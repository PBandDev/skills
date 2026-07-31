/**
 * The `Blocked by:` line.
 *
 * The highest-risk single rule in the project: the dependency graph is built from it, and
 * a wrong edge is invisible on a board that otherwise looks perfect. Every other parser
 * mistake shows up as a card that looks wrong. This one shows up as a card that looks
 * right and is pointing at the wrong Ticket.
 *
 * **Never digit-scan the line.** The naive scan is wrong in four distinct ways that all
 * occur in real files:
 *   - a date yields `[2026, 8, 5]` — one nonexistent Ticket and two real, wrong ones
 *   - a trailing parenthetical `(Runs parallel to 05–08)` yields `[5, 8]`
 *   - `none. Do BEFORE 03` yields `[3]`, which **inverts the dependency direction**
 *   - `— (was 02, 03; …)` yields `[2, 3]` when the truth is no blockers at all, and
 *     mis-parsing that one line moves three cards and two Lane counts
 *
 * The order is the rule: **mask parentheticals first, then split, then read each segment
 * as a Ticket reference or not at all.**
 *
 *   - **Masking comes first because a separator inside a parenthetical is itself a
 *     separator.** Splitting first does not save you: `04 — tracer. (Runs parallel to
 *     05–08; picks up later manifests)` splits on the parenthetical's own `;` into a
 *     second segment that is a fragment of a sentence, and that fragment then reads as an
 *     external blocker on a Ticket whose only real dependency is `04`.
 *   - Splitting happens on **both `,` and `;`**. The tracker spec says comma; real
 *     practice uses semicolons. Comma-only drops four blockers from one real line;
 *     semicolon-only drops one from another. Neither alone is correct.
 *   - A segment names a Ticket in **two shapes only** — a bare number, or a number
 *     introducing a title after a spaced dash — and numbers are read at **any width**,
 *     since a single-digit assumption truncates `10` to `1`, a different Ticket that
 *     probably exists. A number anywhere but the start of a segment is prose, which keeps
 *     `sku2026` and `tickets 10 or 11` out of the graph; a number at the start that is part
 *     of a larger expression is arithmetic, which keeps dates, versions, times, percentages
 *     and amounts out of it.
 *   - A value beginning `none` or a dash yields no blockers **and no `externalBlocker`**,
 *     regardless of what digits or prose follow.
 *   - Any other unmatched remainder is kept as `externalBlocker`, except separator
 *     fragments owned by a preceding titled reference. Its **presence alone** makes the
 *     Ticket blocked. Returning an empty list and stopping is wrong in the most dangerous
 *     direction: it reports the Ticket as ready and offers an agent work that is physically
 *     impossible to start.
 *   - `externalBlocker` is reconstructed from the **original** text, not from the masked
 *     text — masking is for number extraction only. `External events — not before
 *     2026-08-05 (region-A determination; …)` must come back with its parenthetical
 *     intact, because that parenthetical is most of what a reader needs.
 *
 * Masking replaces a parenthetical with **spaces rather than removing it**, so every
 * offset in the masked string still indexes the original. That is what lets the same split
 * produce both the numbers (read from the masked text) and the external remainder (sliced
 * from the original), without a second parse that could disagree with the first.
 *
 * A segment naming a Ticket contributes **only** that number: `02 — Build gates` is one
 * edge, and `— Build gates` is a label for it rather than an external dependency.
 *
 * A segment that names no Ticket normally becomes part of `externalBlocker`, so the Ticket
 * reads blocked. The one ambiguity is title punctuation: after a titled reference, unmatched
 * comma/semicolon fragments continue that title until another valid reference; a bare
 * reference clears that ownership. Put a distinct external blocker before the titled
 * reference. Outside that ambiguity, retaining unmatched text preserves the safety argument:
 * losing a dependency id costs one detail on a still-blocked card, while inventing one
 * produces a plausible, wrong graph that nothing downstream can detect.
 *
 * Residuals, stated rather than guessed at:
 *   - Connectors this format does not define — `&`, `/`, a full-width comma — are not read
 *     as separators. `02 & 03` is kept whole as an external blocker rather than half-read
 *     as `[2]`, which would promote the work as soon as `02` resolved.
 *   - Only `none` and the three dash characters a writer actually reaches for are read as
 *     "no dependency". An ASCII hyphen deliberately is **not**: it also opens a list item
 *     and a negative number, and mistaking one for "no blockers" fails toward offering work
 *     that cannot be started. A hyphen-led value falls through to `externalBlocker`, which
 *     fails toward blocked.
 *   - Duplicate numbers are kept in order rather than collapsed. A repeated edge is
 *     harmless to the graph, and de-duplicating is a repair — this module reports what the
 *     line says.
 */

