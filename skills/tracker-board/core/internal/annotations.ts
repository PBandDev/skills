/**
 * The Annotation store: read, Override application, and as-of state.
 *
 * This is the boundary the AI layer writes through.
 *
 *   - Every entry is keyed by **path plus content hash**. A changed file simply does not
 *     match — no sweeping, no invalidation, no timed collection. Annotations expire by
 *     construction (ADR-0003).
 *   - That path is **Root-qualified**, shaped `<rootPath>#<relPath>`, and the seam already
 *     hands it over that way. One board watches several Roots against one store, so a
 *     Root-relative path is not an identity: two repos both holding
 *     `payments/issues/01.md` would otherwise share an Override whenever their content
 *     hashes matched, and mark each other expired whenever they did not.
 *   - The store carries a **schema version**. An entry with an unknown version is
 *     **dropped and its file re-flagged**, never crash-parsed.
 *   - **AI extracts, code derives** (ADR-0001). An Annotation may carry Extraction fields
 *     only. An Annotation carrying a derived state — a Lane, `blocked`, `ready`, `frozen`,
 *     `done`, Frontier membership, any count — is **rejected**, not stripped and accepted.
 *     The schema has no field to put one in, because a missing field is a wall and a
 *     prompt instruction is only a request.
 *   - **Validation rejects and never truncates.** A rejection names the field and the
 *     overage so the generating model can self-correct, and rejections are **counted**,
 *     because a silently dropped Override is indistinguishable from a parser that quietly
 *     regressed.
 *   - Three as-of states are distinguishable: **current**, **expired** (an entry exists
 *     under the same path with a different hash) and **never written** (no entry at all).
 *     Rendering the last two identically teaches the reader that Digests do not exist.
 *
 * Type stripping erases, it does not check. Every field read here arrives from disk and is
 * validated at runtime independently of the type that describes it.
 *
 * ---
 *
 * Readings this module takes that the rules above do not settle on their own.
 *
 *   - **An entry is validated whole, at read time, and dropped whole.** Rejecting an
 *     Annotation means rejecting the entry, not keeping the parts of it that happened to
 *     typecheck — that is the difference between a wall and a filter. A Digest payload is
 *     checked for its envelope here and for its Blocks per Feature, because only the second
 *     half needs to know which Feature it renders for.
 *   - **The allow-list runs at both levels.** A `lane` written at the top of an entry and a
 *     `lane` written inside its `extraction` are the same mistake, and both are named.
 *   - **A rejection names the field and the shape, never the content.** `field` names the
 *     offending field inside the entry — `schemaVersion`, `lane`,
 *     `extraction.criteria.checked` — and `path` carries the file the entry claimed to
 *     describe. The refused value is never quoted back: it is model-authored text about
 *     somebody's private repository, and a message that echoes it copies that text onto the
 *     board and into anything the board writes. Only an entry that is not an object at all
 *     is named by position instead.
 *   - **Rejection kinds split by where the violation sits**: `annotation` for the store and
 *     the entry envelope, `override` for anything under `extraction.`, `digest` for the
 *     Digest payload. That is what makes the board's "N overrides rejected" a count of
 *     refused Overrides rather than a count of everything that went wrong.
 *   - **A merged field re-derives its code-owned companions.** ADR-0001's consequence is
 *     that the AI fixes the Extraction and the Lane follows, so an Override on `rawStatus`
 *     re-reads the status prefix and qualifier, and an Override on `ticketType` re-reads
 *     the HITL routing, through the same rule modules the parser used.
 *   - **`filesChanged` is answered by `readDigestState` and never by `asOfState`.** The
 *     count is a statement about a *Digest*, so it is read where the Digest is, from the
 *     newest entry under the path that carries one — the one the panel is calling expired.
 *     An older entry's member list describes an older Digest and would answer a question
 *     nobody asked. `asOfState` answers about entries and is handed one hash, so it has no
 *     count to give and no longer pretends to carry one.
 *   - **A member list that will not verify costs the count, not the Digest.** The list is an
 *     optional record that feeds one number; refusing the entry over it would throw away a
 *     valid Digest to punish a field the Digest does not depend on. So `null` is returned
 *     and the Digest still renders. `internal/members.ts` holds the rule and the reasoning.
 */

