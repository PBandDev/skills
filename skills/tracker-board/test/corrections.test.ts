/**
 * The AI-corrected marker, its per-column filter, and the accessibility parity contract.
 *
 * ## What this file is allowed to prove
 *
 * The fake DOM in `dom.ts` models element construction and tree order, and that is the whole of
 * its competence. Everything below is a question about the markup a completed render pass
 * emitted: which nodes exist, what attributes they carry, and which of them a reader of either
 * kind can reach. Nothing here asks the cascade a question - the underline is a browser fact and
 * is measured in a browser, not here.
 *
 * That is deliberate rather than a limitation. The parity contract is a **structural property of
 * the emitted markup**, and checking it structurally makes it mechanically verifiable.
 *
 * ## The canary rule
 *
 * Half of the parity criteria are assertions of *absence*: a collapsed card is not in the
 * accessibility tree, an uncorrected card carries no mark, a board with no Overrides says so. A
 * render pass that collapsed entirely produces every one of those for free.
 *
 * So every test asserting an absence also asserts, in the same pass, something only a completed
 * pass can produce - a marked card beside the unmarked one, an opened ledger beside the closed
 * ones, a populated count beside the zero. If the pass did not finish, the canary dies and the
 * test with it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveSnapshot } from '../core/index.ts';
import type { AnnotationEntry, AnnotationStore, Scan, Snapshot } from '../core/types.ts';
import { render } from '../ui/render.js';
import { buildView, columnOrder } from '../ui/view.js';
import { COLUMN_LANES, renderCorrections, toggleFilter } from '../ui/corrections.js';
import { FakeElement, boardDocument, descendants } from './dom.ts';

// Redirect both home variables before any test runs so an imported state path cannot resolve to
// the maintainer's real state directory. Nothing in this file should touch that directory.
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'tracker-board-corrections-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const ROOT = '/repo';
const EMPTY: AnnotationStore = { schemaVersion: 1, entries: [] };

/** How many Tickets the synthetic board holds. The dense case is 36 of these. */
const CORPUS = 52;

// ---------------------------------------------------------------------------
// A synthetic board, because this repository has essentially no corrections
// ---------------------------------------------------------------------------

/**
 * One Ticket file, shaped to land in a chosen Lane.
 *
 * The Lane is decided by the ladder rather than stated, so these are real Tickets rather than
 * a table of Lane names: checkboxes are truth for a task Ticket, `Status:` may only park or
 * hand to a person, and a `Blocked by:` naming an unfinished Ticket blocks.
 */
function ticketText(number: number, lane: string): string {
  const head = `# ${String(number)} - Ticket ${String(number)}\n\n`;
  switch (lane) {
    case 'complete':
      return `${head}- [x] one\n- [x] two\n`;
    case 'needs-you':
      return `${head}**Status:** ready-for-human\n\n- [x] one\n- [x] two\n`;
    case 'in-progress':
      return `${head}- [x] one\n- [ ] two\n`;
    case 'blocked':
      return `${head}**Blocked by:** 37\n\n- [ ] one\n- [ ] two\n`;
    case 'parked':
      return `${head}**Status:** wontfix\n\n- [ ] one\n- [ ] two\n`;
    default:
      return `${head}- [ ] one\n- [ ] two\n`;
  }
}

/**
 * The Lane each of the 52 Tickets is built for.
 *
 * Spread across every column on purpose: a per-column control that was only ever exercised in
 * one column would not have been exercised at all.
 */
function laneFor(number: number): string {
  if (number <= 20) return 'complete';
  if (number <= 28) return 'needs-you';
  if (number <= 36) return 'in-progress';
  if (number <= 44) return 'agent';
  if (number <= 50) return 'blocked';
  return 'parked';
}

/** Two Features, so the collapsed Done column draws more than one row to open. */
function featureFor(number: number): string {
  return number % 2 === 0 ? 'alpha' : 'beta';
}

function corpusScan(): Scan {
  const files = [];
  for (let number = 1; number <= CORPUS; number += 1) {
    const padded = String(number).padStart(2, '0');
    const path = `${featureFor(number)}/issues/${padded}-t.md`;
    files.push({
      path,
      absPath: `${ROOT}/.scratch/${path}`,
      text: ticketText(number, laneFor(number)),
    });
  }
  return {
    roots: [
      {
        path: ROOT,
        label: 'repo',
        trackerPath: `${ROOT}/.scratch`,
        files,
        hiddenWorktrees: 0,
        tracker: 'local-markdown' as const,
        adrFiles: [],
        glossaryFile: null,
      },
    ],
  };
}

const SCAN = corpusScan();

/** The ids of every Ticket the Snapshot says an Override changed a field on. */
function correctedIds(snapshot: Snapshot): Set<string> {
  return new Set(
    snapshot.roots
      .flatMap((root) => root.features)
      .flatMap((feature) => feature.tickets)
      .filter((ticket) => ticket.derivation.correctedFields.length > 0)
      .map((ticket) => ticket.id),
  );
}

/**
 * The corpus with one file's text replaced, corrected at the same load, so a card can be made to
 * change Lane - or to lose one entirely and move below the board - while the filter is pressed.
 */
function withText(path: string, text: string, count: number): Snapshot {
  const root = SCAN.roots[0];
  assert.ok(root !== undefined);
  assert.ok(root.files.some((file) => file.path === path), `no such fixture: ${path}`);
  const scan: Scan = {
    roots: [{ ...root, files: root.files.map((file) => (file.path === path ? { ...file, text } : file)) }],
  };
  return correctedSnapshot(count, scan);
}

/** Every card id on the synthetic board, in Snapshot order. */
function cardIds(snapshot: Snapshot): string[] {
  const out: string[] = [];
  for (const root of snapshot.roots) {
    for (const feature of root.features) {
      for (const ticket of feature.tickets) out.push(ticket.id);
    }
  }
  return out;
}

/**
 * An Override that disagrees with the parser on exactly one field, for `count` of the Tickets.
 *
 * The corrected field is the title, which the ladder never reads - so a correction cannot move
 * a card between Lanes and the per-Lane counts stay a property of the corpus rather than of how
 * many Overrides were applied.
 */
function correctedSnapshot(count: number, scan: Scan = SCAN): Snapshot {
  const probe = deriveSnapshot(scan, EMPTY);
  const tickets = probe.roots.flatMap((root) => root.features).flatMap((feature) => feature.tickets);

  // Spread evenly across the corpus rather than taken from the front. Correcting a prefix would
  // leave whole Features and whole Lanes untouched, and every "and this one is not marked"
  // assertion below would then be about a Feature the fixture never reached rather than about
  // the marker - which is also how the real case behaves, since a parser bug hits across a
  // board rather than down one Feature.
  const wanted = new Set<number>();
  for (let step = 0; step < count; step += 1) {
    wanted.add(Math.floor((step * tickets.length) / count));
  }

  const entries: AnnotationEntry[] = [];
  for (const [index, ticket] of tickets.entries()) {
    if (!wanted.has(index)) continue;
    entries.push({
      schemaVersion: 1,
      filePath: ticket.id,
      contentSha: ticket.contentSha ?? '',
      extraction: { title: `${ticket.extraction.title} (corrected)` },
    });
  }
  return deriveSnapshot(scan, { schemaVersion: 1, entries });
}

// ---------------------------------------------------------------------------
// Driving the board
// ---------------------------------------------------------------------------

interface Drawn {
  readonly doc: ReturnType<typeof boardDocument>;
  readonly board: FakeElement;
  readonly panel: FakeElement;
}

/**
 * A board document with this panel's mount on it, drawn once.
 *
 * The mount comes from `boardDocument()` rather than being appended here. Appending a *second*
 * `#corrections-panel` to a document that already has one is a silent trap: `getElementById`
 * answers with the first, so the panel would draw into the harness's mount while every assertion
 * below read the local one and saw an empty node.
 */
function draw(
  snapshot: Snapshot | null,
  doneMode: 'collapsed' | 'cards' = 'cards',
  openFeatures: Record<string, boolean> = {},
): Drawn {
  const doc = boardDocument();
  const panel = mountOf(doc);

  const view = buildView(snapshot, { doneMode, openFeatures });
  render(doc as never, view);
  renderCorrections(doc as never, view, snapshot);

  const board = doc.getElementById('board');
  assert.ok(board !== null, 'the board mount is gone, so nothing below is about a drawn board');
  return { doc, board, panel };
}

