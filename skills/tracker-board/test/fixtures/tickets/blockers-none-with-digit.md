<!-- expect: dialect=task blockedBy=[] externalBlocker=none state=ready -->
<!-- trap: the value STARTS with "none" and then mentions a ticket number as sequencing
     advice. A digit scan returns [3]; the truth is no blockers at all. This ticket belongs
     on the frontier and a digit scan hides it there behind a ticket it does not depend on.
     "Do BEFORE 03" is the opposite of "blocked by 03" — the naive parse inverts the
     dependency direction. -->

# 02 — Prefactor the pricing loader seams

**What to build:** Pull the two loaders behind one interface so the later tickets have a
single seam to test at.

**Blocked by:** none. Do BEFORE 03 (same seams); one implement session may do
both if it stays green between them.

**Status:** ready-for-agent

- [ ] Both loaders reachable through one interface
- [ ] Existing tests still green with no call-site changes