import type {
  AnnotationEntry,
  AnnotationExtraction,
  AnnotationStore,
  AsOfState,
  Criteria,
  Dialect,
  DigestState,
  Extraction,
  JsonValue,
  Rejection,
} from '../types.ts';
import { validateDigest } from './digest.ts';
import { countChangedPaths } from './members.ts';
import {
  MAX_RECONCILIATION_BLOCKERS,
  MAX_RECONCILIATION_TEXT_BYTES,
} from './reconciliation-limits.ts';
import { readStatus } from './status.ts';
import { readTypeRouting } from './criteria.ts';

export interface AnnotationIndex {
  /** Keyed by Root-qualified path + `contentSha` — the only key an entry is found by. */
  readonly byKey: ReadonlyMap<string, AnnotationEntry>;
  /** Keyed by the Root-qualified path alone. Used only to tell *expired* from *never written*. */
  readonly byPath: ReadonlyMap<string, readonly AnnotationEntry[]>;
  /** Entries refused at read time. Counted on the Snapshot. */
  readonly rejections: readonly Rejection[];
  /** Entries dropped for an unknown schema version. Their files are re-flagged. */
  readonly droppedForVersion: number;
}

export interface OverrideResult {
  /** The Extraction with any accepted Override merged in. */
  readonly extraction: Extraction;
  /** Names of the Extraction fields an Override disagreed with. Drives the card marker. */
  readonly correctedFields: readonly string[];
  readonly rejections: readonly Rejection[];
}

export interface AsOfLookup {
  readonly state: AsOfState;
  /** The matching entry when `state` is `current`. `null` otherwise. */
  readonly entry: AnnotationEntry | null;
}

export interface DigestRead {
  readonly digest: DigestState;
  readonly rejections: readonly Rejection[];
}

/** The supported store schema. Anything else is dropped and re-flagged (ADR-0003). */
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Joins the two halves of an Annotation key. A NUL cannot occur in a path any file system
 * hands back, and an entry claiming one is refused before it reaches here, so the join is
 * injective and two different entries can never collide onto one key.
 */
const KEY_SEPARATOR = '\u0000';

/** The whole entry envelope. Anything else is a field the schema deliberately does not have. */
const ENTRY_KEYS: readonly string[] = [
  'schemaVersion',
  'filePath',
  'contentSha',
  'reconciled',
  'parserBugExtraction',
  'extraction',
  'digest',
  'memberShas',
];

/** Extraction fields only (ADR-0001). There is no slot here for a Lane or a derived state. */
const EXTRACTION_KEYS: readonly string[] = [
  'title',
  'criteria',
  'blockedBy',
  'externalBlocker',
  'rawStatus',
  'ticketType',
  'dialect',
];

const CRITERIA_KEYS: readonly string[] = ['checked', 'total'];

const DIALECTS: readonly Dialect[] = ['task', 'decision', 'unclassified', 'unparsed'];

const DERIVED_STATE_NOTE =
  'Lanes, states, Frontier membership and counts are derived in code (ADR-0001), and the schema has no field to put one in';

const EMPTY_INDEX: AnnotationIndex = {
  byKey: new Map(),
  byPath: new Map(),
  rejections: [],
  droppedForVersion: 0,
};

// ---------------------------------------------------------------------------
// Reading the store
// ---------------------------------------------------------------------------

