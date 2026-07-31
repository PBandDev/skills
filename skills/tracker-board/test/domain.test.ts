/**
 * The domain-model panel: the ADR ledger and the glossary pointer, from the seam out to the
 * document.
 *
 * ## What this file is actually guarding
 *
 * The panel's deliverable is a **refusal**. An ADR column is excluded because columns encode
 * workflow state and ADRs have none, and the guarded failure mode is not a crash — it is a
 * panel that quietly invents a
 * status, a lifecycle, or a word like "deprecated" that the corpus does not contain. So the
 * assertions below are as much about what is absent from the output as about what is in it,
 * and the vocabulary check runs over the drawn rows rather than over the source, because
 * prose is where an invented status would actually appear.
 *
 * ## Two degraded states, and why each is paired with a canary
 *
 * "A Root with no ADR directory and no glossary renders the panel as absent" is an
 * expectation a *total collapse* satisfies for free: a module that threw on its first line
 * would pass it. The same is true of "an unreachable glossary is not the same as an absent
 * one" — one of the two answers is the empty one. So every degraded case here is asserted in
 * the same pass as something that must come out fully populated. A collapse fails the pair.
 *
 * ## Where the browser has to finish the job
 *
 * The scroll box is a claim about a computed layout, and there is no layout in this
 * zero-dependency suite. What is asserted here is the half that can be: forty records produce
 * forty rows inside **one** box, and the stylesheet caps that box's height and scrolls it. The
 * other half — that the box really is the same height at forty records as at four — was
 * measured in a real browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { deriveSnapshot } from '../core/index.ts';
import type { AdrEntry, Root, ScannedFile, Snapshot } from '../core/types.ts';
import { EMPTY_ANNOTATIONS } from './harness.ts';
import { FakeDocument, FakeElement, descendants } from './dom.ts';
import { renderDomain } from '../ui/domain.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = '/repo';

function file(path: string, text: string | null, readError?: string): ScannedFile {
  return {
    path,
    absPath: `${ROOT}/${path}`,
    text,
    ...(readError === undefined ? {} : { readError }),
  };
}

function root(overrides: Partial<Root>): Root {
  return {
    path: ROOT,
    label: 'repo',
    trackerPath: `${ROOT}/.scratch`,
    files: [],
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
    ...overrides,
  };
}

function derive(...roots: Root[]): Snapshot {
  return deriveSnapshot({ roots }, EMPTY_ANNOTATIONS);
}

function adrsOf(snapshot: Snapshot, index = 0): readonly AdrEntry[] {
  return snapshot.roots[index]?.adrs ?? [];
}

const ADR_0001 = '# 0001 \u2014 AI extracts, code derives\n\n## Context\n\nSomething.\n';
const ADR_0002 =
  '# 0002 \u2014 Zero dependencies\n\n## Context\n\nSomething.\n\n' +
  '## Amendment \u2014 narrowed to the runtime only\n\nLater.\n';

const GLOSSARY =
  '# Context\n\n## tracker-board\n\n### Structure\n\n' +
  '**Root**: a repo the board is watching.\n' +
  '**Feature**: one directory under `.scratch/`.\n\n' +
  '### Lanes\n\n' +
  '**Lane**: which column a ticket lands in, decided by the ladder and\n' +
  '**not by anything a person typed** into the file.\n';

/** A Root with both an ADR directory and a glossary, and every field the panel draws. */
function populatedRoot(): Root {
  return root({
    adrFiles: [
      file('docs/adr/0001-ai-extracts-code-derives.md', ADR_0001),
      file('docs/adr/0002-zero-dependency.md', ADR_0002),
    ],
    glossaryFile: file('CONTEXT.md', GLOSSARY),
  });
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test('an ADR is listed with its number from the file name and its title from the H1', () => {
  // The two halves come from two different places, and that split is the entire reason this
  // panel parses at all rather than being a list of links: the number is in the file name and
  // the title never is. `0001-ai-extracts-code-derives.md` carries a slug, not a title.
  const entries = adrsOf(derive(populatedRoot()));
  assert.equal(entries.length, 2);

  const first = entries[0];
  assert.equal(first?.number, 1, 'the leading number of the file name was not read');
  assert.equal(first?.title, '0001 \u2014 AI extracts, code derives', 'the title is not the H1');
  assert.equal(first?.titleSource, 'h1');
  assert.equal(first?.path, 'docs/adr/0001-ai-extracts-code-derives.md');
  assert.equal(first?.absPath, `${ROOT}/docs/adr/0001-ai-extracts-code-derives.md`);
  assert.equal(first?.readError, null);

  // The slug is not the title, stated rather than implied: this is what the links-only design
  // could not have delivered.
  assert.ok(
    !first?.path.includes(first.title),
    'the file name contains the title, so nothing was bought by opening the file',
  );
});

test('an in-body Amendment heading is quoted literally, and nothing is inferred from it', () => {
  const entries = adrsOf(derive(populatedRoot()));
  assert.equal(entries[0]?.amendmentHeading, null, 'an ADR with no such heading carries one');
  assert.equal(
    entries[1]?.amendmentHeading,
    'Amendment \u2014 narrowed to the runtime only',
    'the heading text is not carried verbatim',
  );

  // The refusal, stated structurally. An ADR entry has exactly these fields and there is no
  // status, no state, no lane, no lifecycle and nowhere for one to be added by accident.
  assert.deepEqual(Object.keys(entries[1] ?? {}).sort(), [
    'absPath',
    'amendmentHeading',
    'number',
    'path',
    'readError',
    'title',
    'titleSource',
  ]);

  // Case is not load-bearing on the match, and is untouched on the way out.
  const lower = derive(
    root({ adrFiles: [file('docs/adr/0003-x.md', '# 0003 \u2014 X\n\n## amendment lowered\n')] }),
  );
  assert.equal(adrsOf(lower)[0]?.amendmentHeading, 'amendment lowered');
});

test('the ledger orders by number, not by path, and an unnumbered file sorts last', () => {
  // A string sort puts 10 before 2. Zero-padded ADR file names would survive that, but the
  // padding is one repository's convention rather than a guarantee, and the
  // ordering here is the panel's only claim about sequence.
  const entries = adrsOf(
    derive(
      root({
        adrFiles: [
          file('docs/adr/10-tenth.md', '# Tenth\n'),
          file('docs/adr/notes.md', '# Loose note\n'),
          file('docs/adr/2-second.md', '# Second\n'),
          file('docs/adr/aaa.md', '# Also loose\n'),
        ],
      }),
    ),
  );
  assert.deepEqual(
    entries.map((entry) => entry.number),
    [2, 10, null, null],
    'the ledger is in string order, so 10 precedes 2',
  );
  assert.deepEqual(
    entries.slice(2).map((entry) => entry.path),
    ['docs/adr/aaa.md', 'docs/adr/notes.md'],
    'unnumbered entries are not in a total order of their own',
  );
});

test('an ADR that could not be read is kept, with its reason, and claims no title', () => {
  // Unreachable is not absent. This entry exists on disk and nobody can open it, which is a
  // different answer from "this Root has one ADR" — and the canary in the same scan is the
  // ADR that must still come out fully read.
  const entries = adrsOf(
    derive(
      root({
        adrFiles: [
          file('docs/adr/0001-ai-extracts-code-derives.md', ADR_0001),
          file('docs/adr/0002-gone.md', null, 'EACCES: permission denied'),
          file('docs/adr/0003-nameless.md', 'No heading at all, just a paragraph.\n'),
        ],
      }),
    ),
  );

  assert.equal(entries.length, 3, 'an unreadable ADR was dropped rather than stated');
  assert.equal(entries[1]?.readError, 'EACCES: permission denied');
  assert.equal(entries[1]?.titleSource, 'none', 'an unread file claimed a title');
  assert.equal(entries[1]?.title, '0002-gone.md', 'an unread file shows nothing at all');
  assert.equal(entries[1]?.amendmentHeading, null, 'a file nobody read was searched for a heading');

  // Read, and carrying no H1. Told apart from the one above, because "there is no title in
  // this file" and "nobody could open this file" are different facts about it.
  assert.equal(entries[2]?.titleSource, 'filename');
  assert.equal(entries[2]?.title, '0003-nameless.md');
  assert.equal(entries[2]?.readError, null);

  // The canary: a total collapse would satisfy every assertion above.
  assert.equal(entries[0]?.titleSource, 'h1');
  assert.equal(entries[0]?.title, '0001 \u2014 AI extracts, code derives');

  // And an unreadable file with no reason given still reports as unreadable.
  const silent = adrsOf(derive(root({ adrFiles: [file('docs/adr/0001-x.md', null)] })));
  assert.equal(silent[0]?.titleSource, 'none');
  assert.ok((silent[0]?.readError ?? '').length > 0, 'an unread file reported no reason at all');
});

// ---------------------------------------------------------------------------
// The glossary pointer
// ---------------------------------------------------------------------------

test('the glossary is a counted pointer, and absent is told apart from unreachable', () => {
  const counted = derive(populatedRoot()).roots[0]?.glossary;
  assert.equal(counted?.path, 'CONTEXT.md');
  assert.equal(counted?.absPath, `${ROOT}/CONTEXT.md`);
  assert.equal(counted?.readError, null);
  // Three terms, not four: `**not by anything a person typed**` opens a wrapped continuation
  // line and carries no colon, so it is the back half of the Lane entry rather than a term.
  assert.equal(counted?.termCount, 3, 'a wrapped continuation line was counted as a term');
  // `## tracker-board`, `### Structure`, `### Lanes`. The document's own H1 is its title.
  assert.equal(counted?.sectionCount, 3);

  // The definitions themselves are never carried. A pointer that shipped the glossary would
  // be the thing this panel exists not to do.
  assert.deepEqual(Object.keys(counted ?? {}).sort(), [
    'absPath',
    'path',
    'readError',
    'sectionCount',
    'termCount',
  ]);

  // The drawn form of those counts, because the figure and its noun are separate nodes: they
  // are set at different sizes. A browser showed this reading `55 terms33 sections` — the noun
  // had been handed the count as well — and no assertion over node counts could see it.
  const drawn = drawInto(panelDocument(), derive(populatedRoot()));
  assert.deepEqual(textOf(drawn, '.dom-big'), ['3', '3']);
  assert.deepEqual(textOf(drawn, '.dom-unit'), ['terms', 'sections'], 'the noun carries the figure twice');

  const single = drawInto(
    panelDocument(),
    derive(root({ glossaryFile: file('CONTEXT.md', '# Context\n\n## One\n\n**Root**: a repo.\n') })),
  );
  assert.deepEqual(textOf(single, '.dom-big'), ['1', '1']);
  assert.deepEqual(textOf(single, '.dom-unit'), ['term', 'section']);

  assert.equal(derive(root({})).roots[0]?.glossary, null, 'a Root with no glossary has one');

  const unreachable = derive(
    root({ glossaryFile: file('CONTEXT.md', null, 'EBUSY: resource busy') }),
  ).roots[0]?.glossary;
  assert.notEqual(unreachable, null, 'an unreachable glossary reads as a Root that has none');
  assert.equal(unreachable?.readError, 'EBUSY: resource busy');
  assert.equal(unreachable?.termCount, 0);
  assert.equal(unreachable?.path, 'CONTEXT.md', 'an unreachable glossary lost its path');
});

test('a fenced block cannot fabricate an Amendment heading, a title or a section', () => {
  // Every read here is a line-anchored pattern and markdown lets a fence contain any line at
  // all — including an ADR that documents the amendment convention by quoting it.
  const fenced =
    '# 0007 \u2014 How amendments are written\n\n' +
    'Write the heading like this:\n\n' +
    '```markdown\n# Not the title\n## Amendment \u2014 example only\n```\n\n' +
    'That is all.\n';
  const entry = adrsOf(derive(root({ adrFiles: [file('docs/adr/0007-how.md', fenced)] })))[0];
  assert.equal(entry?.title, '0007 \u2014 How amendments are written', 'a fenced H1 became the title');
  assert.equal(entry?.amendmentHeading, null, 'an ADR was marked by its own documentation');

  const glossary = derive(
    root({
      glossaryFile: file(
        'CONTEXT.md',
        '# Context\n\n## Terms\n\n**Root**: a repo.\n\n~~~sh\n## not a section\n**Fake**: not a term\n~~~\n',
      ),
    }),
  ).roots[0]?.glossary;
  assert.equal(glossary?.sectionCount, 1, 'a shell comment inside a fence counted as a section');
  assert.equal(glossary?.termCount, 1, 'a bold line inside a fence counted as a term');
});

test('CRLF text is read the same as LF, and a setext heading is refused rather than guessed', () => {
  // Windows. `readTree` hands the seam whatever the file holds, and this repository carries no
  // `.gitattributes`, so on a machine with `core.autocrlf=true` every ADR arrives CRLF. It
  // works, but for a reason subtle enough that a refactor would undo it without noticing: in
  // JavaScript a carriage return is itself a line terminator, so `$` under `m` matches before
  // it and the trailing `\r` never lands inside the captured title. Rewriting `$` as `\n` or
  // the capture as `[^\n]+` would silently start emitting titles ending in a control character.
  const dash = '\u2014';
  // Escaped, never a literal glyph: a byte-order mark is invisible in source views, so spelling
  // it as a character would make the fixture's input impossible to inspect reliably.
  const bom = '\ufeff';
  const crlf = `# 0002 ${dash} Zero dependencies\r\n\r\n## Context\r\n\r\nText.\r\n\r\n## Amendment ${dash} narrowed\r\n\r\nLater.\r\n`;
  const entry = adrsOf(derive(root({ adrFiles: [file('docs/adr/0002-x.md', crlf)] })))[0];
  assert.equal(entry?.title, `0002 ${dash} Zero dependencies`);
  assert.equal(entry?.amendmentHeading, `Amendment ${dash} narrowed`);
  for (const value of [entry?.title ?? '', entry?.amendmentHeading ?? '']) {
    assert.ok(!/[\r\n]/.test(value), `a line terminator was captured into ${JSON.stringify(value)}`);
  }

  const glossary = derive(
    root({ glossaryFile: file('CONTEXT.md', '# Context\r\n\r\n## Terms\r\n\r\n**Root**: a repo.\r\n') }),
  ).roots[0]?.glossary;
  assert.equal(glossary?.termCount, 1, 'a CRLF glossary counted no terms');
  assert.equal(glossary?.sectionCount, 1);

  // A byte-order mark. The walk decodes bytes without stripping one, and every read here is
  // anchored to the start of a line - so a U+FEFF sits between the start of the file and the
  // `#` of its H1. Treating that mark as content reports
  // `titleSource: 'filename'`, which means "read, and carries no H1": a false statement about a
  // file that has one.
  const marked = adrsOf(
    derive(root({ adrFiles: [file('docs/adr/0004-b.md', `${bom}# 0004 ${dash} Marked\n\n## Amendment ${dash} yes\n`)] })),
  )[0];
  assert.equal(marked?.titleSource, 'h1', 'a byte-order mark made the H1 unreadable');
  assert.equal(marked?.title, `0004 ${dash} Marked`, 'the mark was carried into the title');
  assert.equal(marked?.title.charCodeAt(0), 0x30, 'the title still starts with the mark');
  assert.equal(marked?.amendmentHeading, `Amendment ${dash} yes`);

  // Only a LEADING mark, and only one. Anywhere else U+FEFF is a zero-width no-break space and
  // is content: stripping it everywhere would edit somebody else's file text on the way past,
  // and this panel quotes what the file says rather than a tidied version of it.
  //
  // Asserted on a TITLE rather than on a glossary count, because a count cannot tell the two
  // apart — `**Ro<mark>ot**:` and `**Root**:` both match the term pattern. A glossary count would
  // pass whether the mark was stripped globally or not, while a title exposes the difference.
  const inner = adrsOf(
    derive(root({ adrFiles: [file('docs/adr/0005-i.md', `# 0005 ${dash} Ma${bom}rked\n`)] })),
  )[0];
  assert.equal(inner?.title, `0005 ${dash} Ma${bom}rked`, 'a mark inside the H1 was edited out of the title');
  assert.equal(inner?.titleSource, 'h1');

  // A setext heading is deliberately NOT read, and this records the choice rather than a gap.
  // Supporting it means treating any line followed by a run of `=` as a title, and a divider
  // or a table rule in the body is then a title the file does not have. The fallback is honest
  // where a guess would not be: the row shows the file name and says that is what it is.
  const setext = adrsOf(
    derive(root({ adrFiles: [file('docs/adr/0003-s.md', 'Underlined title\n================\n\nBody.\n')] })),
  )[0];
  assert.equal(setext?.titleSource, 'filename');
  assert.equal(setext?.title, '0003-s.md', 'a setext underline was read as a title after all');
});

test('nothing that is not live markdown can fabricate a title, a heading or a count', () => {
  // Five ways this parser could invent ADR metadata out of text that markdown itself does not
  // treat as markdown. Every one of them is the same defect: a file
  // being described by its own documentation or its own commented-out draft.
  const fence = '```';
  const cases: readonly [string, string, string, string | null][] = [
    // A closing fence carries its marker and nothing else. `\`\`\`still-code` is not one, so the
    // block runs on and everything below it stays inside the fence.
    [
      'a lax closing fence exposed the rest of the file',
      `${fence}markdown\ninside\n${fence}still-code\n# Fabricated\n## Amendment fabricated\n`,
      '0020-x.md',
      null,
    ],
    // A backtick fence's info string may not contain a backtick, so this opens nothing and the
    // real heading below it must still be found.
    [
      'a non-fence swallowed a real H1',
      '```a`b\n# Real title\n',
      '0021-x.md',
      'Real title',
    ],
    // An HTML comment block is not markdown. A commented-out draft heading is the most ordinary
    // thing to find in a decision record.
    [
      'an HTML comment fabricated a title and a heading',
      '<!--\n# Fabricated\n## Amendment fabricated\n-->\n# Real title\n',
      '0022-x.md',
      'Real title',
    ],
    // Old-style CR endings. The splitter saw one unbreakable line while the patterns saw every
    // line, so no fence ever opened and fenced content was read as prose.
    [
      'lone carriage returns desynchronised the splitter from the patterns',
      `${fence}\r# Fabricated\r## Amendment fabricated\r${fence}\r# Real title\r`,
      '0023-x.md',
      'Real title',
    ],
    [
      'a unicode line separator did the same',
      `${fence}\u2028# Fabricated\u2028## Amendment fabricated\u2028${fence}\u2028# Real title\u2028`,
      '0024-x.md',
      'Real title',
    ],
  ];

  for (const [why, text, name, expected] of cases) {
    const entry = adrsOf(derive(root({ adrFiles: [file(`docs/adr/${name}`, text)] })))[0];
    assert.equal(entry?.amendmentHeading, null, why);
    if (expected === null) {
      assert.equal(entry?.titleSource, 'filename', why);
    } else {
      assert.equal(entry?.title, expected, why);
      assert.equal(entry?.titleSource, 'h1', why);
    }
  }

  // The same for the glossary's two counts, in one file.
  const glossary = derive(
    root({
      glossaryFile: file(
        'CONTEXT.md',
        `# C\n\n## Real\n\n**Real**: a term.\n\n<!--\n## Fabricated\n**Fabricated**: not a term.\n-->\n`,
      ),
    }),
  ).roots[0]?.glossary;
  assert.equal(glossary?.sectionCount, 1, 'a commented-out heading counted as a section');
  assert.equal(glossary?.termCount, 1, 'a commented-out entry counted as a term');

  // The canary: an ordinary ADR in the same shape is still read completely.
  const ordinary = adrsOf(
    derive(root({ adrFiles: [file('docs/adr/0025-x.md', ADR_0002)] })),
  )[0];
  assert.equal(ordinary?.title, '0002 \u2014 Zero dependencies');
  assert.equal(ordinary?.amendmentHeading, 'Amendment \u2014 narrowed to the runtime only');
});

test('a heading that is punctuation, empty, or too big to be a number is refused', () => {
  const only = (text: string, name = '0030-x.md'): AdrEntry | undefined =>
    adrsOf(derive(root({ adrFiles: [file(`docs/adr/${name}`, text)] })))[0];

  // `#` followed by nothing but blanks is a heading with no content. Returning `title: " "` with
  // `titleSource: 'h1'` would invent a real title made of one space.
  const blank = only('#   \n\nBody.\n');
  assert.equal(blank?.titleSource, 'filename', 'a blank heading was reported as a title');
  assert.equal(blank?.title, '0030-x.md');

  // The optional closing run of hashes is punctuation, not title text.
  assert.equal(only('# Real title ###\n')?.title, 'Real title', 'the closing sequence stayed in the title');
  assert.equal(only('# Real title #\n')?.title, 'Real title');
  // No space before them, so they really are part of the title.
  assert.equal(only('# Real title#\n')?.title, 'Real title#', 'a hash that is part of the title was stripped');
  // The boundary, asserted as what it does rather than what would be tidy: a heading whose
  // whole content is hashes has no space before the run, so the run is content and is kept.
  // Stripping it would need the rule to reach back past the opening marker's own space, and
  // no ADR in any convention writes this.
  assert.equal(only('# ###\n')?.title, '###');
  assert.equal(only('# ###\n')?.titleSource, 'h1');

  // Past 2^53 `parseInt` rounds, so two different file names produced one number, the ordering
  // stopped matching the files, and the panel refused the same value as unsafe and drew nothing.
  // Absent is the honest answer for a number nobody can represent.
  const big = adrsOf(
    derive(
      root({
        adrFiles: [
          file('docs/adr/9007199254740992-a.md', '# A\n'),
          file('docs/adr/9007199254740993-b.md', '# B\n'),
        ],
      }),
    ),
  );
  assert.deepEqual(big.map((entry) => entry.number), [null, null], 'an unrepresentable number was reported');
  assert.deepEqual(big.map((entry) => entry.title), ['A', 'B'], 'the entries themselves were lost');
  // And the boundary still reads: the largest safe integer is a number.
  assert.equal(only('# Safe\n', '9007199254740991-c.md')?.number, 9007199254740991);
});

test('an unreadable file with an empty reason still reads as unreachable, not as empty', () => {
  // `readError: ''` is a string, so it passed the `?? ` fallback and came out as `''` - which
  // the panel treats as "nothing to say". An unreachable glossary therefore rendered exactly
  // like a readable one that defines nothing, which is the collision this entry prevents one
  // layer down.
  const snapshot = derive(
    root({
      adrFiles: [file('docs/adr/0040-gone.md', null, '')],
      glossaryFile: file('CONTEXT.md', null, ''),
    }),
  );
  const entry = adrsOf(snapshot)[0];
  assert.ok((entry?.readError ?? '').length > 0, 'an unreadable ADR reported an empty reason');
  assert.equal(entry?.titleSource, 'none');
  assert.ok((snapshot.roots[0]?.glossary?.readError ?? '').length > 0, 'an unreachable glossary reported nothing');

  // And it reaches the screen, which is the half that matters to a reader.
  const mount = drawInto(panelDocument(), snapshot);
  assert.equal(mount.querySelectorAll('.dom-err').length, 2, 'neither failure was drawn');
  assert.equal(mount.querySelectorAll('.dom-big').length, 0, 'an unreachable glossary drew a count');
});

test('a glossaryFile that is not a file record is stated, never read as a Root with no glossary', () => {
  // Both `adrFiles` and `glossaryFile` need the same shape guard; otherwise a bare string, a
  // number or a list becomes the ordinary answer "this Root has no glossary".
  for (const bad of ['CONTEXT.md', 42, false, ['CONTEXT.md']]) {
    const broken = { ...root({}), glossaryFile: bad } as unknown as Root;
    const snapshot = derive(broken);
    assert.equal(snapshot.roots[0]?.glossary, null);
    assert.ok(
      (snapshot.roots[0]?.warnings ?? []).some(
        (warning) => warning.kind === 'scan-error' && warning.message.includes('glossaryFile'),
      ),
      `glossaryFile: ${JSON.stringify(bad)} vanished without a warning`,
    );
  }

  // A Root that genuinely has none still says nothing, because that is not a fault.
  const quiet = derive(root({}));
  assert.equal(quiet.roots[0]?.glossary, null);
  assert.equal((quiet.roots[0]?.warnings ?? []).length, 0, 'a Root with no glossary raised a warning');
});

test('an adrFiles that is not a list is stated, never read as a Root with no ADRs', () => {
  // The same rule the rest of the seam follows: an omission the board cannot state is a bug.
  // Silently emitting an empty ledger would render this as the perfectly ordinary answer
  // "this Root keeps no ADRs".
  const broken = { ...root({}), adrFiles: 'docs/adr' } as unknown as Root;
  const snapshot = derive(broken);
  assert.deepEqual(adrsOf(snapshot), []);
  assert.ok(
    (snapshot.roots[0]?.warnings ?? []).some(
      (warning) => warning.kind === 'scan-error' && warning.message.includes('adrFiles'),
    ),
    'a malformed adrFiles produced no warning, so the omission is invisible',
  );
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * A document with the panel's mount, counting what the panel does to it.
 *
 * `reads` exists because `renderDomain` carries a top-level guard so that a throw cannot cost
 * the reader their focused card, and that guard would otherwise make the shared assertion in
 * `board-ui.test.ts` vacuous for this panel: with the early return deleted, the panel reaches
 * for the mount, the hostile double there throws, the guard swallows it, and `undefined` comes
 * back exactly as the assertion expects. Counting the reads asks the question that survives
 * the guard — was the document touched at all.
 */
class PanelDocument extends FakeDocument {
  listeners = 0;
  reads = 0;
  /**
   * The handlers themselves, not just a tally.
   *
   * Counting and discarding would let a completely empty click handler pass every listener test
   * in this file. Keeping the handlers lets {@link click} actually run one.
   */
  readonly handlers: ((event: unknown) => void)[] = [];

  addEventListener(_type: string, handler: (event: unknown) => void): void {
    this.listeners += 1;
    this.handlers.push(handler);
  }

  /**
   * Deliver a click to every registered handler, with the minimum an event needs to be one.
   *
   * `test/dom.ts` has no event dispatch and no `closest`, and it is shared, so the shape is
   * built here instead: `closest` walks the fake tree by attribute, which is the only lookup
   * the panel's handler performs. This cannot prove the dialog opens — `showModal` is a
   * browser behaviour and was verified in one — but it does prove the handler finds the right
   * node and calls the right method, which counting never could.
   */
  click(target: FakeElement): void {
    const closest = (selector: string): FakeElement | null => {
      const name = /^\[([a-z-]+)\]$/.exec(selector)?.[1] ?? '';
      for (let node: FakeElement | null = target; node !== null; node = node.parentNode) {
        if (node.hasAttribute(name)) return node;
      }
      return null;
    };
    for (const handler of this.handlers) handler({ target: { ...target, closest } });
  }

  override getElementById(id: string): FakeElement | null {
    this.reads += 1;
    return super.getElementById(id);
  }
}

/**
 * A document that refuses to build one tag, so the panel's draw path throws part-way through.
 *
 * The tag is chosen so the *failure* path still works: the failure notice is built from `div`,
 * `h2` and `p`, and breaking `ol` fails only the ledger. That is what makes the pair below a
 * real test rather than a test of whether anything at all can be created.
 */
class BrittleDocument extends PanelDocument {
  // A plain field, assigned in the body. A TypeScript parameter property is not erasable
  // syntax, so `node --test` rejects the whole file with
  // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` - which reads as `# tests 1 # fail 1`, a broken file
  // wearing the shape of one failing test.
  refuse = '';

  override createElement(tagName: string): FakeElement {
    if (tagName === this.refuse) throw new Error('the renderer refused to build an ol');
    return super.createElement(tagName);
  }
}

function brittleDocument(refuse: string): BrittleDocument {
  const body = new FakeElement('body');
  const mount = new FakeElement('section');
  mount.id = 'domain-panel';
  mount.className = 'section panelmount';
  body.appendChild(mount);
  const doc = new BrittleDocument(body);
  doc.refuse = refuse;
  return doc;
}

function panelDocument(): PanelDocument {
  const body = new FakeElement('body');
  const mount = new FakeElement('section');
  mount.id = 'domain-panel';
  mount.className = 'section panelmount';
  body.appendChild(mount);
  return new PanelDocument(body);
}

function drawInto(doc: PanelDocument, snapshot: unknown): FakeElement {
  renderDomain(doc as never, null as never, snapshot);
  const mount = doc.getElementById('domain-panel');
  assert.ok(mount !== null, 'the mount vanished');
  return mount;
}

function textOf(mount: FakeElement, selector: string): string[] {
  return mount.querySelectorAll(selector).map((node) => node.textContent);
}

const CSS = readFileSync(join(import.meta.dirname, '..', 'ui', 'domain.css'), 'utf8');

test('the panel draws a row per ADR, with its number, its title and a path that copies', () => {
  const mount = drawInto(panelDocument(), derive(populatedRoot()));

  const rows = mount.querySelectorAll('.dom-adr');
  assert.equal(rows.length, 2, 'the ledger did not draw one row per record');

  // The mount is a `<section>`, which is only exposed as a region once it has a name. Asserted
  // in the populated direction as well as the absent one: checking only that an absent panel
  // drops the name proves nothing about a panel that has one.
  const named = mount.getAttribute('aria-labelledby');
  assert.equal(named, 'domain-h', 'the panel does not name itself, so it is not a region');
  assert.equal(mount.querySelectorAll('.subhead').length, 1);
  assert.ok(
    descendants(mount).some((node) => node.id === named && node.tagName === 'h2'),
    'the panel names a heading that is not in it',
  );
  assert.deepEqual(textOf(mount, '.dom-num'), ['1', '2']);
  assert.deepEqual(textOf(mount, '.dom-title'), [
    '0001 \u2014 AI extracts, code derives',
    '0002 \u2014 Zero dependencies',
  ]);

  // Paths copy rather than navigate, on the same terms as every other path on the board: the
  // displayed text is the Root-relative path and the clipboard gets the absolute one.
  const buttons = mount.querySelectorAll('.dom-adrs [data-copy]');
  assert.equal(buttons.length, 2, 'the two records did not produce two paths');
  // Four in all: one per record, one on the glossary pointer, and one inside the dialog,
  // which is where a reader who opened it to look for the definitions is told to go instead.
  assert.equal(mount.querySelectorAll('[data-copy]').length, 4);
  const first = buttons[0];
  assert.equal(first?.tagName, 'button', 'a path was drawn as something other than a button');
  // The property, as `render.js` sets it on every other path on the board. A bare `<button>`
  // inside the glossary dialog's form would submit it and close the dialog.
  assert.equal(first?.type, 'button');
  assert.equal(first?.textContent, 'docs/adr/0001-ai-extracts-code-derives.md');
  assert.equal(
    first?.getAttribute('data-copy'),
    `${ROOT}/docs/adr/0001-ai-extracts-code-derives.md`,
    'the clipboard would get the relative path, which is not a path on disk',
  );
  assert.equal(
    first?.getAttribute('aria-label'),
    'Copy path docs/adr/0001-ai-extracts-code-derives.md',
  );
  assert.ok(first?.className.split(' ').includes('copy'), 'the path does not use the board copy control');
});

test('an Amendment heading is drawn as a quoted heading and never as a status', () => {
  const mount = drawInto(panelDocument(), derive(populatedRoot()));

  const quotes = mount.querySelectorAll('.dom-quote');
  assert.equal(quotes.length, 1, 'exactly one record carries an Amendment heading');
  assert.equal(quotes[0]?.textContent, 'Amendment \u2014 narrowed to the runtime only');
  assert.equal(quotes[0]?.tagName, 'q', 'the heading text is not marked up as a quotation');

  const marked = mount.querySelectorAll('.dom-amend');
  assert.equal(marked.length, 1);
  assert.ok(
    marked[0]?.textContent.startsWith('heading'),
    'the quotation is not labelled as heading text, so it reads as a state',
  );

  // The refusal, swept over the panel's OWN words across the whole panel.
  //
  // A sweep over only `.dom-adr` is both blind and overbroad. Blind: an invented status in the
  // summary line, the refusal note or a heading passes untouched. Overbroad: it reads the ADR
  // title and
  // path, which are somebody else's repository text — an ADR honestly titled `Deprecated APIs`
  // would have failed a test about what the *panel* says.
  //
  // So the sweep now covers every node in the panel and subtracts the untrusted text: quoted
  // headings, titles, paths and read-failure reasons. What is left is what this module wrote.
  const forbidden = [
    'status', 'accepted', 'proposed', 'rejected', 'deprecated', 'superseded',
    'obsolete', 'amended', 'lifecycle', 'active', 'current', 'stage', 'workflow',
  ];
  // `.sectnote` is subtracted too, and for the opposite reason to the rest: it is the refusal
  // note, and a note that refuses to infer a status has to be allowed to say the word "status".
  // It is not left unchecked — it is asserted directly below, against the statements it must
  // make, which is a stronger test than a word sweep could be.
  const quoted = ['.dom-quote', '.dom-title', '.dom-path', '.dom-err', '.sectnote'];
  const panelDoc = panelDocument();
  const whole = drawInto(panelDoc, derive(populatedRoot()));

  const refusal = whole.querySelector('.sectnote')?.textContent ?? '';
  assert.match(refusal, /chronological rather than a progression/, 'the note no longer denies a progression');
  assert.match(refusal, /carries no status field/, 'the note no longer denies a status');
  assert.match(refusal, /quoted and means only that the file has it/, 'the note no longer qualifies the heading');

  let own = whole.textContent;
  for (const selector of quoted) {
    for (const node of whole.querySelectorAll(selector)) own = own.split(node.textContent).join(' ');
  }
  assert.ok(own.includes('Domain model'), 'the sweep subtracted the whole panel, so it proves nothing');
  assert.ok(own.includes('Decisions'), 'the sweep no longer covers the ledger heading');
  assert.ok(own.includes('Glossary'), 'the sweep no longer covers the glossary block');
  for (const word of forbidden) {
    assert.ok(
      !own.toLowerCase().includes(word),
      `the panel's own words say "${word}", which is vocabulary an ADR does not have`,
    );
  }

  // And the other direction: repository text carrying that vocabulary is drawn, not censored.
  // The panel quotes; it does not edit what it quotes.
  const quoting = drawInto(
    panelDocument(),
    derive(
      root({
        adrFiles: [
          file('docs/adr/0011-d.md', `# 0011 ${'\u2014'} Deprecated APIs\n\n## Amendment ${'\u2014'} superseded status removed\n`),
        ],
      }),
    ),
  );
  assert.match(quoting.textContent, /Deprecated APIs/, 'the panel edited a title it was quoting');
  assert.match(quoting.textContent, /superseded status removed/, 'the panel edited a heading it was quoting');

  // And no row carries a state as an attribute either, which is the other way a lane arrives.
  for (const node of descendants(mount)) {
    for (const name of ['data-status', 'data-state', 'data-lane', 'data-l']) {
      assert.ok(!node.hasAttribute(name), `the panel set ${name}, which is a Lane vocabulary`);
    }
  }
});

test('a panel that cannot draw says so, and is never mistaken for an absent one', () => {
  // The two states that must stay distinct are asserted against each other in one test because
  // separately each one passes for the wrong reason.
  //
  // Being total is a requirement: `board.js` calls the three panels in bare sequence and then
  // restores the focused card, so a throw here takes out its two peers and the reader's focus.
  // But catching and rendering nothing would be worse than the throw, because an empty mount
  // ALREADY means something here - "this repository keeps no ADRs and has no glossary" - so a
  // silent failure would make that claim about a repository it knows nothing about. Pairing the
  // states lets the test distinguish "the rule ran and correctly degraded" from "nothing ran".
  const broken = brittleDocument('ol');
  const failed = drawInto(broken, derive(populatedRoot()));

  assert.notEqual(failed.childNodes.length, 0, 'a panel that threw rendered as an absent one');
  assert.equal(failed.querySelectorAll('.dom-failed').length, 1, 'the failure is not stated');
  assert.match(
    failed.textContent,
    /not the same as this repository having none/,
    'the failure does not say which of the two absences it is',
  );
  assert.match(failed.textContent, /refused to build an ol/, 'the reason is not carried');
  assert.equal(failed.querySelectorAll('.dom-adr').length, 0);

  // A failure is not a rendered state to be skipped next frame. The signature is cleared, so
  // the very next Snapshot - a few hundred milliseconds away on a live board - tries again.
  assert.equal(
    failed.getAttribute('data-domain-sig'),
    null,
    'a render that never finished recorded a signature, so the retry will be skipped',
  );

  // And the other half of the pair: absent for the legitimate reason draws nothing at all.
  const absent = drawInto(panelDocument(), derive(root({})));
  assert.equal(absent.childNodes.length, 0, 'the legitimate absent state is no longer empty');
  assert.equal(absent.querySelectorAll('.dom-failed').length, 0);
});

test('a panel recovers on the next good frame, including one it has drawn before', () => {
  // The property the two signature lines exist for, asserted as behaviour rather than as
  // either line. The signature is recorded *after* a successful build AND cleared on failure,
  // so removing either one alone changes no observable answer -
  // each covers for the other. Only the sequence below needs both.
  //
  // Draw A, fail on B, then send A again. A live board sends the same Snapshot repeatedly, so
  // "the model I already drew once" is the ordinary next frame rather than a contrived one -
  // and it is exactly the frame a stale signature would skip, stranding the reader on a
  // failure notice for a Snapshot the panel can draw perfectly well.
  const doc = brittleDocument('');
  const modelA = derive(populatedRoot());
  const modelB = derive(root({ adrFiles: [file('docs/adr/0009-b.md', '# 0009 Nine\n')] }));

  const mount = drawInto(doc, modelA);
  assert.equal(mount.querySelectorAll('.dom-adr').length, 2, 'the first frame did not draw');
  const drawnA = mount.getAttribute('data-domain-sig');
  assert.notEqual(drawnA, null, 'a successful render recorded no signature');

  doc.refuse = 'ol';
  drawInto(doc, modelB);
  assert.equal(mount.querySelectorAll('.dom-failed').length, 1, 'the failing frame did not state itself');

  doc.refuse = '';
  drawInto(doc, modelA);
  assert.equal(
    mount.querySelectorAll('.dom-failed').length,
    0,
    'the panel stayed on its failure notice for a Snapshot it had already drawn once',
  );
  assert.equal(mount.querySelectorAll('.dom-adr').length, 2);
  assert.equal(mount.getAttribute('data-domain-sig'), drawnA);
});

test('a Root with no ADR directory and no glossary leaves the panel absent, not empty', () => {
  // Absent means no node at all: `board.css` hides an empty `.panelmount`, so an empty mount
  // is a panel that is not on the page rather than a heading over nothing.
  const mount = drawInto(panelDocument(), derive(root({})));
  assert.equal(mount.childNodes.length, 0, 'the panel drew scaffolding for a Root with nothing in it');
  assert.equal(mount.getAttribute('aria-labelledby'), null, 'an absent panel still names itself');
  assert.match(
    readFileSync(join(import.meta.dirname, '..', 'ui', 'board.css'), 'utf8'),
    /\.panelmount:empty\s*\{[^}]*display:\s*none/,
    'an empty mount is no longer hidden, so an empty panel is now visible scaffolding',
  );
});

test('a bare Root beside a populated one draws the populated one and nothing for the bare', () => {
  // The pairing that makes the test above mean anything. A module that collapsed entirely
  // would pass "the bare Root drew nothing" perfectly.
  const mount = drawInto(
    panelDocument(),
    derive(root({ path: '/bare', label: 'bare' }), populatedRoot()),
  );

  assert.equal(mount.querySelectorAll('.dom-root').length, 1, 'the bare Root got a block of its own');
  assert.equal(mount.querySelectorAll('.dom-adr').length, 2, 'the populated Root did not draw');
  assert.equal(mount.querySelectorAll('.dom-gloss').length, 1);
  assert.ok(!mount.textContent.includes('bare'), 'the bare Root is named on a panel it contributes nothing to');

  // One Root left with anything to say, so no Root heading is drawn.
  assert.equal(mount.querySelectorAll('.dom-rootname').length, 0);

  // Two of them, and both are named.
  const two = drawInto(panelDocument(), derive(populatedRoot(), root({ path: '/other', label: 'other', adrFiles: [file('docs/adr/0009-x.md', '# 0009 \u2014 Nine\n')] })));
  assert.deepEqual(textOf(two, '.dom-rootname'), ['repo', 'other']);
});

test('an unreachable ADR and an unreachable glossary are drawn as unreachable, not as empty', () => {
  const mount = drawInto(
    panelDocument(),
    derive(
      root({
        adrFiles: [
          file('docs/adr/0001-ai-extracts-code-derives.md', ADR_0001),
          file('docs/adr/0002-gone.md', null, 'EACCES: permission denied'),
        ],
        glossaryFile: file('CONTEXT.md', null, 'EBUSY: resource busy'),
      }),
    ),
  );

  const errors = textOf(mount, '.dom-err');
  assert.equal(errors.length, 2, 'an unreachable record and an unreachable glossary drew no reason');
  assert.ok(errors[0]?.includes('EACCES: permission denied'));
  assert.ok(errors[1]?.includes('EBUSY: resource busy'));

  // The counts are not drawn at all rather than drawn as zero: `0 terms` for a file nobody
  // could open is the unreachable case dressed as the counted one.
  assert.equal(mount.querySelectorAll('.dom-big').length, 0, 'an unreachable glossary drew a count');

  // The canary again: the readable record in the same pass is fully drawn.
  assert.deepEqual(textOf(mount, '.dom-title'), [
    '0001 \u2014 AI extracts, code derives',
    '0002-gone.md',
  ]);
  assert.equal(mount.querySelectorAll('.dom-adr').length, 2);
});

// ---------------------------------------------------------------------------
// Behaviour on a live board — every frame, not just the first
// ---------------------------------------------------------------------------

test('a frame that changes nothing does not rebuild the panel', () => {
  // `renderDomain` runs on every board render — several times a minute, and once per file
  // change while an agent works in a watched repo. Rebuilding regardless would take the
  // reader's scroll position in the ADR box and any open dialog with it, underneath them.
  const doc = panelDocument();
  const mount = drawInto(doc, derive(populatedRoot()));
  const before = mount.childNodes[0];
  assert.ok(before !== undefined, 'nothing was drawn to begin with');

  drawInto(doc, derive(populatedRoot()));
  assert.equal(mount.childNodes[0], before, 'an unchanged Snapshot replaced the subtree');

  // And a real change still redraws, so this is not passing by never drawing twice.
  const changed = derive(
    root({ adrFiles: [file('docs/adr/0001-ai-extracts-code-derives.md', ADR_0001)] }),
  );
  drawInto(doc, changed);
  assert.notEqual(mount.childNodes[0], before, 'a changed Snapshot did not redraw');
  assert.equal(mount.querySelectorAll('.dom-adr').length, 1);
});

test('the panel registers one click handler, not one per frame', () => {
  // A listener added from inside a render accumulates silently, one per frame, and the
  // symptom is a control firing N times with nothing in the source saying so.
  const doc = panelDocument();
  const snapshot = derive(populatedRoot());
  for (let frame = 0; frame < 5; frame += 1) renderDomain(doc as never, null as never, snapshot);
  assert.equal(doc.listeners, 1, `${String(doc.listeners)} handlers were registered over five frames`);

  // Including across a redraw, which is the case a "wire it when you build" version passes
  // the loop above and fails here.
  renderDomain(doc as never, null as never, derive(root({ adrFiles: [file('docs/adr/0001-x.md', '# X\n')] })));
  assert.equal(doc.listeners, 1);
});

test('the handler finds the dialog its button names, and is one handler per document', () => {
  // The listener count alone is satisfied by a handler that does nothing at all, so the handler
  // is actually run here. What it must do is find the dialog named by
  // the button's attribute and open it; the opening itself is a browser behaviour and was
  // verified in one.
  const doc = panelDocument();
  const mount = drawInto(doc, derive(populatedRoot()));
  assert.equal(doc.listeners, 1);

  const opener = mount.querySelector('[data-domain-open]');
  assert.ok(opener !== null, 'the glossary drew no way to reach the definitions');
  const dialog = mount.querySelector('.dom-dialog');
  assert.ok(dialog !== null, 'there is no dialog to reach');
  assert.equal(opener.getAttribute('data-domain-open'), dialog.id, 'the button names no dialog');

  let opened = 0;
  Object.assign(dialog, { open: false, showModal: () => { opened += 1; } });
  doc.click(opener);
  assert.equal(opened, 1, 'the handler did not open the dialog its button names');

  // Already open, so a second click is a no-op rather than a throw: `showModal` throws on an
  // open dialog and a double click is an ordinary thing for a reader to do.
  Object.assign(dialog, { open: true });
  doc.click(opener);
  assert.equal(opened, 1, 'the handler reopened a dialog that was already open');

  // A click on something else is ignored.
  const elsewhere = mount.querySelector('.dom-title');
  assert.ok(elsewhere !== null);
  Object.assign(dialog, { open: false });
  doc.click(elsewhere);
  assert.equal(opened, 1, 'the handler fired on a click that named no dialog');
});

test('one handler per document, across documents and back again', () => {
  // Remembering only the last document seen makes A, B, A find the memory pointing at B and wire
  // A a second time. The board has one document, but the helper's contract is once per document.
  const a = panelDocument();
  const b = panelDocument();
  const one = derive(populatedRoot());
  const two = derive(root({ adrFiles: [file('docs/adr/0007-x.md', '# 0007 Seven\n')] }));

  renderDomain(a as never, null as never, one);
  renderDomain(b as never, null as never, two);
  renderDomain(a as never, null as never, two);
  renderDomain(b as never, null as never, one);

  assert.equal(a.listeners, 1, `document A collected ${String(a.listeners)} handlers`);
  assert.equal(b.listeners, 1, `document B collected ${String(b.listeners)} handlers`);
});

test('no Snapshot at all touches nothing, including the mount', () => {
  // `board.js` holds `null` from page load until the first frame arrives. A panel that
  // reached into it would throw on first paint, before anything is on screen.
  // `undefined` as well as `null`, which is the shared contract in `board-ui.test.ts`: a frame
  // that is literally undefined is nothing having been passed, not a malformed Snapshot having
  // arrived — `JSON.parse` cannot produce it. Pinned here too, because this is the boundary
  // between "absent" and the fault path below it, and getting it wrong turns first paint into a
  // failure notice on every board that has not loaded yet.
  for (const absent of [null, undefined]) {
    const fresh = panelDocument();
    assert.equal(renderDomain(fresh as never, null as never, absent), undefined);
    assert.equal(fresh.reads, 0, `the panel reached into the document on ${String(absent)}`);
    assert.equal(fresh.listeners, 0, `a handler was registered on ${String(absent)}`);
  }

  const doc = panelDocument();
  assert.equal(renderDomain(doc as never, null as never, null), undefined);
  assert.equal(doc.reads, 0, 'the panel reached into the document before a Snapshot arrived');
  assert.equal(doc.listeners, 0, 'a handler was registered before there was anything to draw');

  // Not "drew nothing" — "touched nothing". An early return that had been deleted would still
  // draw nothing here, because a `null` Snapshot projects to no Roots either way; what it
  // would do is read the mount and stamp its signature on it. That is what is asserted.
  const mount = doc.getElementById('domain-panel');
  assert.equal(mount?.childNodes.length, 0);
  assert.equal(mount?.getAttribute('data-domain-sig'), null, 'the panel wrote to the mount anyway');
});

test('a malformed frame is stated, never absorbed as absence or left standing as stale', () => {
  // Treating malformed input as an absent panel blesses the defect rather than guarding against
  // it. The value is `JSON.parse` output off a socket, so a frame that is not a Snapshot
  // is an ordinary event, and there are exactly two wrong ways to handle it. Both were live:
  //
  //   `{ roots: 'nope' }` projected to no Roots and cleared the mount, which is this panel's
  //   way of saying "this repository keeps no ADRs and has no glossary";
  //   `'text'` returned early and left the previous ADRs on screen as though they were current.
  //
  // Neither throws, so the catch never saw either of them.
  for (const bad of ['text', 42, true, { roots: 'nope' }, { roots: 7 }]) {
    const doc = panelDocument();
    // Drawn once from a good frame first, so "left the old content standing" is a state this
    // assertion can actually observe.
    drawInto(doc, derive(populatedRoot()));
    const mount = drawInto(doc, bad);

    assert.equal(mount.querySelectorAll('.dom-failed').length, 1, `${JSON.stringify(bad)} was absorbed`);
    assert.equal(mount.querySelectorAll('.dom-adr').length, 0, `${JSON.stringify(bad)} left stale rows on screen`);
    assert.notEqual(mount.childNodes.length, 0, `${JSON.stringify(bad)} rendered as an absent panel`);
    assert.equal(mount.getAttribute('data-domain-sig'), null, `${JSON.stringify(bad)} latched a signature`);
  }

  // The shapes that are NOT faults, because each is a real Snapshot that legitimately has
  // nothing to draw. Widening the check to these would turn one odd field into a panel-wide
  // refusal, which is the opposite of what a per-row degraded state is for.
  for (const fine of [{}, { roots: [] }, { roots: [null, 7, { adrs: 'no' }] }]) {
    const doc = panelDocument();
    const mount = drawInto(doc, fine);
    assert.equal(renderDomain(doc as never, null as never, fine), undefined);
    assert.equal(mount.querySelectorAll('.dom-failed').length, 0, `${JSON.stringify(fine)} was called a fault`);
  }

  // A record whose every field is the wrong type still draws a row rather than a hole. The
  // second one is the shape a defensive reader gets wrong most easily: an empty string is a
  // string, and treating it as one draws an empty quotation under a label reading `heading`,
  // which asserts that the file carries an Amendment heading.
  const doc = panelDocument();
  const mount = drawInto(doc, {
    roots: [
      {
        label: 7,
        adrs: [
          { number: 'one', title: null, amendmentHeading: 5, path: 12 },
          { number: 2, title: 'Two', amendmentHeading: '', readError: '', path: 'docs/adr/2.md' },
        ],
      },
    ],
  });
  assert.equal(mount.querySelectorAll('.dom-adr').length, 2);
  assert.deepEqual(textOf(mount, '.dom-num'), ['\u2014', '2'], 'a number that is not a number drew as one');
  assert.equal(mount.querySelectorAll('.dom-quote').length, 0, 'an absent heading was quoted anyway');
  assert.equal(mount.querySelectorAll('.dom-err').length, 0, 'an empty reason was drawn as a read failure');
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

test('forty records draw forty rows inside one box the stylesheet caps and scrolls', () => {
  // The number the design used to reject an ADR column: at forty records a column is roughly
  // 5,808px against a 695px board, while this panel is the height of its box whatever N is.
  const many = Array.from({ length: 40 }, (_value, index) =>
    file(
      `docs/adr/${String(index + 1).padStart(4, '0')}-decision-${String(index + 1)}.md`,
      `# ${String(index + 1).padStart(4, '0')} \u2014 Decision number ${String(index + 1)}\n\n## Context\n\nText.\n`,
    ),
  );
  const mount = drawInto(panelDocument(), derive(root({ adrFiles: many })));

  const lists = mount.querySelectorAll('.dom-list');
  assert.equal(lists.length, 1, 'forty records were split across more than one box');
  assert.equal(lists[0]?.querySelectorAll('.dom-adr').length, 40);
  assert.equal(lists[0]?.tagName, 'ol', 'the ledger is not marked up as an ordered list');
  assert.equal(lists[0]?.getAttribute('tabindex'), '0', 'the scroll region cannot be reached by keyboard');

  // In numeric order at two digits, which is where a string sort would have shown itself.
  assert.deepEqual(textOf(mount, '.dom-num').slice(0, 12), [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
  ]);

  // The half of the scroll claim that source can carry. The rest is a computed layout and was
  // measured in a browser; there is no layout in this suite to measure.
  // The exact height, not "some number of pixels". `max-height: 1px` satisfies the looser form
  // while making the panel useless. The asserted number is the one measured in a browser rather
  // than an arbitrary constant.
  const rule = /#domain-panel \.dom-list \{[^}]*\}/.exec(CSS)?.[0] ?? '';
  assert.match(rule, /max-height:\s*336px/, 'the ADR box no longer caps at the measured 336px');
  assert.match(rule, /overflow-y:\s*auto/, 'the ADR box does not scroll, so a capped height would clip the rows');

  // A row is a two-column grid, and the line holding the title has to be ONE of those two
  // items. `display: contents` flattens it into the row's grid, so a title line with a second
  // child - the `no H1` label, which one record in forty carries - overflows into the next
  // implicit row and lands under the number gutter. There is no layout in this suite to catch
  // that, so what is asserted is the decision: found in a browser, recorded here.
  const line = /#domain-panel \.dom-line \{[^}]*\}/.exec(CSS)?.[0] ?? '';
  assert.ok(line !== '', 'the title line has no rule of its own');
  assert.ok(!/display:\s*contents/.test(line), 'the title line is flattened into the row grid again');
  assert.match(line, /grid-column:\s*2/, 'the title line does not claim the column beside the number');
});

test('the panel stylesheet is substantial, and its scope is checked by the real parser', () => {
  // **Scope is `board-ui.test.ts`'s job, not this file's.** That file parses the stylesheet
  // properly — comments, strings, nesting, escapes, at-rule bodies — and applies the same rule
  // to all three panels. A line-oriented scanner would be a weaker second copy: a selector list
  // split across two lines, `body,\n#domain-panel .x { }`, can pass it while styling `body`. A
  // guard that can be walked around is worse than no guard, because it reads like cover.
  //
  // What is left here is the thing that file cannot say — that this stylesheet actually
  // contains the rules the panel depends on, so the guard over there is guarding something
  // rather than passing over a file somebody emptied.
  assert.ok(CSS.includes('#domain-panel'), 'the panel stylesheet no longer scopes anything');
  const rules = [...CSS.matchAll(/#domain-panel[^{]*\{/g)].length;
  assert.ok(rules >= 20, `only ${String(rules)} scoped rules remain; the stylesheet has been gutted`);
  for (const needed of ['.dom-list', '.dom-adr', '.dom-line', '.dom-num', '.dom-failed', '.dom-dialog']) {
    assert.ok(CSS.includes(`#domain-panel ${needed}`), `${needed} has no rule, so its layout is unstyled`);
  }

  // The at-rule denylist is a courtesy duplicate; `board-ui.test.ts` holds the closed
  // allow-list that refuses anything it has not been taught about.
  assert.ok(
    !/@(import|font-face|keyframes|property|layer|counter-style|page|namespace|charset)/i.test(CSS),
    'the panel registers a document-global name, which reaches the board and the other two panels',
  );
});
