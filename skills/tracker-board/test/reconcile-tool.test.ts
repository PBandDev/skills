/** The thin state/network adapter around the pure reconciliation boundary. */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';

import { deriveSnapshot } from '../core/index.ts';
import {
  MAX_RECONCILIATION_RESPONSE_BYTES,
  planReconciliation,
  reconcileExtractions,
  type ReconciliationExtraction,
} from '../core/reconciliation.ts';
import type { AnnotationStore, Root, Scan } from '../core/types.ts';
import { readTree } from '../scan/readTree.ts';
import { MAX_RECONCILIATION_REQUEST_BYTES, serve } from '../server/server.ts';
import { readState, SNAPSHOT_FILE, writeAnnotations } from '../state/store.ts';
import {
  applyOnBoard,
  expectedBoardUrl,
  loadResponseFile,
  runReconcileCli,
  type ReconcileEnvironment,
} from '../tools/reconcile.ts';
import { createBoard } from '../watch/board.ts';
import { EMPTY_ANNOTATIONS } from './harness.ts';

const SOURCE = '# 01 — One\n\nStatus: ready-for-agent\n\n- [ ] criterion\n';

test('plan reads every registered Root and emits the independent source manifest', async () => {
  const first = rootOf('first', { 'alpha/issues/01-one.md': SOURCE });
  const second = rootOf('second', { 'beta/issues/02-two.md': '# 02 — Two\n' });
  const harness = fakeEnvironment([first, second]);

  const code = await runReconcileCli(['plan', '--board', expectedBoardUrl()], harness.options);

  assert.equal(code, 0);
  assert.deepEqual(harness.scanned, [[first.path, second.path]]);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.applies.length, 0);
  const plan = JSON.parse(harness.stdout.join(''));
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(
    plan.candidates.map((candidate: { source: string }) => candidate.source).sort(),
    [SOURCE, '# 02 — Two\n'].sort(),
  );
});

test('apply delegates one complete page to the incumbent transaction', async () => {
  const root = rootOf('repo', { 'alpha/issues/01-one.md': SOURCE });
  const scan: Scan = { roots: [root] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const response = responseFor(plan, scan);
  const harness = fakeEnvironment([root], response);

  const code = await runReconcileCli(
    ['apply', '--board', expectedBoardUrl(), '--input', join(root.path, '..', 'response.json')],
    harness.options,
  );

  assert.equal(code, 0);
  assert.equal(harness.boardReads, 1);
  assert.deepEqual(harness.scanned, [], 'apply belongs to the incumbent, not the calling process');
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0]?.entries[0]?.reconciled, true);
  assert.deepEqual(harness.applies, [{ after: null }]);
  assert.deepEqual(JSON.parse(harness.stdout.join('')), {
    schemaVersion: 1,
    accepted: true,
    agreements: 1,
    overrides: 0,
    parserBugs: [],
    rejections: [],
    rejected: 0,
    rejectionsOmitted: 0,
    written: true,
    refreshed: true,
  });
});

test('an invalid model response is surfaced and never written or refreshed', async () => {
  const root = rootOf('repo', { 'alpha/issues/01-one.md': SOURCE });
  const scan: Scan = { roots: [root] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const harness = fakeEnvironment([root], {
    schemaVersion: 1,
    results: [
      {
        candidateId: plan.candidates[0]?.candidateId,
        extraction: { ...extractionFor(scan, plan.candidates[0]?.filePath ?? ''), lane: 'agent' },
      },
    ],
  });

  const code = await runReconcileCli(
    ['apply', '--board', expectedBoardUrl(), '--input', join(root.path, '..', 'response.json')],
    harness.options,
  );

  assert.equal(code, 1);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.applies.length, 1);
  const report = JSON.parse(harness.stdout.join(''));
  assert.equal(report.accepted, false);
  assert.equal(report.rejected, report.rejections.length);
  assert.ok(report.rejections.some((rejection: { field: string }) => rejection.field.endsWith('.lane')));
});

