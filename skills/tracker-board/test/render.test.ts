/**
 * The renderer, run end to end against the fake DOM in `dom.ts`.
 *
 * Scope, stated so it is not mistaken for more: this file asks only what a fake DOM can answer
 * honestly - which nodes a completed render pass built, what text they carry, and in what order.
 * Focus surviving a Lane move, the just-changed tint restarting, and anything decided by the
 * cascade stay where `view.test.ts` puts them, which is a real browser.
 *
 * ## The canary rule, and why an empty state needs one
 *
 * The assertions here are about a *drawn absence*: a labelled sub-lane holding no cards still
 * draws its heading, its glyph, its zero and its note. That is the one assertion shape a total
 * rendering collapse satisfies for free - a pass that threw half way through and was swallowed
 * upstream leaves exactly the same "no cards here" the passing case does.
 *
 * So every test below asserts, in the same render, something only a completed pass can produce:
 * the populated sub-lane beside it still carries its cards, its count still reads right, and its
 * Feature group still rendered. If the pass did not finish, the canary loses its cards and the
 * test dies. This was bought on this project: a mutation once survived because "the rule ran and
 * correctly degraded" was indistinguishable from "the whole pass collapsed and nothing ran".
 *
 * The harness itself gets the same treatment. A fake DOM that answers `null` to everything makes
 * every absence assertion pass forever, so it is put through positive controls first.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { deriveSnapshot } from '../core/index.ts';
import type { Snapshot } from '../core/types.ts';
import { readTree } from '../scan/readTree.ts';
import { render } from '../ui/render.js';
import { buildView } from '../ui/view.js';
import { FakeElement, MOUNT_IDS, PANEL_MOUNT_IDS, boardDocument } from './dom.ts';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'tracker-board-home-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const EMPTY = { schemaVersion: 1, entries: [] };
const UI_DIR = join(import.meta.dirname, '..', 'ui');

/**
 * One Ticket in progress and one queued behind it. Nothing is `ready-for-human`, so no chain
 * terminates at a person and the Frozen sub-lane comes out empty while its neighbour does not -
 * which is exactly the board state the reader must still be told about.
 */
const NO_FROZEN: Readonly<Record<string, string>> = {
  'alpha/issues/03-moving.md': '# 03 - Moving\n\n- [x] one\n- [ ] two\n',
  'alpha/issues/05-blocked.md': '# 05 - Blocked\n\n**Blocked by:** 03\n\n- [ ] one\n',
};

// ---------------------------------------------------------------------------
// The harness, before anything trusts it
// ---------------------------------------------------------------------------

test('the fake DOM answers the selector forms the renderer uses, and refuses the ones it cannot', () => {
  const doc = boardDocument();
  const host = doc.createElement('div');
  host.className = 'host';
  const tag = doc.createElement('span');
  tag.className = 'stag wide';
  const glyph = doc.createElement('span');
  glyph.className = 'g';
  const deep = doc.createElement('div');
  const buried = doc.createElement('span');
  buried.className = 'g';
  deep.appendChild(buried);
  tag.append(glyph, deep);
  const marked = doc.createElement('p');
  const syntheticDrivePath = ['C:', '/', 'a/repo'].join('');
  marked.setAttribute('data-card', `12#${syntheticDrivePath}#alpha/issues/01 [draft].md`);
  host.append(tag, marked);

  // A class among several, which is how nearly every node in the renderer is built.
  assert.equal(host.querySelector('.stag'), tag, 'a multi-class element is not found by one class');
  assert.equal(host.querySelector('.wide'), tag);
  assert.equal(host.querySelector('.nosuch'), null);

  // Attribute presence, whose value is a path out of somebody else's repository.
  assert.equal(host.querySelector('[data-card]'), marked);
  assert.equal(host.querySelectorAll('[data-card]').length, 1);

  // The descendant combinator, and it really has to reach past an intervening element.
  assert.deepEqual(host.querySelectorAll('.stag .g'), [glyph, buried], 'the descendant combinator is not document-ordered or does not nest');
  assert.equal(tag.querySelector('.g'), glyph);

  // querySelectorAll is descendants only: an element never matches itself.
  assert.equal(tag.querySelectorAll('.stag').length, 0, 'the harness matched the element it was called on');

  // The failure that matters. An unimplemented selector must be loud, because a silent empty
  // answer satisfies every assertion about an absent node, on every file, forever.
  assert.throws(() => host.querySelector('div > .g'), /does not implement/);
  assert.throws(() => host.querySelector('.a[data-x="1"]'), /does not implement/);
});

