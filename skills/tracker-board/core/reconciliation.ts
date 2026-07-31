/**
 * Pure planning and evaluation for the independent Extraction pass.
 *
 * This module is intentionally not re-exported by `core/index.ts`: the board keeps one public
 * derivation seam, while the model workflow imports this narrower batch boundary directly. It has
 * no I/O. The incumbent Board coordinates persistence around an accepted result.
 *
 * Independence is structural. A plan exposes only an opaque candidate id, display identity, and
 * the exact scanned source the model must read; it never exposes the parser Extraction, content
 * hash, Annotation history, Lane, state, or counts. Code re-derives the parser answer from the Scan
 * when it evaluates the response.
 * Agreement is not proof: if the parser and the independent reader are both wrong in the same way,
 * no disagreement exists to flag. Adversarial parser fixtures are the backstop for that class.
 *
 * Receipts are code-stamped by this workflow, not protected provenance. The Annotation file is
 * writable by the same local agent; the response schema keeps a model from emitting a receipt
 * through this boundary, but the marker is not a security boundary against another local writer.
 */

import { createHash } from 'node:crypto';

import { deriveSnapshot } from './index.ts';
import {
  applyAnnotationExtraction,
  applyOverride,
  asOfState,
  readAnnotations,
  type AnnotationIndex,
} from './internal/annotations.ts';
import {
  MAX_RECONCILIATION_BLOCKERS,
  MAX_RECONCILIATION_TEXT_BYTES,
} from './internal/reconciliation-limits.ts';
import type {
  AnnotationEntry,
  AnnotationExtraction,
  AnnotationStore,
  Dialect,
  ParserComponent as AnnotationParserComponent,
  Rejection,
  Scan,
  TicketCard,
} from './types.ts';

const SCHEMA_VERSION = 1;
const EMPTY_ANNOTATIONS: AnnotationStore = { schemaVersion: SCHEMA_VERSION, entries: [] };
const RESULT_KEYS: readonly string[] = ['candidateId', 'extraction'];
const RESPONSE_KEYS: readonly string[] = ['schemaVersion', 'results'];
const EXTRACTION_KEYS: readonly (keyof ReconciliationExtraction)[] = [
  'title',
  'criteria',
  'blockedBy',
  'externalBlocker',
  'rawStatus',
  'ticketType',
  'dialect',
];

/** Three independent files are evidence of a shared parser defect rather than local exceptions. */
export const PARSER_BUG_THRESHOLD = 3;

/** Keep a hostile response from turning one refusal into an unbounded diagnostic allocation. */
export const MAX_RECONCILIATION_REJECTION_DETAILS = 64;
export const MAX_RECONCILIATION_PARSER_BUG_DETAILS = 64;
export const MAX_RECONCILIATION_BATCH_RESULTS = 64;
export { MAX_RECONCILIATION_BLOCKERS, MAX_RECONCILIATION_TEXT_BYTES };
export const MAX_RECONCILIATION_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_RECONCILIATION_PLAN_BYTES = 32 * 1024 * 1024;

export interface ReconciliationExtraction {
  readonly title: string;
  readonly criteria: { readonly checked: number; readonly total: number };
  readonly blockedBy: readonly number[];
  readonly externalBlocker: string | null;
  readonly rawStatus: string;
  readonly ticketType: string | null;
  readonly dialect: Dialect;
}

export interface ReconciliationCandidate {
  /** Opaque binding to the Root-qualified path and current content hash. */
  readonly candidateId: string;
  /** Root-qualified display identity. Not a path the model needs to reopen. */
  readonly filePath: string;
  /** The exact bounded source text whose hash is bound into `candidateId`. */
  readonly source: string;
}

export interface ReconciliationPlan {
  readonly schemaVersion: 1;
  /** Opaque candidate-id cursor supplied to this page, or null for the first page. */
  readonly cursor: string | null;
  /** Pass this cursor to the next plan/apply pair in the same invocation. */
  readonly nextCursor: string | null;
  readonly candidates: readonly ReconciliationCandidate[];
}

export type ParserComponent = AnnotationParserComponent;

