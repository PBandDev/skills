/**
 * The `Status:` field.
 *
 * Vocabulary here is `CONTEXT.md`'s — Ticket, Dialect, Lane — and means what the glossary
 * says it means.
 *
 * Statuses are **unbounded free text**. The longest observed in the sample ran 178
 * characters, and real ones run far longer, carrying the delivery pointer that makes the
 * status worth reading at all.
 *
 * Three ways to get this wrong, all silent:
 *   1. equality-match `resolved` → an `unparsed` card for a finished Ticket
 *   2. truncate the value → the delivery pointer is destroyed
 *   3. longest-prefix match but drop the remainder → the same loss, more quietly
 *
 * So: **case-insensitive longest-prefix** match against the known vocabulary, keeping the
 * **entire** remainder as a displayable qualifier. A prefix that matches nothing leaves
 * `prefix: null` with the raw text preserved rather than discarded.
 *
 * An **absent** `Status:` is not the same as an unrecognised one. On a decision Ticket
 * absence means `open` — "open" is the *absence* of a value upstream, and treating it as
 * unparsed renders a freshly generated map as an entirely unparsed Feature. That
 * distinction is carried by `present`.
 *
 * The vocabulary covers the five canonical triage roles plus the decision lifecycle
 * values, and recognises the retired role still present in upstream docs rather than
 * ignoring it.
 *
 * Fixtures: `status-long-prose`, `status-uppercase-with-commit`, `status-parked-wontfix`,
 * `decision-status-absent`, `status-bold-wrapped`, `status-hitl-in-qualifier`.
 *
 * ---------------------------------------------------------------------------
 * Decisions this module takes, which the rules above leave open
 * ---------------------------------------------------------------------------
 *
 * **An absent field reads as `open`, and that is not a Dialect judgement made here.** The
 * signature takes a value, not a Dialect, so the default is applied unconditionally. It is
 * inert on a task Ticket, where the only prefix the ladder reads is a parking value
 * (`wontfix`, `closed`) and `open` is not one — on a task Ticket `Status:` may only park
 * work, never promote it. `present` stays `false`, so *absent* and *present but
 * unrecognised* remain distinguishable, which is the distinction the ladder needs.
 *
 * **A present-but-empty field is not an absent one.** `Status:` written with nothing after
 * it is what a torn read of `Status: done` looks like while an agent is mid-write. It
 * reads as present with no prefix, which degrades the card to `unparsed` for one scan and
 * resolves itself on the next write. Reading it as *absent* would default it to `open` and
 * promote work on a half-written file, which is the one direction that must never happen.
 *
 * **When nothing matches, the qualifier is the entire value.** The remainder after a
 * prefix that does not exist is the whole string, and it means a reader built from
 * `prefix` plus `qualifier` can never silently show nothing for a status a person can
 * plainly see in the file. Losing the remainder quietly is failure mode 3 above, and an
 * unrecognised status is exactly where it would bite hardest.
 *
 * **A match must end at a boundary.** What follows the matched term has to be the end of
 * the value or a non-alphanumeric character, so `opened by mistake` matches nothing rather
 * than matching `open` with the qualifier `ed by mistake`. This is a refinement on the
 * literal rule and it earns its place by direction: on a decision Ticket a spurious `open`
 * reads as *ready*, which offers an agent work the file never said was available, while the
 * refinement rejects no shape the corpus contains — every observed value is followed by
 * end-of-string, a space, or a dash. The test is over the **first whole code point** of the
 * remainder, not over one character taken by index; the difference is real and it fails
 * open, which is the wrong direction.
 *
 * **Case folding is compared against a fixed-length slice of the raw value, never against
 * a lower-cased copy of the whole thing.** Lower-casing can change a string's length, and
 * an index taken from a folded copy then slices the raw value in the wrong place. Reading
 * the prefix length off the vocabulary term keeps every offset anchored to the raw text.
 *
 * **The vocabulary is a list of terms, not a regular expression**, and the match takes the
 * longest term rather than the first.
 *
 * That last branch is worth flagging rather than leaving to be discovered: **no term in the
 * current list is a prefix of another**, so "longest", "first" and "shortest" all select the
 * same term for every possible input, and the selection is therefore not exercised by any
 * test. It is kept because the rule is stated as longest-prefix in three separate documents
 * and because this vocabulary is the part of the upstream contract already known to be
 * drifting. It becomes live the moment a term is added that another term opens — say a bare
 * `ready` beside `ready-for-human` — and at that point it needs a test of its own, because
 * "first match" would then return `ready` for a `ready-for-human` Ticket and route it to the
 * wrong Lane.
 */

