/**
 * Digest envelope and Block validation.
 *
 * One Digest per Feature, not per file. A fixed Block order, every Block individually
 * omittable, and the whole Digest may render as **nothing** — a Feature with no prose does
 * not get a paragraph invented for it.
 *
 * | Block | Shape | Caps |
 * |---|---|---|
 * | `summary` | `{text}` — required, first, exactly one | ≤200 chars, no newlines/markdown/links |
 * | `facts`   | `{label, value, state?}` | 2–6 items · label ≤24 · value ≤48 |
 * | `bullets` | `{title?, tone?, items[]}` | 2–5 items · ≤100 each · title ≤40 |
 * | `links`   | `{label, path}` | 1–6, **uncapped for maps** · label ≤40 |
 *
 * `state ∈ done | active | blocked | planned | dropped`.
 * `tone ∈ note | risk | decision | question | correction | fog | out-of-scope`.
 *
 * **Envelope:** `{v:1, feature, blocks[]}` · 2–6 Blocks · the first must be `summary` ·
 * **aggregate ≤900 chars across every authored string**. The budget counts **authored
 * strings only** — paths are read off disk, not written by the model, and counting them
 * would make "uncapped for maps" unenforceable on the one Feature that has a map.
 *
 * The aggregate budget sits *on top of* the per-field caps deliberately, so fields compete
 * and the editorial act actually happens. Target output is ~60 words per Feature. There is
 * no `text` Block, no `table` and no `accordion`, because a Block that does not exist
 * cannot be overstuffed.
 *
 * **Validation rejects; it never truncates.** A rejection names the field and the overage
 * — `bullets.items[3]: 147 > 100 chars` — so the model that wrote it can self-correct.
 *
 * A `links.path` holding an absolute URL is **rejected** in v1 rather than silently
 * copied. The Block is repo-relative paths, copied and not navigated, and rejection keeps
 * it single-meaning while being visible enough that the model self-corrects.
 *
 * No AI-authored charts. Measured across 735 KB of prose there is no time series, nothing
 * measured twice, and no shared-unit before/after — every number is a single fraction
 * where a one-bar chart reads worse than the text. `facts` is the Block that replaces
 * charts.
 *
 * ---
 *
 * Readings this module takes that the caps table alone does not settle.
 *
 *   - **A rejection names the field and the size, never the content.** `field` carries the
 *     dotted path and `message` carries the overage, so the two render as
 *     `bullets.items[3]: 147 > 100 chars` and either half is usable alone. The refused value
 *     itself is never quoted back: a Digest is model-authored prose about somebody's private
 *     repository, and a message that echoes it copies that text onto the board and into
 *     anything the board writes. A path can carry credentials, which makes the same mistake
 *     worse. The field path is what a writer needs in order to fix it.
 *   - **Every violation is reported, not the first**, so a writer fixes all of them in one
 *     pass rather than playing twenty questions — *except* that an out-of-range count
 *     refuses without descending. Diagnosing every member of a 100,000-item array amplifies
 *     one malformed file into a Snapshot far larger than itself and buries the one finding
 *     that matters. Nothing is accepted either way, so that is still rejection.
 *   - **The Block label repeats its kind.** With 2–6 Blocks over four kinds a Digest may
 *     legitimately carry two `bullets` Blocks — one per tone — so a second occurrence is
 *     labelled `bullets[1]` and the first stays plain `bullets`.
 *   - **Only "first must be summary" and "exactly one summary" are enforced as ordering.**
 *     A total order over the four kinds cannot coexist with a 6-Block envelope.
 *   - **The aggregate counts free text only**: the summary text, fact labels and values,
 *     bullet titles and items, and link labels. It excludes `links[].path`, the envelope's
 *     Feature name, and the fixed vocabulary tokens (`kind`, `tone`, `state`) — none of
 *     those is prose a model chose the length of.
 *   - **Chars are counted as code points**, so a Digest is not rejected for spending two of
 *     its budget on one character a reader sees once.
 *   - **No authored string may be blank or carry a newline.** Every one of them renders in
 *     a fixed slot, so a newline is authored volume that escapes the cap it sits under, and
 *     a blank string is a field that says nothing while claiming a slot.
 *   - **An unknown key anywhere is a rejection**, not something to ignore. This is the same
 *     wall ADR-0001 relies on: a Block vocabulary that quietly tolerates a `text` key is a
 *     Block vocabulary that has one.
 */