export interface ParserBug {
  readonly component: ParserComponent;
  /** Total affected files; `candidateIds` is a bounded diagnostic sample. */
  readonly affected: number;
  readonly candidateIds: readonly string[];
}

interface ParserBugGroup {
  readonly component: ParserComponent;
  readonly allCandidateIds: readonly string[];
}

export interface ReconciliationReport {
  /** False means the response was refused whole and `store` is the input store unchanged. */
  readonly accepted: boolean;
  readonly agreements: number;
  readonly overrides: number;
  readonly parserBugs: readonly ParserBug[];
  /** Total validation failures, including details omitted from the bounded list below. */
  readonly rejected: number;
  readonly rejectionsOmitted: number;
  /** Response validation failures. Stored Annotation rejections remain surfaced by the Snapshot. */
  readonly rejections: readonly Rejection[];
}

export interface ReconciliationResult {
  readonly store: AnnotationStore;
  readonly report: ReconciliationReport;
}

interface CandidateContext {
  readonly candidate: ReconciliationCandidate;
  readonly card: TicketCard & { readonly contentSha: string };
}

interface ValidatedResult {
  readonly candidateId: string;
  readonly extraction: ReconciliationExtraction;
}

interface ComparedResult extends ValidatedResult {
  readonly context: CandidateContext;
  readonly correctedFields: readonly string[];
}

interface ParserEvidence {
  readonly candidateId: string;
  readonly context: CandidateContext;
  readonly correctedFields: readonly string[];
  readonly components: readonly ParserComponent[];
  readonly extraction: ReconciliationExtraction;
}

interface ParserBugDeferral {
  readonly context: CandidateContext;
  readonly parserBugExtraction: AnnotationExtraction;
  readonly extraction: AnnotationExtraction;
}

/**
 * Select readable Ticket files without a receipt for their exact current content.
 *
 * A current legacy/manual Override is deliberately still selected: only this code-stamped receipt
 * proves the independent pass happened. An unknown Annotation schema is dropped by the reader and
 * therefore selected again.
 */
export function planReconciliation(
  scan: Scan,
  annotations: AnnotationStore,
  after: string | null = null,
): ReconciliationPlan {
  const index = readAnnotations(annotations);
  const cursor = normalCursor(after);
  return pageCandidateContexts(
    pendingCandidateContexts(allCandidateContexts(scan), index),
    cursor,
  ).plan;
}

/**
 * Validate a complete independent response, code-diff it, and produce the next Annotation store.
 * No partial response is written. Parser-bug groups are valid responses, but their files receive no
 * receipt and are offered again until the shared defect is fixed.
 */
