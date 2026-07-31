/**
 * The two state files, and the only code that touches them.
 *
 * The seam is pure and does no I/O, so "state is written outside every watched Root" needs
 * a home. This is it. It sits outside `core/`, is exercised against a temporary directory,
 * and is the one module that knows where state lives.
 *
 *   - **Snapshot** — code-owned, regenerated freely, never hand-edited.
 *   - **Annotations** — AI-owned, every entry keyed by `filePath + contentSha` (ADR-0003).
 *
 * Both live in a hidden directory under the user's home, **outside every watched repo**, so
 * the board never pollutes a tree it observes. The directory is overridable by an explicit
 * argument so a test can point it somewhere disposable rather than at a real home.
 *
 * Both files carry a `schemaVersion`. An entry with an unknown version is **dropped and its
 * file re-flagged** — `reflag` names the source files whose Annotations were dropped, so
 * the AI layer knows exactly what to write again — never crash-parsed.
 *
 * **Nothing here throws.** A missing, empty, truncated or malformed file reads as an empty
 * store *and says so*: every degradation is reported as a `StateProblem` carrying its kind,
 * because a board that silently reads a corrupt state file as "the AI has written nothing
 * yet" is a board that has quietly lost work.
 *
 * Readings this module takes, and the assumptions it makes about the platform underneath
 * it, stated rather than left to be discovered:
 *
 *   - **Entry interiors are not validated here.** The store checks the envelope — is it
 *     JSON, is it an object, does the version match, are the entries a list — and each
 *     entry's own version. Everything else is validated by the seam, which is where a
 *     rejection can be counted onto a Snapshot and rendered. The seam validates
 *     independently rather than trusting this filter, because it is fed from more places
 *     than this one.
 *   - **The Snapshot is returned unvalidated, as raw JSON.** It is code-owned and
 *     regenerated freely, so a caller that needs a Snapshot derives one rather than
 *     trusting a file; typing this return as `Snapshot` would be a claim nothing checked.
 *   - **A message never quotes what it read.** These reach a rendered page, and the files
 *     they describe are model-authored text about a private repository, so a value is
 *     described by its shape and its size and never by its characters.
 *   - **The directory comes from `homedir()` joined with `path`, never from a literal.**
 *     A hard-coded home shorthand is not expanded by the file system: it would create a
 *     directory named after that shorthand in the current working directory, which for a
 *     board launched inside a repo means creating it *inside a watched tree*.
 *   - **State is private to the invoking user.** On POSIX, the directory is tightened to
 *     mode 0700 and each new temporary file is created at 0600 before its atomic rename.
 *     Windows keeps its platform ACL semantics. A permission operation that fails is a
 *     reported write problem, never a reason to leave a more public file behind.
 *   - **Assumed of the platform:** that `rename` over an existing file replaces it, which
 *     is true of POSIX and of Windows through Node's `fs`; and that path comparison follows
 *     `path.relative`, so containment inherits the platform's own case sensitivity rather
 *     than assuming either. Every one of these can fail, and a failure is reported as a
 *     problem rather than thrown or worked around.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AnnotationEntry, AnnotationStore, JsonValue, Snapshot } from '../core/types.ts';

/** The state directory, under the user's home and outside every watched Root. */
export const STATE_DIR_NAME = '.tracker-board';
export const ANNOTATIONS_FILE = 'annotations.json';
export const SNAPSHOT_FILE = 'snapshot.json';

/** The schema both state files are written with, and the only one read back. */
export const STATE_SCHEMA_VERSION = 1;

export type StateProblemKind =
  /** The file has never been written. Expected on a first run; reported, not hidden. */
  | 'absent'
  /** Zero bytes, or nothing but whitespace — the shape a torn write leaves behind. */
  | 'empty'
  /** Not JSON, or JSON of the wrong shape. */
  | 'malformed'
  /** An unsupported version. Its contents are dropped, never guessed at. */
  | 'schema'
  /** The read itself failed — a permission, a directory where a file belongs. */
  | 'unreadable'
  | 'write-failed'
  /** The state directory is inside a watched Root. The write is refused, never relocated. */
  | 'inside-root';

export interface StateProblem {
  readonly kind: StateProblemKind;
  /** Absolute path of the state file the problem is about. */
  readonly file: string;
  readonly message: string;
}

