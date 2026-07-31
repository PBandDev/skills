/**
 * The watcher, tested against controlled time and a controlled change source.
 *
 * Everything the watcher has to be correct about is a question of timing, and timing asserted
 * against a real clock is either slow or flaky. Both are injected, so a fifteen-minute idle
 * reap and a three-event burst are ordinary assertions rather than sleeps.
 *
 * The real `fs.watch` path and the real event storm are covered in `server.test.ts`, where the
 * measurement that motivates the debounce actually happens.
 *
 * Every test builds its own world under `os.tmpdir()` and removes it. The state directory is
 * redirected before anything runs, because `state/store.ts` resolves it from the home
 * directory and a test must never write into the real one.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type { Snapshot } from '../core/types.ts';
import { DEFAULT_DEBOUNCE_MS, DEFAULT_POLL_MS, canonicalRootPath, createBoard } from '../watch/board.ts';
import type { Board, BoardOptions } from '../watch/board.ts';
import { polledSource, startBestSource } from '../watch/changes.ts';
import type { ChangeHandlers, ChangeSource, Stop, Timers } from '../watch/changes.ts';

// `state/store.ts` resolves its directory from the home directory. Redirected here, before
// any board is created, so no test can write into the real one even by mistake.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'tracker-board-home-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

// ---------------------------------------------------------------------------
// The debounce
// ---------------------------------------------------------------------------

test('the debounce interval is a named, adjustable value', (t) => {
  // Named, so the measurement behind it has somewhere to live; adjustable, because event
  // coalescing differs by platform and file system and 250 ms is a starting point rather
  // than a fact about the world.
  assert.equal(DEFAULT_DEBOUNCE_MS, 250);
  assert.ok(DEFAULT_POLL_MS > DEFAULT_DEBOUNCE_MS, 'polling must be coarser than the debounce');

  const world = boardWorld(tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' }), {
    debounceMs: 40,
  });
  world.source.fire();
  world.timers.advance(39);
  assert.equal(world.scans(), 1, 'only the registration scan has run');
  world.timers.advance(1);
  assert.equal(world.scans(), 2, 'the configured interval was not honoured');
  world.board.stop();
});

test('a burst of raw events produces exactly one re-scan', (t) => {
  // One save emits three `fs.watch` events on the machine this was measured on. The whole
  // point of the debounce is that three events are one scan and therefore one frame.
  const world = boardWorld(tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' }));
  const before = world.scans();

  world.source.fire();
  world.source.fire();
  world.source.fire();
  world.timers.advance(DEFAULT_DEBOUNCE_MS);

  assert.equal(world.scans() - before, 1, 'three raw events produced more than one re-scan');
  world.board.stop();
});

test('an event arriving while a scan runs is not swallowed', (t) => {
  // `readTree` is synchronous, so a change cannot interleave with a scan — it queues behind
  // one. This fires from inside a subscriber, which runs during the scan's own turn, and
  // asserts the queued event still produces the next scan rather than being lost to the
  // debounce that was cancelled underneath it.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const world = boardWorld(root);
  let reentered = false;

  world.board.subscribe(() => {
    if (reentered) return;
    reentered = true;
    world.source.fire();
  });

  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 — A changed\n', 'utf8');
  world.source.fire();
  world.timers.advance(DEFAULT_DEBOUNCE_MS);
  assert.ok(reentered, 'the subscriber never ran, so nothing was re-entered');

  const scansAfterFirst = world.scans();
  world.timers.advance(DEFAULT_DEBOUNCE_MS);
  assert.equal(
    world.scans(),
    scansAfterFirst + 1,
    'a change raised during a scan was dropped instead of scheduling the next one',
  );
  world.board.stop();
});

test('a steady trickle of events cannot starve the scan indefinitely', (t) => {
  // A trailing debounce restarted by every event never comes due if events arrive closer
  // together than the interval. Measured: ten polled Roots registered 200 ms apart tick 200 ms
  // apart in aggregate and cancel a 250 ms timer for ever — sixty simulated seconds, zero
  // scans, the change invisible, and nothing anywhere saying so.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const world = boardWorld(root);
  const scansBefore = world.scans();

  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 — CHANGED\n', 'utf8');
  // An event every 200 ms, for ten seconds, against a 250 ms debounce.
  for (let elapsed = 0; elapsed < 10_000; elapsed += 200) {
    world.source.fire();
    world.timers.advance(200);
  }

  assert.ok(
    world.scans() > scansBefore,
    'a steady trickle of events held the debounce open for ever and the board silently stopped updating',
  );
  assert.match(
    world.board.snapshot().roots[0]?.features[0]?.tickets[0]?.extraction.title ?? '',
    /CHANGED/,
    'the change never reached the Snapshot',
  );
  world.board.stop();
});

test('the ceiling on the wait is honoured, and is not simply the debounce', (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const world = boardWorld(root, { debounceMs: 100, maxWaitMs: 500 });
  const before = world.scans();

  // Events every 60 ms: never a 100 ms gap, so the trailing timer alone would never fire.
  for (let elapsed = 0; elapsed < 400; elapsed += 60) {
    world.source.fire();
    world.timers.advance(60);
  }
  assert.equal(world.scans(), before, 'the ceiling fired early — the debounce is doing no work');

  world.timers.advance(200);
  world.source.fire();
  assert.equal(world.scans(), before + 1, 'the ceiling never fired');
  world.board.stop();
});

// ---------------------------------------------------------------------------
// A source that dies after it started
// ---------------------------------------------------------------------------

test('a watcher that fails after starting moves its Root to polling rather than going quiet', (t) => {
  // Starting cleanly and dying an hour later is the dangerous shape: the Root keeps reporting
  // itself as watched while nothing watches it, and every later change to it is lost with no
  // warning anywhere on the board.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const timers = manualTimers();
  const dying = manualSource();
  const board = createBoard({
    timers,
    watchSource: dying,
    fallbackSource: polledSource(DEFAULT_POLL_MS, timers),
    stateDir: join(SANDBOX_HOME, '.tracker-board'),
  });
  t.after(() => board.stop());

  assert.equal(board.register(root).kind, 'recursive');
  dying.fail('EPERM after an hour of watching');

  const after = board.roots()[0];
  assert.equal(after?.kind, 'polled', 'the Root still claims to be watched by a dead watcher');
  assert.match(after?.fellBackBecause ?? '', /EPERM/);

  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 — CHANGED\n', 'utf8');
  timers.advance(DEFAULT_POLL_MS + DEFAULT_DEBOUNCE_MS);
  assert.match(
    board.snapshot().roots[0]?.features[0]?.tickets[0]?.extraction.title ?? '',
    /CHANGED/,
    'the Root went permanently stale after its watcher died',
  );
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

test('one write produces one published Snapshot, and no write produces none', (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const world = boardWorld(root);
  const published: Snapshot[] = [];
  world.board.subscribe((snapshot) => published.push(snapshot));

  // A tick with nothing changed publishes nothing. This is what keeps a polled Root quiet.
  world.source.fire();
  world.timers.advance(DEFAULT_DEBOUNCE_MS);
  assert.equal(published.length, 0, 'a re-scan that found no change still published');

  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 — A changed\n', 'utf8');
  world.source.fire();
  world.source.fire();
  world.timers.advance(DEFAULT_DEBOUNCE_MS);
  assert.equal(published.length, 1, 'one write must produce exactly one published Snapshot');

  world.board.stop();
});

test('a subscriber that throws does not stop the others being told', (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const world = boardWorld(root);
  let reached = 0;
  world.board.subscribe(() => {
    throw new Error('a socket that closed mid-write');
  });
  world.board.subscribe(() => {
    reached += 1;
  });

  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 — changed\n', 'utf8');
  world.source.fire();
  world.timers.advance(DEFAULT_DEBOUNCE_MS);

  assert.equal(reached, 1, 'one failing subscriber cost another its update');
  world.board.stop();
});

// ---------------------------------------------------------------------------
// Full re-scan, never a diff
// ---------------------------------------------------------------------------

test('every change re-reads every Root in full', (t) => {
  const first = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const second = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const world = boardWorld(first);
  world.board.register(second);

  // A file added to the *first* Root after the second was registered still appears, which it
  // could not if the board were updating a cached tree per Root.
  mkdirSync(join(first, '.scratch', 'alpha', 'issues'), { recursive: true });
  writeFileSync(join(first, '.scratch', 'alpha', 'issues', '03-c.md'), '# 03 — C\n', 'utf8');
  world.source.fire();
  world.timers.advance(DEFAULT_DEBOUNCE_MS);

  assert.deepEqual(ticketPaths(world.board.snapshot()), [
    'alpha/issues/01-a.md',
    'alpha/issues/03-c.md',
    'beta/issues/02-b.md',
  ]);
  assert.equal(world.board.lastScan()?.rootCount, 2, 'a re-scan skipped a Root');
  world.board.stop();
});

// ---------------------------------------------------------------------------
// Roots accrete
// ---------------------------------------------------------------------------

test('registering a Root re-scans and leaves the Roots already registered alone', (t) => {
  const first = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const second = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const world = boardWorld(first);

  assert.equal(world.board.roots().length, 1);
  const startedSources = world.source.starts;

  world.board.register(second);
  assert.deepEqual(
    world.board.roots().map((root) => root.path),
    [first, second],
  );
  assert.equal(
    world.source.starts,
    startedSources + 1,
    'registering a second Root restarted the first Root’s source, which drops events in the gap',
  );
  assert.deepEqual(ticketPaths(world.board.snapshot()), [
    'alpha/issues/01-a.md',
    'beta/issues/02-b.md',
  ]);
  world.board.stop();
});

test('a deferred registration accretes before its full re-scan runs', (t) => {
  const first = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const second = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const world = boardWorld(first);
  const scansBefore = world.scans();

  world.board.register(second, { scan: 'deferred' });

  assert.deepEqual(world.board.roots().map((root) => root.path), [first, second]);
  assert.equal(world.scans(), scansBefore, 'the full scan ran on the acknowledgement path');
  assert.equal(world.board.snapshot().roots.length, 1, 'the Snapshot changed before the deferred scan');

  world.timers.advance(DEFAULT_DEBOUNCE_MS);
  assert.equal(world.scans(), scansBefore + 1);
  assert.deepEqual(ticketPaths(world.board.snapshot()), [
    'alpha/issues/01-a.md',
    'beta/issues/02-b.md',
  ]);
  world.board.stop();
});

test('a deferred registration never scans inline when older work exceeded max wait', (t) => {
  const first = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const second = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const timers = manualTimers();
  const source = manualSource();
  const board = createBoard({
    timers,
    watchSource: source,
    fallbackSource: source,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxWaitMs: 10,
    stateDir: join(SANDBOX_HOME, '.tracker-board'),
  });
  t.after(() => board.stop());
  board.register(first);
  source.fire();
  timers.jump(20);
  const scansBefore = board.lastScan()?.scanCount ?? 0;

  board.register(second, { scan: 'deferred' });

  assert.equal(board.lastScan()?.scanCount, scansBefore, 'deferred registration scanned inline');
  board.rescanNow();
  const scansAfterAcknowledgement = board.lastScan()?.scanCount ?? 0;
  assert.equal(scansAfterAcknowledgement, scansBefore + 1);
  timers.advance(DEFAULT_DEBOUNCE_MS * 2);
  assert.equal(
    board.lastScan()?.scanCount,
    scansAfterAcknowledgement,
    'the absorbed deferred timer ran a second full scan',
  );
});

test('registering the same Root twice re-scans without adding it twice', (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const world = boardWorld(root);
  const startedSources = world.source.starts;

  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 — changed\n', 'utf8');
  world.board.register(root);

  assert.equal(world.board.roots().length, 1, 'invoking the skill twice in one repo split the Root');
  assert.equal(world.source.starts, startedSources, 'the existing source was torn down and rebuilt');
  assert.match(
    world.board.snapshot().roots[0]?.features[0]?.tickets[0]?.extraction.title ?? '',
    /changed/,
    're-registering did not re-scan',
  );
  world.board.stop();
});

test('filesystem aliases resolve to one canonical Root and one watcher', (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const aliasHome = mkdtempSync(join(tmpdir(), 'tracker-board-alias-'));
  t.after(() => rmSync(aliasHome, { recursive: true, force: true }));
  const alias = join(aliasHome, 'repository-link');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');

  const world = boardWorld(root);
  const startedSources = world.source.starts;
  const registered = world.board.register(alias);

  assert.equal(registered.path, realpathSync(root));
  assert.deepEqual(world.board.roots().map((candidate) => candidate.path), [realpathSync(root)]);
  assert.equal(world.source.starts, startedSources, 'an alias started a duplicate watcher');
  world.board.stop();
});

test('an alias cannot smuggle a control character into the canonical Root identity', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'tracker-board-canonical-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const target = join(parent, `control${String.fromCharCode(0x85)}root`);
  const alias = join(parent, 'safe-alias');
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => canonicalRootPath(alias), /canonical path|control/i);
});

test('a registered directory replaced by an alias is re-keyed before another Root is added', (t) => {
  const original = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const target = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const world = boardWorld(original);
  const startedSources = world.source.starts;

  rmSync(original, { recursive: true, force: true });
  symlinkSync(target, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(realpathSync(original), realpathSync(target));

  const registered = world.board.register(target);

  assert.equal(registered.path, realpathSync(target));
  assert.deepEqual(
    world.board.roots().map((candidate) => candidate.path),
    [realpathSync(target)],
    'one current directory retained two stale Root identities',
  );
  assert.equal(
    world.source.starts,
    startedSources + 1,
    'the watcher remained attached to the directory entry whose identity changed',
  );
  assert.deepEqual(ticketPaths(world.board.snapshot()), ['beta/issues/02-b.md']);
  world.board.stop();
});

test('a missing Root is refused before it can later change filesystem identity', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'tracker-board-future-root-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const future = join(parent, 'future');
  const target = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const timers = manualTimers();
  const source = manualSource();
  const board = createBoard({
    timers,
    watchSource: source,
    fallbackSource: source,
    stateDir: join(SANDBOX_HOME, '.tracker-board'),
  });
  t.after(() => board.stop());

  assert.throws(() => board.register(future), /existing directory/i);
  assert.deepEqual(board.roots(), []);
  assert.equal(source.starts, 0, 'a rejected Root started a watcher');

  symlinkSync(target, future, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(board.register(future).path, realpathSync(target));
  assert.deepEqual(board.roots().map((candidate) => candidate.path), [realpathSync(target)]);
  assert.equal(source.starts, 1);
});

test('the state directory is checked against the Roots as they accrete', (t) => {
  // The store refuses rather than relocating, and Roots accrete, so the question has to be
  // asked after each registration rather than once at startup.
  const outside = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const stateHome = mkdtempSync(join(tmpdir(), 'tracker-board-state-'));
  t.after(() => rmSync(stateHome, { recursive: true, force: true }));

  const world = boardWorld(outside, { stateDir: join(stateHome, '.tracker-board') });
  assert.equal(world.board.stateIsSafe(), true);

  world.board.register(stateHome);
  assert.equal(
    world.board.stateIsSafe(),
    false,
    'a Root registered later contained the state directory and the board did not notice',
  );
  world.board.stop();
});

// ---------------------------------------------------------------------------
// The polled fallback
// ---------------------------------------------------------------------------

test('a Root that cannot be watched is polled, and says so', (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const timers = manualTimers();
  const refuses: ChangeSource = {
    kind: 'recursive',
    start: () => ({ stop: () => {}, problem: 'recursive watching is unavailable here' }),
  };
  const board = createBoard({
    timers,
    watchSource: refuses,
    fallbackSource: polledSource(DEFAULT_POLL_MS, timers),
    stateDir: join(SANDBOX_HOME, '.tracker-board'),
  });
  t.after(() => board.stop());

  const registered = board.register(root);
  assert.equal(registered.kind, 'polled');
  assert.match(registered.fellBackBecause ?? '', /unavailable/);

  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 — changed\n', 'utf8');
  timers.advance(DEFAULT_POLL_MS);
  timers.advance(DEFAULT_DEBOUNCE_MS);
  assert.match(
    board.snapshot().roots[0]?.features[0]?.tickets[0]?.extraction.title ?? '',
    /changed/,
    'the polled fallback never re-scanned',
  );
});

test('the polled fallback and the watched path produce identical Snapshots', (t) => {
  // The same tree, the same pipeline, woken two different ways. They agree because there is
  // one implementation downstream of a source, not because two of them were kept in step.
  const files = {
    'alpha/issues/01-a.md': '# 01 — A\n\n**Status:** open\n',
    'alpha/spec.md': '# Spec\n',
    'beta/issues/02-b.md': '# 02 — B\n\n- [x] done\n',
  };
  const watched = tempTracker(t, files);
  const polled = tempTracker(t, files);

  const watchedWorld = boardWorld(watched);
  const polledTimers = manualTimers();
  const polledBoard = createBoard({
    timers: polledTimers,
    watchSource: { kind: 'recursive', start: () => ({ stop: () => {}, problem: 'no' }) },
    fallbackSource: polledSource(DEFAULT_POLL_MS, polledTimers),
    stateDir: join(SANDBOX_HOME, '.tracker-board'),
  });
  t.after(() => polledBoard.stop());
  polledBoard.register(polled);

  watchedWorld.source.fire();
  watchedWorld.timers.advance(DEFAULT_DEBOUNCE_MS);
  polledTimers.advance(DEFAULT_POLL_MS + DEFAULT_DEBOUNCE_MS);

  assert.deepEqual(
    withoutRootPaths(polledBoard.snapshot()),
    withoutRootPaths(watchedWorld.board.snapshot()),
    'the two sources produced different Snapshots of the same tree',
  );
  watchedWorld.board.stop();
});

test('a source that starts cleanly is not replaced by the fallback', () => {
  let fellBack = false;
  const started = startBestSource(
    join(tmpdir(), `tracker-board-nowhere-${String(process.pid)}`),
    { onChange: () => {}, onFailure: () => {} },
    { kind: 'recursive', start: () => ({ stop: () => {}, problem: null }) },
    {
      kind: 'polled',
      start: () => {
        fellBack = true;
        return { stop: () => {}, problem: null };
      },
    },
  );
  assert.equal(started.kind, 'recursive');
  assert.equal(started.fellBackBecause, null);
  assert.equal(fellBack, false, 'the fallback ran even though watching started');
});

// ---------------------------------------------------------------------------
// Scan cost
// ---------------------------------------------------------------------------

test('a re-scan reports its own duration, and says when it outran its debounce', (t) => {
  // The honest answer to "is the scan too expensive?" is the scan's own latency, measured on
  // the tree in front of it — not a byte budget guessed in advance. Time is stepped by a
  // fixed amount per reading, so the duration is a known number rather than whatever the
  // machine happened to do, and `slow` is therefore a real assertion in both directions.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });

  const quick = createBoard({
    timers: steppingTimers(10),
    watchSource: manualSource(),
    fallbackSource: manualSource(),
    stateDir: join(SANDBOX_HOME, '.tracker-board'),
    debounceMs: 100,
  });
  t.after(() => quick.stop());
  quick.register(root);
  const fast = quick.lastScan();
  assert.ok(fast !== null, 'no scan was reported');
  assert.equal(fast.durationMs, 10, 'the scan did not measure itself between two clock reads');
  assert.equal(fast.fileCount, 1);
  assert.equal(fast.slow, false, '10 ms against a 100 ms debounce is not slow');

  const sluggish = createBoard({
    timers: steppingTimers(10),
    watchSource: manualSource(),
    fallbackSource: manualSource(),
    stateDir: join(SANDBOX_HOME, '.tracker-board'),
    debounceMs: 5,
  });
  t.after(() => sluggish.stop());
  sluggish.register(root);
  assert.equal(
    sluggish.lastScan()?.slow,
    true,
    'a re-scan that outran the debounce scheduling it was not reported as slow',
  );
});

// ---------------------------------------------------------------------------
// A world: a temp tracker, controlled time, and a source under the test's thumb
// ---------------------------------------------------------------------------

interface ManualTimers extends Timers {
  /** Move time forward, running whatever falls due. */
  readonly advance: (ms: number) => void;
  /** Move the clock without running callbacks, modelling an event-loop stall. */
  readonly jump: (ms: number) => void;
  readonly pending: () => number;
}

