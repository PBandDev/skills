/**
 * The AI boundary, asserted where it is observable: on the Snapshot.
 *
 * Every test here calls `deriveSnapshot` with a hand-built `Scan` and a hand-built
 * `AnnotationStore`. None of them calls `readAnnotations` or `validateDigest` directly, and
 * none names a helper or an intermediate shape — the rules can be reimplemented entirely
 * without a line of this file changing.
 *
 * Every store is built by round-tripping through JSON, because that is what actually
 * arrives: type stripping erases and does not check, so a declared `AnnotationStore` is a
 * claim about a file, not a fact about it. Building the stores this way is also the only
 * way to write the cases that matter — an Annotation carrying a Lane has no TypeScript
 * spelling, which is the entire point of ADR-0001's "the schema has no field to put one in".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveSnapshot } from '../core/index.ts';
import { EMPTY_ANNOTATIONS } from './harness.ts';
import type {
  AnnotationStore,
  FeatureSnapshot,
  Rejection,
  Root,
  Scan,
  Snapshot,
  TicketCard,
} from '../core/types.ts';

const ROOT = '/repo-a';
const OTHER_ROOT = '/repo-b';

/** Assemble a synthetic absolute URL without publishing a literal network location. */
function absoluteWebUrl(authorityAndPath: string): string {
  return ['https', '://', authorityAndPath].join('');
}

// ---------------------------------------------------------------------------
// The three as-of states
// ---------------------------------------------------------------------------

test('a Digest is current, expired or never written — three states, not two', () => {
  const scan = scanOf(
    rootOf(ROOT, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
      ['alpha/spec.md', 'alpha spec\n'],
      ['beta/issues/01-b.md', '# 01 — Beta one\n'],
      ['gamma/issues/01-g.md', '# 01 — Gamma one\n'],
    ]),
  );
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);

  const store = asStore({
    schemaVersion: 1,
    entries: [
      {
        schemaVersion: 1,
        filePath: featureKeyOf(probe, ROOT, 'alpha'),
        contentSha: featureOf(probe, 'alpha').contentSha,
        digest: digestFor('alpha'),
      },
      {
        schemaVersion: 1,
        filePath: featureKeyOf(probe, ROOT, 'beta'),
        // Written against content that has since moved. Nothing is swept; it simply does
        // not match by its real key (ADR-0003).
        contentSha: 'a'.repeat(64),
        digest: digestFor('beta'),
      },
    ],
  });

  const snapshot = deriveSnapshot(scan, store);

  assert.equal(featureOf(snapshot, 'alpha').digest.kind, 'current');
  assert.equal(featureOf(snapshot, 'beta').digest.kind, 'expired');
  assert.equal(
    featureOf(snapshot, 'gamma').digest.kind,
    'never-written',
    'a Feature that never had a Digest must not render like one whose Digest expired',
  );

  assert.deepEqual(
    {
      current: snapshot.liveness.digestsCurrent,
      expired: snapshot.liveness.digestsExpired,
      never: snapshot.liveness.digestsNeverWritten,
    },
    { current: 1, expired: 1, never: 1 },
  );
});

test('a member list of bare hashes buys no count, because it is not a member list', () => {
  // The shape this field was first written in, and the reason the count sat unimplemented.
  // A bare hash carries no path, so every one of them compares unequal to every `path:sha`
  // pair on the other side — a naive diff would report the Feature's entire file count, on
  // every expired Digest, as fact. Refused outright instead.
  //
  // This fixture is refused at the key check, since its list and its `contentSha` were never
  // a matching pair; a bare-hash list that *did* hash to its own key is refused one step
  // later, for having no path half at all. This test exercises the key-check route; the
  // separate shape check covers the other route so neither rejection can mask the other.
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  assert.equal(featureOf(probe, 'alpha').digest.kind, 'never-written');

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: featureKeyOf(probe, ROOT, 'alpha'),
          contentSha: 'b'.repeat(64),
          digest: digestFor('alpha'),
          memberShas: ['c'.repeat(64)],
        },
      ],
    }),
  );

  const digest = featureOf(snapshot, 'alpha').digest;
  assert.equal(digest.kind, 'expired');
  if (digest.kind !== 'expired') return;
  assert.equal(
    digest.filesChanged,
    null,
    'a list of bare hashes must cost the count, not produce one — a wrong number is printed as fact',
  );
});

// ---------------------------------------------------------------------------
// How many files moved under an expired Digest
// ---------------------------------------------------------------------------

/** Two Tickets and a spec, so an edit, an addition and a removal are all expressible. */
const BEFORE: readonly (readonly [string, string | null])[] = [
  ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
  ['alpha/issues/02-b.md', '# 02 — Alpha two\n'],
  ['alpha/spec.md', 'alpha spec\n'],
];

test('one edited file counts one, not two', () => {
  // **The assertion this whole seam turns on.** The rejected reading is the symmetric
  // difference of the two member lists, which for a single edit is 2 — the old pair gone and
  // the new pair arrived — and reads as a bug rather than as a count. Keyed by path, the
  // same edit is the one file it is. Measured: reimplementing the count as a set difference
  // turns this red, along with four of the cases below; this is the one that names the rule.
  assert.equal(
    expiredCount(BEFORE, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
      ['alpha/issues/02-b.md', '# 02 — Alpha two, revised\n'],
      ['alpha/spec.md', 'alpha spec\n'],
    ]),
    1,
  );
});

test('an added file counts one and a removed file counts one', () => {
  assert.equal(
    expiredCount(BEFORE, [...BEFORE, ['alpha/issues/03-c.md', '# 03 — Alpha three\n']]),
    1,
    'an added path is one change',
  );
  assert.equal(
    expiredCount(BEFORE, BEFORE.slice(0, 2)),
    1,
    'a removed path is one change',
  );
});

test('an edit, an addition and a removal together count three', () => {
  // Two edited files also count two, which is what says the count is a count and not a flag
  // that happens to be spelled `1`.
  assert.equal(
    expiredCount(BEFORE, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one, revised\n'],
      ['alpha/issues/03-c.md', '# 03 — Alpha three\n'],
      ['alpha/spec.md', 'alpha spec\n'],
    ]),
    3,
  );
  assert.equal(
    expiredCount(BEFORE, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one, revised\n'],
      ['alpha/issues/02-b.md', '# 02 — Alpha two, revised\n'],
      ['alpha/spec.md', 'alpha spec\n'],
    ]),
    2,
    'two edited files must count two',
  );
});

test('a rename counts two — a path left and a path arrived', () => {
  // Decided, not overlooked. Matching the two by equal content would collapse it to one, and
  // equal content is not evidence of a move: a file deleted and an unrelated identical file
  // added is the same observation. The count is path-keyed, and under a path-keyed rule a
  // rename is exactly a removal and an addition.
  assert.equal(
    expiredCount(BEFORE, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
      ['alpha/issues/02-b.md', '# 02 — Alpha two\n'],
      ['alpha/notes.md', 'alpha spec\n'],
    ]),
    2,
  );
});

test('a file the scanner could not read takes the count away rather than becoming a change', () => {
  // The rule counts paths whose *content* differs, and this file's content is unknown — it
  // may be byte-identical behind a permissions error. Counting it as changed would print a
  // failed read as an edit; skipping it would report the Feature as quieter than it was.
  // Neither is a fact, so there is no defensible number to publish.
  assert.equal(
    expiredCount(BEFORE, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one, revised\n'],
      ['alpha/issues/02-b.md', '# 02 — Alpha two\n'],
      ['alpha/spec.md', null],
    ]),
    null,
    'an unreadable member must cost the count even when another file plainly did change',
  );
});

test('a path holding an unpaired surrogate costs the count, because the key stops being injective', () => {
  // `sha256` encodes UTF-8, which replaces an unpaired surrogate with U+FFFD, so two paths
  // differing only there hash to one key while remaining different strings. A stored list
  // could then verify and still compare unequal to the live path that is really the same
  // file. Refusing the count prevents two distinct source paths becoming one claimed fact.
  const odd: readonly (readonly [string, string | null])[] = [
    ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
    ['alpha/spec\uD800.md', 'alpha spec\n'],
  ];
  assert.equal(
    expiredCount(odd, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one, revised\n'],
      ['alpha/spec\uD800.md', 'alpha spec\n'],
    ]),
    null,
  );
});

