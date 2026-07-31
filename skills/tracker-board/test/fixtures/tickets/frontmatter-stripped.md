<!-- expect: statusPrefix=open dialect=decision number=13 -->
<!-- trap: a leading YAML frontmatter block. There is no instance of this in the sample
     corpus — but the upstream house style mandates frontmatter in two of its own document
     formats, so it is a matter of time, and a repo that adopts it would otherwise render
     entirely unparsed.
     Strip the leading ---…--- block before scanning fields. Do NOT parse it as YAML (that
     is a dependency); merge only the keys the board already understands, and ignore the
     rest. Note `status: open` here is lowercase and inside the block — it must not
     shadow or conflict with the real field scan below.
     Soft invariant, defensive. Not a contract. -->

---
title: Decide the refresh cadence
status: open
created: 2026-07-20
tags: [pricing, vendor]
---

# 13 — Decide the refresh cadence

Type: grilling
Blocked by: 09, 10
Status: open

## Question

Nightly, or on vendor publish? The second is fresher and unpredictable.