export interface StateRead {
  /** The resolved state directory. Never inside a watched Root. */
  readonly dir: string;
  /** Always a store, never `null`. An unreadable file reads as an empty one. */
  readonly annotations: AnnotationStore;
  /**
   * The last written Snapshot, exactly as it was parsed, or `null`. Unvalidated on purpose
   * — the Snapshot is code-owned and cheaper to re-derive than to trust.
   */
  readonly snapshot: JsonValue | null;
  /** Entries dropped for an unknown schema version. */
  readonly droppedForVersion: number;
  /** The source files whose Annotations were dropped. What "re-flagged" means concretely. */
  readonly reflag: readonly string[];
  readonly problems: readonly StateProblem[];
}

export interface StateWrite {
  readonly file: string;
  readonly written: boolean;
  readonly problem: StateProblem | null;
}

const EMPTY_STORE: AnnotationStore = { schemaVersion: STATE_SCHEMA_VERSION, entries: [] };

// ---------------------------------------------------------------------------
// Where state lives
// ---------------------------------------------------------------------------

/**
 * `.tracker-board` under the home directory the platform reports, or the override.
 *
 * Built by joining, never by interpolating a `~` into a string: nothing in the file system
 * expands `~`, so a literal one creates a directory actually named `~` in whatever the
 * current working directory happens to be. Resolved to an absolute path so the "outside
 * every watched Root" check is a path comparison rather than a guess.
 */
export function stateDir(override?: string): string {
  if (typeof override === 'string' && override.length > 0) return resolve(override);
  return join(homedir(), STATE_DIR_NAME);
}

/**
 * Whether `child` sits inside `parent`. This is the check behind "state is written outside
 * every watched Root", and it is exported because whoever registers a Root has to make the
 * same claim before registering it.
 */
export function isInside(child: string, parent: string): boolean {
  if (!isAbsolute(child) || !isAbsolute(parent)) return false;
  const step = relative(canonicalPath(parent), canonicalPath(child));
  if (step.length === 0) return true;
  if (isAbsolute(step)) return false;
  return step !== '..' && !step.startsWith(`..${sep}`);
}

/**
 * The real path, with symbolic links resolved on **both** sides of a containment question.
 *
 * `resolve` normalises `.` and `..` and nothing else, so a symlinked boundary compares
 * unequal and containment silently answers "outside" — the dangerous direction, because the
 * answer is used to decide whether state may be written somewhere. The temporary directory
 * is exactly such a boundary on macOS, where the reported prefix and its real-path prefix
 * differ.
 *
 * The state directory legitimately does not exist yet on a first run, and `realpath` fails
 * on a path that is not there, so this resolves the nearest ancestor that does exist and
 * re-appends the rest. It never throws: a path that resolves to nothing falls back to
 * `resolve`, which is what the comparison used to do everywhere.
 */
export function canonicalPath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...[...tail].reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * Whether the state directory sits outside **every** one of these Roots.
 *
 * The default directory is outside every ordinary Root, but it is not outside a Root that
 * *is* the home directory, or one above it — and nothing in this module can know which
 * Roots exist. Roots also accrete over time, so the question has to be asked again on every
 * write rather than answered once at startup.
 *
 * **The answer when they overlap is to refuse, not to relocate.** Relocating would move the
 * board's memory somewhere the user did not choose and did not know about, and the next run
 * would read an empty store and quietly regenerate everything. Refusing is visible, and the
 * two ways out — watch a directory inside the home rather than the home itself, or pass an
 * explicit state directory — are both the caller's to choose.
 */
