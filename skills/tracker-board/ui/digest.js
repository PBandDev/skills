/**
 * tracker-board - the per-Feature Digest sheet and its as-of marker.
 *
 * The board has two liveness tiers and this panel is the seam between them: cards are live to
 * the file system, and the AI layer is as-of a content hash. Content-hash keying already stops a
 * stale Digest from being shown as if it were current (ADR-0003), but keying alone cannot tell a
 * reader that a Digest is *gone* - it just stops matching, and a Feature with an expired Digest
 * then looks exactly like a Feature that never had one. Saying which of the two it is, out loud,
 * is what this module is for.
 *
 * ## The three as-of states, and why none of them may render as nothing
 *
 * `feature.digest` is a three-arm union. `current` means the Digest was written against the
 * content now on disk. `expired` means one was written and the files moved under it. `never
 * written` means none exists. Drawing the last two the same way teaches the reader that Digests
 * do not exist, which is the one conclusion this panel must not produce - so each of the three
 * carries its own glyph, its own spelled-out word, its own rule treatment and its own colour.
 *
 * **The marker is a content fact, not a time fact.** It states that a Digest was written against
 * content that has since changed, and it names the content hash the comparison turns on. Nothing
 * here formats a clock: "written 4 hours ago" is a different claim, and it is a misleading one
 * when nothing moved in those four hours. There is no timestamp on an Annotation to format even
 * if this module wanted one, and `digest-panel.test.ts` asserts the absence rather than trusting
 * that.
 *
 * **`filesChanged` may be `null` and this module does not invent a count.** An expired Digest
 * says how many files moved when the count is present and says so without a count when it is
 * not. A zero is treated as unknowable rather than printed: an expired Digest is expired
 * *because* content moved, so "0 files changed" contradicts the state it is annotating.
 *
 * ## What is drawn, in what order
 *
 * One Digest per Feature, assembled from four Blocks in a fixed order - `summary`, `facts`,
 * `bullets`, `links` - each individually omittable, and the whole thing may render as nothing.
 * The order is imposed here rather than taken from the authored array: validation pins only
 * "first must be summary", so the ordering guarantee is a rendering guarantee. Within one kind
 * the authored order is kept, because a Digest may legitimately carry two `bullets` Blocks - one
 * per tone - and their relative order is the author's.
 *
 * The sheet is a single vertical stack and deliberately not a multi-column grid: a fixed Block
 * order that a reader has to reconstruct from a two-dimensional layout is not a fixed order. It
 * is full width and below the rail because a five-Block Digest is roughly 1100px tall at 16px
 * against a 254px card tile, so it cannot live in a card.
 *
 * ## `fog` versus `out-of-scope`
 *
 * These two tones mean opposite things - not-yet-specified versus ruled-out - and flattening
 * them asserts the opposite of the truth. They are separated on four channels that do not need
 * the label read: a hollow dotted mark against a struck-through cross, a dashed rule against a
 * solid one, ordinary text against struck-through text, and two distinct hues. The label is
 * spelled out too, and those two alone carry a gloss, because they are the only pair in the
 * vocabulary that a reader can hold backwards.
 *
 * ## The contract
 *
 * `renderDigest(doc, view, snapshot)` runs after `render()` has finished and writes into
 * **`#digest-panel`**, which nothing else touches. It is called from `draw()` on **every** board
 * render - several times a minute on a live board - and two consequences follow:
 *
 *  1. It registers no event listener of any kind. Copy buttons carry `data-copy` and are served
 *     by the one delegated listener `board.js` installs on the document; a listener added from
 *     inside a render accumulates one per frame. The disclosure is a native `<details>` with a
 *     shared `name`, so "one panel open at a time" is the browser's exclusive-accordion
 *     behaviour rather than state this module keeps.
 *  2. It rebuilds nothing it does not have to. Every Feature's row is pooled by key and carries
 *     the signature of the model it was drawn from; an unchanged row is skipped outright, so an
 *     open sheet stays open, a scrolled sheet stays put, and focus stays where the reader left
 *     it while files change underneath. All of that memo lives in the DOM rather than in a
 *     module-level cache, so two documents can never contaminate each other.
 *
 * The data arrives on the **third argument**, the Snapshot itself. `BoardView` is a projection
 * built for the board's six columns and holds no Digest state at all, so everything drawn here
 * is projected from the Snapshot in this module.
 *
 * `snapshot` is typed `unknown`, which is the honest type: it is `JSON.parse` output straight
 * off a socket and it is `null` until the first frame arrives. Every field is read defensively,
 * because a panel that throws on one malformed value takes the whole render down with it - and
 * the two panels after it in `draw()` with it.
 *
 * Every string in a Digest is model-authored text about a private repository. Nodes are built
 * with `textContent` and never from markup, styles live in `digest.css` because the document is
 * served under a policy that forbids inline ones, and a rejection message is rendered without
 * ever quoting the value it refused.
 */

