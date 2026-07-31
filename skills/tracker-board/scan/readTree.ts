/**
 * tracker-board — the tree walk.
 *
 * Pointing the board at a Root produces the in-memory tree that `deriveSnapshot` consumes.
 * `readTree` performs the walk, the worktree skip and the tracker detection, and hands back
 * a {@link Root}. **`core` never touches a disk** — every read the board makes happens here
 * or in the watcher above it, which is what keeps the seam pure and its output stable.
 *
 * It is **synchronous**. The seam is synchronous and pure; the watcher does one full re-scan
 * per debounce and a full scan is well under 50 ms at this scale, so async buys nothing; and
 * a synchronous walk narrows the window in which an agent rewrites a file between the
 * directory listing and the read — which is the steady state here rather than an edge case.
 *
 * ## Rule zero applies here too: this module never throws
 *
 * Agents rewrite these files while the board watches them. A file that exists at listing
 * time and is gone at read time is normal. Every failure degrades to something the board can
 * state:
 *
 *   - an unreadable **file** → `text: null` plus a `readError`, which the seam renders as an
 *     `unparsed` card. The file is *stated*, not omitted.
 *   - a **directory whose contents are missing** → an entry in `unreadableDirs`, which the
 *     seam turns into a `read-error` warning. Its contents *are* gone from the board, so the
 *     omission is what has to be shown.
 *   - a git worktree pointer → skipped and counted into `hiddenWorktrees`, which the seam
 *     turns into a `hidden-worktrees` warning.
 *
 * The rule this module is built around: **an omission the board cannot state is a bug.**
 * Everything the walk drops is either counted, listed in `unreadableDirs`, or documented
 * below as holding no tracker content at all.
 *
 * ## Two path bases, and they differ on purpose
 *
 * | Field | Base | Example |
 * |---|---|---|
 * | `Root.files[].path` | `trackerPath` | `checkout-flow/issues/01-light-theme-default.md` |
 * | `Root.adrFiles[].path` | `rootPath` | `docs/adr/0001-ai-extracts-code-derives.md` |
 * | `Root.glossaryFile.path` | `rootPath` | `CONTEXT.md` |
 *
 * ADRs and the glossary live **outside** the tracker directory, so a tracker-relative path
 * for them would read `../docs/adr/….md`. That is not what `core/types.ts` declares and not
 * what the domain-model panel renders, so `adrDir` and `glossaryPath` that resolve outside
 * the Root are refused rather than emitted with a `../` prefix.
 *
 * `files[].path` is load-bearing well beyond display. `core/index.ts` groups **purely on the
 * shape of that string**: fewer than two segments is an orphan, `<feature>/issues/<file>` is
 * a Ticket, anything else under `<feature>/` is a sibling link. A leading `./`, a leading `/`
 * or a Windows `\` silently reclassifies every file in the tree — and the board still
 * renders, it just renders something false. It is also the file's **identity** across a
 * re-scan, so two files may never produce one path.
 *
 * That is why a `\` inside a single directory entry name — legal on POSIX, impossible on
 * Windows — is percent-encoded before it is emitted. `core/index.ts` reads a `\` as a
 * separator, so a file literally named `alpha\issues\01.md` sitting in the tracker root
 * would otherwise arrive as the Ticket `alpha/issues/01.md` and collide with the real one.
 * `absPath` keeps the true name, so the copy button still copies something that exists.
 *
 * ## What the walk skips, and where each skip is stated
 *
 *   - **`.git`, `.out-of-scope/` and `node_modules`** — an explicit list, not a rule about
 *     dot-directories. A prefix rule reads as tidy and quietly discards any Feature whose
 *     name begins with a dot; only these three are actually licensed, `.out-of-scope/` by
 *     the spec and the other two by not being tracker content at all.
 *   - **A directory whose `.git` is a *file*** — a git worktree pointer. Skipped and
 *     **counted**, and checked *before* the skip list so a worktree at `.scratch/.detached/`
 *     is still counted rather than vanishing into a name rule.
 *   - **A directory reached through a symbolic link** — not followed, and **listed** in
 *     `unreadableDirs`. Following it would give its files a second identity under the link's
 *     name: an alias sorted before the real directory wins the walk, and every Ticket under
 *     it is then classified by the alias's name instead of `issues/`.
 *   - **Anything past `maxDepth`, and files past `maxFiles`** — backstops so no pathological
 *     tree can wedge a scan the watcher runs every few hundred milliseconds. Both are listed
 *     in `unreadableDirs`; a file past `maxFileBytes` carries a `readError` instead.
 *   - **An entry that is neither a file nor a directory**, and a symbolic link whose target
 *     does not exist. Neither holds tracker content, so neither is an omission.
 *
 * ## Portability, stated rather than assumed
 *
 * The board runs wherever Node does, so nothing here may depend on one platform's habits.
 * Paths are built with `node:path` and **emitted** with POSIX separators; no absolute path,
 * drive letter or user directory appears anywhere in this module or its tests. Symbolic
 * links are handled through the port rather than through any one platform's semantics, and
 * the cycle guard uses canonical paths so it does not depend on link support at all.
 *
 * The skipped directory names are compared **case-sensitively, on purpose**. Git writes its
 * marker lower-case on every platform, so `.git` is the name the walk actually sees; a
 * directory somebody named `.GIT` is *theirs*. On a case-sensitive file system the two are
 * different directories and matching exactly keeps the one that holds content, where a
 * case-folding match would silently omit it. On a case-insensitive one the two cannot both
 * exist, and the worktree probe — which asks the file system for `<dir>/.git` rather than
 * comparing strings — resolves whichever spelling is on disk. The ADR extension check is the
 * one deliberately case-insensitive comparison: `.MD` and `.md` are the same kind of
 * document everywhere.
 *
 * ## Credentials never leave the detector
 *
 * A git remote URL routinely carries a token. Tracker detection reads one and returns only a
 * {@link TrackerKind} — the URL is never stored on the `Root`, never put in a warning, never
 * logged. See {@link detectTracker}.
 */

