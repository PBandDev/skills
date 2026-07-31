/**
 * A minimal DOM, for the narrow class of thing a fake DOM can honestly prove.
 *
 * ## Why this exists at all, given the suite's stated position
 *
 * `view.test.ts` says the DOM side is exercised against a real browser "because those are the
 * parts a fake DOM would let pass", and that remains true of everything it was written about:
 * focus surviving a Lane move, the just-changed tint restarting, a clipboard write that never
 * settles, and any question whose answer is a computed layout. None of those are asked here and
 * none of them can be. This harness models element construction and tree order, and that is the
 * whole of its competence.
 *
 * What it does buy is the one assertion shape that source-scanning cannot express: that a
 * *completed* render pass produced a particular node. An empty state is exactly what a total
 * collapse produces for free, so "the empty sub-lane header is drawn" is only worth asserting
 * beside something in the same pass that a collapse would have destroyed.
 *
 * ## The silent-failure mode, and the guard on it
 *
 * A fake DOM fails dangerously in one direction: a `querySelector` that quietly answers `null`,
 * or a selector form it does not implement, makes every assertion about an absent node pass. So
 * `compile` throws on any selector shape it does not handle rather than returning nothing, and
 * `render.test.ts` runs positive controls over the harness itself before trusting a word it says.
 *
 * ## Unimplemented is not the same as absent, and the distinction is the whole of `compile`
 *
 * That guard is right, and for a while it was also a trap, because the set of implemented forms
 * was narrower than the set the board actually writes. `#board [data-card]` - the selector
 * `ui/board.js` uses to find the card it must give focus back to - and `.corrrows li` were both
 * *errors* here rather than misses, so a test written against the real DOM died on the harness
 * for a reason that had nothing to do with the code under test. Three panel test files worked
 * around it privately instead of saying so.
 *
 * The fix is not to soften the throw; a silent `null` for an unimplemented form is still the
 * worst thing this file could do. It is to implement the forms the board writes - id, type,
 * compound and selector-list, beside the class, attribute-presence and descendant forms that
 * were already here - so that `null` means *no element matched* and a throw means *this harness
 * cannot answer that question*. Anything genuinely unimplemented still throws.
 */

/** A node in the fake tree. Text nodes exist because `textContent` has to read back. */
export type FakeNode = FakeText | FakeElement;

export class FakeText {
  parentNode: FakeElement | null = null;
  data: string;

  constructor(data: string) {
    this.data = data;
  }
}

export class FakeElement {
  readonly tagName: string;
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  /** A plain property, as the renderer uses it. The `[hidden]` cascade is a browser question. */
  hidden = false;
  /** Buttons carry one. Nothing here reads it; it exists so assigning it is not a crash. */
  type = '';

