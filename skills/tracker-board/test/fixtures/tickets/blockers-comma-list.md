<!-- expect: dialect=decision blockedBy=[2,3,4,5,6] externalBlocker=none state=blocked -->
<!-- trap: the mirror of blockers-semicolon-pair. Splitting on ';' only yields [2] and drops
     FOUR blockers, which is the difference between "blocked behind everything" and "ready".
     Split on both separators; neither alone is correct. -->

# 07 — Decide the rollout order

Type: grilling
Blocked by: 02, 03, 04, 05, 06
Status: open

## Question

Which surface do we migrate first, given every one of them shares the pricing loader?
