/**
 * tracker-board - the repo-wide domain-model panel.
 *
 * A ledger of the Root's ADRs and a counted pointer at its glossary, drawn below and outside
 * the six columns because both are repo-scoped rather than Feature-scoped.
 *
 * ## What this panel refuses to say, and why the refusal is the feature
 *
 * An ADR column is deliberately excluded. Columns encode workflow state, so an ADR column
 * asserts that ADRs have one - and they do not, which is exactly why supersession in this
 * corpus is an in-body `## Amendment` section rather than a status field. The refusal has to
 * survive into the drawing or the invented lifecycle comes back in prose:
 *
 *   - no status, no lifecycle, no "deprecated", no "superseded", no vocabulary the corpus
 *     does not contain;
 *   - `amendmentHeading` is the literal text of a heading. It is drawn in quotation marks,
 *     under a label that says `heading`, so it cannot be read as a state the ADR is in.
 *     **"Amended" is not a status**;
 *   - ordering is by number, which is chronological. It is not a progression and there is no
 *     next stage for a row to move to.
 *
 * The glossary is a pointer and never its contents. Ubiquitous language must not compete with
 * the ticket board for screen, so the counts sit on the board and everything else sits behind
 * a dialog - which holds the pointer and the counts, and states that the definitions are not
 * reproduced here rather than reproducing a few of them.
 *
 * ## Scale
 *
 * The rows scroll inside a fixed-height box. That is the property that rules out a column:
 * at forty ADRs a column is several thousand pixels of page and this panel is
 * the same height it is at four.
 *
 * ## Two things that only bite on a live board
 *
 * `renderDomain` runs on EVERY board render - several times a minute, and once per file
 * change while an agent is working in a watched repo. So:
 *
 *   - it installs its click handler **once per document**, never per frame. Handlers added
 *     inside a render accumulate silently, one per frame, and the symptom is a control firing
 *     N times with nothing in the source saying so;
 *   - it rebuilds **only when its own inputs changed**, keyed on a signature of the projected
 *     model. Rebuilding every frame would reset the scroll position of the ADR box and close
 *     an open dialog underneath the reader, on a board that re-renders while they read.
 *
 * Rules carried from the rest of the board: nodes are built with `textContent` and never from
 * a string, styles live in `domain.css` rather than inline, and a path is a button that
 * copies rather than anything that navigates - the document is served under a policy that
 * forbids the alternatives.
 */

/** The mount this module owns. Nothing else writes into it. */
const MOUNT = 'domain-panel';

/** Where the rebuild decision is recorded, so a frame that changes nothing costs nothing. */
const SIGNATURE = 'data-domain-sig';

/** The panel's own heading, which is what names the mount as a region. */
const HEADING_ID = 'domain-h';

/**
 * Every document this module has already wired.
 *
 * One handler per document for the life of the page. A **set**, not the last document seen:
 * remembering only the most recent one made "once per document" false the moment a second
 * document appeared, because returning to the first found the memory pointing elsewhere and
 * wired it again. Rendering into A, then B, then A must not produce two handlers on A. Weak, so
 * a document this module has seen is still collectable.
 */
const wired = new WeakSet();

/**
 * @param {Document} doc
 * @param {import('./view.js').BoardView} view
 * @param {unknown} snapshot The raw Snapshot, exactly as `buildView` receives it: unvalidated,
 *   and `null` until the first frame arrives.
 * @returns {void}
 */
