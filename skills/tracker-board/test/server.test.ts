/**
 * The server, and the one measurement that has to happen against a real file system.
 *
 * `watch.test.ts` drives the pipeline against controlled time. This file covers what that
 * structurally cannot: a real `fs.watch` seeing a real save — which is where the claim behind
 * the debounce lives, since a single write emits several raw events — a real socket receiving
 * a real SSE frame, a second launch declining to bind a second port, and a real process
 * outliving the shell that started it.
 *
 * Every test builds its own world under `os.tmpdir()`, binds port 0 so it never claims the
 * board's real port, and removes what it made. The state directory is redirected before
 * anything runs.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { canonicalRootPath, DEFAULT_DEBOUNCE_MS, createBoard } from '../watch/board.ts';
import type { Board, RegisterOptions } from '../watch/board.ts';
import { recursiveWatchSource, systemTimers } from '../watch/changes.ts';
import type { ChangeSource, Timers } from '../watch/changes.ts';
import {
  DEFAULT_IDLE_EXIT_MS,
  HOST,
  MAX_HANDOFF_RESPONSE_BYTES,
  MAX_ROOT_PATH_BYTES,
  MAX_ROOT_REQUEST_BYTES,
  launch,
  serve,
} from '../server/server.ts';
import type { BoardServer } from '../server/server.ts';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'tracker-board-home-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const STATE_DIR = join(SANDBOX_HOME, '.tracker-board');

// ---------------------------------------------------------------------------
// The measurement behind the debounce
// ---------------------------------------------------------------------------

test('a real save emits several raw events and yields exactly one SSE frame', async (t) => {
  // The claim the debounce exists for, measured rather than asserted: the raw event count is
  // what a file system actually delivers, and the published count is what a reader sees.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });

  let rawEvents = 0;
  const counting: ChangeSource = {
    kind: 'recursive',
    start(rootPath, handlers) {
      return recursiveWatchSource.start(rootPath, {
        onChange: () => {
          rawEvents += 1;
          handlers.onChange();
        },
        onFailure: handlers.onFailure,
      });
    },
  };

  const board = createBoard({ watchSource: counting, stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(root);

  const server = await serve(board, { port: 0 });
  t.after(() => server.close());

  const frames = await collectFrames(server.url, async () => {
    await settle(150);
    writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 — A changed\n', 'utf8');
    await settle(DEFAULT_DEBOUNCE_MS * 4);
  });

  // The opening frame carries current state; the change adds exactly one more.
  assert.equal(
    frames.length,
    2,
    `one save produced ${frames.length - 1} update frames after ${rawEvents} raw events — the debounce did not coalesce them`,
  );
  assert.match(JSON.stringify(frames[1]), /A changed/, 'the update did not carry the new content');
  assert.ok(rawEvents >= 1, 'the real watcher saw no events at all, so nothing was measured');
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

test('the snapshot endpoint serves the current Snapshot', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const { server } = await boardServer(t, root);

  const response = await fetch(new URL('/snapshot', server.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  const snapshot = await response.json();
  assert.equal(snapshot.roots[0].features[0].tickets[0].path, 'alpha/issues/01-a.md');
});

test('health exposes a failed persistent Snapshot write', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  const stateSandbox = mkdtempSync(join(tmpdir(), 'tracker-board-broken-state-'));
  t.after(() => rmSync(stateSandbox, { recursive: true, force: true }));
  const notADirectory = join(stateSandbox, 'not-a-directory');
  writeFileSync(notADirectory, 'occupied');

  const board = createBoard({
    watchSource: idleSource(),
    stateDir: join(notADirectory, 'state'),
    persist: true,
  });
  t.after(() => board.stop());
  board.register(root);
  assert.equal(board.stateWriteProblem()?.kind, 'write-failed');

  const server = await serve(board, { port: 0, stopBoardOnClose: false });
  t.after(() => server.close());
  let health = await (await fetch(new URL('/health', server.url))).json();
  assert.equal(health.stateIsSafe, true);
  assert.equal(health.stateWriteProblem.kind, 'write-failed');

  rmSync(notADirectory);
  mkdirSync(notADirectory);
  board.register(root);
  health = await (await fetch(new URL('/health', server.url))).json();
  assert.equal(health.stateWriteProblem, null, 'a successful retry did not clear the stale write failure');
});

test('an unknown path is a 404 rather than a crash, and the server keeps serving', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const { server } = await boardServer(t, root);

  assert.equal((await fetch(new URL('/nope', server.url))).status, 404);
  assert.equal((await fetch(new URL('/snapshot', server.url))).status, 200);
});

test('the server binds the loopback interface only', async (t) => {
  // This process reads arbitrary directories and serves their contents, and `POST /roots`
  // asks it to read another. On a wildcard bind that is a disclosure surface offered to the
  // local network.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const { server } = await boardServer(t, root);
  assert.equal(HOST, '127.0.0.1');
  const loopbackPrefix = ['http', '://', '127.0.0.1:'].join('');
  assert.ok(server.url.startsWith(loopbackPrefix), `bound ${server.url}`);
});

test('Roots accrete over HTTP, and a malformed registration is refused', async (t) => {
  const first = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const second = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const { server } = await boardServer(t, first);

  const added = await fetch(new URL('/roots', server.url), {
    method: 'POST',
    body: JSON.stringify({ path: second }),
  });
  assert.equal(added.status, 200);
  const body = await added.json();
  assert.equal(body.roots.length, 2);

  const snapshot = await (await fetch(new URL('/snapshot', server.url))).json();
  assert.deepEqual(
    snapshot.roots.flatMap((root: { features: { tickets: { path: string }[] }[] }) =>
      root.features.flatMap((feature) => feature.tickets.map((ticket) => ticket.path)),
    ),
    ['alpha/issues/01-a.md', 'beta/issues/02-b.md'],
  );

  const malformedBodies = [
    'not json',
    '{}',
    '{"path": 7}',
    '{"path": ""}',
    JSON.stringify({ path: '.' }),
    JSON.stringify({ path: `${first}${String.fromCharCode(0)}child` }),
    JSON.stringify({ path: `${first}\nchild` }),
    JSON.stringify({ path: `${first}${String.fromCharCode(0x85)}child` }),
    JSON.stringify({ path: `${first}${'p'.repeat(MAX_ROOT_PATH_BYTES)}` }),
    JSON.stringify({ path: join(first, 'does-not-exist') }),
  ];
  for (const bad of malformedBodies) {
    const refused = await fetch(new URL('/roots', server.url), { method: 'POST', body: bad });
    assert.equal(refused.status, 400, `body ${bad} was accepted`);
  }
  assert.equal((await (await fetch(new URL('/health', server.url))).json()).roots.length, 2);
});

test('the Root request envelope carries a maximum-size escaped JSON body', async (t) => {
  const path = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  const padding = '"'.repeat((MAX_ROOT_REQUEST_BYTES - Buffer.byteLength(JSON.stringify({ path, padding: '' }), 'utf8')) / 2);
  const requestBody = JSON.stringify({ path, padding });
  assert.ok(requestBody.length > 64 * 1024, 'the regression request still fits the old envelope');
  assert.ok(Buffer.byteLength(requestBody, 'utf8') <= MAX_ROOT_REQUEST_BYTES);

  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());
  const response = await fetch(new URL('/roots', server.url), {
    method: 'POST',
    body: requestBody,
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.root.path, canonicalRootPath(path));
});

test('a Root that disappears after validation is refused without crashing the server', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  const base = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  const board: Board = {
    ...base,
    register() {
      throw new Error('Root vanished after validation');
    },
  };
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());

  const refused = await fetch(new URL('/roots', server.url), {
    method: 'POST',
    body: JSON.stringify({ path: root }),
  });

  assert.equal(refused.status, 400);
  assert.equal((await fetch(new URL('/health', server.url))).status, 200, 'register failure crashed the singleton');
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

test('a second launch hands its Root to the running board rather than starting a second one', async (t) => {
  // The failure ADR-0005 names explicitly is two servers on two ports splitting the Roots
  // list. Losing the bind is only half of avoiding it: Roots accrete, so the losing
  // invocation's Root has to end up on the board that *is* running, or the user is looking
  // at a board that does not contain the repo they just invoked it in.
  //
  // Two genuinely separate Boards, because one shared instance cannot show any of this.
  const firstRoot = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const secondRoot = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });

  const winner = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  winner.register(firstRoot);
  const first = await serve(winner, { port: 0 });
  t.after(() => first.close());

  const loser = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  loser.register(secondRoot);
  const second = await launch(loser, { port: first.port });

  assert.equal(second.kind, 'already-serving');
  if (second.kind !== 'already-serving') return;
  assert.equal(second.url, first.url, 'the second launch reported a different URL');
  assert.deepEqual(second.handedOver, [secondRoot], 'the losing Root was never handed over');
  assert.deepEqual(second.refused, []);

  const health = await (await fetch(new URL('/health', first.url))).json();
  assert.deepEqual(
    health.roots.map((root: { path: string }) => root.path).sort(),
    [firstRoot, secondRoot].sort(),
    'the running board did not accrete the second invocation’s Root',
  );

  const snapshot = await (await fetch(new URL('/snapshot', first.url))).json();
  assert.equal(snapshot.roots.length, 2);
});

test('a handoff defers its full scan until after acknowledging the Root', async (t) => {
  const firstRoot = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const secondRoot = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const base = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  base.register(firstRoot);
  let requestedScan: string | null = null;
  const winner: Board = {
    ...base,
    register(rootPath, options?: RegisterOptions) {
      requestedScan = options?.scan ?? null;
      return base.register(rootPath, options);
    },
  };
  const first = await serve(winner, { port: 0 });
  t.after(() => first.close());

  const loser = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  loser.register(secondRoot);
  const result = await launch(loser, { port: first.port });

  assert.equal(result.kind, 'already-serving');
  if (result.kind !== 'already-serving') return;
  assert.deepEqual(result.handedOver, [secondRoot]);
  assert.equal(requestedScan, 'deferred');
  await settle(20);
  const postAcknowledgementScans = base.lastScan()?.scanCount ?? 0;
  assert.equal(postAcknowledgementScans, 2, 'the post-acknowledgement scan did not run once');
  await settle(DEFAULT_DEBOUNCE_MS * 2);
  assert.equal(
    base.lastScan()?.scanCount,
    postAcknowledgementScans,
    'the deferred timer repeated the full handoff scan',
  );
});

test('a registered handoff reports an unsafe state location without falsely refusing the Root', async (t) => {
  const firstRoot = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  const secondRoot = tempTracker(t, { 'beta/issues/02-b.md': '# 02 - B\n' });
  const winner = createBoard({
    watchSource: idleSource(),
    stateDir: join(secondRoot, '.tracker-board'),
    persist: true,
  });
  winner.register(firstRoot);
  const first = await serve(winner, { port: 0 });
  t.after(() => first.close());

  const loser = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  loser.register(secondRoot);
  const result = await launch(loser, { port: first.port });

  assert.equal(result.kind, 'already-serving');
  if (result.kind !== 'already-serving') return;
  assert.deepEqual(result.handedOver, [secondRoot]);
  assert.deepEqual(result.refused, []);

  const health = await (await fetch(new URL('/health', first.url))).json();
  assert.deepEqual(health.roots.map((root: { path: string }) => root.path), [firstRoot, secondRoot]);
  assert.equal(health.stateIsSafe, false);
  assert.equal(health.stateWriteProblem.kind, 'inside-root');
});

test('a losing launch stops its own board rather than leaving it watching', async (t) => {
  // The loser is not the board. Left running, its watcher handles hold a process alive that
  // serves nothing — a ghost that survives every later invocation.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const winner = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  t.after(() => winner.stop());
  const first = await serve(winner, { port: 0, stopBoardOnClose: false });
  t.after(() => first.close());

  let stops = 0;
  const loser = createBoard({
    watchSource: {
      kind: 'recursive',
      start: () => ({
        stop: () => {
          stops += 1;
        },
        problem: null,
      }),
    },
    stateDir: STATE_DIR,
  });
  loser.register(root);
  await launch(loser, { port: first.port });
  assert.equal(stops, 1, 'the losing invocation kept its watcher open');
});

test('a port held by something that is not a board is reported rather than assumed', async (t) => {
  // `EADDRINUSE` says somebody has the port, not that the somebody is a board. Handing a Root
  // to an unrelated catch-all service has to come back as a refusal even when it returns 200.
  const impostor = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<p>accepted</p>');
  });
  await new Promise<void>((resolve) => impostor.listen(0, HOST, resolve));
  const address = impostor.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => impostor.close(() => resolve())));

  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  board.register(root);

  const result = await launch(board, { port });
  assert.equal(result.kind, 'already-serving');
  if (result.kind !== 'already-serving') return;
  assert.deepEqual(result.handedOver, []);
  assert.deepEqual(result.refused, [root], 'an unrelated port holder was treated as a board');
});

test('handoff identity rejects each omitted or malformed structured field independently', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const path = { path: root };
  const cases: readonly (readonly [string, unknown])[] = [
    ['root omitted', { roots: [path], stateIsSafe: true, stateWriteProblem: null }],
    ['root malformed', { root: { path: 7 }, roots: [path], stateIsSafe: true, stateWriteProblem: null }],
    ['roots omitted', { root: path, stateIsSafe: true, stateWriteProblem: null }],
    ['roots malformed', { root: path, roots: path, stateIsSafe: true, stateWriteProblem: null }],
    ['stateIsSafe omitted', { root: path, roots: [path], stateWriteProblem: null }],
    ['stateIsSafe malformed', { root: path, roots: [path], stateIsSafe: 'yes', stateWriteProblem: null }],
    ['stateWriteProblem omitted', { root: path, roots: [path], stateIsSafe: true }],
    ['stateWriteProblem malformed', { root: path, roots: [path], stateIsSafe: true, stateWriteProblem: { kind: 7 } }],
  ];

  for (const [name, body] of cases) {
    const impostor = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => impostor.listen(0, HOST, resolve));
    const address = impostor.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
      board.register(root);
      const result = await launch(board, { port });
      assert.equal(result.kind, 'already-serving', name);
      if (result.kind !== 'already-serving') continue;
      assert.deepEqual(result.handedOver, [], name);
      assert.deepEqual(result.refused, [root], name);
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
  }
});

test('a port holder that never completes its handoff response cannot hang launch', async (t) => {
  const holder = createServer((_request, response) => {
    const delayed = setTimeout(() => {
      if (!response.destroyed) response.end('{}');
    }, 1_000);
    response.on('close', () => clearTimeout(delayed));
  });
  await new Promise<void>((resolve) => holder.listen(0, HOST, resolve));
  const address = holder.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => holder.close(() => resolve())));

  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  board.register(root);

  const started = Date.now();
  const result = await launch(board, { port, handoffTimeoutMs: 30 });
  const elapsed = Date.now() - started;

  assert.equal(result.kind, 'already-serving');
  if (result.kind !== 'already-serving') return;
  assert.deepEqual(result.refused, [root]);
  assert.ok(elapsed < 500, `handoff took ${String(elapsed)}ms after its deadline`);
});

test('a handoff never follows a redirect away from the fixed-port incumbent', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  let forwarded = 0;
  const receiver = createServer((_request, response) => {
    forwarded += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ root: { path: root }, roots: [{ path: root }], stateIsSafe: true }));
  });
  await new Promise<void>((resolve) => receiver.listen(0, HOST, resolve));
  const receiverAddress = receiver.address();
  const receiverPort = typeof receiverAddress === 'object' && receiverAddress !== null ? receiverAddress.port : 0;
  t.after(() => new Promise<void>((resolve) => receiver.close(() => resolve())));

  const receiverUrl = ['http', '://', HOST, ':', String(receiverPort), '/roots'].join('');
  const redirector = createServer((_request, response) => {
    response.writeHead(307, { location: receiverUrl });
    response.end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, HOST, resolve));
  const redirectorAddress = redirector.address();
  const port = typeof redirectorAddress === 'object' && redirectorAddress !== null ? redirectorAddress.port : 0;
  t.after(() => new Promise<void>((resolve) => redirector.close(() => resolve())));

  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  board.register(root);
  const result = await launch(board, { port });

  assert.equal(result.kind, 'already-serving');
  if (result.kind !== 'already-serving') return;
  assert.deepEqual(result.refused, [root]);
  assert.equal(forwarded, 0, 'the Root request escaped the fixed-port incumbent');
});

test('a handoff refuses an oversized chunked identity response', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  const incumbent = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(' '.repeat(MAX_HANDOFF_RESPONSE_BYTES + 1));
    response.end(JSON.stringify({ root: { path: root }, roots: [{ path: root }], stateIsSafe: true }));
  });
  await new Promise<void>((resolve) => incumbent.listen(0, HOST, resolve));
  const address = incumbent.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => incumbent.close(() => resolve())));

  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  board.register(root);
  const result = await launch(board, { port });

  assert.equal(result.kind, 'already-serving');
  if (result.kind !== 'already-serving') return;
  assert.deepEqual(result.handedOver, []);
  assert.deepEqual(result.refused, [root]);
});

test('a structured crowded-board response may exceed 64 KiB without a false refusal', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  const roots = [{ path: root }];
  for (let index = 1; index < 64; index += 1) {
    roots.push({ path: `${String(index)}-${'p'.repeat(2_000)}` });
  }
  const incumbent = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ root: { path: root }, roots, stateIsSafe: true, stateWriteProblem: null }));
  });
  await new Promise<void>((resolve) => incumbent.listen(0, HOST, resolve));
  const address = incumbent.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => incumbent.close(() => resolve())));

  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  board.register(root);
  const result = await launch(board, { port });

  assert.equal(result.kind, 'already-serving');
  if (result.kind !== 'already-serving') return;
  assert.deepEqual(result.handedOver, [root]);
  assert.deepEqual(result.refused, []);
});

test('an escape-heavy maximum-size Roots list remains within the handoff envelope', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const roots = [{ path: root }];
  for (let index = 1; index < 64; index += 1) {
    const prefix = `${String(index)}-`;
    roots.push({ path: prefix + '\\'.repeat(MAX_ROOT_PATH_BYTES - prefix.length) });
  }
  const payload = JSON.stringify({
    root: { path: root },
    roots,
    stateIsSafe: true,
    stateWriteProblem: null,
  });
  assert.ok(Buffer.byteLength(payload, 'utf8') > MAX_HANDOFF_RESPONSE_BYTES - 512 * 1024);
  assert.ok(Buffer.byteLength(payload, 'utf8') <= MAX_HANDOFF_RESPONSE_BYTES);

  const incumbent = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(payload);
  });
  await new Promise<void>((resolve) => incumbent.listen(0, HOST, resolve));
  const address = incumbent.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  t.after(() => new Promise<void>((resolve) => incumbent.close(() => resolve())));

  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  board.register(root);
  const result = await launch(board, { port });

  assert.equal(result.kind, 'already-serving');
  if (result.kind !== 'already-serving') return;
  assert.deepEqual(result.handedOver, [root]);
  assert.deepEqual(result.refused, []);
});

test('a failed bind does not leave its subscription or its idle timer behind', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(root);

  let live = 0;
  const counted: Board = {
    ...board,
    subscribe(listener) {
      live += 1;
      const off = board.subscribe(listener);
      return () => {
        live -= 1;
        off();
      };
    },
  };

  const held = await serve(counted, { port: 0, stopBoardOnClose: false });
  t.after(() => held.close());
  await assert.rejects(() => serve(counted, { port: held.port, stopBoardOnClose: false }));
  assert.equal(live, 1, 'the failed bind kept its subscription, so the board fans out to a dead server');
});

// ---------------------------------------------------------------------------
// The HTTP boundary
// ---------------------------------------------------------------------------

test('a request carrying a Host this server did not bind is refused', async (t) => {
  // Binding to loopback keeps the network out. It does not keep out a page in a browser that
  // resolved a name pointing at 127.0.0.1 — only checking the Host does that.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const { server } = await boardServer(t, root);

  // `fetch` refuses to set Host — it is a forbidden header there — so this goes through a raw
  // request, which is also what an attacking page's browser would send.
  assert.equal(
    await statusWithHost(server.port, 'board.example.com'),
    403,
    'a foreign Host reached the Snapshot',
  );
  assert.equal(await statusWithHost(server.port, `127.0.0.1:${String(server.port)}`), 200);
  assert.equal(await statusWithHost(server.port, `localhost:${String(server.port)}`), 200);
});

test('only a same-origin browser request can mutate Roots or Reconciliation state', async (t) => {
  const first = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  const second = tempTracker(t, { 'beta/issues/02-b.md': '# 02 - B\n' });
  const { server } = await boardServer(t, first);
  const foreignOrigin = ['https', '://', 'board.example'].join('');

  const response = await fetch(new URL('/roots', server.url), {
    method: 'POST',
    headers: { origin: foreignOrigin, 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ path: second }),
  });

  assert.equal(response.status, 403);
  const refusedReconciliation = await fetch(new URL('/reconcile', server.url), {
    method: 'POST',
    headers: {
      origin: foreignOrigin,
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ schemaVersion: 1, after: null, response: {} }),
  });
  assert.equal(refusedReconciliation.status, 403);
  let health = await (await fetch(new URL('/health', server.url))).json();
  assert.deepEqual(health.roots.map((root: { path: string }) => root.path), [first]);

  const accepted = await fetch(new URL('/roots', server.url), {
    method: 'POST',
    headers: { origin: new URL(server.url).origin, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ path: second }),
  });
  assert.equal(accepted.status, 200);
  health = await (await fetch(new URL('/health', server.url))).json();
  assert.deepEqual(health.roots.map((root: { path: string }) => root.path), [first, second]);
});

function statusWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: HOST, port, path: '/snapshot', method: 'GET', headers: { host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('the number of Roots one board will hold is bounded', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(root);
  const server = await serve(board, { port: 0, maxRoots: 2, stopBoardOnClose: false });
  t.after(() => server.close());

  const second = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const third = tempTracker(t, { 'gamma/issues/03-c.md': '# 03 — C\n' });
  assert.equal((await post(server.url, second)).status, 200);
  assert.equal(
    (await post(server.url, third)).status,
    429,
    'anything on this machine can add Roots, and each costs a watcher and a full walk per scan',
  );
  // An already-known Root is still accepted at the cap: re-invoking in a registered repo must
  // keep working however many Roots the board holds.
  assert.equal((await post(server.url, second)).status, 200);

  const aliasHome = mkdtempSync(join(tmpdir(), 'tracker-board-alias-'));
  t.after(() => rmSync(aliasHome, { recursive: true, force: true }));
  const alias = join(aliasHome, 'second-root-link');
  symlinkSync(second, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await post(server.url, alias)).status, 200, 'an alias of a known Root consumed another slot');
});

test('the Root cap admits a registered directory whose entry now aliases the requested Root', async (t) => {
  const original = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const target = tempTracker(t, { 'beta/issues/02-b.md': '# 02 — B\n' });
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(original);
  const server = await serve(board, { port: 0, maxRoots: 1, stopBoardOnClose: false });
  t.after(() => server.close());

  rmSync(original, { recursive: true, force: true });
  symlinkSync(target, original, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal((await post(server.url, target)).status, 200);
  assert.deepEqual(board.roots().map((root) => root.path), [canonicalRootPath(target)]);
});

function post(url: string, path: string): Promise<Response> {
  return fetch(new URL('/roots', url), { method: 'POST', body: JSON.stringify({ path }) });
}

interface SpawnedBoard {
  readonly process: ReturnType<typeof spawn>;
  /** Resolves with the URL the child printed, which is all a launch is allowed to print. */
  readonly url: Promise<string>;
}

