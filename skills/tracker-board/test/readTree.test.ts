/**
 * The tree walk, tested end to end.
 *
 * `readTree` sits **outside** the seam, so these are thin integration tests against the
 * committed fixture corpus and against real temporary directories. Wherever a claim is
 * observable on the Snapshot, it is asserted there rather than on an intermediate shape —
 * the corpus counts in particular are the honest check on `ScannedFile.path`, since
 * `core/index.ts` groups purely on the shape of that string and a wrong shape moves the
 * counts while the board still renders.
 *
 * Several failures the walk exists to survive — a directory that cannot be listed, a file
 * that cannot be read, a symbolic link into the tree — cannot be produced on a real disk
 * portably, and on some platforms not without elevated privileges, so `readTree` takes a
 * file-system port and those cases are driven through {@link fakeFs}. The fake resolves
 * links through their target for every operation, so a test cannot pass against a fake shape
 * the real code path never sees.
 *
 * **Every test here is hermetic and platform-neutral.** Temporary trees come from
 * `os.tmpdir()` and are removed afterwards; the fixture corpus is located from
 * `import.meta.dirname`, never from the working directory. Nothing reads the repository this
 * file happens to sit in — the skill is installed into other people's repositories, where
 * anything above its own directory is somebody else's tree.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { deriveSnapshot } from '../core/index.ts';
import type { AnnotationStore, Root, Scan, Snapshot, TicketCard, Warning } from '../core/types.ts';
import { readTree } from '../scan/readTree.ts';
import type { DirEntry, PathKind, ReadTreeFs, ReadTreeOptions } from '../scan/readTree.ts';
import { EMPTY_ANNOTATIONS } from './harness.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');
const WEB_REMOTE_PREFIX = ['https', '://'].join('');
const SSH_REMOTE_PREFIX = ['ssh', '://'].join('');
const REMOTE_AT = '@';

function webRemote(authorityAndPath: string): string {
  return `${WEB_REMOTE_PREFIX}${authorityAndPath}`;
}

function scpRemote(user: string, hostAndPath: string): string {
  return `${user}${REMOTE_AT}${hostAndPath}`;
}

function sshRemote(user: string, hostAndPath: string): string {
  return `${SSH_REMOTE_PREFIX}${scpRemote(user, hostAndPath)}`;
}

function snapshotOf(root: Root): Snapshot {
  return deriveSnapshot({ roots: [root] }, EMPTY_ANNOTATIONS);
}

function ticketPaths(snapshot: Snapshot): string[] {
  return (snapshot.roots[0]?.features ?? [])
    .flatMap((feature) => feature.tickets)
    .map((ticket) => ticket.path)
    .sort();
}

function warningsOfKind(snapshot: Snapshot, kind: Warning['kind']): readonly Warning[] {
  return snapshot.warnings.filter((warning) => warning.kind === kind);
}

// ---------------------------------------------------------------------------
// The committed corpus, walked off disk and fed through the seam
// ---------------------------------------------------------------------------

const CORPUS_TICKETS = [
  'checkout-flow/issues/01-light-theme-default.md',
  'checkout-flow/issues/02-prefactor-loader-seams.md',
  'checkout-flow/issues/03-sources-panel.md',
  'design-system/issues/12-widen-threshold-band.md',
  'search-ranking/issues/02-questions-for-vendor-contact.md',
  'search-ranking/issues/03-cutoff-source.md',
  'search-ranking/issues/09-load-current-roster.md',
  'search-ranking/issues/10-name-the-launch-date.md',
  'search-ranking/issues/11-sources-panel.md',
  'search-ranking/issues/16-regenerate-after-certification.md',
];

function corpusRoot(): Root {
  return readTree(FIXTURES_DIR, { trackerDirName: 'corpus', label: 'corpus' });
}

test('walking the fixture corpus yields three Features and ten Tickets', () => {
  const snapshot = snapshotOf(corpusRoot());
  const root = snapshot.roots[0];
  assert.ok(root !== undefined, 'the walk produced no Root at all');

  assert.deepEqual(
    root.features.map((feature) => feature.name),
    ['checkout-flow', 'design-system', 'search-ranking'],
    'the corpus is pinned at three Features',
  );
  assert.deepEqual(
    ticketPaths(snapshot),
    CORPUS_TICKETS,
    'the corpus is pinned at ten Tickets. A count that moved means ScannedFile.path changed shape — core/index.ts groups purely on that string, so a leading ./ or a Windows separator reclassifies the whole tree and the board still renders, just falsely.',
  );
  assert.deepEqual(root.orphans, [], 'every corpus file sits under a Feature directory');
  assert.equal(root.tracker, 'local-markdown');
  assert.deepEqual(snapshot.warnings, [], 'the corpus walk omitted nothing');
});

test('a map link to a Ticket that does not exist creates no card', () => {
  // `search-ranking/map.md` links `issues/01-feed-shape.md`, which is not on disk. It is a
  // link inside a map, not a Ticket, and it is not a dangling *blocker* reference either.
  const snapshot = snapshotOf(corpusRoot());
  const paths = ticketPaths(snapshot);
  assert.equal(paths.length, 10, 'a phantom card would take the corpus off its pinned ten');
  assert.ok(
    !paths.some((path) => path.includes('01-feed-shape')),
    'the map named a file that does not exist and the walk invented a card for it',
  );
});

test('all three Feature shapes render: spec only, map only, neither', () => {
  const snapshot = snapshotOf(corpusRoot());
  const features = new Map(
    (snapshot.roots[0]?.features ?? []).map((feature) => [feature.name, feature]),
  );

  const checkout = features.get('checkout-flow');
  assert.ok(checkout !== undefined);
  assert.equal(checkout.specPath, 'checkout-flow/spec.md');
  assert.equal(checkout.mapPath, null);

  const search = features.get('search-ranking');
  assert.ok(search !== undefined);
  assert.equal(search.specPath, null);
  assert.equal(search.mapPath, 'search-ranking/map.md');

  const design = features.get('design-system');
  assert.ok(design !== undefined);
  assert.equal(design.specPath, null);
  assert.equal(design.mapPath, null);
  assert.equal(design.tickets.length, 1, 'a Feature with neither spec nor map still renders its Tickets');
});

test('every scanned path is tracker-relative POSIX with no leading punctuation', () => {
  const root = corpusRoot();
  assert.ok(root.files.length > 0, 'the corpus walk found no files');
  for (const file of root.files) {
    assert.ok(!file.path.includes('\\'), `${file.path} carries a Windows separator`);
    assert.ok(!file.path.startsWith('/'), `${file.path} starts with a separator`);
    assert.ok(!file.path.startsWith('./'), `${file.path} starts with ./`);
    assert.ok(!file.path.startsWith('../'), `${file.path} escapes the tracker directory`);
    assert.ok(
      file.absPath.startsWith(root.trackerPath),
      `${file.path} has an absolute path outside the tracker directory`,
    );
  }
});

test('the corpus is walked with spec.md and map.md as sibling links, never as Tickets', () => {
  const snapshot = snapshotOf(corpusRoot());
  const features = snapshot.roots[0]?.features ?? [];
  const siblingPaths = features.flatMap((feature) => feature.siblings.map((link) => link.path));
  assert.deepEqual(
    siblingPaths.sort(),
    ['checkout-flow/spec.md', 'search-ranking/map.md'],
    'the two schema-less files in the corpus must be links',
  );
  assert.ok(
    !ticketPaths(snapshot).some((path) => path.endsWith('/spec.md') || path.endsWith('/map.md')),
    'a spec or a map was read as a Ticket',
  );
});

// ---------------------------------------------------------------------------
// Domain-model inputs
// ---------------------------------------------------------------------------

test('domain-model inputs are collected with Root-relative paths', (t) => {
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-a.md': '# 01 — a\n',
    'docs/adr/0001-first-decision.md': '# 0001 — First decision\n',
    'docs/adr/0002-second-decision.md': '# 0002 — Second decision\n\n## Amendment\n',
    'docs/adr/notes.txt': 'not an ADR\n',
    'CONTEXT.md': '# Context\n\n**Root**: a repo the board is watching.\n',
  });
  const root = readTree(dir);

  assert.deepEqual(
    root.adrFiles.map((adr) => adr.path),
    ['docs/adr/0001-first-decision.md', 'docs/adr/0002-second-decision.md'],
    'ADR paths are Root-relative and POSIX. ADRs live outside trackerPath, so a tracker-relative path here would read ../docs/adr/… — which types.ts does not declare and the panel does not render. The .txt beside them is not an ADR.',
  );
  for (const adr of root.adrFiles) {
    assert.ok(typeof adr.text === 'string' && adr.text.length > 0, `${adr.path} was collected empty`);
  }

  const glossary = root.glossaryFile;
  assert.ok(glossary !== null, 'the Root has a CONTEXT.md; the walk did not collect it');
  assert.equal(glossary.path, 'CONTEXT.md');
  assert.ok(typeof glossary.text === 'string' && glossary.text.includes('Root'));
});

test('an ADR directory or glossary resolving outside the Root is refused, never emitted as ../', (t) => {
  const dir = tempTree(t, { '.scratch/alpha/issues/01-a.md': '# 01 — a\n' });

  const escaped = readTree(dir, { adrDir: '../..', glossaryPath: '../../CONTEXT.md' });
  assert.deepEqual(escaped.adrFiles, [], 'ADRs were read from outside the Root');
  assert.equal(escaped.glossaryFile, null, 'the glossary was read from outside the Root');
  assert.equal(
    warningsOfKind(snapshotOf(escaped), 'read-error').length,
    2,
    'refusing to read outside the Root is an omission and has to be stated',
  );

  const absolute = readTree(dir, { adrDir: resolve(dir, '..'), glossaryPath: resolve(dir, '..', 'x.md') });
  assert.deepEqual(absolute.adrFiles, []);
  assert.equal(absolute.glossaryFile, null);
});

test('a Root with no ADR directory and no glossary walks without complaint', (t) => {
  const dir = tempTree(t, { '.scratch/alpha/issues/01-a.md': '# 01 — a\n' });
  const root = readTree(dir);
  assert.deepEqual(root.adrFiles, []);
  assert.equal(root.glossaryFile, null);
  assert.deepEqual(snapshotOf(root).warnings, [], 'an absent ADR directory is not an omission');
});

test('an ADR directory that exists but cannot be listed is stated, not read as no ADRs', () => {
  const fs = fakeFs({
    '.scratch/alpha/issues/01-a.md': { kind: 'file', text: '# 01 — a\n' },
    'docs/adr': { kind: 'dir', error: { message: 'permission denied', code: 'EACCES' } },
  });
  const root = readTree(fakeBase(), { fs });

  assert.deepEqual(root.adrFiles, []);
  const warnings = warningsOfKind(snapshotOf(root), 'read-error');
  assert.equal(warnings.length, 1, '"no ADRs" and "the ADRs could not be reached" must not render alike');
  assert.match(warnings[0]?.message ?? '', /docs\/adr/);
});

// ---------------------------------------------------------------------------
// Worktree skip
// ---------------------------------------------------------------------------

test('a directory whose .git is a file is a worktree pointer: skipped, counted, and shown', (t) => {
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-real.md': '# 01 — real\n',
    '.scratch/detached/.git': 'gitdir: /elsewhere/.git/worktrees/detached\n',
    '.scratch/detached/issues/99-invisible.md': '# 99 — invisible\n',
  });

  const root = readTree(dir);
  assert.equal(root.hiddenWorktrees, 1);
  assert.ok(
    !root.files.some((file) => file.path.startsWith('detached/')),
    'the worktree pointer was walked into',
  );

  const snapshot = snapshotOf(root);
  assert.deepEqual(ticketPaths(snapshot), ['alpha/issues/01-real.md']);
  const warnings = warningsOfKind(snapshot, 'hidden-worktrees');
  assert.equal(warnings.length, 1, 'the skip reached the Snapshot as a warning, so it is not silent');
  assert.match(warnings[0]?.message ?? '', /1 worktree/);
});

test('a worktree whose directory name starts with a dot is still counted', (t) => {
  // Worktree detection runs before the skip list. A name rule that swallowed this one would
  // omit a whole tree with `hiddenWorktrees === 0`. The count is the whole reason worktrees
  // are skipped visibly rather than quietly.
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-real.md': '# 01 — real\n',
    '.scratch/.detached/.git': 'gitdir: /elsewhere/.git/worktrees/detached\n',
    '.scratch/.detached/issues/99-invisible.md': '# 99 — invisible\n',
  });

  const root = readTree(dir);
  assert.equal(root.hiddenWorktrees, 1, 'a dot-named worktree vanished without being counted');
  assert.equal(warningsOfKind(snapshotOf(root), 'hidden-worktrees').length, 1);
});

test('a directory whose .git is a directory is walked normally', (t) => {
  const dir = tempTree(t, {
    '.scratch/nested/.git/config': '[core]\n',
    '.scratch/nested/issues/01-a.md': '# 01 — a\n',
  });
  const root = readTree(dir);
  assert.equal(root.hiddenWorktrees, 0);
  assert.deepEqual(ticketPaths(snapshotOf(root)), ['nested/issues/01-a.md']);
});

// ---------------------------------------------------------------------------
// Siblings
// ---------------------------------------------------------------------------

test('schema-less siblings of every extension are links and are never parsed as Tickets', (t) => {
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-real.md': '# 01 — real\n',
    '.scratch/alpha/spec.md': '# spec\n',
    '.scratch/alpha/board.html': '<!doctype html><title>x</title>\n',
    '.scratch/alpha/run.sh': '#!/bin/sh\necho hi\n',
    '.scratch/alpha/03-notes.md': '# 03 — dropped here by a cwd-relative writer\n',
    '.scratch/alpha/notes/deep.md': '# deep\n',
  });

  const snapshot = snapshotOf(readTree(dir));
  assert.deepEqual(
    ticketPaths(snapshot),
    ['alpha/issues/01-real.md'],
    'only files under <feature>/issues/ are Tickets — a numbered .md beside the spec is not one',
  );

  const feature = snapshot.roots[0]?.features[0];
  assert.ok(feature !== undefined);
  assert.deepEqual(
    feature.siblings.map((link) => link.path).sort(),
    ['alpha/03-notes.md', 'alpha/board.html', 'alpha/notes/deep.md', 'alpha/run.sh', 'alpha/spec.md'],
    'every schema-less file in the Feature directory is carried as a link',
  );
  for (const link of feature.siblings) {
    assert.ok(link.absPath.length > 0, `${link.path} has no absolute path to copy`);
    assert.equal(link.label, link.path.split('/').pop());
  }
});

test('sibling text is supplied, so a changed sibling moves the Feature content hash', (t) => {
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-real.md': '# 01 — real\n',
    '.scratch/alpha/run.sh': '#!/bin/sh\necho one\n',
  });
  const before = snapshotOf(readTree(dir)).roots[0]?.features[0]?.contentSha;

  writeFileSync(join(dir, '.scratch', 'alpha', 'run.sh'), '#!/bin/sh\necho two\n', 'utf8');
  const after = snapshotOf(readTree(dir)).roots[0]?.features[0]?.contentSha;

  assert.ok(before !== undefined && after !== undefined);
  assert.notEqual(
    before,
    after,
    'a sibling changed and the Feature hash did not move — a Digest written against the old content would never expire (ADR-0003)',
  );
});

// ---------------------------------------------------------------------------
// What the walk skips
// ---------------------------------------------------------------------------

test('.git, .out-of-scope and node_modules are skipped; other dot-directories are not', (t) => {
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-real.md': '# 01 — real\n',
    '.scratch/.out-of-scope/issues/02-ruled-out.md': '# 02 — ruled out\n',
    '.scratch/node_modules/pkg/issues/04-dep.md': '# 04 — dep\n',
    '.scratch/alpha/.git/HEAD': 'ref: refs/heads/main\n',
    '.scratch/.notes/kept.md': '# kept\n',
  });
  const root = readTree(dir);
  assert.deepEqual(
    root.files.map((file) => file.path),
    ['.notes/kept.md', 'alpha/issues/01-real.md'],
    '.out-of-scope/ is out of scope by the spec and .git/node_modules are not tracker content, but no rule makes every dot-named directory disposable — silently dropping one would omit a Feature',
  );
  assert.deepEqual(snapshotOf(root).warnings, [], 'a documented skip is not an omission warning');
});

test('the skip list matches names exactly, so a differently-cased directory is kept', () => {
  // Driven through the fake because a real disk decides this for us: on a case-insensitive
  // file system `.GIT` and `.git` cannot both exist. Git writes its own marker lower-case
  // everywhere, so a directory spelled `.GIT` belongs to somebody, and case-folding the
  // comparison would drop a Feature without saying anything.
  const fs = fakeFs({
    '.scratch/.git/HEAD': { kind: 'file', text: 'ref: refs/heads/main\n' },
    '.scratch/.GIT/issues/01-mine.md': { kind: 'file', text: '# 01 — mine\n' },
  });
  const root = readTree(fakeBase(), { fs });
  assert.deepEqual(root.files.map((file) => file.path), ['.GIT/issues/01-mine.md']);
});

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

test('a name carrying a path separator cannot reclassify, collide, or vanish quietly', () => {
  // Legal on POSIX, impossible on Windows. `core/index.ts` reads a backslash as a separator,
  // so the raw name would arrive as the Ticket `alpha/issues/01.md` and take that identity
  // away from the real file. The percent-encoded spelling is included deliberately: encoding
  // the backslash instead of refusing it would map both names onto one path.
  const backslash = String.fromCharCode(92);
  const fs = fakeFs({
    '.scratch/alpha/issues/01.md': { kind: 'file', text: '# 01 — the real one\n' },
    [`.scratch/alpha${backslash}issues${backslash}01.md`]: { kind: 'file', text: '# not a Ticket\n' },
    [`.scratch/alpha/issues/02-a${backslash}b.md`]: { kind: 'file', text: '# raw\n' },
    '.scratch/alpha/issues/02-a%5Cb.md': { kind: 'file', text: '# already encoded\n' },
  });

  const root = readTree(fakeBase(), { fs });
  const snapshot = snapshotOf(root);

  assert.deepEqual(
    ticketPaths(snapshot),
    ['alpha/issues/01.md', 'alpha/issues/02-a%5Cb.md'],
    'a file whose name merely contains a separator character became a Ticket',
  );
  const cards = (snapshot.roots[0]?.features ?? []).flatMap((feature) => feature.tickets);
  assert.equal(
    new Set(cards.map((card) => card.id)).size,
    cards.length,
    'two cards share one id, so an Override on either would apply to both',
  );
  assert.equal(
    warningsOfKind(snapshot, 'read-error').length,
    2,
    'a refused entry is stated; dropping it silently would be the omission this module exists to avoid',
  );
});

// ---------------------------------------------------------------------------
// Reads are resilient
// ---------------------------------------------------------------------------

test('a file the walk will not read yields an unparsed card carrying its reason', (t) => {
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-small.md': '# 01 — small\n',
    '.scratch/alpha/issues/02-huge.md': `# 02 — huge\n${'x'.repeat(400)}\n`,
  });

  const snapshot = snapshotOf(readTree(dir, { maxFileBytes: 64 }));
  const tickets = snapshot.roots[0]?.features[0]?.tickets ?? [];
  assert.equal(tickets.length, 2, 'the walk stopped on the file it could not read');

  const huge = tickets.find((ticket) => ticket.path.endsWith('02-huge.md'));
  assert.ok(huge !== undefined);
  assert.equal(huge.derivation.state, 'unparsed');
  assert.equal(huge.contentSha, null);
  assert.match(huge.readError ?? '', /above the 64-byte read limit/);
  assert.equal(huge.fileName, '02-huge.md', 'an unparsed card shows its raw filename');

  const small = tickets.find((ticket) => ticket.path.endsWith('01-small.md'));
  assert.ok(small !== undefined);
  assert.equal(small.readError, null, 'the readable file beside it was read');
});

test('the read limit binds on the read itself, not only on a look beforehand', () => {
  // A file that grows between the size check and the read is the shape this guards: the
  // fake reports a small size and then hands back a large body, exactly as an appended-to
  // log would. The limit has to hold on what actually enters the Snapshot.
  const fs = fakeFs({
    '.scratch/alpha/issues/01-grows.md': {
      kind: 'file',
      text: `# 01\n${'x'.repeat(4000)}`,
      reportedSize: 8,
    },
  });

  const ticket = snapshotOf(readTree(fakeBase(), { fs, maxFileBytes: 16 })).roots[0]
    ?.features[0]?.tickets[0];
  assert.ok(ticket !== undefined);
  assert.equal(ticket.contentSha, null, 'a file larger than the limit was read whole anyway');
  assert.match(ticket.readError ?? '', /read limit/);
});

test('a read that fails at the file system yields an unparsed card and the walk completes', () => {
  const fs = fakeFs({
    '.scratch/alpha/issues/01-locked.md': { kind: 'file', text: '# 01\n', error: { message: 'permission denied', code: 'EACCES' } },
    '.scratch/alpha/issues/02-fine.md': { kind: 'file', text: '# 02 — fine\n' },
  });

  const snapshot = snapshotOf(readTree(fakeBase(), { fs }));
  const tickets = snapshot.roots[0]?.features[0]?.tickets ?? [];
  assert.equal(tickets.length, 2, 'one unreadable file took the rest of the Feature with it');

  const locked = tickets.find((ticket) => ticket.path.endsWith('01-locked.md'));
  assert.ok(locked !== undefined);
  assert.equal(locked.derivation.state, 'unparsed');
  assert.match(locked.readError ?? '', /permission denied/);
});

test('a Root with no tracker directory is an empty board, not an error', (t) => {
  const dir = tempTree(t, { 'README.md': '# nothing tracked here\n' });
  const root = readTree(dir);
  assert.deepEqual(root.files, []);
  assert.deepEqual(root.unreadableDirs, [], 'an absent tracker directory is not an omission');
  assert.deepEqual(snapshotOf(root).roots[0]?.features, []);
});

test('a path that does not exist at all walks without throwing', (t) => {
  // The missing directory is a child of a tree this test owns, so it is genuinely absent
  // rather than merely expected to be. A fixed name under the system temp directory could
  // already exist, and the test would then pass without exercising anything.
  const parent = tempTree(t, { 'placeholder.md': '# placeholder\n' });
  const root = readTree(join(parent, 'no-such-root'));
  assert.deepEqual(root.files, []);
  assert.equal(root.tracker, 'local-markdown');
  assert.equal(snapshotOf(root).warnings.length, 0);
});

test('readTree never throws on its own arguments, however they arrive', () => {
  // Type stripping erases without checking, so a caller can hand this anything. `resolve`
  // throws on a non-string, and that would break the contract before the walk even starts.
  const badOptions: ReadTreeOptions = JSON.parse('{"trackerPath":7,"maxDepth":"deep"}');
  const notAnObject: ReadTreeOptions = JSON.parse('null');

  for (const [label, run] of [
    ['a numeric tracker path', () => readTree('.', badOptions)],
    ['a null options value', () => readTree('.', notAnObject)],
    ['a non-string root path', () => readTree(JSON.parse('7'))],
    ['an empty root path', () => readTree('')],
    ['a port that is not one', () => readTree('.', JSON.parse('{"fs":{}}'))],
  ] as const) {
    const root = run();
    assert.equal(typeof root.path, 'string', `${label} did not produce a Root`);
    assert.ok(Array.isArray(root.files), `${label} produced a Root with no file list`);
  }

  const refused = readTree(JSON.parse('7'));
  assert.deepEqual(refused.files, []);
  assert.equal(
    warningsOfKind(snapshotOf(refused), 'read-error').length,
    1,
    'a Root that could not be read at all must say so rather than render as empty',
  );
});

test('a file system that fails every call still yields a Root rather than an exception', () => {
  const angry = (): never => {
    throw new Error('the disk went away');
  };
  const fs: ReadTreeFs = {
    listDir: angry,
    kindOf: angry,
    sizeOf: angry,
    readFile: angry,
    realPath: angry,
  };

  const root = readTree(fakeBase(), { fs });
  assert.deepEqual(root.files, []);
  assert.equal(root.tracker, 'local-markdown', 'a Root that could not be classified shows the board');
  assert.deepEqual(root.adrFiles, []);
  assert.equal(root.glossaryFile, null);

  const warnings = warningsOfKind(snapshotOf(root), 'read-error');
  assert.equal(
    warnings.length,
    2,
    'a walk that could not run at all must still say so — once for the tracker directory and once for the ADRs',
  );
  for (const warning of warnings) assert.match(warning.message, /the disk went away/);
});

// ---------------------------------------------------------------------------
// Directories whose contents go missing
// ---------------------------------------------------------------------------

test('a tracker path that is not a directory is stated as a read-error', (t) => {
  const dir = tempTree(t, { 'notes.md': '# not a directory\n' });
  const root = readTree(dir, { trackerPath: 'notes.md' });

  assert.deepEqual(root.files, []);
  assert.equal(root.unreadableDirs?.length, 1);

  const warnings = warningsOfKind(snapshotOf(root), 'read-error');
  assert.equal(warnings.length, 1, 'a tracker directory that could not be listed rendered as an empty board');
  assert.match(warnings[0]?.message ?? '', /could not be listed/);
});

test('an unlistable directory is stated and the Features beside it still scan', () => {
  const fs = fakeFs({
    '.scratch/alpha/issues/01-fine.md': { kind: 'file', text: '# 01 — fine\n' },
    '.scratch/beta/issues': { kind: 'dir', error: { message: 'permission denied', code: 'EACCES' } },
    '.scratch/beta/spec.md': { kind: 'file', text: '# beta\n' },
  });

  const root = readTree(fakeBase(), { fs });
  const snapshot = snapshotOf(root);

  assert.deepEqual(
    ticketPaths(snapshot),
    ['alpha/issues/01-fine.md'],
    'the walk halted on the directory it could not list',
  );
  const warnings = warningsOfKind(snapshot, 'read-error');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? '', /beta\/issues/);
  assert.match(warnings[0]?.message ?? '', /permission denied/);
  assert.equal(
    snapshot.roots[0]?.features.length,
    2,
    'beta still renders — the Feature exists, only the contents of one directory are missing',
  );
});

test('a directory that vanishes below the tracker root is stated, not silently erased', () => {
  // The parent listed `alpha` a moment ago; by the time the walk descends it has been
  // renamed. Its Tickets are missing from *this* scan, and silence would read exactly like
  // a Feature that never existed.
  const fs = fakeFs({
    '.scratch/alpha': { kind: 'dir', error: { message: 'ENOENT: no such file or directory', code: 'ENOENT' } },
    '.scratch/beta/issues/01-fine.md': { kind: 'file', text: '# 01 — fine\n' },
  });

  const snapshot = snapshotOf(readTree(fakeBase(), { fs }));
  assert.deepEqual(ticketPaths(snapshot), ['beta/issues/01-fine.md']);
  const warnings = warningsOfKind(snapshot, 'read-error');
  assert.equal(warnings.length, 1, 'a directory that disappeared mid-walk took its Tickets with it silently');
  assert.match(warnings[0]?.message ?? '', /alpha/);
});

test('an absent tracker directory is the one absence that is not stated', () => {
  const fs = fakeFs({ 'docs/adr/0001-x.md': { kind: 'file', text: '# 0001 — x\n' } });
  const root = readTree(fakeBase(), { fs });
  assert.deepEqual(root.files, []);
  assert.deepEqual(root.unreadableDirs, [], 'a repo with no .scratch/ is an empty board, not an omission');
});

test('a malformed unreadableDirs says so instead of hiding the omissions in it', () => {
  // Type stripping erases and does not check, so the seam guards this the same way it
  // guards `scan.roots` and `Root.files`: a corrupt container must never render identically
  // to a Root that omitted nothing.
  const badShape: Scan = JSON.parse(
    '{"roots":[{"path":"/r","files":[],"unreadableDirs":{"0":{"path":"a","error":"b"}}}]}',
  );
  assert.ok(
    deriveSnapshot(badShape, EMPTY_ANNOTATIONS).warnings.some((warning) =>
      warning.message.includes('Root.unreadableDirs was not a list'),
    ),
    'an object-valued unreadableDirs swallowed every omission without saying so',
  );

  const badEntries: Scan = JSON.parse(
    '{"roots":[{"path":"/r","files":[],"unreadableDirs":[{},{"path":7,"error":null}]}]}',
  );
  const warnings = deriveSnapshot(badEntries, EMPTY_ANNOTATIONS).warnings.filter(
    (warning) => warning.kind === 'read-error',
  );
  assert.equal(warnings.length, 2, 'an entry with no usable fields is still an omission');
  for (const warning of warnings) assert.match(warning.message, /a directory could not be listed/);
});

test('nesting past the depth limit is stated rather than silently truncated', (t) => {
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-fine.md': '# 01 — fine\n',
    '.scratch/alpha/deep/deeper/deepest/02-lost.md': '# 02 — lost\n',
  });

  const root = readTree(dir, { maxDepth: 2 });
  assert.ok(
    !root.files.some((file) => file.path.includes('deepest')),
    'the depth limit did not apply',
  );
  const warnings = warningsOfKind(snapshotOf(root), 'read-error');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? '', /alpha\/deep\/deeper/);
});

test('a walk truncated by the file cap says so, and stops traversing', (t) => {
  const dir = tempTree(t, {
    '.scratch/alpha/issues/01-a.md': '# 01\n',
    '.scratch/alpha/issues/02-b.md': '# 02\n',
    '.scratch/alpha/issues/03-c.md': '# 03\n',
  });

  const root = readTree(dir, { maxFiles: 2 });
  assert.equal(root.files.length, 2);
  const warnings = warningsOfKind(snapshotOf(root), 'read-error');
  assert.equal(warnings.length, 1, 'a truncated walk that says nothing looks like a smaller tracker');
  assert.match(warnings[0]?.message ?? '', /stopped after 2 files/);

  // The cap has to bound the *work*, not only the output. A walk that keeps listing every
  // remaining directory after it stops collecting still wedges a watcher that re-scans on
  // every change, which is the only reason the cap exists.
  const listed: string[] = [];
  const counting = fakeFs({
    '.scratch/aaa/issues/01-a.md': { kind: 'file', text: '# 01\n' },
    '.scratch/zzz/issues/02-b.md': { kind: 'file', text: '# 02\n' },
  });
  const observed: ReadTreeFs = {
    ...counting,
    listDir(dirPath) {
      listed.push(dirPath);
      return counting.listDir(dirPath);
    },
  };
  readTree(fakeBase(), { fs: observed, maxFiles: 1 });
  assert.ok(
    !listed.some((path) => path.includes('zzz')),
    `the walk kept listing directories after truncating: ${listed.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// Symbolic links
// ---------------------------------------------------------------------------

test('a symbolic link to a directory is not followed, and the omission is stated', () => {
  const fs = fakeFs({
    '.scratch/alpha/issues/01-fine.md': { kind: 'file', text: '# 01 — fine\n' },
    '.scratch/alpha/mirror': { kind: 'link', target: '.scratch/alpha/issues' },
  });

  const root = readTree(fakeBase(), { fs });
  assert.deepEqual(
    root.files.map((file) => file.path),
    ['alpha/issues/01-fine.md'],
    'following the link would give the same Ticket a second identity',
  );
  const warnings = warningsOfKind(snapshotOf(root), 'read-error');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? '', /alpha\/mirror/);
});

test('an alias sorted before the real directory does not steal its Tickets', () => {
  // `0alias` sorts before `issues`. Following it would emit `alpha/0alias/01-a.md`, which
  // `core/index.ts` classifies as a sibling link rather than a Ticket — and the real
  // `issues/` directory would then be skipped as already visited. The corpus count would
  // move and the board would still render.
  const fs = fakeFs({
    '.scratch/alpha/0alias': { kind: 'link', target: '.scratch/alpha/issues' },
    '.scratch/alpha/issues/01-a.md': { kind: 'file', text: '# 01 — a\n' },
  });

  const snapshot = snapshotOf(readTree(fakeBase(), { fs }));
  assert.deepEqual(
    ticketPaths(snapshot),
    ['alpha/issues/01-a.md'],
    'an alias that sorts first took the Ticket identity away from the real directory',
  );
});

test('a link cycle terminates, and a link to a file is read like any other file', () => {
  const fs = fakeFs({
    '.scratch/alpha/issues/01-a.md': { kind: 'file', text: '# 01 — a\n' },
    '.scratch/alpha/loop': { kind: 'link', target: '.scratch' },
    '.scratch/alpha/spec.md': { kind: 'link', target: '.scratch/alpha/issues/01-a.md' },
  });

  const root = readTree(fakeBase(), { fs });
  assert.deepEqual(root.files.map((file) => file.path), [
    'alpha/issues/01-a.md',
    'alpha/spec.md',
  ]);
  assert.equal(
    root.files.find((file) => file.path === 'alpha/spec.md')?.text,
    '# 01 — a\n',
    'a symbolic link to a file must be read through',
  );
});

test('a link the walk cannot resolve becomes an unparsed card, not a silent absence', () => {
  const fs = fakeFs({
    '.scratch/alpha/issues/01-broken.md': { kind: 'link', target: '.scratch/nowhere', targetError: 'EACCES' },
  });

  const ticket = snapshotOf(readTree(fakeBase(), { fs })).roots[0]?.features[0]?.tickets[0];
  assert.ok(ticket !== undefined, 'a link that could not be looked at simply disappeared');
  assert.equal(ticket.derivation.state, 'unparsed');
  assert.match(ticket.readError ?? '', /could not be resolved/);
});

test('a link out of the tracker directory is represented but never read', () => {
  // The route a credential actually takes: a link in the tracker directory pointing at
  // `.git/config`, whose remote URL routinely carries a token. Following it would read the
  // whole file into `Root.files[].text`, and from there its fields become card content on a
  // web page. The entry is still shown; it simply has no contents.
  const secret = 'n0t-a-real-token-51ab90';
  const fs = fakeFs({
    '.git/config': {
      kind: 'file',
      text: `[remote "origin"]\n\turl = ${webRemote(['x:', secret, REMOTE_AT, 'github.com/o/r.git'].join(''))}\n`,
    },
    '.scratch/alpha/issues/01-fine.md': { kind: 'file', text: '# 01 — fine\n' },
    '.scratch/alpha/issues/02-escape.md': { kind: 'link', target: '.git/config' },
  });

  const root = readTree(fakeBase(), { fs });
  const snapshot = snapshotOf(root);

  assert.ok(
    !JSON.stringify(root).includes(secret) && !JSON.stringify(snapshot).includes(secret),
    'a link reached out of the tracker directory and pulled a credential onto the board',
  );
  const escaped = (snapshot.roots[0]?.features[0]?.tickets ?? []).find((card) =>
    card.path.endsWith('02-escape.md'),
  );
  assert.ok(escaped !== undefined, 'the entry was dropped rather than represented');
  assert.equal(escaped.derivation.state, 'unparsed');
  assert.match(escaped.readError ?? '', /outside the tracker directory/);
});

test('an ADR or glossary link out of the Root is represented but never read', () => {
  const secret = 'n0t-a-real-token-6cd3f2';
  const fs = fakeFs({
    'repo/.scratch/alpha/issues/01-a.md': { kind: 'file', text: '# 01 — a\n' },
    'repo/docs/adr/0001-linked.md': { kind: 'link', target: 'outside/secrets.md' },
    'repo/CONTEXT.md': { kind: 'link', target: 'outside/secrets.md' },
    'outside/secrets.md': { kind: 'file', text: `token ${secret}\n` },
  });

  const root = readTree(join(fakeBase(), 'repo'), { fs });
  assert.ok(!JSON.stringify(root).includes(secret), 'a linked ADR or glossary read outside the Root');
  assert.equal(root.adrFiles[0]?.text, null);
  assert.match(root.adrFiles[0]?.readError ?? '', /outside the Root/);
  assert.equal(root.glossaryFile?.text, null);
});

test('a dangling link holds no content and is not reported as an omission', () => {
  const fs = fakeFs({
    '.scratch/alpha/issues/01-a.md': { kind: 'file', text: '# 01 — a\n' },
    '.scratch/alpha/issues/02-gone.md': { kind: 'link', target: '.scratch/nowhere' },
  });
  const root = readTree(fakeBase(), { fs });
  assert.deepEqual(root.files.map((file) => file.path), ['alpha/issues/01-a.md']);
  assert.deepEqual(root.unreadableDirs, []);
});

// ---------------------------------------------------------------------------
// Tracker detection
// ---------------------------------------------------------------------------

test('an empty tracker on a GitHub remote is detected and flagged', (t) => {
  const dir = tempTree(t, {
    '.git/config': `[remote "origin"]\n\turl = ${scpRemote('git', 'github.com:owner/repo.git')}\n`,
  });
  const root = readTree(dir);
  assert.equal(root.tracker, 'github');

  const warnings = warningsOfKind(snapshotOf(root), 'unsupported-tracker');
  assert.equal(warnings.length, 1, 'an unsupported tracker must state itself, not render as an empty board');
});

test('an empty tracker on a GitLab remote is detected and flagged', (t) => {
  const dir = tempTree(t, {
    '.git/config': `[remote "origin"]\n\turl = ${webRemote('gitlab.com/owner/repo.git')}\n`,
  });
  assert.equal(readTree(dir).tracker, 'gitlab');
});

test('local markdown wins over the remote host whenever there is any tracker content', (t) => {
  // A very common shape: hosted on GitHub *and* keeping its tracker in local markdown at the
  // same time. Ranking the remote first badges such a repository unsupported and renders a
  // warning over a tracker that is sitting right there.
  const dir = tempTree(t, {
    '.git/config': `[remote "origin"]\n\turl = ${webRemote('github.com/owner/repo.git')}\n`,
    '.scratch/alpha/issues/01-a.md': '# 01 — a\n',
  });
  const root = readTree(dir);
  assert.equal(root.tracker, 'local-markdown', 'a GitHub remote outranked a tracker that is present');
  assert.deepEqual(warningsOfKind(snapshotOf(root), 'unsupported-tracker'), []);
});

test('remote URL spellings git actually writes are all read', (t) => {
  const forms: readonly (readonly [string, string])[] = [
    [scpRemote('git', 'github.com:owner/repo.git'), 'github'],
    [webRemote('github.com/owner/repo.git'), 'github'],
    [sshRemote('git', 'github.com/owner/repo.git'), 'github'],
    [`"${webRemote('github.com/owner/repo.git')}"`, 'github'],
    [`"${scpRemote('git', 'github.com:owner/repo.git')}"`, 'github'],
    [webRemote(['a-user:n0t-a-real-token', REMOTE_AT, 'github.com/owner/repo.git'].join('')), 'github'],
    [webRemote(['user', REMOTE_AT, 'gitlab.example.com:8443/owner/repo.git'].join('')), 'gitlab'],
    [scpRemote('git', 'gitlab.com:owner/repo.git'), 'gitlab'],
    [webRemote('bitbucket.org/owner/repo.git'), 'local-markdown'],
    ['../a-local-clone', 'local-markdown'],
    [['', 'srv', 'git', 'repo.git'].join('/'), 'local-markdown'],
  ];
  for (const [url, expected] of forms) {
    const dir = tempTree(t, { '.git/config': `[remote "origin"]\n\turl = ${url}\n` });
    assert.equal(readTree(dir).tracker, expected, `remote URL ${url}`);
  }
});

test('a credential embedded in a remote URL never reaches the Root or the Snapshot', (t) => {
  // A git remote URL routinely carries a token, and the board is a web page: a warning that
  // quoted the URL would put the token on screen and into anything that copies the Snapshot.
  // The strings below are synthetic and are the point of the test — the assertion is that
  // neither of them survives detection.
  const secret = 'n0t-a-real-token-2f9c1e';
  const user = 'a-user-name-that-is-not-real';
  const dir = tempTree(t, {
    '.git/config': `[remote "origin"]\n\turl = ${webRemote([user, ':', secret, REMOTE_AT, 'github.com/owner/repo.git'].join(''))}\n`,
  });

  const root = readTree(dir);
  assert.equal(root.tracker, 'github', 'the host is still read out of a credentialed URL');

  const snapshot = snapshotOf(root);
  assert.equal(warningsOfKind(snapshot, 'unsupported-tracker').length, 1);

  for (const [label, subject] of [
    ['the Root', JSON.stringify(root)],
    ['the Snapshot', JSON.stringify(snapshot)],
  ] as const) {
    assert.ok(!subject.includes(secret), `the credential reached ${label}`);
    assert.ok(!subject.includes(user), `the user name reached ${label}`);
    assert.ok(!subject.includes('github.com/owner/repo'), `the remote URL reached ${label}`);
  }
});

test('a git config that cannot be parsed is not detected, and is never quoted back', (t) => {
  const secret = 'n0t-a-real-token-7b41da';
  const dir = tempTree(t, {
    // The section header never closes, so this is not a section git would honour. Reading a
    // tracker out of it would be a confident answer taken from a file that does not parse.
    '.git/config': `[remote "origin"\n\turl = ${webRemote(['x:', secret, REMOTE_AT, 'github.com/owner/repo.git'].join(''))}\n`,
  });

  const root = readTree(dir);
  const snapshot = snapshotOf(root);
  assert.equal(root.tracker, 'local-markdown', 'a malformed section was read as a valid remote');
  assert.deepEqual(warningsOfKind(snapshot, 'unsupported-tracker'), []);
  assert.ok(
    !JSON.stringify(root).includes(secret) && !JSON.stringify(snapshot).includes(secret),
    'an unparsable config was quoted into a message, taking a credential with it',
  );
});

test('origin is preferred over other remotes, and a repo with no remote is not flagged', (t) => {
  const withUpstream = tempTree(t, {
    '.git/config':
      `[remote "upstream"]\n\turl = ${webRemote('gitlab.com/other/repo.git')}\n` +
      `[remote "origin"]\n\turl = ${webRemote('github.com/owner/repo.git')}\n`,
  });
  assert.equal(readTree(withUpstream).tracker, 'github');

  const noRemote = tempTree(t, { '.git/config': '[core]\n\tbare = false\n' });
  assert.equal(readTree(noRemote).tracker, 'local-markdown');

  const noGit = tempTree(t, { 'README.md': '# no git here\n' });
  assert.equal(readTree(noGit).tracker, 'local-markdown');
});

test('a Root that is itself a worktree reads its remotes from the common directory', (t) => {
  const dir = tempTree(t, {
    'main/.git/config': `[remote "origin"]\n\turl = ${scpRemote('git', 'github.com:owner/repo.git')}\n`,
    'main/.git/worktrees/feature/commondir': '../..\n',
    'work/.git': 'gitdir: ../main/.git/worktrees/feature\n',
  });
  assert.equal(
    readTree(join(dir, 'work')).tracker,
    'github',
    'a worktree Root has no config of its own; the remotes live in the common directory',
  );
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test('the label defaults to the Root directory name and can be overridden', (t) => {
  const dir = tempTree(t, { '.scratch/alpha/issues/01-a.md': '# 01 — a\n' });
  assert.equal(readTree(dir).label, dir.split(/[\\/]/).pop());
  assert.equal(readTree(dir, { label: 'my board' }).label, 'my board');
});

// ---------------------------------------------------------------------------
// Card identity across Roots
//
// This exercises `deriveSnapshot`, not the walk, so it belongs with the seam tests. It lives
// here only because that file has another owner while this wave is in flight.
// ---------------------------------------------------------------------------

test('two Roots cannot collapse onto one card id, however their paths are punctuated', () => {
  // A card id joins a Root path to a Root-relative path. A bare separator is not injective:
  // Root `/a#b` with `c/…` and Root `/a` with `b#c/…` both spell `/a#b#c/…`. The two Roots
  // then share one identity, so a single Override applies to both — which is the exact
  // failure the Root prefix was introduced to prevent, reappearing in the shape chosen to
  // express it. `#` is a legal character in a directory name on every platform the board runs
  // on, so this needs no unusual input at all.
  const text = '# 01 — Shared title\n\n**Status:** open\n';
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');

  const scan: Scan = {
    roots: [
      rootWith('/a#b', 'c/issues/01-one.md', text),
      rootWith('/a', 'b#c/issues/01-one.md', text),
    ],
  };

  const cards = snapshotCards(deriveSnapshot(scan, EMPTY_ANNOTATIONS));
  assert.equal(cards.length, 2);
  assert.notEqual(
    cards[0]?.id,
    cards[1]?.id,
    'two Roots produced one card id, so blocker navigation, Override identity and the DOM anchor all address the wrong card',
  );

  // The consequence, asserted where it actually bites: an Override written against one Root
  // must not be applied to the other.
  const override: AnnotationStore = {
    schemaVersion: 1,
    entries: [
      { schemaVersion: 1, filePath: cards[0]?.id ?? '', contentSha: sha, extraction: { title: 'Corrected' } },
    ],
  };
  const applied = deriveSnapshot(scan, override);
  assert.equal(
    applied.overrides.applied,
    1,
    'one Override was applied to two cards — the two Roots share an Annotation identity',
  );
  const corrected = snapshotCards(applied).filter(
    (card) => card.derivation.correctedFields.length > 0,
  );
  assert.deepEqual(
    corrected.map((card) => card.path),
    ['c/issues/01-one.md'],
    'the Override landed on the wrong Root',
  );
});

test('a card id still identifies its Root and path unambiguously', () => {
  // The id is also the DOM anchor, so it stays
  // printable — no control characters, no NUL — and it still contains both halves verbatim.
  const scan: Scan = { roots: [rootWith('/repo', 'alpha/issues/01-a.md', '# 01 — A\n')] };
  const id = snapshotCards(deriveSnapshot(scan, EMPTY_ANNOTATIONS))[0]?.id ?? '';

  assert.ok(id.includes('/repo'), 'the id no longer names its Root');
  assert.ok(id.includes('alpha/issues/01-a.md'), 'the id no longer names its path');
  assert.ok(
    [...id].every((char) => (char.codePointAt(0) ?? 0) >= 0x20),
    'the id carries a control character and cannot anchor a DOM node',
  );
});

function rootWith(rootPath: string, relPath: string, text: string): Root {
  return {
    path: rootPath,
    label: rootPath,
    trackerPath: `${rootPath}/.scratch`,
    files: [{ path: relPath, absPath: `${rootPath}/.scratch/${relPath}`, text }],
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
}

function snapshotCards(snapshot: Snapshot): readonly TicketCard[] {
  return snapshot.roots.flatMap((root) => root.features.flatMap((feature) => feature.tickets));
}

// ---------------------------------------------------------------------------
// Temporary trees
// ---------------------------------------------------------------------------

interface Cleanup {
  after(fn: () => void): void;
}

/** Build a temporary tree from `relative/path` → contents, and remove it after the test. */
function tempTree(t: Cleanup, spec: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-board-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [relPath, contents] of Object.entries(spec)) {
    const abs = join(dir, ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// The fake file system
// ---------------------------------------------------------------------------

interface FakeNode {
  readonly kind: 'file' | 'dir' | 'link';
  readonly text?: string;
  /** For `kind: 'link'`, the node it points at, relative to the fake Root. */
  readonly target?: string;
  /** Makes resolving the link itself fail, as a permission error on the target would. */
  readonly targetError?: string;
  /** Thrown by `listDir` on a directory, or by `readFile` on a file. */
  readonly error?: { readonly message: string; readonly code?: string };
  /** What `sizeOf` reports, when that must disagree with the real length. */
  readonly reportedSize?: number;
}

/** An absolute base that survives `path.resolve` on every platform. */
function fakeBase(): string {
  return resolve('/tracker-board-fake');
}

function fakePosix(path: string): string {
  const slashes = path.split('\\').join('/');
  return slashes.length > 1 && slashes.endsWith('/') ? slashes.slice(0, -1) : slashes;
}

/**
 * A file system built from `relative/path` → node. Directories are implied by their
 * children, so only a directory that needs an `error` has to be declared.
 *
 * Links are modelled the way a real one behaves: `listDir` reports the entry as a link, and
 * `kindOf`, `sizeOf` and `readFile` all resolve **through** the target. A fake whose links
 * were inert would let a cycle test pass with the production guard deleted.
 */
function fakeFs(spec: Readonly<Record<string, FakeNode>>): ReadTreeFs {
  const base = fakePosix(fakeBase());
  const nodes = new Map<string, FakeNode>();
  for (const [relPath, node] of Object.entries(spec)) {
    const full = `${base}/${relPath}`;
    nodes.set(full, node);
    let parent = full.slice(0, full.lastIndexOf('/'));
    while (parent.length >= base.length) {
      if (!nodes.has(parent)) nodes.set(parent, { kind: 'dir' });
      const cut = parent.lastIndexOf('/');
      if (cut < 0) break;
      parent = parent.slice(0, cut);
    }
  }

  const fail = (node: FakeNode): Error =>
    Object.assign(new Error(node.error?.message ?? 'failed'), { code: node.error?.code ?? 'EIO' });
  const missing = (path: string): Error =>
    Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), { code: 'ENOENT' });

  /** Follow links to the node they name. `'error'` when the link itself cannot be resolved. */
  const resolveNode = (path: string): FakeNode | 'error' | undefined => {
    let current = nodes.get(fakePosix(path));
    let hops = 0;
    while (current?.kind === 'link' && hops < 8) {
      if (current.targetError !== undefined) return 'error';
      current = nodes.get(`${base}/${current.target ?? ''}`);
      hops += 1;
    }
    return current;
  };

  const canonical = (path: string): string => {
    let key = fakePosix(path);
    let hops = 0;
    while (nodes.get(key)?.kind === 'link' && hops < 8) {
      key = `${base}/${nodes.get(key)?.target ?? ''}`;
      hops += 1;
    }
    return key;
  };

  return {
    listDir(dirPath) {
      const key = canonical(dirPath);
      const node = nodes.get(key);
      if (node === undefined || node.kind !== 'dir') throw missing(dirPath);
      if (node.error !== undefined) throw fail(node);
      const prefix = `${key}/`;
      const found: DirEntry[] = [];
      for (const [path, child] of nodes) {
        if (!path.startsWith(prefix)) continue;
        if (path.slice(prefix.length).includes('/')) continue;
        found.push({ name: path.slice(prefix.length), kind: child.kind });
      }
      return found.sort((left, right) => (left.name < right.name ? -1 : 1));
    },
    kindOf(path): PathKind {
      const node = resolveNode(path);
      if (node === 'error') return 'error';
      if (node === undefined) return 'missing';
      return node.kind === 'dir' ? 'dir' : 'file';
    },
    sizeOf(path) {
      const node = resolveNode(path);
      if (node === 'error' || node === undefined) return null;
      if (node.reportedSize !== undefined) return node.reportedSize;
      return node.text === undefined ? null : node.text.length;
    },
    readFile(path, maxBytes) {
      const node = resolveNode(path);
      if (node === 'error' || node === undefined || node.kind === 'dir') throw missing(path);
      if (node.error !== undefined) throw fail(node);
      const text = node.text ?? '';
      // The real port measures and reads through one handle, so the limit binds on the read.
      if (text.length > maxBytes) {
        throw new Error(`file is ${text.length} bytes, above the ${maxBytes}-byte read limit`);
      }
      return text;
    },
    realPath(path) {
      return canonical(path);
    },
  };
}
