<!-- expect: dialect=task statusPrefix=done qualifier="— committed `da675f8`" -->
<!-- trap: case. Matching must be case-insensitive, and the commit sha must survive as a
     displayable qualifier rather than being dropped. Equality-matching "done" fails here
     twice over. -->

# 05 — Interactivity and honest labels

**What to build:** Hover and keyboard focus both surface the same tooltip content, and no
label claims precision the dataset does not have.

**Blocked by:** 04 — design prototype approval.

**Status:** DONE — committed `da675f8`

- [x] Tooltip reachable by keyboard
- [x] Labels carry the measurement caveat
