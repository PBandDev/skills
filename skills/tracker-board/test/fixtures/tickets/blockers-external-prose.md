<!-- expect: dialect=task blockedBy=[] externalBlocker="External availability of a real `sku2026` measured metric partition. This is not a dependency of tickets 10 or 11 and does not gate current full-parity certification or deployment readiness." state=blocked -->
<!-- trap: 222 chars of English with no leading number. A parser that returns [] here and
     stops is WRONG in the most dangerous direction — it reports this ticket as READY, i.e.
     it offers an agent work that is physically impossible to start. The remainder must be
     kept as an externalBlocker string, and the presence of that string alone makes the
     ticket blocked. Note the prose contains "10" and "11" — a digit scan invents two
     blockers that the sentence explicitly DENIES are blockers. -->

# 15 — Re-verify and regenerate the sku2026 partition

**What to build:** Regenerate the regional partition once the upstream vendor publishes a real
measured metric for it, replacing the current estimated stand-in.

**Blocked by:** External availability of a real `sku2026` measured metric partition. This is not a dependency of tickets 10 or 11 and does not gate current full-parity certification or deployment readiness.

**Status:** ready-for-agent (respect the not-before date)

- [ ] Partition regenerated from the measured source
- [ ] Estimated stand-in removed and the swap recorded in the manifest
