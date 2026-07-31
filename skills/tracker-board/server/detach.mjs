// @ts-check

/**
 * Give the board direct file handles, detach it from this short-lived process, and report its PID.
 *
 * A shell-managed output redirect may stop pumping when that shell exits. Opening the files here
 * lets the board own the handles it needs after both this process and its spawning shell are gone.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { isMain, messageOf } from './entrypoint.mjs';
import { nodeFloorDiagnostic, nodeMeetsFloor } from './launch.mjs';

/**
 * @typedef {{
 *   pid?: number | undefined,
 *   unref: () => void,
 *   once: import('node:events').EventEmitter['once'],
 *   off: import('node:events').EventEmitter['off'],
 * }} ChildLike
 */
/**
 * @typedef {(command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => ChildLike} SpawnChild
 */
/**
 * @typedef {{
 *   args?: readonly unknown[],
 *   writeOut?: (text: string) => void,
 *   writeError?: (text: string) => void,
 *   spawnChild?: SpawnChild,
 *   nodeVersion?: unknown,
 * }} DetacherOptions
 */

/**
 * @param {DetacherOptions} [options]
 * @returns {Promise<number>}
 */
export async function runDetacher(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const writeOut = options.writeOut ?? ((text) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text) => process.stderr.write(text));
  /** @type {SpawnChild} */
  const spawnChild = options.spawnChild ?? ((command, childArgs, spawnOptions) => spawn(command, childArgs, spawnOptions));
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (!nodeMeetsFloor(nodeVersion)) {
    writeError(nodeFloorDiagnostic(nodeVersion));
    return 1;
  }
  if (args.length !== 4 || !args.every(absolutePath)) {
    writeError('tracker-board detacher requires absolute launcher, Root, stdout, and stderr paths.\n');
    return 1;
  }

  const [launcherPath, rootPath, stdoutPath, stderrPath] = /** @type {[string, string, string, string]} */ (args);
  let stdoutHandle = null;
  let stderrHandle = null;
  try {
    stdoutHandle = openSync(stdoutPath, 'w');
    stderrHandle = openSync(stderrPath, 'w');
    const child = spawnChild(process.execPath, [launcherPath, rootPath], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', stdoutHandle, stderrHandle],
    });
    await childSpawned(child);
    const childPid = child.pid;
    if (typeof childPid !== 'number' || !Number.isSafeInteger(childPid) || childPid <= 0) {
      throw new Error('the operating system returned no child process identifier');
    }
    child.unref();
    writeOut(`${String(childPid)}\n`);
    return 0;
  } catch (error) {
    writeError(`tracker-board could not detach: ${messageOf(error)}.\n`);
    return 1;
  } finally {
    if (stdoutHandle !== null) closeSync(stdoutHandle);
    if (stderrHandle !== null) closeSync(stderrHandle);
  }
}

/**
 * @param {ChildLike} child
 * @returns {Promise<void>}
 */
function childSpawned(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      // Once detached, later runtime diagnostics belong to the child's direct stderr handle.
      // Keeping one listener prevents a late ChildProcess error from crashing this short-lived
      // reporter after it has already handed ownership to the operating system.
      child.once('error', () => {});
      resolve();
    };
    /** @param {Error} error */
    const onError = (error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function absolutePath(value) {
  return typeof value === 'string' && isAbsolute(value);
}

if (isMain(import.meta.url)) process.exitCode = await runDetacher();