/** Run a board in a real child process, the way the invoking agent would. */
function spawnBoard(
  t: { after(fn: () => void): void },
  root: string,
  options: { idleExitMs?: number; watch?: boolean } = {},
): SpawnedBoard {
  const skill = join(import.meta.dirname, '..');
  const script = join(SANDBOX_HOME, `launch-${String(process.hrtime.bigint())}.mjs`);
  writeFileSync(
    script,
    [
      "import { pathToFileURL } from 'node:url';",
      "import { join } from 'node:path';",
      `const skill = ${JSON.stringify(skill)};`,
      "const load = (...p) => import(pathToFileURL(join(skill, ...p)).href);",
      "const { createBoard } = await load('watch', 'board.ts');",
      "const { serve } = await load('server', 'server.ts');",
      `const board = createBoard({ stateDir: ${JSON.stringify(STATE_DIR)}${
        options.watch === true ? '' : ", watchSource: { kind: 'recursive', start: () => ({ stop: () => {}, problem: null }) }"
      } });`,
      `board.register(${JSON.stringify(root)});`,
      `const server = await serve(board, { port: 0${
        options.idleExitMs === undefined ? '' : `, idleExitMs: ${String(options.idleExitMs)}`
      } });`,
      'process.stdout.write(server.url + "\\n");',
    ].join('\n'),
    'utf8',
  );
  t.after(() => rmSync(script, { force: true }));

  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());

  const url = new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no URL after 20s: ${out}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const line = out.split('\n')[0] ?? '';
      if (line.startsWith('http')) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early with ${String(code)}: ${out}`));
    });
  });
  return { process: child, url };
}

test('launch serves when the port is free', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(root);

  const result = await launch(board, { port: 0 });
  assert.equal(result.kind, 'serving');
  if (result.kind !== 'serving') return;
  t.after(() => result.server.close());
  assert.equal((await fetch(new URL('/snapshot', result.url))).status, 200);
});

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

test('the process reaps itself once no client has connected for the idle window', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(root);

  const timers = manualTimers();
  let reaped = 0;
  const server = await serve(board, {
    port: 0,
    timers,
    idleExitMs: DEFAULT_IDLE_EXIT_MS,
    onIdle: () => {
      reaped += 1;
    },
  });
  t.after(() => server.close());

  timers.advance(DEFAULT_IDLE_EXIT_MS - 1);
  assert.equal(reaped, 0, 'the board reaped itself before its idle window elapsed');
  timers.advance(2);
  assert.ok(reaped >= 1, 'the board never reaped itself');
});

test('a connected client holds the process open, and the window restarts when it leaves', async (t) => {
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(root);

  const timers = manualTimers();
  let reaped = 0;
  const server = await serve(board, {
    port: 0,
    timers,
    idleExitMs: DEFAULT_IDLE_EXIT_MS,
    onIdle: () => {
      reaped += 1;
    },
  });
  t.after(() => server.close());

  const controller = new AbortController();
  const stream = await fetch(new URL('/events', server.url), { signal: controller.signal });
  // Aborting rejects the pending read, and an unhandled rejection fails the whole file rather
  // than this assertion — so the rejection is absorbed here, where it is expected.
  void stream.body
    ?.getReader()
    .read()
    .catch(() => {});
  await waitFor(() => server.clientCount() === 1);

  assert.equal(server.idleForMs(), null, 'a connected client must not be counted as idle time');
  timers.advance(DEFAULT_IDLE_EXIT_MS * 2);
  assert.equal(reaped, 0, 'the board reaped itself while a client was watching');

  controller.abort();
  await waitFor(() => server.clientCount() === 0);
  timers.advance(DEFAULT_IDLE_EXIT_MS + 1);
  assert.ok(reaped >= 1, 'the idle window did not restart when the last client left');
});

test('an idle board actually exits, watchers and all', async (t) => {
  // The `onIdle` tests above prove the *clock*. They cannot prove the process leaves, because
  // a Board holding persistent watcher handles keeps Node alive however cleanly the HTTP
  // server closed — which is exactly the shape that makes a reaping board sit there for ever.
  // So this one runs a real child, with a real recursive watcher, and waits for it to go.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const child = spawnBoard(t, root, { idleExitMs: 400, watch: true });
  await child.url;

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the idle board never exited')), 20_000);
    child.process.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 0, 'the idle board exited, but not cleanly');
});

// ---------------------------------------------------------------------------
// Surviving the shell
// ---------------------------------------------------------------------------

test('the server keeps serving after the stream that launched it closes', async (t) => {
  // ADR-0005 leaves *how* to detach to the invoking agent, because that differs by platform.
  // What belongs to this code is not holding the parent open and not dying when its input
  // goes away: a child whose stdin is closed must still answer.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 — A\n' });
  const script = join(SANDBOX_HOME, 'launch-board.mjs');
  const skill = join(import.meta.dirname, '..');
  writeFileSync(
    script,
    [
      "import { pathToFileURL } from 'node:url';",
      "import { join } from 'node:path';",
      `const skill = ${JSON.stringify(skill)};`,
      "const { createBoard } = await import(pathToFileURL(join(skill, 'watch', 'board.ts')).href);",
      "const { serve } = await import(pathToFileURL(join(skill, 'server', 'server.ts')).href);",
      `const board = createBoard({ stateDir: ${JSON.stringify(STATE_DIR)} });`,
      `board.register(${JSON.stringify(root)});`,
      'const server = await serve(board, { port: 0 });',
      'process.stdout.write(server.url + "\\n");',
    ].join('\n'),
    'utf8',
  );
  t.after(() => rmSync(script, { force: true }));

  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());

  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no URL after 20s: ${out}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const line = out.split('\n')[0] ?? '';
      if (line.startsWith('http')) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early with ${String(code)}: ${out}`));
    });
  });

  // Close the child's input, which is what a shell exiting looks like from in here.
  child.stdin.end();
  await settle(300);

  const response = await fetch(new URL('/snapshot', url));
  assert.equal(response.status, 200, 'the board stopped serving when its input closed');
  const snapshot = await response.json();
  assert.equal(snapshot.roots[0].features[0].tickets[0].path, 'alpha/issues/01-a.md');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/** A source that never fires. For tests about HTTP, where changes are noise. */