import type {
  BulletTone,
  Digest,
  DigestBlock,
  DigestBulletsBlock,
  DigestFact,
  DigestFactsBlock,
  DigestLink,
  DigestLinksBlock,
  DigestSummaryBlock,
  FactState,
  JsonValue,
  Rejection,
} from '../types.ts';

export interface DigestValidation {
  /** The validated Digest, or `null` when it was refused. Never a truncated one. */
  readonly digest: Digest | null;
  /** One per violation, each naming the field and the overage. */
  readonly rejections: readonly Rejection[];
}

type JsonObject = { readonly [key: string]: JsonValue };

const SUPPORTED_VERSION = 1;
const MIN_BLOCKS = 2;
const MAX_BLOCKS = 6;
const AGGREGATE_MAX = 900;

const SUMMARY_MAX = 200;
const FACTS_MIN = 2;
const FACTS_MAX = 6;
const FACT_LABEL_MAX = 24;
const FACT_VALUE_MAX = 48;
const BULLETS_MIN = 2;
const BULLETS_MAX = 5;
const BULLET_ITEM_MAX = 100;
const BULLETS_TITLE_MAX = 40;
const LINKS_MIN = 1;
const LINKS_MAX = 6;
const LINK_LABEL_MAX = 40;

const ENVELOPE_KEYS: readonly string[] = ['v', 'feature', 'blocks'];
const SUMMARY_KEYS: readonly string[] = ['kind', 'text'];
const FACTS_KEYS: readonly string[] = ['kind', 'items'];
const FACT_KEYS: readonly string[] = ['label', 'value', 'state'];
const BULLETS_KEYS: readonly string[] = ['kind', 'title', 'tone', 'items'];
const LINKS_KEYS: readonly string[] = ['kind', 'items'];
const LINK_KEYS: readonly string[] = ['label', 'path'];

const BLOCK_KINDS: readonly string[] = ['summary', 'facts', 'bullets', 'links'];
const FACT_STATES: readonly FactState[] = ['done', 'active', 'blocked', 'planned', 'dropped'];
const BULLET_TONES: readonly BulletTone[] = [
  'note',
  'risk',
  'decision',
  'question',
  'correction',
  'fog',
  'out-of-scope',
];

