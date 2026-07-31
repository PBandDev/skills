/**
 * The Digest panel, and the as-of marker that says how far the AI layer can be trusted.
 *
 * ## The canary rule, and why this file needs it more than most
 *
 * Nearly everything this panel is specified to do is a *drawn absence*. A Feature with no prose
 * renders no Digest. A `never-written` as-of state renders a sentence and no sheet. A Snapshot
 * with no Features renders nothing at all. Every one of those is exactly what a total collapse of
 * the render produces for free, because "the rule ran and correctly degraded" is otherwise
 * indistinguishable from "the pass threw and nothing ran".
 *
 * So every test below that asserts an absence also asserts, in the same render, something only a
 * completed pass can produce: a Digest that came out in full, with its Blocks in order and its
 * paths on buttons. If the pass did not finish, the promotion is lost and the test dies.
 *
 * ## Where the Snapshots come from
 *
 * Most of them come through `deriveSnapshot` with a hand-built `Scan` and a hand-built store,
 * which is what the board really renders: the Digests below are validated by the same seam that
 * validates a real one, so a fixture that would be refused on disk is refused here too rather
 * than quietly rendering. The Annotation key is read off a Snapshot rather than rebuilt by hand,
 * because duplicating the key construction in a test can make the same defect appear correct on
 * both sides of the assertion.
 *
 * Two tests build a `Snapshot` literal instead, and both say why: a count only reaches the panel
 * from a Feature whose Digest expired against a stored member list, and standing one of those up
 * per case would make these tests about the seam that derives the count rather than about the
 * sentence that prints it. `annotations.test.ts` owns the deriving.
 *
 * ## Scope
 *
 * This file asks what a fake DOM can answer honestly: which nodes a completed pass built, what
 * text they carry, in what order, and which of them survived the next pass. Anything decided by
 * the cascade - whether the fog rule really reads as dashed, whether a struck-through line is
 * legible - is a browser question and was driven in one; what is asserted here is that the
 * declarations exist and differ, which is the part an edit would undo silently.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { deriveSnapshot } from '../core/index.ts';
import type {
  AnnotationStore,
  FeatureSnapshot,
  Root,
  Scan,
  Snapshot,
} from '../core/types.ts';
import { renderDigest } from '../ui/digest.js';
import { EMPTY_ANNOTATIONS } from './harness.ts';
import { FakeDocument, FakeElement, descendants } from './dom.ts';

const UI_DIR = join(import.meta.dirname, '..', 'ui');
const ROOT = '/repo-a';

const CSS = readFileSync(join(UI_DIR, 'digest.css'), 'utf8');
const JS = readFileSync(join(UI_DIR, 'digest.js'), 'utf8');
const HTML = readFileSync(join(UI_DIR, 'index.html'), 'utf8');

/** The seven tones, spelled here rather than imported, so a rename has to be deliberate. */
const TONES = [
  'note',
  'risk',
  'decision',
  'question',
  'correction',
  'fog',
  'out-of-scope',
] as const;

// ---------------------------------------------------------------------------
// The harness, before anything trusts it
// ---------------------------------------------------------------------------

test('the fake DOM answers every selector form this panel is checked with', () => {
  // A fake DOM fails dangerously in one direction: a selector form it does not implement makes
  // every assertion about an absent node pass forever. These are the exact forms used below.
  const doc = panelDocument();
  const mount = mountOf(doc);
  const item = doc.createElement('details');
  item.className = 'dg-item';
  item.setAttribute('data-feature', '7#/repo-a#alpha');
  item.setAttribute('data-as-of', 'current');
  const block = doc.createElement('section');
  block.className = 'dg-block dg-bullets';
  block.setAttribute('data-block', 'bullets');
  block.setAttribute('data-tone', 'fog');
  item.appendChild(block);
  mount.appendChild(item);

  assert.equal(mount.querySelector('.dg-item'), item, 'a class selector finds nothing');
  assert.equal(mount.querySelector('[data-feature]'), item, 'an attribute selector finds nothing');
  assert.equal(mount.querySelector('.dg-bullets'), block, 'a multi-class element is not found by one class');
  assert.equal(mount.querySelector('[data-tone]'), block);
  assert.equal(mount.querySelector('.dg-item [data-block]'), block, 'the descendant combinator finds nothing');
  assert.equal(mount.querySelector('.nosuch'), null, 'the harness answers a node for a class nothing carries');
  assert.equal(doc.getElementById('digest-panel'), mount, 'the panel mount cannot be found by id');
});

// ---------------------------------------------------------------------------
// The four Blocks
// ---------------------------------------------------------------------------

test('four Blocks render in a fixed order, whatever order they were authored in', () => {
  // The authored array pins only that `summary` comes first, so the fixed order is a rendering
  // guarantee rather than an input one. This Digest is authored summary, links, bullets, facts -
  // the three optional Blocks in reverse - and must come out summary, facts, bullets, links.
  const doc = panelDocument();
  const snapshot = boardWith({
    alpha: {
      v: 1,
      feature: 'alpha',
      blocks: [
        { kind: 'summary', text: 'Alpha is in flight.' },
        { kind: 'links', items: [{ label: 'Spec', path: 'alpha/spec.md' }] },
        { kind: 'bullets', tone: 'risk', items: ['The scan is slow.', 'The store is cold.'] },
        {
          kind: 'facts',
          items: [
            { label: 'Tickets', value: '4' },
            { label: 'Done', value: '1', state: 'done' },
          ],
        },
      ],
    },
    // The canary: a second Digest in the same pass, which a collapsed render loses.
    beta: twoBlockDigest('beta'),
  });
  draw(doc, snapshot);

  assert.deepEqual(
    blockKinds(doc, 'alpha'),
    ['summary', 'facts', 'bullets', 'links'],
    'the Blocks did not come out in the fixed order',
  );
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts'], 'the canary Digest did not render');

  // And the order is really the render's doing rather than the seam's, which would make the
  // assertion above vacuous.
  assert.deepEqual(
    authoredKinds(snapshot, 'alpha'),
    ['summary', 'links', 'bullets', 'facts'],
    'the seam already reordered the Blocks, so this test is not testing the renderer',
  );
});

test('every Block is individually omittable, and a two-Block Digest draws exactly two', () => {
  const doc = panelDocument();
  draw(
    doc,
    boardWith({
      alpha: { v: 1, feature: 'alpha', blocks: [{ kind: 'summary', text: 'Alpha.' }, { kind: 'links', items: [{ label: 'Map', path: 'alpha/map.md' }] }] },
      beta: {
        v: 1,
        feature: 'beta',
        blocks: [
          { kind: 'summary', text: 'Beta.' },
          { kind: 'facts', items: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }] },
          { kind: 'bullets', items: ['one', 'two'] },
          { kind: 'links', items: [{ label: 'Spec', path: 'beta/spec.md' }] },
        ],
      },
    }),
  );

  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'links'], 'a Digest that omits two Blocks drew them anyway');
  // The promotion: four Blocks in the same pass. Without it, "exactly two" is also what a render
  // that fell over after the second node produces.
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts', 'bullets', 'links']);
});

test('at-cap content renders in full rather than being clipped or dropped', () => {
  // Six Blocks, the envelope maximum, with the aggregate close to its 900-character ceiling. The
  // seam accepts it - asserted, so this is a real at-cap Digest and not merely a large one - and
  // every Block of it reaches the page.
  const doc = panelDocument();
  const snapshot = boardWith({ alpha: atCapDigest(), beta: twoBlockDigest('beta') });

  assert.equal(featureOf(snapshot, 'alpha').digest.kind, 'current', 'the at-cap Digest was refused by the seam');
  assert.equal(snapshot.rejections.length, 0, 'the at-cap Digest was accepted but something else was refused');
  // And it really is at the cap rather than merely large: three more characters per bullet is
  // over the aggregate ceiling and the same Digest is refused.
  assert.equal(
    featureOf(boardWith({ alpha: atCapDigest(3) }), 'alpha').digest.kind,
    'never-written',
    'a wider version of this Digest is still accepted, so the fixture is nowhere near the cap',
  );

  draw(doc, snapshot);
  assert.deepEqual(blockKinds(doc, 'alpha'), [
    'summary',
    'facts',
    'bullets',
    'bullets',
    'bullets',
    'links',
  ]);
  assert.equal(itemOf(doc, 'alpha').querySelectorAll('.dg-bitem').length, 9, 'bullet items were dropped');
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts'], 'the canary Digest did not render');
});

// ---------------------------------------------------------------------------
// The three as-of states
// ---------------------------------------------------------------------------

