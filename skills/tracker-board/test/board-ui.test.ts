/**
 * The board's shipped browser files, checked as files.
 *
 * Some browser requirements are not statements about a view model, they are
 * statements about the bytes that reach a browser: a type floor, the absence of a whole class
 * of fill, the absence of a whole class of element, and the presence of the second and third
 * channels that stop two adjacent violets carrying meaning on their own. None of those can be
 * asserted from `buildView`, and all of them can be asserted from the source.
 *
 * That is the trade this file makes deliberately. A rendered-output check would only ever
 * prove that the inputs it was given were safe; forbidding the construct by name forbids the
 * class. A false positive here is one loud edit. A false negative ships.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { findCard, meterSignature } from '../ui/render.js';
import { columnOrder, laneKey, meterOf } from '../ui/view.js';
import { boardAsset } from '../ui/assets.ts';
import { renderCorrections } from '../ui/corrections.js';
import { renderDigest } from '../ui/digest.js';
import { renderDomain } from '../ui/domain.js';
import { CORRECTIONS_PANEL, DIGEST_PANEL, DOMAIN_PANEL, drawPanel } from '../ui/panels.js';
import { FakeElement, boardDocument } from './dom.ts';

const UI_DIR = join(import.meta.dirname, '..', 'ui');

const SHIPPED = readdirSync(UI_DIR).filter((name) => /\.(html|css|js)$/.test(name));
const STYLESHEETS = SHIPPED.filter((name) => name.endsWith('.css'));
const MODULES = SHIPPED.filter((name) => name.endsWith('.js'));

function source(name: string): string {
  return readFileSync(join(UI_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// The type scale
// ---------------------------------------------------------------------------

test('the type scale is declared at the documented sizes', () => {
  const css = source('board.css');
  for (const [token, size] of [
    ['--t-body', '16px'],
    ['--t-sec', '14.5px'],
    ['--t-meta', '13px'],
    ['--t-lab', '12px'],
  ] as const) {
    assert.ok(
      new RegExp(`${token}:\\s*${size.replace('.', '\\.')}\\s*;`).test(css),
      `${token} is not declared as ${size}. The scale was measured, not guessed: the earlier body size read as too small.`,
    );
  }
  assert.match(
    css,
    /font-size:\s*var\(--t-body\)/,
    'the body does not use the scale it declares, so the tokens are decoration',
  );
});

test('nothing is set below the 12px floor, in any stylesheet', () => {
  // The floor exists for tracked micro-labels only, and everything above it is scaled to
  // match. A single 11px declaration is how a type scale quietly comes apart.
  let checked = 0;
  for (const name of STYLESHEETS) {
    for (const match of source(name).matchAll(/font-size:\s*([^;{}]+)/g)) {
      const value = match[1] ?? '';
      for (const px of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
        checked += 1;
        assert.ok(
          Number(px[1]) >= 12,
          `ui/${name} sets a font-size of ${String(px[1])}px, below the 12px floor`,
        );
      }
    }
  }
  assert.ok(checked >= 4, 'no literal font-size was examined, so the floor was not actually checked');
});

test('text sizes carry a line-height that is not left tight under bigger glyphs', () => {
  // The scale going up is only half of it - the reference file's own note is that padding and
  // line-height have to go up with it. Big numerals are allowed to sit at 1.05 or less; body
  // and secondary text is not.
  const css = source('board.css');
  const bodyRule = css.match(/\nbody\s*\{[^}]*\}/);
  assert.ok(bodyRule !== null, 'no body rule to check');
  const lineHeight = bodyRule[0].match(/line-height:\s*([\d.]+)/);
  assert.ok(lineHeight !== null, 'the body sets no line-height');
  assert.ok(Number(lineHeight[1]) >= 1.5, `body line-height is ${String(lineHeight[1])}, which is tight at 16px`);

  const title = css.match(/\.card-title\s*\{[^}]*\}/);
  assert.ok(title !== null);
  const titleHeight = title[0].match(/line-height:\s*([\d.]+)/);
  assert.ok(titleHeight !== null && Number(titleHeight[1]) >= 1.4, 'the card title is set tight');
});

test('the masthead states the standing two-tier claim as static prose', () => {
  const html = source('index.html');
  const masthead = html.match(/<header class="masthead">([\s\S]*?)<\/header>/);
  assert.ok(masthead !== null, 'the board has no masthead to own its standing claim');

  const paragraphs = [...(masthead[1] ?? '').matchAll(/<p class="tiers"([^>]*)>([\s\S]*?)<\/p>/g)];
  assert.equal(paragraphs.length, 1, `the masthead carries ${String(paragraphs.length)} standing claims`);

  const attributes = paragraphs[0]?.[1] ?? '';
  assert.ok(!/\baria-live\s*=/.test(attributes), 'static prose was given an explicit live region');
  assert.ok(
    !/\brole\s*=\s*["'](?:alert|log|marquee|status|timer)["']/i.test(attributes),
    'static prose was given an implicit-live role',
  );
  const text = (paragraphs[0]?.[2] ?? '').replace(/\s+/g, ' ').trim();
  assert.equal(
    text,
    'Cards on this board are live to the file system. The AI layer below is as-of content, not as-of a clock.',
  );

  const claimAt = masthead[0].indexOf('<p class="tiers"');
  const totalsAt = masthead[0].indexOf('<div class="totals" id="totals"');
  const mastEndsAt = masthead[0].indexOf('\n      </div>') + '\n      </div>'.length;
  assert.ok(mastEndsAt >= '\n      </div>'.length, 'the masthead identity row has no closing tag to check');
  assert.ok(claimAt > mastEndsAt, 'the claim is not below the masthead identity row');
  assert.ok(claimAt < totalsAt, 'the claim is not beside the masthead identity it qualifies');

  const rule = source('board.css').match(/\.masthead \.tiers\s*\{[^}]*\}/);
  assert.ok(rule !== null, 'the masthead stylesheet does not lay out the new prose');
  assert.match(rule[0], /margin:/, 'the paragraph keeps browser-default margins');
  assert.match(rule[0], /line-height:/, 'the paragraph has no measured reading line');
  assert.match(rule[0], /max-width:/, 'the paragraph can run across the full masthead');
});

// ---------------------------------------------------------------------------
// No hatched or striped fills
// ---------------------------------------------------------------------------

test('no stylesheet hatches, stripes or patterns anything', () => {
  // Solid low-alpha tint plus a left rule, everywhere state needs to read. Nothing patterned
  // sits under text, and nothing patterned exists at all - which is the stronger rule, and the
  // only one that can be checked without rendering.
  const forbidden: readonly [RegExp, string][] = [
    [/repeating-linear-gradient/i, 'a repeating linear gradient is a hatch'],
    [/repeating-radial-gradient/i, 'a repeating radial gradient is a hatch'],
    [/repeating-conic-gradient/i, 'a repeating conic gradient is a hatch'],
    [/background-image/i, 'the only reason for a background image here would be a pattern'],
    [/url\(/i, 'an external or embedded image is both a pattern risk and a request'],
    [/\blinear-gradient\b/i, 'a tiled gradient is how the graph-paper ground became a stripe'],
  ];
  for (const name of STYLESHEETS) {
    const css = source(name);
    for (const [pattern, why] of forbidden) {
      assert.ok(!pattern.test(css), `ui/${name} matches ${String(pattern)}: ${why}`);
    }
  }

  // And the tint that replaced them is really there, so this is not passing because the
  // stylesheet has no fills at all.
  assert.match(source('board.css'), /--accent-tint:\s*rgba\(/, 'the solid low-alpha tint is gone');
  assert.match(source('board.css'), /border-left:\s*4px solid/, 'the left rule that replaces a hatch is gone');
});

// ---------------------------------------------------------------------------
// Paths copy, and never link
// ---------------------------------------------------------------------------

test('no path renders as an href: the board builds no anchor and sets no href', () => {
  // A file-scheme href from a page served over HTTP is refused by every browser, so a link to
  // a path is a link that does not work. Every path is a real button instead.
  for (const name of MODULES) {
    const js = source(name);
    assert.ok(!/\bhref\b/.test(js), `ui/${name} sets an href`);
    assert.ok(
      !/createElement\(\s*['"]a['"]\s*\)/.test(js),
      `ui/${name} builds an anchor element`,
    );
  }

  const html = source('index.html');
  assert.ok(!/<a[\s>]/i.test(html), 'the document contains an anchor element');
  // The stylesheet and icon links are the only hrefs on the page, and none of them is a path
  // out of a watched repository.
  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    const value = match[1] ?? '';
    assert.ok(
      value.startsWith('/ui/') || value.startsWith('data:'),
      `the document links to ${value}, which is neither a served asset nor an inline icon`,
    );
  }
});

test('a copy confirms into a live region, and the region reserves its height', () => {
  const html = source('index.html');
  const region = html.match(/<p class="copyfb" id="copyfb"[^>]*>/);
  assert.ok(region !== null, 'the copy confirmation region is gone');
  assert.match(region[0], /role="status"/, 'the confirmation is not announced');
  assert.match(region[0], /aria-live="polite"/, 'the confirmation is not announced politely');

  assert.match(
    source('board.js'),
    /getElementById\('copyfb'\)/,
    'nothing writes the copy confirmation into the live region',
  );

  const rule = source('board.css').match(/\.copyfb\s*\{[^}]*\}/);
  assert.ok(rule !== null, 'the confirmation region has no rule');
  assert.match(rule[0], /min-height:/, 'the region does not reserve its height, so confirming shifts the layout');

  // Failure is the one case allowed to grow: the reader has to select the path by hand, and a
  // clipped path cannot be selected by hand.
  assert.match(source('board.css'), /\.copyfb\[data-mode="err"\][^}]*white-space:\s*normal/);
});

// ---------------------------------------------------------------------------
// Nothing rides on colour alone
// ---------------------------------------------------------------------------

test('frozen is the deeper of two adjacent violets, and neither carries meaning alone', () => {
  const css = source('board.css');
  const light = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));

  const lightYou = hexOf(light, '--s-you');
  const lightFrozen = hexOf(light, '--s-frozen');
  assert.notEqual(lightYou, lightFrozen, 'the two Lanes share one colour');
  assert.ok(
    luminance(lightFrozen) < luminance(lightYou),
    `frozen (${lightFrozen}) is not the deeper shade beside needs-you (${lightYou})`,
  );

  const darkYou = hexOf(dark, '--s-you');
  const darkFrozen = hexOf(dark, '--s-frozen');
  assert.notEqual(darkYou, darkFrozen, 'the two Lanes share one colour in the dark theme');

  // The other two channels. A double border is the third style in the same family: solid where
  // a person is declared, dashed where a person is inferred, double where a person stands at
  // the end of every path out.
  const frozenTag = css.match(/\.stag\[data-l="frozen"\]\s*\{[^}]*\}/);
  assert.ok(frozenTag !== null, 'the frozen tag has no rule of its own');
  assert.match(frozenTag[0], /double/, 'frozen and needs-you differ only by hue on the tag');

  const whyDeclared = css.match(/\n\.whyyou\s*\{[^}]*\}/);
  const whyInferred = css.match(/\.whyyou\[data-src="type"\]\s*\{[^}]*\}/);
  assert.ok(whyDeclared !== null && whyInferred !== null);
  assert.match(whyDeclared[0], /border-left:\s*4px solid/, 'a declared Lane has no solid rule');
  assert.match(whyInferred[0], /dashed/, 'an inferred Lane is not told apart from a declared one');
});

test('every Lane and every column has a rule, so none falls back to an unmarked default', () => {
  const css = source('board.css');
  for (const lane of laneKey()) {
    assert.ok(
      css.includes(`.stag[data-l="${lane.lane}"]`),
      `Lane ${lane.lane} has no tag rule, so it renders as an unmarked default`,
    );
  }
  for (const key of columnOrder()) {
    assert.ok(css.includes(`.col[data-col="${key}"]`), `column ${key} has no rule of its own`);
  }
  assert.match(
    css,
    /\.card\[data-signoff\][^}]*var\(--s-done\)/,
    'a full meter awaiting sign-off is drawn the same as an unstarted one',
  );
});

test('hidden outranks every component rule that sets display', () => {
  // A card carries every optional block at all times and toggles `hidden`, because a card
  // that is rebuilt cannot keep focus and cannot be the target of the blocker navigation. The
  // browser's own `[hidden]` rule is a bare attribute selector, so any component rule setting
  // `display` outranks it - and every one of those blocks sets `display`.
  //
  // Without the override the board draws an empty "unclassified" panel and an empty "frozen on
  // you" panel on every card on the page: it tells the reader that a task Ticket scored as
  // neither Dialect and that its chain ends at a person, on cards where both are false. The
  // source assertion keeps that browser-visible failure mechanically detectable.
  const css = source('board.css');
  const rule = css.match(/\[hidden\]\s*\{[^}]*\}/);
  assert.ok(rule !== null, 'no rule enforces the hidden attribute over component display rules');
  assert.match(rule[0], /display:\s*none\s*!important/, 'the hidden rule can be outranked by a class');

  // And the blocks it governs really do set `display`, so this is guarding something.
  let governed = 0;
  for (const selector of ['.meter', '.dchk', '.uncl', '.whyyou', '.frozenblk', '.blk', '.ledger']) {
    const block = css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`));
    assert.ok(block !== null, `${selector} has no rule`);
    if (/display:/.test(block[0])) governed += 1;
  }
  assert.ok(governed >= 5, 'the blocks this override exists for no longer set display');
});

test('the layout is rigid: the column count folds and nothing else reflows', () => {
  const css = source('board.css');
  const counts = [...css.matchAll(/\.board\s*\{[^}]*grid-template-columns:\s*([^;]+);/g)].map(
    (match) => match[1] ?? '',
  );
  assert.ok(counts.length >= 1, 'the board declares no column grid');
  assert.match(counts[0] ?? '', /repeat\(6,/, 'the board does not open at six columns');

  const folds = [...css.matchAll(/@media \(max-width:\s*(\d+)px\)\s*\{\s*\.board\s*\{[^}]*repeat\((\d)/g)];
  assert.deepEqual(
    folds.map((match) => [Number(match[1]), Number(match[2])]),
    [
      [1499, 3],
      [1179, 2],
    ],
    'the folds moved: six columns start at 1500 and three at 1180, and both numbers are load-bearing',
  );

  // The property the widest fold exists for, stated with the measurement behind it: a maximized
  // window on a 1920x1080 screen at Windows' default 125% scaling is 1536 CSS px. That is a very
  // common way to read this board, and while the fold sat at 1560 it never once showed six
  // columns there - so the six-column order, which is the whole visual language of this board,
  // was unlearnable for that reader. Widening this above 1535 takes it away again.
  const widest = Number(folds[0]?.[1] ?? 0);
  assert.ok(
    widest > 0 && widest < 1536,
    `the widest .board fold is at ${String(widest)}px, so a 1536px viewport - a maximized window ` +
      `on 1920x1080 at Windows' default 125% scaling - folds to three columns and never sees the six`,
  );
  assert.match(css, /max-width:\s*700px\)\s*\{\s*\.board\s*\{[^}]*minmax\(0, 1fr\)/, 'the board never reaches one column');

  // Auto-fitting the column count to content is exactly what a fixed visual language forbids.
  const boardRules = [...css.matchAll(/\.board\s*\{[^}]*\}/g)].map((match) => match[0]);
  for (const rule of boardRules) {
    assert.ok(!/auto-fill|auto-fit/.test(rule), 'the board grid sizes itself from its content');
  }
});

test('the board paints the AI-corrected marker, because no panel is allowed to', () => {
  // The panel-stylesheet guard below scopes every selector in `corrections.css` to
  // `#corrections-panel`, so the corrections panel cannot paint `.tid`, which lives on a card.
  // Inline style is refused by the document's own policy. So the marker's only legal home is
  // here, and the division is: the panel sets the state, the stylesheet that owns the element
  // paints it.
  //
  // This is asserted because deleting it breaks nothing that any other test can see. The panel
  // goes on setting `data-corrected`, every render still succeeds, and the marker simply stops
  // being drawn - a correction silently rendering as no correction, which is the one outcome the
  // whole treatment exists to prevent.
  const css = source('board.css');
  const rule = css.match(/\.tid\[data-corrected\][^{}]*\{[^}]*\}/);
  assert.ok(rule !== null, 'board.css carries no rule for a corrected ticket id');
  // A Ticket prints its id in two elements: `.tid` on a card in a column, and `.lid` on a ledger
  // row inside an opened Feature in the collapsed Done column, both filled from the same
  // `card.shortId`. They are pinned to the same rule rather than merely both being present,
  // because two rules can drift and one block cannot - and a Ticket that reads corrected in one
  // mode of the Done column and uncorrected in the other is the same lie as not marking it.
  assert.match(
    rule[0],
    /\.lid\[data-corrected\]/,
    'the corrected marker paints the card id but not the ledger row id, so the same Ticket reads corrected in one mode of the Done column and uncorrected in the other',
  );
  assert.match(
    rule[0],
    /text-decoration:[^;]*dotted/,
    'the corrected ticket id is not marked with a dotted underline',
  );
  // `.lid[data-corrected]` and `.lrow .lid` tie on specificity (0,2,0) and the ledger rule comes
  // later in the file, so anything both set is won by the ledger rule. They share no property.
  const ledgerRules = css.match(/[^{}]*\.lid[^{}]*\{[^}]*\}/g) ?? [];
  for (const ledgerRule of ledgerRules) {
    if (/\[data-corrected\]/.test(ledgerRule)) continue;
    assert.ok(
      !/text-decoration/.test(ledgerRule),
      'a later rule sets text-decoration on .lid, which silently unpaints the corrected marker on ledger rows',
    );
  }
  // It decorates rather than boxes. A marker that added layout would move a card when a
  // correction arrived, and 36 of them would reflow the column.
  assert.ok(
    !/(^|[^-])(padding|margin|border|display|width|height)\s*:/.test(rule[0]),
    'the corrected-id marker changes layout, so corrections would move the cards under them',
  );
});

// ---------------------------------------------------------------------------
// Blocker navigation
// ---------------------------------------------------------------------------

test('a blocker id finds the card it names, and finds nothing when it names nothing', () => {
  // The lookup reads an attribute back rather than building a selector from it. The key holds
  // a Root path and a file name - strings from somebody else's repository - and a selector is
  // a parsed language. These are the keys that would break one.
  const driveRoot = ['C', ':', '/', 'a', '/', 'repo'].join('');
  const keys = [
    `12#${driveRoot}#alpha/issues/01-a.md`,
    `12#${driveRoot}#alpha/issues/02 [draft].md`,
    `12#${driveRoot}#alpha/issues/03:weird".md`,
    `12#${driveRoot}#alpha/issues/04.md`,
  ];
  const node = (key: string) => ({ getAttribute: (name: string) => (name === 'data-card' ? key : null) });
  const nodes = keys.map(node);

  for (const key of keys) {
    assert.equal(
      findCard(nodes as never, key)?.getAttribute('data-card'),
      key,
      `the navigation cannot reach ${key}`,
    );
  }
  assert.equal(findCard(nodes as never, 'no such card'), null);
  assert.equal(findCard(nodes as never, null), null);
  assert.equal(findCard([] as never, keys[0] ?? ''), null);

  // An empty id matches nothing, even against a node whose key is itself empty. Without an
  // empty-keyed node in the list, deleting the guard changes no answer, so the assertion would
  // prove the guard exists and nothing more. The renderer does not produce such a node, but the
  // exported function's contract still has to reject it.
  const withBlank = [node(''), ...nodes];
  assert.equal(findCard(withBlank as never, ''), null, 'an empty id matched a card');
  assert.equal(findCard(withBlank as never, null), null);
  assert.equal(
    findCard(withBlank as never, keys[0] ?? '')?.getAttribute('data-card'),
    keys[0],
    'a real id stopped resolving once a blank-keyed node was present',
  );
});

test('card nodes are pooled across the whole board, not indexed per list', () => {
  // A structural guard, and it says so: that the same node really survives a Lane move with
  // its focus and its just-changed tint was verified by driving a real browser, because there
  // is no DOM in this zero-dependency suite. What can be checked here is the decision that
  // makes it possible, which is the thing an edit would undo.
  //
  // Indexing per destination list means a card that changes Lane is not found where it lands,
  // so it is rebuilt: focus goes, the navigation marker goes, and the just-changed tint never
  // fires - on the one event this board exists to show you.
  const js = source('render.js');

  assert.ok(
    !/indexBy\(\s*list\.querySelectorAll\(\s*'\[data-card\]'/.test(js),
    'renderCards indexes its own list again, so a card changing Lane is rebuilt rather than moved',
  );
  assert.match(js, /tally\.pool\.get\(card\.id\)/, 'renderCards no longer reads the shared card pool');
  assert.match(
    js,
    /for \(const host of \[board, offboard\]\)/,
    'the pool no longer spans both the board and the off-board list',
  );

  // And the sweep that removes a card is board-wide. A per-list sweep would delete a card the
  // moment it left one list, before the list it moved to had a chance to claim it.
  assert.match(js, /for \(const \[key, node\] of pool\)/, 'there is no board-wide sweep for removed cards');
});

test('two meters that draw differently never share a signature', () => {
  // The signature decides whether the segments are rebuilt, so a collision between two meters
  // that draw differently leaves a bar contradicting the ratio printed beside it. The drawn
  // segment count saturates at the cap, so 1 of 100 (forty
  // segments, none lit) and 1 of 41 (forty segments, one lit) both keyed as `40:1`.
  //
  // Stated as the property rather than as the one example, and swept over every ratio up to
  // well past the cap, because the example was never the point.
  const seen = new Map<string, { drawing: string; label: string }>();
  let pastCap = 0;

  for (let total = 1; total <= 130; total += 1) {
    for (let checked = 0; checked <= total; checked += 1) {
      const meter = meterOf(checked, total);
      if (meter.segments.length < total) pastCap += 1;
      const signature = meterSignature(meter);
      const drawing = meter.segments.map((on) => (on ? '1' : '0')).join('');
      const label = `${String(checked)}/${String(total)}`;
      const previous = seen.get(signature);
      if (previous !== undefined) {
        assert.equal(
          previous.drawing,
          drawing,
          `${label} and ${previous.label} share signature ${signature} but draw differently`,
        );
      }
      seen.set(signature, { drawing, label });
    }
  }

  assert.ok(pastCap > 0, 'no ratio in the sweep exceeded the segment cap, so the collision case was never reached');
  assert.notEqual(
    meterSignature(meterOf(1, 100)),
    meterSignature(meterOf(1, 41)),
    'the known saturated pair still collides',
  );
});

// ---------------------------------------------------------------------------
// The three seams, pre-wired
// ---------------------------------------------------------------------------

test('each panel seam is served, imported, mounted and inert', () => {
  // Three panels grow beside the board and would otherwise land in the same three shared files
  // at once. The seam is asserted rather than assumed, because "it is wired up" is exactly the
  // kind of claim that stops being true silently.
  const html = source('index.html');
  const entry = source('board.js');

  for (const [module, call, mount] of [
    ['corrections', 'renderCorrections', 'corrections-panel'],
    ['digest', 'renderDigest', 'digest-panel'],
    ['domain', 'renderDomain', 'domain-panel'],
  ] as const) {
    assert.ok(boardAsset(`/ui/${module}.js`) !== null, `ui/${module}.js is not served, so it cannot load`);
    assert.ok(boardAsset(`/ui/${module}.css`) !== null, `ui/${module}.css is not served`);
    assert.ok(html.includes(`href="/ui/${module}.css"`), `the document does not link ui/${module}.css`);
    assert.ok(html.includes(`id="${mount}"`), `the document has no mount for the ${module} panel`);
    assert.ok(entry.includes(`from './${module}.js'`), `board.js does not import ui/${module}.js`);
    // Three arguments, and the third one is asserted here because nothing else can. `ui/*.js` is
    // compiled with `allowJs` and NOT `checkJs`, so the type checker never looks inside board.js:
    // dropping the Snapshot argument there would be silent, and every panel would go back to
    // being handed a view model that structurally cannot contain what it draws.
    //
    // Comments are stripped first, and the call is counted rather than merely found: a
    // commented-out three-argument call keeps a plain `includes` green while the live call
    // quietly loses its Snapshot.
    const live = stripNoise(entry.replace(/\/\/[^\n]*/g, ' '));
    const calls = [...live.matchAll(new RegExp(`\\b${call}\\s*\\(`, 'g'))].length;
    assert.equal(calls, 1, `board.js calls ${call} ${String(calls)} times; exactly one live call is expected`);
    assert.ok(
      new RegExp(`\\b${call}\\(doc, view, latest\\)`).test(live),
      `board.js does not pass the Snapshot to ${call}; the view model carries no panel data at all`,
    );
  }
});

