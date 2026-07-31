# 02 — Prefactor the pricing loader seams

**What to build:** Pull the two loaders behind one interface so later tickets have a single
seam to test at.

**Blocked by:** none. Do BEFORE 03 (same seams); one implement session may do
both if it stays green between them.

**Status:** ready-for-agent

- [ ] Both loaders reachable through one interface
- [ ] Existing tests still green with no call-site changes
