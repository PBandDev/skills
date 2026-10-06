# Note Patterns

Starting shapes for the notes people keep in a Tolaria vault. Each pattern is frontmatter plus a body skeleton. The key spellings and status values here are Tolaria's defaults; the vault's house style and the type's own template replace them.

## Composition

- **Lead with the answer.** Under the H1, above any template sections, one or two lines that say what this note is. A long note opens with an `[!abstract]` callout.
- **Properties hold what gets filtered or sorted**: status, dates, owner, amounts, kind. The body holds the thinking.
- **A value that changes lives in one place.** Progress, status, and amounts stay in properties, where a dashboard can show them. Prose that repeats "about 10% done" goes stale on the next update.
- **Sections are `##` headings** that read well in the table of contents. Use `###` sparingly.
- **Link the first mention** of every person, project, and topic that has a note.
- **One rich block per job**: a callout for the thing that must not be missed, a table for a small comparison, a task list for actions, a diagram for a flow. A note that is all callouts has no emphasis left.
- **Dates** are `YYYY-MM-DD`.

## Project

```md
---
type: Project
status: Active
belongs_to: "[[grow-the-newsletter]]"
owner: "[[jane-doe]]"
due: 2026-09-30
---
# Launch the Referral Program

Readers invite friends and earn rewards. Done when 500 referrals arrive in one month.

## Outcome

## Milestones

- [ ] Reward tiers agreed
- [ ] Landing page live

## Decisions

## Log
```

A project is the hub for its meetings, notes, and tasks: they point at it with `belongs_to`. Add a dashboard block when it tracks numbers (`dashboards.md`). Add to `## Log` one line per event, newest last: `- 2026-08-07: kickoff held`.

## Responsibility

```md
---
type: Responsibility
status: Active
owner: "[[jane-doe]]"
---
# Grow the Newsletter

## Standards

- Open rate above 35%
- One essay every week

## Operations

- [[publish-weekly-essay]]

## Current projects

- [[launch-the-referral-program]]
```

It has standards and metrics, not an end date.

## Operation

```md
---
type: Operation
status: Active
belongs_to: "[[grow-the-newsletter]]"
cadence: Weekly
---
# Publish Weekly Essay

## When

Every Tuesday morning.

## Steps

1. Draft from the week's notes.
2. Record the voiceover.
3. Schedule the send.

## Checks

- [ ] Links open
- [ ] Preview text set
```

Write the steps so another person, or an agent, can run them cold. Draw a branching procedure as a `mermaid` flowchart above the steps.

## Task

```md
---
type: Task
status: Open
belongs_to: "[[launch-the-referral-program]]"
due: 2026-08-14
---
# Draft Reward Tiers

Three tiers with costs, for review by [[jane-doe]].
```

## Meeting

```md
---
type: Event
date: 2026-08-07
belongs_to: "[[launch-the-referral-program]]"
related_to:
  - "[[jane-doe]]"
  - "[[sam-lee]]"
---
# Referral Kickoff

> [!success] Decisions
> Launch with two reward tiers. Budget capped at $2k per month.

## Notes

## Actions

- [ ] [[sam-lee]] drafts the landing page by 2026-08-14
```

Decisions go first, in a callout. Each action names its owner and a date. The same shape serves any Event: a call, an incident, a milestone.

## Person

```md
---
type: Person
url: https://example.com
related_to: "[[acme-corp]]"
---
# Jane Doe

Head of Growth at [[acme-corp]]. Owns the referral program.

## Context

## Last contact
```

Meetings and projects link to the person, so the person's note shows them as backlinks. Keep this note for stable facts.

## Topic

```md
---
type: Topic
---
# Email Deliverability

What this covers, in one or two lines.

## Key notes

- [[spf-dkim-and-dmarc-explained]]
```

Notes point at a topic with `related_to`. The topic curates the best of them.

## Reference note

```md
---
type: Note
related_to: "[[email-deliverability]]"
url: https://example.com/article
Kind:
  - "Article"
---
# SPF, DKIM, and DMARC Explained

> [!abstract] Summary
> Three DNS records that prove a sender is who it claims to be.

## Key points

## Quotes

## My take
```

Variations use the same skeleton with a different `Kind`: book, paper, video, tool, research summary. When the vault has a type of its own for the item, such as `Book`, use that type and its template instead of `Kind`.

## Decision record

```md
---
type: Note
status: Done
date: 2026-08-07
belongs_to: "[[launch-the-referral-program]]"
Kind:
  - "Decision"
---
# Use Two Reward Tiers

> [!success] Decision
> Two tiers at launch. Revisit after 90 days.

## Context

## Options

| Option | For | Against |
| --- | --- | --- |
| Two tiers | Simple to explain | Less upside |
| Five tiers | More motivation | Costly to run |

## Consequences
```

## Log or journal

```md
---
type: Note
belongs_to: "[[launch-the-referral-program]]"
Kind:
  - "Log"
---
# Referral Program Log

## 2026-08-07

- Kickoff held. See [[referral-kickoff]].
```

Add each entry at the end under a dated `##` heading. Appending keeps earlier entries untouched.

## Hub note

```md
---
type: Note
related_to: "[[email-deliverability]]"
---
# Deliverability Reading Path

Read in this order.

1. [[spf-dkim-and-dmarc-explained]] — the basics
2. [[warming-up-a-domain]] — before the first big send
```

A hub is a hand-ordered map across notes. When the list is "every note where…", a saved view does it without upkeep.

## Tracker

A list of rows with numbers, owners, or dates that the user will keep extending is a sheet note. See `sheets.md`. Name the file for what it tracks and link it from the project it serves.
