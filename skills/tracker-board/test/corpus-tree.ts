/**
 * The committed fixture corpus, as a {@link Scan} the seam can be handed.
 *
 * Shared by `corpus.test.ts` and by the golden generator under `tools/`, so the golden and
 * the test that checks it are built from **one** description of the tree. Two descriptions
 * would drift, and the first symptom would be a golden that passes against a corpus nobody
 * is reading any more.
 *
 * This module registers no tests. `node --test` loads every source file under `test/`, so a
 * helper here reports as a trivially green entry — the same shape as `harness.ts`.
 *
 * Two properties this file exists to guarantee:
 *
 *   - **The Root path is synthetic.** `/corpus`, never the directory this repository
 *     happens to sit in. A card's id is `<rootPath>#<relPath>`, so a real path would write
 *     one machine's absolute paths into a committed golden and the file would never match
 *     on anybody else's disk. The same synthetic Root is already used by `seam.test.ts` and
 *     `dialect.test.ts`.
 *   - **Line endings are normalised to LF.** A card's `contentSha` is a hash of its text,
 *     and `core.autocrlf` decides whether a checkout writes LF or CRLF — so without this the
 *     golden would encode which platform generated it. The parser's own indifference to
 *     line endings is asserted separately in `corpus.test.ts`; it is not assumed here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Root, Scan } from '../core/types.ts';

/** Synthetic, so every id in the golden is the same on every machine. */
export const CORPUS_ROOT_PATH = '/corpus';

export const CORPUS_DIR = join(import.meta.dirname, 'fixtures', 'corpus');

/**
 * Every file the corpus is expected to contain, tracker-relative and POSIX.
 *
 * Stated rather than counted. The corpus is pinned at ten Tickets across three Features, and
 * a file that appeared or vanished must fail loudly here rather than quietly change what the
 * golden describes — including the golden itself, which lives one directory **above** this
 * tree precisely so that walking the corpus can never pick it up.
 */
export const CORPUS_FILES: readonly string[] = [
  'checkout-flow/issues/01-light-theme-default.md',
  'checkout-flow/issues/02-prefactor-loader-seams.md',
  'checkout-flow/issues/03-sources-panel.md',
  'checkout-flow/spec.md',
  'design-system/issues/12-widen-threshold-band.md',
  'search-ranking/issues/02-questions-for-vendor-contact.md',
  'search-ranking/issues/03-cutoff-source.md',
  'search-ranking/issues/09-load-current-roster.md',
  'search-ranking/issues/10-name-the-launch-date.md',
  'search-ranking/issues/11-sources-panel.md',
  'search-ranking/issues/16-regenerate-after-certification.md',
  'search-ranking/map.md',
];

/** What the corpus directory actually holds right now, tracker-relative and POSIX, sorted. */
export function corpusFiles(): readonly string[] {
  return readdirSync(CORPUS_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(relative(CORPUS_DIR, join(entry.parentPath, entry.name))))
    .sort();
}

/**
 * The corpus as the seam sees it.
 *
 * `edit` rewrites one file's text on the way through, for the mutation checks that prove a
 * fixture's blast radius without touching the fixture on disk. It defaults to identity, so
 * the golden and the ordinary read are the same call.
 */
export function corpusScan(edit: (path: string, text: string) => string = (_path, text) => text): Scan {
  const root: Root = {
    path: CORPUS_ROOT_PATH,
    label: 'corpus',
    trackerPath: `${CORPUS_ROOT_PATH}/.scratch`,
    files: corpusFiles().map((path) => ({
      path,
      absPath: `${CORPUS_ROOT_PATH}/.scratch/${path}`,
      text: edit(path, readText(join(CORPUS_DIR, toNative(path)))),
    })),
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
  return { roots: [root] };
}

/**
 * LF, whatever the checkout wrote.
 *
 * This repository carries no `.gitattributes`, so on a machine with `core.autocrlf=true` git
 * rewrites every committed text file to CRLF on the way out — the **golden included**. A
 * comparison against generated LF text would then fail on a fresh Windows clone while the
 * JSON was structurally identical, which reads as "the parser regressed" and is not that.
 * Normalising in code rather than leaning on a git attribute keeps the check honest wherever
 * the file came from.
 */
export function toLf(text: string): string {
  return text.split('\r\n').join('\n');
}

function readText(absPath: string): string {
  return toLf(readFileSync(absPath, 'utf8'));
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function toNative(value: string): string {
  return value.split('/').join(sep);
}
