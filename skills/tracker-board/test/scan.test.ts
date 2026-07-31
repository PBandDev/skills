/**
 * The detectors' own tests.
 *
 * A structural check that has never been shown to fail is decorative: it passes on the day
 * it is written and on every day after, including the day the property it guards stops
 * being true. These cases pin what each detector catches — and, just as importantly, they
 * pin the forms an earlier regex-only version silently let through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { impurities, importRefs, normalizeSpecifier, reachesInternal, readsOutsideWorld } from './scan.ts';

test('runtime module references are collected in every written form', () => {
  const cases: readonly (readonly [string, string])[] = [
    ["import { readFileSync } from 'node:fs';", 'node:fs'],
    ['import { x } from "node:fs";', 'node:fs'],
    ['import {\n  a,\n  b,\n} from `node:fs`;', 'node:fs'],
    ["import 'node:fs';", 'node:fs'],
    ["export { x } from 'node:fs';", 'node:fs'],
    ["const fs = await import('node:fs');", 'node:fs'],
    ['const fs = await import(`node:fs`);', 'node:fs'],
    ["const fs = require('node:fs');", 'node:fs'],
  ];
  for (const [source, expected] of cases) {
    const specifiers = importRefs(source).map((ref) => ref.specifier);
    assert.ok(
      specifiers.includes(expected),
      `missed the module reference in: ${JSON.stringify(source)} (saw ${JSON.stringify(specifiers)})`,
    );
  }
});

test('type-only imports and exports are not runtime references', () => {
  const source = [
    "import type { A } from 'node:fs';",
    "export type { B } from 'node:fs';",
    "export type * from 'node:fs';",
  ].join('\n');
  assert.deepEqual(importRefs(source), [], 'type-only syntax is erased and must not be collected');
});

test('a computed dynamic import reports as unreadable rather than as absent', () => {
  const refs = importRefs("const mod = await import('node:' + 'fs');");
  assert.ok(
    refs.some((ref) => ref.form === 'dynamic' && ref.specifier === null),
    'a specifier that cannot be read must fail closed, not vanish',
  );
});

test('the outside world is recognised in bare, prefixed and submodule spellings', () => {
  for (const specifier of [
    'fs',
    'node:fs',
    'node:fs/promises',
    'http',
    'node:child_process',
    'node:net',
    'node:worker_threads',
    'node:process',
  ]) {
    assert.ok(readsOutsideWorld(specifier), `${specifier} should be refused inside core/`);
  }
});

test('node:crypto stays permitted — hashing is pure computation', () => {
  assert.equal(readsOutsideWorld('node:crypto'), false);
  assert.equal(readsOutsideWorld('./internal/fields.ts'), false);
  assert.equal(readsOutsideWorld('node:test'), false);
});

test('the internal boundary survives redundant path segments', () => {
  for (const specifier of [
    '../core/internal/status.ts',
    '../core/./internal/status.ts',
    '../core//internal/status.ts',
    '../core/././internal/status.ts',
    '..\\core\\internal\\status.ts',
  ]) {
    assert.ok(reachesInternal(specifier), `${specifier} reaches core/internal and must be caught`);
  }
  assert.equal(reachesInternal('../core/types.ts'), false);
  assert.equal(reachesInternal('../core/index.ts'), false);
});

test('normalizing a specifier does not mangle a plain one', () => {
  assert.equal(normalizeSpecifier('./internal/fields.ts'), './internal/fields.ts');
  assert.equal(normalizeSpecifier('node:crypto'), 'node:crypto');
});

test('clock and random reads are caught in the forms that actually occur', () => {
  for (const source of [
    'const t = Date.now();',
    'const t = Date();',
    'const t = new Date();',
    'const t = new  Date(2026, 1, 1);',
    'const t = performance.now();',
    'const t = hrtime.bigint();',
    'const r = Math.random();',
    "import { randomUUID } from 'node:crypto'; const id = randomUUID();",
    'const b = crypto.getRandomValues(new Uint8Array(4));',
    'const p = process.cwd();',
  ]) {
    assert.ok(impurities(source).length > 0, `not caught: ${source}`);
  }
});

test('ordinary pure code is not flagged', () => {
  for (const source of [
    "import { createHash } from 'node:crypto';",
    "createHash('sha256').update(text, 'utf8').digest('hex');",
    'const rounded = Math.round(value * 100);',
    'const floored = Math.floor(count);',
    'const updated = { ...previous, dated: true };',
  ]) {
    assert.deepEqual(impurities(source), [], `false positive on: ${source}`);
  }
});
