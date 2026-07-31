/** The platform-neutral launcher that the skill asks each shell to detach. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('the Node floor follows the release lines that enable type stripping by default', async () => {
  const { nodeMeetsFloor } = await launcher();
  for (const version of ['21.99.0', '22.17.9', '22.18.0-rc.1', '23.0.0', '23.5.9', 'not-a-version']) {
    assert.equal(nodeMeetsFloor(version), false, version);
  }
  for (const version of ['22.18.0', '22.23.1', '23.6.0', '24.0.0']) {
    assert.equal(nodeMeetsFloor(version), true, version);
  }
});

test('an old Node is rejected plainly before any TypeScript module is loaded', async () => {
  const { runLauncher } = await launcher();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let loads = 0;
  const code = await runLauncher({
    nodeVersion: '22.17.9',
    loadRuntime: async () => {
      loads += 1;
      throw new Error('the TypeScript loader must not run');
    },
    writeOut: (text: string) => stdout.push(text),
    writeError: (text: string) => stderr.push(text),
  });

  assert.equal(code, 1);
  assert.equal(loads, 0);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, ['tracker-board requires Node 22.18 or newer.\n']);
});

test('Node 23 before 23.6 is rejected with its actual release-line floor', async () => {
  const { runLauncher } = await launcher();
  for (const nodeVersion of ['23.5.0', '23.6.0-rc.1']) {
    const stderr: string[] = [];
    const code = await runLauncher({
      nodeVersion,
      loadRuntime: async () => assert.fail('the TypeScript loader must not run'),
      writeOut: () => assert.fail('an unsupported runtime must not print success'),
      writeError: (text: string) => stderr.push(text),
    });

    assert.equal(code, 1, nodeVersion);
    assert.deepEqual(
      stderr,
      ['tracker-board requires Node 23.6 or newer on the Node 23 release line.\n'],
      nodeVersion,
    );
  }
});

test('the command-line entrypoint still runs through a linked install path', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'tracker-board-linked-launch-'));
  const linkedSkill = join(sandbox, 'installed skill path with spaces');
  symlinkSync(resolve(import.meta.dirname, '..'), linkedSkill, process.platform === 'win32' ? 'junction' : 'dir');
  test.after(() => rmSync(sandbox, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [join(linkedSkill, 'server', 'launch.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'tracker-board requires exactly one absolute Root path and no port argument.\n');
});

test('the command line refuses an extra argument instead of treating it as another port', async () => {
  const { runLauncher } = await launcher();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runLauncher({
    nodeVersion: '22.18.0',
    args: [resolve(import.meta.dirname, 'synthetic-root'), '9999'],
    loadRuntime: async () => assert.fail('invalid command-line arguments must not load the runtime'),
    writeOut: (text: string) => stdout.push(text),
    writeError: (text: string) => stderr.push(text),
  });

  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, ['tracker-board requires exactly one absolute Root path and no port argument.\n']);
});

test('the first launch applies the same bounded Root contract as singleton handoff', async () => {
  const { runLauncher } = await launcher();
  const prefix = `${resolve(import.meta.dirname, 'synthetic-root')}-`;
  const invalidRoots = [
    `${prefix}line\nbreak`,
    `${prefix}${String.fromCharCode(0x85)}control`,
    prefix + 'p'.repeat(48 * 1024 + 1),
  ];

  for (const root of invalidRoots) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runLauncher({
      nodeVersion: '22.18.0',
      args: [root],
      loadRuntime: async () => assert.fail('an invalid Root must not load the runtime'),
      writeOut: (text: string) => stdout.push(text),
      writeError: (text: string) => stderr.push(text),
    });

    assert.equal(code, 1);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, ['tracker-board requires exactly one absolute Root path and no port argument.\n']);
  }
});

test('a Root registration failure is printed with exactly one terminal mark', async () => {
  const { runLauncher } = await launcher();
  const stderr: string[] = [];
  const root = resolve(import.meta.dirname, 'missing-root');
  const code = await runLauncher({
    nodeVersion: '22.18.0',
    args: [root],
    loadRuntime: async () => ({
      createBoard: () => ({
        register: () => {
          throw new TypeError('Root must name an existing directory.');
        },
        stateWriteProblem: () => null,
        stop: () => {},
      }),
      boardAsset: () => null,
      defaultPort: 4317,
      launch: async () => assert.fail('a rejected Root must not launch a server'),
    }),
    writeOut: () => assert.fail('a rejected Root must not print success'),
    writeError: (text: string) => stderr.push(text),
  });

  assert.equal(code, 1);
  assert.deepEqual(stderr, ['tracker-board could not start: Root must name an existing directory.\n']);
});

test('the production runtime persists its Snapshot outside the watched Root', async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'tracker-board-production-runtime-'));
  const platformHome = join(sandbox, 'platform-home');
  const root = join(sandbox, 'watched-root');
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  mkdirSync(platformHome);
  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-a.md'), '# 01 - A\n');

  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = platformHome;
  process.env.USERPROFILE = platformHome;
  let board: { stop(): void } | null = null;
  t.after(() => {
    board?.stop();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    rmSync(sandbox, { recursive: true, force: true });
  });

  const { defaultRuntime } = await launcher();
  const runtime = await defaultRuntime();
  const runtimeBoard = runtime.createBoard();
  board = runtimeBoard;
  runtimeBoard.register(root);

  const snapshotPath = join(platformHome, '.tracker-board', 'snapshot.json');
  assert.ok(existsSync(snapshotPath), 'production registration did not persist the code-owned Snapshot');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(snapshot.roots.map((candidate: { path: string }) => candidate.path), [root]);
  assert.equal(existsSync(join(root, '.tracker-board')), false, 'runtime state was written into the watched Root');
});

test('the detacher applies the same Node preflight before it can spawn', async () => {
  const { runDetacher } = await detacher();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runDetacher({
    nodeVersion: '23.5.0',
    args: [],
    writeOut: (text: string) => stdout.push(text),
    writeError: (text: string) => stderr.push(text),
  });

  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, ['tracker-board requires Node 23.6 or newer on the Node 23 release line.\n']);
});

test('the detacher reports an asynchronous spawn failure without an unhandled error', async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'tracker-board-detach-failure-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    unref: () => assert.fail('a child that never spawned cannot be detached'),
  });
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await (await detacher()).runDetacher({
    nodeVersion: '22.18.0',
    args: [
      join(sandbox, 'launch.mjs'),
      join(sandbox, 'root'),
      join(sandbox, 'board.out'),
      join(sandbox, 'board.err'),
    ],
    spawnChild: () => {
      queueMicrotask(() => child.emit('error', new Error('spawn resources exhausted')));
      return child;
    },
    writeOut: (text: string) => stdout.push(text),
    writeError: (text: string) => stderr.push(text),
  });

  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, ['tracker-board could not detach: spawn resources exhausted.\n']);
});

test('the detacher exits while its child keeps direct output handles', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'tracker-board-detach-'));
  const childFile = join(sandbox, 'child script with spaces.mjs');
  const root = join(sandbox, 'repository root with spaces');
  const stdoutPath = join(sandbox, 'child.out');
  const stderrPath = join(sandbox, 'child.err');
  let childPid: number | null = null;
  mkdirSync(root);
  writeFileSync(childFile, "process.stdout.write(`${process.argv[2]}\\n`); setInterval(() => {}, 1_000);\n");
  test.after(() => {
    if (childPid !== null) {
      try {
        process.kill(childPid);
      } catch {
        // It already exited; cleanup has nothing left to stop.
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, '..', 'server', 'detach.mjs'), childFile, root, stdoutPath, stderrPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  childPid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0, result.stdout);

  await eventually(() => readFileSync(stdoutPath, 'utf8') === `${root}\n`);
  assert.doesNotThrow(() => process.kill(childPid as number, 0));
  assert.equal(readFileSync(stderrPath, 'utf8'), '');
});

test('a launch registers one absolute Root, fixes the default port, and prints only the URL', async () => {
  const { runLauncher } = await launcher();
  const root = resolve(import.meta.dirname, 'synthetic-root');
  const url = ['http', '://', '127.0.0.1:4317/'].join('');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const registered: string[] = [];
  const asset = () => null;
  let launchOptions: Record<string, unknown> | null = null;

  const code = await runLauncher({
    nodeVersion: '22.18.0',
    root,
    loadRuntime: async () => ({
      createBoard: () => ({
        register: (path: string) => registered.push(path),
        stateWriteProblem: () => null,
        stop: () => {},
      }),
      boardAsset: asset,
      defaultPort: 4317,
      launch: async (_board: unknown, options: Record<string, unknown>) => {
        launchOptions = options;
        return { kind: 'serving', url };
      },
    }),
    writeOut: (text: string) => stdout.push(text),
    writeError: (text: string) => stderr.push(text),
  });

  assert.equal(code, 0);
  assert.deepEqual(registered, [root]);
  assert.deepEqual(stdout, [`${url}\n`]);
  assert.deepEqual(stderr, []);
  assert.deepEqual(launchOptions, { asset });
  assert.ok(!Object.hasOwn(launchOptions ?? {}, 'port'), 'the public launcher exposed a second-port choice');
});

test('a refused Root handoff is a failure and never prints a misleading board URL', async () => {
  const { runLauncher } = await launcher();
  const root = resolve(import.meta.dirname, 'other-root');
  const url = ['http', '://', '127.0.0.1:4317/'].join('');
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await runLauncher({
    nodeVersion: '22.23.1',
    root,
    loadRuntime: async () => ({
      createBoard: () => ({ register: () => {}, stateWriteProblem: () => null, stop: () => {} }),
      boardAsset: () => null,
      defaultPort: 4317,
      launch: async () => ({ kind: 'already-serving', url, handedOver: [], refused: [root] }),
    }),
    writeOut: (text: string) => stdout.push(text),
    writeError: (text: string) => stderr.push(text),
  });

  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0] ?? '', /fixed port 4317[\s\S]*refused the Root/i);
});

async function launcher(): Promise<typeof import('../server/launch.mjs')> {
  return import('../server/launch.mjs');
}

async function detacher(): Promise<typeof import('../server/detach.mjs')> {
  return import('../server/detach.mjs');
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // The child may not have created the file yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.fail('the detached child did not publish its output in time');
}