export function reconcileExtractions(
  scan: Scan,
  annotations: AnnotationStore,
  response: unknown,
  after: string | null = null,
): ReconciliationResult {
  const index = readAnnotations(annotations);
  const allContexts = allCandidateContexts(scan);
  const cursor = normalCursor(after);
  const contexts = pageCandidateContexts(
    pendingCandidateContexts(allContexts, index),
    cursor,
  ).contexts;
  const byId = new Map(contexts.map((context) => [context.candidate.candidateId, context]));
  const validated = validateResponse(response, contexts, byId);
  if (validated.rejected > 0) {
    return refused(
      annotations,
      validated.rejections,
      validated.rejected,
      validated.rejectionsOmitted,
    );
  }

  const comparisonEntries: AnnotationEntry[] = validated.results.map((result) => {
    const context = byId.get(result.candidateId);
    // Completeness and membership were established above. This fallback is unreachable, but keeps
    // a malformed in-memory call from turning a refusal boundary into an exception.
    if (context === undefined || context.card.contentSha === null) {
      return { schemaVersion: SCHEMA_VERSION, filePath: '', contentSha: '' };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      filePath: context.card.id,
      contentSha: context.card.contentSha,
      extraction: result.extraction,
    };
  });
  const comparisonIndex = readAnnotations({
    schemaVersion: SCHEMA_VERSION,
    entries: comparisonEntries,
  });
  // Validation uses the same Annotation guard before this point. If the guard nevertheless refuses
  // a constructed entry, fail closed rather than diffing only the entries that survived.
  if (comparisonIndex.rejections.length > 0) {
    return refused(annotations, comparisonIndex.rejections);
  }

  const compared: ComparedResult[] = validated.results.map((result) => {
    const context = byId.get(result.candidateId) as CandidateContext;
    const applied = applyOverride(
      context.card.extraction,
      context.card.id,
      context.card.contentSha,
      comparisonIndex,
    );
    return { ...result, context, correctedFields: applied.correctedFields };
  });

  const parserEvidence = collectParserEvidence(allContexts, compared, index);
  const evidenceById = new Map(
    parserEvidence.map((evidence) => [evidence.candidateId, evidence]),
  );
  const parserBugGroups = findParserBugs(parserEvidence);
  const componentsById = new Map<string, ParserComponent[]>();
  for (const bug of parserBugGroups) {
    for (const candidateId of bug.allCandidateIds) {
      const components = componentsById.get(candidateId);
      if (components === undefined) componentsById.set(candidateId, [bug.component]);
      else components.push(bug.component);
    }
  }
  const suppressed = new Set(componentsById.keys());
  const parserBugs: readonly ParserBug[] = parserBugGroups.map((bug) => ({
    component: bug.component,
    affected: bug.allCandidateIds.length,
    candidateIds: bug.allCandidateIds.slice(0, MAX_RECONCILIATION_PARSER_BUG_DETAILS),
  }));
  const written = compared.filter((result) => !suppressed.has(result.candidateId));
  const entries = written.map(toReceipt);
  const deferred: ParserBugDeferral[] = [...componentsById].flatMap(
    ([candidateId, components]) => {
      const evidence = evidenceById.get(candidateId);
      if (evidence === undefined) return [];
      const parserBugFields = EXTRACTION_KEYS.filter((field) => {
        const component = componentOf(field);
        return component !== null && components.includes(component);
      });
      const overrideFields = evidence.correctedFields.filter((field) => {
        const component = componentOf(field);
        return component === null || !components.includes(component);
      });
      return [
        {
          context: evidence.context,
          parserBugExtraction: differingExtraction(evidence.extraction, parserBugFields),
          extraction: differingExtraction(evidence.extraction, overrideFields),
        },
      ];
    },
  );
  const currentIds = new Set(compared.map(({ candidateId }) => candidateId));
  const deferredOverrides = deferred.filter(
    ({ context, extraction }) =>
      currentIds.has(context.candidate.candidateId) && Object.keys(extraction).length > 0,
  ).length;
  const store = mergeEntries(annotations, entries, deferred, index);

  return {
    store,
    report: {
      accepted: true,
      agreements: written.filter((result) => result.correctedFields.length === 0).length,
      overrides:
        written.filter((result) => result.correctedFields.length > 0).length +
        deferredOverrides,
      parserBugs,
      rejected: 0,
      rejectionsOmitted: 0,
      rejections: [],
    },
  };
}

function allCandidateContexts(scan: Scan): CandidateContext[] {
  const snapshot = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const cards = snapshot.roots
    .flatMap((root) => {
      const scanned = scan.roots.find((candidate) => candidate.path === root.path);
      return root.features.flatMap((feature) =>
        feature.tickets.map((card) => ({
          card,
          source: scanned?.files.find((file) => file.path === card.path)?.text,
        })),
      );
    })
    .filter(
      (
        found,
      ): found is {
        readonly card: TicketCard & { readonly contentSha: string };
        readonly source: string;
      } =>
        found.card.readError === null &&
        typeof found.card.contentSha === 'string' &&
        found.card.contentSha.length > 0 &&
        typeof found.source === 'string',
    );

  return cards
    .map(({ card, source }) => ({
      card,
      candidate: {
        candidateId: candidateId(card.id, card.contentSha),
        filePath: card.id,
        // `readError === null` and a content hash together mean the scanner handed the parser text.
        // Carry those bytes forward rather than reopening `absPath`: a regular file can become a
        // symlink after the scan, while this source remains the content bound to the candidate id.
        source,
      },
    }))
    .sort((left, right) =>
      compareCodeUnits(left.candidate.candidateId, right.candidate.candidateId),
    );
}

