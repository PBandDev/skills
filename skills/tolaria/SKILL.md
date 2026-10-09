---
name: tolaria
description: Use when working in a Tolaria vault or with Tolaria MCP tools
---

# Tolaria

[Tolaria](https://tolaria.md) is a local-first knowledge base. A vault is a folder of Markdown files with YAML frontmatter. The files are the source of truth, and the app re-reads them when they change. You work on those files from your own harness, outside the app; the user reads the result in Tolaria. Written for Tolaria 2026.9.

## Orient

Once per session, before the first write.

1. **Find the vault.** With Tolaria MCP tools: `list_vaults`, then `get_vault_context`. Without them: it is your working directory when that holds an `AGENTS.md` naming Tolaria or notes with `type:` frontmatter; otherwise ask the user for its path. Then read every note with `type: Type`.
2. **Read the rules.** Read the vault's `AGENTS.md`, then `preferences.local.md` in this skill's folder, beside this `SKILL.md`: the user's overrides for every vault. That file is gitignored, so Grep, ripgrep, and `git ls-files` hide it; read it by path, and a missing file means no overrides. The most specific wins: the user's request, then the vault's `AGENTS.md`, then `preferences.local.md`, then this skill.
3. **Learn the house style.** Read the type note and two or three existing notes of the type you are about to write. For a type that is new, read the vault's other type notes. Copy their key spellings (`related_to` or `Related to`), status values, date and value formats, and section habits. Real notes are the evidence: a sample snippet in `AGENTS.md` is an illustration, and the defaults below are a fallback. Where the vault's own notes disagree with each other, follow the majority for that type, use the defaults below on a tie, and tell the user about the drift.

Done when you can name the vault, its types, and the exact keys and status values you will write, and `preferences.local.md` is in context or its path returned not found.

## The model

| Concept | On disk |
| --- | --- |
| Note | One `.md` file: YAML frontmatter, then a Markdown body. New notes go in the vault root. |
| Title | The `# H1` on the first body line. A sheet note has no H1 and takes its title from its filename. |
| Filename | The title as a kebab-case slug: `billing-rewrite.md`. |
| Type | The `type:` value. It must equal a type's name exactly, case included. Folders never set the type. |
| Type definition | A note with `type: Type`. Its H1 is the type's name; without an H1, its filename is (`note.md` defines `Note`). |
| Relationship | A frontmatter key whose value is a wikilink or a list of wikilinks. |
| System state | Keys that start with `_`. The app writes them. Leave existing ones as found. Add one only when the job the user asked for needs it: `_display` and `_sheet` for a sheet, the `_` keys of a type you create, `_archived` to archive. |
| Saved view | A filter file, `views/<name>.yml`. |
| Attachment | A file in `attachments/`. |

Types are lenses, not schemas: nothing is required and nothing validates.

## Frontmatter

```yaml
---
type: Project
status: Active
due: 2026-09-30
budget: 24000
progress: 0.65
belongs_to: "[[q3-goals]]"
related_to:
  - "[[jane-doe]]"
  - "[[billing-service]]"
tags:
  - billing
url: https://example.com
---
# Billing Rewrite
```

- The file starts with `---` on its first line. The H1 sits on the line right after the closing `---`.
- Quote every wikilink: `"[[note]]"`. One link per value or list item, and nothing else in that string.
- Indent list items exactly two spaces: `  - "item"`.
- Quote a text value that holds `:` or `#`, starts with `[` or `{`, or reads as a number, date, or boolean when you mean text.
- The app picks a property's editor from its value:

| Write | The user gets |
| --- | --- |
| `due: 2026-09-30` (or `2026-09-30T14:00`) | A date picker |
| `budget: 24000`, `done: true` | A number, a checkbox |
| `progress: 0.65` | A number. Store a percentage as a fraction; dashboards and sheets format it. |
| A list under a key named `tags`, `labels`, `categories`, or `keywords` | Tag pills |
| `url: https://…` | A link |
| `status:` with any text | A status chip |

- `status` and `Status` are one property to the app. Use the spelling the vault uses.
- These status values get a color; write them with this exact case: `Active`, `Open`, `Published` (green), `In progress` (purple), `Paused`, `Draft`, `Pending` (yellow), `Done` (blue), `Blocked`, `Dropped`, `Cancelled` (red), `Not started`, `Closed`, `Archived` (gray). Prefer one of these to a new word when it fits: a book being read is `In progress`.
- These plain names have a fixed meaning to the app. Use them only for that meaning and pick other names for your own data: `title`, `type`, `aliases`, `status`, `icon`, `color`, `order`, `sort`, `width`, `template`, `view`, `visible`, and `archived` (an old spelling of `_archived`).
- `aliases:` lists other names a note answers to in wikilinks.

## Relationships and wikilinks

- `belongs_to` is the parent: ownership or composition. `related_to` is a peer. Any other key holding wikilinks is a custom relationship (`owner`, `attendees`, `blocked_by`).
- Write each link once, on the child. The app shows the reverse side on the target by itself, as *Children*, *Referenced by*, and backlinks.
- A relationship shows in the Properties panel, in views, and in Neighborhood mode. A body link is a mention inside a sentence. Use the relationship when the connection should be navigable or filterable.
- A person, project, or topic that has a note is a relationship: `owner: "[[jane-doe]]"`. One with no note is plain text: `author: John Smith`.
- In files, link by filename without `.md`: `[[billing-rewrite]]`. A title resolves too, but a filename survives a retitle. Add a label when the sentence needs one: `[[billing-rewrite|the rewrite]]`. Other files keep their extension: `[[report.html]]`.
- A link points at a whole note. To point at a section, link the note and name the section in the text.
- Link only notes that exist. When a link's target has no note, leave the link out, tell the user, and offer to create the note.

## Pick the shape

Match the content to the form that serves the user best. Before you write a form for the first time in a session, read its reference.

| The content is | Make it | Reference |
| --- | --- | --- |
| Any note body: prose with callouts, tables, tasks, diagrams, math | Durable Markdown | `reference/rich-notes.md` |
| A project, meeting, person, decision, procedure, log, or reference item | A note built on that kind's pattern | `reference/note-patterns.md` |
| Rows, numbers, totals, a tracker the user keeps extending | A sheet note | `reference/sheets.md` |
| An HTML visual requested inside a note, including existing HTML or live dashboards | A fenced HTML block in that note | `reference/dashboards.md` |
| A finished static report or handout | A standalone `.html` file | `reference/dashboards.md` |
| A recurring question over many notes | A saved view | `reference/views-and-types.md` |
| A recurring kind of thing | A type definition | `reference/views-and-types.md` |
| A fact to filter or sort on | A property | Frontmatter, above |
| A connection to navigate | A relationship | Relationships, above |

For a blank HTML preview, read `reference/dashboards.md`.

Often the best answer combines them: a project note with a dashboard block on top, a sheet for its budget, and a view that lists its open tasks.

## Write a note

1. **Search first.** Look for the title, its key words, and likely aliases, one search per name. An existing note gets updated; a new one is for a new thing.
2. **Choose the type** from the types the vault has, and read its type note. Start the body from its `template:` and copy its default values. The app applies templates only to notes made in the app, so apply them yourself. When the best-fitting type has no type note in this vault, use the closest type that exists and offer the new type to the user; create a type only when the user agrees.
3. **Write the file** as `<slug>.md` in the vault root: frontmatter, H1, body. First check that no file with that name exists, ignoring case: `agents.md` is `AGENTS.md` on Windows and macOS, and a note titled "Project" would replace the `project.md` type note. On a clash, add a suffix (`agents-project.md`) and link to that name. LF line endings are fine in any vault.
4. **Connect it.** Give the note a relationship to its parent or its peers. A top-level hub with nothing above it, such as a new project, is connected by the notes that point at it. Link the first mention of every person, project, and topic that has a note.
5. **Show it.** With MCP, `open_note` brings the note up in the app. In your reply, name each note you touched by title and path. If you cannot inspect rendered content in the app, ask the user to check it or send a screenshot.

Done when the frontmatter parses, every wikilink you wrote resolves to an existing file, and the note is connected or you have told the user it stands alone.

New notes land in the user's Inbox. Marking a note organized (`_organized: true`) is the user's triage step.

## Change a note

- **Edit.** Read the whole file first. Make the smallest change. Keep unknown keys, key order, quoting, and line endings as you found them. When you change a property's value, update any sentence in the body that restates the old value.
- **Retitle.** Change the H1. If the old filename was the old title's slug, rename the file to the new slug and fix the links (next item). If the filename was already something else, keep it: links go by filename and still work.
- **Rename a file.** Search the whole vault for the old filename and the old title inside `[[...]]`: note bodies, frontmatter, sheet cells and formulas (`=[[old]].B5`), dashboard expressions (`{{[[old]].status}}`), and `views/*.yml` values. Update every hit and keep any `|label`. The app fixes links only for renames made in its own UI. Done when a search for the old filename returns nothing.
- **Archive.** When the user asks to archive, set `_archived: true`. The note leaves lists and views and stays searchable. To restore, remove the key.
- **Delete.** Only on the user's explicit request. Tolaria has no trash; a deleted file returns only from git history. Offer archive first.
- **Git.** The user owns commits, pushes, and pulls. Leave every file valid after each write, because the app may commit on its own a minute after you stop.

## Tools

File tools and MCP tools both work; the vault is just files. Either creates a note. When you have both, edit an existing note with file tools: a small edit is safer than replacing the whole file.

| Job | Tolaria MCP | File tools |
| --- | --- | --- |
| Orient | `list_vaults`, `get_vault_context` | Read `AGENTS.md` and the type notes |
| Find a note | `search_notes`: one exact phrase per call, raise `limit` | Grep |
| List by type or property | No tool | Grep the frontmatter, e.g. `^type: Project` |
| Read | `get_note` with the exact path | Read |
| Create a note | `create_note` with the full content, sheet notes included; it opens the note itself | Write |
| Edit | `get_note`, then `update_note` with the whole file and `expectedMtime`, then `open_note` | Edit in place |
| Add to a log | `append_to_note`, content starting with a blank line | Append |
| New view, `.html` file, or attachment | No tool | Write |
| Rename, archive, delete | No tool | Rename, edit, delete |
| Show the user | `open_note` | Give the note's title and path |

Read `reference/app-and-mcp.md` when an MCP tool result surprises you, before you rebuild a note from `get_note` output, or when you need to know what the running app does with your files.

## Organizing

Read `reference/organizing.md` when the user asks how to structure a vault, to see notes by time (newest first, this week, a day-by-day feed), to triage the Inbox, or to check vault health, and when you must choose a type and the vault's type notes do not settle it. It covers Portent, Tolaria's default model: eight types, two relationships, and the capture, organize, archive lifecycle.

## Preferences

`preferences.local.md` is read in Orient. Users create it by copying `preferences.example.md`. Rules for a single vault belong in that vault's `AGENTS.md`, which wins inside that vault.

When the user tells you to remember a preference about how their notes are written or organized, record it: in `preferences.local.md` when it holds for every vault, under a `## Preferences` heading in the vault's `AGENTS.md` when it holds for one. When they only mention one in passing, offer to record it. Afterwards, report the existing notes that break the new rule, and change them when the user says so.

## Product questions

For how the app itself behaves (shortcuts, settings, git sync, AI setup), read Tolaria's docs at <https://tolaria.md>. They are grouped as `/concepts/`, `/guides/`, `/reference/`, and `/troubleshooting/`.