test('an unsafe board or unusable Annotation state aborts before model work', async () => {
  const root = rootOf('repo', { 'alpha/issues/01-one.md': SOURCE });
  for (const change of [
    (environment: ReconcileEnvironment) => ({
      ...environment,
      readBoard: async () => ({
        roots: [root.path],
        scanCount: 1,
        stateIsSafe: false,
        stateWriteProblem: 'inside-root',
      }),
    }),
    (environment: ReconcileEnvironment) => ({
      ...environment,
      loadAnnotations: () => ({
        store: EMPTY_ANNOTATIONS,
        problem: 'the Annotation state is malformed',
      }),
    }),
  ]) {
    const harness = fakeEnvironment([root]);
    const code = await runReconcileCli(
      ['plan', '--board', expectedBoardUrl()],
      { ...harness.options, environment: change(harness.options.environment) },
    );
    assert.equal(code, 1);
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.applies.length, 0);
    assert.ok(harness.stderr.join('').length > 0);
  }
});

test('a state write failure does not claim success or refresh the board', async () => {
  const root = rootOf('repo', { 'alpha/issues/01-one.md': SOURCE });
  const scan: Scan = { roots: [root] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const harness = fakeEnvironment([root], responseFor(plan, scan));
  harness.options.environment.applyBoard = async () => ({
    schemaVersion: 1,
    accepted: true,
    agreements: 1,
    overrides: 0,
    parserBugs: [],
    rejected: 0,
    rejectionsOmitted: 0,
    rejections: [],
    written: false,
    refreshed: false,
    writeProblem: 'write-failed',
  });

  const code = await runReconcileCli(
    ['apply', '--board', expectedBoardUrl(), '--input', join(root.path, '..', 'response.json')],
    harness.options,
  );

  assert.equal(code, 1);
  assert.equal(harness.applies.length, 0);
  const report = JSON.parse(harness.stdout.join(''));
  assert.equal(report.written, false);
  assert.equal(report.refreshed, false);
  assert.equal(report.writeProblem, 'write-failed');
});

test('later pages pass one opaque cursor through plan and incumbent apply', async () => {
  const root = rootOf('repo', { 'alpha/issues/01-one.md': SOURCE });
  const scan: Scan = { roots: [root] };
  const cursor = '0'.repeat(64);
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS, cursor);
  const harness = fakeEnvironment([root], responseFor(plan, scan));

  const code = await runReconcileCli(
    [
      'apply',
      '--board',
      expectedBoardUrl(),
      '--input',
      join(root.path, '..', 'response.json'),
      '--after',
      cursor,
    ],
    harness.options,
  );

  assert.equal(code, 0);
  assert.deepEqual(harness.applies, [{ after: cursor }]);
});

test('an empty steady-state pass performs no write and no refresh', async () => {
  const root = rootOf('repo', { 'alpha/issues/01-one.md': SOURCE });
  const scan: Scan = { roots: [root] };
  const firstPlan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const first = await import('../core/reconciliation.ts').then(({ reconcileExtractions }) =>
    reconcileExtractions(scan, EMPTY_ANNOTATIONS, responseFor(firstPlan, scan)),
  );
  const harness = fakeEnvironment([root], { schemaVersion: 1, results: [] }, first.store);

  const code = await runReconcileCli(
    ['apply', '--board', expectedBoardUrl(), '--input', join(root.path, '..', 'response.json')],
    harness.options,
  );

  assert.equal(code, 0);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.applies.length, 1);
  const report = JSON.parse(harness.stdout.join(''));
  assert.equal(report.written, false);
  assert.equal(report.refreshed, false);
});

