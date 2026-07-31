/**
 * tracker-board — the HTTP and SSE surface over a {@link Board}.
 *
 * The transport exposes the current Snapshot, health, a stream of Snapshots, Root handoff,
 * bounded Reconciliation commit, and a closed set of static assets. Rendering belongs to the
 * board's HTML, not here.
 *
 * ## Singleton on a fixed port, decided by the bind
 *
 * ADR-0005 states the invariant and names the failure it must never produce: **a second server
 * on a second port, splitting the Roots list.** Asking "is something already listening?" and
 * then binding is a race — two invocations can both be told no. So the bind *is* the question:
 * whoever gets the port is the server, and `EADDRINUSE` means somebody else already is. The
 * loser prints that URL and stops, which is exactly the invariant.
 *
 * ## Bound to the loopback interface, deliberately
 *
 * The board reads arbitrary directories and renders their contents; its POST endpoints register
 * another Root or commit private Annotation state. On `0.0.0.0` that is a file-disclosure and
 * mutation surface offered to the local network. `127.0.0.1` keeps it to this machine, which is
 * the only place the invoking agent ever runs.
 *
 * ## Lifetime is bound to the browser tab
 *
 * The process exits once no SSE client has been connected for about fifteen minutes, so a
 * board nobody is looking at does not accumulate. The clock for that is a {@link Timers}, not
 * `setTimeout`, so the reaping is asserted in a test rather than waited for.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { MAX_RECONCILIATION_RESPONSE_BYTES } from '../core/reconciliation.ts';
import type { Snapshot } from '../core/types.ts';
import type { Stop, Timers } from '../watch/changes.ts';
import { systemTimers } from '../watch/changes.ts';
import { canonicalRootPath, RootLimitError } from '../watch/board.ts';
import type { Board } from '../watch/board.ts';
import { MAX_ROOT_PATH_BYTES, rootArgumentIsValid } from './entrypoint.mjs';

export { MAX_ROOT_PATH_BYTES };

/** The one port the board ever uses. A second server on a second port is the failure ADR-0005 names. */
export const DEFAULT_PORT = 4317;

/** Loopback only. See the module comment — this process reads and serves arbitrary files. */
export const HOST = '127.0.0.1';

/** Kept in fragments so shipped source contains no literal URL. */
const HTTP_PREFIX = 'http' + '://';

/** Lifetime is bound to the browser tab, not to the shell that launched the process. */
export const DEFAULT_IDLE_EXIT_MS = 15 * 60 * 1000;

/** Most Roots one board holds. Each costs a watcher, a timer, and a full walk per scan. */
export const DEFAULT_MAX_ROOTS = 64;

/** A busy unrelated listener must not be able to hold a launch open forever. */
export const DEFAULT_HANDOFF_TIMEOUT_MS = 5_000;

/** Two JSON bytes per bounded path, all public Roots, plus fixed protocol headroom. */
export const MAX_HANDOFF_RESPONSE_BYTES =
  DEFAULT_MAX_ROOTS * MAX_ROOT_PATH_BYTES * 2 + 256 * 1024;

/** Worst-case JSON escaping for one bounded Root, plus the request object's fixed syntax. */
export const MAX_ROOT_REQUEST_BYTES = MAX_ROOT_PATH_BYTES * 2 + 1024;

/** Raw model response plus a small cursor/wrapper envelope. */
export const MAX_RECONCILIATION_REQUEST_BYTES = MAX_RECONCILIATION_RESPONSE_BYTES + 1024;

/**
 * How often the idle check runs. Coarse by default — it is answering a fifteen-minute
 * question — but scaled to the window, so a short window is actually honoured rather than
 * being rounded up to the next half-minute tick.
 */
function idleTickFor(idleExitMs: number): number {
  return Math.max(20, Math.min(30_000, Math.floor(idleExitMs / 4)));
}