export function readAnnotations(store: AnnotationStore): AnnotationIndex {
  const rejections: Rejection[] = [];
  const byKey = new Map<string, AnnotationEntry>();
  const byPath = new Map<string, AnnotationEntry[]>();
  let droppedForVersion = 0;

  if (!isRecord(store)) {
    rejections.push(refusal('annotation', '', 'annotations', 'is not an Annotation store'));
    return { ...EMPTY_INDEX, rejections };
  }

  const entries = readArray(store.entries);
  if (store.entries !== undefined && !isList(store.entries)) {
    // A malformed collection must never read as an empty store: "the AI wrote nothing" and
    // "the file the AI writes is corrupt" are different facts about the board.
    rejections.push(refusal('annotation', '', 'entries', 'is not a list of Annotation entries'));
  }

  if (readInteger(store.schemaVersion) !== SUPPORTED_SCHEMA_VERSION) {
    // Nothing below this can be trusted to mean what it says, so nothing below it is read.
    rejections.push(
      refusal(
        'annotation',
        '',
        'schemaVersion',
        `${show(store.schemaVersion)} is not store schema version ${SUPPORTED_SCHEMA_VERSION}; no Annotation was read`,
      ),
    );
    return { ...EMPTY_INDEX, droppedForVersion: entries.length, rejections };
  }

  for (const [at, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      rejections.push(refusal('annotation', '', `entries[${at}]`, 'is not an Annotation entry'));
      continue;
    }

    if (readInteger(entry.schemaVersion) !== SUPPORTED_SCHEMA_VERSION) {
      droppedForVersion += 1;
      rejections.push(
        refusal(
          'annotation',
          readString(entry.filePath) ?? '',
          'schemaVersion',
          `${show(entry.schemaVersion)} is not schema version ${SUPPORTED_SCHEMA_VERSION}; the entry is dropped and its file re-flagged`,
        ),
      );
      continue;
    }

    const filePath = readString(entry.filePath);
    const contentSha = readString(entry.contentSha);
    const claimed = filePath ?? '';
    const before = rejections.length;

    if (filePath === null || filePath.length === 0) {
      rejections.push(
        refusal('annotation', claimed, 'filePath', `${show(entry.filePath)} is not a path`),
      );
    } else if (filePath.includes(KEY_SEPARATOR)) {
      rejections.push(
        refusal('annotation', claimed, 'filePath', 'carries a NUL, which no real path does'),
      );
    }
    if (contentSha === null || contentSha.length === 0) {
      rejections.push(
        refusal(
          'annotation',
          claimed,
          'contentSha',
          `${show(entry.contentSha)} is not a content hash`,
        ),
      );
    }
    if (Object.hasOwn(entry, 'reconciled') && entry.reconciled !== true) {
      rejections.push(
        refusal(
          'annotation',
          claimed,
          'reconciled',
          'is not the code-stamped reconciliation receipt true',
        ),
      );
    }
    const parserBugExtraction = entry.parserBugExtraction;
    if (
      Object.hasOwn(entry, 'parserBugExtraction') &&
      isRecord(parserBugExtraction) &&
      Object.keys(parserBugExtraction ?? {}).length === 0
    ) {
      rejections.push(
        refusal(
          'annotation',
          claimed,
          'parserBugExtraction',
          'must retain at least one independently differing Extraction field',
        ),
      );
    }
    if (parserBugExtraction !== undefined && entry.reconciled === true) {
      rejections.push(
        refusal(
          'annotation',
          claimed,
          'parserBugExtraction',
          'cannot also carry a reconciliation receipt',
        ),
      );
    }
    if (
      isRecord(parserBugExtraction) &&
      Object.hasOwn(parserBugExtraction ?? {}, 'blockedBy') !==
        Object.hasOwn(parserBugExtraction ?? {}, 'externalBlocker')
    ) {
      rejections.push(
        refusal(
          'annotation',
          claimed,
          'parserBugExtraction',
          'must retain blockedBy and externalBlocker together as one parser component',
        ),
      );
    }
    if (
      isRecord(parserBugExtraction) &&
      isRecord(entry.extraction) &&
      Object.keys(parserBugExtraction ?? {}).some((field) =>
        Object.hasOwn(entry.extraction ?? {}, field),
      )
    ) {
      rejections.push(
        refusal(
          'annotation',
          claimed,
          'parserBugExtraction',
          'cannot repeat a field carried by the applied Override',
        ),
      );
    }

    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) {
        rejections.push(
          refusal(
            'annotation',
            claimed,
            key,
            `is not a field of an Annotation entry; ${DERIVED_STATE_NOTE}`,
          ),
        );
      }
    }

    if (entry.memberShas !== undefined && !isStringList(entry.memberShas)) {
      rejections.push(
        refusal(
          'annotation',
          claimed,
          'memberShas',
          'is not a list of "<path>:<sha>" member entries',
        ),
      );
    }

    // A present Digest is checked for its envelope shape here, and for its Blocks later.
    // Only the second half needs the Feature it renders for — the first half
    // does not, and leaving it out let an entry carrying `digest: "invalid"` be indexed and
    // have its Extraction applied, which is the strip-and-continue this module exists to
    // refuse. An entry is refused whole or not at all.
    if (Object.hasOwn(entry, 'digest') && !isJsonRecord(entry.digest)) {
      rejections.push(refusal('digest', claimed, 'digest', 'is not a Digest object'));
    }

    checkExtraction(entry.extraction, claimed, rejections);
    const parserEvidenceRejections: Rejection[] = [];
    const boundedParserBugExtraction = checkParserBugEvidenceBounds(
      parserBugExtraction,
      claimed,
      rejections,
    );
    checkExtraction(boundedParserBugExtraction, claimed, parserEvidenceRejections);
    for (const rejection of parserEvidenceRejections) {
      rejections.push({
        ...rejection,
        kind: 'annotation',
        field: safeParserBugEvidenceField(rejection.field),
      });
    }

    if (rejections.length > before || filePath === null || contentSha === null) continue;

    // Last write wins on a duplicated key. The store is appended to, so the later entry is
    // the newer statement about the same content, and the choice has to be deterministic
    // or the Snapshot stops being a function of its input.
    byKey.set(compositeKey(filePath, contentSha), entry);
    const existing = byPath.get(filePath);
    if (existing === undefined) byPath.set(filePath, [entry]);
    else existing.push(entry);
  }

  return { byKey, byPath, rejections, droppedForVersion };
}

