/**
 * The `tickets/` fixture suite.
 *
 * Fixtures are discovered by **directory listing** — adding a fixture file requires no
 * edit here. Each one is fed as a one-file tree and asserted against its own leading
 * `<!-- expect: … -->` comment, one `node --test` subtest per expectation key, so a
 * failure names the fixture *and* the field that disagreed rather than "the parser".
 *
 * Each fixture pins a named rule group, so a regression reports the input shape and the
 * observable field it changed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS, checkExpectation, oneFileTree, parseExpectComment } from './harness.ts';
import type { FixtureResult } from './harness.ts';

const TICKETS_DIR = join(import.meta.dirname, 'fixtures', 'tickets');

const fixtures = readdirSync(TICKETS_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort();

test('fixture discovery', () => {
  assert.ok(
    fixtures.length > 0,
    `no fixtures discovered under ${TICKETS_DIR} — the suite would be silently empty`,
  );
});

for (const fixture of fixtures) {
  test(`tickets/${fixture}`, async (t) => {
    const source = readFileSync(join(TICKETS_DIR, fixture), 'utf8');
    const result = run(fixture, source);

    await t.test('rule-zero: never throws', () => {
      assert.equal(
        result.threw,
        null,
        `${fixture}: deriveSnapshot threw. A fixture that makes the parser throw is a failing test, whatever else it proves — ${String(result.threw)}`,
      );
    });

    await t.test('produces one card', () => {
      assert.ok(result.card !== null, `${fixture}: the one-file tree produced no card`);
    });

    for (const expectation of parseExpectComment(source, fixture)) {
      await t.test(expectation.key, () => {
        checkExpectation(expectation, result, fixture);
      });
    }
  });
}

function run(fixture: string, source: string): FixtureResult {
  try {
    const snapshot = deriveSnapshot(oneFileTree(fixture, source), EMPTY_ANNOTATIONS);
    return { card: snapshot.roots[0]?.features[0]?.tickets[0] ?? null, threw: null };
  } catch (error) {
    return {
      card: null,
      threw: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