test('an id, a type and a compound selector answer, and a miss is null rather than a throw', () => {
  // The other half of the rule above, and the half the harness got wrong. `#board [data-card]`
  // is the selector `ui/board.js` uses to find the card it must give focus back to, and
  // `.corrrows li` is the shape of the corrections panel's own rows - both were *errors* here,
  // not misses, so a test written against the real DOM died on the harness for a reason that
  // had nothing to do with the code it was testing. Three panel test files worked around it
  // privately rather than reporting it.
  const doc = boardDocument();
  const board = doc.getElementById('board');
  assert.ok(board !== null);
  const card = doc.createElement('div');
  card.setAttribute('data-card', 'on-board');
  board.appendChild(card);

  const list = doc.createElement('ul');
  list.className = 'corrrows';
  const row = doc.createElement('li');
  row.className = 'corrrow';
  list.appendChild(row);
  board.appendChild(list);

  // Id, and the descendant combinator reaching through it - the real selector, spelled the way
  // the real caller spells it.
  assert.deepEqual(doc.querySelectorAll('#board [data-card]'), [card]);
  assert.equal(doc.querySelector('#board'), board);
  assert.equal(doc.querySelector('#offboard [data-card]'), null, 'an id that matches nothing under it is a miss');
  assert.equal(doc.querySelector('#nosuchmount'), null, 'an id no element carries is a miss, not an error');

  // Type, case-insensitively, because `tagName` is upper case in a real HTML document.
  assert.deepEqual(list.querySelectorAll('li'), [row]);
  assert.deepEqual(list.querySelectorAll('LI'), [row]);
  assert.deepEqual(doc.querySelectorAll('.corrrows li'), [row]);
  assert.equal(doc.querySelector('.corrrows td'), null, 'a type nothing carries is a miss, not an error');

  // Compound: every simple selector holding on the same element.
  assert.equal(doc.querySelector('li.corrrow'), row);
  assert.equal(doc.querySelector('ul.corrrows'), list);
  assert.equal(doc.querySelector('li.nosuch'), null, 'a compound whose halves match different elements matched');
  assert.equal(doc.querySelector('div[data-card]'), card);

  // A selector list: one entry per element, in document order, never once per alternative it
  // satisfies. Both halves of the real selector are exercised, and the second one really is
  // reached - an off-board card is what `moveTo` is for.
  const offboard = doc.getElementById('offboard');
  assert.ok(offboard !== null);
  const stray = doc.createElement('div');
  stray.setAttribute('data-card', 'off-board');
  offboard.appendChild(stray);
  assert.deepEqual(
    doc.querySelectorAll('#board [data-card], #offboard [data-card]').map((node) => node.getAttribute('data-card')),
    ['on-board', 'off-board'],
    'the selector list is not document-ordered, or dropped one of its alternatives',
  );
  assert.deepEqual(
    doc.querySelectorAll('[data-card], div[data-card]').map((node) => node.getAttribute('data-card')),
    ['on-board', 'off-board'],
    'an element satisfying two alternatives was returned twice',
  );

  // An attribute name is matched the way an HTML document matches it, which is lower-cased.
  // Parsing `[DATA-CARD]` and then missing would be this harness answering `null` where a real
  // browser answers a node - the exact direction it must never be wrong in.
  assert.equal(doc.querySelectorAll('[DATA-CARD]').length, 2);
  // A class and an id are NOT case-folded, because a standards-mode document does not fold them.
  assert.equal(doc.querySelector('.CORRROWS'), null);
  assert.equal(doc.querySelector('#BOARD'), null);

  // The document's own query includes the root; an element's query never includes itself. That
  // is the real difference between the two: `document.querySelector('body')` answers the body.
  assert.equal(doc.querySelector('body'), doc.root, 'the document cannot find its own root');
  assert.equal(doc.root.querySelector('body'), null, 'an element matched the element it was called on');

  // And the throw survives all of it. These are the forms this harness still cannot answer, and
  // a silent empty answer for any of them makes every absence assertion pass forever.
  for (const selector of ['div > .g', '.a[data-x="1"]', 'li:first-child', '*', '#a + #b', '.a, , .b', '']) {
    assert.throws(() => doc.querySelector(selector), /fake DOM/, `\`${selector}\` answered instead of throwing`);
  }

  // A type selector out of place is refused rather than answered. `[data-card]div` matches here
  // and is rejected by every browser; `div[data-card]span` compiles and quietly matches nothing,
  // which is the shape that makes an absence assertion pass forever.
  for (const selector of ['[data-card]div', 'div[data-card]span', 'li[data-card]ul']) {
    assert.throws(
      () => doc.querySelector(selector),
      /fake DOM/,
      `\`${selector}\` was accepted, so a malformed compound answers instead of complaining`,
    );
  }
  // The legal placement still works, so the rule above rejects misplacement rather than types.
  assert.equal(doc.querySelector('ul.corrrows li'), row);
});