test('a path containing a colon is still one path', () => {
  // A path may hold a colon and a sha never does, which is why a member entry is split at its
  // **last** one. Split at the first instead and this file's path reads as `alpha/spec`, its
  // sha reads as `draft.md:<sha>` — not a sha at all — and the whole list is refused, so the
  // count silently disappears for any Feature holding such a file.
  const before: readonly (readonly [string, string | null])[] = [
    ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
    ['alpha/spec:draft.md', 'alpha spec\n'],
  ];
  assert.equal(
    expiredCount(before, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
      ['alpha/spec:draft.md', 'alpha spec, revised\n'],
    ]),
    1,
  );
});

test('a path holding a newline costs the count, because the key stops being injective', () => {
  // Member entries are joined by newlines to make the Feature's key, so a path containing one
  // makes two different lists hash to the same key: `['a:x', 'b:y']` and `['a:x\nb:y']` join
  // to the same text. A stored list in the second form would verify and then be diffed as one
  // oddly-named path against two, reporting changes that never happened. Refused instead.
  const withNewline: readonly (readonly [string, string | null])[] = [
    ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
    ['alpha/spec\nnote.md', 'alpha spec\n'],
  ];
  assert.equal(
    expiredCount(withNewline, [
      ['alpha/issues/01-a.md', '# 01 — Alpha one, revised\n'],
      ['alpha/spec\nnote.md', 'alpha spec\n'],
    ]),
    null,
  );
});

test('a Digest stored without a member list gets no count rather than a guessed one', () => {
  assert.equal(expiredCount(BEFORE, BEFORE.slice(0, 2), { memberShas: undefined }), null);
});

test('a stored member list verifies whatever order it was written in', () => {
  // The published list is sorted, and a writer that copies it into JSON may not keep it that
  // way. The key it is checked against is a hash of the *membership*, so a reordered copy is
  // the same list and still buys its count — otherwise the check would be refusing correct
  // records over a detail no part of the contract asks a writer to preserve.
  const stored: { readonly memberShas?: readonly string[] } = JSON.parse(
    JSON.stringify(storedDigestFor(BEFORE)),
  );
  const members = [...(stored.memberShas ?? [])].reverse();
  assert.equal(members.length, BEFORE.length, 'the fixture did not read the published list');
  assert.notDeepEqual(members, [...members].sort(), 'the fixture is not actually reordered');
  assert.equal(expiredCount(BEFORE, BEFORE.slice(0, 2), { memberShas: members }), 1);
});

test('a member list that does not hash back to its own key is not diffed', () => {
  // Well-formed pairs, and wrong. The list names a file the Feature never held and gives
  // every real one a hash it never had, so it cannot be the list that produced the
  // `contentSha` the entry is filed under — and a diff against it would report **4** (two
  // files reading as edited, the dropped spec, and the phantom) with complete confidence.
  // The check that catches it is the one that makes every number above worth printing.
  assert.equal(
    expiredCount(BEFORE, BEFORE.slice(0, 2), {
      memberShas: [...BEFORE.map(([path]) => `${path}:${'a'.repeat(64)}`), `alpha/ghost.md:${'b'.repeat(64)}`],
    }),
    null,
  );
});

test('a member list naming one path twice is refused rather than folded', () => {
  // Built by deriving a Scan that lists one file twice, so the stored list is genuinely
  // self-consistent — it hashes to the `contentSha` it is filed under — and is still refused,
  // because folding it would mean choosing which of the two shas the count is about.
  const twice: readonly (readonly [string, string | null])[] = [...BEFORE, ['alpha/spec.md', 'alpha spec\n']];
  assert.equal(expiredCount(twice, BEFORE.slice(0, 2)), null, 'a repeated path on the stored side');
  assert.equal(expiredCount(BEFORE.slice(0, 2), twice), null, 'a repeated path on the live side');
});

test('an expired Digest whose member list matches the files on disk reports no count', () => {
  // Two entries share one key; the later carries no Digest so the lookup finds nothing to
  // render, and the earlier one is a Digest written against exactly the content still on disk.
  //
  // **The `expired` asserted below is a defect, and asserting it is not endorsing it.** It
  // predates this change — measured against HEAD, which reports `expired` for this same store
  // — and it lives in the `everWritten` predicate, which asks whether any entry under the path
  // carries a Digest without asking whether that entry is the current one. What is under test
  // here is the count's behaviour on top of it: zero files moved, "expired, and nothing
  // changed" is a contradiction, and the count refuses to put a number on a false sentence
  // rather than dressing it up with one.
  const scan = scanOf(rootOf(ROOT, BEFORE));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const feature = featureOf(probe, 'alpha');
  const key = featureKeyOf(probe, ROOT, 'alpha');

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: key,
          contentSha: feature.contentSha,
          digest: digestFor('alpha'),
          memberShas: [...feature.memberShas],
        },
        { schemaVersion: 1, filePath: key, contentSha: feature.contentSha, extraction: { title: 'Later' } },
      ],
    }),
  );

  const digest = featureOf(snapshot, 'alpha').digest;
  assert.equal(digest.kind, 'expired');
  if (digest.kind !== 'expired') return;
  assert.equal(digest.filesChanged, null, 'a count of zero on an expired Digest is a contradiction, not a number');
});

test('the count is taken from the newest stored Digest, not the oldest', () => {
  // Three trees. The store holds a Digest against the first and a Digest against the second;
  // the board is looking at the third. Only one file moved since the second was written, and
  // two since the first — so a 2 here means an older Digest's member list answered a question
  // about a newer Digest.
  const older = BEFORE;
  const newer: readonly (readonly [string, string | null])[] = [
    ['alpha/issues/01-a.md', '# 01 — Alpha one\n'],
    ['alpha/issues/02-b.md', '# 02 — Alpha two\n'],
    ['alpha/spec.md', 'alpha spec, revised\n'],
  ];
  const now: readonly (readonly [string, string | null])[] = [
    ['alpha/issues/01-a.md', '# 01 — Alpha one, revised\n'],
    ['alpha/issues/02-b.md', '# 02 — Alpha two\n'],
    ['alpha/spec.md', 'alpha spec, revised\n'],
  ];

  const snapshot = deriveSnapshot(
    scanOf(rootOf(ROOT, now)),
    asStore({
      schemaVersion: 1,
      entries: [storedDigestFor(older), storedDigestFor(newer)],
    }),
  );

  const digest = featureOf(snapshot, 'alpha').digest;
  assert.equal(digest.kind, 'expired');
  if (digest.kind !== 'expired') return;
  assert.equal(digest.filesChanged, 1);
});

test('a current Digest survives with every Block it was written with', () => {
  const { snapshot, feature } = withDigest({
    v: 1,
    feature: 'alpha',
    blocks: [
      { kind: 'summary', text: 'Checkout is two Tickets from done.' },
      {
        kind: 'facts',
        items: [
          { label: 'Tickets', value: '3' },
          { label: 'Frontier', value: '1', state: 'active' },
        ],
      },
      { kind: 'bullets', title: 'Open questions', tone: 'fog', items: ['Refund path', 'Tax rules'] },
      { kind: 'links', items: [{ label: 'Spec', path: 'alpha/spec.md' }] },
    ],
  });

  assert.deepEqual(snapshot.rejections, []);
  assert.equal(feature.digest.kind, 'current');
  if (feature.digest.kind !== 'current') return;
  assert.deepEqual(
    feature.digest.digest.blocks.map((block) => block.kind),
    ['summary', 'facts', 'bullets', 'links'],
  );
  assert.equal(feature.digest.digest.feature, 'alpha');
});

