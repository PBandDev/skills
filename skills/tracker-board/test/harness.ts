/**
 * The `tickets/` fixture harness.
 *
 * Every fixture states its own expectation in a leading `<!-- expect: … -->` comment, so
 * the test file is a **loop over the directory** rather than a wall of literals: adding a
 * fixture requires no edit to any test.
 *
 * Grammar — whitespace-separated `key<op>value`, where `op` is one of `=`, `>`, `<` and a
 * value is a double-quoted string, a `[1,2,3]` array, or a bare token. Values carry
 * em-dashes, backticks, semicolons, parentheses and periods, so the tokenizer respects
 * quotes and brackets rather than splitting on whitespace.
 *
 * An **unrecognised key fails loudly**. Silently skipping one would let a future fixture
 * sit in the suite asserting nothing, which is worse than having no fixture at all.
 */

import assert from 'node:assert/strict';

import type { AnnotationStore, Scan, TicketCard } from '../core/types.ts';

export type ExpectOp = '=' | '>' | '<';
export type ExpectKind = 'quoted' | 'array' | 'bare';

export interface Expectation {
  readonly key: string;
  readonly op: ExpectOp;
  /** Quoted: the unescaped contents. Bare: the token. Array: the text between brackets. */
  readonly text: string;
  readonly kind: ExpectKind;
  /** Parsed members, for `kind: 'array'` only. */
  readonly numbers: readonly number[];
}

/** What a fixture run produced. `card` is `null` only when the seam threw — see rule zero. */
export interface FixtureResult {
  readonly card: TicketCard | null;
  readonly threw: Error | null;
}

export const EMPTY_ANNOTATIONS: AnnotationStore = { schemaVersion: 1, entries: [] };

/**
 * Feed a `tickets/` fixture as a **one-file tree**:
 * `<root>/tickets/issues/<basename>.md`. The Feature is named `tickets` and has no sibling
 * `map.md` — the `type-unknown-hybrid` trap depends on that absence.
 */