test('boardDocument mounts what a panel renders into, not only what the renderer reads', () => {
  // The trap this closes: the one helper named for building a board document could not build a
  // document any of the three panels could render into, so each panel test appended its own
  // mount - and appending a second `#corrections-panel` to a document that has one is silently
  // wrong, because `getElementById` answers with the first.
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  const doc = boardDocument();
  for (const id of PANEL_MOUNT_IDS) {
    const mount = doc.getElementById(id);
    assert.ok(mount !== null, `boardDocument does not mount #${id}, so no panel can be drawn into it`);
    assert.equal(mount.tagName, 'section');
    assert.equal(mount.className, 'section panelmount', `#${id} is not the mount ui/index.html ships`);
    assert.ok(html.includes(`id="${id}"`), `the fake DOM mounts #${id}, which ui/index.html does not declare`);
    assert.equal(doc.querySelectorAll(`#${id}`).length, 1, `#${id} is mounted more than once`);
  }

  // Held apart from the renderer's own list on purpose: folding these in would weaken the check
  // that every id `ui/render.js` reads is a mount, which is a different guard for a different file.
  for (const id of PANEL_MOUNT_IDS) {
    assert.ok(!MOUNT_IDS.includes(id as never), `#${id} was folded into the renderer's mount list`);
  }

  // And a delegated listener can be registered, which is not decoration either. The panels
  // install one handler per document rather than one per node, and `ui/domain.js` calls
  // `addEventListener` unconditionally - so against a document without one it threw, landed in
  // its own catch and drew its *failure* notice. A panel test written on that document would
  // have read as a test about content while asserting against a crash.
  const handler = (): void => undefined;
  doc.addEventListener('click', handler);
  assert.deepEqual(doc.delegated.get('click'), [handler], 'the harness discards the handlers it is given');
});

test('the fake DOM moves, detaches and reads back text the way the renderer assumes', () => {
  const doc = boardDocument();
  const list = doc.createElement('div');
  const [a, b, c] = ['a', 'b', 'c'].map((name) => {
    const node = doc.createElement('p');
    node.className = name;
    return node;
  });
  assert.ok(a !== undefined && b !== undefined && c !== undefined);
  list.append(a, b, c);
  assert.deepEqual(list.childNodes, [a, b, c]);
  assert.equal(list.firstChild, a);
  assert.equal(list.lastChild, c);
  assert.equal(a.nextSibling, b);

  // Reordering within the same parent. The renderer does this on every frame, and an index
  // taken before the node was detached would splice it one place wrong.
  list.insertBefore(c, a);
  assert.deepEqual(list.childNodes, [c, a, b], 'a node moved within its own list landed wrong');
  list.insertBefore(c, null);
  assert.deepEqual(list.childNodes, [a, b, c]);

  // A move between parents takes the same node, which is the whole reason the renderer pools.
  const other = doc.createElement('div');
  other.appendChild(b);
  assert.deepEqual(list.childNodes, [a, c]);
  assert.equal(other.firstChild, b);
  assert.equal(b.parentNode, other);

  assert.throws(() => list.insertBefore(a, b), /not a child/);

  // Text reads back through nesting, because `setText` compares before it writes.
  const outer = doc.createElement('p');
  const inner = doc.createElement('b');
  inner.textContent = 'deep';
  outer.textContent = 'flat';
  outer.appendChild(inner);
  assert.equal(outer.textContent, 'flatdeep');
  outer.textContent = 'replaced';
  assert.equal(outer.textContent, 'replaced');
  assert.equal(inner.parentNode, null, 'setting textContent left an orphaned child attached');
  outer.textContent = '';
  assert.equal(outer.childNodes.length, 0);

  a.remove();
  assert.deepEqual(list.childNodes, [c]);
  list.replaceChildren();
  assert.deepEqual(list.childNodes, []);
});