/** Emphasis, code, link and image syntax. A summary is plain prose, so none of it belongs. */
const MARKDOWN_INLINE = /[*_`[\]]|~{2}/;
/** A heading, quote or list marker can only open a line, and a summary has exactly one. */
const MARKDOWN_LEADING = /^\s*(?:[#>+]|-\s|\d+[.)]\s)/;
/**
 * An absolute URL, a markdown link target, or a bare host.
 *
 * **Every alternative here is anchored on a literal**, and that is load-bearing rather than
 * stylistic. Opening with `[a-zA-Z][a-zA-Z0-9+.-]*` before requiring `://` would be unanchored
 * and unbounded: the engine restarts that run at every position
 * and backtracks it to the end, so the scan costs the square of the input. A summary is
 * capped at 200 characters, but the cap is *reported*, not enforced before the scan — the
 * value still arrives at whatever length a file gives it. Measured on the value that
 * reaches this line: 25K characters took 242 ms, 50K took 979 ms, 100K took 3.9 s, and the
 * seam runs on every debounced file change. A board that stops redrawing is worse than one
 * that refuses a Digest.
 */
const LINK_LIKE = /:\/\/|\]\(|(?:^|[^A-Za-z0-9])www\./;
/** A scheme of two characters or more, or a protocol-relative reference. `C:` is not one. */
const ABSOLUTE_URL = /^(?:[a-zA-Z][a-zA-Z0-9+.-]+:|\/\/)/;

/**
 * Everything one validation pass accumulates. The authored strings are collected as they
 * are checked, so the aggregate is computed over exactly the strings the per-field caps
 * saw — a second traversal could disagree with the first and nobody would know which.
 */
interface Pass {
  readonly rejections: Rejection[];
  readonly authored: string[];
  readonly featureName: string;
  readonly sourcePath: string;
}

/**
 * `value` arrives from disk and is untrusted. Type stripping erases and does not check, so
 * every field is validated at runtime rather than assumed from its declared shape.
 */
export function validateDigest(
  value: JsonValue,
  featureName: string,
  sourcePath: string,
): DigestValidation {
  const pass: Pass = { rejections: [], authored: [], featureName, sourcePath };

  const envelope = asObject(value);
  if (envelope === null) {
    reject(pass, 'digest', `${show(value)} is not a Digest object`);
    return { digest: null, rejections: pass.rejections };
  }

  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_KEYS.includes(key)) {
      reject(pass, key, 'is not a field of the Digest envelope');
    }
  }

  if (envelope['v'] !== SUPPORTED_VERSION) {
    reject(pass, 'v', `${show(envelope['v'])} is not Digest version ${SUPPORTED_VERSION}`);
  }

  const feature = envelope['feature'];
  if (typeof feature !== 'string') {
    reject(pass, 'feature', `${show(feature)} is not a string`);
  } else if (feature !== featureName) {
    reject(pass, 'feature', 'does not name the Feature it was written for');
  }

  const blocks = asArray(envelope['blocks']);
  if (blocks === null) {
    reject(pass, 'blocks', `${show(envelope['blocks'])} is not a list of Blocks`);
    return { digest: null, rejections: pass.rejections };
  }
  // Out of range refuses the Digest here, without descending. Walking 100,000 Blocks to
  // append a diagnostic for each would amplify one malformed file into a Snapshot far
  // larger than itself, re-serialised to every connected client on every re-scan — and it
  // buries the one finding that matters under the 100,000 that follow from it. Nothing is
  // accepted either way, so this is still rejection rather than truncation.
  if (blocks.length < MIN_BLOCKS) {
    reject(pass, 'blocks', `${blocks.length} < ${MIN_BLOCKS} Blocks`);
    return { digest: null, rejections: pass.rejections };
  }
  if (blocks.length > MAX_BLOCKS) {
    reject(pass, 'blocks', `${blocks.length} > ${MAX_BLOCKS} Blocks`);
    return { digest: null, rejections: pass.rejections };
  }

  const labels = labelBlocks(blocks);
  const summaries = blocks.filter((block) => kindOf(block) === 'summary').length;
  if (summaries === 0) {
    reject(pass, 'blocks', 'carries no summary Block; a Digest opens with exactly one');
  } else if (summaries > 1) {
    reject(pass, 'blocks', `carries ${summaries} summary Blocks; a Digest opens with exactly one`);
  }
  const firstKind = blocks.length > 0 ? kindOf(blocks[0]) : null;
  if (blocks.length > 0 && firstKind !== 'summary') {
    reject(
      pass,
      'blocks[0]',
      'is not summary; a Digest opens with its summary Block',
    );
  }

  const validated: DigestBlock[] = [];
  for (const [at, raw] of blocks.entries()) {
    const label = labels[at] ?? `blocks[${at}]`;
    const block = validateBlock(pass, raw, label);
    if (block !== null) validated.push(block);
  }

  const total = pass.authored.reduce((sum, text) => sum + charCount(text), 0);
  if (total > AGGREGATE_MAX) {
    reject(pass, 'blocks', `${total} > ${AGGREGATE_MAX} chars across the authored strings`);
  }

  if (pass.rejections.length > 0) {
    // Refused whole. A Digest that renders four of its five Blocks is a Digest that lies
    // about having been written the way it reads.
    return { digest: null, rejections: pass.rejections };
  }
  return {
    digest: { v: SUPPORTED_VERSION, feature: featureName, blocks: validated },
    rejections: pass.rejections,
  };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * One label per Block, `bullets` for the first of its kind and `bullets[1]` for the next,
 * so a message names a Block a reader can find. A Block whose kind is unreadable is
 * labelled by position instead — unreadable is not the same as absent.
 */
