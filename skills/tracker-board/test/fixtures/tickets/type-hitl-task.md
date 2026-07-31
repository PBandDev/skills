<!-- expect: ticketType="task (HITL — the user relays; the vendor contact answers)" hitl=true lane=needs-you -->
<!-- trap: `Status: open`, no blockers, zero checkboxes — every status-based rule says
     "an agent can take this". An agent cannot possibly take it: a human must relay the
     questions to an outside party and wait for a reply.
     HITL is a hard property of the ticket, parsed out of `Type:`, and it routes to
     "Needs you" on its own. This single fixture is the difference between a frontier of 5
     and a frontier of 4 — and offering an agent impossible work is the failure that
     destroys trust in the board fastest.
     Note `Type:` here is "task (…)" — the type word is `task`, in a file using DECISION
     field syntax (bare, not bold). Type is a weak prior for dialect, never a switch. -->

# 02 — Questions for the vendor contact

Type: task (HITL — the user relays; the vendor contact answers)
Blocked by: —
Status: open

## Question

Which of the three candidate cutoffs does the vendor actually support, and from which date?