import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Root, ScannedFile, TrackerKind, UnreadableDir } from '../core/types.ts';

/** Where the tracker lives inside a Root, unless the caller says otherwise. */
const DEFAULT_TRACKER_DIR = '.scratch';
/** Where ADRs live, relative to the Root. */
const DEFAULT_ADR_DIR = 'docs/adr';
/** The Root's glossary, relative to the Root. */
const DEFAULT_GLOSSARY = 'CONTEXT.md';
/** Backstop only. Real tracker trees are three or four levels deep. */
const DEFAULT_MAX_DEPTH = 24;
/** Backstop only. A tracker file is markdown; this stops one huge file wedging a scan. */
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Backstop only. A real tracker holds dozens of files, not tens of thousands. */
const DEFAULT_MAX_FILES = 20_000;

/** Directory names that hold no tracker content. Not a rule about dots — an explicit list. */
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set(['.git', '.out-of-scope', 'node_modules']);

// ---------------------------------------------------------------------------
// The file-system port
// ---------------------------------------------------------------------------

/** What a directory entry is, before a link is resolved. */
export type EntryKind = 'file' | 'dir' | 'link' | 'other';

export interface DirEntry {
  readonly name: string;
  readonly kind: EntryKind;
}

/**
 * What a path turned out to be.
 *
 * `missing` and `error` are kept apart deliberately. Collapsing a permission failure into
 * "not there" is how an inaccessible glossary comes to render identically to a Root that
 * never had one — the same class of lie as an expired Digest rendering as a Digest that was
 * never written. "Could not look at it" and "was not there" are different facts, and the
 * board is built on stating the difference.
 */
export type PathKind = 'file' | 'dir' | 'other' | 'missing' | 'error';

/**
 * The file-system calls the walk makes.
 *
 * It is a parameter rather than a hard-wired import for one reason, and it is a testing
 * reason: the failures this walk exists to survive — a directory that cannot be listed, a
 * file that disappears between the listing and the read — cannot be produced on a real disk
 * portably, and on some platforms not without elevated privileges. A degradation path that
 * has never been shown to fire is not a check, so the port is what lets each one be driven
 * for real. Production always gets {@link nodeFs}.
 */
