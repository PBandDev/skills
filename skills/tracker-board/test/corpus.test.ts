/**
 * The whole-tree corpus check — the only thing capable of catching a graph bug at all.
 *
 * Unit fixtures structurally cannot catch this class. Fictional dependency edges can leave
 * **every Lane unchanged** when all affected Tickets are already finished, because blockers
 * gate only incomplete work. The board can look perfect while the graph is fiction.
 *
 * **Two artifacts, and neither is worth anything alone.**
 *
 *   - `fixtures/corpus.expected.json` is generated from a green parser by
 *     `tools/build-corpus-golden.ts` and committed. It catches regressions: any change to
 *     any rule that moves any field on any card turns this red.
 *   - The table in `fixtures/expected.md` is hand-derived from the rules, independently of
 *     the code, and is transcribed into literal assertions below. It catches the golden
 *     being wrong.
 *
 * The golden is produced by the code it is meant to check, so without the transcribed table
 * the whole thing would be circular — it would prove only that the parser agrees with
 * itself. The transcription is deliberately verbose and deliberately literal: it is meant to
 * be read side by side with the markdown table and diffed by eye.
 *
 * The prose column of that table ("why this Lane and not the obvious one") stays prose. It
 * is the rationale for the row, not a second claim to assert.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSnapshot } from '../core/index.ts';
import { CORPUS_FILES, corpusFiles, corpusScan, toLf } from './corpus-tree.ts';
import { goldenText } from '../tools/build-corpus-golden.ts';
import { EMPTY_ANNOTATIONS } from './harness.ts';
import type { Lane, Snapshot, TicketCard } from '../core/types.ts';

const GOLDEN_PATH = join(import.meta.dirname, 'fixtures', 'corpus.expected.json');

// ---------------------------------------------------------------------------
// The tree the golden describes
// ---------------------------------------------------------------------------

test('the corpus holds exactly the files the golden describes', () => {
  // Stated, not counted. The golden lives one directory **above** this tree precisely so
  // that walking the corpus cannot pick it up, and this is what proves it did not: a
  // `.json` appearing here would show up as a thirteenth entry and as an extra card.
  assert.deepEqual([...corpusFiles()], [...CORPUS_FILES]);
  assert.ok(
    !corpusFiles().some((path) => path.endsWith('.json')),
    'corpus.expected.json is being walked as a corpus fixture — the golden is describing itself',
  );
});

test('the corpus is three Features with the three sibling shapes, and ten Tickets', () => {
  // `expected.md`: search-ranking has map.md and no spec.md; checkout-flow has spec.md and
  // no map.md; design-system has neither. All three must render.
  const features = snapshot().roots[0]?.features ?? [];
  assert.deepEqual(features.map((feature) => feature.name), [
    'checkout-flow',
    'design-system',
    'search-ranking',
  ]);

  const shapes = features.map((feature) => [
    feature.name,
    feature.specPath === null ? 'no spec' : 'spec',
    feature.mapPath === null ? 'no map' : 'map',
  ]);
  assert.deepEqual(shapes, [
    ['checkout-flow', 'spec', 'no map'],
    ['design-system', 'no spec', 'no map'],
    ['search-ranking', 'no spec', 'map'],
  ]);
  assert.equal(cards().length, 10, 'the corpus is pinned at ten Tickets');
});

// ---------------------------------------------------------------------------
// The golden
// ---------------------------------------------------------------------------

test('the committed golden is exactly what the parser produces now', () => {
  assert.equal(
    toLf(readFileSync(GOLDEN_PATH, 'utf8')),
    goldenText(),
    'corpus.expected.json no longer matches the parser. Regenerate it with `node tools/build-corpus-golden.ts --write` — and then read the diff, because a golden that moved without a rule changing is the parser telling you something.',
  );
});

test('the golden is a Snapshot, not a summary of one', () => {
  // Read back and compared structurally as well as textually, so a golden that happened to
  // serialise identically from a different shape could not slip through.
  assert.deepEqual(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')), JSON.parse(JSON.stringify(snapshot())));
});

test('the golden check survives a CRLF checkout', () => {
  // This repository carries no `.gitattributes`, so a machine with `core.autocrlf=true`
  // rewrites the golden to CRLF on checkout. Comparing raw text against generated LF then
  // fails on a fresh Windows clone while the JSON is structurally identical — which reads as
  // "the parser regressed" and is nothing of the kind. Both sides normalise; this is the
  // assertion that says so, rather than the comparison quietly depending on a git setting.
  const asCheckedOutOnWindows = goldenText().split('\n').join('\r\n');
  assert.notEqual(asCheckedOutOnWindows, goldenText(), 'the fixture for this test is not actually CRLF');
  assert.equal(toLf(asCheckedOutOnWindows), goldenText());
  assert.deepEqual(
    JSON.parse(asCheckedOutOnWindows),
    JSON.parse(goldenText()),
    'a CRLF checkout must still parse to the same Snapshot',
  );
});

// ---------------------------------------------------------------------------
// `expected.md`, transcribed. Hand-derived from the rules; independent of the code above.
// ---------------------------------------------------------------------------

/** The Lane display names `expected.md` uses, mapped once to the seven Lane values. */
const LANE_OF_COLUMN: Readonly<Record<string, Lane>> = {
  'Needs you': 'needs-you',
  Done: 'complete',
  'Frozen on you': 'frozen',
  'Agent can take': 'agent',
  Blocked: 'blocked',
  Parked: 'parked',
  'In progress': 'in-progress',
};

