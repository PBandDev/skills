/**
 * tracker-board — the board's static assets.
 *
 * The server knows how to move bytes and nothing about HTML. This is the whole of the
 * translation between them: a path in, a body and a content type out, `null` for anything this
 * does not own. That keeps markup out of the transport layer, and it is what lets the full
 * board grow to several ES modules without the server learning about any of them.
 *
 * ## Why the list is explicit
 *
 * It would be shorter to resolve the request path against this directory and read whatever is
 * there. It would also be a file server pointed at a process that has already been handed
 * arbitrary directories to read — one `..` bug away from serving anything the board can reach.
 * An allowlist cannot traverse anywhere, and the cost is one line per asset.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Asset {
  readonly body: string;
  readonly type: string;
}

/** The document itself, reachable at the bare origin so the printed URL is all a reader needs. */
const INDEX = 'index.html';

/**
 * Every file the board serves, and nothing else. Paths are literal, never computed.
 *
 * Every panel module and stylesheet is named here explicitly. A file absent from this map is
 * not served, so adding an asset requires an intentional allowlist edit rather than turning the
 * asset directory into a file server.
 */
const ASSETS: ReadonlyMap<string, string> = new Map([
  ['/', INDEX],
  ['/index.html', INDEX],
  ['/ui/board.css', 'board.css'],
  ['/ui/board.js', 'board.js'],
  ['/ui/view.js', 'view.js'],
  ['/ui/render.js', 'render.js'],
  ['/ui/transport.js', 'transport.js'],
  ['/ui/panels.js', 'panels.js'],
  ['/ui/corrections.js', 'corrections.js'],
  ['/ui/corrections.css', 'corrections.css'],
  ['/ui/digest.js', 'digest.js'],
  ['/ui/digest.css', 'digest.css'],
  ['/ui/domain.js', 'domain.js'],
  ['/ui/domain.css', 'domain.css'],
]);

const TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

/**
 * Read an asset by request path.
 *
 * Files are read per request rather than cached at startup. The board is a development tool
 * whose whole premise is that it reflects the disk as it changes; a cache would mean editing
 * the board's own stylesheet and reloading to no effect, and at this traffic — one reader, a
 * handful of files — there is nothing to gain by holding them.
 *
 * Never throws. A missing asset is `null`, which the server renders as a 404, because a board
 * whose stylesheet is absent should still show its cards.
 */
export function boardAsset(requestPath: string): Asset | null {
  const name = typeof requestPath === 'string' ? ASSETS.get(requestPath) : undefined;
  if (name === undefined) return null;
  try {
    const body = readFileSync(join(import.meta.dirname, name), 'utf8');
    return { body, type: typeFor(name) };
  } catch {
    return null;
  }
}

/** Every path the board answers on. Exported so a test can assert the set rather than guess it. */
export function boardAssetPaths(): readonly string[] {
  return [...ASSETS.keys()];
}

function typeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot === -1 ? undefined : TYPES.get(name.slice(dot))) ?? 'application/octet-stream';
}