function pendingCandidateContexts(
  contexts: readonly CandidateContext[],
  index: AnnotationIndex,
): CandidateContext[] {
  return contexts.filter(({ card }) => {
    const lookup = asOfState(card.id, card.contentSha, index);
    return lookup.state !== 'current' || lookup.entry?.reconciled !== true;
  });
}

function pageCandidateContexts(
  contexts: readonly CandidateContext[],
  cursor: string | null,
): { readonly contexts: readonly CandidateContext[]; readonly plan: ReconciliationPlan } {
  const eligible = contexts.filter(
    (context) =>
      cursor === null || compareCodeUnits(context.candidate.candidateId, cursor) > 0,
  );
  const selected: CandidateContext[] = [];
  for (const context of eligible) {
    if (selected.length >= MAX_RECONCILIATION_BATCH_RESULTS) break;
    const next = [...selected, context];
    const provisional: ReconciliationPlan = {
      schemaVersion: SCHEMA_VERSION,
      cursor,
      nextCursor: context.candidate.candidateId,
      candidates: next.map(({ candidate }) => candidate),
    };
    if (encodedBytes(JSON.stringify(provisional, null, 2)) > MAX_RECONCILIATION_PLAN_BYTES) {
      // One scanner-bounded source fits by construction. Keep it moving rather than create a
      // cursor that can never advance if a synthetic in-memory Scan violates the scanner bound.
      if (selected.length === 0) selected.push(context);
      break;
    }
    selected.push(context);
  }
  const hasMore = selected.length < eligible.length;
  const nextCursor = hasMore
    ? (selected[selected.length - 1]?.candidate.candidateId ?? cursor)
    : null;
  return {
    contexts: selected,
    plan: {
      schemaVersion: SCHEMA_VERSION,
      cursor,
      nextCursor,
      candidates: selected.map(({ candidate }) => candidate),
    },
  };
}

function normalCursor(value: string | null): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function candidateId(filePath: string, contentSha: string): string {
  return createHash('sha256').update(filePath).update('\0').update(contentSha).digest('hex');
}

function validateResponse(
  response: unknown,
  contexts: readonly CandidateContext[],
  byId: ReadonlyMap<string, CandidateContext>,
): {
  readonly results: readonly ValidatedResult[];
  readonly rejected: number;
  readonly rejectionsOmitted: number;
  readonly rejections: readonly Rejection[];
} {
  const rejections = new RejectionCollector();
  if (!isRecord(response)) {
    rejections.add(refusal('', 'response', 'is not a reconciliation response object'));
    return { results: [], ...rejections.report() };
  }

  rejectUnknownKeys(response, RESPONSE_KEYS, '', rejections);
  if (response['schemaVersion'] !== SCHEMA_VERSION) {
    rejections.add(refusal('', 'schemaVersion', `is not schema version ${SCHEMA_VERSION}`));
  }
  const rawResults = response['results'];
  if (!Array.isArray(rawResults)) {
    rejections.add(refusal('', 'results', 'is not a list of candidate results'));
    return { results: [], ...rejections.report() };
  }
  if (rawResults.length !== contexts.length) {
    rejections.add(
      refusal(
        '',
        'results',
        `does not contain exactly ${String(contexts.length)} current candidate results`,
      ),
    );
    return { results: [], ...rejections.report() };
  }

  const results: ValidatedResult[] = [];
  const seen = new Set<string>();
  for (const [at, raw] of rawResults.entries()) {
    const prefix = `results[${String(at)}]`;
    if (!isRecord(raw)) {
      rejections.add(refusal('', prefix, 'is not a candidate result object'));
      continue;
    }
    rejectUnknownKeys(raw, RESULT_KEYS, prefix, rejections);
    const rawId = raw['candidateId'];
    const id = typeof rawId === 'string' ? rawId : '';
    const context = byId.get(id);
    if (id.length === 0) {
      rejections.add(refusal('', `${prefix}.candidateId`, 'is not a candidate id'));
    } else if (seen.has(id)) {
      rejections.add(refusal('', `${prefix}.candidateId`, 'duplicates another result'));
    } else if (context === undefined) {
      rejections.add(
        refusal('', `${prefix}.candidateId`, 'does not identify current unreconciled content'),
      );
    }
    seen.add(id);

    const extraction = validateExtraction(raw['extraction'], context?.card.id ?? '', prefix, rejections);
    if (context !== undefined && extraction !== null) {
      results.push({ candidateId: id, extraction });
    }
  }

  for (const context of contexts) {
    if (!seen.has(context.candidate.candidateId)) {
      rejections.add(
        refusal(
          context.card.id,
          'results',
          'has no result for one current reconciliation candidate',
        ),
      );
    }
  }
  return { results, ...rejections.report() };
}

