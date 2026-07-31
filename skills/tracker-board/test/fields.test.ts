/**
 * Field scanning and Ticket identity, asserted **through the seam**.
 *
 * Every test here calls `deriveSnapshot` with a one-file tree and reads the resulting
 * `TicketCard`. None of them names `scanFields`, `extractIdentity`, a regex or an
 * intermediate shape, so the whole module can be reimplemented without a test changing.
 *
 * The `tickets/` fixture loop covers each rule against one real file shape. This file
 * covers the same rules against the shapes a corpus does not happen to contain yet —
 * variant line endings, a byte-order mark, an unterminated comment or fence, a torn read —
 * and it asserts the field-scan boundary as a property over the whole fixture directory
 * rather than one file at a time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS, oneFileTree } from './harness.ts';
import type { RawField, TicketCard } from '../core/types.ts';

const TICKETS_DIR = join(import.meta.dirname, 'fixtures', 'tickets');

// ---------------------------------------------------------------------------
// Rule 1 — the marker strip, and where it lands
// ---------------------------------------------------------------------------

test('rule 1: no scanned field carries a markup marker, across the whole fixture corpus', () => {
  // The 37-of-54 defect as a property. A tolerant per-field match like
  // /^\*{0,2}(Status)\*{0,2}:/ accepts `**Status:** done` and hands back a value beginning
  // `**`, which then defeats every leading-anchored match on every value downstream — the
  // failure that made blocker parsing fiction on 25 of 54 Tickets while no Lane moved.
  let scanned = 0;
  for (const fixture of fixtureNames()) {
    for (const field of cardFor(fixture, readFixture(fixture)).extraction.rawFields) {
      scanned += 1;
      assert.ok(
        !field.name.includes('*'),
        `${fixture}: field name "${field.name}" kept a markup marker`,
      );
      assert.ok(
        !field.value.includes('*'),
        `${fixture}: value of "${field.name}" kept a markup marker — "${field.value}"`,
      );
    }
  }
  assert.ok(scanned > 0, 'no fields were scanned at all, so the property held vacuously');
});

test('rule 1: a colon inside the bold yields a clean name and a clean value', () => {
  const card = cardFor('status-bold-wrapped.md', readFixture('status-bold-wrapped.md'));

  const status = fieldNamed(card, 'Status');
  assert.equal(status.name, 'Status', 'raw field names keep their original casing');
  assert.equal(status.value, 'done', 'the closing `**` landed in the value');

  // The status field is not where the damage was. Anything leading-anchored on any other
  // value is, so assert one directly: this blocker line has to start with its first number.
  const blockers = fieldNamed(card, 'Blocked by');
  assert.ok(
    blockers.value.startsWith('02'),
    `a leading-anchored read of the blocker line failed — "${blockers.value}"`,
  );
});

test('rule 1: the strip is scoped to the candidate field line, not to the document', () => {
  // `preamble` and `body` are handed on with their markup intact — `dialect.ts` scores on
  // observed bold-versus-bare markers and `criteria.ts` reads `- [ ]` markup. The title is
  // read out of the body, so it is the observable proof that the body was not rewritten.
  const card = cardFor(
    '07-scoped.md',
    lines('# 07 - Title *with emphasis*', '', '**Status:** done', '', '- [x] a *starred* criterion'),
  );

  assert.equal(
    card.extraction.title,
    'Title *with emphasis*',
    'the document itself was stripped, so body-derived text lost its markup too',
  );
  assert.deepEqual(
    names(card),
    ['Status'],
    'a criteria line is not a field line, stripped or otherwise',
  );
});

// ---------------------------------------------------------------------------
// Rule 12 — the preamble window
// ---------------------------------------------------------------------------

test('rule 12: with no `## ` heading anywhere the window runs to EOF', () => {
  // The measured case: `**Status:**` on line 21 of a file with no section heading at all.
  // Any fixed line budget reports "no status line in this file" for a finished Ticket.
  const card = cardFor(
    'preamble-runs-to-first-heading.md',
    readFixture('preamble-runs-to-first-heading.md'),
  );
  assert.equal(fieldNamed(card, 'Status').value, 'done');
  assert.equal(
    fieldNamed(card, 'Blocked by').value,
    '07 — Qualify and normalize member-roster sources.',
  );
});

test('rule 12: a field below the first `## ` heading is not captured', () => {
  const card = cardFor(
    '03-windowed.md',
    lines(
      '# 03 — Windowed',
      '',
      '**Status:** done',
      '',
      '## Comments — review round 3 (3 mediums → fixed)',
      '',
      'Status: claimed',
      'Blocked by: 99',
    ),
  );
  assert.deepEqual(
    names(card),
    ['Status'],
    'the window ran past its heading and picked up conversation below it',
  );
  assert.equal(fieldNamed(card, 'Status').value, 'done');
});

test('rule 12: the closing heading is matched by prefix, never by equality', () => {
  // Real headings carry trailing prose, dates and parentheticals. The heading above reads
  // `## Comments — review round 3 (…)`; an equality match against `## Comments` finds
  // nothing and the cut never happens. Assert the general form directly.
  const card = cardFor(
    '04-prefixed.md',
    lines('# 04 — Prefixed', '', 'Status: open', '', '## Anything At All (2026-07-24)', '', 'Type: grilling'),
  );
  assert.deepEqual(names(card), ['Status']);
});

test('rule 12: an unmatched comment opener inside a fence does not swallow the file', () => {
  // Fence state is resolved before comment state. With comments classified over the raw
  // text first, this one line of sample text swallows its own closing fence and every real
  // field below it, and the card renders with nothing on it.
  const card = cardFor(
    '23-fenced.md',
    lines('# 23 — Fenced', '', '```md', '<!-- a sample comment with no close', '```', '', '**Status:** done'),
  );
  assert.equal(fieldNamed(card, 'Status').value, 'done');
});

test('rule 12: a comment opener quoted in an inline code span is not a comment', () => {
  // Prose explaining Ticket markup quotes `<!--` routinely. Read as a delimiter it opens a
  // comment that never closes, and every field below it — the status line included —
  // disappears. The control below is the same document with the backticks removed: the two
  // must agree, or the span is being treated as structure rather than as content.
  const quoted = cardFor(
    '08-span.md',
    lines(
      '# 08 — Span',
      '',
      '**What to build:** Explain that a `<!--` marker hides the rest of a file.',
      '',
      '**Blocked by:** 07',
      '',
      '**Status:** done',
    ),
  );
  const control = cardFor(
    '08-control.md',
    lines(
      '# 08 — Span',
      '',
      '**What to build:** Explain that a marker hides the rest of a file.',
      '',
      '**Blocked by:** 07',
      '',
      '**Status:** done',
    ),
  );

  assert.deepEqual(names(quoted), names(control), 'the quoted opener hid the fields below it');
  assert.equal(quoted.extraction.rawStatus, 'done');

  // CommonMark closes a span on a run of exactly the same length, which is what lets a span
  // quote a backtick. The double-run form has to work too.
  const doubled = cardFor(
    '08-doubled.md',
    lines('# 08 — Span', '', '**What to build:** The ``a `<!--` b`` form.', '', '**Status:** done'),
  );
  assert.equal(doubled.extraction.rawStatus, 'done');
});

test('rule 12: a genuine comment still hides what it encloses', () => {
  // The mirror of the test above, so the span rule cannot pass by making every `<!--` inert.
  const card = cardFor(
    '09-commented.md',
    lines('# 09 — Commented', '', '<!-- Status: hidden -->', '', '**Status:** done'),
  );
  assert.deepEqual(names(card), ['Status']);
  assert.equal(card.extraction.rawStatus, 'done', 'the commented-out field won the scan');
});

test('rule 12: a fence closes only on a bare marker, so sample code cannot outrank a real field', () => {
  const card = cardFor(
    '24-fenced.md',
    lines('# 24 — Fenced', '', '```md', '```not-a-close', 'Status: fake', '```', '', '**Status:** real'),
  );
  assert.equal(
    card.extraction.rawStatus,
    'real',
    'a `Status:` written inside a code sample won the scan',
  );
});

test('rule 12: content after a comment closes mid-line is still read', () => {
  // A heading written as `-->## Details` closes the preamble. Dropping the remainder of a
  // line that merely *began* inside a comment loses it, and the window then runs on and
  // captures conversation below the section break as though it were a field.
  //
  // Run under all three terminators: this is line-transition state, which is exactly where
  // an ending difference would show up.
  for (const [label, ending] of [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ] as const) {
    const card = cardFor(
      '40-transition.md',
      ['# 40 — Transition', '', 'Status: open', '', '<!-- a note', '-->## Details', 'Status: claimed'].join(
        ending,
      ) + ending,
    );
    assert.deepEqual(names(card), ['Status'], `${label}: the heading after the comment was lost`);
    assert.equal(card.extraction.rawStatus, 'open', `${label}: a field below the heading was captured`);
  }
});

test('rule 12: a fence opener carrying a comment does not leave comment state set', () => {
  // The line opens a fence *and* a comment. Committing the comment leaves that state set
  // when the fence closes, which hides every real field after it — the whole card renders
  // empty. Inside a fence everything is inert, so the pre-fence state is what resumes.
  const card = cardFor(
    '41-opener.md',
    lines('# 41 — Fenced', '', '```md <!-- a sample', 'sample text', '```', '', '**Status:** real'),
  );
  assert.equal(card.extraction.rawStatus, 'real');
});

test('rule 9: an indented delimiter inside a block scalar does not close the block', () => {
  // `description: |` introduces a block scalar whose content is indented — and `---` is
  // legal content inside it. Accepting an indented delimiter closes the block early, after
  // which the block's own `status:` is scanned as body content ahead of the real field and
  // shadows it. Block-scalar content must be indented past its key, so anchoring the
  // delimiter at column 0 excludes every scalar body exactly.
  const card = cardFor(
    '42-scalar.md',
    lines('---', 'description: |', '  ---', 'status: closed', '---', '', '# 42 — Real', '', 'Status: open'),
  );
  assert.equal(card.extraction.rawStatus, 'open');
  assert.deepEqual(names(card), ['Status']);
});

test('rule 9: an indented code fence inside a block scalar does not disqualify the block', () => {
  const card = cardFor(
    '43-scalar.md',
    lines(
      '---',
      'description: |',
      '  ```',
      '  sample',
      '  ```',
      'status: closed',
      '---',
      '',
      '# 43 — Real',
      '',
      'Status: open',
    ),
  );
  assert.equal(card.extraction.rawStatus, 'open', 'the block stayed unstripped and shadowed the real field');
  assert.deepEqual(names(card), ['Status']);
});

test('rule 12: a byte-order mark does not hide the first field or the H1', () => {
  // Node's UTF-8 read preserves it and a Windows editor writes one, so this is an ordinary
  // file that reads correctly to a person and scans as empty.
  const bom = String.fromCharCode(0xfeff);
  const field = cardFor('27-bom.md', `${bom}Status: open\n`);
  assert.equal(field.extraction.rawStatus, 'open');

  const heading = cardFor('28-bom.md', `${bom}# 28 — Real title\n\nStatus: open\n`);
  assert.equal(heading.extraction.title, 'Real title');
  assert.equal(heading.extraction.titleSource, 'h1');

  // Every leading mark, not one. A file round-tripped through two tools can carry two, and
  // removing exactly one in each of two places makes the same invisible prefix hide a field
  // while leaving a heading readable.
  const twice = cardFor('44-bom.md', `${bom}${bom}Status: open\n`);
  assert.equal(twice.extraction.rawStatus, 'open');

  const twiceHeading = cardFor('45-bom.md', `${bom}${bom}# 45 — Real title\n\nStatus: open\n`);
  assert.equal(twiceHeading.extraction.title, 'Real title');
  assert.equal(twiceHeading.extraction.rawStatus, 'open');

  const beforeBlock = cardFor('46-bom.md', `${bom}---\nstatus: closed\n---\n\n# 46 — Real\n\nStatus: open\n`);
  assert.equal(beforeBlock.extraction.rawStatus, 'open', 'a mark before the block defeated the strip');
  assert.deepEqual(names(beforeBlock), ['Status']);
});

test('rule 12: a `## ` inside a fence or off column 0 does not close the window', () => {
  // Ending the window early is the measured defect; running long only risks collecting an
  // extra unknown field, and first-occurrence-wins already protects the real ones.
  const card = cardFor(
    '05-fenced.md',
    lines(
      '# 05 — Fenced',
      '',
      '```md',
      '## Comments',
      '```',
      '   ## Quoted inside a list item',
      '',
      '**Status:** done',
    ),
  );
  assert.equal(fieldNamed(card, 'Status').value, 'done');
});

test('every line terminator scans identically, including a lone carriage return', () => {
  // A file authored on one platform is read on another, and a checkout can rewrite endings
  // on its own. A terminator left on the end of a value is an invisible character that
  // defeats every trailing-anchored match downstream; splitting on `\n` alone reads a
  // lone-`\r` file as one line and finds nothing in it at all.
  //
  // The endings are built here rather than read off disk on purpose — how a fixture file is
  // checked out is not something this assertion may depend on.
  const parts = ['# 06 — Portable', '', '**Status:** done', '', '## Comments', '', 'Status: claimed'];

  for (const [label, ending] of [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ] as const) {
    const card = cardFor('06-endings.md', parts.join(ending) + ending);
    assert.deepEqual(names(card), ['Status'], `${label}: the window did not close on its heading`);
    assert.equal(
      fieldNamed(card, 'Status').value,
      'done',
      `${label}: the value kept its terminator, or the file did not split into lines at all`,
    );
    assert.equal(card.extraction.title, 'Portable', `${label}: the H1 did not match`);
    assert.equal(card.extraction.number, 6, `${label}: the H1 number did not match`);
  }
});

test('a file mixing line terminators still scans field by field', () => {
  // Mixed endings are what a half-rewritten file looks like — which is the steady state
  // when the watcher reads a file an editor is still saving.
  const card = cardFor(
    '07-mixed.md',
    '# 07 — Mixed\r\n\rType: grilling\n\r\nStatus: open\r\n\r\n## Question\r\nStatus: claimed\n',
  );
  assert.deepEqual(names(card), ['Type', 'Status']);
  assert.equal(card.extraction.rawStatus, 'open');
  assert.equal(card.extraction.title, 'Mixed');
});

test('rule 12: the first occurrence of a field wins', () => {
  const card = cardFor(
    '07-twice.md',
    lines('# 07 — Twice', '', '**Status:** done', '', 'Later prose repeats it.', '', 'Status: claimed'),
  );
  const observed = card.extraction.rawFields.filter(
    (field) => field.name.toLowerCase() === 'status',
  );
  assert.equal(observed.length, 2, 'both occurrences are observed and carried, in order');
  assert.equal(observed[0]?.value, 'done');
  assert.equal(observed[1]?.value, 'claimed');
  // `rawStatus` is the resolved field, not the observed list, so this asserts the
  // resolution rather than the ordering it was derived from.
  assert.equal(
    card.extraction.rawStatus,
    'done',
    'a later mention in prose overrode the real field',
  );
});

// ---------------------------------------------------------------------------
// Rule 9 — frontmatter
// ---------------------------------------------------------------------------

test('rule 9: a leading frontmatter block is stripped rather than scanned as fields', () => {
  const card = cardFor('frontmatter-stripped.md', readFixture('frontmatter-stripped.md'));
  assert.deepEqual(
    names(card),
    ['Type', 'Blocked by', 'Status'],
    'the block was read as preamble fields instead of being stripped out of it',
  );
  assert.equal(
    card.extraction.number,
    13,
    'the H1 below the block was not reachable, so the block was not removed from the body',
  );
});

test('rule 9: frontmatter never shadows the real field scan', () => {
  const card = cardFor(
    '21-shadowed.md',
    lines(
      '---',
      'status: closed',
      'title: A frontmatter title',
      'tags: [pricing, vendor]',
      '---',
      '',
      '# 21 — The real title',
      '',
      'Status: open',
    ),
  );
  assert.deepEqual(names(card), ['Status'], 'no frontmatter key reaches the preamble scan');
  assert.equal(
    card.extraction.rawStatus,
    'open',
    'the lower-cased `status` inside the block shadowed the real field below it',
  );
  assert.equal(card.extraction.title, 'The real title', 'the frontmatter title shadowed the H1');
  assert.equal(card.extraction.number, 21);
});

test('rule 9: a YAML comment inside the block does not make it un-strippable', () => {
  // The dangerous direction. A block rejected for containing a legal YAML comment is then
  // scanned as ordinary content, which puts the block's own `status:` *ahead* of the file's
  // real one and shadows it — a confidently wrong value, which is the failure this rule must prevent.
  const card = cardFor(
    '29-commented.md',
    lines('---', '# audit note', 'status: closed', '---', '', '# 29 — Real title', '', 'Status: open'),
  );
  assert.equal(card.extraction.rawStatus, 'open');
  assert.equal(card.extraction.title, 'Real title');
  assert.deepEqual(names(card), ['Status']);
});

test('rule 9: a leading `---` region carrying markdown is content, not frontmatter', () => {
  // The defensive half, narrowed to what a mapping never contains. A checkbox item here
  // means the `---` was a thematic break, and stripping the region would delete a real
  // criterion and a real field.
  const card = cardFor(
    '30-rule.md',
    lines('---', 'Status: open', '- [ ] a real criterion', '---', '', '# 30 — Kept'),
  );
  assert.equal(fieldNamed(card, 'Status').value, 'open');
  assert.equal(card.extraction.title, 'Kept');
});

test('rule 9: an unclosed or mapping-less leading `---` strips nothing', () => {
  const unclosed = cardFor('31-unclosed.md', lines('---', 'status: closed', '', '# 31 — Kept'));
  assert.equal(unclosed.extraction.title, 'Kept');
  assert.equal(unclosed.extraction.rawStatus, 'closed', 'the block was read as ordinary content');

  const prose = cardFor('32-prose.md', lines('---', '', 'Just a separator.', '', '---', '', '# 32 — Kept'));
  assert.equal(prose.extraction.title, 'Kept', 'a region with no mapping entry is not a block');
});

// ---------------------------------------------------------------------------
// Rule 13 — unknown fields
// ---------------------------------------------------------------------------

test('rule 13: unknown fields are carried and disturb nothing', () => {
  const card = cardFor('type-unknown-hybrid.md', readFixture('type-unknown-hybrid.md'));
  assert.deepEqual(
    names(card),
    ['Type', 'Created', 'Origin', 'Blocked by', 'Status'],
    'unknown fields are not errors and an unclassified card renders them',
  );
  assert.equal(fieldNamed(card, 'Status').value, 'ready-for-human');
  assert.equal(fieldNamed(card, 'Type').value, 'research + implement');
});

test('rule 13: an unknown field between two known ones does not break either', () => {
  const card = cardFor('status-long-prose.md', readFixture('status-long-prose.md'));
  assert.ok(names(card).includes('Origin'), 'the unknown field was dropped rather than carried');
  assert.equal(fieldNamed(card, 'Blocked by').value, '—');
  assert.ok(
    fieldNamed(card, 'Status').value.startsWith('resolved'),
    'the status value below an unknown field no longer starts where it should',
  );
});

// ---------------------------------------------------------------------------
// Rule 5 — identity
// ---------------------------------------------------------------------------

test('rule 5: the number comes from the filename at any width', () => {
  const card = cardFor(
    '007-title-hyphen-and-wide-number.md',
    readFixture('007-title-hyphen-and-wide-number.md'),
  );
  assert.equal(card.extraction.number, 7, 'a zero-padded filename is not a different Ticket');
  assert.equal(card.extraction.title, 'Qualify and normalize roster sources');
  assert.equal(card.extraction.titleSource, 'h1');
});

test('rule 5: a filename with no leading digits falls back to the H1', () => {
  const card = cardFor('frontmatter-stripped.md', readFixture('frontmatter-stripped.md'));
  assert.equal(card.extraction.number, 13);
  assert.equal(card.extraction.title, 'Decide the refresh cadence');
});

test('rule 5: the `NN` prefix strips on an em-dash, an en-dash and a plain hyphen', () => {
  const em = cardFor('em.md', lines('# 31 — Em dashed'));
  const en = cardFor('en.md', lines('# 32 – En dashed'));
  const hyphen = cardFor('hyphen.md', lines('# 33 - Hyphenated'));
  assert.deepEqual(
    [em, en, hyphen].map((card) => [card.extraction.number, card.extraction.title]),
    [
      [31, 'Em dashed'],
      [32, 'En dashed'],
      [33, 'Hyphenated'],
    ],
    'an em-dash-only strip leaves "NN - " glued to the front of 8% of display titles',
  );
});

test('rule 5: an H1 opening with a calendar date is not read as a Ticket number', () => {
  const card = cardFor('retro.md', lines('# 2026-07-24 retrospective', '', 'Status: open'));
  assert.equal(card.extraction.number, null);
  assert.equal(card.extraction.title, '2026-07-24 retrospective');
});

test('rule 5: a Ticket with no H1 falls back to the filename slug', () => {
  // Decision Tickets frequently have no H1 at all — requiring one marks every one of them
  // unparsed. The number still comes from the filename, so nothing is lost but the
  // human-readable title, and that degrades to the slug rather than to nothing.
  const card = cardFor(
    '12-no-h1-decision-ticket.md',
    readFixture('12-no-h1-decision-ticket.md'),
  );
  assert.equal(card.extraction.titleSource, 'filename');
  assert.equal(card.extraction.title, 'no h1 decision ticket');
  assert.equal(card.extraction.number, 12);
});

test('rule 5: the filename slug keeps its number out of the display title', () => {
  const card = cardFor('12-widen-the-band.md', lines('Status: open', '', 'A question with no heading.'));
  assert.equal(card.extraction.number, 12);
  assert.equal(card.extraction.title, 'widen the band');
  assert.equal(card.extraction.titleSource, 'filename');
});

test('rule 5: no number in either source is `null`, not a guess', () => {
  const card = cardFor('a-decision.md', lines('Status: open'));
  assert.equal(
    card.extraction.number,
    null,
    'null is the honest answer, and Tickets with a null number sort last',
  );
});

// ---------------------------------------------------------------------------
// Rule zero — the parser never throws
// ---------------------------------------------------------------------------

test('rule zero: a torn read returns a scan rather than raising', () => {
  // The watcher fires *during* a write, so every one of these is the steady state rather
  // than an edge case.
  const torn: readonly (readonly [string, string | null])[] = [
    ['empty.md', ''],
    ['null.md', null],
    ['11-torn.md', readFixture('malformed-mid-write.md')],
    ['cut-mid-frontmatter.md', '---\ntitle: half a bl'],
    ['cut-mid-comment.md', '<!-- expect: number=1\n# 01 — Cut'],
    ['cut-mid-fence.md', '# 01 — Cut\n\n```md\n## Comments'],
    ['cut-mid-field.md', '# 01 — Cut\n\n**Status:'],
    ['delimiters-only.md', '---\n---\n---\n---'],
    ['no-newline.md', '# 01 — One line with no terminator'],
    ['just-markers.md', '****'],
  ];

  for (const [fileName, text] of torn) {
    assert.doesNotThrow(
      () => deriveSnapshot(oneFileTree(fileName, text), EMPTY_ANNOTATIONS),
      `${fileName}: a torn read raised. A fixture that makes the parser throw is a failing test, whatever else it proves.`,
    );
    const card = cardFor(fileName, text);
    assert.equal(card.fileName, fileName, 'an unreadable file still shows its raw filename');
  }
});

test('rule zero: a torn read still yields what the file did contain', () => {
  // `deriveSnapshot` catches an extractor throw and substitutes an empty Extraction, so
  // "it did not throw" is not observable on its own — every call could raise and the test
  // above would still pass. These assert recoverable content, which an empty Extraction
  // cannot produce.
  const midField = cardFor('01-cut.md', '# 01 — Cut\n\n**Status:');
  assert.equal(midField.extraction.number, 1);
  assert.equal(midField.extraction.title, 'Cut');
  assert.equal(midField.extraction.titleSource, 'h1');

  const noTerminator = cardFor('02-one-line.md', '# 02 — One line with no terminator');
  assert.equal(noTerminator.extraction.title, 'One line with no terminator');

  const midComment = cardFor('03-cut.md', '# 03 — Cut\n\nStatus: done\n\n<!-- a note with no close');
  assert.equal(midComment.extraction.rawStatus, 'done');
  assert.equal(midComment.extraction.title, 'Cut');

  const torn = cardFor('11-torn.md', readFixture('malformed-mid-write.md'));
  assert.equal(torn.extraction.title, 'Ship gat', 'the fixture that exists to hold rule zero');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cardFor(fileName: string, text: string | null): TicketCard {
  const snapshot = deriveSnapshot(oneFileTree(fileName, text), EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, `${fileName}: the one-file tree produced no card`);
  return card;
}

function names(card: TicketCard): string[] {
  return card.extraction.rawFields.map((field) => field.name);
}

function fieldNamed(card: TicketCard, name: string): RawField {
  const found = card.extraction.rawFields.find((field) => field.name === name);
  assert.ok(
    found !== undefined,
    `no field named "${name}" was scanned — observed [${names(card).join(', ')}]`,
  );
  return found;
}

function lines(...parts: readonly string[]): string {
  return `${parts.join('\n')}\n`;
}

function fixtureNames(): readonly string[] {
  return readdirSync(TICKETS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function readFixture(name: string): string {
  return readFileSync(join(TICKETS_DIR, name), 'utf8');
}