export function stateIsOutside(rootPaths: readonly string[], override?: string): boolean {
  const dir = stateDir(override);
  const roots = Array.isArray(rootPaths) ? rootPaths : [];
  return roots.every((root) => typeof root !== 'string' || !isInside(dir, root));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Both files, merged into one read. Never throws, whatever is on disk.
 */
export function readState(override?: string): StateRead {
  const dir = stateDir(override);
  const problems: StateProblem[] = [];

  const annotationsFile = join(dir, ANNOTATIONS_FILE);
  const snapshotFile = join(dir, SNAPSHOT_FILE);

  // Each decode is guarded as a whole rather than only around `JSON.parse`. Parsing is not
  // the only step that can fail on a value chosen by whatever wrote the file: reading a
  // field, comparing it, or describing it in a message all touch untrusted data, and the
  // never-throws contract covers the file, not one call inside it.
  let read: AnnotationsRead = { store: EMPTY_STORE, droppedForVersion: 0, reflag: [] };
  try {
    read = readAnnotationsText(annotationsFile, readText(annotationsFile, problems), problems);
  } catch (error) {
    problems.push(problem('malformed', annotationsFile, `could not be decoded: ${String(error)}`));
  }

  let snapshot: JsonValue | null = null;
  try {
    snapshot = readSnapshotText(snapshotFile, readText(snapshotFile, problems), problems);
  } catch (error) {
    problems.push(problem('malformed', snapshotFile, `could not be decoded: ${String(error)}`));
  }

  return {
    dir,
    annotations: read.store,
    snapshot,
    droppedForVersion: read.droppedForVersion,
    reflag: read.reflag,
    problems,
  };
}

interface AnnotationsRead {
  readonly store: AnnotationStore;
  readonly droppedForVersion: number;
  readonly reflag: readonly string[];
}

function readAnnotationsText(
  file: string,
  text: string | null,
  problems: StateProblem[],
): AnnotationsRead {
  const empty: AnnotationsRead = { store: EMPTY_STORE, droppedForVersion: 0, reflag: [] };
  if (text === null) return empty;

  let parsed: AnnotationStore;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    problems.push(problem('malformed', file, `is not JSON: ${String(error)}`));
    return empty;
  }

  if (!isRecord(parsed)) {
    problems.push(problem('malformed', file, 'is not an Annotation store object'));
    return empty;
  }
  if (!isInteger(parsed.schemaVersion) || parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    problems.push(
      problem(
        'schema',
        file,
        `carries schema version ${describe(parsed.schemaVersion)}, not ${STATE_SCHEMA_VERSION}; no Annotation was read`,
      ),
    );
    return empty;
  }
  if (!Array.isArray(parsed.entries)) {
    problems.push(problem('malformed', file, 'has no list of entries'));
    return empty;
  }

  const kept: AnnotationEntry[] = [];
  const reflag: string[] = [];
  let droppedForVersion = 0;
  for (const entry of parsed.entries) {
    if (isRecord(entry) && isInteger(entry.schemaVersion) && entry.schemaVersion === STATE_SCHEMA_VERSION) {
      kept.push(entry);
      continue;
    }
    // Dropped, and its file re-flagged: the entry is gone and the source file it described
    // is named, so the AI layer writes it again rather than the board guessing at it.
    droppedForVersion += 1;
    const claimed = isRecord(entry) ? entry.filePath : undefined;
    if (typeof claimed === 'string' && claimed.length > 0) reflag.push(claimed);
  }
  if (droppedForVersion > 0) {
    problems.push(
      problem(
        'schema',
        file,
        `dropped ${droppedForVersion} entr${droppedForVersion === 1 ? 'y' : 'ies'} carrying a schema version other than ${STATE_SCHEMA_VERSION}`,
      ),
    );
  }

  return {
    store: { schemaVersion: STATE_SCHEMA_VERSION, entries: kept },
    droppedForVersion,
    reflag,
  };
}

function readSnapshotText(
  file: string,
  text: string | null,
  problems: StateProblem[],
): JsonValue | null {
  if (text === null) return null;

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    problems.push(problem('malformed', file, `is not JSON: ${String(error)}`));
    return null;
  }
  const object = asObject(parsed);
  if (object === null) {
    problems.push(problem('malformed', file, 'is not a Snapshot object'));
    return null;
  }
  const version = object['schemaVersion'];
  if (typeof version !== 'number' || version !== STATE_SCHEMA_VERSION) {
    problems.push(
      problem(
        'schema',
        file,
        `carries schema version ${describe(version)}, not ${STATE_SCHEMA_VERSION}; the Snapshot is re-derived rather than read`,
      ),
    );
    return null;
  }
  return object;
}

