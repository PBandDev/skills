/**
 * The two Dialect ladders and the Lane ordering, asserted where they are observable: on the
 * Snapshot.
 *
 * Every case builds a whole Ticket file, feeds it through `deriveSnapshot`, and reads
 * `derivation.state` and `derivation.lane` back off the card. Nothing calls the ladder
 * directly and nothing names an intermediate shape.
 *
 * **The Dialect is asserted by construction, not by remembering to.** `deriveTask` and
 * `deriveDecision` each check that the document they built scored the Dialect they intended,
 * so no case can silently exercise the wrong ladder. That is not ceremony: the two ladders
 * answer differently, and several expectations here are `unparsed` or "no Lane" — which is
 * also exactly what a document that reached the *other* ladder, or no ladder at all, can
 * produce. A parked task and a parked decision are indistinguishable in the result and are
 * not the same test. `deriveRaw` exists for the few cases that deliberately have no Dialect.
 *
 * **One limit, stated rather than left to be discovered:** the module that resolves blocker
 * numbers to states still resolves nothing, so through this seam every dependency is
 * unresolved. The cases below prove that an unresolved dependency blocks; they cannot yet
 * prove that a satisfied one clears, because no input can produce a satisfied one. Forcing
 * it by calling the ladder directly is not available either — the encapsulation check
 * forbids importing a rule module from outside the seam, which also prevents tests from
 * pinning unreachable internal guards as though they were observable behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS, oneFileTree } from './harness.ts';
import type { AnnotationStore, Dialect, Lane, TicketState } from '../core/types.ts';

interface Derived {
  readonly state: TicketState;
  readonly lane: Lane | null;
  readonly dialect: Dialect;
  readonly statusPrefix: string | null;
  readonly statusPresent: boolean;
  readonly criteria: string;
  readonly hitl: boolean;
  readonly blockedBy: readonly number[];
}

interface TaskDoc {
  readonly status?: string;
  readonly criteria: readonly boolean[];
  readonly blockers?: string;
}

interface DecisionDoc {
  readonly status: string | null;
  readonly blockers?: string;
  readonly type?: string;
}

// ---------------------------------------------------------------------------
// Parking is a veto, on both Dialects, before every other rule
// ---------------------------------------------------------------------------

test('a parked task Ticket is parked however complete it is', () => {
  // Zero checked, no blockers: every progress rule says ready and puts it on the Frontier.
  const unstarted = deriveTask({ status: 'wontfix', criteria: [false, false] });
  assert.deepEqual([unstarted.state, unstarted.lane], ['parked', 'parked']);

  // And the veto outranks completeness in the other direction too.
  const finished = deriveTask({ status: 'closed', criteria: [true, true] });
  assert.deepEqual([finished.state, finished.lane], ['parked', 'parked']);
});

test('a parked decision Ticket is parked too', () => {
  // The decision ladder does not list parking, but parking is a veto evaluated before every
  // other rule and it opens the Lane ordering for every card.
  for (const status of ['wontfix', 'closed']) {
    const found = deriveDecision({ status, blockers: '02' });
    assert.deepEqual([found.state, found.lane], ['parked', 'parked'], status);
  }
});

// ---------------------------------------------------------------------------
// The task ladder
// ---------------------------------------------------------------------------

test('a task Ticket with no criteria cannot be placed', () => {
  const found = deriveTask({ criteria: [] });
  assert.equal(found.criteria, '0/0');
  assert.deepEqual([found.state, found.lane], ['unparsed', null]);
});

test('the task ladder reads checkboxes, in order', () => {
  const rungs: readonly (readonly [readonly boolean[], TicketState, Lane])[] = [
    [[true, true], 'done', 'complete'],
    [[true, false], 'in-progress', 'in-progress'],
    [[false, false], 'ready', 'agent'],
  ];
  for (const [criteria, state, lane] of rungs) {
    const found = deriveTask({ criteria });
    assert.deepEqual([found.state, found.lane], [state, lane], `criteria ${found.criteria}`);
  }
});

test('an unstarted task Ticket is blocked by a dependency or by prose', () => {
  const byTicket = deriveTask({ criteria: [false, false], blockers: '02' });
  assert.deepEqual([...byTicket.blockedBy], [2], 'the dependency never reached the ladder');
  assert.deepEqual([byTicket.state, byTicket.lane], ['blocked', 'blocked']);

  const byProse = deriveTask({ criteria: [false, false], blockers: 'External legal sign-off' });
  assert.deepEqual(
    [byProse.state, byProse.lane],
    ['blocked', 'blocked'],
    'a Ticket waiting on something that is not a Ticket still cannot be started',
  );
});

test('an unresolved dependency blocks, whatever shape it arrives in', () => {
  // Every dependency is unresolved through this seam, which is the safe direction: a number
  // that resolves to no Ticket, a Ticket that cannot be placed, and a Ticket that is itself
  // blocked all fail the same test, so a typo or a deleted file keeps work off the Frontier.
  for (const blockers of ['02', '02, 03', '999', '01, 02, 03, 04']) {
    const found = deriveTask({ criteria: [false], blockers });
    assert.equal(found.state, 'blocked', `blockers ${blockers}`);
  }
});

test('done is read before blocked, so a finished Ticket is not held by a stale dependency', () => {
  const found = deriveTask({ criteria: [true, true], blockers: '03, 06' });
  assert.deepEqual([found.state, found.lane], ['done', 'complete']);
});

// ---------------------------------------------------------------------------
// The collision: ready-for-human against completeness, and against everything after it
// ---------------------------------------------------------------------------

test('a fully checked Ticket awaiting a human does not collapse into Done', () => {
  // The defect this ordering exists to prevent: five of five boxes checked filed the Ticket
  // under Done, where it collapsed and disappeared, while it had been waiting on a person
  // for a week. The Status is a Lane assignment and it outranks being finished.
  const found = deriveTask({ status: 'ready-for-human', criteria: [true, true, true, true, true] });
  assert.equal(found.criteria, '5/5', 'the ratio must survive for display, so it reads as awaiting sign-off');
  assert.deepEqual([found.state, found.lane], ['done-awaiting-human', 'needs-you']);
});

test('a Ticket matching two Lane rungs takes the earlier one', () => {
  // First match wins, so a card satisfying more than one rung is the only thing that proves
  // the list is ordered at all. Each of these matches the human rung and a later one.
  const alsoComplete = deriveTask({ status: 'ready-for-human', criteria: [true, true] });
  assert.equal(alsoComplete.lane, 'needs-you', 'complete outranked the human Lane');

  const alsoBlocked = deriveTask({ status: 'ready-for-human', criteria: [false, false], blockers: '02' });
  assert.equal(alsoBlocked.state, 'blocked', 'the ladder still reports what the dependencies say');
  assert.equal(alsoBlocked.lane, 'needs-you', 'blocked outranked the human Lane');

  const alsoInProgress = deriveTask({ status: 'ready-for-human', criteria: [true, false] });
  assert.equal(alsoInProgress.lane, 'needs-you', 'in progress outranked the human Lane');

  const alsoParked = deriveTask({ status: 'wontfix', criteria: [true, true] });
  assert.equal(alsoParked.lane, 'parked', 'parked is first and must outrank everything');
});

test('that Status routes to the human Lane regardless of checkbox state', () => {
  // It is a Lane assignment, orthogonal to progress — not a synonym for finished.
  const unstarted = deriveTask({ status: 'ready-for-human', criteria: [false, false, false] });
  assert.equal(unstarted.criteria, '0/3');
  assert.deepEqual([unstarted.state, unstarted.lane], ['ready', 'needs-you']);
});

// ---------------------------------------------------------------------------
// On a task Ticket, Status may only park
// ---------------------------------------------------------------------------

test('a task Status never promotes, only parks', () => {
  // The asymmetry is what makes a stale `ready-for-agent` harmless. Two Tickets in the
  // corpus carry `done` and `resolved` and reach Done through their criteria instead.
  for (const status of ['done', 'resolved', 'ready-for-agent', 'open', 'claimed']) {
    const found = deriveTask({ status, criteria: [false, false] });
    assert.equal(found.statusPrefix, status, `the Status did not reach the ladder for ${status}`);
    assert.equal(
      found.state,
      'ready',
      `a task Status of ${status} promoted the Ticket, which a stale status must never do`,
    );
  }
});

test('a task Ticket reaches Done through its criteria even when its Status says otherwise', () => {
  const found = deriveTask({ status: 'ready-for-agent', criteria: [true, true] });
  assert.deepEqual([found.state, found.lane], ['done', 'complete']);
});

// ---------------------------------------------------------------------------
// The decision ladder, where Status is live state
// ---------------------------------------------------------------------------

test('the decision ladder reads the Status, in order', () => {
  const rungs: readonly (readonly [string, TicketState, Lane])[] = [
    ['resolved', 'done', 'complete'],
    ['claimed', 'in-progress', 'in-progress'],
    ['open', 'ready', 'agent'],
  ];
  for (const [status, state, lane] of rungs) {
    const found = deriveDecision({ status });
    assert.deepEqual([found.state, found.lane], [state, lane], `status ${status}`);
  }
});

test('a claimed decision Ticket outranks its unfinished dependencies', () => {
  // Someone is holding this, which is a truer thing to say about it than that something
  // upstream is unfinished.
  const found = deriveDecision({ status: 'claimed', blockers: '09, 10' });
  assert.deepEqual([...found.blockedBy], [9, 10]);
  assert.deepEqual([found.state, found.lane], ['in-progress', 'in-progress']);
});

test('a decision Ticket is blocked by a dependency or by prose', () => {
  const byTicket = deriveDecision({ status: 'open', blockers: '02, 03' });
  assert.deepEqual([byTicket.state, byTicket.lane], ['blocked', 'blocked']);

  const byProse = deriveDecision({ status: 'open', blockers: 'External vendor determination' });
  assert.deepEqual([byProse.state, byProse.lane], ['blocked', 'blocked']);
});

test('a decision Ticket awaiting a person appears in the human Lane', () => {
  // Reading "unrecognised" as "not one of the three lifecycle values" made this Ticket
  // stateless and Laneless — it vanished from the board entirely, which is the same costly
  // failure as burying a finished Ticket under Done, in the other Dialect. The Status is a
  // Lane assignment on both Dialects.
  const found = deriveDecision({ status: 'ready-for-human' });
  assert.equal(found.statusPrefix, 'ready-for-human');
  assert.deepEqual([found.state, found.lane], ['ready', 'needs-you']);

  const blocked = deriveDecision({ status: 'ready-for-human', blockers: '02' });
  assert.equal(blocked.lane, 'needs-you', 'and it still outranks being blocked here too');
});

test('every readable Status leaves a decision Ticket somewhere a reader can find it', () => {
  // Six of the eleven statuses the vocabulary knows sit outside the decision lifecycle.
  // Treating them as unreadable removed those cards from every column, from the Frontier
  // and from Done, and counted them nowhere.
  for (const status of ['ready-for-agent', 'needs-triage', 'needs-info', 'ready-for-afk', 'done']) {
    const found = deriveDecision({ status });
    assert.equal(found.statusPrefix, status, `${status} did not reach the ladder`);
    assert.notEqual(found.state, 'unparsed', `${status} made the card unplaceable`);
    assert.notEqual(found.lane, null, `${status} removed the card from every Lane`);
  }
});

test('a decision Status that is present but unrecognised cannot be placed', () => {
  const found = deriveDecision({ status: 'halfway through a sentence' });
  assert.equal(found.statusPrefix, null, 'the vocabulary matched something it should not have');
  assert.equal(found.statusPresent, true);
  assert.deepEqual([found.state, found.lane], ['unparsed', null]);
});

// ---------------------------------------------------------------------------
// What this ladder depends on the status reader for
// ---------------------------------------------------------------------------

test('an absent Status arrives as open, so the ladder needs one check and not two', () => {
  // The written ladder says "prefix open **or** Status absent". Absence already arrives
  // carrying `open`, so the second half is a branch no input can reach. Asserted rather
  // than assumed, because collapsing the condition depends on that behaviour holding.
  const found = deriveDecision({ status: null });
  assert.equal(found.statusPresent, false, 'absence must stay distinguishable from a written value');
  assert.equal(found.statusPrefix, 'open');
  assert.deepEqual([found.state, found.lane], ['ready', 'agent']);
});

test('a present but empty Status is a torn read, not a default to open', () => {
  // What `Status: done` looks like halfway through being written. Defaulting it to open
  // would promote half-written work; it reads as unplaceable for one scan and resolves
  // itself on the next write.
  const found = deriveDecision({ status: '' });
  assert.equal(found.statusPresent, true);
  assert.equal(found.statusPrefix, null);
  assert.deepEqual([found.state, found.lane], ['unparsed', null]);
});

// ---------------------------------------------------------------------------
// HITL is last, so it never outranks a Ticket someone is already holding
// ---------------------------------------------------------------------------

test('a Ticket needing a human takes the human Lane once nothing else claims it', () => {
  const found = deriveDecision({ status: 'open', type: 'research (AFK)' });
  assert.equal(found.hitl, true);
  assert.deepEqual([found.state, found.lane], ['ready', 'needs-you']);
});

test('a claimed Ticket that also needs a human stays In progress', () => {
  // Tested after claimed. Dragging it into Needs you would ask for attention on work
  // somebody is already doing.
  const found = deriveDecision({ status: 'claimed', type: 'task (HITL — the user relays)' });
  assert.equal(found.hitl, true);
  assert.deepEqual([found.state, found.lane], ['in-progress', 'in-progress']);
});

test('a parked Ticket that also needs a human stays parked', () => {
  const found = deriveDecision({ status: 'wontfix', type: 'task (HITL)' });
  assert.equal(found.hitl, true);
  assert.equal(found.lane, 'parked');
});

// ---------------------------------------------------------------------------
// Cards the parser could not place take no Lane
// ---------------------------------------------------------------------------

test('an unplaceable card is kept out of every Lane rather than guessed into one', () => {
  const torn = deriveRaw('# 01 — A\n\n**Status:*');
  assert.equal(torn.lane, null, 'a card with no Dialect must not be offered to an agent');
});

test('an unplaceable card says which kind of unplaceable it is', () => {
  // Nothing-observable and observed-but-unplaceable are different answers, and the card
  // renders differently for each — one shows a raw filename, the other its raw fields. Both
  // take no Lane, so collapsing them would be invisible on the board and would throw away
  // the only thing that tells a reader which one to go and look at.
  const ambiguous = deriveRaw('# 01 — A\n\n**Status:** open\nBlocked by: none\n');
  assert.equal(ambiguous.dialect, 'unclassified');
  assert.deepEqual(
    [ambiguous.state, ambiguous.lane],
    ['unclassified', null],
    'a card whose Dialect could not be settled was reported as if nothing had been observed',
  );
});

// ---------------------------------------------------------------------------
// Totality and purity
// ---------------------------------------------------------------------------

test('every card gets exactly one Lane, and only an unplaceable one gets none', () => {
  const shapes: readonly string[] = [
    taskDoc({ criteria: [] }),
    taskDoc({ criteria: [false, false] }),
    taskDoc({ criteria: [true, false] }),
    taskDoc({ criteria: [true, true] }),
    taskDoc({ status: 'wontfix', criteria: [false] }),
    taskDoc({ status: 'ready-for-human', criteria: [true] }),
    taskDoc({ criteria: [false], blockers: '02' }),
    decisionDoc({ status: 'open' }),
    decisionDoc({ status: 'claimed' }),
    decisionDoc({ status: 'resolved' }),
    decisionDoc({ status: 'closed' }),
    decisionDoc({ status: 'ready-for-human' }),
    decisionDoc({ status: 'needs-triage' }),
    decisionDoc({ status: 'nonsense' }),
    decisionDoc({ status: null }),
    decisionDoc({ status: 'open', blockers: '02' }),
    decisionDoc({ status: 'open', type: 'task (HITL)' }),
    '# 01 — A\n',
    '',
  ];
  const lanes: readonly (Lane | null)[] = [
    'parked', 'needs-you', 'complete', 'blocked', 'frozen', 'in-progress', 'agent', null,
  ];

  for (const text of shapes) {
    const found = deriveRaw(text);
    assert.ok(lanes.includes(found.lane), `${JSON.stringify(found.lane)} is not a Lane`);
    const unplaceable = found.state === 'unparsed' || found.state === 'unclassified';
    assert.equal(
      found.lane === null,
      unplaceable,
      `state ${found.state} came back with lane ${JSON.stringify(found.lane)}; only an unplaceable card holds no Lane`,
    );
  }
});

test('the same Ticket derives the same Lane every time', () => {
  const scan = oneFileTree('01-a.md', taskDoc({ status: 'ready-for-human', criteria: [true, true] }));
  assert.deepEqual(deriveSnapshot(scan, EMPTY_ANNOTATIONS), deriveSnapshot(scan, EMPTY_ANNOTATIONS));
});

// ---------------------------------------------------------------------------
// An Override can move a Lane, which is the point of separating extraction from derivation
// ---------------------------------------------------------------------------

test('correcting an extracted field moves the card, without the AI ever naming a Lane', () => {
  // The AI may only write extraction fields; the Lane follows in code. Until now that
  // consequence was theoretical, because nothing derived a Lane. It is live from here.
  const scan = oneFileTree('01-a.md', taskDoc({ status: 'ready-for-agent', criteria: [false, false] }));

  const before = deriveSnapshot(scan, EMPTY_ANNOTATIONS).roots[0]?.features[0]?.tickets[0];
  assert.ok(before !== undefined);
  assert.deepEqual([before.derivation.state, before.derivation.lane], ['ready', 'agent']);

  // Keyed off the card's own id and hash, never a rebuilt one.
  const parked = deriveSnapshot(scan, storeFor(before.id, before.contentSha, { rawStatus: 'wontfix' }))
    .roots[0]?.features[0]?.tickets[0];
  assert.ok(parked !== undefined);
  assert.deepEqual(
    [parked.derivation.state, parked.derivation.lane],
    ['parked', 'parked'],
    'a corrected Status did not reach the ladder, so an Override cannot move a Lane',
  );
  assert.deepEqual([...parked.derivation.correctedFields], ['rawStatus']);

  const finished = deriveSnapshot(
    scan,
    storeFor(before.id, before.contentSha, { criteria: { checked: 2, total: 2 } }),
  ).roots[0]?.features[0]?.tickets[0];
  assert.ok(finished !== undefined);
  assert.deepEqual([finished.derivation.state, finished.derivation.lane], ['done', 'complete']);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A task-Dialect Ticket: bold field markers and a checkbox list, which is what separates
 * the two Dialects in every observed file.
 */