export interface ReadTreeFs {
  /** Lists a directory. **Throws** when it cannot — that is the signal the walk acts on. */
  readonly listDir: (dirPath: string) => readonly DirEntry[];
  /** Resolves links. Never throws; distinguishes genuine absence from a failed look. */
  readonly kindOf: (path: string) => PathKind;
  /** Byte length, or `null` when it cannot be determined. Never throws. */
  readonly sizeOf: (path: string) => number | null;
  /**
   * Reads at most `maxBytes` bytes of a file as UTF-8. **Throws** when it cannot; the walk
   * turns that into a `readError`. The bound is part of the contract rather than a check
   * applied afterwards, because a file can grow between a look and a read.
   */
  readonly readFile: (path: string, maxBytes: number) => string;
  /** Canonical path, for cycle detection. Falls back to its argument. Never throws. */
  readonly realPath: (path: string) => string;
}

/** The real file system. */
export const nodeFs: ReadTreeFs = {
  listDir(dirPath) {
    return readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink()
        ? 'link'
        : entry.isDirectory()
          ? 'dir'
          : entry.isFile()
            ? 'file'
            : 'other',
    }));
  },
  kindOf(path) {
    try {
      const stats = statSync(path);
      return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
    } catch (error) {
      return isMissing(error) ? 'missing' : 'error';
    }
  },
  sizeOf(path) {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  readFile(path, maxBytes) {
    // Opened once, then measured and read through the **same handle**. Looking at a path by
    // name and then reading it by name are two operations on two possibly different files:
    // a log an agent is appending to can pass a size check and then be read past the limit.
    // `fstat` on the open handle closes that, and the buffer is exactly the file's size
    // rather than the limit, so a 4 MiB cap does not cost 4 MiB per markdown file.
    const handle = openSync(path, 'r');
    try {
      const size = fstatSync(handle).size;
      if (size > maxBytes) {
        throw new Error(`file is ${size} bytes, above the ${maxBytes}-byte read limit`);
      }
      const buffer = Buffer.alloc(size);
      let filled = 0;
      while (filled < size) {
        const read = readSync(handle, buffer, filled, size - filled, null);
        if (read === 0) break;
        filled += read;
      }
      // A file that grew after `fstat` is read short. That is a torn read, which the seam
      // already renders as an `unparsed` card that the next write resolves — the documented
      // steady state, and a bounded one.
      return buffer.subarray(0, filled).toString('utf8');
    } finally {
      closeSync(handle);
    }
  },
  realPath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReadTreeOptions {
  /**
   * Tracker directory name inside the Root. Default `.scratch`. Ignored when
   * {@link ReadTreeOptions.trackerPath} is given.
   */
  readonly trackerDirName?: string;
  /** Tracker directory, absolute or resolved against the Root. Overrides `trackerDirName`. */
  readonly trackerPath?: string;
  /** Display label for the Root. Default: the Root directory's base name. */
  readonly label?: string;
  /** ADR directory, **Root-relative**. Default `docs/adr`. Anything outside the Root is refused. */
  readonly adrDir?: string;
  /** Glossary file, **Root-relative**. Default `CONTEXT.md`. Anything outside the Root is refused. */
  readonly glossaryPath?: string;
  /** Files above this many bytes are not read; the card states why. Default 4 MiB. */
  readonly maxFileBytes?: number;
  /** Directory nesting cap under the tracker directory. Default 24. */
  readonly maxDepth?: number;
  /** Total file cap for one walk. Default 20000. A truncated walk says so. */
  readonly maxFiles?: number;
  /** File-system port. Defaults to {@link nodeFs}; overridden only by fault-injection tests. */
  readonly fs?: ReadTreeFs;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface WalkState {
  readonly fs: ReadTreeFs;
  readonly maxFileBytes: number;
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly files: ScannedFile[];
  readonly unreadableDirs: UnreadableDir[];
  /** Canonical paths already walked. A second arrival is another route into the same tree. */
  readonly visited: Set<string>;
  /** Canonical tracker directory. A symbolic link may not resolve outside it. */
  readonly trackerReal: string;
  hiddenWorktrees: number;
  truncated: boolean;
}

/**
 * Walk a Root and return the in-memory tree the seam consumes.
 *
 * **Never throws — including on its own arguments.** Type stripping erases without checking,
 * so `rootPath` and `options` are validated at run time like anything else that arrives from
 * outside. A Root with no tracker directory is an empty board rather than an error, which is
 * the ordinary state of a repo that was just registered.
 */
export function readTree(rootPath: string, options: ReadTreeOptions = {}): Root {
  try {
    return walkRoot(rootPath, options);
  } catch (error) {
    // Setup failed — an unusable path, an options object that is not one, a port missing a
    // method. The contract is that a caller always gets a Root back, so it gets one that
    // states why it is empty instead of an exception it did not expect.
    return {
      path: typeof rootPath === 'string' ? rootPath : '',
      label: '',
      trackerPath: '',
      files: [],
      hiddenWorktrees: 0,
      tracker: 'local-markdown',
      adrFiles: [],
      glossaryFile: null,
      unreadableDirs: [{ path: '.', error: `the Root could not be read: ${errorMessage(error)}` }],
    };
  }
}

function walkRoot(rootPath: string, options: ReadTreeOptions): Root {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new Error('rootPath must be a non-empty string');
  }
  const settings = readOptions(options);
  const fs = settings.fs;
  const rootAbs = resolve(rootPath);
  const trackerAbs = resolve(rootAbs, settings.trackerPath ?? DEFAULT_TRACKER_DIR);

  const state: WalkState = {
    fs,
    maxFileBytes: readLimit(settings.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    maxDepth: readLimit(settings.maxDepth, DEFAULT_MAX_DEPTH),
    maxFiles: readLimit(settings.maxFiles, DEFAULT_MAX_FILES),
    files: [],
    unreadableDirs: [],
    visited: new Set<string>(),
    trackerReal: guard(() => fs.realPath(trackerAbs), trackerAbs),
    hiddenWorktrees: 0,
    truncated: false,
  };

  try {
    walkDir(state, trackerAbs, '', 0);
  } catch (error) {
    // Rule zero at the outermost scope. A walk that died halfway still reports whatever it
    // reached, and says that it stopped, rather than taking the whole board down.
    omit(state, '.', errorMessage(error));
  }

  // Sorted so one file write produces one identical Snapshot. A walk whose output order
  // drifts makes the board re-render for no reason.
  state.files.sort((left, right) => comparePaths(left.path, right.path));

  // The three collectors below are individually guarded for the same reason the walk is:
  // each of them reads a disk, and losing the whole tree because a glossary went missing
  // mid-read would be exactly the failure rule zero exists to prevent. A Root that could
  // not be classified reads as `local-markdown`, which shows the board rather than a
  // warning about a tracker nobody could look at.
  return {
    path: rootAbs,
    label: readLabel(settings.label, rootAbs),
    trackerPath: trackerAbs,
    files: state.files,
    hiddenWorktrees: state.hiddenWorktrees,
    tracker: guard(() => detectTracker(rootAbs, fs, state.files.length > 0), 'local-markdown'),
    adrFiles: guard(() => readAdrFiles(state, rootAbs, settings.adrDir ?? DEFAULT_ADR_DIR), []),
    glossaryFile: guard(
      () => readGlossary(state, rootAbs, settings.glossaryPath ?? DEFAULT_GLOSSARY),
      null,
    ),
    unreadableDirs: state.unreadableDirs,
  };
}

interface Settings {
  readonly fs: ReadTreeFs;
  readonly trackerPath: string | null;
  readonly label: string | null;
  readonly adrDir: string | null;
  readonly glossaryPath: string | null;
  readonly maxFileBytes: number | undefined;
  readonly maxDepth: number | undefined;
  readonly maxFiles: number | undefined;
}

/**
 * Options, checked rather than trusted. The declared types are erased before anything runs,
 * so a caller can hand this function a number where a path belongs — and `path.resolve`
 * throws on one, which would break the never-throws contract before the walk even starts.
 */
function readOptions(options: ReadTreeOptions): Settings {
  const given = typeof options === 'object' && options !== null ? options : {};
  const port = given.fs;
  if (port !== undefined && !isReadTreeFs(port)) {
    throw new Error('options.fs is not a file-system port');
  }
  return {
    fs: port ?? nodeFs,
    trackerPath: readOptionPath(given.trackerPath) ?? readOptionPath(given.trackerDirName),
    label: readOptionPath(given.label),
    adrDir: readOptionPath(given.adrDir),
    glossaryPath: readOptionPath(given.glossaryPath),
    maxFileBytes: typeof given.maxFileBytes === 'number' ? given.maxFileBytes : undefined,
    maxDepth: typeof given.maxDepth === 'number' ? given.maxDepth : undefined,
    maxFiles: typeof given.maxFiles === 'number' ? given.maxFiles : undefined,
  };
}

function readOptionPath(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isReadTreeFs(value: ReadTreeFs): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const required = ['listDir', 'kindOf', 'sizeOf', 'readFile', 'realPath'] as const;
  return required.every((name) => typeof value[name] === 'function');
}

function walkDir(state: WalkState, absDir: string, relDir: string, depth: number): void {
  const here = relDir === '' ? '.' : relDir;

  // Truncation stops the traversal, not just the pushing. Returning from the push alone
  // leaves the walk listing every remaining directory — the cap would bound the output
  // while the work it was added to bound carried on.
  if (state.truncated) return;

  if (depth > state.maxDepth) {
    omit(state, here, `nested deeper than the ${state.maxDepth}-level limit`);
    return;
  }

  // Termination guard for a tree that is reachable from itself by some route other than a
  // symbolic link — a bind mount, say, since links are not followed at all. First arrival
  // wins, which is deterministic because entries are walked in sorted order.
  const canonical = state.fs.realPath(absDir);
  if (state.visited.has(canonical)) return;
  state.visited.add(canonical);

  let entries: readonly DirEntry[];
  try {
    entries = state.fs.listDir(absDir);
  } catch (error) {
    // Absence is only unremarkable at the top: a Root with no `.scratch/` is an empty
    // board. Deeper down, the parent listing named this directory a moment ago, so it
    // being gone now means its Tickets are missing from *this* scan and the board must
    // say so. The next re-scan will find them under their new name.
    if (!(relDir === '' && isMissing(error))) omit(state, here, errorMessage(error));
    return;
  }

  for (const entry of [...entries].sort((left, right) => comparePaths(left.name, right.name))) {
    if (state.truncated) return;

    // A name carrying a path separator has no honest tracker-relative identity. On POSIX a
    // filename may contain `\`, and `core/index.ts` reads `\` as a separator — so a file
    // named `alpha\issues\01.md` in the tracker root would arrive as the Ticket
    // `alpha/issues/01.md` and take that card's id away from the real one. Percent-encoding
    // it instead only moves the collision onto the encoded spelling, and encoding `%` as
    // well would mangle every ordinary filename containing one. Refusing it costs nothing on
    // any real name and is *stated*, which is the standard the rest of this module holds to.
    if (entry.name.includes('\\') || entry.name.includes('/')) {
      omit(state, here, `an entry named ${JSON.stringify(entry.name)} contains a path separator and has no unambiguous path; it is not on the board`);
      continue;
    }

    const abs = join(absDir, entry.name);
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

    if (entry.kind === 'link') {
      readLinkEntry(state, abs, rel);
      continue;
    }

    if (entry.kind === 'dir') {
      // Before the skip list, not after: a worktree at `.scratch/.detached/` is still a
      // counted omission. The count is the whole point of skipping these visibly — a
      // worktree that a name rule swallowed first would take a whole tree with it.
      if (state.fs.kindOf(join(abs, '.git')) === 'file') {
        state.hiddenWorktrees += 1;
        continue;
      }
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      walkDir(state, abs, rel, depth + 1);
      continue;
    }

    if (entry.kind === 'file') pushFile(state, abs, rel);
    // `other` — a socket, a device node, a named pipe. No tracker content, so no omission.
  }
}

/**
 * A symbolic link. A link to a **file** is read like any other file. A link to a
 * **directory** is not followed, and is listed as an omission.
 *
 * Following it looks harmless and is not. The link's name becomes part of every path
 * beneath it, and `ScannedFile.path` is both the classification input and the identity: an
 * alias called `0alias` pointing at `issues/` sorts first, wins the walk, and every Ticket
 * under it arrives as `<feature>/0alias/…` — a sibling link rather than a Ticket, with the
 * real `issues/` directory then skipped as already visited.
 */
function readLinkEntry(state: WalkState, abs: string, rel: string): void {
  const kind = state.fs.kindOf(abs);
  if (kind === 'dir') {
    omit(state, rel, 'symbolic link to a directory; not followed, so its contents are not on the board');
    return;
  }
  if (kind === 'file') {
    // A link may not reach outside the tracker directory. The board reads file contents and
    // renders them, and a link is the one way a file the user never put in the tracker
    // directory can be read as though they had — `.git/config`, say, whose remote URL
    // routinely carries a token. The entry is still represented, carrying the reason it has
    // no content, so nothing disappears.
    if (!containedIn(state, state.trackerReal, abs)) {
      state.files.push({
        path: rel,
        absPath: abs,
        text: null,
        readError: 'symbolic link resolves outside the tracker directory and was not read',
      });
      return;
    }
    pushFile(state, abs, rel);
    return;
  }
  if (kind === 'error') {
    // Listed but unresolvable. Stated as an unreadable file rather than dropped, because
    // "could not look at it" and "was not there" are different facts.
    state.files.push({ path: rel, absPath: abs, text: null, readError: 'symbolic link could not be resolved' });
    return;
  }
  // `missing` — a dangling link. `other` — a link to a socket or a device node. Neither
  // holds tracker content, so neither is an omission.
}

function pushFile(state: WalkState, absPath: string, relPath: string): void {
  if (state.truncated) return;
  state.files.push(readScannedFile(state, absPath, relPath));
  if (state.files.length < state.maxFiles) return;

  // Truncation is declared the moment the cap is *reached*, not when the next push is
  // refused. Waiting for the refusal means the walk first lists its way to wherever the next
  // file happens to live, which is the traversal work the cap exists to stop. The cost is
  // that a tracker holding exactly the cap says it stopped when nothing was in fact left
  // out — a false alarm rather than a silent omission, which is the right way round.
  state.truncated = true;
  omit(
    state,
    '.',
    `stopped after ${state.maxFiles} files; anything past the limit is not on the board`,
  );
}

/**
 * Read one file. A failure is carried on the file rather than thrown: the seam renders it as
 * an `unparsed` card showing the raw filename, and the next write resolves it.
 */
function readScannedFile(state: WalkState, absPath: string, relPath: string): ScannedFile {
  const size = state.fs.sizeOf(absPath);
  if (size !== null && size > state.maxFileBytes) {
    return {
      path: relPath,
      absPath,
      text: null,
      readError: `file is ${size} bytes, above the ${state.maxFileBytes}-byte read limit`,
    };
  }
  try {
    return { path: relPath, absPath, text: state.fs.readFile(absPath, state.maxFileBytes) };
  } catch (error) {
    return { path: relPath, absPath, text: null, readError: errorMessage(error) };
  }
}

function omit(state: WalkState, path: string, reason: string): void {
  state.unreadableDirs.push({ path, error: reason });
}

// ---------------------------------------------------------------------------
// Domain-model inputs — collected here, rendered by the domain-model panel
// ---------------------------------------------------------------------------

/**
 * Every `.md` under the Root's ADR directory, with **Root-relative** paths. A Root without
 * one is normal and yields an empty list; ADRs are not required to have a board. A directory
 * that exists and could not be read is listed instead, so "no ADRs" and "the ADRs could not
 * be reached" do not render identically.
 */
function readAdrFiles(state: WalkState, rootAbs: string, adrDir: string): readonly ScannedFile[] {
  const absDir = resolve(rootAbs, adrDir);
  if (!insideRoot(rootAbs, absDir)) {
    omit(state, adrDir, 'ADR directory resolves outside the Root and was not read');
    return [];
  }

  let entries: readonly DirEntry[];
  try {
    entries = state.fs.listDir(absDir);
  } catch (error) {
    if (!isMissing(error)) omit(state, relativePosix(rootAbs, absDir), errorMessage(error));
    return [];
  }

  const rootReal = guard(() => state.fs.realPath(rootAbs), rootAbs);
  const found: ScannedFile[] = [];
  for (const entry of [...entries].sort((left, right) => comparePaths(left.name, right.name))) {
    if (entry.name.includes('\\') || entry.name.includes('/')) continue;
    const abs = join(absDir, entry.name);
    const kind = entry.kind === 'link' ? state.fs.kindOf(abs) : entry.kind;
    if (kind !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue;
    found.push(readContained(state, rootReal, abs, relativePosix(rootAbs, abs)));
  }
  return found;
}

/**
 * Read a file that must resolve inside `boundaryReal`. A link reaching out of the Root is
 * represented carrying its reason rather than read — the same rule the tracker walk applies,
 * and for the same reason: a link is how a file nobody put here gets read as though they had.
 */
function readContained(
  state: WalkState,
  boundaryReal: string,
  absPath: string,
  relPath: string,
): ScannedFile {
  if (!containedIn(state, boundaryReal, absPath)) {
    return {
      path: relPath,
      absPath,
      text: null,
      readError: 'resolves outside the Root and was not read',
    };
  }
  return readScannedFile(state, absPath, relPath);
}

/**
 * The Root's glossary, with a **Root-relative** path, or `null` when it has none. A glossary
 * that is there but could not be looked at is returned carrying its `readError`, not as
 * `null` — absent and unreachable are different answers.
 */
function readGlossary(
  state: WalkState,
  rootAbs: string,
  glossaryPath: string,
): ScannedFile | null {
  const abs = resolve(rootAbs, glossaryPath);
  if (!insideRoot(rootAbs, abs)) {
    omit(state, glossaryPath, 'glossary resolves outside the Root and was not read');
    return null;
  }
  const kind = state.fs.kindOf(abs);
  if (kind !== 'file' && kind !== 'error') return null;
  const rootReal = guard(() => state.fs.realPath(rootAbs), rootAbs);
  return readContained(state, rootReal, abs, relativePosix(rootAbs, abs));
}

// ---------------------------------------------------------------------------
// Tracker detection
// ---------------------------------------------------------------------------

/**
 * Which tracker this Root actually uses.
 *
 * **Local markdown wins whenever it is present.** The ordering is the whole rule, and it is
 * not cosmetic: a repository is very often hosted on GitHub *and* keeping its tracker in
 * local markdown at the same time. Ranking the remote first badges such a repository
 * `github` and renders an unsupported-tracker warning over a tracker that is sitting right
 * there. The remote host is consulted **only** when the walk found no local tracker content
 * at all — the case the warning is actually for, where a board would otherwise render empty
 * with no explanation of why.
 *
 * A self-hosted forge on a custom domain is undetectable from a remote URL and falls back to
 * `local-markdown`. That is the safe direction: a missing warning shows an empty board, a
 * wrong warning hides a real one.
 *
 * ## Only the host ever leaves this function
 *
 * A git remote routinely carries credentials in its user-info section. The board is a **web
 * page**, so a remote value that reached a `Warning`
 * message would put a token on screen and into anything that copies the Snapshot. Nothing
 * here returns, stores, logs or embeds the URL: the only value that escapes is a
 * {@link TrackerKind}, and the warning the seam renders names a kind and never a URL. A
 * config that cannot be parsed reads as "not detected" rather than as a reason to quote the
 * text that failed.
 */
function detectTracker(rootAbs: string, fs: ReadTreeFs, hasLocalContent: boolean): TrackerKind {
  if (hasLocalContent) return 'local-markdown';
  const url = originUrl(rootAbs, fs);
  if (url === null) return 'local-markdown';
  const host = hostOf(url);
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com') || host.startsWith('gitlab.')) {
    return 'gitlab';
  }
  return 'local-markdown';
}

/**
 * The `url` of the `origin` remote, or of the first remote when there is no `origin`.
 * `null` when the Root is not a git repository, or has no remote, or the config cannot be
 * read — all three mean the same thing here: nothing to detect.
 */
function originUrl(rootAbs: string, fs: ReadTreeFs): string | null {
  const configPath = gitConfigPath(rootAbs, fs);
  if (configPath === null) return null;
  let text: string;
  try {
    text = fs.readFile(configPath, DEFAULT_MAX_FILE_BYTES);
  } catch {
    return null;
  }

  let section = '';
  let firstRemote: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      // A header must actually close. An unterminated `[remote "origin"` is not a section
      // git would honour, and treating it as one detects a tracker from a config that does
      // not parse — a confident answer read out of a malformed file.
      section = trimmed.endsWith(']') ? trimmed.toLowerCase() : '';
      continue;
    }
    if (!section.startsWith('[remote ')) continue;
    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;
    if (trimmed.slice(0, equals).trim().toLowerCase() !== 'url') continue;
    const url = unquoteConfigValue(trimmed.slice(equals + 1).trim());
    if (url.length === 0) continue;
    if (section === '[remote "origin"]') return url;
    firstRemote ??= url;
  }
  return firstRemote;
}