test('a Feature with no prose renders no Digest, and no empty panel either', () => {
  const doc = panelDocument();
  draw(doc, boardWith({ alpha: twoBlockDigest('alpha') }, ['beta']));

  const bare = itemOf(doc, 'beta');
  assert.equal(bare.getAttribute('data-as-of'), 'never-written');
  assert.equal(bare.querySelector('.dg-sheet'), null, 'a Feature with no Digest was given an empty sheet');
  assert.equal(bare.querySelectorAll('[data-block]').length, 0, 'a Feature with no Digest was given Blocks');
  assert.equal(bare.tagName.toLowerCase(), 'div', 'a Feature with nothing to disclose was made a disclosure');
  // And it is not silent. Rendering it as nothing is the failure this state exists to prevent.
  assert.match(bare.textContent, /none has ever been written/i, 'a Feature with no Digest says nothing at all');

  // The promotion: the Feature that does have one rendered in full in the same pass.
  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts']);
});

test('expired and never-written are told apart on every channel, not just by absence', () => {
  const doc = panelDocument();
  draw(doc, boardWith({ alpha: twoBlockDigest('alpha') }, ['gamma'], { beta: twoBlockDigest('beta') }));

  const expired = itemOf(doc, 'beta');
  const never = itemOf(doc, 'gamma');

  assert.equal(expired.getAttribute('data-as-of'), 'expired');
  assert.equal(never.getAttribute('data-as-of'), 'never-written');
  assert.notEqual(
    textOf(expired, '.dg-glyph'),
    textOf(never, '.dg-glyph'),
    'expired and never-written carry the same glyph, so they are told apart by colour alone',
  );
  assert.notEqual(
    textOf(expired, '.dg-asof'),
    textOf(never, '.dg-asof'),
    'expired and never-written say the same thing',
  );
  assert.notEqual(textOf(expired, '.dg-asof'), '', 'the expired marker is empty');
  assert.notEqual(textOf(never, '.dg-asof'), '', 'the never-written marker is empty');
  assert.match(textOf(expired, '.dg-asof'), /has since changed/i);

  // Neither is drawn as nothing, and the third state still drew its sheet in the same pass.
  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts']);
});

test('the as-of marker is a content fact: it names the hash and never formats a clock', () => {
  const doc = panelDocument();
  const snapshot = boardWith({ alpha: twoBlockDigest('alpha') }, ['gamma'], { beta: twoBlockDigest('beta') });
  draw(doc, snapshot);

  // The claim is about content, so the key the comparison actually turns on is on screen - and
  // it is shown as the PREFIX it is. A bare eight-character stem is 32 bits presented as though
  // it were the key: two Features whose hashes share a stem would carry identical-looking as-of
  // markers. The ellipsis makes the prefix explicit, and the length is asserted so it cannot
  // quietly shorten again.
  for (const name of ['alpha', 'beta', 'gamma']) {
    const shown = textOf(itemOf(doc, name), '.dg-sha');
    const sha = featureOf(snapshot, name).contentSha;
    const match = /^content ([0-9a-f]{12})\u2026$/.exec(shown);
    assert.ok(match !== null, `${name} does not show a content-hash prefix: ${shown}`);
    assert.ok(
      sha.startsWith(match[1] ?? ''),
      `${name} shows a hash that is not a prefix of its own contentSha, so the marker is keyed on nothing`,
    );
  }
  // Two Features whose hashes agree over the first eight characters must still read differently,
  // which is the property the twelve-plus-ellipsis form exists to hold.
  const nearly = panelDocument();
  const stem = 'deadbeef';
  draw(nearly, {
    roots: [
      {
        path: '/r',
        features: [
          { name: 'a', path: 'a', contentSha: `${stem}${'0'.repeat(56)}`, digest: { kind: 'never-written' } },
          { name: 'b', path: 'b', contentSha: `${stem}${'f'.repeat(56)}`, digest: { kind: 'never-written' } },
        ],
      },
    ],
  } as never);
  assert.notEqual(
    textOf(itemOf(nearly, 'a'), '.dg-sha'),
    textOf(itemOf(nearly, 'b'), '.dg-sha'),
    'two different content hashes present the same as-of marker',
  );

  // "written 4 hours ago" is a different claim from "written against content that has changed",
  // and it is a misleading one when nothing moved in those four hours.
  //
  // Asserted as the OUTPUT, exhaustively, rather than by forbidding clock APIs in the source. A
  // source scan is only as good as the spellings it lists: `new globalThis.Date().toISOString()`
  // matches none of them and produces a string containing
  // none of the forbidden words either. Pinning the sentence to a closed set of grammars closes
  // the whole class - anything a clock could add has to appear here first.
  const permitted: readonly RegExp[] = [
    /^Current \u2014 written against the content now on disk\.$/,
    /^Expired \u2014 written against content that has since changed\. How many files moved is not recorded yet\.$/,
    /^Expired \u2014 \d+ files? changed since it was written\.$/,
    /^No Digest \u2014 none has ever been written for this Feature\.$/,
    /^Unreadable \u2014 this frame records a Digest for this Feature and does not carry one that can be read, so its as-of state is not known\.$/,
  ];
  const seen = new Set<string>();
  for (const doc2 of [doc, nearly, panelDocument()]) {
    if (doc2 !== doc && doc2 !== nearly) draw(doc2, expiredBoard(3));
    for (const row of mountOf(doc2).querySelectorAll('[data-feature]')) {
      const sentence = row.querySelector('.dg-asof')?.textContent ?? '';
      assert.ok(
        permitted.some((shape) => shape.test(sentence)),
        `an as-of marker outside the permitted grammar reached the page: ${sentence}`,
      );
      seen.add(sentence.split(' \u2014 ')[0] ?? '');
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ['Current', 'Expired', 'No Digest'],
    'the sweep did not reach all three as-of states, so the grammar was barely exercised',
  );

  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], 'the canary Digest did not render');
});

test('an expired Digest takes a file count when there is one and degrades honestly when there is not', () => {
  // Reached from a `Snapshot` literal, so the two branches sit side by side in one test and the
  // sentence is what is under examination rather than the derivation behind the number. The seam
  // that derives it is asserted in `annotations.test.ts`.
  const doc = panelDocument();
  draw(doc, expiredBoard(3));
  assert.equal(
    textOf(itemOf(doc, 'alpha'), '.dg-asof'),
    'Expired \u2014 3 files changed since it was written.',
  );
  assert.deepEqual(blockKinds(doc, 'current'), ['summary'], 'the canary Digest did not render');

  const one = panelDocument();
  draw(one, expiredBoard(1));
  assert.match(textOf(itemOf(one, 'alpha'), '.dg-asof'), /1 file changed/, 'the count is not singular at one');

  // No count: truthful, count-free, and still not the never-written sentence.
  const unknown = panelDocument();
  draw(unknown, expiredBoard(null));
  const degraded = textOf(itemOf(unknown, 'alpha'), '.dg-asof');
  assert.match(degraded, /Expired/);
  assert.match(degraded, /has since changed/i);
  assert.ok(!/\d/.test(degraded), `the degraded wording invented a number: ${degraded}`);
  assert.ok(!/none has ever been written/i.test(degraded), 'expired degraded into the never-written wording');
  assert.deepEqual(blockKinds(unknown, 'current'), ['summary'], 'the canary Digest did not render');

  // A zero is a broken count rather than a fact - an expired Digest is expired BECAUSE content
  // moved - so it degrades rather than printing the one confidently wrong number available here.
  const zero = panelDocument();
  draw(zero, expiredBoard(0));
  const zeroText = textOf(itemOf(zero, 'alpha'), '.dg-asof');
  assert.ok(!/0 files? changed/.test(zeroText), `the panel printed "0 files changed": ${zeroText}`);
  assert.equal(zeroText, degraded, 'a zero count did not degrade to the count-free wording');

  // A fraction is not a count either. Rounding 2.7 files down to 2 invents a number out of a
  // value that is not one, which is the same fabrication as printing a zero.
  for (const notACount of [2.7, Number.NaN, Infinity, -3, Number.MAX_SAFE_INTEGER + 2]) {
    const odd = panelDocument();
    draw(odd, expiredBoard(notACount));
    assert.equal(
      textOf(itemOf(odd, 'alpha'), '.dg-asof'),
      degraded,
      `${String(notACount)} was turned into a file count instead of degrading`,
    );
    assert.deepEqual(blockKinds(odd, 'current'), ['summary'], 'the canary Digest did not render');
  }
});

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