interface Row {
  readonly feature: string;
  readonly number: number;
  readonly dialect: string;
  /** The `Blockers` column. `—` and `none` both derive to no blockers, for different reasons. */
  readonly blockers: readonly number[];
  /** The `Criteria` column. `—` in the table means the Ticket carries no checkbox list. */
  readonly criteria: readonly [number, number];
  /** The `Lane` column, verbatim as the table spells it. */
  readonly column: string;
}

const TABLE: readonly Row[] = [
  { feature: 'search-ranking', number: 2, dialect: 'decision', blockers: [], criteria: [0, 0], column: 'Needs you' },
  { feature: 'search-ranking', number: 3, dialect: 'decision', blockers: [], criteria: [0, 0], column: 'Done' },
  { feature: 'search-ranking', number: 9, dialect: 'decision', blockers: [2], criteria: [0, 0], column: 'Frozen on you' },
  { feature: 'search-ranking', number: 10, dialect: 'decision', blockers: [], criteria: [0, 0], column: 'Agent can take' },
  { feature: 'search-ranking', number: 11, dialect: 'decision', blockers: [2, 9], criteria: [0, 0], column: 'Frozen on you' },
  { feature: 'search-ranking', number: 16, dialect: 'decision', blockers: [9, 10], criteria: [0, 0], column: 'Blocked' },
  { feature: 'checkout-flow', number: 1, dialect: 'task', blockers: [], criteria: [2, 2], column: 'Done' },
  { feature: 'checkout-flow', number: 2, dialect: 'task', blockers: [], criteria: [0, 2], column: 'Agent can take' },
  { feature: 'checkout-flow', number: 3, dialect: 'task', blockers: [2], criteria: [3, 3], column: 'Needs you' },
  { feature: 'design-system', number: 12, dialect: 'task', blockers: [], criteria: [0, 2], column: 'Parked' },
];

test('every row of expected.md holds', () => {
  assert.equal(TABLE.length, 10, 'the transcription lost a row');
  for (const row of TABLE) {
    const where = `${row.feature} #${String(row.number).padStart(2, '0')}`;
    const card = cardFor(row.feature, row.number);
    assert.equal(card.extraction.dialect, row.dialect, `${where}: Dialect`);
    assert.deepEqual([...card.extraction.blockedBy], [...row.blockers], `${where}: Blockers`);
    assert.deepEqual(
      [card.extraction.criteria.checked, card.extraction.criteria.total],
      [...row.criteria],
      `${where}: Criteria`,
    );
    const lane = LANE_OF_COLUMN[row.column];
    assert.ok(lane !== undefined, `${where}: "${row.column}" is not a column expected.md names`);
    assert.equal(card.derivation.lane, lane, `${where}: Lane — the table says ${row.column}`);
  }
});

test('the Lane counts in expected.md hold', () => {
  // `1 blocked · 2 frozen on you · 2 agent can take · 2 needs you · 0 in progress · 2 done ·
  //  1 parked = 10`. Seven Lanes, six columns — frozen and blocked share the Blocked column.
  assert.deepEqual(snapshot().counts, {
    blocked: 1,
    frozen: 2,
    agent: 2,
    'needs-you': 2,
    'in-progress': 0,
    complete: 2,
    parked: 1,
    unlaned: 0,
  });
  assert.equal(
    Object.values(snapshot().counts).reduce((sum, count) => sum + count, 0),
    10,
    'the Lane counts no longer add up to the ten Tickets in the corpus',
  );
});

