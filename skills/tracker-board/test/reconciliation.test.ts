/**
 * The standing independent-Extraction pass.
 *
 * These tests deliberately talk to a pure batch boundary. The model-facing plan never carries
 * the parser's answer, and the batch evaluator never touches disk: the CLI owns state I/O after
 * this module has either accepted the whole response or refused it whole.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveSnapshot } from '../core/index.ts';
import {
  MAX_RECONCILIATION_BATCH_RESULTS,
  MAX_RECONCILIATION_BLOCKERS,
  MAX_RECONCILIATION_PLAN_BYTES,
  MAX_RECONCILIATION_REJECTION_DETAILS,
  MAX_RECONCILIATION_RESPONSE_BYTES,
  MAX_RECONCILIATION_TEXT_BYTES,
  PARSER_BUG_THRESHOLD,
  planReconciliation,
  reconcileExtractions,
  type ReconciliationExtraction,
} from '../core/reconciliation.ts';
import type { AnnotationEntry, AnnotationStore, Root, Scan } from '../core/types.ts';
import { EMPTY_ANNOTATIONS } from './harness.ts';

const FIRST = '# 01 — First\n\nStatus: ready-for-agent\n\n- [ ] one\n';
const SECOND = '# 02 — Second\n\nStatus: claimed\n\n- [x] one\n';

test('the plan offers only readable changed Tickets and reveals no parser answer', () => {
  const scan = scanOf({
    'alpha/issues/01-first.md': FIRST,
    'alpha/issues/02-second.md': SECOND,
    'alpha/issues/03-unreadable.md': null,
    'alpha/spec.md': '# Alpha\n',
  });

  const first = planReconciliation(scan, EMPTY_ANNOTATIONS);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.cursor, null);
  assert.equal(first.nextCursor, null);
  assert.equal(first.candidates.length, 2);
  assert.deepEqual(
    first.candidates.map((candidate) => [candidate.filePath, candidate.source]),
    [
      [ticketAt(deriveSnapshot(scan, EMPTY_ANNOTATIONS), 'alpha/issues/01-first.md').id, FIRST],
      [ticketAt(deriveSnapshot(scan, EMPTY_ANNOTATIONS), 'alpha/issues/02-second.md').id, SECOND],
    ],
  );
  for (const candidate of first.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['candidateId', 'filePath', 'source']);
    assert.match(candidate.candidateId, /^[a-f0-9]{64}$/);
    for (const forbidden of ['contentSha', 'extraction', 'derivation', 'lane', 'state']) {
      assert.ok(!Object.hasOwn(candidate, forbidden), `candidate leaked ${forbidden}`);
    }
  }

  const settled = reconcileExtractions(scan, EMPTY_ANNOTATIONS, responseFor(first, scan));
  assert.equal(settled.report.accepted, true);
  assert.equal(settled.report.agreements, 2);
  assert.equal(settled.report.overrides, 0);
  assert.equal(settled.store.entries.length, 2);
  for (const entry of settled.store.entries) {
    assert.equal(entry.reconciled, true);
    assert.equal(entry.extraction, undefined);
  }
  assert.equal(planReconciliation(scan, settled.store).candidates.length, 0);

  const changed = replaceText(scan, 'alpha/issues/02-second.md', `${SECOND}\nEdited.\n`);
  assert.deepEqual(
    planReconciliation(changed, settled.store).candidates.map((candidate) => candidate.filePath),
    [ticketAt(deriveSnapshot(changed, EMPTY_ANNOTATIONS), 'alpha/issues/02-second.md').id],
  );
});

test('large changed sets are deterministic bounded pages that remain admissible', () => {
  const files = Object.fromEntries(
    Array.from({ length: MAX_RECONCILIATION_BATCH_RESULTS * 2 + 2 }, (_, at) => [
      `alpha/issues/${String(at + 1).padStart(4, '0')}-ticket.md`,
      `# ${String(at + 1)} — Ticket\n`,
    ]),
  );
  const scan = scanOf(files);
  const first = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const second = planReconciliation(scan, EMPTY_ANNOTATIONS, first.nextCursor);
  const third = planReconciliation(scan, EMPTY_ANNOTATIONS, second.nextCursor);

  assert.deepEqual(
    [first.candidates.length, second.candidates.length, third.candidates.length],
    [MAX_RECONCILIATION_BATCH_RESULTS, MAX_RECONCILIATION_BATCH_RESULTS, 2],
  );
  assert.equal(first.cursor, null);
  assert.equal(second.cursor, first.nextCursor);
  assert.equal(third.cursor, second.nextCursor);
  assert.equal(third.nextCursor, null);
  const ids = [...first.candidates, ...second.candidates, ...third.candidates].map(
    (candidate) => candidate.candidateId,
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [...ids].sort());
  for (const page of [first, second, third]) {
    assert.ok(
      new TextEncoder().encode(JSON.stringify(page, null, 2)).byteLength <=
        MAX_RECONCILIATION_PLAN_BYTES,
    );
  }
});

test('escape-heavy sources page by encoded plan bytes without losing candidates', () => {
  const escapedPayload = '\0'.repeat(3 * 1024 * 1024);
  const scan = scanOf({
    'alpha/issues/01-first.md': `# 01 — First\n${escapedPayload}`,
    'alpha/issues/02-second.md': `# 02 — Second\n${escapedPayload}`,
    'alpha/issues/03-third.md': `# 03 — Third\n${escapedPayload}`,
  });
  const pages: ReturnType<typeof planReconciliation>[] = [];
  let cursor: string | null = null;
  do {
    const page = planReconciliation(scan, EMPTY_ANNOTATIONS, cursor);
    pages.push(page);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(page, null, 2)).byteLength <=
        MAX_RECONCILIATION_PLAN_BYTES,
    );
    cursor = page.nextCursor;
  } while (cursor !== null);

  assert.deepEqual(pages.map((page) => page.candidates.length), [1, 1, 1]);
  const ids = pages.flatMap((page) => page.candidates.map((candidate) => candidate.candidateId));
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, [...ids].sort());
});

test('a dropped-version receipt re-flags its current file', () => {
  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const settled = reconcileExtractions(scan, EMPTY_ANNOTATIONS, responseFor(plan, scan));
  const receipt = settled.store.entries[0];
  assert.ok(receipt !== undefined);

  const dropped = {
    schemaVersion: 1,
    entries: [{ ...receipt, schemaVersion: 2 }],
  } satisfies AnnotationStore;

  assert.equal(planReconciliation(scan, dropped).candidates.length, 1);
});

test('a forged false receipt is rejected and cannot suppress reconciliation', () => {
  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const card = ticketAt(deriveSnapshot(scan, EMPTY_ANNOTATIONS), 'alpha/issues/01-first.md');
  assert.ok(card.contentSha !== null);
  const forged = {
    schemaVersion: 1,
    entries: [
      {
        schemaVersion: 1,
        filePath: card.id,
        contentSha: card.contentSha,
        reconciled: false,
      },
    ],
  } as unknown as AnnotationStore;

  const snapshot = deriveSnapshot(scan, forged);
  assert.ok(snapshot.rejections.some((rejection) => rejection.field === 'reconciled'));
  assert.equal(planReconciliation(scan, forged).candidates.length, 1);
});

test('parser-bug evidence accepts only a neutral non-empty Extraction envelope', () => {
  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const card = ticketAt(deriveSnapshot(scan, EMPTY_ANNOTATIONS), 'alpha/issues/01-first.md');
  assert.ok(card.contentSha !== null);
  const entry = {
    schemaVersion: 1,
    filePath: card.id,
    contentSha: card.contentSha,
  } as const;
  const falseMarker = {
    schemaVersion: 1,
    entries: [{ ...entry, parserBugExtraction: false }],
  } as unknown as AnnotationStore;
  const receiptMarker = {
    schemaVersion: 1,
    entries: [{ ...entry, parserBugExtraction: { title: 'Independent' }, reconciled: true }],
  } satisfies AnnotationStore;
  const emptyMarker = {
    schemaVersion: 1,
    entries: [{ ...entry, parserBugExtraction: {} }],
  } satisfies AnnotationStore;
  const overlappingMarker = {
    schemaVersion: 1,
    entries: [
      {
        ...entry,
        parserBugExtraction: { title: 'Independent' },
        extraction: { title: 'Applied' },
      },
    ],
  } satisfies AnnotationStore;
  const partialBlockerMarker = {
    schemaVersion: 1,
    entries: [{ ...entry, parserBugExtraction: { blockedBy: [1] } }],
  } satisfies AnnotationStore;
  const sentinel = 'PRIVATE_MARKER_SENTINEL';
  const oversizedTextMarker = {
    schemaVersion: 1,
    entries: [
      {
        ...entry,
        parserBugExtraction: {
          title: `${sentinel}${'x'.repeat(MAX_RECONCILIATION_TEXT_BYTES)}`,
        },
      },
    ],
  } satisfies AnnotationStore;
  const oversizedBlockerMarker = {
    schemaVersion: 1,
    entries: [
      {
        ...entry,
        parserBugExtraction: {
          blockedBy: Array.from({ length: MAX_RECONCILIATION_BLOCKERS + 1 }, () => 1),
          externalBlocker: null,
        },
      },
    ],
  } satisfies AnnotationStore;
  const unknownMarkerFields = {
    schemaVersion: 1,
    entries: [
      {
        ...entry,
        parserBugExtraction: {
          [sentinel]: 'private',
          criteria: { checked: 0, total: 0, [sentinel]: 1 },
        },
      },
    ],
  } as unknown as AnnotationStore;

  for (const malformed of [
    falseMarker,
    receiptMarker,
    emptyMarker,
    overlappingMarker,
    partialBlockerMarker,
    oversizedTextMarker,
    oversizedBlockerMarker,
    unknownMarkerFields,
  ]) {
    const rejected = deriveSnapshot(scan, malformed);
    assert.ok(
      rejected.rejections.some(
        (rejection) => rejection.field.startsWith('parserBugExtraction'),
      ),
    );
    assert.doesNotMatch(JSON.stringify(rejected.rejections), new RegExp(sentinel));
    assert.equal(planReconciliation(scan, malformed).candidates.length, 1);
  }
});

test('the response requires exactly all seven Extraction fields and rejects derived fields whole', () => {
  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const candidateId = plan.candidates[0]?.candidateId ?? '';
  const extraction = parserExtraction(scan, 'alpha/issues/01-first.md');

  const malformed = reconcileExtractions(scan, EMPTY_ANNOTATIONS, {
    schemaVersion: 1,
    results: [
      {
        candidateId,
        extraction: {
          title: extraction.title,
          criteria: extraction.criteria,
          blockedBy: extraction.blockedBy,
          externalBlocker: extraction.externalBlocker,
          rawStatus: extraction.rawStatus,
          ticketType: extraction.ticketType,
          lane: 'agent',
        },
      },
    ],
  });

  assert.equal(malformed.report.accepted, false);
  assert.deepEqual(malformed.store, EMPTY_ANNOTATIONS);
  assert.ok(malformed.report.rejections.some((rejection) => rejection.field.endsWith('.dialect')));
  assert.ok(malformed.report.rejections.some((rejection) => rejection.field.endsWith('.lane')));

  const valid = reconcileExtractions(scan, EMPTY_ANNOTATIONS, {
    schemaVersion: 1,
    results: [{ candidateId, extraction }],
  });
  assert.equal(valid.report.accepted, true);
  assert.equal(valid.store.entries.length, 1);
});

test('malformed Extraction values never enter rejection diagnostics', () => {
  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const sentinel = 'PRIVATE_TICKET_TEXT_SENTINEL';
  const result = reconcileExtractions(scan, EMPTY_ANNOTATIONS, {
    schemaVersion: 1,
    results: [
      {
        candidateId: plan.candidates[0]?.candidateId,
        extraction: {
          title: [sentinel],
          criteria: { checked: sentinel, total: 1 },
          blockedBy: [sentinel],
          externalBlocker: [sentinel],
          rawStatus: [sentinel],
          ticketType: [sentinel],
          dialect: 'task',
        },
      },
    ],
  });

  assert.equal(result.report.accepted, false);
  assert.ok(result.report.rejected > 0);
  assert.doesNotMatch(JSON.stringify(result.report), new RegExp(sentinel));

  let nested: unknown = sentinel;
  for (let depth = 0; depth < 20_000; depth += 1) nested = [nested];
  const deeplyMalformed = reconcileExtractions(scan, EMPTY_ANNOTATIONS, {
    schemaVersion: 1,
    results: [
      {
        candidateId: plan.candidates[0]?.candidateId,
        extraction: {
          ...parserExtraction(scan, 'alpha/issues/01-first.md'),
          title: nested,
        },
      },
    ],
  });
  assert.equal(deeplyMalformed.report.accepted, false);
  assert.doesNotMatch(JSON.stringify(deeplyMalformed.report), new RegExp(sentinel));
});

test('response field budgets keep every maximum page below the byte limit', () => {
  const text = '\0'.repeat(MAX_RECONCILIATION_TEXT_BYTES);
  const blockedBy = Array.from(
    { length: MAX_RECONCILIATION_BLOCKERS },
    () => Number.MAX_SAFE_INTEGER,
  );
  const response = {
    schemaVersion: 1,
    results: Array.from({ length: MAX_RECONCILIATION_BATCH_RESULTS }, (_, at) => ({
      candidateId: at.toString(16).padStart(64, '0'),
      extraction: {
        title: text,
        criteria: { checked: 0, total: 0 },
        blockedBy,
        externalBlocker: null,
        rawStatus: '',
        ticketType: null,
        dialect: 'task',
      },
    })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(response, null, 2)).byteLength;
  assert.ok(bytes > 12 * 1024 * 1024, 'the generated response did not exercise the real bound');
  assert.ok(bytes <= MAX_RECONCILIATION_RESPONSE_BYTES);

  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const extraction = parserExtraction(scan, 'alpha/issues/01-first.md');
  for (const overLimit of [
    { ...extraction, title: 'x'.repeat(MAX_RECONCILIATION_TEXT_BYTES + 1) },
    {
      ...extraction,
      blockedBy: Array.from({ length: MAX_RECONCILIATION_BLOCKERS + 1 }, () => 1),
    },
  ]) {
    const refused = reconcileExtractions(scan, EMPTY_ANNOTATIONS, {
      schemaVersion: 1,
      results: [{ candidateId: plan.candidates[0]?.candidateId ?? '', extraction: overLimit }],
    });
    assert.equal(refused.report.accepted, false);
    assert.ok(refused.report.rejected > 0);
  }
});

test('hostile result arrays and diagnostics are bounded before they can amplify', () => {
  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const mismatch = reconcileExtractions(scan, EMPTY_ANNOTATIONS, {
    schemaVersion: 1,
    results: Array.from({ length: 100_000 }, () => null),
  });
  assert.equal(mismatch.report.accepted, false);
  assert.equal(mismatch.report.rejected, 1);
  assert.equal(mismatch.report.rejections.length, 1);

  const files = Object.fromEntries(
    Array.from({ length: MAX_RECONCILIATION_BATCH_RESULTS }, (_, at) => [
      `alpha/issues/${String(at + 1).padStart(4, '0')}-ticket.md`,
      `# ${String(at + 1)} — Ticket\n`,
    ]),
  );
  const crowded = scanOf(files);
  const plan = planReconciliation(crowded, EMPTY_ANNOTATIONS);
  const malformed = reconcileExtractions(crowded, EMPTY_ANNOTATIONS, {
    schemaVersion: 1,
    results: plan.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      extraction: {},
    })),
  });
  assert.equal(malformed.report.accepted, false);
  assert.ok(malformed.report.rejected > malformed.report.rejections.length);
  assert.ok(
    malformed.report.rejections.length <= MAX_RECONCILIATION_REJECTION_DETAILS + 1,
  );
});

test('missing, duplicate, and stale candidate results refuse the whole batch', () => {
  const scan = scanOf({
    'alpha/issues/01-first.md': FIRST,
    'alpha/issues/02-second.md': SECOND,
  });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const first = plan.candidates[0];
  assert.ok(first !== undefined);
  const extraction = parserExtractionById(scan, first.filePath);

  for (const results of [
    [{ candidateId: first.candidateId, extraction }],
    [
      { candidateId: first.candidateId, extraction },
      { candidateId: first.candidateId, extraction },
    ],
    [
      { candidateId: 'f'.repeat(64), extraction },
      { candidateId: plan.candidates[1]?.candidateId ?? '', extraction },
    ],
  ]) {
    const refused = reconcileExtractions(scan, EMPTY_ANNOTATIONS, { schemaVersion: 1, results });
    assert.equal(refused.report.accepted, false);
    assert.deepEqual(refused.store, EMPTY_ANNOTATIONS);
    assert.ok(refused.report.rejections.length > 0);
  }
});

test('one disagreement becomes a hash-keyed Override and code re-derives companion fields', () => {
  const scan = scanOf({
    'alpha/issues/01-first.md':
      '# 01 — Parser title\n\nType: task\nStatus: ready-for-agent\n\n- [ ] one\n',
  });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const extraction = parserExtraction(scan, 'alpha/issues/01-first.md');
  const corrected: ReconciliationExtraction = {
    ...extraction,
    title: 'Independent title',
    criteria: { checked: 1, total: 1 },
    blockedBy: [99],
    externalBlocker: 'outside dependency',
    rawStatus: 'ready-for-human — inspect it',
    ticketType: 'HITL task',
    dialect: 'task',
  };

  const result = reconcileExtractions(scan, EMPTY_ANNOTATIONS, {
    schemaVersion: 1,
    results: [{ candidateId: plan.candidates[0]?.candidateId ?? '', extraction: corrected }],
  });

  assert.equal(result.report.accepted, true);
  assert.equal(result.report.agreements, 0);
  assert.equal(result.report.overrides, 1);
  assert.deepEqual(result.store.entries[0]?.extraction, {
    title: 'Independent title',
    criteria: { checked: 1, total: 1 },
    blockedBy: [99],
    externalBlocker: 'outside dependency',
    rawStatus: 'ready-for-human — inspect it',
    ticketType: 'HITL task',
    dialect: 'task',
  });

  const card = ticketAt(deriveSnapshot(scan, result.store), 'alpha/issues/01-first.md');
  assert.deepEqual(card.derivation.correctedFields, [
    'title',
    'criteria',
    'blockedBy',
    'externalBlocker',
    'rawStatus',
    'ticketType',
    'dialect',
  ]);
  assert.equal(card.extraction.statusPrefix, 'ready-for-human');
  assert.equal(card.extraction.qualifier, '— inspect it');
  assert.equal(card.extraction.hitl, true);
  assert.equal(card.derivation.lane, 'needs-you');

  const edited = replaceText(scan, 'alpha/issues/01-first.md', `${FIRST}\nChanged source.\n`);
  const expired = ticketAt(deriveSnapshot(edited, result.store), 'alpha/issues/01-first.md');
  assert.deepEqual(expired.derivation.correctedFields, []);
  assert.equal(planReconciliation(edited, result.store).candidates.length, 1);
});

test('three files disagreeing in one parser component produce one parser-bug report', () => {
  assert.equal(PARSER_BUG_THRESHOLD, 3);
  const scan = scanOf({
    'alpha/issues/01-first.md': FIRST,
    'alpha/issues/02-second.md': SECOND,
    'alpha/issues/03-third.md': '# 03 — Third\n\nStatus: parked\n',
  });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const response = responseFor(plan, scan, (extraction, at) => ({
    ...extraction,
    title: `Independent ${String(at + 1)}`,
  }));

  const result = reconcileExtractions(scan, EMPTY_ANNOTATIONS, response);

  assert.equal(result.report.accepted, true);
  assert.equal(result.report.agreements, 0);
  assert.equal(result.report.overrides, 0);
  assert.equal(result.store.entries.length, 3);
  assert.ok(
    result.store.entries.every(
      (entry) =>
        entry.reconciled === undefined &&
        entry.extraction === undefined &&
        typeof entry.parserBugExtraction?.title === 'string',
    ),
  );
  assert.deepEqual(result.report.parserBugs, [
    {
      component: 'identity',
      affected: 3,
      candidateIds: plan.candidates.map((candidate) => candidate.candidateId),
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result.report), /Independent/);
  for (const candidate of plan.candidates) {
    assert.deepEqual(
      ticket(deriveSnapshot(scan, result.store), candidate.filePath).derivation.correctedFields,
      [],
    );
  }
  assert.equal(planReconciliation(scan, result.store).candidates.length, 3);
});

test('an unchanged parser-bug evidence batch is a store no-op', () => {
  const scan = scanOf({
    'alpha/issues/01-first.md': FIRST,
    'alpha/issues/02-second.md': SECOND,
    'alpha/issues/03-third.md': '# 03 â€” Third\n\nStatus: parked\n',
  });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const response = responseFor(plan, scan, (extraction, at) => ({
    ...extraction,
    title: `Independent ${String(at + 1)}`,
  }));
  const first = reconcileExtractions(scan, EMPTY_ANNOTATIONS, response);
  const repeated = reconcileExtractions(scan, first.store, responseFor(plan, scan, (extraction, at) => ({
    ...extraction,
    title: `Independent ${String(at + 1)}`,
  })));

  assert.equal(repeated.report.accepted, true);
  assert.equal(repeated.report.overrides, 0);
  assert.equal(repeated.report.parserBugs[0]?.affected, 3);
  assert.equal(repeated.store, first.store);
});

test('parser-bug evidence accumulates across changed-only invocations and clears prior Overrides', () => {
  const paths = [
    'alpha/issues/01-first.md',
    'alpha/issues/02-second.md',
    'alpha/issues/03-third.md',
  ] as const;
  let scan = scanOf({
    [paths[0]]: FIRST,
    [paths[1]]: SECOND,
    [paths[2]]: '# 03 — Third\n\nStatus: parked\n',
  });
  let store = reconcileExtractions(
    scan,
    EMPTY_ANNOTATIONS,
    responseFor(planReconciliation(scan, EMPTY_ANNOTATIONS), scan),
  ).store;
  const currentCandidateIds: string[] = [];
  let final: ReturnType<typeof reconcileExtractions> | null = null;

  for (const [at, path] of paths.entries()) {
    const original = scan.roots[0]?.files.find((file) => file.path === path)?.text;
    assert.ok(typeof original === 'string');
    scan = replaceText(scan, path, `${original}\nChanged ${String(at + 1)}.\n`);
    const plan = planReconciliation(scan, store);
    assert.equal(plan.candidates.length, 1);
    currentCandidateIds.push(plan.candidates[0]?.candidateId ?? '');
    const result = reconcileExtractions(
      scan,
      store,
      responseFor(plan, scan, (extraction) => ({
        ...extraction,
        title: `Independent ${String(at + 1)}`,
      })),
    );

    if (at === 0) {
      const currentId = plan.candidates[0]?.filePath;
      store = {
        ...result.store,
        entries: result.store.entries.map((entry) =>
          entry.filePath === currentId && entry.reconciled === true
            ? {
                ...entry,
                digest: { v: 1, feature: 'kept', blocks: [] },
                memberShas: ['kept:material'],
              }
            : entry,
        ),
      };
    } else {
      store = result.store;
    }
    final = result;

    if (at < PARSER_BUG_THRESHOLD - 1) {
      assert.equal(result.report.overrides, 1);
      assert.deepEqual(result.report.parserBugs, []);
    }
  }

  assert.ok(final !== null);
  assert.equal(final.report.overrides, 0);
  assert.deepEqual(final.report.parserBugs, [
    { component: 'identity', affected: 3, candidateIds: [...currentCandidateIds].sort() },
  ]);
  assert.equal(planReconciliation(scan, store).candidates.length, 3);
  assert.ok(
    store.entries.some(
      (entry) =>
        entry.digest !== undefined &&
        entry.memberShas !== undefined &&
        entry.extraction === undefined &&
        entry.reconciled === undefined &&
        typeof entry.parserBugExtraction?.title === 'string',
    ),
  );
  for (const path of paths) {
    assert.deepEqual(ticketAt(deriveSnapshot(scan, store), path).derivation.correctedFields, []);
  }
});

test('parser-bug evidence crosses a pagination boundary without starving the later page', () => {
  const files = Object.fromEntries(
    Array.from({ length: MAX_RECONCILIATION_BATCH_RESULTS + 1 }, (_, at) => [
      `alpha/issues/${String(at + 1).padStart(4, '0')}-ticket.md`,
      `# ${String(at + 1)} — Ticket\n`,
    ]),
  );
  const scan = scanOf(files);
  const first = planReconciliation(scan, EMPTY_ANNOTATIONS);
  assert.equal(first.candidates.length, MAX_RECONCILIATION_BATCH_RESULTS);
  assert.ok(first.nextCursor !== null);
  const firstBugIds = first.candidates.slice(0, 2).map((candidate) => candidate.candidateId);
  const firstResult = reconcileExtractions(
    scan,
    EMPTY_ANNOTATIONS,
    responseFor(first, scan, (extraction, at) =>
      at < 2 ? { ...extraction, title: `Independent ${String(at + 1)}` } : extraction,
    ),
  );
  assert.equal(firstResult.report.overrides, 2);

  const second = planReconciliation(scan, firstResult.store, first.nextCursor);
  assert.equal(second.candidates.length, 1);
  const secondResult = reconcileExtractions(
    scan,
    firstResult.store,
    responseFor(second, scan, (extraction) => ({ ...extraction, title: 'Independent later' })),
    first.nextCursor,
  );

  assert.deepEqual(secondResult.report.parserBugs, [
    {
      component: 'identity',
      affected: 3,
      candidateIds: [...firstBugIds, second.candidates[0]?.candidateId ?? ''].sort(),
    },
  ]);
  const pending = new Set(
    planReconciliation(scan, secondResult.store).candidates.map((candidate) => candidate.candidateId),
  );
  for (const candidateId of [...firstBugIds, second.candidates[0]?.candidateId ?? '']) {
    assert.ok(pending.has(candidateId));
  }
});

test('promoted component evidence keeps a later page in the same parser bug', () => {
  const files = Object.fromEntries(
    Array.from({ length: MAX_RECONCILIATION_BATCH_RESULTS + 6 }, (_, at) => [
      `alpha/issues/${String(at + 1).padStart(4, '0')}-ticket.md`,
      `# ${String(at + 1)} — Ticket\n`,
    ]),
  );
  const scan = scanOf(files);
  const initialFirst = planReconciliation(scan, EMPTY_ANNOTATIONS);
  assert.ok(initialFirst.nextCursor !== null);
  const initialTail = planReconciliation(scan, EMPTY_ANNOTATIONS, initialFirst.nextCursor);
  const priorCandidates = initialTail.candidates.slice(-2);
  assert.equal(priorCandidates.length, 2);
  const priorIds = new Set(priorCandidates.map((candidate) => candidate.candidateId));
  const priorStore: AnnotationStore = {
    schemaVersion: 1,
    entries: priorCandidates.map((candidate) => {
      const card = ticket(deriveSnapshot(scan, EMPTY_ANNOTATIONS), candidate.filePath);
      assert.ok(card.contentSha !== null);
      return {
        schemaVersion: 1,
        filePath: card.id,
        contentSha: card.contentSha,
        reconciled: true,
        extraction: { title: `Independent ${card.path}` },
      };
    }),
  };

  const first = planReconciliation(scan, priorStore);
  assert.equal(first.candidates.length, MAX_RECONCILIATION_BATCH_RESULTS);
  assert.ok(first.nextCursor !== null);
  const promotedId = first.candidates[0]?.candidateId ?? '';
  const promoted = reconcileExtractions(
    scan,
    priorStore,
    responseFor(first, scan, (extraction, at) =>
      at === 0 ? { ...extraction, title: 'Independent current page' } : extraction,
    ),
  );
  assert.equal(promoted.report.parserBugs[0]?.affected, 3);

  const continued = planReconciliation(scan, promoted.store, first.nextCursor);
  assert.equal(continued.candidates.length, 6);
  assert.equal(continued.candidates.filter((candidate) => priorIds.has(candidate.candidateId)).length, 2);
  const laterPromoted = continued.candidates.find(
    (candidate) => !priorIds.has(candidate.candidateId),
  );
  assert.ok(laterPromoted !== undefined);
  const laterPromotedId = laterPromoted.candidateId;
  const continuedResult = reconcileExtractions(
    scan,
    promoted.store,
    responseFor(continued, scan, (extraction, _at, candidate) =>
      priorIds.has(candidate.candidateId) || candidate.candidateId === laterPromotedId
        ? { ...extraction, title: 'Independent continuation page' }
        : extraction,
    ),
    first.nextCursor,
  );
  assert.equal(continuedResult.report.overrides, 0);
  assert.deepEqual(continuedResult.report.parserBugs, [
    {
      component: 'identity',
      affected: 4,
      candidateIds: [...priorIds, promotedId, laterPromotedId].sort(),
    },
  ]);
  assert.deepEqual(
    new Set(
      planReconciliation(scan, continuedResult.store).candidates.map(
        (candidate) => candidate.candidateId,
      ),
    ),
    new Set([...priorIds, promotedId, laterPromotedId]),
  );
});

test('more than one page of prior parser-bug evidence remains eligible until checked', () => {
  const files = Object.fromEntries(
    Array.from({ length: MAX_RECONCILIATION_BATCH_RESULTS + 6 }, (_, at) => [
      `alpha/issues/${String(at + 1).padStart(4, '0')}-ticket.md`,
      `# ${String(at + 1)} — Ticket\n`,
    ]),
  );
  const scan = scanOf(files);
  const cards = deriveSnapshot(scan, EMPTY_ANNOTATIONS).roots
    .flatMap((root) => root.features)
    .flatMap((feature) => feature.tickets);
  const deferredStore: AnnotationStore = {
    schemaVersion: 1,
    entries: cards.map((card) => {
      assert.ok(card.contentSha !== null);
      return {
        schemaVersion: 1,
        filePath: card.id,
        contentSha: card.contentSha,
        parserBugExtraction: { title: `Independent ${card.path}` },
      };
    }),
  };

  const first = planReconciliation(scan, deferredStore);
  assert.equal(first.candidates.length, MAX_RECONCILIATION_BATCH_RESULTS);
  assert.ok(first.nextCursor !== null);
  const firstResult = reconcileExtractions(scan, deferredStore, responseFor(first, scan));
  assert.equal(firstResult.report.agreements, MAX_RECONCILIATION_BATCH_RESULTS);

  const second = planReconciliation(scan, firstResult.store, first.nextCursor);
  assert.equal(second.candidates.length, 6);
  const secondResult = reconcileExtractions(
    scan,
    firstResult.store,
    responseFor(second, scan),
    first.nextCursor,
  );
  assert.equal(secondResult.report.agreements, 6);
  assert.equal(planReconciliation(scan, secondResult.store).candidates.length, 0);
});

test('stale parser-bug evidence is re-diffed across a pagination boundary', () => {
  const files = Object.fromEntries(
    Array.from({ length: MAX_RECONCILIATION_BATCH_RESULTS + 6 }, (_, at) => [
      `alpha/issues/${String(at + 1).padStart(4, '0')}-ticket.md`,
      `# ${String(at + 1)} — Ticket\n`,
    ]),
  );
  const scan = scanOf(files);
  const emptyFirst = planReconciliation(scan, EMPTY_ANNOTATIONS);
  assert.ok(emptyFirst.nextCursor !== null);
  const emptyTail = planReconciliation(scan, EMPTY_ANNOTATIONS, emptyFirst.nextCursor);
  const staleCandidates = emptyTail.candidates.slice(0, 3);
  assert.equal(staleCandidates.length, 3);
  const snapshot = deriveSnapshot(scan, EMPTY_ANNOTATIONS);
  const staleStore: AnnotationStore = {
    schemaVersion: 1,
    entries: staleCandidates.map((candidate) => {
      const card = ticket(snapshot, candidate.filePath);
      assert.ok(card.contentSha !== null);
      return {
        schemaVersion: 1,
        filePath: card.id,
        contentSha: card.contentSha,
        // This used to disagree, but now equals the fixed parser. It must not remain evidence.
        parserBugExtraction: { title: card.extraction.title },
      };
    }),
  };
  assert.deepEqual(deriveSnapshot(scan, staleStore).rejections, []);

  const first = planReconciliation(scan, staleStore);
  assert.equal(first.candidates.length, MAX_RECONCILIATION_BATCH_RESULTS);
  assert.ok(first.nextCursor !== null);
  const staleIds = new Set(staleCandidates.map((candidate) => candidate.candidateId));
  assert.equal(first.candidates.filter((candidate) => staleIds.has(candidate.candidateId)).length, 0);
  const oneOffId = first.candidates[0]?.candidateId ?? '';
  const result = reconcileExtractions(
    scan,
    staleStore,
    responseFor(first, scan, (extraction, at) =>
      at === 0 ? { ...extraction, title: 'Independent one-off' } : extraction,
    ),
  );

  assert.equal(result.report.overrides, 1);
  assert.deepEqual(result.report.parserBugs, []);
  assert.ok(
    result.store.entries.some(
      (entry) =>
        entry.reconciled === true &&
        entry.extraction?.title === 'Independent one-off' &&
        entry.filePath === first.candidates[0]?.filePath &&
        oneOffId.length > 0,
    ),
  );
});

test('the parser-bug threshold counts distinct files across Roots', () => {
  const scan: Scan = {
    roots: [
      scanOf({ 'alpha/issues/01-first.md': FIRST }, '/repo-a').roots[0] as Root,
      scanOf({ 'alpha/issues/01-first.md': FIRST }, '/repo-b').roots[0] as Root,
      scanOf({ 'alpha/issues/01-first.md': FIRST }, '/other').roots[0] as Root,
    ],
  };
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const result = reconcileExtractions(
    scan,
    EMPTY_ANNOTATIONS,
    responseFor(plan, scan, (extraction, at) => ({
      ...extraction,
      title: `Independent ${String(at)}`,
    })),
  );

  assert.equal(new Set(plan.candidates.map((candidate) => candidate.filePath)).size, 3);
  assert.equal(result.report.parserBugs[0]?.component, 'identity');
  assert.equal(result.report.parserBugs[0]?.candidateIds.length, 3);
  assert.equal(result.store.entries.length, 3);
});

test('one-off fields still apply while another field on that file is a parser bug', () => {
  const scan = scanOf({
    'alpha/issues/01-first.md': FIRST,
    'alpha/issues/02-second.md': SECOND,
    'alpha/issues/03-third.md': '# 03 — Third\n\nStatus: parked\n',
    'alpha/issues/04-fourth.md': '# 04 — Fourth\n\nStatus: ready-for-human\n',
  });
  const plan = planReconciliation(scan, EMPTY_ANNOTATIONS);
  const response = responseFor(plan, scan, (extraction, at, candidate) => {
    if (!candidate.filePath.endsWith('04-fourth.md')) {
      return {
        ...extraction,
        title: `Independent ${String(at + 1)}`,
        ...(candidate.filePath.endsWith('01-first.md')
          ? { rawStatus: 'claimed — unique' }
          : {}),
      };
    }
    return { ...extraction, rawStatus: 'parked' };
  });

  const result = reconcileExtractions(scan, EMPTY_ANNOTATIONS, response);

  assert.equal(result.report.accepted, true);
  assert.deepEqual(result.report.parserBugs.map((bug) => bug.component), ['identity']);
  assert.equal(result.report.overrides, 2);
  assert.equal(result.report.agreements, 0);
  assert.equal(result.store.entries.length, 4);
  const overrideEntries = result.store.entries.filter((entry) => entry.extraction !== undefined);
  assert.equal(overrideEntries.length, 2);
  const firstEntry = overrideEntries.find((entry) => entry.filePath.endsWith('01-first.md'));
  const fourthEntry = overrideEntries.find((entry) => entry.filePath.endsWith('04-fourth.md'));
  assert.deepEqual(firstEntry?.extraction, { rawStatus: 'claimed — unique' });
  assert.equal(typeof firstEntry?.parserBugExtraction?.title, 'string');
  assert.deepEqual(fourthEntry?.extraction, { rawStatus: 'parked' });
  assert.equal(fourthEntry?.parserBugExtraction, undefined);
  assert.deepEqual(
    planReconciliation(scan, result.store).candidates.map((candidate) => candidate.filePath).sort(),
    plan.candidates
      .filter((candidate) => !candidate.filePath.endsWith('04-fourth.md'))
      .map((candidate) => candidate.filePath)
      .sort(),
  );
});

test('a current agreement receipt clears an older expired Override from pending recheck', () => {
  const oldScan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const oldPlan = planReconciliation(oldScan, EMPTY_ANNOTATIONS);
  const oldExtraction = parserExtraction(oldScan, 'alpha/issues/01-first.md');
  const oldOverride = reconcileExtractions(oldScan, EMPTY_ANNOTATIONS, {
    schemaVersion: 1,
    results: [
      {
        candidateId: oldPlan.candidates[0]?.candidateId ?? '',
        extraction: { ...oldExtraction, title: 'Old correction' },
      },
    ],
  }).store;

  const currentScan = replaceText(oldScan, 'alpha/issues/01-first.md', `${FIRST}\nNew source.\n`);
  assert.equal(deriveSnapshot(currentScan, oldOverride).liveness.overridesPendingRecheck, 1);

  const currentPlan = planReconciliation(currentScan, oldOverride);
  const settled = reconcileExtractions(currentScan, oldOverride, responseFor(currentPlan, currentScan));

  assert.equal(deriveSnapshot(currentScan, settled.store).liveness.overridesPendingRecheck, 0);
  assert.equal(planReconciliation(currentScan, settled.store).candidates.length, 0);
});

test('a superseded historical receipt cannot clear an expired Override pending count', () => {
  const oldScan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const oldCard = ticketAt(deriveSnapshot(oldScan, EMPTY_ANNOTATIONS), 'alpha/issues/01-first.md');
  assert.ok(oldCard.contentSha !== null);
  const currentScan = replaceText(oldScan, 'alpha/issues/01-first.md', `${FIRST}\nNew source.\n`);
  const currentCard = ticketAt(
    deriveSnapshot(currentScan, EMPTY_ANNOTATIONS),
    'alpha/issues/01-first.md',
  );
  assert.ok(currentCard.contentSha !== null);
  const store: AnnotationStore = {
    schemaVersion: 1,
    entries: [
      {
        schemaVersion: 1,
        filePath: oldCard.id,
        contentSha: oldCard.contentSha,
        extraction: { title: 'Old correction' },
      },
      {
        schemaVersion: 1,
        filePath: currentCard.id,
        contentSha: currentCard.contentSha,
        reconciled: true,
      },
      {
        schemaVersion: 1,
        filePath: currentCard.id,
        contentSha: currentCard.contentSha,
      },
    ],
  };

  const snapshot = deriveSnapshot(currentScan, store);
  assert.equal(snapshot.liveness.overridesPendingRecheck, 1);
  assert.equal(planReconciliation(currentScan, store).candidates.length, 1);
});

test('a same-key reconciliation replaces legacy Extraction but preserves Digest material', () => {
  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const card = ticketAt(deriveSnapshot(scan, EMPTY_ANNOTATIONS), 'alpha/issues/01-first.md');
  assert.ok(card.contentSha !== null);
  const legacy: AnnotationEntry = {
    schemaVersion: 1,
    filePath: card.id,
    contentSha: card.contentSha,
    extraction: { title: 'Legacy correction' },
    digest: { v: 1, feature: 'kept', blocks: [] },
    memberShas: ['kept:material'],
  };
  const store: AnnotationStore = { schemaVersion: 1, entries: [legacy] };
  const plan = planReconciliation(scan, store);
  assert.equal(plan.candidates.length, 1);

  const result = reconcileExtractions(scan, store, responseFor(plan, scan));

  assert.equal(result.report.accepted, true);
  assert.equal(result.store.entries.length, 1);
  assert.deepEqual(result.store.entries[0], {
    schemaVersion: 1,
    filePath: card.id,
    contentSha: card.contentSha,
    reconciled: true,
    digest: legacy.digest,
    memberShas: legacy.memberShas,
  });
});

test('a valid same-key retry removes an earlier malformed entry and its rejection', () => {
  const scan = scanOf({ 'alpha/issues/01-first.md': FIRST });
  const card = ticketAt(deriveSnapshot(scan, EMPTY_ANNOTATIONS), 'alpha/issues/01-first.md');
  assert.ok(card.contentSha !== null);
  const malformed = {
    schemaVersion: 1,
    entries: [
      {
        schemaVersion: 1,
        filePath: card.id,
        contentSha: card.contentSha,
        extraction: { title: 'Bad retry' },
        lane: 'agent',
      },
    ],
  } as unknown as AnnotationStore;
  assert.ok(deriveSnapshot(scan, malformed).rejections.length > 0);
  const plan = planReconciliation(scan, malformed);

  const result = reconcileExtractions(scan, malformed, responseFor(plan, scan));

  assert.equal(result.report.accepted, true);
  assert.equal(result.store.entries.length, 1);
  assert.equal(deriveSnapshot(scan, result.store).rejections.length, 0);
});

function responseFor(
  plan: ReturnType<typeof planReconciliation>,
  scan: Scan,
  alter: (
    extraction: ReconciliationExtraction,
    at: number,
    candidate: (typeof plan.candidates)[number],
  ) => ReconciliationExtraction =
    (extraction) => extraction,
): object {
  return {
    schemaVersion: 1,
    results: plan.candidates.map((candidate, at) => ({
      candidateId: candidate.candidateId,
      extraction: alter(parserExtractionById(scan, candidate.filePath), at, candidate),
    })),
  };
}

function parserExtractionById(scan: Scan, id: string): ReconciliationExtraction {
  return extractionOf(ticket(deriveSnapshot(scan, EMPTY_ANNOTATIONS), id).extraction);
}

function parserExtraction(scan: Scan, path: string): ReconciliationExtraction {
  return extractionOf(ticketAt(deriveSnapshot(scan, EMPTY_ANNOTATIONS), path).extraction);
}

function extractionOf(extraction: ReturnType<typeof ticket>['extraction']): ReconciliationExtraction {
  return {
    title: extraction.title,
    criteria: {
      checked: extraction.criteria.checked,
      total: extraction.criteria.total,
    },
    blockedBy: [...extraction.blockedBy],
    externalBlocker: extraction.externalBlocker,
    rawStatus: extraction.rawStatus,
    ticketType: extraction.ticketType,
    dialect: extraction.dialect,
  };
}

function ticket(snapshot: ReturnType<typeof deriveSnapshot>, id: string) {
  const found = snapshot.roots
    .flatMap((root) => root.features)
    .flatMap((feature) => feature.tickets)
    .find((card) => card.id === id);
  assert.ok(found !== undefined, `no Ticket ${id}`);
  return found;
}

function ticketAt(snapshot: ReturnType<typeof deriveSnapshot>, path: string) {
  const found = snapshot.roots
    .flatMap((root) => root.features)
    .flatMap((feature) => feature.tickets)
    .find((card) => card.path === path);
  assert.ok(found !== undefined, `no Ticket at ${path}`);
  return found;
}

function scanOf(files: Readonly<Record<string, string | null>>, path = '/repo'): Scan {
  const root: Root = {
    path,
    label: path.slice(path.lastIndexOf('/') + 1) || 'repo',
    trackerPath: `${path}/.scratch`,
    files: Object.entries(files).map(([filePath, text]) => ({
      path: filePath,
      absPath: `${path}/.scratch/${filePath}`,
      text,
      ...(text === null ? { readError: 'unreadable' } : {}),
    })),
    hiddenWorktrees: 0,
    tracker: 'local-markdown',
    adrFiles: [],
    glossaryFile: null,
  };
  return { roots: [root] };
}

function replaceText(scan: Scan, path: string, text: string): Scan {
  return {
    roots: scan.roots.map((root) => ({
      ...root,
      files: root.files.map((file) =>
        file.path === path ? { path: file.path, absPath: file.absPath, text } : file,
      ),
    })),
  };
}
