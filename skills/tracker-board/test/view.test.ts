/**
 * The board's view model.
 *
 * Every decision the board takes about what a reader sees is taken in `ui/view.js` and is
 * therefore answerable here, without a browser: which column a card lands in, what its meter
 * reads, which Ticket a Frozen chain terminates at, what the header claims and what the counts
 * add up to. The DOM side - patching, clipboard, reconnect, layout - is exercised against a
 * real browser instead, because those are the parts a fake DOM would let pass.
 *
 * Snapshots here are built from `deriveSnapshot` over a temporary tracker tree rather than
 * hand-written, so the shapes under test are the shapes the server actually sends. Hand-rolled
 * Snapshot literals would be this file rebuilding the thing it is checking.
 *
 * ## The canary rule
 *
 * Several assertions below are about an absence - an empty column, a card with no blockers, a
 * Done column collapsed to a count. A test whose expected result is "nothing" passes for free
 * if the render collapses entirely, so every one of those runs against `BOARD`, a fixture that
 * also contains cards which must come out populated, and asserts both halves.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { deriveSnapshot } from '../core/index.ts';
import type { Snapshot } from '../core/types.ts';
import { readTree } from '../scan/readTree.ts';
import { buildView, columnOrder, laneKey, summarise } from '../ui/view.js';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'tracker-board-home-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const EMPTY = { schemaVersion: 1, entries: [] };

/**
 * The board fixture. One Ticket for every Lane, both Dialects, a Frozen chain, a dangling
 * reference, an external blocker, a schema-less sibling and an orphan.
 *
 * Every expectation written against it below was read off the seam first rather than assumed
 * from what the file looks like it should mean - `beta`'s Tickets use bare field markers
 * because bold ones score as `task`, which is the sort of thing only running it tells you.
 */
const BOARD: Readonly<Record<string, string>> = {
  'alpha/issues/01-base.md': '# 01 - Base\n\n- [x] one\n- [x] two\n',
  'alpha/issues/02-signoff.md':
    '# 02 - Signoff\n\n**Status:** ready-for-human\n\n- [x] one\n- [x] two\n',
  'alpha/issues/03-moving.md': '# 03 - Moving\n\n- [x] one\n- [ ] two\n',
  'alpha/issues/04-frozen.md': '# 04 - Frozen\n\n**Blocked by:** 02\n\n- [ ] one\n',
  'alpha/issues/05-blocked.md': '# 05 - Blocked\n\n**Blocked by:** 03\n\n- [ ] one\n',
  'alpha/issues/06-ready.md': '# 06 - Ready\n\n- [ ] one\n',
  'alpha/issues/07-parked.md':
    '# 07 - Parked\n\n**Status:** wontfix\n\n- [ ] one\n- [ ] two\n- [ ] three\n',
  'alpha/issues/08-dangling.md': '# 08 - Dangling\n\n**Blocked by:** 99\n\n- [ ] one\n',
  'alpha/issues/09-external.md':
    '# 09 - External\n\n**Blocked by:** a vendor contract\n\n- [ ] one\n',
  'alpha/spec.md': '# Spec\n',
  'beta/issues/01-decide.md': '# 01 - Decide\n\nType: grilling (HITL)\nStatus: open\n',
  'beta/issues/02-resolved.md': '# 02 - Resolved\n\nType: research (AFK)\nStatus: resolved\n',
  'gamma/issues/01-mystery.md': '## Roll-call taxonomy - working notes\n\nProse, no fields.\n',
  'loose.md': '# outside any Feature\n',
};

// ---------------------------------------------------------------------------
// The six columns
// ---------------------------------------------------------------------------

test('six columns in a fixed order with fixed glyphs, each stating what puts a Ticket there', (t) => {
  const view = buildView(snapshotOf(tempTracker(t, BOARD)));

  assert.deepEqual(
    view.columns.map((column) => column.key),
    ['blocked', 'agent', 'needs-you', 'in-progress', 'done', 'parked'],
    'the column order is the whole visual language of this board; content must never move it',
  );
  assert.deepEqual(columnOrder(), view.columns.map((column) => column.key));

  assert.deepEqual(
    view.columns.map((column) => column.glyph),
    ['▲', '▶', '◆', '◐', '✓', '⊘'],
  );
  assert.deepEqual(
    view.columns.map((column) => column.name),
    ['Blocked', 'Agent can take', 'Needs you', 'In progress', 'Done', 'Parked'],
  );

  for (const column of view.columns) {
    const hint = column.hint.map((run) => run.text).join('');
    assert.ok(hint.length > 24, `column ${column.key} has no hint saying what puts a Ticket there`);
  }
});

test('every Lane carries a distinct glyph and a spelled-out name, so nothing rides on colour', () => {
  // Frozen and Needs-you are adjacent violets by design - the cause of both is a person. That
  // is only acceptable because neither is carried by hue, so the two non-colour channels are
  // asserted over all seven Lanes at once rather than over the two that happen to be close.
  const lanes = laneKey();
  assert.equal(lanes.length, 7, 'seven Lanes, in six columns');

  const glyphs = lanes.map((lane) => lane.glyph);
  assert.equal(new Set(glyphs).size, 7, 'two Lanes share a glyph, so the glyph cannot tell them apart');

  const labels = lanes.map((lane) => lane.label);
  assert.equal(new Set(labels).size, 7, 'two Lanes share a spelled-out name');
  for (const lane of lanes) {
    assert.ok(lane.label.length > 0, `Lane ${lane.lane} has no spelled-out name`);
    assert.ok(lane.glyph.length > 0, `Lane ${lane.lane} has no glyph`);
  }

  const frozen = lanes.find((lane) => lane.lane === 'frozen');
  const you = lanes.find((lane) => lane.lane === 'needs-you');
  assert.ok(frozen !== undefined && you !== undefined);
  assert.notEqual(frozen.glyph, you.glyph, 'the two violets are told apart by glyph');
  assert.notEqual(frozen.label, you.label, 'the two violets are told apart by name');
});

