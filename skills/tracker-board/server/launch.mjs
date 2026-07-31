// @ts-check

/**
 * The platform-neutral tracker-board entrypoint.
 *
 * Shell detachment differs by platform; composing the board does not. Keeping that composition
 * here gives every shell the same fixed-port singleton, Root handoff, assets, output contract,
 * and old-Node diagnostic.
 */

import { isMain, messageOf, rootArgumentIsValid } from './entrypoint.mjs';

const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 18;

/** @typedef {{ register: (root: string) => unknown, stop: () => void }} LaunchBoard */
/** @typedef {(path: string) => { body: string, type: string } | null} AssetLookup */
/**
 * @typedef {
 *   | { kind: 'serving', url: string }
 *   | { kind: 'already-serving', url: string, handedOver: readonly string[], refused: readonly string[] }
 * } LaunchResult
 */
/**
 * @typedef {{
 *   createBoard: () => LaunchBoard,
 *   launch: (board: LaunchBoard, options: { asset: AssetLookup }) => Promise<LaunchResult>,
 *   defaultPort: number,
 *   boardAsset: AssetLookup,
 * }} LaunchRuntime
 */
/**
 * @typedef {{
 *   nodeVersion?: unknown,
 *   args?: readonly unknown[],
 *   root?: unknown,
 *   writeOut?: (text: string) => void,
 *   writeError?: (text: string) => void,
 *   loadRuntime?: () => Promise<LaunchRuntime>,
 * }} LauncherOptions
 */

/**
 * Whether `version` meets the first Node release that strips TypeScript by default.
 * @param {unknown} version
 * @returns {boolean}
 */
export function nodeMeetsFloor(version) {
  if (typeof version !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;

  const requiredMinor = major === REQUIRED_MAJOR ? REQUIRED_MINOR : major === 23 ? 6 : major >= 24 ? 0 : null;
  if (requiredMinor === null || minor < requiredMinor) return false;
  if (minor > requiredMinor || patch > 0) return true;
  return !(match[4] ?? '').startsWith('-');
}

/**
 * Start or join the board for one absolute Root.
 *
 * Injection points exist only so the preflight and output boundary can be proved without opening
 * the public port. The command-line surface exposes a Root and nothing else: in particular there
 * is no port option that could split one board into two.
 */
/**
 * @param {LauncherOptions} [options]
 * @returns {Promise<number>}
 */
export async function runLauncher(options = {}) {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const writeOut = options.writeOut ?? ((text) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text) => process.stderr.write(text));

  // This check must precede the dynamic imports below. An older runtime can parse this plain
  // JavaScript file and state the floor; importing TypeScript first would replace that answer
  // with a loader error.
  if (!nodeMeetsFloor(nodeVersion)) {
    writeError(nodeFloorDiagnostic(nodeVersion));
    return 1;
  }

  const args = options.args ?? (Object.hasOwn(options, 'root') ? [options.root] : process.argv.slice(2));
  if (args.length !== 1 || !rootArgumentIsValid(args[0])) {
    writeError('tracker-board requires exactly one absolute Root path and no port argument.\n');
    return 1;
  }
  const root = args[0];

  const loadRuntime = options.loadRuntime ?? defaultRuntime;
  /** @type {LaunchBoard | null} */
  let board = null;
  try {
    const runtime = await loadRuntime();
    board = runtime.createBoard();
    board.register(root);

    // Omit `port`: `launch` owns the one fixed default. Supplying a caller-selected fallback
    // would make a busy port split the Roots list across processes.
    const result = await runtime.launch(board, { asset: runtime.boardAsset });
    if (result.kind === 'already-serving' && result.refused.length > 0) {
      writeError(
        `tracker-board fixed port ${String(runtime.defaultPort)} is occupied by a service that refused the Root.\n`,
      );
      return 1;
    }

    writeOut(`${result.url}\n`);
    return 0;
  } catch (error) {
    board?.stop();
    const detail = messageOf(error);
    writeError(`tracker-board could not start: ${detail}${/[.!?]$/.test(detail) ? '' : '.'}\n`);
    return 1;
  }
}

/** @returns {Promise<LaunchRuntime>} */
export async function defaultRuntime() {
  const [watch, server, assets] = await Promise.all([
    import('../watch/board.ts'),
    import('./server.ts'),
    import('../ui/assets.ts'),
  ]);
  return {
    createBoard: () => watch.createBoard({ persist: true }),
    launch: (board, options) => server.launch(
      /** @type {import('../watch/board.ts').Board} */ (/** @type {unknown} */ (board)),
      options,
    ),
    defaultPort: server.DEFAULT_PORT,
    boardAsset: assets.boardAsset,
  };
}

/**
 * @param {unknown} version
 * @returns {string}
 */
export function nodeFloorDiagnostic(version) {
  const match = typeof version === 'string' ? /^(\d+)\.(\d+)\./.exec(version) : null;
  if (match !== null && Number(match[1]) === 23) {
    return 'tracker-board requires Node 23.6 or newer on the Node 23 release line.\n';
  }
  return 'tracker-board requires Node 22.18 or newer.\n';
}

if (isMain(import.meta.url)) process.exitCode = await runLauncher();
