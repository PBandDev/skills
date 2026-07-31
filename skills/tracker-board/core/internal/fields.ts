/**
 * Field scanning and Ticket identity.
 *
 * Vocabulary here is `CONTEXT.md`'s — Ticket, Dialect, Lane, Extraction — and means what the
 * glossary says it means.
 *
 * Rules this module honours — every one of them is a measured defect, not a preference:
 *
 * 1. Strip `*` **once, at the field-scan boundary, before matching any field** — never
 *    per-field. Task Tickets write `**Status:** value` with the colon *inside* the bold.
 *    A tolerant `/^\*{0,2}(Status)\*{0,2}:/` matches but captures a stray `**` into the
 *    value, measured wrong on 37 of 54 Tickets. The damage is not the status field: the
 *    artifact defeats *any* leading-anchored match on *any* value, which silently broke
 *    blocker parsing on 25 of 54 Tickets while **no Lane moved**, because every affected
 *    Ticket was Done and blockers only gate incomplete work.
 * 2. The field preamble runs from the top to the **first `## ` heading, or to EOF when
 *    there is none**. Never a line budget — a real Ticket puts its status on line 21 of a
 *    file with no `## ` heading at all.
 * 3. The **first** occurrence of each field wins, so a later mention in prose cannot
 *    override the real one.
 * 4. Strip a leading `---…---` frontmatter block defensively and merge it. Do **not**
 *    parse it as YAML — that is a dependency and a throw site for a block the corpus does
 *    not contain yet.
 * 5. Unknown fields are ignored without disturbing the scan. They are common and they are
 *    not errors — but they are still carried on `rawFields`, because an `unclassified`
 *    card renders them.
 * 6. Section headings match by **prefix, never equality**. Real headings carry trailing
 *    prose, dates and parentheticals.
 * 7. The Ticket number comes from the **filename**, `^(\d+)-`, at any width. The H1 is
 *    display text; strip an optional `NN —` / `NN –` / `NN -` prefix from it. Decision
 *    Tickets frequently have no H1 — fall back to the filename slug.
 *
 * Fixtures holding these rules: `status-bold-wrapped`, `preamble-runs-to-first-heading`,
 * `frontmatter-stripped`, `007-title-hyphen-and-wide-number`, `no-h1-decision-ticket`.
 *
 * Dialect scoring is **not** here. It observes its own syntax in `dialect.ts`, which is why
 * this module hands on `preamble` and `body` with their markup intact.
 *
 * ---------------------------------------------------------------------------
 * Decisions this module takes, which the rules above leave open
 * ---------------------------------------------------------------------------
 *
 * **Where the marker strip lands.** On the **candidate line**, once, immediately before
 * the name/value match — and nowhere else. `body` and `preamble` are handed on with their
 * markup intact, because `dialect.ts` scores on observed **bold-versus-bare field markers**
 * and `criteria.ts` reads real `- [ ]` markup; a document-wide strip would destroy both.
 * The strip removes **every** `*` on that line rather than a bounded run around the name,
 * because a bounded run is a tolerant per-field match wearing a different hat — it handles
 * `**Status:**` and then misses `**Status: done**`, `*Status:*` and `***Status:***`. Two
 * costs, both stated rather than hidden:
 *   - a field **value** containing a literal `*` — a glob or a regular expression — reaches
 *     `fields` and `rawFields` without it. Field values render on the board as plain text,
 *     so emphasis markers are noise there in every other case.
 *   - **underscore emphasis is not handled.** `_Status:_ done` is not read as a field at
 *     all, and `**Status:** _done_` keeps the leading `_` in its value. Both degrade to
 *     *absent* or *unmatched* rather than to a confidently wrong value, which is the safe
 *     direction and is what separates them from the `**` defect above. No observed file
 *     writes a field label in underscores, and a global `_` strip would corrupt the
 *     snake_case identifiers and file paths that real values do contain. Revisit when a
 *     real file shows the shape — that file becomes the fixture.
 *
 * **What closes the preamble.** A line beginning `## ` at **column 0**, outside a fenced
 * code block and outside an HTML comment. Three readings, each chosen the same way — the
 * measured defect is a window that ends **early** (a real Ticket's status sits on line 21),
 * while a window that runs long only risks collecting an extra unknown field, and rule 3
 * already protects the real ones:
 *   - a `## ` **inside a fence** is sample text, not a heading, so it does not close the
 *     window. A torn read can leave a fence unterminated, which makes the window run to EOF
 *     — the safe direction.
 *   - a `## ` **not at column 0** does not close it either. Indented hashes turn up quoted
 *     inside list items and evidence lines far more often than as real section breaks.
 *   - `# ` does not close it (every Dialect writes its fields *below* the H1) and neither
 *     does `### `, which is the literal reading of "the first `## ` heading".
 *
 * **Fences and comments are one ordered state machine, in that order.** Inside a fence,
 * comment delimiters are inert; outside one, comment regions are removed from the line
 * before anything is matched against it. Getting that order wrong is not theoretical: with
 * comments classified over the raw text first, a single unmatched `<!--` *inside* a code
 * sample swallows its own closing fence and every real field below it. A closing fence
 * must repeat the opener's character at least as many times **and carry nothing but
 * whitespace after it**, or a `` ```lang `` line inside a sample closes the fence early and
 * lets a `Status:` written in example code outrank the file's real one.
 *
 * Lines are split on `\n` with a trailing `\r` removed, so a CRLF file yields the same
 * fields as an LF one — otherwise every value carries an invisible trailing character and
 * every leading-anchored match downstream fails on exactly the files a Windows editor
 * touched. A single leading U+FEFF byte-order mark is removed for the same reason: Node's
 * UTF-8 read preserves it, and it otherwise hides the first field or the H1 of any file a
 * Windows editor saved. Lines are visited **without materialising a line array**, because
 * one 4 MiB file of bare newlines otherwise costs about 1.2 s and 440 MiB per scan — and
 * the watcher re-scans on every debounced write.
 *
 * **What a field line is.** After the strip: no leading whitespace, a name starting with a
 * letter and running at most 40 characters of letters, digits, spaces, `.`, `_` or `-`,
 * then `:`. That admits `Blocked by:` and `What to build:` while rejecting `- [x] …`,
 * `# 07 — …` and prose containing a comma before its colon. Value capture is
 * **single-line**: a value that wraps keeps only its first line, because the only available
 * terminator for a folded value is prose, and folding would quietly pull an unrelated
 * sentence into `externalBlocker` on a torn read. One corpus value wraps and is unaffected.
 * Every reader of a value in `fields` therefore gets a single line.
 *
 * **Frontmatter.** "Leading" means before any content — blank lines and HTML comments do
 * not count as content, so a fixture whose expectation comment sits above its block is
 * still read correctly. A block is stripped when it opens with `---` on its own line,
 * closes with `---` or `...`, carries **at least one `key: value` entry** at column 0, and
 * carries **no unambiguous markdown block** — a `- [ ]` checkbox item, a code fence, or a
 * bold field marker. That is a shape check, not a YAML parser: no dependency and no throw
 * site. It deliberately does **not** require every interior line to look like YAML, because
 * that rejects a legal YAML comment — and a rejected block is then scanned as ordinary
 * content, which puts `status: closed` from inside the block *ahead* of the file's real
 * `Status:` and shadows it. A shadowed value is the exact failure this scan must
 * prevent; a wrongly-stripped region degrades to an empty card, which is visible. The
 * residual is stated: a document opening with a thematic break whose following region is
 * mapping-shaped loses that region, which is also how every markdown tool reads it.
 * Merged keys **never shadow** a real field scan — a preamble field wins, and frontmatter
 * only fills a gap. Frontmatter keys stay out of `rawFields`, which is documented as what
 * was observed in the preamble.
 *
 * **Identity.** The number is filename-first with an H1 fallback: `^(\d+)-` on the filename
 * at any width, else a leading `NN —` / `NN –` / `NN -` on the H1, else `null` — the honest
 * answer, and Tickets with a `null` number sort last. The plain-hyphen form requires
 * whitespace before the hyphen so that an H1 opening with a calendar date is not read as
 * the year as issue number 2026. Sorting is not this module's job; it lives in `core/index.ts`.
 */

