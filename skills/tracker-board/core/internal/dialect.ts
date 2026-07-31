/**
 * Dialect scoring and `unclassified`.
 *
 * Vocabulary here is `CONTEXT.md`'s — Ticket, Dialect, Lane, Criteria — and means what the
 * glossary says it means.
 *
 * Which field vocabulary a Ticket file speaks, decided by **scoring observed syntax**
 * rather than by reading a single discriminator.
 *
 * The old rule — two Dialects discriminated by the `Type:` field and a sibling `map.md` —
 * is refuted by a real file in which **both clauses fire in opposite directions**: a
 * `Type:` value that is none of the known types, no sibling `map.md`, task-vocabulary
 * status written in decision-style bare field syntax, two unknown fields, and a body
 * heading belonging to neither template. There are at least four field vocabularies in
 * the wild and one of them lands *inside* a file of another Dialect.
 *
 *   - Score from observed syntax: **bold versus bare field markers**, `## Question`
 *     versus `**What to build:**`, **checkboxes present or absent**.
 *   - `Type:` and a sibling `map.md` are **weak priors, never switches**.
 *   - A confident score yields `task` or `decision`; an ambiguous score yields
 *     `unclassified` — a first-class rendered state showing the file's raw fields and
 *     holding **no Lane**, so it can never be counted into the Frontier or into Done.
 *     Not a guess, and not a crash: a guess asserts a Lane the file does not support.
 *
 * ---------------------------------------------------------------------------
 * The thresholds, stated where a reader can find them
 * ---------------------------------------------------------------------------
 *
 * `score` is a signed confidence: **positive leans `task`, negative leans `decision`**, and
 * a magnitude **below 2** is what produces `unclassified`. Every weight below was chosen
 * against the committed corpus and the fixture set, and the margins are stated so a later
 * reader can see how much room each decision has.
 *
 *   - **Field markers, bold outnumbering bare: +2** (bare outnumbering bold: −2, equal or
 *     none: 0). The single most reliable signal — it separates every observed file with no
 *     overlap, task files carrying three or more bold markers and no bare ones, decision
 *     files the reverse.
 *   - **A `What to build:` field: +1.** The task template's opening field, present in every
 *     observed task file and absent from every decision file.
 *   - **A first body heading of `## Question`: −1.** Strong when present, but **absent from
 *     most decision files** — six of the ten corpus Tickets are decision Tickets and only
 *     one carries a `## ` heading at all — so its absence must mean nothing.
 *   - **Checkboxes present: +2. Checkboxes absent: −1.** Presence is near-conclusive: every
 *     observed task file has them and no observed decision file does. Absence is
 *     deliberately weaker, because a task Ticket can legitimately have none yet and a torn
 *     read has none either.
 *   - **`Type:` word: ±0.5, a weak prior and never a switch.** One observed file carries the
 *     **task** type word in decision syntax and must still read as `decision`; at this
 *     weight the prior cannot overturn the markers, and that file lands at −3.5.
 *   - **A sibling `map.md`: −0.5, present-only.** Its **absence scores nothing**, because
 *     "no map means task" is exactly the clause this design refutes.
 *   - **A first body heading belonging to neither template: magnitude −2.** Not a
 *     directional signal. A file whose section marker matches neither template is *less
 *     classifiable*, so this pulls the score toward zero rather than toward a Dialect.
 *
 * **Margins, measured across all 33 observed files rather than reasoned about.** Every
 * confident call lands at a magnitude of **3 or more**; the one ambiguous file lands at
 * **1**. Nothing at all falls between them, so the threshold of 2 sits in the middle of an
 * empty band a full point wide on each side. The narrowest confident calls are the two
 * decision Tickets that carry no section heading *and* the task type word, at −3.
 *
 * That gap is the number to watch when tuning against a repo nobody has seen yet: a file
 * arriving at |score| of 2 is not a near-miss, it is a shape none of the observed corpus
 * produces, and it should be looked at rather than absorbed by moving the threshold.
 *
 * **Which weights actually decide something, measured by changing each one and seeing
 * whether any observed file moves.** Four do: the **marker style**, the **checkbox-absence**
 * weight, the **unrecognised-heading penalty**, and the **`What to build:` field** — that
 * last one only for a task Ticket drafted before its criteria exist, which is the narrowest
 * task call the scheme makes. The threshold itself is load-bearing in both directions.
 *
 * The rest — the `## Question` weight, the checkbox-*presence* weight, the `Type:`
 * parenthetical strip, and treating a missing `map.md` as no evidence — are **redundant
 * against every file observed so far**: the signals that remain already separate those files
 * by more than the gap. They are kept because each is a rule stated in the spec or the
 * glossary, and because redundancy is what makes the margins wide, but a reader should know
 * that changing one of them alone will not show up in any test. That is a property of a
 * corpus where the two templates are cleanly written, not evidence the rules are idle — the
 * first genuinely mixed file that arrives is where they start carrying weight.
 *
 * **A file with no observable syntax at all** — no fields, no headings, no checkboxes —
 * scores `unparsed`, not `unclassified`. The two mean different things: `unclassified` is
 * "this file speaks a vocabulary I cannot place", which presumes there was something to
 * place, while `unparsed` is "there was nothing here to read". A file truncated mid-write is
 * the second, and calling it ambiguous would assert an observation never made.
 *
 * **What is deliberately not scored, and why:**
 *   - **The status vocabulary.** It is not partitioned by Dialect — an observed task Ticket
 *     carries the decision-lifecycle word `resolved` — so a status term is evidence of
 *     nothing here.
 *   - **The parsed field list.** Marker style is counted from the preamble **text**. A file
 *     with no `## ` heading has a preamble running to the end of the file, so ordinary prose
 *     containing a colon is carried as a field, and counting those would read prose as
 *     evidence.
 *   - **Unknown field names.** A file carrying a field belonging to neither template is not
 *     thereby ambiguous: an observed task file carries an `Origin:` field and is
 *     unambiguous. Only an unrecognised *section heading* moves the confidence.
 *
 * Fixture: `type-unknown-hybrid`. Plus: the ten corpus Tickets must classify as expected,
 * with no false `unclassified`.
 */

