/**
 * tracker-board - containment for the three panels below the board.
 *
 * ## What this is for, which is not what it looks like
 *
 * `board.js` calls the three panels in sequence and then restores the focused card. Read
 * quickly, this file exists so that one panel throwing does not take out its two peers and the
 * focus restore. That is true, and it is the smaller half.
 *
 * The larger half is that a caught failure has to stay **visible**. Every one of the three
 * panels renders a legitimate absence: the corrections panel says no Override changed a field,
 * the Digest panel clears its mount when a Snapshot carries no Features at all, and a Root with
 * no ADRs and no glossary makes the domain panel absent rather than empty. So a guard that
 * caught a throw and rendered nothing would not be degrading gracefully - it would be publishing
 * a false claim about the repository, in the panel's own voice, indistinguishable from the
 * truth. The empty state is already taken.
 *
 * So the failure is **drawn**, in the place the content would have been, and it says which of
 * the two it is. That is the standard the domain panel set for itself and it is the standard
 * here.
 *
 * ## Why `board.js` guards at all, when the panels guard themselves
 *
 * Two of them do. `corrections.js` and `domain.js` are total: they catch, and they state the
 * failure in their own mount in their own vocabulary, which is strictly better than anything
 * this file can say from outside. When they work, this guard never fires.
 *
 * `digest.js` is deliberately **not** total, and says so in its own header: it contains only
 * the projection, on the argument that a blanket catch around the drawing would swallow a real
 * defect and leave a panel quietly showing a previous frame. That argument is right. Its
 * consequence is that a throw out of the digest panel's drawing reaches `board.js` - and
 * `renderDigest` is called *second* of three, so it takes the domain panel and the focus restore
 * with it.
 *
 * That is why the guard is per-call rather than one `try` around all three.
 *
 * ## Why the notice is built here and not by the panel that failed
 *
 * A throw that gets this far means the panel's own way of saying so is unavailable: either it
 * has none for that phase, or it has one and the one threw too. Calling back into the module
 * that just failed to ask it to describe its own failure is calling the broken thing. Nothing
 * in this file imports a panel; it works from a small record per panel and the document.
 *
 * The cost is that three sentences of panel vocabulary live here rather than beside the panels.
 * `board-ui.test.ts` holds each of them to the panel it describes so they cannot drift.
 */

/**
 * @typedef {object} PanelGuard
 * @property {string} mount The id of the section this panel owns. Nothing else writes into it.
 * @property {string} heading The panel's own heading, redrawn so a failed panel is still named.
 * @property {string|null} headingId The id the panel's heading carries when the panel drew it
 *   itself, or `null` when the panel names its mount no other way.
 *
 *   This is not decoration. A mount is named by `aria-labelledby` pointing at that heading, so
 *   replacing the mount's children without restoring the heading leaves the region pointing at
 *   an element that no longer exists - a region with no name at all. `corrections.js` therefore
 *   rebuilds its heading in its own failure path.
 *
 *   `null` is not "no heading"; it is "this panel never sets `aria-labelledby`, so this file
 *   must not either". Setting one the panel does not restore would leave the attribute dangling
 *   the moment the panel recovered and rebuilt its own contents, which is the same defect
 *   arriving by the other door.
 * @property {string} absent What this panel's empty mount already legitimately means, phrased so
 *   the notice can deny it. This is the whole point of the notice: without it, a failure and a
 *   true empty answer are the same screen.
 * @property {string|null} rebuildKey An attribute a panel records on its own mount to decide
 *   whether the next frame needs rebuilding at all, or `null` for a panel that keys that
 *   decision on its own content instead.
 *
 *   It has to be cleared here for the same reason the panel clears it in its own failure path.
 *   The notice replaces the content the key describes, so a key left behind describes a frame
 *   that is no longer on the page: the next Snapshot matches it, the panel returns early
 *   without drawing, and the reader is stranded on this notice for a board the panel could
 *   have drawn perfectly well. On a live board the next Snapshot is a few hundred milliseconds
 *   away and is usually the same one, which is precisely the frame a stale key skips.
 */

/** @type {PanelGuard} */
export const CORRECTIONS_PANEL = {
  mount: 'corrections-panel',
  heading: 'AI-corrected Tickets',
  headingId: 'corrections-h',
  absent:
    'The corrected Tickets are not shown, which is not the same as no Override having changed ' +
    'a field on this board.',
  // Keyed on the presence of its own `.corrbody` frame, which this notice removes.
  rebuildKey: null,
};

/** @type {PanelGuard} */
export const DIGEST_PANEL = {
  mount: 'digest-panel',
  heading: 'Two liveness tiers',
  // `digest.js` names its mount no way at all - its heading carries no id and it never sets
  // `aria-labelledby` - so neither does this. See `headingId` above for why inventing one here
  // would be worse than leaving the region unnamed for a frame.
  headingId: null,
  absent:
    'No Digests are shown, which is not the same as this board having no Features. The cards ' +
    'above are unaffected: they are read from the file system directly.',
  // Keyed on the presence of its own `.dg-liveness` node, which this notice removes.
  rebuildKey: null,
};

