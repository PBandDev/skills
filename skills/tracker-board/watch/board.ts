/**
 * tracker-board — the board process's state.
 *
 * A Board holds the registered Roots, wakes on change, re-scans **in full**, and hands the
 * resulting Snapshot to whoever is subscribed. It is everything the server serves and nothing
 * to do with HTTP, so the whole of the watcher's behaviour is testable without opening a
 * socket.
 *
 * ## Three rules that look like implementation detail and are not
 *
 * **A full re-scan, never a diff.** One file write re-reads every Root. Incremental diffing is
 * explicitly out of scope: a full scan of a markdown tracker measures ~7 ms, and the
 * bookkeeping needed to update a Snapshot in place is the main way a project like this becomes
 * expensive to own. `readTree` is synchronous, which is what makes this safe — a change event
 * cannot interleave with a scan, it can only queue behind one.
 *
 * **Publish on a changed Snapshot, not on a change event.** Sources are noisy in different
 * ways: a single save emits three `fs.watch` events, and a polled source emits one tick per
 * interval whether or not anything moved. Comparing the rendered Snapshot collapses both into
 * the same rule, so one save is one frame on the watched path and no writes is no frames on
 * the polled one — without either source needing a private idea of what counts as a change.
 *
 * The guarantee is precisely: **a save that completes within the debounce produces one frame.**
 * An editor that truncates a file, pauses longer than the debounce, then writes it has made two
 * states, and the board shows both — a torn read degrading to an `unparsed` card and resolving
 * on the next write is the documented behaviour, not a defect to suppress. Withholding the
 * board's current truth because a better one might arrive is the opposite of what it is for.
 *
 * **Roots accrete, and the state directory is re-checked on every write.** Invoking the skill
 * in a new repo registers that repo. A Root registered later can contain the state directory
 * even though no earlier one did, so the containment question is asked per write rather than
 * once at startup.
 */

import { realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { deriveSnapshot } from '../core/index.ts';
import { reconcileExtractions, type ReconciliationReport } from '../core/reconciliation.ts';
import type { AnnotationStore, Root, Snapshot } from '../core/types.ts';
import { readTree } from '../scan/readTree.ts';
import type { ReadTreeOptions } from '../scan/readTree.ts';
import { rootArgumentIsValid } from '../server/entrypoint.mjs';
import {
  ANNOTATIONS_FILE,
  readState,
  stateIsOutside,
  writeAnnotations,
  writeSnapshot,
} from '../state/store.ts';
import type { StateProblem } from '../state/store.ts';
import type { ChangeSource, ChangeSourceKind, Stop, Timers } from './changes.ts';
import { polledSource, recursiveWatchSource, startBestSource, systemTimers } from './changes.ts';

/**
 * **A measured starting value, not a constant.** One save of one file emitted three `fs.watch`
 * events on the machine this was measured on; 250 ms coalesced them into a single re-scan
 * while staying under the ~1 s a reader perceives as immediate. Event coalescing differs by
 * platform and by file system, so this is exposed as an option and expected to be tuned rather
 * than treated as a fact about the world.
 */
export const DEFAULT_DEBOUNCE_MS = 250;

/**
 * How often a polled Root re-scans. Deliberately far coarser than the debounce: polling pays a
 * full re-scan per tick on a tree nobody is touching, so it trades latency for cost. It is the
 * fallback path, not the normal one.
 */
export const DEFAULT_POLL_MS = 2_000;

/** A re-scan slower than this is reported rather than left for a user to notice as lag. */
export const SLOW_SCAN_MS = DEFAULT_DEBOUNCE_MS;

/**
 * The longest a change may wait behind a *trailing* debounce before it is scanned anyway.
 *
 * A trailing debounce restarted by every event can be starved indefinitely: ten polled Roots
 * whose ticks land 200 ms apart cancel a 250 ms timer forever, and the board silently stops
 * updating — measured, not imagined. A ceiling on the wait turns that from "never" into "at
 * worst this late", which is the property the board actually needs. Continuous unrelated
 * `fs.watch` traffic on a busy tree fails the same way.
 */
export const DEFAULT_MAX_WAIT_MS = 1_000;

export interface BoardOptions {
  /** See {@link DEFAULT_DEBOUNCE_MS}. Measured starting value, expected to be tuned. */
  readonly debounceMs?: number;
  /** See {@link DEFAULT_MAX_WAIT_MS}. The ceiling that stops a busy tree starving the scan. */
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
  readonly timers?: Timers;
  /** Change source tried first. Replaced by {@link BoardOptions.fallbackSource} if it cannot start. */
  readonly watchSource?: ChangeSource;
  readonly fallbackSource?: ChangeSource;
  /** Passed through to every `readTree` call. The disk-fault injection point. */
  readonly readOptions?: ReadTreeOptions;
  /** State directory override. Tests must set this; it defaults under the home directory. */
  readonly stateDir?: string;
  /** Persist each Snapshot to the state directory. Off by default so tests opt in. */
  readonly persist?: boolean;
}

/** What a Root looks like from outside, without exposing the watcher handle that drives it. */
export interface RegisteredRoot {
  readonly path: string;
  readonly kind: ChangeSourceKind;
  /** Why this Root is polled rather than watched, or `null` when watching started. */
  readonly fellBackBecause: string | null;
}

export interface ScanReport {
  /**
   * How many re-scans this board has run, in total. The debounce's whole job is to keep this
   * from tracking the raw event count, so it has to be observable — a caller that could only
   * see the *latest* report could not tell one scan from three.
   */
  readonly scanCount: number;
  /** Wall time for the whole re-scan: every Root walked, plus the Snapshot derived. */
  readonly durationMs: number;
  readonly rootCount: number;
  readonly fileCount: number;
  /** Whether this scan produced a Snapshot different from the last one published. */
  readonly changed: boolean;
  /** `true` when the re-scan took longer than the debounce that schedules it. */
  readonly slow: boolean;
}

export interface ReconciliationApplyResult extends ReconciliationReport {
  readonly schemaVersion: 1;
  readonly written: boolean;
  readonly refreshed: boolean;
  readonly writeProblem?: string;
}

export interface RegisterOptions {
  /**
   * `deferred` accretes the Root and schedules its full scan through the debounce. The server
   * uses this to acknowledge a singleton handoff before a large synchronous tree walk; ordinary
   * callers keep the default `now` behaviour.
   */
  readonly scan?: 'now' | 'deferred';
  /** Refuse a genuinely new Root once this many are registered; known aliases remain admissible. */
  readonly maxRoots?: number;
}

/** The requested Root was valid but would exceed a caller-owned resource bound. */
export class RootLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`this board already holds ${String(limit)} Roots`);
    this.name = 'RootLimitError';
    this.limit = limit;
  }
}

export interface Board {
  /**
   * Register a Root and re-scan. Registering one that is already registered re-scans without
   * disturbing it — invoking the skill twice in the same repo is the ordinary case.
   */
  readonly register: (rootPath: string, options?: RegisterOptions) => RegisteredRoot;
  readonly roots: () => readonly RegisteredRoot[];
  /** The current Snapshot. Never `null` — an empty board is a Snapshot with no Roots. */
  readonly snapshot: () => Snapshot;
  /** The last scan's timing, or `null` before the first scan. */
  readonly lastScan: () => ScanReport | null;
  /** Called with each newly published Snapshot. Returns an unsubscribe function. */
  readonly subscribe: (listener: (snapshot: Snapshot) => void) => Stop;
  /** Re-scan now, skipping the debounce. Returns whether the Snapshot changed. */
  readonly rescanNow: () => boolean;
  /** Atomically evaluate, persist, and publish one bounded Reconciliation page. */
  readonly reconcile: (response: unknown, after?: string | null) => ReconciliationApplyResult;
  /** Whether the state directory sits outside every registered Root. */
  readonly stateIsSafe: () => boolean;
  /** The last failed persistent Snapshot write, cleared by the next successful one. */
  readonly stateWriteProblem: () => StateProblem | null;
  readonly stop: () => void;
}

/** One existing on-disk directory has one Root identity, even when reached through a link or `..`. */
export function canonicalRootPath(rootPath: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(rootPath));
  } catch {
    throw new TypeError('Root must name an existing directory.');
  }
  if (!rootArgumentIsValid(canonical)) {
    throw new TypeError('Root canonical path must be absolute, bounded, and contain no control characters.');
  }
  try {
    if (!statSync(canonical).isDirectory()) throw new TypeError('Root must name an existing directory.');
  } catch {
    throw new TypeError('Root must name an existing directory.');
  }
  return canonical;
}