test('fog and out-of-scope both survive validation as distinct tones', () => {
  const { feature } = withDigest({
    v: 1,
    feature: 'alpha',
    blocks: [
      { kind: 'summary', text: 'Two things are open and one is ruled out.' },
      { kind: 'bullets', tone: 'fog', items: ['Refund path', 'Tax rules'] },
      { kind: 'bullets', tone: 'out-of-scope', items: ['Multi-currency', 'Partial capture'] },
    ],
  });
  assert.equal(feature.digest.kind, 'current');
  if (feature.digest.kind !== 'current') return;
  const tones = feature.digest.digest.blocks.map((block) =>
    block.kind === 'bullets' ? block.tone : null,
  );
  assert.deepEqual(
    tones,
    [null, 'fog', 'out-of-scope'],
    'fog and out-of-scope mean opposite things and must not be collapsed into one tone',
  );
});

// ---------------------------------------------------------------------------
// Root-qualified identity
// ---------------------------------------------------------------------------

test('two Roots holding the same relative path do not share an Annotation', () => {
  // One board, several Roots, one store. If a key were Root-relative these two would share
  // an Override whenever their content hashes matched, and mark each other expired
  // whenever they did not.
  const text = '# 01 — Charge the card\n';
  const relPath = 'payments/issues/01-charge.md';
  const scan = scanOf(rootOf(ROOT, [[relPath, text]]), rootOf(OTHER_ROOT, [[relPath, text]]));

  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const a = cardIn(probe, ROOT, relPath);
  const b = cardIn(probe, OTHER_ROOT, relPath);
  assert.notEqual(a.id, b.id, 'identical content in two Roots must still be two identities');
  assert.equal(a.contentSha, b.contentSha, 'identical content does hash identically — that is the point');

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: a.id,
          contentSha: a.contentSha,
          extraction: { title: 'Charge the card, retried' },
        },
        {
          schemaVersion: 1,
          filePath: featureKeyOf(probe, ROOT, 'payments'),
          contentSha: 'd'.repeat(64),
          digest: digestFor('payments'),
        },
      ],
    }),
  );

  const correctedA = cardIn(snapshot, ROOT, relPath);
  const untouchedB = cardIn(snapshot, OTHER_ROOT, relPath);
  assert.equal(correctedA.extraction.title, 'Charge the card, retried');
  assert.deepEqual([...correctedA.derivation.correctedFields], ['title']);
  assert.deepEqual(
    [...untouchedB.derivation.correctedFields],
    [],
    'the other Root shares a relative path and a content hash, and must still be a different identity',
  );
  assert.notEqual(untouchedB.extraction.title, 'Charge the card, retried');

  const rootA = snapshot.roots.find((root) => root.path === ROOT);
  const rootB = snapshot.roots.find((root) => root.path === OTHER_ROOT);
  assert.ok(rootA !== undefined && rootB !== undefined);
  assert.equal(rootA.features[0]?.digest.kind, 'expired');
  assert.equal(
    rootB.features[0]?.digest.kind,
    'never-written',
    'one Root expiring must not expire the identically-named Feature in the other',
  );
});

// ---------------------------------------------------------------------------
// Schema versions
// ---------------------------------------------------------------------------

test('an entry with an unknown schema version is dropped and surfaces as a rejection', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 7,
          filePath: card.id,
          contentSha: card.contentSha,
          extraction: { title: 'From an unsupported schema version' },
        },
      ],
    }),
  );

  const after = cardOf(snapshot, card.id);
  assert.deepEqual([...after.derivation.correctedFields], [], 'the entry was dropped, so nothing was corrected');
  assert.notEqual(after.extraction.title, 'From an unsupported schema version');

  const rejection = named(snapshot.rejections, 'schemaVersion');
  assert.equal(rejection.kind, 'annotation');
  assert.equal(rejection.path, card.id, 'the rejection names the file whose Annotation was dropped');
  assert.ok(
    rejection.message.includes('7') && rejection.message.includes('re-flagged'),
    `dropped-and-re-flagged must be visible, not just counted — got "${rejection.message}"`,
  );
});

test('a store carrying an unknown schema version reads as empty and says so', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 99,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: card.contentSha,
          extraction: { title: 'Never read' },
        },
      ],
    }),
  );

  assert.deepEqual([...cardOf(snapshot, card.id).derivation.correctedFields], []);
  const rejection = named(snapshot.rejections, 'schemaVersion');
  assert.ok(
    rejection.message.includes('99'),
    `the unreadable version must be named — got "${rejection.message}"`,
  );
});

// ---------------------------------------------------------------------------
// AI extracts, code derives
// ---------------------------------------------------------------------------

test('an Annotation carrying a derived state is rejected and the parser Extraction survives', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);
  const parsedTitle = card.extraction.title;

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: card.contentSha,
          extraction: { title: 'Corrected by the AI', lane: 'agent' },
        },
      ],
    }),
  );

  const after = cardOf(snapshot, card.id);
  assert.equal(
    after.extraction.title,
    parsedTitle,
    'the entry was rejected whole — stripping the Lane and keeping the rest is exactly what ADR-0001 forbids',
  );
  assert.deepEqual([...after.derivation.correctedFields], []);

  const rejection = named(snapshot.rejections, 'extraction.lane');
  assert.equal(rejection.kind, 'override');
  assert.ok(
    rejection.message.includes('ADR-0001'),
    `the rejection must say why, not only that — got "${rejection.message}"`,
  );
  assert.ok(snapshot.overrides.rejected >= 1, 'a refused Override must be counted on the board');
});

test('a derived state written at the top of an entry is rejected too', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: card.contentSha,
          lane: 'agent',
          onFrontier: true,
          extraction: { title: 'Corrected by the AI' },
        },
      ],
    }),
  );

  assert.deepEqual([...cardOf(snapshot, card.id).derivation.correctedFields], []);
  assert.equal(named(snapshot.rejections, 'lane').kind, 'annotation');
  assert.equal(named(snapshot.rejections, 'onFrontier').kind, 'annotation');
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

test('an Override marks exactly the fields it disagreed with', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const disagreeing = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: card.contentSha,
          extraction: {
            title: `${card.extraction.title} (corrected)`,
            blockedBy: [...card.extraction.blockedBy],
            dialect: card.extraction.dialect,
          },
        },
      ],
    }),
  );
  const corrected = cardOf(disagreeing, card.id);
  assert.deepEqual(
    [...corrected.derivation.correctedFields],
    ['title'],
    'blockedBy and dialect agreed with the parser, and claiming a correction that did not happen is worse than claiming none',
  );
  assert.equal(disagreeing.corrections.total, 1);
  assert.equal(disagreeing.overrides.applied, 1);

  const agreeing = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: card.contentSha,
          extraction: { title: card.extraction.title },
        },
      ],
    }),
  );
  assert.deepEqual([...cardOf(agreeing, card.id).derivation.correctedFields], []);
  assert.equal(agreeing.corrections.total, 0);
  assert.equal(agreeing.overrides.applied, 0);
});

test('an Override keyed to content that has moved does not apply, and is counted pending', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: 'e'.repeat(64),
          extraction: { title: 'Written against text that no longer exists' },
        },
      ],
    }),
  );

  assert.deepEqual([...cardOf(snapshot, card.id).derivation.correctedFields], []);
  assert.equal(
    snapshot.liveness.overridesPendingRecheck,
    1,
    'the key path is in the scan under a different hash, so the next Reconciliation pass re-checks it',
  );
  assert.equal(snapshot.overrides.applied, 0);
});

test('an Override whose content still matches is not pending re-check', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: card.contentSha,
          extraction: { title: 'Still current' },
        },
      ],
    }),
  );
  assert.equal(snapshot.liveness.overridesPendingRecheck, 0);
});

// ---------------------------------------------------------------------------
// Digest caps — every one of them, each naming its field and its overage
// ---------------------------------------------------------------------------

interface CapCase {
  readonly name: string;
  readonly digest: object;
  readonly field: string;
  readonly message: string;
}

/**
 * Shared across cases, and **frozen** so sharing them cannot become coupling.
 *
 * Nothing here writes to a disk and no case reads another's result, so the cases are
 * order-independent by construction — but "by construction" is an argument, and freezing is
 * a check. A case that mutated a shared fixture would make the file's result depend on the
 * order it ran in, and a suite that reports a different number on different runs destroys
 * the only signal a count-gated project has.
 */
