/**
 * Generates `test/fixtures/corpus.expected.json` — the corpus golden.
 *
 * The golden is **generated from a green parser and never hand-authored**. With no parser to
 * check it against, a hand-written golden encodes its author's mistakes as truth, and the
 * parser then gets "fixed" until it reproduces them.
 *
 * That cuts the other way too, which is why this script is only half of the check: the golden
 * is produced by the very code it is meant to guard, so on its own it proves nothing more
 * than that the parser agrees with itself. The other half is `test/corpus.test.ts`, which
 * transcribes the table in `test/fixtures/expected.md` — authored independently, by hand,
 * from the rules — into explicit assertions. The golden catches regressions; the transcribed
 * table catches the golden being wrong to begin with. Neither is sufficient alone.
 *
 * **This script must never run as part of the suite.** If it did, it would rewrite the golden
 * on every `node --test` and the corpus test would pass forever no matter what the parser
 * did. Two things keep it out:
 *
 *   - It lives outside `test/`. `node --test` treats every source file under that directory
 *     as a test file, and nothing under `tools/` matches any of its patterns.
 *   - Nothing happens on import. Both modes require an explicit flag, so even a runner that
 *     loaded this file would execute no branch of it.
 *
 * Usage, from the skill directory:
 *
 * ```
 * node tools/build-corpus-golden.ts --check    # exit 1 if the golden is stale
 * node tools/build-corpus-golden.ts --write    # regenerate it
 * ```
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSnapshot } from '../core/index.ts';
import { CORPUS_FILES, corpusFiles, corpusScan, toLf } from '../test/corpus-tree.ts';
import type { AnnotationStore } from '../core/types.ts';

const GOLDEN_PATH = join(import.meta.dirname, '..', 'test', 'fixtures', 'corpus.expected.json');

const NO_ANNOTATIONS: AnnotationStore = { schemaVersion: 1, entries: [] };

/** Trailing newline included, so the file is a well-formed text file and diffs cleanly. */
export function goldenText(): string {
  const found = [...corpusFiles()].sort();
  const expected = [...CORPUS_FILES].sort();
  if (found.join('\n') !== expected.join('\n')) {
    throw new Error(
      `the corpus directory no longer holds the files the golden describes.\n  expected: ${expected.join(', ')}\n  found:    ${found.join(', ')}`,
    );
  }
  return `${JSON.stringify(deriveSnapshot(corpusScan(), NO_ANNOTATIONS), null, 2)}\n`;
}

function main(argv: readonly string[]): number {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (!write && !check) {
    process.stderr.write('usage: node tools/build-corpus-golden.ts (--check | --write)\n');
    return 2;
  }

  const text = goldenText();
  if (write) {
    writeFileSync(GOLDEN_PATH, text, 'utf8');
    process.stdout.write(`wrote ${text.length} bytes to test/fixtures/corpus.expected.json\n`);
    return 0;
  }

  const current = readCurrent();
  if (current === text) {
    process.stdout.write('corpus.expected.json is current\n');
    return 0;
  }
  process.stderr.write(
    'corpus.expected.json is STALE. Regenerate with --write, then read the diff before committing it: a golden that moved without a rule changing is the parser telling you something.\n',
  );
  return 1;
}

/** Normalised, because a CRLF checkout is not a stale golden. See `toLf`. */
function readCurrent(): string | null {
  try {
    return toLf(readFileSync(GOLDEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// Guarded twice over: nothing above ran on import, and this line does nothing without a flag.
if (process.argv.includes('--write') || process.argv.includes('--check')) {
  process.exitCode = main(process.argv.slice(2));
}