test('the real refresh path reloads a written Annotation into one fresh Snapshot', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const stateDir = join(outer, 'state');
  const issue = join(root, '.scratch', 'alpha', 'issues', '01-one.md');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  writeFileSync(issue, SOURCE, 'utf8');

  const board = createBoard({ stateDir, persist: true });
  board.register(root);
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());
  const scan: Scan = { roots: [readTree(root)] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const extraction = extractionFor(scan, plan.candidates[0]?.filePath ?? '');
  const response = {
    schemaVersion: 1,
    results: [
      {
        candidateId: plan.candidates[0]?.candidateId,
        extraction: { ...extraction, title: 'Independent title' },
      },
    ],
  };
  const before = board.lastScan()?.scanCount ?? 0;

  const applied = await applyOnBoard(server.url, response, null);

  assert.equal(applied.written, true);
  assert.equal(applied.refreshed, true);
  const card = board
    .snapshot()
    .roots.flatMap((candidate) => candidate.features)
    .flatMap((feature) => feature.tickets)[0];
  assert.equal(card?.extraction.title, 'Independent title');
  assert.deepEqual(card?.derivation.correctedFields, ['title']);
  assert.equal(board.lastScan()?.scanCount, before + 1);
});

test('an invisible agreement write still publishes and persists one fresh Snapshot', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-agreement-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const stateDir = join(outer, 'state');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-one.md'), SOURCE, 'utf8');
  const board = createBoard({ stateDir, persist: true });
  board.register(root);
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());
  const scan: Scan = { roots: [readTree(root)] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const snapshotPath = join(stateDir, SNAPSHOT_FILE);
  const oldTime = new Date(1_000);
  utimesSync(snapshotPath, oldTime, oldTime);
  let frames = 0;
  const unsubscribe = board.subscribe(() => {
    frames += 1;
  });
  t.after(unsubscribe);

  const applied = await applyOnBoard(server.url, responseFor(plan, scan), null);

  assert.equal(applied.written, true);
  assert.equal(applied.refreshed, true);
  assert.equal(frames, 1);
  assert.equal(board.lastScan()?.changed, false);
  assert.ok(statSync(snapshotPath).mtimeMs > oldTime.getTime());
});

test('repeating unchanged parser-bug evidence performs no incumbent write or refresh', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-parser-bug-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const stateDir = join(outer, 'state');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  for (let ticket = 1; ticket <= 3; ticket += 1) {
    writeFileSync(
      join(root, '.scratch', 'alpha', 'issues', `0${String(ticket)}-ticket.md`),
      `# 0${String(ticket)} — Ticket\n`,
      'utf8',
    );
  }
  const board = createBoard({ stateDir, persist: true });
  board.register(root);
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());
  const scan: Scan = { roots: [readTree(root)] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const response = {
    schemaVersion: 1,
    results: plan.candidates.map((candidate, at) => ({
      candidateId: candidate.candidateId,
      extraction: {
        ...extractionFor(scan, candidate.filePath),
        title: `Independent ${String(at + 1)}`,
      },
    })),
  };
  assert.equal((await applyOnBoard(server.url, response, null)).written, true);
  let frames = 0;
  const unsubscribe = board.subscribe(() => {
    frames += 1;
  });
  t.after(unsubscribe);

  const repeated = await applyOnBoard(server.url, response, null);

  assert.equal(repeated.accepted, true);
  assert.equal(repeated.written, false);
  assert.equal(repeated.refreshed, false);
  assert.equal(frames, 0);
});

test('two simultaneous incumbent applies serialize without losing the committed receipt', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-race-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const stateDir = join(outer, 'state');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-one.md'), SOURCE, 'utf8');
  const board = createBoard({ stateDir, persist: true });
  board.register(root);
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());
  const scan: Scan = { roots: [readTree(root)] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const response = responseFor(plan, scan);

  const results = await Promise.all([
    applyOnBoard(server.url, response, null),
    applyOnBoard(server.url, response, null),
  ]);

  assert.equal(results.filter((result) => result.written).length, 1);
  assert.equal(results.filter((result) => !result.accepted).length, 1);
  assert.equal(readState(stateDir).annotations.entries.length, 1);
});