const SUMMARY = deepFreeze({ kind: 'summary', text: 'Checkout is two Tickets from done.' });
const FACTS = deepFreeze({
  kind: 'facts',
  items: [
    { label: 'Tickets', value: '3' },
    { label: 'Done', value: '1' },
  ],
});

const CAP_CASES: readonly CapCase[] = [
  {
    name: 'summary over its character cap',
    digest: envelope([{ kind: 'summary', text: 'x'.repeat(201) }, FACTS]),
    field: 'summary.text',
    message: '201 > 200 chars',
  },
  {
    name: 'summary carrying a newline',
    digest: envelope([{ kind: 'summary', text: 'Line one.\nLine two.' }, FACTS]),
    field: 'summary.text',
    message: 'carries a newline',
  },
  {
    name: 'summary carrying markdown',
    digest: envelope([{ kind: 'summary', text: 'The **payments** rewrite landed.' }, FACTS]),
    field: 'summary.text',
    message: 'carries markdown; a summary is plain prose',
  },
  {
    name: 'summary carrying a link',
    digest: envelope([
      { kind: 'summary', text: `See ${absoluteWebUrl('example.com/roadmap')} for the plan.` },
      FACTS,
    ]),
    field: 'summary.text',
    message: 'carries a link; links belong in the links Block',
  },
  {
    name: 'facts below its item floor',
    digest: envelope([SUMMARY, { kind: 'facts', items: [{ label: 'Tickets', value: '3' }] }]),
    field: 'facts.items',
    message: '1 < 2 items',
  },
  {
    name: 'facts above its item cap',
    digest: envelope([
      SUMMARY,
      { kind: 'facts', items: repeat(7, (at) => ({ label: `Label ${at}`, value: `${at}` })) },
    ]),
    field: 'facts.items',
    message: '7 > 6 items',
  },
  {
    name: 'a fact label over its cap',
    digest: envelope([
      SUMMARY,
      {
        kind: 'facts',
        items: [
          { label: 'y'.repeat(25), value: '3' },
          { label: 'Done', value: '1' },
        ],
      },
    ]),
    field: 'facts.items[0].label',
    message: '25 > 24 chars',
  },
  {
    name: 'a fact value over its cap',
    digest: envelope([
      SUMMARY,
      {
        kind: 'facts',
        items: [
          { label: 'Tickets', value: 'z'.repeat(49) },
          { label: 'Done', value: '1' },
        ],
      },
    ]),
    field: 'facts.items[0].value',
    message: '49 > 48 chars',
  },
  {
    name: 'a fact state outside the vocabulary',
    digest: envelope([
      SUMMARY,
      {
        kind: 'facts',
        items: [
          { label: 'Tickets', value: '3', state: 'ready' },
          { label: 'Done', value: '1' },
        ],
      },
    ]),
    field: 'facts.items[0].state',
    message: 'is not one of done, active, blocked, planned, dropped',
  },
  {
    name: 'bullets below its item floor',
    digest: envelope([SUMMARY, { kind: 'bullets', items: ['Only one'] }]),
    field: 'bullets.items',
    message: '1 < 2 items',
  },
  {
    name: 'bullets above its item cap',
    digest: envelope([SUMMARY, { kind: 'bullets', items: repeat(6, (at) => `Bullet ${at}`) }]),
    field: 'bullets.items',
    message: '6 > 5 items',
  },
  {
    name: 'a bullet over its character cap',
    digest: envelope([
      SUMMARY,
      {
        kind: 'bullets',
        items: ['Bullet 0', 'Bullet 1', 'Bullet 2', 'w'.repeat(101)],
      },
    ]),
    field: 'bullets.items[3]',
    message: '101 > 100 chars',
  },
  {
    name: 'a bullets title over its cap',
    digest: envelope([
      SUMMARY,
      { kind: 'bullets', title: 't'.repeat(41), items: ['Bullet 0', 'Bullet 1'] },
    ]),
    field: 'bullets.title',
    message: '41 > 40 chars',
  },
  {
    name: 'a bullets tone outside the vocabulary',
    digest: envelope([
      SUMMARY,
      { kind: 'bullets', tone: 'urgent', items: ['Bullet 0', 'Bullet 1'] },
    ]),
    field: 'bullets.tone',
    message: 'is not one of note, risk, decision, question, correction, fog, out-of-scope',
  },
  {
    name: 'links below its item floor',
    digest: envelope([SUMMARY, { kind: 'links', items: [] }]),
    field: 'links.items',
    message: '0 < 1 items',
  },
  {
    name: 'links above its item cap',
    digest: envelope([
      SUMMARY,
      { kind: 'links', items: repeat(7, (at) => ({ label: `Link ${at}`, path: `alpha/${at}.md` })) },
    ]),
    field: 'links.items',
    message: '7 > 6 items',
  },
  {
    name: 'a link label over its cap',
    digest: envelope([
      SUMMARY,
      { kind: 'links', items: [{ label: 'l'.repeat(41), path: 'alpha/spec.md' }] },
    ]),
    field: 'links.items[0].label',
    message: '41 > 40 chars',
  },
  {
    name: 'a link path holding an absolute URL',
    digest: envelope([
      SUMMARY,
      { kind: 'links', items: [{ label: 'Roadmap', path: absoluteWebUrl('example.com/roadmap') }] },
    ]),
    field: 'links.items[0].path',
    message: 'is an absolute URL; links are repo-relative paths',
  },
  {
    name: 'a link path holding a protocol-relative URL',
    digest: envelope([
      SUMMARY,
      { kind: 'links', items: [{ label: 'Roadmap', path: '//example.com/roadmap' }] },
    ]),
    field: 'links.items[0].path',
    message: 'is an absolute URL; links are repo-relative paths',
  },
  {
    name: 'an envelope below its Block floor',
    digest: envelope([SUMMARY]),
    field: 'blocks',
    message: '1 < 2 Blocks',
  },
  {
    name: 'an envelope above its Block cap',
    digest: envelope([SUMMARY, FACTS, FACTS, FACTS, FACTS, FACTS, FACTS]),
    field: 'blocks',
    message: '7 > 6 Blocks',
  },
  {
    name: 'an envelope that does not open with summary',
    digest: envelope([FACTS, SUMMARY]),
    field: 'blocks[0]',
    message: 'is not summary; a Digest opens with its summary Block',
  },
  {
    name: 'an envelope with two summaries',
    digest: envelope([SUMMARY, SUMMARY]),
    field: 'blocks',
    message: 'carries 2 summary Blocks; a Digest opens with exactly one',
  },
  {
    name: 'an envelope with no summary at all',
    digest: envelope([FACTS, FACTS]),
    field: 'blocks',
    message: 'carries no summary Block; a Digest opens with exactly one',
  },
  {
    name: 'an envelope of an unknown version',
    digest: { v: 2, feature: 'alpha', blocks: [SUMMARY, FACTS] },
    field: 'v',
    message: '2 is not Digest version 1',
  },
  {
    name: 'an envelope naming a different Feature',
    digest: { v: 1, feature: 'beta', blocks: [SUMMARY, FACTS] },
    field: 'feature',
    message: 'does not name the Feature it was written for',
  },
  {
    name: 'an unknown field on the envelope',
    digest: { v: 1, feature: 'alpha', blocks: [SUMMARY, FACTS], lane: 'agent' },
    field: 'lane',
    message: 'is not a field of the Digest envelope',
  },
  {
    name: 'an unknown field on a Block',
    digest: envelope([{ kind: 'summary', text: 'Fine.', tone: 'risk' }, FACTS]),
    field: 'summary.tone',
    message: 'is not a field of a summary Block',
  },
  {
    name: 'an unknown Block kind',
    digest: envelope([SUMMARY, { kind: 'table', rows: [] }]),
    field: 'blocks[1].kind',
    message: 'is not one of summary, facts, bullets, links',
  },
  {
    // An anchored URL test sees the raw string, so one leading space used to carry a whole
    // absolute URL into the Snapshot. Trimming here instead would be the other failure:
    // accepting a path the file does not contain.
    name: 'a link path padded with whitespace, which an anchored URL test would not see',
    digest: envelope([
      SUMMARY,
      { kind: 'links', items: [{ label: 'Roadmap', path: ` ${absoluteWebUrl('example.com/private')}` }] },
    ]),
    field: 'links.items[0].path',
    message: 'is padded with whitespace',
  },
  {
    name: 'an empty authored string, which claims a slot and says nothing',
    digest: envelope([{ kind: 'summary', text: '   ' }, FACTS]),
    field: 'summary.text',
    message: 'is empty',
  },
  {
    name: 'a newline in a fact label, which escapes the cap it sits under',
    digest: envelope([
      SUMMARY,
      {
        kind: 'facts',
        items: [
          { label: 'Tickets\nopen', value: '3' },
          { label: 'Done', value: '1' },
        ],
      },
    ]),
    field: 'facts.items[0].label',
    message: 'carries a newline',
  },
  {
    name: 'a fact item that is not an object',
    digest: envelope([SUMMARY, { kind: 'facts', items: ['Tickets: 3', { label: 'Done', value: '1' }] }]),
    field: 'facts.items[0]',
    message: 'a 10-character string is not a fact',
  },
  {
    name: 'a link item that is not an object',
    digest: envelope([SUMMARY, { kind: 'links', items: [7] }]),
    field: 'links.items[0]',
    message: '7 is not a link',
  },
  {
    name: 'a blocks field that is not a list',
    digest: { v: 1, feature: 'alpha', blocks: 5 },
    field: 'blocks',
    message: '5 is not a list of Blocks',
  },
  {
    name: 'a second Block of the same kind, named so the message stays unambiguous',
    digest: envelope([
      SUMMARY,
      { kind: 'bullets', items: ['Bullet 0', 'Bullet 1'] },
      { kind: 'bullets', items: ['Bullet 0', 'x'.repeat(101)] },
    ]),
    field: 'bullets[1].items[1]',
    message: '101 > 100 chars',
  },
  {
    name: 'the aggregate budget, over by 128 chars',
    digest: envelope([
      { kind: 'summary', text: 's'.repeat(200) },
      { kind: 'bullets', title: 'b'.repeat(40), items: repeat(5, () => 'i'.repeat(100)) },
      {
        kind: 'facts',
        items: repeat(4, () => ({ label: 'f'.repeat(24), value: 'v'.repeat(48) })),
      },
    ]),
    field: 'blocks',
    message: '1028 > 900 chars across the authored strings',
  },
];