test('each panel receives the raw Snapshot, on the same terms buildView receives it', () => {
  // The panels draw Digest state, ADRs, a glossary and correction counts. None of that is on
  // `BoardView` - it is a projection built for the six columns - so `view` alone is an argument
  // that structurally cannot contain what these three modules are specified to draw.
  //
  // The Snapshot goes through instead of widening `BoardView`, because widening it would put
  // three panels into `ui/view.js` at once, which is the one file all three are forbidden to
  // share. That decision is asserted rather than assumed, in both directions: the panels take
  // the Snapshot, and the view model still does not carry panel data.
  const view = source('view.js');
  for (const field of ['corrections', 'digest', 'adrs', 'glossary']) {
    assert.ok(
      !new RegExp(`\\b${field}\\b`).test(view),
      `ui/view.js now carries \`${field}\`; the panels were meant to project the Snapshot themselves`,
    );
  }

  // Runtime arity on the exact exported functions, because every lexical form of this check is
  // satisfiable without the seam existing: a comment can carry the call text, `render\w+` matches
  // a differently-named helper beside a two-argument real export, and JavaScript silently ignores
  // extra arguments so calling a two-parameter function with three still returns cleanly.
  // `Function.length` counts declared parameters and cannot be faked.
  for (const [name, render] of [
    ['renderCorrections', renderCorrections],
    ['renderDigest', renderDigest],
    ['renderDomain', renderDomain],
  ] as const) {
    assert.equal(render.length, 3, `${name} declares ${String(render.length)} parameters, not 3`);
  }

  for (const module of ['corrections', 'digest', 'domain']) {
    const js = source(`${module}.js`);
    // `unknown`, not `Snapshot`. `transport.js` types `onSnapshot` as `unknown` because the value
    // is `JSON.parse` output off a socket, and `board.js` holds `null` until the first frame
    // arrives. Declaring it `Snapshot` would tell a panel author the field access is safe when
    // the first render proves otherwise.
    assert.match(
      js,
      /@param \{unknown\} snapshot/,
      `ui/${module}.js does not declare its Snapshot parameter as unknown, which is what it is`,
    );
    assert.match(
      js,
      /export function render\w+\(doc, view, snapshot\)/,
      `ui/${module}.js does not take the Snapshot`,
    );
    // The deferral that would have sent all three wave agents into ui/view.js at once.
    assert.ok(
      !/carrying them onto the view model|onto the view model is part of the work/.test(js),
      `ui/${module}.js still tells its author to carry data onto the view model, which is a shared file`,
    );
    // The header is this file's specification for the agent who fills it in, so its stated arity
    // has to match the real one. All three headers documented the two-argument form for a while
    // after the signature gained its third parameter, which is the version an author would trust.
    assert.ok(
      !/`render\w+\(doc, view\)`/.test(js),
      `ui/${module}.js documents the two-argument call in its header, contradicting its signature`,
    );
  }
});

