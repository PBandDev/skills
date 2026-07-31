/**
 * Blocker resolution, the Frozen walk, and the Frontier.
 *
 * Two unstartable Tickets can look identical and mean opposite things. **Blocked** has at
 * least one chain an agent could still advance. **Frozen on you** has **every** chain
 * terminating at a human-gated Ticket — nothing will happen until the user acts. Folding
 * them together gives the reader opposite instructions.
 *
 * Rules the ladder does not state:
 *   - **Blocker numbers resolve within their Feature only.** Features are Root-local and
 *     numbers are Feature-local, so the graph never crosses a Feature or a Root boundary.
 *     Nothing here enforces that — it is structural. Both passes are called once per
 *     Feature, so a Ticket in another Feature is not in `tickets` and cannot be reached.
 *   - **A dangling blocker reference blocks.** A number with no matching Ticket is
 *     not-done, therefore blocking. Failing safe keeps a typo or a deleted file off the
 *     Frontier.
 *   - **A blocker that is `unparsed` or `unclassified` blocks**, for the same reason — and
 *     cannot be human-terminal, because it holds no Lane. Chains through it stay ordinary
 *     Blocked.
 *   - **The Frozen walk is cycle-safe.** Walk each blocked Ticket's chain with a visited
 *     set; a cycle terminates at nothing, so a cycle is ordinary Blocked and never an
 *     infinite loop.
 *   - A Ticket is Frozen only when **every** path terminates at a human-gated Ticket.
 *     Mixed chains stay ordinary Blocked — an agent can still make progress.
 *   - A Frozen Ticket **names its terminal human Ticket by id**.
 *
 * Three readings the written rules leave implicit, each resolved in the direction that
 * refuses to promote work:
 *
 *   - **A satisfied blocker is not a path.** The walk considers only blockers that are not
 *     `done`. Requiring a finished blocker to also be human-terminal would make Frozen
 *     unreachable for any Ticket that has ever had a completed dependency, which is most
 *     of them.
 *   - **Zero live paths is not "every path".** A Ticket the ladder blocked while naming no
 *     unsatisfied Ticket blocker is held by something that is not a Ticket — an external
 *     blocker. "Every path terminates at a human" is vacuously true over an empty set, and
 *     taking that vacuous truth would freeze a Ticket waiting on a contract, naming no
 *     Ticket to go and do.
 *
 *     **An external blocker anywhere on a path also ends it**, not only when it is the sole
 *     cause. A Ticket blocked by *both* a human-gated Ticket and an external blocker is not
 *     Frozen: finishing the human would leave it exactly as blocked, so naming that human
 *     would be a false instruction rather than merely a vague one. This is why
 *     {@link ChainTicket} carries `externalBlocker` at all — it cannot be inferred, because
 *     the numbered blocker on its own already accounts for the `blocked` state.
 *   - **A number that names two Tickets names neither.** Feature-local numbers are meant to
 *     be unique; two files claiming one number make the reference ambiguous. An ambiguous
 *     reference is treated exactly like a dangling one — it blocks, and it is never
 *     human-terminal — so an authoring mistake surfaces instead of resolving to whichever
 *     file happened to sort first.
 *
 * The corpus is the only thing that can catch a bug here. Fictional dependency edges can
 * leave **every Lane unchanged** when all affected Tickets are already finished, because
 * blockers gate only incomplete work. The board can look perfect while the graph is fiction.
 */

import type { Extraction, Lane, TicketState } from '../types.ts';
import { deriveState } from './derive.ts';
import type { BlockerState } from './derive.ts';

/** The Lane that means a person — and only a person — can clear a Ticket. */
const HUMAN_LANE: Lane = 'needs-you';

/** The Lane the ladder places an unstartable Ticket in, before this pass runs. */
const BLOCKED_LANE: Lane = 'blocked';

/**
 * The Frontier **is** the Agent Lane, not a second condition that happens to agree with it.
 * The board calls the Frontier out as its own column, and that column is "Agent can take" —
 * so membership is read off the Lane rather than recomputed from state and `hitl`, which
 * would be a second definition free to drift from the first. A `ready` Ticket whose `Type:`
 * carries HITL is in the human Lane and is deliberately **not** on the Frontier: its
 * blockers are all resolved and an agent still cannot take it.
 */
const FRONTIER_LANE: Lane = 'agent';

/** The one blocker state that clears a dependency (`derive.ts`). */
const SATISFIED: TicketState = 'done';

