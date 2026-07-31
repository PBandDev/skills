<!-- expect: dialect=unclassified renders=raw-fields -->
<!-- trap: this file breaks the dialect discriminator in BOTH directions at once, and it is a
     real file, not a hypothetical.
       - `Type: research + implement` is not one of the four known types
       - there is no sibling `map.md`, which the old rule read as "task dialect"
       - `Status: ready-for-human` is TASK vocabulary in DECISION (bare) field syntax
       - `Created:` and `Origin:` are unknown fields
       - the body uses `## Problem`, which belongs to neither template
     Classify dialect by SCORING observed syntax — bold vs bare markers, `## Question` vs
     `**What to build:**`, checkboxes present or absent. `Type:` and a sibling `map.md` are
     weak priors, never switches.
     When scoring is ambiguous the answer is a first-class `unclassified` card showing the
     raw fields — NOT a guess, and NOT a crash. A guess here asserts a lane the file does not
     support. There is no instance of `unclassified` in the source corpus, which is exactly
     why it needs a fixture: it is the state that will first appear in someone else's repo. -->

# 01 — "Approved" means rejects the vendor: fix the surfaces that show the badge without its meaning

Type: research + implement
Created: 2026-07-22
Origin: user report
Blocked by: —
Status: ready-for-human

## Problem

The badge renders on three surfaces. On two of them the qualifying text is absent, so the
badge reads as an endorsement rather than as the narrow claim it actually makes.
