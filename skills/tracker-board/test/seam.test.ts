/**
 * Properties of the seam itself — all machine-checkable, so structural regressions fail at
 * the boundary instead of relying on a source diff to reveal them.
 *
 * Two of these are **source scans** rather than behaviour tests. Purity and encapsulation
 * are structural claims: a behaviour test can only show that the seam happened not to
 * touch a disk on the input it was given, while a scan shows it cannot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import * as core from '../core/index.ts';
import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS, oneFileTree } from './harness.ts';
import { impurities, importRefs, reachesInternal, readsOutsideWorld } from './scan.ts';
import type { Root, Scan } from '../core/types.ts';

const SKILL_DIR = join(import.meta.dirname, '..');
const CORE_DIR = join(SKILL_DIR, 'core');
const SOURCE_EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs)$/;

// ---------------------------------------------------------------------------
// The export surface
// ---------------------------------------------------------------------------

test('core exports exactly one runtime value', () => {
  assert.deepEqual(
    Object.keys(core).sort(),
    ['deriveSnapshot'],
    'core must expose one seam. Type re-exports are erased and do not count; a second runtime export is a second surface to keep honest.',
  );
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('deriveSnapshot is pure: the same input returns the same Snapshot', () => {
  const scan = corpusScan();
  const first = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const second = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  assert.deepEqual(first, second, 'two calls on one input disagreed — cards would flicker between scans');
});

test('no file under core/ reaches for the outside world', () => {
  for (const file of listSources(CORE_DIR)) {
    for (const ref of importRefs(readFileSync(file, 'utf8'))) {
      assert.ok(
        ref.specifier !== null,
        `${label(file)} loads a module through a computed specifier. core/ has no reason to, and a specifier that cannot be read cannot be checked — so it fails closed.`,
      );
      assert.ok(
        !readsOutsideWorld(ref.specifier),
        `${label(file)} imports "${ref.specifier}". The seam does no I/O — the tree walk hands it an in-memory tree. node:crypto is the one permitted module, because hashing is pure computation.`,
      );
    }
  }
});

test('no file under core/ reads a clock or a random source', () => {
  for (const file of listSources(CORE_DIR)) {
    assert.deepEqual(
      impurities(readFileSync(file, 'utf8')),
      [],
      `${label(file)} is not deterministic. A Snapshot that changes when nothing changed is a board nobody trusts. Note the scan reads comments and strings too, so prose in core/ avoids these tokens literally.`,
    );
  }
});

// ---------------------------------------------------------------------------
// Encapsulation
// ---------------------------------------------------------------------------

test('nothing outside core/ imports core/internal at runtime', () => {
  for (const file of listSources(SKILL_DIR)) {
    if (!relative(CORE_DIR, file).startsWith('..')) continue;
    for (const ref of importRefs(readFileSync(file, 'utf8'))) {
      if (ref.specifier === null) continue;
      assert.ok(
        !reachesInternal(ref.specifier),
        `${label(file)} imports "${ref.specifier}" at runtime. The rule modules are reachable only through deriveSnapshot; type-only imports are erased and are fine.`,
      );
    }
  }
});

test('core/types.ts has no runtime exports at all', async () => {
  // Not the same claim as core/index.ts having one. A stripped types.ts that carried no
  // ESM marker would load as CommonJS and hand back a `default` key.
  const types = await import('../core/types.ts');
  assert.deepEqual(
    Object.keys(types),
    [],
    'types.ts must be erased to nothing. A `default` export here means it lost its ESM marker.',
  );
});

// ---------------------------------------------------------------------------
// Every file is accounted for
// ---------------------------------------------------------------------------

test('every scanned file is represented in the Snapshot exactly once', () => {
  const paths = [
    'alpha/issues/01-first.md',
    'alpha/issues/02-second.md',
    'alpha/spec.md',
    'alpha/notes/aside.md',
    'beta/map.md',
    'beta/issues/10-tenth.md',
    'gamma/issues/03-third.md',
    'loose-at-the-root.md',
  ];
  const snapshot = deriveSnapshot(treeOf(paths), EMPTY_ANNOTATIONS);
  const root = snapshot.roots[0];
  assert.ok(root !== undefined, 'the Root did not survive the scan');

  const represented = [
    ...root.features.flatMap((feature) => feature.tickets.map((ticket) => ticket.path)),
    ...root.features.flatMap((feature) => feature.siblings.map((sibling) => sibling.path)),
    ...root.orphans.map((orphan) => orphan.path),
  ].sort();
  assert.deepEqual(
    represented,
    [...paths].sort(),
    'a scanned file went missing. A file the Snapshot does not mention is a file nobody knows the board ignored.',
  );
});

test('every file under issues/ produces a card', () => {
  const paths = [
    'alpha/issues/01-first.md',
    'alpha/spec.md',
    'beta/issues/10-tenth.md',
    'beta/map.md',
  ];
  const snapshot = deriveSnapshot(treeOf(paths), EMPTY_ANNOTATIONS);
  const cards = (snapshot.roots[0]?.features ?? []).flatMap((feature) =>
    feature.tickets.map((ticket) => ticket.path),
  );
  assert.deepEqual(cards.sort(), ['alpha/issues/01-first.md', 'beta/issues/10-tenth.md']);
});

test('a Feature renders with spec.md, with map.md, or with neither', () => {
  const snapshot = deriveSnapshot(
    treeOf([
      'has-spec/spec.md',
      'has-spec/issues/01-a.md',
      'has-map/map.md',
      'has-map/issues/01-b.md',
      'has-neither/issues/01-c.md',
    ]),
    EMPTY_ANNOTATIONS,
  );
  const features = snapshot.roots[0]?.features ?? [];
  assert.deepEqual(
    features.map((feature) => [feature.name, feature.specPath, feature.mapPath]),
    [
      ['has-map', null, 'has-map/map.md'],
      ['has-neither', null, null],
      ['has-spec', 'has-spec/spec.md', null],
    ],
    'all three Feature shapes are real and all three must render',
  );
});

test('two Roots holding the same relative path stay distinct identities', () => {
  // One board, several Roots, one Annotation store. If identity were Root-relative, these
  // two would share an Override whenever their content hashes matched and would mark each
  // other expired whenever they did not.
  const rootOf = (path: string, text: string): Root => ({
    path,
    label: path,
    trackerPath: `${path}/.scratch`,
    files: [{ path: 'payments/issues/01-charge.md', absPath: `${path}/x`, text }],
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  });

  const same = deriveSnapshot(
    { roots: [rootOf('/repo-a', '# identical'), rootOf('/repo-b', '# identical')] },
    EMPTY_ANNOTATIONS,
  );
  const [a, b] = same.roots.map((root) => root.features[0]?.tickets[0]);
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(a.contentSha, b.contentSha, 'identical content does hash identically — that is the point');
  assert.notEqual(a.id, b.id, 'identical content in two Roots must still be two identities');

  const differing = deriveSnapshot(
    { roots: [rootOf('/repo-a', '# one'), rootOf('/repo-b', '# two')] },
    EMPTY_ANNOTATIONS,
  );
  const ids = differing.roots.map((root) => root.features[0]?.tickets[0]?.id);
  assert.equal(new Set(ids).size, 2, 'differing content in two Roots must also be two identities');
});

test('an unreadable file produces an unparsed card showing its raw filename', () => {
  const snapshot = deriveSnapshot(oneFileTree('11-torn-mid-write.md', null), EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, 'an unreadable file produced no card at all');
  assert.equal(card.derivation.state, 'unparsed');
  assert.equal(card.derivation.lane, null, 'an unparsed card takes no Lane');
  assert.equal(card.fileName, '11-torn-mid-write.md');
  assert.equal(card.contentSha, null, 'there is no content to hash');
});

// ---------------------------------------------------------------------------
// Rule zero, at the seam
// ---------------------------------------------------------------------------

test('a malformed collection says so instead of reading as an empty tracker', () => {
  const badRoots: Scan = JSON.parse('{"roots":{"0":{"path":"/r"}}}');
  const withBadRoots = deriveSnapshot(badRoots, EMPTY_ANNOTATIONS);
  assert.deepEqual(withBadRoots.roots, []);
  assert.ok(
    withBadRoots.warnings.some((warning) => warning.message.includes('scan.roots was not a list')),
    'an object-valued roots erased the whole board without saying so',
  );

  const badFiles: Scan = JSON.parse('{"roots":[{"path":"/r","files":{"0":{"path":"f/issues/01.md"}}}]}');
  const withBadFiles = deriveSnapshot(badFiles, EMPTY_ANNOTATIONS);
  assert.equal(withBadFiles.roots.length, 1);
  assert.ok(
    withBadFiles.warnings.some((warning) => warning.message.includes('Root.files was not a list')),
    'an object-valued files erased a Root without saying so',
  );
});

test('unparsed cards do not share one criteria object', () => {
  const snapshot = deriveSnapshot(
    {
      roots: [
        {
          path: '/r',
          label: 'r',
          trackerPath: '/r/.scratch',
          files: [
            { path: 'f/issues/a.md', absPath: '/r/a', text: null },
            { path: 'f/issues/b.md', absPath: '/r/b', text: null },
          ],
          hiddenWorktrees: 0,
          tracker: 'local-markdown',
          adrFiles: [],
          glossaryFile: null,
        },
      ],
    },
    EMPTY_ANNOTATIONS,
  );
  const [first, second] = snapshot.roots[0]?.features[0]?.tickets ?? [];
  assert.ok(first !== undefined && second !== undefined);
  assert.notEqual(
    first.extraction.criteria,
    second.extraction.criteria,
    'two cards shared one criteria object, so a caller mutating one would rewrite the other',
  );
  assert.notEqual(first.extraction.criteria.items, second.extraction.criteria.items);
});

test('never throws on input that arrived off disk as JSON', () => {
  // Type stripping erases and does not check, so this is what the seam is actually
  // handed: parsed JSON whose declared type is a claim, not a guarantee.
  const scan: Scan = JSON.parse(
    '{"roots":[{"path":"/a","files":[{"path":"f/issues/x.md"},{"path":""},{"path":"f/issues/y.md","text":null}]},{},null,{"roots":1}]}',
  );
  const store = JSON.parse('{"entries":"not an array"}');
  assert.doesNotThrow(() => deriveSnapshot(scan, store));
  const snapshot = deriveSnapshot(scan, store);
  assert.ok(snapshot.warnings.length >= 0);
  assert.equal(snapshot.schemaVersion, 1);
});

test('never throws on an empty scan', () => {
  const snapshot = deriveSnapshot({ roots: [] }, EMPTY_ANNOTATIONS);
  assert.deepEqual(snapshot.roots, []);
  assert.equal(snapshot.frontierCount, 0);
  assert.equal(snapshot.progress.total, 0);
  assert.equal(
    snapshot.progress.label,
    'finished and off your desk',
    'the progress figure ships with what it counts — it is the one number a reader quotes',
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function treeOf(paths: readonly string[]): Scan {
  const root: Root = {
    path: '/repo',
    label: 'repo',
    trackerPath: '/repo/.scratch',
    files: paths.map((path) => ({
      path,
      absPath: `/repo/.scratch/${path}`,
      text: `# placeholder\n\n${path}\n`,
    })),
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
  return { roots: [root] };
}

/** The committed corpus, read off disk and fed through the seam whole. */
function corpusScan(): Scan {
  const corpusDir = join(import.meta.dirname, 'fixtures', 'corpus');
  const files = readdirSync(corpusDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const root: Root = {
    path: '/corpus',
    label: 'corpus',
    trackerPath: corpusDir,
    files: files.map((file) => ({
      path: relative(corpusDir, file).split(sep).join('/'),
      absPath: file,
      text: readFileSync(file, 'utf8'),
    })),
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
  return { roots: [root] };
}

function listSources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function label(file: string): string {
  return relative(SKILL_DIR, file).split(sep).join('/');
}
