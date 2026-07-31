/**
 * The criteria region and `Type:` HITL/AFK routing, asserted **through the seam**.
 *
 * Every test here calls `deriveSnapshot` with a one-file tree and reads the resulting
 * `TicketCard`. None of them names a rule function, a regex or an intermediate shape, so
 * the whole rule can be reimplemented without a test changing — and the rule modules stay
 * reachable only through the seam, which `seam.test.ts` enforces.
 *
 * Nothing here touches the filesystem except the fixture directory the skill ships, read
 * through `import.meta.dirname`. No test asserts anything about the repository it happens
 * to be checked out in.
 *
 * The `tickets/` fixture loop covers each rule against one real file shape. This file
 * covers the shapes the corpus does not happen to contain yet — a checkbox quoted inside a
 * code sample, a region heading written inside an HTML comment, variant line endings, a
 * torn read — and the one type value that would flood the human lane if the marker were
 * matched as a bare substring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS, oneFileTree } from './harness.ts';
import type { Criteria, TicketCard } from '../core/types.ts';

const TICKETS_DIR = join(import.meta.dirname, 'fixtures', 'tickets');

/** Written as a string so the fence characters survive being embedded in a document. */
const BACKTICK_FENCE = '```';
const LONG_BACKTICK_FENCE = '````';
const TILDE_FENCE = '~~~';

// ---------------------------------------------------------------------------
// Where the region is cut
// ---------------------------------------------------------------------------

test('checkboxes below the first `## Comments` heading are not criteria', () => {
  const criteria = criteriaOf(
    doc(
      '# 01 — Ship it',
      '',
      '- [x] the first criterion',
      '- [ ] the second criterion',
      '',
      '## Comments',
      '',
      '- [ ] triage: has this been reviewed',
      '- [ ] triage: does it need a migration',
    ),
  );

  // The whole point of the rule: a review checklist is never ticked, so counting it pins a
  // finished Ticket at In progress for as long as the file exists.
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['the first criterion', 'the second criterion'],
  );
});

test('`## Answer` cuts the region as well as `## Comments`', () => {
  const criteria = criteriaOf(
    doc('- [ ] decide the shape', '', '## Answer', '', '- [x] recorded in an ADR'),
  );
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 0);
});

test('a region heading is matched by prefix, so trailing prose and a stamp still cut', () => {
  for (const heading of [
    '## Comments',
    '## Comments (2026-07-24)',
    '## Comments — from the review pass',
    '## Answer',
    '## Answer: keep the seam',
    '## Answers',
  ]) {
    const criteria = criteriaOf(doc('- [ ] above', '', heading, '', '- [x] below', '- [x] below'));
    assert.equal(criteria.total, 1, `${heading} did not cut the region`);
    assert.equal(criteria.checked, 0, `${heading} counted a checkbox below the cut`);
  }
});

test('a region heading is matched case-insensitively', () => {
  for (const heading of ['## comments', '## COMMENTS', '## answer', '## AnSwEr']) {
    const criteria = criteriaOf(doc('- [ ] above', heading, '- [x] below'));
    assert.equal(criteria.total, 1, `${heading} did not cut the region`);
  }
});

test('only the first region heading matters — a second one changes nothing', () => {
  const criteria = criteriaOf(
    doc('- [x] above', '## Comments', '- [ ] below', '## Comments', '- [ ] lower still'),
  );
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 1);
});

test('a heading that is not `## Comments` or `## Answer` does not cut the region', () => {
  const criteria = criteriaOf(
    doc(
      '## Criteria',
      '- [x] one',
      '',
      '## Notes',
      '- [x] two',
      '',
      '## Commentary is a different word',
      '- [ ] three',
    ),
  );
  assert.equal(criteria.total, 3);
  assert.equal(criteria.checked, 2);
});

test('`### Comments` does not cut — the rule reads `## ` at column 0', () => {
  const criteria = criteriaOf(doc('- [x] above', '### Comments', '- [x] below'));
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 2);
});