function validateExtraction(
  raw: unknown,
  path: string,
  prefix: string,
  rejections: RejectionCollector,
): ReconciliationExtraction | null {
  const before = rejections.count;
  if (!isRecord(raw)) {
    rejections.add(refusal(path, `${prefix}.extraction`, 'is not an Extraction object'));
    return null;
  }

  for (const key of EXTRACTION_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      rejections.add(
        refusal(path, `${prefix}.extraction.${key}`, 'is required for an independent Extraction'),
      );
    }
  }
  for (const key of Object.keys(raw)) {
    if (!EXTRACTION_KEYS.includes(key as keyof ReconciliationExtraction)) {
      rejections.add(
        refusal(
          path,
          `${prefix}.extraction.${safeUnknownField(key)}`,
          'is not an Extraction field; Lane, state, Frontier membership and counts are code-derived',
        ),
      );
    }
  }

  const title = raw['title'];
  if (typeof title !== 'string') {
    rejections.add(refusal(path, `${prefix}.extraction.title`, 'is not a string'));
  }
  const externalBlocker = raw['externalBlocker'];
  if (externalBlocker !== null && typeof externalBlocker !== 'string') {
    rejections.add(
      refusal(path, `${prefix}.extraction.externalBlocker`, 'is not a string or null'),
    );
  }
  const rawStatus = raw['rawStatus'];
  if (typeof rawStatus !== 'string') {
    rejections.add(refusal(path, `${prefix}.extraction.rawStatus`, 'is not a string'));
  }
  const ticketType = raw['ticketType'];
  if (ticketType !== null && typeof ticketType !== 'string') {
    rejections.add(refusal(path, `${prefix}.extraction.ticketType`, 'is not a string or null'));
  }
  const dialect = raw['dialect'];
  if (
    typeof dialect !== 'string' ||
    !(['task', 'decision', 'unclassified', 'unparsed'] as const).some(
      (candidate) => candidate === dialect,
    )
  ) {
    rejections.add(refusal(path, `${prefix}.extraction.dialect`, 'is not a supported dialect'));
  }

  const textValues = [raw['title'], raw['externalBlocker'], raw['rawStatus'], raw['ticketType']];
  if (
    textValues.reduce<number>(
      (total, value) => total + (typeof value === 'string' ? encodedBytes(value) : 0),
      0,
    ) > MAX_RECONCILIATION_TEXT_BYTES
  ) {
    rejections.add(
      refusal(
        path,
        `${prefix}.extraction`,
        `text fields exceed the ${String(MAX_RECONCILIATION_TEXT_BYTES)} byte response budget`,
      ),
    );
  }
  const blockedBy = raw['blockedBy'];
  if (!Array.isArray(blockedBy)) {
    rejections.add(refusal(path, `${prefix}.extraction.blockedBy`, 'is not a Ticket-number list'));
  } else if (blockedBy.length > MAX_RECONCILIATION_BLOCKERS) {
    rejections.add(
      refusal(
        path,
        `${prefix}.extraction.blockedBy`,
        `has more than ${String(MAX_RECONCILIATION_BLOCKERS)} entries`,
      ),
    );
  } else {
    for (const [at, blocker] of blockedBy.entries()) {
      if (!Number.isSafeInteger(blocker) || (blocker as number) < 0) {
        rejections.add(
          refusal(
            path,
            `${prefix}.extraction.blockedBy[${String(at)}]`,
            'is not a nonnegative safe Ticket number',
          ),
        );
      }
    }
  }
  const criteria = raw['criteria'];
  if (!isRecord(criteria)) {
    rejections.add(refusal(path, `${prefix}.extraction.criteria`, 'is not a criteria ratio'));
  } else {
    for (const required of ['checked', 'total']) {
      if (!Object.hasOwn(criteria, required)) {
        rejections.add(
          refusal(
            path,
            `${prefix}.extraction.criteria.${required}`,
            'is required for a complete criteria ratio',
          ),
        );
      }
    }
    for (const key of Object.keys(criteria)) {
      if (key !== 'checked' && key !== 'total') {
        rejections.add(
          refusal(
            path,
            `${prefix}.extraction.criteria.${safeUnknownField(key)}`,
            'is not a criteria ratio field',
          ),
        );
      }
    }
    for (const field of ['checked', 'total'] as const) {
      const value = criteria[field];
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        rejections.add(
          refusal(
            path,
            `${prefix}.extraction.criteria.${field}`,
            'is not a nonnegative safe count',
          ),
        );
      }
    }
  }
  // Do not hand structurally invalid, potentially huge arrays or objects to the shared Annotation
  // validator. The exact-key checks above already collected every safe response-level detail.
  if (rejections.count > before) return null;

  // Reuse the Annotation schema's field-by-field bounds and enum validation. The response boundary
  // adds required/exact keys above; the Annotation boundary remains authoritative for field shapes.
  const probe = readAnnotations({
    schemaVersion: SCHEMA_VERSION,
    entries: [
      {
        schemaVersion: SCHEMA_VERSION,
        filePath: path.length > 0 ? path : 'candidate',
        contentSha: 'candidate',
        extraction: raw as AnnotationExtraction,
      },
    ],
  });
  for (const rejection of probe.rejections) {
    rejections.add(
      refusal(
        path,
        `${prefix}.${safeExtractionRejectionField(rejection.field)}`,
        'is not a valid value for this Extraction field',
      ),
    );
  }
  if (rejections.count > before) return null;

  return {
    title: raw['title'] as string,
    criteria: raw['criteria'] as ReconciliationExtraction['criteria'],
    blockedBy: [...(raw['blockedBy'] as readonly number[])],
    externalBlocker: raw['externalBlocker'] as string | null,
    rawStatus: raw['rawStatus'] as string,
    ticketType: raw['ticketType'] as string | null,
    dialect: raw['dialect'] as Dialect,
  };
}