test('fog and out-of-scope are distinguishable without reading the label', () => {
  // They mean OPPOSITE things - not-yet-specified against ruled-out - and this is the one artifact
  // where the distinction is the deliverable. Colour alone is not enough: on this board nothing
  // rides on colour alone, and the two adjacent violets elsewhere each carry a distinct glyph and
  // a spelled-out key.
  const doc = panelDocument();
  draw(doc, toneBoard());

  const fog = toneBlock(doc, 'fog');
  const ruled = toneBlock(doc, 'out-of-scope');

  // Channel one: the glyph.
  const fogGlyph = textOf(fog, '.dg-tglyph');
  const ruledGlyph = textOf(ruled, '.dg-tglyph');
  assert.notEqual(fogGlyph, ruledGlyph, 'fog and out-of-scope carry the same glyph');
  assert.notEqual(fogGlyph, '', 'the fog block carries no glyph at all');
  assert.notEqual(ruledGlyph, '', 'the out-of-scope block carries no glyph at all');

  // Channel two: the spelled-out key, and the gloss that says which way round they are.
  assert.match(textOf(fog, '.dg-tone'), /not yet specified/i, 'the fog label does not say what fog means');
  assert.match(textOf(ruled, '.dg-tone'), /ruled out/i, 'the out-of-scope label does not say what it means');

  // Channel three: the rule style. Dashed where the edge is open, solid where it is closed - a
  // channel that survives a greyscale print and a colour-blind reader.
  assert.match(
    ruleFor('fog'),
    /border-left-style:\s*dashed/,
    'fog does not take a dashed rule, so it differs from out-of-scope only by hue and glyph',
  );
  assert.match(ruleFor('out-of-scope'), /border-left-style:\s*solid/, 'out-of-scope does not take a solid rule');

  // Channel four, and the strongest: ruled-out prose is struck through and not-yet-specified
  // prose is not. This is what makes the pair unreadable backwards from across the room.
  assert.match(
    ruleFor('out-of-scope', '.dg-bitem'),
    /text-decoration-line:\s*line-through/,
    'out-of-scope items are not struck through, so ruled-out prose reads as ordinary prose',
  );
  assert.equal(ruleFor('fog', '.dg-bitem'), '', 'fog items are struck through, which asserts they were ruled out');

  // And the hues really are different, so the fourth channel is not carrying the whole load.
  assert.notEqual(colourFor('fog'), colourFor('out-of-scope'), 'fog and out-of-scope share one colour');

  assert.deepEqual(blockKinds(doc, 'canary'), ['summary', 'facts'], 'the canary Digest did not render');
});

test('all seven tones are distinct in the document and in the stylesheet', () => {
  const doc = panelDocument();
  draw(doc, toneBoard());

  const glyphs = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const tone of TONES) {
    const block = toneBlock(doc, tone);
    const glyph = textOf(block, '.dg-tglyph');
    const label = textOf(block, '.dg-tone');
    assert.notEqual(glyph, '', `tone ${tone} renders no glyph`);
    assert.notEqual(label, '', `tone ${tone} renders no spelled-out key`);
    for (const [other, seen] of glyphs) {
      assert.notEqual(glyph, seen, `tones ${tone} and ${other} share the glyph ${glyph}`);
    }
    for (const [other, seen] of labels) {
      assert.notEqual(label, seen, `tones ${tone} and ${other} share the label ${label}`);
    }
    glyphs.set(tone, glyph);
    labels.set(tone, label);

    // Each tone has a rule of its own, so none of them falls back to an unmarked default.
    assert.notEqual(ruleFor(tone), '', `tone ${tone} has no rule in ui/digest.css`);
  }
  assert.equal(glyphs.size, TONES.length, 'not every tone reached the page');

  // The five ordinary tones take five different hues, so the vocabulary reads as a vocabulary.
  const hues = new Set(TONES.map((tone) => colourFor(tone)));
  assert.equal(hues.size, TONES.length, `the seven tones use only ${String(hues.size)} colours`);

  assert.deepEqual(blockKinds(doc, 'canary'), ['summary', 'facts'], 'the canary Digest did not render');
});

test('a bullets Block with no tone is drawn plainly rather than given one', () => {
  const doc = panelDocument();
  draw(
    doc,
    boardWith({
      alpha: {
        v: 1,
        feature: 'alpha',
        blocks: [
          { kind: 'summary', text: 'Alpha.' },
          { kind: 'bullets', title: 'Notes', items: ['one', 'two'] },
        ],
      },
      beta: twoBlockDigest('beta'),
    }),
  );

  const block = itemOf(doc, 'alpha').querySelector('.dg-bullets');
  assert.ok(block !== null, 'the untoned bullets Block did not render');
  assert.equal(block.getAttribute('data-tone'), null, 'an untoned Block was assigned a tone');
  assert.equal(block.querySelector('.dg-tglyph'), null, 'an untoned Block was given a tone glyph');
  // The title still renders, and the items with it - so this is not passing on a Block that
  // failed to draw at all.
  assert.equal(textOf(block, '.dg-btitle'), 'Notes');
  assert.equal(block.querySelectorAll('.dg-bitem').length, 2);
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts'], 'the canary Digest did not render');
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test('a links path is a copy button, never a navigation', () => {
  const doc = panelDocument();
  draw(
    doc,
    boardWith({
      alpha: {
        v: 1,
        feature: 'alpha',
        blocks: [
          { kind: 'summary', text: 'Alpha.' },
          {
            kind: 'links',
            items: [
              { label: 'Spec', path: 'alpha/spec.md' },
              { label: 'Map', path: 'alpha/map.md' },
            ],
          },
        ],
      },
      beta: twoBlockDigest('beta'),
    }),
  );

  const buttons = itemOf(doc, 'alpha').querySelectorAll('.dg-lpath');
  assert.equal(buttons.length, 2, 'the links Block did not draw its paths');
  for (const [index, path] of ['alpha/spec.md', 'alpha/map.md'].entries()) {
    const button = buttons[index];
    assert.ok(button !== undefined);
    assert.equal(button.tagName.toLowerCase(), 'button', 'a path is not a button');
    assert.equal(button.type, 'button', 'a path button would submit a form');
    // `data-copy` is what the one delegated listener in board.js answers. Rebuilding the copy
    // here would get the silent version: `navigator.clipboard.writeText` never settles on this
    // platform when the page is not frontmost, and the shipped handler races it against a
    // timeout and degrades to a visible "not confirmed" with the path selectable.
    assert.equal(button.getAttribute('data-copy'), path, 'the path does not reach the clipboard handler');
    assert.equal(button.getAttribute('aria-label'), `Copy path ${path}`, 'the button is unlabelled for a screen reader');
    assert.ok(button.className.split(/\s+/).includes('copy'), 'the button does not take the board copy treatment');
    assert.equal(button.textContent, path, 'the path is not shown, so it cannot be selected by hand either');
  }

  // Nothing anywhere in the panel is a link. A file-scheme link from a page served over HTTP is
  // one a browser refuses to follow, so the whole element is absent rather than merely unused.
  for (const node of descendants(mountOf(doc))) {
    assert.notEqual(node.tagName.toLowerCase(), 'a', 'the panel built an anchor');
  }
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts'], 'the canary Digest did not render');
});

// ---------------------------------------------------------------------------
// The Digest counts, and the rejection count
// ---------------------------------------------------------------------------

test('one Digest header carries the four counts without repeating the board-level claim', () => {
  // The four counts are deliberately four DIFFERENT numbers, and that is asserted rather than
  // arranged and forgotten. If current and expired were equal, swapping the two could print the
  // same sentence and leave the mistake invisible.
  const doc = panelDocument();
  const snapshot = boardWith(
    { alpha: twoBlockDigest('alpha'), epsilon: twoBlockDigest('epsilon'), zeta: twoBlockDigest('zeta') },
    ['gamma', 'delta', 'theta', 'iota'],
    { beta: twoBlockDigest('beta'), eta: twoBlockDigest('eta') },
    ['gamma'],
  );
  draw(doc, snapshot);

  const lines = mountOf(doc).querySelectorAll('.dg-liveness');
  assert.equal(lines.length, 1, `the Digest count line is drawn ${String(lines.length)} times, not once`);
  const line = lines[0]?.textContent ?? '';

  assert.ok(!/live to the file system/i.test(line), 'the board-level cards claim is repeated in the Digest panel');
  assert.ok(!/as-of content/i.test(line), 'the board-level AI claim is repeated in the Digest panel');
  assert.ok(!/as-of a clock/i.test(line), 'the board-level clock clarification is repeated in the Digest panel');

  const live = snapshot.liveness;
  const counts = [live.digestsCurrent, live.digestsExpired, live.digestsNeverWritten, live.overridesPendingRecheck];
  assert.deepEqual(counts, [3, 2, 4, 1], 'the fixture is not the board this test believes it is');
  assert.equal(
    new Set(counts).size,
    4,
    'two of the four counts are equal, so a line that swapped them would read identically and ' +
      'every assertion below would pass on the wrong number',
  );

  assert.match(line, /3 Digests current/, 'the current count is missing or wrong');
  assert.match(line, /2 expired/, 'the expired count is missing or wrong');
  assert.match(line, /4 never written/, 'the never-written count is missing or wrong');
  assert.match(line, /1 Override pending re-check/i, 'the Overrides-pending-re-check count is missing or wrong');

  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], 'the canary Digest did not render');
});

