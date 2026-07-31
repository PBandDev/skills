<!-- expect: statusPrefix=done blockedBy=[7] criteria=1/1 -->
<!-- trap: `**Status:**` sits on line 21 and this file has NO `## ` heading anywhere, so the
     field preamble is the WHOLE FILE. Any fixed line budget — 10 lines, 12, 20 — reports
     "no status line in this file" for a finished ticket, and the card renders unparsed.
     The window runs to the first `## ` heading, or to EOF when there is none. Never a line
     count.
     Second rule in the same fixture: take the FIRST occurrence of each field. The prose
     below mentions a `Status:` in backticks; a last-wins scan picks up the wrong one. -->

# 08 — Emit dated roster snapshots

**What to build:** Emit a dated snapshot on every regeneration so a reader can tell which
vintage a page was built from, and so a regression can be bisected against the data rather
than only against the code.

The snapshot is written beside the dataset, not into it, so that consumers who do not care
about vintage are unaffected. Each snapshot carries the source manifest hash, the generation
timestamp, and the tool version.

Consumers read the newest snapshot by default. A query parameter pins an older one, which is
what makes the bisect workflow possible without a rebuild.

**Blocked by:** 07 — Qualify and normalize member-roster sources.

**Status:** done

Downstream note: the loader treats a missing `Status:` field in a snapshot header as vintage
zero, which is deliberate — see the loader tests.

- [x] Dated snapshot emitted on every regeneration, with hash and tool version