export interface BlockerRead {
  /** Feature-local Ticket numbers, in the order they appear. */
  readonly blockedBy: readonly number[];
  /** The unmatched remainder, verbatim from the original value. `null` when there is none. */
  readonly externalBlocker: string | null;
}

/** No edges asserted and nothing claimed to be waiting on. */
const NO_BLOCKERS: BlockerRead = { blockedBy: [], externalBlocker: null };

/**
 * A value that **declares** the absence of a dependency, in the shapes real files use:
 * `none`, `none.`, or `none` followed by a spaced dash introducing an aside. A bare dash
 * counts on its own, so `—` and `— (was 02, 03)` are both "no blockers".
 *
 * The declaration shapes are the rule, not the word. `None of the required security reviews
 * has completed` opens with `none` and is a *sentence describing an unmet condition* — it
 * says the Ticket is waiting, not that it is free. Reading it as the sentinel discards a
 * real external blocker and puts the Ticket on the Frontier, which is the worst outcome this
 * module can produce. `none-of-the-vendors has signed` is the same trap with a hyphen.
 */
const NO_DEPENDENCY = /^(?:none(?:\s*[.;]|\s+[-–—―](?=\s)|\s*$)|[–—―](?=\s|$))/i;

/**
 * A segment that names a Ticket. Two shapes, and they are the only two the corpus contains:
 * a bare number, or a number introducing a title after a spaced dash.
 *
 * This is the difference between reading a dependency and reading arithmetic. Requiring one
 * of these two shapes is what keeps `2026-08-05 is the earliest release`, `10% legal
 * approval`, `2.1 release`, `09:00 standup`, `2,000 USD` and `02 & 03` out of the graph —
 * every one of which a leading-digit match turns into an edge, and none of which names a
 * Ticket. A segment that matches neither shape normally falls through to `externalBlocker`,
 * so the Ticket reads as blocked rather than as ready. A fragment owned by a preceding titled
 * reference instead continues that title. Losing the *id* of a dependency is a display gap;
 * inventing one is a lie the board cannot show you.
 */
const BARE_REFERENCE = /^\s*(\d+)\s*\.?\s*$/;
const TITLED_REFERENCE = /^\s*(\d+)\s+[-–—―]\s/;

/** Both separators. The spec says comma; real practice uses semicolons; neither alone is correct. */
const SEPARATORS = ',;';

/**
 * A comma sitting between a digit and exactly three more digits is a thousands separator,
 * not a list separator. `2,000 USD funding approval` otherwise splits into `2` — which is
 * a bare number, and therefore indistinguishable from a real numeric Ticket reference — and
 * `000 USD…`. Neutralised before splitting so the whole amount stays one segment, which
 * then matches neither reference shape and becomes an external blocker.
 *
 * A real list is unaffected: `02, 03` has a space after the comma, and `02,03` has only two
 * digits after it, so neither can match.
 */
const THOUSANDS_SEPARATOR = /(?<=\d),(?=\d{3}(?!\d))/g;

interface Span {
  readonly start: number;
  readonly end: number;
}

