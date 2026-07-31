/**
 * Dialect scoring, asserted **through the seam**.
 *
 * Every test calls `deriveSnapshot` and reads `extraction.dialect` off the resulting
 * `TicketCard`. None names the scoring function, a weight, a threshold or an intermediate
 * shape — the whole scheme can be re-tuned without a test changing, which is the point,
 * because this is the rule most likely to need tuning against a repo nobody has seen yet.
 *
 * The signed confidence itself is deliberately not asserted anywhere: it is not on the
 * Snapshot, so asserting it would mean reaching past the seam to check a number instead of
 * the answer it produces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS, oneFileTree } from './harness.ts';
import type { Root, Scan, TicketCard } from '../core/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const TICKETS_DIR = join(FIXTURES, 'tickets');
const CORPUS_DIR = join(FIXTURES, 'corpus');

/** The task template: bold field markers, a `What to build:` field, checkboxes. */
const TASK_SHAPE = [
  '# 01 — A task Ticket',
  '',
  '**What to build:** One normalizer every source passes through.',
  '',
  '**Blocked by:** None.',
  '',
  '**Status:** ready-for-agent',
  '',
  '- [ ] the first criterion',
  '- [ ] the second criterion',
].join('\n');

/** The decision template: bare field markers, a `## Question` section, no checkboxes. */
const DECISION_SHAPE = [
  '# 02 — A decision Ticket',
  '',
  'Type: grilling',
  'Blocked by: 01',
  'Status: open',
  '',
  '## Question',
  '',
  'Which surface do we migrate first?',
].join('\n');

// ---------------------------------------------------------------------------
// The two templates
// ---------------------------------------------------------------------------

test('the task template scores task and the decision template scores decision', () => {
  assert.equal(dialectOf('01-task.md', TASK_SHAPE), 'task');
  assert.equal(dialectOf('02-decision.md', DECISION_SHAPE), 'decision');
});

test('flipping only the marker style withdraws the answer rather than inverting it', () => {
  // Take each template and change **nothing but** the field markers. The syntax now
  // contradicts everything else the file says — checkboxes and a `What to build:` field in
  // bare markers, or a `## Question` and no checkboxes in bold ones — and the honest
  // response to a file arguing with itself is to decline, not to pick the louder signal.
  //
  // This is the property `type-unknown-hybrid` encodes, asserted on a file built here so it
  // does not depend on that one fixture continuing to exist.
  const boldified = DECISION_SHAPE.split('\n')
    .map((line) => line.replace(/^([A-Za-z][A-Za-z ]*?):/, '**$1:**'))
    .join('\n');
  const bareified = TASK_SHAPE.split('\n')
    .map((line) => line.replace(/^\*\*([A-Za-z][A-Za-z ]*?):\*\*/, '$1:'))
    .join('\n');

  assert.equal(dialectOf('03-decision.md', DECISION_SHAPE), 'decision');
  assert.equal(dialectOf('03-boldified.md', boldified), 'unclassified', 'bold markers on a decision document');

  assert.equal(dialectOf('04-task.md', TASK_SHAPE), 'task');
  assert.equal(dialectOf('04-bareified.md', bareified), 'unclassified', 'bare markers on a task document');
});

test('a task Ticket drafted before its criteria exist is still a task Ticket', () => {
  // A real and common shape: the template is filled in but nobody has written the checkboxes
  // yet. It is also the narrowest task call the scheme makes — the `What to build:` field is
  // what carries it over the line once checkbox evidence is absent. Reading it as ambiguous
  // would leave a perfectly ordinary Ticket holding no Lane on the day it was written.
  const drafted = [
    '# 03 — A drafted task Ticket',
    '',
    '**What to build:** One normalizer every source passes through.',
    '',
    '**Blocked by:** None.',
    '',
    '**Status:** ready-for-agent',
  ].join('\n');
  assert.equal(dialectOf('03-drafted.md', drafted), 'task');
});

test('a decision Ticket with no section heading is still a decision Ticket', () => {
  // `## Question` is strong when present and absent from most real decision files, so its
  // absence must not count against them.
  assert.equal(dialectOf('05-headless.md', '# 05 — T\n\nType: grilling\nBlocked by: 01\nStatus: open\n\nProse, no heading.\n'), 'decision');
});

