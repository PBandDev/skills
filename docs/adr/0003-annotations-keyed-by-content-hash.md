# 0003 — Annotations are keyed by content hash

## Context

AI-authored content — digests, extraction overrides — describes files that change constantly,
written by agents that are working while the board watches.

Keyed by file path alone, an annotation outlives the content it describes. A digest that
confidently summarises work finished an hour ago, or an override correcting a line that has
since been rewritten, is worse than having no annotation at all: it is indistinguishable from
a correct one, and it is *authoritative-looking*.

## Decision

Every annotation entry is keyed by `filePath + contentSha`.

When a file's content hash changes, its annotations no longer match and are simply not found.
They do not need to be invalidated, swept, or garbage-collected on a timer — they expire by
construction.

Both `snapshot.json` and `annotations.json` carry a `schemaVersion`. An entry with an unknown
version is **dropped and its file re-flagged**, never crash-parsed.

State lives in `~/.tracker-board/`, outside every watched repo, so the board never pollutes a
working tree it is observing.

## Consequences

An override is permanent for the content it was written against, and silent about anything
else. Editing a corrected line discards its correction, which is right — the correction was
about text that no longer exists.

The board has two liveness tiers, and this makes the seam explicit rather than hiding it:
cards are live to the file system, AI content is as-of its hash. **The UI must show the
staleness**, because a stale digest that looks current is exactly the failure this keying was
adopted to prevent. Expiry stops the lie; it does not by itself tell the reader the digest is
gone.

Rewriting a whole feature discards its digest. Regenerating is the AI layer's job on next
invocation, and cheap — only changed files pay.
