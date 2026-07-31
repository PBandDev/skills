/**
 * Portable command adapter for the standing reconciliation pass.
 *
 * `plan` obtains the incumbent board's canonical Roots, scans them, and prints one bounded
 * changed-file page. `apply` safely reads a complete model response and delegates the synchronous
 * re-scan/merge/write/refresh transaction to the incumbent. The board URL is accepted only in its
 * one fixed loopback shape.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  MAX_RECONCILIATION_RESPONSE_BYTES,
  planReconciliation,
} from '../core/reconciliation.ts';
import type { AnnotationStore, Scan } from '../core/types.ts';
import { readTree } from '../scan/readTree.ts';
import { isMain, messageOf, rootArgumentIsValid } from '../server/entrypoint.mjs';
import {
  DEFAULT_HANDOFF_TIMEOUT_MS,
  DEFAULT_MAX_ROOTS,
  DEFAULT_PORT,
  HOST,
  MAX_HANDOFF_RESPONSE_BYTES,
  MAX_RECONCILIATION_REQUEST_BYTES,
} from '../server/server.ts';
import {
  ANNOTATIONS_FILE,
  canonicalPath,
  isInside,
  readState,
} from '../state/store.ts';

const SCHEMA_VERSION = 1;
const RECONCILIATION_APPLY_TIMEOUT_MS = 30_000;
const RECONCILIATION_REPORT_LIMIT_BYTES = 8 * 1024 * 1024;
const HTTP_PREFIX = 'http' + '://';

export interface BoardStatus {
  readonly roots: readonly string[];
  readonly scanCount: number;
  readonly stateIsSafe: boolean;
  readonly stateWriteProblem: string | null;
}

export interface AnnotationLoad {
  readonly store: AnnotationStore;
  readonly problem: string | null;
}

export interface ReconcileEnvironment {
  readBoard(url: string): Promise<BoardStatus>;
  scan(rootPaths: readonly string[]): Scan;
  loadAnnotations(rootPaths: readonly string[]): AnnotationLoad;
  loadResponse(path: string, rootPaths: readonly string[]): unknown;
  applyBoard(url: string, response: unknown, after: string | null): Promise<ApplyOutput>;
}

export interface ReconcileCliOptions {
  readonly environment?: ReconcileEnvironment;
  readonly writeOut?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

export interface ApplyOutput {
  readonly schemaVersion: 1;
  readonly accepted: boolean;
  readonly agreements: number;
  readonly overrides: number;
  readonly parserBugs: readonly unknown[];
  readonly rejected: number;
  readonly rejectionsOmitted: number;
  readonly rejections: readonly unknown[];
  readonly written: boolean;
  readonly refreshed: boolean;
  readonly writeProblem?: string;
}

/** The one URL shape the launcher prints. Built in fragments so shipped source has no literal URL. */
export function expectedBoardUrl(): string {
  return `${HTTP_PREFIX}${HOST}:${String(DEFAULT_PORT)}/`;
}

/** Run a bounded plan page or apply that page through the incumbent board. */
export async function runReconcileCli(
  args: readonly string[],
  options: ReconcileCliOptions = {},
): Promise<number> {
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text: string) => process.stderr.write(text));
  const environment = options.environment ?? DEFAULT_ENVIRONMENT;
  const parsed = parseArgs(args);
  if (parsed === null) {
    writeError(
      'tracker-board reconciliation expects `plan --board <launcher-url>` or ' +
        '`apply --board <launcher-url> --input <absolute-json-path>`; append ' +
        '`--after <cursor>` to both commands for a later page.\n',
    );
    return 1;
  }
  if (!boardUrlIsExpected(parsed.boardUrl)) {
    writeError('tracker-board reconciliation accepts only the fixed loopback board URL.\n');
    return 1;
  }

  try {
    const board = await environment.readBoard(parsed.boardUrl);
    const boardProblem = unusableBoard(board);
    if (boardProblem !== null) throw new Error(boardProblem);

    if (parsed.command === 'plan') {
      const scan = environment.scan(board.roots);
      const loaded = environment.loadAnnotations(board.roots);
      if (loaded.problem !== null) throw new Error(loaded.problem);
      writeJson(writeOut, planReconciliation(scan, loaded.store, parsed.after));
      return 0;
    }

    const response = environment.loadResponse(parsed.input, board.roots);
    const applied = await environment.applyBoard(parsed.boardUrl, response, parsed.after);
    writeJson(writeOut, applied);
    if (!applied.accepted || applied.writeProblem !== undefined) return 1;
    return !applied.written || applied.refreshed ? 0 : 1;
  } catch (error) {
    writeError(`tracker-board reconciliation failed: ${messageOf(error)}\n`);
    return 1;
  }
}