test('a panel does nothing at all until a Snapshot has arrived', () => {
  // This replaces an assertion that all three panels were untouchable on *every* argument. That
  // was a statement about their stub lifetime, not about the board, and three agents are filling
  // these panels in concurrently: the first one to render anything would have turned it red for
  // the other two, in a shared file, for a reason belonging to somebody else's ticket. That is
  // the same trap the panel-stylesheet guard below was written to replace, and it is the third
  // instance of it in this file. Replaced rather than deleted, because half of it is a real
  // contract and that half survives the wave.
  //
  // The half that survives: `board.js` holds `null` from page load until the first SSE frame
  // arrives, and `transport.js` types the value `unknown` because it is `JSON.parse` output off a
  // socket. A panel that reaches into it throws in the browser on first paint, before anything is
  // on screen at all. So with no Snapshot, a panel returns without touching the document.
  //
  // An early return at the top of the function satisfies this, and nothing legitimate needs to
  // run ahead of it: the value never goes back to `null` once a frame has arrived, so there is no
  // disconnect case that would need to clear a mount.
  // This probe counts reads rather than throwing on them, and the difference is the whole test.
  //
  // A throwing probe cannot test this contract any more. Every panel here is required to be
  // *total* - no input may make it throw - because `board.js` calls the three in bare sequence and
  // one throw takes out the other two. So against a throwing probe a panel that reaches straight
  // into the document catches its own failure, returns `undefined`, and passes, having drawn
  // nothing *because it crashed*. That is indistinguishable from having correctly returned early,
  // and it is the only outcome the assertion could see.
  //
  // It was not hypothetical. The corrections panel drew its entire frame on a `null` Snapshot -
  // including a sentence claiming no Override had changed a field on a board that had not loaded -
  // and passed this test green the whole time.
  //
  // Counting separates them: a panel that returns first reads nothing, and a panel that reads and
  // then catches has already been recorded. `undefined` is returned from the trap rather than a
  // stub, so a panel that keeps going gets a TypeError on the next step and lands in its own
  // catch - by which point the read is on the list. The count is the assertion; the return value
  // is only a secondary check.
  const reads: string[] = [];
  const counting = (): never =>
    new Proxy(
      {},
      {
        get(_target, property) {
          reads.push(String(property));
          return undefined;
        },
      },
    ) as never;

  // `undefined` as well as `null`: `transport.js` types the frame `unknown` because it is
  // `JSON.parse` output off a socket, so a malformed frame reaches a panel as neither.
  for (const render of [renderCorrections, renderDigest, renderDomain]) {
    for (const absent of [null, undefined] as never[]) {
      reads.length = 0;
      const returned = render(counting(), counting(), absent);
      assert.deepEqual(
        reads,
        [],
        `a panel read ${reads.join(', ')} before a Snapshot arrived`,
      );
      assert.equal(returned, undefined);
    }
  }
});

// ---------------------------------------------------------------------------
// One panel failing costs one panel
// ---------------------------------------------------------------------------

const GUARDS = [
  ['corrections', CORRECTIONS_PANEL],
  ['digest', DIGEST_PANEL],
  ['domain', DOMAIN_PANEL],
] as const;

/** The mount a guard owns, on a fresh board document, with a previous frame's content in it. */
function mountWithStaleFrame(doc: ReturnType<typeof boardDocument>, id: string): FakeElement {
  const mount = doc.getElementById(id);
  assert.ok(mount !== null, `the harness document carries no #${id}`);
  const stale = doc.createElement('p');
  stale.className = 'previous-frame';
  mount.appendChild(stale);
  return mount;
}

test('a panel that throws is stated in the mount it owns, never left as an empty one', () => {
  // The whole reason the guard draws rather than absorbs. All three panels render a legitimate
  // absence - no Override changed a field, no Features at all, a Root with neither ADRs nor a
  // glossary - so a guard that caught a throw and rendered nothing would be publishing the
  // emptier claim in the panel's own voice, and no reader could tell the difference.
  for (const [name, guard] of GUARDS) {
    const doc = boardDocument();
    const mount = mountWithStaleFrame(doc, guard.mount);

    drawPanel(doc as never, guard, () => {
      throw new Error(`the ${name} projection is unreadable`);
    });

    const notice = mount.querySelector('.panelfail');
    assert.ok(notice !== null, `the ${name} guard went quiet instead of saying it could not draw`);
    assert.match(notice.textContent, /could not be drawn from the current Snapshot/);
    assert.match(
      notice.textContent,
      new RegExp(`the ${name} projection is unreadable`),
      `the ${name} guard dropped the reason`,
    );
    assert.ok(
      notice.textContent.includes(guard.absent),
      `the ${name} guard did not say which absence this is not`,
    );
    assert.equal(notice.getAttribute('role'), 'status', 'the notice replaces content without announcing it');

    // The heading comes back with it, and the stale frame does not survive underneath.
    assert.equal(mount.querySelector('h2')?.textContent, guard.heading, `the ${name} panel lost its heading`);
    assert.equal(mount.querySelector('.previous-frame'), null, `the ${name} guard left the previous frame on screen`);
    assert.equal(mount.childNodes.length, 2, `the ${name} mount holds more than the heading and the notice`);
  }

  // The canary: the same guard around a call that works writes nothing at all, so everything
  // above is about a failure path rather than about a guard that always draws a notice.
  const doc = boardDocument();
  const mount = mountWithStaleFrame(doc, DOMAIN_PANEL.mount);
  drawPanel(doc as never, DOMAIN_PANEL, () => undefined);
  assert.equal(mount.querySelector('.panelfail'), null, 'the guard drew a failure over a call that succeeded');
  assert.ok(mount.querySelector('.previous-frame') !== null, 'the guard cleared a mount it had no reason to touch');
});

test('each guard denies a different absence, in the vocabulary the panel it guards uses', () => {
  // Three notices that all said "could not be drawn" would leave the reader exactly where the
  // empty mount left them: told that something is missing, not told what would otherwise have
  // been there.
  const sentences = GUARDS.map(([, guard]) => guard.absent);
  assert.equal(new Set(sentences).size, 3, 'two guards deny the same absence');
  for (const [name, guard] of GUARDS) {
    assert.ok(guard.absent.length > 40, `the ${name} guard says nothing about what is not shown`);
    assert.ok(source('index.html').includes(`id="${guard.mount}"`), `the document has no #${guard.mount}`);
    // The mount really is the one that panel module owns, so the notice lands where its content
    // would have been rather than in a neighbour's box.
    assert.ok(
      source(`${name}.js`).includes(guard.mount),
      `ui/${name}.js does not write into #${guard.mount}, so the guard names the wrong mount`,
    );
  }
});