test('a rejected Digest is counted and named, and its refused text is never echoed', () => {
  // The overage is what a writer needs; the value is what a writer already has. A Digest is
  // model-authored prose about somebody's private repository and rejections render on the board,
  // so the message names the field and the size and nothing else.
  const secret = `Q${'x'.repeat(220)}Z`;
  const doc = panelDocument();
  const snapshot = boardWith({
    alpha: { v: 1, feature: 'alpha', blocks: [{ kind: 'summary', text: secret }, { kind: 'bullets', items: ['a', 'b'] }] },
    beta: twoBlockDigest('beta'),
  });
  draw(doc, snapshot);

  assert.ok(snapshot.rejections.length > 0, 'the seam accepted an over-long summary, so nothing was rejected');

  const panel = mountOf(doc).querySelector('.dg-rejected');
  assert.ok(panel !== null, 'there is no place for a rejection to surface');
  assert.equal(panel.hidden, false, 'a rejection was refused and then hidden');
  assert.match(panel.textContent, /1 Digest refused/, 'the rejection count is missing');

  const rows = panel.querySelectorAll('.dg-rej');
  assert.equal(rows.length, 1, `${String(rows.length)} rejection rows for one rejection`);
  const row = rows[0]?.textContent ?? '';
  assert.match(row, /summary/, 'the rejection does not name the field that was refused');
  assert.match(row, /\d+ > \d+ chars/, 'the rejection does not name the overage, so it cannot be self-corrected');

  // The value itself is nowhere on the page, in whole or in part.
  const rendered = mountOf(doc).textContent;
  assert.ok(!rendered.includes(secret), 'the refused text was echoed back onto the board');
  assert.ok(!rendered.includes('xxxxxxxxxx'), 'part of the refused text was echoed back onto the board');

  // `Rejection.path` is the Root-qualified key and begins with an absolute Root path. Every digest
  // rejection the seam emits names its Feature, so the path is never needed to locate one - and a
  // frame that did not come from this seam must not be able to put an absolute path on the page
  // through this block.
  const nameless = panelDocument();
  const privateRoot = ['C', ':', '/', 'private', '/', 'repo'].join('');
  draw(nameless, {
    rejections: [{ kind: 'digest', feature: null, path: `${privateRoot}#alpha`, field: 'summary', message: '240 > 200 chars' }],
    roots: [{ path: '/r', features: [{ name: 'good', path: 'good', contentSha: 'cd', digest: { kind: 'current', digest: twoBlockDigest('good') } }] }],
  } as never);
  const shown = mountOf(nameless).textContent;
  assert.match(shown, /240 > 200 chars/, 'the rejection did not surface at all, so its silence proves nothing');
  assert.ok(!shown.includes(privateRoot), 'a rejection with no Feature put its absolute path on the page');
  assert.deepEqual(blockKinds(nameless, 'good'), ['summary', 'facts'], 'the canary Digest did not render');

  // A refused Digest renders as no Digest, and the Feature beside it still rendered in full.
  assert.equal(itemOf(doc, 'alpha').getAttribute('data-as-of'), 'never-written');
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts'], 'the canary Digest did not render');

  // And the block goes away again when the rejection does, rather than staying visible and empty.
  draw(doc, boardWith({ alpha: twoBlockDigest('alpha'), beta: twoBlockDigest('beta') }));
  const after = mountOf(doc).querySelector('.dg-rejected');
  assert.ok(after !== null);
  assert.equal(after.hidden, true, 'the rejection block stayed visible after the rejection cleared');
  assert.equal(after.querySelectorAll('.dg-rej').length, 0, 'a cleared rejection block still holds rows');
  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], 'the promoted Digest did not render');
});

// ---------------------------------------------------------------------------
// The panel's boundaries
// ---------------------------------------------------------------------------

test('two different Features never pool onto one row, whatever their paths spell', () => {
  // The pool key decides which row a Feature updates, so two Features landing on one key means
  // the second silently overwrites the first: one Digest drawn under another Feature's name, and
  // the other Feature gone from the board. The key has to be INJECTIVE, and that is asserted as
  // the property rather than as one example - the examples below are three separate ways a
  // concatenation stops being injective, and two of them were live defects:
  //
  //   1. `<root>#<path>`      `/a` + `b#c` and `/a#b` + `c` are the same string. A Root path may
  //                           contain `#` on both platforms this runs on. MEASURED: two Features
  //                           drew a single row between them.
  //   2. `<len>#<root>#<path||name>`  fixes (1) and reopens it one level down, INSIDE one Root:
  //                           a Feature with no path called `x` collides with a Feature whose
  //                           path is `x`.
  //   3. adjacent components  `a` + `bc` against `ab` + `c` in any unprefixed pair.
  //
  // The seam never emits an empty Feature path, so (2) needs a malformed frame - which is exactly
  // what this module is handed: `JSON.parse` output off a socket, not the seam's guarantee.
  const triples: readonly (readonly [string, string, string])[] = [
    ['/a', 'b#c', 'one'],
    ['/a#b', 'c', 'two'],
    ['/a', '', 'x'],
    ['/a', 'x', 'other'],
    ['/a', 'x', 'x'],
    ['/ab', 'c', 'three'],
    ['/a', 'bc', 'four'],
    ['/a', '1#/a#1#x#y', 'five'],
    ['/a', '', ''],
    ['', '', 'six'],
  ];

  const doc = panelDocument();
  draw(doc, {
    roots: triples.map(([root, path, name]) => ({
      path: root,
      label: root,
      features: [{ name, path, contentSha: 'ab', digest: { kind: 'never-written' } }],
    })),
  } as never);

  const keys = mountOf(doc)
    .querySelectorAll('[data-feature]')
    .map((node) => node.getAttribute('data-feature') ?? '');
  assert.equal(
    keys.length,
    triples.length,
    `${String(triples.length)} Features collapsed onto ${String(keys.length)} rows`,
  );
  assert.equal(new Set(keys).size, triples.length, `two Features share one key:\n${keys.join('\n')}`);

  // Two Features in the SAME Root, which is where the second collision lived - the case above
  // spreads them over separate Roots, and a per-Root list is not what the panel pools by.
  const inOneRoot = panelDocument();
  draw(inOneRoot, {
    roots: [
      {
        path: '/a',
        label: '/a',
        features: [
          { name: 'x', path: '', contentSha: 'aa', digest: { kind: 'never-written' } },
          { name: 'other', path: 'x', contentSha: 'bb', digest: { kind: 'current', digest: twoBlockDigest('other') } },
        ],
      },
    ],
  } as never);
  const both = mountOf(inOneRoot).querySelectorAll('[data-feature]');
  assert.equal(both.length, 2, 'two Features in one Root collapsed onto one row');
  assert.equal(
    new Set(both.map((node) => node.getAttribute('data-feature'))).size,
    2,
    'two Features in one Root share a key',
  );
  // The promotion: the surviving pass really drew the second Feature's Digest, so this is not
  // passing on two rows that both failed to render.
  assert.deepEqual(blockKinds(inOneRoot, 'other'), ['summary', 'facts'], 'the second Feature drew no Digest');

  // And the key still carries the Root, so two Roots holding a Feature of the same name never
  // merge - the reason the key is Root-qualified at all.
  for (const key of keys) assert.match(key, /^\d+#/, `the key ${key} carries no length prefix`);
});

test('the panel writes inside its own mount and nowhere else', () => {
  // Cards carry no liveness marker: they are live by definition, and marking them would imply
  // the marker meant something. The strongest form of that is that this module cannot reach a
  // card at all - it is handed the whole document and touches one node in it.
  const doc = panelDocument();
  const board = doc.createElement('main');
  board.id = 'board';
  const card = doc.createElement('article');
  card.setAttribute('data-card', 'alpha/issues/01-a.md');
  board.appendChild(card);
  doc.root.appendChild(board);

  draw(doc, boardWith({ alpha: twoBlockDigest('alpha') }));

  assert.equal(board.childNodes.length, 1, 'the panel added a node to the board');
  assert.equal(card.childNodes.length, 0, 'the panel wrote into a card');
  assert.deepEqual([...card.attributes.keys()], ['data-card'], 'the panel marked a card');
  // The promotion: it did draw, somewhere. Otherwise "it touched nothing" is what a module that
  // returned immediately also produces.
  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], 'the panel drew nothing at all');
});