export function renderDomain(doc, view, snapshot) {
  // Before the first frame there is nothing to draw and nothing to clear - the value never
  // goes back to absent once a frame has arrived - so the document is not touched at all.
  //
  // `undefined` counts as absent alongside `null`, which is the shared contract in
  // `board-ui.test.ts` and is also the honest reading: `board.js` holds `null` until the first
  // frame, and `JSON.parse` cannot return `undefined`, so a frame that is literally undefined
  // is nothing having been passed rather than a malformed Snapshot having arrived. Everything
  // that is not absent but is not a Snapshot either is a **fault**, and is stated below.
  //
  // `view` is the board's own projection and carries no ADRs and no glossary by design; this
  // panel projects the Snapshot itself, below.
  if (snapshot === null || snapshot === undefined) return;
  void view;

  try {
    // A frame that is not a Snapshot at all is stated, never absorbed. Folding it into the
    // `null` case or empty projection has two opposite failure modes: `"text"` returns early and
    // leaves previous ADRs on screen as though they were current, while `{ roots: "nope" }`
    // projects to no Roots and clears the mount - which is this panel's way of saying "this
    // repository keeps no ADRs and has no glossary". A malformed frame is neither of those
    // things, so this branch rejects the shape explicitly before projection.
    const fault = frameFault(snapshot);
    if (fault !== null) failed(doc, fault);
    else draw(doc, project(snapshot));
  } catch (error) {
    // Total, and deliberately NOT silent.
    //
    // `board.js` calls the three panels in bare sequence and then restores the focused card, so
    // a throw here costs the reader their focus and takes its two peers down with it. That is
    // why this is caught at all.
    //
    // But catching and rendering nothing would be worse than the throw. "This panel could not
    // be drawn" and "this repository has no ADRs and no glossary" would then be the same empty
    // mount, and the second is a state this panel is specifically required to render - so the
    // failure would be wearing the costume of a correct answer. It is drawn instead, and it
    // says which of the two it is.
    try {
      failed(doc, error);
    } catch {
      // The document itself is unusable, so there is nowhere left to say anything. This is the
      // only silent branch in the module and it is silent because it has no alternative.
    }
  }
}

// ---------------------------------------------------------------------------
// The projection. `BoardView` is built for the six columns and structurally cannot carry
// this, so it is read off the Snapshot here rather than in the shared view model.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AdrRow
 * @property {number|null} number From the file name.
 * @property {string} title From the H1, or the file name when there is none.
 * @property {'h1'|'filename'|'none'} titleSource Which of those two `title` actually is.
 * @property {string} path Root-relative, as the board displays it.
 * @property {string} copyPath Absolute where the walk supplied one - what the clipboard gets.
 * @property {string|null} amendment The literal text of an `## Amendment` heading.
 * @property {string|null} error Why the file could not be read.
 */

/**
 * @typedef {object} GlossaryRow
 * @property {string} path
 * @property {string} copyPath
 * @property {number} terms
 * @property {number} sections
 * @property {string|null} error
 */

/**
 * @typedef {object} RootPanel
 * @property {string} label
 * @property {AdrRow[]} adrs
 * @property {GlossaryRow|null} glossary
 */

/**
 * @typedef {object} DomainModel
 * @property {RootPanel[]} roots Only Roots with something to show. A Root with neither an ADR
 *   directory nor a glossary contributes nothing, which is what makes the panel absent rather
 *   than empty scaffolding when no Root has either.
 * @property {boolean} named Whether Root labels are drawn. One Root needs no heading.
 */

/**
 * Why this frame is not a Snapshot, or `null` when it is one worth projecting.
 *
 * Deliberately narrow. It asks only about the **shape the panel navigates** \u2014 the value itself
 * and its `roots` list \u2014 because everything below that is read defensively and degrades to a
 * stated per-row answer. Widening it to "every field is the right type" would turn one odd ADR
 * entry into a whole panel refusing to draw, which is the opposite of what this is for.
 *
 * `roots` being absent is not a fault: a Snapshot from a board with no repositories registered
 * legitimately has none, and that is the absent state.
 *
 * @param {unknown} snapshot
 * @returns {string|null}
 */
function frameFault(snapshot) {
  if (typeof snapshot !== 'object') {
    return `the board sent a ${typeof snapshot} where a Snapshot was expected`;
  }
  const roots = peek(snapshot, 'roots');
  if (roots !== undefined && !Array.isArray(roots)) {
    return 'the Snapshot carries no list of repositories';
  }
  return null;
}

/**
 * @param {unknown} snapshot
 * @returns {DomainModel}
 */
function project(snapshot) {
  const roots = [];
  for (const root of asArray(peek(snapshot, 'roots'))) {
    const adrs = asArray(peek(root, 'adrs')).map(adrRow);
    const glossary = glossaryRow(peek(root, 'glossary'));
    // The whole of the absent test. Nothing to say about a Root is said with no node at all.
    if (adrs.length === 0 && glossary === null) continue;
    roots.push({ label: asString(peek(root, 'label')) || asString(peek(root, 'path')), adrs, glossary });
  }
  return { roots, named: roots.length > 1 };
}