test('a failed panel is still a named region, and names itself no way its panel cannot undo', () => {
  // A mount is named by `aria-labelledby` pointing at its heading. Replacing the mount's
  // children without restoring that heading leaves the region pointing at an element that no
  // longer exists. The guard has the mirror-image hazard as well: setting an id the panel itself
  // never sets would dangle the moment the panel recovered and rebuilt its own contents.
  for (const [name, guard] of GUARDS) {
    const doc = boardDocument();
    const mount = mountWithStaleFrame(doc, guard.mount);
    mount.setAttribute('aria-labelledby', 'a-heading-from-a-previous-frame');

    drawPanel(doc as never, guard, () => {
      throw new Error('nope');
    });

    const named = mount.getAttribute('aria-labelledby');
    if (guard.headingId === null) {
      assert.equal(named, null, `the ${name} guard left a name pointing at a heading it did not draw`);
      assert.equal(mount.querySelector('h2')?.id, '', `the ${name} guard invented a heading id`);
      // And `null` is the right record of that panel, rather than an oversight: it names its
      // mount no way at all, so there is nothing for the guard to restore.
      assert.ok(
        !source(`${name}.js`).includes('aria-labelledby'),
        `ui/${name}.js does name its mount, so the guard should restore that name rather than clear it`,
      );
    } else {
      assert.equal(named, guard.headingId, `the ${name} guard left the region unnamed`);
      assert.equal(mount.querySelector('h2')?.id, guard.headingId, 'the name points at no element in the mount');
      // And the panel restores the same id when it recovers, so the name is never left dangling
      // by the guard having drawn one the panel does not know about.
      assert.ok(
        source(`${name}.js`).includes(`'${guard.headingId}'`),
        `ui/${name}.js never sets #${guard.headingId}, so the guard's name dangles once the panel recovers`,
      );
    }
  }
});

test('a guarded failure does not strand a panel that keys its next frame on the mount', () => {
  // The hazard the `rebuildKey` field exists for, asserted as behaviour rather than as the line.
  // `domain.js` skips a frame whose projection signature matches the one already on its mount -
  // ADRs move on a scale of weeks and rebuilding would take the reader's scroll position with it
  // - so a notice drawn over a mount that kept its signature is a notice the panel will never
  // replace: the next Snapshot matches, the panel returns early, and the reader is stranded on a
  // failure for a board that draws perfectly well. `domain.js` clears its own signature in its
  // own failure path for exactly this reason; this is a second failure path into the same mount.
  //
  // A live board sends the same Snapshot repeatedly, so "the frame I already drew" is the
  // ordinary next frame rather than a contrived one.
  const snapshot = {
    roots: [{ label: 'alpha', adrs: [{ number: 2, title: 'Two', path: 'docs/adr/0002-two.md' }] }],
  };
  const doc = boardDocument();
  const mount = doc.getElementById(DOMAIN_PANEL.mount);
  assert.ok(mount !== null);

  renderDomain(doc as never, null as never, snapshot as never);
  assert.equal(mount.querySelectorAll('.dom-adr').length, 1, 'the first frame drew no ledger');
  assert.notEqual(mount.getAttribute('data-domain-sig'), null, 'the panel recorded no rebuild key');

  drawPanel(doc as never, DOMAIN_PANEL, () => {
    throw new Error('something after the panel threw');
  });
  assert.ok(mount.querySelector('.panelfail') !== null, 'the guard did not draw its notice');
  assert.equal(
    mount.getAttribute('data-domain-sig'),
    null,
    'the notice kept the key describing the frame it replaced, so the panel will skip its own retry',
  );

  // The same Snapshot again. It has to draw, which is the whole property.
  renderDomain(doc as never, null as never, snapshot as never);
  assert.equal(mount.querySelector('.panelfail'), null, 'the panel stayed on a notice it could have replaced');
  assert.equal(mount.querySelectorAll('.dom-adr').length, 1, 'the panel did not redraw its ledger');

  // And the field really does describe the panel it names, rather than being an invented string.
  for (const [name, guard] of GUARDS) {
    if (guard.rebuildKey === null) continue;
    assert.ok(
      source(`${name}.js`).includes(guard.rebuildKey),
      `ui/${name}.js does not use ${guard.rebuildKey}, so the guard clears an attribute nothing sets`,
    );
  }
});

/** A mount that will not take a text assignment, so even the last resort has nowhere to go. */
class UnwritableMount extends FakeElement {
  override get textContent(): string {
    return super.textContent;
  }

  override set textContent(_text: string) {
    throw new Error('this mount refuses a text assignment');
  }
}

test('when nothing can be written, the panel keeps its old frame rather than going empty', () => {
  // The rule the build order rests on, and the only case that can see it. Every node the notice
  // needs is built detached and the mount is written last, so a document that fails half way
  // through leaves whatever the panel had rather than an emptied mount - and an empty mount is
  // not "nothing was said", it is all three of these panels saying there is nothing to show.
  //
  // With the text fallback in place this is invisible unless the fallback fails too, which is
  // why the mount below refuses a text assignment. Otherwise, clearing the mount at the top of
  // the notice changes no observable answer once the fallback exists.
  const doc = boardDocument();
  const original = doc.getElementById(DOMAIN_PANEL.mount);
  assert.ok(original !== null);
  original.remove();

  const mount = new UnwritableMount('section');
  mount.id = DOMAIN_PANEL.mount;
  mount.className = 'section panelmount';
  const previous = doc.createElement('p');
  previous.className = 'previous-frame';
  previous.textContent = 'what the panel drew last time';
  mount.appendChild(previous);
  doc.root.appendChild(mount);

  const useless = {
    getElementById: (id: string): FakeElement | null => doc.getElementById(id),
    createElement: (): never => {
      throw new Error('this document can build nothing at all');
    },
  };

  assert.equal(
    drawPanel(useless as never, DOMAIN_PANEL, () => {
      throw new Error('boom');
    }),
    undefined,
    'the guard threw when it had nowhere at all to report',
  );
  assert.ok(
    mount.querySelector('.previous-frame') !== null,
    'the guard emptied a mount it then could not write into, which is this panel claiming the repository has no ADRs',
  );

  // The canary: the same refusing mount, with a document that CAN build, still gets the notice -
  // so the assertion above is about the last-resort path rather than about a mount nothing works
  // on. `replaceChildren` is not a text assignment, which is why the structured notice survives.
  drawPanel(doc as never, DOMAIN_PANEL, () => {
    throw new Error('boom');
  });
  assert.ok(mount.querySelector('.panelfail') !== null, 'the structured notice never reaches this mount either');
});

test('the guard is total, so the panel after it and the focus restore always run', () => {
  // `board.js` calls the three in sequence and restores the focused card afterwards. A card that
  // changes Lane is moved rather than rebuilt, and moving a node blurs it, so that restore is
  // what keeps the reader's place - and losing it to somebody else's panel is the failure a
  // reader actually feels.
  const doc = boardDocument();
  const ran: string[] = [];
  drawPanel(doc as never, CORRECTIONS_PANEL, () => {
    ran.push('corrections');
  });
  drawPanel(doc as never, DIGEST_PANEL, () => {
    ran.push('digest');
    throw new Error('the AI layer could not be read');
  });
  drawPanel(doc as never, DOMAIN_PANEL, () => {
    ran.push('domain');
  });
  ran.push('focus restore');

  assert.deepEqual(ran, ['corrections', 'digest', 'domain', 'focus restore']);
  // `?? null` rather than a bare `!== null`: an absent mount makes the optional chain
  // `undefined`, which is also `!== null`, so the assertion would pass on a document that never
  // had a digest panel at all.
  assert.ok(
    (doc.getElementById('digest-panel')?.querySelector('.panelfail') ?? null) !== null,
    'the failure was absorbed',
  );
  for (const id of ['corrections-panel', 'domain-panel']) {
    assert.equal(
      doc.getElementById(id)?.querySelector('.panelfail') ?? null,
      null,
      `a throw in the Digest panel wrote a failure into #${id}`,
    );
    assert.equal(doc.getElementById(id)?.childNodes.length, 0, `a throw in the Digest panel touched #${id}`);
  }
});

test('the guard survives a document that cannot answer, and an error that cannot be read', () => {
  // Everything here reaches the guard from outside this process: the document is whatever the
  // browser gives it, and the thrown value came from evaluating a Snapshot off a socket. A guard
  // that threw on any of them would cost the reader the focus restore it exists to protect.
  const missing = { getElementById: (): null => null, createElement: (): never => { throw new Error('no'); } };
  assert.equal(
    drawPanel(missing as never, DOMAIN_PANEL, () => {
      throw new Error('boom');
    }),
    undefined,
    'the guard threw when the mount was absent',
  );

  const doc = boardDocument();
  const brittle = {
    getElementById: (id: string): FakeElement | null => doc.getElementById(id),
    createElement: (tag: string): FakeElement => {
      if (tag === 'h2') throw new Error('this document cannot build a heading');
      return doc.createElement(tag);
    },
  };
  const mount = mountWithStaleFrame(doc, DOMAIN_PANEL.mount);
  assert.equal(
    drawPanel(brittle as never, DOMAIN_PANEL, () => {
      throw new Error('boom');
    }),
    undefined,
    'the guard threw when the document could not build the notice',
  );
  // And it did not leave the previous frame standing as though it were current. A document that
  // cannot build an element can still take a string, so the failure is stated in text rather
  // than left implicit in stale content - see the text-only fallback test below.
  assert.equal(mount.querySelector('.previous-frame'), null, 'the stale frame was left looking current');
  assert.match(mount.textContent, /could not be drawn from the current Snapshot/);

  // A thrown value whose own `toString` throws - a revoked Proxy is the shape that reaches this
  // on a real board - still produces the notice rather than taking it out.
  const unreadable = new Proxy({}, { get: (): never => { throw new Error('revoked'); } });
  const third = boardDocument();
  drawPanel(third as never, CORRECTIONS_PANEL, () => {
    throw unreadable;
  });
  const notice = third.getElementById('corrections-panel')?.querySelector('.panelfail') ?? null;
  assert.ok(notice !== null, 'an error that could not be described took the notice down with it');
  assert.match(notice.textContent, /the reason could not be read either/);
  assert.ok(notice.textContent.includes(CORRECTIONS_PANEL.absent), 'the notice lost the absence it denies');
});

test('the notice lands in the mount that is on the page, not the one that was', () => {
  // Describing the thrown value runs code this process does not own: it came out of evaluating a
  // Snapshot that arrived as JSON off a socket, and `String` calls its `toString`. A hostile
  // `toString` can swap the panel's mount out of the document while it runs, after which a guard
  // that had already resolved the mount would write its notice into the
  // detached old node, and the live mount stayed EMPTY. Empty is the one thing this notice exists
  // to avoid, so the coercion happens before the mount is resolved.
  const doc = boardDocument();
  const original = doc.getElementById(DOMAIN_PANEL.mount);
  assert.ok(original !== null);

  const replacement = doc.createElement('section');
  replacement.className = 'section panelmount';
  const hostile = {
    toString: (): string => {
      original.remove();
      replacement.id = DOMAIN_PANEL.mount;
      doc.root.appendChild(replacement);
      return 'a reason that rearranged the document while it was read';
    },
  };

  drawPanel(doc as never, DOMAIN_PANEL, () => {
    throw hostile;
  });

  assert.equal(doc.getElementById(DOMAIN_PANEL.mount), replacement, 'the probe did not actually swap the mount');
  assert.ok(
    replacement.querySelector('.panelfail') !== null,
    'the notice went into the detached mount, so the panel on the page is silently empty',
  );
  assert.equal(original.querySelector('.panelfail'), null, 'the notice was written into a node that left the page');
  assert.match(replacement.textContent, /rearranged the document while it was read/);
});