/**
 * Git config values may be quoted, and the quotes are not part of the value. Left in, an
 * ordinary quoted web remote yields a host that begins with a quote, matches no forge, and
 * leaves an empty hosted repository with no warning on the board.
 */
function unquoteConfigValue(value: string): string {
  const trimmed = value.replace(/[;#].*$/, '').trim();
  if (!trimmed.startsWith('"')) return trimmed;
  let out = '';
  for (let i = 1; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === '\\' && i + 1 < trimmed.length) {
      out += trimmed[i + 1];
      i += 1;
      continue;
    }
    if (char === '"') break;
    out += char;
  }
  return out;
}

/**
 * Where this Root's git config lives.
 *
 * A `.git` that is a **file** is a pointer, and a Root that is itself a git worktree is not
 * exotic — running an agent in one is routine. A worktree has no config of its own: the
 * remotes live in the *common* directory, which the worktree's gitdir names in `commondir`.
 */
function gitConfigPath(rootAbs: string, fs: ReadTreeFs): string | null {
  const dotGit = join(rootAbs, '.git');
  const kind = fs.kindOf(dotGit);
  if (kind === 'dir') return join(dotGit, 'config');
  if (kind !== 'file') return null;

  let pointer: string;
  try {
    pointer = fs.readFile(dotGit, DEFAULT_MAX_FILE_BYTES);
  } catch {
    return null;
  }
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (match === null) return null;
  const gitDir = resolve(rootAbs, match[1] ?? '');

  try {
    const common = resolve(gitDir, fs.readFile(join(gitDir, 'commondir'), DEFAULT_MAX_FILE_BYTES).trim());
    if (fs.kindOf(join(common, 'config')) === 'file') return join(common, 'config');
  } catch {
    // No `commondir` — this gitdir is the whole repository, so its own config is the one.
  }
  return fs.kindOf(join(gitDir, 'config')) === 'file' ? join(gitDir, 'config') : null;
}

/**
 * The host out of a git remote URL, lower-cased. Handles both scheme-based and scp-like
 * spellings written by git.
 * Anything it cannot read yields `''`, which matches no known forge.
 *
 * The userinfo section is dropped rather than parsed, and the return value is a host and
 * nothing else. That is what keeps a credential embedded in a remote URL from travelling any
 * further than this function.
 */
function hostOf(url: string): string {
  const trimmed = url.trim();
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(trimmed);
  if (scheme !== null) {
    const authority = trimmed.slice(scheme[0].length).split('/')[0] ?? '';
    const at = authority.lastIndexOf('@');
    const hostPort = at === -1 ? authority : authority.slice(at + 1);
    return (hostPort.split(':')[0] ?? '').toLowerCase();
  }
  const scp = /^(?:[^@/]+@)?([^/:]+):/.exec(trimmed);
  return (scp?.[1] ?? '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Small helpers. Nothing here trusts a declared type: options arrive from a caller and
// everything else arrives from a disk, and type stripping erases without checking.
// ---------------------------------------------------------------------------

/**
 * Whether the canonical target of `abs` is `boundaryReal` or sits inside it.
 *
 * Both sides are canonicalised before they are compared, so a boundary that is itself
 * reached through a platform temporary-directory alias still compares correctly.
 */
function containedIn(state: WalkState, boundaryReal: string, abs: string): boolean {
  const target = guard(() => state.fs.realPath(abs), abs);
  if (target === boundaryReal) return true;
  const rel = relative(boundaryReal, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function readLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function readLabel(value: string | null, rootAbs: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  const name = basename(rootAbs);
  return name.length > 0 ? name : rootAbs;
}

/** Whether `target` sits strictly inside `rootAbs`, so a Root-relative path cannot start `..`. */
function insideRoot(rootAbs: string, target: string): boolean {
  const rel = relative(rootAbs, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function relativePosix(from: string, to: string): string {
  return relative(from, to).split(sep).join('/').split('\\').join('/');
}

function comparePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `ENOENT` alone. A path that is a file where a directory was expected is a real defect. */
function isMissing(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return error.code === 'ENOENT';
}

/** Rule zero, applied to one collector: a read that failed degrades to its neutral answer. */
function guard<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