type ParsedArgs =
  | { readonly command: 'plan'; readonly boardUrl: string; readonly after: string | null }
  | {
      readonly command: 'apply';
      readonly boardUrl: string;
      readonly input: string;
      readonly after: string | null;
    };

function parseArgs(args: readonly string[]): ParsedArgs | null {
  if (
    (args.length === 3 || args.length === 5) &&
    args[0] === 'plan' &&
    args[1] === '--board'
  ) {
    const after = readAfter(args.slice(3));
    return after === undefined
      ? null
      : { command: 'plan', boardUrl: args[2] ?? '', after };
  }
  if (
    (args.length === 5 || args.length === 7) &&
    args[0] === 'apply' &&
    args[1] === '--board' &&
    args[3] === '--input'
  ) {
    const after = readAfter(args.slice(5));
    return after === undefined
      ? null
      : { command: 'apply', boardUrl: args[2] ?? '', input: args[4] ?? '', after };
  }
  return null;
}

function readAfter(args: readonly string[]): string | null | undefined {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--after' || !/^[a-f0-9]{64}$/.test(args[1] ?? '')) {
    return undefined;
  }
  return args[1] as string;
}

function boardUrlIsExpected(value: string): boolean {
  try {
    return new URL(value).href === expectedBoardUrl();
  } catch {
    return false;
  }
}

function unusableBoard(board: BoardStatus): string | null {
  if (!board.stateIsSafe) return 'the incumbent reports that its state directory is unsafe';
  if (board.stateWriteProblem !== null) {
    return `the incumbent reports a ${board.stateWriteProblem} state write problem`;
  }
  if (board.roots.length === 0) return 'the incumbent reports no registered Roots';
  if (!Number.isSafeInteger(board.scanCount) || board.scanCount < 0) {
    return 'the incumbent reports no valid scan count';
  }
  return null;
}

function writeJson(write: (text: string) => void, value: object): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

const DEFAULT_ENVIRONMENT: ReconcileEnvironment = {
  readBoard: readBoardStatus,
  scan(rootPaths) {
    return { roots: rootPaths.map((path) => readTree(path)) };
  },
  loadAnnotations() {
    const state = readState();
    const annotationFile = join(state.dir, ANNOTATIONS_FILE);
    const problems = state.problems.filter(
      (problem) => canonicalPath(problem.file) === canonicalPath(annotationFile),
    );
    const unusable = problems.find(
      (problem) =>
        problem.kind !== 'absent' &&
        !(problem.kind === 'schema' && state.droppedForVersion > 0),
    );
    return {
      store: state.annotations,
      problem:
        unusable === undefined
          ? null
          : `the Annotation state is ${unusable.kind}; it was not overwritten`,
    };
  },
  loadResponse(path, rootPaths) {
    return loadResponseFile(path, rootPaths);
  },
  applyBoard(url, response, after) {
    return applyOnBoard(url, response, after);
  },
};

