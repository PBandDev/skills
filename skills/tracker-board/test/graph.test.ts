/**
 * The dependency graph: blocker resolution, the Frozen walk, and the Frontier.
 *
 * Everything here runs through `deriveSnapshot`. The rule modules are reachable only
 * through the seam, and going through it is also the honest test: what these rules are for
 * is the Lane a reader ends up looking at, and asserting on an intermediate shape would let
 * the graph be right while the board stayed wrong.
 *
 * **Nothing here reconstructs an id.** A card's id is `<rootPath>#<relPath>`,
 * length-prefixed, and `frozenOn` carries that string. A test that rebuilt the id from its
 * parts would be asserting the guarantee *through* the thing that could have failed to
 * deliver it — so every id comparison here reads both sides off the Snapshot.
 *
 * Trees are built in memory. Nothing reads the repository this file sits in; the skill
 * installs into other people's repositories, where everything above its own directory
 * belongs to somebody else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS } from './harness.ts';
import { corpusScan } from './corpus-tree.ts';
import type { Scan, Snapshot, TicketCard } from '../core/types.ts';

/**
 * Two Tickets that must come out Frozen-on-the-first, dropped into any Feature whose real
 * subject is a Ticket that must come out **Blocked**.
 *
 * Blocked-with-no-terminal is also precisely what every card in a Feature degrades to when
 * the chain pass throws: the seam catches it, hands back no chain results, and each card
 * keeps the Lane the ladder gave it. So a Feature holding only Blocked expectations cannot
 * tell a correct answer from a collapsed pass, and a guard whose removal makes the pass
 * throw would survive every assertion in it. This pair can tell them apart — if the pass did
 * not complete, the canary loses its Frozen Lane.
 *
 * Numbered out of the way so it never collides with a Ticket a test is actually about.
 */
const CANARY: Readonly<Record<string, string>> = {
  '98-canary-relay.md': humanReady(),
  '99-canary-frozen.md': blockedOn('98 — the canary relay'),
};

function assertChainPassRan(snapshot: Snapshot, feature: string): void {
  const canary = cardIn(snapshot, feature, '99-');
  assert.equal(
    canary.derivation.lane,
    'frozen',
    `the chain pass did not complete for ${feature}. Every card in it fell back to its pre-graph Lane, so a Blocked assertion beside this one would be passing for the wrong reason.`,
  );
  assert.equal(canary.derivation.frozenOn, cardIn(snapshot, feature, '98-').id);
}

// ---------------------------------------------------------------------------
// Feature-local resolution
// ---------------------------------------------------------------------------

test('blocker numbers resolve within their Feature only', () => {
  // `alpha` names blocker 02 and holds no 02. `beta` holds one, and it is human-gated. If
  // numbers crossed the Feature boundary, alpha/03 would freeze on beta's Ticket.
  const snapshot = derive({
    alpha: { ...CANARY, '03-needs-two.md': blockedOn('02 — a Ticket this Feature does not have') },
    beta: { '02-relay.md': humanReady() },
  });
  assertChainPassRan(snapshot, 'alpha');

  const needsTwo = cardIn(snapshot, 'alpha', '03-');
  assert.equal(needsTwo.derivation.lane, 'blocked');
  assert.equal(
    needsTwo.derivation.frozenOn,
    null,
    'a blocker number reached into another Feature. Features are Root-local and numbers are Feature-local, so the graph must never cross the boundary.',
  );
  assert.deepEqual([...needsTwo.derivation.danglingBlockers], [2]);
  assert.equal(cardIn(snapshot, 'beta', '02-').derivation.lane, 'needs-you');

  // The control: the identical Ticket freezes the moment its **own** Feature holds the 02.
  const together = derive({
    alpha: { '02-relay.md': humanReady(), '03-needs-two.md': blockedOn('02 — a Ticket this Feature does have') },
  });
  const resolved = cardIn(together, 'alpha', '03-');
  assert.equal(resolved.derivation.lane, 'frozen');
  assert.equal(resolved.derivation.frozenOn, cardIn(together, 'alpha', '02-').id);
  assert.deepEqual([...resolved.derivation.danglingBlockers], []);
});

test('a number two files claim identifies neither', () => {
  // Feature-local numbers are meant to be unique. Resolving an ambiguous reference to
  // whichever file sorted first would hide the authoring mistake behind a plausible board.
  const snapshot = derive({
    alpha: {
      ...CANARY,
      '02-relay.md': humanReady(),
      '02-duplicate.md': humanReady(),
      '03-needs-two.md': blockedOn('02'),
    },
  });
  assertChainPassRan(snapshot, 'alpha');

  const needsTwo = cardIn(snapshot, 'alpha', '03-');
  assert.equal(needsTwo.derivation.lane, 'blocked');
  assert.equal(needsTwo.derivation.frozenOn, null, 'an ambiguous reference must not name a terminal');
  assert.deepEqual([...needsTwo.derivation.danglingBlockers], [2]);
});

// ---------------------------------------------------------------------------
// A dangling reference blocks
// ---------------------------------------------------------------------------