test('incumbent apply fresh-loads and preserves Annotation state written after planning', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-merge-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const stateDir = join(outer, 'state');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-one.md'), SOURCE, 'utf8');
  const board = createBoard({ stateDir, persist: true });
  board.register(root);
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());
  const scan: Scan = { roots: [readTree(root)] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const concurrent = {
    schemaVersion: 1,
    entries: [{ schemaVersion: 1, filePath: 'other#digest', contentSha: 'current' }],
  } satisfies AnnotationStore;
  assert.equal(writeAnnotations(concurrent, stateDir, [root]).written, true);

  const result = await applyOnBoard(server.url, responseFor(plan, scan), null);

  assert.equal(result.written, true);
  assert.ok(
    readState(stateDir).annotations.entries.some((entry) => entry.filePath === 'other#digest'),
  );
});

test('a Root accreted before incumbent apply participates in the live containment refusal', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-root-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const stateDir = join(outer, 'state');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-one.md'), SOURCE, 'utf8');
  const board = createBoard({ stateDir });
  board.register(root);
  const scan: Scan = { roots: [readTree(root)] };
  const response = responseFor(planReconciliation(scan, EMPTY_ANNOTATIONS), scan);
  board.register(outer);
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());

  await assert.rejects(
    applyOnBoard(server.url, response, null),
    /incumbent refused the Reconciliation commit/,
  );
  assert.deepEqual(readState(stateDir).annotations.entries, []);
});

test('a failed post-commit Snapshot write never reports a successful refresh', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-refresh-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const stateDir = join(outer, 'state');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-one.md'), SOURCE, 'utf8');
  const board = createBoard({ stateDir, persist: true });
  board.register(root);
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());
  const scan: Scan = { roots: [readTree(root)] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const extraction = extractionFor(scan, plan.candidates[0]?.filePath ?? '');
  rmSync(join(stateDir, SNAPSHOT_FILE), { force: true });
  mkdirSync(join(stateDir, SNAPSHOT_FILE));

  const result = await applyOnBoard(
    server.url,
    {
      schemaVersion: 1,
      results: [
        {
          candidateId: plan.candidates[0]?.candidateId,
          extraction: { ...extraction, title: 'Independent title' },
        },
      ],
    },
    null,
  );

  assert.equal(result.written, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.writeProblem, 'write-failed');
});

test('response-file failures are fixed diagnostics that never echo private JSON', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-input-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = 'PRIVATE_RESPONSE_SENTINEL';
  const malformed = join(dir, 'response.json');
  const invalidUtf8 = join(dir, 'invalid-utf8.json');
  writeFileSync(malformed, `{${sentinel}`, 'utf8');
  writeFileSync(
    invalidUtf8,
    Buffer.concat([Buffer.from('{"private":"'), Buffer.from([0xff]), Buffer.from('"}')]),
  );
  if (process.platform !== 'win32') chmodSync(malformed, 0o600);
  if (process.platform !== 'win32') chmodSync(invalidUtf8, 0o600);

  assert.throws(
    () => loadResponseFile(malformed, []),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'the response file is not valid JSON' &&
      !error.message.includes(sentinel),
  );
  assert.throws(
    () => loadResponseFile(dir, []),
    /response path is not one private regular file/,
  );
  assert.throws(
    () => loadResponseFile(invalidUtf8, []),
    /response file is not valid JSON/,
  );
});