/** Draw again into the same document, the way a file change does. */
function redraw(
  drawn: Drawn,
  snapshot: Snapshot | null,
  doneMode: 'collapsed' | 'cards' = 'cards',
  openFeatures: Record<string, boolean> = {},
): void {
  const view = buildView(snapshot, { doneMode, openFeatures });
  render(drawn.doc as never, view);
  renderCorrections(drawn.doc as never, view, snapshot);
}

/** This panel's mount, asserted present rather than assumed - an absent one draws nothing. */
function mountOf(doc: ReturnType<typeof boardDocument>): FakeElement {
  const panel = doc.getElementById('corrections-panel');
  assert.ok(panel !== null, 'the harness document carries no corrections mount to draw into');
  return panel;
}

function columnOf(board: FakeElement, key: string): FakeElement {
  for (const column of board.querySelectorAll('[data-col]')) {
    if (column.getAttribute('data-col') === key) return column;
  }
  throw new Error(`the board drew no ${key} column`);
}

function filterButton(board: FakeElement, key: string): FakeElement | null {
  return columnOf(board, key).querySelector('[data-corrections-filter]');
}

/** Every element carrying a correction mark, anywhere under `root`. */
function marked(root: FakeElement): FakeElement[] {
  return descendants(root).filter((node) => node.getAttribute('data-corrected') !== null);
}

/**
 * The canary, as one call.
 *
 * Every absence asserted in this file needs something in the SAME pass that only a completed
 * `renderCorrections` could have produced - and the board's own cards are not that, because
 * `render.js` draws them before this panel runs at all. If this panel throws after `markCards`,
 * the card count still comes out right while every "nothing is marked" assertion passes. The
 * panel's lead line is written last, by this module, from the projected Snapshot, so it is the
 * one thing that cannot survive a pass that stopped early.
 */
function assertPanelCompleted(drawn: Drawn, total: number, cards: number): void {
  assert.equal(
    drawn.panel.querySelector('.corrfail'),
    null,
    'the panel reported a failure, so nothing else in this test is about a completed pass',
  );
  const lead = drawn.panel.querySelector('.corrlead');
  assert.ok(lead !== null, 'the panel drew no lead line, so this pass did not complete');
  assert.equal(
    lead.textContent,
    total === 0
      ? 'No Override has changed a field on this board.'
      : `${String(total)} of ${String(cards)} Tickets carry an Override that disagreed with the ` +
        'file, on the fields named below.',
    'the panel finished with a lead line that does not describe this Snapshot',
  );
}

/**
 * The collapsed Done column with its first Feature opened.
 *
 * Read out of the drawn document rather than out of the view model: the key the disclosure
 * carries is the key the reader's click sends back, so taking it from anywhere else would be
 * asserting against a name nothing on the page uses.
 */
function withOpenRow(snapshot: Snapshot): Drawn {
  const drawn = draw(snapshot, 'collapsed');
  const first = columnOf(drawn.board, 'done').querySelector('[data-digrow]');
  assert.ok(first !== null, 'the collapsed Done column drew no row to open');
  const key = first.getAttribute('data-digrow');
  assert.ok(key !== null && key !== '');
  redraw(drawn, snapshot, 'collapsed', { [key]: true });
  return drawn;
}

// ---------------------------------------------------------------------------
// The corpus itself, before anything is asserted about how it draws
// ---------------------------------------------------------------------------

test('the synthetic board holds 52 Tickets spread across every column', () => {
  const snapshot = deriveSnapshot(SCAN, EMPTY);
  assert.equal(snapshot.progress.total, CORPUS, 'the corpus is not the size this file claims');
  assert.deepEqual(
    { ...snapshot.counts },
    {
      complete: 20,
      'needs-you': 8,
      'in-progress': 8,
      agent: 8,
      blocked: 6,
      frozen: 0,
      parked: 2,
      unlaned: 0,
    },
    'the corpus no longer lands where the per-column assertions below assume',
  );
  assert.equal(snapshot.corrections.total, 0, 'a corpus with no Overrides already reports some');
});

test('the sparse and dense correction loads are both reachable', () => {
  assert.equal(correctedSnapshot(2).corrections.total, 2, 'the sparse steady state');
  assert.equal(correctedSnapshot(36).corrections.total, 36, 'the dense 36-of-52 case');
});

// ---------------------------------------------------------------------------
// The column map is a contract with ui/view.js
// ---------------------------------------------------------------------------

test('every column has a Lane list and every Lane has a column', () => {
  // The counts arrive per-Lane and the control is per-column, so this map is the join between
  // them. A column added or a Lane renamed would otherwise leave a count pointing at nothing,
  // silently, and the control would read zero on a column holding corrections.
  assert.deepEqual(Object.keys(COLUMN_LANES), columnOrder(), 'the column map and the board disagree');

  // The flat list, sorted - NOT a Set. Collapsing duplicates first is what makes a Lane listed
  // under two columns invisible here: the zero-`frozen` corpus keeps every count green while a
  // real corrected Frozen Ticket would be counted twice on the board. A Set can prove coverage,
  // but never exclusivity.
  const mapped = Object.values(COLUMN_LANES).flat().sort();
  const lanes = Object.keys(deriveSnapshot(SCAN, EMPTY).counts)
    .filter((key) => key !== 'unlaned')
    .sort();
  assert.deepEqual(mapped, lanes, 'a Lane is drawn by no column, or by two');
});

// ---------------------------------------------------------------------------
// Layer B - the mark on the ticket id
// ---------------------------------------------------------------------------

test('a corrected card is marked on its own ticket id, and an uncorrected one is not', () => {
  const snapshot = correctedSnapshot(2);
  const drawn = draw(snapshot);

  const ids = cardIds(snapshot);
  const corrected = correctedIds(snapshot);
  assert.equal(corrected.size, 2, 'the fixture no longer corrects two cards');

  let seenMarked = 0;
  let seenBare = 0;
  for (const node of drawn.board.querySelectorAll('[data-card]')) {
    const id = node.getAttribute('data-card') ?? '';
    const tid = node.querySelector('.tid');
    assert.ok(tid !== null, `card ${id} drew no ticket id at all`);
    if (corrected.has(id)) {
      assert.equal(tid.getAttribute('data-corrected'), '1', `card ${id} is corrected and unmarked`);
      seenMarked += 1;
    } else {
      assert.equal(tid.getAttribute('data-corrected'), null, `card ${id} is marked and is not corrected`);
      assert.equal(tid.getAttribute('aria-label'), null, `card ${id} is named and is not corrected`);
      seenBare += 1;
    }
  }

  // The canary. A render that collapsed leaves every card unmarked, which is exactly what the
  // negative half of this test asserts - so the positive half has to come out of the same pass.
  assert.ok(seenMarked > 0, 'no card was marked, so the negative assertions above proved nothing');
  assert.ok(seenBare > 0, 'every card was marked, so the positive assertions above proved nothing');
  assert.ok(ids.length > 0);
  assertPanelCompleted(drawn, 2, CORPUS);
});

test('the mark adds NO ELEMENT to the card: the id keeps the one text node the renderer gave it', () => {
  // Criterion B, literally. The mark is an attribute on the element that was already there, so a
  // correction arriving cannot move a card, and thirty-six marks cost exactly what one costs.
  // The paint lives in `board.css` (`.tid[data-corrected]`), which is the only stylesheet allowed
  // to reach a card - asserted there, in `board-ui.test.ts`, not here.
  const drawn = draw(correctedSnapshot(36));

  let markedSlots = 0;
  let bareSlots = 0;
  for (const node of drawn.board.querySelectorAll('[data-card]')) {
    const tid = node.querySelector('.tid');
    assert.ok(tid !== null);
    assert.equal(tid.childNodes.length, 1, 'the ticket id gained a node');
    assert.equal(
      descendants(tid).length,
      0,
      'an element was added inside the ticket id, which criterion B forbids',
    );
    if (tid.getAttribute('data-corrected') !== null) markedSlots += 1;
    else bareSlots += 1;
  }
  assert.ok(markedSlots > 0, 'nothing was marked, so "no element was added" proves nothing');
  assert.ok(bareSlots > 0, 'everything was marked, so there is nothing to compare against');
  assertPanelCompleted(drawn, 36, CORPUS);
});