test('a document that cannot build the notice still states it, in text', () => {
  // The gap between "could not draw" and "said nothing": a panel can clear its own mount on the
  // way to throwing - `digest.js` does exactly that when it rebuilds its frame - and if the
  // notice then cannot be BUILT, a guard that gave up would leave that empty mount behind
  // claiming this board has no Digests. A property assignment asks nothing of the document that
  // element construction does, so it is what the last resort uses.
  const doc = boardDocument();
  const mount = doc.getElementById(DIGEST_PANEL.mount);
  assert.ok(mount !== null);
  mount.setAttribute('aria-labelledby', 'a-heading-from-a-previous-frame');

  const brittle = {
    getElementById: (id: string): FakeElement | null => doc.getElementById(id),
    createElement: (): never => {
      throw new Error('this document can build nothing at all');
    },
  };

  drawPanel(brittle as never, DIGEST_PANEL, () => {
    // The panel clears its own mount and then fails, which is the sequence that makes silence
    // a false claim rather than a withheld one.
    mount.replaceChildren();
    throw new Error('the panel cleared its mount and then threw');
  });

  assert.notEqual(mount.textContent, '', 'the mount was left empty, which is this panel saying there are no Digests');
  assert.match(mount.textContent, /Two liveness tiers/, 'the text does not say which panel this is');
  assert.match(mount.textContent, /could not be drawn from the current Snapshot/);
  assert.ok(mount.textContent.includes(DIGEST_PANEL.absent), 'the text does not say which absence this is not');
  assert.equal(
    mount.getAttribute('aria-labelledby'),
    null,
    'the region still names a heading that is no longer in it',
  );

  // The canary: the same guard on a document that CAN build gives the structured notice, so the
  // text-only path above is a fallback rather than the only thing this guard ever does.
  const healthy = boardDocument();
  drawPanel(healthy as never, DIGEST_PANEL, () => {
    throw new Error('boom');
  });
  assert.ok(
    (healthy.getElementById(DIGEST_PANEL.mount)?.querySelector('.panelfail') ?? null) !== null,
    'the structured notice is gone, so the fallback is all there is',
  );
});

test('board.js runs every panel through the guard, and restores focus after all three', () => {
  // The runtime tests above are about `drawPanel`. This is the other half: that `board.js`
  // actually uses it, on all three, and that the focus restore is downstream of them. A bare
  // sequence would pass every one of those tests while shipping the defect.
  const entry = source('board.js');
  // Comments only. `stripNoise` also blanks string literals, which is why the import below is
  // asserted against the raw source rather than against this.
  const live = stripNoise(entry.replace(/\/\/[^\n]*/g, ' '));
  for (const [call, guard] of [
    ['renderCorrections', 'CORRECTIONS_PANEL'],
    ['renderDigest', 'DIGEST_PANEL'],
    ['renderDomain', 'DOMAIN_PANEL'],
  ] as const) {
    assert.ok(
      new RegExp(`drawPanel\\(doc, ${guard}, \\(\\) => ${call}\\(doc, view, latest\\)\\)`).test(live),
      `board.js calls ${call} outside the guard, so a throw there takes out the panels after it`,
    );
  }
  assert.ok(entry.includes(`from './panels.js'`), 'board.js does not import the guard at all');

  // The restore reads `activeElement` after the panels, not before them. Ordering is the whole
  // property: a restore written above the three calls is not protected by guarding them.
  const guarded = live.lastIndexOf('drawPanel(');
  const restore = live.indexOf('activeElement !== doc.body');
  assert.ok(guarded > 0 && restore > 0, 'board.js no longer guards a panel or no longer restores focus');
  assert.ok(restore > guarded, 'the focus restore runs before the panels, so guarding them protects nothing');
});

const PANELS = [
  ['corrections.css', '#corrections-panel'],
  ['digest.css', '#digest-panel'],
  ['domain.css', '#domain-panel'],
] as const;

test('every selector in a panel stylesheet is scoped to the mount that panel owns', () => {
  // This replaces an assertion that the three panel stylesheets were literally empty. Empty was
  // only ever a stand-in: three panels are written concurrently into three files, and the first
  // legitimate rule in any of them would have turned that assertion red for the other two, in a
  // shared file, for a reason belonging to somebody else's work.
  //
  // Scoping every selector to the panel's mount is what empty was standing in for, and it holds
  // two things at once:
  //
  // 1. The layout-rigidity argument above. Exactly four declarations may set `.board`'s column
  //    count - the base rule and the three folds - and that is only exhaustive if nothing else
  //    can reach the board. Naming `.board` is not the only way in: the board is
  //    `<main class="board" id="board">`, so a bare `main`, a bare `#board` or a bare `*` all
  //    reach it without ever writing `.board`, and this stylesheet's own `* { box-sizing }` is
  //    local precedent telling a panel author a universal selector is normal here. Requiring
  //    the mount id in every selector closes all four routes at once. Inline style, the one
  //    thing that would beat all of them, is refused by the server's CSP.
  // 2. Panel-to-panel interference. Three panels share one document, and an unscoped rule in
  //    one restyles the others. Nothing else caught that case.
  //
  // Media queries are deliberately NOT restricted: the scoping is on the selector, not on the
  // context, so a panel folding its own layout at narrow widths is free to do so. A guard that
  // fails on correct work is a guard that gets weakened.
  //
  // Merely containing the mount id is not enough. These four selectors contain it and reach
  // outside it anyway, and the third is an ordinary thing to write by accident:
  //
  //   :not(#digest-panel)                 selects everything that is NOT the panel
  //   body:has(#digest-panel) main        the mount is only a condition; `main` is the board
  //   #corrections-panel + #digest-panel  styles the NEXT panel, which somebody else owns
  //   body:has(#digest-panel) .bo\61rd    `\61` is `a`, so this is `.board` spelled around a scan
  //
  // `scopeFailure` closes all four by asking where the mount id actually sits rather than
  // whether the text appears: it must be a real part of the selector rather than an argument to
  // a functional pseudo-class, what follows it must be descent into the panel rather than a step
  // sideways out of it, and a selector may not spell anything with escapes.
  for (const [name, mount] of PANELS) {
    const css = source(name);

    // Before believing a single selector: did this parser read the same document a browser reads?
    // A leftover open block means it did not, and every answer below is then about a file nobody
    // has. This is the class-level guard, and it is here because one instance of the class was
    // real - see `stripNoise`.
    assert.equal(
      openBlocksAtEnd(css),
      0,
      `ui/${name} left this checker inside an unclosed block, so its selector list describes ` +
        'a document the browser does not see and cannot be trusted',
    );

    for (const selector of selectorsOf(css)) {
      const why = scopeFailure(selector, mount);
      assert.equal(why, null, `ui/${name} styles \`${selector}\`, which ${String(why)}`);
    }

    // Keyframe names are global and last-definition-wins, so they are the one thing a panel can
    // declare that reaches the whole document while producing no selector at all - the guard
    // above is vacuously happy about it. `board.css` animates the just-changed card tint with
    // `@keyframes settle`, and that tint is the board's entire claim that a card moves when a
    // file moves; a panel redefining `settle` would delete it silently. Three panels written at
    // once can also collide with each other on an obvious name like `fade`.
    const slug = mount.replace('#', '').replace('-panel', '');
    for (const animation of keyframeNamesOf(css)) {
      assert.ok(
        animation.includes(slug),
        `ui/${name} declares @keyframes ${animation}, a global name: prefix it with \`${slug}\` ` +
          'so it cannot replace an animation belonging to board.css or to another panel',
      );
    }

    // The second clause, and it is an allow-list rather than a list of dangerous at-rules -
    // see AT_RULES. A selector-scoped predicate cannot observe an at-rule at all, so every
    // global name one registers escapes it completely.
    for (const prelude of parseCss(css).atRules) {
      const { keyword, names } = atRuleParts(prelude);
      const refused = AT_RULES_REFUSED.get(keyword);
      assert.equal(
        refused,
        undefined,
        `ui/${name} uses @${keyword}, which ${String(refused)}`,
      );
      const kind = AT_RULES.get(keyword);
      assert.ok(
        kind !== undefined,
        `ui/${name} uses @${keyword}, which this checker cannot verify against a shared ` +
          'document. If the panel needs it, add it to AT_RULES deliberately rather than widening ' +
          'this rule',
      );
      if (kind !== 'namespaced') continue;
      assert.notEqual(names.length, 0, `ui/${name} declares an unnamed @${keyword}, which cannot be namespaced`);
      // Every name, not the first: `@layer a, b;` declares two.
      for (const declared of names) {
        assert.ok(
          isNamespaced(declared, slug),
          `ui/${name} declares @${keyword} ${declared}, a document-global name: it must start ` +
            `with \`${slug}-\` so the three panels and board.css cannot collide`,
        );
      }
    }
  }
});

test('scope is decided by where the mount id sits, not by whether its text appears', () => {
  // Every rejected case below is a selector that CONTAINS the mount id and reaches outside it
  // anyway. A rule that asks only `selector.includes(mount)` passes all four.
  const mount = '#digest-panel';
  const accepted = [
    '#digest-panel',
    '#digest-panel .facts',
    '#digest-panel > .facts',
    '#digest-panel .a + .b', // two siblings INSIDE the panel: the step out is what is banned
    '#digest-panel .a ~ .b',
    '#digest-panel:hover .a',
    '#digest-panel .a:is(.b, .c)',
    '#digest-panel:has(.facts) .a', // a condition ON the panel, still styling inside it
    '.x #digest-panel .y', // mount neither first nor last
    'body #digest-panel',
    // Subject-preserving groups. `:where()` is the ordinary way to scope component CSS without
    // adding specificity, so rejecting it is a false failure on correct work.
    ':where(#digest-panel) .facts',
    ':is(#digest-panel) .facts',
    ':is(#digest-panel, #digest-panel.wide) .facts', // every alternative scoped
    ':where(#digest-panel) .a + .b',
    // What nesting resolves to. Three levels deep is ordinary panel CSS, and a flat
    // "is the mount at this alternative's top level" test refuses all of it, which is why the
    // alternative test recurses.
    ':is(:is(#digest-panel) .a) .b',
    ':is(:is(:is(#digest-panel) .a) .b) .c',
    ':is(:is(#digest-panel)) .a',
    // A descendant of the panel is safe whatever else the selector says, because nothing is
    // inside a panel mount - asserted below, since the whole argument leans on it.
    ':is(#digest-panel):has(.x) .board',
  ];
  const rejected: readonly [string, RegExp][] = [
    ['.facts', /not scoped/],
    ['main', /not scoped/],
    ['#board', /not scoped/],
    ['*', /not scoped/],
    ['.board', /not scoped/],
    ['#digest-panel-wide', /not scoped/], // a longer id that merely starts with the mount
    [':not(#digest-panel)', /functional pseudo-class/],
    ['body:has(#digest-panel) main', /functional pseudo-class/],
    ['body:has(#digest-panel) .board', /functional pseudo-class/],
    ['#digest-panel + .x', /steps sideways/],
    ['#digest-panel ~ .x', /steps sideways/],
    ['#digest-panel:hover + .x', /steps sideways/],
    ['#digest-panel:is(.a, .b) + .x', /steps sideways/],
    ['body:has(#digest-panel) .bo\\61rd', /escape/],
    ['#digest-panel .bo\\61rd', /escape/],
    // A subject group is only scoped if EVERY alternative is. One unscoped arm reaches the board.
    [':is(#digest-panel, main)', /functional pseudo-class/],
    [':where(#digest-panel, .board)', /functional pseudo-class/],
    [':where(#digest-panel) + .x', /steps sideways/],
    [':is(#digest-panel) ~ .x', /steps sideways/],
    // Nesting under a list with one unscoped arm, which is what `#digest-panel, main { .a {} }`
    // resolves to. One bad arm poisons the group.
    [':is(#digest-panel, main) .a', /functional pseudo-class/],
    [':is(:is(#digest-panel), .x)', /functional pseudo-class/],
  ];

  // The unstated premise the whole rule rests on, made stated: a selector scoped to a panel is
  // safe because a *descendant* of a panel can never be the board. That is true only while the
  // three mounts are empty containers in the document, so it is asserted rather than assumed -
  // if a panel mount ever wrapped the board, `#digest-panel .board` would start matching and
  // every "descendant is fine" judgement above would silently become wrong.
  const html = source('index.html');
  for (const [, panelMount] of PANELS) {
    const id = panelMount.slice(1);
    assert.match(
      html,
      new RegExp(`id="${id}"\\s*></section>`),
      `the ${id} mount is no longer an empty element, so a panel descendant may now reach the board`,
    );
  }
  assert.match(html, /<main class="board" id="board"[^>]*><\/main>/, 'the board is no longer an empty element');

  for (const selector of accepted) {
    assert.equal(scopeFailure(selector, mount), null, `\`${selector}\` is legitimate panel CSS and was rejected`);
  }
  for (const [selector, why] of rejected) {
    const failure = scopeFailure(selector, mount);
    assert.notEqual(failure, null, `\`${selector}\` reaches outside ${mount} and was accepted`);
    assert.match(String(failure), why, `\`${selector}\` was rejected for the wrong reason`);
  }
});