// ---------------------------------------------------------------------------
// Weak priors, never switches
// ---------------------------------------------------------------------------

test('the `Type:` word cannot overturn the field syntax', () => {
  // The observed file this protects carries the **task** type word in decision syntax. If
  // `Type:` were a switch rather than a prior it would read as a task Ticket, and the whole
  // status-versus-checkbox rule would then apply to a file that has no checkboxes.
  const taskWordInDecisionSyntax = [
    '# 06 — T',
    '',
    'Type: task (HITL — the user relays; the vendor contact answers)',
    'Blocked by: —',
    'Status: open',
    '',
    '## Question',
    '',
    'Which cutoff does the vendor support?',
  ].join('\n');
  assert.equal(dialectOf('06-type.md', taskWordInDecisionSyntax), 'decision');

  // And the mirror, so this is not just asserting that `Type:` is ignored: a decision type
  // word on a file written in task syntax does not drag it to decision either.
  const decisionWordInTaskSyntax = TASK_SHAPE.replace(
    '**What to build:**',
    '**Type:** grilling\n\n**What to build:**',
  );
  assert.equal(dialectOf('07-type.md', decisionWordInTaskSyntax), 'task');
});

test('a sibling map.md is a prior, and its absence is not evidence of anything', () => {
  // "No map.md means task" is the clause this design exists to refute. Both files below are
  // decision-syntax; the one without a map must not be dragged the other way.
  assert.equal(dialectIn(featureTree('08-a.md', DECISION_SHAPE, { map: false })), 'decision');
  assert.equal(dialectIn(featureTree('08-b.md', DECISION_SHAPE, { map: true })), 'decision');

  // And a map beside a task-syntax file does not overturn it either.
  assert.equal(dialectIn(featureTree('09-a.md', TASK_SHAPE, { map: true })), 'task');
});

test('a prior cannot demote a Ticket the syntax already places', () => {
  // The narrowest task call there is — a template filled in before its criteria exist. A
  // prior that can push it out of every Lane is not a prior, it is a switch, and which
  // *sibling files happen to sit next to it* would then decide whether the card counts.
  const drafted = [
    '# 09 — A drafted task Ticket',
    '',
    '**What to build:** One normalizer every source passes through.',
    '',
    '**Blocked by:** None.',
    '',
    '**Status:** ready-for-agent',
  ].join('\n');
  assert.equal(dialectIn(featureTree('09-b.md', drafted, { map: false })), 'task');
  assert.equal(dialectIn(featureTree('09-c.md', drafted, { map: true })), 'task', 'a sibling map demoted it');
});

test('an organisational section before the template section does not obscure it', () => {
  // `## Context` belongs to neither template, but the `## Question` below it does. Reading
  // only the first heading treats an ordinary section as evidence the file matches nothing.
  const withContext = [
    '# 10 — T',
    '',
    'Type: grilling',
    'Blocked by: 01',
    'Status: open',
    '',
    '## Context',
    '',
    'Background.',
    '',
    '## Question',
    '',
    'Which one?',
  ].join('\n');
  assert.equal(dialectIn(featureTree('10-a.md', withContext, { map: false })), 'decision');
  assert.equal(dialectIn(featureTree('10-b.md', withContext, { map: true })), 'decision');
});

// ---------------------------------------------------------------------------
// Example markup is not evidence
// ---------------------------------------------------------------------------

test('field lines shown as examples in a fence or a comment are not live fields', () => {
  // A Ticket explaining its own markup contains exactly these samples. Counted as live, they
  // invent a Dialect for a document that has no fields at all.
  const fenced = '# 01 — T\n\n```md\nType: grilling\nBlocked by: 01\nStatus: open\n```\n';
  const commented = '# 01 — T\n\n<!--\nType: grilling\nBlocked by: 01\nStatus: open\n-->\n';
  assert.equal(dialectOf('14-fenced.md', fenced), 'unparsed', 'a fenced sample was read as fields');
  assert.equal(dialectOf('14-commented.md', commented), 'unparsed', 'a commented sample was read as fields');
});