test('a Snapshot with no Features renders nothing, and clears what a previous frame drew', () => {
  const doc = panelDocument();
  draw(doc, boardWith({ alpha: twoBlockDigest('alpha') }));
  // The promotion, taken first: this is a mount that really had content in it.
  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], 'nothing was drawn to clear');

  draw(doc, deriveSnapshot({ roots: [] }, EMPTY_ANNOTATIONS));
  assert.equal(mountOf(doc).childNodes.length, 0, 'an empty board left the panel on the page');

  // And it comes back, so "renders nothing" is a state rather than a one-way door.
  draw(doc, boardWith({ alpha: twoBlockDigest('alpha') }));
  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], 'the panel never recovered');
});

test('the panel is one disclosure group, opening one sheet at a time, and only where there is one', () => {
  const doc = panelDocument();
  draw(doc, boardWith({ alpha: twoBlockDigest('alpha') }, ['gamma'], { beta: twoBlockDigest('beta') }));

  const alpha = itemOf(doc, 'alpha');
  assert.equal(alpha.tagName.toLowerCase(), 'details', 'a Digest is not a disclosure');
  assert.equal(alpha.querySelector('.dg-line')?.tagName.toLowerCase(), 'summary', 'the disclosure has no summary');
  // A shared `name` makes `<details>` an exclusive accordion in the browser itself, which is what
  // keeps "one panel open at a time" out of a click handler this module would otherwise have to
  // install on every render.
  const group = alpha.getAttribute('name');
  assert.ok(group !== null && group !== '', 'the disclosure is in no group, so two sheets can be open at once');

  // Every Feature that has a Digest is in the SAME group. Two groups is two open sheets.
  const named = mountOf(doc).querySelectorAll('[data-feature]').filter((node) => node.hasAttribute('name'));
  assert.equal(named.length, 1, 'the wrong number of Features are disclosures');
  for (const node of named) assert.equal(node.getAttribute('name'), group);

  // And a Feature with nothing behind it is not a control at all: a disclosure that opens onto an
  // empty sheet would invent a panel with no content.
  for (const key of ['beta', 'gamma']) {
    const item = itemOf(doc, key);
    assert.equal(item.tagName.toLowerCase(), 'div', `${key} was made a disclosure with nothing behind it`);
    assert.equal(item.getAttribute('name'), null, `${key} joined the disclosure group without a sheet`);
  }
  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], 'the canary Digest did not render');
});

test('the panel sits below the rail, full width, and constrains only its own prose', () => {
  // Placement is a fact about the shipped document, and the mount was pre-wired: this asserts it
  // has not moved out from under the panel that renders into it.
  const legend = HTML.indexOf('id="legend"');
  const mount = HTML.indexOf('id="digest-panel"');
  assert.ok(legend > 0 && mount > 0, 'the rail or the mount is gone from the document');
  assert.ok(mount > legend, 'the Digest panel no longer sits below the rail');

  // Full width: the panel sets no width of its own. A five-Block Digest is roughly 1100px tall at
  // 16px against a 254px card tile, and narrowing the panel only puts that height back.
  const own = ruleText(CSS, '#digest-panel');
  assert.notEqual(own, '', 'the panel has no rule of its own at all, so this is checking nothing');
  assert.ok(!/(^|[^-])max-width:/.test(own), `the panel caps its own width: ${own}`);
  assert.ok(!/(^|[^-\w])width:/.test(own), `the panel sets its own width: ${own}`);

  // Prose inside it is still measured, which is a different thing from narrowing the panel.
  assert.match(ruleText(CSS, '#digest-panel .dg-summary'), /max-width:\s*\d+ch/, 'the summary runs the full width of a wide screen');
});

// ---------------------------------------------------------------------------
// Running on every frame
// ---------------------------------------------------------------------------

test('an unchanged Feature is not rebuilt, so an open sheet stays open under a live board', () => {
  // `renderDigest` is called from `draw()` on every board render - several times a minute on a
  // live board, and once per file change while an agent works in a watched repo. A panel that
  // rebuilds its subtree every frame closes an open sheet, drops focus and jumps a scrolled list,
  // and none of that is visible to a single-render test.
  const doc = panelDocument();
  const first = boardWith({ alpha: twoBlockDigest('alpha'), beta: twoBlockDigest('beta') });
  draw(doc, first);

  const alpha = itemOf(doc, 'alpha');
  const alphaSheet = alpha.querySelector('.dg-sheet');
  const beta = itemOf(doc, 'beta');
  assert.ok(alphaSheet !== null);
  // The browser records the open state on the element itself, so surviving as the same element is
  // exactly what keeps a sheet open.
  alpha.setAttribute('open', '');
  // The Block nodes are what a reader is actually looking at, and they are the identity a
  // signature skip protects: keeping the sheet while replacing everything in it still throws away
  // focus and scroll position inside it, and `replaceChildren` on an unchanged sheet is the
  // ordinary way that happens.
  const alphaBlocks = alphaSheet.querySelectorAll('[data-block]');
  assert.equal(alphaBlocks.length, 2, 'the sheet drew no Blocks, so their survival proves nothing');

  draw(doc, first);
  assert.equal(itemOf(doc, 'alpha'), alpha, 'an unchanged Feature was rebuilt');
  assert.equal(itemOf(doc, 'alpha').querySelector('.dg-sheet'), alphaSheet, 'an unchanged sheet was rebuilt');
  sameNodes(
    alphaSheet.querySelectorAll('[data-block]'),
    alphaBlocks,
    'an unchanged sheet had every Block inside it replaced, which loses focus and scroll position',
  );
  assert.equal(itemOf(doc, 'alpha').getAttribute('open'), '', 'the open sheet closed under a redraw');

  // A changed Feature is redrawn, and only it. Beta's node and alpha's open state both survive.
  draw(doc, boardWith({ alpha: twoBlockDigest('alpha'), beta: threeBlockDigest('beta') }));
  assert.equal(itemOf(doc, 'beta'), beta, 'a changed Feature was rebuilt rather than updated in place');
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts', 'links'], 'the changed Feature did not redraw');
  assert.equal(itemOf(doc, 'alpha').querySelector('.dg-sheet'), alphaSheet, 'an untouched Feature was rebuilt');
  sameNodes(alphaSheet.querySelectorAll('[data-block]'), alphaBlocks, 'an untouched sheet was redrawn');
  assert.equal(itemOf(doc, 'alpha').getAttribute('open'), '', 'an untouched sheet closed');
});

test('the panel registers no listener, because one per frame is one per frame', () => {
  // Every control it draws is served by the single delegated listener `board.js` installs on the
  // document. A listener added from inside a render accumulates silently, one per frame, and the
  // symptom is an action firing N times with nothing in the source saying so.
  assert.ok(!/addEventListener/.test(JS), 'ui/digest.js registers an event listener');
  assert.ok(!/\bonclick\b|\bon[a-z]+\s*=/.test(JS), 'ui/digest.js assigns an inline handler');
});

test('a Feature that gains or loses a Digest changes element, and the list keeps its order', () => {
  const doc = panelDocument();
  draw(doc, boardWith({ beta: twoBlockDigest('beta') }, ['alpha']));
  assert.equal(itemOf(doc, 'alpha').tagName.toLowerCase(), 'div');
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts'], 'nothing rendered to begin with');

  draw(doc, boardWith({ alpha: twoBlockDigest('alpha'), beta: twoBlockDigest('beta') }));
  assert.equal(itemOf(doc, 'alpha').tagName.toLowerCase(), 'details', 'a Feature that gained a Digest kept its old element');
  assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts']);
  assert.deepEqual(
    rowNames(doc),
    ['alpha', 'beta'],
    'the Feature order changed when one of them gained a Digest',
  );

  // And back the other way, with no duplicate left behind.
  draw(doc, boardWith({ beta: twoBlockDigest('beta') }, ['alpha']));
  assert.equal(mountOf(doc).querySelectorAll('[data-feature]').length, 2, 'a stale element was left in the list');
  assert.equal(itemOf(doc, 'alpha').tagName.toLowerCase(), 'div', 'a Feature that lost its Digest kept its disclosure');
  assert.deepEqual(blockKinds(doc, 'beta'), ['summary', 'facts'], 'the canary Digest did not render');
});

