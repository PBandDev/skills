/**
 * The board as it is actually served, and the two things about it that matter most.
 *
 * The board renders text out of arbitrary repositories. A ticket title, a status qualifier, a
 * file name and an AI-authored annotation are all writable by anyone who can put a file in a
 * watched repo — so if any of it ever reached the DOM as markup, a script would run in the
 * board's own origin, where `/snapshot` is the text of every file in every watched Root and
 * `POST /roots` adds another to read. That is a file-exfiltration chain, not a cosmetic bug.
 *
 * Two independent guards, asserted separately because either alone is one mistake from
 * failing: the renderer builds every node with `textContent`, and the document is served under
 * a default-deny policy.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createBoard } from '../watch/board.ts';
import type { ChangeSource } from '../watch/changes.ts';
import { HOST, serve } from '../server/server.ts';
import type { BoardServer } from '../server/server.ts';
import { boardAsset } from '../ui/assets.ts';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'tracker-board-home-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
const STATE_DIR = join(SANDBOX_HOME, '.tracker-board');

const UI_DIR = join(import.meta.dirname, '..', 'ui');

// ---------------------------------------------------------------------------
// Nothing builds markup from a string
// ---------------------------------------------------------------------------

test('no board module ever assigns markup, so hostile text cannot become an element', () => {
  // A source scan rather than a rendered-output check, and deliberately so: an output check
  // only ever proves the inputs it was given were safe, while this forbids the entire class.
  // It reads comments and strings too — the trade runs the right way, since a false positive
  // is one loud edit and a false negative ships.
  const forbidden = [
    /\binnerHTML\b/,
    /\bouterHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\bdocument\s*\.\s*write\b/,
    /\bcreateContextualFragment\b/,
    /\bnew\s+Function\b/,
    /\beval\s*\(/,
  ];
  // Every module in `ui/`, read off the directory rather than from a list retyped here. A
  // module added to the board and forgotten in this list would be the one module free to
  // build a node from a string, which is precisely the module that would do it.
  const modules = readdirSync(UI_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(modules.length >= 7, 'the scan found almost no modules, so it proves nothing');

  for (const name of modules) {
    const source = readFileSync(join(UI_DIR, name), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(source),
        `ui/${name} matches ${String(pattern)}. The board renders repository text; building a node from a string is how a ticket file runs script in the board's origin.`,
      );
    }
  }
});

test('the document carries no inline script and no inline event handler', () => {
  // The policy below forbids both. Asserting it here as well means the document and the policy
  // cannot drift apart silently — a page that quietly needed `unsafe-inline` would otherwise
  // just stop working, and the tempting fix is to widen the policy.
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'the document contains an inline script');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'the document contains an inline event handler');
  assert.ok(!/https?:\/\//i.test(html), 'the document reaches for a remote origin');
});

test('no board asset reaches for a remote origin', () => {
  // The skill must work offline from a fresh clone, and a board that phones home would be
  // reporting the contents of a private repository.
  const shipped = readdirSync(UI_DIR).filter((name) => /\.(html|css|js)$/.test(name));
  assert.ok(shipped.length >= 11, 'the scan found almost no assets, so it proves nothing');

  for (const name of shipped) {
    const source = readFileSync(join(UI_DIR, name), 'utf8');
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/i.test(source), `ui/${name} references a remote origin`);
    assert.ok(!/@import\s+url\(/i.test(source), `ui/${name} imports a remote stylesheet`);
  }
});

// ---------------------------------------------------------------------------
// How it is served
// ---------------------------------------------------------------------------

test('the document is served at the bare origin under a default-deny policy', async (t) => {
  const server = await boardServer(t);
  const page = await get(server.port, '/');

  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');

  const csp = String(page.headers['content-security-policy'] ?? '');
  assert.match(csp, /default-src 'none'/, 'the policy is not default-deny');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/unsafe-inline/.test(csp), 'the policy allows inline script or style');
  assert.ok(!/unsafe-eval/.test(csp), 'the policy allows eval');
  assert.ok(!/\*/.test(csp), 'the policy contains a wildcard source');
});