/**
 * The Extraction payload, field by field. Every violation is reported rather than only the
 * first, so a model rewriting its Annotation fixes all of them in one pass.
 */
function checkExtraction(
  extraction: AnnotationExtraction | undefined,
  claimed: string,
  rejections: Rejection[],
): void {
  if (extraction === undefined) return;
  if (!isRecord(extraction)) {
    rejections.push(refusal('override', claimed, 'extraction', 'is not an object'));
    return;
  }

  for (const key of Object.keys(extraction)) {
    switch (key) {
      case 'title': {
        if (readString(extraction.title) === null) {
          rejections.push(
            refusal(
              'override',
              claimed,
              'extraction.title',
              `${show(extraction.title)} is not a string`,
            ),
          );
        }
        break;
      }
      case 'criteria': {
        checkCriteria(extraction.criteria, claimed, rejections);
        break;
      }
      case 'blockedBy': {
        checkBlockedBy(extraction.blockedBy, claimed, rejections);
        break;
      }
      case 'externalBlocker': {
        const value = extraction.externalBlocker;
        if (value !== null && readString(value) === null) {
          rejections.push(
            refusal(
              'override',
              claimed,
              'extraction.externalBlocker',
              `${show(value)} is not a string or null`,
            ),
          );
        }
        break;
      }
      case 'rawStatus': {
        if (readString(extraction.rawStatus) === null) {
          rejections.push(
            refusal(
              'override',
              claimed,
              'extraction.rawStatus',
              `${show(extraction.rawStatus)} is not a string`,
            ),
          );
        }
        break;
      }
      case 'ticketType': {
        const value = extraction.ticketType;
        if (value !== null && readString(value) === null) {
          rejections.push(
            refusal(
              'override',
              claimed,
              'extraction.ticketType',
              `${show(value)} is not a string or null`,
            ),
          );
        }
        break;
      }
      case 'dialect': {
        const value = extraction.dialect;
        if (readString(value) === null || !DIALECTS.some((dialect) => dialect === value)) {
          rejections.push(
            refusal(
              'override',
              claimed,
              'extraction.dialect',
              `is not one of ${DIALECTS.join(', ')}`,
            ),
          );
        }
        break;
      }
      default: {
        rejections.push(
          refusal(
            'override',
            claimed,
            `extraction.${key}`,
            `is not one of ${EXTRACTION_KEYS.join(', ')}; ${DERIVED_STATE_NOTE}`,
          ),
        );
      }
    }
  }
}