test('the Frontier is 2, and it is the two lines a naive parser gets wrong', () => {
  const board = snapshot();
  assert.equal(board.frontierCount, 2);

  const onFrontier = cards().filter((card) => card.derivation.onFrontier);
  assert.deepEqual(
    onFrontier.map((card) => card.fileName).sort(),
    ['02-prefactor-loader-seams.md', '10-name-the-launch-date.md'],
    'expected.md names search-ranking #10 and checkout-flow #02. Both reach the Frontier only by parsing a blocker line correctly that a naive parser gets wrong.',
  );

  // The per-Feature lists carry ids, and they are the same cards. Both sides read off the
  // Snapshot — nothing here rebuilds an id from a Root path and a relative path.
  const listed = (board.roots[0]?.features ?? []).flatMap((feature) => [...feature.frontier]).sort();
  assert.deepEqual(listed, onFrontier.map((card) => card.id).sort());
});

test('Done is 2 of 10, and the label says what it counts', () => {
  const { progress } = snapshot();
  assert.deepEqual(
    [progress.doneCount, progress.total, progress.percent],
    [2, 10, 20],
    'Done = 2 of 10 = 20%',
  );
  assert.equal(progress.label, 'finished and off your desk');

  // The row the figure exists to be careful about: every box checked, and deliberately not
  // counted, because `ready-for-human` moved it. The figure moves without any work undone.
  const signOff = cardFor('checkout-flow', 3);
  assert.deepEqual(
    [signOff.extraction.criteria.checked, signOff.extraction.criteria.total],
    [3, 3],
  );
  assert.equal(signOff.derivation.state, 'done-awaiting-human');
  assert.equal(signOff.derivation.lane, 'needs-you');
  assert.equal(
    cards().filter((card) => card.derivation.lane === 'complete').length,
    2,
    'a Ticket with every box checked was counted into Done while it was still waiting on a person',
  );
});

test('each Frozen card names its terminal human Ticket by id', () => {
  // Both search-ranking chains end at 02 — the HITL relay — however many hops away it is.
  const relay = cardFor('search-ranking', 2);
  assert.equal(relay.derivation.lane, 'needs-you');
  for (const number of [9, 11]) {
    const card = cardFor('search-ranking', number);
    assert.equal(card.derivation.lane, 'frozen', `search-ranking #${number}`);
    assert.equal(card.derivation.frozenOn, relay.id, `search-ranking #${number} names the wrong terminal`);
  }
  for (const card of cards()) {
    if (card.derivation.lane === 'frozen') continue;
    assert.equal(card.derivation.frozenOn, null, `${card.fileName} is not Frozen but names a terminal`);
  }
});

test('no corpus Ticket has a dangling blocker', () => {
  // Every number the corpus writes resolves. If one stopped resolving, the affected cards
  // would still read as Blocked — the same Lane, for a completely different reason — so the
  // dangling channel is asserted directly rather than inferred from a Lane that did not move.
  for (const card of cards()) {
    assert.deepEqual([...card.derivation.danglingBlockers], [], `${card.fileName} has a dangling blocker`);
  }
});

// ---------------------------------------------------------------------------
// The one that moves everything
// ---------------------------------------------------------------------------

test('mis-parsing the search-ranking #10 parenthetical moves cards and Lane counts', () => {
  // `Blocked by: — (was 02, 03; …)` states **no** blockers. A digit scan reads [2,3].
  // Nothing else in the corpus has this blast radius from one line. The fixture on disk is
  // not touched: the mutation is applied to the text on its way into the seam.
  const base = snapshot();
  const mutated = deriveSnapshot(
    corpusScan((path, text) =>
      path.endsWith('10-name-the-launch-date.md')
        ? text.replace(/^Blocked by:.*$/m, 'Blocked by: 02, 03')
        : text,
    ),
    EMPTY_ANNOTATIONS,
  );
  assert.deepEqual(
    [...cardIn(mutated, 'search-ranking', 10).extraction.blockedBy],
    [2, 3],
    'the mutation did not take, so this test proves nothing',
  );

  // The three movements expected.md enumerates, each asserted on its own.
  const ten = cardIn(mutated, 'search-ranking', 10);
  assert.equal(ten.derivation.lane, 'frozen', '10 must leave the agent Lane for Frozen');
  assert.equal(ten.derivation.onFrontier, false);
  assert.equal(
    cardIn(mutated, 'search-ranking', 16).derivation.lane,
    'frozen',
    '16 must flip from Blocked to Frozen — its last non-human path disappeared',
  );
  assert.deepEqual([base.frontierCount, mutated.frontierCount], [2, 1], 'the Frontier must drop 2 -> 1');

  // The measured blast radius. NOTE: the summary sentence in `expected.md` says "three cards
  // move and two lane counts change"; the enumeration in that same sentence lists the two
  // card movements asserted above, and the counts below are what the parser produces. The
  // discrepancy is in the summary, not in any table row, and has been raised rather than
  // reconciled here — neither side is adjusted to fit the other.
  const moved = cards(base).filter((card) => {
    const after = cards(mutated).find((candidate) => candidate.id === card.id);
    return after === undefined || after.derivation.lane !== card.derivation.lane;
  });
  assert.deepEqual(
    moved.map((card) => card.fileName).sort(),
    ['10-name-the-launch-date.md', '16-regenerate-after-certification.md'],
  );
  const changed = (Object.keys(base.counts) as (keyof typeof base.counts)[]).filter(
    (lane) => base.counts[lane] !== mutated.counts[lane],
  );
  assert.deepEqual(changed.sort(), ['agent', 'blocked', 'frozen']);
  assert.deepEqual(
    changed.map((lane) => [lane, base.counts[lane], mutated.counts[lane]]),
    [
      ['agent', 2, 1],
      ['blocked', 1, 0],
      ['frozen', 2, 4],
    ],
  );
});

