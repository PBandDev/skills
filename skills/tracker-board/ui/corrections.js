/**
 * tracker-board - the AI-corrected marker, its per-column filter, and the Override ledger.
 *
 * Two layers, and both are needed. **B** decorates the ticket id a card already has, so ten
 * marks cost the same ink as one and a board where a parser bug corrected 36 of 52 Tickets
 * still reads. **C** is a count in each column header that filters to corrected cards when
 * pressed. B alone means nobody looks; C alone means a card can silently disagree with its
 * own file.
 *
 * ## The contract this module exists to get right
 *
 * **At every state the assistive contract mirrors the visual contract.** Neither modality is
 * given something the other is not, in either direction:
 *
 *   - A **collapsed** Done row is a content state, not a visual one. `render.js` marks the
 *     ledger `hidden` *and* empties it, so the cards are absent from the page for everyone.
 *     Nothing here re-adds them, and nothing here ever moves content out of sight while
 *     leaving it in the accessibility tree - that whole family of idioms appears nowhere in
 *     this skill and this module does not introduce one. The names are deliberately not
 *     spelled out here, because the guard that forbids them reads comments too.
 *   - A **visible** card's underline is purely visual, so the element that carries the
 *     underline also carries the correction in its accessible name. A sighted reader and a
 *     reader using assistive technology learn the same fact from the same node.
 *
 * ## The marker adds no element, and the paint is not this file's
 *
 * The mark is an attribute on the id the card already prints. Nothing is inserted, so ten
 * marks cost the same ink as one and a correction arriving cannot move a card.
 *
 * The paint lives in `board.css` (`.tid[data-corrected], .lid[data-corrected]`), not here, and
 * the division is not arbitrary: the layout guard scopes every selector in
 * `ui/corrections.css` to `#corrections-panel`, a card lives in `#board`, and inline style is
 * refused by the document's own policy - so no rule this panel is permitted to write can paint
 * a card at all. The panel sets the state; the stylesheet that owns the element draws it.
 *
 * **Both selectors are in one `board.css` rule, and the `named` flags in `ROWS` below have to
 * agree with it.** A Ticket prints its id in two elements: `.tid` on a card in a column, and
 * `.lid` on a ledger row inside an opened Feature in the collapsed Done column. A shape that is
 * painted is named; a shape that is not painted is marked as state and named to nobody, because
 * a name where nothing draws tells assistive technology something a sighted reader is not told -
 * the exact inversion this module exists to close. Both shapes are painted, so both are named.
 *
 * ## The filter holds its state in the DOM, deliberately
 *
 * `aria-pressed` on the button **is** the state; this module keeps none. That is not tidiness.
 * `renderCorrections` runs on every frame - several times a minute on a live board - and a
 * pressed filter surviving the next frame has to be a structural property rather than
 * something a module remembers. The button lives in the column head, which `render.js` builds
 * once and never rebuilds, so the state and the focus on it both outlive the render that
 * follows.
 *
 * For the same reason nothing here is rebuilt unconditionally: the panel's frame is built once
 * and its values are written into it, and a card already marked is left alone.
 *
 * ## Where the data comes from
 *
 * The counts arrive on the **third argument**, which is the Snapshot itself: `corrections` is a
 * total plus a per-Lane breakdown, `overrides` is the applied and rejected pair, and the
 * per-card detail is `derivation.correctedFields`.
 *
 * `snapshot` is typed `unknown`, and that is the honest type rather than a lazy one. It is
 * `JSON.parse` output straight off a socket, and it is `null` until the first frame arrives.
 * Every read below goes through a coercion that answers a safe empty value instead of throwing.
 *
 * Rules that hold for anything drawn here, the same as everywhere else on the board: build
 * nodes with `textContent` and never from a string, and put styles in `corrections.css`
 * rather than inline - the document is served under a policy that forbids both.
 */

