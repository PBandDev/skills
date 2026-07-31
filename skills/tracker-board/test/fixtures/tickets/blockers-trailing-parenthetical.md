<!-- expect: dialect=task blockedBy=[4] externalBlocker=none -->
<!-- trap: a digit scan returns [4,5,8] — it picks up the en-dashed range "05–08" from inside
     the parenthetical. Strip parentheticals BEFORE splitting, then take each segment's
     LEADING number. Note the separator inside the parenthetical is a semicolon, so
     splitting before stripping does not save you either. -->

# 09 — Sources panel (manifest-driven credits)

**What to build:** A Sources panel on `/pricing` rendered from the manifests of the datasets
the page actually loaded.

**Blocked by:** 04 — unit-costs tracer. (Runs parallel to 05–08; picks up later manifests automatically since it renders whatever loaded.)

**Status:** ready-for-agent

- [ ] Panel content derives entirely from fetched manifests
- [ ] Attribution requirements met for vendor-a derived data
