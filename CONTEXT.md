# Context

Domain glossary for this repo. Sectioned per skill — skills here are unrelated to one
another, and their vocabularies must not bleed.

Format: **Term**: definition. `_Avoid_:` lists words that mean something else here, or
nothing.

---

## tracker-board

A live board over the local markdown issue trackers that the engineering skills produce.
"Read-only" means it never writes a watched repository; its private runtime state lives beneath
the platform-reported home directory. Most of these terms exist because two of them were confused
on real data and the board lied.

### Operation

**Invocation**: asking the installed `tracker-board` skill to open a board from the current
repository. It starts or reuses the fixed-port singleton and registers the repository as a Root.
A second port is never a fallback.

**Lifetime**: the process survives its spawning shell and exits after no browser SSE client has
been connected for about 15 minutes.

**Watcher**: recursive file watching when available, otherwise a polled full re-scan. The debounce
is tunable; 250 ms is a measured starting value, not a cross-platform constant.

### Structure

**Root**: a repo the board is watching. Roots **accrete** — invoking the skill in a new repo
registers it and re-scans. The board is one process across all of them.

**Feature**: one directory under `.scratch/`. Holds `spec.md` or `map.md`, an `issues/`
directory, and any number of schema-less sibling files.

**Ticket**: one markdown file under a feature's `issues/`. Its **number** comes from the
filename, at any width, sorted numerically. The H1 is display text only, and decision tickets
frequently have none.

**Field preamble**: the region of a ticket file that field scanning reads — from the top to
the **first `## ` heading, or to EOF when there is none**. Never a fixed line count.
_Avoid_: "header", "frontmatter" — frontmatter is a distinct optional `---` block.

### Dialects

**Dialect**: which field vocabulary a ticket file speaks, determined by **scoring observed
syntax** — bold vs bare field markers, `## Question` vs `**What to build:**`, checkboxes
present or absent. `Type:` and a sibling `map.md` are weak priors, never switches.

**Task ticket** (dialect A): checkboxes are truth. Produced by `/to-tickets`.

**Decision ticket** (dialect B): `Status:` is truth. Produced by `/wayfinder`, which owns
their lifecycle end to end. An **absent** `Status:` means `open`, not unknown.

**Unclassified**: a first-class rendered state for a file whose dialect scoring is ambiguous.
Shows its raw fields and takes no lane. _Avoid_: treating it as an error — it is an answer.

**Unparsed**: a file the parser could not read at all, rendered as a card showing the raw
filename. The parser **never throws**; agents rewrite these files while the board watches, so
torn reads are the steady state, not an edge case.

### Progress and triage

**Criteria**: the `- [ ]` list **above** the first `## Comments` or `## Answer` heading.
Conversation appends below, and a triage pass adds a second checkbox list that is not
criteria.

**Status**: a **triage** field — who should act, or whether to act at all. Free text, matched
case-insensitively by **longest prefix** against a known vocabulary, with the remainder kept
as a displayable **qualifier**.

Criteria and Status answer different questions and never actually compete. Criteria are
progress; Status is routing. On a task ticket Status may only **park** work, never promote it
— one-directional, which is what makes a stale `ready-for-agent` harmless.

**Parked**: `wontfix` or `closed`. A veto, evaluated before every other rule.

### Lanes

**Lane**: which column a ticket lands in. Ordering, first match wins:
`parked → ready-for-human → complete → blocked → claimed → HITL-in-Type → agent`.

**Frontier**: tickets whose blockers are all resolved — what an agent could pick up right
now. The board's reason to exist.

**Blocked**: unstartable, with at least one blocker chain an agent could still advance.

**Frozen on you**: unstartable, and **every** blocker chain terminates at a human-gated
ticket. Not queued behind an agent — waiting on you. Name the terminal ticket by id.
_Avoid_: folding this into Blocked. "Queued behind work in progress" and "nothing will happen
until you act" are opposite instructions to the reader.

**Needs you**: the human lane. Three different jobs share it — relay a question outward, sign
off implemented work, review green work.

**ready-for-human**: a **Status** value. A lane assignment, orthogonal to progress — it routes
to Needs you *regardless of checkbox state*, rendered with its ratio so a completed one reads
as awaiting sign-off rather than unstarted.

**HITL** / **AFK**: a **property of the ticket**, parsed from the `Type:` field **only** —
never the body, never criteria, never the status qualifier. A human is structurally required.
_Avoid_: matching the substring anywhere else. It appears far more often in prose describing
sign-offs that already happened, and a wide match floods Needs you with them.

### Data

**Snapshot**: code-owned state, regenerated freely, never hand-edited.

**Annotation**: AI-owned state, every entry keyed by `filePath + contentSha` so it
**auto-expires when its source changes** rather than lying forever.

**Override**: an applied annotation that disagrees with the parser, marked visibly on the
card.

**Extraction**: reading fuzzy facts out of a file — title, criteria, blockers, raw status.
AI-suited.

**Derivation**: computing lane and state from extracted facts plus the dependency graph.
Always code. Never AI. Fuzzy derivation makes cards flicker.

Governing rule: **AI extracts, code derives.** An annotation may carry extraction fields and
may never carry a derived state.

**Reconciliation**: the standing pass where the AI independently re-extracts changed files and
code diffs its output against the parser. **Disagreement** raises the flag — not
unparsability. One or two files disagreeing in a parser component become overrides; three distinct
files disagreeing in that component become one parser bug, with current evidence accumulated across
bounded pages and invocations. Pending parser-bug evidence retains only the independent component
values and is re-diffed against the current parser before it counts again; it is never applied as an
override. Agreement, overrides, and that evidence are recorded against the source content hash, so
settled unchanged files cost no AI work and edits are checked again. The incumbent board owns the
synchronous read/merge/write/refresh transaction, which serializes Root accretion and concurrent
passes.

### Digests

**Digest**: the AI-authored panel for a feature. Assembled from a fixed block vocabulary, in a
fixed order, every block individually omittable — a digest may render as nothing.

**Block**: one of `summary`, `facts`, `bullets`, `links`. There is deliberately no free-prose
block. A block that does not exist cannot be overstuffed.

**Fog**: not yet specified — graduates to a real ticket.

**Out-of-scope**: ruled out — never graduates.

Fog and out-of-scope mean **opposite** things and must be distinguishable without reading the
label. Flattening them asserts the opposite of the truth in the one artifact where the
distinction is the deliverable.
