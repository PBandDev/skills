/**
 * tracker-board — `core`. The one seam.
 *
 * `deriveSnapshot` is the **only** runtime export of this module. Everything above it —
 * the tree walk, the watcher, the HTTP/SSE server, the HTML — sits outside and is
 * integration-tested only.
 *
 * It is **pure**: no disk, no clock, no network, no randomness. `node:crypto` hashing is
 * pure computation and is how a card gets the `contentSha` that half of an Annotation key
 * is made of (ADR-0003). Given the same inputs it returns the same Snapshot, which is what
 * stops cards flickering between scans.
 *
 * It **never throws** — rule zero. Agents rewrite the files this reads while
 * the board watches them and the watcher fires *during* a write, so a torn read is the
 * steady state rather than an edge case. Per-Ticket extraction, per-Feature derivation and
 * per-Root assembly are each guarded individually so one bad file cannot take down a scan.
 * Anything unrecognisable degrades to an `unparsed` card showing its raw filename; the next
 * write fires another event a few milliseconds later and the card resolves itself.
 *
 * Every parser rule lives in its own module under `internal/`, each owned by exactly one
 * ticket. This file is wiring: it calls them in a fixed order and assembles the result. A
 * rule change should never need an edit here.
 */

import { createHash } from 'node:crypto';

import type {
  AdrEntry,
  AnnotationStore,
  Criteria,
  Derivation,
  DigestState,
  Extraction,
  FeatureSnapshot,
  GlossaryPointer,
  Lane,
  LaneCounts,
  Rejection,
  Root,
  RootSnapshot,
  Scan,
  ScannedFile,
  SiblingLink,
  Snapshot,
  TicketCard,
  TicketState,
  TrackerKind,
  Warning,
} from './types.ts';

import { extractIdentity, scanFields } from './internal/fields.ts';
import { readStatus } from './internal/status.ts';
import { readBlockers } from './internal/blockers.ts';
import { readCriteria, readTypeRouting } from './internal/criteria.ts';
import { scoreDialect } from './internal/dialect.ts';
import { deriveLane, deriveState } from './internal/derive.ts';
import type { BlockerState } from './internal/derive.ts';
import { resolveBlockers, resolveChains } from './internal/graph.ts';
import type { ChainTicket, GraphTicket } from './internal/graph.ts';
import {
  applyOverride,
  countPendingRecheck,
  readAnnotations,
  readDigestState,
} from './internal/annotations.ts';
import type { AnnotationIndex } from './internal/annotations.ts';
import { memberEntry, memberListSha } from './internal/members.ts';

export type * from './types.ts';

const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * The one number a reader quotes. It counts Tickets that are finished **and off your
 * desk** — more Tickets have every box checked than are counted here, because
 * `ready-for-human` overrides completeness. The figure moves without any work being
 * undone, so the label ships with it.
 */
const PROGRESS_LABEL = 'finished and off your desk';

/** Field-map keys are the field name lower-cased and trimmed: `status`, `blocked by`, `type`. */
const FIELD_STATUS = 'status';
const FIELD_BLOCKED_BY = 'blocked by';
const FIELD_TYPE = 'type';

/**
 * A fresh object every time. Sharing one instance across cards would alias every
 * `unparsed` card's criteria — and its `items` array — onto the same memory, so a caller
 * appending to one card's items would silently rewrite every other card's.
 */
function emptyCriteria(): Criteria {
  return { checked: 0, total: 0, items: [] };
}

/**
 * Root-qualified identity for a scanned path. Root-relative paths collide across Roots — two
 * repos both holding `payments/issues/01.md` would otherwise share an Override.
 *
 * The Root is **length-prefixed** because joining on a bare separator does not actually
 * deliver that guarantee. `#` is a legal character in a directory name everywhere the board
 * runs, so Root `/a#b` with `c` and Root `/a` with `b#c` both spell `/a#b#c`: the two Roots
 * collapse onto one identity and a single Override applies to both. The count says how many
 * characters the Root occupies, so the split is unambiguous however either half is
 * punctuated.
 *
 * The result stays **printable** — no control characters, no NUL — because this string is
 * also the card's DOM anchor.
 */
function annotationKey(rootPath: string, relPath: string): string {
  return `${rootPath.length}#${rootPath}#${relPath}`;
}

const ZERO_COUNTS: LaneCounts = {
  blocked: 0,
  frozen: 0,
  agent: 0,
  'needs-you': 0,
  'in-progress': 0,
  complete: 0,
  parked: 0,
  unlaned: 0,
};