test('an at-rule that registers a global name is namespaced, and an unlisted one is refused', () => {
  // The generalisation. `@keyframes` was never special - it is one instance of "at-rules that
  // create a document-global name", and every one of them escapes a selector-scoped predicate
  // completely, because a selector-scoped predicate cannot see an at-rule at all.
  //
  // Stated as an allow-list on purpose. Enumerating the dangerous ones is the same mistake as
  // enumerating the ways a selector can reach the board, one level up: CSS grows new at-rules and
  // the list would silently stop being complete.
  const at = (css: string): { keyword: string; names: string[] }[] =>
    parseCss(css).atRules.map(atRuleParts);

  assert.deepEqual(at('@keyframes digest-fade { from { opacity: 0 } }'), [
    { keyword: 'keyframes', names: ['digest-fade'] },
  ]);
  assert.deepEqual(at('@property --digest-x { syntax: "*"; inherits: false; }'), [
    { keyword: 'property', names: ['--digest-x'] },
  ]);
  assert.deepEqual(at('@counter-style digest-dots { system: cyclic; }'), [
    { keyword: 'counter-style', names: ['digest-dots'] },
  ]);
  assert.deepEqual(at('@layer digest-base { #digest-panel { color: red; } }'), [
    { keyword: 'layer', names: ['digest-base'] },
  ]);
  // Statement forms open no block at all, so a brace-driven reader never sees them.
  // The name reads `""` because strings are stripped before parsing. Only the keyword decides a
  // refusal, so that costs nothing - and it is asserted rather than glossed over.
  assert.deepEqual(at('@import "other.css";'), [{ keyword: 'import', names: ['""'] }]);
  assert.deepEqual(at('@layer a, b;'), [{ keyword: 'layer', names: ['a', 'b'] }], 'a layer list must yield every name');
  assert.deepEqual(at('@media (max-width: 780px) { .a { color: red; } }'), [
    { keyword: 'media', names: ['(max-width:'] },
  ]);
  assert.deepEqual(at('#digest-panel { color: red; }'), [], 'an ordinary rule is not an at-rule');

  // Every keyword named in either table is spelled the way `atRuleParts` reports it, or the
  // guard silently permits something it believes it is refusing.
  for (const keyword of [...AT_RULES.keys(), ...AT_RULES_REFUSED.keys()]) {
    assert.equal(atRuleParts(`@${keyword} name { }`).keyword, keyword, `@${keyword} does not round-trip`);
  }
  // And the two tables are disjoint: a keyword in both would make the outcome depend on order.
  for (const keyword of AT_RULES.keys()) {
    assert.equal(AT_RULES_REFUSED.has(keyword), false, `@${keyword} is both allowed and refused`);
  }

  // The positive control for this clause: board.css really does use the at-rules this rule
  // reasons about, so the tables are describing a real language and not an imagined one.
  const boardKeywords = new Set(parseCss(source('board.css')).atRules.map((rule) => atRuleParts(rule).keyword));
  assert.ok(boardKeywords.has('media'), 'board.css declares no @media, so `transparent` is untested');
  assert.ok(boardKeywords.has('keyframes'), 'board.css declares no @keyframes, so `namespaced` is untested');
});

test('a panel may not declare a global keyframe name', () => {
  // Keyframes produce no selector, so the scope guard is vacuously happy about them, and the
  // name is global with the last definition winning. `board.css` animates the just-changed card
  // tint with `@keyframes settle` - the board's only motion, and the whole of its claim that a
  // card moves when a file moves.
  assert.deepEqual(keyframeNamesOf('@keyframes settle { from { opacity: 0 } }'), ['settle']);
  assert.deepEqual(keyframeNamesOf('@-webkit-keyframes digest-fade{from{opacity:0}}'), ['digest-fade']);
  assert.deepEqual(keyframeNamesOf('/* @keyframes settle */ #digest-panel { color: red; }'), []);
  assert.deepEqual(keyframeNamesOf(''), []);

  // The positive control: board.css really does declare the name this rule exists to protect.
  assert.ok(
    keyframeNamesOf(source('board.css')).includes('settle'),
    'board.css no longer declares @keyframes settle, so this guard is protecting nothing',
  );
});

test('the selector extractor survives the three at-rule shapes this stylesheet already contains', () => {
  // The guard above is a checker, and a checker that quietly returns nothing reports every file
  // as perfectly scoped, for ever. All three shapes below occur in board.css, so none of
  // them is hypothetical, and a line-oriented or brace-counting check misreads each one.
  const cases: readonly [string, string, string[]][] = [
    ['an empty file', '', []],
    ['comments only', '/* nothing but prose { .board } */', []],
    ['a plain rule', '#digest-panel .facts { color: red; }', ['#digest-panel .facts']],
    [
      'a multi-line at-rule wrapper, whose prelude is not a selector',
      '@media (max-width: 780px) {\n  #digest-panel .facts { display: block; }\n}',
      ['#digest-panel .facts'],
    ],
    [
      'a single-line at-rule, where the query and its rule share one line',
      '@media (max-width: 900px) { .board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }',
      ['.board'],
    ],
    [
      'keyframes, whose stops are not selectors and can never carry a mount id',
      '@keyframes panelfade { from { opacity: 0 } to { opacity: 1 } 50% { opacity: 0.5 } }\n#domain-panel b { color: red; }',
      ['#domain-panel b'],
    ],
    [
      'a comma-separated list, where only the first selector is scoped',
      '#digest-panel .a, .b { color: red; }',
      ['#digest-panel .a', '.b'],
    ],
    [
      'a rule wrapped in comments, and a selector that exists only inside one',
      '/* before { .hidden } */ #domain-panel .x { color: red; } /* after { .alsohidden } */',
      ['#domain-panel .x'],
    ],
    [
      'a descendant combinator where the mount id is neither first nor last',
      '.x #digest-panel .y { color: red; }',
      ['.x #digest-panel .y'],
    ],
    [
      'commas inside :is(), which separate arguments and not selectors',
      '#digest-panel .a:is(.b, .c) { color: red; }',
      ['#digest-panel .a:is(.b, .c)'],
    ],
    [
      'commas inside :not() and inside an attribute value, in a real list',
      '#domain-panel :not(.a, .b), #domain-panel [data-k="x,y"] { color: red; }',
      ['#domain-panel :not(.a, .b)', '#domain-panel [data-k=""]'],
    ],
    [
      'declarations, which precede no brace and are never selectors',
      '#domain-panel { color: red; font-weight: 700; }',
      ['#domain-panel'],
    ],
    [
      'a brace inside a quoted value',
      '#domain-panel::after { content: "{"; }',
      ['#domain-panel::after'],
    ],
    [
      'a comment opener inside a quoted value, which two passes would swallow the file on',
      '#domain-panel::after { content: "/*"; }\nmain { color: red; }\n#domain-panel b { content: "*/"; }',
      ['#domain-panel::after', 'main', '#domain-panel b'],
    ],
    [
      'a string continued across a backslash-newline, which hid a top-level #board rule outright',
      '#digest-panel::before { content: "a\\\n; @keyframes digest-z { .x {"; }\n#board { color: red; }',
      ['#digest-panel::before', '#board'],
    ],
    [
      'a nested rule, resolved against the selector it sits inside rather than judged alone',
      '#digest-panel { color: red; .facts { color: blue; } }',
      ['#digest-panel', ':is(#digest-panel) .facts'],
    ],
    [
      'a nested rule written with an explicit &',
      '#digest-panel { &.wide { color: red; } }',
      ['#digest-panel', ':is(#digest-panel).wide'],
    ],
    [
      'nesting two deep, so the resolution is not just one level',
      '#digest-panel { .a { .b { color: red; } } }',
      ['#digest-panel', ':is(#digest-panel) .a', ':is(:is(#digest-panel) .a) .b'],
    ],
    [
      'a nested rule inside a media query, whose at-rule body is transparent to the scope',
      '#digest-panel { @media (max-width: 780px) { .facts { color: red; } } }',
      ['#digest-panel', ':is(#digest-panel) .facts'],
    ],
    [
      // `\{` is escaped identifier content, not a block opener. Counting it as one desynchronised
      // this parser from the browser permanently - and that was a live bypass, not a nicety: it
      // let `#board { grid-template-columns: none }` through while the guard read clean.
      'an escaped delimiter, which is identifier content and opens no block',
      '.a\\{b { color: red; }',
      ['.a\\b'],
    ],
    [
      'the escaped-brace desync that removed the board grid entirely in a real browser',
      '#digest-panel { @media all { @supports \\{ } } #board { grid-template-columns: none; } }',
      ['#digest-panel', '#board'],
    ],
    [
      'an HTML comment delimiter, which CSS ignores and reads straight past',
      '<!-- @import "board.css"; #digest-panel { color: red; }',
      ['#digest-panel'],
    ],
    [
      'statement at-rules, which open no block and would otherwise never be seen',
      '@import "other.css";\n#domain-panel { color: red; }',
      ['#domain-panel'],
    ],
  ];

  for (const [what, css, expected] of cases) {
    assert.deepEqual(selectorsOf(css), expected, `the extractor misread ${what}`);
  }

  // The escaped-brace bypass, asserted as the property rather than the shape: the rule that a
  // browser really applies has to be visible to the scope check.
  const desync = '#digest-panel { @media all { @supports \\{ } } #board { grid-template-columns: none; } }';
  assert.ok(
    selectorsOf(desync).includes('#board'),
    'the escaped-brace stylesheet hides its #board rule again - a browser applies it and drops the grid',
  );
  assert.equal(openBlocksAtEnd(desync), 0, 'the escaped-brace stylesheet no longer parses to balance');
  assert.notEqual(scopeFailure('#board', '#digest-panel'), null, 'a bare #board rule is somehow scoped');

  // An escape still marks the selector as unverifiable, so a selector carrying one is refused
  // whatever else it says.
  assert.notEqual(scopeFailure('.a\\b', '#digest-panel'), null, 'an escaped selector was accepted');
});

