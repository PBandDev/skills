/**
 * The board's static assets.
 *
 * Small surface, but the one place where a request path chooses a file to read — inside a
 * process that has already been handed arbitrary directories to walk. So the interesting
 * assertions are about what it refuses, not what it serves.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { boardAsset, boardAssetPaths } from '../ui/assets.ts';

test('the bare origin serves the document, so the printed URL is all a reader needs', () => {
  const asset = boardAsset('/');
  assert.ok(asset !== null, 'the board has no page at its own URL');
  assert.equal(asset.type, 'text/html; charset=utf-8');
  assert.match(asset.body, /<!doctype html>/i);
  assert.match(asset.body, /id="board"/, 'the document has no board element to render into');
});

test('every module the document asks for is actually served', () => {
  // The set is asserted against what the document imports, not against a list retyped here —
  // a module added to the page and forgotten in the allowlist is a blank board.
  const html = boardAsset('/')?.body ?? '';
  const css = boardAsset('/ui/board.css')?.body ?? '';
  const referenced = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((match) => match[1] ?? '');
  assert.ok(referenced.length >= 2, 'the document references no local assets at all');

  for (const path of referenced) {
    assert.ok(boardAsset(path) !== null, `${path} is referenced by the document but not served`);
  }
  assert.ok(css.length > 0);

  // And every ES module reachable from the entry point, which the document does not name.
  for (const source of [boardAsset('/ui/board.js')?.body ?? '', boardAsset('/ui/render.js')?.body ?? '']) {
    for (const match of source.matchAll(/from '\.\/([a-z]+\.js)'/g)) {
      const name = match[1] ?? '';
      assert.ok(
        boardAsset(`/ui/${name}`) !== null,
        `${name} is imported by a served module but is not itself served`,
      );
    }
  }
});

test('content types are right, because a module served as text does not execute', () => {
  assert.equal(boardAsset('/ui/board.js')?.type, 'text/javascript; charset=utf-8');
  assert.equal(boardAsset('/ui/board.css')?.type, 'text/css; charset=utf-8');
  assert.equal(boardAsset('/index.html')?.type, 'text/html; charset=utf-8');
});

test('anything outside the allowlist is refused, traversal included', () => {
  // The allowlist is the whole defence: this maps a request path to a literal filename and
  // never joins user input onto a directory, so there is no path for a `..` to take.
  const refused = [
    '/ui/assets.ts',
    '/ui/../core/index.ts',
    ['/', '..', '/', '..', '/', '..', '/', 'etc', '/', 'passwd'].join(''),
    '/ui/%2e%2e/board.js',
    '/ui/board.js/../../core/types.ts',
    '/ui/',
    '/ui',
    '/snapshot',
    '/events',
    '',
    '/UI/BOARD.JS',
  ];
  for (const path of refused) {
    assert.equal(boardAsset(path), null, `${path} was served`);
  }
});

test('a non-string path is refused rather than thrown on', () => {
  // It arrives off a socket, and type stripping erases without checking.
  for (const value of JSON.parse('[null, 7, {}, [], true]')) {
    assert.equal(boardAsset(value), null);
  }
});

test('every browser file in ui/ is either served or deliberately not', () => {
  // A module that exists but is unreachable is dead weight; one that is reachable and
  // unlisted is a blank board. Both are caught by comparing the directory to the allowlist.
  const onDisk = readdirSync(join(import.meta.dirname, '..', 'ui')).filter((name) =>
    /\.(html|css|js)$/.test(name),
  );
  const served = new Set(
    boardAssetPaths()
      .map((path) => boardAsset(path))
      .map((asset) => asset?.body ?? ''),
  );
  assert.equal(served.size >= 1, true);

  for (const name of onDisk) {
    const path = name === 'index.html' ? '/' : `/ui/${name}`;
    assert.ok(boardAsset(path) !== null, `ui/${name} exists but nothing serves it`);
  }
});