function taskDoc(options: TaskDoc): string {
  const lines = ['# 01 — A task Ticket', ''];
  if (options.status !== undefined) lines.push(`**Status:** ${options.status}`);
  if (options.blockers !== undefined) lines.push(`**Blocked by:** ${options.blockers}`);
  lines.push('', '**What to build:** something small.', '');
  for (const [at, checked] of options.criteria.entries()) {
    lines.push(`- [${checked ? 'x' : ' '}] criterion ${at + 1}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A decision-Dialect Ticket: bare field markers, a `## Question` heading, no checkboxes. */
function decisionDoc(options: DecisionDoc): string {
  const lines = ['# 01 — A decision Ticket', ''];
  if (options.status !== null) lines.push(`Status: ${options.status}`);
  if (options.blockers !== undefined) lines.push(`Blocked by: ${options.blockers}`);
  if (options.type !== undefined) lines.push(`Type: ${options.type}`);
  lines.push('', '## Question', '', 'Which way should this go?', '');
  return `${lines.join('\n')}\n`;
}

/** Builds a task document **and proves it reached the task ladder**. */
function deriveTask(options: TaskDoc): Derived {
  return expectDialect(deriveRaw(taskDoc(options)), 'task', options);
}

/** Builds a decision document **and proves it reached the decision ladder**. */
function deriveDecision(options: DecisionDoc): Derived {
  return expectDialect(deriveRaw(decisionDoc(options)), 'decision', options);
}

function expectDialect(found: Derived, dialect: Dialect, options: object): Derived {
  assert.equal(
    found.dialect,
    dialect,
    `this document scored ${found.dialect}, so it exercised the wrong ladder and everything asserted about it below means nothing: ${JSON.stringify(options)}`,
  );
  return found;
}

function deriveRaw(text: string): Derived {
  const snapshot = deriveSnapshot(oneFileTree('01-a.md', text), EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, 'the one-file tree produced no card');
  return {
    state: card.derivation.state,
    lane: card.derivation.lane,
    dialect: card.extraction.dialect,
    statusPrefix: card.extraction.statusPrefix,
    statusPresent: card.extraction.statusPresent,
    criteria: `${card.extraction.criteria.checked}/${card.extraction.criteria.total}`,
    hitl: card.extraction.hitl,
    blockedBy: card.extraction.blockedBy,
  };
}

/** An Annotation store keyed to a card the Snapshot already handed back. */
function storeFor(id: string, contentSha: string | null, extraction: object): AnnotationStore {
  const parsed: AnnotationStore = JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      entries: [{ schemaVersion: 1, filePath: id, contentSha, extraction }],
    }),
  );
  return parsed;
}