/** The state the ladder hands this pass for a Ticket it could not start. */
const BLOCKED: TicketState = 'blocked';

/** What a promoted Ticket becomes. The ladder cannot produce it; only this pass can. */
const FROZEN: TicketState = 'frozen';
const FROZEN_LANE: Lane = 'frozen';

export interface GraphTicket {
  readonly id: string;
  /** Feature-local Ticket number, or `null` when the filename carries none. */
  readonly number: number | null;
  readonly blockedBy: readonly number[];
  /**
   * The Ticket's own Extraction, **after any Override has been applied** — this pass runs
   * the ladder itself, so it must see the same corrected fields the card will (ADR-0001).
   */
  readonly extraction: Extraction;
}

export interface BlockerResolution {
  /**
   * One entry per number in `blockedBy`, in order. `null` means the number dangles.
   *
   * Post-ladder, **pre-chain**: a blocker later promoted to `frozen` appears here as
   * `blocked`. See {@link resolveBlockers} — the guarantee is satisfaction equivalence, not
   * literal equality with the card the board finally renders.
   */
  readonly blockerStates: readonly BlockerState[];
  /** The subset of `blockedBy` that resolves to no Ticket in the Feature. */
  readonly dangling: readonly number[];
}

/**
 * First graph pass, run **before** `derive.deriveState` — it supplies that function's
 * `blockerStates` argument. Keyed by Ticket id; every Ticket in `tickets` gets an entry.
 *
 * It resolves each number to a Ticket in the Feature and reports **that Ticket's state**,
 * which is what lets a finished dependency actually clear. Reporting something conservative
 * instead would keep every Ticket with any blocker permanently Blocked and leave the
 * Frontier — the board's reason to exist — structurally unreachable on a real tree.
 *
 * ## Why this needs no fixpoint, no recursion and no traversal
 *
 * It looks circular: a Ticket's state depends on its blockers' states, and a cycle would
 * then have no defined answer. It is not circular, because of where `blockerStates` is read.
 * The ladders are
 *
 * ```
 * task:     parked → unparsed → done → in-progress → (blocked | ready)
 * decision: unparsed → done → in-progress → (blocked | ready)
 * ```
 *
 * and `blockerStates` is consulted in **exactly one place**, `isBlocked`, on the final rung.
 * Every rung that can return `done` sits above it and reads only criteria or the Status
 * prefix — and `done` is the **only** state that clears a dependency. So whether a Ticket
 * satisfies a dependency is a pure function of its own Extraction: it cannot depend on that
 * Ticket's own blockers, and cannot change under iteration.
 *
 * That collapses the problem into two ordinary passes:
 *
 *   1. `solo` — run the ladder with an **empty** blocker list. `isBlocked` then reports true
 *      for anything naming a blocker at all (`states.length < named`), so `solo` says
 *      `blocked` wherever the truth is blocked-or-ready, and is **exact** on every rung above
 *      that. Which is all that is needed: `solo(B) === 'done'` exactly when `B` is done.
 *   2. `settled` — run the ladder again with each blocker's `solo` value. Because the ladder
 *      only ever asks the `done` question, this **is** the Ticket's true final state.
 *
 * Nothing here walks an edge, so there is no entry point, no stack and no order to depend on:
 * a Ticket in a dependency cycle simply gets two ordinary states. The cycle guard in
 * {@link resolveChains}'s Frozen walk is a genuinely separate mechanism solving a different
 * problem, and neither substitutes for the other.
 *
 * ## What the reported state is, precisely
 *
 * Each blocker's **post-ladder, pre-chain** state, and the contract it keeps is **satisfaction
 * equivalence**: a blocker is quoted `done` exactly when it is done, and as some non-`done`
 * state otherwise. That is the whole of what `isBlocked` asks, so it is the whole that can
 * honestly be promised.
 *
 * It is deliberately **not** literal equality with the state the board finally shows, and the
 * difference is reachable rather than theoretical. This pass runs before {@link resolveChains},
 * so a Ticket that the chain walk later promotes from `blocked` to `frozen` has already been
 * quoted to its dependants as `blocked`. Three Tickets show it: `01` in the human Lane, `02`
 * blocked by `01`, `03` blocked by `02` — the board renders `02` Frozen, and `03` was told
 * `blocked`. Nothing downstream is wrong, because `frozen` is a labelled refinement of
 * `blocked` and both are non-`done`; and the ordering cannot be undone, because the chain pass
 * needs the ladder to have run and the ladder needs these values. Reporting post-chain states
 * would take a third pass that no caller reads.
 *
 * `settled` rather than `solo` is still what gets reported, and that part earns its keep:
 * `core/index.ts` recomputes each card as `deriveState(extraction, blockerStates)`, so quoting
 * `settled` means a genuinely `ready` blocker is quoted `ready` instead of `blocked`. The
 * ladder cannot tell those apart — but anything else reading this map can, and a value that is
 * true costs nothing over one that merely behaves the same.
 *
 * **The one assumption, stated so it can be checked:** all of this is exact only while no rung
 * above `isBlocked` consults `blockerStates`. That is one edit to `derive.ts` away, so it is
 * asserted from the outside rather than trusted — see the blocker-independence matrix in
 * `test/graph.test.ts`, which derives each shape with its blocker finished and again with it
 * absent and requires done-ness to be identical.
 */