test('a region heading indented up to three spaces still cuts', () => {
  // CommonMark allows three spaces before an ATX heading, and a Ticket nesting one under a
  // list item writes exactly that. Reading only column 0 counts the review checklist below
  // it, which is the permanent-unfinished defect this rule exists to prevent.
  for (const indent of ['', ' ', '  ', '   ']) {
    const criteria = criteriaOf(doc('- [x] above', `${indent}## Comments`, '- [ ] below'));
    assert.equal(criteria.total, 1, `${indent.length} spaces did not cut the region`);
    assert.equal(criteria.checked, 1, `${indent.length} spaces counted a checkbox below the cut`);
  }
});

test('a fourth space makes the line indented code, and it does not cut', () => {
  const criteria = criteriaOf(doc('- [x] above', '    ## Comments', '- [x] below'));
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 2);
});

test('a Ticket with no region heading counts every checkbox in the file', () => {
  const criteria = criteriaOf(doc('- [x] one', '- [x] two', '- [ ] three'));
  assert.equal(criteria.total, 3);
  assert.equal(criteria.checked, 2);
});

// ---------------------------------------------------------------------------
// Fenced samples and HTML comments
// ---------------------------------------------------------------------------

test('a region heading inside a fenced sample does not cut the region', () => {
  const criteria = criteriaOf(
    doc(
      '- [x] one',
      '',
      `${BACKTICK_FENCE}markdown`,
      '## Comments',
      BACKTICK_FENCE,
      '',
      '- [x] two',
    ),
  );
  // A Ticket documenting its own markup would otherwise cut at line three and report 0/0
  // for a file full of criteria.
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 2);
});

test('checkboxes inside a fenced sample are not criteria', () => {
  const criteria = criteriaOf(
    doc(
      '- [ ] the real one',
      '',
      `${TILDE_FENCE}text`,
      '- [x] sample',
      '- [x] sample',
      TILDE_FENCE,
    ),
  );
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 0);
});

test('a fence is not closed by a line carrying anything but whitespace after it', () => {
  const criteria = criteriaOf(
    doc(
      `${BACKTICK_FENCE}text`,
      `${BACKTICK_FENCE}lang`,
      '- [x] still inside the sample',
      BACKTICK_FENCE,
      '- [ ] the real one',
    ),
  );
  // Without the suffix rule the ```lang line ends the sample early and the checkbox
  // written inside it is counted.
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 0);
});

test('a fence is not closed by the other fence character', () => {
  const criteria = criteriaOf(
    doc(BACKTICK_FENCE, TILDE_FENCE, '- [x] still inside the sample', BACKTICK_FENCE, '- [ ] the real one'),
  );
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 0);
});

test('a sample fenced under a list item is suppressed however deep it is indented', () => {
  // The three-space allowance CommonMark states is relative to the enclosing container, so
  // a fence nested under a list item sits four, six or eight spaces in. Measuring from
  // column 0 misses them and counts the sample's own checkboxes.
  for (const indent of ['    ', '      ', '        ']) {
    const criteria = criteriaOf(
      doc(
        '- [ ] the real criterion',
        `${indent}${BACKTICK_FENCE}`,
        `${indent}- [x] sample`,
        `${indent}${BACKTICK_FENCE}`,
      ),
    );
    assert.equal(criteria.total, 1, `${indent.length} spaces counted the sample`);
    assert.equal(criteria.checked, 0, `${indent.length} spaces ticked the criterion`);
    assert.deepEqual(
      criteria.items.map((item) => item.text),
      ['the real criterion'],
      `${indent.length} spaces folded the fence into the criterion`,
    );
  }
});

test('a nested criterion at four spaces still counts, fence or no fence', () => {
  // The counterweight to the rule above: an indented checkbox and an indented code block
  // are the same shape, and dropping a real criterion is the one direction this must not
  // take.
  const criteria = criteriaOf(doc('- [ ] parent', '    - [x] nested child'));
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
});

test('a fence is not closed by a shorter run of its own character', () => {
  const criteria = criteriaOf(
    doc(
      LONG_BACKTICK_FENCE,
      BACKTICK_FENCE,
      '- [x] still inside the sample',
      LONG_BACKTICK_FENCE,
      '- [ ] the real one',
    ),
  );
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 0);
});