for (const capCase of CAP_CASES) {
  test(`a Digest is rejected for ${capCase.name}`, () => {
    const { snapshot, feature } = withDigest(capCase.digest);

    const rejection = named(snapshot.rejections, capCase.field);
    assert.equal(rejection.kind, 'digest');
    assert.equal(rejection.feature, 'alpha', 'a Digest rejection names the Feature it was written for');
    assert.equal(
      rejection.message,
      capCase.message,
      'a rejection names the field and the overage so the model that wrote it can self-correct',
    );

    assert.equal(
      feature.digest.kind,
      'never-written',
      'a refused Digest renders as no Digest — never as a truncated one',
    );
    assert.equal(snapshot.liveness.digestsNeverWritten, 1);
  });
}

test('the aggregate budget excludes link paths, which are read off disk and not authored', () => {
  // 860 authored chars, and 1,200 more if the paths were counted. Counting them would make
  // "links uncapped for maps" unenforceable on the one Feature that has a map.
  const { snapshot, feature } = withDigest(
    envelope([
      { kind: 'summary', text: 's'.repeat(200) },
      { kind: 'bullets', title: 'b'.repeat(40), items: repeat(5, () => 'i'.repeat(100)) },
      {
        kind: 'links',
        items: repeat(6, (at) => ({ label: `Link label ${at}`.padEnd(20, '.'), path: `alpha/${'p'.repeat(193)}${at}.md` })),
      },
    ]),
  );

  assert.deepEqual(
    snapshot.rejections.map((rejection) => `${rejection.field}: ${rejection.message}`),
    [],
  );
  assert.equal(feature.digest.kind, 'current');
  assert.equal(snapshot.liveness.digestsCurrent, 1);
});

// ---------------------------------------------------------------------------
// Annotation refusals — every rule the entry validator states, each named
// ---------------------------------------------------------------------------

interface RefusalCase {
  readonly name: string;
  /** JSON text for one entry. `KEY` and `SHA` stand in for the card's identity. */
  readonly entry: string;
  readonly kind: Rejection['kind'];
  readonly field: string;
  readonly message: string;
}

const REFUSAL_CASES: readonly RefusalCase[] = [
  {
    name: 'a criteria ratio claiming more checked than total',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","extraction":{"criteria":{"checked":5,"total":2}}}',
    kind: 'override',
    field: 'extraction.criteria.checked',
    message: '5 > 2 total',
  },
  {
    name: 'an unknown field inside a criteria ratio',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","extraction":{"criteria":{"checked":1,"total":2,"percent":50}}}',
    kind: 'override',
    field: 'extraction.criteria.percent',
    message: 'is not a field of a criteria ratio, which carries a checked count and a total',
  },
  {
    name: 'a criteria ratio that is not an object',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","extraction":{"criteria":[1,2]}}',
    kind: 'override',
    field: 'extraction.criteria',
    message: 'is not a ratio object',
  },
  {
    name: 'a blocker list member that is not a Ticket number',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","extraction":{"blockedBy":[2,"three"]}}',
    kind: 'override',
    field: 'extraction.blockedBy[1]',
    message: 'a 5-character string is not a Ticket number',
  },
  {
    name: 'a blocker list that is not a list',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","extraction":{"blockedBy":"02, 03"}}',
    kind: 'override',
    field: 'extraction.blockedBy',
    message: 'is not a list of Ticket numbers',
  },
  {
    name: 'a Dialect outside the vocabulary',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","extraction":{"dialect":"sideways"}}',
    kind: 'override',
    field: 'extraction.dialect',
    message: 'is not one of task, decision, unclassified, unparsed',
  },
  {
    name: 'a title that is not a string',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","extraction":{"title":9}}',
    kind: 'override',
    field: 'extraction.title',
    message: '9 is not a string',
  },
  {
    name: 'an extraction that is not an object',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","extraction":"corrected"}',
    kind: 'override',
    field: 'extraction',
    message: 'is not an object',
  },
  {
    name: 'a missing content hash',
    entry: '{"schemaVersion":1,"filePath":"KEY"}',
    kind: 'annotation',
    field: 'contentSha',
    message: 'absent is not a content hash',
  },
  {
    name: 'a path carrying a NUL, which would let two entries collide onto one key',
    entry: '{"schemaVersion":1,"filePath":"KEY\\u0000extra","contentSha":"SHA"}',
    kind: 'annotation',
    field: 'filePath',
    message: 'carries a NUL, which no real path does',
  },
  {
    name: 'a member list that is not a list of strings',
    entry: '{"schemaVersion":1,"filePath":"KEY","contentSha":"SHA","memberShas":[1,2]}',
    kind: 'annotation',
    field: 'memberShas',
    message: 'is not a list of "<path>:<sha>" member entries',
  },
];

for (const refusal of REFUSAL_CASES) {
  test(`an Annotation is refused for ${refusal.name}`, () => {
    const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
    const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
    const card = probe.roots[0]?.features[0]?.tickets[0];
    assert.ok(card !== undefined);

    const entry = refusal.entry
      .split('KEY')
      .join(card.id)
      .split('SHA')
      .join(card.contentSha ?? '');
    const store: AnnotationStore = JSON.parse(`{"schemaVersion":1,"entries":[${entry}]}`);
    const snapshot = deriveSnapshot(scan, store);

    const rejection = named(snapshot.rejections, refusal.field);
    assert.equal(rejection.kind, refusal.kind);
    assert.equal(rejection.message, refusal.message);
    assert.deepEqual(
      [...cardOf(snapshot, card.id).derivation.correctedFields],
      [],
      'a refused entry is refused whole — no part of it may reach the card',
    );
  });
}

