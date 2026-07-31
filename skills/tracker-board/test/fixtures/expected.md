# What `corpus/` must derive to

Ten tickets across three features. Hand-derived from the rules, reviewed as prose.

Generate `corpus.expected.json` from a **green** parser and diff it against this table before
committing it. Do not hand-author the JSON — with no parser to check it against, a
hand-written golden encodes its author's mistakes as truth, and the parser then gets "fixed"
until it reproduces them.

## Lane ordering

First match wins:

```
parked → ready-for-human → complete → blocked → claimed → HITL-in-Type → agent
```

`ready-for-human` is tested **before** completeness — that is what rescues a signed-off-pending
ticket from collapsing into Done. HITL is tested **after** claimed, so a claimed HITL ticket
stays In progress rather than being dragged into Needs you.

## Per ticket

| Feature | # | Dialect | Blockers | Criteria | Lane | Why this lane and not the obvious one |
|---|---|---|---|---|---|---|
| search-ranking | 02 | decision | — | — | **Needs you** | `Status: open`, no blockers, no checkboxes — every status rule says an agent can take it. `HITL` in `Type:` overrides. A human must relay to an outside party. |
| search-ranking | 03 | decision | — | — | **Done** | `resolved` prefix; the trailing date is a qualifier, not part of the match. |
| search-ranking | 09 | decision | 02 | — | **Frozen on you** | Blocked, and its only chain terminates at 02, which is human. Not queued for an agent — waiting on you. |
| search-ranking | 10 | decision | **none** | — | **Agent can take** | `Blocked by: — (was 02, 03; …)`. A digit scan reads `[2,3]` and moves this to Frozen, dropping the frontier and flipping 16. |
| search-ranking | 11 | decision | 02, 09 | — | **Frozen on you** | Two blockers, but 09 itself terminates at 02. Every path ends at a human. |
| search-ranking | 16 | decision | 09, 10 | — | **Blocked** | Mixed chain: 09 is human-terminal but 10 is agent-takeable, so an agent can still make progress. Ordinary Blocked. |
| checkout-flow | 01 | task | — | 2/2 | **Done** | `HITL` appears in the status *qualifier*. Matching it here asks you to sign off on finished work. |
| checkout-flow | 02 | task | **none** | 0/2 | **Agent can take** | `none. Do BEFORE 03` — a digit scan reads `[3]` and inverts the dependency direction. |
| checkout-flow | 03 | task | 02 | **3/3** | **Needs you** | All criteria checked. Completeness would file it under Done, where it collapses and disappears. `ready-for-human` wins. Render the 3/3 so it reads as awaiting sign-off, not unstarted. |
| design-system | 12 | task | — | 0/2 | **Parked** | Zero checked, no blockers — every progress rule says "ready" and puts it on the frontier. `wontfix` is a veto, tested first. |

## Lane counts

```
1 blocked · 2 frozen on you · 2 agent can take · 2 needs you · 0 in progress · 2 done · 1 parked = 10
```

Seven lanes, six columns — frozen and blocked share the Blocked column as labelled sub-lanes.
Both are unstartable; they differ only in **who can clear them**.

## Aggregates

- **Frontier = 2** (`search-ranking #10`, `checkout-flow #02`). Both reach it only by parsing a
  blocker line correctly that a naive parser gets wrong.
- **Done = 2 of 10 = 20%**, and the label must say *what* it counts. `checkout-flow #03` has
  every box checked and is **not** counted, because `ready-for-human` moved it. The figure
  means "finished **and off your desk**" — it is the one number a reader will quote, and it
  moves without any work being undone.
- `search-ranking` has `map.md` and no `spec.md`; `checkout-flow` has `spec.md` and no
  `map.md`; `design-system` has neither. All three must render.

## The one that moves everything

`search-ranking #10` is the best single regression fixture in the set. Mis-parse its
parenthetical and **two cards move and three lane counts change**: 10 leaves the agent lane
for Frozen, and 16 flips from Blocked to Frozen because its last non-human path disappeared.
That moves `agent` 2 → 1, `blocked` 1 → 0 and `frozen` 2 → 4, and the frontier drops 2 → 1.

Nothing else in the corpus has that blast radius from one line.