/** Fixed render order. The authored array pins only that `summary` comes first. */
const BLOCK_ORDER = ['summary', 'facts', 'bullets', 'links'];

/**
 * The as-of vocabulary. Glyph, word and gloss for each of the three states, so that none of
 * them is told apart by colour, and none of them is told apart by absence.
 */
const AS_OF = {
  current: { glyph: '\u25C9', word: 'Current' }, // FISHEYE - filled in
  expired: { glyph: '\u2296', word: 'Expired' }, // CIRCLED MINUS - was there, no longer holds
  'never-written': { glyph: '\u25CB', word: 'No Digest' }, // WHITE CIRCLE - nothing in it
  // A fourth state, and it is not one of the union's three arms. It is what the panel says when
  // the frame CLAIMS a state it cannot support: a `current` arm carrying nothing renderable, or
  // a `kind` outside the vocabulary. Neither may be folded into one of the three - drawing an
  // unsupportable claim as `current` asserts a Digest exists for content nobody can show, and
  // drawing it as `never-written` asserts a history the frame never claimed.
  unreadable: { glyph: '\u2297', word: 'Unreadable' }, // CIRCLED TIMES - claimed, not readable
};

/**
 * Bullet tones. Written as escapes rather than as literal characters, the same as the Lane
 * glyphs: this project has had a NUL byte and a Cyrillic homoglyph substituted into source by an
 * editor, and an escape cannot be substituted invisibly.
 *
 * `fog` and `out-of-scope` are the pair this panel exists to keep apart, so they take the two
 * most opposed marks in the set - a hollow dotted ring against a solid cross - and the only two
 * glosses. The dotted ring is the same mark the board already puts on a card holding no Lane,
 * which is the same idea one level down: nothing has been pinned here yet.
 */
const TONES = {
  note: { glyph: '\u25AA', label: 'note' }, // BLACK SMALL SQUARE
  risk: { glyph: '\u25B3', label: 'risk' }, // WHITE UP-POINTING TRIANGLE
  decision: { glyph: '\u21D2', label: 'decision' }, // RIGHTWARDS DOUBLE ARROW
  question: { glyph: '?', label: 'question' },
  correction: { glyph: '\u2260', label: 'correction' }, // NOT EQUAL TO
  fog: { glyph: '\u25CC', label: 'fog \u00B7 not yet specified' }, // DOTTED CIRCLE
  'out-of-scope': { glyph: '\u2717', label: 'out of scope \u00B7 ruled out' }, // BALLOT X
};

/** Fact states, spelled out beside their tint so none of them rides on colour alone. */
const FACT_STATES = ['done', 'active', 'blocked', 'planned', 'dropped'];

/**
 * The shared disclosure group. `<details>` elements sharing a `name` are an exclusive accordion
 * in the browser itself, which is what makes "one panel open at a time" a property of the
 * document rather than of a click handler this module would otherwise have to install on every
 * render.
 */
const SHEET_GROUP = 'tracker-board-digest';

/**
 * @param {Document} doc
 * @param {import('./view.js').BoardView} view
 * @param {unknown} snapshot The raw Snapshot, exactly as `buildView` receives it: unvalidated,
 *   and `null` until the first frame arrives.
 * @returns {void}
 */