/**
 * @param {unknown} entry
 * @returns {AdrRow}
 */
function adrRow(entry) {
  const path = asString(peek(entry, 'path'));
  const source = asString(peek(entry, 'titleSource'));
  return {
    number: asNumber(peek(entry, 'number')),
    title: asString(peek(entry, 'title')),
    // Anything the seam has not vouched for is treated as the weakest of the three, because
    // the only claim this field makes is "this really is a title" and a missing field makes
    // no claim at all.
    titleSource: source === 'h1' || source === 'filename' ? source : 'none',
    path,
    copyPath: asString(peek(entry, 'absPath')) || path,
    amendment: asOptionalString(peek(entry, 'amendmentHeading')),
    error: asOptionalString(peek(entry, 'readError')),
  };
}

/**
 * @param {unknown} value
 * @returns {GlossaryRow|null}
 */
function glossaryRow(value) {
  if (typeof value !== 'object' || value === null) return null;
  const path = asString(peek(value, 'path'));
  return {
    path,
    copyPath: asString(peek(value, 'absPath')) || path,
    terms: asCount(peek(value, 'termCount')),
    sections: asCount(peek(value, 'sectionCount')),
    error: asOptionalString(peek(value, 'readError')),
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {DomainModel} model
 * @returns {void}
 */
function draw(doc, model) {
  const mount = doc.getElementById(MOUNT);
  if (mount === null) return;

  // Nothing below this line runs on a frame that changed nothing, which is most of them: the
  // board re-renders on every file change in a watched repo, and ADRs move on a scale of
  // weeks. Rebuilding anyway would take the reader's scroll position and any open dialog with
  // it, several times a minute.
  const signature = JSON.stringify(model);
  if (mount.getAttribute(SIGNATURE) === signature) return;

  // Every node is built before a single one is attached, and the signature is recorded **last**.
  // Both matter for the same reason: if building throws, the mount still holds the last good
  // render rather than half of a new one, and no signature was recorded - so the next frame
  // tries again instead of matching a signature left behind by a render that never finished.
  const nodes = build(doc, model);
  mount.replaceChildren(...nodes);
  if (nodes.length === 0) mount.removeAttribute('aria-labelledby');
  else mount.setAttribute('aria-labelledby', HEADING_ID);
  mount.setAttribute(SIGNATURE, signature);
}

/**
 * Every node the panel draws, or an empty list when there is nothing to say.
 *
 * An empty list is the **absent** state and is a real answer: `board.css` hides an empty
 * `.panelmount`, so a Root with no ADR directory and no glossary leaves no heading, no rule and
 * no gap behind. It is emphatically not the failure state - see {@link failed}.
 *
 * @param {Document} doc
 * @param {DomainModel} model
 * @returns {Element[]}
 */
function build(doc, model) {
  if (model.roots.length === 0) return [];

  wire(doc);
  const subhead = el(doc, 'div', 'subhead');
  subhead.append(headingNode(doc), el(doc, 'p', 'subnote', summarise(model)));

  const nodes = [subhead, el(doc, 'p', 'sectnote', REFUSAL)];
  model.roots.forEach((root, index) => {
    nodes.push(rootBlock(doc, root, index, model.named));
  });
  return nodes;
}

/**
 * Draw the fact that this panel could not be drawn.
 *
 * The whole point is that this is **not** an empty mount. An empty mount already means
 * something here - "this repository keeps no ADRs and has no glossary" - and a panel that
 * failed and rendered nothing would be making that claim on a repository it knows nothing
 * about. So the failure is stated, in the same place the ledger would have been, and it says
 * explicitly which of the two it is.
 *
 * The signature is **cleared** rather than recorded. A failure is not a rendered state to be
 * skipped next frame: the very next Snapshot must be allowed to try again, and on this board
 * the next one is usually a few hundred milliseconds away.
 *
 * @param {Document} doc
 * @param {unknown} error
 * @returns {void}
 */
function failed(doc, error) {
  const mount = doc.getElementById(MOUNT);
  if (mount === null) return;
  mount.removeAttribute(SIGNATURE);

  const subhead = el(doc, 'div', 'subhead');
  subhead.append(headingNode(doc), el(doc, 'p', 'subnote', 'could not be drawn'));

  const note = el(doc, 'p', 'dom-failed');
  // Announced, because this replaces content that was on screen a moment ago and a reader who
  // is not looking at this corner of the page would otherwise never learn it had gone.
  note.setAttribute('role', 'status');
  note.textContent =
    `This panel could not be drawn from the current Snapshot \u2014 ${String(error)}. The ADRs ` +
    'and the glossary are not shown, which is not the same as this repository having none.';

  mount.replaceChildren(subhead, note);
  mount.setAttribute('aria-labelledby', HEADING_ID);
}

/**
 * @param {Document} doc
 * @returns {Element}
 */
function headingNode(doc) {
  const heading = el(doc, 'h2', '', 'Domain model');
  heading.id = HEADING_ID;
  return heading;
}

/**
 * What the panel says about itself, in the vocabulary the files themselves use.
 *
 * It is here because the alternative to stating the refusal is a reader inferring the thing
 * the design rejected: a ledger ordered by number looks like a pipeline unless it says it is
 * not one, and a quoted heading looks like a status unless it says it is a heading.
 */
const REFUSAL =
  'Ordered by number, which is chronological rather than a progression \u2014 there is no ' +
  'next stage for a decision to reach. An ADR carries no status field, so none is shown ' +
  'here: where a file has an in-body Amendment heading, that heading is quoted and means ' +
  'only that the file has it.';

/**
 * @param {DomainModel} model
 * @returns {string}
 */
function summarise(model) {
  let adrs = 0;
  let withHeading = 0;
  let unreadable = 0;
  let glossaries = 0;
  for (const root of model.roots) {
    adrs += root.adrs.length;
    for (const adr of root.adrs) {
      if (adr.amendment !== null) withHeading += 1;
      if (adr.error !== null) unreadable += 1;
    }
    if (root.glossary !== null) glossaries += 1;
  }
  const parts = [plural(adrs, 'decision record', 'decision records')];
  if (withHeading > 0) parts.push(`${String(withHeading)} carrying an Amendment heading`);
  if (unreadable > 0) parts.push(plural(unreadable, 'unreadable', 'unreadable'));
  parts.push(plural(glossaries, 'glossary', 'glossaries'));
  return parts.join(' \u00b7 ');
}

/**
 * @param {Document} doc
 * @param {RootPanel} root
 * @param {number} index
 * @param {boolean} named
 * @returns {Element}
 */
function rootBlock(doc, root, index, named) {
  const block = el(doc, 'div', 'dom-root');
  if (named) block.append(el(doc, 'h3', 'dom-rootname', root.label));

  const columns = el(doc, 'div', 'dom-cols');
  if (root.adrs.length > 0) columns.append(adrBox(doc, root.adrs));
  if (root.glossary !== null) columns.append(glossaryBox(doc, root.glossary, index));
  block.append(columns);
  return block;
}

/**
 * The ledger.
 *
 * An `<ol>` because the order is a real ordering and a reader using assistive technology
 * should be told so; the numbers it would draw itself are suppressed in the stylesheet,
 * because the number that matters comes from the file name and is drawn in the gutter.
 *
 * @param {Document} doc
 * @param {AdrRow[]} adrs
 * @returns {Element}
 */
function adrBox(doc, adrs) {
  const box = el(doc, 'div', 'dom-adrs');
  box.append(el(doc, 'h3', 'dom-h3', `Decisions (${String(adrs.length)})`));

  const list = el(doc, 'ol', 'dom-list');
  // A scroll region is only reachable by keyboard if something in it takes focus. Every row
  // carries a copy button, so it is - but the region is labelled and focusable in its own
  // right so it can be scrolled without tabbing through forty of them.
  list.setAttribute('tabindex', '0');
  list.setAttribute('aria-label', 'Architecture decision records');
  for (const adr of adrs) list.append(adrItem(doc, adr));
  box.append(list);
  return box;
}

/**
 * @param {Document} doc
 * @param {AdrRow} adr
 * @returns {Element}
 */
function adrItem(doc, adr) {
  const item = el(doc, 'li', 'dom-adr');

  // The number is a direct child of the row and everything else is inside one line node, so
  // the row's two columns hold exactly two things. Making the line `display: contents` would
  // append all three children to the grid and put the third - the rare `no H1` label - into the
  // *next* implicit row, under the number gutter. Browser layout coverage keeps the real grid
  // and fallback together.
  //
  // An em dash where the file name carries no leading number. Absent is drawn as absent rather
  // than as a zero, which would sort and read as a real ADR number.
  item.append(el(doc, 'span', 'dom-num', adr.number === null ? '\u2014' : String(adr.number)));

  const line = el(doc, 'p', 'dom-line');
  const title = el(doc, 'span', 'dom-title', adr.title);
  if (adr.titleSource !== 'h1') title.setAttribute('data-source', adr.titleSource);
  line.append(title);
  if (adr.titleSource === 'filename') {
    // The file name is not a title, and a row that shows one without saying so is claiming a
    // title the file does not have.
    line.append(el(doc, 'span', 'dom-lab', 'file name \u2014 no H1'));
  }
  item.append(line);

  if (adr.amendment !== null) {
    const amend = el(doc, 'p', 'dom-amend');
    amend.append(el(doc, 'span', 'dom-lab', 'heading'));
    // Quotation marks, verbatim text, and a label that says `heading`. Three separate things
    // all saying the same one: this is what the file says, not what the board thinks it is.
    amend.append(el(doc, 'q', 'dom-quote', adr.amendment));
    item.append(amend);
  }

  if (adr.error !== null) {
    item.append(el(doc, 'p', 'dom-err', `could not be read \u2014 ${adr.error}`));
  }

  item.append(pathButton(doc, adr.path, adr.copyPath));
  return item;
}

/**
 * @param {Document} doc
 * @param {GlossaryRow} glossary
 * @param {number} index
 * @returns {Element}
 */
function glossaryBox(doc, glossary, index) {
  const box = el(doc, 'div', 'dom-gloss');
  box.append(el(doc, 'h3', 'dom-h3', 'Glossary'));

  if (glossary.error === null) {
    // The figure and its noun are separate nodes because they are set at different sizes, so
    // the noun is the noun alone - `plural` carries the count with it and would print it
    // twice. Which it did, and only a browser showed it: the drawn text read `55 terms`.
    const counts = el(doc, 'p', 'dom-counts');
    counts.append(el(doc, 'b', 'dom-big', String(glossary.terms)));
    counts.append(el(doc, 'span', 'dom-unit', unit(glossary.terms, 'term', 'terms')));
    counts.append(el(doc, 'b', 'dom-big', String(glossary.sections)));
    counts.append(el(doc, 'span', 'dom-unit', unit(glossary.sections, 'section', 'sections')));
    box.append(counts);
  } else {
    // Counted zero and unreachable are not the same answer, and a pointer that showed `0
    // terms` for a file nobody could open would be the second dressed as the first.
    box.append(el(doc, 'p', 'dom-err', `could not be read \u2014 ${glossary.error}`));
  }

  box.append(pathButton(doc, glossary.path, glossary.copyPath));

  const id = `domain-gloss-${String(index)}`;
  const open = el(doc, 'button', 'dom-open', 'Definitions\u2026');
  open.type = 'button';
  open.setAttribute('data-domain-open', id);
  open.setAttribute('aria-haspopup', 'dialog');
  box.append(open);
  box.append(glossaryDialog(doc, glossary, id));
  return box;
}

/**
 * The dialog the definitions sit behind.
 *
 * It holds the pointer and the counts, and says plainly that the terms are not reproduced on
 * the board. That is the honest content: the Snapshot carries a counted pointer and never the
 * glossary itself, so a dialog listing a few definitions would be a dialog listing whichever
 * few somebody chose - and the reason the definitions are off the board in the first place is
 * that ubiquitous language must not compete with the ticket board for screen.
 *
 * @param {Document} doc
 * @param {GlossaryRow} glossary
 * @param {string} id
 * @returns {Element}
 */
function glossaryDialog(doc, glossary, id) {
  const dialog = el(doc, 'dialog', 'dom-dialog');
  dialog.id = id;
  const title = el(doc, 'h4', 'dom-dialog-h', 'Glossary');
  title.id = `${id}-h`;
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.append(title);

  dialog.append(
    el(
      doc,
      'p',
      'dom-dialog-p',
      glossary.error === null
        ? `${plural(glossary.terms, 'term', 'terms')} in ${plural(glossary.sections, 'section', 'sections')}.`
        : `This file could not be read \u2014 ${glossary.error}`,
    ),
  );
  dialog.append(
    el(
      doc,
      'p',
      'dom-dialog-p',
      'The definitions are not reproduced here. They live in the file below, which is the ' +
        'one copy of them: a board that restated a few of them would be a second, staler ' +
        'glossary competing with the Tickets for the screen.',
    ),
  );
  dialog.append(pathButton(doc, glossary.path, glossary.copyPath));

  // `method="dialog"` closes without a handler of any kind, so the only behaviour this panel
  // registers is opening. Escape closes it natively as well.
  const form = el(doc, 'form', 'dom-dialog-form');
  form.setAttribute('method', 'dialog');
  const close = el(doc, 'button', 'dom-close', 'Close');
  close.type = 'submit';
  form.append(close);
  dialog.append(form);
  return dialog;
}

/**
 * A path, as a button that copies it.
 *
 * Never anything that navigates: the board is served over HTTP and a file-scheme link from an
 * HTTP origin is one the browser refuses to follow. The attribute is all this needs - the
 * document-level handler in `board.js` owns the clipboard write, the confirmation line, and
 * the case where the write never settles at all.
 *
 * The displayed text is the Root-relative path and the copied text is the absolute one, which
 * is the same split every path on the board already uses.
 *
 * @param {Document} doc
 * @param {string} path
 * @param {string} copyPath
 * @returns {Element}
 */
function pathButton(doc, path, copyPath) {
  const button = el(doc, 'button', 'copy dom-path', path);
  button.type = 'button';
  button.setAttribute('data-copy', copyPath);
  button.setAttribute('aria-label', `Copy path ${path}`);
  return button;
}

// ---------------------------------------------------------------------------
// The one handler
// ---------------------------------------------------------------------------

/**
 * Register the dialog opener, once per document.
 *
 * Delegated, and outside the render path, for the two reasons the board's own listener is:
 * this function runs on every frame, so a listener added from inside it accumulates one per
 * frame; and the nodes it acts on are replaced whenever the ADRs change, so a listener bound
 * to a node would go with them.
 *
 * @param {Document} doc
 * @returns {void}
 */
function wire(doc) {
  if (wired.has(doc)) return;
  doc.addEventListener('click', (event) => {
    const target = event?.target;
    // Duck-typed rather than `instanceof Element` / `instanceof HTMLDialogElement`. Those read
    // the *ambient* constructors, which belong to this module's own window; an element from
    // another realm - an iframe, a second window - fails the check while being a perfectly good
    // element, and the control silently stops working. Asking whether it can do the thing is
    // both more robust and narrower.
    if (typeof target?.closest !== 'function') return;
    const opener = target.closest('[data-domain-open]');
    if (opener === null) return;
    const dialog = doc.getElementById(opener.getAttribute('data-domain-open') ?? '');
    // `showModal` throws on a dialog that is already open, and a double click is an ordinary
    // thing for a reader to do.
    if (typeof dialog?.showModal === 'function' && dialog.open !== true) dialog.showModal();
  });
  wired.add(doc);
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {Element}
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  // `textContent`, never a string of markup: these values are file names and headings out of
  // somebody else's repository.
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function plural(count, one, many) {
  return `${String(count)} ${unit(count, one, many)}`;
}

/**
 * The noun on its own, for the one place the figure beside it is drawn separately.
 *
 * @param {number} count
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function unit(count, one, many) {
  return count === 1 ? one : many;
}

// ---------------------------------------------------------------------------
// Reading values that arrived over a socket. Same terms as `view.js`: this is `JSON.parse`
// output and every field on it is a claim rather than a fact.
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
 * A string that is meaningfully absent when it is absent - an amendment heading, a read
 * failure. Distinct from `asString` because `''` and "there is none" are different answers
 * here, and collapsing them would draw an empty quotation on every ADR that carries no
 * such heading.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function asOptionalString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
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
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