test('the mark adds no visible text: the id still reads exactly as the renderer wrote it', () => {
  const bare = draw(deriveSnapshot(SCAN, EMPTY));
  const dense = draw(correctedSnapshot(36));

  const before = new Map<string, string>();
  for (const node of bare.board.querySelectorAll('[data-card]')) {
    before.set(node.getAttribute('data-card') ?? '', node.querySelector('.tid')?.textContent ?? '');
  }

  let checked = 0;
  let marks = 0;
  for (const node of dense.board.querySelectorAll('[data-card]')) {
    const id = node.getAttribute('data-card') ?? '';
    const tid = node.querySelector('.tid');
    assert.ok(tid !== null);
    assert.equal(tid.textContent, before.get(id), `card ${id} reads differently once marked`);
    checked += 1;
    if (tid.getAttribute('data-corrected') !== null) marks += 1;
  }
  assert.ok(checked > 0, 'no card was compared');
  assert.ok(marks > 0, 'nothing was marked, so equal text proves nothing');
});

test('marking is idempotent: four more frames change nothing about a mark', () => {
  // `renderCorrections` runs on every frame - several times a minute on a live board, and once
  // per file change while an agent works. Anything that accumulated here would be invisible to a
  // single-render test and obvious within ten seconds of watching a live board.
  const snapshot = correctedSnapshot(36);
  const drawn = draw(snapshot);
  const first = marked(drawn.board).map((slot) => ({
    slot,
    corrected: slot.getAttribute('data-corrected'),
    label: slot.getAttribute('aria-label'),
    children: slot.childNodes.length,
  }));
  assert.ok(first.length > 0, 'nothing was marked, so stability proves nothing');

  for (let frame = 0; frame < 4; frame += 1) redraw(drawn, snapshot);

  const after = marked(drawn.board);
  assert.equal(after.length, first.length, 'the mark count moved across frames');
  for (const [index, slot] of after.entries()) {
    const was = first[index];
    assert.ok(was !== undefined);
    assert.equal(slot, was.slot, 'the marked element is not the one that was marked');
    assert.equal(slot.getAttribute('data-corrected'), was.corrected);
    assert.equal(slot.getAttribute('aria-label'), was.label);
    assert.equal(slot.childNodes.length, was.children, 'a node accumulated inside the ticket id');
  }
  assertPanelCompleted(drawn, 36, CORPUS);
});

test('a card that stops being corrected loses its mark, its name and its role', () => {
  const snapshot = correctedSnapshot(36);
  const drawn = draw(snapshot);
  const before = marked(drawn.board);
  assert.ok(before.length > 0, 'nothing was marked, so unmarking proves nothing');
  const sample = before[0];
  assert.ok(sample !== undefined);
  const text = sample.textContent;

  redraw(drawn, deriveSnapshot(SCAN, EMPTY));

  assert.equal(marked(drawn.board).length, 0, 'a mark outlived the Override that put it there');
  for (const name of ['aria-label', 'role'] as const) {
    assert.equal(sample.getAttribute(name), null, `${name} outlived the correction`);
  }
  assert.equal(sample.textContent, text, 'unmarking changed the id the card prints');
  assert.equal(sample.childNodes.length, 1, 'the id is not a bare text node');

  // The canary, and it has to be this rather than the board's card count: `render.js` draws the
  // cards BEFORE this module runs, so a pass that threw after `markCards` would leave the count
  // right and every absence above green. The lead line is written by this module, last, from the
  // projected Snapshot.
  assertPanelCompleted(drawn, 0, CORPUS);
});

// ---------------------------------------------------------------------------
// Layer C - the per-column count, and the filter it drives
// ---------------------------------------------------------------------------

test('a column holding corrections gets a real button carrying its own count', () => {
  // Both loads, because they exercise opposite halves. At 36 of 52 every column holds some, so
  // the control has to be right everywhere; at 2 of 52 most hold none, so the control has to be
  // absent everywhere else. One load alone would leave the other half unasserted.
  let drawnControls = 0;
  let skipped = 0;

  for (const load of [36, 2]) {
    const snapshot = correctedSnapshot(load);
    const drawn = draw(snapshot);

    for (const key of Object.keys(COLUMN_LANES)) {
      const lanes = COLUMN_LANES[key as keyof typeof COLUMN_LANES];
      const expected = lanes.reduce(
        (total, lane) => total + (snapshot.corrections.byLane[lane as 'agent'] ?? 0),
        0,
      );
      const button = filterButton(drawn.board, key);
      if (expected === 0) {
        assert.equal(button, null, `the ${key} column holds no corrections and drew a filter anyway`);
        skipped += 1;
        continue;
      }
      const label = `${String(expected)} AI-corrected`;
      assert.ok(button !== null, `the ${key} column holds ${String(expected)} corrections and drew no filter`);
      assert.equal(button.tagName, 'button', 'the count is not a real button');
      assert.equal(button.type, 'button', 'the button would submit rather than act');
      assert.equal(button.getAttribute('aria-pressed'), 'false', 'the button carries no pressed state');
      assert.equal(button.textContent, label, `the ${key} count is wrong`);

      // The accessible name must OPEN with the visible text, verbatim. Otherwise, a name that
      // drops the count hands the sighted reader a number nobody else gets, which is the same
      // parity inversion one level up; and
      // a control whose name does not contain its visible label cannot be spoken to a voice
      // control, which reads what is on the screen.
      const name = button.getAttribute('aria-label') ?? '';
      assert.ok(name.startsWith(label), `the ${key} button's name drops its own visible label: ${name}`);
      assert.match(name, /\bin .+\. Show only these Tickets\.$/, 'the name does not say which column');
      drawnControls += 1;
    }
    assertPanelCompleted(drawn, load, CORPUS);
  }

  assert.ok(drawnControls > 0, 'no column drew a control, so the negative assertions proved nothing');
  assert.ok(skipped > 0, 'every column drew one, so the zero case was never exercised');
});

test('a column whose corrections all go away loses its control on the next frame', () => {
  const drawn = draw(correctedSnapshot(36));
  const before = Object.keys(COLUMN_LANES).filter((key) => filterButton(drawn.board, key) !== null);
  assert.ok(before.length >= 4, 'the dense load drew almost no controls, so losing them proves little');

  redraw(drawn, deriveSnapshot(SCAN, EMPTY));

  for (const key of Object.keys(COLUMN_LANES)) {
    assert.equal(filterButton(drawn.board, key), null, `the ${key} control outlived its corrections`);
  }
  assertPanelCompleted(drawn, 0, CORPUS);
});

test('the control sits in the column head, where the renderer never rebuilds it', () => {
  const snapshot = correctedSnapshot(36);
  const drawn = draw(snapshot);
  const button = filterButton(drawn.board, 'agent');
  assert.ok(button !== null);
  assert.ok(
    columnOf(drawn.board, 'agent').querySelector('.col-head [data-corrections-filter]') !== null,
    'the control is not inside the column head',
  );

  // Identity, not equality. `render.js` builds a column section once and patches it forever
  // after, so the very node the reader may have focused has to be the node still there.
  for (let frame = 0; frame < 3; frame += 1) redraw(drawn, snapshot);
  assert.equal(filterButton(drawn.board, 'agent'), button, 'the control was rebuilt by a later frame');
});