function labelBlocks(blocks: readonly JsonValue[]): readonly string[] {
  const seen = new Map<string, number>();
  const labels: string[] = [];
  for (const [at, block] of blocks.entries()) {
    const kind = kindOf(block);
    if (kind === null) {
      labels.push(`blocks[${at}]`);
      continue;
    }
    const count = seen.get(kind) ?? 0;
    seen.set(kind, count + 1);
    labels.push(count === 0 ? kind : `${kind}[${count}]`);
  }
  return labels;
}

function kindOf(block: JsonValue | undefined): string | null {
  const object = asObject(block);
  if (object === null) return null;
  const kind = object['kind'];
  return typeof kind === 'string' && BLOCK_KINDS.includes(kind) ? kind : null;
}

function validateBlock(pass: Pass, raw: JsonValue, label: string): DigestBlock | null {
  const block = asObject(raw);
  if (block === null) {
    reject(pass, label, `${show(raw)} is not a Block`);
    return null;
  }
  const kind = block['kind'];
  if (typeof kind !== 'string' || !BLOCK_KINDS.includes(kind)) {
    reject(pass, `${label}.kind`, `is not one of ${BLOCK_KINDS.join(', ')}`);
    return null;
  }
  switch (kind) {
    case 'summary':
      return validateSummary(pass, block, label);
    case 'facts':
      return validateFacts(pass, block, label);
    case 'bullets':
      return validateBullets(pass, block, label);
    default:
      return validateLinks(pass, block, label);
  }
}

function validateSummary(pass: Pass, block: JsonObject, label: string): DigestSummaryBlock | null {
  checkKeys(pass, block, SUMMARY_KEYS, label, 'summary Block');
  const field = `${label}.text`;
  const text = block['text'];
  if (typeof text !== 'string') {
    reject(pass, field, `${show(text)} is not a string`);
    return null;
  }
  authored(pass, field, text, SUMMARY_MAX);
  if (MARKDOWN_INLINE.test(text) || MARKDOWN_LEADING.test(text)) {
    reject(pass, field, 'carries markdown; a summary is plain prose');
  }
  if (LINK_LIKE.test(text)) {
    reject(pass, field, 'carries a link; links belong in the links Block');
  }
  return { kind: 'summary', text };
}

function validateFacts(pass: Pass, block: JsonObject, label: string): DigestFactsBlock | null {
  checkKeys(pass, block, FACTS_KEYS, label, 'facts Block');
  const items = asArray(block['items']);
  if (items === null) {
    reject(pass, `${label}.items`, `${show(block['items'])} is not a list`);
    return null;
  }
  if (!checkCount(pass, `${label}.items`, items.length, FACTS_MIN, FACTS_MAX)) return null;

  const facts: DigestFact[] = [];
  for (const [at, raw] of items.entries()) {
    const where = `${label}.items[${at}]`;
    const item = asObject(raw);
    if (item === null) {
      reject(pass, where, `${show(raw)} is not a fact`);
      continue;
    }
    checkKeys(pass, item, FACT_KEYS, where, 'fact');
    const factLabel = requireString(pass, `${where}.label`, item['label'], FACT_LABEL_MAX);
    const value = requireString(pass, `${where}.value`, item['value'], FACT_VALUE_MAX);

    let state: FactState | null = null;
    if (Object.hasOwn(item, 'state')) {
      const raw2 = item['state'];
      if (typeof raw2 !== 'string' || !isFactState(raw2)) {
        reject(pass, `${where}.state`, `is not one of ${FACT_STATES.join(', ')}`);
      } else {
        state = raw2;
      }
    }
    if (factLabel === null || value === null) continue;
    facts.push(state === null ? { label: factLabel, value } : { label: factLabel, value, state });
  }
  return { kind: 'facts', items: facts };
}