function idleSource(): ChangeSource {
  return { kind: 'recursive', start: () => ({ stop: () => {}, problem: null }) };
}

async function boardServer(
  t: { after(fn: () => void | Promise<void>): void },
  root: string,
): Promise<{ board: Board; server: BoardServer }> {
  const board = createBoard({ watchSource: idleSource(), stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(root);
  const server = await serve(board, { port: 0, timers: systemTimers });
  t.after(() => server.close());
  return { board, server };
}

/** Read SSE frames while `during` runs. Returns the parsed `data:` payloads, in order. */
async function collectFrames(url: string, during: () => Promise<void>): Promise<unknown[]> {
  const controller = new AbortController();
  const response = await fetch(new URL('/events', url), { signal: controller.signal });
  const reader = response.body?.getReader();
  assert.ok(reader !== undefined, 'the event stream had no body');

  const frames: unknown[] = [];
  let buffer = '';
  const pump = (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block.startsWith('data: ') ? block.slice('data: '.length) : null;
          if (data !== null) frames.push(JSON.parse(data));
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted, which is how this always ends.
    }
  })();

  await during();
  controller.abort();
  await pump;
  return frames;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await settle(10);
  }
}

interface ManualTimers extends Timers {
  readonly advance: (ms: number) => void;
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
  };
}

function tempTracker(
  t: { after(fn: () => void): void },
  files: Readonly<Record<string, string>>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'tracker-board-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relPath, text] of Object.entries(files)) {
    const abs = join(root, '.scratch', ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}