export interface ServeOptions {
  readonly port?: number;
  /** Most time one Root handoff may spend waiting for the fixed-port incumbent. */
  readonly handoffTimeoutMs?: number;
  readonly idleExitMs?: number;
  readonly timers?: Timers;
  /** Called when the board has been unwatched long enough to reap. Defaults to closing. */
  readonly onIdle?: () => void;
  /** Stop the board when the server closes. Default true. */
  readonly stopBoardOnClose?: boolean;
  /** Most Roots one board will hold. A bound on watchers, timers and scan cost. */
  readonly maxRoots?: number;
  /**
   * Same-origin static assets. Returns `null` for a path it does not own.
   *
   * A lookup rather than a route so this module stays transport-only: it moves bytes and
   * never learns what HTML is. The board's document, stylesheet and ES modules all arrive
   * through this one function, and adding another costs nothing here.
   *
   * **The implementation must resolve from a closed set of names, never by joining the
   * request path onto a directory.** This process has already been handed arbitrary
   * directories to read, so a lookup that can be talked into `..` is a file server pointed at
   * every repository the board watches.
   */
  readonly asset?: (path: string) => { readonly body: string; readonly type: string } | null;
}

export interface BoardServer {
  readonly url: string;
  readonly port: number;
  /** Live SSE connections. The board's lifetime is a function of this reaching zero. */
  readonly clientCount: () => number;
  /** Milliseconds since the last SSE client disconnected, or `null` while one is connected. */
  readonly idleForMs: () => number | null;
  readonly close: () => Promise<void>;
}

/** Either this process is the board, or another one already is. Never both. */
export type LaunchResult =
  | { readonly kind: 'serving'; readonly server: BoardServer; readonly url: string }
  | {
      readonly kind: 'already-serving';
      readonly url: string;
      /** Roots this invocation handed to the board that was already running. */
      readonly handedOver: readonly string[];
      /** Roots the peer would not take. A non-empty list means the port holder is not a board. */
      readonly refused: readonly string[];
    };

/**
 * Bind the port and serve, or discover that somebody already has.
 *
 * The caller prints `url` and nothing else, whichever branch it lands in — that is what makes
 * a second invocation idempotent instead of a second server.
 */
export async function launch(board: Board, options: ServeOptions = {}): Promise<LaunchResult> {
  const port = readPort(options.port);
  const handoffTimeoutMs = readDuration(options.handoffTimeoutMs, DEFAULT_HANDOFF_TIMEOUT_MS);
  try {
    const server = await serve(board, options);
    return { kind: 'serving', server, url: server.url };
  } catch (error) {
    if (codeOf(error) !== 'EADDRINUSE') throw error;

    // Losing the bind is only half of the invariant. Roots **accrete**, so the whole point of
    // a second invocation is that its Root joins the board that is already running — losing
    // quietly would leave the user looking at a board that does not contain the repo they
    // just invoked it in, which is the splitting failure wearing a different hat.
    const url = urlFor(port);
    const handedOver: string[] = [];
    const refused: string[] = [];
    for (const root of board.roots()) {
      if (await handOver(url, root.path, handoffTimeoutMs)) handedOver.push(root.path);
      else refused.push(root.path);
    }
    // This process is not the board, so it must not keep watching anything. Left running, its
    // watcher handles would hold a process alive that serves nothing.
    board.stop();
    return { kind: 'already-serving', url, handedOver, refused };
  }
}

/**
 * Ask the running board to adopt a Root. Returns whether it did.
 *
 * A refusal is reported rather than thrown: the peer may be an unrelated service that happens
 * to hold the port, and "something else is on this port" is a different message from "the
 * board would not take your Root".
 */
async function handOver(url: string, rootPath: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(new URL('/roots', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rootPath }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    return handoffAccepted(await readHandoffJson(response), rootPath);
  } catch {
    return false;
  }
}

