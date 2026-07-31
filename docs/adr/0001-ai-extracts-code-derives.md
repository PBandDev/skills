# 0001 — AI extracts, code derives

## Context

`tracker-board` mixes a deterministic parser with an AI layer. The obvious division — "let the
AI decide what goes on the board" — puts lane assignment in the AI's hands.

Lane assignment is not a judgement call. It is a pure function of extracted fields plus the
dependency graph, and it must be **stable**: the same files must produce the same board on
every scan. An AI that re-derives lanes nondeterministically makes cards flicker between
scans, and a board that changes when nothing changed is a board nobody trusts.

Extraction is the opposite. Statuses are unbounded free text, blocker lines are prose as often
as they are numbers, and at least four field vocabularies exist in the wild. That fuzziness is
exactly what an AI is good at.

## Decision

The AI may produce **extraction** fields only: `title`, `criteria`, `blockedBy`,
`externalBlocker`, `rawStatus`, `ticketType`, `dialect`.

The AI may **never** produce a derived state — lane, `blocked`, `ready`, `frozen`, `done`,
frontier membership, or any count. These are computed in code from the merged extraction.

This is enforced by the annotation schema, which has no field to put a derived state in.
Validation **rejects** an annotation carrying one; it does not strip it and continue.

Digest prose is unaffected — that is authored content, not derived state, and it is where the
AI's judgement is the product.

## Consequences

The AI cannot fix a wrong lane directly. It fixes the *extraction* the lane was computed from,
and the lane follows. When extraction is right and the lane is still wrong, that is a
derivation bug and belongs in code — where it is fixed once for every repo.

Cards do not flicker. A given tree produces one board.

The rule has to be stated as a schema constraint rather than a prompt instruction, because a
prompt instruction is a request and a missing field is a wall.