export function renderDigest(doc, view, snapshot) {
  void view;
  // Ahead of the document, deliberately. `board.js` holds `null` from page load until the first
  // SSE frame arrives, so a panel that reaches for a mount first throws on the very first paint,
  // before anything is on screen at all. Nothing legitimate runs before this: the value never
  // returns to `null` once a frame has arrived, so there is no disconnect that needs a mount
  // cleared.
  // Reflection-free on purpose: `typeof` and `=== null` cannot be intercepted, but `isObject`
  // calls `Array.isArray`, which THROWS on a revoked Proxy. Running that ahead of the try
  // reopens exactly the hole the try exists to close, one line above it. The shape check
  // therefore happens inside the containment, below.
  if (snapshot === null || typeof snapshot !== 'object') return;

  const mount = doc.getElementById('digest-panel');
  if (mount === null) return;

  // The projection is contained, and only the projection. Everything inside it reads a value
  // this process does not own, and `board.js` runs two more panels after this one from the same
  // `draw()` - so a throw here is three panels gone and the board frozen on its last frame,
  // rather than one panel degrading.
  //
  // Deliberately NOT a catch around the whole render: a blanket one would swallow a real defect
  // in the drawing below and leave a panel quietly showing a previous frame, which on a board
  // whose whole premise is reflecting the disk is worse than a visible failure. The containment
  // is around reading, ends before any DOM is touched, and **says so on the page** rather than
  // failing silently - so a projection defect is still visible, it is just visible in the panel
  // instead of in the console.
  let model;
  try {
    model = projectDigests(snapshot);
  } catch {
    // The error itself is never rendered. It came from evaluating somebody else's value, so its
    // message is as untrusted as the value was.
    renderUnreadable(doc, mount);
    return;
  }
  // A Snapshot carrying no Features at all is the one state that renders as nothing. This is
  // distinct from the early return above: a Snapshot HAS arrived and says the board is empty, so
  // a mount holding rows from a previous frame has to be cleared rather than left lying. The
  // board's own empty state already says the board is empty, and a liveness line reading
  // "0 current, 0 expired" would be four true numbers about nothing; `.panelmount:empty` then
  // takes the mount off the page entirely.
  if (model === null) {
    if (mount.firstChild !== null) mount.replaceChildren();
    return;
  }

  const frame = mountFrame(doc, mount);
  updateLiveness(frame.liveness, model.liveness, drawnCounts(model.features));
  updateRejections(doc, frame.rejected, model.rejections);
  updateList(doc, frame.list, model.features);
}

// ---------------------------------------------------------------------------
// The projection. Everything below reads a value that came off a socket, so nothing here
// trusts a declared type: type stripping erases and does not check.
// ---------------------------------------------------------------------------

/**
 * The panel's whole model, or `null` when there is nothing to draw.
 *
 * @param {unknown} snapshot
 */
function projectDigests(snapshot) {
  if (!isObject(snapshot)) return null;

  const features = [];
  for (const root of readArray(snapshot.roots)) {
    if (!isObject(root)) continue;
    const rootPath = readString(root.path);
    const rootLabel = readString(root.label) || rootPath;
    for (const feature of readArray(root.features)) {
      if (!isObject(feature)) continue;
      features.push(projectFeature(rootPath, rootLabel, feature));
    }
  }
  if (features.length === 0) return null;

  // Absent is not zero. A Snapshot that carries no liveness block at all is outside the
  // recognised frame shape, and answering "0 Overrides pending re-check" for it would be a
  // confident false number - so the count stays `null` and the line says what it does not know.
  const liveness = isObject(snapshot.liveness) ? snapshot.liveness : {};

  return {
    liveness: {
      current: readCount(liveness.digestsCurrent),
      expired: readCount(liveness.digestsExpired),
      neverWritten: readCount(liveness.digestsNeverWritten),
      pending: readCount(liveness.overridesPendingRecheck),
    },
    // A rejection names the field and the overage and never the value it refused. That is a
    // decision taken in the seam, for a reason - the refused text is model-authored prose about
    // somebody's private repository - and `core/internal/digest.ts` keeps it: its `show()` helper
    // describes a string by its shape and its size and never by its characters. Rendering that
    // output is this panel's job; re-deriving the vocabulary here would be a second copy of the
    // rule, free to drift from the one that actually refuses things.
    //
    // What IS dropped here is the `path` fallback. `Rejection.path` is the Root-qualified key,
    // which begins with an absolute Root path, and every digest rejection the seam emits carries
    // `feature` - so the fallback could only ever fire on a frame this seam did not produce, and
    // its only effect would be to put an absolute path on the page for a rejection that names no
    // Feature. The projection therefore accepts only the Feature label carried by the rejection.
    rejections: readArray(snapshot.rejections)
      .filter((rejection) => isObject(rejection) && rejection.kind === 'digest')
      .map((rejection) => ({
        where: readString(rejection.feature),
        field: readString(rejection.field),
        message: readString(rejection.message),
      })),
    features,
  };
}

/**
 * @param {string} rootPath
 * @param {string} rootLabel
 * @param {Record<string, unknown>} feature
 */