export interface StatusRead {
  /** The value verbatim, `''` when the field is absent. */
  readonly rawStatus: string;
  /** Whether a `Status:` field was present at all. Absent ≠ unrecognised. */
  readonly present: boolean;
  /** The matched vocabulary prefix, lower-cased, or `null` when nothing matched. */
  readonly prefix: string | null;
  /** The entire remainder after the prefix, trimmed of leading space only. Never truncated. */
  readonly qualifier: string;
}

/**
 * The known vocabulary, lower-cased.
 *
 * Three groups, and each one is here because a document says so rather than because it
 * seemed likely:
 *
 *   - the **five canonical triage roles** — `needs-triage`, `needs-info`, `ready-for-agent`,
 *     `ready-for-human`, `wontfix`
 *   - the **retired role** `ready-for-afk`, which upstream documents still name. Recognising
 *     it costs one entry; ignoring it renders a Ticket that reads perfectly to a person as
 *     unparsed
 *   - the **decision lifecycle** — `open`, `claimed`, `resolved` — plus `closed`, which is
 *     the second parking value beside `wontfix`, and `done`, which is how a task Ticket
 *     spells completion
 *
 * Nothing is here speculatively. A value outside this list is not an error: it keeps its
 * raw text and takes no prefix, and the ladder reads that as unparsed rather than guessing.
 */
const VOCABULARY: readonly string[] = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'ready-for-afk',
  'wontfix',
  'closed',
  'open',
  'claimed',
  'resolved',
  'done',
];

/** What an absent field means. Not unknown — upstream writes `Status:` only once it moves. */
const ABSENT_PREFIX = 'open';

const LEADING_SPACE = /^\s+/;

/**
 * A letter or a digit at the **start of the remainder**. A match may not run into one, or
 * it is a different word.
 *
 * Anchored and applied to the remainder rather than to a single character taken by index:
 * an index yields one UTF-16 code unit, so a character outside the basic plane arrives as a
 * lone surrogate, which is in neither class and lets the boundary pass. Measured: `open𐐀`
 * and `open𝟎` both matched `open` under the by-index reading, which on a decision Ticket
 * reads as *ready*.
 */
const BOUNDARY_ALPHANUMERIC = /^[\p{L}\p{N}]/u;

/**
 * Read a `Status:` value. Never throws, and never truncates: whatever it cannot classify
 * it hands back intact for the card to display.
 */
export function readStatus(value: string | undefined): StatusRead {
  // Type stripping erases and does not check, so the declared type is a claim. Anything
  // that is not a string is treated as an absent field rather than coerced into one.
  if (typeof value !== 'string') {
    return { rawStatus: '', present: false, prefix: ABSENT_PREFIX, qualifier: '' };
  }

  const matched = longestPrefix(value);
  if (matched === null) {
    return { rawStatus: value, present: true, prefix: null, qualifier: value };
  }
  return {
    rawStatus: value,
    present: true,
    prefix: matched,
    qualifier: value.slice(matched.length).replace(LEADING_SPACE, ''),
  };
}

/**
 * The longest vocabulary term this value opens with, compared case-insensitively and
 * required to end at a boundary. `null` when none does.
 */
function longestPrefix(value: string): string | null {
  let best: string | null = null;
  for (const term of VOCABULARY) {
    if (best !== null && term.length <= best.length) continue;
    if (!opensWith(value, term)) continue;
    best = term;
  }
  return best;
}

/**
 * Whether `value` opens with `term`, case-insensitively, ending at a boundary.
 *
 * The slice is taken at the term's own length so every offset stays anchored to `value`.
 * Folding the whole value first and indexing into that is the trap: for some characters
 * the folded form is longer, and the qualifier is then cut in the wrong place.
 */
function opensWith(value: string, term: string): boolean {
  // No length guard is needed and one would be decorative: a short value slices to a short
  // string, which cannot equal the term.
  if (value.slice(0, term.length).toLowerCase() !== term) return false;
  // An exhausted value slices to `''`, which the anchored class cannot match, so the end of
  // the string is a boundary without needing to be special-cased.
  return !BOUNDARY_ALPHANUMERIC.test(value.slice(term.length));
}
