<!-- expect: dialect=task rawStatus="done" statusPrefix=done -->
<!-- trap: the colon sits INSIDE the bold. The tolerant regex /^\*{0,2}(Status)\*{0,2}:/
     matches, but captures a stray "**" into the VALUE. On the corpus this measured wrong on
     37 of 54 tickets.
     The damage is not the status field — it is that the "**" artifact defeats any
     leading-anchored match on ANY value, so the blocker parser below silently returned [5]
     for a two-blocker line. Strip '*' from the line ONCE at the field-scan boundary, before
     matching, never per-field. -->

# 03 — Restore the highlight cutoff

**What to build:** Bring back the cutoff control that was dropped in the theme migration.

**Blocked by:** 02 — graphics vendoring; 05 — map modes (same page surface, serialized)

**Status:** done

- [x] Cutoff control renders and persists
- [x] Deep link round-trips the cutoff value