function projectFeature(rootPath, rootLabel, feature) {
  const digest = isObject(feature.digest) ? feature.digest : {};
  const kind = readString(digest.kind);
  const contentSha = readString(feature.contentSha);
  const name = readString(feature.name);
  const path = readString(feature.path);

  // The arm is not taken on `kind` alone. `kind: 'current'` carrying nothing renderable is a
  // frame claiming a Digest exists for this content while showing none of it - an empty panel and
  // a false as-of sentence in one row. So `current` has to earn
  // the word by producing at least one Block, and anything that cannot is `unreadable`: stated,
  // rather than promoted to `current` or demoted to a history the frame never claimed.
  const blocks = kind === 'current' ? projectBlocks(digest.digest) : [];
  const state =
    kind === 'expired' || kind === 'never-written'
      ? kind
      : kind === 'current' && blocks.length > 0
        ? 'current'
        : 'unreadable';

  return {
    key: rowKey(rootPath, path, name),
    name: name || path,
    rootLabel,
    contentSha,
    // Twelve characters and an ellipsis, so it reads as the prefix it is. A bare eight-character
    // stem is 32 bits presented as if it were the key, and two different content hashes sharing
    // a stem would then carry an identical-looking as-of marker.
    shortSha: contentSha === '' ? '' : `${contentSha.slice(0, 12)}\u2026`,
    state,
    filesChanged: state === 'expired' ? readMoved(digest.filesChanged) : null,
    blocks: state === 'current' ? blocks : [],
  };
}

/**
 * The identity a Feature's row is pooled by.
 *
 * The one thing this has to be is **injective**: two different Features sharing a key means the
 * second silently overwrites the first's row, so one Feature's Digest is drawn under another's
 * name and the other disappears. Nothing else about the key matters, and it is never parsed back.
 *
 * Every variable-length component carries its own length, which is what makes the join injective
 * over all three parts rather than merely unlikely to collide. The idiom is `core/index.ts`'s,
 * where a card id and an Annotation key are joined `<length>#<rootPath>#<relPath>` for the same
 * reason. This goes one step further than that join does, and deliberately:
 *
 *  - `<root>#<path>` alone is **not** injective. A Root path may contain `#` on both platforms
 *    this runs on, so `/a` + `b#c` and `/a#b` + `c` land on one key. Measured, not argued: with
 *    the bare join, two Features drew a single row between them.
 *  - The length prefix on the Root closes that, but `path || name` reopens it one level down: a
 *    Feature with no path called `x` collides with a Feature whose path is `x`, **inside a single
 *    Root**. The seam never emits an empty Feature path - but this module is handed `JSON.parse`
 *    output off a socket, not the seam's guarantee, so it cannot rely on that.
 *
 * @param {string} rootPath
 * @param {string} path
 * @param {string} name
 */
function rowKey(rootPath, path, name) {
  return `${String(rootPath.length)}#${rootPath}#${String(path.length)}#${path}#${name}`;
}

/**
 * How many member files moved, or `null` when that is not knowable.
 *
 * A zero is `null` deliberately rather than a count. An expired Digest is expired *because* its
 * Feature's content moved, so a zero contradicts the state it is annotating - it is a broken
 * count rather than a fact, and printing "0 files changed" beside "Expired" would be the one
 * confidently wrong number this panel has the chance to print.
 *
 * @param {unknown} value
 */
function readMoved(value) {
  // A safe integer or nothing. Rounding 2.7 files down to 2 would be inventing a count out of a
  // value that is not one, which is the same fabrication as printing a zero.
  if (!Number.isSafeInteger(value)) return null;
  return value > 0 ? value : null;
}

/**
 * The Blocks of one Digest, in fixed order, with anything unreadable dropped.
 *
 * Stable within a kind: two `bullets` Blocks keep the order their author gave them.
 *
 * @param {unknown} raw
 */
function projectBlocks(raw) {
  if (!isObject(raw)) return [];
  const blocks = [];
  for (const block of readArray(raw.blocks)) {
    if (!isObject(block)) continue;
    const projected = projectBlock(block);
    if (projected !== null) blocks.push(projected);
  }
  return blocks.sort((left, right) => rankOf(left.kind) - rankOf(right.kind));
}

/** @param {string} kind */
function rankOf(kind) {
  const rank = BLOCK_ORDER.indexOf(kind);
  return rank === -1 ? BLOCK_ORDER.length : rank;
}

/** @param {Record<string, unknown>} block */
function projectBlock(block) {
  const kind = readString(block.kind);

  if (kind === 'summary') {
    const text = readString(block.text);
    return text === '' ? null : { kind, text };
  }

  if (kind === 'facts') {
    const items = readArray(block.items)
      .filter(isObject)
      .map((item) => ({
        label: readString(item.label),
        value: readString(item.value),
        state: FACT_STATES.includes(readString(item.state)) ? readString(item.state) : '',
      }))
      .filter((item) => item.label !== '' || item.value !== '');
    return items.length === 0 ? null : { kind, items };
  }

  if (kind === 'bullets') {
    const tone = readString(block.tone);
    const items = readArray(block.items)
      .map((item) => readString(item))
      .filter((item) => item !== '');
    return items.length === 0
      ? null
      : {
          kind,
          title: readString(block.title),
          tone: Object.hasOwn(TONES, tone) ? tone : '',
          items,
        };
  }

  if (kind === 'links') {
    const items = readArray(block.items)
      .filter(isObject)
      .map((item) => ({ label: readString(item.label), path: readString(item.path) }))
      .filter((item) => item.path !== '');
    return items.length === 0 ? null : { kind, items };
  }

  // A kind outside the four cannot survive validation, so reaching here means the Snapshot is
  // malformed. Dropping it is the only honest answer: rendering an unrecognised Block means
  // guessing what it says.
  return null;
}

