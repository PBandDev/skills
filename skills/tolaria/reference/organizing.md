# Organizing a Vault

Structure advice for a Tolaria vault: which type a thing is, how to connect it, how to triage the Inbox, and how to check vault health. Tolaria's default model is **Portent** (full spec: <https://portent.md>, template vault: `refactoringhq/portent-vault-template`). A vault's own types and `AGENTS.md` come first; use Portent to fill gaps and to answer "how should I structure this?".

## The three questions

Ask them of every note, in order:

1. **What is this?** → its `type`.
2. **What is it useful for?** → its relationships.
3. **Is it captured, organized, or archived?** → its lifecycle stage.

## Types

Eight defaults. **PORT** types are actionable, **ENTP** types are inert knowledge. Litmus: if it needs a `status`, it is PORT.

| Type | It is | Belongs to |
| --- | --- | --- |
| **Responsibility** | Recurring work that never finishes: an area with a standard to keep. Body holds metrics or KPIs, not a goal. "Stay in good shape". | A team or area, if the vault has them |
| **Project** | One-off work that takes many sittings. Has a start, an end, and a definition of done. | A Responsibility |
| **Operation** | Recurring work done in one sitting: a procedure with written steps. The best home for work an agent owns. | A Responsibility or Project |
| **Task** | One-off work done in one sitting. Many users keep tasks in a task app instead. | A Project |
| **Event** | Something that happened: meeting, decision, milestone, incident. | A Project (and `related_to` the people) |
| **Note** | The default type. A durable knowledge artifact: document, reference, research, decision record. | A Project or Operation it serves |
| **Topic** | An area of interest with no expectation of action. A lens that gathers notes. | — |
| **Person** | A real person, or an agent treated as an actor. Linked well, people become a CRM. | — |

Work sorts on two axes: one sitting or many, one-off or recurring.

| | One-off | Recurring |
| --- | --- | --- |
| **Many sittings** | Project | Responsibility |
| **One sitting** | Task | Operation |

## Relationships

Two graph-style relationships cover almost everything, and they mean the same thing across every type.

- `belongs_to` — strong: ownership or composition, usually one parent. Use it toward and between PORT items.
- `related_to` — weak: many-to-many, no action implied. Use it between ENTP items (Event → Person, Note → Topic).

Tolaria shows the reverse side on the target by itself (*Children*, *Referenced by*, backlinks), so write each link once, on the child.

Add a custom relationship only when it carries meaning the two defaults cannot, such as `owner`, `attendees`, or `blocked_by`.

## Lifecycle

1. **Capture** — speed over tidiness. A captured note needs only a useful H1. It sits in the Inbox.
2. **Organize** — give it a type and relationships. Capture optimistically, organize pessimistically: a note that attaches to no Project, Responsibility, Operation, or Topic is a candidate to drop. Propose that to the user.
3. **Archive** — obsolete but possibly useful later. Archived notes leave the active lists and stay searchable.

## Type, property, or view?

| You have | Use |
| --- | --- |
| A recurring kind of thing that deserves its own sidebar section and template | A type |
| A variation inside one type (essay, video, article) | A list property on that type, e.g. `Kind: ["Essay"]`. It earns a type of its own once it needs its own properties or template: a `Book` with author and rating. |
| A recurring question across notes ("active projects", "people to follow up") | A saved view |
| A temporary or one-off grouping | A saved view, or a body link from a hub note |

Extensions that stay clean: calendar types (Year, Quarter, Month) to anchor projects and events, Team or Area types above Responsibilities, and domain types in the user's own language (Essay, Podcast, Client).

## Time

- Newest first: sort a type (`_sort`) or a view (`sort`) by a date property, or by `modified` or `created`.
- This week, this month: a view with `field: <date key>`, `op: after`, `value: 7 days ago`.
- A day-by-day feed: **History** (`Ctrl+K`, "Go to History"; code name Pulse). It lists git commits grouped by day, so it needs a git vault with commits. AutoGit keeps it current.
- In a git vault, `created` is the author date of the first commit that touched the file, and `modified` is the newer of the last commit and the file's own time. To import old notes with their real dates, commit each one with `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` set to that date.
- There is no calendar grid. Month or quarter grouping needs calendar notes (`Year`, `Quarter`, `Month` types) that other notes point at with `belongs_to`.

## Inbox triage

The Inbox holds every note that is not marked `_organized: true`, not archived, and not a type definition.

For each Inbox note:

1. Give it a clear H1.
2. Set `type`.
3. Add `status` if it is a PORT type.
4. Add `belongs_to` or `related_to`.
5. List it for the user as ready, or as a candidate to archive or delete.

A note is organized when you can answer: what kind of thing is this, what is it connected to, what is it useful for, what will the user do with it. Marking it organized is the user's action.

## Health checks

Run these with search or grep. Leave out type notes, `AGENTS.md`, `CLAUDE.md`, and archived notes, and ignore wikilinks inside code spans and code fences.

- **Orphans** — notes with no relationship key of any name and no inbound links.
- **Broken links** — wikilinks whose target matches no filename, title, or alias.
- **Untyped notes** — no `type:` key, or a `type:` value with no type note.
- **Drifted keys** — the same property under two spellings (`Status` and `status`, `Related to` and `related_to`).
- **House rules** — notes that break a rule stated in the vault's `AGENTS.md` or the user's preferences.
- **PORT notes without a status** — Projects, Tasks, Operations, and Responsibilities with no `status`.
- **Inbox backlog** — how many notes wait to be organized.
- **Thin types** — a long-standing type with one or two notes; it may be a property instead.
- **Duplicate titles** — two notes with the same H1.
- **Oversized notes** — files above 16 KB, which the editor handles less reliably.
- **Unused attachments** — files in `attachments/` that no note references.

Report before changing anything: a short list ranked by impact, each line with the finding, a count, one example, and the fix you propose. Then ask which to fix.

## Moving a vault to Portent

Propose a mapping from the current types to Portent first, with counts per type, and wait for the user to agree. Migrate one type at a time so each step is a small, reviewable diff.