  readonly attributes = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }

  set className(value: string) {
    this.attributes.set('class', value);
  }

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  set id(value: string) {
    this.attributes.set('id', value);
  }

  get textContent(): string {
    let out = '';
    for (const child of this.childNodes) {
      out += child instanceof FakeText ? child.data : child.textContent;
    }
    return out;
  }

  set textContent(text: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (text !== '') this.appendChild(new FakeText(text));
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    if (siblings === undefined) return null;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild<T extends FakeNode>(node: T): T {
    detach(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  /**
   * Detaches first, then locates the reference - in that order, because a node moving within
   * the list it is already in would otherwise be spliced against a stale index.
   */
  insertBefore<T extends FakeNode>(node: T, reference: FakeNode | null): T {
    if (reference === null) return this.appendChild(node);
    detach(node);
    const index = this.childNodes.indexOf(reference);
    if (index === -1) throw new Error('insertBefore was given a reference that is not a child');
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    for (const node of nodes) this.appendChild(node);
  }

  remove(): void {
    detach(this);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /**
   * Descendants matching any alternative in the selector list, in document order.
   *
   * The walk is over the tree rather than over the alternatives, which is what makes
   * `#board [data-card], #offboard [data-card]` answer the way the real DOM does: one entry per
   * element, ordered by the document, never once per alternative it happens to satisfy.
   */
  querySelectorAll(selector: string): FakeElement[] {
    return query(this, selector, false);
  }

  /** The renderer reads a width to restart an animation. No layout exists here to report. */
  getBoundingClientRect(): { width: number; height: number } {
    return { width: 0, height: 0 };
  }
}

export class FakeDocument {
  readonly root: FakeElement;

  constructor(root: FakeElement) {
    this.root = root;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  /**
   * Delegated listeners, by type, in the order they were registered.
   *
   * The panels install one delegated handler per document rather than one per node, so a
   * document with no `addEventListener` is not a document a panel can render into. `domain.js`
   * calls it unconditionally, and against a harness without one it threw, landed in its own
   * catch, and drew its *failure* notice - a panel test would have been asserting against a
   * crash while reading like a test about content.
   *
   * They are kept rather than counted because counting and discarding would let a completely
   * empty handler pass every listener test there is.
   */
  readonly delegated = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const registered = this.delegated.get(type) ?? [];
    registered.push(handler);
    this.delegated.set(type, registered);
  }

  getElementById(id: string): FakeElement | null {
    if (this.root.id === id) return this.root;
    for (const element of descendants(this.root)) {
      if (element.id === id) return element;
    }
    return null;
  }

  /**
   * `ui/board.js` searches from the document, not from an element, and its two most
   * load-bearing searches - the card to give focus back to, and the marks to clear before
   * moving - are both written that way.
   *
   * The root is a candidate here, unlike an element's own query. That is the difference between
   * the two, not an inconsistency: `element.querySelector` never returns the element it was
   * called on, while `document.querySelector('body')` really does answer the body. Delegating to
   * the root without including the root itself would answer `null` where a browser answers a
   * node, which is the direction this harness must never differ from the browser.
   */
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return query(this.root, selector, true);
  }
}

/**
 * Every id `ui/render.js` reads out of the document.
 *
 * A missing one is silent - `getElementById` answers `null`, the renderer returns early or
 * skips a section, and a test asserting an absence passes. `render.test.ts` holds this list to
 * both the shipped document and the renderer's own source, so it cannot drift out from under a
 * test that depends on it.
 */
export const MOUNT_IDS = [
  'summary',
  'totals',
  'headline',
  'notices',
  'emptystate',
  'board',
  'offboard-section',
  'offboard-count',
  'offboard-note',
  'offboard',
  'legend-title',
  'legend-note',
  'legend',
] as const;

/**
 * The three panel mounts, which `ui/render.js` never touches and every panel needs.
 *
 * Held apart from {@link MOUNT_IDS} rather than folded into it, because that list has a job:
 * `render.test.ts` holds it to the renderer's own `getElementById` calls, and widening it with
 * ids the renderer is specifically forbidden to read would make that check weaker for the
 * renderer while proving nothing about the panels.
 *
 * They are mounted by {@link boardDocument} all the same. A helper named for building a board
 * document that could not build one any panel could render into was the trap: each of the three
 * panel test files appended its own mount privately, which is three copies of one line, and the
 * one shape a panel test most needs - all three panels drawn into the same document, the way
 * `board.js` draws them - could not be built by anybody.
 */
export const PANEL_MOUNT_IDS = ['corrections-panel', 'digest-panel', 'domain-panel'] as const;

/** A document carrying the mounts of `ui/index.html`, and nothing else. */
export function boardDocument(): FakeDocument {
  const root = new FakeElement('body');
  const doc = new FakeDocument(root);
  for (const id of MOUNT_IDS) {
    const node = doc.createElement('div');
    node.id = id;
    root.appendChild(node);
  }
  // `section.section.panelmount`, exactly as `ui/index.html` declares them: the `:empty` rule
  // that takes an undrawn panel off the page keys on that class, and a panel asserting it was
  // drawn into a bare `div` would be asserting against a mount the board does not ship.
  for (const id of PANEL_MOUNT_IDS) {
    const node = doc.createElement('section');
    node.id = id;
    node.className = 'section panelmount';
    root.appendChild(node);
  }
  return doc;
}

/** Every element under `root`, in document order, excluding `root` itself. */
export function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (element: FakeElement): void => {
    for (const child of element.childNodes) {
      if (child instanceof FakeText) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Everything under `scope` matching any alternative in the selector list, in document order.
 *
 * The walk is over the tree rather than over the alternatives, which is what makes
 * `#board [data-card], #offboard [data-card]` answer the way the real DOM does: one entry per
 * element, ordered by the document, never once per alternative it happens to satisfy.
 *
 * @param includeScope Whether `scope` itself is a candidate. False for an element's own query,
 *   which never returns the element it was called on; true for the document's, which searches
 *   the whole tree and can answer with the body.
 */
function query(scope: FakeElement, selector: string, includeScope: boolean): FakeElement[] {
  const alternatives = compile(selector);
  const candidates = includeScope ? [scope, ...descendants(scope)] : descendants(scope);
  const found: FakeElement[] = [];
  for (const element of candidates) {
    if (alternatives.some((sequence) => matches(element, sequence))) found.push(element);
  }
  return found;
}

/** One simple selector: a single condition on a single element. */
type Part =
  | { kind: 'class'; value: string }
  | { kind: 'attribute'; value: string }
  | { kind: 'id'; value: string }
  | { kind: 'tag'; value: string };

/** One compound selector: every simple selector that has to hold on the *same* element. */
type Compound = Part[];

/** One entry of a selector list: compounds joined by the descendant combinator. */
type Sequence = Compound[];

/**
 * One simple selector, anchored at the start of what is left of a compound.
 *
 * Order inside the alternation is load-bearing. The attribute form has to be tried before the
 * type form, or `[data-card]` would never be reached; and the type form is last precisely
 * because it is the only one with no sigil, so it must not get first refusal on anything.
 *
 * The attribute form is presence only - `[a="b"]`, `[a^="b"]` and friends deliberately fail
 * here, because matching a value is a question this harness has never been able to answer and
 * answering it wrongly is worse than refusing it.
 */
const SIMPLE = /^(?:\[[a-z][a-z0-9-]*\]|\.[a-z][a-z0-9_-]*|#[a-z][a-z0-9_-]*|[a-z][a-z0-9]*)/i;

/**
 * Class, attribute-presence, id and type selectors; compounds of them; the descendant
 * combinator between them; and a comma-separated list of the result.
 *
 * Anything else throws - a child combinator, an attribute *value*, a pseudo-class, `*`. Returning
 * no match for an unimplemented form would be the harness's worst failure: silently
 * correct-looking, and permanently green. What has changed is only which forms are unimplemented:
 * the four above are the ones `ui/*.js` and its tests actually write, and while they threw, a
 * test written against the real DOM failed here for a reason belonging to the harness.
 *
 * @returns One {@link Sequence} per entry in the selector list. An element matches the selector
 *   when it matches any of them.
 */
function compile(selector: string): Sequence[] {
  return selector.split(',').map((alternative) => compileSequence(selector, alternative));
}

function compileSequence(selector: string, alternative: string): Sequence {
  const tokens = alternative.trim().split(/\s+/).filter((token) => token !== '');
  // A selector list with a hole in it - `'a,,b'`, `''`, `'.x, '` - is a syntax error in the real
  // DOM, and it reaches here as an alternative that compiles to nothing. Left to return an empty
  // sequence it would match every element, which is the loudest way to be silently wrong.
  if (tokens.length === 0) {
    throw new Error(`the fake DOM was given an empty selector in \`${selector}\``);
  }
  return tokens.map((token) => compileCompound(selector, token));
}

function compileCompound(selector: string, token: string): Compound {
  const parts: Compound = [];
  let rest = token;
  while (rest !== '') {
    const piece = SIMPLE.exec(rest)?.[0];
    if (piece === undefined) {
      throw new Error(
        `the fake DOM does not implement the selector \`${selector}\`: no rule for \`${token}\``,
      );
    }
    const part = simple(piece);
    // A type selector is legal at most once and only at the head of a compound. Without this,
    // `[data-card]div` compiles and matches while a browser rejects it, and `div[data-card]span`
    // compiles and quietly matches nothing at all - the second being the shape this whole file
    // is written against, since a selector that answers "no elements" makes every assertion
    // about an absent node pass forever.
    if (part.kind === 'tag' && parts.length > 0) {
      throw new Error(
        `the fake DOM does not implement the selector \`${selector}\`: \`${token}\` puts the ` +
          `type selector \`${piece}\` after another simple selector, which no browser accepts`,
      );
    }
    parts.push(part);
    rest = rest.slice(piece.length);
  }
  return parts;
}

function simple(piece: string): Part {
  const sigil = piece[0];
  // An attribute name is lower-cased, as an HTML document lower-cases it: `[DATA-CARD]` selects
  // `data-card` in a browser, and a harness that parsed it and then missed would be answering
  // `null` where the real DOM answers a node.
  if (sigil === '[') return { kind: 'attribute', value: piece.slice(1, -1).toLowerCase() };
  if (sigil === '.') return { kind: 'class', value: piece.slice(1) };
  if (sigil === '#') return { kind: 'id', value: piece.slice(1) };
  return { kind: 'tag', value: piece.toLowerCase() };
}

function matchesPart(element: FakeElement, part: Part): boolean {
  if (part.kind === 'attribute') return element.hasAttribute(part.value);
  // A class and an id are compared exactly, as they are in a standards-mode document. A tag name
  // is not, because `tagName` is upper case in a real HTML document and lower case in every call
  // this harness sees, and a selector that worked in one and not the other would be its own trap.
  if (part.kind === 'class') return element.className.split(/\s+/).includes(part.value);
  if (part.kind === 'id') return element.id === part.value;
  return element.tagName.toLowerCase() === part.value;
}

function matchesCompound(element: FakeElement, compound: Compound): boolean {
  return compound.every((part) => matchesPart(element, part));
}

/** Right to left, as a descendant combinator resolves. */
function matches(element: FakeElement, sequence: Sequence): boolean {
  const last = sequence[sequence.length - 1];
  if (last === undefined || !matchesCompound(element, last)) return false;

  let index = sequence.length - 2;
  let ancestor = element.parentNode;
  while (index >= 0) {
    if (ancestor === null) return false;
    const compound = sequence[index];
    if (compound !== undefined && matchesCompound(ancestor, compound)) index -= 1;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function detach(node: FakeNode): void {
  const parent = node.parentNode;
  if (parent === null) return;
  const index = parent.childNodes.indexOf(node);
  if (index !== -1) parent.childNodes.splice(index, 1);
  node.parentNode = null;
}
