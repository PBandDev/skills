/**
 * tracker-board - the entry point.
 *
 * Wiring only: transport in, view model, DOM out, plus the small amount of state that belongs
 * to the reader rather than to the Snapshot - whether Done is collapsed, which Features are
 * expanded inside it. Every decision worth arguing about lives in one of the modules this
 * imports, which is what lets the board grow by adding modules beside them rather than by
 * unpicking this file.
 *
 * The three panels below the board are called here, each through the guard in `panels.js`, so
 * that one panel failing costs its own mount and nothing else - not its two peers, and not the
 * focus restore that keeps the reader's place. The guard states the failure rather than
 * absorbing it; `panels.js` carries the reasoning.
 */

import { buildView } from './view.js';
import { render, findCard } from './render.js';
import { connect, copyText } from './transport.js';
import { renderCorrections } from './corrections.js';
import { renderDigest } from './digest.js';
import { renderDomain } from './domain.js';
import { CORRECTIONS_PANEL, DIGEST_PANEL, DOMAIN_PANEL, drawPanel } from './panels.js';

const CONNECTION_WORDS = {
  connecting: 'connecting',
  live: 'live',
  retrying: 'reconnecting',
  down: 'disconnected',
};

/** How long a copy confirmation stays on screen before the line clears itself. */
const CONFIRM_MS = 3200;

/** How long a card stays marked after the blocker navigation moved to it. */
const TARGET_MS = 2600;

/**
 * Reader-held state. It is not on the Snapshot and must not be: a re-scan arrives every few
 * seconds while an agent works, and a board that re-collapsed the Done column underneath
 * somebody reading it would be unusable.
 */
const ui = { doneMode: 'collapsed', openFeatures: {} };

/** The last Snapshot, so a control can redraw without waiting for the next one to arrive. */
let latest = null;

start(document, window);

/**
 * @param {Document} doc
 * @param {Window} win
 */
function start(doc, win) {
  const conn = doc.getElementById('conn');
  const connText = doc.getElementById('conn-text');
  const feedback = doc.getElementById('copyfb');

  connect({
    onSnapshot: (snapshot) => {
      latest = snapshot;
      draw(doc);
    },
    onState: ({ state }) => {
      if (conn !== null) conn.setAttribute('data-state', state);
      if (connText !== null) connText.textContent = CONNECTION_WORDS[state] ?? state;
    },
    setTimeoutImpl: win.setTimeout.bind(win),
  });

  // One delegated listener rather than a handler per card. The board rewrites cards several
  // times a minute, and a listener attached per card would have to be attached and detached
  // with them - delegation makes every control below independent of the render entirely.
  doc.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const copy = target.closest('[data-copy]');
    if (copy !== null) {
      const path = copy.getAttribute('data-copy');
      if (path !== null && path !== '') void confirmCopy(win, copy, feedback, path);
      return;
    }

    const goto = target.closest('[data-goto]');
    if (goto !== null) {
      moveTo(doc, win, goto.getAttribute('data-goto'));
      return;
    }

    const toggle = target.closest('[data-toggle]');
    if (toggle !== null) {
      const key = toggle.getAttribute('data-toggle');
      if (key === null) return;
      ui.openFeatures[key] = ui.openFeatures[key] !== true;
      draw(doc);
      // The node was patched in place rather than replaced, so focus is still where the
      // reader put it. Restoring it explicitly would be a no-op that could only go wrong.
      return;
    }

    const mode = target.closest('[data-done-mode]');
    if (mode !== null) {
      ui.doneMode = mode.getAttribute('data-done-mode') === 'cards' ? 'cards' : 'collapsed';
      for (const button of doc.querySelectorAll('[data-done-mode]')) {
        button.setAttribute(
          'aria-pressed',
          button.getAttribute('data-done-mode') === ui.doneMode ? 'true' : 'false',
        );
      }
      draw(doc);
    }
  });
}

/**
 * Draw the latest Snapshot, keeping the reader's place.
 *
 * A card that changes Lane keeps its node - the renderer moves it rather than rebuilding it -
 * but moving a node still blurs it, because `insertBefore` detaches and re-inserts and
 * detaching a focused element sends focus to the body. The node surviving is what preserves
 * the card's marks and its just-changed tint; this is what preserves the reader's place.
 *
 * Restored only when focus actually fell to the body. If the reader moved to a control while
 * the render was in flight, that is where they meant to be, and pulling them back to a card
 * they were merely looking at would be worse than doing nothing.
 *
 * @param {Document} doc
 */