/**
 * The two shapes a Ticket takes on the board, and where each one prints its id.
 *
 * A card in a column is an `article` carrying `data-card`, and a Ticket inside an opened
 * Feature in the collapsed Done column is a ledger row carrying `data-ledger`. Both are the
 * same Ticket and both must carry the same mark: marking one and not the other would let the
 * same Ticket read as corrected in one mode of a column and uncorrected in the other.
 */
const ROWS = [
  // `named` tracks `board.css`'s `.tid[data-corrected], .lid[data-corrected]` rule and must not
  // drift from it: naming a shape nothing paints gives assistive technology a fact a sighted
  // reader never gets, and painting one this module does not name is the same inversion the
  // other way round. Both are painted, so both are named.
  { row: '[data-card]', key: 'data-card', id: '.tid', named: true },
  { row: '[data-ledger]', key: 'data-ledger', id: '.lid', named: true },
];

/**
 * Which Lanes each of the six columns draws.
 *
 * Exported because it is a contract with `ui/view.js` rather than a detail: the filter is a
 * per-column control and the counts arrive per-Lane, so this map is the join between them. A
 * test pins it against `columnOrder()` and against the Lane names a real Snapshot carries, so
 * a column added or a Lane renamed cannot leave a count silently pointing at nothing.
 *
 * `unlaned` is deliberately absent. Those cards hold no Lane, so they are drawn below the
 * board rather than in a column - and their corrections are stated in the panel instead of
 * being folded into a column that does not contain them.
 */
export const COLUMN_LANES = {
  blocked: ['blocked', 'frozen'],
  agent: ['agent'],
  'needs-you': ['needs-you'],
  'in-progress': ['in-progress'],
  done: ['complete'],
  parked: ['parked'],
};

/** Documents this module has already attached its one delegated listener to. */
const listening = new WeakSet();

/**
 * @param {Document} doc
 * @param {import('./view.js').BoardView} view
 * @param {unknown} snapshot The raw Snapshot, exactly as `buildView` receives it: unvalidated,
 *   and `null` until the first frame arrives.
 * @returns {void}
 */
export function renderCorrections(doc, view, snapshot) {
  void view;
  // Nothing at all until a frame has arrived, and the return is FIRST so that not one property
  // of `doc` is read on the way to it. `board.js` holds `null` from page load until the first
  // SSE frame, so this is the state the browser paints in. Returning early rather than drawing
  // an empty panel is also the honest answer: "no Override has changed a field on this board" is
  // a claim about a board, and there is no board yet. The value never goes back to `null` once a
  // frame has arrived, so there is no disconnect case needing a mount cleared.
  if (snapshot === null || snapshot === undefined) return;
  try {
    draw(doc, snapshot);
  } catch (error) {
    // A panel is drawn from `draw()` in `board.js`, in sequence with two others, and the focus
    // restore that keeps the reader's place runs after all three. Throwing from here would
    // blank the two panels below and drop the reader to the body, so the failure is caught and
    // stated in this panel's own mount instead of taken out on the board.
    report(doc, error);
  }
}

/**
 * Press or release one column's filter, and say what that did.
 *
 * Exported so the filter can be asserted without a browser. The delegated listener below is
 * the only other caller.
 *
 * @param {Document} doc
 * @param {Element} button
 * @returns {void}
 */
export function toggleFilter(doc, button) {
  const wanted = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', wanted ? 'true' : 'false');
  const board = doc.getElementById('board');
  const marked = markedIds(board);
  applyFilter(board, marked);
  announce(doc, button, board, marked);
}

// ---------------------------------------------------------------------------
// The render
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {unknown} snapshot
 */