test('pressing a filter removes the uncorrected cards from the page, in that column only', () => {
  const snapshot = correctedSnapshot(36);
  const drawn = draw(snapshot);
  const button = filterButton(drawn.board, 'agent');
  assert.ok(button !== null);

  const untouched = columnOf(drawn.board, 'in-progress')
    .querySelectorAll('[data-card]')
    .filter((node) => node.hidden).length;
  assert.equal(untouched, 0, 'a card was already hidden before anything was pressed');

  toggleFilter(drawn.doc as never, button as never);

  assert.equal(button.getAttribute('aria-pressed'), 'true', 'the press did not record itself');
  let shown = 0;
  let gone = 0;
  for (const node of columnOf(drawn.board, 'agent').querySelectorAll('[data-card]')) {
    const isMarked = node.querySelector('.tid')?.getAttribute('data-corrected') !== null;
    if (node.hidden) {
      assert.equal(isMarked, false, 'a corrected card was hidden by its own filter');
      gone += 1;
    } else {
      assert.equal(isMarked, true, 'an uncorrected card survived the filter');
      shown += 1;
    }
  }
  assert.ok(shown > 0, 'the filter hid everything, so it is not a filter');
  assert.ok(gone > 0, 'the filter hid nothing, so it did not run');

  assert.equal(
    columnOf(drawn.board, 'in-progress').querySelectorAll('[data-card]').filter((node) => node.hidden).length,
    0,
    'pressing one column filtered another',
  );

  toggleFilter(drawn.doc as never, button as never);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(
    columnOf(drawn.board, 'agent').querySelectorAll('[data-card]').filter((node) => node.hidden).length,
    0,
    'releasing the filter left cards off the page',
  );
});

test('a pressed filter survives the next frame, and so does what it hid', () => {
  // The failure this exists for cannot be seen in a single render: a panel that rebuilt its
  // controls, or held its state in a module the next frame overwrote, unpresses under the
  // reader while a file changes.
  const snapshot = correctedSnapshot(36);
  const drawn = draw(snapshot);
  const button = filterButton(drawn.board, 'needs-you');
  assert.ok(button !== null);
  toggleFilter(drawn.doc as never, button as never);
  const hiddenAfterPress = columnOf(drawn.board, 'needs-you')
    .querySelectorAll('[data-card]')
    .filter((node) => node.hidden).length;
  assert.ok(hiddenAfterPress > 0, 'the press hid nothing, so surviving a frame proves nothing');

  for (let frame = 0; frame < 3; frame += 1) redraw(drawn, snapshot);

  const after = filterButton(drawn.board, 'needs-you');
  assert.ok(after !== null);
  assert.equal(after.getAttribute('aria-pressed'), 'true', 'the filter unpressed itself on the next frame');
  assert.equal(
    columnOf(drawn.board, 'needs-you').querySelectorAll('[data-card]').filter((node) => node.hidden).length,
    hiddenAfterPress,
    'the filter stayed pressed and stopped filtering',
  );
});

test('the filter announces its result politely, and says what changed', () => {
  const snapshot = correctedSnapshot(36);
  const drawn = draw(snapshot);
  const live = drawn.doc.getElementById('corrections-live');
  assert.ok(live !== null, 'the panel has no live region');
  assert.equal(live.getAttribute('aria-live'), 'polite', 'the announcement interrupts, or is silent');
  assert.equal(live.getAttribute('role'), 'status');
  assert.equal(live.textContent, '', 'the region starts with something to say');

  const button = filterButton(drawn.board, 'blocked');
  assert.ok(button !== null);
  toggleFilter(drawn.doc as never, button as never);
  const pressed = live.textContent;
  assert.match(pressed, /showing \d+ AI-corrected, \d+ hidden\./, 'the announcement states no result');

  toggleFilter(drawn.doc as never, button as never);
  assert.notEqual(live.textContent, pressed, 'releasing the filter announced the same thing as pressing it');
  assert.match(live.textContent, /showing every Ticket again/);
});

test('the announcement counts the ledger rows a filter also acts on, not only the cards', () => {
  // Collapsed Done with a Feature open draws ledger rows and NO cards, and the filter hides
  // those rows. An announcement that counted only `[data-card]` therefore reported that nothing
  // was on the page to filter while rows were disappearing underneath it - which is a live
  // region contradicting the screen.
  const snapshot = correctedSnapshot(36);
  const drawn = withOpenRow(snapshot);
  const done = columnOf(drawn.board, 'done');
  assert.equal(done.querySelectorAll('[data-card]').length, 0, 'this state draws no cards, by construction');
  const rows = done.querySelectorAll('[data-ledger]').length;
  assert.ok(rows > 0, 'no ledger row was drawn, so the announcement has nothing to count');

  const button = filterButton(drawn.board, 'done');
  assert.ok(button !== null);
  toggleFilter(drawn.doc as never, button as never);

  const live = drawn.doc.getElementById('corrections-live');
  assert.ok(live !== null);
  const shown = done.querySelectorAll('[data-ledger]').filter((row) => !row.hidden).length;
  assert.ok(shown > 0 && shown < rows, 'the filter hid all or none of the rows, so counting proves nothing');
  assert.equal(
    live.textContent,
    `Done: showing ${String(shown)} AI-corrected, ${String(rows - shown)} hidden.`,
    'the announcement disagrees with what the column now shows',
  );
});

test('the Done column, wholly collapsed, says why its filter has nothing to act on', () => {
  // A control that appears to do nothing is worse than one that is absent. With every Feature
  // closed the Tickets are on the page for nobody, so the filter says so rather than failing
  // quietly.
  const snapshot = correctedSnapshot(36);
  const drawn = draw(snapshot, 'collapsed');
  const button = filterButton(drawn.board, 'done');
  assert.ok(button !== null, 'the Done column holds corrections and drew no control');
  const done = columnOf(drawn.board, 'done');
  assert.equal(done.querySelectorAll('[data-card]').length, 0, 'this state drew cards');
  assert.equal(done.querySelectorAll('[data-ledger]').length, 0, 'this state drew ledger rows');

  toggleFilter(drawn.doc as never, button as never);
  const live = drawn.doc.getElementById('corrections-live');
  assert.ok(live !== null);
  assert.match(live.textContent, /is collapsed, so no Tickets are on the page to filter/);
  assert.match(live.textContent, /\d+ AI-corrected inside it/);
});

test('an announcement a later frame has made untrue is cleared rather than left on screen', () => {
  // Press a filter, then let every correction go away. The control goes with them and the panel
  // says none exist, while the sentence beside it still says six are showing. Cleared rather
  // than rewritten, deliberately: recomputing it would announce on every file change, which on a
  // live board is several times a minute.
  const snapshot = correctedSnapshot(36);
  const drawn = draw(snapshot);
  const button = filterButton(drawn.board, 'agent');
  assert.ok(button !== null);
  toggleFilter(drawn.doc as never, button as never);
  const live = drawn.doc.getElementById('corrections-live');
  assert.ok(live !== null);
  assert.match(live.textContent, /showing \d+ AI-corrected/, 'nothing was announced to go stale');

  redraw(drawn, snapshot);
  assert.match(live.textContent, /showing \d+ AI-corrected/, 'a still-true announcement was thrown away');

  redraw(drawn, deriveSnapshot(SCAN, EMPTY));
  assert.equal(live.textContent, '', 'the announcement outlived the state it described');
  assertPanelCompleted(drawn, 0, CORPUS);
});

test('a card filtered out of a column and then moved below the board is revealed again', () => {
  // `render.js` pools card nodes across the board AND the off-board list, so a card hidden by a
  // filter that then becomes unparseable moves out of its column carrying `hidden`. The filter's
  // own walk is scoped to the columns, so releasing it would never reach the card again and it
  // would be gone from the page permanently.
  const text = '# 07 - Ticket with a title long enough to wrap on a narrow column\n\n- [ ] one\n- [ ] two\n';
  const before = withText('beta/issues/07-t.md', text, 36);
  // A heading and no checkbox list at all: the ladder scores that `unparsed`, which holds no
  // Lane, so the card leaves its column and is drawn below the board instead.
  const after = withText('beta/issues/07-t.md', '# 07 - Ticket after the edit\n\nprose, and not one checkbox\n', 36);

  const drawn = draw(before);
  const button = filterButton(drawn.board, 'agent');
  assert.ok(button !== null, 'the agent column drew no control, so nothing can be filtered');
  toggleFilter(drawn.doc as never, button as never);

  const stranded = drawn.board
    .querySelectorAll('[data-card]')
    .find((node) => node.hidden && (node.getAttribute('data-card') ?? '').includes('07-t.md'));
  assert.ok(stranded !== undefined, 'the card this test is about was not hidden by the filter');

  redraw(drawn, after);

  const offboard = drawn.doc.getElementById('offboard');
  assert.ok(offboard !== null);
  const moved = offboard
    .querySelectorAll('[data-card]')
    .find((node) => (node.getAttribute('data-card') ?? '').includes('07-t.md'));
  assert.ok(moved !== undefined, 'the card did not move below the board, so this test proves nothing');
  assert.equal(moved.hidden, false, 'a card was filtered out of a column and is now hidden for ever');
});