test('checkboxes inside an HTML comment are not criteria', () => {
  const criteria = criteriaOf(
    doc(
      '<!-- expect: criteria=1/1 -->',
      '',
      '<!--',
      '- [x] an old criterion, commented out',
      '- [x] another',
      '-->',
      '',
      '- [ ] the live one',
    ),
  );
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 0);
});

test('a region heading inside an HTML comment does not cut the region', () => {
  const criteria = criteriaOf(
    doc('- [x] one', '<!-- the triage pass writes its list under ## Comments -->', '- [x] two'),
  );
  assert.equal(criteria.total, 2);
});

test('a region heading that resumes after a comment closes still cuts', () => {
  const criteria = criteriaOf(doc('- [x] one', '<!-- note', 'still note -->## Comments', '- [ ] two'));
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 1);
});

test('a comment delimiter quoted in inline code does not hide the criteria below it', () => {
  // Hiding an *unchecked* criterion turns 1/2 into 1/1, so an unfinished Ticket reads as
  // finished — the one direction a hidden criterion is worse than a counted one.
  const criteria = criteriaOf(
    doc('- [x] first', '', 'Open the expectation with `<!--` and close it with `-->`.', '', '- [ ] second'),
  );
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
});

test('an unbalanced comment opener quoted in inline code is still inert', () => {
  const criteria = criteriaOf(doc('- [x] first', '', 'Write `<!--` to open it.', '', '- [ ] second'));
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
});

test('a code span closes only on a run of its own length', () => {
  // ``…`` is one span quoting a literal backtick, not two. Pairing the outer run with the
  // inner single backtick ends the span early and leaves the `<!--` outside it, which then
  // opens a comment that never closes and hides the unchecked criterion below.
  const criteria = criteriaOf(doc('- [x] first', '', '``a ` b <!-- c``', '', '- [ ] second'));
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
});

test('a real comment is still a comment when a code span sits beside it', () => {
  const criteria = criteriaOf(
    doc('- [x] first', '`inline` <!--', '- [ ] hidden', '-->', '- [ ] second'),
  );
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
});

test('a code span after a comment opener is inside the comment, not beside it', () => {
  // Order matters both ways round. Reading the span first steps over the `<!--` entirely,
  // so the commented-out checkbox below is counted as live work.
  const criteria = criteriaOf(
    doc('- [x] first', '<!-- `code` was here', '- [ ] commented out', '-->', '- [ ] second'),
  );
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['first', 'second'],
  );
});

test('an unterminated comment hides the criteria below it rather than counting them', () => {
  // The shape a torn read leaves behind. Degrading to a smaller ratio is visible; counting
  // commented-out markup as live criteria is not.
  const criteria = criteriaOf(doc('- [x] one', '<!-- mid-write', '- [ ] two', '- [ ] three'));
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 1);
});

test('an unterminated fence hides the criteria below it and never throws', () => {
  const criteria = criteriaOf(doc('- [x] one', BACKTICK_FENCE, '- [ ] two'));
  assert.equal(criteria.total, 1);
});

// ---------------------------------------------------------------------------
// What counts as a checkbox
// ---------------------------------------------------------------------------

test('both checked states are counted, and the ratio is not just a total', () => {
  const criteria = criteriaOf(doc('- [x] lower case', '- [X] upper case', '- [ ] unchecked'));
  assert.equal(criteria.total, 3);
  assert.equal(criteria.checked, 2);
  assert.deepEqual(
    criteria.items.map((item) => item.checked),
    [true, true, false],
  );
});

test('all three bullet markers make a criterion', () => {
  const criteria = criteriaOf(doc('- [x] dash', '* [x] star', '+ [ ] plus'));
  assert.equal(criteria.total, 3);
  assert.equal(criteria.checked, 2);
});

test('a link whose text is `x` is not a ticked criterion', () => {
  // `- [x](./notes.md)` is an ordinary link. Without the whitespace rule after the bracket
  // it reads as a finished criterion, and a Ticket whose body links to notes reports done.
  const criteria = criteriaOf(doc('- [x](./notes.md)', '- [ ](./open.md)', '- [x] the real one'));
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 1);
});

