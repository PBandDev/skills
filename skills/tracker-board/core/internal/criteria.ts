/**
 * The criteria region and `Type:` HITL/AFK routing.
 *
 * Vocabulary here is `CONTEXT.md`'s — Ticket, Criteria, Dialect, Lane — and means what the
 * glossary says it means.
 *
 * Two extractions that share one hazard: both are ruined by matching too widely.
 *
 * **Criteria** are the checkbox list **above** the first `## Comments` or `## Answer`
 * heading. Conversation appends below, and a triage pass appends a *second* checkbox list
 * to the same file. Counting all of them reports a finished Ticket as In progress
 * **permanently**, because a review checklist is never ticked.
 *   - Cut at the **first** such heading, matched by **prefix** so a heading carrying a
 *     calendar stamp or trailing prose still cuts.
 *   - Count both checked and unchecked, giving a ratio and not just a total.
 *   - A Ticket with no checkboxes at all is not an error — that is the decision Dialect.
 *
 * **HITL** and **AFK** are matched **case-insensitively inside `Type:` only** — never the
 * body, never criteria, never the status qualifier. On the sample corpus `HITL` appears in
 * 29 files' prose against 4 in a `Type:` line, overwhelmingly describing sign-offs that
 * **already happened**; a wide match floods the human lane with finished work and asks the
 * user to act on it. The marker is usually parenthetical — `research (AFK)`,
 * `task (HITL — the user relays)` — so match as a **substring**, never equality-match the
 * type value, and preserve the remainder for display.
 *
 * Fixtures: `criteria-below-comments`, `type-hitl-task`, `type-afk-research`, and
 * `status-hitl-in-qualifier` as the negative case — a finished Ticket that must **not**
 * route to the human lane.
 *
 * ---------------------------------------------------------------------------
 * Decisions this module takes, which the rules above leave open
 * ---------------------------------------------------------------------------
 *
 * **The region walk reads code and HTML comments before it reads structure.** A `- [x]`
 * inside a fenced sample is sample text, and a `## Comments` inside one is not a section
 * break — a Ticket that documents its own markup would otherwise cut its region at line one
 * and report `0/0` for a file full of criteria. Three orderings, each bought by a real
 * misread:
 *   - **Fence state resolves first and freezes comment state**, because a comment delimiter
 *     inside a code sample is sample text too. Getting that order wrong lets a single
 *     unmatched `<!--` inside a sample swallow the sample's own closing fence and every
 *     criterion below it. Torn reads leave exactly that shape, and they are the steady
 *     state rather than an edge case.
 *   - **A fence is recognised at any indentation.** CommonMark's three-space allowance is
 *     measured from the enclosing container, and Tickets nest samples under list items at
 *     four, six or eight spaces. Measuring from column 0 misses those fences entirely and
 *     counts the sample's own checkboxes as live criteria.
 *   - **An inline code span's content is inert to comment delimiters.** Prose quoting
 *     `` `<!--` `` while explaining Ticket markup would otherwise open a comment that never
 *     closes, hiding every criterion below it — and hiding an *unchecked* criterion turns
 *     1/2 into 1/1, which reads as finished.
 *
 * Both this walk and `fields.ts`'s are deliberately local to their own module: every rule
 * reads the document for itself, so filling one rule can never move another.
 *
 * **What cuts the region.** A line beginning `##` indented no more than three spaces,
 * followed by whitespace, whose heading text then begins — case-insensitively — with
 * `Comments` or `Answer`. Four readings:
 *   - **prefix, not equality**, so `## Comments (2026-07-24)` and `## Answer — revised`
 *     still cut. The stated cost is that a heading opening with one of those words for an
 *     unrelated reason cuts early. That is the safe direction: an early cut undercounts
 *     visibly, while a missed cut folds a review checklist into the ratio and pins a
 *     finished Ticket at In progress forever, which is the defect this rule exists for.
 *   - **case-insensitively**, because heading casing is a display choice and `## comments`
 *     is the same section by any reading.
 *   - **up to three spaces of indentation**, which is CommonMark's rule, and a fourth space
 *     makes the line indented code rather than a heading. Note this is deliberately *not*
 *     the column-0 reading `fields.ts` takes for the field preamble: there, a window that
 *     runs long only risks collecting an extra unknown field, so the strict reading is
 *     free. Here a missed cut is the measured defect itself, so the two rules resolve the
 *     same ambiguity in opposite directions on purpose.
 *   - **`### ` does not cut**, which is the literal reading of "the first `## ` heading",
 *     and **a heading that is not one of those two does not cut** — the region is bounded
 *     by conversation, not by structure, and criteria routinely sit under `## Criteria` or
 *     below a `## Notes` block.
 *
 * **What a checkbox is.** Optional indentation, one of `-`, `*` or `+`, whitespace, then
 * `[ ]`, `[x]` or `[X]`, then **whitespace or the end of the line**. The trailing rule is
 * load-bearing: without it `- [x](./notes.md)` — an ordinary link whose text is `x` — reads
 * as a ticked criterion. Nested checkboxes count; a sub-criterion is still a criterion, and
 * a ratio that silently omits the indented half of a list is worse than one that does not.
 * Ordered task lists (`1. [ ] …`) are a **deliberate gap**: no observed file writes criteria
 * that way, the three bullet markers are the grammar `fields.ts` already recognises, and
 * admitting `N.` widens the match into numbered prose for no measured gain. When a real file
 * shows the shape, that file becomes the fixture and this rule follows it.
 *
 * **Indentation on a checkbox is not bounded**, and it deliberately is not read as code. A
 * four-space-indented `- [x]` is a nested criterion under the item above it far more often
 * than it is an indented code block, and the two shapes are identical to any reader that
 * does not track markdown containers. Bounding it to defend against the rarer shape would
 * drop real nested criteria — dropping a criterion is the one direction this rule must not
 * take, because the count is what says whether work is finished. A sample fenced at any
 * depth is already suppressed by the fence rule above, which is the shape that actually
 * occurs.
 *
 * **A wrapped criterion keeps its continuation lines.** Corpus criteria wrap constantly, and
 * `items[].text` exists to be rendered — a card showing half a sentence is a card that has
 * to be opened. A following line folds into the item when it is contiguous, indented,
 * non-blank, and is not itself a list item, a heading or a fence. Requiring indentation is
 * tighter than markdown's own lazy continuation on purpose: an unindented line below a
 * checkbox is prose far more often than it is a continuation, and folding prose in would
 * put an unrelated sentence on the card. The counts are unaffected either way — only a line
 * carrying a checkbox marker is ever counted.
 *
 * **`HITL`/`AFK` match on token boundaries, not on bare `indexOf`.** A bare substring test
 * is the rule as stated and is wrong in one direction that matters: `Type: kafka consumer`
 * contains `afk`, and routing it to the human lane is exactly the flood this rule exists to
 * prevent. Bounding the match with non-alphanumeric characters keeps every parenthetical
 * form the corpus writes — `(AFK)`, `(HITL — the user relays)`, `HITL/AFK`, `AFK-research`
 * — while a value has to spell the marker glued to a letter or digit to be missed, which no
 * observed file does. Equality-matching the whole value, which the corpus rules out, is not
 * reintroduced by this: the marker is still found anywhere inside the value.
 *
 * **`items` is uncapped, and the cost is stated rather than guessed.** A pathological file
 * of nothing but checkboxes, at the 4 MiB ceiling the tree walk already enforces, reads in
 * about 140 ms and retains roughly 59 MiB of items. Every real Ticket is three orders of
 * magnitude smaller, so a cap would buy nothing on any observed corpus while making
 * `items.length` disagree with `total` — a card that renders fewer criteria than it counts
 * is the kind of quiet disagreement this seam exists to avoid. Revisit if a Root ever
 * carries files near that ceiling.
 *
 * **The `Type:` value is passed through untouched.** It arrives single-line, trimmed and
 * marker-stripped, and `null` means the field was absent. A present-but-empty `Type:` stays
 * `''` rather than collapsing to `null`, because `null` is the answer to a different
 * question and Dialect scoring reads this value as a weak prior.
 */