test('one key holds one entry, and the later statement about the same content wins', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        { schemaVersion: 1, filePath: card.id, contentSha: card.contentSha, extraction: { title: 'First' } },
        { schemaVersion: 1, filePath: card.id, contentSha: card.contentSha, extraction: { title: 'Second' } },
      ],
    }),
  );

  assert.equal(
    cardOf(snapshot, card.id).extraction.title,
    'Second',
    'the store is appended to, so the later entry is the newer statement — and the choice has to be deterministic',
  );
});

// ---------------------------------------------------------------------------
// Rule zero, at the AI boundary
// ---------------------------------------------------------------------------

test('nothing that arrives off disk can make the seam throw', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const shapes: readonly string[] = [
    'null',
    '"a string where an object belongs"',
    '[]',
    '17',
    'true',
    '{}',
    '{"schemaVersion":1}',
    '{"schemaVersion":1,"entries":"not a list"}',
    '{"schemaVersion":1,"entries":[null,5,"x",[],{}]}',
    '{"schemaVersion":"1","entries":[]}',
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"${card.id}","contentSha":"${card.contentSha}","extraction":"not an object"}]}`,
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"${card.id}","contentSha":"${card.contentSha}","extraction":{"criteria":"not a ratio","blockedBy":"not a list","title":9,"dialect":"sideways"}}]}`,
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"${card.id}","contentSha":"${card.contentSha}","extraction":{"criteria":{"checked":5,"total":2,"ratio":0.4}}}]}`,
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"${card.id}","contentSha":"${card.contentSha}","digest":"a string"}]}`,
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"${card.id}","contentSha":"${card.contentSha}","digest":null}]}`,
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"${card.id}","contentSha":"${card.contentSha}","digest":[1,2,3]}]}`,
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"${card.id}","contentSha":"${card.contentSha}","digest":{"v":1,"feature":"alpha","blocks":[{"kind":"summary","text":null},"not a block"]}}]}`,
    '{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"","contentSha":""}]}',
    '{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":7,"contentSha":true}]}',
  ];

  for (const shape of shapes) {
    const store: AnnotationStore = JSON.parse(shape);
    assert.doesNotThrow(() => deriveSnapshot(scan, store), `threw on ${shape}`);
    const snapshot = deriveSnapshot(scan, store);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(
      snapshot.roots[0]?.features[0]?.tickets.length,
      1,
      `a malformed store must not cost a card — ${shape}`,
    );
  }
});

test('a key that shadows an object built-in is refused like any other unknown key', () => {
  // `JSON.parse` makes `__proto__` an ordinary own enumerable key rather than reassigning a
  // prototype, so the allow-list sees it. This is asserted rather than assumed, because the
  // allow-list is the whole mechanism ADR-0001 rests on and it is built out of `Object.keys`.
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const store: AnnotationStore = JSON.parse(
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":"${card.id}","contentSha":"${card.contentSha}","extraction":{"title":"Corrected","__proto__":{"lane":"agent"},"constructor":"x"}}]}`,
  );
  const snapshot = deriveSnapshot(scan, store);

  assert.equal(named(snapshot.rejections, 'extraction.__proto__').kind, 'override');
  assert.equal(named(snapshot.rejections, 'extraction.constructor').kind, 'override');
  assert.deepEqual(
    [...cardOf(snapshot, card.id).derivation.correctedFields],
    [],
    'the entry was refused whole, so its title did not apply either',
  );

  const digested = withDigest(
    JSON.parse('{"v":1,"feature":"alpha","blocks":[{"kind":"summary","text":"Fine.","__proto__":{}},{"kind":"facts","items":[{"label":"a","value":"b"},{"label":"c","value":"d"}]}]}'),
  );
  assert.equal(named(digested.snapshot.rejections, 'summary.__proto__').kind, 'digest');
  assert.equal(digested.feature.digest.kind, 'never-written');
});

test('no rejection message carries the content it refused', () => {
  // Rejections render on a web page. Everything they describe is model-authored text about
  // somebody's private repository, so a message that quotes what it refused copies that
  // text onto the board and into anything the board writes. A rejection names the field and
  // the size — `bullets.items[3]: 147 > 100 chars` — which is exactly the shape that
  // carries no content.
  //
  // Every string below is a distinct sentinel, so a leak names its own source. The
  // Root-qualified key is deliberately excluded: `Rejection.path` is that key by design.
  const scan = scanOf(
    rootOf(ROOT, [
      ['alpha/issues/01-a.md', '# 01 — Alpha\n'],
      ['beta/issues/01-b.md', '# 01 — Beta\n'],
    ]),
  );
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = cardIn(probe, ROOT, 'alpha/issues/01-a.md');
  const featureSha = featureOf(probe, 'alpha').contentSha;

  const sentinels = {
    title: 'SENTINEL-TITLE-a1',
    dialect: 'SENTINEL-DIALECT-b2',
    blocker: 'SENTINEL-BLOCKER-c3',
    summary: 'SENTINEL-SUMMARY-d4',
    factLabel: 'SENTINEL-FACTLABEL-e5',
    factValue: 'SENTINEL-FACTVALUE-f6',
    factState: 'SENTINEL-FACTSTATE-g7',
    tone: 'SENTINEL-TONE-h8',
    bullet: 'SENTINEL-BULLET-i9',
    linkLabel: 'SENTINEL-LINKLABEL-j0',
    linkPath: 'SENTINEL-LINKPATH-k1',
    unknownValue: 'SENTINEL-UNKNOWNVALUE-l2',
    feature: 'SENTINEL-FEATURE-m3',
    factItem: 'SENTINEL-FACTITEM-n4',
    block: 'SENTINEL-BLOCK-o5',
    version: 'SENTINEL-VERSION-p6',
    envelope: 'SENTINEL-ENVELOPE-q7',
  };

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: card.contentSha,
          extraction: {
            title: { nested: sentinels.title },
            dialect: sentinels.dialect,
            blockedBy: [sentinels.blocker],
            criteria: { checked: sentinels.unknownValue, total: 2 },
          },
        },
        {
          schemaVersion: 1,
          filePath: featureKeyOf(probe, ROOT, 'alpha'),
          contentSha: featureSha,
          digest: {
            v: 1,
            feature: sentinels.feature,
            blocks: [
              { kind: 'summary', text: `${sentinels.summary} ${'x'.repeat(400)}` },
              {
                kind: 'facts',
                items: [
                  { label: sentinels.factLabel.repeat(3), value: sentinels.factValue.repeat(4), state: sentinels.factState },
                  sentinels.factItem,
                ],
              },
              { kind: 'bullets', tone: sentinels.tone, items: [sentinels.bullet.repeat(9), 'ok'] },
              { kind: 'links', items: [{ label: sentinels.linkLabel.repeat(4), path: absoluteWebUrl(`example.com/${sentinels.linkPath}`) }] },
              sentinels.block,
            ],
          },
        },
        // A second Feature whose envelope version and Feature name are strings, so the
        // type-shape descriptions are exercised on strings too rather than only on objects
        // and lists. Keyed to beta's real content hash — an entry keyed to content that does
        // not match is never validated at all, so its sentinels would assert nothing.
        {
          schemaVersion: 1,
          filePath: featureKeyOf(probe, ROOT, 'beta'),
          contentSha: featureOf(probe, 'beta').contentSha,
          digest: { v: sentinels.version, feature: sentinels.envelope, blocks: [] },
        },
      ],
    }),
  );

  assert.ok(snapshot.rejections.length > 0, 'nothing was refused, so this asserts nothing');

  const rendered = JSON.stringify(snapshot.rejections.map((rejection) => rejection.message));
  for (const [where, sentinel] of Object.entries(sentinels)) {
    assert.ok(
      !rendered.includes(sentinel),
      `a rejection message quoted the ${where} it refused. Messages name the field and the size; the value stays in the file it came from.`,
    );
  }
});