test('an empty column is drawn with its hint, beside columns that are populated', (t) => {
  // The canary: this fixture has no Ticket in three of the six columns and Tickets in the
  // other three. A render that collapsed entirely would satisfy the empty half for free.
  const view = buildView(
    snapshotOf(tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n\n- [ ] one\n' })),
  );

  const byKey = new Map(view.columns.map((column) => [column.key, column]));
  assert.equal(byKey.get('agent')?.count, 1, 'the populated column came out empty, so this proves nothing');
  assert.equal(byKey.get('done')?.count, 0);
  assert.equal(byKey.get('parked')?.count, 0);
  assert.equal(view.columns.length, 6, 'a column vanished when it emptied');

  for (const column of view.columns) {
    assert.ok(column.emptyNote.length > 0, `column ${column.key} has no note for its empty state`);
  }
});

// ---------------------------------------------------------------------------
// Blocked: two sub-lanes, one column
// ---------------------------------------------------------------------------

test('frozen and blocked are labelled sub-lanes of one column, counted separately', (t) => {
  const view = buildView(snapshotOf(tempTracker(t, BOARD)));
  const blocked = view.columns[0];
  assert.ok(blocked !== undefined);

  assert.equal(blocked.split, true, 'the Blocked column stopped carrying two Lanes');
  assert.deepEqual(
    blocked.sublanes.map((sublane) => sublane.lane),
    ['frozen', 'blocked'],
    'frozen is listed first: it is the one a reader is most likely to be wrong about',
  );
  for (const sublane of blocked.sublanes) {
    assert.equal(sublane.labelled, true, `sub-lane ${sublane.lane} is not labelled`);
    assert.ok(sublane.label.length > 0);
    assert.ok(sublane.note.length > 0, `sub-lane ${sublane.lane} does not say who can clear it`);
  }

  // Both populated, and populated differently - a fold would give one sub-lane of four.
  assert.equal(blocked.sublanes[0]?.count, 1, 'the frozen sub-lane is empty, so the split proves nothing');
  assert.equal(blocked.sublanes[1]?.count, 3);
  assert.equal(blocked.count, 4, 'the column count must be the sum of both sub-lanes');

  // And the header breaks the number down, because one number over two sub-lanes reads as one
  // queue, which is the misreading the split exists to prevent.
  const breakdown = blocked.breakdown.map((run) => run.text).join('');
  assert.match(breakdown, /1.*[Ff]rozen on you/);
  assert.match(breakdown, /3.*[Qq]ueued for an agent/);

  const single = view.columns[1];
  assert.equal(single?.split, false, 'a single-Lane column must not draw a breakdown');
  assert.equal(single?.breakdown.length, 0);
});

test('a frozen card names the human-gated Ticket its chain terminates at', (t) => {
  const snapshot = snapshotOf(tempTracker(t, BOARD));
  const view = buildView(snapshot);
  const frozen = cardsIn(view, 'blocked', 'frozen');
  const blocked = cardsIn(view, 'blocked', 'blocked');

  assert.equal(frozen.length, 1);
  assert.equal(blocked.length, 3, 'the blocked sub-lane is empty, so the contrast below proves nothing');

  const card = frozen[0];
  assert.ok(card !== undefined && card.frozen !== null);
  assert.equal(card.frozen.targetLabel, 'AL·02', 'the frozen card does not name its terminal Ticket');
  assert.equal(card.frozen.targetTitle, 'Signoff', 'the terminal Ticket is named by id but not by title');

  // The id is the Snapshot's own, so the navigation can find the node. Read off the Snapshot
  // rather than reconstructed here, which would be a second copy of the id scheme.
  const target = ticketNamed(snapshot, '02-signoff.md');
  assert.equal(card.frozen.targetId, target.id);
  assert.equal(target.derivation.lane, 'needs-you', 'the chain must terminate at a human Lane');

  // And an ordinary blocked card claims no terminal human. Same fixture, opposite answer.
  for (const other of blocked) {
    assert.equal(other.frozen, null, `${other.shortId} claims a frozen terminal while in the blocked sub-lane`);
  }
});

// ---------------------------------------------------------------------------
// Meters, Dialects and sign-off
// ---------------------------------------------------------------------------

test('a ready-for-human Ticket renders its criteria ratio and reads as awaiting sign-off', (t) => {
  const view = buildView(snapshotOf(tempTracker(t, BOARD)));
  const you = cardsIn(view, 'needs-you', 'needs-you');
  assert.equal(you.length, 2, 'Needs you holds a task awaiting sign-off and a decision named by Type');

  const card = you.find((entry) => entry.shortId === 'AL·02');
  assert.ok(card !== undefined);
  assert.equal(card.meter?.text, '2/2', 'a fully-checked Needs-you card lost its ratio');
  assert.deepEqual(card.meter?.segments, [true, true], 'the meter reduced to a bare ratio');
  assert.equal(card.signoff, true, 'a full meter here must read as implemented, not as unstarted');
  assert.equal(card.state, 'done-awaiting-human');

  // The canary: an in-progress card in the same fixture keeps a partial meter and is not
  // flagged for sign-off, so `signoff` is not simply true everywhere.
  const moving = cardsIn(view, 'in-progress', 'in-progress')[0];
  assert.ok(moving !== undefined);
  assert.equal(moving.meter?.text, '1/2');
  assert.equal(moving.signoff, false);
});

test('a Needs-you card prints the field that put it there, and says when it was inferred', (t) => {
  const view = buildView(
    snapshotOf(
      tempTracker(t, {
        ...BOARD,
        // A decision Ticket routed by a substring hit in free-text `Type:` rather than by a
        // declared `Status:`. Both must appear on one board, or "declared" and "inferred"
        // cannot be shown to render differently.
        'delta/issues/01-relay.md': '# 01 - Relay\n\nType: task (HITL - the user relays)\nStatus: open\n',
      }),
    ),
  );
  const you = cardsIn(view, 'needs-you', 'needs-you');
  const bySource = new Map(you.map((card) => [card.whyYou?.src, card]));

  const declared = bySource.get('status');
  assert.ok(declared !== undefined, 'no card is routed to Needs you by a declared Status');
  assert.match(declared.whyYou?.label ?? '', /declares/);
  assert.equal(declared.whyYou?.value, 'ready-for-human', 'the status value is not printed');

  const inferred = bySource.get('type');
  assert.ok(inferred !== undefined, 'no card is routed to Needs you by a Type field');
  assert.match(inferred.whyYou?.label ?? '', /heuristic/, 'an inferred Lane must say it was inferred');
  assert.match(
    inferred.whyYou?.value ?? '',
    /HITL/,
    'the whole Type string is printed so the reader can judge the match',
  );
  assert.notEqual(declared.whyYou?.src, inferred.whyYou?.src);
});

test('a decision Ticket carries no ratio and says so, rather than being drawn at zero', (t) => {
  const view = buildView(snapshotOf(tempTracker(t, BOARD)));
  const all = everyCard(view);
  const decisions = all.filter((card) => card.dialect === 'decision');
  const tasks = all.filter((card) => card.dialect === 'task');

  assert.ok(decisions.length > 0, 'the fixture produced no decision Ticket, so this proves nothing');
  assert.ok(tasks.length > 0, 'the fixture produced no task Ticket, so the contrast proves nothing');

  for (const card of decisions) {
    assert.equal(card.meter, null, `${card.shortId} drew a meter on a Ticket that has no checklist`);
    assert.ok(card.decision !== null, `${card.shortId} says nothing about having no checklist`);
    assert.match(card.decision?.note ?? '', /no checklist/);
  }
  for (const card of tasks) {
    assert.ok(card.meter !== null, `${card.shortId} lost the meter that carries its progress`);
    assert.equal(card.decision, null);
  }
});

test('a parked Ticket keeps its unchecked boxes visible', (t) => {
  const view = buildView(snapshotOf(tempTracker(t, BOARD)));
  const parked = cardsIn(view, 'parked', 'parked');
  assert.equal(parked.length, 1);

  const card = parked[0];
  assert.ok(card !== undefined);
  assert.ok(card.meter !== null, 'a parked Ticket lost its meter, so its unfinished work is invisible');
  assert.equal(card.meter.text, '0/3');
  assert.equal(card.meter.segments.length, 3, 'the unchecked boxes are not drawn');
  assert.deepEqual(card.meter.segments, [false, false, false]);

  // The canary: a finished card in the same fixture comes out full, so "all segments off" is
  // not what this fixture produces everywhere.
  const done = cardsIn(view, 'done', 'complete')[0];
  assert.ok(done !== undefined);
  assert.deepEqual(done.meter?.segments, [true, true]);

  assert.match(view.columns[5]?.note ?? '', /unchecked boxes/, 'the Parked column does not say why');
});

// ---------------------------------------------------------------------------
// Done, collapsed
// ---------------------------------------------------------------------------

test('Done is collapsed by default, with a count, and expands on request', (t) => {
  const root = tempTracker(t, BOARD);
  const snapshot = snapshotOf(root);

  const collapsed = buildView(snapshot);
  const done = collapsed.columns[4];
  assert.ok(done !== undefined && done.collapsed !== null);
  assert.equal(done.count, 2, 'the Done column is empty, so collapsing it proves nothing');
  assert.equal(done.collapsed.total, 2, 'the collapsed Done column does not state its count');
  assert.equal(done.collapsed.featureCount, 2);
  assert.deepEqual(
    done.collapsed.rows.map((row) => row.count),
    [1, 1],
    'each Feature row must carry its own count',
  );
  for (const row of done.collapsed.rows) {
    assert.equal(row.expanded, false, 'a Feature row is expanded before anyone asked');
  }

  // No other column collapses: this is a property of Done, not of the renderer running out.
  for (const column of collapsed.columns) {
    if (column.key === 'done') continue;
    assert.equal(column.collapsed, null, `column ${column.key} collapsed and should not`);
  }

  const opened = buildView(snapshot, { openFeatures: { [done.collapsed.rows[0]?.key ?? '']: true } });
  const openedDone = opened.columns[4];
  assert.deepEqual(
    openedDone?.collapsed?.rows.map((row) => row.expanded),
    [true, false],
    'expanding one Feature must not expand the others',
  );

  const asCards = buildView(snapshot, { doneMode: 'cards' });
  assert.equal(asCards.columns[4]?.collapsed, null, 'the full-cards mode still collapsed');
  assert.equal(cardsIn(asCards, 'done', 'complete').length, 2);
});

// ---------------------------------------------------------------------------
// Counts, the Frontier, and the progress figure
// ---------------------------------------------------------------------------

test('the progress figure is labelled with what it counts, from the Snapshot', (t) => {
  const snapshot = snapshotOf(tempTracker(t, BOARD));
  const view = buildView(snapshot);

  assert.equal(
    view.progressLabel,
    snapshot.progress.label,
    'the board invented a label instead of carrying the one the seam supplies',
  );
  assert.equal(view.progressLabel, 'finished and off your desk');

  const tile = view.totals.find((total) => total.label === snapshot.progress.label);
  assert.ok(tile !== undefined, 'the progress figure is on the board without its label');
  assert.equal(tile.value, `${String(snapshot.progress.percent)}%`);

  // The number means finished AND off your desk, which is not the same as having every box
  // checked. Two Tickets here have a full meter; only one of them is in Done, because the
  // other is held by `ready-for-human`. If every full meter landed in Done the label would be
  // carrying no information at all, so both halves are asserted.
  const fullMeters = everyCard(view).filter(
    (card) => card.meter !== null && card.meter.total > 0 && card.meter.checked === card.meter.total,
  );
  assert.equal(fullMeters.length, 2, 'no fully-checked Ticket in the fixture, so this proves nothing');

  const fullInDone = cardsIn(view, 'done', 'complete').filter(
    (card) => card.meter !== null && card.meter.checked === card.meter.total,
  );
  const fullInNeedsYou = cardsIn(view, 'needs-you', 'needs-you').filter(
    (card) => card.meter !== null && card.meter.checked === card.meter.total,
  );
  assert.equal(fullInDone.length, 1);
  assert.equal(fullInNeedsYou.length, 1, 'a fully-checked Ticket awaiting sign-off was filed as done');

  const headline = view.headline.map((run) => run.text).join('');
  assert.match(headline, /finished and off your desk/);
});

test('the Frontier count is stated as a number, and comes from the Snapshot', (t) => {
  const snapshot = snapshotOf(tempTracker(t, BOARD));
  const view = buildView(snapshot);

  assert.equal(view.frontierCount, snapshot.frontierCount);
  assert.equal(view.frontierCount, 1, 'the fixture has no Frontier, so this proves nothing');

  const tile = view.totals.find((total) => /frontier/i.test(total.label));
  assert.ok(tile !== undefined, 'the Frontier is not stated as a number in the header');
  assert.equal(tile.value, String(snapshot.frontierCount));

  const headline = view.headline.map((run) => run.text).join('');
  assert.match(headline, /1 Ticket is claimable by an agent right now/);
});

test('the columns account for every Laned Ticket and for nothing else', (t) => {
  const snapshot = snapshotOf(tempTracker(t, BOARD));
  const view = buildView(snapshot);

  const laned =
    snapshot.counts.blocked +
    snapshot.counts.frozen +
    snapshot.counts.agent +
    snapshot.counts['needs-you'] +
    snapshot.counts['in-progress'] +
    snapshot.counts.complete +
    snapshot.counts.parked;

  assert.equal(view.laneTotal, laned, 'the columns and the Snapshot disagree on how many Tickets are Laned');
  assert.ok(snapshot.counts.unlaned > 0, 'no unlaned Ticket in the fixture, so the exclusion proves nothing');
  assert.equal(view.offBoard.ticketCount, snapshot.counts.unlaned);

  // Per column, against the Snapshot's own per-Lane counts.
  const byKey = new Map(view.columns.map((column) => [column.key, column.count]));
  assert.equal(byKey.get('blocked'), snapshot.counts.blocked + snapshot.counts.frozen);
  assert.equal(byKey.get('agent'), snapshot.counts.agent);
  assert.equal(byKey.get('needs-you'), snapshot.counts['needs-you']);
  assert.equal(byKey.get('in-progress'), snapshot.counts['in-progress']);
  assert.equal(byKey.get('done'), snapshot.counts.complete);
  assert.equal(byKey.get('parked'), snapshot.counts.parked);
});

test('a column counts the cards in it, and says so when the Snapshot disagrees', () => {
  // A header reading 99 over one visible card asserts something the reader can see is false
  // and gives them no way to tell which number to believe. A count over a list of cards has
  // one honest value - how many cards are in the list.
  //
  // But the disagreement is itself information, so it is stated rather than swallowed.
  const skewed = {
    roots: [
      {
        path: '/r',
        label: 'r',
        features: [
          {
            name: 'f',
            tickets: [{ id: 'a', path: 'f/issues/01.md', fileName: '01.md', derivation: { lane: 'agent', state: 'ready' } }],
            siblings: [],
          },
        ],
        orphans: [],
      },
    ],
    counts: { agent: 99, blocked: 0, frozen: 0, 'needs-you': 0, 'in-progress': 0, complete: 0, parked: 0, unlaned: 0 },
    warnings: [],
  };

  const view = buildView(skewed);
  const agent = view.columns.find((column) => column.key === 'agent');
  assert.equal(agent?.count, 1, 'the column reported a count it did not draw');
  assert.equal(view.laneTotal, 1);

  const notice = view.notices.find((entry) => entry.kind === 'count-mismatch');
  assert.ok(notice !== undefined, 'the board drew one card under a Snapshot claiming 99 and said nothing');
  assert.match(notice.message, /agent: the Snapshot counts 99, the board placed 1/);

  // The canary: an agreeing Snapshot raises nothing, so this notice is not simply always on.
  const agreeing = { ...skewed, counts: { ...skewed.counts, agent: 1 } };
  const quiet = buildView(agreeing);
  assert.equal(quiet.columns.find((column) => column.key === 'agent')?.count, 1);
  assert.equal(
    quiet.notices.find((entry) => entry.kind === 'count-mismatch'),
    undefined,
    'an agreeing Snapshot still produced a mismatch notice',
  );

  // And a Snapshot carrying no counts at all raises nothing either: absent is not zero, and a
  // malformed frame must not produce a wall of false alarms.
  const countless = buildView({ roots: skewed.roots, warnings: [] });
  assert.equal(countless.notices.filter((entry) => entry.kind === 'count-mismatch').length, 0);
});

test('the board adds no Lane of its own: every card carries what the Snapshot derived', (t) => {
  const snapshot = snapshotOf(tempTracker(t, BOARD));
  const view = buildView(snapshot);

  const derived = new Map<string, string | null>();
  for (const root of snapshot.roots) {
    for (const feature of root.features) {
      for (const ticket of feature.tickets) derived.set(ticket.id, ticket.derivation.lane);
    }
  }

  let checked = 0;
  for (const card of everyCard(view)) {
    if (card.kind !== 'ticket') continue;
    assert.equal(card.lane, derived.get(card.id), `${card.shortId} shows a Lane the Snapshot did not derive`);
    checked += 1;
  }
  assert.equal(checked, 11, 'the walk found no Ticket cards, so nothing was actually compared');

  // And a card off the board carries no Lane rather than a substitute one.
  for (const group of view.offBoard.groups) {
    for (const card of group.cards) assert.equal(card.lane, null);
  }
});

// ---------------------------------------------------------------------------
// The legend, and what must never enter a Lane
// ---------------------------------------------------------------------------

test('the legend renders unclassified as a labelled specimen, in no Lane and in no count', (t) => {
  const snapshot = snapshotOf(tempTracker(t, BOARD));
  const view = buildView(snapshot);

  const specimen = view.legend.specimens.find((entry) => entry.key === 'unclassified');
  assert.ok(specimen !== undefined, 'the board has no unclassified specimen');
  assert.match(specimen.caption, /unclassified/);
  assert.match(specimen.caption, /specimen/, 'the specimen is not labelled as one');
  assert.equal(specimen.card.specimen, true);
  assert.ok(specimen.card.unclassified !== null, 'the specimen does not show the raw-field treatment');

  // All three Dialect treatments exist, so this is a legend rather than one special case.
  assert.deepEqual(
    view.legend.specimens.map((entry) => entry.key),
    ['task', 'decision', 'unclassified'],
  );

  // Nothing synthetic reaches a column or the off-board list. A specimen counted into a Lane
  // would put every number on the page one out, and the counts are pinned to the Snapshot's.
  for (const card of everyCard(view)) {
    assert.equal(card.specimen, false, `specimen ${card.id} was injected into a Lane`);
  }
  for (const group of view.offBoard.groups) {
    for (const card of group.cards) assert.equal(card.specimen, false);
  }
  const specimenIds = new Set(view.legend.specimens.map((entry) => entry.card.id));
  for (const card of everyCard(view)) {
    assert.ok(!specimenIds.has(card.id), 'a specimen id reached the board');
  }
  assert.equal(view.laneTotal, snapshot.counts.blocked + snapshot.counts.frozen + snapshot.counts.agent +
    snapshot.counts['needs-you'] + snapshot.counts['in-progress'] + snapshot.counts.complete +
    snapshot.counts.parked);
});

test('a Ticket that holds no Lane is listed below the board rather than dropped or placed', (t) => {
  // A file too large to read, so it arrives `unparsed` - the other way a Ticket holds no Lane.
  // The limit is set above every other file in the fixture, so the rest of the board is
  // untouched and the columns below can still be checked against the Snapshot.
  const root = tempTracker(t, { ...BOARD, 'alpha/issues/10-huge.md': `# 10\n${'x'.repeat(400)}\n` });
  const snapshot = deriveSnapshot({ roots: [readTree(root, { maxFileBytes: 120 })] }, EMPTY);
  const view = buildView(snapshot);

  const off = view.offBoard.groups.flatMap((group) => group.cards);
  assert.ok(off.length > 0);
  assert.ok(view.offBoard.linkCount > 0, 'no link file in the fixture, so the mix proves nothing');
  assert.ok(view.offBoard.ticketCount > 0, 'no unplaced Ticket in the fixture');
  assert.equal(view.offBoard.count, view.offBoard.ticketCount + view.offBoard.linkCount);

  const tags = new Set(off.map((card) => card.tag));
  assert.ok(tags.has('link'), 'a schema-less file lost its link tag');
  assert.ok(tags.has('unparsed'), 'a file the parser could not read lost its unparsed tag');

  // And the columns still hold what they held: nothing was quietly moved off the board.
  assert.equal(
    view.laneTotal + view.offBoard.ticketCount,
    snapshot.progress.total,
    'a Ticket is neither in a column nor listed below the board',
  );
});

// ---------------------------------------------------------------------------
// Blocker navigation
// ---------------------------------------------------------------------------

test('a blocker id resolves to the card it names, and a dangling one says so', (t) => {
  const snapshot = snapshotOf(tempTracker(t, BOARD));
  const view = buildView(snapshot);
  const byShort = new Map(everyCard(view).map((card) => [card.shortId, card]));

  const blocked = byShort.get('AL·05');
  assert.ok(blocked !== undefined);
  assert.equal(blocked.blockers.length, 1);
  assert.equal(
    blocked.blockers[0]?.targetId,
    ticketNamed(snapshot, '03-moving.md').id,
    'a blocker id does not point at the card it names, so the navigation cannot find it',
  );
  assert.equal(blocked.blockers[0]?.dangling, false);
  assert.equal(blocked.blockers[0]?.label, 'AL·03');

  // The canary: a dangling reference in the same fixture resolves to nothing and is marked,
  // rather than silently pointing somewhere or disappearing.
  const dangling = byShort.get('AL·08');
  assert.ok(dangling !== undefined);
  assert.equal(dangling.blockers.length, 1, 'the dangling reference was dropped from the card');
  assert.equal(dangling.blockers[0]?.targetId, null);
  assert.equal(dangling.blockers[0]?.dangling, true);

  // A satisfied blocker keeps its reference too - a card listing only what is still open
  // cannot be told apart from a card whose Blocked-by line was never parsed.
  const external = byShort.get('AL·09');
  assert.ok(external !== undefined);
  assert.equal(external.blockers.length, 0);
  assert.equal(external.externalBlocker, 'a vendor contract', 'an external blocker vanished');

  // And a card with nothing blocking it carries an empty list rather than a placeholder.
  assert.deepEqual(byShort.get('AL·06')?.blockers, []);
});

test('a blocker resolves inside its own Feature, never across Features', (t) => {
  // Ticket numbers are Feature-local. Two Features reusing the same Ticket number is the ordinary
  // case, not an edge case, and resolving across them would point the reader at a stranger.
  // Constructed as the case the code would get wrong: identical numbers, different Features.
  const snapshot = snapshotOf(
    tempTracker(t, {
      'alpha/issues/01-first.md': '# 01 - First\n\n- [x] one\n',
      'alpha/issues/02-second.md': '# 02 - Second\n\n**Blocked by:** 01\n\n- [ ] one\n',
      'beta/issues/01-first.md': '# 01 - First\n\n- [ ] one\n',
      'beta/issues/02-second.md': '# 02 - Second\n\n**Blocked by:** 01\n\n- [ ] one\n',
    }),
  );
  const view = buildView(snapshot);
  const cards = everyCard(view);

  const alphaSecond = cards.find((card) => card.fileName === '02-second.md' && card.featureName === 'alpha');
  const betaSecond = cards.find((card) => card.fileName === '02-second.md' && card.featureName === 'beta');
  assert.ok(alphaSecond !== undefined && betaSecond !== undefined);

  const alphaFirst = ticketNamed(snapshot, '01-first.md', 'alpha');
  const betaFirst = ticketNamed(snapshot, '01-first.md', 'beta');
  assert.notEqual(alphaFirst.id, betaFirst.id);

  assert.equal(alphaSecond.blockers[0]?.targetId, alphaFirst.id);
  assert.equal(betaSecond.blockers[0]?.targetId, betaFirst.id, 'a blocker resolved across Features');

  // Their satisfied-ness differs, which is what makes the mix-up detectable at all.
  assert.equal(alphaSecond.blockers[0]?.satisfied, true);
  assert.equal(betaSecond.blockers[0]?.satisfied, false);
});

// ---------------------------------------------------------------------------
// Identity, keys and ordering
// ---------------------------------------------------------------------------

test('a card is keyed by the Snapshot id, not by anything this file invents', (t) => {
  // The renderer patches by key, and the blocker navigation finds a card by it. Deriving one
  // here would be rebuilding a shape the Snapshot already carries.
  const root = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n\n- [ ] one\n' });
  const snapshot = snapshotOf(root);
  const card = everyCard(buildView(snapshot))[0];
  const ticket = snapshot.roots[0]?.features[0]?.tickets[0];

  assert.ok(card !== undefined && ticket !== undefined);
  assert.equal(card.id, ticket.id);
});

test('card keys are unique across Roots holding identical relative paths', (t) => {
  const first = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n', 'alpha/spec.md': '# S\n' });
  const second = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n', 'alpha/spec.md': '# S\n' });
  const view = buildView(deriveSnapshot({ roots: [readTree(first), readTree(second)] }, EMPTY));

  const cards = [...everyCard(view), ...view.offBoard.groups.flatMap((group) => group.cards)];
  const ids = cards.map((card) => card.id);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4, 'two Roots collided on a card key, so one card would overwrite the other');

  const groupKeys = view.offBoard.groups.map((group) => group.key);
  assert.equal(new Set(groupKeys).size, groupKeys.length, 'two Features named alpha collided on a group key');
});

