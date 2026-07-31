<!-- expect: dialect=task statusPrefix=wontfix lane=parked state=parked -->
<!-- trap: this ticket has ZERO checked criteria and no blockers, so every progress rule says
     "ready" and it lands on the agent frontier. It must not. `wontfix` is a veto and is
     tested FIRST, before any progress or blocker logic runs.
     This is the asymmetry that makes the whole status/checkbox split safe: `Status:` on a
     task ticket may only PARK work, never promote it. Nobody types `wontfix` by accident,
     while a stale `ready-for-agent` cannot fake completion because the checkboxes still
     govern progress. One direction only. -->

# 12 — Widen the threshold band

**What to build:** Allow the band to be configured per region rather than globally.

**Blocked by:** None — can start anytime; blocks nothing in this cycle.

**Status:** wontfix

- [ ] Band configurable per region
- [ ] Existing global value migrates cleanly