function collectParserEvidence(
  contexts: readonly CandidateContext[],
  compared: readonly ComparedResult[],
  index: AnnotationIndex,
): readonly ParserEvidence[] {
  const current = new Map(compared.map((result) => [result.candidateId, result]));
  const evidence: ParserEvidence[] = [];
  for (const context of contexts) {
    const result = current.get(context.candidate.candidateId);
    if (result !== undefined) {
      if (result.correctedFields.length > 0) {
        evidence.push({
          candidateId: result.candidateId,
          context,
          correctedFields: result.correctedFields,
          components: componentsOf(result.correctedFields),
          extraction: result.extraction,
        });
      }
      continue;
    }
    if (context.card.contentSha === null) continue;
    const prior = asOfState(context.card.id, context.card.contentSha, index);
    if (prior.state !== 'current' || prior.entry === null) continue;
    const marker = prior.entry.parserBugExtraction;
    const independent =
      marker !== undefined
        ? { ...prior.entry.extraction, ...marker }
        : prior.entry.reconciled === true
          ? prior.entry.extraction
          : undefined;
    if (independent === undefined) continue;
    // Re-run every stored independent value through the current parser. A parser fix can make
    // either an old Override or a neutral marker agree, so component labels alone are not proof.
    const applied = applyAnnotationExtraction(context.card.extraction, independent);
    if (applied.correctedFields.length > 0) {
      evidence.push({
        candidateId: context.candidate.candidateId,
        context,
        correctedFields: applied.correctedFields,
        components: componentsOf(applied.correctedFields),
        extraction: reconciliationExtraction(applied.extraction),
      });
    }
  }
  return evidence;
}

