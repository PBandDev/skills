<!-- expect: dialect=task statusPrefix=ready-for-human criteria=5/5 lane=needs-you state=done-awaiting-human -->
<!-- trap: THE lane-ordering keystone. Five of five criteria checked, so "checkboxes decide
     progress" files this under Done — where it collapses by default and becomes invisible.
     It had been waiting on a human for a week.
     `ready-for-human` is a LANE assignment, orthogonal to progress. It routes to "Needs you"
     REGARDLESS of checkbox state, and must be tested BEFORE completeness. Render it showing
     its ratio (5/5) so it reads as "implemented, awaiting sign-off" rather than unstarted —
     the ratio is what stops the lane from looking like a pile of un-started work.
     Two rules written independently collided here on real data. Neither was wrong alone. -->

# 09 — Sources panel (manifest-driven credits)

**What to build:** A Sources panel on `/pricing` rendered from the manifests of the datasets
the page actually loaded — source names, links, fetch dates, attribution. No hand-written
credits list anywhere.

**Blocked by:** 04 — unit-costs tracer.

**Status:** ready-for-human

- [x] Panel content derives entirely from fetched manifests — adding a dataset adds its credit with zero panel changes
      Evidence: loaders register their manifest URL into a page-lifetime store on load success;
      the panel renders exactly the registered set. Hand-written credits deleted.
- [x] Attribution requirements met for vendor-a derived data
      Evidence: credit renders source name, link, fetch date, and the manifest's attribution
      field carrying the adapted/recomputed indication — all from manifest fields.
- [x] e2e asserts panel lists exactly the datasets the page loaded
      Evidence: expected names derived from the REAL fetched manifests, asserting the credit
      set matches with no extras or misses.
- [x] No persona-breaking strings anywhere in the panel or footer
      Evidence: panel content is manifest fields; footer unchanged. Build-time sweep clean.
- [x] Final acceptance review done
      Evidence: see Comments.

## Comments

Final pass — 3 mismatches, each fixed.