// ---------------------------------------------------------------------------
// The frame. Built once, then written into.
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {Element} mount
 */
function mountFrame(doc, mount) {
  let liveness = mount.querySelector('.dg-liveness');
  if (liveness === null) {
    mount.replaceChildren();

    // The standing claim about the board's two liveness tiers lives in the masthead. This line
    // stays here because it counts the Digest rows immediately below it.
    const head = doc.createElement('div');
    head.className = 'dg-head';
    const title = doc.createElement('h2');
    title.className = 'dg-title';
    title.textContent = 'Two liveness tiers';
    liveness = doc.createElement('p');
    liveness.className = 'dg-liveness';
    head.append(title, liveness);

    const rejected = doc.createElement('div');
    rejected.className = 'dg-rejected';
    rejected.hidden = true;

    const list = doc.createElement('div');
    list.className = 'dg-list';

    mount.append(head, rejected, list);
  }

  return {
    liveness,
    rejected: mount.querySelector('.dg-rejected'),
    list: mount.querySelector('.dg-list'),
  };
}

/**
 * How many Digests this pass actually drew, in each of the three as-of states.
 *
 * A count printed over a list has exactly one honest value - how many things are in the list -
 * and these three are printed directly above the rows they describe. Sourcing them from
 * `snapshot.liveness` instead would let the line read "0 Digests current" above three current
 * rows on a truncated or version-skewed frame, which converts a visible inconsistency into an
 * invisible lie. The same visible-count rule governs the column headers and this panel.
 *
 * @param {ReturnType<typeof projectFeature>[]} features
 */
function drawnCounts(features) {
  let current = 0;
  let expired = 0;
  let neverWritten = 0;
  let unreadable = 0;
  for (const feature of features) {
    if (feature.state === 'current') current += 1;
    else if (feature.state === 'expired') expired += 1;
    else if (feature.state === 'never-written') neverWritten += 1;
    // An unreadable row is counted on its own and never folded into "never written". Folding it
    // would make the header line assert a history for rows the reader can see say the opposite -
    // the same mistake one level up as drawing the row itself as `never-written`. Caught in a
    // browser, where the line read "2 never written" above two rows saying `Unreadable`.
    else unreadable += 1;
  }
  return { current, expired, neverWritten, unreadable };
}

/**
 * The four counts that say how much of the AI layer is worth trusting.
 *
 * Three of them are counted off the rows below. The fourth - Overrides pending re-check - has no
 * list on this panel to count, so it is taken from the Snapshot and reads *not recorded* rather
 * than *0* when the Snapshot does not carry it. Absent is not zero.
 *
 * When the Snapshot's own Digest counts disagree with the rows, the line says so instead of
 * silently preferring one of them: the disagreement means the frame did not come from this
 * seam - `core/index.ts` tallies `liveness` over the same Features it emits - and that is a fact
 * about the board worth stating. The check is skipped entirely when the Snapshot carries no
 * counts at all, because a malformed frame must not produce a wall of false alarms.
 *
 * @param {Element|null} node
 * @param {{current: number|null, expired: number|null, neverWritten: number|null, pending: number|null}} claimed
 * @param {{current: number, expired: number, neverWritten: number}} drawn
 */
function updateLiveness(node, claimed, drawn) {
  const pending =
    claimed.pending === null
      ? 'an unrecorded number of Overrides'
      : plural(claimed.pending, 'Override');

  // The fourth count appears only when there is one to state. A permanent "0 unreadable" would
  // teach the reader that unreadable rows are an ordinary thing for this board to have.
  const unreadable = drawn.unreadable === 0 ? '' : `${String(drawn.unreadable)} unreadable, `;

  let line =
    `${plural(drawn.current, 'Digest')} current, ` +
    `${String(drawn.expired)} expired, ${String(drawn.neverWritten)} never written, ` +
    `${unreadable}and ${pending} pending re-check.`;

  const stated = [claimed.current, claimed.expired, claimed.neverWritten];
  const disagrees =
    stated.every((count) => count !== null) &&
    (claimed.current !== drawn.current ||
      claimed.expired !== drawn.expired ||
      claimed.neverWritten !== drawn.neverWritten);
  if (disagrees) {
    line +=
      ` The Snapshot's own counts disagree with the rows below \u2014 it reports ` +
      `${String(claimed.current)} current, ${String(claimed.expired)} expired and ` +
      `${String(claimed.neverWritten)} never written \u2014 so this frame did not come from ` +
      `the seam that draws them.`;
  }
  setText(node, line);
}

