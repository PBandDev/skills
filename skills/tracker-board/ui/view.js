/**
 * tracker-board - Snapshot to view model.
 *
 * Pure. No DOM, no fetch, no clock. Everything the board decides about *what* to show lives
 * here, and everything about *how* to put it on screen lives in `render.js`. That split is the
 * reason this file exists: a browser is an expensive place to assert anything, and the
 * decisions worth asserting - which column a card lands in, what its meter reads, which Ticket
 * a Frozen chain ends at, what the header claims - are all answerable without one.
 *
 * So the rule this file keeps is stricter than "no DOM": every string the reader will see,
 * every glyph, every count and every ordering is decided here and carried as data. `render.js`
 * puts values into nodes and never chooses one. A criterion that cannot be checked without a
 * browser is a criterion that will be checked by nobody, and this is what stops that happening.
 *
 * ## What this file does not decide
 *
 * Lane, state, Frontier membership and the Frozen chain all arrive already computed on the
 * Snapshot. Recomputing any of them here would be a second, staler copy of rules that live in
 * `core/` and are tested there - and the two copies would disagree the first time either
 * moved. Where this file appears to make such a judgement it is reading a derived field:
 * `derivation.lane`, `derivation.state`, `derivation.frozenOn`, `snapshot.frontierCount`,
 * `snapshot.progress.label`.
 *
 * ## Seven Lanes, six columns
 *
 * `frozen` and `blocked` share the Blocked column as labelled sub-lanes. Both are unstartable
 * and they differ only in who can clear them, so folding them together would hand the reader
 * one instruction where the board means two opposite ones. Splitting them into two columns
 * would say they are different kinds of work, which they are not.
 *
 * ## Nothing synthetic enters a Lane
 *
 * The card legend needs an `unclassified` specimen whether or not any file scores that way,
 * because the treatment has to exist before the first real one arrives. That specimen is built
 * here and marked `specimen: true`, and it is reachable only through `view.legend`. Injecting
 * it into a column would corrupt every count on the page, which are pinned to the Snapshot's.
 */

/** Feature accent colours, in order. Six, then it wraps. */
const FEATURE_ACCENTS = 6;

/**
 * Lane glyphs. Written as escapes rather than as literal characters on purpose: this project
 * has had a NUL byte and a Cyrillic homoglyph substituted into source by an editor, and both
 * are invisible in every normal view of the file. An escape is not.
 */
const LANE_GLYPH = {
  blocked: '\u25B2', // BLACK UP-POINTING TRIANGLE
  frozen: '\u2299', // CIRCLED DOT OPERATOR
  agent: '\u25B6', // BLACK RIGHT-POINTING TRIANGLE
  'needs-you': '\u25C6', // BLACK DIAMOND
  'in-progress': '\u25D0', // CIRCLE WITH LEFT HALF BLACK
  complete: '\u2713', // CHECK MARK
  parked: '\u2298', // CIRCLED DIVISION SLASH
};

/** Spelled out, always shown beside the glyph. Nothing on this board rides on colour alone. */
const LANE_LABEL = {
  blocked: 'blocked',
  frozen: 'frozen on you',
  agent: 'agent can take',
  'needs-you': 'needs you',
  'in-progress': 'in progress',
  complete: 'done',
  parked: 'parked',
};

/** Tag text for a card that holds no Lane, and for a file that is not a Ticket at all. */
const OFF_BOARD_TAG = {
  unparsed: 'unparsed',
  unclassified: 'unclassified',
  link: 'link',
};

const EM = '\u2014';

/**
 * The six columns, in the order the board draws them, with the hint that says what puts a
 * Ticket in each. The order is fixed and content never rearranges it: a status board's value
 * is a visual language learned once, and a layout that reflows has to be re-learned each time.
 *
 * Hints are runs rather than a string because the emphasis is load-bearing and the renderer
 * may not build a node from markup - repository text reaches these same code paths.
 */
const COLUMNS = [
  {
    key: 'blocked',
    name: 'Blocked',
    lanes: ['frozen', 'blocked'],
    hint: [
      { text: 'Nobody can start these. Two kinds, and the difference is who can clear them: ' },
      { text: 'frozen on you', em: true },
      { text: ` ${EM} every path out ends at a Ticket that needs a person ${EM} and ` },
      { text: 'queued for an agent', em: true },
      { text: ', where an agent can still clear the path.' },
    ],
  },
  {
    key: 'agent',
    name: 'Agent can take',
    lanes: ['agent'],
    hint: [
      { text: 'Every blocker resolved and nothing waiting on a person. ' },
      { text: 'This is the Frontier an agent can claim right now.', em: true },
    ],
  },
  {
    key: 'needs-you',
    name: 'Needs you',
    lanes: ['needs-you'],
    hint: [
      { text: 'Work that stops at a person: a ' },
      { text: 'Status:', em: true },
      { text: ' of ready-for-human, or a ' },
      { text: 'Type:', em: true },
      { text: ` that names HITL. Triage and progress are separate axes here ${EM} ` },
      { text: 'a full meter in this lane means implemented and awaiting your sign-off', em: true },
      { text: ', not unstarted.' },
    ],
  },
  {
    key: 'in-progress',
    name: 'In progress',
    lanes: ['in-progress'],
    hint: [{ text: 'Claimed by a session, or partly checked off. Something is already moving.' }],
  },
  {
    key: 'done',
    name: 'Done',
    lanes: ['complete'],
    hint: [
      {
        text:
          'Every acceptance criterion checked, with nobody waiting on you. Collapsed by ' +
          `default ${EM} most of the tracker ends up here, and it is almost never the ` +
          'question being asked.',
      },
    ],
  },
  {
    key: 'parked',
    name: 'Parked',
    lanes: ['parked'],
    hint: [
      { text: 'A terminal ' },
      { text: 'Status:', em: true },
      {
        text:
          ` ${EM} wontfix or closed ${EM} with work still unchecked. Off the Frontier ` +
          'permanently: never ready, never done, and its unchecked boxes stay visible.',
      },
    ],
  },
];

