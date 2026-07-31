/**
 * The two Dialect ladders and the Lane ordering.
 *
 * Pure and total: the same Extraction always yields the same Lane, and every Ticket gets
 * one. Nothing here reads a clock, a file or a random source, because a board that
 * changes when nothing changed is a board nobody trusts.
 *
 * Two rules in this ladder were written independently and **collided on real data**.
 * "Checkboxes decide progress" filed a Ticket with 5 of 5 boxes checked under Done —
 * collapsed and invisible — while it had been waiting on a human for a week.
 * `ready-for-human` is a **Lane assignment, orthogonal to progress**, and it must be
 * tested **before** completeness. That ordering is the whole rule.
 *
 * ```
 * task Ticket (dialect A):
 *   parked      → Status prefix ∈ {wontfix, closed}          ← veto, checked first
 *   unparsed    → no title, or no criteria
 *   done        → criteria.length > 0 && all checked
 *   in-progress → some checked
 *   blocked     → 0 checked && (any blocker not done || externalBlocker present)
 *   ready       → 0 checked && all blockers done             ← the Frontier
 *
 * decision Ticket (dialect B):
 *   done        → Status prefix "resolved"
 *   in-progress → Status prefix "claimed"
 *   blocked     → any blocker not resolved || externalBlocker present
 *   ready       → (Status prefix "open" || Status absent) && all blockers resolved
 *   unparsed    → Status present but unrecognised
 * ```
 *
 * **Lane ordering, first match wins:**
 *
 * ```
 * parked → ready-for-human → complete → blocked → claimed → HITL-in-Type → agent
 * ```
 *
 * `ready-for-human` is tested **before** completeness — that is what rescues a
 * 5/5-checked Ticket from collapsing into Done while it waits on a person, and it is why
 * `done-awaiting-human` exists as a state. It also routes a Ticket that is *not* finished:
 * the Status is a Lane assignment regardless of checkbox state, so a 0/5 Ticket in that
 * Status is in the human Lane too, carrying its ratio so it reads as unstarted-and-waiting
 * rather than as merely unstarted. HITL is tested **after** claimed, so a claimed HITL
 * Ticket stays In progress rather than being dragged into Needs you.
 *
 * On a **task** Ticket `Status:` may only **park** — never promote to ready or done. That
 * asymmetry is what makes a stale `ready-for-agent` harmless, and it is visible in the
 * corpus: two task Tickets carry `done` and `resolved` prefixes and reach Done through
 * their **criteria**, not through their Status. Nothing here reads the prefix except for
 * the two parking values and the human-Lane assignment. On a **decision** Ticket `Status:`
 * **is** live state.
 *
 * `unparsed` and `unclassified` take **no** Lane — that is what keeps a card the parser
 * could not place out of the Frontier and out of Done, rather than guessing a column for
 * it. The two are kept apart because nothing-observable and observed-but-unplaceable are
 * different answers.
 *
 * Two readings the written ladders leave implicit, both resolved against the status reader
 * rather than assumed, and both asserted:
 *
 *   - **An absent `Status:` arrives already carrying the prefix `open`**, so the decision
 *     ladder's "prefix open **or** Status absent" is one check, not two. Carrying the
 *     second half as well would be a branch no input can reach.
 *   - **A prefix of `null` only ever occurs on a Status that is present**, so "present but
 *     unrecognised" is likewise one check. A present-but-empty `Status:` — what a torn read
 *     of `Status: done` looks like mid-write — lands there and reads as `unparsed` for one
 *     scan, resolving itself on the next write rather than promoting half-written work.
 *
 * **Parking is a veto on both Dialects.** The decision ladder above does not list it, but
 * parking is defined as a veto evaluated before every other rule, and it opens the Lane
 * ordering for every card. A decision Ticket marked `closed` is parked for the same reason
 * a task Ticket is.
 *
 * **A blocker is satisfied only by `done`.** A dangling reference, an `unparsed` or
 * `unclassified` blocker, and a blocker that is itself blocked all fail that test, so a
 * typo or a deleted file keeps work off the Frontier instead of promoting it. So does
 * `done-awaiting-human`: that work is finished but not yet off anyone's desk, and treating
 * it as clearing a dependency would offer an agent work whose predecessor is still waiting
 * on a person. No observed Ticket depends on one, so this is the safe reading of an
 * unobserved case rather than a measured rule.
 */

import type { Criteria, Extraction, Lane, TicketState } from '../types.ts';

/**
 * The derived state of one blocker a Ticket names, or `null` when the number resolves to
 * no Ticket in the Feature.
 *
 * `null` is not "unknown, assume fine". A dangling blocker reference **blocks**: a number
 * with no matching Ticket is not-done, therefore blocking, so a typo or a deleted file
 * fails safe rather than promoting work onto the Frontier.
 */
export type BlockerState = TicketState | null;

/** The two parking values. A veto on both Dialects, evaluated before every other rule. */
const PARKED_PREFIXES: readonly string[] = ['wontfix', 'closed'];

/** A Lane assignment carried by the Status field, orthogonal to progress. */
const HUMAN_PREFIX = 'ready-for-human';

/** The only blocker state that clears a dependency. */
const SATISFIED = 'done';

export function deriveState(
  extraction: Extraction,
  blockerStates: readonly BlockerState[],
): TicketState {
  const dialect = extraction?.dialect;
  // A card the parser could not place takes no Lane, so it needs a state that holds none.
  if (dialect === 'unparsed') return 'unparsed';
  if (dialect === 'unclassified') return 'unclassified';

  const prefix = readPrefix(extraction);
  if (prefix !== null && PARKED_PREFIXES.includes(prefix)) return 'parked';

  if (dialect === 'decision') return decisionState(extraction, blockerStates, prefix);
  if (dialect === 'task') return taskState(extraction, blockerStates, prefix);
  // A Dialect outside the four is not a Ticket the ladder can place.
  return 'unparsed';
}

