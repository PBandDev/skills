<!-- expect: criteria=2/2 state=done -->
<!-- trap: there are FOUR checkbox lines in this file. Only the two above `## Comments` are
     acceptance criteria; the two below belong to a review checklist that a triage pass
     appended. Counting all four reports 2/4 and files a finished ticket as In progress —
     permanently, because the review list is never ticked.
     Cut the criteria region at the FIRST `## Comments` or `## Answer` heading, matched by
     PREFIX, never equality: real headings carry trailing detail like the one below.
     44 of the sample corpus's ticket files already have such a section. -->

# 06 — Member card and explainer

**What to build:** A card that explains what the score means in one sentence, at the point of
use, without linking away.

**Blocked by:** 03 — HTTP caching; 06 — member card + explainer.

**Status:** done

- [x] Card renders inline at the point of use
- [x] Explainer text passes the plain-language check

## Comments — review round 3 (3 mediums → fixed)

Follow-up checklist from the review:

- [ ] Re-check the explainer wording after the vocabulary change lands
- [ ] Confirm the card still fits at 390px once the badge is added
