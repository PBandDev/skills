<!-- expect: ticketType="research (AFK)" hitl=true lane=blocked -->
<!-- trap: AFK is the same routing signal as HITL under a different word, and the retired
     role `ready-for-afk` still appears in upstream docs. Match both. The parenthetical form
     `(AFK)` is the common one — the marker is rarely the whole value, so equality-matching
     the type word loses it.

     NOTE: this file also carries `Blocked by: 01`, and Lane ordering places `blocked` before the
     HITL rung, so its Lane is `blocked`. The original expectation said `needs-you`, which would
     require moving the HITL rung — an ordering stated identically in the spec, the glossary and
     the corpus table, and one that must stay after `claimed` or a held Ticket gets dragged into
     the human column. What this fixture teaches is that `(AFK)` is matched as a HITL signal, and
     `hitl=true` proves that directly. -->

# 04 — Survey the three candidate feed formats

Type: research (AFK)
Blocked by: 01
Status: open

## Question

Which feed format do we adopt, and what does each cost us at refresh time?
