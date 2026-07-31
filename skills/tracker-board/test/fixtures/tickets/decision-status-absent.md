<!-- expect: dialect=decision rawStatus="" statusPrefix=open state=blocked -->
<!-- trap: there is NO `Status:` line, and that is not a defect — on a decision ticket,
     "open" is the ABSENCE of a value in the upstream spec. Wayfinder writes `Status:` only
     when a ticket is claimed or resolved.
     Treating absent-status as `unparsed` renders a freshly-generated map as an entirely
     unparsed feature — the worst possible first impression, on the newest work, where the
     board is most useful. The sample corpus writes `Status: open` explicitly, which is a
     LOCAL habit; do not build the parser around it.

     NOTE: this file also carries `Blocked by: 02, 03`, so its state is `blocked`, not `ready`.
     The original expectation said `ready`, which contradicted its own body — `blockers-comma-list`
     is the same shape and asserts `blocked`, and no rule greens both. `ready` was shorthand for
     "not unparsed", which is what this fixture actually teaches and what `statusPrefix=open`
     already proves. -->

# 05 — How much history do we keep on screen?

Type: grilling (+ `/domain-modeling`)
Blocked by: 02, 03

## Question

Does the pricing view show one vintage at a time, or all of them stacked?
