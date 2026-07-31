# 0004 — The board is read-only

## Context

A kanban board affords dragging. The obvious next feature is moving a card and having the
ticket file update — and the tickets are markdown files sitting right there.

But the board is not the only writer. Agents are editing these files continuously; that is the
premise the live-updating design exists to serve. Two writers on the same markdown, one of
them a browser with no lock and a stale view, is a lost-update bug with a user's work in it.

There is also a semantic problem. Lanes are **derived** (ADR-0001). Dragging a card to Done
has no single legal file edit — it could mean ticking every criterion, writing a status, or
both, and which one is right depends on the ticket's dialect. The gesture is ambiguous at the
data layer even when it feels obvious at the UI layer.

## Decision

The board never writes to a watched repo. No drag-to-move, no inline edit, no status writeback,
no tracker-file creation.

Its runtime-state writes go to a private `.tracker-board` directory beneath the home directory
reported by the platform. A write is refused when that directory falls inside a watched Root,
and the refusal is reported through board health. On POSIX the directory and files use modes 0700
and 0600; Windows retains its platform ACL semantics.

File paths **copy to the clipboard** rather than linking — browsers block local-file links from
the board's loopback web origin, so a link here is a link that does not work.

## Consequences

The board is a window, not a workspace. Acting on what you see means going to the agent or the
file — which is the existing workflow, unchanged.

No conflict resolution, no locking, no optimistic concurrency, no undo. A large class of
bugs is absent by construction rather than handled.

Read-only is a **v1 constraint**, not a permanent one. Revisiting it means solving the
ambiguity above first: a write path needs a per-dialect mapping from gesture to file edit, and
that mapping must be decided, not inferred.
