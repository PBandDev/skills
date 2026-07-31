/**
 * tracker-board — getting Snapshots into the page.
 *
 * Separate from rendering on purpose. The board is left open for hours across server restarts,
 * agent runs and laptop sleeps, so the interesting behaviour here is not the happy path — it
 * is what happens when the stream dies, which is often.
 *
 * `EventSource` reconnects on its own, but only while the server is answering. When the
 * process has gone — an idle reap, a restart, a crash — the browser gives up and the page sits
 * there showing a board that stopped being true, with nothing saying so. So reconnection is
 * driven here, with backoff, and the connection state is always on screen: a stale board that
 * admits it is stale is honest, and a stale board that looks live is the failure this whole
 * project exists to avoid.
 */

/** Backoff between reconnection attempts, in milliseconds. Caps rather than growing for ever. */
const RETRY_STEPS = [500, 1000, 2000, 4000, 8000];

/**
 * @typedef {{ state: 'connecting'|'live'|'retrying'|'down', attempt: number }} ConnectionState
 */

/**
 * Subscribe to the board's Snapshot stream.
 *
 * @param {{
 *   onSnapshot: (snapshot: unknown) => void,
 *   onState: (state: ConnectionState) => void,
 *   origin?: string,
 *   EventSourceImpl?: typeof EventSource,
 *   setTimeoutImpl?: typeof setTimeout,
 * }} options
 * @returns {{ stop: () => void }}
 */
export function connect(options) {
  const origin = options.origin ?? '';
  const Source = options.EventSourceImpl ?? EventSource;
  const later = options.setTimeoutImpl ?? setTimeout;

  let attempt = 0;
  let current = null;
  let stopped = false;
  /** Whether a Snapshot has ever parsed on this connection. An open socket is not a board. */
  let delivered = false;

  function announce(state) {
    options.onState({ state, attempt });
  }

  function open() {
    if (stopped) return;
    delivered = false;
    announce(attempt === 0 ? 'connecting' : 'retrying');

    const source = new Source(`${origin}/events`);
    current = source;

    // An open socket is not a working board. The endpoint may accept the connection and then
    // say nothing, or send frames that do not parse — in both cases the page would sit there
    // labelled `live` over a board that stopped being true, which is the exact failure this
    // whole project exists to avoid. So `live` is claimed only once a Snapshot has actually
    // arrived and parsed, and until then the state stays `connecting`.
    source.onopen = () => {
      if (delivered) announce('live');
    };

    source.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // A truncated frame. The next Snapshot supersedes it entirely, so there is nothing
        // worth recovering — but it is not evidence the connection works either.
        return;
      }
      // Reset the backoff here rather than on open. An endpoint that accepts a connection and
      // immediately drops it would otherwise reset the delay on every cycle and retry at the
      // shortest interval for ever, which is a busy loop against a server already in trouble.
      attempt = 0;
      delivered = true;
      announce('live');
      options.onSnapshot(parsed);
    };

    source.onerror = () => {
      // `EventSource` reports an error both for a transient blip it will retry itself and for
      // a server that has gone away. Closing and re-opening on our own schedule collapses the
      // two into one path that always ends in a visible state.
      source.close();
      if (stopped) return;
      const wait = RETRY_STEPS[Math.min(attempt, RETRY_STEPS.length - 1)];
      attempt += 1;
      announce(attempt >= RETRY_STEPS.length ? 'down' : 'retrying');
      later(open, wait);
    };
  }

  open();

  return {
    stop() {
      stopped = true;
      if (current !== null) current.close();
    },
  };
}

/**
 * Copy text, and report whether it worked.
 *
 * The clipboard API is unavailable on an insecure origin in some browsers, and the board is
 * served over plain HTTP on loopback — so the fallback is not decoration, it is the path a
 * real reader may well take. A failure has to be *reported*, because a copy button that
 * silently does nothing is worse than one that admits it: the reader pastes stale content and
 * never learns why.
 *
 * @param {string} text
 * Returns `true` when the text is on the clipboard, `false` when it certainly is not, and
 * `indeterminate` when a write was started and never settled — see below for why that is a
 * third answer rather than a failure.
 *
 * The dependencies are declared as exactly what this function touches rather than as
 * `Navigator` and `Document`. That is not a convenience for tests: it is the honest statement
 * of the contract, and it means a test double is a few lines instead of a hundred stubs, which
 * is the difference between the failure paths below being exercised and being assumed.
 *
 * @param {{
 *   navigatorImpl?: { clipboard?: { writeText?: (text: string) => Promise<void> } },
 *   documentImpl?: {
 *     body: { appendChild: (node: CopyField) => unknown } | null,
 *     createElement: (tag: string) => CopyField,
 *     execCommand?: (command: string) => boolean,
 *   },
 *   setTimeoutImpl?: (fn: () => void, ms: number) => unknown,
 * }} [deps]
 * @returns {Promise<boolean|"indeterminate">}
 */
export async function copyText(text, deps = {}) {
  const nav = deps.navigatorImpl ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const doc = deps.documentImpl ?? (typeof document === 'undefined' ? undefined : document);
  const wait = deps.setTimeoutImpl ?? setTimeout;

  if (nav !== undefined && nav.clipboard !== undefined && typeof nav.clipboard.writeText === 'function') {
    const settled = await Promise.race([
      nav.clipboard.writeText(text).then(
        () => 'ok',
        () => 'failed',
      ),
      new Promise((resolve) => wait(() => resolve('stalled'), CLIPBOARD_TIMEOUT_MS)),
    ]);
    if (settled === 'ok') return true;

    // `stalled` is not hypothetical, and it is why this is a race rather than a plain await:
    // `writeText` can hang indefinitely — neither resolving nor rejecting — while the
    // permission reads as granted, which happens when the page is not the frontmost window.
    // Observed in a real browser. Awaited directly, the button does nothing at all, for ever.
    //
    // But a stalled write is **indeterminate, not failed**, and the difference matters: the
    // call has no cancellation, so it may still land. Falling back here would start a second
    // write, and if the reader then copies a different path the stalled first write can
    // complete afterwards and leave the *older* path on the clipboard while the page confirms
    // the newer one. Silently pasting the wrong path is worse than being told to select it.
    if (settled === 'stalled') return 'indeterminate';
  }
  return legacyCopy(text, doc);
}

/**
 * The off-screen field the legacy copy path selects from. Declared structurally, for the
 * same reason the dependencies above are: this is what the code touches, and nothing more.
 *
 * @typedef {{ value: string, style: { position?: string, top?: string },
 *             setAttribute: (name: string, value: string) => void,
 *             select: () => void, remove: () => void }} CopyField
 */

/** How long to wait for the clipboard API before falling back. Long enough not to pre-empt it. */
const CLIPBOARD_TIMEOUT_MS = 1500;

/**
 * @param {string} text
 * @param {Document|undefined} doc
 */
function legacyCopy(text, doc) {
  if (doc === undefined || doc.body === null) return false;
  try {
    const field = doc.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-2000px';
    doc.body.appendChild(field);
    field.select();
    const ok = typeof doc.execCommand === 'function' && doc.execCommand('copy');
    field.remove();
    return ok === true;
  } catch {
    return false;
  }
}