function draw(doc, snapshot) {
  const facts = project(snapshot);
  const board = doc.getElementById('board');
  const offboard = doc.getElementById('offboard');

  markCards(board, facts.byCard);
  markCards(offboard, facts.byCard);
  syncFilters(doc, board, facts);
  applyFilter(board, facts.byCard);
  // Nothing below the board is ever filtered, and a card that arrives there arrives carrying
  // whatever it was last given. `render.js` pools card nodes across the board AND the off-board
  // list, so a card hidden by a filter and then found unparseable moves out of its column with
  // its `hidden` still set - and releasing the filter would never reach it again, because that
  // walk is scoped to the columns.
  reveal(offboard);
  freshenAnnouncement(doc, board);
  drawPanel(doc, doc.getElementById('corrections-panel'), facts);

  // One delegated listener for the whole document, attached once, never from a per-frame path.
  // A listener added inside a render accumulates one copy per frame and the symptom is a
  // control firing N times with nothing in the source saying so. Feature-detected rather than
  // wrapped, so a document without event support still gets the whole render above.
  if (!listening.has(doc) && typeof doc.addEventListener === 'function') {
    listening.add(doc);
    doc.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('[data-corrections-filter]');
      if (button !== null) toggleFilter(doc, button);
    });
  }
}

// ---------------------------------------------------------------------------
// Layer B - the marker on the card's own ticket id
// ---------------------------------------------------------------------------

/**
 * Mark every corrected card under `host`, and unmark every card that is no longer corrected.
 *
 * The legend's specimens carry card keys of their own and are never passed in here: they are
 * not Snapshot cards, so marking one would claim an Override that does not exist.
 *
 * @param {Document} doc
 * @param {Element|null} host
 * @param {Map<string, string[]>} byCard
 */
function markCards(host, byCard) {
  if (host === null) return;
  for (const shape of ROWS) {
    for (const node of host.querySelectorAll(shape.row)) {
      const id = node.getAttribute(shape.key);
      const slot = node.querySelector(shape.id);
      if (id === null || slot === null) continue;
      const fields = byCard.get(id);
      if (fields === undefined || fields.length === 0) unmark(slot);
      else mark(slot, fields, shape.named);
    }
  }
}

/**
 * @param {Element} slot The element holding the Ticket's printed id.
 * @param {string[]} fields
 * @param {boolean} named Whether a stylesheet paints this shape, and so whether it may be named.
 */
function mark(slot, fields, named) {
  setAttr(slot, 'data-corrected', String(fields.length));
  if (!named) {
    // Marked as state, told to nobody. Naming a row nothing paints is the inversion.
    if (slot.getAttribute('role') !== null) slot.removeAttribute('role');
    if (slot.getAttribute('aria-label') !== null) slot.removeAttribute('aria-label');
    return;
  }
  // The name goes on the element the underline goes on, which is the whole point: the underline
  // is the entirety of a sighted reader's signal, so anything less here would give one modality
  // a fact the other never gets. `img` is the role that lets a span-level element carry a name
  // at all - the same element with no role is generic, where naming is prohibited and ignored.
  // The id is repeated inside the name because that role replaces the element's text rather
  // than adding to it.
  setAttr(slot, 'role', 'img');
  setAttr(slot, 'aria-label', `${slot.textContent}, AI-corrected: ${fields.join(', ')}`);
}

/** @param {Element} slot */
function unmark(slot) {
  for (const name of ['data-corrected', 'role', 'aria-label']) {
    if (slot.getAttribute(name) !== null) slot.removeAttribute(name);
  }
}

// ---------------------------------------------------------------------------
// Layer C - the per-column count, and the filter it drives
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {Element|null} board
 * @param {Facts} facts
 */
function syncFilters(doc, board, facts) {
  if (board === null) return;
  for (const column of board.querySelectorAll('[data-col]')) {
    const key = column.getAttribute('data-col');
    const head = column.querySelector('.col-head');
    if (key === null || head === null) continue;
    const count = columnCount(facts, key);
    let wrap = head.querySelector('.corrseg');
    // Drawn only where there is something to filter. A control that filters to nothing is a
    // trap, and the columns holding none are still stated - in the panel's own breakdown,
    // which lists every column including the zeroes.
    if (count === 0) {
      if (wrap !== null) wrap.remove();
      continue;
    }
    if (wrap === null) {
      wrap = doc.createElement('span');
      wrap.className = 'seg corrseg';
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.setAttribute('data-corrections-filter', key);
      button.setAttribute('aria-pressed', 'false');
      wrap.appendChild(button);
      head.appendChild(wrap);
    }
    const button = wrap.querySelector('.chip');
    if (button === null) continue;
    const name = column.querySelector('.cname')?.textContent ?? key;
    const label = `${String(count)} AI-corrected`;
    setText(button, label);
    // The name **opens with the visible text, verbatim**, and then adds the column the visible
    // text leaves to context. Both halves are load-bearing. A name that dropped the count would
    // hand a sighted reader a number nobody else gets, which is the same inversion this module
    // exists to close one level down; and a name that does not contain its own visible label
    // cannot be spoken to a voice control, which reads what is on screen.
    setAttr(button, 'aria-label', `${label} in ${name}. Show only these Tickets.`);
  }
}