/**
 * What the panel says when it could not read the frame at all.
 *
 * A stated failure rather than a silent one: the alternative is a panel showing a previous
 * frame's Digests as though they were this frame's, which is the one thing the as-of marker
 * exists to prevent it doing.
 *
 * @param {Document} doc
 * @param {Element} mount
 */
function renderUnreadable(doc, mount) {
  const note = doc.createElement('p');
  note.className = 'dg-unreadable';
  note.textContent =
    'The AI layer could not be read from this update, so nothing about Digests is shown ' +
    'below. The cards above are unaffected: they are read from the file system directly.';
  mount.replaceChildren(note);
}

/**
 * Refused Digests, counted and named.
 *
 * Visible rather than silent, because a Digest that is dropped without a word is
 * indistinguishable from a Feature nobody wrote one for - and the model that wrote it can only
 * self-correct if it is told which field and by how much.
 *
 * @param {Document} doc
 * @param {Element|null} node
 * @param {{where: string, field: string, message: string}[]} rejections
 */
function updateRejections(doc, node, rejections) {
  if (node === null) return;
  node.hidden = rejections.length === 0;
  if (rejections.length === 0) {
    // The signature goes with the children. Leaving it behind would make the same rejection
    // coming back a no-op against an emptied node, and the block would then be shown as visible
    // while carrying nothing at all.
    node.removeAttribute('data-sig');
    if (node.firstChild !== null) node.replaceChildren();
    return;
  }

  const signature = JSON.stringify(rejections);
  if (node.getAttribute('data-sig') === signature) return;
  node.setAttribute('data-sig', signature);

  const lead = doc.createElement('p');
  lead.className = 'dg-rejlead';
  lead.textContent =
    `${plural(rejections.length, 'Digest')} refused and not shown. Each names its field and its ` +
    `overage; the refused text is never quoted back.`;

  const list = doc.createElement('ul');
  list.className = 'dg-rejlist';
  for (const rejection of rejections) {
    const row = doc.createElement('li');
    row.className = 'dg-rej';
    const where = doc.createElement('b');
    where.className = 'dg-rejwhere';
    where.textContent = rejection.where === '' ? 'an unnamed Feature' : rejection.where;
    const detail = doc.createElement('span');
    detail.className = 'dg-rejwhat';
    detail.textContent = ` ${rejection.field}: ${rejection.message}`;
    row.append(where, detail);
    list.appendChild(row);
  }
  node.replaceChildren(lead, list);
}

// ---------------------------------------------------------------------------
// The Feature list
// ---------------------------------------------------------------------------

/**
 * Reconcile the Feature rows: pooled by key, moved rather than rebuilt, and skipped outright
 * when nothing about them changed.
 *
 * @param {Document} doc
 * @param {Element|null} host
 * @param {ReturnType<typeof projectFeature>[]} features
 */
function updateList(doc, host, features) {
  if (host === null) return;

  const existing = new Map();
  for (const node of host.querySelectorAll('[data-feature]')) {
    existing.set(node.getAttribute('data-feature'), node);
  }

  const seen = new Set();
  let previous = null;

  for (const feature of features) {
    seen.add(feature.key);
    const wanted = feature.state === 'current' ? 'details' : 'div';
    let item = existing.get(feature.key) ?? null;
    // A Feature whose Digest is written or expires changes which element it is. Compared
    // case-insensitively because a browser reports `DETAILS` and the test harness reports
    // `details`.
    if (item !== null && item.tagName.toLowerCase() !== wanted) {
      item.remove();
      existing.delete(feature.key);
      item = null;
    }
    if (item === null) {
      item = buildItem(doc, feature);
      host.appendChild(item);
      existing.set(feature.key, item);
    }

    const shouldFollow = previous === null ? host.firstChild : previous.nextSibling;
    if (shouldFollow !== item) host.insertBefore(item, shouldFollow);
    previous = item;

    const signature = JSON.stringify(feature);
    if (item.getAttribute('data-sig') === signature) continue;
    item.setAttribute('data-sig', signature);
    updateItem(doc, item, feature);
  }

  for (const [key, node] of existing) {
    if (seen.has(key)) continue;
    node.remove();
  }
}