test('a dangling blocker blocks and keeps the Ticket off the Frontier', () => {
  const snapshot = derive({
    alpha: { ...CANARY, '01-typo.md': blockedOn('97 — a number nobody wrote') },
  });
  assertChainPassRan(snapshot, 'alpha');

  const card = cardIn(snapshot, 'alpha', '01-');
  assert.deepEqual(
    [card.derivation.state, card.derivation.lane],
    ['blocked', 'blocked'],
    'a number with no matching Ticket is not-done, therefore blocking. A typo must fail safe rather than promote work.',
  );
  assert.deepEqual([...card.derivation.danglingBlockers], [97]);
  assert.equal(card.derivation.onFrontier, false);
  assert.equal(snapshot.frontierCount, 0);
});

test('an unreadable blocker cannot be named at all, so the reference dangles', () => {
  // A file that could not be read has no number — it never got as far as its filename being
  // parsed for one — so nothing can reference it. It blocks by dangling rather than by state.
  const snapshot = derive({
    alpha: { ...CANARY, '01-torn.md': null, '02-waits.md': blockedOn('01 — the unreadable one') },
  });
  assertChainPassRan(snapshot, 'alpha');

  assert.equal(cardIn(snapshot, 'alpha', '01-').derivation.state, 'unparsed');
  const waits = cardIn(snapshot, 'alpha', '02-');
  assert.equal(waits.derivation.lane, 'blocked');
  assert.equal(waits.derivation.frozenOn, null);
  assert.deepEqual([...waits.derivation.danglingBlockers], [1]);
});

