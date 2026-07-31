/**
 * tracker-board — when things happen.
 *
 * Two ports live here, and they exist for the same reason: everything the watcher has to be
 * correct about is a question of *timing*, and timing is the one thing a test cannot observe
 * by looking at a file. A debounce that coalesces three events into one, an idle process that
 * reaps itself after fifteen minutes, a change that arrives while a scan is running — none of
 * those can be asserted against a real clock without either sleeping for fifteen minutes or
 * writing a test that passes on a fast machine and fails on a loaded one.
 *
 * `ReadTreeFs` already covers listing, stat, read and canonicalisation, so disk faults during
 * a scan are injectable. It does **not** model change events, which is why these are separate:
 * a missed event, a duplicate event and an event landing mid-scan are the watcher's own
 * failure modes, not the walk's.
 *
 * ## Why the fallback is a source rather than a branch
 *
 * Recursive watching is not available everywhere, and where it is missing the watcher degrades
 * to polling rather than failing. Expressing that as a **{@link ChangeSource}** rather than as
 * an `if` inside the watcher is what makes the two paths testable against the same assertions:
 * the pipeline downstream of a source — debounce, full re-scan, publish — is one piece of code
 * that neither source can see. A polled board and a watched board differ in what wakes them
 * and in nothing else.
 *
 * That is also why the polled source carries no change detection of its own. It ticks, the
 * pipeline re-scans, and the board publishes only when the Snapshot actually differs. Giving
 * polling a private notion of "changed" would be a second implementation of the thing being
 * tested, and the two would drift.
 */

import { watch } from 'node:fs';

/** Cancels whatever it was returned by. Calling it twice is safe. */
export type Stop = () => void;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * The passage of time, as the watcher needs it: a reading of now, and a way to be called
 * later. Nothing here reads a clock directly, so a test can run fifteen simulated minutes in
 * a microsecond and assert on the reaping rather than on a sleep.
 */
export interface Timers {
  /** Milliseconds, monotonic enough for measuring an interval. */
  readonly now: () => number;
  /** Call `fn` after `ms`. The returned function cancels it. */
  readonly delay: (ms: number, fn: () => void) => Stop;
  /** Call `fn` every `ms`. The returned function cancels it. */
  readonly repeat: (ms: number, fn: () => void) => Stop;
}

/**
 * Real time. Both timer kinds are `unref`ed: a pending debounce or a poll tick must never be
 * the reason the process stays alive, or the fifteen-minute idle exit could never happen.
 */
export const systemTimers: Timers = {
  now() {
    return Number(process.hrtime.bigint() / 1_000_000n);
  },
  delay(ms, fn) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return () => {
      clearTimeout(handle);
    };
  },
  repeat(ms, fn) {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return () => {
      clearInterval(handle);
    };
  },
};

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

/**
 * Something that says "the tree may have moved". Deliberately carries no detail about *what*
 * moved: the board re-scans in full, so a source that reported paths would be offering
 * information nothing is allowed to act on.
 */
export interface ChangeHandlers {
  /** A raw event. Says nothing about what moved, because nothing may act on that. */
  readonly onChange: () => void;
  /**
   * This source has stopped observing and will deliver nothing further.
   *
   * A source can die **after** starting cleanly — a permission change, a handle limit, the
   * watched directory replaced underneath it. Without this signal the board would keep
   * reporting the Root as watched while nothing was watching it, and every later change to
   * that Root would be silently lost. Failing loudly at start is easy; failing silently an
   * hour in is the case this exists for.
   */
  readonly onFailure: (reason: string) => void;
}

export interface ChangeSource {
  /** How this source learns about changes. Reported so the board can state which it got. */
  readonly kind: ChangeSourceKind;
  /**
   * Begin observing `rootPath`. Returns a stop function. **Never throws** — a source that
   * cannot start reports it through {@link ChangeSourceStart.problem} and the board falls
   * back rather than failing.
   */
  readonly start: (rootPath: string, handlers: ChangeHandlers) => ChangeSourceStart;
}

export type ChangeSourceKind = 'recursive' | 'polled';

export interface ChangeSourceStart {
  readonly stop: Stop;
  /** Why this source could not observe the Root, or `null` when it started. */
  readonly problem: string | null;
}

/**
 * Recursive `fs.watch`. Available on Windows and macOS, and on Linux only from Node 20 — and
 * even where the flag is accepted it can fail per-path, so this is **verified by starting it**
 * rather than by testing the platform name. A source that reports a problem is a source the
 * board replaces; that is the whole fallback mechanism.
 */
export const recursiveWatchSource: ChangeSource = {
  kind: 'recursive',
  start(rootPath, handlers) {
    try {
      const watcher = watch(rootPath, { recursive: true, persistent: true }, () => {
        handlers.onChange();
      });
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        watcher.close();
      };
      // An error after a successful start — a directory removed underneath us, a permission
      // change, a handle limit — must not become an uncaught exception, and must not leave
      // the Root looking watched while nothing watches it. Closing and *reporting* is what
      // lets the board move that Root to polling instead of losing it quietly.
      watcher.on('error', (error) => {
        if (closed) return;
        close();
        handlers.onFailure(describe(error));
      });
      return { stop: close, problem: null };
    } catch (error) {
      return { stop: () => {}, problem: describe(error) };
    }
  },
};

/**
 * A tick, at a fixed interval. It reports nothing about the tree and does not look at one:
 * the pipeline downstream re-scans and publishes only on a real difference, so polling and
 * watching converge on the same Snapshot by running the same code rather than by agreeing.
 *
 * The cost is one full re-scan per interval on a Root nobody is touching. That is why the
 * interval is coarse relative to the debounce — it is a fallback, not the normal path.
 */
export function polledSource(intervalMs: number, timers: Timers = systemTimers): ChangeSource {
  return {
    kind: 'polled',
    start(_rootPath, handlers) {
      const stop = timers.repeat(intervalMs, handlers.onChange);
      return { stop, problem: null };
    },
  };
}

/**
 * Try to watch; fall back to polling when watching cannot start.
 *
 * ADR-0005 states the fallback as a launch invariant rather than an optimisation, so the
 * decision is made per Root at start time and the outcome is reported. A board that silently
 * polled when it believed it was watching would be a board whose latency nobody could explain.
 */
export function startBestSource(
  rootPath: string,
  handlers: ChangeHandlers,
  preferred: ChangeSource,
  fallback: ChangeSource,
): { readonly stop: Stop; readonly kind: ChangeSourceKind; readonly fellBackBecause: string | null } {
  const attempt = preferred.start(rootPath, handlers);
  if (attempt.problem === null) {
    return { stop: attempt.stop, kind: preferred.kind, fellBackBecause: null };
  }
  attempt.stop();
  const second = fallback.start(rootPath, handlers);
  return { stop: second.stop, kind: fallback.kind, fellBackBecause: attempt.problem };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