/**
 * @param {Document} doc
 * @param {ReturnType<typeof projectFeature>} feature
 */
function buildItem(doc, feature) {
  const open = feature.state === 'current';
  const item = doc.createElement(open ? 'details' : 'div');
  item.className = 'dg-item';
  item.setAttribute('data-feature', feature.key);
  // The exclusive accordion, from the browser rather than from a handler. Only a Feature with a
  // Digest to show is a disclosure at all: an expired or never-written Feature has nothing
  // behind it, and a control that opens onto an empty sheet would invent an empty panel.
  if (open) item.setAttribute('name', SHEET_GROUP);

  const line = doc.createElement(open ? 'summary' : 'p');
  line.className = 'dg-line';

  const glyph = doc.createElement('span');
  glyph.className = 'dg-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  const name = doc.createElement('b');
  name.className = 'dg-name';
  const root = doc.createElement('span');
  root.className = 'dg-root';
  const asOf = doc.createElement('span');
  asOf.className = 'dg-asof';
  const sha = doc.createElement('span');
  sha.className = 'dg-sha lab';
  line.append(glyph, name, root, asOf, sha);
  item.appendChild(line);

  if (open) {
    const sheet = doc.createElement('div');
    sheet.className = 'dg-sheet';
    item.appendChild(sheet);
  }
  return item;
}

/**
 * @param {Document} doc
 * @param {Element} item
 * @param {ReturnType<typeof projectFeature>} feature
 */
function updateItem(doc, item, feature) {
  const marker = AS_OF[feature.state] ?? AS_OF['never-written'];
  setAttr(item, 'data-as-of', feature.state);
  setText(item.querySelector('.dg-glyph'), marker.glyph);
  setText(item.querySelector('.dg-name'), feature.name);
  setText(item.querySelector('.dg-root'), feature.rootLabel);
  setText(item.querySelector('.dg-asof'), asOfSentence(feature));
  // The content hash the as-of comparison turns on, shown because the claim this panel makes is
  // a claim about content. It is the key, not a decoration - and when the frame carries none, it
  // says so rather than printing the word `content` above an empty space.
  setText(
    item.querySelector('.dg-sha'),
    feature.shortSha === '' ? 'content not recorded' : `content ${feature.shortSha}`,
  );

  const sheet = item.querySelector('.dg-sheet');
  if (sheet === null) return;
  const drawn = [];
  for (const block of feature.blocks) {
    const node = buildBlock(doc, block);
    if (node !== null) drawn.push(node);
  }
  sheet.replaceChildren(...drawn);
}

/**
 * The as-of marker, in words.
 *
 * Every branch is a statement about content. None of them is a statement about elapsed time, and
 * none of them is silence.
 *
 * @param {ReturnType<typeof projectFeature>} feature
 */
function asOfSentence(feature) {
  const marker = AS_OF[feature.state] ?? AS_OF['never-written'];
  if (feature.state === 'current') {
    return `${marker.word} \u2014 written against the content now on disk.`;
  }
  if (feature.state === 'expired') {
    return feature.filesChanged === null
      ? `${marker.word} \u2014 written against content that has since changed. ` +
          'How many files moved is not recorded yet.'
      : `${marker.word} \u2014 ${plural(feature.filesChanged, 'file')} changed since it was written.`;
  }
  if (feature.state === 'never-written') {
    return `${marker.word} \u2014 none has ever been written for this Feature.`;
  }
  return (
    `${marker.word} \u2014 this frame records a Digest for this Feature and does not carry one ` +
    'that can be read, so its as-of state is not known.'
  );
}

// ---------------------------------------------------------------------------
// The four Blocks
// ---------------------------------------------------------------------------

/**
 * One Block, or `null` for a kind this function does not know.
 *
 * Exhaustive on all four kinds rather than falling through to `summary` on the way out.
 * `projectBlock` already refuses anything outside the four, so the fallthrough is unreachable -
 * and that is exactly what makes it worth closing: a fifth kind added there and not here would
 * be drawn silently as a paragraph of summary prose, which is the renderer inventing a Block
 * rather than declining to draw one.
 *
 * @param {Document} doc
 * @param {NonNullable<ReturnType<typeof projectBlock>>} block
 */
function buildBlock(doc, block) {
  if (block.kind === 'summary') return buildSummary(doc, block);
  if (block.kind === 'facts') return buildFacts(doc, block);
  if (block.kind === 'bullets') return buildBullets(doc, block);
  if (block.kind === 'links') return buildLinks(doc, block);
  return null;
}