// ---------------------------------------------------------------------------
// The parity contract, stated once and asserted in both directions
// ---------------------------------------------------------------------------

/** Every idiom that moves content off screen while leaving it in the accessibility tree. */
const OFFSCREEN = [/visually-?hidden/i, /\bsr-only\b/i, /screen-?reader/i, /clip-path/i];

test('parity: a visible correction reaches both trees, and a collapsed card reaches neither', () => {
  const snapshot = correctedSnapshot(36);
  // One Feature opened inside the collapsed Done column, and the rest closed. Both halves of the
  // contract are then in one document: the opened ledger is the canary for the closed ones.
  const drawn = withOpenRow(snapshot);

  // Direction one, VISUAL to ASSISTIVE. `board.css` paints `.tid[data-corrected]` and
  // `.lid[data-corrected]` in one rule, so EVERY mark on the page is visible - and every one of
  // them therefore carries the correction in its accessible name, on the same element.
  let namedCards = 0;
  let namedRows = 0;
  for (const slot of marked(drawn.doc.root)) {
    const label = slot.getAttribute('aria-label') ?? '';
    assert.match(label, /AI-corrected: /, 'the marked id carries no correction in its accessible name');
    assert.ok(label.startsWith(slot.textContent), 'the name drops the id the element prints');
    assert.equal(slot.getAttribute('role'), 'img', 'a generic element cannot carry an accessible name');
    if (slot.className.split(/\s+/).includes('lid')) namedRows += 1;
    else namedCards += 1;
  }
  assert.ok(namedCards > 0, 'no card was named, so direction one proved nothing');
  assert.ok(namedRows > 0, 'no ledger row was named, so the second painted shape was never reached');

  // Direction one, ASSISTIVE to VISUAL - and this half is the one an attacker gets past. Adding
  // `aria-hidden="true"` to a marked id leaves the underline exactly where it was and deletes
  // the correction from the accessibility tree, and every name assertion above still passes.
  // So the marked element, and every ancestor between it and the card, must be in the tree.
  for (const slot of marked(drawn.doc.root)) {
    let node: FakeElement | null = slot;
    while (node !== null) {
      assert.notEqual(
        node.getAttribute('aria-hidden'),
        'true',
        'a painted correction sits under aria-hidden, so only a sighted reader is told',
      );
      assert.notEqual(node.getAttribute('role'), 'presentation');
      assert.notEqual(node.getAttribute('role'), 'none');
      node = node.parentNode;
    }
  }

  // Every shape this module names must be a shape `board.css` paints, and the reverse. The two
  // tables are in different files and cannot be checked against each other by the type system,
  // so the stylesheet is read as bytes: a selector present there and unnamed here would leave a
  // sighted reader a mark nobody else gets, and a name here with no selector there is the same
  // inversion the other way round.
  const boardCss = readShipped('../ui/board.css');
  for (const [shape, painted] of [
    ['tid', /\.tid\[data-corrected\]/],
    ['lid', /\.lid\[data-corrected\]/],
  ] as const) {
    assert.match(boardCss, painted, `board.css no longer paints .${shape}[data-corrected]`);
    const named = marked(drawn.doc.root).filter((slot) => slot.className.split(/\s+/).includes(shape));
    assert.ok(named.length > 0, `no .${shape} was marked, so the pairing above proves nothing`);
    for (const slot of named) {
      assert.match(
        slot.getAttribute('aria-label') ?? '',
        /AI-corrected: /,
        `.${shape} is painted and not named, so only a sighted reader is told`,
      );
    }
  }

  // Direction two. A collapsed row is a content state: `render.js` marks the ledger hidden AND
  // empties it, so its cards are absent from the page rather than merely unpainted.
  let closed = 0;
  let opened = 0;
  for (const ledger of columnOf(drawn.board, 'done').querySelectorAll('.ledger')) {
    if (ledger.hidden) {
      assert.equal(ledger.childNodes.length, 0, 'a collapsed ledger kept its rows in the tree');
      closed += 1;
    } else {
      assert.ok(ledger.querySelectorAll('[data-ledger]').length > 0, 'an opened ledger drew no rows');
      opened += 1;
    }
  }
  assert.ok(closed > 0, 'no row was collapsed, so the absence proved nothing');
  assert.ok(opened > 0, 'no row was opened, so a total collapse would have passed this test');

  // And nothing anywhere is merely moved off screen. This is the structural form of the rule,
  // asserted over the emitted markup rather than over a stylesheet, because it is the markup
  // that decides which tree a node is in.
  for (const node of descendants(drawn.doc.root)) {
    for (const [name, value] of node.attributes) {
      for (const pattern of OFFSCREEN) {
        assert.ok(
          !pattern.test(`${name} ${value}`),
          `an emitted node carries ${name}="${value}", which hides it from one tree only`,
        );
      }
    }
  }
  assertPanelCompleted(drawn, 36, CORPUS);
});

test('no collapsed card is visually hidden: the whole idiom is absent from the shipped files', () => {
  // The markup check above can only see the states this file happened to draw. This one closes
  // the class: the idiom appears in none of the bytes that reach a browser, so no state can
  // produce it. Both are needed - the first would miss a rule nothing exercised, the second
  // would miss an attribute written by hand at runtime.
  const files = ['../ui/corrections.js', '../ui/corrections.css'] as const;
  let scanned = 0;
  for (const name of files) {
    const text = readShipped(name);
    assert.ok(text.length > 0, `${name} is empty, so scanning it proves nothing`);
    for (const pattern of OFFSCREEN) {
      assert.ok(!pattern.test(text), `ui/${name} introduces ${String(pattern)}`);
    }
    scanned += 1;
  }
  assert.equal(scanned, files.length);
});

test('the disclosure that reveals a collapsed row is a real button carrying aria-expanded', () => {
  const snapshot = correctedSnapshot(36);
  const drawn = withOpenRow(snapshot);

  let expanded = 0;
  let collapsed = 0;
  for (const block of columnOf(drawn.board, 'done').querySelectorAll('[data-digrow]')) {
    const toggle = block.querySelector('.frow');
    assert.ok(toggle !== null, 'a collapsed row has no disclosure at all');
    assert.equal(toggle.tagName, 'button', 'the disclosure is not a real button');
    assert.equal(toggle.type, 'button');
    const state = toggle.getAttribute('aria-expanded');
    assert.ok(state === 'true' || state === 'false', 'the disclosure carries no expanded state');
    if (state === 'true') expanded += 1;
    else collapsed += 1;
  }
  assert.ok(expanded > 0, 'nothing was expanded, so the state is not being written');
  assert.ok(collapsed > 0, 'everything was expanded, so the closed state was never drawn');
});

