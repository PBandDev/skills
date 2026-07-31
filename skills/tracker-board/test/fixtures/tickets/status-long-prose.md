<!-- expect: dialect=task statusPrefix=resolved qualifierLength>400 lane=complete -->
<!-- trap: statuses are UNBOUNDED free text — the longest observed ran 178 chars in one
     sample and far longer here. Three ways to get this wrong:
       1. equality-match "resolved" → unparsed card for a finished card
       2. truncate the value → the delivery pointer is destroyed
       3. longest-prefix match but DROP the remainder → same loss, quieter
     Case-insensitive LONGEST-PREFIX match against the known vocabulary, keep the entire
     remainder as a displayable qualifier.
     Note this file also carries an unknown `**Origin:**` field. Unknown fields must be
     ignored without disturbing the scan — they are common and they are not errors. -->

# 14 — Return-visit HTTP caching for /records/ files

**What to build:** The local harness sends no `Cache-Control`/`ETag`/`Last-Modified`, so a
reload re-downloads every /records/ file with status 200 — the suite cannot observe or ratchet
return-visit caching, and a future regression in header config would be invisible.

**Origin:** Reliability review of cache semantics — the caching policy is a product decision
and the surrounding service is not currently broken.

**Blocked by:** —

**Status:** resolved — delivered via `example-delivery/records/return-visit-cache-policy.md` (2026-07-23). Policy chosen = explicit `Cache-Control`: `/records/(.*)` → `public, max-age=0, must-revalidate`; content-hashed `/assets/(.*)` and `/media/(.*)` → `public, max-age=31536000, immutable`. The harness now reads and mirrors all rules and adds strong content-ETag + Last-Modified validators with `If-None-Match` 304 handling and a drift ratchet requiring the `/records` rule. See sample-delivery/cache for full evidence.

- [x] Policy recorded with stale-after-regeneration reasoning
- [x] Harness sends validators and honours conditional requests