/**
 * Un-hide everything under `host`.
 *
 * For the off-board list, which no filter owns. A card that moves out of a column carries
 * whatever it was last given, and the filter's own walk cannot reach it there.
 *
 * @param {Element|null} host
 */
function reveal(host) {
  if (host === null) return;
  for (const shape of ROWS) {
    for (const node of host.querySelectorAll(shape.row)) node.hidden = false;
  }
}

/**
 * Hide every card the pressed filters exclude, and reveal every card they do not.
 *
 * The `hidden` attribute rather than a class, and that is the parity contract rather than an
 * implementation choice: pressing a filter changes what exists on the page, for both
 * modalities at once. A rule that only stopped the card being painted would leave it in the
 * accessibility tree and break that parity.
 *
 * `board.css` enforces `[hidden]` over every component rule that sets `display`, so this
 * works on a card whose own rule makes it a flex container.
 *
 * @param {Element|null} board
 * @param {Map<string, string[]>} marked
 */
function applyFilter(board, marked) {
  if (board === null) return;
  for (const column of board.querySelectorAll('[data-col]')) {
    const button = column.querySelector('[data-corrections-filter]');
    const on = button !== null && button.getAttribute('aria-pressed') === 'true';
    for (const node of column.querySelectorAll('[data-card]')) {
      node.hidden = on && !marked.has(node.getAttribute('data-card') ?? '');
    }
    // A Feature opened inside the collapsed Done column draws ledger rows rather than cards,
    // keyed by the same card id. Filtering one and not the other would show a reader a column
    // that answered the control in one of its two modes.
    for (const row of column.querySelectorAll('[data-ledger]')) {
      row.hidden = on && !marked.has(row.getAttribute('data-ledger') ?? '');
    }
  }
}

/**
 * What a press did, in words, into this panel's own live region.
 *
 * Its own region rather than the board's `#live`: that one carries where the blocker
 * navigation landed, and two announcers sharing one region overwrite each other's message.
 *
 * @param {Document} doc
 * @param {Element} button
 * @param {Element|null} board
 * @param {Map<string, string[]>} marked
 */
function announce(doc, button, board, marked) {
  const live = doc.getElementById('corrections-live');
  if (live === null || board === null) return;
  const key = button.getAttribute('data-corrections-filter');
  const column = columnFor(board, key);
  const name = column?.querySelector('.cname')?.textContent ?? String(key);

  if (button.getAttribute('aria-pressed') !== 'true') {
    setText(live, `${name}: showing every Ticket again.`);
    forget(live);
    return;
  }

  const tally = countFiltered(column, marked);
  if (tally.shown === 0 && tally.hidden === 0) {
    // The Done column, collapsed with every Feature closed. The Tickets are not on the page for
    // anybody, so a filter has nothing to act on - and saying so is the difference between a
    // control that did nothing and a control that appears broken.
    const inside = countOnButton(button);
    setText(
      live,
      `${name} is collapsed, so no Tickets are on the page to filter. ` +
        `${String(inside)} AI-corrected inside it. Open a Feature, or switch the column to all cards.`,
    );
    forget(live);
    return;
  }
  setText(
    live,
    `${name}: showing ${String(tally.shown)} AI-corrected, ${String(tally.hidden)} hidden.`,
  );
  // What this sentence described, so a later frame can tell whether it is still true.
  live.setAttribute('data-for', String(key));
  live.setAttribute('data-sig', signatureOf(tally));
}

