/**
 * Source-text detectors for the two structural contracts: `core` is pure, and `core/internal`
 * is reachable only through the seam.
 *
 * These are **tripwires against drift, not a sandbox.** They read source text with regular
 * expressions, so they can be walked around on purpose by anyone who wants to. What they
 * catch is the realistic failure — a future edit adding a convenient `readFileSync` or a
 * timestamp to `core` without anyone noticing until the board starts flickering.
 *
 * Two deliberate design choices, both erring the same way:
 *
 *   - **Non-literal module loading inside `core` fails closed.** A dynamic `import()` whose
 *     specifier is computed cannot be checked, so it is reported rather than waved through.
 *     `core` has no reason to load a module dynamically at all.
 *   - **Comments and string literals are scanned too.** Excluding them would need a real
 *     lexer, and the trade runs the wrong way: a false positive on prose is a loud failure
 *     that takes one edit to fix, while a false negative is silent and ships. Prose in
 *     `core` therefore avoids writing these tokens literally.
 *
 * They live here, outside `core`, and are exercised directly by `scan.test.ts` — a detector
 * that has never been shown to fail is not a check.
 */

/** How a module reference was written. `dynamic` is the only form that can be non-literal. */
export type ImportForm = 'static' | 'reexport' | 'side-effect' | 'dynamic' | 'require';

export interface ImportRef {
  /** The module specifier, or `null` when it was computed rather than written literally. */
  readonly specifier: string | null;
  readonly form: ImportForm;
}

const QUOTE = String.raw`['"\x60]`;
const SPECIFIER = String.raw`([^'"\x60]+)`;

const IMPORT_PATTERNS: readonly (readonly [RegExp, ImportForm])[] = [
  [new RegExp(String.raw`^[ \t]*import\s+(?!type[\s{])[\s\S]*?\bfrom\s*${QUOTE}${SPECIFIER}${QUOTE}`, 'gm'), 'static'],
  [new RegExp(String.raw`^[ \t]*export\s+(?!type[\s{*])[\s\S]*?\bfrom\s*${QUOTE}${SPECIFIER}${QUOTE}`, 'gm'), 'reexport'],
  [new RegExp(String.raw`^[ \t]*import\s*${QUOTE}${SPECIFIER}${QUOTE}`, 'gm'), 'side-effect'],
  [new RegExp(String.raw`\brequire\s*\(\s*${QUOTE}${SPECIFIER}${QUOTE}`, 'g'), 'require'],
];

const DYNAMIC_IMPORT_HEAD = /\bimport\s*\(/g;

/**
 * Reads a module out of the standard library that the seam must never touch. Matches the
 * bare and `node:`-prefixed spellings, and any submodule of either.
 *
 * `node:crypto` is deliberately absent: hashing is pure computation, and a card's
 * `contentSha` is half of an Annotation key.
 */
const OUTSIDE_WORLD =
  /^(node:)?(fs|http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster|repl|readline|inspector|v8|vm|os|process)(\/|$)/;

/**
 * Tokens that make a Snapshot depend on something other than its input. A board that
 * changes when nothing changed is a board nobody trusts.
 *
 * `randomUUID` and `getRandomValues` are here because they are reachable from the one
 * module `core` is allowed to import — permitting `node:crypto` for hashing must not
 * quietly permit a random source with it.
 */
const IMPURE_TOKENS: readonly (readonly [RegExp, string])[] = [
  [/\bDate\s*\./, 'reads the clock'],
  [/\bDate\s*\(/, 'reads the clock'],
  [/\bnew\s+Date\b/, 'reads the clock'],
  [/\bperformance\s*\.\s*now\b/, 'reads the clock'],
  [/\bhrtime\b/, 'reads the clock'],
  [/\bMath\s*\.\s*random\b/, 'reads a random source'],
  [/\brandomUUID\b/, 'reads a random source'],
  [/\bgetRandomValues\b/, 'reads a random source'],
  [/\brandomBytes\b/, 'reads a random source'],
  [/\bprocess\s*\.\s*\w/, 'reads ambient process state'],
];

/**
 * Every module reference in a file, at run time. `import type` and `export type` are erased
 * before anything executes and are deliberately not collected.
 */
export function importRefs(source: string): readonly ImportRef[] {
  const found: ImportRef[] = [];
  for (const [pattern, form] of IMPORT_PATTERNS) {
    const scanner = new RegExp(pattern.source, pattern.flags);
    let match = scanner.exec(source);
    while (match !== null) {
      found.push({ specifier: match[1] ?? null, form });
      match = scanner.exec(source);
    }
  }
  const dynamic = new RegExp(DYNAMIC_IMPORT_HEAD.source, DYNAMIC_IMPORT_HEAD.flags);
  let match = dynamic.exec(source);
  while (match !== null) {
    // A computed specifier reports as `null` rather than being skipped: unreadable is not
    // the same as absent, and treating it as absent is how a bypass gets in.
    found.push({ specifier: readDynamicSpecifier(source, match.index + match[0].length), form: 'dynamic' });
    match = dynamic.exec(source);
  }
  return found;
}

/**
 * The argument of a dynamic `import(` starting at `at`, or `null` when it is anything other
 * than one whole string literal.
 *
 * Reading only the leading literal is the trap this exists to avoid: `import('node:' + 'fs')`
 * would otherwise report the specifier `node:`, which matches no forbidden module and so
 * reads as clean.
 */
function readDynamicSpecifier(source: string, at: number): string | null {
  let i = at;
  while (i < source.length && /\s/.test(source[i] ?? '')) i += 1;
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  i += 1;
  let specifier = '';
  while (i < source.length && source[i] !== quote) {
    specifier += source[i];
    i += 1;
  }
  if (i >= source.length) return null;
  i += 1;
  while (i < source.length && /\s/.test(source[i] ?? '')) i += 1;
  // Only a closing paren or an options argument may follow. Anything else — an operator,
  // a template placeholder — means the specifier was computed.
  return source[i] === ')' || source[i] === ',' ? specifier : null;
}

/** `../core/./internal/x.ts` and `../core//internal/x.ts` are the same module as the plain form. */
export function normalizeSpecifier(specifier: string): string {
  const slashes = specifier.split('\\').join('/');
  let previous = '';
  let current = slashes;
  while (current !== previous) {
    previous = current;
    current = current.split('/./').join('/').split('//').join('/');
  }
  return current;
}

export function readsOutsideWorld(specifier: string): boolean {
  return OUTSIDE_WORLD.test(normalizeSpecifier(specifier).trim());
}

export function reachesInternal(specifier: string): boolean {
  return normalizeSpecifier(specifier).includes('core/internal/');
}

/** One entry per impurity found, each naming what it reads. Empty means clean. */
export function impurities(source: string): readonly string[] {
  const found: string[] = [];
  for (const [pattern, why] of IMPURE_TOKENS) {
    const hit = pattern.exec(source);
    if (hit !== null) found.push(`${hit[0]} — ${why}`);
  }
  return found;
}
