// @ts-check

/** Small, plain-JavaScript boundaries shared by the launcher's two executable modules. */

import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root requests stay below the public protocol's bounded response calculation. */
export const MAX_ROOT_PATH_BYTES = 48 * 1024;

/**
 * The launcher's direct argument and the singleton's JSON request share one Root alphabet.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function rootArgumentIsValid(value) {
  return typeof value === 'string'
    && isAbsolute(value)
    && !/\p{Cc}/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_ROOT_PATH_BYTES;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function messageOf(error) {
  try {
    return error instanceof Error && error.message.length > 0 ? error.message : 'unknown failure';
  } catch {
    return 'unknown failure';
  }
}

/**
 * @param {string} moduleUrl
 * @param {unknown} [entry=process.argv[1]]
 * @returns {boolean}
 */
export function isMain(moduleUrl, entry = process.argv[1]) {
  if (typeof entry !== 'string') return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