/** @param {Document} doc @param {{text?: string}} block */
function buildSummary(doc, block) {
  const node = doc.createElement('p');
  node.className = 'dg-block dg-summary';
  node.setAttribute('data-block', 'summary');
  node.textContent = readString(block.text);
  return node;
}

/**
 * The Block that replaces charts. Label above value, laid out across the panel's width, with the
 * optional state spelled out beside its tint.
 *
 * @param {Document} doc
 * @param {{items?: {label: string, value: string, state: string}[]}} block
 */
function buildFacts(doc, block) {
  const node = doc.createElement('div');
  node.className = 'dg-block dg-facts';
  node.setAttribute('data-block', 'facts');
  for (const fact of readArray(block.items)) {
    const cell = doc.createElement('div');
    cell.className = 'dg-fact';
    if (fact.state !== '') cell.setAttribute('data-state', fact.state);

    const label = doc.createElement('span');
    label.className = 'dg-flabel lab';
    label.textContent = fact.label;
    const value = doc.createElement('span');
    value.className = 'dg-fvalue';
    value.textContent = fact.value;
    cell.append(label, value);

    if (fact.state !== '') {
      const state = doc.createElement('span');
      state.className = 'dg-fstate';
      state.textContent = fact.state;
      cell.appendChild(state);
    }
    node.appendChild(cell);
  }
  return node;
}

/**
 * @param {Document} doc
 * @param {{title?: string, tone?: string, items?: string[]}} block
 */
function buildBullets(doc, block) {
  const node = doc.createElement('section');
  node.className = 'dg-block dg-bullets';
  node.setAttribute('data-block', 'bullets');

  const tone = readString(block.tone);
  const marked = Object.hasOwn(TONES, tone) ? TONES[tone] : null;
  if (marked !== null) node.setAttribute('data-tone', tone);

  const head = doc.createElement('p');
  head.className = 'dg-bhead';
  if (marked !== null) {
    const glyph = doc.createElement('span');
    glyph.className = 'dg-tglyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = marked.glyph;
    const label = doc.createElement('span');
    label.className = 'dg-tone lab';
    label.textContent = marked.label;
    head.append(glyph, label);
  }
  const title = readString(block.title);
  if (title !== '') {
    const text = doc.createElement('span');
    text.className = 'dg-btitle';
    text.textContent = title;
    head.appendChild(text);
  }
  if (head.firstChild !== null) node.appendChild(head);

  const list = doc.createElement('ul');
  list.className = 'dg-blist';
  for (const item of readArray(block.items)) {
    const row = doc.createElement('li');
    row.className = 'dg-bitem';
    row.textContent = item;
    list.appendChild(row);
  }
  node.appendChild(list);
  return node;
}

/**
 * Paths copy rather than navigate, exactly as every other path on the board does. A file-scheme
 * link from a page served over HTTP is a link a browser refuses to follow, so each one is a real
 * button carrying `data-copy`, served by the delegated listener in `board.js`.
 *
 * @param {Document} doc
 * @param {{items?: {label: string, path: string}[]}} block
 */
function buildLinks(doc, block) {
  const node = doc.createElement('ul');
  node.className = 'dg-block dg-links';
  node.setAttribute('data-block', 'links');
  for (const link of readArray(block.items)) {
    const row = doc.createElement('li');
    row.className = 'dg-link';

    const label = doc.createElement('span');
    label.className = 'dg-llabel';
    label.textContent = link.label;

    const button = doc.createElement('button');
    button.className = 'copy dg-lpath';
    button.type = 'button';
    button.setAttribute('data-copy', link.path);
    button.setAttribute('aria-label', `Copy path ${link.path}`);
    button.textContent = link.path;

    row.append(label, button);
    node.appendChild(row);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {unknown} value */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function readArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function readString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * A count off a socket: a non-negative safe integer, or `null` when the value is not one.
 *
 * `null` rather than `0`, and no rounding. Both matter and for the same reason: a fractional or
 * absent count answered as a number is a number the board prints as fact and nothing supplied.
 *
 * @param {unknown} value
 */
function readCount(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return null;
  return Number(value);
}

/** @param {number} count @param {string} noun */
function plural(count, noun) {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** @param {Element|null} node @param {string} text */
function setText(node, text) {
  if (node !== null && node.textContent !== text) node.textContent = text;
}

/** @param {Element|null} node @param {string} name @param {string} value */
function setAttr(node, name, value) {
  if (node !== null && node.getAttribute(name) !== value) node.setAttribute(name, value);
}