test('a frame that cannot be read at all says so, and lets the panels after it run', () => {
  // `board.js` calls three panels in sequence from one `draw()`, so a throw here is three panels
  // gone and the board frozen on its last frame - not one panel degrading. Both inputs below
  // can throw before the projection is contained.
  //
  // Contained, and NOT silent. A panel that swallowed the failure would go on showing a previous
  // frame's Digests as though they were this frame's, which is the one thing the as-of marker
  // exists to stop it doing.
  const throwingRoots = {};
  Object.defineProperty(throwingRoots, 'roots', {
    get() {
      throw new Error('roots getter executed');
    },
    enumerable: true,
  });

  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const revokedBlocks = {
    roots: [
      {
        path: '/r',
        features: [{ name: 'a', path: 'a', contentSha: 'ab', digest: { kind: 'current', digest: { blocks: revoked.proxy } } }],
      },
    ],
  };

  // The Snapshot ITSELF revoked, which is a different hole from the two above and was open one
  // line higher up: the shape check ahead of the containment called `Array.isArray`, and that
  // throws on a revoked Proxy - so the guard that exists to keep the panel from taking `draw()`
  // down could itself take `draw()` down. `typeof` and `=== null` cannot be intercepted; the
  // reflective check therefore belongs inside the try.
  const revokedTop = Proxy.revocable({}, {});
  revokedTop.revoke();

  for (const [what, hostile] of [
    ['a getter that throws', throwingRoots],
    ['a revoked Proxy where a Block list belongs', revokedBlocks],
    ['a revoked Proxy as the Snapshot itself', revokedTop.proxy],
  ] as const) {
    const doc = panelDocument();
    // The promotion: a good frame first, so the mount really had Digests in it to lose.
    draw(doc, boardWith({ alpha: twoBlockDigest('alpha') }));
    assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], 'nothing was drawn before the hostile frame');

    assert.doesNotThrow(() => draw(doc, hostile as never), `the panel threw on ${what}`);

    const note = mountOf(doc).querySelector('.dg-unreadable');
    assert.ok(note !== null, `${what} left the panel silent rather than stating it could not read`);
    assert.match(note.textContent, /could not be read/i);
    // The stale Digest is gone. Showing it would be the panel asserting content it no longer has.
    assert.equal(mountOf(doc).querySelectorAll('[data-block]').length, 0, `${what} left a stale Digest on screen`);
    // And the message never quotes the error, which came from evaluating somebody else's value.
    assert.ok(!/getter executed|Proxy|revoked/i.test(mountOf(doc).textContent), `${what} echoed the error text`);

    // It recovers on the next good frame rather than staying stuck.
    draw(doc, boardWith({ alpha: twoBlockDigest('alpha') }));
    assert.equal(mountOf(doc).querySelector('.dg-unreadable'), null, `${what} left the panel stuck`);
    assert.deepEqual(blockKinds(doc, 'alpha'), ['summary', 'facts'], `${what} left the panel unable to recover`);
  }
});

test('the Digest header counts the rows it sits above, and says when the Snapshot disagrees', () => {
  // A count printed over a list has one honest value: how many things are in the list. Taking
  // these three from `snapshot.liveness` instead would let the line read "0 Digests current"
  // above three current rows on a truncated frame - a visible inconsistency turned into an
  // invisible lie. Counts attached to rendered rows must come from those rows.
  const skewed = panelDocument();
  draw(skewed, {
    liveness: { digestsCurrent: 0, digestsExpired: 0, digestsNeverWritten: 0, overridesPendingRecheck: 2 },
    roots: [
      {
        path: '/r',
        label: 'r',
        features: [
          { name: 'a', path: 'a', contentSha: 'aa', digest: { kind: 'current', digest: twoBlockDigest('a') } },
          { name: 'b', path: 'b', contentSha: 'bb', digest: { kind: 'expired', filesChanged: null } },
        ],
      },
    ],
  } as never);
  const line = mountOf(skewed).querySelector('.dg-liveness')?.textContent ?? '';
  assert.match(line, /1 Digest current/, 'the line does not count the rows it sits above');
  assert.match(line, /1 expired/);
  assert.match(line, /0 never written/);
  assert.match(line, /2 Overrides pending re-check/, 'the one count with no list to count was dropped');
  assert.match(line, /disagree with the rows below/, 'a Snapshot contradicting its own rows passed in silence');
  assert.match(line, /reports 0 current, 0 expired and 0 never written/, 'the disagreement does not say what was claimed');
  assert.deepEqual(blockKinds(skewed, 'a'), ['summary', 'facts'], 'the canary Digest did not render');

  // Absent is not zero, and a fraction is not a count. Neither may print a number nothing gave.
  const absent = panelDocument();
  draw(absent, {
    liveness: { digestsCurrent: 1, digestsExpired: 0, digestsNeverWritten: 0, overridesPendingRecheck: 2.5 },
    roots: [{ path: '/r', features: [{ name: 'a', path: 'a', contentSha: 'aa', digest: { kind: 'current', digest: twoBlockDigest('a') } }] }],
  } as never);
  const partial = mountOf(absent).querySelector('.dg-liveness')?.textContent ?? '';
  assert.match(partial, /an unrecorded number of Overrides pending re-check/, 'a fractional count was rounded into a fact');
  assert.ok(!/2 Overrides|3 Overrides|0 Overrides/.test(partial), `a count was invented: ${partial}`);
  // The Digest counts agree with the rows here, so nothing is flagged.
  assert.ok(!/disagree/.test(partial), 'a false alarm was raised on an agreeing Snapshot');

  // A Snapshot with no liveness block at all raises no alarm either: absent is not a disagreement.
  const none = panelDocument();
  draw(none, {
    roots: [{ path: '/r', features: [{ name: 'a', path: 'a', contentSha: 'aa', digest: { kind: 'current', digest: twoBlockDigest('a') } }] }],
  } as never);
  const bare = mountOf(none).querySelector('.dg-liveness')?.textContent ?? '';
  assert.match(bare, /1 Digest current/, 'the rows were not counted when the Snapshot said nothing');
  assert.ok(!/disagree/.test(bare), 'a Snapshot carrying no counts was reported as disagreeing');
  assert.deepEqual(blockKinds(none, 'a'), ['summary', 'facts'], 'the canary Digest did not render');
});

test('a Digest arm the frame cannot support is stated as unreadable, never as history', () => {
  // Taking the as-of state from `kind` alone permits two failures at once:
  //
  //   `{kind:'current'}` with no payload rendered "Current - written against the content now on
  //   disk" over an EMPTY sheet and a blank hash. That is a false content claim and the invented
  //   empty panel, in one row.
  //
  //   any unrecognised `kind` was rendered "none has ever been written", which asserts a history
  //   the frame never claimed.
  //
  // Neither may be folded into one of the three real arms, so there is a fourth thing to say.
  // Every frame below carries a Feature that MUST come out fully rendered in the same pass -
  // without that, a render that collapsed entirely would satisfy every assertion here for free.
  const canary = {
    name: 'good',
    path: 'good',
    contentSha: 'c'.repeat(64),
    digest: { kind: 'current', digest: twoBlockDigest('good') },
  };
  const cases: readonly (readonly [string, unknown])[] = [
    ['a current arm with no payload', { kind: 'current' }],
    ['a current arm whose payload is not an object', { kind: 'current', digest: 'no' }],
    ['a current arm whose blocks are not a list', { kind: 'current', digest: { blocks: 'no' } }],
    ['a current arm with an empty block list', { kind: 'current', digest: { blocks: [] } }],
    ['a current arm whose only Block is unrecognised', { kind: 'current', digest: { blocks: [{ kind: 'table' }] } }],
    ['an unrecognised kind', { kind: 'nonsense' }],
    ['a kind that is not a string', { kind: 7 }],
    ['a digest that is not an object', 'no'],
  ];

  for (const [what, digest] of cases) {
    const doc = panelDocument();
    draw(doc, {
      roots: [{ path: '/r', label: 'r', features: [{ name: 'a', path: 'a', contentSha: 'ab', digest }, canary] }],
    } as never);

    const row = itemOf(doc, 'a');
    assert.equal(row.getAttribute('data-as-of'), 'unreadable', `${what} was promoted or demoted to a real arm`);
    assert.match(row.textContent, /Unreadable/, `${what} says nothing about being unreadable`);
    // Not a false content claim, and not an invented history.
    assert.ok(!/written against the content now on disk/i.test(row.textContent), `${what} claimed to be current`);
    assert.ok(!/none has ever been written/i.test(row.textContent), `${what} invented a history`);
    // No disclosure onto an empty sheet, and no empty Digest.
    assert.equal(row.tagName.toLowerCase(), 'div', `${what} was made a disclosure with nothing behind it`);
    assert.equal(row.querySelector('.dg-sheet'), null, `${what} was given a sheet`);
    assert.equal(row.querySelectorAll('[data-block]').length, 0, `${what} drew Blocks it does not have`);
    // And no blank hash: the word `content` above an empty space is worse than saying so.
    assert.notEqual(textOf(row, '.dg-sha'), 'content ', `${what} printed the word content and no hash`);
    assert.match(textOf(row, '.dg-sha'), /content ([0-9a-f]+\u2026|not recorded)/, `${what} has no honest hash line`);

    // The header line counts it as unreadable and never folds it into "never written". Folding
    // asserts a history for a row the reader can see says the opposite - the same mistake one
    // level up as drawing the row itself as never-written. Caught in a browser, where the line
    // read "2 never written" above two rows saying `Unreadable`.
    const line = mountOf(doc).querySelector('.dg-liveness')?.textContent ?? '';
    assert.match(line, /1 unreadable/, `${what} was not counted as unreadable: ${line}`);
    assert.match(line, /0 never written/, `${what} was counted as never written: ${line}`);

    // The promotion, in the same pass.
    assert.deepEqual(blockKinds(doc, 'good'), ['summary', 'facts'], `the canary Digest did not render beside ${what}`);
  }

  // And the fourth count is absent when there is nothing to count, rather than a standing zero
  // that would teach the reader unreadable rows are ordinary here.
  const clean = panelDocument();
  draw(clean, boardWith({ alpha: twoBlockDigest('alpha') }, ['beta']));
  const cleanLine = mountOf(clean).querySelector('.dg-liveness')?.textContent ?? '';
  assert.ok(!/unreadable/.test(cleanLine), `a clean board advertised an unreadable count: ${cleanLine}`);
  assert.match(cleanLine, /1 Digest current, 0 expired, 1 never written, and/, cleanLine);
  assert.deepEqual(blockKinds(clean, 'alpha'), ['summary', 'facts'], 'the canary Digest did not render');
});