test('a criterion carrying no text is still a criterion', () => {
  const criteria = criteriaOf(doc('- [x]', '- [ ]'));
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['', ''],
  );
});

test('a nested criterion counts — a ratio that omits half a list is worse than none', () => {
  const criteria = criteriaOf(doc('- [x] parent', '  - [x] child', '    - [ ] grandchild'));
  assert.equal(criteria.total, 3);
  assert.equal(criteria.checked, 2);
});

test('a bracket holding anything but a space or an x is not a checkbox', () => {
  const criteria = criteriaOf(doc('- [-] partial', '- [o] some other tool', '- [~] and another'));
  assert.equal(criteria.total, 0);
});

test('a numbered task list is a documented gap, not a silently wrong count', () => {
  // Stated so the behaviour is deliberate: when a real file writes criteria this way, that
  // file becomes the fixture and the rule follows it.
  const criteria = criteriaOf(doc('1. [x] numbered', '2) [ ] numbered', '- [ ] bulleted'));
  assert.equal(criteria.total, 1);
  assert.equal(criteria.checked, 0);
});

test('a Ticket with no checkboxes reports 0/0 and is not an error', () => {
  const card = cardFor(
    'decision.md',
    doc('Status: open', 'Type: decision', '', 'Should the seam stay pure?'),
  );
  assert.equal(card.extraction.criteria.total, 0);
  assert.equal(card.extraction.criteria.checked, 0);
  assert.deepEqual([...card.extraction.criteria.items], []);
  assert.equal(card.readError, null);
});

// ---------------------------------------------------------------------------
// Item text
// ---------------------------------------------------------------------------

test('a wrapped criterion keeps its continuation lines, joined by one space', () => {
  const criteria = criteriaOf(
    doc(
      '- [ ] The criteria region is cut at the first `## Comments` or `## Answer`,',
      '      matched by prefix so a heading carrying trailing prose still cuts',
      '',
      '- [x] Both checked and unchecked states are counted',
    ),
  );
  assert.equal(criteria.total, 2);
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    [
      'The criteria region is cut at the first `## Comments` or `## Answer`, matched by prefix so a heading carrying trailing prose still cuts',
      'Both checked and unchecked states are counted',
    ],
  );
});

test('an unindented line below a criterion is prose, not a continuation', () => {
  const criteria = criteriaOf(doc('- [ ] the criterion', 'A paragraph that follows it.'));
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['the criterion'],
  );
});

test('a blank line ends a criterion, so a later indented block is not folded in', () => {
  const criteria = criteriaOf(doc('- [ ] the criterion', '', '      an indented block below'));
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['the criterion'],
  );
});

test('a following list item is its own item and is never folded into the one above', () => {
  const criteria = criteriaOf(doc('- [ ] the criterion', '  - a plain sub-bullet', '  1. and a numbered one'));
  assert.equal(criteria.total, 1);
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['the criterion'],
  );
});

test('an indented heading below a criterion is not folded into it', () => {
  const criteria = criteriaOf(doc('- [ ] the criterion', '  ### a heading'));
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['the criterion'],
  );
});

test('a section heading ends the criterion above it, so the prose below is not folded in', () => {
  const criteria = criteriaOf(
    doc('- [ ] the criterion', '## Notes', '  an indented line under the heading'),
  );
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['the criterion'],
  );
});

test('a fenced sample ends the criterion above it, and neither it nor what follows is folded in', () => {
  const criteria = criteriaOf(
    doc(
      '- [ ] the criterion',
      `  ${BACKTICK_FENCE}`,
      '  sample text',
      `  ${BACKTICK_FENCE}`,
      '  an indented line below the sample',
    ),
  );
  assert.deepEqual(
    criteria.items.map((item) => item.text),
    ['the criterion'],
  );
});

// ---------------------------------------------------------------------------
// Portability and torn reads
// ---------------------------------------------------------------------------