function draw(doc) {
  const active = doc.activeElement;
  const held =
    active instanceof Element ? (active.closest('[data-card]')?.getAttribute('data-card') ?? null) : null;

  const view = buildView(latest, ui);
  render(doc, view);
  // The raw Snapshot goes to the panels alongside the view, because `BoardView` is a projection
  // built for the six columns and holds none of what the panels draw - no Digest state, no ADRs,
  // no glossary, no correction counts. Widening it instead would mean three panels designing
  // three view models inside `view.js`, the one file none of them may share, which is the exact
  // collision the seam below exists to prevent. Each panel projects what it needs in its own
  // module. It is the same value `buildView` gets, unvalidated and possibly null.
  //
  // Each call is guarded separately rather than run in bare sequence, and `ui/panels.js` carries
  // the argument for it in full. In short: `digest.js` is deliberately not total past its own
  // projection, and it is the middle call of three - so a throw there is the domain panel gone
  // and the focus restore below skipped, on a board that redraws every few seconds. The guard
  // does not swallow. All three panels render a legitimate empty state, so a failure that drew
  // nothing would be making the emptier claim in the panel's own voice; it is drawn and named
  // instead.
  drawPanel(doc, CORRECTIONS_PANEL, () => renderCorrections(doc, view, latest));
  drawPanel(doc, DIGEST_PANEL, () => renderDigest(doc, view, latest));
  drawPanel(doc, DOMAIN_PANEL, () => renderDomain(doc, view, latest));

  // Reached whatever the three panels did, which is the other half of guarding them: this is
  // what keeps the reader's place, and losing it to somebody else's panel is the failure a
  // reader actually feels.
  if (held === null || doc.activeElement !== doc.body) return;
  const node = findCard(doc.querySelectorAll('#board [data-card], #offboard [data-card]'), held);
  if (node instanceof HTMLElement) node.focus({ preventScroll: true });
}

/**
 * Move to the card a blocker names.
 *
 * Board-internal navigation, never a path: the reader chasing a dependency chain wants the
 * other card, not a file name to go and find. The search is scoped to the board and the
 * off-board list so the legend's specimens - which carry card keys of their own - can never
 * be the destination.
 *
 * @param {Document} doc
 * @param {Window} win
 * @param {string|null} id
 */
function moveTo(doc, win, id) {
  const nodes = doc.querySelectorAll('#board [data-card], #offboard [data-card]');
  const node = findCard(nodes, id);
  const live = doc.getElementById('live');

  if (node === null) {
    if (live !== null) {
      live.textContent = 'That Ticket is not on the board. It may be filtered out or unparsed.';
    }
    return;
  }

  node.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (node instanceof HTMLElement) node.focus({ preventScroll: true });
  if (live !== null) {
    const name = node.querySelector('.tid')?.textContent ?? '';
    live.textContent = `Moved to ${name}.`;
  }

  if (targetTimer !== null) win.clearTimeout(targetTimer);
  for (const marked of doc.querySelectorAll('[data-targeted]')) marked.removeAttribute('data-targeted');
  node.setAttribute('data-targeted', '1');
  targetTimer = win.setTimeout(() => node.removeAttribute('data-targeted'), TARGET_MS);
}

let targetTimer = null;

/**
 * @param {Window} win
 * @param {Element} button
 * @param {Element|null} feedback
 * @param {string} path
 */
async function confirmCopy(win, button, feedback, path) {
  // One generation for the whole feedback region, because every button shares it. Keying the
  // timer per button is not enough: a successful copy A, followed by a failed copy B, would
  // have A's timer clear B's message - erasing the one case that must stay on screen, since
  // the reader still has to select that path by hand.
  generation += 1;
  const mine = generation;
  const ok = await copyText(path);
  if (mine !== generation) return;
  button.setAttribute('data-state', ok === true ? 'ok' : 'fail');

  if (feedback !== null) {
    feedback.replaceChildren();
    if (ok === true) {
      const word = document.createElement('b');
      word.textContent = 'Copied';
      feedback.append(word, ` ${baseName(path)}`);
      feedback.removeAttribute('data-mode');
    } else {
      // Naming the path in full, and letting it wrap, is the point: the reader now has to
      // select it by hand, and a truncated path cannot be selected by hand.
      //
      // `indeterminate` gets its own wording rather than being folded into failure, because
      // the two ask different things of the reader. A failure means "this did not happen";
      // an unsettled write means "this may yet happen, and may not" - so telling them it
      // failed would be as wrong as telling them it worked.
      const word = document.createElement('span');
      word.className = 'warn';
      word.textContent = ok === 'indeterminate' ? 'Copy not confirmed.' : 'Clipboard unavailable.';
      feedback.append(word, ` ${path}`);
      feedback.setAttribute('data-mode', 'err');
    }
  }

  if (timer !== null) win.clearTimeout(timer);
  timer = win.setTimeout(() => {
    if (mine !== generation) return;
    button.removeAttribute('data-state');
    // Only a confirmation clears itself. Anything else is a path the reader still has to copy
    // by hand, and taking it off the screen on a timer would take the path with it.
    if (ok === true && feedback !== null) {
      feedback.replaceChildren();
      feedback.removeAttribute('data-mode');
    }
  }, CONFIRM_MS);
}

/**
 * The feedback region is shared by every path on the page, so its state belongs to whichever
 * copy happened last rather than to a button. One counter and one timer: an older operation
 * that finishes late finds its generation stale and leaves the newer message alone.
 */
let generation = 0;
let timer = null;

function baseName(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}