function manualTimers(): ManualTimers {
  let clock = 0;
  let nextId = 0;
  const due = new Map<number, { at: number; every: number | null; fn: () => void }>();

  return {
    now: () => clock,
    delay(ms, fn) {
      const id = nextId++;
      due.set(id, { at: clock + ms, every: null, fn });
      return () => {
        due.delete(id);
      };
    },
    repeat(ms, fn) {
      const id = nextId++;
      due.set(id, { at: clock + ms, every: ms, fn });
      return () => {
        due.delete(id);
      };
    },
    advance(ms) {
      const target = clock + ms;
      // Run in due order, and let a callback schedule more work — a debounce restarted from
      // inside a subscriber has to be honoured, which is the mid-scan case.
      for (let guard = 0; guard < 10_000; guard += 1) {
        let soonest: number | null = null;
        let soonestAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of due) {
          if (entry.at <= target && entry.at < soonestAt) {
            soonest = id;
            soonestAt = entry.at;
          }
        }
        if (soonest === null) break;
        const entry = due.get(soonest);
        if (entry === undefined) break;
        clock = entry.at;
        if (entry.every === null) due.delete(soonest);
        else due.set(soonest, { ...entry, at: entry.at + entry.every });
        entry.fn();
      }
      clock = target;
    },
    jump(ms) {
      clock += ms;
    },
    pending: () => due.size,
  };
}

