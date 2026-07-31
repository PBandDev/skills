/**
 * tracker-board - view model to DOM.
 *
 * Patches rather than rebuilds. Replacing the board's markup on every frame would be far less
 * code, and it would also destroy the thing the board is for: an agent rewrites a file every
 * few seconds, so a wholesale rebuild throws away focus, scroll position and any selection the
 * reader had, several times a minute, and makes it impossible to see *which* card moved.
 *
 * Keys come from the Snapshot's own card ids. Nothing here invents an identity.
 *
 * This module chooses nothing. Every glyph, label, count, hint and ordering arrives on the
 * view already decided, and the code below puts values into nodes. That is deliberate and it
 * is what makes the board's behaviour assertable: a decision taken here would be a decision
 * that could only be checked by driving a browser.
 *
 * ## Everything is built with `textContent`
 *
 * The board renders text out of arbitrary repositories - a Ticket title, a status qualifier, a
 * file name. If any of it reached the DOM as markup, a script would run in the board's own
 * origin, where `/snapshot` is the text of every file in every watched Root. So no node here
 * is ever built from a string, and the guard on that is a source scan in `board-http.test.ts`
 * which forbids the whole class of markup-assigning properties by name. The scan reads
 * comments too, which is why none of them are spelled out anywhere in this file.
 */

const FEATURE_ACCENTS = 6;

/**
 * @typedef {import('./view.js').BoardView} BoardView
 * @typedef {import('./view.js').CardView} CardView
 * @typedef {import('./view.js').ColumnView} ColumnView
 * @typedef {import('./view.js').Run} Run
 */

/**
 * Draw a view into the page, reusing whatever is already there.
 *
 * @param {Document} doc
 * @param {BoardView} view
 * @returns {{ added: number, updated: number, removed: number }}
 */
export function render(doc, view) {
  renderNotices(doc, view);
  renderHeader(doc, view);
  renderLegend(doc, view);

  const board = doc.getElementById('board');
  if (board === null) return { added: 0, updated: 0, removed: 0 };

  const placeholder = doc.getElementById('emptystate');
  if (placeholder !== null) placeholder.hidden = !view.empty;

  // One pool of card nodes for the whole board and the off-board list, keyed by the Snapshot's
  // card id, built before anything is drawn.
  //
  // Indexing per destination list instead - which is what this did first - means a card that
  // changes Lane is not found where it lands, so it is rebuilt and the old node discarded.
  // That loses three things at once, and the third is the worst: focus and the navigation
  // marker, any selection inside the card, and the just-changed tint. The tint is the whole
  // point. A card moving Lane is the single most interesting event this board reports, and
  // treating it as an unrelated add plus an unrelated remove is precisely the case where the
  // board must say "this one moved" and instead said nothing.
  //
  // The legend's specimens carry card keys too and are deliberately not pooled: they live in
  // their own host, are never Snapshot cards, and must never be a destination.
  const offboard = doc.getElementById('offboard');
  const pool = new Map();
  for (const host of [board, offboard]) {
    if (host === null) continue;
    for (const node of host.querySelectorAll('[data-card]')) {
      const key = node.getAttribute('data-card');
      if (key !== null && !pool.has(key)) pool.set(key, node);
    }
  }

  const tally = { added: 0, updated: 0, removed: 0, pool, seen: new Set(), stale: [] };

  renderOffBoard(doc, view, tally);

  const existing = indexBy(board.querySelectorAll('[data-col]'), 'data-col');
  let previous = null;

  for (const column of view.columns) {
    let section = existing.get(column.key) ?? null;
    if (section === null) {
      section = buildColumn(doc, column);
      board.appendChild(section);
    }
    // Keep document order matching view order without moving nodes that are already right.
    // The six columns never reorder, but a needless move resets any animation inside one.
    const shouldFollow = previous === null ? board.firstChild : previous.nextSibling;
    if (shouldFollow !== section) board.insertBefore(section, shouldFollow);
    previous = section;
    updateColumn(doc, section, column, tally);
  }

  // One sweep at the end. A card is gone only if nothing claimed it anywhere on the board,
  // which is a question that cannot be answered from inside a single list.
  for (const [key, node] of pool) {
    if (tally.seen.has(key)) continue;
    node.remove();
    tally.removed += 1;
  }
  // Containers last. A sub-lane or Feature group that emptied may still have been holding a
  // card a later column claimed, and detaching it before that claim would take the card's
  // focus with it.
  for (const block of tally.stale) block.remove();

  return { added: tally.added, updated: tally.updated, removed: tally.removed };
}

/**
 * Find a card node by its key.
 *
 * A loop rather than a selector, and that is the whole point of the function. The key contains
 * a Root path and a file name - strings from somebody else's repository - and a selector is a
 * parsed language. Escaping one correctly for every legal POSIX name, control characters
 * included, is a problem worth not having. Reading the attribute back never parses anything.
 *
 * Exported so the navigation it drives can be asserted without a browser.
 *
 * @param {Iterable<Element>} nodes
 * @param {string|null} id
 * @returns {Element|null}
 */
export function findCard(nodes, id) {
  if (id === null || id === '') return null;
  for (const node of nodes) {
    if (node.getAttribute('data-card') === id) return node;
  }
  return null;
}