test('keys are printable and stay distinct when a name contains the separator', (t) => {
  // These name DOM nodes the renderer patches in place, so a collision silently overwrites a
  // card. Feature names are directory names and `#` is legal in one everywhere the board runs,
  // so the separator is not a safe assumption - the Root is length-prefixed for that reason.
  //
  // Printability is asserted rather than assumed: an earlier revision of this used control
  // characters as separators, which are invisible in every normal view of the source and are
  // reserved elsewhere in the project as an annotation-key separator.
  const root = tempTracker(t, {
    'a#F#b/issues/01-a.md': '# 01 - A\n\n- [ ] one\n',
    'a/issues/01-a.md': '# 01 - A\n\n- [ ] one\n',
    'loose files/issues/01-a.md': '# 01 - A\n\n- [ ] one\n',
    'stray.md': '# outside any Feature\n',
  });
  const view = buildView(snapshotOf(root));

  const cards = [...everyCard(view), ...view.offBoard.groups.flatMap((group) => group.cards)];
  const keys = [
    ...view.offBoard.groups.map((group) => group.key),
    ...view.columns.flatMap((column) =>
      column.sublanes.flatMap((sublane) => sublane.groups.map((group) => group.key)),
    ),
    ...cards.map((card) => card.id),
  ];
  assert.equal(new Set(keys).size, keys.length, 'two keys collided, so one node would overwrite another');
  for (const key of keys) {
    assert.ok(
      [...key].every((char) => (char.codePointAt(0) ?? 0) >= 0x20),
      `key contains a control character: ${JSON.stringify(key)}`,
    );
  }
  assert.ok(
    view.offBoard.groups.some(
      (group) => group.featureName === 'loose files' && group.cards[0]?.kind === 'orphan',
    ),
    'the orphan group and a Feature genuinely named "loose files" were merged',
  );
});