export function resolveBlockers(
  tickets: readonly GraphTicket[],
): ReadonlyMap<string, BlockerResolution> {
  const byNumber = indexByNumber(tickets);

  // Pass 1. Exact wherever it matters — see the header.
  const solo = new Map<string, TicketState>();
  for (const ticket of tickets) solo.set(ticket.id, deriveState(ticket.extraction, []));

  // Pass 2. The true state of every Ticket, blockers accounted for.
  const settled = new Map<string, TicketState>();
  for (const ticket of tickets) {
    settled.set(ticket.id, deriveState(ticket.extraction, statesOf(ticket, byNumber, solo)));
  }

  const out = new Map<string, BlockerResolution>();
  for (const ticket of tickets) {
    const dangling: number[] = [];
    for (const number of ticket.blockedBy) {
      const target = byNumber.get(number);
      if (target === undefined || target === null) dangling.push(number);
    }
    out.set(ticket.id, { blockerStates: statesOf(ticket, byNumber, settled), dangling });
  }
  return out;
}

/**
 * One entry per named blocker, in order, read out of `states`.
 *
 * `undefined` from the index is a number no file claims; `null` is a number two files claim.
 * Neither identifies a Ticket, and a reference that identifies no Ticket blocks — so both
 * report `null`, which `derive.ts` reads as "dangles, therefore not done, therefore blocking".
 */
function statesOf(
  ticket: GraphTicket,
  byNumber: NumberIndex<GraphTicket>,
  states: ReadonlyMap<string, TicketState>,
): readonly BlockerState[] {
  const out: BlockerState[] = [];
  for (const number of ticket.blockedBy) {
    const target = byNumber.get(number);
    out.push(target === undefined || target === null ? null : (states.get(target.id) ?? null));
  }
  return out;
}

export interface ChainTicket {
  readonly id: string;
  readonly number: number | null;
  readonly blockedBy: readonly number[];
  /** The Ticket's state after the ladder has run. */
  readonly state: TicketState;
  /** The Ticket's Lane after the ordering has run. `null` for `unparsed`/`unclassified`. */
  readonly lane: Lane | null;
  /**
   * The unmatched remainder of the Ticket's `Blocked by:` line — something it waits on that
   * is not a Ticket. Carried **here and not on {@link GraphTicket}**: the first pass runs the
   * ladder, and `derive.isBlocked` already reads this straight off the Extraction. This pass
   * never sees an Extraction, which is the only reason it needs its own copy.
   */
  readonly externalBlocker: string | null;
}

export interface ChainResult {
  /** Possibly promoted from `blocked` to `frozen`. Otherwise the input Lane, unchanged. */
  readonly lane: Lane | null;
  /** Possibly promoted from `blocked` to `frozen`. Otherwise the input state, unchanged. */
  readonly state: TicketState;
  /** Id of the terminal human-gated Ticket on a Frozen card. `null` otherwise. */
  readonly frozenOn: string | null;
  readonly onFrontier: boolean;
}

/**
 * Second graph pass, run **after** the ladder and the Lane ordering. Promotes `blocked` to
 * `frozen` where every chain terminates at a human, names the terminal Ticket, and marks
 * Frontier membership. Keyed by Ticket id; every Ticket in `tickets` gets an entry.
 *
 * Unlike the first pass this one has every Ticket's state and Lane, so it walks real edges.
 */