import type { RawField, TitleSource } from '../types.ts';

export interface FieldScan {
  /**
   * Every field name observed, lower-cased and trimmed — `status`, `blocked by`, `type` —
   * mapped to its **first-occurrence** value. Unknown names are present and simply never
   * looked up, which is what "ignored without disturbing the scan" means here.
   */
  readonly fields: ReadonlyMap<string, string>;
  /** Every `Name: value` pair observed in the preamble, in order, names verbatim. */
  readonly rawFields: readonly RawField[];
  /** The preamble region: top of the body → first `## ` heading, or EOF. Markup intact. */
  readonly preamble: string;
  /**
   * The whole file with any leading frontmatter block and any leading byte-order mark
   * removed. Markup intact.
   */
  readonly body: string;
  /** Keys merged out of a leading `---…---` block. Never shadows a real field scan. */
  readonly frontmatter: ReadonlyMap<string, string>;
}

export interface Identity {
  readonly number: number | null;
  readonly title: string;
  readonly titleSource: TitleSource;
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

/** Matched by prefix, never equality — real headings carry trailing prose and dates. */
const SECTION_HEADING = '## ';

/** Applied to the **stripped** line. No leading whitespace: fields sit at column 0. */
const FIELD_LINE = /^([A-Za-z][A-Za-z0-9._ -]{0,39}):[ \t]*(.*)$/;

/** A fence opener or closer. CommonMark allows up to three leading spaces. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

const H1_LINE = /^#[ \t]+(.+)$/;

/** `13 — Decide …` and `13 – Decide …`. An en/em dash needs no surrounding space. */
const H1_DASH_NUMBER = /^(\d+)[ \t]*[–—][ \t]*(.+)$/;

/**
 * `07 - Qualify …`. The space **before** the hyphen is required: without it an H1 opening
 * `2026-07-24 …` would read the year as the number with the rest of the date as its title.
 */
const H1_HYPHEN_NUMBER = /^(\d+)[ \t]+-[ \t]*(.+)$/;

/** Any width. `007-…` has number 7; a string sort would put 10 before 2. */
const FILENAME_NUMBER = /^(\d+)-/;

const FILENAME_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Frontmatter delimiters sit at **column 0**, with only trailing whitespace after them.
 * Anchoring is load-bearing rather than tidiness: an indented `---` is legal *content*
 * inside a block scalar (`description: |`), and accepting it closes the block early, after
 * which the block's own `status:` is scanned as body content ahead of the file's real one
 * and shadows it. Because block-scalar content must be indented further than its key, a
 * column-0 anchor excludes every scalar body exactly, with no need to track indentation.
 */
const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_DELIMITER = /^(?:-{3}|\.{3})[ \t]*$/;

/**
 * Markdown that no frontmatter block contains: a checkbox list item, a code fence, or a
 * bold field marker. Any of them means the leading `---` was a thematic break and the
 * region below it is document content, not a mapping.
 *
 * Anchored at column 0 for the same reason as the delimiters — an indented fence inside a
 * block scalar is scalar text, and disqualifying on it leaves a real block unstripped,
 * which shadows a real field. Over-disqualifying fails silently and wrongly; failing to
 * disqualify loses a region visibly.
 */
const MARKDOWN_BLOCK = /^(?:[-*+][ \t]+\[[ xX]\]|`{3,}|~{3,}|\*\*)/;

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

/** Built from its code point on purpose — the literal character is invisible in a diff. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
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

// ---------------------------------------------------------------------------
// scanFields
// ---------------------------------------------------------------------------

/**
 * Read a Ticket file's fields. Never throws: a file truncated mid-line, mid-comment or
 * mid-frontmatter returns a scan describing whatever it did contain, because the watcher
 * fires *during* a write and a torn read is the steady state.
 */
export function scanFields(text: string): FieldScan {
  // Type stripping erases and does not check, so the declared `string` is a claim.
  const source = withoutByteOrderMark(typeof text === 'string' ? text : '');

  const split = splitFrontmatter(source);
  const body = split.body;
  const scanned = scanPreamble(body);

  const fields = new Map<string, string>();
  for (const field of scanned.rawFields) {
    const key = field.name.toLowerCase();
    // Rule 3: first occurrence wins, so a later mention in prose cannot override it.
    if (key.length > 0 && !fields.has(key)) fields.set(key, field.value);
  }
  for (const [key, value] of split.frontmatter) {
    // Rule 4: frontmatter fills a gap and never shadows a real field scan.
    if (!fields.has(key)) fields.set(key, value);
  }

  return {
    fields,
    rawFields: scanned.rawFields,
    preamble: body.slice(0, scanned.end),
    body,
    frontmatter: split.frontmatter,
  };
}

export interface DocumentView {
  /**
   * The visible text of each preamble line, with commented regions and fenced code blocks
   * removed and every line terminator already resolved.
   */
  readonly preambleLines: readonly string[];
  /** The visible text of every `## ` section heading, in order, the marker stripped. */
  readonly headings: readonly string[];
}

/**
 * The document's structure as the field scan sees it, for a reader that needs to observe
 * *syntax* rather than field values. Dialect scoring is its only consumer.
 *
 * It exists so that observation happens **once**. A module that re-derives this from raw
 * text gets a different answer: a `Type:` line inside a fenced example counts as a field, a
 * heading exposed when a comment closes on the same line is missed, and a file written with
 * lone carriage returns collapses to a single line. Each makes a second reader disagree with
 * this one.
 *
 * Takes a body that has already had its frontmatter and byte-order mark removed — that is
 * what {@link FieldScan.body} is — and does not strip either again.
 */
export function readDocumentView(body: string): DocumentView {
  const source = typeof body === 'string' ? body : '';
  const cursor: Cursor = { fence: null, commented: false };
  const preambleLines: string[] = [];
  const headings: string[] = [];
  let inPreamble = true;

  forEachLine(source, (line) => {
    const visible = readableText(cursor, line);
    if (visible === null) return true;
    if (visible.startsWith(SECTION_HEADING)) {
      inPreamble = false;
      headings.push(visible.slice(SECTION_HEADING.length).trim());
      return true;
    }
    if (inPreamble) preambleLines.push(visible);
    return true;
  });

  return { preambleLines, headings };
}

interface PreambleScan {
  /** Offset in the body at which the preamble ends. */
  readonly end: number;
  readonly rawFields: readonly RawField[];
}

function scanPreamble(body: string): PreambleScan {
  const cursor: Cursor = { fence: null, commented: false };
  const rawFields: RawField[] = [];
  let end = body.length;

  forEachLine(body, (line, start) => {
    const visible = readableText(cursor, line);
    if (visible === null) return true;
    if (visible.startsWith(SECTION_HEADING)) {
      end = start;
      return false;
    }
    const field = readFieldLine(visible);
    if (field !== null) rawFields.push(field);
    return true;
  });

  return { end, rawFields };
}

/**
 * Rule 1, and the only place it happens: strip the line's `*` markers **once**, then match
 * a name and a value against the result. Never a tolerant `\*{0,2}` around a field name —
 * that shape matches `**Status:**` and hands back a value beginning `**`.
 */
function readFieldLine(text: string): RawField | null {
  const stripped = stripMarkers(text);
  const match = FIELD_LINE.exec(stripped);
  if (match === null) return null;
  const name = (match[1] ?? '').trim();
  if (name.length === 0) return null;
  return { name, value: (match[2] ?? '').trim() };
}

function stripMarkers(text: string): string {
  return text.split('*').join('');
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

interface FrontmatterSplit {
  readonly body: string;
  readonly frontmatter: ReadonlyMap<string, string>;
}

/**
 * Strip a leading `---…---` block and read its top-level keys. Defensive, not a parser:
 * a block that is not shaped like a mapping, or that carries markdown a mapping never
 * carries, is left exactly where it is.
 */
function splitFrontmatter(text: string): FrontmatterSplit {
  const entries = new Map<string, string>();
  let commented = false;
  let inside = false;
  let closed = false;
  let disqualified = false;
  let hasEntry = false;
  let openAt = -1;
  let resumeAt = -1;

  forEachLine(text, (line, start, nextStart) => {
    if (!inside) {
      const seen = outsideComments(line, commented);
      commented = seen.after;
      if (seen.visible.trim().length === 0) return true;
      // The first line carrying content. Frontmatter is only frontmatter here.
      if (!FRONTMATTER_OPEN.test(seen.visible)) return false;
      inside = true;
      openAt = start;
      return true;
    }

    if (FRONTMATTER_DELIMITER.test(line)) {
      closed = true;
      resumeAt = nextStart;
      return false;
    }
    if (MARKDOWN_BLOCK.test(line)) {
      disqualified = true;
      return false;
    }
    const field = readFieldLine(line);
    if (field !== null) {
      hasEntry = true;
      const key = field.name.toLowerCase();
      if (!entries.has(key)) entries.set(key, field.value);
    }
    return true;
  });

  if (!closed || disqualified || !hasEntry || openAt < 0) {
    return { body: text, frontmatter: new Map<string, string>() };
  }
  return { body: text.slice(0, openAt) + text.slice(resumeAt), frontmatter: entries };
}

// ---------------------------------------------------------------------------
// extractIdentity
// ---------------------------------------------------------------------------

/**
 * The Ticket's number and display title. Filename-first for the number, H1-first for the
 * title, and `null` / the filename slug when a source is absent — a
 * decision Ticket frequently has no H1 at all, and marking it unparsed would bury every
 * freshly-generated map.
 */
export function extractIdentity(fileName: string, body: string): Identity {
  const name = typeof fileName === 'string' ? fileName : '';
  const source = withoutByteOrderMark(typeof body === 'string' ? body : '');

  const heading = readH1(source);
  const parsed = heading === null ? null : splitHeadingNumber(heading);
  const number = numberFromFileName(name) ?? parsed?.number ?? null;

  if (parsed !== null && parsed.title.length > 0) {
    return { number, title: parsed.title, titleSource: 'h1' };
  }
  const slug = slugFromFileName(name);
  if (slug.length > 0) return { number, title: slug, titleSource: 'filename' };
  return { number, title: '', titleSource: 'none' };
}

/** The first `# ` heading outside a fence and outside an HTML comment, or `null`. */
function readH1(body: string): string | null {
  const cursor: Cursor = { fence: null, commented: false };
  let heading: string | null = null;

  forEachLine(body, (line) => {
    const visible = readableText(cursor, line);
    if (visible === null) return true;
    const match = H1_LINE.exec(visible);
    if (match === null) return true;
    heading = (match[1] ?? '').trim();
    return false;
  });

  return heading;
}

interface HeadingParts {
  readonly number: number | null;
  readonly title: string;
}

/**
 * Split an optional `NN —` / `NN –` / `NN -` prefix off the H1. 70 of 76 sampled H1s used
 * an em-dash and 6 did not, so an em-dash-only strip leaves `07 - ` glued to the front of
 * the display title on 8% of cards.
 */
function splitHeadingNumber(heading: string): HeadingParts {
  const dash = H1_DASH_NUMBER.exec(heading);
  if (dash !== null) {
    return { number: toNumber(dash[1]), title: (dash[2] ?? '').trim() };
  }
  const hyphen = H1_HYPHEN_NUMBER.exec(heading);
  if (hyphen !== null) {
    return { number: toNumber(hyphen[1]), title: (hyphen[2] ?? '').trim() };
  }
  return { number: null, title: heading.trim() };
}

function numberFromFileName(fileName: string): number | null {
  const match = FILENAME_NUMBER.exec(fileName);
  return match === null ? null : toNumber(match[1]);
}

/**
 * The filename slug as display text: extension gone, a leading `NN-` gone, separators as
 * spaces. It degrades to something a person can still read rather than to nothing.
 */
function slugFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(FILENAME_EXTENSION, '');
  const withoutNumber = withoutExtension.replace(FILENAME_NUMBER, '');
  const spaced = withoutNumber.split('-').join(' ').split('_').join(' ');
  const collapsed = spaced
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ');
  return collapsed.length > 0 ? collapsed : withoutExtension.trim();
}

function toNumber(digits: string | undefined): number | null {
  if (digits === undefined || digits.length === 0) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// The line walk
// ---------------------------------------------------------------------------

/**
 * Visit each line in order with its start offset and the offset the next line begins at.
 * Return `false` from `visit` to stop.
 *
 * **All three line terminators end a line** — `\n`, `\r\n`, and a lone `\r` — and none of
 * them ever reaches the visitor. A file authored on one platform is read on another, and a
 * checkout can rewrite endings on its own, so a terminator left on the end of a value is an
 * invisible character that defeats every trailing-anchored match downstream on exactly the
 * files one editor happened to touch. Splitting on `\n` alone reads a lone-`\r` file as a
 * single line and finds no fields in it at all.
 *
 * Nothing is materialised: a Ticket file is read on every debounced re-scan, and one
 * pathological file of bare newlines costs about 1.2 s and 440 MiB per scan when each line
 * becomes an object in an array. The two terminator cursors only ever move forward, so the
 * whole walk is one pass — searching for both terminators from scratch on every line is
 * quadratic on a file that contains only one of them, which is the common case.
 */
function forEachLine(
  text: string,
  visit: (line: string, start: number, nextStart: number) => boolean,
): void {
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

    if (!visit(text.slice(start, end), start, nextStart)) return;
    if (breakAt === -1) return;
    start = nextStart;
  }
}

/**
 * The part of a line that carries readable content, or `null` when the line is inside a
 * fenced code block or is a fence delimiter. Advances the cursor.
 *
 * Three orderings here, each one bought by a real misread:
 *
 *   - **Fence state resolves first and freezes comment state.** An unmatched `<!--` inside
 *     a code sample must not swallow the sample's own closing fence and every field below.
 *   - **A line that *begins* inside a comment still contributes whatever follows the
 *     `-->`.** Discarding the remainder loses a heading written as `-->## Details`, so the
 *     preamble runs on and captures conversation below a section break as though it were a
 *     field.
 *   - **A fence opener is recognised before comment state is committed.** A line like
 *     ` ```md <!-- sample ` opens a fence *and* opens a comment; committing the comment
 *     would leave that state set when the fence closes, hiding every real field after it.
 *     Inside a fence everything is inert, so the pre-fence comment state is what resumes.
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
 * ends the sample early, and a `Status:` written in example code outranks the real one.
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
 * An unterminated `<!--` — the shape a torn read leaves behind — swallows the rest of the
 * file, so the card degrades to `unparsed` and the next write resolves it.
 *
 * A `<!--` inside an **inline code span** is literal text, not a delimiter. A Ticket whose
 * prose quotes `` `<!--` `` while explaining its own markup would otherwise open a comment
 * that never closes, hiding every field below it — the status line included. The span's
 * content stays in the visible text, because it is content; only its delimiters are inert.
 *
 * This reading is shared with the criteria region walk on purpose. The same file must not be
 * cut into comments two different ways by two modules, or one decision has quietly become
 * two.
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

/**
 * Node's UTF-8 read preserves a byte-order mark, and a Windows editor writes one. Left in
 * place it hides the file's first field or its H1 — the card then shows a filename-derived
 * title and no status, for a file that reads correctly to a person.
 *
 * **Every** leading mark goes, not one. A file that has been round-tripped through two
 * tools can carry two, and removing exactly one here while another read removes exactly one
 * elsewhere makes the same invisible prefix hide a field but not a heading.
 */
function withoutByteOrderMark(text: string): string {
  let at = 0;
  while (text.startsWith(BYTE_ORDER_MARK, at)) at += BYTE_ORDER_MARK.length;
  return at === 0 ? text : text.slice(at);
}