test('two Roots cannot collide on a group key, however their paths are punctuated', (t) => {
  // The length prefix only earns its place across *Roots*: a single Root cannot produce a
  // collision by joining on a separator, so a one-Root test passes with the prefix deleted -
  // which is exactly what a mutation run showed. Root `<a>#b` + feature `c` and Root `<a>` +
  // feature `b#c` are the pair that collapse under a naive join.
  const outer = tempTracker(t, { 'c/issues/01-a.md': '# 01 - A\n' });
  const inner = tempTracker(t, { 'b#c/issues/01-a.md': '# 01 - A\n' });

  // Name the two Roots so that `<rootA>#<featureA>` and `<rootB>#<featureB>` would be equal.
  const view = buildView({
    roots: [
      {
        path: `${inner}#b`,
        label: 'a',
        features: [{ name: 'c', tickets: [], siblings: [{ path: 'x.md', absPath: 'x', label: 'x' }] }],
        orphans: [],
      },
      {
        path: inner,
        label: 'b',
        features: [{ name: 'b#c', tickets: [], siblings: [{ path: 'x.md', absPath: 'x', label: 'x' }] }],
        orphans: [],
      },
    ],
    warnings: [],
  });

  assert.equal(view.offBoard.groups.length, 2);
  assert.notEqual(
    view.offBoard.groups[0]?.key,
    view.offBoard.groups[1]?.key,
    'two Roots produced one group key, so one Feature would silently overwrite the other',
  );
  assert.ok(outer.length > 0);
});