test('an example in the other vocabulary does not change a Ticket that has real fields', () => {
  // The dangerous direction: a decision Ticket documenting the task template would otherwise
  // acquire enough contrary evidence to fall out of every Lane.
  const headless = '# 01 — T\n\nType: grilling\nBlocked by: 01\nStatus: open\n\nProse.\n';
  const withExample = `${headless}\n\`\`\`md\n**What to build:** X\n**Blocked by:** 02\n**Status:** open\n\`\`\`\n`;
  assert.equal(dialectOf('15-plain.md', headless), 'decision');
  assert.equal(dialectOf('15-example.md', withExample), 'decision', 'a fenced example moved the answer');
});

test('a section heading is still seen when a comment closes on its line', () => {
  const ordinary = '# 02 — T\n\nType: grilling\nStatus: open\n\n## Question\n\nWhich?\n';
  const resumed = '# 02 — T\n\nType: grilling\nStatus: open\n\n<!-- a note\n-->## Question\n\nWhich?\n';
  assert.equal(dialectOf('16-ordinary.md', ordinary), dialectOf('16-resumed.md', resumed));
});

test('every line terminator yields the same Dialect', () => {
  // The field scan resolves all three; an observer that splits on newlines alone reads a
  // lone-carriage-return file as one line and finds no markers in it at all.
  const parts = ['# 01 — T', '', 'Type: grilling', 'Blocked by: 01', 'Status: open', ''];
  const lf = dialectOf('17-lf.md', parts.join('\n'));
  assert.equal(lf, 'decision');
  assert.equal(dialectOf('17-crlf.md', parts.join('\r\n')), lf, 'CRLF disagreed with LF');
  assert.equal(dialectOf('17-cr.md', parts.join('\r')), lf, 'a lone carriage return disagreed with LF');
});

// ---------------------------------------------------------------------------
// `unclassified` — an answer, not an error
// ---------------------------------------------------------------------------

test('a file whose markers say one thing and whose section says neither is unclassified', () => {
  const card = cardFor('type-unknown-hybrid.md', readFixture('type-unknown-hybrid.md'));
  assert.equal(card.extraction.dialect, 'unclassified');
});

test('an unclassified Ticket takes no Lane and shows its raw fields', () => {
  // Both halves matter. Holding no Lane is what keeps it out of the Frontier and out of
  // Done; showing raw fields is what makes it a rendered answer rather than a blank card.
  const card = cardFor('type-unknown-hybrid.md', readFixture('type-unknown-hybrid.md'));
  assert.equal(card.derivation.lane, null, 'an unclassified card must hold no Lane');
  assert.ok(card.extraction.rawFields.length > 0, 'an unclassified card renders its raw fields');
  assert.equal(card.derivation.onFrontier, false);
});

test('an ambiguous file is a rendered answer, never a throw', () => {
  assert.doesNotThrow(() =>
    deriveSnapshot(oneFileTree('10-hybrid.md', readFixture('type-unknown-hybrid.md')), EMPTY_ANNOTATIONS),
  );
});

test('a file with nothing observable is unparsed, not unclassified', () => {
  // The two mean different things. `unclassified` presumes there was something to place;
  // a file truncated before it wrote anything had nothing. Calling that ambiguous would
  // assert an observation never made.
  assert.equal(dialectOf('11-torn.md', '# 11 — Ship gat\n\n**What to buil'), 'unparsed');
  assert.equal(dialectOf('12-empty.md', ''), 'unparsed');
});

// ---------------------------------------------------------------------------
// The corpus, whole
// ---------------------------------------------------------------------------