function checkParserBugEvidenceBounds(
  extraction: AnnotationExtraction | undefined,
  claimed: string,
  rejections: Rejection[],
): AnnotationExtraction | undefined {
  if (!isRecord(extraction)) return extraction;
  const textBytes = [
    extraction?.title,
    extraction?.externalBlocker,
    extraction?.rawStatus,
    extraction?.ticketType,
  ].reduce(
    (total, value) =>
      total + (typeof value === 'string' ? new TextEncoder().encode(value).byteLength : 0),
    0,
  );
  if (textBytes > MAX_RECONCILIATION_TEXT_BYTES) {
    rejections.push(
      refusal(
        'annotation',
        claimed,
        'parserBugExtraction',
        `exceeds the ${String(MAX_RECONCILIATION_TEXT_BYTES)}-byte text limit`,
      ),
    );
  }
  const blockers = extraction?.blockedBy;
  if (!Array.isArray(blockers) || blockers.length <= MAX_RECONCILIATION_BLOCKERS) {
    return extraction;
  }
  rejections.push(
    refusal(
      'annotation',
      claimed,
      'parserBugExtraction.blockedBy',
      `exceeds the ${String(MAX_RECONCILIATION_BLOCKERS)}-item limit`,
    ),
  );
  // The entry is already refused. Avoid traversing an attacker-sized list in the generic shape
  // validator merely to produce redundant per-item diagnostics.
  return { ...extraction, blockedBy: [] };
}

function checkCriteria(
  criteria: { readonly checked: number; readonly total: number } | undefined,
  claimed: string,
  rejections: Rejection[],
): void {
  if (criteria === undefined || !isRecord(criteria)) {
    rejections.push(refusal('override', claimed, 'extraction.criteria', 'is not a ratio object'));
    return;
  }
  for (const key of Object.keys(criteria)) {
    if (!CRITERIA_KEYS.includes(key)) {
      rejections.push(
        refusal(
          'override',
          claimed,
          `extraction.criteria.${key}`,
          'is not a field of a criteria ratio, which carries a checked count and a total',
        ),
      );
    }
  }
  const checked = readInteger(criteria.checked);
  const total = readInteger(criteria.total);
  if (checked === null || checked < 0) {
    rejections.push(
      refusal(
        'override',
        claimed,
        'extraction.criteria.checked',
        `${show(criteria.checked)} is not a count`,
      ),
    );
  }
  if (total === null || total < 0) {
    rejections.push(
      refusal(
        'override',
        claimed,
        'extraction.criteria.total',
        `${show(criteria.total)} is not a count`,
      ),
    );
  }
  if (checked !== null && total !== null && checked > total) {
    rejections.push(
      refusal('override', claimed, 'extraction.criteria.checked', `${checked} > ${total} total`),
    );
  }
}