import type { Criteria, CriteriaItem } from '../types.ts';

export interface TypeRouting {
  /** The `Type:` value verbatim, for display. `null` when the field is absent. */
  readonly ticketType: string | null;
  /** A human is structurally required. Never inferred from anything but `Type:`. */
  readonly hitl: boolean;
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

/**
 * `##` with whitespace after it, indented no more than three spaces. `### ` is not a
 * section break here, and a fourth space makes the line indented code rather than a
 * heading — both readings are CommonMark's.
 */
const HEADING_LINE = /^ {0,3}##[ \t]+(.*)$/;

/** Matched by prefix against the lower-cased heading text, never by equality. */
const REGION_HEADINGS: readonly string[] = ['comments', 'answer'];

/**
 * A task list item. The trailing `(?:[ \t]+(.*))?$` is what separates a checkbox from a
 * link: `- [x](./notes.md)` has no whitespace after the bracket and is not matched.
 */
const CHECKBOX_LINE = /^[ \t]*[-*+][ \t]+\[([ xX])\](?:[ \t]+(.*))?$/;

/** Any list item, bulleted or numbered. A new item ends the previous item's text. */
const LIST_ITEM_LINE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;

/** Any ATX heading at any depth and any indentation. Ends the previous item's text. */
const ANY_HEADING_LINE = /^[ \t]*#{1,6}[ \t]/;

/** Indented and carrying content — the shape a wrapped criterion's second line takes. */
const CONTINUATION_LINE = /^[ \t]+\S/;

/**
 * A fence opener or closer, at **any** indentation. CommonMark's three-space allowance is
 * relative to the enclosing container, and a sample fenced under a list item sits four,
 * six or eight spaces in — measuring from column 0 misses every one of them and then counts
 * the sample's own checkboxes as criteria. Reading a deeply indented fence as a fence
 * instead costs an indented code block that happens to contain a fence line, which
 * suppresses content rather than inventing it.
 */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * `HITL` or `AFK` standing as its own token, case-insensitively. Bounded by
 * non-alphanumeric characters at both ends so that `kafka` is not read as `AFK`.
 *
 * Deliberately not a global regular expression: a `g` flag carries `lastIndex` across
 * calls, and a shared pattern would then answer differently on the second Ticket than on
 * the first.
 */
const TYPE_MARKER = /(?<![A-Za-z0-9])(?:hitl|afk)(?![A-Za-z0-9])/i;

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;

/**
 * Where a line walk is: inside a fenced code block, or inside an HTML comment. Fence state
 * is checked **first** and freezes comment state, because a comment delimiter inside a code
 * sample is sample text.
 */
interface Cursor {
  fence: string | null;
  commented: boolean;
}

/** An item under construction. Its text grows while its continuation lines are read. */
interface OpenItem {
  text: string;
  checked: boolean;
}

// ---------------------------------------------------------------------------
// readCriteria
// ---------------------------------------------------------------------------

/**
 * Count the criteria above the first `## Comments` / `## Answer` heading.
 *
 * `body` arrives from the field scan already normalised — a leading byte-order mark and any
 * leading frontmatter block removed — so this rule reads it as given rather than repeating a
 * normalisation it can never be the first to perform.
 *
 * Never throws: a file truncated mid-line, mid-comment or mid-fence returns the criteria it
 * did contain, because the watcher fires *during* a write. A Ticket with no checkboxes
 * returns `0/0`, which is an answer and not a failure — decision Tickets carry none.
 */
export function readCriteria(body: string): Criteria {
  const cursor: Cursor = { fence: null, commented: false };
  const items: OpenItem[] = [];
  let checked = 0;
  let open: OpenItem | null = null;

  forEachLine(body, (line) => {
    const visible = readableText(cursor, line);
    if (visible === null) {
      open = null;
      return true;
    }

    const heading = HEADING_LINE.exec(visible);
    if (heading !== null) {
      if (cutsRegion(heading[1] ?? '')) return false;
      open = null;
      return true;
    }

    const box = CHECKBOX_LINE.exec(visible);
    if (box !== null) {
      const item: OpenItem = { text: (box[2] ?? '').trim(), checked: (box[1] ?? ' ') !== ' ' };
      if (item.checked) checked += 1;
      items.push(item);
      open = item;
      return true;
    }

    const current: OpenItem | null = open;
    if (current !== null && isContinuation(visible)) {
      const extra = visible.trim();
      current.text = current.text.length === 0 ? extra : `${current.text} ${extra}`;
      return true;
    }

    open = null;
    return true;
  });

  const frozen: CriteriaItem[] = items.map((item) => ({ text: item.text, checked: item.checked }));
  return { checked, total: frozen.length, items: frozen };
}

/** Prefix, never equality — a real heading carries trailing prose, a stamp or a parenthetical. */
function cutsRegion(headingText: string): boolean {
  const lower = headingText.toLowerCase();
  for (const name of REGION_HEADINGS) {
    if (lower.startsWith(name)) return true;
  }
  return false;
}

/**
 * Whether a line continues the criterion above it. A new list item, a heading or an
 * unindented line ends the criterion instead — folding those in would put an unrelated
 * sentence on the card.
 */
function isContinuation(visible: string): boolean {
  if (!CONTINUATION_LINE.test(visible)) return false;
  if (LIST_ITEM_LINE.test(visible)) return false;
  if (ANY_HEADING_LINE.test(visible)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// readTypeRouting
// ---------------------------------------------------------------------------

/**
 * Read the `Type:` field's routing. The value arrives single-line, trimmed and
 * marker-stripped; `undefined` means the field was absent, and nothing else in the file is
 * consulted — that narrowness is the whole rule.
 */
export function readTypeRouting(typeValue: string | undefined): TypeRouting {
  // A Ticket with no `Type:` line reaches this with nothing to read. Absent is an answer,
  // not a failure — most decision Tickets have no type at all.
  if (typeof typeValue !== 'string') return { ticketType: null, hitl: false };
  return { ticketType: typeValue, hitl: TYPE_MARKER.test(typeValue) };
}

// ---------------------------------------------------------------------------
// The line walk
// ---------------------------------------------------------------------------

/**
 * Visit each line without materialising a line array. A single 4 MiB file of bare newlines
 * is inside the walk's own size cap, and the watcher re-reads every Ticket on every
 * debounced write, so the array is one the board cannot afford to allocate per scan.
 *
 * `\n`, `\r\n` and a lone `\r` all terminate a line, so a file a Windows editor touched
 * yields the same criteria as a file it did not — an invisible trailing `\r` otherwise
 * defeats the end-of-line anchors every pattern here relies on.
 *
 * The visitor returns `false` to stop the walk.
 */
function forEachLine(text: string, visit: (line: string) => boolean): void {
  let start = 0;
  let feed = text.indexOf('\n');
  let carriage = text.indexOf('\r');

  for (;;) {
    if (feed !== -1 && feed < start) feed = text.indexOf('\n', start);
    if (carriage !== -1 && carriage < start) carriage = text.indexOf('\r', start);

    let breakAt = -1;
    if (feed === -1) breakAt = carriage;
    else if (carriage === -1) breakAt = feed;
    else breakAt = feed < carriage ? feed : carriage;

    const end = breakAt === -1 ? text.length : breakAt;
    let nextStart = text.length;
    if (breakAt !== -1) {
      nextStart = breakAt + 1;
      // A carriage return followed by a line feed is one terminator, not two.
      if (text.charCodeAt(breakAt) === CARRIAGE_RETURN && text.charCodeAt(nextStart) === LINE_FEED) {
        nextStart += 1;
      }
    }

    if (!visit(text.slice(start, end))) return;
    if (breakAt === -1) return;
    start = nextStart;
  }
}

/**
 * The part of a line that carries readable content, or `null` when the line is inside a
 * fenced code block or is a fence delimiter. Advances the cursor.
 *
 * A line that *begins* inside a comment still contributes whatever follows the `-->`, so a
 * heading written as `-->## Comments` cuts the region rather than being swallowed with the
 * comment that preceded it.
 */
function readableText(cursor: Cursor, line: string): string | null {
  if (cursor.fence !== null) {
    if (closesFence(line, cursor.fence)) cursor.fence = null;
    return null;
  }
  const seen = outsideComments(line, cursor.commented);
  const opener = fenceTokenOf(seen.visible);
  if (opener !== null) {
    cursor.fence = opener;
    return null;
  }
  cursor.commented = seen.after;
  return seen.visible;
}

function fenceTokenOf(text: string): string | null {
  const match = FENCE_LINE.exec(text);
  return match === null ? null : (match[1] ?? null);
}

/**
 * A fence closes only on its own character, at least as long, carrying nothing but
 * whitespace after it. Without the suffix rule a `` ```lang `` line inside a code sample
 * ends the sample early, and the checkboxes written in that sample are counted as criteria.
 */
function closesFence(line: string, fence: string): boolean {
  const match = FENCE_LINE.exec(line);
  if (match === null) return false;
  const token = match[1] ?? '';
  if (token.slice(0, 1) !== fence.slice(0, 1)) return false;
  if (token.length < fence.length) return false;
  return line.slice(match[0].length).trim().length === 0;
}

interface CommentRead {
  /** The line with every commented region removed. */
  readonly visible: string;
  /** Whether the line ends inside a comment. */
  readonly after: boolean;
}

/**
 * Remove HTML comment regions from one line, carrying the open/closed state across lines.
 * An unterminated `<!--` — the shape a torn read leaves behind — hides the rest of the
 * file, so the ratio degrades to what was readable rather than counting commented-out
 * markup as live criteria.
 *
 * A `<!--` inside an **inline code span** is literal text, not a delimiter. That is not a
 * nicety: a Ticket whose prose quotes `` `<!--` `` while explaining its own markup would
 * otherwise open a comment that never closes, hiding every criterion below it — and hiding
 * an *unchecked* criterion turns a ratio of 1/2 into 1/1, so unfinished work reads as
 * finished. The span's content stays in the visible text, because it is content; only its
 * delimiters are inert.
 */
function outsideComments(line: string, inComment: boolean): CommentRead {
  let visible = '';
  let at = 0;
  let open = inComment;
  while (at < line.length) {
    if (open) {
      // Inside a comment the enclosed text is not markdown, so backticks mean nothing here.
      const close = line.indexOf(COMMENT_CLOSE, at);
      if (close === -1) return { visible, after: true };
      at = close + COMMENT_CLOSE.length;
      open = false;
      continue;
    }
    const start = line.indexOf(COMMENT_OPEN, at);
    const spanEnd = codeSpanBefore(line, at, start);
    if (spanEnd !== -1) {
      visible += line.slice(at, spanEnd);
      at = spanEnd;
      continue;
    }
    if (start === -1) return { visible: visible + line.slice(at), after: false };
    visible += line.slice(at, start);
    at = start + COMMENT_OPEN.length;
    open = true;
  }
  return { visible, after: open };
}

/**
 * The end of the inline code span that begins at or after `at` and before `commentStart`,
 * or `-1` when the next thing on the line is the comment opener instead.
 *
 * A span opens on a run of backticks and closes on the next run of **exactly** the same
 * length, which is CommonMark's rule and is what lets a span quote a backtick. A run with
 * no match is literal text; it is still stepped over so the walk keeps moving and whatever
 * follows is read normally.
 */
function codeSpanBefore(line: string, at: number, commentStart: number): number {
  const tick = line.indexOf('`', at);
  if (tick === -1) return -1;
  if (commentStart !== -1 && commentStart < tick) return -1;
  const length = backtickRun(line, tick);
  const close = closingBacktickRun(line, tick + length, length);
  return close === -1 ? tick + length : close + length;
}

function backtickRun(line: string, at: number): number {
  let end = at;
  while (line.charAt(end) === '`') end += 1;
  return end - at;
}

function closingBacktickRun(line: string, from: number, length: number): number {
  let at = from;
  for (;;) {
    const tick = line.indexOf('`', at);
    if (tick === -1) return -1;
    const run = backtickRun(line, tick);
    if (run === length) return tick;
    at = tick + run;
  }
}