test('every asset is typed from the map, never sniffed from the path', async (t) => {
  const server = await boardServer(t);
  assert.equal((await get(server.port, '/ui/board.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get(server.port, '/ui/board.css')).headers['content-type'], 'text/css; charset=utf-8');
  // A module served as the wrong type does not execute, so this is load-bearing rather than
  // tidy — and `nosniff` is what stops the browser overruling it.
  assert.equal((await get(server.port, '/ui/view.js')).headers['x-content-type-options'], 'nosniff');
});

test('an asset path cannot be talked into reading another file', async (t) => {
  // The lookup resolves from a closed set of names and never joins the request path onto a
  // directory, so there is no path for any of these to take. Asserted through the real server
  // rather than against the lookup alone, because the decoding happens on the way in.
  const server = await boardServer(t);
  const attempts = [
    '/../server/server.ts',
    '/ui/../../core/index.ts',
    '/ui/..%2fassets.ts',
    '/%2e%2e%2f%2e%2e%2fcore/types.ts',
    '/ui/..\\assets.ts',
    '//ui/board.js',
    '/ui//board.js',
    '/ui/board.js%00.txt',
    `/ui/${'a'.repeat(4000)}.js`,
    '/ui/assets.ts',
    '/package.json',
    '/.git/config',
  ];
  for (const path of attempts) {
    const response = await get(server.port, path);
    assert.equal(response.status, 404, `${path} was served with ${String(response.status)}`);
    assert.ok(!/readFileSync|ServeOptions/.test(response.body), `${path} leaked source`);
  }
});

test('the Host check runs before the asset lookup, not after it', async (t) => {
  // The new surface inherits the check by being routed at all — asserted rather than assumed,
  // because "it inherits it" is exactly the kind of claim that stops being true silently.
  const server = await boardServer(t);
  assert.equal((await get(server.port, '/', 'board.example.com')).status, 403);
  assert.equal((await get(server.port, '/ui/board.js', 'board.example.com')).status, 403);
  assert.equal((await get(server.port, '/', `localhost:${String(server.port)}`)).status, 200);
});

test('an asset never shadows an endpoint', async (t) => {
  const server = await boardServer(t);
  const snapshot = await get(server.port, '/snapshot');
  assert.equal(snapshot.headers['content-type'], 'application/json');
  assert.equal(boardAsset('/snapshot'), null, 'the asset map claims a path the API owns');
});

test('a board served without an asset lookup still answers its endpoints', async (t) => {
  // The option is optional. A caller that wants the API and no page must not 500.
  const server = await boardServer(t, { withAssets: false });
  assert.equal((await get(server.port, '/snapshot')).status, 200);
  assert.equal((await get(server.port, '/')).status, 404);
});

// ---------------------------------------------------------------------------

async function boardServer(
  t: { after(fn: () => void | Promise<void>): void },
  options: { withAssets?: boolean } = {},
): Promise<BoardServer> {
  const root = mkdtempSync(join(tmpdir(), 'tracker-board-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, '.scratch', 'alpha', 'issues', '01-a.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '# 01 — A\n', 'utf8');

  const idle: ChangeSource = { kind: 'recursive', start: () => ({ stop: () => {}, problem: null }) };
  const board = createBoard({ watchSource: idle, stateDir: STATE_DIR });
  t.after(() => board.stop());
  board.register(root);

  const server = await serve(board, {
    port: 0,
    stopBoardOnClose: false,
    ...(options.withAssets === false ? {} : { asset: boardAsset }),
  });
  t.after(() => server.close());
  return server;
}

interface Fetched {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A raw request, so `Host` can be set — `fetch` treats it as a forbidden header. */
function get(port: number, path: string, host?: string): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: HOST,
        port,
        path,
        method: 'GET',
        headers: host === undefined ? {} : { host },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Copying, including the failure mode a real browser found
// ---------------------------------------------------------------------------

test('a clipboard write that never settles falls back rather than hanging for ever', async () => {
  // Not hypothetical: driving a real browser showed `navigator.clipboard.writeText` neither
  // resolving nor rejecting, with the permission reading as `granted`, when the page was not
  // the frontmost window. Awaited directly, the copy button does nothing at all — no
  // confirmation, no failure, no state — which is the one outcome worse than admitting it
  // could not copy. A fake that resolves would never have shown this.
  const { copyText } = await import('../ui/transport.js');

  let fellBack = false;
  const started = Date.now();
  const copied = await copyText('some/path.md', {
    navigatorImpl: { clipboard: { writeText: () => new Promise(() => {}) } },
    documentImpl: {
      body: { appendChild: () => {} },
      createElement: () => ({
        value: '',
        style: {},
        setAttribute: () => {},
        select: () => {},
        remove: () => {},
      }),
      execCommand: () => {
        fellBack = true;
        return true;
      },
    },
    setTimeoutImpl: (fn: () => void) => setTimeout(fn, 5),
  });

  // Indeterminate, not failed, and not retried: the stalled write has no cancellation and may
  // still land, so starting a second one risks the older path overwriting a newer copy.
  assert.equal(copied, 'indeterminate', 'a stalled write must be reported as unsettled');
  assert.equal(fellBack, false, 'a second clipboard write was started while the first was still pending');
  assert.ok(Date.now() - started < 4000, 'copyText waited on a promise that never settles');
});

test('a clipboard write that rejects still falls back, and a total failure is reported', async () => {
  const { copyText } = await import('../ui/transport.js');

  const denied = await copyText('some/path.md', {
    navigatorImpl: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
    documentImpl: {
      body: { appendChild: () => {} },
      createElement: () => ({ value: '', style: {}, setAttribute: () => {}, select: () => {}, remove: () => {} }),
      execCommand: () => true,
    },
  });
  assert.equal(denied, true, 'a denied clipboard API must fall back rather than give up');

  // And when nothing works, it says so. The caller renders that as a selectable path.
  const hopeless = await copyText('some/path.md', {
    navigatorImpl: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
    documentImpl: {
      body: { appendChild: () => {} },
      createElement: () => ({ value: '', style: {}, setAttribute: () => {}, select: () => {}, remove: () => {} }),
      execCommand: () => false,
    },
  });
  assert.equal(hopeless, false, 'a failed copy must be reported, never swallowed');
});