test('an opened ledger row carries the same mark the card does, so a Ticket cannot read both ways', () => {
  // Same Ticket, two elements: `.tid` on a card in a column, `.lid` on a ledger row inside an
  // opened Feature in the collapsed Done column, both filled from the same `shortId`. Marking one
  // and not the other would let a Ticket read as corrected in one mode of the Done column and
  // uncorrected in the other.
  const snapshot = correctedSnapshot(36);
  const drawn = withOpenRow(snapshot);
  const corrected = correctedIds(snapshot);

  let markedRows = 0;
  let bareRows = 0;
  for (const row of columnOf(drawn.board, 'done').querySelectorAll('[data-ledger]')) {
    const id = row.getAttribute('data-ledger') ?? '';
    const slot = row.querySelector('.lid');
    assert.ok(slot !== null, 'a ledger row printed no id');
    if (corrected.has(id)) {
      assert.equal(slot.getAttribute('data-corrected'), '1', `ledger row ${id} is corrected and unmarked`);
      markedRows += 1;
    } else {
      assert.equal(slot.getAttribute('data-corrected'), null, `ledger row ${id} is marked and is not corrected`);
      bareRows += 1;
    }
  }
  assert.ok(markedRows > 0, 'no ledger row was marked, so the negative half proved nothing');
  assert.ok(bareRows > 0, 'every ledger row was marked, so the positive half proved nothing');
  assertPanelCompleted(drawn, 36, CORPUS);
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

test('the panel states the total, every column including the zeroes, and the rejected count', () => {
  const dense = draw(correctedSnapshot(36));
  assert.match(dense.panel.textContent, /36 of 52 Tickets carry an Override/);

  const rows = dense.panel.querySelector('.corrrows');
  assert.ok(rows !== null, 'the panel drew no breakdown');
  assert.deepEqual(
    rows.querySelectorAll('.k').map((node) => node.textContent),
    Object.keys(COLUMN_LANES),
    'the breakdown skipped a column',
  );
  const denseCounts = rows.querySelectorAll('.n').map((node) => Number(node.textContent));
  assert.equal(
    denseCounts.reduce((total, one) => total + one, 0),
    36,
    'the breakdown does not add up to the total the panel prints',
  );
  assert.ok(
    denseCounts.filter((one) => one > 0).length >= 4,
    'the dense load populated almost nothing, so the sparse half below is not the contrast it claims',
  );

  // The sparse load is where the zero row earns its place: the header control is drawn only
  // where there is something to filter, so this list is the only place a reader learns that a
  // column was counted and came back empty - a different fact from never having been looked at.
  const sparse = draw(correctedSnapshot(2));
  const sparseRows = sparse.panel.querySelector('.corrrows');
  assert.ok(sparseRows !== null);
  const sparseCounts = sparseRows.querySelectorAll('.n').map((node) => Number(node.textContent));
  assert.equal(sparseCounts.length, Object.keys(COLUMN_LANES).length, 'a zero column was dropped');
  assert.equal(sparseCounts.reduce((total, one) => total + one, 0), 2);
  assert.ok(sparseCounts.includes(0), 'no column came back at zero, so the zero row was never drawn');
  assert.ok(
    sparseCounts.some((one) => one > 0),
    'every column came back at zero, so a collapsed render would have passed',
  );
});

test('a correction on a card that holds no Lane is marked, counted, and never folded into a column', () => {
  // The reachable case a per-column control cannot show. An Override that changes `rawStatus` on
  // a file the parser scored as a decision Ticket can leave it holding no Lane at all - so the
  // card is drawn below the board rather than in a column, and its correction belongs to no
  // column's count. Dropping it there would make the six counts quietly disagree with the total
  // printed above them, which is the failure this whole panel exists to prevent one level up.
  const scan: Scan = {
    roots: [
      {
        path: ROOT,
        label: 'repo',
        trackerPath: `${ROOT}/.scratch`,
        files: [
          { path: 'alpha/issues/01-ok.md', absPath: 'a', text: '# 01 - Fine\n\n- [x] one\n' },
          { path: 'alpha/issues/02-odd.md', absPath: 'b', text: 'Owner: nobody\nMood: unclear\n\nno heading, no boxes\n' },
        ],
        hiddenWorktrees: 0,
        tracker: 'local-markdown',
        adrFiles: [],
        glossaryFile: null,
      },
    ],
  };
  const probe = deriveSnapshot(scan, EMPTY);
  const odd = probe.roots[0]?.features[0]?.tickets.find((ticket) => ticket.path.includes('02-odd'));
  assert.ok(odd !== undefined);
  const snapshot = deriveSnapshot(scan, {
    schemaVersion: 1,
    entries: [
      {
        schemaVersion: 1,
        filePath: odd.id,
        contentSha: odd.contentSha ?? '',
        extraction: { rawStatus: 'in review' },
      },
    ],
  });
  assert.equal(snapshot.corrections.byLane.unlaned, 1, 'the fixture no longer produces an unlaned correction');
  assert.equal(snapshot.corrections.total, 1);

  const drawn = draw(snapshot);
  const offboard = drawn.doc.getElementById('offboard');
  assert.ok(offboard !== null);
  assert.equal(marked(offboard).length, 1, 'the off-board card carries no mark');
  assert.equal(marked(drawn.board).length, 0, 'the correction was drawn inside a column it is not in');

  const rows = drawn.panel.querySelectorAll('.corrrows .k').map((node) => node.textContent);
  assert.equal(rows.length, Object.keys(COLUMN_LANES).length + 1, 'the unlaned row was dropped');
  assert.ok(
    rows.includes('not on the board'),
    'a correction the columns cannot show is not stated anywhere',
  );
  const counts = drawn.panel.querySelectorAll('.corrrows .n').map((node) => Number(node.textContent));
  assert.equal(
    counts.reduce((total, one) => total + one, 0),
    snapshot.corrections.total,
    'the breakdown no longer adds up to the total printed above it',
  );

  // The canary: the other card really was drawn on the board and really is unmarked, so the two
  // absences above are about placement rather than about a render that produced nothing.
  assert.equal(drawn.board.querySelectorAll('[data-card]').length, 1);
});

/** The value the validator refuses below. Kept here so the panel can be searched for it. */
const REFUSED_VALUE = -7;

/** One Override the validator refuses, so the rejected count is a real number and not a guess. */
function rejectedSnapshot(): Snapshot {
  return deriveSnapshot(SCAN, {
    schemaVersion: 1,
    entries: [
      {
        schemaVersion: 1,
        filePath: `${ROOT}#alpha/issues/02-t.md`,
        contentSha: 'not-the-hash-on-disk',
        extraction: { criteria: { checked: REFUSED_VALUE, total: 2 } },
      },
    ],
  });
}

test('a rejected Override is a count on the board, never an absence', () => {
  // A dropped Override and a parser that quietly regressed are indistinguishable on a board
  // that only counts what it applied.
  const clean = draw(correctedSnapshot(36));
  assert.match(clean.panel.textContent, /No Override was rejected\./);
  // The canary for that absence: the same pass still printed the applied total.
  assertPanelCompleted(clean, 36, CORPUS);
  const drawn = draw(rejectedSnapshot());
  const count = rejectedSnapshot().overrides.rejected;
  assert.equal(count, 1, 'the fixture no longer produces exactly one rejected Override');
  // The exact number, not merely a positive one: a hard-coded summary would satisfy a looser
  // assertion.
  assert.match(
    drawn.panel.querySelector('.corrrej')?.textContent ?? '',
    /^1 Override was rejected and did not reach a card\.$/,
    'the panel does not state the rejected count exactly',
  );
  const why = drawn.panel.querySelector('.corrwhy');
  assert.ok(why !== null && why.querySelectorAll('.k').length === count, 'the rejection was counted and never named');
});

test('a rejection reproduces the seam exactly: the field it names, the words it used, nothing added', () => {
  const rejected = rejectedSnapshot();
  const { panel } = draw(rejected);
  const fields = panel.querySelectorAll('.corrwhy .k').map((node) => node.textContent);
  const messages = panel.querySelectorAll('.corrwhy .v').map((node) => node.textContent);
  const paths = panel.querySelectorAll('.corrwhy .copy').map((node) => node.getAttribute('data-copy'));
  assert.ok(fields.length > 0, 'nothing was drawn, so nothing below is being compared');

  // The exact field names, messages and paths, in order, against what the seam produced. A
  // constant label in every row would satisfy a looser comparison.
  assert.deepEqual(fields, rejected.rejections.map((one) => one.field));
  assert.deepEqual(messages, rejected.rejections.map((one) => one.message));
  assert.deepEqual(paths, rejected.rejections.map((one) => one.path));
  assert.deepEqual(fields, ['extraction.criteria.checked'], 'the field is not the one the seam named');

  // What a message contains is the seam's decision, not this panel's - it names the field and
  // the overage so the model that wrote the Override can correct itself, so `-7 is not a count`
  // legitimately carries the value. What is asserted here is that the panel adds NOTHING: the
  // rejection block's whole text is the three strings the seam produced.
  const block = panel.querySelector('.corrwhy');
  assert.ok(block !== null);
  assert.equal(
    block.textContent,
    rejected.rejections.map((one) => `${one.field}${one.message}${one.path}`).join(''),
    'the panel added wording of its own to a rejection',
  );
  assert.ok(String(REFUSED_VALUE).length > 0);
});

test('before the first frame the panel touches nothing at all, and it returns early to do it', () => {
  // `board.js` holds `null` from page load until the first SSE frame, so this is the state the
  // browser paints in. Two things are asserted and the second is the one that matters: the panel
  // draws nothing, AND it never reads a property of the document on the way to deciding that.
  //
  // A counting proxy rather than a throwing one, deliberately. The shared guard in
  // `board-ui.test.ts` throws, which a panel that reached in and caught its own failure would
  // pass while doing exactly the thing the contract forbids - and this panel does catch its own
  // failures, for a good reason, so that guard cannot tell the two apart. Counting can.
  let reads = 0;
  const counting = new Proxy(
    {},
    {
      get(_target, property) {
        reads += 1;
        return () => {
          throw new Error(`a panel called doc.${String(property)} before a Snapshot arrived`);
        };
      },
    },
  );

  for (const nothing of [null, undefined]) {
    assert.equal(renderCorrections(counting as never, counting as never, nothing), undefined);
  }
  assert.equal(reads, 0, `the panel read ${String(reads)} document properties before its first Snapshot`);

  // And on a real document: nothing is written into the mount, and no card is marked.
  const doc = boardDocument();
  const panel = mountOf(doc);
  const view = buildView(correctedSnapshot(36), { doneMode: 'cards', openFeatures: {} });
  render(doc as never, view);
  renderCorrections(doc as never, view, null);

  assert.equal(panel.childNodes.length, 0, 'the panel drew into its mount before a Snapshot arrived');
  const board = doc.getElementById('board');
  assert.ok(board !== null);
  assert.equal(marked(board).length, 0, 'a card was marked before a Snapshot arrived');
  assert.equal(board.querySelectorAll('[data-corrections-filter]').length, 0);

  // The canary: the same document, the same call, one frame later, draws everything. Without it
  // "nothing was drawn" is a claim a panel that never works at all also satisfies.
  renderCorrections(doc as never, view, correctedSnapshot(36));
  assert.match(panel.textContent, /36 of 52 Tickets carry an Override/);
  assert.ok(marked(board).length > 0);
});

test('a Snapshot that arrived but is not one draws the panel rather than a failure', () => {
  // `JSON.parse` output off a socket. Not `null` - a frame HAS arrived - so the panel draws, and
  // what it can honestly say about a Snapshot carrying nothing is that nothing was corrected.
  for (const snapshot of [{} as never, { corrections: 'nope' } as never, [] as never, 7 as never]) {
    const { panel, board } = draw(snapshot);
    assert.match(panel.textContent, /No Override has changed a field on this board\./);
    assert.equal(marked(board).length, 0);
    assert.equal(panel.querySelector('.corrfail'), null, 'the panel reported a failure it should absorb');
  }

  // The canary: the same call path on a real Snapshot still draws the populated panel, so the
  // assertions above are about degraded input rather than about a panel that never runs.
  assertPanelCompleted(draw(correctedSnapshot(2)), 2, CORPUS);
});

test('a failure inside the panel is stated in the panel, not swallowed and not thrown', () => {
  // Two things at once, and they pull in opposite directions. The panel must not throw: it is
  // called from `draw()` between two other panels, and the focus restore that keeps the
  // reader's place runs after all three, so a throw here blanks its neighbours and drops the
  // reader to the body. But it must not go quiet either - a panel that silently stopped
  // updating is a panel reporting stale counts as current.
  const snapshot = correctedSnapshot(36);
  const doc = boardDocument();
  const panel = mountOf(doc);
  const view = buildView(snapshot, { doneMode: 'cards', openFeatures: {} });
  render(doc as never, view);

  const hostile = {
    root: doc.root,
    createElement: (tag: string): FakeElement => doc.createElement(tag),
    getElementById: (id: string): FakeElement | null => {
      if (id === 'board') throw new Error('the board mount is unreachable');
      return doc.getElementById(id);
    },
  };

  assert.equal(renderCorrections(hostile as never, view, snapshot), undefined, 'the panel threw');
  const failure = panel.querySelector('.corrfail');
  assert.ok(failure !== null, 'the panel went quiet instead of saying it could not be drawn');
  assert.match(failure.textContent, /could not be drawn/);
  assert.match(failure.textContent, /the board mount is unreachable/, 'the reason was dropped');

  // The canary: the same panel drawn normally still produces its counts, so the assertion above
  // is about a failure path rather than about a panel that never draws anything else.
  const { panel: healthy } = draw(snapshot);
  assert.equal(healthy.querySelector('.corrfail'), null);
  assert.match(healthy.textContent, /36 of 52 Tickets carry an Override/);
});

test('the panel frame is built once and written into, never rebuilt under the reader', () => {
  const snapshot = correctedSnapshot(2);
  const drawn = draw(snapshot);
  const body = drawn.panel.querySelector('.corrbody');
  const live = drawn.doc.getElementById('corrections-live');
  assert.ok(body !== null && live !== null);

  redraw(drawn, correctedSnapshot(36));

  assert.equal(drawn.panel.querySelector('.corrbody'), body, 'the panel frame was rebuilt');
  assert.equal(drawn.doc.getElementById('corrections-live'), live, 'the live region was replaced');
  assert.match(drawn.panel.textContent, /36 of 52 Tickets carry an Override/, 'the frame survived and went stale');
});

test('the panel names itself, so it is a region a reader can reach rather than an unlabelled box', () => {
  const { panel } = draw(correctedSnapshot(2));
  const heading = panel.querySelector('.subhead');
  assert.ok(heading !== null, 'the panel drew no heading');
  assert.equal(panel.getAttribute('aria-labelledby'), 'corrections-h');
  const title = panel.querySelector('.corrbody');
  assert.ok(title !== null);
});

// ---------------------------------------------------------------------------
// Things that only go wrong on the tenth frame
// ---------------------------------------------------------------------------

test('exactly one listener is attached, however many frames are drawn', () => {
  // A handler registered from inside a render accumulates one copy per frame, and the symptom
  // is an action firing N times with nothing in the source saying so.
  const snapshot = correctedSnapshot(2);
  const doc = boardDocument();
  const panel = mountOf(doc);

  let attached = 0;
  const withEvents = {
    root: doc.root,
    createElement: (tag: string): FakeElement => doc.createElement(tag),
    getElementById: (id: string): FakeElement | null => doc.getElementById(id),
    addEventListener: (): void => {
      attached += 1;
    },
  };

  const view = buildView(snapshot, { doneMode: 'cards', openFeatures: {} });
  for (let frame = 0; frame < 6; frame += 1) {
    render(withEvents as never, view);
    renderCorrections(withEvents as never, view, snapshot);
  }
  assert.equal(attached, 1, `${String(attached)} listeners were attached across six frames`);

  // The canary: those six frames really did draw a board and fill this panel, so a single
  // attachment is not the count a render that never ran would also report.
  const board = withEvents.getElementById('board');
  assert.ok(board !== null && marked(board).length > 0, 'the six frames drew no marked board');
  assert.match(panel.textContent, /2 of 52 Tickets carry an Override/, 'the six frames drew nothing into the panel');
});

test('no Snapshot field is read through the prototype chain', () => {
  // The Snapshot is `JSON.parse` output, so every object in it carries `Object.prototype`. A
  // plain `byLane.unlaned` on a page where anything has polluted that prototype answers with the
  // pollution, and the panel prints corrections a board with none does not have. Every field
  // access needs the same own-property guard.
  const polluted = ['unlaned', 'total', 'corrections', 'rejected', 'correctedFields'] as const;
  for (const key of polluted) {
    Object.defineProperty(Object.prototype, key, {
      value: key === 'correctedFields' ? ['title'] : 3,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  try {
    const drawn = draw({} as never);
    assert.match(
      drawn.panel.querySelector('.corrlead')?.textContent ?? '',
      /^No Override has changed a field on this board\.$/,
      'a polluted prototype was read as a correction count',
    );
    const rows = drawn.panel.querySelectorAll('.corrrows .k').map((node) => node.textContent);
    assert.deepEqual(rows, Object.keys(COLUMN_LANES), 'a prototype key added a breakdown row');
    assert.equal(
      drawn.panel.querySelector('.corrrej')?.textContent,
      'No Override was rejected.',
      'a polluted prototype was read as a rejected Override',
    );
  } finally {
    for (const key of polluted) delete (Object.prototype as Record<string, unknown>)[key];
  }

  // The canary, outside the pollution: the same call path on a real Snapshot still draws counts.
  assertPanelCompleted(draw(correctedSnapshot(2)), 2, CORPUS);
});

test('two different rejection lists that collide under a delimiter join still redraw', () => {
  // The list was keyed by `path:field:message` joined with `|`, and every one of those strings
  // comes out of somebody else's repository. The two lists below produce the identical joined
  // signature, so the second could be silently drawn as the first - a rejection count of two
  // beside a detail list of one. The key must preserve the list's structure.
  const one = snapshotWithRejections([{ path: 'a', field: 'b', message: 'c|d:e:f' }]);
  const two = snapshotWithRejections([
    { path: 'a', field: 'b', message: 'c' },
    { path: 'd', field: 'e', message: 'f' },
  ]);
  assert.equal(joinSignature(one), joinSignature(two), 'the fixture no longer collides, so it proves nothing');

  const drawn = draw(one as never);
  assert.equal(drawn.panel.querySelectorAll('.corrwhy .k').length, 1);

  redraw(drawn, two as never);
  assert.equal(
    drawn.panel.querySelectorAll('.corrwhy .k').length,
    2,
    'the second rejection list was suppressed by a colliding signature',
  );
  assert.deepEqual(
    drawn.panel.querySelectorAll('.corrwhy .v').map((node) => node.textContent),
    ['c', 'f'],
  );
});

test('two rejections whose joined text is identical stay two rows on the second frame', () => {
  // The per-row key. A delimiter join cannot tell these two apart - both come out `a:b:c:d`,
  // because the boundary between path and field moved - so the second frame finds one key for
  // two rows, patches the first, and sweeps the second away. The list then silently shows one
  // rejection where the count beside it says two. `JSON.stringify` cannot be fooled that way.
  const pair = [
    { path: 'a:b', field: 'c', message: 'd' },
    { path: 'a', field: 'b:c', message: 'd' },
  ];
  const joined = pair.map((one) => `${one.path}:${one.field}:${one.message}`);
  assert.equal(joined[0], joined[1], 'the fixture no longer collides, so it proves nothing');

  const drawn = draw(snapshotWithRejections(pair) as never);
  assert.equal(drawn.panel.querySelectorAll('.corrwhy .k').length, 2, 'the first frame drew the wrong count');

  // One of the two then says something different, which is what a re-validation produces. Under
  // a joined key the changed row cannot be matched to the node that held it, the unchanged row's
  // node is unreachable in the index and so is never swept, and the panel draws THREE rejections
  // beside a count that says two.
  const changed = [{ ...pair[0], message: 'e' }, pair[1]] as Refusal[];
  redraw(drawn, snapshotWithRejections(changed) as never);

  assert.deepEqual(
    drawn.panel.querySelectorAll('.corrwhy .v').map((node) => node.textContent),
    ['e', 'd'],
    'the rejection list disagrees with the rejections the Snapshot carries',
  );
  assert.deepEqual(
    drawn.panel.querySelectorAll('.corrwhy .k').map((node) => node.textContent),
    ['c', 'b:c'],
  );
  assert.match(drawn.panel.querySelector('.corrrej')?.textContent ?? '', /^2 Overrides were rejected/);
});

test('a count changing does not throw away the rejection the reader was reading', () => {
  // Both lists were rebuilt wholesale whenever their signature moved, so one count changing
  // discarded every row - including a copy button the reader had focused and a path they were
  // half way through selecting. On a live board a count changes several times a minute.
  const rejections = [
    { path: 'alpha/issues/02-t.md', field: 'extraction.criteria.checked', message: '-7 is not a count' },
    { path: 'beta/issues/03-t.md', field: 'extraction.title', message: '412 > 200 chars' },
  ];
  const drawn = draw(snapshotWithRejections(rejections, 4) as never);
  const buttons = drawn.panel.querySelectorAll('.corrwhy .copy');
  const rows = drawn.panel.querySelectorAll('.corrrows .k');
  assert.equal(buttons.length, 2, 'the fixture drew no rejection buttons');
  assert.ok(rows.length > 0);

  // Same rejections, a different correction count: every row's number changes, no rejection does.
  redraw(drawn, snapshotWithRejections(rejections, 9) as never);

  assert.deepEqual(drawn.panel.querySelectorAll('.corrwhy .copy'), buttons, 'a copy button was rebuilt');
  assert.match(drawn.panel.querySelector('.corrlead')?.textContent ?? '', /^9 of /, 'the counts did not move');

  // And the reverse: a rejection arriving must not rebuild the counts beside it.
  const before = drawn.panel.querySelectorAll('.corrrows .k');
  redraw(drawn, snapshotWithRejections([...rejections, { path: 'c.md', field: 'f', message: 'm' }], 9) as never);
  assert.deepEqual(drawn.panel.querySelectorAll('.corrrows .k'), before, 'a count row was rebuilt');
  assert.equal(drawn.panel.querySelectorAll('.corrwhy .copy').length, 3);
});

test('the panel names itself, and goes on naming itself after it fails to draw', () => {
  // `aria-labelledby` points at the heading's id. The failure path replaces the mount's children;
  // without rebuilding that heading, the region points at an element that no longer exists and
  // has no accessible name. The test checks both the id value and that it resolves.
  const drawn = draw(correctedSnapshot(2));
  assert.equal(drawn.panel.getAttribute('aria-labelledby'), 'corrections-h');
  const heading = drawn.doc.getElementById('corrections-h');
  assert.ok(heading !== null, 'the panel is named by an id that resolves to nothing');
  assert.equal(heading.tagName, 'h2');
  assert.equal(heading.textContent, 'AI-corrected Tickets');

  const hostile = {
    root: drawn.doc.root,
    createElement: (tag: string): FakeElement => drawn.doc.createElement(tag),
    getElementById: (id: string): FakeElement | null => {
      if (id === 'board') throw new Error('the board mount is unreachable');
      return drawn.doc.getElementById(id);
    },
  };
  const view = buildView(correctedSnapshot(2), { doneMode: 'cards', openFeatures: {} });
  renderCorrections(hostile as never, view, correctedSnapshot(2));

  assert.ok(drawn.panel.querySelector('.corrfail') !== null, 'the failure was not drawn');
  assert.equal(drawn.panel.getAttribute('aria-labelledby'), 'corrections-h');
  const afterFailure = drawn.doc.getElementById('corrections-h');
  assert.ok(afterFailure !== null, 'the failed panel is named by an id that resolves to nothing');
  assert.equal(afterFailure.textContent, 'AI-corrected Tickets');
});

test('the panel is reached through the seam it is wired into, with the arity that seam asserts', () => {
  assert.equal(renderCorrections.length, 3, 'the panel no longer takes the Snapshot');
  assert.equal(typeof toggleFilter, 'function');
});

// ---------------------------------------------------------------------------

/** Read as bytes rather than imported, because the question is what ships. */
function readShipped(relative: string): string {
  return readFileSync(join(import.meta.dirname, relative), 'utf8');
}

interface Refusal {
  readonly path: string;
  readonly field: string;
  readonly message: string;
}

/**
 * A hand-built Snapshot carrying exactly these rejections.
 *
 * Hand-built rather than derived, because the seam cannot be made to emit a path or a message
 * containing a chosen delimiter - and the panel's contract is that its argument is unvalidated
 * `JSON.parse` output off a socket, so this is the shape it is specified to survive.
 */
function snapshotWithRejections(rejections: readonly Refusal[], total = 0): unknown {
  return {
    corrections: { total, byLane: { blocked: total, frozen: 0, agent: 0, 'needs-you': 0, 'in-progress': 0, complete: 0, parked: 0, unlaned: 0 } },
    overrides: { applied: total, rejected: rejections.length },
    progress: { total: CORPUS },
    rejections: rejections.map((one) => ({ kind: 'override', feature: null, ...one })),
    roots: [],
  };
}

/** The deliberately collision-prone delimiter-joined signature under test. */
function joinSignature(snapshot: unknown): string {
  const held = (snapshot as { rejections: readonly Refusal[] }).rejections;
  return held.map((one) => `${one.path}:${one.field}:${one.message}`).join('|');
}