export function oneFileTree(fileName: string, text: string | null): Scan {
  const relPath = `tickets/issues/${fileName}`;
  return {
    roots: [
      {
        path: '/fixtures',
        label: 'fixtures',
        trackerPath: '/fixtures/.scratch',
        files: [{ path: relPath, absPath: `/fixtures/.scratch/${relPath}`, text }],
        hiddenWorktrees: 0,
        tracker: 'local-markdown',
        adrFiles: [],
        glossaryFile: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The expect-comment grammar
// ---------------------------------------------------------------------------

/**
 * Read the leading `<!-- expect: … -->` comment. A fixture without one is an authoring
 * error and throws, because a fixture that asserts nothing is invisible in a green suite.
 */
export function parseExpectComment(source: string, fixture: string): readonly Expectation[] {
  const body = findExpectComment(source);
  if (body === null) {
    throw new Error(`${fixture}: no leading <!-- expect: … --> comment`);
  }
  const expectations = tokenize(body, fixture);
  if (expectations.length === 0) {
    // An empty comment is the one malformed shape that would otherwise pass: the fixture
    // would run, throw nothing, and assert nothing.
    throw new Error(`${fixture}: the <!-- expect: … --> comment states no expectations`);
  }
  return expectations;
}

/**
 * The expectation must be the **first non-whitespace construct** in the file, not merely
 * present somewhere in it. A fixture whose expectation drifted below its body would still
 * be read by a looser search, and would then be asserting against a file whose top it no
 * longer describes.
 */
function findExpectComment(source: string): string | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith('<!--')) return null;
  const end = trimmed.indexOf('-->');
  if (end === -1) return null;
  const inner = trimmed.slice('<!--'.length, end).trim();
  if (!inner.startsWith('expect:')) return null;
  return inner.slice('expect:'.length);
}

function tokenize(input: string, fixture: string): readonly Expectation[] {
  const out: Expectation[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && isSpace(input[i])) i += 1;
    if (i >= input.length) break;

    const keyStart = i;
    while (i < input.length && !isOp(input[i]) && !isSpace(input[i])) i += 1;
    const key = input.slice(keyStart, i);
    if (key.length === 0 || i >= input.length || !isOp(input[i])) {
      throw new Error(
        `${fixture}: malformed expectation near "${input.slice(keyStart, keyStart + 40).trim()}" — expected key=value`,
      );
    }
    const op = input[i] as ExpectOp;
    i += 1;

    const char = input[i];
    if (char === '"') {
      i += 1;
      let text = '';
      let closed = false;
      while (i < input.length) {
        const current = input[i];
        if (current === '\\' && i + 1 < input.length) {
          text += input[i + 1];
          i += 2;
          continue;
        }
        if (current === '"') {
          i += 1;
          closed = true;
          break;
        }
        text += current;
        i += 1;
      }
      if (!closed) throw new Error(`${fixture}: unterminated quoted value for "${key}"`);
      requireSeparator(input, i, key, fixture);
      out.push({ key, op, text, kind: 'quoted', numbers: [] });
      continue;
    }

    if (char === '[') {
      const close = input.indexOf(']', i);
      if (close === -1) throw new Error(`${fixture}: unterminated array value for "${key}"`);
      const inner = input.slice(i + 1, close);
      i = close + 1;
      requireSeparator(input, i, key, fixture);
      const trimmedInner = inner.trim();
      // `[]` is a real expectation — several fixtures assert no blockers. A member that is
      // empty is not: `[2,,10]` and `[2,]` are typos, and quietly repairing them would let
      // a fixture assert a list it does not state.
      const parts = trimmedInner.length === 0 ? [] : trimmedInner.split(',');
      const numbers = parts.map((part) => {
        const member = part.trim();
        if (member.length === 0) {
          throw new Error(`${fixture}: "${key}" has an empty array member in "[${inner}]"`);
        }
        const parsed = Number(member);
        if (!Number.isInteger(parsed)) {
          throw new Error(`${fixture}: "${key}" array member "${member}" is not an integer`);
        }
        return parsed;
      });
      out.push({ key, op, text: inner, kind: 'array', numbers });
      continue;
    }

    const valueStart = i;
    while (i < input.length && !isSpace(input[i])) i += 1;
    const text = input.slice(valueStart, i);
    if (text.length === 0) throw new Error(`${fixture}: "${key}" has no value`);
    out.push({ key, op, text, kind: 'bare', numbers: [] });
  }
  return out;
}

/**
 * A closing quote or bracket must be followed by whitespace or the end of the comment.
 * Without this, `title="x"state=done` reads as one pair and the second expectation is lost
 * — silently, which is the only way this harness can fail badly.
 */
function requireSeparator(input: string, at: number, key: string, fixture: string): void {
  if (at < input.length && !isSpace(input[at])) {
    throw new Error(
      `${fixture}: "${key}" is not separated from what follows it — expected whitespace before "${input.slice(at, at + 20)}"`,
    );
  }
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isOp(char: string | undefined): boolean {
  return char === '=' || char === '>' || char === '<';
}

// ---------------------------------------------------------------------------
// Checking one expectation against one card
// ---------------------------------------------------------------------------

/**
 * Assert one expectation. Throws an `Error` — not an assertion failure — for a key the
 * harness does not handle, so a typo or a newly-invented key surfaces immediately rather
 * than passing silently.
 *
 * The fixture name is in every message so it survives into `node --test`'s failure
 * summary, where the subtest path alone is not always enough to tell which file moved.
 */
export function checkExpectation(
  expectation: Expectation,
  result: FixtureResult,
  fixture: string,
): void {
  const where = `${fixture}: ${expectation.key}`;

  if (expectation.key === 'throws') {
    requireOp(expectation, '=', fixture);
    requireBare(expectation, fixture);
    if (expectation.text !== 'never') {
      throw new Error(`${where}: only "throws=never" is meaningful — got "${expectation.text}"`);
    }
    assert.equal(
      result.threw,
      null,
      `${where}: deriveSnapshot threw — rule zero, the parser never throws (${String(result.threw)})`,
    );
    return;
  }

  const card = result.card;
  if (card === null) {
    assert.fail(`${where}: no card — deriveSnapshot threw (${String(result.threw)})`);
  }

  switch (expectation.key) {
    case 'number': {
      requireOp(expectation, '=', fixture);
      assert.equal(card.extraction.number, requireInteger(expectation, fixture), where);
      return;
    }
    case 'title': {
      requireOp(expectation, '=', fixture);
      if (expectation.kind === 'quoted') {
        assert.equal(card.extraction.title, expectation.text, where);
        return;
      }
      if (expectation.kind === 'bare' && expectation.text === 'from-filename') {
        assert.equal(card.extraction.titleSource, 'filename', `${where} (titleSource)`);
        return;
      }
      throw new Error(
        `${where}: expected a quoted title or the sentinel "from-filename" — got "${expectation.text}"`,
      );
    }
    case 'dialect': {
      requireOp(expectation, '=', fixture);
      requireBare(expectation, fixture);
      assert.equal(card.extraction.dialect, expectation.text, where);
      return;
    }
    case 'blockedBy': {
      requireOp(expectation, '=', fixture);
      if (expectation.kind !== 'array') {
        throw new Error(`${where}: expected an array value like [2,3] — got "${expectation.text}"`);
      }
      assert.deepEqual([...card.extraction.blockedBy], [...expectation.numbers], where);
      return;
    }
    case 'externalBlocker': {
      requireOp(expectation, '=', fixture);
      if (expectation.kind === 'quoted') {
        assert.equal(card.extraction.externalBlocker, expectation.text, where);
        return;
      }
      if (expectation.kind === 'bare' && expectation.text === 'none') {
        assert.equal(card.extraction.externalBlocker, null, `${where} (sentinel none)`);
        return;
      }
      throw new Error(
        `${where}: expected a quoted string or the sentinel "none" — got "${expectation.text}"`,
      );
    }
    case 'state': {
      requireOp(expectation, '=', fixture);
      requireBare(expectation, fixture);
      assert.equal(card.derivation.state, expectation.text, where);
      return;
    }
    case 'lane': {
      requireOp(expectation, '=', fixture);
      requireBare(expectation, fixture);
      assert.equal(card.derivation.lane, expectation.text, where);
      return;
    }
    case 'criteria': {
      requireOp(expectation, '=', fixture);
      const ratio = /^(\d+)\/(\d+)$/.exec(expectation.text);
      if (ratio === null) {
        throw new Error(`${where}: expected a ratio like 2/2 — got "${expectation.text}"`);
      }
      assert.equal(card.extraction.criteria.checked, Number(ratio[1]), `${where} (checked)`);
      assert.equal(card.extraction.criteria.total, Number(ratio[2]), `${where} (total)`);
      return;
    }
    case 'rawStatus': {
      requireOp(expectation, '=', fixture);
      if (expectation.kind !== 'quoted') {
        throw new Error(`${where}: expected a quoted value — got "${expectation.text}"`);
      }
      assert.equal(card.extraction.rawStatus, expectation.text, where);
      return;
    }
    case 'statusPrefix': {
      requireOp(expectation, '=', fixture);
      requireBare(expectation, fixture);
      assert.equal(card.extraction.statusPrefix, expectation.text, where);
      return;
    }
    case 'qualifier': {
      requireOp(expectation, '=', fixture);
      if (expectation.kind !== 'quoted') {
        throw new Error(`${where}: expected a quoted value — got "${expectation.text}"`);
      }
      assert.equal(card.extraction.qualifier, expectation.text, where);
      return;
    }
    case 'qualifierLength': {
      const bound = requireInteger(expectation, fixture);
      const actual = card.extraction.qualifier.length;
      if (expectation.op === '>') {
        assert.ok(actual > bound, `${where}: ${actual} is not > ${bound}`);
        return;
      }
      if (expectation.op === '<') {
        assert.ok(actual < bound, `${where}: ${actual} is not < ${bound}`);
        return;
      }
      assert.equal(actual, bound, where);
      return;
    }
    case 'ticketType': {
      requireOp(expectation, '=', fixture);
      if (expectation.kind !== 'quoted') {
        throw new Error(`${where}: expected a quoted value — got "${expectation.text}"`);
      }
      assert.equal(card.extraction.ticketType, expectation.text, where);
      return;
    }
    case 'hitl': {
      requireOp(expectation, '=', fixture);
      requireBare(expectation, fixture);
      if (expectation.text !== 'true' && expectation.text !== 'false') {
        throw new Error(`${where}: expected true or false — got "${expectation.text}"`);
      }
      assert.equal(card.extraction.hitl, expectation.text === 'true', where);
      return;
    }
    case 'renders': {
      requireOp(expectation, '=', fixture);
      requireBare(expectation, fixture);
      if (expectation.text !== 'raw-fields') {
        throw new Error(`${where}: only "renders=raw-fields" is handled — got "${expectation.text}"`);
      }
      assert.ok(
        card.extraction.rawFields.length > 0,
        `${where}: the card exposes no raw fields, so an unclassified card would render empty`,
      );
      return;
    }
    default:
      throw new Error(
        `${where}: unrecognised expectation key "${expectation.key}". Handle it in test/harness.ts — an unhandled key would let this fixture assert nothing.`,
      );
  }
}

function requireOp(expectation: Expectation, op: ExpectOp, fixture: string): void {
  if (expectation.op !== op) {
    throw new Error(
      `${fixture}: "${expectation.key}" only supports "${op}" — got "${expectation.op}"`,
    );
  }
}

function requireBare(expectation: Expectation, fixture: string): void {
  if (expectation.kind !== 'bare') {
    throw new Error(
      `${fixture}: "${expectation.key}" expects a bare token — got a ${expectation.kind} value`,
    );
  }
}

function requireInteger(expectation: Expectation, fixture: string): number {
  const parsed = Number(expectation.text);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fixture}: "${expectation.key}" expects an integer — got "${expectation.text}"`);
  }
  return parsed;
}