async function readBoardStatus(url: string): Promise<BoardStatus> {
  const response = await fetch(new URL('/health', url), {
    redirect: 'error',
    signal: AbortSignal.timeout(DEFAULT_HANDOFF_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('the incumbent refused its health request');
  }
  const value = await readBoundedResponse(response, MAX_HANDOFF_RESPONSE_BYTES);
  if (!isRecord(value)) throw new Error('the incumbent returned malformed health data');

  const rawRoots = value['roots'];
  if (!Array.isArray(rawRoots) || rawRoots.length === 0 || rawRoots.length > DEFAULT_MAX_ROOTS) {
    throw new Error('the incumbent returned an invalid Roots list');
  }
  const roots: string[] = [];
  for (const raw of rawRoots) {
    const path = isRecord(raw) ? raw['path'] : null;
    if (!rootArgumentIsValid(path)) throw new Error('the incumbent returned an invalid Root');
    let canonical: string;
    try {
      canonical = canonicalPath(path);
    } catch {
      throw new Error('the incumbent returned an unavailable Root');
    }
    if (canonical !== path || roots.includes(path)) {
      throw new Error('the incumbent returned a non-canonical or duplicate Root');
    }
    roots.push(path);
  }

  const lastScan = value['lastScan'];
  const scanCount = isRecord(lastScan) ? lastScan['scanCount'] : null;
  const stateIsSafe = value['stateIsSafe'];
  const rawProblem = value['stateWriteProblem'];
  const stateWriteProblem = rawProblem === null
    ? null
    : isRecord(rawProblem) && typeof rawProblem['kind'] === 'string'
      ? rawProblem['kind']
      : undefined;
  if (
    !Number.isSafeInteger(scanCount) ||
    (scanCount as number) < 0 ||
    typeof stateIsSafe !== 'boolean' ||
    stateWriteProblem === undefined
  ) {
    throw new Error('the incumbent returned malformed health data');
  }
  return { roots, scanCount: scanCount as number, stateIsSafe, stateWriteProblem };
}

export async function applyOnBoard(
  url: string,
  modelResponse: unknown,
  after: string | null,
): Promise<ApplyOutput> {
  const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, after, response: modelResponse });
  if (Buffer.byteLength(body, 'utf8') > MAX_RECONCILIATION_REQUEST_BYTES) {
    throw new Error('the Reconciliation request exceeded its byte limit');
  }
  const response = await fetch(new URL('/reconcile', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(RECONCILIATION_APPLY_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('the incumbent refused the Reconciliation commit');
  }
  const value = await readBoundedResponse(response, RECONCILIATION_REPORT_LIMIT_BYTES);
  const output = applyOutputFrom(value);
  if (output === null) throw new Error('the incumbent returned malformed Reconciliation data');
  return output;
}

function applyOutputFrom(value: unknown): ApplyOutput | null {
  if (!isRecord(value)) return null;
  const writeProblem = value['writeProblem'];
  if (
    value['schemaVersion'] !== SCHEMA_VERSION ||
    typeof value['accepted'] !== 'boolean' ||
    !isCount(value['agreements']) ||
    !isCount(value['overrides']) ||
    !Array.isArray(value['parserBugs']) ||
    !isCount(value['rejected']) ||
    !isCount(value['rejectionsOmitted']) ||
    !Array.isArray(value['rejections']) ||
    typeof value['written'] !== 'boolean' ||
    typeof value['refreshed'] !== 'boolean' ||
    (writeProblem !== undefined && typeof writeProblem !== 'string')
  ) {
    return null;
  }
  return value as unknown as ApplyOutput;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('the incumbent response exceeded its byte limit');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('the incumbent response had no body');
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error('the incumbent response exceeded its byte limit');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('the incumbent returned invalid JSON');
  }
}

export function loadResponseFile(path: string, rootPaths: readonly string[]): unknown {
  try {
    if (!isAbsolute(path)) throw new ResponseFileError('the response path is not absolute');
    const named = lstatSync(path);
    if (!named.isFile() || named.nlink !== 1) {
      throw new ResponseFileError('the response path is not one private regular file');
    }
    if (
      process.platform !== 'win32' &&
      ((named.mode & 0o077) !== 0 || (lstatSync(dirname(path)).mode & 0o077) !== 0)
    ) {
      throw new ResponseFileError('the response file or directory is not restricted to its owner');
    }
    const canonical = canonicalPath(path);
    if (rootPaths.some((root) => isInside(canonical, root))) {
      throw new ResponseFileError('the response file is inside a watched Root');
    }
    if (!isInside(canonical, canonicalPath(tmpdir()))) {
      throw new ResponseFileError('the response file is not inside the platform temporary directory');
    }
    return readBoundedJson(canonical, MAX_RECONCILIATION_RESPONSE_BYTES, named);
  } catch (error) {
    if (error instanceof ResponseFileError) throw error;
    throw new ResponseFileError('the response file could not be read safely');
  }
}

function readBoundedJson(
  path: string,
  maxBytes: number,
  before: Stats,
): unknown {
  if (before.size > maxBytes) throw new ResponseFileError('the response file exceeded its byte limit');
  const buffer = Buffer.alloc(maxBytes + 1);
  let handle: number | null = null;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const nonBlocking = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
    handle = openSync(path, constants.O_RDONLY | noFollow | nonBlocking);
    const opened = fstatSync(handle);
    if (!samePrivateFile(opened, before)) {
      throw new ResponseFileError('the response file changed before it could be read safely');
    }
    let bytes = 0;
    for (;;) {
      const read = readSync(handle, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > maxBytes || bytes === buffer.length) {
        throw new ResponseFileError('the response file exceeded its byte limit');
      }
    }
    if (!samePrivateFile(fstatSync(handle), opened)) {
      throw new ResponseFileError('the response file changed while it was being read');
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
      return JSON.parse(text);
    } catch {
      throw new ResponseFileError('the response file is not valid JSON');
    }
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

function samePrivateFile(current: Stats, expected: Stats): boolean {
  return (
    current.isFile() &&
    current.nlink === 1 &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.ctimeMs === expected.ctimeMs &&
    (process.platform === 'win32' || (current.mode & 0o077) === 0)
  );
}

class ResponseFileError extends Error {}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

if (isMain(import.meta.url)) {
  process.exitCode = await runReconcileCli(process.argv.slice(2));
}
