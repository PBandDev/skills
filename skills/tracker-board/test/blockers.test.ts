/**
 * The `Blocked by:` line, asserted where it is observable: on the Snapshot.
 *
 * Every case here feeds a whole Ticket file through `deriveSnapshot` and reads
 * `extraction.blockedBy` and `extraction.externalBlocker` back off the card. Nothing calls
 * the rule directly and nothing names an intermediate shape, so the rule can be rewritten
 * without a line of this file changing.
 *
 * The helper asserts that the **exact value it seeded came back out**, on every case. That
 * is not ceremony — it closes two ways this file could assert nothing while reading green:
 *
 *   - A blocker rule fed nothing at all returns no edges and no external blocker, which is
 *     exactly what most of the negative cases below expect. A field scan that stopped
 *     delivering the value would leave them all passing.
 *   - The seam converts an exception raised inside extraction into an *empty* extraction, so
 *     a rule that threw on every input would satisfy a bare `doesNotThrow` and report no
 *     blockers besides. The degraded extraction carries no fields, so requiring the value
 *     back out is what turns a swallowed exception into a failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS, oneFileTree } from './harness.ts';

interface Blockers {
  readonly blockedBy: readonly number[];
  readonly externalBlocker: string | null;
}

// ---------------------------------------------------------------------------
// The harness has to be shown to work before anything it reports means anything
// ---------------------------------------------------------------------------

test('the harness reaches the blocker rule at all', () => {
  // A positive control. Every "no blockers" expectation below is indistinguishable from a
  // value that never arrived, so one case has to prove the path is live.
  assert.deepEqual([...read('02').blockedBy], [2]);
});

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

test('a comma list yields every number in the order it appears', () => {
  assert.deepEqual([...read('02, 03, 04, 05, 06').blockedBy], [2, 3, 4, 5, 6]);
});

test('semicolons separate too, and a wide number keeps both digits', () => {
  // Comma-only drops four blockers from one real line and semicolon-only drops one from
  // another, so neither separator alone is correct. A single-digit assumption would read
  // `10` as `1`, which is a different Ticket that probably exists.
  const read10 = read('02 — Build gates; 10 — E2E hardening.');
  assert.deepEqual([...read10.blockedBy], [2, 10]);
  assert.equal(read10.externalBlocker, null, 'trailing prose labels an edge; it is not a dependency of its own');
});

test('both separators in one line are both honoured', () => {
  assert.deepEqual([...read('02, 03; 04, 05').blockedBy], [2, 3, 4, 5]);
});

test('a number is read at any width, with leading zeroes tolerated', () => {
  assert.deepEqual([...read('007, 10, 100, 2').blockedBy], [7, 10, 100, 2]);
});

test('an empty segment contributes nothing rather than a zero', () => {
  assert.deepEqual([...read('02,, 03; ; 04').blockedBy], [2, 3, 4]);
});

// ---------------------------------------------------------------------------
// Masking parentheticals, and why it has to happen first
// ---------------------------------------------------------------------------

test('a separator inside a parenthetical does not split the line', () => {
  // This is the whole reason masking precedes splitting. Split first and the parenthetical's
  // own `;` produces a second segment — a fragment of a sentence — which then reads as an
  // external blocker on a Ticket whose only real dependency is 04.
  const found = read('04 — unit-costs tracer. (Runs parallel to 05–08; picks up later manifests automatically.)');
  assert.deepEqual([...found.blockedBy], [4]);
  assert.equal(
    found.externalBlocker,
    null,
    'the parenthetical is an aside about the edge, and splitting on its semicolon invents a dependency',
  );
});

test('a range inside a parenthetical contributes no numbers', () => {
  const found = read('04 (Runs parallel to 05–08)');
  assert.deepEqual([...found.blockedBy], [4], 'a digit scan would add 5 and 8 here');
});

test('nested parentheticals are masked whole, closing depth by depth', () => {
  // The separator sits after the inner `)` but still inside the outer one. Treating any
  // `)` as closing everything unmasks it, which splits the line and invents a remainder.
  const found = read('02 (an aside (with 07) and; more prose), 03');
  assert.deepEqual([...found.blockedBy], [2, 3]);
  assert.equal(found.externalBlocker, null, 'the outer parenthetical is still open at that semicolon');
});

test('an unclosed parenthetical masks to the end of the line', () => {
  // An unterminated parenthetical is a run-on aside far more often than the start of a
  // dependency, and reading its separators would split a sentence into fragments that then
  // read as blockers.
  const found = read('02, 03 (this aside never closes; 09, 10 are mentioned in it');
  assert.deepEqual([...found.blockedBy], [2, 3]);
  assert.equal(found.externalBlocker, null);
});

// ---------------------------------------------------------------------------
// The absence of a dependency
// ---------------------------------------------------------------------------

test('a value beginning none yields nothing, whatever digits follow', () => {
  // `none. Do BEFORE 03` is the dangerous one: a digit scan yields `[3]`, which does not
  // merely add an edge — it points the dependency the wrong way round.
  for (const value of [
    'none',
    'none.',
    'None',
    'NONE — nothing blocks this',
    'none. Do BEFORE 03 (same seams); one implement session may do both',
  ]) {
    const found = read(value);
    assert.deepEqual([...found.blockedBy], [], `blockers found in ${JSON.stringify(value)}`);
    assert.equal(found.externalBlocker, null, `an external blocker claimed for ${JSON.stringify(value)}`);
  }
});

test('a value beginning with a standalone dash yields nothing', () => {
  // `— (was 02, 03; …)` means the blockers were removed. Reading the digits reinstates two
  // dependencies that no longer exist, which moves three cards and two Lane counts.
  for (const value of [
    '—',
    '— (was 02, 03; the vendor named the date on 2026-07-24 and 03 is resolved)',
    '– (was 04)',
    '― nothing',
  ]) {
    const found = read(value);
    assert.deepEqual([...found.blockedBy], [], `blockers found in ${JSON.stringify(value)}`);
    assert.equal(found.externalBlocker, null, `an external blocker claimed for ${JSON.stringify(value)}`);
  }
});

test('none is a word, not a prefix', () => {
  const found = read('nonexistent upstream service');
  assert.equal(
    found.externalBlocker,
    'nonexistent upstream service',
    'matching `none` as a bare prefix would read this as "no blockers" and offer the work to an agent',
  );
});

test('a dash that opens a word is not the no-dependency sentinel', () => {
  assert.equal(read('—Q3 planning must land first').externalBlocker, '—Q3 planning must land first');
});

test('an ASCII hyphen is not the no-dependency sentinel', () => {
  // A hyphen also opens a list item and a negative number. Reading it as "no blockers"
  // fails toward offering work that cannot be started; falling through to the remainder
  // rule fails toward blocked, which is the safe direction.
  const found = read('- (was 02, 03)');
  assert.deepEqual([...found.blockedBy], []);
  assert.equal(found.externalBlocker, '- (was 02, 03)');
});

// ---------------------------------------------------------------------------
// The unmatched remainder
// ---------------------------------------------------------------------------

test('prose with no leading number is kept verbatim as an external blocker', () => {
  // Its presence alone is what makes the Ticket blocked. Returning an empty list and
  // stopping would report the Ticket ready and offer an agent work that cannot start.
  const value =
    'External availability of a real `sku2026` measured metric partition. This is not a dependency of tickets 10 or 11.';
  const found = read(value);
  assert.deepEqual([...found.blockedBy], [], 'sku2026, 10 and 11 are prose, not edges');
  assert.equal(found.externalBlocker, value);
});

test('an external blocker keeps its parenthetical, because that is most of what it says', () => {
  // Masking is for number extraction only. Rebuilding the remainder from the masked text
  // would hand the reader "External events — not before 2026-08-05 ." and drop the reason.
  const value = 'External events — not before 2026-08-05 (region-A determination; ideally also the region-B panel ruling).';
  const found = read(value);
  assert.deepEqual([...found.blockedBy], [], 'a digit scan would invent 2026, 8 and 5');
  assert.equal(found.externalBlocker, value);
});

test('an external blocker keeps its separators rather than being reassembled', () => {
  const value = 'Legal sign-off, then the vendor contract; neither is a Ticket';
  assert.equal(read(value).externalBlocker, value);
});

test('a numbered segment contributes its number and nothing else', () => {
  const found = read('02 — Build gates that will not be a separate Ticket');
  assert.deepEqual([...found.blockedBy], [2]);
  assert.equal(found.externalBlocker, null);
});

test('a comma inside a titled blocker stays part of its title', () => {
  const found = read('01 — Preserve frozen chains, and the corpus golden.');
  assert.deepEqual([...found.blockedBy], [1]);
  assert.equal(found.externalBlocker, null);
});

test('a semicolon inside a titled blocker stays part of its title', () => {
  const found = read('02 — Parse tracker references; including punctuation in the title.');
  assert.deepEqual([...found.blockedBy], [2]);
  assert.equal(found.externalBlocker, null);
});

test('a titled blocker list keeps title punctuation until the next reference', () => {
  const found = read('04 — Preserve Frozen chains, and the corpus golden.; 12 — Reconcile derived state');
  assert.deepEqual([...found.blockedBy], [4, 12]);
  assert.equal(found.externalBlocker, null);
});

test('a bare reference clears ownership from a preceding titled reference', () => {
  const found = read('01 — Title, 02, legal sign-off');
  assert.deepEqual([...found.blockedBy], [1, 2]);
  assert.equal(found.externalBlocker, 'legal sign-off');
});

test('an external prefix before a titled reference remains an external blocker', () => {
  const found = read('legal sign-off, 02 — Parser title, with punctuation');
  assert.deepEqual([...found.blockedBy], [2]);
  assert.equal(found.externalBlocker, 'legal sign-off');
});

test('a line mixing a number and prose reports both', () => {
  const found = read('02, legal sign-off');
  assert.deepEqual([...found.blockedBy], [2]);
  assert.equal(found.externalBlocker, 'legal sign-off');
});

test('a mixed line keeps the parenthetical on the prose segment too', () => {
  // The whole-line shortcut does not cover this: here some segments did resolve to Tickets,
  // so the remainder is assembled from the segments that did not — and those slices have to
  // come from the original text, or the reason the Ticket is waiting is masked out of them.
  const found = read('02, legal sign-off (vendor contract; not a Ticket), 03');
  assert.deepEqual([...found.blockedBy], [2, 3]);
  assert.equal(found.externalBlocker, 'legal sign-off (vendor contract; not a Ticket)');
});

// ---------------------------------------------------------------------------
// What a digit scan would get wrong, gathered in one place
// ---------------------------------------------------------------------------

test('none of the four measured digit-scan traps produces an edge', () => {
  const traps: readonly (readonly [string, readonly number[]])[] = [
    ['External events — not before 2026-08-05 (region-A determination).', []],
    ['04 — tracer. (Runs parallel to 05–08.)', [4]],
    ['none. Do BEFORE 03', []],
    ['— (was 02, 03; both resolved)', []],
  ];
  for (const [value, expected] of traps) {
    assert.deepEqual(
      [...read(value).blockedBy],
      [...expected],
      `${JSON.stringify(value)} — a wrong edge here is invisible on a board that otherwise looks right`,
    );
  }
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test('an absent, empty or blank line yields nothing and claims nothing', () => {
  assert.deepEqual([...readFile('# 01 — A ticket\n\nNo field here.\n').blockedBy], []);
  assert.equal(readFile('# 01 — A ticket\n\nNo field here.\n').externalBlocker, null);

  for (const value of ['', '   ']) {
    const found = readAllowingAbsentField(value);
    assert.deepEqual([...found.blockedBy], []);
    assert.equal(found.externalBlocker, null);
  }
});

test('a value that wrapped onto a second line contributes only its first line', () => {
  const found = readFile('# 01 — A ticket\n\nBlocked by: 02, 03\nand some prose about 09 that wrapped\n');
  assert.deepEqual([...found.blockedBy], [2, 3], 'a wrapped continuation must not fold prose into the graph');
});

test('zero is not a Ticket number', () => {
  // Ticket numbers come from a filename and start at 01 in every observed tracker, so a
  // bare `0` in a blocker line is prose or a stray rather than a dependency. Refusing it
  // keeps a Ticket that cannot exist out of the graph, and the segment still reads as an
  // external blocker so the card stays blocked.
  const found = read('0, 02');
  assert.deepEqual([...found.blockedBy], [2]);
  assert.equal(found.externalBlocker, '0');

  const padded = read('000, 02');
  assert.deepEqual([...padded.blockedBy], [2]);
  assert.equal(padded.externalBlocker, '000');
});

test('a run of digits too long to be a Ticket number is refused rather than rounded', () => {
  // `Number` loses precision past 2^53, so accepting one would assert an edge to a Ticket
  // whose number is not the one written down. Refusing sends it to the remainder rule,
  // which fails toward blocked.
  const found = read('9007199254740993 — a number no Ticket has');
  assert.deepEqual([...found.blockedBy], []);
  assert.equal(found.externalBlocker, '9007199254740993 — a number no Ticket has');
});

// ---------------------------------------------------------------------------
// Numeric prose is not a dependency
// ---------------------------------------------------------------------------

test('a number that is part of a larger numeric expression is not a Ticket', () => {
  // Every one of these was reproduced through the seam producing a false edge. None names
  // a Ticket, and a low false number resolves to a Ticket that usually exists — so the
  // graph comes out plausible and wrong, which is the one outcome this module exists to
  // prevent. Each falls through to `externalBlocker`, so the card reads blocked.
  const invented: readonly (readonly [string, string])[] = [
    ['Vendor embargo; 2026-08-05 is the earliest release', 'a date'],
    ['10% legal approval', 'a percentage'],
    ['2,000 USD funding approval', 'a thousands separator'],
    ['2.1 release must ship', 'a version'],
    ['09:00 standup sign-off', 'a time'],
  ];
  for (const [value, what] of invented) {
    const found = read(value);
    assert.deepEqual([...found.blockedBy], [], `${what} became an edge: ${JSON.stringify(value)}`);
    assert.equal(found.externalBlocker, value, `${what} left the card readable as ready`);
  }
});

test('a separator inside a code span or a quotation does not invent an edge', () => {
  // Neither is a list context. Splitting through them produced an edge to a number that was
  // never a Ticket reference, and truncated the external text at the separator.
  for (const value of [
    'Waiting for API tuple `3,4` from vendor',
    'External clause says "legacy; 03 is historical"',
  ]) {
    const found = read(value);
    assert.deepEqual([...found.blockedBy], [], `an edge was invented in ${JSON.stringify(value)}`);
    assert.equal(found.externalBlocker, value, 'and the external text was truncated at the separator');
  }
});

test('an unconventional connector is kept whole rather than half-read', () => {
  // `&`, `/` and a full-width comma are not separators this format defines. Reading only the
  // first number would drop the second dependency and promote the work as soon as the first
  // resolves. Keeping the segment whole reads as blocked instead.
  for (const value of ['02 & 03', '02 / 03', '02，03']) {
    const found = read(value);
    assert.deepEqual([...found.blockedBy], [], `a dependency was silently dropped from ${JSON.stringify(value)}`);
    assert.equal(found.externalBlocker, value);
  }
});

// ---------------------------------------------------------------------------
// Blockers that must not go missing
// ---------------------------------------------------------------------------

test('a segment that is only a parenthetical is still an external blocker', () => {
  // Masking is for number extraction. A segment that masks away to nothing is not empty —
  // deciding that on the masked text deleted the one thing the Ticket was waiting on, and
  // the card would have been offered as soon as 02 and 03 resolved.
  const found = read('02, (vendor sign-off required), 03');
  assert.deepEqual([...found.blockedBy], [2, 3]);
  assert.equal(found.externalBlocker, '(vendor sign-off required)');

  const partial = read('02, (waiting for vendor');
  assert.deepEqual([...partial.blockedBy], [2]);
  assert.equal(partial.externalBlocker, '(waiting for vendor', 'a half-written line still states what it waits on');
});

test('a sentence that opens with none is prose, not a declaration', () => {
  // The sentinel is a declaration — `none`, `none.`, `none — aside`. A sentence beginning
  // "None of…" says the Ticket *is* waiting. Reading it as the sentinel discards the
  // blocker and puts the Ticket on the Frontier, which is the worst thing this rule can do.
  for (const value of [
    'None of the required security reviews has completed',
    'none-of-the-vendors has signed',
    'None of 03 is finished',
  ]) {
    const found = read(value);
    assert.deepEqual([...found.blockedBy], [], `${JSON.stringify(value)} yielded an edge`);
    assert.equal(found.externalBlocker, value, `${JSON.stringify(value)} was read as "no blockers"`);
  }
});

test('an unmatched closing bracket does not promote what follows it', () => {
  // A half-written line is routine here. Blanking a closer that closes nothing moved `02`
  // to the front of its segment and made it read as a dependency.
  const found = read(') 02');
  assert.deepEqual([...found.blockedBy], []);
  assert.equal(found.externalBlocker, ') 02');
});

test('nothing a file can contain makes the seam throw', () => {
  const values: readonly string[] = [
    '(((((',
    ')))))',
    '((((( 02',
    ',,,,,',
    ';;;;;',
    '()',
    '( )',
    '02 (',
    ') 02',
    ' ',
    '\u0000',
    '02,  , 03',
    '—',
    '-',
    '𝟘𝟚 emoji digits',
    '02'.repeat(500),
    `${'('.repeat(200)}02${')'.repeat(200)}`,
    'a'.repeat(20_000),
  ];
  for (const value of values) {
    const label = JSON.stringify(value.slice(0, 40));
    assert.doesNotThrow(() => readAllowingAbsentField(value), `threw on ${label}`);

    // `doesNotThrow` alone cannot see a throw here: the seam converts an exception raised
    // inside extraction into an *empty* extraction, so a rule that threw on every one of
    // these would satisfy the line above and report no blockers besides. The degraded
    // extraction carries no fields at all, so requiring the value back out is what turns a
    // swallowed exception into a failure.
    const found = readAllowingAbsentField(value);
    assert.equal(
      found.seen,
      value.trim(),
      `extraction degraded on ${label}, which hides a thrown exception. The field scan delivers one trimmed line, so the value comes back trimmed and nothing else.`,
    );
    assert.ok(Array.isArray(found.blockedBy), `blockedBy was not a list on ${label}`);
    for (const number of found.blockedBy) {
      assert.ok(
        Number.isSafeInteger(number) && number >= 1,
        `${label} produced ${String(number)}, which is not a Ticket number`,
      );
    }
    assert.ok(
      found.externalBlocker === null || typeof found.externalBlocker === 'string',
      `externalBlocker was neither a string nor null on ${label}`,
    );
  }
});

test('a Snapshot does not depend on anything but its input', () => {
  const scan = oneFileTree('01-a.md', '# 01 — A ticket\n\nBlocked by: 02, 03 (an aside; with prose)\n');
  assert.deepEqual(deriveSnapshot(scan, EMPTY_ANNOTATIONS), deriveSnapshot(scan, EMPTY_ANNOTATIONS));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Feed one `Blocked by:` value through the seam, **asserting the field was scanned**.
 *
 * Every "no blockers" expectation in this file is indistinguishable from a value that never
 * reached the rule, so each case proves its input arrived before believing what came back.
 */