test('a malformed Snapshot degrades instead of taking the render down with it', () => {
  // The panel is handed `JSON.parse` output off a socket, and two more panels run after it in
  // `draw()`. A throw here is three panels gone, not one.
  for (const malformed of [
    { roots: 'not a list' },
    { roots: [null, 7, { features: 'no' }] },
    { roots: [{ path: 1, features: [{ name: null, digest: 'no', contentSha: 9 }] }] },
    { roots: [{ features: [{ name: 'a', digest: { kind: 'expired', filesChanged: 'three' } }] }] },
    { liveness: 'no', rejections: 'no', roots: [{ features: [{ name: 'a', digest: { kind: 'current' } }] }] },
    { roots: [{ features: [{ name: 'a', digest: { kind: 'current', digest: { blocks: [null, 7, 'x'] } } }] }] },
  ]) {
    const doc = panelDocument();
    assert.doesNotThrow(() => draw(doc, malformed as never), `the panel threw on ${JSON.stringify(malformed)}`);
  }

  // A non-numeric file count is no count rather than a guessed one, and the row still says which
  // as-of state it is in.
  const doc = panelDocument();
  draw(doc, {
    roots: [
      {
        path: '/r',
        features: [
          { name: 'a', path: 'a', contentSha: 'ab', digest: { kind: 'expired', filesChanged: 'three' } },
          { name: 'good', path: 'good', contentSha: 'cd', digest: { kind: 'current', digest: twoBlockDigest('good') } },
        ],
      },
    ],
  } as never);
  assert.equal(itemOf(doc, 'a').getAttribute('data-as-of'), 'expired');
  assert.match(textOf(itemOf(doc, 'a'), '.dg-asof'), /How many files moved is not recorded yet/);
  assert.ok(!/\d/.test(textOf(itemOf(doc, 'a'), '.dg-asof')), 'a non-numeric count was turned into a number');
  assert.deepEqual(blockKinds(doc, 'good'), ['summary', 'facts'], 'the canary Digest did not render');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A document carrying the panel's mount, and nothing this module is entitled to touch. */
function panelDocument(): FakeDocument {
  const root = new FakeElement('body');
  const doc = new FakeDocument(root);
  const mount = doc.createElement('section');
  mount.id = 'digest-panel';
  mount.className = 'section panelmount';
  root.appendChild(mount);
  return doc;
}

function mountOf(doc: FakeDocument): FakeElement {
  const mount = doc.getElementById('digest-panel');
  assert.ok(mount !== null, 'the fake document lost the panel mount');
  return mount;
}

/** The call the board makes, with the view model the panel is specified never to read. */
function draw(doc: FakeDocument, snapshot: unknown): void {
  renderDigest(doc as never, null as never, snapshot as never);
}

/**
 * A Feature's row, found by the name the panel drew on it.
 *
 * Deliberately NOT found by its `data-feature` key. The key is Root-qualified with the same
 * length-prefixed join `core/index.ts` uses for a card id and an Annotation key, and rebuilding
 * that join here would mean every test in this file asserted the panel's behaviour through a
 * private duplicate of the very construction under test, letting the same collision survive on
 * both sides of the assertion. One test asserts the key,
 * against a value derived from the Snapshot; everything else asks for a name.
 */
function itemOf(doc: FakeDocument, name: string): FakeElement {
  for (const node of mountOf(doc).querySelectorAll('[data-feature]')) {
    if (node.querySelector('.dg-name')?.textContent === name) return node;
  }
  return assert.fail(`no Feature row named ${name}`);
}

/** The Feature names the panel drew, in document order. */
function rowNames(doc: FakeDocument): string[] {
  return mountOf(doc)
    .querySelectorAll('[data-feature]')
    .map((node) => node.querySelector('.dg-name')?.textContent ?? '');
}

function toneBlock(doc: FakeDocument, tone: string): FakeElement {
  for (const node of mountOf(doc).querySelectorAll('[data-tone]')) {
    if (node.getAttribute('data-tone') === tone) return node;
  }
  return assert.fail(`no bullets Block with tone ${tone}`);
}

function textOf(node: FakeElement, selector: string): string {
  return node.querySelector(selector)?.textContent ?? '';
}

/**
 * The same nodes, by identity.
 *
 * `deepEqual` is the wrong tool here and quietly so: a subtree that was thrown away and rebuilt
 * is structurally identical to the one it replaced, so a structural comparison reports a rebuild
 * as a match. Surviving as the same object is the whole property.
 */
function sameNodes(found: readonly FakeElement[], expected: readonly FakeElement[], why: string): void {
  assert.equal(found.length, expected.length, `${why} (node count changed)`);
  for (const [index, node] of expected.entries()) {
    assert.equal(found[index], node, `${why} (node ${String(index)} is a different object)`);
  }
}

/** The Block kinds one Feature drew, in document order. */
function blockKinds(doc: FakeDocument, key: string): string[] {
  return itemOf(doc, key)
    .querySelectorAll('[data-block]')
    .map((node) => node.getAttribute('data-block') ?? '');
}

/** The Block kinds a Digest was AUTHORED with, read back off the Snapshot. */
function authoredKinds(snapshot: Snapshot, name: string): string[] {
  const digest = featureOf(snapshot, name).digest;
  assert.equal(digest.kind, 'current', `${name} has no current Digest to read`);
  return digest.kind === 'current' ? digest.digest.blocks.map((block) => block.kind) : [];
}

function featureOf(snapshot: Snapshot, name: string): FeatureSnapshot {
  for (const root of snapshot.roots) {
    for (const feature of root.features) {
      if (feature.name === name) return feature;
    }
  }
  return assert.fail(`no Feature named ${name} in the Snapshot`);
}

/**
 * The body of one rule in a stylesheet, or `''` when there is none.
 *
 * Deliberately literal about the selector: a rule that is renamed has to be renamed here too,
 * which is the point. A fuzzy match would keep passing while the declaration it describes moved
 * to a selector that no longer applies.
 */
function ruleText(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return close === -1 ? '' : css.slice(open + 1, close).trim();
}

/** The declarations a tone's own rule carries, optionally on a descendant of the block. */
function ruleFor(tone: string, within = ''): string {
  const selector = `#digest-panel .dg-bullets[data-tone="${tone}"]${within === '' ? '' : ` ${within}`}`;
  return ruleText(CSS, selector);
}

/**
 * The colour a tone's glyph and its spelled-out key are drawn in.
 *
 * Every tone declares one explicitly, including `note`, so that this reads a stylesheet rather
 * than a mixture of stylesheet and inherited default - a comparison over defaults would report
 * two tones as different because neither of them said anything.
 */
function colourFor(tone: string): string {
  const selector = `#digest-panel .dg-bullets[data-tone="${tone}"] .dg-tglyph`;
  const at = CSS.indexOf(`\n${selector},`);
  assert.notEqual(at, -1, `tone ${tone} declares no colour of its own in ui/digest.css`);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  const colour = /color:\s*([^;]+)/.exec(CSS.slice(open + 1, close))?.[1]?.trim();
  assert.ok(colour !== undefined, `the rule for tone ${tone} sets no colour`);
  return colour;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A board with one Root and one Feature per named Digest, derived twice: once to learn each
 * Feature's content hash and its Annotation key, once for real.
 *
 * The key is read off the Snapshot rather than rebuilt, for the reason `annotations.test.ts`
 * gives at length: a hand-built copy of the key construction means a test for a key defect is
 * asserting the guarantee through a private duplicate of the very thing that has to deliver it.
 *
 * @param current Digests written against the content now on disk.
 * @param bare Features with no Annotation at all.
 * @param expired Digests written against content that has since moved.
 * @param stale Features whose Ticket carries an Override written against content that has since
 *   moved. Each one is an Override the next Reconciliation pass will re-check, which is the
 *   fourth count in the Digest header.
 */
function boardWith(
  current: Readonly<Record<string, object>>,
  bare: readonly string[] = [],
  expired: Readonly<Record<string, object>> = {},
  stale: readonly string[] = [],
): Snapshot {
  const names = [...Object.keys(current), ...bare, ...Object.keys(expired)].sort();
  const scan = scanOf(names.map((name): [string, string] => [`${name}/issues/01-a.md`, `# 01 \u2014 ${name}\n`]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);

  const entries = [
    ...Object.entries(current).map(([name, digest]) => ({
      schemaVersion: 1,
      filePath: featureKeyOf(probe, name),
      contentSha: featureOf(probe, name).contentSha,
      digest,
    })),
    ...Object.entries(expired).map(([name, digest]) => ({
      schemaVersion: 1,
      filePath: featureKeyOf(probe, name),
      // Written against content that has since moved. Nothing is swept; it simply stops matching
      // by its real key (ADR-0003).
      contentSha: 'a'.repeat(64),
      digest,
    })),
    ...stale.map((name) => ({
      schemaVersion: 1,
      filePath: cardIdOf(probe, `${name}/issues/01-a.md`),
      contentSha: 'f'.repeat(64),
      extraction: { title: 'Written against content that has moved' },
    })),
  ];
  return deriveSnapshot(scan, asStore({ schemaVersion: 1, entries }));
}

/** A card's key, read off the Snapshot by the path it was scanned at - never rebuilt by hand. */
function cardIdOf(snapshot: Snapshot, relPath: string): string {
  for (const root of snapshot.roots) {
    for (const feature of root.features) {
      for (const ticket of feature.tickets) {
        if (ticket.path === relPath) return ticket.id;
      }
    }
  }
  return assert.fail(`no card at ${relPath}`);
}

function scanOf(files: readonly (readonly [string, string])[]): Scan {
  const root: Root = {
    path: ROOT,
    label: ROOT,
    trackerPath: `${ROOT}/.scratch`,
    files: files.map(([path, text]) => ({ path, absPath: `${ROOT}/.scratch/${path}`, text })),
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
  return { roots: [root] };
}

/** The Feature's Annotation key, composed the way the seam composes it, read off a card. */
function featureKeyOf(snapshot: Snapshot, name: string): string {
  const feature = featureOf(snapshot, name);
  const card = snapshot.roots.flatMap((root) => root.features).flatMap((each) => each.tickets)[0];
  assert.ok(card !== undefined, 'the probe Snapshot has no card to read the key prefix from');
  assert.ok(card.id.endsWith(card.path), `a card id must end with its path: id ${card.id}, path ${card.path}`);
  return `${card.id.slice(0, card.id.length - card.path.length)}${feature.path}`;
}

/** A store as it actually arrives: round-tripped through JSON, because that is what a file is. */
function asStore(value: object): AnnotationStore {
  const parsed: AnnotationStore = JSON.parse(JSON.stringify(value));
  return parsed;
}

function twoBlockDigest(name: string): object {
  return {
    v: 1,
    feature: name,
    blocks: [
      { kind: 'summary', text: `${name} is in flight.` },
      {
        kind: 'facts',
        items: [
          { label: 'Tickets', value: '4' },
          { label: 'Done', value: '1', state: 'done' },
        ],
      },
    ],
  };
}

function threeBlockDigest(name: string): object {
  return {
    v: 1,
    feature: name,
    blocks: [
      { kind: 'summary', text: `${name} moved.` },
      { kind: 'facts', items: [{ label: 'Tickets', value: '5' }, { label: 'Done', value: '2' }] },
      { kind: 'links', items: [{ label: 'Spec', path: `${name}/spec.md` }] },
    ],
  };
}

/**
 * Six Blocks, the envelope maximum, with the aggregate a couple of dozen characters below its
 * 900-character ceiling.
 *
 * `pad` widens every bullet item. It exists so the test can prove this fixture is really at the
 * cap rather than merely large: at `0` the seam accepts it, and a few characters more is refused.
 * Asserting the aggregate directly would mean reimplementing the budget rule here, letting the
 * same budget defect appear correct on both sides of the assertion.
 */
function atCapDigest(pad = 0): object {
  const line = (mark: string): string => `${mark}${'The seam holds one content hash per Feature'.padEnd(83 + pad, '.')}`;
  return {
    v: 1,
    feature: 'alpha',
    blocks: [
      { kind: 'summary', text: 'Alpha carries the seam between the two liveness tiers on this board.' },
      {
        kind: 'facts',
        items: [
          { label: 'Tickets', value: '16' },
          { label: 'On the Frontier', value: '3' },
          { label: 'Frozen', value: '1' },
        ],
      },
      { kind: 'bullets', title: 'Risks', tone: 'risk', items: [line('a'), line('b'), line('c')] },
      { kind: 'bullets', title: 'Not yet decided', tone: 'fog', items: [line('d'), line('e'), line('f')] },
      { kind: 'bullets', title: 'Ruled out', tone: 'out-of-scope', items: [line('g'), line('h'), line('i')] },
      { kind: 'links', items: [{ label: 'Spec', path: 'alpha/spec.md' }] },
    ],
  };
}

/** Every tone, spread over as many Features as the 5-bullets-per-Digest envelope needs. */
function toneBoard(): Snapshot {
  const bullets = (tone: string): object => ({
    kind: 'bullets',
    title: `${tone} items`,
    tone,
    items: [`first ${tone} item`, `second ${tone} item`],
  });
  return boardWith({
    alpha: { v: 1, feature: 'alpha', blocks: [{ kind: 'summary', text: 'Alpha.' }, ...TONES.slice(0, 4).map((tone) => bullets(tone))] },
    beta: { v: 1, feature: 'beta', blocks: [{ kind: 'summary', text: 'Beta.' }, ...TONES.slice(4).map((tone) => bullets(tone))] },
    canary: twoBlockDigest('canary'),
  });
}

/**
 * An expired Digest carrying a given file count, built as a `Snapshot` literal.
 *
 * A literal rather than a derived Snapshot, so both arms - a count and no count - are reachable
 * from one place and the panel is tested on the sentence it writes rather than on the seam that
 * hands it the number. `annotations.test.ts` asserts the counting rule itself.
 */
function expiredBoard(filesChanged: number | null): Snapshot {
  const feature = (name: string, digest: object): object => ({
    name,
    path: name,
    specPath: null,
    mapPath: null,
    siblings: [],
    tickets: [],
    counts: {},
    frontier: [],
    digest,
    contentSha: `${name}0123456789abcdef`,
  });
  return {
    schemaVersion: 1,
    roots: [
      {
        path: ROOT,
        label: ROOT,
        trackerPath: `${ROOT}/.scratch`,
        tracker: 'local-markdown',
        hiddenWorktrees: 0,
        features: [
          feature('alpha', { kind: 'expired', filesChanged }),
          // The canary: a Digest that must come out promoted in the same pass.
          feature('current', {
            kind: 'current',
            digest: { v: 1, feature: 'current', blocks: [{ kind: 'summary', text: 'Still current.' }] },
          }),
        ],
        orphans: [],
        adrs: [],
        glossary: null,
        counts: {},
        warnings: [],
      },
    ],
    counts: {},
    frontierCount: 0,
    progress: { doneCount: 0, total: 0, percent: 0, label: '' },
    liveness: { digestsCurrent: 1, digestsExpired: 1, digestsNeverWritten: 0, overridesPendingRecheck: 0 },
    rejections: [],
    overrides: { applied: 0, rejected: 0 },
    corrections: { total: 0, byLane: {} },
    warnings: [],
  } as never;
}