test('the selector extractor really reads the stylesheet the exhaustion argument rests on', () => {
  // The positive control. Every assertion in the guard above is of the form "every selector
  // satisfies X", which an extractor returning an empty list satisfies for free on every file.
  // So it is pointed at the one stylesheet whose contents are known, and asked for them.
  const selectors = selectorsOf(source('board.css'));
  assert.ok(selectors.length > 100, `the extractor found ${String(selectors.length)} selectors in board.css`);
  assert.ok(selectors.includes('.board'), 'the extractor cannot see the board rule it exists to protect');

  // Four, and not one fewer: the base rule plus the three folds. Three of those four are written
  // with the query and the rule on a single line, so a line-oriented check finds one. This is
  // the silent-failure mode named above, and this number is what makes it impossible.
  assert.equal(
    selectors.filter((selector) => selector === '.board').length,
    4,
    'the extractor did not find all four .board rules, so it cannot see inside the single-line folds',
  );

  // And it never mistakes an at-rule prelude or a keyframe stop for a selector.
  for (const selector of selectors) {
    assert.ok(!selector.startsWith('@'), `the extractor returned the at-rule prelude \`${selector}\` as a selector`);
    assert.ok(!/^(from|to|\d+%)$/.test(selector), `the extractor returned the keyframe stop \`${selector}\` as a selector`);
  }
  assert.match(source('board.css'), /@keyframes/, 'board.css no longer contains keyframes, so that exclusion is untested here');

  // The balance invariant, on the one file known to be well-formed, and on the shape that broke it.
  assert.equal(openBlocksAtEnd(source('board.css')), 0, 'board.css does not parse to a balanced block stack');
  assert.equal(
    openBlocksAtEnd('#digest-panel::before { content: "a\\\n; @keyframes digest-z { .x {"; }\n#board { color: red; }'),
    0,
    'a string continued across a newline still desynchronises the block stack',
  );
  assert.ok(
    openBlocksAtEnd('#digest-panel { color: red;') > 0,
    'an unclosed block is reported as balanced, so the invariant can never fire',
  );
});

// ---------------------------------------------------------------------------
// The bytes themselves
// ---------------------------------------------------------------------------

test('no shipped browser file carries a control character', () => {
  // Not a hypothetical. The editor used on this project has substituted a NUL for a space four
  // times, and substituted U+0001 and U+0002 for empty strings in this very directory. Both
  // are invisible in every normal view of the source, and `grep` bails to binary mode on a NUL
  // and reports nothing at all - so this reads the codepoints itself.
  let scanned = 0;
  for (const name of SHIPPED) {
    const text = source(name);
    scanned += 1;
    [...text].forEach((char, index) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return;
      assert.ok(
        code >= 0x20,
        `ui/${name} carries U+${code.toString(16).toUpperCase().padStart(4, '0')} at offset ${String(index)}`,
      );
    });
  }
  assert.ok(scanned >= 10, 'the scan examined almost nothing, so it proves nothing');
});

test('every non-ASCII codepoint in a shipped file is a glyph the board means to draw', () => {
  // A Cyrillic homoglyph was substituted for an ASCII word once on this project and read
  // identically. An allow-list of ranges catches that; an eyeball does not.
  const allowed: readonly [number, number, string][] = [
    [0x00a0, 0x00bf, 'Latin-1 punctuation: the middle dot in a short Ticket id'],
    [0x2010, 0x203a, 'General punctuation: em dash, quotes'],
    [0x2190, 0x21ff, 'Arrows'],
    [0x2200, 0x22ff, 'Mathematical operators: the circled Lane glyphs'],
    [0x25a0, 0x25ff, 'Geometric shapes: the triangle, diamond, half-circle and dotted circle'],
    [0x2700, 0x27bf, 'Dingbats: the check mark'],
  ];

  const found = new Map<number, string[]>();
  for (const name of SHIPPED) {
    for (const char of source(name)) {
      const code = char.codePointAt(0) ?? 0;
      if (code <= 0x7e) continue;
      const seen = found.get(code) ?? [];
      if (!seen.includes(name)) seen.push(name);
      found.set(code, seen);
    }
  }

  for (const [code, files] of found) {
    const range = allowed.find(([low, high]) => code >= low && code <= high);
    assert.ok(
      range !== undefined,
      `U+${code.toString(16).toUpperCase().padStart(4, '0')} in ${files.join(', ')} is outside every range the board draws from`,
    );
  }
});

// ---------------------------------------------------------------------------

/**
 * Every selector a stylesheet declares, one per entry, with at-rule preludes and keyframe stops
 * left out and comma-separated lists split apart.
 *
 * It parses rather than scans, because all three shapes that defeat a scan are already in
 * `board.css`: an `@media` prelude is not a selector but is followed by a brace; a `@keyframes`
 * block's `from`, `to` and percentage stops are not selectors and can never carry a mount id;
 * and three of the four `.board` rules put the query and the rule on one line, so a
 * line-oriented reader misses exactly the declarations the layout argument rests on - silently,
 * while still reporting a pass.
 *
 * Comments and quoted strings are removed in one pass, by a single alternation, so whichever
 * opens first wins. Two passes - comments, then strings - is not the same thing and is not safe:
 * a stylesheet containing `content: "/*"` ... `content: "*\/"` would have everything between the
 * two swallowed as a comment, including an unscoped rule.
 */
function stripNoise(css: string): string {
  const withoutNoise = css.replace(
    // `\\[\s\S]`, not `\\.`, because `.` does not match a newline and CSS lets a quoted string
    // continue across a backslash-newline. Missing that form leaves the string body in the text,
    // and an unbalanced `{` inside it desynchronises the block stack below from the browser's -
    // measured, not theorised: a stylesheet whose string carried `@keyframes z { .x {` hid a
    // top-level `#board { grid-template-columns: repeat(2, ...) }` from this checker completely,
    // and a real browser drew the board at two columns while the guard stayed green.
    /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g,
    (match) => (match.startsWith('/*') ? ' ' : '""'),
  );
  // Order matters and is the whole correctness of this function. Strings and comments go first,
  // because an escape inside a string belongs to the string - neutralising `\"` before the string
  // pattern ran would leave the quote unterminated and lose the rest of the file. Only then are
  // the escapes that remain, which are all in selectors and preludes, made structurally inert.
  return neutraliseEscapes(stripCdo(withoutNoise));
}

/**
 * Remove the HTML-comment delimiters, which CSS tokenises as CDO and CDC and ignores at the top
 * level of a stylesheet.
 *
 * They are not decoration: a browser skips `<!--` and reads what follows as ordinary CSS, so
 * `<!-- @import "board.css";` imports. A reader that only asks whether a statement *starts with*
 * `@` sees `<!-- @import ...` and records nothing at all.
 */
function stripCdo(css: string): string {
  return css.replace(/<!--|-->/g, ' ');
}

/**
 * Replace every CSS escape with a bare backslash.
 *
 * `\{` is escaped identifier content, not the start of a block - so a brace-driven reader that
 * counts it opens a block the browser never opened, and from there its idea of the document
 * diverges permanently. Measured, not argued: `#digest-panel { @media all { @supports \{ } }
 * #board { grid-template-columns: none; } }` passed every clause of this guard, balance included,
 * while a real browser applied `#board` at top level and the board lost its grid entirely.
 *
 * A bare backslash is left behind rather than nothing, deliberately: it carries no structural
 * meaning, and it keeps `scopeFailure`'s refusal of escaped selectors able to see that an escape
 * was there. The replacement is one-for-one and left to right, so `\\{` - an escaped backslash
 * followed by a real brace - correctly keeps its brace.
 */
function neutraliseEscapes(css: string): string {
  return css.replace(/\\[\s\S]/g, '\\');
}

/**
 * Every `@keyframes` name a stylesheet declares.
 *
 * Keyframe names are global and the last definition wins, so they are the one thing a panel
 * stylesheet can declare that reaches the entire document while producing no selector at all.
 */