test('a rejected path is named but never quoted back into the Snapshot', () => {
  // `field` already says which link is wrong,
  // which is all the writer needs; quoting the value copies whatever it holds — including
  // credentials in a URL — onto the board and into anything the Snapshot is serialised to.
  const syntheticSecret = 'NOT-A-REAL-SECRET';
  const { snapshot, feature } = withDigest(
    envelope([
      SUMMARY,
      {
        kind: 'links',
        items: [
          {
            label: 'Roadmap',
            path: absoluteWebUrl(['user:', syntheticSecret, '@', 'example.com/x'].join('')),
          },
        ],
      },
    ]),
  );

  assert.equal(feature.digest.kind, 'never-written');
  assert.equal(named(snapshot.rejections, 'links.items[0].path').message, 'is an absolute URL; links are repo-relative paths');
  assert.ok(
    !JSON.stringify(snapshot).includes(syntheticSecret),
    'the refused path was copied into the Snapshot, so refusing it did not stop it being rendered',
  );
});

test('a Digest with far too many Blocks is refused once, not once per Block', () => {
  // Measured before this was bounded: 100,000 null Blocks produced 100,003
  // rejections. The Snapshot is re-serialised to every connected client on every re-scan,
  // so one malformed file amplified into a payload far larger than itself — and the useful
  // size rejection was buried under the 100,000 consequences that followed from it.
  const { snapshot, feature } = withDigest({
    v: 1,
    feature: 'alpha',
    blocks: Array.from({ length: 50_000 }, () => null),
  });

  assert.equal(feature.digest.kind, 'never-written');
  assert.equal(named(snapshot.rejections, 'blocks').message, '50000 > 6 Blocks');
  assert.equal(
    snapshot.rejections.length,
    1,
    `one malformed Digest produced ${snapshot.rejections.length} rejections. Refusing an over-long list means refusing it, not diagnosing every member of it.`,
  );
});

test('an unsafe integer is refused rather than silently rounded into a different Ticket', () => {
  // `JSON.parse` rounds past 2^53 — the text
  // 9007199254740993 arrives as ...992 — and `Number.isInteger` waves it through. A Ticket
  // number is an identity, so a rounded one points a blocker at a different Ticket.
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const store: AnnotationStore = JSON.parse(
    `{"schemaVersion":1,"entries":[{"schemaVersion":1,"filePath":${JSON.stringify(card.id)},"contentSha":${JSON.stringify(card.contentSha)},"extraction":{"blockedBy":[9007199254740993,1e100]}}]}`,
  );
  const snapshot = deriveSnapshot(scan, store);

  assert.deepEqual([...cardOf(snapshot, card.id).derivation.correctedFields], []);
  assert.equal(named(snapshot.rejections, 'extraction.blockedBy[0]').kind, 'override');
  assert.equal(named(snapshot.rejections, 'extraction.blockedBy[1]').kind, 'override');
});

test('an entry carrying an unreadable Digest is refused whole, Extraction included', () => {
  // A Digest is validated per Feature because the
  // Block rules need the Feature name — but its *envelope* needs nothing, and leaving that
  // out let an entry carrying `digest: "invalid"` be indexed and have its Extraction
  // applied. An entry is refused whole or not at all.
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);
  const parsedTitle = card.extraction.title;

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          filePath: card.id,
          contentSha: card.contentSha,
          digest: 'invalid',
          extraction: { title: 'APPLIED' },
        },
      ],
    }),
  );

  const after = cardOf(snapshot, card.id);
  assert.equal(after.extraction.title, parsedTitle);
  assert.deepEqual([...after.derivation.correctedFields], []);
  assert.equal(named(snapshot.rejections, 'digest').message, 'is not a Digest object');
});

test('the three as-of states describe Digests, not merely entries', () => {
  // `asOfState` answers about entries, and an
  // entry is not necessarily a Digest, so the liveness line lied in both directions.
  const scan = scanOf(
    rootOf(ROOT, [
      ['alpha/issues/01-a.md', '# 01 — Alpha\n'],
      ['beta/issues/01-b.md', '# 01 — Beta\n'],
    ]),
  );
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);

  const snapshot = deriveSnapshot(
    scan,
    asStore({
      schemaVersion: 1,
      entries: [
        // Stale, and never a Digest: this Feature has never had one.
        {
          schemaVersion: 1,
          filePath: featureKeyOf(probe, ROOT, 'alpha'),
          contentSha: 'a'.repeat(64),
          extraction: { title: 'not a Digest' },
        },
        // Current but digestless, with a real Digest behind it against older content.
        {
          schemaVersion: 1,
          filePath: featureKeyOf(probe, ROOT, 'beta'),
          contentSha: 'b'.repeat(64),
          digest: digestFor('beta'),
        },
        {
          schemaVersion: 1,
          filePath: featureKeyOf(probe, ROOT, 'beta'),
          contentSha: featureOf(probe, 'beta').contentSha,
          extraction: { title: 'not a Digest either' },
        },
      ],
    }),
  );

  assert.equal(
    featureOf(snapshot, 'alpha').digest.kind,
    'never-written',
    'an Extraction-only entry is not a Digest, so it cannot make one expire',
  );
  assert.equal(
    featureOf(snapshot, 'beta').digest.kind,
    'expired',
    'a digestless current entry must not hide a Digest that was written and has since expired',
  );
});

test('an oversized authored string is refused promptly rather than stalling the seam', () => {
  // Measured, not hypothetical. The per-field
  // caps are *reported*, not enforced before the content scans run, so a value arrives at
  // whatever length a file gives it. An unanchored, unbounded pattern in the link check
  // made that scan cost the square of the input: 100K characters took 3.9 seconds, and the
  // seam runs on every debounced file change. The board freezing is a worse failure than
  // any Digest it could have refused, and it is invisible in a suite of small fixtures.
  const enormous = 'a'.repeat(400_000);
  const started = process.hrtime.bigint();
  const { snapshot, feature } = withDigest(envelope([{ kind: 'summary', text: enormous }, FACTS]));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(named(snapshot.rejections, 'summary.text').message, '400000 > 200 chars');
  assert.equal(feature.digest.kind, 'never-written');
  assert.ok(
    elapsedMs < 4_000,
    `refusing one oversized string took ${elapsedMs.toFixed(0)} ms. Linear scanning does this in single-digit milliseconds; anything near a second means a scan whose cost is superlinear in the length of a value that arrives from a file.`,
  );
});

test('a malformed store degrades to an empty one and is counted rather than hidden', () => {
  const scan = scanOf(rootOf(ROOT, [['alpha/issues/01-a.md', '# 01 — Alpha\n']]));

  const notAStore: AnnotationStore = JSON.parse('"a string where a store belongs"');
  const flat = deriveSnapshot(scan, notAStore);
  assert.ok(
    flat.rejections.length > 0,
    'a corrupt store must not read identically to a store the AI has never written to',
  );

  const badEntries: AnnotationStore = JSON.parse('{"schemaVersion":1,"entries":{"0":{}}}');
  const wrapped = deriveSnapshot(scan, badEntries);
  assert.equal(named(wrapped.rejections, 'entries').kind, 'annotation');
});