/** Used when the Annotation store itself could not be read. Rule zero applies there too. */
const EMPTY_INDEX: AnnotationIndex = {
  byKey: new Map(),
  byPath: new Map(),
  rejections: [],
  droppedForVersion: 0,
};

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export function deriveSnapshot(scan: Scan, annotations: AnnotationStore): Snapshot {
  const rootSnapshots: RootSnapshot[] = [];
  const rejections: Rejection[] = [];
  const warnings: Warning[] = [];

  let index: AnnotationIndex = EMPTY_INDEX;
  try {
    index = readAnnotations(annotations);
    for (const rejection of index.rejections) rejections.push(rejection);
  } catch (error) {
    index = EMPTY_INDEX;
    warnings.push({
      kind: 'scan-error',
      rootPath: null,
      message: `Annotations could not be read: ${String(error)}`,
    });
  }

  try {
    const rootsValue = scan?.roots;
    const roots = Array.isArray(rootsValue) ? rootsValue : [];
    if (rootsValue !== undefined && !Array.isArray(rootsValue)) {
      // A malformed container must not read as an empty tracker. Erasing the whole board
      // silently is the one degradation that looks exactly like "there is nothing here".
      warnings.push({
        kind: 'scan-error',
        rootPath: null,
        message: 'scan.roots was not a list; no Root could be read from it',
      });
    }
    for (const root of roots) {
      try {
        const built = buildRoot(root, index, rejections);
        rootSnapshots.push(built);
        for (const warning of built.warnings) warnings.push(warning);
      } catch (error) {
        // Rule zero: one unreadable Root degrades to a stated warning, never to a
        // failed scan of the Roots beside it.
        warnings.push({
          kind: 'scan-error',
          rootPath: readString(root?.path),
          message: `Root could not be assembled: ${String(error)}`,
        });
      }
    }
  } catch (error) {
    warnings.push({
      kind: 'scan-error',
      rootPath: null,
      message: `Scan could not be assembled: ${String(error)}`,
    });
  }

  const cards = rootSnapshots.flatMap((root) =>
    root.features.flatMap((feature) => feature.tickets),
  );
  const counts = countLanes(cards);
  const frontierCount = cards.filter((card) => card.derivation.onFrontier).length;
  const corrected = cards.filter((card) => card.derivation.correctedFields.length > 0);

  let digestsCurrent = 0;
  let digestsExpired = 0;
  let digestsNeverWritten = 0;
  for (const root of rootSnapshots) {
    for (const feature of root.features) {
      if (feature.digest.kind === 'current') digestsCurrent += 1;
      else if (feature.digest.kind === 'expired') digestsExpired += 1;
      else digestsNeverWritten += 1;
    }
  }

  const shasByPath = new Map<string, string | null>();
  for (const card of cards) shasByPath.set(card.id, card.contentSha);

  let pendingRecheck = 0;
  try {
    pendingRecheck = countPendingRecheck(index, shasByPath);
  } catch {
    pendingRecheck = 0;
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    roots: rootSnapshots,
    counts,
    frontierCount,
    progress: {
      doneCount: counts.complete,
      total: cards.length,
      percent: cards.length === 0 ? 0 : Math.round((counts.complete / cards.length) * 100),
      label: PROGRESS_LABEL,
    },
    liveness: {
      digestsCurrent,
      digestsExpired,
      digestsNeverWritten,
      overridesPendingRecheck: pendingRecheck,
    },
    rejections,
    overrides: {
      applied: corrected.length,
      rejected: rejections.filter((rejection) => rejection.kind === 'override').length,
    },
    corrections: { total: corrected.length, byLane: countLanes(corrected) },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

interface FeatureFiles {
  readonly ticketFiles: ScannedFile[];
  readonly siblingFiles: ScannedFile[];
}

function buildRoot(
  root: Root,
  index: AnnotationIndex,
  rejections: Rejection[],
): RootSnapshot {
  const rootPath = readString(root?.path) ?? '';
  const filesValue = root?.files;
  const files = Array.isArray(filesValue) ? filesValue : [];

  const warnings: Warning[] = [];
  if (filesValue !== undefined && !Array.isArray(filesValue)) {
    warnings.push({
      kind: 'scan-error',
      rootPath,
      message: 'Root.files was not a list; no file could be read from this Root',
    });
  }

  const grouped = new Map<string, FeatureFiles>();
  const orphans: SiblingLink[] = [];

  for (const file of files) {
    const relPath = toPosix(readString(file?.path) ?? '');
    const segments = relPath.split('/').filter((segment) => segment.length > 0);
    if (segments.length < 2) {
      // Not under a Feature directory. Represented rather than dropped — a file the
      // Snapshot does not mention is a file nobody knows the board ignored.
      orphans.push(toLink(file, relPath));
      continue;
    }
    const featureName = segments[0] ?? '';
    let bucket = grouped.get(featureName);
    if (bucket === undefined) {
      bucket = { ticketFiles: [], siblingFiles: [] };
      grouped.set(featureName, bucket);
    }
    if (segments[1] === 'issues' && segments.length > 2) bucket.ticketFiles.push(file);
    else bucket.siblingFiles.push(file);
  }

  const features: FeatureSnapshot[] = [];
  for (const featureName of [...grouped.keys()].sort(compareStrings)) {
    const bucket = grouped.get(featureName);
    if (bucket === undefined) continue;
    try {
      features.push(buildFeature(rootPath, featureName, bucket, index, rejections));
    } catch (error) {
      features.push(degradedFeature(rootPath, featureName, bucket, String(error)));
    }
  }

  const tracker = readTracker(root?.tracker);
  if (tracker !== 'local-markdown') {
    warnings.push({
      kind: 'unsupported-tracker',
      rootPath,
      message: `${tracker} is not a supported tracker; only local markdown is read`,
    });
  }
  const hiddenWorktrees = readCount(root?.hiddenWorktrees);
  if (hiddenWorktrees > 0) {
    warnings.push({
      kind: 'hidden-worktrees',
      rootPath,
      message: `hidden: ${hiddenWorktrees} worktree${hiddenWorktrees === 1 ? '' : 's'}`,
    });
  }

  // A directory the walk could not list is the one omission the board cannot state any
  // other way: an unreadable *file* already arrives as an `unparsed` card carrying its
  // reason, so it is visible, while the contents of an unlistable directory are simply
  // absent. Same runtime guarding as the two warnings above — this arrives from outside.
  const unreadableValue = root?.unreadableDirs;
  if (unreadableValue !== undefined && !Array.isArray(unreadableValue)) {
    warnings.push({
      kind: 'scan-error',
      rootPath,
      message: 'Root.unreadableDirs was not a list; omitted directories cannot be shown',
    });
  } else {
    for (const entry of unreadableValue ?? []) {
      const where = readString(entry?.path) ?? '';
      const why = readString(entry?.error) ?? 'no reason given';
      warnings.push({
        kind: 'read-error',
        rootPath,
        message: `${where === '' ? 'a directory' : where} could not be listed, so its contents are missing from this board: ${why}`,
      });
    }
  }

  // The domain-model inputs. Same runtime guarding as the three warnings above, and for the
  // same reason: an `adrFiles` that is not a list would otherwise render as a Root that has no
  // ADRs, which is a different and perfectly ordinary answer.
  const adrValue = root?.adrFiles;
  if (adrValue !== undefined && !Array.isArray(adrValue)) {
    warnings.push({
      kind: 'scan-error',
      rootPath,
      message: 'Root.adrFiles was not a list; no ADR could be read from this Root',
    });
  }

  // The same guard on the glossary, and its absence was an asymmetry rather than a decision:
  // a `glossaryFile` that was a bare string, a number or a list became `glossary: null`, which
  // is the ordinary answer "this Root has no glossary". The malformed case and the absent case
  // were indistinguishable — the exact collision the line above exists to prevent, on the field
  // beside it.
  const glossaryValue = root?.glossaryFile ?? null;
  if (glossaryValue !== null && !isRecord(glossaryValue)) {
    warnings.push({
      kind: 'scan-error',
      rootPath,
      message: 'Root.glossaryFile was not a file record; the glossary could not be read from this Root',
    });
  }

  return {
    path: rootPath,
    label: readString(root?.label) ?? rootPath,
    trackerPath: readString(root?.trackerPath) ?? '',
    tracker,
    hiddenWorktrees,
    features,
    orphans,
    adrs: buildAdrs(Array.isArray(adrValue) ? adrValue : []),
    glossary: buildGlossary(isRecord(glossaryValue) ? glossaryValue : null),
    counts: countLanes(features.flatMap((feature) => feature.tickets)),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Domain model — the ADR ledger and the glossary pointer
//
// Both are repo-scoped rather than Feature-scoped, which is why they hang off the Root and
// not off a column. The walk collects the files (`Root.adrFiles`, `Root.glossaryFile`, both
// carrying Root-relative paths); everything below is the reading, and it is deliberately the
// smallest reading that answers the question.
//
// **What is refused here is as load-bearing as what is read.** An ADR carries no status
// field, so none is inferred: there is no lifecycle, no "deprecated", no "superseded", and
// `amendmentHeading` is the literal text of a heading rather than a state. Ordering by number
// is chronological and is not a progression — there is no next stage for an entry to reach.
// The vocabulary an ADR ledger is drawn in is the vocabulary the files themselves contain.
// ---------------------------------------------------------------------------

/**
 * The ADR ledger, ordered by number.
 *
 * Numerically rather than by path, on the same argument as {@link compareDrafts}: a string
 * sort puts 10 before 2. Zero-padding can mask that defect, but padding is a repository
 * convention rather than a guarantee.
 *
 * An ADR the walk could not read is **kept**, carrying its reason. Dropping it would render a
 * Root whose ADR directory is unreachable identically to a Root that has no ADRs — and those
 * are different answers to different questions.
 */
function buildAdrs(files: readonly ScannedFile[]): readonly AdrEntry[] {
  const entries: AdrEntry[] = [];
  for (const file of files) {
    const relPath = toPosix(readString(file?.path) ?? '');
    const text = readText(file?.text);
    const failure = readFailure(file, text);
    const body = text === null ? '' : readable(text);
    const heading = text === null ? null : h1Of(body);
    const name = baseName(relPath);

    entries.push({
      number: leadingNumber(name),
      // Three answers, told apart rather than collapsed: the H1, the file name when the file
      // was read and carries no H1, and the file name again when it could not be read at all.
      // `titleSource` is what stops the last two claiming to be a title.
      title: heading ?? name,
      titleSource: text === null ? 'none' : heading === null ? 'filename' : 'h1',
      path: relPath,
      absPath: readString(file?.absPath) ?? '',
      amendmentHeading: text === null ? null : amendmentOf(body),
      readError: failure,
    });
  }
  entries.sort(compareAdrs);
  return entries;
}

/**
 * The glossary as a counted pointer: where it is, and how much is in it. Never its contents.
 *
 * `null` means the Root genuinely has no glossary. A glossary that is there and could not be
 * read comes back as a pointer carrying its `readError` and zero counts, because "there is no
 * ubiquitous language here" and "the ubiquitous language could not be reached" are the two
 * answers a reader most needs told apart.
 */
function buildGlossary(file: ScannedFile | null): GlossaryPointer | null {
  if (!isRecord(file)) return null;
  const text = readText(file?.text);
  const body = text === null ? '' : readable(text);
  return {
    path: toPosix(readString(file?.path) ?? ''),
    absPath: readString(file?.absPath) ?? '',
    termCount: countMatches(body, TERM),
    sectionCount: countMatches(body, SECTION),
    readError: readFailure(file, text),
  };
}

/**
 * Why a scanned file could not be read, or `null` when it was.
 *
 * A `text` of `null` is the fact; the walk's `readError` is the explanation and is not
 * guaranteed to arrive with it. Reporting "unreadable, reason unknown" is still the right
 * answer — an entry that silently becomes readable because nobody said why would be worse.
 */
function readFailure(file: ScannedFile, text: string | null): string | null {
  if (text !== null) return null;
  // An **empty** reason is not a reason. `?? ` alone let `readError: ''` through, and the panel
  // treats an empty string as "there is nothing to say" — so an unreachable file came out
  // carrying no visible error and rendered exactly like a readable one with nothing in it.
  // That is the absent-versus-unreachable collision this whole entry exists to prevent, hiding
  // one layer down.
  const reason = readString(file?.readError) ?? '';
  return reason === '' ? 'the file could not be read' : reason;
}

/**
 * The leading number of an ADR file name, or `null` when it carries none.
 *
 * The number lives in the file name and the title never does, which is the whole reason this
 * module reads an ADR's body at all rather than listing links.
 */
function leadingNumber(fileName: string): number | null {
  const match = /^(\d+)/.exec(fileName);
  if (match === null) return null;
  const value = Number.parseInt(match[1] ?? '', 10);
  // Safe, not merely finite. Past 2^53 `parseInt` rounds, so two different file names collapse
  // onto one number and the ledger's ordering silently stops matching the files — and the panel
  // rejects the same value as unsafe and draws no number at all, so the seam and the screen
  // would disagree about what the file is called. Absent is the honest answer for a number
  // nobody can represent.
  return Number.isSafeInteger(value) ? value : null;
}

/** Chronological by number, entries carrying none last, then by path so the order is total. */
function compareAdrs(a: AdrEntry, b: AdrEntry): number {
  if (a.number !== null && b.number !== null && a.number !== b.number) return a.number - b.number;
  if (a.number !== null && b.number === null) return -1;
  if (a.number === null && b.number !== null) return 1;
  return compareStrings(a.path, b.path);
}

/**
 * Up to three leading spaces is what a heading is allowed to carry and still be one, and the
 * text must begin with something that is not a space: `#` followed only by blanks is a heading
 * with no content, and reporting `title: " "` with `titleSource: 'h1'` claimed a title made of
 * one space.
 */
const H1 = /^ {0,3}#[ \t]+(\S[^\n]*?)[ \t]*$/m;

/**
 * The optional closing run of `#` on an ATX heading, which is punctuation rather than title.
 *
 * `# Real title ###` is a heading whose text is `Real title`. Carrying the hashes through put
 * them on screen as part of the title. The space before them is required: `# Title#` really
 * does end in a hash.
 */
const CLOSING_HASHES = /[ \t]+#+$/;

/**
 * The one regex the design admits to. An `## Amendment` heading is quoted, never interpreted:
 * the panel prints this text and says nothing about what it means, because "amended" is not a
 * status and an ADR has no status field for it to be one of.
 *
 * Matched case-insensitively so a heading is not missed on its first letter, and captured
 * verbatim so nothing is normalised on the way out.
 */
const AMENDMENT = /^ {0,3}##[ \t]+(Amendment\b.*?)[ \t]*$/im;

/**
 * A glossary term: a line opening with a bold span that is followed by a colon.
 *
 * The colon is what makes this a definition rather than a bold sentence. `CONTEXT.md` wraps
 * its entries, so a continuation line can itself begin with a bold span — `**auto-expires
 * when its source changes** rather than lying forever.` is the back half of the Annotation
 * entry, not a thirtieth term, and it is excluded by carrying no colon.
 */
const TERM = /^\*\*[^*\n]+\*\*.*:/gm;

/** A section: any heading below the document's own title. */
const SECTION = /^ {0,3}#{2,6}[ \t]+\S/gm;

/**
 * The H1's text, with any closing run of hashes removed.
 *
 * The strip can never empty the result, and that is worth saying rather than guarding: the
 * capture begins at the first non-space character and {@link CLOSING_HASHES} requires
 * whitespace before the run, so a heading whose entire content is hashes — `# ###` — has no
 * internal space and keeps them. That is the literal text after the marker, which is what this
 * function is for, so an empty-string guard would represent a case that cannot arise.
 */
function h1Of(body: string): string | null {
  const text = H1.exec(body)?.[1];
  return text === undefined ? null : text.replace(CLOSING_HASHES, '');
}

function amendmentOf(body: string): string | null {
  return AMENDMENT.exec(body)?.[1] ?? null;
}

function countMatches(body: string, pattern: RegExp): number {
  // A fresh scanner per call: a `g` pattern carries `lastIndex` between uses, so sharing one
  // would make the second Root's counts depend on the first Root's text.
  return [...body.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

/**
 * The text as the line-anchored patterns below need to see it: no byte-order mark, no fenced
 * code, no HTML comment. One function so the three are never applied in one place and
 * forgotten in the other.
 */
function readable(text: string): string {
  return blankOut(withoutBom(text));
}

/**
 * The text without a leading byte-order mark.
 *
 * The walk reads bytes and decodes them without stripping a mark. Every read below is anchored
 * to the start of a line, so a leading U+FEFF sits between the start of the file and the `#` of
 * its H1 and makes the title unreadable. The entry would then report `titleSource: 'filename'`,
 * which means "read, and carries no H1": a false statement about a file that has one.
 *
 * Only a leading mark, and only one: anywhere else U+FEFF is a zero-width no-break space and is
 * content, not framing.
 */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Every line terminator JavaScript's regular-expression engine treats as one.
 *
 * The splitter below and the line-anchored patterns above **must agree about where a line
 * ends**, and splitting on `\n` alone does not: `^` and `$` under `m` also break on a lone
 * carriage return and on U+2028/U+2029. A file using old-style CR endings therefore arrived
 * as a single unsplittable line here — no fence ever opened — while the H1 and Amendment
 * patterns saw every line perfectly, so fenced content was matched as though it were prose.
 * Normalising here is what makes the two views identical.
 */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** A closing fence carries its marker and nothing else but trailing whitespace. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** An opening fence, with whatever info string follows it. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The text with everything that is not live markdown blanked out, line for line.
 *
 * Every read above is a line-anchored pattern, and markdown has two constructs whose contents
 * are **not** markdown at all. Both can fabricate ADR metadata in the same way: an ADR can be
 * mistaken for metadata quoted by its own documentation:
 *
 *   - a **fenced code block**. An ADR documenting the amendment convention by quoting
 *     `## Amendment` inside a fence would otherwise be marked as amended by its own example.
 *     The closer is strict: same character, at least as long, and nothing after it but
 *     whitespace. A lax closer let ```` ```still-code ```` end a block and expose the rest of
 *     the file. A backtick opener whose info string contains a backtick is not a fence at all.
 *   - an **HTML comment**. A commented-out draft heading is the most ordinary thing to find in
 *     a decision record, and it is not a heading.
 *
 * Blanking rather than deleting keeps the line count, so nothing downstream shifts. An
 * unclosed fence or comment runs to the end of the file, which is what markdown itself does.
 */
function blankOut(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let inComment = false;

  for (const line of text.split(LINE_BREAK)) {
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      out.push('');
      continue;
    }
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line)?.[1] ?? null;
      if (close !== null && close[0] === fence[0] && close.length >= fence.length) fence = null;
      out.push('');
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    const marker = open?.[1] ?? '';
    // A backtick fence's info string may not itself contain a backtick, so a line like
    // ``` `a`b ``` opens nothing and must not be allowed to swallow the file that follows it.
    if (open !== null && !(marker.startsWith('`') && (open[2] ?? '').includes('`'))) {
      fence = marker;
      out.push('');
      continue;
    }
    if (/^ {0,3}<!--/.test(line)) {
      if (!line.includes('-->')) inComment = true;
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function buildFeature(
  rootPath: string,
  featureName: string,
  bucket: FeatureFiles,
  index: AnnotationIndex,
  rejections: Rejection[],
): FeatureSnapshot {
  const siblings = bucket.siblingFiles.map((file) =>
    toLink(file, toPosix(readString(file?.path) ?? '')),
  );
  const specPath = siblings.find((link) => baseName(link.path) === 'spec.md')?.path ?? null;
  const mapPath = siblings.find((link) => baseName(link.path) === 'map.md')?.path ?? null;

  const drafts = bucket.ticketFiles.map((file) =>
    buildDraft(rootPath, file, mapPath !== null, index, rejections),
  );
  drafts.sort(compareDrafts);

  const graphTickets: GraphTicket[] = drafts.map((draft) => ({
    id: draft.id,
    number: draft.extraction.number,
    blockedBy: draft.extraction.blockedBy,
    extraction: draft.extraction,
  }));
  const resolved = safeResolveBlockers(graphTickets);

  const laddered = drafts.map((draft) => {
    const resolution = resolved.get(draft.id);
    const blockerStates: readonly BlockerState[] =
      resolution?.blockerStates ?? draft.extraction.blockedBy.map(() => null);
    const dangling = resolution?.dangling ?? draft.extraction.blockedBy;
    let state: TicketState = 'unparsed';
    let lane: Lane | null = null;
    try {
      state = deriveState(draft.extraction, blockerStates);
      lane = deriveLane(draft.extraction, state);
    } catch {
      // A Ticket the ladder cannot place is an `unparsed` card, never a failed Feature.
      state = 'unparsed';
      lane = null;
    }
    return { draft, state, lane, dangling };
  });

  const chainTickets: ChainTicket[] = laddered.map((entry) => ({
    id: entry.draft.id,
    number: entry.draft.extraction.number,
    blockedBy: entry.draft.extraction.blockedBy,
    state: entry.state,
    lane: entry.lane,
    externalBlocker: entry.draft.extraction.externalBlocker,
  }));
  const chains = safeResolveChains(chainTickets);

  const tickets: TicketCard[] = laddered.map((entry) => {
    const chain = chains.get(entry.draft.id);
    // Presence, not nullishness: `lane` and `frozenOn` are legitimately `null`, so `??`
    // here would silently discard a graph pass that meant to clear one.
    const derivation: Derivation =
      chain === undefined
        ? {
            lane: entry.lane,
            state: entry.state,
            frozenOn: null,
            correctedFields: entry.draft.correctedFields,
            danglingBlockers: entry.dangling,
            onFrontier: false,
          }
        : {
            lane: chain.lane,
            state: chain.state,
            frozenOn: chain.frozenOn,
            correctedFields: entry.draft.correctedFields,
            danglingBlockers: entry.dangling,
            onFrontier: chain.onFrontier,
          };
    return { ...entry.draft.card, extraction: entry.draft.extraction, derivation };
  });

  const featurePath = featureName;
  // Root-qualified, for the same reason a card id is: one store serves every Root, and
  // two Roots can each hold a Feature called `payments`.
  const featureKey = annotationKey(rootPath, featurePath);
  // `path:sha` pairs, not bare hashes, and sorted so the hash below is a function of the
  // membership rather than of the walk order. `internal/members.ts` owns the spelling of
  // both, because the expired-Digest count compares two of these lists and a second copy of
  // the convention is exactly how the two sides come to disagree.
  const memberShas = [...bucket.ticketFiles, ...bucket.siblingFiles]
    .map((file) => memberEntry(toPosix(readString(file?.path) ?? ''), readText(file?.text)))
    .sort(compareStrings);
  const contentSha = memberListSha(memberShas);

  let digest: DigestState = { kind: 'never-written' };
  try {
    const read = readDigestState(featureKey, contentSha, featureName, index, memberShas);
    digest = read.digest;
    for (const rejection of read.rejections) rejections.push(rejection);
  } catch (error) {
    rejections.push({
      kind: 'digest',
      path: featureKey,
      feature: featureName,
      field: 'digest',
      message: `could not be read: ${String(error)}`,
    });
  }

  return {
    name: featureName,
    path: featurePath,
    specPath,
    mapPath,
    siblings,
    tickets,
    counts: countLanes(tickets),
    frontier: tickets
      .filter((ticket) => ticket.derivation.onFrontier)
      .map((ticket) => ticket.id),
    digest,
    contentSha,
    memberShas,
  };
}

/** A Feature whose assembly threw still renders — every one of its files as an `unparsed` card. */
function degradedFeature(
  rootPath: string,
  featureName: string,
  bucket: FeatureFiles,
  reason: string,
): FeatureSnapshot {
  const siblings = bucket.siblingFiles.map((file) =>
    toLink(file, toPosix(readString(file?.path) ?? '')),
  );
  const tickets = bucket.ticketFiles.map((file) =>
    unparsedCard(rootPath, file, `feature could not be derived: ${reason}`),
  );
  return {
    name: featureName,
    path: featureName,
    specPath: siblings.find((link) => baseName(link.path) === 'spec.md')?.path ?? null,
    mapPath: siblings.find((link) => baseName(link.path) === 'map.md')?.path ?? null,
    siblings,
    tickets,
    counts: countLanes(tickets),
    frontier: [],
    digest: { kind: 'never-written' },
    contentSha: sha256(featureName),
    // Empty, and deliberately not the real list: this Feature's `contentSha` is a hash of
    // its name rather than of its members, so publishing members beside it would offer a
    // pair that cannot verify and invite a writer to file one. A degraded Feature has no
    // Digest to expire anyway.
    memberShas: [],
  };
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

interface Draft {
  readonly id: string;
  readonly card: TicketCard;
  readonly extraction: Extraction;
  readonly correctedFields: readonly string[];
}

function buildDraft(
  rootPath: string,
  file: ScannedFile,
  hasSiblingMap: boolean,
  index: AnnotationIndex,
  rejections: Rejection[],
): Draft {
  const relPath = toPosix(readString(file?.path) ?? '');
  const text = readText(file?.text);

  if (text === null) {
    const card = unparsedCard(rootPath, file, readString(file?.readError) ?? 'unreadable');
    return { id: card.id, card, extraction: card.extraction, correctedFields: [] };
  }

  const card = baseCard(rootPath, file, relPath, text);

  let extraction: Extraction;
  try {
    extraction = extract(baseName(relPath), text, hasSiblingMap);
  } catch {
    // Rule zero, at its narrowest scope: one Ticket the extractor chokes on is one
    // `unparsed` card, not a lost Feature.
    extraction = emptyExtraction();
  }

  let corrected: readonly string[] = [];
  try {
    const applied = applyOverride(extraction, card.id, card.contentSha, index);
    extraction = applied.extraction;
    corrected = applied.correctedFields;
    for (const rejection of applied.rejections) rejections.push(rejection);
  } catch (error) {
    rejections.push({
      kind: 'override',
      path: card.id,
      feature: null,
      field: 'override',
      message: `could not be applied: ${String(error)}`,
    });
  }

  return { id: card.id, card, extraction, correctedFields: corrected };
}

/** The fixed order every Ticket file is read in. Rules live in the modules, never here. */
function extract(fileName: string, text: string, hasSiblingMap: boolean): Extraction {
  const scanned = scanFields(text);
  const identity = extractIdentity(fileName, scanned.body);
  const status = readStatus(scanned.fields.get(FIELD_STATUS));
  const blockers = readBlockers(scanned.fields.get(FIELD_BLOCKED_BY));
  const criteria = readCriteria(scanned.body);
  const routing = readTypeRouting(scanned.fields.get(FIELD_TYPE));
  const scored = scoreDialect({
    body: scanned.body,
    preamble: scanned.preamble,
    rawFields: scanned.rawFields,
    criteria,
    ticketType: routing.ticketType,
    hasSiblingMap,
  });

  return {
    number: identity.number,
    title: identity.title,
    titleSource: identity.titleSource,
    criteria,
    blockedBy: blockers.blockedBy,
    externalBlocker: blockers.externalBlocker,
    rawStatus: status.rawStatus,
    statusPresent: status.present,
    statusPrefix: status.prefix,
    qualifier: status.qualifier,
    ticketType: routing.ticketType,
    hitl: routing.hitl,
    dialect: scored.dialect,
    rawFields: scanned.rawFields,
  };
}

function baseCard(
  rootPath: string,
  file: ScannedFile,
  relPath: string,
  text: string | null,
): TicketCard {
  return {
    id: annotationKey(rootPath, relPath),
    path: relPath,
    absPath: readString(file?.absPath) ?? '',
    fileName: baseName(relPath),
    contentSha: text === null ? null : sha256(text),
    readError: readString(file?.readError) ?? null,
    extraction: emptyExtraction(),
    derivation: unparsedDerivation(),
  };
}

/** A file that could not be read at all. The card shows its raw filename and says `unparsed`. */
function unparsedCard(rootPath: string, file: ScannedFile, reason: string): TicketCard {
  const relPath = toPosix(readString(file?.path) ?? '');
  return {
    ...baseCard(rootPath, file, relPath, null),
    readError: reason,
  };
}

function emptyExtraction(): Extraction {
  return {
    number: null,
    title: '',
    titleSource: 'none',
    criteria: emptyCriteria(),
    blockedBy: [],
    externalBlocker: null,
    rawStatus: '',
    statusPresent: false,
    statusPrefix: null,
    qualifier: '',
    ticketType: null,
    hitl: false,
    dialect: 'unparsed',
    rawFields: [],
  };
}

function unparsedDerivation(): Derivation {
  return {
    lane: null,
    state: 'unparsed',
    frozenOn: null,
    correctedFields: [],
    danglingBlockers: [],
    onFrontier: false,
  };
}

// ---------------------------------------------------------------------------
// Guarded calls into the graph
// ---------------------------------------------------------------------------

function safeResolveBlockers(
  tickets: readonly GraphTicket[],
): ReturnType<typeof resolveBlockers> {
  try {
    return resolveBlockers(tickets);
  } catch {
    return new Map();
  }
}

function safeResolveChains(
  tickets: readonly ChainTicket[],
): ReturnType<typeof resolveChains> {
  try {
    return resolveChains(tickets);
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

/**
 * Numerically by Ticket number, at any width — a string sort puts 10 before 2 and
 * silently reorders the whole dependency display. Files with no number sort last, then by
 * path so the order is total and stable.
 */
function compareDrafts(a: Draft, b: Draft): number {
  const left = a.extraction.number;
  const right = b.extraction.number;
  if (left !== null && right !== null && left !== right) return left - right;
  if (left !== null && right === null) return -1;
  if (left === null && right !== null) return 1;
  return compareStrings(a.card.path, b.card.path);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function countLanes(cards: readonly TicketCard[]): LaneCounts {
  const tally = { ...ZERO_COUNTS };
  for (const card of cards) {
    const lane = card.derivation.lane;
    // A Lane outside the seven is a derivation bug, not disk data — but counting it into
    // `undefined` would make every board total silently NaN, which reads as the board
    // being broken rather than as one card being wrong. It lands in `unlaned` instead.
    if (lane !== null && Object.hasOwn(tally, lane)) tally[lane] += 1;
    else tally.unlaned += 1;
  }
  return tally;
}

function toLink(file: ScannedFile, relPath: string): SiblingLink {
  return {
    label: baseName(relPath),
    path: relPath,
    absPath: readString(file?.absPath) ?? '',
  };
}

// ---------------------------------------------------------------------------
// Runtime guards. Type stripping erases and does not check, so nothing below trusts a
// declared type: every value here arrived from a disk read outside this module.
// ---------------------------------------------------------------------------

function readString(value: string | undefined | null): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A plain object, which is what a file record has to be before any field is read off it.
 *
 * Arrays are excluded deliberately: `typeof [] === 'object'`, so a bare `typeof` check accepts
 * a list as a record and then reads `undefined` out of every field, producing a pointer to
 * nowhere that looks exactly like a real one.
 */
function isRecord(value: unknown): value is ScannedFile {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function readCount(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readTracker(value: TrackerKind | undefined | null): TrackerKind {
  return value === 'github' || value === 'gitlab' ? value : 'local-markdown';
}

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

function baseName(relPath: string): string {
  const segments = relPath.split('/');
  return segments[segments.length - 1] ?? relPath;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