test('every id the renderer reads is a mount the shipped document declares and the harness provides', () => {
  // The silent failure this closes: `getElementById` answering null makes the renderer skip a
  // whole section without complaint, and a test asserting an absence then passes for free.
  const js = readFileSync(join(UI_DIR, 'render.js'), 'utf8');
  const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  const read = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1] ?? '');
  assert.ok(read.length >= 8, 'no getElementById call was found, so this checked nothing');

  const doc = boardDocument();
  for (const id of read) {
    assert.ok(MOUNT_IDS.includes(id as never), `ui/render.js reads #${id}, which the fake DOM never mounts`);
  }
  for (const id of MOUNT_IDS) {
    assert.ok(html.includes(`id="${id}"`), `the fake DOM mounts #${id}, which ui/index.html does not declare`);
    assert.notEqual(doc.getElementById(id), null, `boardDocument does not actually mount #${id}`);
  }
});

// ---------------------------------------------------------------------------
// A labelled sub-lane at zero
// ---------------------------------------------------------------------------

test('an empty labelled sub-lane draws its heading, its glyph, its zero and its note', (t) => {
  // "Frozen on you" and "Queued for an agent" are opposite instructions - one says nothing moves
  // until you act, the other says somebody else is already on it. Drawing only whichever happens
  // to be populated leaves a reader who never learns the column was split, and who reads the
  // survivor as the whole of Blocked.
  const view = buildView(snapshotOf(tempTracker(t, NO_FROZEN)));

  const column = view.columns[0];
  assert.ok(column !== undefined && column.key === 'blocked');
  assert.equal(column.sublanes[0]?.count, 0, 'the fixture stopped producing an empty Frozen sub-lane');
  assert.equal(column.sublanes[1]?.count, 1, 'the fixture stopped producing a populated neighbour');

  const doc = boardDocument();
  const tally = render(doc as never, view);

  const blocked = columnNode(doc.getElementById('board'), 'blocked');
  assert.equal(blocked.querySelector('.col-body')?.getAttribute('data-mode'), 'lanes');

  // `.lane`, not `[data-lane]`: every card carries a `data-lane` of its own, so the attribute
  // selector answers with the sub-lane blocks *and* their contents.
  const lanes = blocked.querySelectorAll('.lane');
  assert.deepEqual(
    lanes.map((lane) => lane.getAttribute('data-lane')),
    ['frozen', 'blocked'],
    'the empty Frozen sub-lane was not drawn, so the split is invisible whenever it is empty',
  );

  const [frozen, queued] = lanes;
  assert.ok(frozen !== undefined && queued !== undefined);

  // The empty half: everything a reader needs to learn the Lane exists.
  const heading = frozen.querySelector('.sublane');
  assert.ok(heading !== null && heading.hidden === false, 'the empty sub-lane heading is hidden');
  assert.equal(heading.querySelector('.sl')?.textContent, 'Frozen on you');
  assert.equal(heading.querySelector('.sn')?.textContent, '0');
  assert.ok((heading.querySelector('.sg')?.textContent ?? '').length > 0, 'the empty sub-lane drew no glyph');

  const note = frozen.querySelector('.sublane-note');
  assert.ok(note !== null && note.hidden === false, 'the empty sub-lane dropped the note saying who can clear it');
  assert.match(note.textContent, /ends at a person/);

  // And it reads as deliberately empty rather than as a heading whose body failed to render.
  const marker = frozen.querySelector('.laneempty');
  assert.ok(marker !== null && marker.hidden === false, 'a bare zero was drawn with nothing under it');
  assert.equal(marker.textContent, 'none');
  assert.equal(frozen.getAttribute('data-empty'), '1');
  assert.equal(frozen.querySelectorAll('[data-card]').length, 0);

  // The canary, in the same render. A collapsed pass gives the empty half above for free; it
  // cannot give this. If the pass did not finish, the promotion is gone and this test dies.
  assert.equal(queued.getAttribute('data-empty'), null, 'the populated sub-lane was marked empty');
  assert.equal(queued.querySelector('.sublane .sn')?.textContent, '1');
  assert.equal(queued.querySelector('.sl')?.textContent, 'Queued for an agent');
  assert.equal(queued.querySelector('.laneempty')?.hidden, true, 'the populated sub-lane drew an empty marker');
  assert.equal(queued.querySelectorAll('[data-group]').length, 1, 'the populated sub-lane rendered no Feature group');
  assert.equal(queued.querySelector('.gcount')?.textContent, '1');

  const cards = queued.querySelectorAll('[data-card]');
  assert.equal(cards.length, 1, 'the populated sub-lane came out empty too, so nothing here proves anything');
  assert.match(cards[0]?.querySelector('.card-title')?.textContent ?? '', /Blocked/);
  assert.ok(tally.added > 0, 'the render reported building no cards at all');
});