test('cards stay in the order the seam produced them', (t) => {
  const snapshot = snapshotOf(tempTracker(t, BOARD));
  const view = buildView(snapshot);
  const order = new Map<string, number>();
  let index = 0;
  for (const root of snapshot.roots) {
    for (const feature of root.features) {
      for (const ticket of feature.tickets) order.set(ticket.id, (index += 1));
    }
  }

  for (const column of view.columns) {
    for (const sublane of column.sublanes) {
      for (const group of sublane.groups) {
        const positions = group.cards.map((card) => order.get(card.id) ?? 0);
        assert.deepEqual(
          [...positions].sort((a, b) => a - b),
          positions,
          `column ${column.key} reordered the Tickets the seam had already ordered`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test('every scanned file is represented, as a card in a column or as one below the board', (t) => {
  const view = buildView(
    snapshotOf(
      tempTracker(t, {
        'alpha/issues/01-first.md': '# 01 - First\n\n- [ ] one\n',
        'alpha/issues/02-second.md': '# 02 - Second\n\n- [ ] one\n',
        'alpha/spec.md': '# Spec\n',
        'beta/issues/03-third.md': '# 03 - Third\n\n- [ ] one\n',
        'loose.md': '# a file outside any Feature\n',
      }),
    ),
  );

  const names = [
    ...everyCard(view).map((card) => card.fileName),
    ...view.offBoard.groups.flatMap((group) => group.cards.map((card) => card.fileName)),
  ].sort();
  assert.deepEqual(names, ['01-first.md', '02-second.md', '03-third.md', 'loose.md', 'spec.md']);
  assert.equal(view.fileCount, 5, 'a file the board silently omitted reads as a file that is not there');
  assert.equal(view.empty, false);
});

test('an unreadable file keeps its filename and carries its reason', (t) => {
  const root = tempTracker(t, {
    'alpha/issues/01-small.md': '# 01 - A\n\n- [ ] one\n',
    'alpha/issues/02-huge.md': `# 02\n${'x'.repeat(400)}\n`,
  });
  const snapshot = deriveSnapshot({ roots: [readTree(root, { maxFileBytes: 64 })] }, EMPTY);
  const view = buildView(snapshot);
  const card = view.offBoard.groups
    .flatMap((group) => group.cards)
    .find((entry) => entry.fileName === '02-huge.md');

  assert.ok(card !== undefined, 'a file that could not be read lost its card');
  assert.equal(card.state, 'unparsed');
  assert.equal(card.tag, 'unparsed');
  assert.match(card.detail, /read limit/, 'the card does not say why it is unparsed');
});

test('warnings reach the view, so an omission is visible on the page', (t) => {
  const root = tempTracker(t, {
    'alpha/issues/01-a.md': '# 01 - A\n\n- [ ] one\n',
    'detached/.git': 'gitdir: /elsewhere/.git/worktrees/detached\n',
    'detached/issues/99-hidden.md': '# 99\n',
  });
  const view = buildView(snapshotOf(root));

  assert.ok(
    view.notices.some((notice) => notice.kind === 'hidden-worktrees' && /1 worktree/.test(notice.message)),
    'a skipped worktree was counted by the walk and then dropped before the page',
  );
  // The canary: the board below the notice is still populated, so this is not a total failure
  // reading as a warning.
  assert.equal(view.laneTotal, 1);
});

test('an unsupported tracker reaches the view as its own notice', (t) => {
  const remote = ['git', '@', 'github.com:o/r.git'].join('');
  const root = tempTracker(t, {}, { '.git/config': `[remote "origin"]\n\turl = ${remote}\n` });
  assert.ok(
    buildView(snapshotOf(root)).notices.some((notice) => notice.kind === 'unsupported-tracker'),
    'a repo the board cannot read must say so rather than render as empty',
  );
});

test('the summary line distinguishes nothing-registered from nothing-tracked', (t) => {
  assert.match(summarise(buildView(deriveSnapshot({ roots: [] }, EMPTY))), /No repository/);

  const bare = tempTracker(t, {});
  assert.match(summarise(buildView(snapshotOf(bare))), /nothing tracked yet/);

  const full = tempTracker(t, { 'alpha/issues/01-a.md': '# 01 - A\n' });
  assert.match(summarise(buildView(snapshotOf(full))), /1 file across 1 feature in 1 repository/);
});

test('the view never throws, whatever arrives over the socket', () => {
  // It arrives as JSON from a socket, and a board that blanks on one malformed field is worse
  // than a board that draws what it understood.
  const malformed: unknown[] = [
    undefined,
    null,
    7,
    'a string',
    {},
    { roots: 'not a list' },
    { roots: [null] },
    { roots: [{ features: [{ tickets: [null, 7, {}] }] }] },
    { roots: [{ features: 'no' }], warnings: [{ kind: 5, message: null }] },
    // A Lane name that is not one of the seven, and one that names a property every object
    // has. Either would drop cards silently if the Lane were trusted rather than checked.
    { roots: [{ features: [{ tickets: [{ id: 'a', derivation: { lane: 'made-up' } }] }] }] },
    { roots: [{ features: [{ tickets: [{ id: 'b', derivation: { lane: 'constructor' } }] }] }] },
    { roots: [{ features: [{ tickets: [{ id: 'c', derivation: { lane: '__proto__' } }] }] }] },
    // And the same trick through the *state*, which is the door a card without a Lane goes
    // through. A mutation run found this: the Lane was checked and the state was not, so the
    // hostile name had to arrive here to reach the tag lookup at all.
    { roots: [{ features: [{ tickets: [{ id: 'd', derivation: { state: 'constructor' } }] }] }] },
    { roots: [{ features: [{ tickets: [{ id: 'e', derivation: { state: '__proto__' } }] }] }] },
    { roots: [{ features: [{ tickets: [{ id: 'f', derivation: { state: 'toString' } }] }] }] },
    JSON.parse('{"roots":[{"path":"/r","features":[{"name":"f","tickets":[{"id":"x"}]}]}]}'),
  ];
  for (const input of malformed) {
    const view = buildView(input);
    assert.equal(view.columns.length, 6, `the six columns did not survive ${JSON.stringify(input)}`);
    assert.equal(typeof summarise(view), 'string');
    assert.equal(view.legend.specimens.length, 3);
    for (const column of view.columns) assert.equal(typeof column.count, 'number');

    // Every displayed value is a string, whatever arrived. A Lane name off the socket is used
    // to look up this module's own tables, so `constructor` and `__proto__` would return a
    // function and a prototype from a plain object literal - and the renderer would set that
    // as the text of a tag. The lookup guards against it; this is what proves the guard runs.
    for (const group of view.offBoard.groups) {
      for (const card of group.cards) {
        assert.equal(typeof card.tag, 'string', `card ${card.id} carries a non-string tag`);
        assert.equal(typeof card.tagGlyph, 'string', `card ${card.id} carries a non-string glyph`);
      }
    }
  }

  // A card carrying an unknown Lane is listed below the board rather than dropped.
  const strange = buildView({
    roots: [{ path: '/r', features: [{ name: 'f', tickets: [{ id: 'x', derivation: { lane: 'made-up' } }] }] }],
  });
  assert.equal(strange.laneTotal, 0);
  assert.equal(strange.offBoard.ticketCount, 1, 'a card with an unreadable Lane was dropped');
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('building the view stays linear in the number of cards', (t) => {
  // The board re-renders on every change event, and an agent rewrites a file every few
  // seconds. A quadratic step here would be invisible against the fixtures above and would
  // show up only on a real tracker - so it is measured at a size larger than any fixture uses.
  const small = tempTracker(t, spread(60));
  const large = tempTracker(t, spread(600));
  const smallSnapshot = snapshotOf(small);
  const largeSnapshot = snapshotOf(large);

  assert.equal(buildView(largeSnapshot).ticketCount, 600);

  const smallMs = timeOf(() => buildView(smallSnapshot));
  const largeMs = timeOf(() => buildView(largeSnapshot));

  // Ten times the cards. A linear pass lands near ten times the work; the bound is loose
  // because this is a wall clock on a shared machine, and it still fails a quadratic pass by
  // an order of magnitude.
  assert.ok(
    largeMs < smallMs * 40 + 60,
    `buildView took ${largeMs.toFixed(1)}ms at 600 cards against ${smallMs.toFixed(1)}ms at 60`,
  );
});

test('building the view stays linear when the Frontier is frozen behind one person', (t) => {
  // The test above populates ordinary cards, but the expensive path is Frozen-chain
  // resolution; a fixture with no Frozen cards never touches it. Measured before the fix:
  // 5.3 ms at 500 Tickets, 17.8 at 1000, 70.3 at 2000, 278.5 at 4000, on the render path.
  //
  // One human gate with everything behind it is not a contrived shape. It is the shape the
  // Frozen Lane exists to describe, so it is the shape the cost has to be measured on.
  const small = tempTracker(t, frozenBehindOne(100));
  const large = tempTracker(t, frozenBehindOne(2000));
  const smallSnapshot = snapshotOf(small);
  const largeSnapshot = snapshotOf(large);

  const view = buildView(largeSnapshot);
  assert.equal(view.columns[0]?.sublanes[0]?.count, 1999, 'the fixture produced no Frozen cards at all');
  assert.ok(
    view.columns[0]?.sublanes[0]?.groups[0]?.cards[0]?.frozen?.targetLabel !== '',
    'the Frozen cards resolved no terminal Ticket, so the expensive path was never taken',
  );

  // A ratio rather than a budget, because a wall clock on a shared machine says more about the
  // machine than about the code, and a ratio cancels that out. Twenty times the cards: a linear
  // pass lands near twenty times the work and a quadratic one near four hundred. The first
  // version of this bound was an absolute budget loose enough that the quadratic pass fitted
  // inside it, so the mutation survived - which is the whole reason the battery is run.
  const smallMs = median(() => buildView(smallSnapshot));
  const largeMs = median(() => buildView(largeSnapshot));
  const growth = largeMs / Math.max(smallMs, 0.02);

  assert.ok(
    growth < 60,
    `buildView grew ${growth.toFixed(0)}x for 20x the frozen cards ` +
      `(${smallMs.toFixed(2)}ms at 100, ${largeMs.toFixed(2)}ms at 2000). Linear is about 20x.`,
  );
});

// ---------------------------------------------------------------------------

type ViewOf = ReturnType<typeof buildView>;
type CardOf = ViewOf['columns'][number]['sublanes'][number]['groups'][number]['cards'][number];

/** Every card the board placed in a column. */
function everyCard(view: ViewOf): CardOf[] {
  return view.columns.flatMap((column) =>
    column.sublanes.flatMap((sublane) => sublane.groups.flatMap((group) => group.cards)),
  );
}

function cardsIn(view: ViewOf, columnKey: string, lane: string): CardOf[] {
  const column = view.columns.find((entry) => entry.key === columnKey);
  const sublane = column?.sublanes.find((entry) => entry.lane === lane);
  return (sublane?.groups ?? []).flatMap((group) => group.cards);
}

/** A Ticket off the Snapshot by file name, so an expectation never retypes an id. */
function ticketNamed(snapshot: Snapshot, fileName: string, feature?: string) {
  for (const root of snapshot.roots) {
    for (const entry of root.features) {
      if (feature !== undefined && entry.name !== feature) continue;
      for (const ticket of entry.tickets) if (ticket.fileName === fileName) return ticket;
    }
  }
  throw new Error(`no Ticket named ${fileName} in the Snapshot`);
}

function timeOf(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** Median of nine runs after a warm-up, so one scheduling hiccup cannot decide a comparison. */
function median(run: () => unknown): number {
  run();
  run();
  const samples = Array.from({ length: 9 }, () => timeOf(run)).sort((a, b) => a - b);
  return samples[4] ?? 0;
}

/**
 * One human-gated Ticket with `n - 1` Tickets blocked directly on it, in a single Feature.
 * Every one of those is Frozen, which is the shape the Frozen chain resolution costs most on.
 */
function frozenBehindOne(n: number): Record<string, string> {
  const files: Record<string, string> = {
    'f/issues/0001-gate.md': '# 1 - Gate\n\n**Status:** ready-for-human\n\n- [ ] one\n',
  };
  for (let index = 2; index <= n; index += 1) {
    files[`f/issues/${String(index).padStart(4, '0')}-t.md`] =
      `# ${String(index)} - T\n\n**Blocked by:** 1\n\n- [ ] one\n`;
  }
  return files;
}

/** `n` Tickets spread over ten Features, each blocked by the one before it. */
function spread(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 1; index <= n; index += 1) {
    const feature = `f${String(index % 10)}`;
    const local = Math.ceil(index / 10);
    const blocked = local > 1 ? `**Blocked by:** ${String(local - 1)}\n\n` : '';
    files[`${feature}/issues/${String(local).padStart(3, '0')}-t.md`] =
      `# ${String(local)} - T\n\n${blocked}- [ ] one\n`;
  }
  return files;
}

function snapshotOf(root: string): Snapshot {
  return deriveSnapshot({ roots: [readTree(root)] }, EMPTY);
}

/** A tracker tree under `os.tmpdir()`, removed afterwards. `extra` writes outside `.scratch`. */
function tempTracker(
  t: { after(fn: () => void): void },
  files: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'tracker-board-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.scratch'), { recursive: true });
  for (const [relPath, text] of Object.entries(files)) {
    const abs = join(root, '.scratch', ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  for (const [relPath, text] of Object.entries(extra)) {
    const abs = join(root, ...relPath.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return root;
}