import { readDocumentView } from './fields.ts';
import type { Criteria, Dialect, RawField } from '../types.ts';

export interface DialectInput {
  /** The file text with any leading frontmatter block removed. Syntax is observed here. */
  readonly body: string;
  /** The field preamble region, for marker-style observation. */
  readonly preamble: string;
  /** Every field observed, including unknown ones. */
  readonly rawFields: readonly RawField[];
  readonly criteria: Criteria;
  /** Weak prior only. */
  readonly ticketType: string | null;
  /** Weak prior only — a sibling `map.md` in the same Feature. */
  readonly hasSiblingMap: boolean;
}

export interface DialectScore {
  readonly dialect: Dialect;
  /**
   * Signed confidence. Positive leans `task`, negative leans `decision`, and a magnitude
   * below the threshold is what produces `unclassified`.
   */
  readonly score: number;
}

/** Below this magnitude the observation is not confident enough to name a Dialect. */
const CONFIDENCE_THRESHOLD = 2;

const MARKER_STYLE = 2;
const TASK_FIELD = 1;
const DECISION_HEADING = 1;
const CHECKBOXES_PRESENT = 2;
const CHECKBOXES_ABSENT = 1;
const WEAK_PRIOR = 0.5;
const UNRECOGNISED_HEADING = 2;

/** A bold field marker at column 0: `**Name:**`. */
const BOLD_FIELD = /^\*\*([A-Za-z][A-Za-z0-9._ -]{0,39}):\*\*/;
/** A bare field marker at column 0: `Name:`. */
const BARE_FIELD = /^([A-Za-z][A-Za-z0-9._ -]{0,39}):/;

/** The task template's opening field, lower-cased. */
const TASK_FIELD_NAME = 'what to build';

/**
 * Section headings the templates actually use. `answer` and `comments` are shared ground —
 * conversation appends below either Dialect — so they are recognised without being evidence
 * for one.
 */
const DECISION_SECTION = 'question';
const SHARED_SECTIONS: readonly string[] = ['answer', 'comments'];

/**
 * The four known `Type:` words, observed in the corpus rather than invented: `task` belongs
 * to the task template and the other three to the decision template. A value matching none
 * of them — a hybrid like `research + implement` — is a prior of zero rather than a guess.
 */
const TASK_TYPES: readonly string[] = ['task'];
const DECISION_TYPES: readonly string[] = ['grilling', 'research', 'prototype'];

/**
 * Score a file's Dialect from its observed syntax. Never throws: an input missing anything
 * it declares scores as though that signal were simply not observed, which is what an
 * unreadable file is.
 */