/** Checkboxes are truth here, and `Status:` may only park. */
function taskState(
  extraction: Extraction,
  blockerStates: readonly BlockerState[],
  prefix: string | null,
): TicketState {
  const criteria = readCriteria(extraction);
  const title = typeof extraction?.title === 'string' ? extraction.title : '';
  if (title.length === 0 || criteria.total === 0) return 'unparsed';

  if (criteria.checked >= criteria.total) {
    // Completeness alone would file this under Done, where it collapses and disappears.
    // The Status says a person still has to sign it off, and that outranks being finished.
    return prefix === HUMAN_PREFIX ? 'done-awaiting-human' : 'done';
  }
  if (criteria.checked > 0) return 'in-progress';
  return isBlocked(extraction, blockerStates) ? 'blocked' : 'ready';
}

/** `Status:` is live state here, and checkboxes are usually absent entirely. */
function decisionState(
  extraction: Extraction,
  blockerStates: readonly BlockerState[],
  prefix: string | null,
): TicketState {
  // Present but **unrecognised** — which is a null prefix, and nothing else. A torn read of
  // a half-written `Status:` lands here and resolves itself on the next write.
  //
  // Read as "not one of the three lifecycle values" instead, this rung swallows six of the
  // eleven statuses the vocabulary knows: a decision Ticket marked `ready-for-human`,
  // `ready-for-agent`, `needs-triage`, `needs-info`, `ready-for-afk` or `done` becomes
  // stateless, takes no Lane, and **vanishes from the board entirely** — no column, absent
  // from the Frontier and from Done, counted nowhere. The `ready-for-human` case is the
  // worst of them: work explicitly waiting on a person, hidden. `unparsed` means the parser
  // could not read the value, never that the value is outside a subset chosen here.
  if (prefix === null) return 'unparsed';

  if (prefix === 'resolved') return 'done';
  // Claimed outranks blocked: someone is holding this, which is a truer thing to say about
  // it than the fact that something upstream is unfinished.
  if (prefix === 'claimed') return 'in-progress';
  if (isBlocked(extraction, blockerStates)) return 'blocked';
  // Every other readable Status leaves the Ticket at its default readiness and lets the Lane
  // ordering decide the column — which is how `ready-for-human` reaches the human Lane on
  // this Dialect as well as on the other one.
  return 'ready';
}

export function deriveLane(extraction: Extraction, state: TicketState): Lane | null {
  if (state === 'unparsed' || state === 'unclassified') return null;

  if (state === 'parked') return 'parked';
  if (readPrefix(extraction) === HUMAN_PREFIX) return 'needs-you';
  // `done-awaiting-human` belongs here too: the work *is* complete, which is precisely why
  // the rung above has to be tested first. Excluding it would move the ordering rule out of
  // this list and into the state ladder, leaving the order here true but unenforced — and
  // an ordering nothing depends on is an ordering the next edit can quietly invert.
  if (state === 'done' || state === 'done-awaiting-human') return 'complete';
  // `frozen` keeps its own Lane rather than folding into `blocked`. The two share a column
  // as labelled sub-lanes, but they are opposite instructions to a reader — queued behind an
  // agent versus nothing happens until you act — and collapsing them here would throw that
  // away before the renderer ever saw it. The ladder cannot produce `frozen`; the graph walk
  // promotes a blocked Ticket into it once every one of its blocker chains ends at a person.
  if (state === 'frozen') return 'frozen';
  if (state === 'blocked') return 'blocked';
  if (state === 'in-progress') return 'in-progress';
  // Last, so a claimed Ticket that also needs a human stays In progress. `HITL` and `AFK`
  // are read from the `Type:` field only, never from prose or a status qualifier.
  if (extraction?.hitl === true) return 'needs-you';
  return 'agent';
}

/**
 * Whether anything stops this Ticket starting now.
 *
 * The presence of an external blocker alone is enough: a Ticket waiting on something that
 * is not a Ticket cannot be started, and reporting it ready would offer an agent work that
 * is physically impossible.
 */
function isBlocked(extraction: Extraction, blockerStates: readonly BlockerState[]): boolean {
  const external = extraction?.externalBlocker;
  if (typeof external === 'string' && external.trim().length > 0) return true;

  // Annotated, because `Array.isArray` narrows to `any[]` and would otherwise widen every
  // blocker to `any` — silently removing the type check from the one comparison in this
  // module that decides whether a dependency is cleared.
  const states: readonly BlockerState[] = Array.isArray(blockerStates) ? blockerStates : [];
  const named = Array.isArray(extraction?.blockedBy) ? extraction.blockedBy.length : 0;
  // Fewer resolutions than the line named means at least one reference went unaccounted
  // for. Unaccounted-for is not the same as satisfied, and reading it as satisfied would
  // promote work whose dependency nobody looked up.
  if (states.length < named) return true;

  return states.some((blocker) => blocker !== SATISFIED);
}

function readPrefix(extraction: Extraction): string | null {
  const prefix = extraction?.statusPrefix;
  return typeof prefix === 'string' ? prefix : null;
}

function readCriteria(extraction: Extraction): { readonly checked: number; readonly total: number } {
  const criteria: Criteria | undefined = extraction?.criteria;
  return { checked: readCount(criteria?.checked), total: readCount(criteria?.total) };
}

function readCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