/** `null` for every degradation. The problem is recorded; the caller gets an empty read. */
function readText(file: string, problems: StateProblem[]): string | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      problems.push(problem('absent', file, 'has not been written yet'));
    } else {
      problems.push(problem('unreadable', file, `could not be read: ${String(error)}`));
    }
    return null;
  }
  if (text.trim().length === 0) {
    // Zero bytes is what a torn write leaves behind, and it parses as neither JSON nor
    // nothing. It is a degradation, not a store.
    problems.push(problem('empty', file, 'is empty'));
    return null;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The AI-owned file. Written through a temporary name and renamed into place, because the
 * board may be reading it at the moment it is written — a torn read is the steady state in
 * this project, and this is the one place it can be prevented rather than tolerated.
 *
 * The writer stamps the envelope version. An entry's own version is the caller's.
 *
 * Pass `rootPaths` and the write is **refused** if the state directory turns out to sit
 * inside one of them. Making that a parameter rather than a note is the point: a caller that
 * hands over its Roots cannot forget to ask, and Roots accrete, so the question has to be
 * asked on every write rather than once.
 */
export function writeAnnotations(
  store: AnnotationStore,
  override?: string,
  rootPaths?: readonly string[],
): StateWrite {
  const refusal = refuseIfInsideRoot(ANNOTATIONS_FILE, override, rootPaths);
  if (refusal !== null) return refusal;
  const entries = Array.isArray(store?.entries) ? store.entries : [];
  return writeJson(join(stateDir(override), ANNOTATIONS_FILE), {
    schemaVersion: STATE_SCHEMA_VERSION,
    entries,
  });
}

/** The code-owned file. Regenerated freely; losing it costs one re-derivation. */
export function writeSnapshot(
  snapshot: Snapshot,
  override?: string,
  rootPaths?: readonly string[],
): StateWrite {
  const refusal = refuseIfInsideRoot(SNAPSHOT_FILE, override, rootPaths);
  if (refusal !== null) return refusal;
  return writeJson(join(stateDir(override), SNAPSHOT_FILE), snapshot);
}

/**
 * Refused rather than relocated, and refused rather than written. A board that quietly
 * moved its own memory somewhere the user did not choose would read an empty store on the
 * next run and regenerate everything, which looks exactly like the AI layer having written
 * nothing. Writing anyway would put the board's state inside a tree it watches, so the
 * watcher would fire on its own writes.
 */
function refuseIfInsideRoot(
  fileName: string,
  override?: string,
  rootPaths?: readonly string[],
): StateWrite | null {
  if (rootPaths === undefined || stateIsOutside(rootPaths, override)) return null;
  const file = join(stateDir(override), fileName);
  return {
    file,
    written: false,
    problem: problem(
      'inside-root',
      file,
      'sits inside a watched Root; state is not written into a tree the board observes. Watch a directory inside the home rather than the home itself, or give the board an explicit state directory.',
    ),
  };
}

function writeJson(file: string, value: AnnotationStore | Snapshot): StateWrite {
  let temporary: string | null = null;
  let handle: number | null = null;
  try {
    const directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    // A PID can be reused while debris from its earlier owner remains. A fresh unique
    // suffix means this invocation never claims or deletes a temporary file it did not create.
    const candidate = `${file}.${String(process.pid)}.${randomUUID()}.tmp`;
    handle = openSync(candidate, 'wx', 0o600);
    // Ownership begins only after the exclusive open succeeds. If another process somehow
    // chose the same candidate, this invocation must not unlink that process's file.
    temporary = candidate;
    if (process.platform !== 'win32') fchmodSync(handle, 0o600);
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    closeSync(handle);
    handle = null;
    renameSync(temporary, file);
    return { file, written: true, problem: null };
  } catch (error) {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        // The failed write may already have closed it.
      }
    }
    if (temporary !== null) {
      try {
        unlinkSync(temporary);
      } catch {
        // The owned temporary file may already be gone. Nothing remains to clean up or report.
      }
    }
    return {
      file,
      written: false,
      problem: problem('write-failed', file, `could not be written: ${String(error)}`),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers. Nothing below trusts a declared type: every value reaching them came off disk,
// and type stripping erases without checking.
// ---------------------------------------------------------------------------

type JsonObject = { readonly [key: string]: JsonValue };

function problem(kind: StateProblemKind, file: string, message: string): StateProblem {
  return { kind, file, message };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: object | null | undefined): boolean {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function isInteger(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * A value as it appears in a message, **without ever coercing it**.
 *
 * `String(value)` is the wrong tool on anything that came out of `JSON.parse`: a value like
 * `{"schemaVersion":{"toString":null}}` is perfectly good JSON, and coercing it raises
 * `TypeError: Cannot convert object to primitive value`. Doing that while composing the
 * message that reports the bad version turns a degradation into a crash — in the one module
 * whose whole contract is that it never throws.
 */
function describe(value: JsonValue | number | null | undefined): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Described by shape and size, never by characters. These messages reach a rendered page,
  // and the file they describe is model-authored text about a private repository.
  if (typeof value === 'string') return `a ${value.length}-character string`;
  return Array.isArray(value) ? 'a list' : 'an object';
}

function isJsonArray(value: readonly JsonValue[] | JsonObject): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  return isJsonArray(value) ? null : value;
}