export function scoreDialect(input: DialectInput): DialectScore {
  // Observed through the field scan's own reader rather than off raw text, so that a field
  // line inside a fenced example or a comment is not mistaken for a live one, and so that
  // every line terminator is already resolved.
  const view = readDocumentView(readText(input?.body));
  const markers = countMarkers(view.preambleLines);
  const heading = recognisedHeading(view.headings);
  const total = readCount(input?.criteria?.total);

  // Nothing was observed at all. That is not ambiguity between two vocabularies, it is the
  // absence of a document — and calling it ambiguous would assert an observation never made.
  if (markers.bold === 0 && markers.bare === 0 && view.headings.length === 0 && total === 0) {
    return { dialect: 'unparsed', score: 0 };
  }

  let syntax = 0;
  if (markers.bold > markers.bare) syntax += MARKER_STYLE;
  else if (markers.bare > markers.bold) syntax -= MARKER_STYLE;

  if (markers.hasTaskField) syntax += TASK_FIELD;
  if (heading === DECISION_SECTION) syntax -= DECISION_HEADING;

  syntax += total > 0 ? CHECKBOXES_PRESENT : -CHECKBOXES_ABSENT;

  // Section headings, and **none of them** belonging to either template. A file whose
  // sections match neither is less classifiable rather than more one thing than the other,
  // so this pulls the magnitude toward zero — never past it, which would flip the sign and
  // assert the opposite Dialect. Recognising *any* heading is enough: a document that opens
  // with `## Context` before its `## Question` still carries the decision template's marker.
  if (heading === null && view.headings.length > 0) {
    syntax = towardZero(syntax, UNRECOGNISED_HEADING);
  }

  // Priors are consulted **only when the syntax alone is not conclusive**. That is what makes
  // "weak prior, never a switch" true rather than merely intended: a confident reading cannot
  // be demoted to `unclassified` by a sibling file appearing next to it, and cannot be
  // promoted or inverted by a `Type:` word either.
  if (Math.abs(syntax) >= CONFIDENCE_THRESHOLD) {
    return { dialect: syntax > 0 ? 'task' : 'decision', score: syntax };
  }

  let score = syntax + typePrior(input?.ticketType);
  if (input?.hasSiblingMap === true) score -= WEAK_PRIOR;

  if (Math.abs(score) < CONFIDENCE_THRESHOLD) return { dialect: 'unclassified', score };
  return { dialect: score > 0 ? 'task' : 'decision', score };
}

interface MarkerCount {
  readonly bold: number;
  readonly bare: number;
  /** Whether the task template's opening field is among them. */
  readonly hasTaskField: boolean;
}

/**
 * Count field markers by style over the preamble's **column-0** lines.
 *
 * The lines arrive already stripped of commented regions and fenced code blocks, so a
 * `Status:` line shown as an example in a fence or quoted in a comment is not counted as a
 * live field. That distinction is not cosmetic: a Ticket file explaining its own markup
 * contains exactly such samples, and counting them either invents a Dialect for a document
 * that has no fields at all or drags a correctly-classified one into `unclassified`.
 */
function countMarkers(lines: readonly string[]): MarkerCount {
  let bold = 0;
  let bare = 0;
  let hasTaskField = false;

  for (const line of lines) {
    const boldMatch = BOLD_FIELD.exec(line);
    if (boldMatch !== null) {
      bold += 1;
      if (nameOf(boldMatch[1]) === TASK_FIELD_NAME) hasTaskField = true;
      continue;
    }
    const bareMatch = BARE_FIELD.exec(line);
    if (bareMatch !== null) {
      bare += 1;
      if (nameOf(bareMatch[1]) === TASK_FIELD_NAME) hasTaskField = true;
    }
  }

  return { bold, bare, hasTaskField };
}

/**
 * The leading word of the first section heading either template recognises, lower-cased, or
 * `null` when the file has none — either because it has no headings at all, or because none
 * of the ones it has belongs to a template.
 *
 * Scanning all of them rather than only the first is what lets a decision Ticket open with
 * `## Context` and still be read by its `## Question` further down. Taking only the first
 * heading treats an ordinary organisational section as evidence the file matches neither
 * template, which is the opposite of what it means.
 */
function recognisedHeading(headings: readonly string[]): string | null {
  for (const heading of headings) {
    // Real headings carry trailing prose, dates and parentheticals, so read the leading word
    // and never match the whole line.
    const word = (heading.trim().split(/[^A-Za-z]/)[0] ?? '').toLowerCase();
    if (word === DECISION_SECTION || SHARED_SECTIONS.includes(word)) return word;
  }
  return null;
}

/**
 * The `Type:` prior. A trailing parenthetical is where the HITL and AFK markers live, so it
 * is removed before the word is read — `task (HITL — …)` is the type word `task`.
 */
function typePrior(ticketType: string | null | undefined): number {
  if (typeof ticketType !== 'string') return 0;
  const word = ticketType.replace(/\(.*$/, '').trim().toLowerCase();
  if (word.length === 0) return 0;
  if (TASK_TYPES.includes(word)) return WEAK_PRIOR;
  if (DECISION_TYPES.includes(word)) return -WEAK_PRIOR;
  return 0;
}

/** Reduce a magnitude by `amount`, stopping at zero rather than crossing it. */
function towardZero(score: number, amount: number): number {
  if (score > 0) return Math.max(0, score - amount);
  if (score < 0) return Math.min(0, score + amount);
  return 0;
}

function nameOf(captured: string | undefined): string {
  return (captured ?? '').trim().toLowerCase();
}

// Type stripping erases and does not check, so nothing below trusts a declared type.

function readText(value: string | undefined | null): string {
  return typeof value === 'string' ? value : '';
}

function readCount(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