test('CRLF, lone CR and LF files yield the same criteria', () => {
  // A wrapped criterion is in here on purpose: the counts survive `\r\n` being read as two
  // terminators, and only the folded text shows that it was not.
  const lines = [
    '- [x] one and',
    '      its continuation',
    '- [ ] two',
    '## Comments',
    '- [ ] not a criterion',
  ];
  const readings = [lines.join('\n'), lines.join('\r\n'), lines.join('\r')].map((text) =>
    criteriaOf(text),
  );
  for (const criteria of readings) {
    assert.equal(criteria.total, 2);
    assert.equal(criteria.checked, 1);
    assert.deepEqual(
      criteria.items.map((item) => item.text),
      ['one and its continuation', 'two'],
    );
  }
});

test('a leading byte-order mark does not hide the first criterion', () => {
  // Written from a code point rather than a literal, which is invisible in a diff.
  const criteria = criteriaOf(`${String.fromCharCode(0xfeff)}- [x] one\n- [ ] two`);
  assert.equal(criteria.total, 2);
  assert.equal(criteria.checked, 1);
});

test('a file that could not be read at all reports 0/0 rather than throwing', () => {
  const snapshot = deriveSnapshot(oneFileTree('unreadable.md', null), EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, 'the one-file tree produced no card');
  assert.equal(card.extraction.criteria.total, 0);
  assert.equal(card.extraction.criteria.checked, 0);
  assert.equal(card.extraction.ticketType, null);
  assert.equal(card.extraction.hitl, false);
});

test('a file truncated mid-line still reports what it did contain', () => {
  const card = cardFor('torn.md', doc('- [x] one', '- [ ] two', '- [x'));
  assert.equal(card.extraction.criteria.total, 2);
  assert.equal(card.extraction.criteria.checked, 1);
  assert.equal(card.readError, null);
});

test('an empty file and a file of bare newlines both report 0/0 without throwing', () => {
  for (const text of ['', '\n', '\n\n\n', '\r\n\r\n']) {
    const criteria = criteriaOf(text);
    assert.equal(criteria.total, 0);
    assert.equal(criteria.checked, 0);
  }
});

test('every reading returns its own items array', () => {
  // One shared instance would alias every criteria-free card's items onto the same memory,
  // so a caller appending to one card's items would rewrite every other card's.
  const first = criteriaOf('Status: open');
  const second = criteriaOf('Status: open');
  assert.notEqual(first.items, second.items);
});

// ---------------------------------------------------------------------------
// `Type:` routing
// ---------------------------------------------------------------------------

test('a parenthetical HITL marker inside `Type:` routes, and the value is kept for display', () => {
  const card = cardFor(
    '01-relay.md',
    doc('Type: task (HITL — the user relays; the vendor contact answers)', 'Status: in progress'),
  );
  assert.equal(card.extraction.hitl, true);
  assert.equal(
    card.extraction.ticketType,
    'task (HITL — the user relays; the vendor contact answers)',
  );
});

test('AFK is the same routing signal as HITL', () => {
  const card = cardFor('02-research.md', doc('Type: research (AFK)', 'Status: ready-for-agent'));
  assert.equal(card.extraction.hitl, true);
  assert.equal(card.extraction.ticketType, 'research (AFK)');
});

test('the marker is matched case-insensitively and in every punctuation the corpus writes', () => {
  for (const value of [
    'task (HITL)',
    'task (hitl)',
    'Task — Hitl',
    'research (AFK)',
    'research (afk)',
    'AFK-research',
    'HITL/AFK',
    'hitl',
    'task, AFK, blocked on a person',
    'AFK',
  ]) {
    const card = cardFor('06-typed.md', `Type: ${value}`);
    assert.equal(card.extraction.hitl, true, `${value} did not route to the human lane`);
    assert.equal(card.extraction.ticketType, value, `${value} was not preserved verbatim`);
  }
});

test('a word merely containing the letters does not route', () => {
  // `kafka` contains `afk`. A bare substring test routes a broker migration to the human
  // lane, which is exactly the flood this rule exists to prevent.
  for (const value of [
    'kafka consumer',
    'Kafka',
    'kafkaesque',
    'refactoring',
    'whitlow',
    'architect',
  ]) {
    const card = cardFor('07-typed.md', `Type: ${value}`);
    assert.equal(card.extraction.hitl, false, `${value} routed to the human lane`);
    assert.equal(card.extraction.ticketType, value, `${value} was not preserved verbatim`);
  }
});