test('every corpus Ticket classifies as expected, with no false unclassified', () => {
  // Dialects per `expected.md`: `search-ranking` is a decision Feature, `checkout-flow` and
  // `design-system` are task Features. A false `unclassified` anywhere here would be the
  // failure that matters most — a card that renders but takes no Lane, silently leaving the
  // Frontier and the counts.
  const expected: Readonly<Record<string, string>> = {
    'search-ranking': 'decision',
    'checkout-flow': 'task',
    'design-system': 'task',
  };

  const snapshot = deriveSnapshot(corpusScan(), EMPTY_ANNOTATIONS);
  const features = snapshot.roots[0]?.features ?? [];
  assert.ok(features.length > 0, 'the corpus produced no Features');

  let seen = 0;
  for (const feature of features) {
    const want = expected[feature.name];
    assert.ok(want !== undefined, `no expected Dialect recorded for Feature ${feature.name}`);
    for (const card of feature.tickets) {
      seen += 1;
      assert.equal(
        card.extraction.dialect,
        want,
        `${feature.name}/${card.fileName} classified as ${card.extraction.dialect}`,
      );
    }
  }
  assert.equal(seen, 10, 'the corpus is pinned at ten Tickets');
});

test('no fixture that declares a Dialect gets a different one', () => {
  // The directory loop already asserts this fixture by fixture. This asserts the property
  // over the whole set at once, so a fixture added later is covered without an edit here.
  let checked = 0;
  for (const name of readdirSync(TICKETS_DIR).filter((f) => f.endsWith('.md')).sort()) {
    const text = readFixture(name);
    const declared = /dialect=(\w+)/.exec(text);
    if (declared === null) continue;
    checked += 1;
    assert.equal(cardFor(name, text).extraction.dialect, declared[1], `${name} disagreed`);
  }
  assert.ok(checked > 0, 'no fixture declared a Dialect, so the property held vacuously');
});

// ---------------------------------------------------------------------------
// Rule zero
// ---------------------------------------------------------------------------

test('an odd file returns a Dialect rather than raising', () => {
  const odd = [
    '## Question\n',
    '**Status:** done\n## Question\n- [ ] x\n',
    'Type:\n',
    '`'.repeat(400),
    '# 01 — T\n\n<!-- **Status:** commented\n',
    'Status: open\r\nBlocked by: 01\r\n',
  ];
  for (const text of odd) {
    assert.doesNotThrow(
      () => deriveSnapshot(oneFileTree('13-odd.md', text), EMPTY_ANNOTATIONS),
      `input ${JSON.stringify(text.slice(0, 40))} raised`,
    );
    const card = cardFor('13-odd.md', text);
    assert.ok(
      ['task', 'decision', 'unclassified', 'unparsed'].includes(card.extraction.dialect),
      `input ${JSON.stringify(text.slice(0, 40))} produced ${card.extraction.dialect}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cardFor(fileName: string, text: string): TicketCard {
  const snapshot = deriveSnapshot(oneFileTree(fileName, text), EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, `${fileName}: the one-file tree produced no card`);
  return card;
}

function dialectOf(fileName: string, text: string): string {
  return cardFor(fileName, text).extraction.dialect;
}

/** A one-Ticket Feature, optionally with a sibling `map.md` beside it. */
function featureTree(fileName: string, text: string, options: { readonly map: boolean }): Scan {
  const files = [
    { path: `alpha/issues/${fileName}`, absPath: `/r/alpha/issues/${fileName}`, text },
    ...(options.map ? [{ path: 'alpha/map.md', absPath: '/r/alpha/map.md', text: '# Map\n' }] : []),
  ];
  const root: Root = {
    path: '/r',
    label: 'r',
    trackerPath: '/r/tracker',
    files,
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
  return { roots: [root] };
}

function dialectIn(scan: Scan): string {
  const snapshot = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, 'the tree produced no card');
  return card.extraction.dialect;
}

/** The committed corpus, read off disk and fed through the seam whole. */
function corpusScan(): Scan {
  const files = readdirSync(CORPUS_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const root: Root = {
    path: '/corpus',
    label: 'corpus',
    trackerPath: CORPUS_DIR,
    files: files.map((file) => ({
      path: relative(CORPUS_DIR, file).split(sep).join('/'),
      absPath: file,
      text: readFileSync(file, 'utf8'),
    })),
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
  return { roots: [root] };
}

function readFixture(name: string): string {
  return readFileSync(join(TICKETS_DIR, name), 'utf8');
}
