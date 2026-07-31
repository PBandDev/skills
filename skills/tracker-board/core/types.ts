/**
 * tracker-board — the frozen type contract.
 *
 * This module has **zero runtime exports**. Everything here is erased by Node's type
 * stripping, so it may only ever be reached through `import type`.
 *
 * Type stripping erases, it does not check (ADR-0002). These declarations are
 * documentation, not a guarantee: every value that arrives from disk — annotation
 * files, digest JSON, ticket text — is validated at runtime independently of the type
 * that describes it.
 *
 * Vocabulary is `CONTEXT.md` § tracker-board. Where a term is capitalised in a comment
 * — Root, Feature, Ticket, Dialect, Lane, Frontier, Snapshot, Annotation, Override,
 * Extraction, Derivation, Digest, Block — it means what the glossary says it means and
 * not a synonym.
 *
 * Widening this file is allowed. Changing the meaning of an existing field is a
 * stop-and-escalate.
 */

// The one statement in this file that survives type stripping. Without it the stripped
// module carries no ESM marker, Node loads it as CommonJS, and importing it yields a
// `default` key — which would make "zero runtime exports" false. It exports nothing.
export {};

/** A value that came off disk and has not been validated yet. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Scan input — what the tree walk hands to the seam
// ---------------------------------------------------------------------------

/** Which issue tracker a Root actually uses. Only `local-markdown` is supported in v1. */
export type TrackerKind = 'local-markdown' | 'github' | 'gitlab';

export interface ScannedFile {
  /**
   * Path relative to the Root's `trackerPath`, POSIX separators, shaped
   * `<feature>/…`. This is the identity of the file across a re-scan.
   */
  readonly path: string;
  /** Absolute path on disk. Displayed and copied; never fetched by the seam. */
  readonly absPath: string;
  /** File contents, or `null` when the file could not be read. */
  readonly text: string | null;
  /** Why the read failed. Present only alongside `text: null`. */
  readonly readError?: string;
}

/**
 * A directory whose contents are missing from {@link Root.files} — it could not be listed,
 * or the walk declined to descend into it.
 *
 * An unreadable *file* is deliberately not one of these: it already arrives as a
 * {@link ScannedFile} carrying its `readError` and renders as an `unparsed` card, so it is
 * stated rather than omitted. A directory whose contents are gone is a genuine omission, and
 * an omission nobody can see is the failure this channel exists to prevent.
 */
export interface UnreadableDir {
  /**
   * POSIX path as the board displays it — tracker-relative for content under `trackerPath`,
   * Root-relative for the domain-model directories that sit outside it. `.` is the tracker
   * directory itself.
   */
  readonly path: string;
  /** Why its contents are missing, verbatim. */
  readonly error: string;
}

export interface Root {
  /** Absolute path of the watched repo. */
  readonly path: string;
  /** Short display name for the repo. */
  readonly label: string;
  /** Absolute path of the tracker directory inside it, normally `<path>/.scratch`. */
  readonly trackerPath: string;
  /** Every file found under `trackerPath`, flat. Grouping into Features is the seam's job. */
  readonly files: readonly ScannedFile[];
  /** Git worktree pointers skipped by the walk. Counted so the omission is never silent. */
  readonly hiddenWorktrees: number;
  /** Detected tracker. Anything but `local-markdown` renders as a warning, not an empty board. */
  readonly tracker: TrackerKind;
  /** ADR documents collected for the domain-model panel. Paths are Root-relative. */
  readonly adrFiles: readonly ScannedFile[];
  /** The Root's glossary, if it has one. Rendered as a counted pointer, never inline. */
  readonly glossaryFile: ScannedFile | null;
  /** Directories the walk could not list. Each becomes one `read-error` warning. */
  readonly unreadableDirs?: readonly UnreadableDir[];
}