test('the marker is never read from the body, the criteria or the status qualifier', () => {
  const card = cardFor(
    '03-signed-off.md',
    doc(
      'Status: done (HITL sign-off received 2026-07-01)',
      'Type: implementation',
      '',
      '# 03 — Ship the exporter',
      '',
      'The HITL review happened before the branch was cut, so nothing is outstanding.',
      '',
      '- [x] HITL sign-off recorded',
      '- [x] AFK research folded in',
    ),
  );
  // The negative case: a finished Ticket that must not be asked for again.
  assert.equal(card.extraction.hitl, false);
  assert.equal(card.extraction.ticketType, 'implementation');
  assert.equal(card.extraction.criteria.total, 2);
  assert.equal(card.extraction.criteria.checked, 2);
});

test('an absent `Type:` field is `null`, and a present but empty one stays empty', () => {
  const absent = cardFor('04-no-type.md', doc('Status: open', '', 'Prose only.'));
  assert.equal(absent.extraction.ticketType, null);
  assert.equal(absent.extraction.hitl, false);

  const empty = cardFor('05-empty-type.md', doc('Status: open', 'Type:'));
  // `null` answers a different question — the field is there, and Dialect scoring reads
  // this value as a weak prior.
  assert.equal(empty.extraction.ticketType, '');
  assert.equal(empty.extraction.hitl, false);
});

// ---------------------------------------------------------------------------
// Invariants over the shipped corpus
// ---------------------------------------------------------------------------

test('across every fixture, the ratio and the items agree and the ratio is well formed', () => {
  let checkedFixtures = 0;
  for (const fixture of fixtureNames()) {
    const criteria = cardFor(fixture, readFixture(fixture)).extraction.criteria;
    checkedFixtures += 1;
    assert.equal(criteria.items.length, criteria.total, `${fixture}: items disagree with total`);
    assert.ok(criteria.checked <= criteria.total, `${fixture}: more checked than total`);
    assert.ok(criteria.checked >= 0, `${fixture}: a negative checked count`);
    assert.equal(
      criteria.items.filter((item) => item.checked).length,
      criteria.checked,
      `${fixture}: the ticked items disagree with the checked count`,
    );
  }
  assert.ok(checkedFixtures > 0, 'the fixture directory produced no files to check');
});

test('across every fixture, routing depends on the `Type:` value and on nothing else in the file', () => {
  // The rule is not restated here. Each fixture's own type value is replayed as a Ticket
  // that has *only* that line, and the two readings must agree — which is what "never the
  // body, never criteria, never the status qualifier" means when it is checked rather than
  // asserted.
  let routed = 0;
  let typed = 0;
  for (const fixture of fixtureNames()) {
    const extraction = cardFor(fixture, readFixture(fixture)).extraction;
    const value = extraction.ticketType;
    const alone =
      value === null
        ? cardFor(fixture, 'Status: open')
        : cardFor(fixture, `Type: ${value}`);
    assert.equal(
      extraction.hitl,
      alone.extraction.hitl,
      `${fixture}: routing disagrees with its own type value read on its own`,
    );
    if (value !== null) typed += 1;
    if (extraction.hitl) routed += 1;
  }
  // An invariant that only ever sees `false` on both sides holds trivially and would keep
  // holding if the rule stopped working, so both sides are shown to be exercised.
  assert.ok(typed > 0, 'no fixture carried a `Type:` field, so the invariant proved nothing');
  assert.ok(routed > 0, 'no fixture routed to the human lane, so the invariant proved nothing');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function doc(...lines: readonly string[]): string {
  return lines.join('\n');
}

function cardFor(fileName: string, text: string): TicketCard {
  const snapshot = deriveSnapshot(oneFileTree(fileName, text), EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, `${fileName}: the one-file tree produced no card`);
  return card;
}

function criteriaOf(text: string): Criteria {
  return cardFor('01-criteria.md', text).extraction.criteria;
}

function fixtureNames(): readonly string[] {
  return readdirSync(TICKETS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function readFixture(fixture: string): string {
  return readFileSync(join(TICKETS_DIR, fixture), 'utf8');
}