test('response files are confined, private, singular, and byte bounded', (t) => {
  const privateTemp = mkdtempSync(join(tmpdir(), 'tracker-board-response-guards-'));
  const watchedRoot = mkdtempSync(join(tmpdir(), 'tracker-board-response-root-'));
  const outsideTemp = mkdtempSync(join(process.cwd(), '.tracker-board-response-outside-'));
  t.after(() => rmSync(privateTemp, { recursive: true, force: true }));
  t.after(() => rmSync(watchedRoot, { recursive: true, force: true }));
  t.after(() => rmSync(outsideTemp, { recursive: true, force: true }));
  const outside = join(outsideTemp, 'response.json');
  const watched = join(watchedRoot, 'response.json');
  const oversized = join(privateTemp, 'oversized.json');
  const linked = join(privateTemp, 'linked.json');
  const alias = join(privateTemp, 'linked-alias.json');
  writeFileSync(outside, '{}', 'utf8');
  writeFileSync(watched, '{}', 'utf8');
  writeFileSync(oversized, Buffer.alloc(MAX_RECONCILIATION_RESPONSE_BYTES + 1, 0x20));
  writeFileSync(linked, '{}', 'utf8');
  linkSync(linked, alias);
  if (process.platform !== 'win32') {
    for (const path of [outside, watched, oversized, linked, alias]) chmodSync(path, 0o600);
  }

  const fromTemp = relative(tmpdir(), outside);
  if (fromTemp === '' || (!fromTemp.startsWith('..') && !isAbsolute(fromTemp))) {
    // An installed-copy test may unpack the whole checkout beneath the platform temp directory.
    // That environment has no checkout-local path with which to exercise this one refusal branch.
    assert.deepEqual(loadResponseFile(outside, []), {});
  } else {
    assert.throws(
      () => loadResponseFile(outside, []),
      /response file is not inside the platform temporary directory/,
    );
  }
  assert.throws(
    () => loadResponseFile(watched, [watchedRoot]),
    /response file is inside a watched Root/,
  );
  assert.throws(
    () => loadResponseFile(oversized, []),
    /response file exceeded its byte limit/,
  );
  assert.throws(
    () => loadResponseFile(linked, []),
    /response path is not one private regular file/,
  );
});

test(
  'response files and their directory are owner-only on POSIX',
  { skip: process.platform === 'win32' },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-board-response-mode-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const response = join(dir, 'response.json');
    writeFileSync(response, '{}', 'utf8');
    chmodSync(response, 0o644);
    assert.throws(
      () => loadResponseFile(response, []),
      /response file or directory is not restricted to its owner/,
    );
    chmodSync(response, 0o600);
    chmodSync(dir, 0o755);
    assert.throws(
      () => loadResponseFile(response, []),
      /response file or directory is not restricted to its owner/,
    );
  },
);