interface ManualSource extends ChangeSource {
  /** Raise one raw change event, as a file system would. */
  readonly fire: () => void;
  /** The source dies after having started cleanly. */
  readonly fail: (reason: string) => void;
  /** How many times a Root has been observed. Restarting one drops events in the gap. */
  readonly starts: number;
}

function manualSource(): ManualSource {
  const handlers = new Set<ChangeHandlers>();
  let starts = 0;
  const source = {
    kind: 'recursive' as const,
    start(_rootPath: string, given: ChangeHandlers) {
      starts += 1;
      handlers.add(given);
      const stop: Stop = () => {
        handlers.delete(given);
      };
      return { stop, problem: null };
    },
    fire() {
      for (const handler of [...handlers]) handler.onChange();
    },
    fail(reason: string) {
      for (const handler of [...handlers]) handler.onFailure(reason);
    },
    get starts() {
      return starts;
    },
  };
  return source;
}

interface World {
  readonly board: Board;
  readonly timers: ManualTimers;
  readonly source: ManualSource;
  /** How many re-scans have completed. */
  readonly scans: () => number;
}

function boardWorld(rootPath: string, options: BoardOptions = {}): World {
  const timers = manualTimers();
  const source = manualSource();
  let scans = 0;
  const board = createBoard({
    timers,
    watchSource: source,
    fallbackSource: source,
    stateDir: join(SANDBOX_HOME, '.tracker-board'),
    ...options,
  });
  board.register(rootPath);
  // Read straight off the board's own running total. Counting how many times the *latest*
  // report changes identity increments once per reading rather than once per scan, so three
  // scans read as one and the debounce test can pass with coalescing deleted. The observable
  // has to be the quantity under test.
  const count = (): number => {
    scans = board.lastScan()?.scanCount ?? 0;
    return scans;
  };
  count();
  return { board, timers, source, scans: count };
}

/** Build a tracker tree under `os.tmpdir()` and remove it afterwards. */
function tempTracker(t: { after(fn: () => void): void }, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'tracker-board-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relPath, text] of Object.entries(files)) {
    const abs = join(root, '.scratch', ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}

/**
 * Time that advances a fixed amount on every reading. Lets a synchronous scan have a known
 * duration, which is what makes the slow-scan report assertable in both directions.
 */
function steppingTimers(stepMs: number): Timers {
  let clock = 0;
  return {
    now() {
      clock += stepMs;
      return clock;
    },
    delay: () => () => {},
    repeat: () => () => {},
  };
}

function ticketPaths(snapshot: Snapshot): string[] {
  return snapshot.roots
    .flatMap((root) => root.features.flatMap((feature) => feature.tickets))
    .map((ticket) => ticket.path)
    .sort();
}

/** Two Roots on different temp paths differ only in those paths; everything else must match. */
function withoutRootPaths(snapshot: Snapshot): unknown {
  return JSON.parse(
    JSON.stringify(snapshot, (key, value: unknown) =>
      key === 'path' || key === 'absPath' || key === 'id' || key === 'label' || key === 'trackerPath'
        ? undefined
        : value,
    ),
  );
}