function keyframeNamesOf(css: string): string[] {
  return [...stripNoise(css).matchAll(/@(?:-[a-z]+-)?keyframes\s+([^{\s]+)/gi)].map(
    (match) => match[1] ?? '',
  );
}

/**
 * At-rules a panel stylesheet may use, and what the checker requires of each.
 *
 * **This is an allow-list, and the shape is the point.** Merely excluding `@keyframes` from the
 * selector check would let a panel redefine `board.css`'s `settle` animation while passing
 * cleanly. Replacing that with a list of
 * *dangerous* at-rules would repeat the mistake one level up: a guard written by enumerating the
 * ways in is only ever as good as the list, and CSS grows new at-rules. So anything not named
 * here is refused, and a future at-rule is refused until somebody decides about it deliberately.
 *
 * `transparent` - a conditional group whose body is ordinary rules. The parser walks into it and
 * every selector inside is scope-checked already, so the at-rule adds no reach of its own.
 *
 * `namespaced` - registers a name in a document-global namespace shared by all four stylesheets.
 * Permitted, but the name must carry the panel's slug or it can collide with `board.css` or with
 * another panel.
 */
const AT_RULES = new Map<string, 'transparent' | 'namespaced'>([
  ['media', 'transparent'],
  ['supports', 'transparent'],
  ['container', 'transparent'],
  ['keyframes', 'namespaced'],
  ['-webkit-keyframes', 'namespaced'],
  ['property', 'namespaced'],
  ['counter-style', 'namespaced'],
  ['layer', 'namespaced'],
]);

/**
 * Refused deliberately, with the reason, so the message teaches instead of just failing:
 *
 * - `@import` pulls in a stylesheet the asset allow-list never authorised. The `url(` ban
 *   elsewhere in this file catches `@import url(...)` but **not** the bare-string form.
 * - `@font-face` registers a global `font-family` name from a descriptor rather than its
 *   prelude, so it cannot be checked the way the others are - and with `url(` already banned a
 *   panel cannot load a font anyway, leaving name hijacking as the only thing it could do.
 * - `@page`, `@namespace` and `@charset` are document-wide by definition and no panel needs one.
 *
 * Anything absent from both tables is refused by the same rule, which is what makes this
 * closed rather than a list of things somebody happened to think of.
 */
const AT_RULES_REFUSED = new Map<string, string>([
  ['import', 'pulls in a stylesheet the asset allow-list never authorised'],
  ['font-face', 'registers a global font-family name that this checker cannot see'],
  ['page', 'styles the printed page document-wide, which is not a panel concern'],
  ['namespace', 'declares a document-global namespace prefix'],
  ['charset', 'is a document-wide declaration and belongs to no panel'],
]);

/**
 * The at-rule keyword and every name it declares.
 *
 * `names` is a list because `@layer digest-base, domain-base;` declares two, and checking only
 * the first registers the second globally unchecked.
 */
function atRuleParts(prelude: string): { keyword: string; names: string[] } {
  const match = /^@([\w-]+)([\s\S]*)$/.exec(prelude);
  const keyword = (match?.[1] ?? '').toLowerCase();
  const names = splitList(match?.[2] ?? '')
    .map((entry) => entry.trim().split(/\s+/)[0] ?? '')
    .filter((entry) => entry !== '');
  return { keyword, names };
}

/**
 * A document-global name a panel is allowed to register: `<slug>-something`, or
 * `--<slug>-something` for the custom properties `@property` declares.
 *
 * A strict **prefix**, not containment. `@keyframes digest-domain-fade` contains both `digest`
 * and `domain`, so a containment test let the same global name pass in two different panel
 * stylesheets - and then whichever loaded last owned the animation in both. Prefixes make the
 * three namespaces disjoint by construction, which is stronger than checking for collisions
 * after the fact and needs no cross-file bookkeeping.
 */
function isNamespaced(name: string, slug: string): boolean {
  return name.startsWith(`${slug}-`) || name.startsWith(`--${slug}-`);
}

/**
 * Why `selector` is not scoped to `mount`, or `null` when it is.
 *
 * Three questions close the bypasses left by asking only whether the mount id appears in the
 * text:
 *
 * 1. **Is it spelled plainly?** `.bo\61rd` is `.board`, and `\` can spell anything, so a panel
 *    selector may not contain one. No legitimate panel rule needs an escape.
 * 2. **Is the mount a real part of the selector?** `:not(#digest-panel)` and
 *    `body:has(#digest-panel) main` both contain the mount id as an *argument* to a functional
 *    pseudo-class - a condition on some other element, which is then the thing being styled. The
 *    mount has to appear at the top level, outside every bracket.
 * 3. **Does what follows go inward?** `#corrections-panel + #digest-panel` steps sideways to the
 *    next panel, which somebody else owns. Descendant and child combinators go into the panel;
 *    the sibling combinators leave it. This is the one of the three that is an ordinary thing to
 *    write by accident - a panel nudging the spacing of the panel below it - which is exactly
 *    why it matters.
 */
function scopeFailure(selector: string, mount: string): string | null {
  if (selector.includes('\\')) {
    return 'contains a CSS escape, and an escape can spell any selector at all';
  }
  const at = tokenIndexOf(selector, mount, true);
  if (at === -1) {
    // `:where(#digest-panel) .facts` and `:is(#digest-panel) .facts` select exactly what
    // `#digest-panel .facts` selects, and `:where()` is the ordinary way to scope component CSS
    // without adding specificity - so rejecting them is a predictable false failure on correct
    // work, which is how a guard gets weakened wholesale. They are accepted only when EVERY
    // alternative in the group is itself scoped, so `:is(#digest-panel, main)` still fails.
    //
    // `:not()` and `:has()` stay rejected and are not an oversight: neither constrains the
    // subject to the mount. `:not(#digest-panel)` selects everything that is not the panel, and
    // `body:has(#digest-panel) main` styles the board on the mere condition that a panel exists.
    const group = subjectGroup(selector, mount);
    if (group !== null) {
      const after = combinatorAfter(selector, group.end);
      // A sibling of a *strict descendant* of the mount is still inside the mount:
      // `#digest-panel .row { & + .row { ... } }` resolves to `:is(#digest-panel .row) + .row`,
      // which is ordinary spacing between two rows of the panel's own content. Only a sibling of
      // the mount ITSELF leaves it. Rejecting both was a false positive on very likely work.
      const leaves =
        (after === '+' || after === '~') &&
        group.alternatives.some((alternative) => mountIsSubject(alternative, mount));
      return leaves
        ? `steps sideways out of ${mount} to a sibling, which is another panel or the board`
        : null;
    }
    // Told apart deliberately, because the two are different mistakes: a selector that names the
    // mount inside `:not()` or `:has()` looks scoped and is not, while `#digest-panel-wide` is
    // simply a different id that happens to start with the same text.
    return tokenIndexOf(selector, mount, false) === -1
      ? `is not scoped to ${mount}, so it can reach the board or another panel`
      : `names ${mount} only inside a functional pseudo-class, so it styles something else`;
  }
  const combinator = combinatorAfter(selector, at + mount.length);
  if (combinator === '+' || combinator === '~') {
    return `steps sideways out of ${mount} to a sibling, which is another panel or the board`;
  }
  return null;
}

/**
 * The index just past a top-level `:is(...)` or `:where(...)` whose every alternative is scoped
 * to `mount`, or -1 when there is no such group.
 *
 * Only these two are subject-preserving: whatever they match, the element selected is the one they
 * are attached to. That is what makes `:where(#digest-panel) .facts` identical to
 * `#digest-panel .facts`, and it is what `:not()` and `:has()` do not do.
 */
function subjectGroup(
  selector: string,
  mount: string,
): { end: number; alternatives: string[] } | null {
  const pattern = /:(is|where)\(/gi;
  for (const match of selector.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    if (bracketDepthAt(selector, match.index ?? 0) !== 0) continue;

    let depth = 0;
    let close = -1;
    for (let index = open; index < selector.length; index += 1) {
      const char = selector[index];
      if (char === '(' || char === '[') depth += 1;
      else if (char === ')' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close === -1) continue;
    const alternatives = splitList(selector.slice(open + 1, close));
    if (alternatives.length === 0) continue;
    // Recursive, because an alternative can itself be a subject group. Nesting three deep
    // resolves to `:is(:is(:is(#p) .a) .b) .c`, and a flat "is the mount at this alternative's
    // top level" test rejects it - correct work, refused. Each step strips one bracket layer, so
    // the recursion is strictly decreasing and terminates.
    if (alternatives.every((alternative) => scopeFailure(alternative, mount) === null)) {
      return { end: close + 1, alternatives };
    }
  }
  return null;
}

/**
 * Whether the mount is the thing this selector *selects*, rather than an ancestor of it.
 *
 * `#digest-panel` and `:is(#digest-panel)` select the panel; `#digest-panel .row` selects a row
 * inside it. The difference decides whether a following sibling combinator leaves the panel or
 * stays within it.
 */
function mountIsSubject(selector: string, mount: string): boolean {
  const at = tokenIndexOf(selector, mount, true);
  if (at !== -1) return combinatorAfter(selector, at + mount.length) === '';
  const group = subjectGroup(selector, mount);
  if (group === null) return false;
  return (
    combinatorAfter(selector, group.end) === '' &&
    group.alternatives.some((alternative) => mountIsSubject(alternative, mount))
  );
}

/** Bracket nesting immediately before `index`. */
function bracketDepthAt(selector: string, index: number): number {
  let depth = 0;
  for (let scan = 0; scan < index; scan += 1) {
    const char = selector[scan];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * Where `needle` appears as a whole token, or -1.
 *
 * With `topLevelOnly`, only outside every bracket - which is what tells a selector that IS the
 * mount from one that merely mentions it as an argument to a functional pseudo-class.
 */
function tokenIndexOf(selector: string, needle: string, topLevelOnly: boolean): number {
  let depth = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if ((topLevelOnly && depth !== 0) || !selector.startsWith(needle, index)) continue;
    // Not a prefix of a longer id: `#digest-panel` must not match `#digest-panel-wide`.
    if (!/[\w-]/.test(selector[index + needle.length] ?? '')) return index;
  }
  return -1;
}

/**
 * The combinator that follows the compound selector starting at `from`: `>`, `+`, `~`, a space
 * for descendant, or `''` at the end of the selector.
 *
 * The compound is consumed first, so `#digest-panel:is(.a, .b) + .x` is read as a sibling step
 * and `#digest-panel .a + .b` - two siblings *inside* the panel - is read as a descendant one.
 */
function combinatorAfter(selector: string, from: number): string {
  let depth = 0;
  let index = from;
  for (; index < selector.length; index += 1) {
    const char = selector[index] ?? '';
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s>+~]/.test(char)) break;
  }
  const rest = selector.slice(index).trimStart();
  if (rest === '') return '';
  const next = rest[0] ?? '';
  return next === '>' || next === '+' || next === '~' ? next : ' ';
}
function selectorsOf(css: string): string[] {
  return parseCss(css).selectors;
}

/**
 * The block stack this parser ends on.
 *
 * Zero means every block it opened was closed, which is the only state in which its answer can be
 * trusted. Anything else means the text it read was not the text a browser reads - a lexer gap, a
 * malformed file - and the selector list is then a description of a document nobody has. Asserted
 * separately from the scope rule because it catches the whole class rather than one instance: the
 * string-continuation bypass above left this at 2 while reporting a perfectly scoped stylesheet.
 */
function openBlocksAtEnd(css: string): number {
  return parseCss(css).openAtEnd;
}

function parseCss(css: string): { selectors: string[]; atRules: string[]; openAtEnd: number } {
  const text = stripNoise(css);
  const found: string[] = [];
  const atRules: string[] = [];
  /** One frame per open block. `scope` is null for at-rule bodies, which are transparent. */
  const open: { keyframes: boolean; scope: string | null }[] = [];
  let buffer = '';

  const enclosing = (): string | null => {
    for (let index = open.length - 1; index >= 0; index -= 1) {
      const scope = open[index]?.scope;
      if (scope !== null && scope !== undefined) return scope;
    }
    return null;
  };

  for (const char of text) {
    if (char === ';') {
      // A statement, not a block - `@import "x";` and `@layer a, b;` never open one, so they
      // would otherwise never be seen at all.
      const statement = buffer.trim();
      if (statement.startsWith('@')) atRules.push(statement);
      buffer = '';
      continue;
    }
    if (char === '}') {
      buffer = '';
      open.pop();
      continue;
    }
    if (char !== '{') {
      buffer += char;
      continue;
    }
    const prelude = buffer.trim();
    buffer = '';

    if (prelude.startsWith('@')) {
      atRules.push(prelude);
      open.push({ keyframes: /^@(?:-[a-z]+-)?keyframes\b/i.test(prelude), scope: null });
      continue;
    }
    // A stop inside `@keyframes` is not a selector, however deeply the block is nested.
    if (open.some((frame) => frame.keyframes)) {
      open.push({ keyframes: false, scope: null });
      continue;
    }

    // Native CSS nesting. A nested rule is meaningless without the selector it sits inside, so
    // it is resolved against it rather than judged on its own prelude - judging it alone
    // rejected `#digest-panel { .facts { ... } }`, which is correct work.
    //
    // `&` stands for the enclosing selector list, and a nested selector written without one gets
    // an implicit descendant `&`. Both resolve through `:is(...)`, which is exactly what the
    // specification says `&` means and which the subject-group rule in `scopeFailure` already
    // understands - so nesting needed no new scope logic, only resolution.
    const parent = enclosing();
    const resolved = splitList(prelude).map((selector) => {
      if (parent === null) return selector;
      const group = `:is(${parent})`;
      return selector.includes('&') ? selector.split('&').join(group) : `${group} ${selector}`;
    });
    for (const selector of resolved) found.push(selector);
    open.push({ keyframes: false, scope: resolved.join(', ') });
  }
  // End of file terminates an at-rule just as a semicolon does, so a trailing `@import "x"` with
  // no semicolon is a real import. Without this flush the buffer is simply dropped and the
  // at-rule is never seen.
  const trailing = buffer.trim();
  if (trailing.startsWith('@')) atRules.push(trailing);
  return { selectors: found, atRules, openAtEnd: open.length };
}

/**
 * Split a selector list on its top-level commas only.
 *
 * The commas inside `:is()`, `:where()`, `:not()` and `:has()` separate arguments, not selectors.
 * Splitting on them turns one correct rule into two fragments - `#digest-panel .a:is(.b` and
 * `.c)` - and the second fragment carries no mount id, so a scope check rejects work that was
 * right. That is the failure mode that gets a guard weakened rather than fixed, so it is closed
 * here rather than tolerated.
 *
 * Known boundary, and it is a boundary rather than an oversight: a selector that combines the
 * mount id with a reach back out - `body:has(#digest-panel) main` - is one selector, contains
 * the mount id, and passes. Seeing that needs a real selector engine, which is a dependency this
 * project does not have. The scope check pairs this with a flat refusal to name the board at
 * all, which closes the same escape for the one element the layout argument protects. Native CSS
 * nesting is likewise unresolved: a nested `& .a` is reported by its own prelude and will fail
 * the scope check, loudly, which is the right way round for a rule nobody here writes yet.
 */
function splitList(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of prelude) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** Read a custom property's hex value out of a slice of stylesheet text. */
function hexOf(css: string, token: string): string {
  const match = css.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match !== null, `${token} is not declared as a six-digit hex value`);
  return (match[1] ?? '').toLowerCase();
}

/** Relative luminance, sRGB. Enough to say which of two shades is the deeper one. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