/**
 * Sub-lane headings inside the Blocked column. Frozen is listed first: it is the one a reader
 * is most likely to be wrong about, because it looks like ordinary queued work and is not.
 */
const SUBLANE = {
  frozen: {
    label: 'Frozen on you',
    note: 'Every path out of these ends at a person. An agent clears nothing here.',
  },
  blocked: {
    label: 'Queued for an agent',
    note: 'At least one path out is agent-takeable, so an agent can still clear these.',
  },
};

/**
 * @typedef {{ text: string, em?: boolean, count?: boolean }} Run
 * @typedef {{ number: number, label: string, targetId: string|null, dangling: boolean,
 *             satisfied: boolean }} BlockerRef
 * @typedef {{ checked: number, total: number, text: string, segments: boolean[] }} MeterView
 * @typedef {{ kind: string, flags: string[], note: string }} DecisionView
 * @typedef {{ name: string, value: string }} FieldRow
 * @typedef {{ rows: FieldRow[], note: string }} UnclassifiedView
 * @typedef {{ src: 'status'|'type', label: string, value: string, note: string }} WhyYouView
 * @typedef {{ targetId: string|null, targetLabel: string, targetTitle: string,
 *             note: string }} FrozenView
 * @typedef {{ id: string, kind: 'ticket'|'sibling'|'orphan', specimen: boolean,
 *             shortId: string, number: number|null, title: string, fileName: string,
 *             path: string, absPath: string, featureKey: string, featureName: string,
 *             sigil: string, accent: number, lane: string|null, state: string,
 *             tag: string, tagGlyph: string, dialect: string, meter: MeterView|null,
 *             decision: DecisionView|null, unclassified: UnclassifiedView|null,
 *             signoff: boolean, whyYou: WhyYouView|null, frozen: FrozenView|null,
 *             blockers: BlockerRef[], externalBlocker: string, status: string,
 *             statusPresent: boolean, detail: string }} CardView
 * @typedef {{ key: string, featureName: string, sigil: string, accent: number,
 *             cards: CardView[] }} GroupView
 * @typedef {{ lane: string, glyph: string, label: string, note: string, count: number,
 *             labelled: boolean, groups: GroupView[] }} SublaneView
 * @typedef {{ key: string, featureName: string, sigil: string, accent: number, count: number,
 *             expanded: boolean, cards: CardView[] }} CollapsedRow
 * @typedef {{ total: number, featureCount: number, rows: CollapsedRow[],
 *             note: string }} CollapsedView
 * @typedef {{ key: string, name: string, glyph: string, hint: Run[], count: number,
 *             split: boolean, breakdown: Run[], sublanes: SublaneView[],
 *             collapsed: CollapsedView|null, emptyNote: string, note: string }} ColumnView
 * @typedef {{ key: string, caption: string, card: CardView, why: Run[] }} SpecimenView
 * @typedef {{ title: string, note: string, specimens: SpecimenView[] }} LegendView
 * @typedef {{ value: string, label: string, hi: boolean }} TotalView
 * @typedef {{ key: string, featureName: string, sigil: string, accent: number,
 *             cards: CardView[] }} OffBoardGroup
 * @typedef {{ count: number, ticketCount: number, linkCount: number, note: string,
 *             groups: OffBoardGroup[] }} OffBoardView
 * @typedef {{ kind: string, message: string }} NoticeView
 * @typedef {{ columns: ColumnView[], legend: LegendView, offBoard: OffBoardView,
 *             totals: TotalView[], headline: Run[], notices: NoticeView[],
 *             frontierCount: number, progressLabel: string, cardCount: number,
 *             ticketCount: number, featureCount: number, rootCount: number,
 *             fileCount: number, laneTotal: number, empty: boolean,
 *             summaryText: string }} BoardView
 * @typedef {{ doneMode?: 'collapsed'|'cards', openFeatures?: Record<string, boolean> }} UiState
 */

/**
 * Build the whole view in one pass.
 *
 * Never throws, whatever arrives. The Snapshot comes off a socket and type stripping erases
 * without checking - but more to the point, a board that blanks on one malformed field is
 * worse than a board that draws what it understood.
 *
 * @param {unknown} snapshot
 * @param {UiState} [ui] Reader-held state: how Done is drawn, which Features are expanded.
 * @returns {BoardView}
 */
export function buildView(snapshot, ui = {}) {
  const doneMode = ui.doneMode === 'cards' ? 'cards' : 'collapsed';
  const openFeatures = ui.openFeatures ?? {};

  const features = readFeatures(snapshot);
  const byLane = new Map();
  for (const column of COLUMNS) for (const lane of column.lanes) byLane.set(lane, []);

  const offBoardGroups = [];
  let linkCount = 0;
  let unlanedCount = 0;
  let cardCount = 0;

  for (const feature of features) {
    const stray = [];
    for (const card of feature.cards) {
      cardCount += 1;
      const bucket = card.lane === null ? null : byLane.get(card.lane);
      if (bucket === undefined || bucket === null) {
        stray.push(card);
        if (card.kind === 'ticket') unlanedCount += 1;
        else linkCount += 1;
      } else {
        bucket.push(card);
      }
    }
    if (stray.length > 0) {
      offBoardGroups.push({
        key: feature.key,
        featureName: feature.name,
        sigil: feature.sigil,
        accent: feature.accent,
        cards: stray,
      });
    }
  }

  const columns = COLUMNS.map((column) =>
    buildColumn(column, byLane, features, doneMode, openFeatures),
  );

  const counts = peek(snapshot, 'counts');
  const frontierCount = asCount(peek(snapshot, 'frontierCount'));
  const progress = peek(snapshot, 'progress');
  const progressLabel = asString(peek(progress, 'label'));
  const roots = asArray(peek(snapshot, 'roots'));
  const laneTotal = columns.reduce((total, column) => total + column.count, 0);
  // Tickets and files are different numbers and the header must not blur them: a Feature's
  // `spec.md` is a file the board carries and never a Ticket it places, and the progress
  // figure is a proportion of Tickets. `progress.total` is the seam's own Ticket count.
  const ticketCount = asCount(peek(progress, 'total'));
  const featureCount = features.filter((feature) => !feature.orphanGroup).length;

  const view = {
    columns,
    legend: buildLegend(features, unlanedCount),
    offBoard: {
      count: linkCount + unlanedCount,
      ticketCount: unlanedCount,
      linkCount,
      note:
        `Files the board carries but cannot place in a Lane ${EM} a Ticket the parser could ` +
        'not read or could not classify, and files that are not Tickets at all. None of them ' +
        'is counted into a column, and none is hidden: a file the board dropped silently ' +
        'would be indistinguishable from a file that is not there.',
      groups: offBoardGroups,
    },
    totals: buildTotals(featureCount, ticketCount, counts, frontierCount, progress),
    headline: buildHeadline(ticketCount, counts, frontierCount, progressLabel),
    notices: [...readNotices(snapshot), ...countNotices(counts, byLane, unlanedCount)],
    frontierCount,
    progressLabel,
    cardCount,
    ticketCount,
    featureCount,
    rootCount: roots.length,
    fileCount: cardCount,
    laneTotal,
    empty: cardCount === 0,
    summaryText: '',
  };
  view.summaryText = summarise(view);
  return view;
}

