<!-- expect: dialect=task blockedBy=[] externalBlocker="External events — not before 2026-08-05 (region-A determination; ideally also the region-B panel ruling)." state=blocked -->
<!-- trap: the date is the test. A digit-scanning blocker regex reads 2026-08-05 as blockers
     [2026, 8, 5] — one nonexistent, two real and wrong. Dates in blocker lines are common
     because "blocked by an external event" is normally expressed as a date. -->

# 16 — Regenerate after certification

**What to build:** Re-run the pipeline once both regional certifications land, and diff the
output against the current committed dataset before publishing.

**Blocked by:** External events — not before 2026-08-05 (region-A determination; ideally also the region-B panel ruling).

**Status:** ready-for-agent (respect the not-before date)

- [ ] Pipeline re-run against post-certification sources
- [ ] Diff reviewed and approved before publish
