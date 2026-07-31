<!-- expect: dialect=task blockedBy=[2,10] externalBlocker=none -->
<!-- trap: the tracker spec says blockers are COMMA separated. Real practice uses semicolons.
     Splitting on commas only yields [2] and silently drops the second blocker. Note 10 is
     two digits — a \d{1} width assumption truncates it to 1, which is a DIFFERENT ticket
     that probably exists. -->

# 11 — Ship gate

**What to build:** A single command that refuses to publish when either upstream gate is red.

**Blocked by:** 02 — Build gates; 10 — E2E hardening.

**Status:** ready-for-agent

- [ ] Gate fails loudly when build gates are red
- [ ] Gate fails loudly when e2e is red