/**
 * Feed one `Blocked by:` value through the seam, **proving the exact value arrived**.
 *
 * Two ways this could otherwise assert nothing, both of which look like a pass:
 *
 *   - Every "no blockers" expectation is indistinguishable from a value that never reached
 *     the rule, so the seeded text is compared against what was actually scanned.
 *   - The seam converts an exception thrown inside extraction into an *empty* extraction.
 *     A rule that threw on every input would therefore satisfy a bare `doesNotThrow`, and
 *     would report no blockers besides. Requiring the seeded value to come back out means a
 *     thrown exception fails here rather than passing quietly, because the degraded
 *     extraction carries no fields at all.
 */
function read(value: string): Blockers {
  const found = readAllowingAbsentField(value);
  assert.equal(
    found.seen,
    value,
    `the field carrying ${JSON.stringify(value)} did not reach the rule intact, so this case asserts nothing about it`,
  );
  return found;
}

interface Scanned extends Blockers {
  /** The value as it was actually scanned, or `undefined` when no such field survived. */
  readonly seen: string | undefined;
}

function readAllowingAbsentField(value: string): Scanned {
  return readFileScanned(`# 01 — A ticket\n\nBlocked by: ${value}\n\n## Notes\n\nBody.\n`);
}

function readFile(text: string): Blockers {
  return readFileScanned(text);
}

function readFileScanned(text: string): Scanned {
  const snapshot = deriveSnapshot(oneFileTree('01-a.md', text), EMPTY_ANNOTATIONS);
  const card = snapshot.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined, 'the one-file tree produced no card');
  return {
    blockedBy: card.extraction.blockedBy,
    externalBlocker: card.extraction.externalBlocker,
    seen: card.extraction.rawFields.find(
      (field) => field.name.trim().toLowerCase() === 'blocked by',
    )?.value,
  };
}