export function createBoard(options: BoardOptions = {}): Board {
  const timers = options.timers ?? systemTimers;
  const debounceMs = readInterval(options.debounceMs, DEFAULT_DEBOUNCE_MS);
  const maxWaitMs = readInterval(options.maxWaitMs, DEFAULT_MAX_WAIT_MS);
  const pollMs = readInterval(options.pollMs, DEFAULT_POLL_MS);
  const watchSource = options.watchSource ?? recursiveWatchSource;
  const fallbackSource = options.fallbackSource ?? polledSource(pollMs, timers);

  const registered = new Map<string, RegisteredRoot>();
  const stops = new Map<string, Stop>();
  const listeners = new Set<(snapshot: Snapshot) => void>();

  let annotations: AnnotationStore = { schemaVersion: 1, entries: [] };
  let current: Snapshot = deriveSnapshot({ roots: [] }, annotations);
  let published = serialise(current);
  let lastScan: ScanReport | null = null;
  let scanCount = 0;
  let cancelDebounce: Stop | null = null;
  /** When the oldest unscanned event arrived, or null when nothing is pending. */
  let pendingSince: number | null = null;
  let stopped = false;
  let stateWriteProblem: StateProblem | null = null;

  /** Re-read the AI-owned store, so an Annotation written between scans is picked up. */
  function refreshAnnotations(): void {
    try {
      annotations = readState(options.stateDir).annotations;
    } catch {
      // Rule zero: the store is outside this process's control. An unreadable one reads as
      // the empty store rather than taking the board down.
      annotations = { schemaVersion: 1, entries: [] };
    }
  }

  function readRegisteredScan(): { readonly roots: readonly Root[] } {
    const roots: Root[] = [];
    for (const rootPath of registered.keys()) {
      try {
        roots.push(readTree(rootPath, options.readOptions));
      } catch {
        // `readTree` is documented never to throw, including on its own arguments. This is
        // belt and braces: one Root that somehow did must not cost the others their scan.
      }
    }
    return { roots };
  }

  function scan(forcePublish = false): boolean {
    scanCount += 1;
    const started = timers.now();
    const nextScan = readRegisteredScan();
    refreshAnnotations();
    const next = deriveSnapshot(nextScan, annotations);
    const rendered = serialise(next);
    const changed = rendered !== published;
    current = next;
    if (changed) published = rendered;

    const durationMs = timers.now() - started;
    lastScan = {
      scanCount,
      durationMs,
      rootCount: nextScan.roots.length,
      fileCount: nextScan.roots.reduce((total, root) => total + root.files.length, 0),
      changed,
      slow: durationMs > debounceMs,
    };

    if (options.persist === true && (changed || forcePublish || stateWriteProblem !== null)) {
      persist(next);
    }
    if (changed || forcePublish) {
      for (const listener of [...listeners]) {
        try {
          listener(next);
        } catch {
          // One subscriber throwing — a socket that closed mid-write — must not stop the
          // others being told, and must not unwind the scan that produced the Snapshot.
        }
      }
    }
    return changed;
  }

  function persist(snapshot: Snapshot): void {
    // Roots accrete, so the containment question is asked here rather than at startup: a
    // Root registered a minute ago can contain the state directory even though none did
    // when the process started. The store refuses rather than relocating and returns the
    // problem for health checks and launch diagnostics.
    stateWriteProblem = writeSnapshot(snapshot, options.stateDir, [...registered.keys()]).problem;
  }

  /**
   * What a Root does when its source dies mid-life.
   *
   * A watcher can start cleanly and fail an hour later — a permission change, a handle limit,
   * the directory replaced. Left alone the Root keeps reporting itself as watched while
   * nothing watches it, and every later change to it is lost with no warning anywhere. So the
   * Root is moved to the fallback, its reported kind changes to match, and it is re-scanned
   * immediately in case the failure and a change arrived together.
   */
  function handlersFor(rootPath: string): { onChange: () => void; onFailure: (reason: string) => void } {
    return {
      onChange: requestScan,
      onFailure: (reason) => {
        if (stopped || !registered.has(rootPath)) return;
        stops.get(rootPath)?.();
        const replacement = fallbackSource.start(rootPath, handlersFor(rootPath));
        stops.set(rootPath, replacement.stop);
        registered.set(rootPath, {
          path: rootPath,
          kind: fallbackSource.kind,
          fellBackBecause: reason,
        });
        requestScan();
      },
    };
  }

  /**
   * A registered directory entry can be replaced while the process is alive. If the new entry is
   * an alias of the Root currently being registered, the old map key and watcher no longer name
   * the filesystem identity they were created for. Coalesce those stale aliases before lookup so
   * one current directory cannot acquire two Roots.
   */
  function refreshAliasesOf(canonicalPath: string): RegisteredRoot | undefined {
    const exact = registered.get(canonicalPath);
    const staleAliases: string[] = [];
    for (const storedPath of registered.keys()) {
      if (storedPath === canonicalPath) continue;
      try {
        if (canonicalRootPath(storedPath) === canonicalPath) staleAliases.push(storedPath);
      } catch {
        // A missing Root may be transient and its source owns the fallback/reporting path. It is
        // not an alias of the requested directory until the filesystem can prove that it is.
      }
    }
    if (staleAliases.length === 0) return exact;

    if (exact !== undefined) {
      for (const stalePath of staleAliases) {
        stops.get(stalePath)?.();
        stops.delete(stalePath);
        registered.delete(stalePath);
      }
      return exact;
    }

    // Start the replacement before stopping the stale source. If startup throws, the board keeps
    // its previous watcher and identity instead of losing the Root halfway through a re-key.
    const started = startBestSource(canonicalPath, handlersFor(canonicalPath), watchSource, fallbackSource);
    const replacement: RegisteredRoot = {
      path: canonicalPath,
      kind: started.kind,
      fellBackBecause: started.fellBackBecause,
    };
    for (const stalePath of staleAliases) {
      stops.get(stalePath)?.();
      stops.delete(stalePath);
      registered.delete(stalePath);
    }
    stops.set(canonicalPath, started.stop);
    registered.set(canonicalPath, replacement);
    return replacement;
  }

  function runPendingScan(forcePublish = false): boolean {
    cancelDebounce?.();
    cancelDebounce = null;
    pendingSince = null;
    return scan(forcePublish);
  }

  function requestScan(): void {
    if (stopped) return;
    // Restarting the timer on every event is what turns a burst into one scan. A change that
    // arrives *during* a scan cannot be lost: `readTree` is synchronous, so the event is
    // queued behind the scan and schedules the next one when it runs.
    //
    // On its own, though, restarting can be starved: events arriving closer together than the
    // debounce cancel it forever, and the board stops updating without saying so. So the
    // first event of a run is remembered, and once it has waited `maxWaitMs` the scan happens
    // regardless of how much noise is still arriving.
    if (pendingSince === null) pendingSince = timers.now();
    if (timers.now() - pendingSince >= maxWaitMs) {
      runPendingScan();
      return;
    }
    cancelDebounce?.();
    cancelDebounce = timers.delay(debounceMs, runPendingScan);
  }

  /**
   * A singleton acknowledgement must never inherit `requestScan`'s synchronous max-wait branch.
   * The HTTP response pulls this scan forward on `finish`; this timer is the fallback when that
   * response never finishes, and deliberately remains asynchronous even when older work is due.
   */
  function requestDeferredScan(): void {
    if (stopped) return;
    if (pendingSince === null) pendingSince = timers.now();
    cancelDebounce?.();
    cancelDebounce = timers.delay(debounceMs, runPendingScan);
  }

  return {
    register(rootPath, registerOptions = {}) {
      const canonicalPath = canonicalRootPath(rootPath);
      const maxRoots = readRootLimit(registerOptions.maxRoots);
      const existing = refreshAliasesOf(canonicalPath);
      if (existing !== undefined) {
        // Already watched. Re-scan so the caller sees current state, and leave the source
        // alone — tearing it down and rebuilding it would drop events in the gap. The
        // pending debounce is absorbed rather than left to fire: this scan is about to read
        // the same tree, so letting both run would be one redundant full walk.
        if (registerOptions.scan === 'deferred') requestDeferredScan();
        else runPendingScan();
        return existing;
      }
      if (maxRoots !== null && registered.size >= maxRoots) throw new RootLimitError(maxRoots);
      const started = startBestSource(canonicalPath, handlersFor(canonicalPath), watchSource, fallbackSource);
      stops.set(canonicalPath, started.stop);
      const entry: RegisteredRoot = {
        path: canonicalPath,
        kind: started.kind,
        fellBackBecause: started.fellBackBecause,
      };
      registered.set(canonicalPath, entry);
      if (registerOptions.scan === 'deferred') requestDeferredScan();
      else runPendingScan();
      return entry;
    },
    roots() {
      return [...registered.values()];
    },
    snapshot() {
      return current;
    },
    lastScan() {
      return lastScan;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rescanNow() {
      return runPendingScan();
    },
    reconcile(response, after = null) {
      // This transaction must stay synchronous. HTTP Root registration and every shipped
      // Reconciliation apply run on the incumbent's one event loop, so no second mutation can
      // interleave between the live Root snapshot, fresh state read, atomic rename, and refresh.
      const rootPaths = [...registered.keys()];
      if (!stateIsOutside(rootPaths, options.stateDir)) {
        throw new Error('the incumbent state directory is unsafe');
      }
      if (stateWriteProblem !== null) {
        throw new Error('the incumbent reports a state write problem');
      }
      const state = readState(options.stateDir);
      const annotationFile = join(state.dir, ANNOTATIONS_FILE);
      const unusable = state.problems.find((problem) => {
        return (
          problem.file === annotationFile &&
          problem.kind !== 'absent' &&
          !(problem.kind === 'schema' && state.droppedForVersion > 0)
        );
      });
      if (unusable !== undefined) {
        throw new Error(`the Annotation state is ${unusable.kind}; it was not overwritten`);
      }

      const reconciled = reconcileExtractions(
        readRegisteredScan(),
        state.annotations,
        response,
        after,
      );
      if (!reconciled.report.accepted || reconciled.store === state.annotations) {
        return {
          schemaVersion: 1,
          ...reconciled.report,
          written: false,
          refreshed: false,
        };
      }
      const written = writeAnnotations(reconciled.store, options.stateDir, rootPaths);
      if (!written.written) {
        return {
          schemaVersion: 1,
          ...reconciled.report,
          written: false,
          refreshed: false,
          writeProblem: written.problem?.kind ?? 'write-failed',
        };
      }

      const before = scanCount;
      runPendingScan(true);
      const postScanProblem = stateWriteProblem as StateProblem | null;
      const refreshed =
        scanCount === before + 1 &&
        stateIsOutside([...registered.keys()], options.stateDir) &&
        postScanProblem === null;
      return {
        schemaVersion: 1,
        ...reconciled.report,
        written: true,
        refreshed,
        ...(postScanProblem === null ? {} : { writeProblem: postScanProblem.kind }),
      };
    },
    stateIsSafe() {
      return stateIsOutside([...registered.keys()], options.stateDir);
    },
    stateWriteProblem() {
      return stateWriteProblem;
    },
    stop() {
      stopped = true;
      cancelDebounce?.();
      cancelDebounce = null;
      for (const stop of stops.values()) stop();
      stops.clear();
      listeners.clear();
    },
  };
}

/**
 * The comparison that decides whether anything is published.
 *
 * `deriveSnapshot` is pure and builds its object in a fixed order, so its serialisation is
 * stable for stable input — that is the property being relied on, and it is asserted by the
 * seam's own purity test rather than assumed here.
 */
function serialise(snapshot: Snapshot): string {
  try {
    return JSON.stringify(snapshot);
  } catch {
    // Unreachable for a Snapshot, which holds no cycles. A counter rather than a constant
    // means a serialisation failure shows up as an extra frame — the board keeps updating —
    // instead of as a board that silently stops. A counter rather than a random value keeps
    // the failure path deterministic and therefore testable.
    unserialisable += 1;
    return `unserialisable:${unserialisable}`;
  }
}

let unserialisable = 0;

function readInterval(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readRootLimit(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new TypeError('maxRoots must be a positive safe integer.');
}