/** @type {PanelGuard} */
export const DOMAIN_PANEL = {
  mount: 'domain-panel',
  heading: 'Domain model',
  headingId: 'domain-h',
  absent:
    'The ADRs and the glossary are not shown, which is not the same as this repository having ' +
    'none.',
  // `domain.js` skips a frame whose projection signature matches the one already on the mount,
  // and clears that signature in its own failure path for exactly the reason above. This is a
  // second failure path into the same mount, so it needs the same line.
  rebuildKey: 'data-domain-sig',
};

/** The one sentence both the drawn notice and the text-only last resort open with. */
const LEAD = 'This panel could not be drawn from the current Snapshot';

/**
 * Draw one panel, and state it in that panel's own mount if it throws.
 *
 * Total by construction, so the next panel and the focus restore always run.
 *
 * Two levels of falling back, because there are two different things that can be broken. If the
 * notice cannot be *built* - the document refuses to create an element - the mount is written
 * with plain text instead, which asks nothing of the document but a property assignment. Only
 * when that fails too is there nothing left to say. Staying silent earlier than that would not
 * be conservative: a panel can clear its own mount on the way to throwing, and an empty mount
 * is a legitimate answer for all three of these panels, so silence publishes a claim about the
 * repository rather than withholding one.
 *
 * @param {Document} doc
 * @param {PanelGuard} panel
 * @param {() => void} run The panel call. Passed as a closure so that `board.js` keeps a literal
 *   call site per panel rather than dispatching through a table - the seam that proves each
 *   panel is handed the raw Snapshot is asserted on that literal text.
 * @returns {void}
 */
export function drawPanel(doc, panel, run) {
  try {
    run();
  } catch (error) {
    try {
      failed(doc, panel, error);
    } catch {
      try {
        // No element construction, and no coercion of the thrown value - either could be what
        // just failed. The reason is dropped rather than risked; which panel and which absence
        // are what the reader actually needs.
        const mount = doc.getElementById(panel.mount);
        if (mount !== null) {
          mount.textContent = `${panel.heading}: ${LEAD}. ${panel.absent}`;
          mount.removeAttribute('aria-labelledby');
          if (panel.rebuildKey !== null) mount.removeAttribute(panel.rebuildKey);
        }
      } catch {
        // The document itself is unusable. There is genuinely nowhere left to say anything, and
        // throwing from here would cost the reader the focus restore this guard protects.
      }
    }
  }
}

/**
 * @param {Document} doc
 * @param {PanelGuard} panel
 * @param {unknown} error
 * @returns {void}
 */
function failed(doc, panel, error) {
  // Every field is read once, into a local, before anything is resolved or written. The three
  // records are module-private constants here, so a stateful getter is not a reachable attack -
  // but reading a value twice and acting on it once is the shape that produces a heading with
  // one id and an `aria-labelledby` naming another, and reading once costs nothing.
  const { mount: mountId, heading, headingId, absent, rebuildKey } = panel;

  // Coerced BEFORE the mount is resolved, because coercing runs code this process does not own:
  // the thrown value came out of evaluating a Snapshot that arrived as JSON off a socket, and
  // `String` calls its `toString` or its `Symbol.toPrimitive`. A `toString` can swap the panel's
  // mount out of the document during coercion; resolving first would then write the notice into
  // the detached old node while the live mount stays empty. Resolving afterwards means the mount
  // written to is the one on the page.
  const why = reason(error);

  const mount = doc.getElementById(mountId);
  if (mount === null) return;

  const head = doc.createElement('div');
  head.className = 'subhead';
  const title = doc.createElement('h2');
  if (headingId !== null) title.id = headingId;
  title.textContent = heading;
  head.appendChild(title);

  const note = doc.createElement('p');
  note.className = 'panelfail';
  // Announced, because this replaces content that was on screen a moment ago, and a reader
  // whose eyes are on the columns would otherwise never learn that a panel had stopped saying
  // anything true.
  note.setAttribute('role', 'status');
  note.textContent = `${LEAD} — ${why}. ${absent}`;

  // Last, and in this order deliberately. Everything above is built into detached nodes, so a
  // document that fails half way through leaves the panel's own half-drawn frame on screen
  // rather than an empty mount - and an empty mount is the one thing this notice exists to
  // avoid claiming.
  if (headingId === null) mount.removeAttribute('aria-labelledby');
  else mount.setAttribute('aria-labelledby', headingId);
  if (rebuildKey !== null) mount.removeAttribute(rebuildKey);
  mount.replaceChildren(head, note);
}

/**
 * The thrown value as text, without letting it throw again.
 *
 * It came from evaluating a value this process does not own, so its `toString` is as untrusted
 * as the value was - a revoked Proxy or a `toString` that throws would otherwise take out the
 * notice describing it, and the panel would go silent for the one reason the notice exists.
 *
 * The value is still coerced rather than refused. Refusing every object would refuse every
 * `Error`, which is what is actually thrown here, and the reason is the one part of the notice
 * that says which defect this is. What the coercion is not allowed to do is decide where the
 * notice lands, which is why the caller runs it first - see {@link failed}.
 *
 * @param {unknown} error
 * @returns {string}
 */
function reason(error) {
  try {
    return String(error);
  } catch {
    return 'the reason could not be read either';
  }
}