function findParserBugs(evidence: readonly ParserEvidence[]): readonly ParserBugGroup[] {
  const ids = new Map<ParserComponent, Set<string>>();
  for (const result of evidence) {
    for (const component of result.components) {
      const existing = ids.get(component);
      if (existing === undefined) ids.set(component, new Set([result.candidateId]));
      else existing.add(result.candidateId);
    }
  }

  return COMPONENT_ORDER.flatMap((component) => {
    const candidateIds = ids.get(component);
    if (candidateIds === undefined || candidateIds.size < PARSER_BUG_THRESHOLD) return [];
    return [{ component, allCandidateIds: [...candidateIds] }];
  });
}

const COMPONENT_ORDER: readonly ParserComponent[] = [
  'identity',
  'criteria-region',
  'blockers',
  'status',
  'type-routing',
  'dialect-scoring',
];

function componentsOf(fields: readonly string[]): readonly ParserComponent[] {
  const components = new Set<ParserComponent>();
  for (const field of fields) {
    const component = componentOf(field);
    if (component !== null) components.add(component);
  }
  return [...components];
}

function componentOf(field: string): ParserComponent | null {
  switch (field) {
    case 'title':
      return 'identity';
    case 'criteria':
      return 'criteria-region';
    case 'blockedBy':
    case 'externalBlocker':
      return 'blockers';
    case 'rawStatus':
      return 'status';
    case 'ticketType':
      return 'type-routing';
    case 'dialect':
      return 'dialect-scoring';
    default:
      return null;
  }
}

function toReceipt(result: ComparedResult): AnnotationEntry {
  const contentSha = result.context.card.contentSha as string;
  const extraction = differingExtraction(result.extraction, result.correctedFields);
  return {
    schemaVersion: SCHEMA_VERSION,
    filePath: result.context.card.id,
    contentSha,
    reconciled: true,
    ...(Object.keys(extraction).length > 0 ? { extraction } : {}),
  };
}

function differingExtraction(
  extraction: ReconciliationExtraction | AnnotationExtraction,
  fields: readonly string[],
): AnnotationExtraction {
  const result: {
    title?: string;
    criteria?: ReconciliationExtraction['criteria'];
    blockedBy?: readonly number[];
    externalBlocker?: string | null;
    rawStatus?: string;
    ticketType?: string | null;
    dialect?: Dialect;
  } = {};
  for (const field of fields) {
    switch (field) {
      case 'title': {
        const value = extraction.title;
        if (value !== undefined) result.title = value;
        break;
      }
      case 'criteria': {
        const value = extraction.criteria;
        if (value !== undefined) result.criteria = value;
        break;
      }
      case 'blockedBy': {
        const value = extraction.blockedBy;
        if (value !== undefined) result.blockedBy = value;
        break;
      }
      case 'externalBlocker':
        if (Object.hasOwn(extraction, 'externalBlocker')) {
          result.externalBlocker = extraction.externalBlocker ?? null;
        }
        break;
      case 'rawStatus': {
        const value = extraction.rawStatus;
        if (value !== undefined) result.rawStatus = value;
        break;
      }
      case 'ticketType':
        if (Object.hasOwn(extraction, 'ticketType')) {
          result.ticketType = extraction.ticketType ?? null;
        }
        break;
      case 'dialect': {
        const value = extraction.dialect;
        if (value !== undefined) result.dialect = value;
        break;
      }
    }
  }
  return result;
}

function reconciliationExtraction(
  extraction: TicketCard['extraction'],
): ReconciliationExtraction {
  return {
    title: extraction.title,
    criteria: {
      checked: extraction.criteria.checked,
      total: extraction.criteria.total,
    },
    blockedBy: [...extraction.blockedBy],
    externalBlocker: extraction.externalBlocker,
    rawStatus: extraction.rawStatus,
    ticketType: extraction.ticketType,
    dialect: extraction.dialect,
  };
}