function validateBullets(pass: Pass, block: JsonObject, label: string): DigestBulletsBlock | null {
  checkKeys(pass, block, BULLETS_KEYS, label, 'bullets Block');

  let title: string | null = null;
  if (Object.hasOwn(block, 'title')) {
    title = requireString(pass, `${label}.title`, block['title'], BULLETS_TITLE_MAX);
  }

  let tone: BulletTone | null = null;
  if (Object.hasOwn(block, 'tone')) {
    const raw = block['tone'];
    if (typeof raw !== 'string' || !isBulletTone(raw)) {
      reject(pass, `${label}.tone`, `is not one of ${BULLET_TONES.join(', ')}`);
    } else {
      tone = raw;
    }
  }

  const items = asArray(block['items']);
  if (items === null) {
    reject(pass, `${label}.items`, `${show(block['items'])} is not a list`);
    return null;
  }
  if (!checkCount(pass, `${label}.items`, items.length, BULLETS_MIN, BULLETS_MAX)) return null;

  const lines: string[] = [];
  for (const [at, raw] of items.entries()) {
    const line = requireString(pass, `${label}.items[${at}]`, raw, BULLET_ITEM_MAX);
    if (line !== null) lines.push(line);
  }

  const base = { kind: 'bullets', items: lines } as const;
  if (title !== null && tone !== null) return { ...base, title, tone };
  if (title !== null) return { ...base, title };
  if (tone !== null) return { ...base, tone };
  return base;
}