/**
 * The comparison key that decides whether a card's meter segments are rebuilt.
 *
 * Exported because it is a correctness property rather than an optimisation, and because a
 * property is the only useful way to state it: **two meters that draw differently must never
 * share a signature.** Keyed on the drawn segment count and the checked count alone it does
 * not hold, because the drawn count saturates at the cap - 1 of 100 draws forty segments with
 * none lit, 1 of 41 draws forty with one lit, and both said `40:1`. The renderer then skipped
 * the rebuild and left a bar that contradicted the ratio printed beside it.
 *
 * The total closes it: segments are a pure function of `checked` and `total`, so carrying both
 * makes the signature injective over everything that can change the drawing.
 *
 * @param {{ checked: number, total: number, segments: boolean[] }} meter
 * @returns {string}
 */
export function meterSignature(meter) {
  return `${String(meter.total)}:${String(meter.checked)}:${String(meter.segments.length)}`;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {ColumnView} column
 */
function buildColumn(doc, column) {
  const section = doc.createElement('section');
  section.className = 'col';
  section.setAttribute('data-col', column.key);
  section.setAttribute('aria-labelledby', `h-${column.key}`);

  const head = doc.createElement('div');
  head.className = 'col-head';

  const row = doc.createElement('div');
  row.className = 'hrow';
  const heading = doc.createElement('h3');
  heading.id = `h-${column.key}`;
  const glyph = doc.createElement('span');
  glyph.className = 'cglyph';
  glyph.setAttribute('aria-hidden', 'true');
  const name = doc.createElement('span');
  name.className = 'cname';
  heading.append(glyph, name);
  const count = doc.createElement('span');
  count.className = 'ccount n';
  row.append(heading, count);

  const hint = doc.createElement('p');
  hint.className = 'chint';
  const breakdown = doc.createElement('p');
  breakdown.className = 'cbreak';

  head.append(row, hint, breakdown);

  const body = doc.createElement('div');
  body.className = 'col-body';
  section.append(head, body);
  return section;
}

/**
 * @param {Document} doc
 * @param {Element} section
 * @param {ColumnView} column
 * @param {{ added: number, updated: number, removed: number }} tally
 */
function updateColumn(doc, section, column, tally) {
  setText(section.querySelector('.cglyph'), column.glyph);
  setText(section.querySelector('.cname'), column.name);
  setText(section.querySelector('.ccount'), String(column.count));
  setRuns(doc, section.querySelector('.chint'), column.hint);

  const breakdown = section.querySelector('.cbreak');
  setRuns(doc, breakdown, column.breakdown);
  if (breakdown !== null) breakdown.hidden = column.breakdown.length === 0;

  const body = section.querySelector('.col-body');
  if (body === null) return;

  if (column.count === 0) {
    renderColumnEmpty(doc, body, column);
    return;
  }
  if (column.collapsed !== null) {
    renderCollapsed(doc, body, column, tally);
    return;
  }
  renderSublanes(doc, body, column, tally);
}

/**
 * An empty column is drawn, never hidden. A column that disappears when it empties cannot be
 * learned, and its absence reads as "this board has no such state" rather than "nothing is in
 * it right now".
 *
 * @param {Document} doc
 * @param {Element} body
 * @param {ColumnView} column
 */
function renderColumnEmpty(doc, body, column) {
  if (body.getAttribute('data-mode') === 'empty') return;
  body.setAttribute('data-mode', 'empty');
  body.replaceChildren();
  const box = doc.createElement('div');
  box.className = 'colempty';
  const zero = doc.createElement('span');
  zero.className = 'zero n';
  zero.textContent = '0';
  const word = doc.createElement('b');
  word.textContent = 'none';
  const note = doc.createElement('span');
  note.textContent = column.emptyNote;
  box.append(zero, word, note);
  body.appendChild(box);
}

/**
 * @param {Document} doc
 * @param {Element} body
 * @param {ColumnView} column
 * @param {{ added: number, updated: number, removed: number }} tally
 */
function renderSublanes(doc, body, column, tally) {
  if (body.getAttribute('data-mode') !== 'lanes') {
    body.setAttribute('data-mode', 'lanes');
    body.replaceChildren();
  }

  const existing = indexBy(body.querySelectorAll('[data-lane]'), 'data-lane');
  const seen = new Set();
  let previous = null;

  for (const sublane of column.sublanes) {
    // A *labelled* sub-lane at zero is drawn, exactly as an empty column is. The rule one level
    // up is written into the view model verbatim - an empty column is a fact about the board,
    // and a column that vanishes when it empties cannot be learned - and it is no less true
    // here. "Frozen on you" and "Queued for an agent" are opposite instructions to a reader:
    // one says nothing moves until you act, the other says somebody else is already on it. A
    // reader who only ever meets whichever one happens to be populated never learns the Blocked
    // column was ever split, and reads the survivor as the whole column.
    //
    // An *unlabelled* sub-lane is still skipped. A single-Lane column draws no sub-lane heading
    // at all, so there is nothing there to carry the zero - it would be an anonymous empty
    // block, and a second empty state besides, because a column whose total is zero never
    // reaches this function: `updateColumn` hands it to `renderColumnEmpty` and returns.
    if (sublane.count === 0 && !sublane.labelled) continue;
    seen.add(sublane.lane);
    let block = existing.get(sublane.lane) ?? null;
    if (block === null) {
      block = buildSublane(doc, sublane);
      body.appendChild(block);
    }
    const shouldFollow = previous === null ? body.firstChild : previous.nextSibling;
    if (shouldFollow !== block) body.insertBefore(block, shouldFollow);
    previous = block;

    const header = block.querySelector('.sublane');
    if (header !== null) {
      header.hidden = !sublane.labelled;
      setText(header.querySelector('.sg'), sublane.glyph);
      setText(header.querySelector('.sl'), sublane.label);
      setText(header.querySelector('.sn'), String(sublane.count));
    }
    const note = block.querySelector('.sublane-note');
    if (note !== null) {
      note.hidden = !sublane.labelled || sublane.note === '';
      setText(note, sublane.note);
    }
    // The zero marker. A heading, a rule and a bare `0` with nothing under it reads as a
    // renderer that gave up half way; the word says the emptiness was drawn on purpose. Same
    // word the column-level empty box uses, because it is the same fact at a smaller scale.
    setFlag(block, 'data-empty', sublane.count === 0);
    const empty = block.querySelector('.laneempty');
    if (empty !== null) empty.hidden = sublane.count > 0;

    const list = block.querySelector('.lanecards');
    if (list !== null) renderGroups(doc, list, sublane.groups, tally);
  }

  for (const [key, block] of existing) {
    if (seen.has(key)) continue;
    tally.stale.push(block);
  }

  renderColumnNote(doc, body, column);
}

/**
 * @param {Document} doc
 * @param {{ lane: string }} sublane
 */
function buildSublane(doc, sublane) {
  const block = doc.createElement('div');
  block.className = 'lane';
  block.setAttribute('data-lane', sublane.lane);

  const header = doc.createElement('p');
  header.className = 'sublane';
  header.setAttribute('data-l', sublane.lane);
  const glyph = doc.createElement('span');
  glyph.className = 'sg';
  glyph.setAttribute('aria-hidden', 'true');
  const label = doc.createElement('span');
  label.className = 'sl';
  const rule = doc.createElement('span');
  rule.className = 'rule';
  rule.setAttribute('aria-hidden', 'true');
  const count = doc.createElement('span');
  count.className = 'sn n';
  header.append(glyph, label, rule, count);

  const note = doc.createElement('p');
  note.className = 'sublane-note';

  const empty = doc.createElement('p');
  empty.className = 'laneempty';
  empty.textContent = 'none';

  const list = doc.createElement('div');
  list.className = 'lanecards';
  block.append(header, note, empty, list);
  return block;
}

/**
 * @param {Document} doc
 * @param {Element} body
 * @param {ColumnView} column
 */
function renderColumnNote(doc, body, column) {
  let note = body.querySelector('.colnote');
  if (column.note === '') {
    if (note !== null) note.remove();
    return;
  }
  if (note === null) {
    note = doc.createElement('p');
    note.className = 'colnote';
    body.appendChild(note);
  }
  setText(note, column.note);
  if (note !== body.lastChild) body.appendChild(note);
}

// ---------------------------------------------------------------------------
// Done, collapsed
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {Element} body
 * @param {ColumnView} column
 * @param {{ added: number, updated: number, removed: number }} tally
 */
function renderCollapsed(doc, body, column, tally) {
  const collapsed = column.collapsed;
  if (collapsed === null) return;
  if (body.getAttribute('data-mode') !== 'collapsed') {
    body.setAttribute('data-mode', 'collapsed');
    body.replaceChildren();
    const lead = doc.createElement('div');
    lead.className = 'dig-lead';
    const big = doc.createElement('span');
    big.className = 'big n';
    const sub = doc.createElement('span');
    sub.className = 'sub';
    lead.append(big, sub);
    const rows = doc.createElement('div');
    rows.className = 'digrows';
    const note = doc.createElement('p');
    note.className = 'colnote';
    body.append(lead, rows, note);
  }

  setText(body.querySelector('.big'), String(collapsed.total));
  setText(
    body.querySelector('.sub'),
    `Tickets finished across ${String(collapsed.featureCount)} ${
      collapsed.featureCount === 1 ? 'Feature' : 'Features'
    }. Open one to read its ledger, or switch this column to full cards.`,
  );
  setText(body.querySelector('.colnote'), collapsed.note);

  const host = body.querySelector('.digrows');
  if (host === null) return;
  const existing = indexBy(host.querySelectorAll('[data-digrow]'), 'data-digrow');
  const seen = new Set();
  let previous = null;

  for (const row of collapsed.rows) {
    seen.add(row.key);
    let block = existing.get(row.key) ?? null;
    if (block === null) {
      block = buildCollapsedRow(doc, row.key);
      host.appendChild(block);
    }
    const shouldFollow = previous === null ? host.firstChild : previous.nextSibling;
    if (shouldFollow !== block) host.insertBefore(block, shouldFollow);
    previous = block;

    const toggle = block.querySelector('.frow');
    if (toggle !== null) {
      setAttr(toggle, 'aria-expanded', row.expanded ? 'true' : 'false');
      setAttr(toggle, 'data-toggle', row.key);
      setAttr(toggle, 'data-accent', accentSlot(row.accent));
      setText(toggle.querySelector('.sigil'), row.sigil);
      setText(toggle.querySelector('.fname'), row.featureName);
      setText(toggle.querySelector('.fcount'), String(row.count));
    }
    const ledger = block.querySelector('.ledger');
    if (ledger === null) continue;
    ledger.hidden = !row.expanded;
    if (row.expanded) renderLedger(doc, ledger, row.cards);
    else if (ledger.firstChild !== null) ledger.replaceChildren();
  }

  for (const [key, block] of existing) {
    if (seen.has(key)) continue;
    block.remove();
  }
}

/**
 * @param {Document} doc
 * @param {string} key
 */
function buildCollapsedRow(doc, key) {
  const block = doc.createElement('div');
  block.className = 'digblock';
  block.setAttribute('data-digrow', key);

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'frow';
  const sigil = doc.createElement('span');
  sigil.className = 'sigil';
  const name = doc.createElement('span');
  name.className = 'fname';
  const count = doc.createElement('span');
  count.className = 'fcount n';
  const caret = doc.createElement('span');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '\u25B8';
  toggle.append(sigil, name, count, caret);

  const ledger = doc.createElement('div');
  ledger.className = 'ledger';
  block.append(toggle, ledger);
  return block;
}

/**
 * @param {Document} doc
 * @param {Element} ledger
 * @param {CardView[]} cards
 */
function renderLedger(doc, ledger, cards) {
  const existing = indexBy(ledger.querySelectorAll('[data-ledger]'), 'data-ledger');
  const seen = new Set();
  let previous = null;

  for (const card of cards) {
    seen.add(card.id);
    let row = existing.get(card.id) ?? null;
    if (row === null) {
      row = doc.createElement('div');
      row.className = 'lrow';
      row.setAttribute('data-ledger', card.id);
      const id = doc.createElement('span');
      id.className = 'lid n';
      const ratio = doc.createElement('span');
      ratio.className = 'lck n';
      const title = doc.createElement('span');
      title.className = 'ltitle';
      row.append(id, ratio, title);
      ledger.appendChild(row);
    }
    const shouldFollow = previous === null ? ledger.firstChild : previous.nextSibling;
    if (shouldFollow !== row) ledger.insertBefore(row, shouldFollow);
    previous = row;

    setText(row.querySelector('.lid'), card.shortId);
    setText(row.querySelector('.lck'), card.meter === null ? '\u25C7' : card.meter.text);
    setText(row.querySelector('.ltitle'), card.title);
  }

  for (const [key, row] of existing) {
    if (!seen.has(key)) row.remove();
  }
}

// ---------------------------------------------------------------------------
// Feature groups and cards
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {Element} host
 * @param {import('./view.js').GroupView[]} groups
 * @param {{ added: number, updated: number, removed: number }} tally
 */
function renderGroups(doc, host, groups, tally) {
  const existing = indexBy(host.querySelectorAll('[data-group]'), 'data-group');
  const seen = new Set();
  let previous = null;

  for (const group of groups) {
    seen.add(group.key);
    let block = existing.get(group.key) ?? null;
    if (block === null) {
      block = buildGroup(doc, group);
      host.appendChild(block);
    }
    const shouldFollow = previous === null ? host.firstChild : previous.nextSibling;
    if (shouldFollow !== block) host.insertBefore(block, shouldFollow);
    previous = block;

    setAttr(block, 'data-accent', accentSlot(group.accent));
    setText(block.querySelector('.sigil'), group.sigil);
    setText(block.querySelector('.gname'), group.featureName);
    setText(block.querySelector('.gcount'), String(group.cards.length));

    const list = block.querySelector('.cards');
    if (list !== null) renderCards(doc, list, group.cards, tally);
  }

  for (const [key, block] of existing) {
    if (seen.has(key)) continue;
    tally.stale.push(block);
  }
}

/**
 * @param {Document} doc
 * @param {import('./view.js').GroupView} group
 */
function buildGroup(doc, group) {
  const block = doc.createElement('div');
  block.className = 'grpblock';
  block.setAttribute('data-group', group.key);

  const head = doc.createElement('p');
  head.className = 'grp';
  const sigil = doc.createElement('span');
  sigil.className = 'sigil';
  const name = doc.createElement('span');
  name.className = 'gname';
  const rule = doc.createElement('span');
  rule.className = 'rule';
  rule.setAttribute('aria-hidden', 'true');
  const count = doc.createElement('span');
  count.className = 'gcount n';
  head.append(sigil, name, rule, count);

  const list = doc.createElement('div');
  list.className = 'cards';
  block.append(head, list);
  return block;
}

/**
 * @param {Document} doc
 * @param {Element} list
 * @param {CardView[]} cards
 * @param {{ added: number, updated: number, removed: number }} tally
 */
function renderCards(doc, list, cards, tally) {
  let previous = null;

  for (const card of cards) {
    tally.seen.add(card.id);
    let node = tally.pool.get(card.id) ?? null;
    const isNew = node === null;
    if (node === null) {
      node = buildCard(doc, card);
      tally.pool.set(card.id, node);
      tally.added += 1;
    }
    // `insertBefore` moves a node that is already somewhere else, which is exactly what is
    // wanted when a card changes Lane: the same node, carrying its focus and its marks, ends
    // up in the new list. The guard skips nodes already in the right place in this list, so
    // an unchanged board performs no moves at all.
    const shouldFollow = previous === null ? list.firstChild : previous.nextSibling;
    if (node.parentNode !== list || shouldFollow !== node) list.insertBefore(node, shouldFollow);
    previous = node;

    if (!isNew && updateCard(doc, node, card)) {
      tally.updated += 1;
      mark(node);
    }
  }
}

/**
 * Build a card's full frame once, with every optional block present and hidden.
 *
 * Toggling `hidden` rather than adding and removing nodes is what keeps an update a set of
 * attribute writes: a card whose status changes must not lose focus, and a card that is
 * rebuilt every frame cannot be pointed at by the blocker navigation.
 *
 * @param {Document} doc
 * @param {CardView} card
 */
function buildCard(doc, card) {
  const node = doc.createElement('article');
  node.className = 'card';
  node.setAttribute('data-card', card.id);
  // Focusable programmatically but not in the tab order: this is the target of the blocker
  // navigation, and putting every card in the tab sequence would bury the real controls.
  node.setAttribute('tabindex', '-1');

  const top = doc.createElement('div');
  top.className = 'card-top';
  const sigil = doc.createElement('span');
  sigil.className = 'sigil';
  const id = doc.createElement('span');
  id.className = 'tid';
  const tag = doc.createElement('span');
  tag.className = 'stag';
  const tagGlyph = doc.createElement('span');
  tagGlyph.className = 'g';
  tagGlyph.setAttribute('aria-hidden', 'true');
  const tagText = doc.createElement('span');
  tagText.className = 't';
  tag.append(tagGlyph, tagText);
  top.append(sigil, id, tag);

  const title = doc.createElement('p');
  title.className = 'card-title';

  const meter = doc.createElement('div');
  meter.className = 'meter';
  const segs = doc.createElement('span');
  segs.className = 'segs';
  segs.setAttribute('aria-hidden', 'true');
  const ratio = doc.createElement('span');
  ratio.className = 'mnum n';
  meter.append(segs, ratio);

  const decision = doc.createElement('div');
  decision.className = 'dchk';
  const pills = doc.createElement('span');
  pills.className = 'pills';
  const why = doc.createElement('span');
  why.className = 'why';
  decision.append(pills, why);

  const unclassified = doc.createElement('div');
  unclassified.className = 'uncl';
  const uhead = doc.createElement('span');
  uhead.className = 'uh';
  uhead.textContent = 'unclassified';
  const urows = doc.createElement('span');
  urows.className = 'rows';
  const uwhy = doc.createElement('span');
  uwhy.className = 'uwhy';
  unclassified.append(uhead, urows, uwhy);

  const whyYou = doc.createElement('div');
  whyYou.className = 'whyyou';
  const wl = doc.createElement('span');
  wl.className = 'wl';
  const wv = doc.createElement('span');
  wv.className = 'wv';
  const wn = doc.createElement('span');
  wn.className = 'wn';
  whyYou.append(wl, wv, wn);

  const frozen = doc.createElement('div');
  frozen.className = 'frozenblk';
  const zl = doc.createElement('span');
  zl.className = 'zl';
  zl.textContent = 'frozen on you \u2014 not yours to do, yours to unblock';
  const zv = doc.createElement('span');
  zv.className = 'zv';
  const zlead = doc.createElement('span');
  zlead.className = 'zlead';
  zlead.textContent = 'every path out ends at ';
  const zbtn = doc.createElement('button');
  zbtn.type = 'button';
  zbtn.className = 'goto';
  const ztitle = doc.createElement('span');
  ztitle.className = 'ztitle';
  zv.append(zlead, zbtn, ztitle);
  const zn = doc.createElement('span');
  zn.className = 'zn';
  frozen.append(zl, zv, zn);

  const blockers = doc.createElement('div');
  blockers.className = 'blk';
  const blkLead = doc.createElement('span');
  blkLead.className = 'k';
  blkLead.textContent = 'blocked by';
  const blkList = doc.createElement('span');
  blkList.className = 'blklist';
  blockers.append(blkLead, blkList);

  const external = doc.createElement('p');
  external.className = 'ext';
  const extLead = doc.createElement('span');
  extLead.className = 'k';
  extLead.textContent = 'waiting on';
  const extText = doc.createElement('span');
  extText.className = 'v';
  external.append(extLead, extText);

  const foot = doc.createElement('p');
  foot.className = 'card-foot';
  const footLead = doc.createElement('span');
  footLead.className = 'k';
  footLead.textContent = 'status';
  const footText = doc.createElement('span');
  footText.className = 'v';
  foot.append(footLead, footText);

  const detail = doc.createElement('p');
  detail.className = 'card-detail';

  const copy = doc.createElement('button');
  copy.className = 'copy';
  copy.type = 'button';

  node.append(
    top,
    title,
    meter,
    decision,
    unclassified,
    whyYou,
    frozen,
    blockers,
    external,
    foot,
    detail,
    copy,
  );
  updateCard(doc, node, card);
  return node;
}

/**
 * Write a card's current values, and report whether anything actually changed.
 *
 * @param {Document} doc
 * @param {Element} node
 * @param {CardView} card
 * @returns {boolean}
 */
function updateCard(doc, node, card) {
  let changed = false;
  changed = setAttr(node, 'data-kind', card.kind) || changed;
  changed = setAttr(node, 'data-accent', accentSlot(card.accent)) || changed;
  changed = setAttr(node, 'data-lane', card.lane ?? 'none') || changed;
  changed = setAttr(node, 'data-state', card.state) || changed;
  changed = setFlag(node, 'data-signoff', card.signoff) || changed;

  changed = setText(node.querySelector('.sigil'), card.sigil) || changed;
  changed = setText(node.querySelector('.tid'), card.shortId) || changed;
  changed = setText(node.querySelector('.card-title'), card.title) || changed;

  const tag = node.querySelector('.stag');
  changed = setAttr(tag, 'data-l', card.lane ?? 'none') || changed;
  changed = setText(node.querySelector('.stag .g'), card.tagGlyph) || changed;
  changed = setText(node.querySelector('.stag .t'), card.tag) || changed;

  changed = updateMeter(doc, node, card) || changed;
  changed = updateDecision(doc, node, card) || changed;
  changed = updateUnclassified(doc, node, card) || changed;
  changed = updateWhyYou(node, card) || changed;
  changed = updateFrozen(node, card) || changed;
  changed = updateBlockers(doc, node, card) || changed;

  const external = node.querySelector('.ext');
  if (external !== null) external.hidden = card.externalBlocker === '';
  changed = setText(node.querySelector('.ext .v'), card.externalBlocker) || changed;

  const foot = node.querySelector('.card-foot');
  if (foot !== null) foot.hidden = card.status === '' && !card.statusPresent;
  changed =
    setText(
      node.querySelector('.card-foot .v'),
      card.status === '' && card.statusPresent ? '(present, empty)' : card.status,
    ) || changed;

  const detail = node.querySelector('.card-detail');
  if (detail !== null) detail.hidden = card.detail === '';
  changed = setText(detail, card.detail) || changed;

  const copy = node.querySelector('.copy');
  if (copy !== null) copy.hidden = card.path === '';
  changed = setText(copy, card.path) || changed;
  changed = setAttr(copy, 'data-copy', card.absPath || card.path) || changed;
  changed = setAttr(copy, 'aria-label', `Copy path ${card.path}`) || changed;
  return changed;
}

/**
 * The criteria meter. It stays a meter and never collapses to a bare ratio: the segments are
 * what make a task Ticket read differently from a decision Ticket at a glance, and a decision
 * Ticket has no ratio at all.
 *
 * @param {Document} doc
 * @param {Element} node
 * @param {CardView} card
 */
function updateMeter(doc, node, card) {
  const meter = node.querySelector('.meter');
  if (meter === null) return false;
  const wanted = card.meter;
  meter.hidden = wanted === null;
  if (wanted === null) return false;

  const segs = meter.querySelector('.segs');
  if (segs !== null) {
    const signature = meterSignature(wanted);
    if (segs.getAttribute('data-sig') !== signature) {
      segs.setAttribute('data-sig', signature);
      segs.replaceChildren();
      for (const on of wanted.segments) {
        const seg = doc.createElement('i');
        if (on) seg.className = 'on';
        segs.appendChild(seg);
      }
    }
  }
  return setText(meter.querySelector('.mnum'), wanted.text);
}

/**
 * @param {Document} doc
 * @param {Element} node
 * @param {CardView} card
 */
function updateDecision(doc, node, card) {
  const block = node.querySelector('.dchk');
  if (block === null) return false;
  const wanted = card.decision;
  block.hidden = wanted === null;
  if (wanted === null) return false;

  const pills = block.querySelector('.pills');
  if (pills !== null) {
    const labels = ['\u25C7 decision', ...(wanted.kind === '' ? [] : [wanted.kind]), ...wanted.flags];
    const signature = JSON.stringify(labels);
    if (pills.getAttribute('data-sig') !== signature) {
      pills.setAttribute('data-sig', signature);
      pills.replaceChildren();
      labels.forEach((label, index) => {
        const pill = doc.createElement('span');
        pill.className = index === 0 ? 'dpill kind' : index === 1 && wanted.kind !== '' ? 'dpill' : 'dpill mode';
        pill.textContent = label;
        pills.appendChild(pill);
      });
    }
  }
  return setText(block.querySelector('.why'), wanted.note);
}

/**
 * @param {Document} doc
 * @param {Element} node
 * @param {CardView} card
 */
function updateUnclassified(doc, node, card) {
  const block = node.querySelector('.uncl');
  if (block === null) return false;
  const wanted = card.unclassified;
  block.hidden = wanted === null;
  if (wanted === null) return false;

  const rows = block.querySelector('.rows');
  if (rows !== null) {
    const signature = JSON.stringify(wanted.rows);
    if (rows.getAttribute('data-sig') !== signature) {
      rows.setAttribute('data-sig', signature);
      rows.replaceChildren();
      for (const row of wanted.rows) {
        const name = doc.createElement('span');
        name.className = 'rk';
        name.textContent = row.name;
        const value = doc.createElement('span');
        value.className = 'rv';
        value.textContent = row.value;
        rows.append(name, value);
      }
    }
  }
  return setText(block.querySelector('.uwhy'), wanted.note);
}

/**
 * @param {Element} node
 * @param {CardView} card
 */
function updateWhyYou(node, card) {
  const block = node.querySelector('.whyyou');
  if (block === null) return false;
  const wanted = card.whyYou;
  block.hidden = wanted === null;
  if (wanted === null) return false;
  let changed = setAttr(block, 'data-src', wanted.src);
  changed = setText(block.querySelector('.wl'), wanted.label) || changed;
  changed = setText(block.querySelector('.wv'), wanted.value) || changed;
  changed = setText(block.querySelector('.wn'), wanted.note) || changed;
  return changed;
}

/**
 * @param {Element} node
 * @param {CardView} card
 */
function updateFrozen(node, card) {
  const block = node.querySelector('.frozenblk');
  if (block === null) return false;
  const wanted = card.frozen;
  block.hidden = wanted === null;
  if (wanted === null) return false;

  const button = block.querySelector('.goto');
  let changed = setText(button, wanted.targetLabel);
  // No target means no navigation attribute at all, rather than an empty one. An empty
  // `data-goto` still answers `closest('[data-goto]')`, so the click handler would run a
  // lookup for a card keyed by the empty string - a question with no useful answer.
  if (button !== null) {
    if (wanted.targetId === null) button.removeAttribute('data-goto');
    else changed = setAttr(button, 'data-goto', wanted.targetId) || changed;
  }
  changed = setAttr(button, 'aria-label', `Move to Ticket ${wanted.targetLabel} on the board`) || changed;
  if (button !== null) button.hidden = wanted.targetId === null;
  changed = setText(block.querySelector('.ztitle'), wanted.targetTitle === '' ? '' : ` \u2014 ${wanted.targetTitle}`) || changed;
  changed = setText(block.querySelector('.zn'), wanted.note) || changed;
  return changed;
}

/**
 * Blocker ids are board-internal navigation, never a path. Each one is a real button whose
 * activation moves focus to the card it names - a reader chasing a chain stays on the board
 * rather than being handed a file path to go and find.
 *
 * @param {Document} doc
 * @param {Element} node
 * @param {CardView} card
 */
function updateBlockers(doc, node, card) {
  const block = node.querySelector('.blk');
  if (block === null) return false;
  block.hidden = card.blockers.length === 0;
  if (card.blockers.length === 0) return false;

  const list = block.querySelector('.blklist');
  if (list === null) return false;
  const signature = JSON.stringify(card.blockers);
  if (list.getAttribute('data-sig') === signature) return false;
  list.setAttribute('data-sig', signature);
  list.replaceChildren();

  for (const ref of card.blockers) {
    if (ref.targetId === null) {
      const dead = doc.createElement('span');
      dead.className = 'goto dangling';
      dead.textContent = `${ref.label} (dangling)`;
      list.appendChild(dead);
      continue;
    }
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'goto';
    button.setAttribute('data-goto', ref.targetId);
    button.setAttribute('data-open', ref.satisfied ? '0' : '1');
    button.setAttribute(
      'aria-label',
      `Move to Ticket ${ref.label} on the board, ${ref.satisfied ? 'finished' : 'still open'}`,
    );
    button.textContent = ref.label;
    list.appendChild(button);
  }
  return true;
}

/** Flag a card as just-changed, restarting the mark if it changes again while lit. */
function mark(node) {
  node.removeAttribute('data-changed');
  // Reading a layout property between the removal and the set is what makes the browser treat
  // this as a new animation rather than a continuing one.
  void node.getBoundingClientRect().width;
  node.setAttribute('data-changed', '1');
}

// ---------------------------------------------------------------------------
// Header, legend, off-board, notices
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {BoardView} view
 */
function renderHeader(doc, view) {
  const summary = doc.getElementById('summary');
  if (summary !== null) summary.textContent = view.summaryText;

  const totals = doc.getElementById('totals');
  if (totals !== null) {
    const signature = JSON.stringify(view.totals);
    if (totals.getAttribute('data-sig') !== signature) {
      totals.setAttribute('data-sig', signature);
      totals.replaceChildren();
      for (const tile of view.totals) {
        const box = doc.createElement('div');
        box.className = tile.hi ? 'tot hi' : 'tot';
        const value = doc.createElement('b');
        value.className = 'n';
        value.textContent = tile.value;
        const label = doc.createElement('span');
        label.className = 'lab';
        label.textContent = tile.label;
        box.append(value, label);
        totals.appendChild(box);
      }
    }
  }

  setRuns(doc, doc.getElementById('headline'), view.headline);
}

/**
 * @param {Document} doc
 * @param {BoardView} view
 */
function renderLegend(doc, view) {
  const host = doc.getElementById('legend');
  if (host === null) return;
  setText(doc.getElementById('legend-title'), view.legend.title);
  setText(doc.getElementById('legend-note'), view.legend.note);

  const existing = indexBy(host.querySelectorAll('[data-spec]'), 'data-spec');
  let previous = null;
  for (const specimen of view.legend.specimens) {
    let block = existing.get(specimen.key) ?? null;
    if (block === null) {
      block = doc.createElement('div');
      block.className = 'speccol';
      block.setAttribute('data-spec', specimen.key);
      const caption = doc.createElement('p');
      caption.className = 'speccap';
      const body = doc.createElement('div');
      body.className = 'specbody';
      const why = doc.createElement('p');
      why.className = 'specwhy';
      block.append(caption, body, why);
      host.appendChild(block);
    }
    const shouldFollow = previous === null ? host.firstChild : previous.nextSibling;
    if (shouldFollow !== block) host.insertBefore(block, shouldFollow);
    previous = block;

    setText(block.querySelector('.speccap'), specimen.caption);
    setRuns(doc, block.querySelector('.specwhy'), specimen.why);

    const body = block.querySelector('.specbody');
    if (body === null) continue;
    let card = body.querySelector('[data-card]');
    if (card === null) {
      card = buildCard(doc, specimen.card);
      card.setAttribute('data-specimen', '1');
      body.appendChild(card);
    } else {
      updateCard(doc, card, specimen.card);
    }
  }
}

/**
 * @param {Document} doc
 * @param {BoardView} view
 * @param {{ added: number, updated: number, removed: number, pool: Map<string, Element>,
 *           seen: Set<string>, stale: Element[] }} tally
 */
function renderOffBoard(doc, view, tally) {
  const section = doc.getElementById('offboard-section');
  const host = doc.getElementById('offboard');
  if (host === null) return;
  if (section !== null) section.hidden = view.offBoard.count === 0;

  setText(
    doc.getElementById('offboard-count'),
    `${String(view.offBoard.ticketCount)} unplaced ${
      view.offBoard.ticketCount === 1 ? 'Ticket' : 'Tickets'
    }, ${String(view.offBoard.linkCount)} ${view.offBoard.linkCount === 1 ? 'file' : 'files'}`,
  );
  setText(doc.getElementById('offboard-note'), view.offBoard.note);

  renderGroups(doc, host, view.offBoard.groups, tally);
}

/**
 * @param {Document} doc
 * @param {BoardView} view
 */
function renderNotices(doc, view) {
  const host = doc.getElementById('notices');
  if (host === null) return;
  // A printable, injective comparison key: the notices are data, and JSON is exactly a
  // reversible rendering of them. A hand-rolled separator here was where two control
  // characters got into this file in the first place.
  const wanted = JSON.stringify(view.notices);
  if (host.getAttribute('data-shown') === wanted) return;
  host.setAttribute('data-shown', wanted);
  host.replaceChildren();
  for (const notice of view.notices) {
    const item = doc.createElement('li');
    item.className = 'notice';
    const kind = doc.createElement('span');
    kind.className = 'kind';
    kind.textContent = notice.kind;
    const message = doc.createElement('span');
    message.textContent = notice.message;
    item.append(kind, message);
    host.appendChild(item);
  }
}

// ---------------------------------------------------------------------------

/**
 * Write a run of emphasised and plain text into a node.
 *
 * Runs rather than markup because the emphasis matters and this file may not build a node
 * from a string. The signature check keeps a static hint from churning on every frame.
 *
 * @param {Document} doc
 * @param {Element|null} node
 * @param {Run[]} runs
 */
function setRuns(doc, node, runs) {
  if (node === null) return;
  const signature = JSON.stringify(runs);
  if (node.getAttribute('data-sig') === signature) return;
  node.setAttribute('data-sig', signature);
  node.replaceChildren();
  for (const run of runs) {
    if (run.em === true) {
      const strong = doc.createElement('b');
      strong.textContent = run.text;
      node.appendChild(strong);
      continue;
    }
    if (run.count === true) {
      const value = doc.createElement('span');
      value.className = 'cnt n';
      value.textContent = run.text;
      node.appendChild(value);
      continue;
    }
    const plain = doc.createElement('span');
    plain.textContent = run.text;
    node.appendChild(plain);
  }
}

function setText(node, text) {
  if (node === null || node.textContent === text) return false;
  node.textContent = text;
  return true;
}

function setAttr(node, name, value) {
  if (node === null || node.getAttribute(name) === value) return false;
  node.setAttribute(name, value);
  return true;
}

function setFlag(node, name, on) {
  if (node === null) return false;
  const has = node.hasAttribute(name);
  if (has === on) return false;
  if (on) node.setAttribute(name, '1');
  else node.removeAttribute(name);
  return true;
}

/** @param {number} accent */
function accentSlot(accent) {
  return String((((accent - 1) % FEATURE_ACCENTS) + FEATURE_ACCENTS) % FEATURE_ACCENTS + 1);
}

/**
 * Index nodes by an attribute value.
 *
 * Replaces a per-item selector lookup, which was quadratic over the card list and - worse -
 * required building a selector out of a Root path and a file name. Those are strings from
 * somebody else's repository, and a selector is a parsed language: escaping it correctly for
 * every legal POSIX name, control characters included, is a problem worth not having. Reading
 * the attribute back never parses anything.
 */
function indexBy(nodes, attribute) {
  const found = new Map();
  for (const node of nodes) {
    const key = node.getAttribute(attribute);
    if (key !== null && !found.has(key)) found.set(key, node);
  }
  return found;
}