export function readBlockers(value: string | undefined): BlockerRead {
  if (typeof value !== 'string') return NO_BLOCKERS;

  // Single-line by contract from the field scan, and reduced to one line here anyway: a
  // value that wrapped would otherwise fold a following prose line into the graph.
  //
  // This reduction is deliberately **not** asserted through the seam, because no input that
  // reaches it can carry a line break — the field scan already delivers one trimmed line, so
  // there is no way to reach the second line of a value from a file. It is kept as the
  // cheapest possible defence against that contract changing, and recorded as unreachable
  // rather than left to look like a tested rule.
  const line = firstLineOf(value).trim();
  if (line.length === 0) return NO_BLOCKERS;
  if (NO_DEPENDENCY.test(line)) return NO_BLOCKERS;

  // Both substitutions preserve length, so every offset into `masked` still indexes `line`.
  const masked = maskParentheticals(line).replace(THOUSANDS_SEPARATOR, ' ');
  const numbers: number[] = [];
  const remainders: string[] = [];
  let titledReferenceOwnsFollowingFragments = false;

  for (const span of splitOnSeparators(masked)) {
    // Sliced from the original, so a masked parenthetical comes back with its text. A
    // segment that masks away to nothing is **not** empty — `02, (vendor sign-off), 03` has
    // a middle segment that is entirely a parenthetical, and skipping it on the masked text
    // would delete the one thing that Ticket is actually waiting on. Emptiness is a fact
    // about the original.
    const original = line.slice(span.start, span.end).trim();
    if (original.length === 0) continue;

    const maskedSegment = masked.slice(span.start, span.end);
    const number = ticketReference(maskedSegment);
    if (number !== null) {
      numbers.push(number);
      // A titled reference owns later punctuation fragments until another reference resets
      // the grammar. Bare references stay compatible with `02, legal sign-off`.
      titledReferenceOwnsFollowingFragments = TITLED_REFERENCE.test(maskedSegment);
      continue;
    }
    if (titledReferenceOwnsFollowingFragments) continue;
    remainders.push(original);
  }

  if (numbers.length === 0) {
    // Nothing in the line resolved to a Ticket, so the whole line is what this Ticket is
    // waiting on — returned verbatim, separators and all, rather than reassembled from the
    // pieces the split happened to produce.
    return { blockedBy: [], externalBlocker: line };
  }

  return {
    blockedBy: numbers,
    // No observed file mixes numbered and external segments in one line, so the joiner is a
    // choice rather than a measurement. It is stated here so a file that ever does mix them
    // changes this deliberately instead of by accident.
    externalBlocker: remainders.length === 0 ? null : remainders.join('; '),
  };
}

/**
 * Every parenthetical replaced by spaces, **preserving length** so offsets into the result
 * still index the original.
 *
 * Nesting is counted, and an unclosed `(` masks to the end of the line: an unterminated
 * parenthetical is far more likely to be a run-on aside than the start of a dependency, and
 * reading its separators would split a sentence into fragments that then read as blockers.
 */
function maskParentheticals(text: string): string {
  const units = text.split('');
  let depth = 0;
  for (let at = 0; at < units.length; at += 1) {
    const unit = units[at];
    if (unit === '(') {
      depth += 1;
      units[at] = ' ';
      continue;
    }
    if (unit === ')') {
      // Only a closer that actually closes something is masked. Blanking an unmatched one
      // would promote whatever follows it to the front of its segment, so `) 02` — a shape
      // a half-written file produces routinely — would read as a dependency on 02 rather
      // than as text nobody can parse.
      if (depth > 0) {
        depth -= 1;
        units[at] = ' ';
      }
      continue;
    }
    if (depth > 0) units[at] = ' ';
  }
  return units.join('');
}

/** Spans between separators. Always at least one span, so a separator-free line is one segment. */
function splitOnSeparators(text: string): readonly Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text[at] ?? '';
    if (SEPARATORS.includes(unit)) {
      spans.push({ start, end: at });
      start = at + 1;
    }
  }
  spans.push({ start, end: text.length });
  return spans;
}

function ticketReference(segment: string): number | null {
  const found = BARE_REFERENCE.exec(segment) ?? TITLED_REFERENCE.exec(segment);
  if (found === null) return null;
  const digits = found[1];
  if (digits === undefined) return null;
  const parsed = Number(digits);
  // A run of digits long enough to lose precision is not a Ticket number, and neither is
  // zero — a `000` left over from a thousands separator resolves to a Ticket nobody wrote.
  // Refusing either normally sends the segment to the remainder rule, which fails toward
  // blocked; after a titled reference owns it, the segment continues that title instead.
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** The first line, tolerating either line ending. */
function firstLineOf(value: string): string {
  const breakAt = value.search(/[\r\n]/);
  return breakAt === -1 ? value : value.slice(0, breakAt);
}
