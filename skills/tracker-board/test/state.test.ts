/**
 * The state files, integration-tested against a temporary directory.
 *
 * This is the one module in the skill that touches a disk on purpose, so it is tested the
 * way the tree walk is: real files, real degradations, and never the real home directory.
 * Every test points `state/store.ts` at a directory it created and removes it afterwards —
 * nothing here writes into the repo, and nothing here writes into the real state directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS } from './harness.ts';
import {
  ANNOTATIONS_FILE,
  SNAPSHOT_FILE,
  STATE_DIR_NAME,
  STATE_SCHEMA_VERSION,
  isInside,
  readState,
  stateDir,
  stateIsOutside,
  writeAnnotations,
  writeSnapshot,
} from '../state/store.ts';
import type { AnnotationStore } from '../core/types.ts';

const SKILL_DIR = join(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// Where state lives — outside every watched Root
// ---------------------------------------------------------------------------

test('state resolves under the home directory, not inside a watched Root', (t) => {
  const dir = temporaryDir(t);

  assert.equal(
    stateDir(),
    join(homedir(), STATE_DIR_NAME),
    'state lives under the home directory so the board never pollutes a tree it observes',
  );
  assert.equal(
    isInside(stateDir(), SKILL_DIR),
    false,
    'the default state directory sits inside the repo this test runs in — the board would be writing into a tree it watches',
  );
  assert.equal(isInside(stateDir(), dir), false);
});

test('a write lands in the directory it was given and nowhere else', (t) => {
  const dir = temporaryDir(t);
  const written = writeAnnotations(EMPTY_ANNOTATIONS, dir);

  assert.equal(written.written, true);
  assert.equal(written.problem, null);
  assert.equal(written.file, join(dir, ANNOTATIONS_FILE));
  assert.equal(isInside(written.file, dir), true);
  assert.equal(isInside(written.file, SKILL_DIR), false, 'a write escaped into the watched repo');
  assert.equal(isInside(written.file, stateDir()), false, 'the override was ignored and the real home was written to');

  assert.deepEqual(
    readdirSync(dir).sort(),
    [ANNOTATIONS_FILE],
    'the write is a rename into place, so no temporary file may survive it',
  );
});

test('state directories and files are private on POSIX', { skip: process.platform === 'win32' }, (t) => {
  const dir = temporaryDir(t);
  chmodSync(dir, 0o777);
  assert.equal(writeAnnotations(EMPTY_ANNOTATIONS, dir).written, true);
  assert.equal(writeSnapshot(deriveSnapshot({ roots: [] }, EMPTY_ANNOTATIONS), dir).written, true);

  assert.equal(statSync(dir).mode & 0o777, 0o700, 'a pre-existing permissive state directory stayed public');
  assert.equal(statSync(join(dir, ANNOTATIONS_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, SNAPSHOT_FILE)).mode & 0o777, 0o600);
});

test('the state directory is outside ordinary Roots, and says so when it is not', (t) => {
  // The default state directory is outside every ordinary Root — but not outside a Root
  // that *is* the home directory, and this module cannot know which Roots exist. Roots also
  // accrete, so the answer can change after startup. The claim is therefore exported rather
  // than assumed: whoever registers a Root has to ask, and a write that is handed its Roots
  // refuses rather than relocating.
  const dir = temporaryDir(t);

  assert.equal(stateIsOutside([SKILL_DIR, dir, join(dir, 'nested')]), true);
  assert.equal(
    stateIsOutside([homedir()]),
    false,
    'a Root that is the home directory does contain the state directory, and pretending otherwise is how state ends up inside a watched tree',
  );
  assert.equal(stateIsOutside([], dir), true);
  assert.equal(
    stateIsOutside([join(dir, 'watched')], dir),
    true,
    'an alternate directory is the way out, as long as it is not itself inside a Root',
  );
  // Worth stating rather than leaving as a trap: on Windows the temporary directory lives
  // *inside* the home directory, so pointing the override at a temp directory does not by
  // itself escape a Root that is the home directory. Only asking gets a true answer.
  assert.equal(stateIsOutside([homedir()], dir), !isInside(dir, homedir()));
});

test('a write into a watched Root is refused, not relocated and not written', (t) => {
  const dir = temporaryDir(t);
  const watched = join(dir, 'watched');
  const inside = join(watched, '.tracker-board');

  const refused = writeAnnotations(EMPTY_ANNOTATIONS, inside, [watched]);
  assert.equal(refused.written, false);
  assert.equal(refused.problem?.kind, 'inside-root');
  assert.equal(
    readdirSync(dir).includes('watched'),
    false,
    'refusing has to mean writing nothing — the directory was created anyway',
  );

  const refusedSnapshot = writeSnapshot(deriveSnapshot({ roots: [] }, EMPTY_ANNOTATIONS), inside, [watched]);
  assert.equal(refusedSnapshot.written, false);
  assert.equal(refusedSnapshot.problem?.kind, 'inside-root');

  // Relocating instead of refusing would put the board's memory somewhere the user never
  // chose; the next run would read an empty store and regenerate everything, which looks
  // exactly like the AI layer having written nothing.
  assert.equal(
    readState(inside).problems.every((problem) => problem.kind === 'absent'),
    true,
    'nothing was written anywhere, so the read finds nothing rather than finding it elsewhere',
  );

  // The same directory, with no Roots declared, still writes. The wall is the question
  // being asked, not the directory being blessed.
  assert.equal(writeAnnotations(EMPTY_ANNOTATIONS, inside).written, true);
  assert.equal(writeAnnotations(EMPTY_ANNOTATIONS, inside, [join(dir, 'elsewhere')]).written, true);
});

test('containment sees through a symlinked boundary on both sides', (t) => {
  // `resolve` normalises `.` and `..` and nothing else, so a symlinked boundary compares
  // unequal and containment answers "outside" — the dangerous direction, because that
  // answer decides whether state may be written somewhere. The temporary directory is
  // exactly such a boundary on macOS, where the reported and real-path prefixes differ.
  const dir = temporaryDir(t);
  const real = join(dir, 'real-root');
  mkdirSync(join(real, 'state'), { recursive: true });

  const link = join(dir, 'linked-root');
  try {
    symlinkSync(real, link, 'junction');
  } catch (error) {
    assert.fail(
      `could not create a symbolic link to test containment through one: ${String(error)}. ` +
        'This assertion is the only thing standing between a symlinked Root and state written inside it.',
    );
  }

  assert.equal(
    isInside(join(link, 'state'), real),
    true,
    'a path reached through a link is inside the directory the link points at',
  );
  assert.equal(
    isInside(join(real, 'state'), link),
    true,
    'and the same holds with the link on the other side of the question',
  );
  assert.equal(
    stateIsOutside([link], join(real, 'state')),
    false,
    'a Root named through a link still contains the state directory',
  );
  assert.equal(writeAnnotations(EMPTY_ANNOTATIONS, join(real, 'state'), [link]).written, false);
  assert.equal(isInside(join(dir, 'elsewhere'), link), false, 'and unrelated paths stay outside');
});

test('isInside answers the containment question a prefix comparison gets wrong', (t) => {
  const dir = temporaryDir(t);
  assert.equal(isInside(join(dir, 'b', 'c'), join(dir, 'b')), true);
  assert.equal(isInside(join(dir, 'b'), join(dir, 'b')), true, 'a directory contains itself');
  assert.equal(
    isInside(join(dir, 'bc'), join(dir, 'b')),
    false,
    'a shared name prefix is not containment, and reading it as one puts state inside a Root',
  );
  assert.equal(isInside(dir, join(dir, 'b')), false);
});

// ---------------------------------------------------------------------------
// Degradations — none of them throws, all of them are stated
// ---------------------------------------------------------------------------

test('a missing file reads as an empty store and says it is missing', (t) => {
  const dir = temporaryDir(t);
  const read = readState(dir);

  assert.deepEqual(read.annotations, { schemaVersion: STATE_SCHEMA_VERSION, entries: [] });
  assert.equal(read.snapshot, null);
  assert.equal(read.droppedForVersion, 0);
  assert.deepEqual(
    read.problems.map((problem) => problem.kind).sort(),
    ['absent', 'absent'],
    'a first run is a degradation the caller may ignore, but not one the store may hide',
  );
});

test('an empty, truncated or malformed file reads as an empty store without throwing', (t) => {
  const shapes: readonly (readonly [string, string, string])[] = [
    ['zero bytes', '', 'empty'],
    ['whitespace only', '   \n\n  ', 'empty'],
    ['truncated mid-write', '{"schemaVersion":1,"entries":[{"filePa', 'malformed'],
    ['a bare string', '"a string where a store belongs"', 'malformed'],
    ['a list', '[]', 'malformed'],
    ['a number', '17', 'malformed'],
    ['null', 'null', 'malformed'],
    ['no entries list', '{"schemaVersion":1,"entries":{"0":{}}}', 'malformed'],
  ];

  for (const [name, text, kind] of shapes) {
    const dir = temporaryDir(t);
    writeFileSync(join(dir, ANNOTATIONS_FILE), text, 'utf8');

    assert.doesNotThrow(() => readState(dir), `threw on ${name}`);
    const read = readState(dir);
    assert.deepEqual(read.annotations.entries, [], `${name} did not read as an empty store`);
    assert.ok(
      read.problems.some(
        (problem) => problem.kind === kind && problem.file === join(dir, ANNOTATIONS_FILE),
      ),
      `${name} was not reported as ${kind} — problems were ${JSON.stringify(read.problems)}`,
    );
  }
});

test('valid JSON chosen to resist coercion still reads as empty rather than throwing', (t) => {
  // `{"toString":null}` is perfectly good JSON,
  // and `String(...)` on it raises "Cannot convert object to primitive value" — so composing
  // the message that *reports* a bad version was itself the crash, in the one module whose
  // whole contract is that it never throws.
  const shapes: readonly (readonly [string, string, string])[] = [
    [ANNOTATIONS_FILE, '{"schemaVersion":{"toString":null},"entries":[]}', 'an object'],
    [SNAPSHOT_FILE, '{"schemaVersion":{"toString":null},"roots":[]}', 'an object'],
    [ANNOTATIONS_FILE, '{"schemaVersion":{"valueOf":null,"toString":null},"entries":[]}', 'an object'],
    [ANNOTATIONS_FILE, '{"schemaVersion":[1],"entries":[]}', 'a list'],
    [SNAPSHOT_FILE, '{"schemaVersion":{"a":{"b":1}},"roots":[]}', 'an object'],
    // A string version, so the description is exercised on a string too. `SENTINEL` must
    // not come back out: these messages reach a rendered page.
    [ANNOTATIONS_FILE, '{"schemaVersion":"SENTINEL-VERSION-r8","entries":[]}', '19-character string'],
    [SNAPSHOT_FILE, '{"schemaVersion":"SENTINEL-VERSION-r8","roots":[]}', '19-character string'],
  ];

  for (const [file, body, shown] of shapes) {
    const dir = temporaryDir(t);
    writeFileSync(join(dir, file), body, 'utf8');

    assert.doesNotThrow(() => readState(dir), `threw on ${file} holding ${body}`);
    const read = readState(dir);
    assert.deepEqual(read.annotations.entries, []);
    assert.equal(read.snapshot, null);

    const reported = read.problems.find((problem) => problem.file === join(dir, file));
    assert.ok(reported !== undefined, `${body} degraded silently instead of being reported`);
    // `schema`, not a generic decode failure. Anything else means the version was reported
    // by crashing and being caught, rather than by being described without coercion — which
    // reads the same from outside and is one guard away from throwing again.
    assert.equal(
      reported.kind,
      'schema',
      `${body} was reported as "${reported.kind}: ${reported.message}". The version is unreadable, not the file.`,
    );
    assert.ok(
      reported.message.includes(shown),
      `expected the message to describe the version as ${shown} — got "${reported.message}"`,
    );
    assert.ok(
      !reported.message.includes('SENTINEL'),
      `the message quoted the version it refused — got "${reported.message}"`,
    );
  }
});

test('a state file that is a directory reads as empty rather than throwing', (t) => {
  const dir = temporaryDir(t);
  mkdirSync(join(dir, ANNOTATIONS_FILE));

  assert.doesNotThrow(() => readState(dir));
  const read = readState(dir);
  assert.deepEqual(read.annotations.entries, []);
  assert.ok(read.problems.some((problem) => problem.kind === 'unreadable'));
});

// ---------------------------------------------------------------------------
// Schema versions
// ---------------------------------------------------------------------------

test('a store carrying an unknown schema version is dropped whole', (t) => {
  const dir = temporaryDir(t);
  writeFileSync(
    join(dir, ANNOTATIONS_FILE),
    JSON.stringify({
      schemaVersion: 4,
      entries: [{ schemaVersion: 1, filePath: '/repo#a/issues/01.md', contentSha: 'a' }],
    }),
    'utf8',
  );

  const read = readState(dir);
  assert.deepEqual(read.annotations.entries, []);
  const problem = read.problems.find((candidate) => candidate.kind === 'schema');
  assert.ok(problem !== undefined, 'an unreadable schema version must be stated, not guessed at');
  assert.ok(problem.message.includes('4'));
});

test('an entry carrying an unknown schema version is dropped and its file re-flagged', (t) => {
  const dir = temporaryDir(t);
  writeFileSync(
    join(dir, ANNOTATIONS_FILE),
    JSON.stringify({
      schemaVersion: STATE_SCHEMA_VERSION,
      entries: [
        { schemaVersion: 1, filePath: '/repo#a/issues/01.md', contentSha: 'aa' },
        { schemaVersion: 9, filePath: '/repo#a/issues/02.md', contentSha: 'bb' },
        { schemaVersion: 1, filePath: '/repo#a/issues/03.md', contentSha: 'cc' },
        'not an entry at all',
      ],
    }),
    'utf8',
  );

  const read = readState(dir);
  assert.deepEqual(
    read.annotations.entries.map((entry) => entry.filePath),
    ['/repo#a/issues/01.md', '/repo#a/issues/03.md'],
    'the readable entries survive; only the unreadable ones are dropped',
  );
  assert.equal(read.droppedForVersion, 2);
  assert.deepEqual(
    [...read.reflag],
    ['/repo#a/issues/02.md'],
    're-flagged has to name the source file, or "re-flagged" is a number nobody can act on',
  );
  assert.ok(read.problems.some((problem) => problem.kind === 'schema'));
});

test('a Snapshot file of an unknown version is re-derived rather than read', (t) => {
  const dir = temporaryDir(t);
  writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify({ schemaVersion: 42, roots: [] }), 'utf8');

  const read = readState(dir);
  assert.equal(read.snapshot, null);
  const problem = read.problems.find(
    (candidate) => candidate.kind === 'schema' && candidate.file === join(dir, SNAPSHOT_FILE),
  );
  assert.ok(problem !== undefined);
  assert.ok(problem.message.includes('42'));
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('an Annotation store written here reads back unchanged', (t) => {
  const dir = temporaryDir(t);
  const store: AnnotationStore = {
    schemaVersion: STATE_SCHEMA_VERSION,
    entries: [
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        filePath: '/repo#payments/issues/01-charge.md',
        contentSha: 'f'.repeat(64),
        extraction: { title: 'Charge the card', blockedBy: [2, 3] },
      },
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        filePath: '/repo#payments',
        contentSha: 'e'.repeat(64),
        digest: { v: 1, feature: 'payments', blocks: [{ kind: 'summary', text: 'In flight.' }] },
        memberShas: ['d'.repeat(64)],
      },
    ],
  };

  assert.equal(writeAnnotations(store, dir).written, true);
  const read = readState(dir);
  assert.deepEqual(read.annotations, store);
  assert.equal(read.droppedForVersion, 0);
  assert.deepEqual([...read.reflag], []);
  assert.ok(
    read.problems.every((problem) => problem.file !== join(dir, ANNOTATIONS_FILE)),
    'a store this module just wrote must read back without a single complaint',
  );
});

test('a Snapshot written here reads back, and the store it was derived with survives beside it', (t) => {
  const dir = temporaryDir(t);
  const snapshot = deriveSnapshot({ roots: [] }, EMPTY_ANNOTATIONS);

  assert.equal(writeSnapshot(snapshot, dir).written, true);
  assert.equal(writeAnnotations(EMPTY_ANNOTATIONS, dir).written, true);

  const read = readState(dir);
  assert.deepEqual(read.snapshot, JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(read.annotations.entries, []);
  assert.deepEqual(readdirSync(dir).sort(), [ANNOTATIONS_FILE, SNAPSHOT_FILE].sort());
});

test('a second write replaces the first rather than accreting temporary files', (t) => {
  const dir = temporaryDir(t);
  const first: AnnotationStore = {
    schemaVersion: STATE_SCHEMA_VERSION,
    entries: [{ schemaVersion: STATE_SCHEMA_VERSION, filePath: '/repo#a/issues/01.md', contentSha: 'aa' }],
  };
  const second: AnnotationStore = {
    schemaVersion: STATE_SCHEMA_VERSION,
    entries: [{ schemaVersion: STATE_SCHEMA_VERSION, filePath: '/repo#a/issues/02.md', contentSha: 'bb' }],
  };

  writeAnnotations(first, dir);
  writeAnnotations(second, dir);

  assert.deepEqual(readdirSync(dir).sort(), [ANNOTATIONS_FILE]);
  assert.deepEqual(
    readState(dir).annotations.entries.map((entry) => entry.filePath),
    ['/repo#a/issues/02.md'],
  );
});

test('stale temporary debris is neither claimed nor deleted by a later write', (t) => {
  const dir = temporaryDir(t);
  const stale = join(dir, `${ANNOTATIONS_FILE}.${String(process.pid)}.tmp`);
  writeFileSync(stale, 'owned by an earlier process', 'utf8');

  const written = writeAnnotations(EMPTY_ANNOTATIONS, dir);

  assert.equal(written.written, true, written.problem?.message);
  assert.equal(readFileSync(stale, 'utf8'), 'owned by an earlier process');
  assert.deepEqual(readState(dir).annotations.entries, []);
});

test('an exclusive temporary-name collision never deletes the file it does not own', (t) => {
  const dir = temporaryDir(t);
  const storeUrl = pathToFileURL(join(import.meta.dirname, '..', 'state', 'store.ts')).href;
  const script = `
    import crypto from 'node:crypto';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const [dir, storeUrl] = process.argv.slice(1);
    const forced = 'forced-collision';
    crypto.randomUUID = () => forced;
    syncBuiltinESMExports();
    const { ANNOTATIONS_FILE, writeAnnotations } = await import(storeUrl);
    const stale = join(dir, ANNOTATIONS_FILE + '.' + process.pid + '.' + forced + '.tmp');
    writeFileSync(stale, 'owned elsewhere', 'utf8');
    const result = writeAnnotations({ schemaVersion: 1, entries: [] }, dir);
    process.stdout.write(JSON.stringify({
      written: result.written,
      staleExists: existsSync(stale),
      staleText: readFileSync(stale, 'utf8'),
    }));
  `;
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script, dir, storeUrl],
    { encoding: 'utf8' },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    written: false,
    staleExists: true,
    staleText: 'owned elsewhere',
  });
});

test('a write into a directory that does not exist yet creates it', (t) => {
  const dir = join(temporaryDir(t), 'nested', 'deeper');
  assert.equal(writeAnnotations(EMPTY_ANNOTATIONS, dir).written, true);
  assert.deepEqual(readState(dir).annotations.entries, []);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A disposable directory, removed when the test ends however it ends. */
function temporaryDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-board-state-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