/**
 * Every Ticket a column has on the page, in both of the shapes it draws them in.
 *
 * Both, because the filter acts on both: a Feature opened inside the collapsed Done column
 * draws ledger rows and no cards, so counting only cards there reports that a press did nothing
 * while rows were being hidden underneath it.
 *
 * @param {Element|null} column
 * @param {Map<string, string[]>} marked
 * @returns {{ shown: number, hidden: number }}
 */
function countFiltered(column, marked) {
  let shown = 0;
  let hidden = 0;
  if (column === null) return { shown, hidden };
  for (const shape of ROWS) {
    for (const node of column.querySelectorAll(shape.row)) {
      if (marked.has(node.getAttribute(shape.key) ?? '')) shown += 1;
      else hidden += 1;
    }
  }
  return { shown, hidden };
}

/** @param {{ shown: number, hidden: number }} tally */
function signatureOf(tally) {
  return `${String(tally.shown)}:${String(tally.hidden)}`;
}

/** @param {Element} live */
function forget(live) {
  if (live.getAttribute('data-for') !== null) live.removeAttribute('data-for');
  if (live.getAttribute('data-sig') !== null) live.removeAttribute('data-sig');
}

/**
 * Clear an announcement a later frame has made untrue.
 *
 * A live region states a result, and a result goes stale: press a filter, then let every
 * correction disappear, and the control goes with them while the sentence stays on screen
 * saying six are showing. Cleared rather than rewritten, deliberately - recomputing it would
 * announce again on every file change, which on a live board is several times a minute.
 *
 * @param {Document} doc
 * @param {Element|null} board
 */
function freshenAnnouncement(doc, board) {
  const live = doc.getElementById('corrections-live');
  if (live === null) return;
  const key = live.getAttribute('data-for');
  if (key === null) return;

  const column = board === null ? null : columnFor(board, key);
  const button = column?.querySelector('[data-corrections-filter]') ?? null;
  const stillPressed = button !== null && button.getAttribute('aria-pressed') === 'true';
  const stillTrue =
    stillPressed && live.getAttribute('data-sig') === signatureOf(countFiltered(column, markedIds(board)));
  if (stillTrue) return;
  setText(live, '');
  forget(live);
}

/**
 * The corrected count a button already states, read back off the button rather than recomputed.
 *
 * A press has to answer without waiting for the next Snapshot, and the number on the control
 * the reader just pressed is the number they are owed an explanation of - recomputing it here
 * could only ever produce a second answer that disagreed with the one on screen.
 *
 * @param {Element} button
 * @returns {number}
 */
function countOnButton(button) {
  const digits = /^\d+/.exec(button.textContent ?? '');
  return digits === null ? 0 : Number(digits[0]);
}

/**
 * @param {Element} board
 * @param {string|null} key
 * @returns {Element|null}
 */
function columnFor(board, key) {
  if (key === null) return null;
  for (const column of board.querySelectorAll('[data-col]')) {
    if (column.getAttribute('data-col') === key) return column;
  }
  return null;
}

/**
 * The ids currently marked, read back off the document.
 *
 * A press has to act without waiting for the next Snapshot, and the marks on the page are
 * already the answer - so the filter reads them rather than holding a copy that could disagree
 * with what the reader can see.
 *
 * @param {Element|null} board
 * @returns {Map<string, string[]>}
 */