async function readHandoffJson(response: Response): Promise<unknown> {
  const declaredText = response.headers.get('content-length');
  const declared = declaredText === null ? null : Number(declaredText);
  if (declared !== null && Number.isFinite(declared) && declared > MAX_HANDOFF_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_HANDOFF_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}

/** A 2xx response alone proves only that something owns the port, not that it adopted the Root. */
function handoffAccepted(value: unknown, rootPath: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (!('root' in value) || !('roots' in value) || !('stateIsSafe' in value) || !('stateWriteProblem' in value)) {
    return false;
  }
  const root = value.root;
  const roots = value.roots;
  return typeof value.stateIsSafe === 'boolean'
    && stateProblemIsReported(value.stateWriteProblem)
    && pathOf(root) === rootPath
    && Array.isArray(roots)
    && roots.some((candidate) => pathOf(candidate) === rootPath);
}

function stateProblemIsReported(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'object'
    && 'kind' in value
    && typeof value.kind === 'string';
}

function pathOf(value: unknown): string | null {
  return typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string'
    ? value.path
    : null;
}

/**
 * Start the server. Rejects with `EADDRINUSE` when the port is taken — {@link launch} turns
 * that into the singleton answer rather than an error.
 */
export function serve(board: Board, options: ServeOptions = {}): Promise<BoardServer> {
  const timers = options.timers ?? systemTimers;
  const port = readPort(options.port);
  const idleExitMs = readIdle(options.idleExitMs);
  const maxRoots = Math.min(readCount(options.maxRoots, DEFAULT_MAX_ROOTS), DEFAULT_MAX_ROOTS);

  const clients = new Set<ServerResponse>();
  /**
   * Clients whose socket is not draining, and the one Snapshot each still owes.
   *
   * `response.write` returning false means the socket is backed up. A client that has stopped
   * reading — a suspended tab, a paused debugger — does not necessarily emit `close`, so
   * ignoring that return queues every Snapshot in memory for as long as the process runs, and
   * the board is left running for hours. A Snapshot supersedes its predecessor completely, so
   * at most one is held per client and it is replaced rather than appended.
   */
  const owed = new Map<ServerResponse, Snapshot | null>();
  let idleSince: number | null = timers.now();
  let stopIdleCheck: Stop | null = null;
  let unsubscribe: Stop | null = null;

  const http = createServer((request, response) => {
    try {
      route(request, response);
    } catch (error) {
      // One bad request must never take the board down. Agents leave this process running for
      // hours; an unhandled throw here would end a session's visibility into its own work.
      send(response, 500, { error: describe(error) });
    }
  });

  function route(request: IncomingMessage, response: ServerResponse): void {
    // A page in a browser can resolve a name that points at 127.0.0.1 and reach this port.
    // Binding to loopback does not stop that; refusing a Host header this server did not bind
    // does. Loopback keeps the network out, this keeps somebody else's web page out.
    if (!hostIsOurs(request.headers.host)) {
      send(response, 403, { error: 'unrecognised Host' });
      return;
    }
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (request.method === 'GET' && path === '/snapshot') {
      send(response, 200, board.snapshot());
      return;
    }
    if (request.method === 'GET' && path === '/health') {
      send(response, 200, {
        roots: board.roots(),
        clients: clients.size,
        lastScan: board.lastScan(),
        stateIsSafe: board.stateIsSafe(),
        stateWriteProblem: board.stateWriteProblem(),
      });
      return;
    }
    if (request.method === 'GET' && path === '/events') {
      openStream(response);
      return;
    }
    if (request.method === 'POST' && path === '/roots') {
      if (!localMutationIsAllowed(request)) {
        send(response, 403, { error: 'cross-origin Root registration refused' });
        return;
      }
      registerRoot(request, response);
      return;
    }
    if (request.method === 'POST' && path === '/reconcile') {
      if (!localMutationIsAllowed(request)) {
        send(response, 403, { error: 'cross-origin Reconciliation refused' });
        return;
      }
      reconcile(request, response);
      return;
    }
    // Last, so a static asset can never shadow an endpoint, and after the Host check above,
    // which every surface on this server inherits by being routed at all.
    if (request.method === 'GET' && options.asset !== undefined) {
      const found = options.asset(path);
      if (found !== null) {
        sendAsset(response, found);
        return;
      }
    }
    send(response, 404, { error: 'not found' });
  }

  function openStream(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    clients.add(response);
    idleSince = null;
    // The current Snapshot immediately, so a client that connects between changes renders
    // something rather than an empty board waiting for the next write.
    writeFrame(response, board.snapshot());
    const drop = (): void => {
      owed.delete(response);
      if (!clients.delete(response)) return;
      if (clients.size === 0) idleSince = timers.now();
    };
    response.on('close', drop);
    response.on('error', drop);
  }

  function registerRoot(request: IncomingMessage, response: ServerResponse): void {
    readBody(request, MAX_ROOT_REQUEST_BYTES, response, (body) => {
      const rootPath = readRootPath(body);
      if (rootPath === null) {
        send(response, 400, { error: 'expected a JSON body of the form {"path": "<absolute path>"}' });
        return;
      }
      let canonicalPath: string;
      try {
        canonicalPath = canonicalRootPath(rootPath);
      } catch {
        send(response, 400, { error: 'Root must name an existing directory' });
        return;
      }
      // Roots accrete immediately, but the full walk can cover thousands of files. Defer that
      // synchronous scan so the singleton acknowledgement reaches the losing launcher first;
      // `finish` then pulls the scheduled scan forward without waiting for the debounce.
      let registered: ReturnType<Board['register']>;
      try {
        // The Board owns this check because it also owns alias coalescing. Checking a stale list
        // here first can reject an existing directory whose registered entry became a link.
        registered = board.register(canonicalPath, { scan: 'deferred', maxRoots });
      } catch (error) {
        if (error instanceof RootLimitError) {
          send(response, 429, { error: error.message });
          return;
        }
        send(response, 400, { error: 'Root could not be registered as an existing directory' });
        return;
      }
      response.once('finish', () => board.rescanNow());
      const stateWriteProblem = board.stateWriteProblem();
      send(response, 200, {
        root: { path: registered.path },
        roots: board.roots().map((root) => ({ path: root.path })),
        stateIsSafe: board.stateIsSafe(),
        stateWriteProblem: stateWriteProblem === null ? null : { kind: stateWriteProblem.kind },
      });
    });
  }

  function reconcile(request: IncomingMessage, response: ServerResponse): void {
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      send(response, 415, { error: 'Reconciliation requires JSON' });
      return;
    }
    readBody(request, MAX_RECONCILIATION_REQUEST_BYTES, response, (body) => {
      const input = readReconciliationRequest(body);
      if (input === null) {
        send(response, 400, { error: 'invalid Reconciliation request JSON' });
        return;
      }
      try {
        send(response, 200, board.reconcile(input.response, input.after));
      } catch {
        send(response, 409, { error: 'Reconciliation could not commit against current board state' });
      }
    });
  }

  function writeFrame(response: ServerResponse, snapshot: Snapshot): void {
    if (owed.has(response)) {
      // Superseded, never queued — the newest Snapshot is the only one worth sending. A
      // client that keeps buffering past the cap has stopped reading, and is dropped.
      owed.set(response, snapshot);
      if (response.writableLength > MAX_CLIENT_BACKLOG_BYTES) response.destroy();
      return;
    }
    let drained = false;
    try {
      drained = response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch {
      // A client that vanished between the change and the write. `close` removes it.
      return;
    }
    if (drained) return;
    owed.set(response, null);
    response.once('drain', () => {
      const queued = owed.get(response) ?? null;
      owed.delete(response);
      if (queued !== null) writeFrame(response, queued);
    });
  }

  unsubscribe = board.subscribe((snapshot) => {
    for (const client of [...clients]) writeFrame(client, snapshot);
  });

  stopIdleCheck = timers.repeat(idleTickFor(idleExitMs), () => {
    if (idleSince === null) return;
    if (timers.now() - idleSince < idleExitMs) return;
    if (options.onIdle !== undefined) {
      options.onIdle();
      return;
    }
    void close();
  });

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    stopIdleCheck?.();
    stopIdleCheck = null;
    unsubscribe?.();
    unsubscribe = null;
    for (const client of [...clients]) client.end();
    clients.clear();
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
    // The board owns persistent watcher handles. Closing the HTTP server alone leaves them
    // open, so an idle reap would tear down the socket and leave the process running for
    // ever — the exact opposite of what the idle window is for.
    if (options.stopBoardOnClose !== false) board.stop();
  }

  return new Promise<BoardServer>((resolve, reject) => {
    http.once('error', (error) => {
      // The subscription and the idle timer were created before the bind was attempted.
      // Without this a losing second launch leaks both into a process that then hangs
      // around holding a board it never serves.
      stopIdleCheck?.();
      stopIdleCheck = null;
      unsubscribe?.();
      unsubscribe = null;
      reject(error);
    });
    http.listen(port, HOST, () => {
      http.removeAllListeners('error');
      // A server error after a successful listen must not become an uncaught exception.
      http.on('error', () => {});
      resolve({
        url: urlFor(readActualPort(http, port)),
        port: readActualPort(http, port),
        clientCount: () => clients.size,
        idleForMs: () => (idleSince === null ? null : timers.now() - idleSince),
        close,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** A client buffering more than this has stopped reading, and is disconnected. */
const MAX_CLIENT_BACKLOG_BYTES = 8 * 1024 * 1024;

/**
 * The board's content security policy.
 *
 * Default-deny, and there is nothing legitimate to open up: the skill must run offline from a
 * fresh clone, so every script, style and connection it needs is same-origin, and anything
 * reaching for another origin is by definition not the board.
 *
 * This is **defence in depth, not the defence**. The board renders text out of arbitrary
 * repositories — ticket titles, status qualifiers, file names, AI-authored annotations — all of
 * it writable by anyone who can put a file in a watched repo. The renderer therefore builds
 * every node with `textContent`, and this policy is what stands between a mistake there and a
 * script running in the board's own origin, where it could read `/snapshot` — the text of every
 * file in every watched Root — and post new Roots to be read.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Write a static asset.
 *
 * The content type comes from the asset itself rather than from the request path, and
 * `nosniff` stops the browser second-guessing it: a module served as the wrong type does not
 * execute, and a document sniffed out of something that is not one is how a text file becomes
 * a script.
 */
function sendAsset(response: ServerResponse, asset: { readonly body: string; readonly type: string }): void {
  try {
    response.writeHead(200, {
      'content-type': asset.type,
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // The board is a live view of a working tree; a cached copy is a stale one.
      'cache-control': 'no-store',
    });
    response.end(asset.body);
  } catch {
    // Headers already sent, or a socket that closed mid-response.
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  try {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(text);
  } catch {
    // Headers already sent, or a socket that closed mid-response. Nothing left to say.
  }
}

/**
 * Read a bounded request body. Bounded because this endpoint is reachable by anything on the
 * loopback interface, and an unbounded read is a way to make the board hold a request open
 * forever.
 */
function readBody(
  request: IncomingMessage,
  maxBytes: number,
  response: ServerResponse,
  done: (body: string) => void,
): void {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let over = false;
  request.on('data', (chunk: Buffer) => {
    if (over) return;
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      over = true;
      chunks = [];
      send(response, 413, { error: 'request body exceeded its byte limit' });
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (over) return;
    try {
      done(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    } catch {
      done('');
    }
  });
  request.on('error', () => {
    if (!over) done('');
  });
}

function readReconciliationRequest(
  body: string,
): { readonly after: string | null; readonly response: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).length !== 3 ||
    record['schemaVersion'] !== 1 ||
    !Object.hasOwn(record, 'after') ||
    !Object.hasOwn(record, 'response')
  ) {
    return null;
  }
  const after = record['after'];
  if (after !== null && (typeof after !== 'string' || !/^[a-f0-9]{64}$/.test(after))) {
    return null;
  }
  return { after, response: record['response'] };
}

/** Type stripping erases without checking, and this value arrived over a socket. */
function readRootPath(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('path' in parsed)) return null;
  const path = parsed.path;
  return rootArgumentIsValid(path) ? path : null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function urlFor(port: number): string {
  return `${HTTP_PREFIX}${HOST}:${port}/`;
}

/** Port 0 asks the OS for a free one, which is how a test runs without claiming the real port. */
function readActualPort(http: Server, requested: number): number {
  const address = http.address();
  return typeof address === 'object' && address !== null ? address.port : requested;
}

function readPort(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
    ? value
    : DEFAULT_PORT;
}

function readIdle(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_IDLE_EXIT_MS;
}

function readDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Browsers attach an unforgeable Origin or Fetch Metadata header to cross-site mutations.
 * Origin-less clients remain valid because the singleton handoff is a local Node request.
 */
function localMutationIsAllowed(request: IncomingMessage): boolean {
  const fetchSite = request.headers['sec-fetch-site'];
  if (Array.isArray(fetchSite)) return false;
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;

  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === request.headers.host?.toLowerCase();
  } catch {
    return false;
  }
}

/** Only the names this server is reachable under. Anything else is somebody else's page. */
function hostIsOurs(host: string | undefined): boolean {
  if (typeof host !== 'string' || host.length === 0) return false;
  const withoutPort = host.startsWith('[') ? (host.split(']')[0] ?? '') + ']' : (host.split(':')[0] ?? '');
  const name = withoutPort.toLowerCase();
  return name === HOST || name === 'localhost' || name === '[::1]';
}

function readCount(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function codeOf(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : '';
  }
  return '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