test('malformed private request JSON is not echoed and does not poison the incumbent', async (t) => {
  const outer = mkdtempSync(join(tmpdir(), 'tracker-board-reconcile-json-'));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, 'repo');
  const stateDir = join(outer, 'state');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  writeFileSync(join(root, '.scratch', 'alpha', 'issues', '01-one.md'), SOURCE, 'utf8');
  const board = createBoard({ stateDir });
  board.register(root);
  const server = await serve(board, { port: 0 });
  t.after(() => server.close());
  const sentinel = 'PRIVATE_REQUEST_SENTINEL';
  const scan: Scan = { roots: [readTree(root)] };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const extraction = extractionFor(scan, plan.candidates[0]?.filePath ?? '');

  const malformed = await fetch(new URL('/reconcile', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{${sentinel}`,
  });
  const diagnostic = await malformed.text();
  assert.equal(malformed.status, 400);
  assert.ok(!diagnostic.includes(sentinel));

  const placeholder = 'INVALID_UTF8_SLOT';
  const encoded = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      after: null,
      response: {
        schemaVersion: 1,
        results: [
          {
            candidateId: plan.candidates[0]?.candidateId,
            extraction: { ...extraction, title: placeholder },
          },
        ],
      },
    }),
  );
  const placeholderAt = encoded.indexOf(placeholder);
  assert.ok(placeholderAt >= 0);
  const invalidUtf8 = await fetch(new URL('/reconcile', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.concat([
      encoded.subarray(0, placeholderAt),
      Buffer.from([0xff]),
      encoded.subarray(placeholderAt + Buffer.byteLength(placeholder)),
    ]),
  });
  assert.equal(invalidUtf8.status, 400);
  assert.equal(await invalidUtf8.text(), '{"error":"invalid Reconciliation request JSON"}');

  const oversized = await fetch(new URL('/reconcile', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.alloc(MAX_RECONCILIATION_REQUEST_BYTES + 1, 0x20),
  });
  assert.equal(oversized.status, 413);
  await oversized.body?.cancel();

  await abortReconciliationRequest(server.port);

  assert.equal((await applyOnBoard(server.url, responseFor(plan, scan), null)).written, true);
});

function abortReconciliationRequest(port: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolve();
    };
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/reconcile',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': MAX_RECONCILIATION_REQUEST_BYTES,
      },
    });
    request.on('error', finish);
    request.on('close', finish);
    request.flushHeaders();
    request.write('{"schemaVersion":1');
    setTimeout(() => request.destroy(), 10);
  });
}

function fakeEnvironment(
  roots: readonly Root[],
  response: unknown = null,
  store: AnnotationStore = EMPTY_ANNOTATIONS,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writes: AnnotationStore[] = [];
  const applies: { after: string | null }[] = [];
  const scanned: string[][] = [];
  let boardReads = 0;

  const environment: ReconcileEnvironment = {
    async readBoard() {
      boardReads += 1;
      return {
        roots: roots.map((root) => root.path),
        scanCount: 1,
        stateIsSafe: true,
        stateWriteProblem: null,
      };
    },
    scan(rootPaths) {
      scanned.push([...rootPaths]);
      return { roots: rootPaths.map((path) => roots.find((root) => root.path === path) as Root) };
    },
    loadAnnotations() {
      return { store, problem: null };
    },
    loadResponse() {
      return response;
    },
    async applyBoard(_url, candidateResponse, after) {
      applies.push({ after });
      const reconciled = reconcileExtractions(
        { roots },
        store,
        candidateResponse,
        after,
      );
      const written = reconciled.report.accepted && reconciled.store !== store;
      if (written) writes.push(reconciled.store);
      return {
        schemaVersion: 1,
        ...reconciled.report,
        written,
        refreshed: written,
      };
    },
  };
  const options = {
    environment,
    writeOut: (text: string) => stdout.push(text),
    writeError: (text: string) => stderr.push(text),
  };
  return {
    options,
    stdout,
    stderr,
    writes,
    applies,
    scanned,
    get boardReads() {
      return boardReads;
    },
  };
}

function responseFor(plan: ReturnType<typeof planReconciliation>, scan: Scan): object {
  return {
    schemaVersion: 1,
    results: plan.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      extraction: extractionFor(scan, candidate.filePath),
    })),
  };
}

function extractionFor(scan: Scan, id: string): ReconciliationExtraction {
  const card = scan.roots
    .flatMap((root) => root.files)
    .find((file) => id.endsWith(`#${file.path}`));
  assert.ok(typeof card?.text === 'string');
  const snapshot = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const ticket = snapshot.roots
    .flatMap((root) => root.features)
    .flatMap((feature) => feature.tickets)
    .find((candidate) => candidate.id === id);
  assert.ok(ticket !== undefined);
  return {
    title: ticket.extraction.title,
    criteria: {
      checked: ticket.extraction.criteria.checked,
      total: ticket.extraction.criteria.total,
    },
    blockedBy: [...ticket.extraction.blockedBy],
    externalBlocker: ticket.extraction.externalBlocker,
    rawStatus: ticket.extraction.rawStatus,
    ticketType: ticket.extraction.ticketType,
    dialect: ticket.extraction.dialect,
  };
}

function rootOf(label: string, files: Readonly<Record<string, string>>): Root {
  const path = join(import.meta.dirname, '..', '..', '..', `.tmp-${label}`);
  return {
    path,
    label,
    trackerPath: join(path, '.scratch'),
    files: Object.entries(files).map(([filePath, text]) => ({
      path: filePath,
      absPath: join(path, '.scratch', ...filePath.split('/')),
      text,
    })),
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
}
