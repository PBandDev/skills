/**
 * The harness's own contract.
 *
 * The fixture suite is only as good as its reader: a tokenizer that splits on whitespace
 * mangles every value carrying an em-dash or a semicolon, and a checker that shrugs at an
 * unknown key lets a future fixture sit in a green suite asserting nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { checkExpectation, parseExpectComment } from './harness.ts';
import type { FixtureResult } from './harness.ts';

const TICKETS_DIR = join(import.meta.dirname, 'fixtures', 'tickets');

const CARD: FixtureResult = {
  threw: null,
  card: {
    id: '/x#tickets/issues/a.md',
    path: 'tickets/issues/a.md',
    absPath: '/x/tickets/issues/a.md',
    fileName: 'a.md',
    contentSha: null,
    readError: null,
    extraction: {
      number: null,
      title: '',
      titleSource: 'none',
      criteria: { checked: 0, total: 0, items: [] },
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
    },
    derivation: {
      lane: null,
      state: 'unparsed',
      frozenOn: null,
      correctedFields: [],
      danglingBlockers: [],
      onFrontier: false,
    },
  },
};

test('a quoted value survives its em-dashes, backticks, semicolons and periods', () => {
  const source =
    '<!-- expect: dialect=task blockedBy=[] externalBlocker="External events — not before 2026-08-05 (region-A determination; ideally also the region-B panel ruling)." state=blocked -->';
  assert.deepEqual(
    parseExpectComment(source, 'demo.md').map((expectation) => [
      expectation.key,
      expectation.kind,
      expectation.text,
    ]),
    [
      ['dialect', 'bare', 'task'],
      ['blockedBy', 'array', ''],
      [
        'externalBlocker',
        'quoted',
        'External events — not before 2026-08-05 (region-A determination; ideally also the region-B panel ruling).',
      ],
      ['state', 'bare', 'blocked'],
    ],
  );
});

test('an array value parses to integers at any width', () => {
  const [expectation] = parseExpectComment('<!-- expect: blockedBy=[2,10,100] -->', 'demo.md');
  assert.ok(expectation !== undefined);
  assert.deepEqual([...expectation.numbers], [2, 10, 100]);
});

test('a comparison operator is read as one', () => {
  const [expectation] = parseExpectComment('<!-- expect: qualifierLength>400 -->', 'demo.md');
  assert.ok(expectation !== undefined);
  assert.equal(expectation.key, 'qualifierLength');
  assert.equal(expectation.op, '>');
  assert.equal(expectation.text, '400');
});

test('the trap comment is not mistaken for the expectation', () => {
  const source = '<!-- expect: number=7 -->\n<!-- trap: number=999 is a lie -->\n';
  assert.deepEqual(
    parseExpectComment(source, 'demo.md').map((expectation) => expectation.key),
    ['number'],
  );
});

test('a fixture with no expect comment fails loudly', () => {
  assert.throws(
    () => parseExpectComment('# just a heading\n', 'demo.md'),
    /no leading <!-- expect/,
  );
});

test('an empty expect comment fails loudly rather than asserting nothing', () => {
  assert.throws(() => parseExpectComment('<!-- expect: -->\n', 'demo.md'), /states no expectations/);
});

test('a key with no value fails loudly', () => {
  assert.throws(() => parseExpectComment('<!-- expect: number= -->', 'demo.md'), /has no value/);
});

test('a pair with spaces around the operator fails loudly', () => {
  assert.throws(() => parseExpectComment('<!-- expect: number = 7 -->', 'demo.md'), /malformed expectation/);
});

test('an expect comment below the body is not accepted as the leading one', () => {
  assert.throws(
    () => parseExpectComment('# a heading\n\n<!-- expect: number=7 -->\n', 'demo.md'),
    /no leading <!-- expect/,
  );
});

test('an empty array member is a typo, not an empty list', () => {
  assert.throws(() => parseExpectComment('<!-- expect: blockedBy=[2,,10] -->', 'demo.md'), /empty array member/);
  assert.throws(() => parseExpectComment('<!-- expect: blockedBy=[2,] -->', 'demo.md'), /empty array member/);
  const [empty] = parseExpectComment('<!-- expect: blockedBy=[] -->', 'demo.md');
  assert.ok(empty !== undefined);
  assert.deepEqual([...empty.numbers], [], 'an actually empty list stays legal');
});

test('two pairs run together without whitespace fail loudly', () => {
  assert.throws(
    () => parseExpectComment('<!-- expect: title="x"state=done -->', 'demo.md'),
    /not separated from what follows/,
  );
  assert.throws(
    () => parseExpectComment('<!-- expect: blockedBy=[2]state=done -->', 'demo.md'),
    /not separated from what follows/,
  );
});

test('an unrecognised key fails loudly rather than being skipped', () => {
  const [expectation] = parseExpectComment('<!-- expect: bogusKey=whatever -->', 'demo.md');
  assert.ok(expectation !== undefined);
  assert.throws(
    () => checkExpectation(expectation, CARD, 'demo.md'),
    /unrecognised expectation key "bogusKey"/,
  );
});

test('an unrecognised sentinel fails loudly rather than passing', () => {
  const [expectation] = parseExpectComment('<!-- expect: externalBlocker=maybe -->', 'demo.md');
  assert.ok(expectation !== undefined);
  assert.throws(() => checkExpectation(expectation, CARD, 'demo.md'), /sentinel "none"/);
});

test('every key used across the fixture set is handled', () => {
  const unhandled = new Set<string>();
  for (const name of readdirSync(TICKETS_DIR).filter((file) => file.endsWith('.md'))) {
    const source = readFileSync(join(TICKETS_DIR, name), 'utf8');
    for (const expectation of parseExpectComment(source, name)) {
      try {
        checkExpectation(expectation, CARD, name);
      } catch (error) {
        // An assertion failure means the key is handled and the value disagreed, which is
        // the whole point of the suite. Only an unhandled key is a harness defect.
        if (String(error).includes('unrecognised expectation key')) unhandled.add(expectation.key);
      }
    }
  }
  assert.deepEqual(
    [...unhandled],
    [],
    'a fixture states an expectation the harness ignores, so that fixture asserts nothing',
  );
});