function checkBlockedBy(
  blockedBy: readonly number[] | undefined,
  claimed: string,
  rejections: Rejection[],
): void {
  if (!isList(blockedBy)) {
    rejections.push(
      refusal('override', claimed, 'extraction.blockedBy', 'is not a list of Ticket numbers'),
    );
    return;
  }
  for (const [at, member] of readArray(blockedBy).entries()) {
    const value = readInteger(member);
    if (value === null || value < 0) {
      rejections.push(
        refusal(
          'override',
          claimed,
          `extraction.blockedBy[${at}]`,
          `${show(member)} is not a Ticket number`,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * On a key hit, merge only the fields that genuinely disagree with the parser's Extraction
 * and name them in `correctedFields`. Claiming a correction that did not happen is worse
 * than claiming none: the marker is the reader's only signal that a card was touched.
 *
 * Entries are validated whole when the store is read, so anything reaching here is already
 * known-good and `rejections` is empty. The list stays on the result because the seam
 * counts it either way, and because a refusal that can only be seen at apply time has
 * somewhere to go the day one exists.
 */
export function applyOverride(
  extraction: Extraction,
  annotationKey: string,
  contentSha: string | null,
  index: AnnotationIndex,
): OverrideResult {
  const unchanged: OverrideResult = { extraction, correctedFields: [], rejections: [] };
  if (typeof annotationKey !== 'string' || typeof contentSha !== 'string') return unchanged;
  if (contentSha.length === 0) return unchanged;
  if (!isMap(index?.byKey)) return unchanged;

  const entry = index.byKey.get(compositeKey(annotationKey, contentSha));
  return applyAnnotationExtraction(extraction, entry?.extraction);
}

/**
 * Diff a validated Extraction payload without looking it up or giving it Override semantics.
 * Reconciliation uses this for private parser-bug evidence, which must be rechecked against the
 * current parser but must never be applied to the published Snapshot.
 */
export function applyAnnotationExtraction(
  extraction: Extraction,
  annotated: AnnotationExtraction | undefined,
): OverrideResult {
  const unchanged: OverrideResult = { extraction, correctedFields: [], rejections: [] };
  if (annotated === undefined) return unchanged;

  const corrected: string[] = [];
  let merged = extraction;

  if (annotated.title !== undefined && annotated.title !== extraction.title) {
    corrected.push('title');
    // `titleSource` is left alone deliberately: none of its three values names an
    // Annotation, and claiming `h1` here would assert a source the file does not have.
    merged = { ...merged, title: annotated.title };
  }

  const criteria = annotated.criteria;
  if (
    criteria !== undefined &&
    (criteria.checked !== extraction.criteria.checked ||
      criteria.total !== extraction.criteria.total)
  ) {
    corrected.push('criteria');
    // The item texts stay the parser's. An Override on `criteria` corrects the ratio, and
    // replacing the items with nothing would trade one wrong number for an empty list
    // nobody asked for.
    const next: Criteria = {
      checked: criteria.checked,
      total: criteria.total,
      items: extraction.criteria.items,
    };
    merged = { ...merged, criteria: next };
  }

  if (annotated.blockedBy !== undefined && !sameNumbers(annotated.blockedBy, extraction.blockedBy)) {
    corrected.push('blockedBy');
    merged = { ...merged, blockedBy: [...annotated.blockedBy] };
  }

  if (Object.hasOwn(annotated, 'externalBlocker')) {
    const value = annotated.externalBlocker ?? null;
    if (value !== extraction.externalBlocker) {
      corrected.push('externalBlocker');
      merged = { ...merged, externalBlocker: value };
    }
  }

  if (annotated.rawStatus !== undefined && annotated.rawStatus !== extraction.rawStatus) {
    corrected.push('rawStatus');
    // Code derives, so the prefix and the qualifier are re-read from the corrected value
    // through the same rule module the parser used. An empty value means the field is
    // absent, which is how the parser spells it too.
    const raw = annotated.rawStatus;
    const read = readStatus(raw.length === 0 ? undefined : raw);
    merged = {
      ...merged,
      rawStatus: raw,
      statusPresent: read.present,
      statusPrefix: read.prefix,
      qualifier: read.qualifier,
    };
  }

  if (Object.hasOwn(annotated, 'ticketType')) {
    const routing = readTypeRouting(annotated.ticketType ?? undefined);
    if (routing.ticketType !== extraction.ticketType) {
      corrected.push('ticketType');
      // HITL follows the `Type:` value and is never asserted by an Annotation directly.
      merged = { ...merged, ticketType: routing.ticketType, hitl: routing.hitl };
    }
  }

  if (annotated.dialect !== undefined && annotated.dialect !== extraction.dialect) {
    corrected.push('dialect');
    merged = { ...merged, dialect: annotated.dialect };
  }

  return { extraction: merged, correctedFields: corrected, rejections: [] };
}

// ---------------------------------------------------------------------------
// As-of state
// ---------------------------------------------------------------------------

/**
 * Look an Annotation up by path and compare the hash. Found under the same hash is
 * `current`; found under a different hash is `expired`; not found at all is
 * `never-written`. Nothing is invalidated and nothing is collected — the entry is still
 * "simply not found" by its real key (ADR-0003).
 */
export function asOfState(
  annotationKey: string,
  contentSha: string,
  index: AnnotationIndex,
): AsOfLookup {
  const missing: AsOfLookup = { state: 'never-written', entry: null };
  if (typeof annotationKey !== 'string' || typeof contentSha !== 'string') return missing;
  if (!isMap(index?.byKey) || !isMap(index?.byPath)) return missing;

  if (contentSha.length > 0) {
    const exact = index.byKey.get(compositeKey(annotationKey, contentSha));
    if (exact !== undefined) return { state: 'current', entry: exact };
  }

  const written = readArray(index.byPath.get(annotationKey));
  // Something was written about this path, against content that has since moved. How many
  // files moved is a question about a Digest and about the Feature's current member list,
  // and this function has neither — `readDigestState` answers it.
  if (written.length > 0) return { state: 'expired', entry: null };
  return missing;
}

/**
 * The composed read the seam calls per Feature: as-of lookup, then Digest envelope and
 * Block validation on whatever it found.
 *
 * `memberShas` is the Feature's member list **as it is on disk now** — the other half of the
 * expired-Digest count, and the half that has to come from here because it is derived from
 * content rather than read from the store.
 */
export function readDigestState(
  featureKey: string,
  featureSha: string,
  featureName: string,
  index: AnnotationIndex,
  memberShas: readonly string[],
): DigestRead {
  const lookup = asOfState(featureKey, featureSha, index);
  const raw = lookup.state === 'current' ? lookup.entry?.digest : undefined;

  if (raw === undefined) {
    // `asOfState` answers about *entries*, and an entry is not necessarily a Digest. Asking
    // it alone made the liveness line lie in both directions: a stale Extraction-only entry
    // under a Feature key reported "Digest expired" though none was ever written, and a
    // current entry carrying no Digest reported "never written" while an older Digest sat
    // expired behind it. The three states are a statement about Digests, so they are read
    // from Digests.
    const written = isMap(index?.byPath) ? readArray(index.byPath.get(featureKey)) : [];
    // The **last** entry carrying a Digest, because the store is appended to and `byKey`
    // already resolves a duplicated key the same way: the later entry is the newer statement.
    // That entry is the Digest the panel is about to call expired, so it is the one whose
    // member list the count has to be taken from — an older entry describes an older Digest.
    const digested = written.filter((entry) => entry?.digest !== undefined);
    const newest = digested[digested.length - 1];
    return {
      digest:
        newest === undefined
          ? { kind: 'never-written' }
          : {
              kind: 'expired',
              filesChanged: countChangedPaths(
                memberShas,
                newest.memberShas,
                readString(newest.contentSha) ?? '',
              ),
            },
      rejections: [],
    };
  }
  const validated = validateDigest(raw, featureName, featureKey);
  if (validated.digest === null) {
    // A refused Digest renders as no Digest and surfaces as a counted rejection carrying
    // the naming message, so the model that wrote it can self-correct.
    return { digest: { kind: 'never-written' }, rejections: validated.rejections };
  }
  return {
    digest: { kind: 'current', digest: validated.digest },
    rejections: validated.rejections,
  };
}

/**
 * Overrides whose source content has moved and which the next Reconciliation pass will
 * re-check. The count is surfaced in the board's Digest panel.
 *
 * Counted per path rather than per entry: three historical entries for one file are one
 * Override waiting to be re-checked, not three. A file whose current hash is unknown —
 * unreadable, or torn mid-write — is not counted, because "the content moved" is a claim
 * that needs the new content to make.
 */
export function countPendingRecheck(
  index: AnnotationIndex,
  scannedShasByKey: ReadonlyMap<string, string | null>,
): number {
  if (!isMap(index?.byPath) || !isMap(scannedShasByKey)) return 0;

  let pending = 0;
  for (const [path, entries] of index.byPath) {
    // `byPath` retains history, while `byKey` is the effective last write for one content version.
    // Count only effective entries: a later agreement replaces an old same-key Override, and a
    // later unmarked entry can supersede an older receipt.
    const effective = readArray(entries).filter(
      (entry) =>
        typeof entry?.contentSha === 'string' &&
        index.byKey.get(compositeKey(path, entry.contentSha)) === entry,
    );
    const overrides = effective.filter((entry) => entry.extraction !== undefined);
    if (overrides.length === 0) continue;

    const scanned = scannedShasByKey.get(path);
    if (typeof scanned !== 'string' || scanned.length === 0) continue;
    // A later pass can agree with the parser after an older Override expires. The receipt is
    // positive evidence that the current content was checked, so the historical correction is no
    // longer pending even though it remains in the append-only history under its old hash.
    if (
      effective.some((entry) => entry.reconciled === true && entry.contentSha === scanned)
    ) {
      continue;
    }
    if (overrides.some((entry) => entry.contentSha === scanned)) continue;
    pending += 1;
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Runtime guards. Nothing below trusts a declared type: every value reaching them came off
// disk, and type stripping erases without checking.
// ---------------------------------------------------------------------------

function compositeKey(filePath: string, contentSha: string): string {
  return `${filePath}${KEY_SEPARATOR}${contentSha}`;
}

function refusal(kind: Rejection['kind'], path: string, field: string, message: string): Rejection {
  return { kind, path, feature: null, field, message };
}

/** A plain object, at run time. A declared object type says nothing about what arrived. */
function isRecord(value: object | null | undefined): boolean {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/** Deliberately returns a plain boolean: narrowing an array guard here would widen to `any`. */
function isList(value: object | null | undefined): boolean {
  return Array.isArray(value);
}

function isMap(value: object | null | undefined): boolean {
  return value instanceof Map;
}

function readString(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * `Number.isSafeInteger`, not `Number.isInteger`.
 *
 * `JSON.parse` silently rounds anything past 2^53: the text `9007199254740993` arrives as
 * `9007199254740992`, and `Number.isInteger` waves it through. A Ticket number is an
 * identity, so accepting a rounded one points a blocker at a different Ticket than the file
 * names. `1e100` is an integer by the looser test too, and is not a count of anything.
 */
function readInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** A plain JSON object. `isRecord` cannot take a `JsonValue`, which may be a primitive. */
function isJsonRecord(value: JsonValue | undefined): boolean {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function readArray<T>(value: readonly T[] | null | undefined): readonly T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [];
}

function isStringList(value: readonly string[] | null | undefined): boolean {
  if (!isList(value)) return false;
  return readArray(value).every((member) => typeof member === 'string');
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, at) => value === right[at]);
}

/**
 * A value as it appears in a message. Long strings are shortened **here only** — nothing
 * stored is ever truncated, and a 900-character quotation inside an error buries the field
 * name the message exists to carry.
 */
function safeParserBugEvidenceField(field: string): string {
  const mapped = field.replace(/^extraction/, 'parserBugExtraction');
  if (
    mapped === 'parserBugExtraction' ||
    /^parserBugExtraction\.(?:title|criteria|blockedBy|externalBlocker|rawStatus|ticketType|dialect)$/.test(
      mapped,
    ) ||
    /^parserBugExtraction\.criteria\.(?:checked|total)$/.test(mapped) ||
    /^parserBugExtraction\.blockedBy\[\d+\]$/.test(mapped)
  ) {
    return mapped;
  }
  return 'parserBugExtraction.<unknown-field>';
}

function show(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  // A string is described by its shape and its size, never by its characters. Counting code
  // points is one pass over a value that may be arbitrarily long; quoting it would put
  // model-authored text about a private repository onto the board.
  if (typeof value !== 'string') {
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    if (Array.isArray(value)) return 'a list';
    return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
  }
  let count = 0;
  for (const _point of value) count += 1;
  return `a ${count}-character string`;
}
