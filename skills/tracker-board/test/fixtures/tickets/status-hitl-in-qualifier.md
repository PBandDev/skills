<!-- expect: dialect=task statusPrefix=done lane=complete -->
<!-- trap: the string "HITL" appears in the STATUS QUALIFIER, and this ticket is finished.
     Matching HITL anywhere in the file routes a completed ticket into "Needs you" and asks
     the user to act on work that is already done.
     On the corpus, HITL appears in 29 files' body or criteria text against 4 in a `Type:`
     line — so a body-wide match floods the human lane with sign-offs that ALREADY HAPPENED.
     Match HITL/AFK in the `Type:` field only. Never the body. Never the status. -->

# 01 — Light theme default

**What to build:** Ship light as the default theme with a persisted user override.

**Blocked by:** None.

**Status:** done (pending HITL theme taste check)

- [x] Light renders as default on first visit
- [x] Override persists across reloads
