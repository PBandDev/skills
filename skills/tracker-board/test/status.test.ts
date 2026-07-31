/**
 * The `Status:` field, asserted **through the seam**.
 *
 * Every test calls `deriveSnapshot` with a one-file tree and reads the resulting
 * `TicketCard`. None names `readStatus`, a regex, the vocabulary list or any intermediate
 * shape, so the rule can be reimplemented without a test changing.
 *
 * Status values are written as strings here rather than read off disk, except where the
 * point of the assertion is a specific real file. A status is unbounded free text and the
 * shapes worth pinning — mixed case, a 400-character remainder, a value that matches
 * nothing, a field present but empty — are mostly not in any one committed file.
 *
 * Expectations are written as literals. Nothing here recomputes an expected value the way
 * the implementation would, because a test that derives its expectation from the rule it
 * is checking agrees with that rule by construction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS, oneFileTree } from './harness.ts';
import type { TicketCard } from '../core/types.ts';

const TICKETS_DIR = join(import.meta.dirname, 'fixtures', 'tickets');

// ---------------------------------------------------------------------------
// Longest-prefix, never equality
// ---------------------------------------------------------------------------

test('a status carrying a qualifier still matches its vocabulary prefix', () => {
  // Equality-matching `done` here produces an `unparsed` card for a finished Ticket. That
  // is failure mode 1, and it is silent.
  const card = statusOf('done (pending HITL theme taste check)');
  assert.equal(card.extraction.statusPrefix, 'done');
  assert.equal(card.extraction.qualifier, '(pending HITL theme taste check)');
});

test('matching is case-insensitive and the prefix reports lower-cased', () => {
  for (const written of ['DONE', 'done', 'Done', 'dOnE']) {
    const card = statusOf(`${written} — committed \`da675f8\``);
    assert.equal(card.extraction.statusPrefix, 'done', `"${written}" did not match`);
    assert.equal(
      card.extraction.qualifier,
      '— committed `da675f8`',
      `"${written}" lost or mangled its qualifier`,
    );
  }
});

test('the qualifier is trimmed of leading whitespace only, and the dash survives', () => {
  assert.equal(statusOf('resolved   — shipped').extraction.qualifier, '— shipped');
  assert.equal(statusOf('resolved\t— shipped').extraction.qualifier, '— shipped');
  assert.equal(statusOf('resolved— shipped').extraction.qualifier, '— shipped');
});

test('a status that is exactly a vocabulary term has an empty qualifier', () => {
  const card = statusOf('wontfix');
  assert.equal(card.extraction.statusPrefix, 'wontfix');
  assert.equal(card.extraction.qualifier, '');
  assert.equal(card.extraction.rawStatus, 'wontfix');
});

// ---------------------------------------------------------------------------
// The entire remainder is kept
// ---------------------------------------------------------------------------

test('a 400-plus character qualifier survives intact, character for character', () => {
  // Truncating destroys the delivery pointer, which is the thing that makes a long status
  // worth reading. The expected qualifier is defined **first** and the status is built from
  // it, so the assertion is exact equality against data rather than against a length, a
  // head and a tail — those three leave the middle unguarded, and losing text out of the
  // middle is the failure this is here to catch.
  const filler = 'delivered via the migration Ticket; policy recorded; harness updated. ';
  const expected = `— ${filler.repeat(8)}END-OF-STATUS-SENTINEL`;
  const card = statusOf(`resolved ${expected}`);

  assert.equal(card.extraction.statusPrefix, 'resolved');
  assert.ok(expected.length > 400, 'the fixture value under test is not actually long');
  assert.equal(card.extraction.qualifier, expected, 'the qualifier is not the remainder verbatim');
  assert.equal(card.extraction.rawStatus, `resolved ${expected}`, 'rawStatus is the value as scanned, whole');
});

test('the corpus long-prose status keeps its whole remainder', () => {
  // The fixture keeps realistic punctuation and field structure around a deliberately long
  // qualifier. Its trailing sentence is the first thing a truncating parser loses.
  //
  // The strong assertion here is that the qualifier is a **contiguous tail** of the value as
  // scanned. That is derived entirely from output, and it fails on text dropped from the
  // middle, on reordering, and on a truncated tail — none of which a length-plus-endpoints
  // check would notice. Reconstructing the expected qualifier by slicing `rawStatus` would
  // just re-run the rule under test and agree with it whatever it did.
  const card = cardFor('status-long-prose.md', readFixture('status-long-prose.md'));
  const { rawStatus, qualifier, statusPrefix } = card.extraction;

  assert.equal(statusPrefix, 'resolved');
  assert.ok(qualifier.length > 400, `qualifier was only ${qualifier.length} characters`);
  assert.ok(rawStatus.endsWith(qualifier), 'the qualifier is not a contiguous tail of the status');
  assert.equal(
    rawStatus.length - qualifier.length,
    'resolved '.length,
    'exactly the matched term and its single separating space are what the qualifier drops',
  );
  assert.ok(
    qualifier.endsWith('sample-delivery/cache for full evidence.'),
    'the delivery pointer at the end of the status was cut off',
  );
});

// ---------------------------------------------------------------------------
// Absent, empty, and unrecognised are three different things
// ---------------------------------------------------------------------------

test('an absent Status reads as open, and says it was absent', () => {
  // "open" is the *absence* of a value upstream. Reading absence as unparsed renders a
  // freshly generated map as an entirely unparsed Feature — the worst first impression,
  // on the newest work, where the board is most useful.
  const card = cardFor('a-decision.md', 'Type: grilling\nBlocked by: 02\n\n## Question\n\nWhich one?\n');
  assert.equal(card.extraction.statusPrefix, 'open');
  assert.equal(card.extraction.statusPresent, false, 'absence must stay distinguishable');
  assert.equal(card.extraction.rawStatus, '');
  assert.equal(card.extraction.qualifier, '');
});

test('a Status written with no value is present, not absent', () => {
  // This is what a torn read of `Status: done` looks like mid-write. Defaulting it to
  // `open` would promote work on a half-written file; reading it as present-and-unmatched
  // degrades the card for one scan and the next write resolves it.
  const card = statusOf('');
  assert.equal(card.extraction.statusPresent, true);
  assert.equal(card.extraction.statusPrefix, null);
  assert.equal(card.extraction.rawStatus, '');
});

test('a status matching nothing keeps its raw text rather than being discarded', () => {
  const card = statusOf('awaiting a reply from the vendor contact');
  assert.equal(card.extraction.statusPrefix, null, 'nothing in the vocabulary opens this value');
  assert.equal(card.extraction.statusPresent, true, 'present but unrecognised is not absent');
  assert.equal(card.extraction.rawStatus, 'awaiting a reply from the vendor contact');
  assert.equal(
    card.extraction.qualifier,
    'awaiting a reply from the vendor contact',
    'with no prefix the remainder is the whole value, so a reader built from prefix plus qualifier still shows it',
  );
});

test('a vocabulary term running into another word matches nothing', () => {
  // `opened by mistake` read as `open` puts a decision Ticket on the Frontier and offers
  // an agent work the file never said was available.
  for (const value of ['opened by mistake', 'openness', 'doneness', 'closedown planned']) {
    const card = statusOf(value);
    assert.equal(card.extraction.statusPrefix, null, `"${value}" matched a vocabulary term`);
    assert.equal(card.extraction.rawStatus, value, `"${value}" lost its text`);
  }
});

test('a letter or digit outside the basic plane is still a word character', () => {
  // A boundary tested one UTF-16 code unit at a time sees a lone surrogate here, which is
  // in neither the letter nor the number class, so the boundary passes and the value reads
  // as `open` — on a decision Ticket, as *ready*. The test has to be over whole code points.
  const letter = '\u{10400}'; // DESERET CAPITAL LETTER LONG I — a letter
  const digit = '\u{1D7CE}'; // MATHEMATICAL BOLD DIGIT ZERO — a number

  for (const [name, char] of [['letter', letter], ['digit', digit]] as const) {
    for (const term of ['open', 'done', 'claimed']) {
      const card = statusOf(`${term}${char}`);
      assert.equal(
        card.extraction.statusPrefix,
        null,
        `"${term}" followed by a supplementary-plane ${name} matched anyway`,
      );
    }
  }

  // The mirror case, so this is not just asserting that everything fails to match: a
  // supplementary-plane character that is punctuation rather than a letter or a number is a
  // boundary, and the term before it still matches.
  const punctuation = '\u{1F676}'; // SANS-SERIF HEAVY DOUBLE COMMA QUOTATION MARK ORNAMENT
  assert.equal(statusOf(`done${punctuation}`).extraction.statusPrefix, 'done');
});

// ---------------------------------------------------------------------------
// Vocabulary coverage
// ---------------------------------------------------------------------------

test('the five canonical triage roles are recognised', () => {
  for (const role of [
    'needs-triage',
    'needs-info',
    'ready-for-agent',
    'ready-for-human',
    'wontfix',
  ]) {
    assert.equal(statusOf(role).extraction.statusPrefix, role, `${role} was not recognised`);
    assert.equal(
      statusOf(`${role} — with a note`).extraction.statusPrefix,
      role,
      `${role} was not recognised when it carried a qualifier`,
    );
  }
});

test('the retired role still named in upstream docs is recognised', () => {
  // Ignoring it renders a Ticket that reads perfectly to a person as unparsed.
  assert.equal(statusOf('ready-for-afk').extraction.statusPrefix, 'ready-for-afk');
  assert.equal(
    statusOf('ready-for-afk (queued behind the vendor reply)').extraction.qualifier,
    '(queued behind the vendor reply)',
  );
});

test('the decision lifecycle values and both parking values are recognised', () => {
  for (const term of ['open', 'claimed', 'resolved', 'wontfix', 'closed', 'done']) {
    assert.equal(statusOf(term).extraction.statusPrefix, term, `${term} was not recognised`);
  }
});

// ---------------------------------------------------------------------------
// Rule zero
// ---------------------------------------------------------------------------

test('an odd status value returns a reading rather than raising', () => {
  const odd = [
    '   ',
    '—',
    'resolved',
    '::::',
    'done'.repeat(500),
    'RESOLVED truncated',
    ' done',
  ];
  for (const value of odd) {
    assert.doesNotThrow(
      () => deriveSnapshot(oneFileTree('01-odd.md', `# 01 — Odd\n\nStatus: ${value}\n`), EMPTY_ANNOTATIONS),
      `a status of ${JSON.stringify(value)} raised`,
    );
    // Recoverable content, not merely "it did not throw": the seam catches an extractor
    // throw and substitutes an empty Extraction, so a card that still knows its title is
    // the observable proof the extractor ran to completion.
    const card = statusOf(value);
    assert.equal(card.extraction.title, 'Odd', `a status of ${JSON.stringify(value)} lost the card`);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A one-file Ticket whose only interesting content is the status value under test. */
function statusOf(value: string): TicketCard {
  return cardFor('01-odd.md', `# 01 — Odd\n\nStatus: ${value}\n`);
}

function cardFor(fileName: string, text: string): TicketCard {
  const snapshot = deriveSnapshot(oneFileTree(fileName, text), EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, `${fileName}: the one-file tree produced no card`);
  return card;
}

function readFixture(name: string): string {
  return readFileSync(join(TICKETS_DIR, name), 'utf8');
}