export interface Scan {
  readonly roots: readonly Root[];
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Seven Lanes in six columns — Blocked holds `frozen` and `blocked` as labelled
 * sub-lanes. Ordering, first match wins:
 * `parked → ready-for-human → complete → blocked → claimed → HITL-in-Type → agent`,
 * which maps onto these values as
 * `parked → needs-you → complete → blocked → in-progress → needs-you → agent`.
 *
 * `frozen` is not reached by the ladder. It is a `blocked` Ticket promoted by the graph
 * walk once every one of its blocker chains is found to terminate at a human.
 */
export type Lane =
  | 'parked'
  | 'needs-you'
  | 'complete'
  | 'blocked'
  | 'frozen'
  | 'in-progress'
  | 'agent';

/**
 * Derived Ticket state.
 *
 * `unparsed` — the parser could not read the file at all; the card shows its raw filename.
 * `unclassified` — Dialect scoring was ambiguous; the card shows its raw fields.
 * Neither takes a Lane, so neither can be counted into the Frontier or into Done.
 *
 * `done-awaiting-human` is the ladder's `done` seen through a `ready-for-human` Lane
 * assignment: every criterion is checked and a person still has to sign it off. It is
 * `done` and `needs-you` at once, and collapsing it to either loses the thing the card
 * exists to say.
 */
export type TicketState =
  | 'unparsed'
  | 'unclassified'
  | 'parked'
  | 'done'
  | 'done-awaiting-human'
  | 'in-progress'
  | 'blocked'
  | 'frozen'
  | 'ready';

/**
 * Which field vocabulary a Ticket file speaks, decided by scoring observed syntax.
 * `Type:` and a sibling `map.md` are weak priors, never switches.
 */
export type Dialect = 'task' | 'decision' | 'unclassified' | 'unparsed';

/** Parser subsystems whose repeated disagreement is one shared defect, not many Overrides. */
export type ParserComponent =
  | 'identity'
  | 'criteria-region'
  | 'blockers'
  | 'status'
  | 'type-routing'
  | 'dialect-scoring';

/** Where a card's display title came from. `none` means the card falls back to `fileName`. */
export type TitleSource = 'h1' | 'filename' | 'none';

// ---------------------------------------------------------------------------
// Extraction — reading fuzzy facts out of a file. AI-suited (ADR-0001).
// ---------------------------------------------------------------------------

export interface CriteriaItem {
  readonly text: string;
  readonly checked: boolean;
}

/**
 * The `- [ ]` list **above** the first `## Comments` / `## Answer` heading. Conversation
 * appends below, and a triage pass appends a second checkbox list that is not criteria.
 */
export interface Criteria {
  readonly checked: number;
  readonly total: number;
  readonly items: readonly CriteriaItem[];
}

/** One `Name: value` pair observed in the field preamble, before any interpretation. */
export interface RawField {
  readonly name: string;
  readonly value: string;
}

/**
 * Everything read out of a Ticket file. Adjacent to — and never merged with —
 * {@link Derivation}, so a Reconciliation diff is a field comparison rather than a
 * re-run, and so ADR-0001 is checkable by reading one object.
 */
export interface Extraction {
  /** From the filename, `^(\d+)-`, at any width. `null` when the filename carries none. */
  readonly number: number | null;
  /** Display text only. Empty when `titleSource` is `none`. */
  readonly title: string;
  readonly titleSource: TitleSource;
  readonly criteria: Criteria;
  /** Feature-local Ticket numbers. Never digit-scanned off the line. */
  readonly blockedBy: readonly number[];
  /** The unmatched remainder of a `Blocked by:` line. Its presence alone blocks. */
  readonly externalBlocker: string | null;
  /** The `Status:` value verbatim. `''` when the field is absent. */
  readonly rawStatus: string;
  /** Whether a `Status:` field was present at all — absent means `open` on a decision Ticket. */
  readonly statusPresent: boolean;
  /** Longest-prefix match against the known vocabulary, or `null` when nothing matched. */
  readonly statusPrefix: string | null;
  /** The entire remainder after the matched prefix. Never truncated, never dropped. */
  readonly qualifier: string;
  /** The `Type:` value verbatim, for display. `null` when the field is absent. */
  readonly ticketType: string | null;
  /** `HITL` or `AFK` matched inside `Type:` **only** — never the body, never the qualifier. */
  readonly hitl: boolean;
  readonly dialect: Dialect;
  /** Every field observed in the preamble, including unknown ones. An `unclassified` card renders these. */
  readonly rawFields: readonly RawField[];
}

// ---------------------------------------------------------------------------
// Derivation — computing Lane and state. Always code, never AI (ADR-0001).
// ---------------------------------------------------------------------------

export interface Derivation {
  /** `null` for `unparsed` and `unclassified` — they take no Lane. */
  readonly lane: Lane | null;
  readonly state: TicketState;
  /** Id of the terminal human-gated Ticket, on a Frozen card. `null` otherwise. */
  readonly frozenOn: string | null;
  /** Extraction field names an Override disagreed with. Drives the AI-corrected marker. */
  readonly correctedFields: readonly string[];
  /** Blocker numbers that resolve to no Ticket in the Feature. Dangling references block. */
  readonly danglingBlockers: readonly number[];
  /** Frontier membership — blockers all resolved, so an agent could take it now. */
  readonly onFrontier: boolean;
}

// ---------------------------------------------------------------------------
// Cards, Features, Roots, Snapshot
// ---------------------------------------------------------------------------

export interface TicketCard {
  /** Board-wide stable id, `<rootPath>#<file.path>`. Used for blocker navigation. */
  readonly id: string;
  /** Root-tracker-relative POSIX path, as scanned. */
  readonly path: string;
  readonly absPath: string;
  /** The raw filename. What an `unparsed` card shows, so it is always populated. */
  readonly fileName: string;
  /** sha256 of the file text, or `null` when unreadable. Half of an Annotation key (ADR-0003). */
  readonly contentSha: string | null;
  readonly readError: string | null;
  readonly extraction: Extraction;
  readonly derivation: Derivation;
}

/** A schema-less file carried as a link and never parsed. */
export interface SiblingLink {
  readonly label: string;
  readonly path: string;
  readonly absPath: string;
}

export interface LaneCounts {
  readonly blocked: number;
  readonly frozen: number;
  readonly agent: number;
  readonly 'needs-you': number;
  readonly 'in-progress': number;
  readonly complete: number;
  readonly parked: number;
  /** Cards holding no Lane — `unparsed` and `unclassified`. Never folded into a Lane. */
  readonly unlaned: number;
}

/**
 * As-of state of a Feature's Digest.
 *
 * Three states, not two: *expired* and *never written* must not render identically, or
 * the reader learns that Digests do not exist. Distinguishing them needs no sweep and no
 * collection — look the Annotation up by path and compare the hash (ADR-0003).
 */
export type AsOfState = 'current' | 'expired' | 'never-written';

export type FactState = 'done' | 'active' | 'blocked' | 'planned' | 'dropped';

/**
 * `fog` and `out-of-scope` mean **opposite** things — not-yet-specified versus ruled-out
 * — and must be distinguishable without reading the label.
 */
export type BulletTone =
  | 'note'
  | 'risk'
  | 'decision'
  | 'question'
  | 'correction'
  | 'fog'
  | 'out-of-scope';

/** Required, first, exactly one. ≤200 chars, no newlines, no markdown, no links. */
export interface DigestSummaryBlock {
  readonly kind: 'summary';
  readonly text: string;
}

export interface DigestFact {
  readonly label: string;
  readonly value: string;
  readonly state?: FactState;
}

/** 2–6 items · label ≤24 · value ≤48. The Block that replaces charts. */
export interface DigestFactsBlock {
  readonly kind: 'facts';
  readonly items: readonly DigestFact[];
}

/** 2–5 items · ≤100 chars each · title ≤40. */
export interface DigestBulletsBlock {
  readonly kind: 'bullets';
  readonly title?: string;
  readonly tone?: BulletTone;
  readonly items: readonly string[];
}

/** Repo-relative path, copied and never navigated. An absolute URL is rejected in v1. */
export interface DigestLink {
  readonly label: string;
  readonly path: string;
}

/** 1–6 items, uncapped for maps · label ≤40. */
export interface DigestLinksBlock {
  readonly kind: 'links';
  readonly items: readonly DigestLink[];
}

export type DigestBlock =
  | DigestSummaryBlock
  | DigestFactsBlock
  | DigestBulletsBlock
  | DigestLinksBlock;

/** Envelope: 2–6 Blocks, first must be `summary`, aggregate ≤900 authored chars. */
export interface Digest {
  readonly v: 1;
  readonly feature: string;
  readonly blocks: readonly DigestBlock[];
}

/**
 * A discriminated union rather than a nullable Digest, so *expired* stays distinguishable
 * from *never written* everywhere downstream — including in the renderer, which is where
 * flattening them would do the damage.
 */
export type DigestState =
  | { readonly kind: 'current'; readonly digest: Digest }
  | {
      readonly kind: 'expired';
      /**
       * How many of the Feature's **paths** hold different content than when the Digest was
       * written. An added path and a removed path each count one, and so a rename counts two.
       *
       * Not the symmetric difference of the two file lists, which reports **2** for a single
       * edited file and reads as a bug rather than as a count.
       *
       * `null` whenever the number is not answerable — no member list was stored beside the
       * Digest, or the one that was does not verify against the key it was filed under. The
       * renderer says so in words instead; it never prints a number it was not given.
       */
      readonly filesChanged: number | null;
    }
  | { readonly kind: 'never-written' };

export interface FeatureSnapshot {
  readonly name: string;
  /** Root-tracker-relative POSIX path of the Feature directory. */
  readonly path: string;
  /** A Feature may have `spec.md`, or `map.md`, or neither. All three shapes are real. */
  readonly specPath: string | null;
  readonly mapPath: string | null;
  /** Schema-less files in the Feature directory, carried as links and never parsed. */
  readonly siblings: readonly SiblingLink[];
  readonly tickets: readonly TicketCard[];
  readonly counts: LaneCounts;
  /** Ids of this Feature's Frontier Tickets. */
  readonly frontier: readonly string[];
  readonly digest: DigestState;
  /** Hash over the Feature's member files. The Digest Annotation key (ADR-0003). */
  readonly contentSha: string;
  /**
   * The Feature's member files as `<path>:<sha>` pairs, sorted. `contentSha` is the hash of
   * these entries newline-joined, so the two always travel together.
   *
   * Published rather than kept internal because this is what an Annotation's `memberShas`
   * has to be **copied from**. A writer that recomputes the list instead re-implements the
   * path spelling, the unreadable-file sentinel and the sort, and a list that differs from
   * this one in any of them is refused — the expired-Digest count is then lost, silently,
   * for every Feature. Copy this array and this `contentSha` into the entry together.
   *
   * Empty for a Feature the board could not derive: that Feature's `contentSha` is a hash of
   * its name rather than of any member list, and the pair would not verify.
   */
  readonly memberShas: readonly string[];
}

/**
 * One ADR, read as close to links-only as the question allows. No status is ever inferred.
 *
 * The reading is small but it is not "exactly one regex", and saying so was a claim the code
 * stopped meeting the moment it had to find a title as well as a heading: there are separate
 * patterns for the H1, the `## Amendment` heading, and — because markdown has constructs whose
 * contents are not markdown — for fenced code and HTML comments, which are blanked first so
 * neither can fabricate either of the other two.
 */
export interface AdrEntry {
  /**
   * From the filename. `null` when it carries no leading number, and also when the number is
   * too large to represent exactly: past 2^53 two different filenames would round onto one
   * value, so the ordering would stop matching the files it claims to order.
   */
  readonly number: number | null;
  /**
   * From the H1 where there is one, and the filename where there is not — {@link
   * AdrEntry.titleSource} says which. The filename never carries the *title*, which is the
   * whole reason this entry is parsed rather than listed as a link; but it is the only thing
   * left to show when a file has no H1 or could not be read at all.
   */
  readonly title: string;
  /**
   * Where {@link AdrEntry.title} came from, on the same three terms a card's title uses.
   *
   * Only `h1` makes it a title at all. `filename` means the file was read and carries no H1,
   * so the row is showing a file name; `none` means the file could not be read, so nothing
   * about its contents is known and the file name is all there is. Without this the two
   * fallbacks are indistinguishable from a real title, which is a small lie told on every
   * row it applies to.
   */
  readonly titleSource: TitleSource;
  readonly path: string;
  readonly absPath: string;
  /**
   * The literal text of an in-body `## Amendment` heading, quoted verbatim. `null` when
   * absent. "Amended" is not a status — it is heading text, and the panel refuses to
   * turn it into a lifecycle.
   */
  readonly amendmentHeading: string | null;
  /**
   * Why the ADR could not be read, verbatim. `null` when it was read.
   *
   * An ADR that exists and is unreachable is carried here rather than dropped: absent and
   * unreachable are different answers, and rendering them the same way is how a board comes
   * to report a Root as having no decisions when it has decisions nobody can reach.
   */
  readonly readError: string | null;
}

/** The glossary as a counted pointer. Definitions live behind a dialog, never inline. */
export interface GlossaryPointer {
  readonly path: string;
  readonly absPath: string;
  readonly termCount: number;
  readonly sectionCount: number;
  /**
   * Why the glossary could not be read, verbatim. `null` when it was read, and both counts
   * are then `0` — which is why this field exists rather than the counts standing alone: a
   * glossary nobody can reach would otherwise read as a glossary that defines nothing.
   */
  readonly readError: string | null;
}

export type WarningKind =
  | 'unsupported-tracker'
  | 'hidden-worktrees'
  | 'read-error'
  | 'scan-error';

export interface Warning {
  readonly kind: WarningKind;
  /** Absolute Root path the warning belongs to, or `null` when board-level. */
  readonly rootPath: string | null;
  readonly message: string;
}

export interface RootSnapshot {
  readonly path: string;
  readonly label: string;
  readonly trackerPath: string;
  readonly tracker: TrackerKind;
  readonly hiddenWorktrees: number;
  readonly features: readonly FeatureSnapshot[];
  /** Scanned files that sat outside any Feature directory. Represented, never dropped. */
  readonly orphans: readonly SiblingLink[];
  readonly adrs: readonly AdrEntry[];
  readonly glossary: GlossaryPointer | null;
  readonly counts: LaneCounts;
  readonly warnings: readonly Warning[];
}

/**
 * Why an Annotation, an Override or a Digest was refused. Validation rejects and never
 * truncates: the message names the field and the overage so the model that wrote it can
 * self-correct, and rejections are counted on the board because a silently dropped
 * Override is indistinguishable from a parser that quietly regressed.
 */
export interface Rejection {
  readonly kind: 'annotation' | 'override' | 'digest';
  /** The file path the rejected entry claimed to describe. */
  readonly path: string;
  readonly feature: string | null;
  /** Dotted field path, e.g. `bullets.items[3]`. */
  readonly field: string;
  /** e.g. `147 > 100 chars`. */
  readonly message: string;
}

/**
 * The board's one progress figure. `label` ships with it because the number means
 * "finished **and off your desk**" — more Tickets have every box checked than are
 * counted here, since `ready-for-human` overrides completeness. It is the one number a
 * reader quotes, and it moves without any work being undone.
 */
export interface Progress {
  readonly doneCount: number;
  readonly total: number;
  readonly percent: number;
  readonly label: string;
}

/**
 * Two liveness tiers: cards are live to the file system, AI content is as-of a content
 * hash. The standing claim lives in the masthead; numeric counts feed the Digest panel. Cards
 * carry no liveness marker — they are live by definition, and marking them would imply the
 * marker meant something.
 */
export interface Liveness {
  readonly digestsCurrent: number;
  readonly digestsExpired: number;
  readonly digestsNeverWritten: number;
  readonly overridesPendingRecheck: number;
}

/** Correction counts. Per-Lane because the filter control is a per-column header button. */
export interface CorrectionCounts {
  readonly total: number;
  readonly byLane: LaneCounts;
}

export interface OverrideCounts {
  readonly applied: number;
  readonly rejected: number;
}

export interface Snapshot {
  readonly schemaVersion: number;
  readonly roots: readonly RootSnapshot[];
  readonly counts: LaneCounts;
  readonly frontierCount: number;
  readonly progress: Progress;
  readonly liveness: Liveness;
  readonly rejections: readonly Rejection[];
  readonly overrides: OverrideCounts;
  readonly corrections: CorrectionCounts;
  readonly warnings: readonly Warning[];
}

// ---------------------------------------------------------------------------
// Annotations — AI-owned state (ADR-0001, ADR-0003)
// ---------------------------------------------------------------------------

/**
 * The fields an Annotation is allowed to carry. Extraction only.
 *
 * There is deliberately no field here for a Lane, a state, Frontier membership or a
 * count. The rule is a schema constraint rather than a prompt instruction, because a
 * prompt instruction is a request and a missing field is a wall.
 */
export interface AnnotationExtraction {
  readonly title?: string;
  readonly criteria?: { readonly checked: number; readonly total: number };
  readonly blockedBy?: readonly number[];
  readonly externalBlocker?: string | null;
  readonly rawStatus?: string;
  readonly ticketType?: string | null;
  readonly dialect?: Dialect;
}

export interface AnnotationEntry {
  readonly schemaVersion: number;
  /**
   * **Root-qualified** path of the file — or Feature directory — described, shaped
   * `<rootPath>#<relPath>`.
   *
   * The Root prefix is load-bearing, not decoration. One board watches several Roots
   * against one store, and Root-relative paths collide across them: two repos both
   * holding `payments/issues/01.md` would share an Override whenever their hashes
   * matched, and would mark each other expired whenever they did not.
   */
  readonly filePath: string;
  /** The other half of the key. A changed file simply does not match; nothing is swept. */
  readonly contentSha: string;
  /**
   * Code-stamped receipt that the independent Reconciliation pass examined this exact content.
   * Its absence keeps legacy/manual entries eligible for the first standing pass; its only valid
   * value is `true`, so an authored false cannot masquerade as a checkpoint.
   */
  readonly reconciled?: true;
  /**
   * Code-stamped evidence for a shared parser defect, kept separate so it is never applied as an
   * Override. It carries only component values needed to revalidate the independent disagreement,
   * remains pending, and is re-diffed against the current parser before a later threshold.
   */
  readonly parserBugExtraction?: AnnotationExtraction;
  readonly extraction?: AnnotationExtraction;
  /** Untrusted until `internal/digest.ts` validates it. */
  readonly digest?: JsonValue;
  /**
   * The Feature's member list as it stood when the Digest was written, for the
   * expired-Digest file count. **Copy `FeatureSnapshot.memberShas` verbatim**, together with
   * the `contentSha` published beside it.
   *
   * `<path>:<sha>` pairs, not bare hashes. The path half is the whole point: bare hashes can
   * only be compared as a set, and a set difference calls a single edited file two changes.
   * A list that does not hash back to this entry's `contentSha` is not diffed at all — the
   * count is dropped rather than guessed, because a wrong count is printed as fact.
   */
  readonly memberShas?: readonly string[];
}

export interface AnnotationStore {
  readonly schemaVersion: number;
  readonly entries: readonly AnnotationEntry[];
}