function mergeEntries(
  annotations: AnnotationStore,
  receipts: readonly AnnotationEntry[],
  deferred: readonly ParserBugDeferral[],
  index: AnnotationIndex,
): AnnotationStore {
  if (receipts.length === 0 && deferred.length === 0) return annotations;
  const replaced = new Set([
    ...receipts.map((entry) => pair(entry.filePath, entry.contentSha)),
    ...deferred.map(({ context }) => pair(context.card.id, context.card.contentSha)),
  ]);
  const kept = Array.isArray(annotations.entries)
    ? annotations.entries.filter((entry) => !sameRawKey(entry, replaced))
    : [];
  const merged = receipts.map((receipt) => {
    const previous = asOfState(receipt.filePath, receipt.contentSha, index);
    const entry = previous.state === 'current' ? previous.entry : null;
    return {
      ...receipt,
      ...(entry?.digest !== undefined ? { digest: entry.digest } : {}),
      ...(entry?.memberShas !== undefined ? { memberShas: entry.memberShas } : {}),
    };
  });
  const neutral = deferred.map(
    ({ context, parserBugExtraction, extraction }): AnnotationEntry => {
    const previous = asOfState(context.card.id, context.card.contentSha, index);
    const entry = previous.state === 'current' ? previous.entry : null;
    return {
      schemaVersion: SCHEMA_VERSION,
      filePath: context.card.id,
      contentSha: context.card.contentSha,
      parserBugExtraction,
      ...(Object.keys(extraction).length > 0 ? { extraction } : {}),
      ...(entry?.digest !== undefined ? { digest: entry.digest } : {}),
      ...(entry?.memberShas !== undefined ? { memberShas: entry.memberShas } : {}),
    };
    },
  );
  const next = { schemaVersion: SCHEMA_VERSION, entries: [...kept, ...merged, ...neutral] };
  return sameJson(annotations, next) ? annotations : next;
}

function sameRawKey(entry: AnnotationEntry, keys: ReadonlySet<string>): boolean {
  return (
    typeof entry?.filePath === 'string' &&
    typeof entry?.contentSha === 'string' &&
    keys.has(pair(entry.filePath, entry.contentSha))
  );
}

function pair(filePath: string, contentSha: string): string {
  return `${filePath}\0${contentSha}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function refused(
  store: AnnotationStore,
  rejections: readonly Rejection[],
  rejected = rejections.length,
  rejectionsOmitted = 0,
): ReconciliationResult {
  return {
    store,
    report: {
      accepted: false,
      agreements: 0,
      overrides: 0,
      parserBugs: [],
      rejected,
      rejectionsOmitted,
      rejections,
    },
  };
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  prefix: string,
  rejections: RejectionCollector,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      rejections.add(
        refusal(
          '',
          prefix.length > 0
            ? `${prefix}.${safeUnknownField(key)}`
            : safeUnknownField(key),
          'is not a response field',
        ),
      );
    }
  }
}

function safeUnknownField(key: string): string {
  return SAFE_FORBIDDEN_FIELDS.has(key) ? key : '<unknown-field>';
}

function safeExtractionRejectionField(field: string): string {
  return /^extraction\.(?:title|externalBlocker|rawStatus|ticketType|dialect|criteria(?:\.(?:checked|total))?|blockedBy(?:\[\d+\])?)$/.test(
    field,
  )
    ? field
    : 'extraction';
}

const SAFE_FORBIDDEN_FIELDS = new Set([
  'lane',
  'state',
  'onFrontier',
  'frontier',
  'count',
  'contentSha',
  'reconciled',
  'correctedFields',
  'statusPrefix',
  'qualifier',
  'statusPresent',
  'hitl',
]);

class RejectionCollector {
  readonly details: Rejection[] = [];
  count = 0;

  add(rejection: Rejection): void {
    this.count += 1;
    if (this.details.length < MAX_RECONCILIATION_REJECTION_DETAILS) {
      this.details.push(rejection);
    }
  }

  report(): {
    readonly rejected: number;
    readonly rejectionsOmitted: number;
    readonly rejections: readonly Rejection[];
  } {
    if (this.count <= this.details.length) {
      return { rejected: this.count, rejectionsOmitted: 0, rejections: this.details };
    }
    const rejectionsOmitted = this.count - this.details.length;
    return {
      rejected: this.count,
      rejectionsOmitted,
      rejections: [
        ...this.details,
        refusal(
          '',
          'response',
          `${String(rejectionsOmitted)} additional validation failures were omitted`,
        ),
      ],
    };
  }
}

function refusal(path: string, field: string, message: string): Rejection {
  return { kind: 'override', path, feature: null, field, message };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