test('a blocker holding no Lane blocks, and no chain through it can be Frozen', () => {
  // `unclassified` takes no Lane, so it cannot be the human a chain terminates at — there is
  // no Lane on it to be human. The chain stays ordinary Blocked even though a person is the
  // only one who can resolve the ambiguity.
  const snapshot = derive({
    alpha: { ...CANARY, '01-ambiguous.md': unclassified(), '02-waits.md': blockedOn('01 — the ambiguous one') },
  });
  assertChainPassRan(snapshot, 'alpha');

  const ambiguous = cardIn(snapshot, 'alpha', '01-');
  assert.equal(ambiguous.extraction.dialect, 'unclassified');
  assert.equal(ambiguous.derivation.lane, null, 'an unclassified card must hold no Lane');

  const waits = cardIn(snapshot, 'alpha', '02-');
  assert.deepEqual([waits.derivation.state, waits.derivation.lane], ['blocked', 'blocked']);
  assert.equal(waits.derivation.frozenOn, null);
  assert.deepEqual(
    [...waits.derivation.danglingBlockers],
    [],
    'the number resolved — it is the blocker holding no Lane that stops the chain, not a missing reference',
  );
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

test('a cycle is ordinary Blocked, and the walk still resolves the chains beside it', () => {
  // The second half is the real assertion. A missing visited set does not hang here — the
  // seam catches the stack overflow and hands back an empty result — so the observable
  // symptom is that **every** chain in the Feature silently loses its Frozen Lane. Asserting
  // an unrelated chain is still Frozen is what makes that visible.
  const snapshot = derive({
    alpha: {
      '01-loops.md': blockedOn('02 — the other half of the loop'),
      '02-loops-back.md': blockedOn('01 — the first half of the loop'),
      '03-itself.md': blockedOn('03 — itself'),
      '04-relay.md': humanReady(),
      '05-genuinely-frozen.md': blockedOn('04 — the relay'),
    },
  });

  for (const file of ['01-', '02-', '03-']) {
    const card = cardIn(snapshot, 'alpha', file);
    assert.deepEqual(
      [card.derivation.state, card.derivation.lane],
      ['blocked', 'blocked'],
      `${file} is in a cycle. A cycle terminates at nothing, so it is ordinary Blocked.`,
    );
    assert.equal(card.derivation.frozenOn, null);
  }

  assert.equal(
    cardIn(snapshot, 'alpha', '05-').derivation.lane,
    'frozen',
    'the cycle took the whole Feature down with it — the walk is not cycle-safe',
  );
});

test('a human on a loop cuts it, and the Ticket behind the loop still Freezes', () => {
  // The walk stops at the human Lane without reading that Ticket's own blockers, so a loop
  // running through a person is cut there rather than detected as a cycle. 02 and 03 name
  // each other, but 03 is in the human Lane, so 02's chain terminates instead of looping.
  const snapshot = derive({
    alpha: {
      '01-behind.md': blockedOn('02 — the one behind the person'),
      '02-loops-through-relay.md': blockedOn('03 — the relay'),
      '03-relay.md': humanBlockedOn('02 — back the other way'),
    },
  });

  const relay = cardIn(snapshot, 'alpha', '03-');
  assert.equal(relay.derivation.lane, 'needs-you');
  for (const file of ['01-', '02-']) {
    const card = cardIn(snapshot, 'alpha', file);
    assert.equal(card.derivation.lane, 'frozen', `${file} terminates at a person and must Freeze`);
    assert.equal(card.derivation.frozenOn, relay.id);
  }
});

test('a cycle with a human hanging off it is still Blocked', () => {
  // 01 → 02, and 02 → {01, 03}. 02 has one path that closes a loop, so 02 is not
  // human-terminal, so neither is 01 — even though a person really is on one of its paths.
  const snapshot = derive({
    alpha: {
      ...CANARY,
      '01-enters.md': blockedOn('02 — the loop'),
      '02-loops.md': blockedOn('01, 03'),
      '03-relay.md': humanReady(),
    },
  });
  assertChainPassRan(snapshot, 'alpha');

  assert.deepEqual(
    [...cardIn(snapshot, 'alpha', '02-').extraction.blockedBy],
    [1, 3],
    'the fixture must state both the loop and the human, or this proves nothing about mixing them',
  );
  for (const file of ['01-', '02-']) {
    const card = cardIn(snapshot, 'alpha', file);
    assert.equal(card.derivation.lane, 'blocked', `${file} must not freeze through a cycle`);
    assert.equal(card.derivation.frozenOn, null);
  }
});

// ---------------------------------------------------------------------------
// Frozen: every path, or none
// ---------------------------------------------------------------------------

test('a Ticket is Frozen only when every path terminates at a human', () => {
  const snapshot = derive({
    alpha: {
      ...CANARY,
      '01-relay.md': humanReady(),
      '02-takeable.md': agentReady(),
      '03-one-path.md': blockedOn('01 — the relay'),
      '04-mixed.md': blockedOn('01, 02'),
    },
  });
  assertChainPassRan(snapshot, 'alpha');

  const onePath = cardIn(snapshot, 'alpha', '03-');
  assert.deepEqual([onePath.derivation.state, onePath.derivation.lane], ['frozen', 'frozen']);

  const mixed = cardIn(snapshot, 'alpha', '04-');
  assert.deepEqual([...mixed.extraction.blockedBy], [1, 2], 'the fixture no longer states two blockers');
  assert.deepEqual(
    [mixed.derivation.state, mixed.derivation.lane],
    ['blocked', 'blocked'],
    'one chain an agent could still advance is enough. Mixed chains stay ordinary Blocked — folding them into Frozen tells the reader nothing will happen until they act, which is false.',
  );
  assert.equal(mixed.derivation.frozenOn, null);
});

test('Frozen is transitive through a blocked intermediary', () => {
  const snapshot = derive({
    alpha: {
      '01-relay.md': humanReady(),
      '02-behind-relay.md': blockedOn('01 — the relay'),
      '03-behind-that.md': blockedOn('02 — behind the relay'),
    },
  });

  const relay = cardIn(snapshot, 'alpha', '01-');
  for (const file of ['02-', '03-']) {
    const card = cardIn(snapshot, 'alpha', file);
    assert.equal(card.derivation.lane, 'frozen', `${file} traces to a person and must be Frozen`);
    assert.equal(
      card.derivation.frozenOn,
      relay.id,
      `${file} must name the person at the end of the chain, not the Ticket immediately above it`,
    );
  }
});

test('a chain through work someone has already started is Blocked, not Frozen', () => {
  // The intermediary is In progress: an agent is advancing it right now, so the chain below
  // it is queued behind an agent rather than waiting on a person.
  const snapshot = derive({
    alpha: {
      ...CANARY,
      '01-relay.md': humanReady(),
      '02-underway.md': inProgress('01 — the relay'),
      '03-behind-it.md': blockedOn('02 — the one underway'),
    },
  });
  assertChainPassRan(snapshot, 'alpha');

  assert.equal(cardIn(snapshot, 'alpha', '02-').derivation.lane, 'in-progress');
  const behind = cardIn(snapshot, 'alpha', '03-');
  assert.deepEqual([behind.derivation.state, behind.derivation.lane], ['blocked', 'blocked']);
  assert.equal(behind.derivation.frozenOn, null);
});

test('a satisfied blocker is not a path', () => {
  // 01 is finished. It is neither a human terminal nor a chain an agent could advance — it
  // is simply not a path any more, so it must not stop 03 freezing on 02.
  const snapshot = derive({
    alpha: {
      '01-finished.md': doneTicket(),
      '02-relay.md': humanReady(),
      '03-waits.md': blockedOn('01, 02'),
    },
  });

  assert.equal(cardIn(snapshot, 'alpha', '01-').derivation.state, 'done');
  const waits = cardIn(snapshot, 'alpha', '03-');
  assert.deepEqual([...waits.extraction.blockedBy], [1, 2]);
  assert.equal(waits.derivation.lane, 'frozen');
  assert.equal(
    waits.derivation.frozenOn,
    cardIn(snapshot, 'alpha', '02-').id,
    'the finished blocker was walked as if it were a live path, so the chain failed on it',
  );
});

test('an external blocker alone never freezes', () => {
  // "Every path terminates at a human" is vacuously true over zero paths. Taking that
  // vacuous truth would freeze a Ticket waiting on a contract and name no Ticket to go and
  // do — a card frozen on nothing.
  const snapshot = derive({
    alpha: { ...CANARY, '01-relay.md': humanReady(), '02-waits-on-legal.md': external() },
  });
  assertChainPassRan(snapshot, 'alpha');

  const waits = cardIn(snapshot, 'alpha', '02-');
  assert.deepEqual([...waits.extraction.blockedBy], [], 'the fixture must name no Ticket blocker');
  assert.ok(waits.extraction.externalBlocker !== null, 'the fixture must carry an external blocker');
  assert.deepEqual([waits.derivation.state, waits.derivation.lane], ['blocked', 'blocked']);
  assert.equal(waits.derivation.frozenOn, null);
});

test('an external blocker alongside a human one still blocks, and names nobody', () => {
  // The card would otherwise read "Frozen on 01" — and finishing 01 would leave it exactly as
  // blocked, because a contract is not a Ticket. A confidently wrong instruction is worse than
  // an unhelpful one, so the whole path fails instead.
  const snapshot = derive({
    alpha: {
      ...CANARY,
      '01-relay.md': humanReady(),
      '02-mixed.md': blockedOn('01, External legal sign-off.'),
    },
  });
  assertChainPassRan(snapshot, 'alpha');

  const mixed = cardIn(snapshot, 'alpha', '02-');
  assert.deepEqual([...mixed.extraction.blockedBy], [1], 'the fixture must still name the Ticket blocker');
  assert.ok(
    mixed.extraction.externalBlocker !== null,
    'the fixture must also carry an external blocker, or this proves nothing',
  );
  assert.deepEqual([mixed.derivation.state, mixed.derivation.lane], ['blocked', 'blocked']);
  assert.equal(
    mixed.derivation.frozenOn,
    null,
    'the card named a human Ticket whose completion would leave it exactly as blocked',
  );
});

test('an external blocker part way up a chain stops everything behind it', () => {
  const snapshot = derive({
    alpha: {
      ...CANARY,
      '01-relay.md': humanReady(),
      '02-mixed.md': blockedOn('01, External legal sign-off.'),
      '03-behind.md': blockedOn('02'),
    },
  });
  assertChainPassRan(snapshot, 'alpha');

  for (const file of ['02-', '03-']) {
    const card = cardIn(snapshot, 'alpha', file);
    assert.equal(card.derivation.lane, 'blocked', `${file} must not be Frozen`);
    assert.equal(card.derivation.frozenOn, null);
  }
});

test('a Ticket a person already owns still ends a chain, external blocker or not', () => {
  // The external check is tested *after* the human Lane, deliberately: if a person owns the
  // Ticket, the thing it waits on is theirs to clear too, so the chain does terminate at them.
  const snapshot = derive({
    alpha: {
      '01-sign-off.md': taskText({ blockers: 'External legal sign-off.', status: 'ready-for-human' }),
      '02-behind.md': blockedOn('01'),
    },
  });

  const signOff = cardIn(snapshot, 'alpha', '01-');
  assert.equal(signOff.derivation.lane, 'needs-you');
  assert.ok(signOff.extraction.externalBlocker !== null);
  const behind = cardIn(snapshot, 'alpha', '02-');
  assert.equal(behind.derivation.lane, 'frozen');
  assert.equal(behind.derivation.frozenOn, signOff.id);
});

test('a blocked Ticket already in the human Lane keeps it', () => {
  // `ready-for-human` is a Lane assignment the ordering makes deliberately, and it outranks
  // being blocked. Promoting it to Frozen would replace a specific answer with a vaguer one
  // — and, since the walk stops at the human Lane, would leave the card frozen on itself.
  const snapshot = derive({
    alpha: { ...CANARY, '01-relay.md': humanReady(), '02-sign-off.md': humanBlockedOn('01 — the relay') },
  });
  assertChainPassRan(snapshot, 'alpha');

  const signOff = cardIn(snapshot, 'alpha', '02-');
  assert.equal(signOff.derivation.state, 'blocked');
  assert.equal(signOff.derivation.lane, 'needs-you');
  assert.equal(signOff.derivation.frozenOn, null, 'the card was frozen, and on itself');
});

test('a Ticket in the human Lane terminates a chain even when it is itself blocked', () => {
  const snapshot = derive({
    alpha: {
      '01-upstream.md': agentReady(),
      '02-sign-off.md': humanBlockedOn('01 — upstream'),
      '03-behind-sign-off.md': blockedOn('02 — the sign-off'),
    },
  });

  const behind = cardIn(snapshot, 'alpha', '03-');
  assert.equal(behind.derivation.lane, 'frozen');
  assert.equal(behind.derivation.frozenOn, cardIn(snapshot, 'alpha', '02-').id);
});

// ---------------------------------------------------------------------------
// The Frontier
// ---------------------------------------------------------------------------

test('the Frontier is the Agent Lane, computed and counted', () => {
  const snapshot = derive({
    alpha: {
      '01-takeable.md': agentReady(),
      '02-relay.md': humanReady(),
      '03-blocked.md': blockedOn('02 — the relay'),
      '04-finished.md': doneTicket(),
    },
    beta: { '01-also-takeable.md': agentReady(), '02-parked.md': parked() },
  });

  const takeable = cardIn(snapshot, 'alpha', '01-');
  const relay = cardIn(snapshot, 'alpha', '02-');
  assert.equal(takeable.derivation.onFrontier, true);
  assert.equal(
    relay.derivation.onFrontier,
    false,
    'a Ticket whose blockers are all resolved but whose Lane is Needs you is not on the Frontier — the Frontier is what an *agent* could claim now, and nobody but a person can take this one.',
  );
  assert.equal(relay.derivation.state, 'ready', 'the fixture must be ready, or it proves nothing about the Lane');
  for (const file of ['03-', '04-']) {
    assert.equal(cardIn(snapshot, 'alpha', file).derivation.onFrontier, false);
  }
  assert.equal(cardIn(snapshot, 'beta', '02-').derivation.onFrontier, false);

  assert.equal(snapshot.frontierCount, 2);
  assert.deepEqual(
    featureOf(snapshot, 'alpha').frontier,
    [takeable.id],
    'a Feature lists its own Frontier by id',
  );
  assert.deepEqual(featureOf(snapshot, 'beta').frontier, [cardIn(snapshot, 'beta', '01-').id]);
});

test('a Frozen Ticket is never on the Frontier', () => {
  const snapshot = derive({
    alpha: { '01-relay.md': humanReady(), '02-frozen.md': blockedOn('01 — the relay') },
  });
  const frozen = cardIn(snapshot, 'alpha', '02-');
  assert.equal(frozen.derivation.lane, 'frozen');
  assert.equal(frozen.derivation.onFrontier, false);
  assert.equal(snapshot.frontierCount, 0);
});

// ---------------------------------------------------------------------------
// Finished blockers clear
//
// One-file `tickets/` fixtures make every blocker dangle, and the corpus has no `done`
// blocker. These cases supply the missing contrast: they fail whenever a resolved blocker
// cannot be reported as finished.
// ---------------------------------------------------------------------------

test('a Ticket whose only blocker is finished reaches the Frontier', () => {
  const snapshot = derive({
    alpha: { '01-finished.md': doneTicket(), '02-waits.md': blockedOn('01 — the finished one') },
  });

  assert.equal(cardIn(snapshot, 'alpha', '01-').derivation.state, 'done');
  const waits = cardIn(snapshot, 'alpha', '02-');
  assert.deepEqual([...waits.extraction.blockedBy], [1], 'the fixture must name the blocker');
  assert.deepEqual(
    [waits.derivation.state, waits.derivation.lane],
    ['ready', 'agent'],
    'a finished dependency must clear. Leaving it Blocked keeps the Frontier permanently empty on any real tree.',
  );
  assert.equal(waits.derivation.onFrontier, true);
  assert.equal(snapshot.frontierCount, 1);
});

test('one unfinished blocker among finished ones still blocks', () => {
  const snapshot = derive({
    alpha: {
      '01-finished.md': doneTicket(),
      '02-underway.md': inProgress('None.'),
      '03-waits.md': blockedOn('01, 02'),
    },
  });

  assert.equal(cardIn(snapshot, 'alpha', '02-').derivation.state, 'in-progress');
  const waits = cardIn(snapshot, 'alpha', '03-');
  assert.deepEqual([...waits.extraction.blockedBy], [1, 2]);
  assert.deepEqual([waits.derivation.state, waits.derivation.lane], ['blocked', 'blocked']);
  assert.equal(waits.derivation.onFrontier, false);
});

test('a finished-but-awaiting-sign-off blocker does not clear', () => {
  // `done-awaiting-human` is finished and not off anyone's desk. Treating it as clearing a
  // dependency would offer an agent work whose predecessor is still waiting on a person.
  const snapshot = derive({
    alpha: {
      '01-signed-off-pending.md': taskText({ checked: 1, total: 1, status: 'ready-for-human' }),
      '02-waits.md': blockedOn('01 — awaiting sign-off'),
    },
  });

  const pending = cardIn(snapshot, 'alpha', '01-');
  assert.equal(pending.derivation.state, 'done-awaiting-human');
  const waits = cardIn(snapshot, 'alpha', '02-');
  assert.equal(waits.derivation.lane, 'frozen', 'it terminates at a person, so it is Frozen, not Ready');
  assert.equal(waits.derivation.onFrontier, false);
});

test('clearing runs the whole length of a chain', () => {
  const snapshot = derive({
    alpha: {
      '01-finished.md': doneTicket(),
      '02-also-finished.md': taskText({ blockers: '01', checked: 1, total: 1 }),
      '03-waits.md': blockedOn('02'),
    },
  });

  assert.equal(cardIn(snapshot, 'alpha', '02-').derivation.state, 'done');
  assert.equal(cardIn(snapshot, 'alpha', '03-').derivation.onFrontier, true);
});

// ---------------------------------------------------------------------------
// Order independence, and the graph agreeing with the board
// ---------------------------------------------------------------------------

test('a dependency cycle settles to one answer, whichever Ticket you start from', () => {
  // The worked hazard for a memoised depth-first pass with an on-stack sentinel: entering at
  // 01 yields `state(02) = blocked`; entering at 02 yields `state(01) = done` first and so
  // `state(02) = ready`. Two answers for one graph. This pass has no entry point at all —
  // done-ness is a pure function of a Ticket's own Extraction, so nothing recurses.
  const cyclic = {
    '01-finished.md': taskText({ blockers: '02', checked: 2, total: 2 }),
    '02-unstarted.md': taskText({ blockers: '01', checked: 0, total: 2 }),
  };
  const snapshot = derive({ alpha: cyclic });

  const finished = cardIn(snapshot, 'alpha', '01-');
  const unstarted = cardIn(snapshot, 'alpha', '02-');
  assert.equal(finished.derivation.state, 'done', 'criteria decide 01 whatever its blocker says');
  assert.equal(
    unstarted.derivation.state,
    'ready',
    '02 names one blocker and that blocker is finished, so 02 is startable — the cycle is not a reason to hold it',
  );
  assertGraphAgreesWithBoard(snapshot);

  // The same Feature with the files handed over in the opposite order must be the same board.
  const reversed = derive({ alpha: Object.fromEntries(Object.entries(cyclic).reverse()) });
  assert.deepEqual(reversed, snapshot, 'the board changed when the tree was scanned in a different order');
});

test('a Ticket is cleared by a finished blocker that sorts after it', () => {
  // `core/index.ts` sorts Tickets by number before the graph sees them, so a **forward**
  // reference — a low-numbered Ticket waiting on a high-numbered one — is the case that
  // reaches a blocker whose state has not been reached yet.
  //
  // That is the shape any single-pass implementation gets wrong: computing states in place,
  // in order, 10 would look up 30 before 30 had an answer, read the absence as "not
  // finished", and stay Blocked forever while the board showed its only blocker as Done.
  const tickets: Record<string, string> = {
    '10-waits-on-a-later-one.md': blockedOn('30 — finished and further down the sort'),
    '20-waits-too.md': blockedOn('30'),
    '30-finished.md': doneTicket(),
    '40-waits-on-an-unfinished-one.md': blockedOn('20'),
    'no-number.md': agentReady(),
  };
  const forward = derive({ alpha: tickets });

  for (const file of ['10-', '20-']) {
    const card = cardIn(forward, 'alpha', file);
    // Pinned, because a stray comma in a blocker line turns the tail into an external
    // blocker and the Ticket would then be Blocked for a reason this test is not about.
    assert.deepEqual([...card.extraction.blockedBy], [30], `${file} blockedBy`);
    assert.equal(card.extraction.externalBlocker, null, `${file} externalBlocker`);
    assert.deepEqual(
      [card.derivation.state, card.derivation.lane],
      ['ready', 'agent'],
      `${file} is held by a finished Ticket that merely sorts after it`,
    );
  }
  // ...and one that genuinely is not cleared, so the test cannot pass by clearing everything.
  assert.equal(cardIn(forward, 'alpha', '40-').derivation.lane, 'blocked');
  assertGraphAgreesWithBoard(forward);

  // The same Feature handed over in the opposite order must be the same board, byte for byte.
  const backward = derive({ alpha: Object.fromEntries(Object.entries(tickets).reverse()) });
  assert.deepEqual(backward, forward, 'the board changed when the tree was scanned in a different order');
});

test('a blocker promoted to Frozen was quoted to its dependants as Blocked', () => {
  // The boundary of the contract, pinned so nobody has to rediscover it. `resolveBlockers`
  // runs before the chain walk, so it reports a blocker's **pre-chain** state: 02 is rendered
  // Frozen on the board, and 03 was told `blocked` when its own state was derived.
  //
  // That is why the invariant below is stated as *satisfaction* equivalence — quoted `done`
  // exactly when done — rather than as literal equality with the card. Literal equality is
  // false here and cannot be made true: the chain pass needs the ladder to have run, and the
  // ladder needs these values. Nothing downstream is harmed, because `frozen` is a labelled
  // refinement of `blocked` and the ladder treats every non-`done` state alike.
  const snapshot = derive({
    alpha: {
      '01-relay.md': humanReady(),
      '02-behind-relay.md': blockedOn('01'),
      '03-behind-that.md': blockedOn('02'),
    },
  });

  assert.equal(cardIn(snapshot, 'alpha', '02-').derivation.state, 'frozen');
  assert.equal(
    cardIn(snapshot, 'alpha', '03-').derivation.state,
    'frozen',
    '03 was gated on a blocker quoted as `blocked` and still had to reach Frozen through it',
  );
  assertGraphAgreesWithBoard(snapshot);
});

test('the graph and the board never disagree about whether a blocker is satisfied', () => {
  // The anti-drift assertion. The state this pass used for a Ticket **as a blocker** is not
  // on the Snapshot, so it is checked through its only observable consequence: every card's
  // own state has to be consistent with the states of the cards it names. If the two ever
  // diverge, a card reads Blocked while its only blocker reads Done — an observable
  // contradiction that this assertion rejects.
  assertGraphAgreesWithBoard(
    derive({
      alpha: {
        '01-finished.md': doneTicket(),
        '02-relay.md': humanReady(),
        '03-clears.md': blockedOn('01'),
        '04-blocked.md': blockedOn('02'),
        '05-mixed.md': blockedOn('01, 02'),
        '06-dangling.md': blockedOn('91'),
        '07-external.md': external(),
        '08-cycle.md': blockedOn('09'),
        '09-cycle-back.md': blockedOn('08'),
        '10-unclassified.md': unclassified(),
        '11-behind-unclassified.md': blockedOn('10'),
      },
      beta: { '01-alone.md': agentReady() },
    }),
  );
});

test('done-ness never depends on the blockers a Ticket names', () => {
  // The assumption the whole first pass rests on. `blockerStates` is read in exactly one
  // place — `isBlocked`, on the last rung of both ladders — so every rung that can return
  // `done` sits above it and reads only criteria or the Status prefix. That is what makes two
  // ordinary passes sufficient where a fixpoint would otherwise be needed, and it is one edit
  // to `derive.ts` away from being false, so it is asserted here rather than assumed.
  //
  // Checked through the seam by deriving each shape twice: once with its blocker present and
  // finished, once with the blocker gone entirely. Only the blocked-versus-ready rung may
  // move between the two.
  const statuses = ['ready-for-agent', 'ready-for-human', 'done', 'resolved', 'wontfix', 'closed', 'open', 'claimed', 'needs-triage'];
  const shapes: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 2],
  ];
  const movable = new Set(['blocked', 'ready']);
  let checked = 0;

  for (const status of statuses) {
    for (const [checkedBoxes, total] of shapes) {
      const subject = taskText({ blockers: '01', status, checked: checkedBoxes, total });
      const withFinished = cardIn(
        derive({ alpha: { '01-finished.md': doneTicket(), '02-subject.md': subject } }),
        'alpha',
        '02-',
      ).derivation.state;
      const withNothing = cardIn(
        derive({ alpha: { '02-subject.md': subject } }),
        'alpha',
        '02-',
      ).derivation.state;

      const where = `${status} ${checkedBoxes}/${total}`;
      if (withFinished !== withNothing) {
        assert.ok(
          movable.has(withFinished) && movable.has(withNothing),
          `${where}: removing the blocker moved the state from ${withNothing} to ${withFinished}. Only the blocked/ready rung may move — anything else means a rung above isBlocked now reads blockerStates, and the two-pass first graph pass is no longer exact.`,
        );
      }
      assert.equal(
        withFinished === 'done',
        withNothing === 'done',
        `${where}: done-ness changed with the blockers, so it is not a pure function of the Extraction`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, statuses.length * shapes.length, 'the matrix did not run');
});

test('the committed corpus satisfies the same invariant', () => {
  // Reached through `corpus-tree.ts`, which is a plain module rather than a test file —
  // importing one test file from another would re-register its tests, because `node --test`
  // runs each file in its own process.
  assertGraphAgreesWithBoard(deriveSnapshot(corpusScan(), EMPTY_ANNOTATIONS));
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

test('a densely shared chain does not explode the walk', () => {
  // The cycle guard holds only the ids on the current path, so a Ticket reached twice by two
  // different routes is re-entered rather than refused. That is required for correctness and,
  // unmemoised, it is exponential: a Feature where every path terminates at a person never
  // short-circuits, so the walk explores every path there is. Measured before the memo, on
  // exactly this shape: 16 ms at 18 Tickets, 229 ms at 22, 961 ms at 24 — four times the work
  // for every two Tickets added, and nothing usable by about 34.
  //
  // This is asserted as wall-clock because exponential-versus-linear has no other observable
  // form, and the headroom is what keeps it from being flaky: 26 Tickets costs single-digit
  // milliseconds memoised and about 3.8 seconds without, so the bound below sits ~1000x above
  // the real cost and ~2x below the regression. It matters because the seam is called
  // synchronously from the watcher on every file change — the failure is not a slow board, it
  // is a board that stops updating and says nothing.
  const size = 26;
  const tickets: Record<string, string> = {
    '01-relay.md': humanReady(),
  };
  for (let number = 2; number <= size; number += 1) {
    const blockers = Array.from({ length: number - 1 }, (_unused, index) =>
      String(index + 1).padStart(2, '0'),
    ).join(', ');
    tickets[`${String(number).padStart(2, '0')}-shared.md`] = blockedOn(blockers);
  }

  const started = performance.now();
  const snapshot = derive({ alpha: tickets });
  const elapsed = performance.now() - started;

  // Correctness first — a fast wrong answer is not the thing being checked.
  const relay = cardIn(snapshot, 'alpha', '01-');
  assert.equal(relay.derivation.lane, 'needs-you');
  const frozen = featureOf(snapshot, 'alpha').tickets.filter(
    (ticket) => ticket.derivation.lane === 'frozen',
  );
  assert.equal(frozen.length, size - 1, 'every Ticket above the relay traces to it and must be Frozen');
  for (const card of frozen) {
    assert.equal(card.derivation.frozenOn, relay.id, `${card.fileName} named the wrong terminal`);
  }
  assert.ok(
    elapsed < 2000,
    `the walk took ${elapsed.toFixed(0)} ms on ${size} Tickets. That is the exponential path explosion returning — see the Walk memo in graph.ts.`,
  );
});

// ---------------------------------------------------------------------------
// Ticket text. Every role is a real shape, asserted where it matters rather than assumed.
// ---------------------------------------------------------------------------

interface TaskOptions {
  readonly blockers?: string;
  readonly status?: string;
  readonly checked?: number;
  readonly total?: number;
}

function taskText(options: TaskOptions = {}): string {
  const total = options.total ?? 1;
  const checked = options.checked ?? 0;
  const boxes = Array.from(
    { length: total },
    (_unused, index) => `- [${index < checked ? 'x' : ' '}] criterion ${index + 1}`,
  );
  return [
    '# A Ticket',
    '',
    '**What to build:** One line, so the Dialect scorer sees task syntax.',
    '',
    `**Blocked by:** ${options.blockers ?? 'None.'}`,
    '',
    `**Status:** ${options.status ?? 'ready-for-agent'}`,
    '',
    ...boxes,
    '',
  ].join('\n');
}

/** Unstarted, unblocked, takeable by an agent. */
function agentReady(): string {
  return taskText();
}

/** Unstarted, unblocked, and assigned to a person by its Status. */
function humanReady(): string {
  return taskText({ status: 'ready-for-human' });
}

function blockedOn(blockers: string): string {
  return taskText({ blockers });
}

function humanBlockedOn(blockers: string): string {
  return taskText({ blockers, status: 'ready-for-human' });
}

function inProgress(blockers: string): string {
  return taskText({ blockers, checked: 1, total: 2 });
}

function doneTicket(): string {
  return taskText({ checked: 1, total: 1, status: 'done' });
}

function parked(): string {
  return taskText({ status: 'wontfix' });
}

/** Blocked by something that is not a Ticket, so it names no number at all. */
function external(): string {
  return taskText({ blockers: 'External legal sign-off.' });
}

/**
 * Ambiguous on purpose, in both directions at once: an unknown `Type:`, decision-shaped bare
 * fields carrying task vocabulary, unknown fields, and a heading belonging to neither
 * template. The scorer answers `unclassified`, which holds no Lane.
 */
function unclassified(): string {
  return [
    '# A Ticket whose shape belongs to neither template',
    '',
    'Type: research + implement',
    'Created: a while ago',
    'Origin: user report',
    'Blocked by: —',
    'Status: ready-for-human',
    '',
    '## Problem',
    '',
    'Prose that matches no template.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Trees and lookups
// ---------------------------------------------------------------------------

type Features = Readonly<Record<string, Readonly<Record<string, string | null>>>>;

function derive(features: Features): Snapshot {
  return deriveSnapshot(tree(features), EMPTY_ANNOTATIONS);
}

function tree(features: Features): Scan {
  const files = Object.entries(features).flatMap(([feature, tickets]) =>
    Object.entries(tickets).map(([fileName, text]) => {
      const path = `${feature}/issues/${fileName}`;
      return { path, absPath: `/repo/.scratch/${path}`, text };
    }),
  );
  return {
    roots: [
      {
        path: '/repo',
        label: 'repo',
        trackerPath: '/repo/.scratch',
        files,
        hiddenWorktrees: 0,
        tracker: 'local-markdown',
        adrFiles: [],
        glossaryFile: null,
      },
    ],
  };
}

function featureOf(snapshot: Snapshot, name: string) {
  const feature = snapshot.roots[0]?.features.find((candidate) => candidate.name === name);
  assert.ok(feature !== undefined, `the tree produced no Feature called ${name}`);
  return feature;
}

/**
 * Every card's own state agrees with the states of the cards it names as blockers.
 *
 * Reads nothing but the Snapshot — it re-derives no rule from the source text, it checks two
 * halves of one output against each other. `blockerStates` is internal to the seam, so this
 * is the only way to assert, from outside, that the graph and the board agree.
 *
 * **What it proves is satisfaction equivalence, not literal state equality** — that a blocker
 * counted as clearing a dependency is exactly one the board renders as Done. It deliberately
 * does not require the quoted state to be the card's final state, because the first graph pass
 * runs before Frozen promotion and a Frozen card was quoted as `blocked`. That boundary has
 * its own test above; this is the invariant that actually governs whether work is offered.
 *
 * Only the two blocker-dependent states carry an obligation. `done`, `done-awaiting-human`,
 * `in-progress`, `parked`, `unparsed` and `unclassified` are all decided on rungs above the
 * blocker test, so a Ticket in one of them is saying nothing about its blockers.
 */
function assertGraphAgreesWithBoard(snapshot: Snapshot): void {
  for (const root of snapshot.roots) {
    for (const feature of root.features) {
      const claimed = new Map<number, number>();
      for (const card of feature.tickets) {
        const number = card.extraction.number;
        if (number !== null) claimed.set(number, (claimed.get(number) ?? 0) + 1);
      }
      const byNumber = new Map<number, TicketCard>();
      for (const card of feature.tickets) {
        const number = card.extraction.number;
        // A number two files claim resolves to neither, so it is not a blocker anyone can
        // check against — it is accounted for through `danglingBlockers` instead.
        if (number !== null && claimed.get(number) === 1) byNumber.set(number, card);
      }

      for (const card of feature.tickets) {
        const state = card.derivation.state;
        if (state !== 'ready' && state !== 'blocked' && state !== 'frozen') continue;
        const where = `${feature.name}/${card.fileName}`;

        const external = card.extraction.externalBlocker;
        const hasExternal = typeof external === 'string' && external.trim().length > 0;
        const hasDangling = card.derivation.danglingBlockers.length > 0;
        const unsatisfied = card.extraction.blockedBy
          .map((number) => byNumber.get(number))
          .filter((blocker) => blocker === undefined || blocker.derivation.state !== 'done');

        if (state === 'ready') {
          assert.deepEqual(
            [hasExternal, hasDangling, unsatisfied.length],
            [false, false, 0],
            `${where} is Ready while something still holds it. The graph and the board disagree about at least one of its blockers.`,
          );
          continue;
        }
        assert.ok(
          hasExternal || hasDangling || unsatisfied.length > 0,
          `${where} is ${state} while every blocker it names is finished and nothing else holds it. The graph used a different state for one of them than the board shows.`,
        );
      }
    }
  }
}

/** Looked up by filename — observable output — never by an id rebuilt from its parts. */
function cardIn(snapshot: Snapshot, feature: string, filePrefix: string): TicketCard {
  const found = featureOf(snapshot, feature).tickets.filter((ticket) =>
    ticket.fileName.startsWith(filePrefix),
  );
  assert.equal(found.length, 1, `${feature}/${filePrefix}* matched ${found.length} cards, expected exactly 1`);
  const card = found[0];
  assert.ok(card !== undefined);
  return card;
}