function markedIds(board) {
  const found = new Map();
  if (board === null) return found;
  for (const shape of ROWS) {
    for (const node of board.querySelectorAll(shape.row)) {
      const id = node.getAttribute(shape.key);
      const slot = node.querySelector(shape.id);
      if (id === null || slot === null) continue;
      if (slot.getAttribute('data-corrected') !== null) found.set(id, []);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {Element|null} mount
 * @param {Facts} facts
 */
function drawPanel(doc, mount, facts) {
  if (mount === null) return;
  const frame = panelFrame(doc, mount);

  setText(
    frame.lead,
    facts.total === 0
      ? 'No Override has changed a field on this board.'
      : `${String(facts.total)} of ${String(facts.cards)} Tickets carry an Override that ` +
        'disagreed with the file, on the fields named below.',
  );

  // Every column, including the ones at zero. The header control is drawn only where there is
  // something to filter, so this list is the only place a reader can learn that a column was
  // counted and came back empty - which is a different fact from not having been counted.
  const rows = [];
  for (const key of Object.keys(COLUMN_LANES)) {
    rows.push([key, columnCount(facts, key)]);
  }
  if (facts.unlaned > 0) {
    rows.push(['not on the board', facts.unlaned]);
  }
  writeRows(doc, frame.rows, rows);

  // A rejected Override is the one number that must never be inferred from an absence: a
  // dropped Override and a parser that quietly regressed look identical on a board that only
  // counts what it applied.
  setText(
    frame.rejected,
    facts.rejected === 0
      ? 'No Override was rejected.'
      : `${String(facts.rejected)} ${facts.rejected === 1 ? 'Override was' : 'Overrides were'} ` +
        'rejected and did not reach a card.',
  );
  writeRejections(doc, frame.why, facts.rejections);
}

/**
 * Build the panel's frame once and hand it back on every later frame.
 *
 * Rebuilding it per frame would close whatever the reader had open inside it and throw away
 * the caret, several times a minute, for a subtree whose text is all that ever changes.
 *
 * @param {Document} doc
 * @param {Element} mount
 */
function panelFrame(doc, mount) {
  const found = mount.querySelector('.corrbody');
  if (found !== null) {
    return {
      lead: found.querySelector('.corrlead'),
      rows: found.querySelector('.corrrows'),
      rejected: found.querySelector('.corrrej'),
      why: found.querySelector('.corrwhy'),
    };
  }

  const head = doc.createElement('div');
  head.className = 'subhead';
  const title = doc.createElement('h2');
  title.id = 'corrections-h';
  title.textContent = 'AI-corrected Tickets';
  const note = doc.createElement('p');
  note.className = 'subnote';
  note.textContent = 'An Override the AI layer wrote, where it disagreed with the file.';
  head.append(title, note);

  const body = doc.createElement('div');
  body.className = 'corrbody';
  const lead = doc.createElement('p');
  lead.className = 'corrlead';
  const rows = doc.createElement('ul');
  rows.className = 'corrrows';
  const rejected = doc.createElement('p');
  rejected.className = 'corrrej';
  const why = doc.createElement('ul');
  why.className = 'corrwhy';
  // Reserved height, so announcing never moves the panel under whoever is reading it.
  const live = doc.createElement('p');
  live.className = 'corrlive';
  live.id = 'corrections-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  body.append(lead, rows, rejected, why, live);

  mount.setAttribute('aria-labelledby', 'corrections-h');
  mount.replaceChildren(head, body);
  return { lead, rows, rejected, why };
}

/**
 * @param {Document} doc
 * @param {Element|null} host
 * @param {[string, number][]} rows
 */
function writeRows(doc, host, rows) {
  reconcile(doc, host, rows.map((row) => ({ key: row[0], build: () => buildRow(doc, row) })));
}

/**
 * @param {Document} doc
 * @param {[string, number]} row
 */
function buildRow(doc, row) {
  const item = doc.createElement('li');
  const label = doc.createElement('span');
  label.className = 'k';
  label.textContent = row[0];
  const value = doc.createElement('span');
  value.className = 'n';
  value.textContent = String(row[1]);
  item.append(label, value);
  return item;
}

/**
 * The rejected Overrides, named by field and by what the validator said.
 *
 * The message is reproduced verbatim and nothing is added to it. What a rejection message may
 * contain is the seam's decision, not this panel's - it names the field and the overage so the
 * model that wrote the Override can correct itself - and a panel that paraphrased would be
 * inventing a second wording of a fact it did not compute.
 *
 * @param {Document} doc
 * @param {Element|null} host
 * @param {{ path: string, field: string, message: string }[]} rejections
 */
function writeRejections(doc, host, rejections) {
  reconcile(
    doc,
    host,
    rejections.map((one, index) => ({
      key: `${String(index)}${JSON.stringify([one.path, one.field, one.message])}`,
      build: () => buildRejection(doc, one),
    })),
  );
}

/**
 * @param {Document} doc
 * @param {{ path: string, field: string, message: string }} one
 */
function buildRejection(doc, one) {
  const item = doc.createElement('li');
  const field = doc.createElement('span');
  field.className = 'k';
  field.textContent = one.field;
  const message = doc.createElement('span');
  message.className = 'v';
  message.textContent = one.message;
  // The path copies rather than navigates, on the board's own delegated handler: a file-scheme
  // link from a page served over HTTP is a link the browser refuses to follow.
  const copy = doc.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.setAttribute('data-copy', one.path);
  copy.setAttribute('aria-label', `Copy path ${one.path}`);
  copy.textContent = one.path;
  item.append(field, message, copy);
  return item;
}

/**
 * Patch a keyed list in place: keep what is still wanted, build what is new, drop the rest.
 *
 * Not an optimisation. Rebuilding the whole list when a signature moves means one count change
 * throws away every row - including a copy button the reader has focused and a path they are
 * half way through selecting. On a live board a count changes several times a minute.
 *
 * Keys are `JSON.stringify` rather than a delimiter join, because a rejection's path, field and
 * message are strings out of somebody else's repository: any separator can appear inside them,
 * and a collision here silently suppresses an update.
 *
 * @param {Document} doc
 * @param {Element|null} host
 * @param {{ key: string, build: () => Element }[]} wanted
 */
function reconcile(doc, host, wanted) {
  void doc;
  if (host === null) return;
  const existing = new Map();
  for (const node of host.querySelectorAll('[data-row]')) {
    const key = node.getAttribute('data-row');
    if (key !== null && !existing.has(key)) existing.set(key, node);
  }

  const seen = new Set();
  let previous = null;
  for (const entry of wanted) {
    seen.add(entry.key);
    let node = existing.get(entry.key) ?? null;
    if (node === undefined || node === null) {
      node = entry.build();
      node.setAttribute('data-row', entry.key);
      host.appendChild(node);
    }
    const shouldFollow = previous === null ? host.firstChild : previous.nextSibling;
    if (shouldFollow !== node) host.insertBefore(node, shouldFollow);
    previous = node;
  }

  for (const [key, node] of existing) {
    if (!seen.has(key)) node.remove();
  }
}

/**
 * The last resort: something in this module threw, and the reader is told rather than shown a
 * panel that quietly stopped updating.
 *
 * The heading is rebuilt with it, because the mount is named by `aria-labelledby` pointing at
 * that heading's id: replacing the mount's children without it would leave the region carrying
 * a reference to an element that no longer exists, which is a region with no name at all.
 *
 * @param {Document} doc
 * @param {unknown} error
 */
function report(doc, error) {
  try {
    const mount = doc.getElementById('corrections-panel');
    if (mount === null) return;
    const head = doc.createElement('div');
    head.className = 'subhead';
    const title = doc.createElement('h2');
    title.id = 'corrections-h';
    title.textContent = 'AI-corrected Tickets';
    head.appendChild(title);
    const line = doc.createElement('p');
    line.className = 'corrfail';
    line.textContent = `The AI-corrected panel could not be drawn: ${String(error)}`;
    mount.setAttribute('aria-labelledby', 'corrections-h');
    mount.replaceChildren(head, line);
  } catch {
    // The document itself is unusable. There is nowhere left to say so.
  }
}

// ---------------------------------------------------------------------------
// Projecting the Snapshot
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   total: number,
 *   cards: number,
 *   unlaned: number,
 *   rejected: number,
 *   byLane: Record<string, unknown>,
 *   byCard: Map<string, string[]>,
 *   rejections: { path: string, field: string, message: string }[],
 * }} Facts
 */

/**
 * @param {unknown} snapshot
 * @returns {Facts}
 */
function project(snapshot) {
  // **Every** read below goes through `readMap`, never a plain index. Not belt and braces, and
  // not only for the keys that look like data: the Snapshot is `JSON.parse` output whose objects
  // carry `Object.prototype`, so `byLane.unlaned` on a page where anything has written
  // `Object.prototype.unlaned = 3` answers 3 on an empty board. Doing it in some places and not
  // others only looks safe; one plain index is enough to accept the polluted value.
  const root = asObject(snapshot);
  const corrections = asObject(readMap(root, 'corrections'));
  const byLane = asObject(readMap(corrections, 'byLane'));

  const byCard = new Map();
  let cards = 0;
  for (const one of asArray(readMap(root, 'roots'))) {
    for (const feature of asArray(readMap(asObject(one), 'features'))) {
      for (const ticket of asArray(readMap(asObject(feature), 'tickets'))) {
        const card = asObject(ticket);
        const id = readMap(card, 'id');
        if (typeof id !== 'string' || id === '') continue;
        cards += 1;
        const fields = asStrings(readMap(asObject(readMap(card, 'derivation')), 'correctedFields'));
        // First wins, matching `render.js`'s own card pool exactly. Ids are unique by
        // construction, so this only arises on a Snapshot that has broken that - and there the
        // node on screen is the first occurrence's, so the mark on it must describe the first
        // occurrence too. Last-wins would have marked one Ticket with another's fields.
        if (fields.length > 0 && !byCard.has(id)) byCard.set(id, fields);
      }
    }
  }

  const rejections = [];
  for (const entry of asArray(readMap(root, 'rejections'))) {
    const one = asObject(entry);
    if (readMap(one, 'kind') !== 'override') continue;
    rejections.push({
      path: asText(readMap(one, 'path')),
      field: asText(readMap(one, 'field')),
      message: asText(readMap(one, 'message')),
    });
  }

  // `overrides.applied` and `corrections.total` are the same number by construction - both are
  // the count of cards whose Override changed a field - so only one of them is drawn. Printing
  // both would invite a reader to look for a difference that cannot exist.
  return {
    total: asCount(readMap(corrections, 'total')),
    cards: cards === 0 ? asCount(readMap(asObject(readMap(root, 'progress')), 'total')) : cards,
    unlaned: asCount(readMap(byLane, 'unlaned')),
    rejected: asCount(readMap(asObject(readMap(root, 'overrides')), 'rejected')),
    byLane,
    byCard,
    rejections,
  };
}

/**
 * @param {Facts} facts
 * @param {string} key
 * @returns {number}
 */
function columnCount(facts, key) {
  const lanes = readMap(COLUMN_LANES, key);
  if (!Array.isArray(lanes)) return 0;
  let total = 0;
  for (const lane of lanes) {
    if (typeof lane === 'string') total += asCount(readMap(facts.byLane, lane));
  }
  return total;
}

/**
 * A keyed read that cannot reach an inherited member.
 *
 * The Snapshot is `JSON.parse` output and its keys are file names and Lane names out of
 * somebody else's repository, so a plain index could answer with something off the prototype
 * chain rather than with data.
 *
 * @param {Record<string, unknown>} map
 * @param {string} key
 * @returns {unknown}
 */
function readMap(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {unknown[]} */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value @returns {string[]} */
function asStrings(value) {
  return asArray(value).filter((entry) => typeof entry === 'string' && entry !== '');
}

/** A count that is a real, finite, non-negative number, or zero. @param {unknown} value */
function asCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/** @param {unknown} value @returns {string} */
function asText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {Element|null} node
 * @param {string} text
 */
function setText(node, text) {
  if (node === null || node.textContent === text) return;
  node.textContent = text;
}

/**
 * @param {Element|null} node
 * @param {string} name
 * @param {string} value
 */
function setAttr(node, name, value) {
  if (node === null || node.getAttribute(name) === value) return;
  node.setAttribute(name, value);
}