test('the checkout-flow #02 parenthetical is the other one a digit scan inverts', () => {
  // `none. Do BEFORE 03` — a digit scan reads [3] and inverts the dependency direction.
  const mutated = deriveSnapshot(
    corpusScan((path, text) =>
      path.endsWith('02-prefactor-loader-seams.md')
        ? text.replace(/\*\*Blocked by:\*\*[\s\S]*?\n\n/, '**Blocked by:** 03\n\n')
        : text,
    ),
    EMPTY_ANNOTATIONS,
  );
  const two = cardIn(mutated, 'checkout-flow', 2);
  assert.deepEqual([...two.extraction.blockedBy], [3], 'the mutation did not take');
  // Not merely Blocked: 03 is the 3/3 Ticket sitting in the human Lane awaiting sign-off, so
  // the inverted edge terminates at a person and the card reads "nothing happens until you
  // act" — about the one Ticket in this Feature an agent could have picked up immediately.
  assert.equal(two.derivation.lane, 'frozen');
  assert.equal(two.derivation.frozenOn, cardIn(mutated, 'checkout-flow', 3).id);
  assert.equal(two.derivation.onFrontier, false);
  assert.equal(mutated.frontierCount, 1, 'reading the direction backwards must cost the Frontier');
});

// ---------------------------------------------------------------------------
// Portability of the golden
// ---------------------------------------------------------------------------

test('the derivation does not depend on how the corpus was checked out', () => {
  // `core.autocrlf` decides whether a checkout writes LF or CRLF. The golden is generated
  // from LF text so it is the same file on every machine; this is what says that choice
  // costs nothing — every Lane, state, terminal and blocker list survives CRLF unchanged.
  // `contentSha` is deliberately not compared: it is a hash of the bytes, and the bytes do
  // differ.
  const crlf = deriveSnapshot(
    corpusScan((_path, text) => text.split('\n').join('\r\n')),
    EMPTY_ANNOTATIONS,
  );
  assert.deepEqual(shapeOf(crlf), shapeOf(snapshot()));
  assert.equal(crlf.frontierCount, 2);
});

function shapeOf(board: Snapshot): unknown {
  return cards(board).map((card) => [
    card.path,
    card.extraction.dialect,
    [...card.extraction.blockedBy],
    card.extraction.criteria.checked,
    card.extraction.criteria.total,
    card.derivation.state,
    card.derivation.lane,
    card.derivation.frozenOn,
    card.derivation.onFrontier,
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cached: Snapshot | null = null;

function snapshot(): Snapshot {
  cached ??= deriveSnapshot(corpusScan(), EMPTY_ANNOTATIONS);
  return cached;
}

function cards(board: Snapshot = snapshot()): readonly TicketCard[] {
  return board.roots.flatMap((root) => root.features.flatMap((feature) => feature.tickets));
}

function cardFor(feature: string, number: number): TicketCard {
  return cardIn(snapshot(), feature, number);
}

/** Looked up by Feature and Ticket number, both observable on the card. */
function cardIn(board: Snapshot, feature: string, number: number): TicketCard {
  const found = (board.roots[0]?.features.find((candidate) => candidate.name === feature)?.tickets ?? [])
    .filter((ticket) => ticket.extraction.number === number);
  assert.equal(found.length, 1, `${feature} #${number} matched ${found.length} cards, expected exactly 1`);
  const card = found[0];
  assert.ok(card !== undefined);
  return card;
}