/**
 * One line summarising the board, for the header.
 *
 * @param {BoardView} view
 * @returns {string}
 */
export function summarise(view) {
  if (view.rootCount === 0) return 'No repository registered yet.';
  if (view.empty) {
    return `${count(view.rootCount, 'repository', 'repositories')}, nothing tracked yet.`;
  }
  return `${count(view.fileCount, 'file', 'files')} across ${count(
    view.featureCount,
    'feature',
    'features',
  )} in ${count(view.rootCount, 'repository', 'repositories')}.`;
}

/**
 * The board's lane vocabulary, exported so a test can assert over all seven at once rather
 * than over whichever ones a fixture happens to produce.
 *
 * @returns {{ lane: string, glyph: string, label: string }[]}
 */
export function laneKey() {
  return Object.keys(LANE_GLYPH).map((lane) => ({
    lane,
    glyph: readMap(LANE_GLYPH, lane),
    label: readMap(LANE_LABEL, lane),
  }));
}

/** The six column keys in draw order. Exported so the order can be pinned by a test. */
export function columnOrder() {
  return COLUMNS.map((column) => column.key);
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * @param {{ key: string, name: string, lanes: string[], hint: Run[] }} column
 * @param {Map<string, CardView[]>} byLane
 * @param {{ key: string, name: string, sigil: string, accent: number }[]} features
 * @param {'collapsed'|'cards'} doneMode
 * @param {Record<string, boolean>} openFeatures
 * @returns {ColumnView}
 */
function buildColumn(column, byLane, features, doneMode, openFeatures) {
  const sublanes = column.lanes.map((lane) => {
    const cards = byLane.get(lane) ?? [];
    const sublane = readMap(SUBLANE, lane);
    return {
      lane,
      glyph: readMap(LANE_GLYPH, lane),
      label: sublane === undefined ? readMap(LANE_LABEL, lane) : sublane.label,
      note: sublane === undefined ? '' : sublane.note,
      count: cards.length,
      labelled: column.lanes.length > 1,
      groups: groupByFeature(cards, features),
    };
  });

  const total = sublanes.reduce((sum, sublane) => sum + sublane.count, 0);
  const split = column.lanes.length > 1;

  // The header count breaks down whenever a column carries more than one Lane. A single
  // number over two sub-lanes reads as one queue, which is the misreading the split exists
  // to prevent.
  const breakdown = split
    ? sublanes.flatMap((sublane, index) => [
        ...(index === 0 ? [] : [{ text: ' \u00B7 ' }]),
        { text: String(sublane.count), count: true },
        { text: ` ${sublane.label.toLowerCase()}` },
      ])
    : [];

  const isDone = column.key === 'done';
  const collapsed =
    isDone && doneMode === 'collapsed' && total > 0
      ? collapseDone(sublanes, openFeatures)
      : null;

  return {
    key: column.key,
    name: column.name,
    glyph: readMap(LANE_GLYPH, column.lanes[column.lanes.length - 1] ?? column.key),
    hint: column.hint,
    count: total,
    split,
    breakdown,
    sublanes,
    collapsed,
    emptyNote:
      'Empty in this snapshot, and drawn rather than hidden: an empty column is a fact ' +
      'about the board, and a column that vanishes when it empties cannot be learned.',
    note:
      column.key === 'parked' && total > 0
        ? 'Parked Tickets keep their unchecked boxes. Nothing here was promoted by its ' +
          'status line, and nothing here can be.'
        : '',
  };
}

/**
 * Done, collapsed: a count and one row per Feature, each expandable to its ledger.
 *
 * Collapsed by default because most of a tracker ends up finished, and forty identical Done
 * cards push the live work off the screen - the answer to "what is done?" is a number far more
 * often than it is a list.
 *
 * @param {SublaneView[]} sublanes
 * @param {Record<string, boolean>} openFeatures
 * @returns {CollapsedView}
 */
function collapseDone(sublanes, openFeatures) {
  const rows = [];
  let total = 0;
  for (const sublane of sublanes) {
    for (const group of sublane.groups) {
      total += group.cards.length;
      rows.push({
        key: group.key,
        featureName: group.featureName,
        sigil: group.sigil,
        accent: group.accent,
        count: group.cards.length,
        expanded: openFeatures[group.key] === true,
        cards: group.cards,
      });
    }
  }
  return {
    total,
    featureCount: rows.length,
    rows,
    note:
      'Full cards are one control away. The default answer to "what is done?" is a number, ' +
      `not ${String(total)} identical cards pushing the live work off the screen.`,
  };
}

/**
 * @param {CardView[]} cards
 * @param {{ key: string, name: string, sigil: string, accent: number }[]} features
 * @returns {GroupView[]}
 */
function groupByFeature(cards, features) {
  const byKey = new Map();
  for (const card of cards) {
    const existing = byKey.get(card.featureKey);
    if (existing === undefined) byKey.set(card.featureKey, [card]);
    else existing.push(card);
  }
  const groups = [];
  for (const feature of features) {
    const found = byKey.get(feature.key);
    if (found === undefined) continue;
    groups.push({
      key: feature.key,
      featureName: feature.name,
      sigil: feature.sigil,
      accent: feature.accent,
      cards: found,
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Features and cards
// ---------------------------------------------------------------------------

/**
 * Walk the Snapshot once and build every card, keeping the seam's ordering.
 *
 * Blocker references resolve inside the Feature, which is where Ticket numbers are scoped.
 * The index maps a number to `null` where two files claim it: a reference that identifies no
 * single Ticket identifies no Ticket, and pointing the reader at an arbitrary one of the two
 * would be worse than saying it dangles.
 *
 * The orphan group is flagged rather than passed off as a Feature. It has to be a group so
 * that files outside every Feature directory are drawn at all, and it must not be a Feature
 * so that the count in the header stays the number of Features that exist on disk.
 *
 * @param {unknown} snapshot
 * @returns {{ key: string, name: string, sigil: string, accent: number, orphanGroup: boolean,
 *             cards: CardView[] }[]}
 */
function readFeatures(snapshot) {
  const features = [];
  let accent = 0;

  for (const root of asArray(peek(snapshot, 'roots'))) {
    const rootPath = asString(peek(root, 'path'));

    for (const feature of asArray(peek(root, 'features'))) {
      const name = asString(peek(feature, 'name'));
      const key = featureKey(rootPath, name);
      const sigil = sigilOf(name);
      const slot = (accent % FEATURE_ACCENTS) + 1;
      accent += 1;

      const tickets = asArray(peek(feature, 'tickets'));
      const byNumber = indexByNumber(tickets);
      const byId = indexById(tickets);
      const cards = [];
      for (const ticket of tickets) {
        const card = ticketCard(ticket, key, name, sigil, slot, byNumber, byId);
        if (card !== null) cards.push(card);
      }
      for (const sibling of asArray(peek(feature, 'siblings'))) {
        const card = linkCard(sibling, 'sibling', rootPath, key, name, sigil, slot);
        if (card !== null) cards.push(card);
      }
      features.push({ key, name, sigil, accent: slot, orphanGroup: false, cards });
    }

    // Files that sat outside any Feature directory. Their own group rather than dropped,
    // because the walk went to real trouble to represent them.
    const key = orphanKey(rootPath);
    const slot = (accent % FEATURE_ACCENTS) + 1;
    const orphans = [];
    for (const orphan of asArray(peek(root, 'orphans'))) {
      const card = linkCard(orphan, 'orphan', rootPath, key, 'loose files', '..', slot);
      if (card !== null) orphans.push(card);
    }
    if (orphans.length > 0) {
      accent += 1;
      features.push({
        key,
        name: 'loose files',
        sigil: '..',
        accent: slot,
        orphanGroup: true,
        cards: orphans,
      });
    }
  }
  return features;
}

/**
 * Ticket id to Ticket, built once per Feature.
 *
 * A Frozen card names the Ticket its chain terminates at, and `frozenOn` carries that Ticket's
 * id. Resolving it by scanning the Feature is O(Tickets) per Frozen card, which is quadratic
 * over a Feature where a single human gate freezes everything behind it - the shape this
 * costs most on is exactly the shape the Frozen Lane exists for. Measured before the index:
 * 5.3 ms at 500 Tickets, 17.8 ms at 1000, 70.3 ms at 2000, 278.5 ms at 4000, on the render
 * path, blocking the main thread on every socket update.
 *
 * @param {unknown[]} tickets
 * @returns {Map<string, unknown>}
 */
function indexById(tickets) {
  const index = new Map();
  for (const ticket of tickets) {
    const id = asString(peek(ticket, 'id'));
    if (id !== '' && !index.has(id)) index.set(id, ticket);
  }
  return index;
}

/**
 * @param {unknown[]} tickets
 * @returns {Map<number, unknown>} number to Ticket, or to `null` where two claim it.
 */
function indexByNumber(tickets) {
  const index = new Map();
  for (const ticket of tickets) {
    const number = asNumber(peek(peek(ticket, 'extraction'), 'number'));
    if (number === null) continue;
    index.set(number, index.has(number) ? null : ticket);
  }
  return index;
}

/**
 * A Ticket card.
 *
 * `id` is the Snapshot's own card id, used verbatim as the DOM key. It is board-wide unique
 * and stable across a re-scan, which is exactly what a patching renderer needs - deriving a
 * key here instead would be rebuilding a shape that already exists.
 *
 * @param {unknown} ticket
 * @param {string} featureKeyValue
 * @param {string} featureName
 * @param {string} sigil
 * @param {number} accent
 * @param {Map<number, unknown>} byNumber
 * @param {Map<string, unknown>} byId
 * @returns {CardView|null}
 */
function ticketCard(ticket, featureKeyValue, featureName, sigil, accent, byNumber, byId) {
  const id = asString(peek(ticket, 'id'));
  const path = asString(peek(ticket, 'path'));
  if (id === '' && path === '') return null;

  const extraction = peek(ticket, 'extraction');
  const derivation = peek(ticket, 'derivation');
  const readError = asString(peek(ticket, 'readError'));
  const fileName = asString(peek(ticket, 'fileName')) || baseName(path);

  const lane = asLane(peek(derivation, 'lane'));
  const state = asString(peek(derivation, 'state')) || 'unparsed';
  const dialect = asString(peek(extraction, 'dialect')) || 'unparsed';
  const number = asNumber(peek(extraction, 'number'));
  const title = asString(peek(extraction, 'title')) || fileName;

  const criteria = peek(extraction, 'criteria');
  const checked = asCount(peek(criteria, 'checked'));
  const total = asCount(peek(criteria, 'total'));

  const dangling = asArray(peek(derivation, 'danglingBlockers')).map(asCount);
  const blockers = readBlockers(extraction, derivation, byNumber, dangling, sigil);

  const frozenOn = asString(peek(derivation, 'frozenOn'));
  const statusPrefix = asString(peek(extraction, 'statusPrefix'));
  const rawStatus = stripBold(asString(peek(extraction, 'rawStatus')));

  return {
    id: id || path,
    kind: 'ticket',
    specimen: false,
    shortId: shortId(sigil, number, fileName),
    number,
    title,
    fileName,
    path,
    absPath: asString(peek(ticket, 'absPath')),
    featureKey: featureKeyValue,
    featureName,
    sigil,
    accent,
    lane,
    state,
    tag: lane === null ? readMap(OFF_BOARD_TAG, state) ?? state : readMap(LANE_LABEL, lane),
    tagGlyph: lane === null ? '\u25CC' : readMap(LANE_GLYPH, lane),
    dialect,
    // The meter stays a meter on every task Ticket, including a parked one at zero and a
    // finished one awaiting sign-off. Reducing it to a bare ratio would collapse the contrast
    // with the decision Dialect, which has no ratio at all and must not be drawn as 0%.
    meter: dialect === 'task' && total > 0 ? meterOf(checked, total) : null,
    decision: dialect === 'decision' ? decisionOf(extraction) : null,
    unclassified: dialect === 'unclassified' ? unclassifiedOf(extraction) : null,
    // Complete *and* handed to a person. The one reading true on both axes is "implemented,
    // awaiting sign-off", and a full meter here must never read as unstarted.
    signoff: state === 'done-awaiting-human',
    whyYou: lane === 'needs-you' ? whyYouOf(statusPrefix, rawStatus, extraction) : null,
    frozen: lane === 'frozen' ? frozenOf(frozenOn, byId, sigil) : null,
    blockers,
    externalBlocker: asString(peek(extraction, 'externalBlocker')),
    status: rawStatus,
    statusPresent: peek(extraction, 'statusPresent') === true,
    detail: readError,
  };
}

/**
 * The criteria meter for a task Ticket.
 *
 * Exported so the renderer's rebuild signature can be swept against it: the two together have
 * to satisfy "two meters that draw differently never share a signature", and that is a
 * property of this function and `meterSignature` jointly, not of either alone.
 *
 * @param {number} checked
 * @param {number} total
 * @returns {MeterView}
 */
export function meterOf(checked, total) {
  const capped = Math.min(checked, total);
  const segments = [];
  // Bounded so a malformed count cannot make the renderer build an unbounded number of
  // nodes. Above the cap the ratio still reads exactly; only the drawn segments merge.
  const drawn = Math.min(total, 40);
  for (let index = 0; index < drawn; index += 1) {
    segments.push(index < Math.round((capped / total) * drawn));
  }
  return { checked: capped, total, text: `${String(capped)}/${String(total)}`, segments };
}

/**
 * A decision Ticket carries no checklist by design - it closes on a written answer - so it
 * says so in words rather than being drawn at 0%, which would be a fabricated number.
 *
 * @param {unknown} extraction
 * @returns {DecisionView}
 */
function decisionOf(extraction) {
  const ticketType = asString(peek(extraction, 'ticketType'));
  const kind = ticketType.split('(')[0]?.trim() ?? '';
  const flags = [];
  if (peek(extraction, 'hitl') === true) flags.push('HITL');
  return {
    kind,
    flags,
    note: `no checklist ${EM} closes on a written answer, so no ratio exists`,
  };
}

/**
 * @param {unknown} extraction
 * @returns {UnclassifiedView}
 */
function unclassifiedOf(extraction) {
  const rows = [];
  for (const field of asArray(peek(extraction, 'rawFields'))) {
    const name = asString(peek(field, 'name'));
    if (name === '') continue;
    rows.push({ name, value: asString(peek(field, 'value')) });
  }
  return {
    rows,
    note:
      'Neither Dialect scored, so the board prints what the parser found and refuses to ' +
      'pick one. Dialect is read from observed syntax, never from which directory the file ' +
      'sits in.',
  };
}

/**
 * Why a Ticket landed in Needs you, sourced from the field that put it there.
 *
 * Declared and inferred are rendered differently and the inferred one says the word:
 * `Status: ready-for-human` is read straight off the file, while `HITL` inside a free-text
 * `Type:` is a substring hit. It is the one Lane assignment the board guesses rather than
 * reads, and it should look like it.
 *
 * @param {string} statusPrefix
 * @param {string} rawStatus
 * @param {unknown} extraction
 * @returns {WhyYouView|null}
 */
function whyYouOf(statusPrefix, rawStatus, extraction) {
  if (statusPrefix === 'ready-for-human') {
    return {
      src: 'status',
      label: `needs you ${EM} the status line declares it`,
      value: rawStatus,
      note: 'The status line hands this to a person. No agent can close it.',
    };
  }
  if (peek(extraction, 'hitl') === true) {
    return {
      src: 'type',
      label: `needs you ${EM} the type field matched (heuristic)`,
      value: asString(peek(extraction, 'ticketType')),
      note:
        'Substring match on the free-text Type: field, inferred rather than declared. The ' +
        'whole string is printed so you can judge the match.',
    };
  }
  return null;
}

/**
 * Name the human-gated Ticket a Frozen chain terminates at, by id and title.
 *
 * "Frozen" as a bare assertion is useless: the reader's next question is always which person,
 * on what. So the card answers it, and the id doubles as board-internal navigation.
 *
 * One map lookup, not a scan. See {@link indexById} for what the scan cost and why the shape
 * it costs most on is the shape this Lane exists to describe.
 *
 * @param {string} frozenOn
 * @param {Map<string, unknown>} byId
 * @param {string} sigil
 * @returns {FrozenView}
 */
function frozenOf(frozenOn, byId, sigil) {
  let targetTitle = '';
  let targetLabel = '';
  const ticket = byId.get(frozenOn) ?? null;
  if (ticket !== null) {
    const extraction = peek(ticket, 'extraction');
    const fileName = asString(peek(ticket, 'fileName'));
    targetTitle = asString(peek(extraction, 'title')) || fileName;
    targetLabel = shortId(sigil, asNumber(peek(extraction, 'number')), fileName);
  }
  return {
    targetId: frozenOn === '' ? null : frozenOn,
    targetLabel,
    targetTitle,
    note:
      'No agent can clear this chain. Until that Ticket moves, nothing here can start: it ' +
      'is not yours to do, it is yours to unblock.',
  };
}

/**
 * Every blocker the file named, each resolved to the card it points at.
 *
 * Satisfied blockers are kept rather than filtered away. A card that lists only what is still
 * open cannot be distinguished from a card whose `Blocked by:` line was never parsed, and the
 * whole point of the line is that the reader can check the board's arithmetic against it.
 *
 * @param {unknown} extraction
 * @param {unknown} derivation
 * @param {Map<number, unknown>} byNumber
 * @param {number[]} dangling
 * @param {string} sigil
 * @returns {BlockerRef[]}
 */
function readBlockers(extraction, derivation, byNumber, dangling, sigil) {
  void derivation;
  const out = [];
  for (const value of asArray(peek(extraction, 'blockedBy'))) {
    const number = asNumber(value);
    if (number === null) continue;
    const target = byNumber.get(number) ?? null;
    const targetId = target === null ? null : asString(peek(target, 'id'));
    // `done` is the only blocker state that clears a dependency, and that rule lives in
    // `core/internal/derive.ts`. Reading the derived state is quoting it; recomputing the
    // condition here would be a second copy free to drift.
    const state = target === null ? '' : asString(peek(peek(target, 'derivation'), 'state'));
    out.push({
      number,
      label: shortId(sigil, number, ''),
      targetId: targetId === '' ? null : targetId,
      dangling: target === null || dangling.includes(number),
      satisfied: state === 'done',
    });
  }
  return out;
}

/**
 * @param {unknown} link
 * @param {'sibling'|'orphan'} kind
 * @param {string} rootPath
 * @param {string} featureKeyValue
 * @param {string} featureName
 * @param {string} sigil
 * @param {number} accent
 * @returns {CardView|null}
 */
function linkCard(link, kind, rootPath, featureKeyValue, featureName, sigil, accent) {
  const path = asString(peek(link, 'path'));
  if (path === '') return null;
  const name = asString(peek(link, 'label')) || baseName(path);
  return {
    id: linkKey(rootPath, kind, path),
    kind,
    specimen: false,
    shortId: name,
    number: null,
    title: name,
    fileName: name,
    path,
    absPath: asString(peek(link, 'absPath')),
    featureKey: featureKeyValue,
    featureName,
    sigil,
    accent,
    lane: null,
    state: 'link',
    tag: readMap(OFF_BOARD_TAG, 'link'),
    tagGlyph: '\u25CC',
    dialect: 'unparsed',
    meter: null,
    decision: null,
    unclassified: null,
    signoff: false,
    whyYou: null,
    frozen: null,
    blockers: [],
    externalBlocker: '',
    status: '',
    statusPresent: false,
    detail: '',
  };
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

/**
 * Three specimens at full card size: the two Dialects, and the honest refusal.
 *
 * Every specimen is marked `specimen: true` and lives only here. None is injected into a
 * Lane: the counts on this page are pinned to the Snapshot's, and one synthetic card in a
 * column would put every number on the board one out.
 *
 * @param {{ cards: CardView[] }[]} features
 * @param {number} unlanedCount
 * @returns {LegendView}
 */
function buildLegend(features, unlanedCount) {
  const unclassified = countBy(features, (card) => card.dialect === 'unclassified');
  return {
    title: 'How to read a card',
    note: `three Dialects ${EM} scored from observed syntax, never from directory shape`,
    specimens: [
      {
        key: 'task',
        caption: `task ${EM} specimen`,
        card: specimenCard('task', 'task', 'Task Ticket \u2014 progress is a count of boxes', {
          meter: meterOf(3, 5),
        }),
        why: [
          { text: 'Checkbox criteria, so progress is a ratio.', em: true },
          {
            text:
              ' The meter counts boxes and nothing else. It is not an estimate, and it never ' +
              'appears on a Ticket that has no boxes.',
          },
        ],
      },
      {
        key: 'decision',
        caption: `decision ${EM} specimen`,
        card: specimenCard(
          'decision',
          'decision',
          'Decision Ticket \u2014 closes on a written answer',
          {
            decision: {
              kind: 'grilling',
              flags: ['HITL'],
              note: `no checklist ${EM} closes on a written answer, so no ratio exists`,
            },
          },
        ),
        why: [
          { text: 'No checkboxes at all, by design.', em: true },
          {
            text:
              ' It carries a kind and a mode instead, and takes its Lane from the status ' +
              'line. Drawing it as 0% complete would be a fabricated number.',
          },
        ],
      },
      {
        key: 'unclassified',
        caption: `unclassified ${EM} specimen`,
        card: specimenCard(
          'unclassified',
          'unclassified',
          'Specimen \u2014 a file that scores as neither Dialect',
          {
            unclassified: {
              rows: [
                { name: 'heading', value: '## Roll-call taxonomy \u2014 working notes' },
                { name: 'checkbox syntax', value: '0 lines' },
                { name: 'status line', value: 'absent' },
              ],
              note:
                'Task scored zero (no checkboxes), decision scored zero (no status line). ' +
                'Neither Dialect wins, so the card prints what the parser found.',
            },
          },
        ),
        why: [
          { text: 'Neither Dialect scored, so the board does not guess.', em: true },
          {
            text:
              unclassified === 0
                ? ' No file in this snapshot is unclassified; this specimen exists so the ' +
                  'treatment is here before the first one arrives. It takes no Lane and is ' +
                  'counted into no column.'
                : ` ${String(unclassified)} ${
                    unclassified === 1 ? 'file scores' : 'files score'
                  } this way in this snapshot. Such a file takes no Lane, so it is listed ` +
                  'below the board rather than counted into a column.',
          },
          {
            text: ` ${String(unlanedCount)} Ticket${
              unlanedCount === 1 ? '' : 's'
            } hold no Lane in total.`,
          },
        ],
      },
    ],
  };
}

/**
 * @param {string} key
 * @param {string} dialect
 * @param {string} title
 * @param {{ meter?: MeterView, decision?: DecisionView,
 *           unclassified?: UnclassifiedView }} parts
 * @returns {CardView}
 */
function specimenCard(key, dialect, title, parts) {
  return {
    id: `legend:${key}`,
    kind: 'ticket',
    specimen: true,
    shortId: `\u2014\u00B7${key.slice(0, 2)}`,
    number: null,
    title,
    fileName: `${key}-specimen.md`,
    path: '',
    absPath: '',
    featureKey: 'legend',
    featureName: 'legend',
    sigil: '??',
    accent: 1,
    lane: null,
    state: dialect === 'unclassified' ? 'unclassified' : 'ready',
    tag: dialect === 'unclassified' ? 'unclassified' : 'specimen',
    tagGlyph: '\u25CC',
    dialect,
    meter: parts.meter ?? null,
    decision: parts.decision ?? null,
    unclassified: parts.unclassified ?? null,
    signoff: false,
    whyYou: null,
    frozen: null,
    blockers: [],
    externalBlocker: '',
    status: '',
    statusPresent: false,
    detail: '',
  };
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * The tiles across the masthead.
 *
 * The progress figure carries `snapshot.progress.label` verbatim rather than a word chosen
 * here. It counts work that is finished *and off your desk*, which is fewer Tickets than have
 * every box checked - `ready-for-human` outranks completeness - and it is the one number a
 * reader quotes out loud. A percentage with no statement of what it counts is a number that
 * will be quoted wrongly.
 *
 * @param {number} featureCount
 * @param {number} ticketCount
 * @param {unknown} counts
 * @param {number} frontierCount
 * @param {unknown} progress
 * @returns {TotalView[]}
 */
function buildTotals(featureCount, ticketCount, counts, frontierCount, progress) {
  const percent = asCount(peek(progress, 'percent'));
  return [
    { value: String(featureCount), label: 'features', hi: false },
    { value: String(ticketCount), label: 'tickets', hi: false },
    { value: String(frontierCount), label: 'on the Frontier', hi: true },
    { value: String(laneCount(counts, 'needs-you')), label: 'needs you', hi: false },
    { value: String(laneCount(counts, 'frozen')), label: 'frozen on you', hi: false },
    { value: `${String(percent)}%`, label: asString(peek(progress, 'label')), hi: false },
  ];
}

/**
 * The counts, in a sentence. Deliberately prose rather than a second chart: the point being
 * made is that neither "ready" nor "done" is one number, and a chart cannot say that.
 *
 * @param {number} ticketCount
 * @param {unknown} counts
 * @param {number} frontierCount
 * @param {string} progressLabel
 * @returns {Run[]}
 */
function buildHeadline(ticketCount, counts, frontierCount, progressLabel) {
  const done = laneCount(counts, 'complete');
  const you = laneCount(counts, 'needs-you');
  const frozen = laneCount(counts, 'frozen');
  const blocked = laneCount(counts, 'blocked');
  const moving = laneCount(counts, 'in-progress');
  const flat = frontierCount + you + laneCount(counts, 'parked');

  return [
    { text: 'Of ' },
    { text: String(ticketCount), count: true },
    { text: plural(ticketCount, ' Ticket, ', ' Tickets, ') },
    { text: String(done), count: true },
    { text: plural(done, ' is ', ' are ') },
    { text: progressLabel === '' ? 'finished and off your desk' : progressLabel, em: true },
    { text: `. ${EM} ` },
    { text: 'The Frontier is not one number.', em: true },
    { text: ' ' },
    { text: String(frontierCount), count: true },
    { text: plural(frontierCount, ' Ticket is', ' Tickets are') },
    { text: ' claimable by an agent right now; ' },
    { text: String(you), count: true },
    { text: plural(you, ' stops', ' stop') },
    { text: ' at a person and cannot be closed by an agent at all; ' },
    { text: String(frozen), count: true },
    { text: plural(frozen, ' is', ' are') },
    { text: ' frozen ' },
    { text: `${EM} blocked, with every path out ending at one of those people; ` },
    { text: String(blocked), count: true },
    { text: plural(blocked, ' is', ' are') },
    { text: ' queued behind work an agent can still clear, and ' },
    { text: String(moving), count: true },
    { text: plural(moving, ' is', ' are') },
    { text: ' already moving. A flat "ready" queue would report ' },
    { text: String(flat), count: true },
    { text: ', and a board that stopped at "blocked" would show ' },
    { text: String(frozen + blocked), count: true },
    { text: ' Tickets as merely queued when ' },
    { text: String(frozen), count: true },
    { text: ' of them cannot move until you act.' },
  ];
}

// ---------------------------------------------------------------------------
// Keys
//
// These name DOM nodes the renderer patches in place, so two groups or two cards that collide
// on a key would silently overwrite each other. Roots are absolute paths and Feature names are
// directory names, so both halves can contain any separator one might reach for - including
// `#`, which is legal in a directory name everywhere the board runs.
//
// So the Root is length-prefixed, the same technique the Snapshot's own card id uses, and for
// the same reason: reading the count tells you exactly how many characters the Root occupies,
// and the split is unambiguous however either half is punctuated. The kind marker keeps a
// Feature genuinely named `loose files` distinct from the orphan group.
//
// Everything here stays printable. A control character as a separator is invisible in every
// normal view of the source, survives trimming, and is reserved elsewhere in this project as
// an annotation-key separator - this file shipped two of them before a byte scan caught it.
// ---------------------------------------------------------------------------

/**
 * @param {string} rootPath
 * @param {string} name
 */
function featureKey(rootPath, name) {
  return `${String(rootPath.length)}#${rootPath}#F#${name}`;
}

/** @param {string} rootPath */
function orphanKey(rootPath) {
  return `${String(rootPath.length)}#${rootPath}#O`;
}

/**
 * @param {string} rootPath
 * @param {'sibling'|'orphan'} kind
 * @param {string} path
 */
function linkKey(rootPath, kind, path) {
  return `${String(rootPath.length)}#${rootPath}#${kind}#${path}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * A two-character mark for a Feature, from the initials of its words.
 *
 * Decoration beside the Feature's full name, never a substitute for it - two Features can
 * collide here and nothing is lost when they do.
 *
 * @param {string} name
 * @returns {string}
 */
function sigilOf(name) {
  const words = name.split(/[^A-Za-z]+/).filter((word) => word.length > 0);
  const initials = words.map((word) => word.charAt(0)).join('');
  const source = initials.length >= 2 ? initials : `${words[0] ?? name}??`;
  return source.slice(0, 2).toUpperCase() || '??';
}

/**
 * @param {string} sigil
 * @param {number|null} number
 * @param {string} fallback
 * @returns {string}
 */
function shortId(sigil, number, fallback) {
  if (number === null) return fallback === '' ? sigil : fallback;
  const padded = String(number).padStart(2, '0');
  return `${sigil}\u00B7${padded}`;
}

/** Leading `**` is how a bold `**Status:**` line carries its value. It is not part of it. */
function stripBold(value) {
  return value.replace(/^\*+\s*/, '');
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
function count(n, one, many) {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * @param {{ cards: CardView[] }[]} features
 * @param {(card: CardView) => boolean} predicate
 */
function countBy(features, predicate) {
  let total = 0;
  for (const feature of features) for (const card of feature.cards) if (predicate(card)) total += 1;
  return total;
}

/**
 * @param {unknown} counts
 * @param {string} lane
 * @returns {number}
 */
function laneCount(counts, lane) {
  return asCount(peek(counts, lane));
}

/**
 * Notice a disagreement between the Snapshot's own Lane counts and what the board placed.
 *
 * ## Why the column count is the number of cards drawn, and not `snapshot.counts`
 *
 * `snapshot.counts` may look authoritative, but sourcing a column count from it would let a
 * header read 99 above one visible card. That asserts something the reader can see is false and
 * gives them no way to tell which number to believe. A count over a list of cards has exactly
 * one honest value - how many cards are in the list.
 *
 * Ignoring a disagreement would be its own kind of silence. `core/index.ts` computes `counts`
 * with `countLanes(cards)` over the same cards it emits, so the two cannot disagree when the
 * payload came from this seam. If they do disagree, the payload did not come from this seam - a
 * partial frame, a different schema version, something else on the socket - and that is a fact
 * about the board worth stating.
 *
 * So: draw what was drawn, and say so when the Snapshot disagrees. The board already has a
 * channel for "what you are looking at is not the whole truth", and this is one of those.
 *
 * The check is skipped entirely when the Snapshot carries no counts at all, because absent is
 * not the same as zero and a malformed frame must not produce a wall of false alarms.
 *
 * @param {unknown} counts
 * @param {Map<string, CardView[]>} byLane
 * @param {number} unlanedCount
 * @returns {NoticeView[]}
 */
function countNotices(counts, byLane, unlanedCount) {
  const lanes = [...Object.keys(LANE_GLYPH), 'unlaned'];
  if (typeof counts !== 'object' || counts === null) return [];
  if (!lanes.some((lane) => Object.prototype.hasOwnProperty.call(counts, lane))) return [];

  const disagreements = [];
  for (const lane of lanes) {
    if (!Object.prototype.hasOwnProperty.call(counts, lane)) continue;
    const claimed = asCount(peek(counts, lane));
    const placed = lane === 'unlaned' ? unlanedCount : (byLane.get(lane) ?? []).length;
    if (claimed !== placed) {
      disagreements.push(`${lane}: the Snapshot counts ${String(claimed)}, the board placed ${String(placed)}`);
    }
  }
  if (disagreements.length === 0) return [];

  return [
    {
      kind: 'count-mismatch',
      message:
        `The columns below show what the board placed, which is the only number a column can ` +
        `honestly carry ${EM} but the Snapshot's own counts disagree, so this board is not ` +
        `showing everything the Snapshot claims to hold. ${disagreements.join('; ')}.`,
    },
  ];
}

/**
 * @param {unknown} snapshot
 * @returns {NoticeView[]}
 */
function readNotices(snapshot) {
  const notices = [];
  for (const warning of asArray(peek(snapshot, 'warnings'))) {
    const message = asString(peek(warning, 'message'));
    if (message === '') continue;
    notices.push({ kind: asString(peek(warning, 'kind')) || 'scan-error', message });
  }
  return notices;
}

function baseName(path) {
  const parts = String(path).split('/');
  return parts[parts.length - 1] || String(path);
}

// ---------------------------------------------------------------------------
// Reading values that arrived over a socket
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function peek(value, key) {
  if (typeof value !== 'object' || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? /** @type {Record<string, unknown>} */ (value)[key]
    : undefined;
}

/**
 * Read one of this module's own constant tables.
 *
 * Separate from `peek` because the argument is a key from the Snapshot: a Lane name that
 * arrived over the socket must not be able to reach `constructor` or `__proto__` on a plain
 * object literal and come back with something that is not a string.
 *
 * @param {Record<string, string|{label: string, note: string}>} table
 * @param {string} key
 * @returns {any}
 */
function readMap(table, key) {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function asNumber(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function asCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A Lane, or `null` for anything that is not one of the seven.
 *
 * Checked against the table rather than trusted: the value arrives over a socket, and an
 * unknown Lane that reached `byLane` would silently drop every card carrying it.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function asLane(value) {
  return typeof value === 'string' && Object.hasOwn(LANE_GLYPH, value) ? value : null;
}