test('a non-empty store does not make the Snapshot depend on anything but its input', () => {
  // The purity assertion in seam.test.ts runs against an empty store, so it cannot see an
  // Annotation read that iterates a set, hashes an object identity, or otherwise reorders
  // between calls. A board that changes when nothing changed is a board nobody trusts.
  const scan = scanOf(
    rootOf(ROOT, [
      ['alpha/issues/01-a.md', '# 01 — Alpha\n'],
      ['alpha/issues/02-b.md', '# 02 — Beta\n'],
      ['alpha/spec.md', 'alpha spec\n'],
    ]),
  );
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const card = probe.roots[0]?.features[0]?.tickets[0];
  assert.ok(card !== undefined);

  const store = asStore({
    schemaVersion: 1,
    entries: [
      { schemaVersion: 1, filePath: featureKeyOf(probe, ROOT, 'alpha'), contentSha: featureOf(probe, 'alpha').contentSha, digest: digestFor('alpha') },
      { schemaVersion: 1, filePath: card.id, contentSha: card.contentSha, extraction: { title: 'Corrected' } },
      { schemaVersion: 1, filePath: card.id, contentSha: 'f'.repeat(64), extraction: { title: 'Stale' } },
      { schemaVersion: 4, filePath: card.id, contentSha: 'aa' },
      { schemaVersion: 1, filePath: card.id, contentSha: 'bb', extraction: { lane: 'agent' } },
    ],
  });

  assert.deepEqual(deriveSnapshot(scan, store), deriveSnapshot(scan, store));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `null` text is a file that could not be read, which the scanner really does hand over. */
function rootOf(rootPath: string, files: readonly (readonly [string, string | null])[]): Root {
  return {
    path: rootPath,
    label: rootPath,
    trackerPath: `${rootPath}/.scratch`,
    files: files.map(([path, text]) => ({
      path,
      absPath: `${rootPath}/.scratch/${path}`,
      text,
    })),
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
}

function scanOf(...roots: readonly Root[]): Scan {
  return { roots };
}

/**
 * The Feature's Annotation key, **read off the Snapshot rather than rebuilt.**
 *
 * A card exposes both its key (`id`) and the Root-relative path that key was built from
 * (`path`), and a Feature's key is composed the same way from the Feature's own path. So the
 * Root-qualifying prefix is one minus the other, and the Feature's key is that prefix plus
 * `feature.path`. **Nothing here knows how the prefix is spelled**, which is the whole
 * point: this file previously rebuilt the key shape by hand, and a hand-built copy meant the
 * regression test for cross-Root key collisions was asserting that guarantee through a
 * private duplicate of the very construction that had to deliver it. A duplicated key
 * construction in a test makes the assertion repeat the implementation instead of checking it.
 *
 * The prefix is a property of the Root, not of the Feature, so any card in the Root will do
 * — which also means a Feature with no Tickets of its own still gets a key.
 */
function featureKeyOf(snapshot: Snapshot, rootPath: string, featureName: string): string {
  const root = snapshot.roots.find((candidate) => candidate.path === rootPath);
  assert.ok(root !== undefined, `no Root at ${rootPath} in the Snapshot`);
  const feature = root.features.find((candidate) => candidate.name === featureName);
  assert.ok(feature !== undefined, `no Feature named ${featureName} in ${rootPath}`);

  const card = root.features.flatMap((candidate) => candidate.tickets)[0];
  assert.ok(card !== undefined, `Root ${rootPath} has no card to read the key prefix from`);
  assert.ok(
    card.id.endsWith(card.path),
    `a card id must end with the path it was built from — got id "${card.id}" and path "${card.path}"`,
  );
  return `${card.id.slice(0, card.id.length - card.path.length)}${feature.path}`;
}

/**
 * A store as it actually arrives — round-tripped through JSON, so a declared type is a
 * claim about a file rather than a fact about it, and so an entry carrying a Lane can be
 * written at all.
 */
function asStore(value: object): AnnotationStore {
  const parsed: AnnotationStore = JSON.parse(JSON.stringify(value));
  return parsed;
}

function envelope(blocks: readonly object[]): object {
  return { v: 1, feature: 'alpha', blocks };
}

function digestFor(featureName: string): object {
  return {
    v: 1,
    feature: featureName,
    blocks: [
      { kind: 'summary', text: `${featureName} is in flight.` },
      {
        kind: 'facts',
        items: [
          { label: 'Tickets', value: '1' },
          { label: 'Done', value: '0' },
        ],
      },
    ],
  };
}

/**
 * The file count on `alpha`'s expired Digest, after `before` became `after`.
 *
 * The stored entry is assembled from a probe of `before` — its key, its `contentSha` and its
 * member list all **read off the Snapshot** rather than rebuilt here, the same way
 * `featureKeyOf` reads the key. That is the difference between this file asserting the
 * counting rule and this file asserting that the parser agrees with a private copy of the
 * parser: a test that hand-writes `path:sha` pairs encodes the path spelling, the
 * unreadable-file sentinel and the sort order, and would go on agreeing with a `core` that
 * had drifted away from all three.
 *
 * `stored` overrides fields on that entry, for the cases where the stored side is itself what
 * is under test. `{ memberShas: undefined }` drops the field, because the store round-trips
 * through JSON on the way in.
 */
function expiredCount(
  before: readonly (readonly [string, string | null])[],
  after: readonly (readonly [string, string | null])[],
  stored: object = {},
): number | null {
  const snapshot = deriveSnapshot(
    scanOf(rootOf(ROOT, after)),
    asStore({ schemaVersion: 1, entries: [{ ...storedDigestFor(before), ...stored }] }),
  );
  const digest = featureOf(snapshot, 'alpha').digest;
  assert.equal(digest.kind, 'expired', 'the fixture did not expire the Digest it meant to');
  return digest.kind === 'expired' ? digest.filesChanged : null;
}

/** A stored Digest entry for `alpha`, describing the Feature as it stands in `files`. */
function storedDigestFor(files: readonly (readonly [string, string | null])[]): object {
  const probe = deriveSnapshot(scanOf(rootOf(ROOT, files)), EMPTY_ANNOTATIONS);
  const feature = featureOf(probe, 'alpha');
  return {
    schemaVersion: 1,
    filePath: featureKeyOf(probe, ROOT, 'alpha'),
    contentSha: feature.contentSha,
    digest: digestFor('alpha'),
    memberShas: [...feature.memberShas],
  };
}

/** One Feature, one Digest, derived twice: once to learn its content hash, once for real. */
function withDigest(digest: object): { snapshot: Snapshot; feature: FeatureSnapshot } {
  const scan = scanOf(
    rootOf(ROOT, [
      ['alpha/issues/01-a.md', '# 01 — Alpha\n'],
      ['alpha/spec.md', 'alpha spec\n'],
    ]),
  );
  const probe = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const store = asStore({
    schemaVersion: 1,
    entries: [
      {
        schemaVersion: 1,
        filePath: featureKeyOf(probe, ROOT, 'alpha'),
        contentSha: featureOf(probe, 'alpha').contentSha,
        digest,
      },
    ],
  });
  const snapshot = deriveSnapshot(scan, store);
  return { snapshot, feature: featureOf(snapshot, 'alpha') };
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
 * A card found by the Root it is in and the path it was scanned at — both observable — so
 * that looking one up never means rebuilding the key shape by hand either.
 */
function cardIn(snapshot: Snapshot, rootPath: string, relPath: string): TicketCard {
  const root = snapshot.roots.find((candidate) => candidate.path === rootPath);
  assert.ok(root !== undefined, `no Root at ${rootPath} in the Snapshot`);
  for (const feature of root.features) {
    for (const ticket of feature.tickets) {
      if (ticket.path === relPath) return ticket;
    }
  }
  return assert.fail(`no card at ${relPath} in ${rootPath}`);
}

function cardOf(snapshot: Snapshot, id: string): TicketCard {
  for (const root of snapshot.roots) {
    for (const feature of root.features) {
      for (const ticket of feature.tickets) {
        if (ticket.id === id) return ticket;
      }
    }
  }
  return assert.fail(`no card with id ${id} in the Snapshot`);
}

function named(rejections: readonly Rejection[], field: string): Rejection {
  const hit = rejections.find((rejection) => rejection.field === field);
  if (hit !== undefined) return hit;
  const seen = rejections.map((rejection) => `${rejection.field}: ${rejection.message}`).join(' | ');
  return assert.fail(`no rejection named "${field}". Rejections were: ${seen || '(none)'}`);
}

function repeat<T>(count: number, make: (at: number) => T): readonly T[] {
  return Array.from({ length: count }, (_unused, at) => make(at));
}

/** Freezes an object and everything it holds, so a shared fixture cannot become shared state. */
function deepFreeze<T extends object>(value: T): T {
  for (const held of Object.values(value)) {
    if (typeof held === 'object' && held !== null) deepFreeze(held);
  }
  return Object.freeze(value);
}