function validateLinks(pass: Pass, block: JsonObject, label: string): DigestLinksBlock | null {
  checkKeys(pass, block, LINKS_KEYS, label, 'links Block');
  const items = asArray(block['items']);
  if (items === null) {
    reject(pass, `${label}.items`, `${show(block['items'])} is not a list`);
    return null;
  }
  if (!checkCount(pass, `${label}.items`, items.length, LINKS_MIN, LINKS_MAX)) return null;

  const links: DigestLink[] = [];
  for (const [at, raw] of items.entries()) {
    const where = `${label}.items[${at}]`;
    const item = asObject(raw);
    if (item === null) {
      reject(pass, where, `${show(raw)} is not a link`);
      continue;
    }
    checkKeys(pass, item, LINK_KEYS, where, 'link');
    const linkLabel = requireString(pass, `${where}.label`, item['label'], LINK_LABEL_MAX);

    // The path is read off disk rather than authored, so it carries no length cap and is
    // kept out of the aggregate. That exclusion is what keeps `links` usable on the one
    // Feature that has a map.
    const pathField = `${where}.path`;
    const path = item['path'];
    let linkPath: string | null = null;
    if (typeof path !== 'string') {
      reject(pass, pathField, `${show(path)} is not a string`);
    } else if (path.length === 0) {
      reject(pass, pathField, 'is empty');
    } else if (path.trim().length !== path.length) {
      // Checked *before* the URL test and never trimmed away. `ABSOLUTE_URL` is anchored,
      // so one leading space used to slip a whole absolute URL past it and store it
      // verbatim in the Snapshot. Trimming here instead would be the other failure: it
      // would accept a path the file does not contain.
      reject(pass, pathField, 'is padded with whitespace');
    } else if (ABSOLUTE_URL.test(path)) {
      // The offending value is deliberately not quoted back. `field` already names which
      // link is wrong, which is all the writer needs to fix it, and a path can carry
      // credentials — echoing it would copy them onto the board and into any log the
      // Snapshot reaches.
      reject(pass, pathField, 'is an absolute URL; links are repo-relative paths');
    } else if (/[\r\n]/.test(path)) {
      reject(pass, pathField, 'carries a newline');
    } else {
      linkPath = path;
    }

    if (linkLabel === null || linkPath === null) continue;
    links.push({ label: linkLabel, path: linkPath });
  }
  return { kind: 'links', items: links };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * A string a model wrote. It is counted against the aggregate whatever else is wrong with
 * it, so a Digest cannot buy budget by also breaking a per-field cap.
 */
function authored(pass: Pass, field: string, text: string, max: number): void {
  pass.authored.push(text);
  if (text.trim().length === 0) {
    reject(pass, field, 'is empty');
    return;
  }
  if (/[\r\n]/.test(text)) {
    reject(pass, field, 'carries a newline');
  }
  const count = charCount(text);
  if (count > max) {
    reject(pass, field, `${count} > ${max} chars`);
  }
}

/** An authored string that must be present. Returns `null` when it was refused. */
function requireString(
  pass: Pass,
  field: string,
  value: JsonValue | undefined,
  max: number,
): string | null {
  if (typeof value !== 'string') {
    reject(pass, field, `${show(value)} is not a string`);
    return null;
  }
  const before = pass.rejections.length;
  authored(pass, field, value, max);
  return pass.rejections.length === before ? value : null;
}

/**
 * `false` when the count is out of range, and **every caller stops descending on `false`**.
 *
 * That is rejection, not truncation: nothing in the array is accepted either way, and the
 * Digest is refused whole. What it prevents is a malformed file amplifying into a Snapshot
 * far larger than itself — a Digest of 100,000 Blocks produced 100,003 separate rejections,
 * each of which the board then serialises to every connected client on every re-scan. The
 * count violation is the finding; the 100,000 that follow from it are noise that buries it.
 */
function checkCount(pass: Pass, field: string, count: number, min: number, max: number): boolean {
  if (count < min) {
    reject(pass, field, `${count} < ${min} items`);
    return false;
  }
  if (count > max) {
    reject(pass, field, `${count} > ${max} items`);
    return false;
  }
  return true;
}

function checkKeys(
  pass: Pass,
  object: JsonObject,
  allowed: readonly string[],
  label: string,
  what: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      reject(pass, `${label}.${key}`, `is not a field of a ${what}`);
    }
  }
}

function reject(pass: Pass, field: string, message: string): void {
  pass.rejections.push({
    kind: 'digest',
    path: pass.sourcePath,
    feature: pass.featureName,
    field,
    message,
  });
}

// ---------------------------------------------------------------------------
// Runtime guards. Nothing below trusts a declared type: every value reaching them came
// off disk, and type stripping erases without checking.
// ---------------------------------------------------------------------------

function isJsonArray(value: readonly JsonValue[] | JsonObject): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  return isJsonArray(value) ? null : value;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  return isJsonArray(value) ? value : null;
}

function isFactState(value: string): value is FactState {
  return FACT_STATES.some((state) => state === value);
}

function isBulletTone(value: string): value is BulletTone {
  return BULLET_TONES.some((tone) => tone === value);
}

/** Code points, not code units, so one character a reader sees once costs one char. */
function charCount(text: string): number {
  return [...text].length;
}

/**
 * A value as it appears in a message. Long strings are shortened **here only** — the
 * stored value is never truncated, and shortening a 900-character quotation inside an
 * error would bury the field name the message exists to carry.
 */
function show(value: JsonValue | undefined): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  // A string is described by its shape and its size, and never by its characters. Numbers
  // and booleans carry no prose, so naming them costs nothing and helps.
  if (typeof value === 'string') return `a ${charCount(value)}-character string`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return isJsonArray(value) ? 'a list' : 'an object';
}