export function resolveChains(
  tickets: readonly ChainTicket[],
): ReadonlyMap<string, ChainResult> {
  const byNumber = indexByNumber(tickets);

  const out = new Map<string, ChainResult>();
  for (const ticket of tickets) {
    const frozenOn = freezeTarget(ticket, byNumber);
    const frozen = frozenOn !== null;
    const lane = frozen ? FROZEN_LANE : ticket.lane;
    const state = frozen ? FROZEN : ticket.state;
    out.set(ticket.id, { lane, state, frozenOn, onFrontier: lane === FRONTIER_LANE });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Frozen walk
// ---------------------------------------------------------------------------

/** A Ticket found by number, `null` when the number is ambiguous, `undefined` when unknown. */
type NumberIndex<T> = ReadonlyMap<number, T | null>;

/**
 * The state one Frozen walk carries.
 *
 * `onPath` is the cycle guard and holds only the ids on the **current** path — a Ticket is
 * removed again as the walk unwinds, so a diamond is re-entered rather than refused.
 *
 * That re-entry is correct and, on its own, exponential: a Feature where many Tickets share
 * many blockers has exponentially many paths through it, and a walk in which every path
 * terminates at a person never short-circuits, so it explores all of them. Measured on a
 * Feature where each Ticket is blocked by every Ticket below it: 16 ms at 18 Tickets, 229 ms
 * at 22, 961 ms at 24 — roughly four times the work for every two Tickets added. At around
 * 34 it stops returning in any useful time. The seam is called synchronously from the
 * watcher on every file change, so that is not a slow board, it is a board that stops
 * updating and says nothing.
 *
 * `memo` fixes it without weakening the rule. A result may only be reused if **no cycle
 * influenced it**: whether a chain terminates can depend on where the walk entered it, but
 * only when something looped back into the path above. `sawCycle` reports whether the
 * subtree just walked reached back into `onPath`, and a result carrying that taint is
 * recomputed rather than cached. Everything else is entry-independent and safe to keep.
 */
interface Walk {
  readonly onPath: Set<string>;
  readonly memo: Map<string, string | null>;
  sawCycle: boolean;
}

/**
 * The id of the human-gated Ticket this Ticket is frozen on, or `null` when it is not
 * Frozen.
 *
 * Candidacy is read off the **Lane**, not the state. Those agree on every Ticket the ladder
 * can produce, and testing the Lane is what makes the disagreement that matters come out
 * right: a Ticket that is `blocked` and sits in the human Lane already — `Status:
 * ready-for-human` with unmet blockers — keeps that Lane. The ordering put it there
 * deliberately, and promoting it to Frozen would replace a specific answer with a vaguer one
 * and leave the card frozen on itself.
 */
function freezeTarget(ticket: ChainTicket, byNumber: NumberIndex<ChainTicket>): string | null {
  if (ticket.lane !== BLOCKED_LANE) return null;
  return humanEndOf(ticket, byNumber, { onPath: new Set<string>(), memo: new Map(), sawCycle: false });
}

/**
 * The id of the human-gated Ticket that **every** live path through `ticket` terminates at,
 * or `null` when any path does not.
 *
 * See {@link Walk} for the cycle guard and for why a result is only sometimes reusable.
 */
function humanEndOf(
  ticket: ChainTicket,
  byNumber: NumberIndex<ChainTicket>,
  walk: Walk,
): string | null {
  // Re-entering a Ticket already on this path is a cycle. A cycle terminates at nothing, so
  // the path fails and the walk unwinds — it never revisits and never loops. The flag is what
  // stops the result being cached: it is the one answer that depends on the way in.
  if (walk.onPath.has(ticket.id)) {
    walk.sawCycle = true;
    return null;
  }
  // The walk stops at a person. Tested before anything else, so a Ticket that is itself
  // blocked *and* in the human Lane still terminates the chain: a person owns it either way.
  if (ticket.lane === HUMAN_LANE) return ticket.id;
  // Anything else that is not blocked ends the path at a non-human: `ready` and
  // `in-progress` are agent-advanceable, `done` and `parked` are settled, and a Ticket
  // holding no Lane at all (`unparsed`, `unclassified`) cannot be human-terminal because
  // there is no Lane on it to be human.
  if (ticket.state !== BLOCKED) return null;
  // Held by something that is not a Ticket. Finishing every human on this path would leave it
  // exactly as blocked, so the path does not terminate at a person — and a Frozen card naming
  // a Ticket whose completion changes nothing is a false instruction, which is worse than an
  // unhelpful one. Tested after the human Lane above, so a Ticket a person already owns still
  // ends the chain: the external blocker is theirs to clear too.
  if (hasExternalBlocker(ticket)) return null;

  // A cached entry is legitimately `null` when the chain does not terminate at a person, so
  // absence has to be `undefined` and nothing else — `??` here would recompute every miss.
  const cached = walk.memo.get(ticket.id);
  if (cached !== undefined) return cached;

  walk.onPath.add(ticket.id);
  // Saved and restored, so that "did *this* subtree touch a cycle" stays separable from
  // whatever a sibling branch already found.
  const outer = walk.sawCycle;
  walk.sawCycle = false;
  const found = walkBlockers(ticket, byNumber, walk);
  const tainted = walk.sawCycle;
  walk.sawCycle = outer || tainted;
  walk.onPath.delete(ticket.id);

  if (!tainted) walk.memo.set(ticket.id, found);
  return found;
}

function walkBlockers(
  ticket: ChainTicket,
  byNumber: NumberIndex<ChainTicket>,
  walk: Walk,
): string | null {
  let first: string | null = null;
  for (const target of liveBlockersOf(ticket, byNumber)) {
    // A dangling or ambiguous reference terminates at nothing.
    if (target === null) return null;
    const found = humanEndOf(target, byNumber, walk);
    // One path an agent could still advance is enough to keep the whole Ticket Blocked.
    if (found === null) return null;
    if (first === null) first = found;
  }
  // Every path terminated at a person. Several may name different people; the card names the
  // first one reached, walking `Blocked by:` in the order it was written.
  //
  // `first` is only ever set by a path that ended at a person, so a Ticket with **no** live
  // blockers — one the ladder blocked on an external blocker — falls out of here as `null`
  // rather than as vacuously-every-path-human. That is deliberate and is the whole reason
  // this returns `first` instead of a boolean: there is no Ticket to name, and a card frozen
  // on nothing tells the reader to go and do nothing.
  return first;
}

/** Mirrors `derive.isBlocked`: whitespace alone is not a blocker. */
function hasExternalBlocker(ticket: ChainTicket): boolean {
  const external = ticket.externalBlocker;
  return typeof external === 'string' && external.trim().length > 0;
}

/**
 * The blockers that are actually holding this Ticket: one entry per named number that is
 * not already `done`, `null` where the number names no single Ticket. A `done` blocker is
 * dropped rather than failed — it is not a path, so it neither freezes nor unfreezes.
 */
function liveBlockersOf(
  ticket: ChainTicket,
  byNumber: NumberIndex<ChainTicket>,
): readonly (ChainTicket | null)[] {
  const live: (ChainTicket | null)[] = [];
  for (const number of ticket.blockedBy) {
    const target = byNumber.get(number);
    if (target === undefined || target === null) {
      live.push(null);
      continue;
    }
    if (target.state === SATISFIED) continue;
    live.push(target);
  }
  return live;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Feature-local number to Ticket. A number claimed by two Tickets maps to `null` — see the
 * header: an ambiguous reference identifies no Ticket, and resolving it to whichever file
 * sorted first would hide the authoring mistake behind a plausible board.
 *
 * A Ticket whose filename carries no number is indexed under nothing. It can hold blockers
 * of its own; it simply cannot be named as one.
 */
function indexByNumber<T extends { readonly id: string; readonly number: number | null }>(
  tickets: readonly T[],
): NumberIndex<T> {
  const index = new Map<number, T | null>();
  for (const ticket of tickets) {
    const number = ticket.number;
    if (number === null) continue;
    index.set(number, index.has(number) ? null : ticket);
  }
  return index;
}

// ---------------------------------------------------------------------------
// On the absence of runtime guards
//
// Every other module under `internal/` re-checks the values it is handed, because they came
// off disk. These two did not: `core/index.ts` builds both argument lists itself, out of
// Extractions it has already validated, and it calls both passes through `safeResolveBlockers`
// and `safeResolveChains`, which catch. Rule zero is therefore already delivered at the call
// site — a malformed list degrades to an empty result and every card falls back to its
// pre-graph Lane. A second layer here would be code no test could ever turn red.
//
// A blocker number that is not a number is covered by the same reasoning from the other
// direction: it matches no key in the index, so it resolves to nothing, and a reference that
// resolves to nothing blocks.
// ---------------------------------------------------------------------------