test('an unlabelled sub-lane at zero is skipped, and its populated neighbour is not', (t) => {
  // The other half of the rule, and the reason it is not simply "always draw". A single-Lane
  // column has no sub-lane heading to hang the zero on, so drawing it would put an anonymous
  // empty block on the board - and a second empty state besides, since a column whose total is
  // zero is handed to the column-level empty box and never reaches this code at all.
  //
  // This case is built by hand because the view model cannot produce it: a column total is the
  // sum of its sub-lanes, so an unlabelled sub-lane at zero always means a column at zero. That
  // invariant belongs to the view model, not the renderer's contract - the same reason
  // `board-ui.test.ts` tests `findCard` against an empty key.
  const view = buildView(snapshotOf(tempTracker(t, NO_FROZEN)));
  const column = view.columns[0];
  assert.ok(column !== undefined);
  for (const sublane of column.sublanes) sublane.labelled = false;

  const doc = boardDocument();
  render(doc as never, view);

  const blocked = columnNode(doc.getElementById('board'), 'blocked');
  assert.deepEqual(
    blocked.querySelectorAll('.lane').map((lane) => lane.getAttribute('data-lane')),
    ['blocked'],
    'an unlabelled empty sub-lane was drawn as an anonymous empty block',
  );

  // The canary again: the neighbour that is not empty still rendered its card, so "one lane" is
  // the rule at work rather than the pass falling over before it drew the second.
  assert.equal(blocked.querySelectorAll('[data-card]').length, 1, 'the surviving sub-lane lost its card');
  assert.equal(blocked.querySelector('.sublane')?.hidden, true, 'an unlabelled sub-lane drew a heading');
});

// ---------------------------------------------------------------------------

function columnNode(board: FakeElement | null, key: string): FakeElement {
  assert.ok(board !== null, 'the board mount is missing, so nothing was rendered');
  const found = board.querySelectorAll('[data-col]').find((node) => node.getAttribute('data-col') === key);
  assert.ok(found !== undefined, `the board drew no ${key} column`);
  return found;
}

function snapshotOf(root: string): Snapshot {
  return deriveSnapshot({ roots: [readTree(root)] }, EMPTY);
}

/** A tracker tree under `os.tmpdir()`, removed afterwards. */
function tempTracker(t: { after(fn: () => void): void }, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'tracker-board-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.scratch'), { recursive: true });
  for (const [relPath, text] of Object.entries(files)) {
    const abs = join(root, '.scratch', ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}
