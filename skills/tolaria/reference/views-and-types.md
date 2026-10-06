# Saved Views and Type Definitions

The exact file formats for the two things that shape how a vault is displayed: saved views (`views/*.yml`) and type definitions (notes with `type: Type`). Verified against Tolaria 2026.9 source.

## Saved views

A view is a saved filter that answers one recurring question. Write the question first ("which projects are active and due soon?"), then the file.

- One view per file, directly in `views/`, extension `.yml` exactly.
- The filename is the view's identity; `name` is the label. Use a kebab-case filename.
- A view lists Markdown notes, sheet notes included. Other files, such as `.html` reports and images, never appear in one.
- A view with a missing `name`, a missing `filters`, or a misspelled `op` disappears from the sidebar with no error.
- The app picks up a new or changed view file by itself.

Done when every key and `op` is one from the tables below, and you have worked out which existing notes the view matches today. Name them to the user. If it matches none, say why.

```yaml
name: Active Projects
icon: rocket
color: blue
order: 0
sort: property:due:asc
listPropertiesDisplay:
  - status
  - belongs_to
filters:
  all:
    - field: type
      op: equals
      value: Project
    - field: status
      op: any_of
      value: [Active, In progress]
    - any:
        - field: due
          op: before
          value: in 2 weeks
        - field: belongs_to
          op: contains
          value: "[[q3-goals]]"
```

| Key | Value |
| --- | --- |
| `name` | Label in the sidebar. Required. |
| `icon` | A Phosphor icon name in kebab-case (`rocket`, `calendar-blank`), one emoji, or an `http(s)` image URL. |
| `color` | One of `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `teal`, `pink`, `gray`. |
| `order` | Integer. Lower shows first; views without it sort last, by filename. |
| `sort` | See Sort below. Default `modified:desc`. |
| `listPropertiesDisplay` | Property or relationship keys shown as chips on each row. |
| `filters` | Required. The root is one `all:` (AND) or one `any:` (OR) list. Groups nest. |

### Conditions

Each condition is `field`, `op`, and usually `value`.

| `op` | Matches when |
| --- | --- |
| `equals` / `not_equals` | The whole value is equal. On a list or relationship: it holds exactly one item and that item matches. |
| `contains` / `not_contains` | Text: substring. List property: one item equals the value. Relationship: see Relationship values. |
| `any_of` / `none_of` | `value` is a YAML list; the field equals one of its items (or none). |
| `is_empty` / `is_not_empty` | The field is missing, null, `''`, `false`, or an empty list. No `value`. |
| `before` / `after` | The field is a date strictly before or after `value`. |

- Text comparison ignores case.
- Negate with the `not_*` and `none_of` ops. Combine with nested `all` and `any`.
- `equals` compares as dates when both sides can be read as dates, so a value like `Sprint 12` or a bare number can mismatch. For exact text use `any_of` with a one-item list. Plain words such as `In progress` are safe with `equals`.
- Numbers have no greater-than or less-than; `before` and `after` are for dates. For "rating of 4 or more", list the values: `op: any_of`, `value: [4, 5]`. Tell the user a value outside the list will not show.
- Add `regex: true` to an `equals` or `contains` condition to treat `value` as a case-insensitive regular expression (256 characters at most). Keep patterns narrow.

### Fields

| `field` | Reads |
| --- | --- |
| `type`, `status`, `title` | The note's type, status, and H1 title. |
| `filename` | The file name with `.md`. |
| `archived`, `favorite` | Booleans. Use `value: true`. |
| `body` | Only the first 160 characters of the note. |
| anything else | The frontmatter key of that name: relationships first, then properties. |

- A custom field must match the key as written on the notes, ignoring only case. `related_to` and `Related to` are different fields, so search the vault for the real spelling first.
- There is no field for modified date, created date, folder, or Inbox state. Those exist only as sorts or app sections.
- Archived notes are left out of every view unless a condition names the `archived` field.

### Date values

- Absolute: `YYYY-MM-DD`.
- Relative, re-evaluated each day: `today`, `yesterday`, `tomorrow`, `in <n> <unit>`, `<n> <unit> ago`. `<unit>` is `day`, `week`, `month`, or `year` (plural allowed). `<n>` is digits, `a`, `an`, or `one` to `twelve`.
- Other phrases, such as `this month` or `next week`, never match.
- "Due within the next month" is `op: before`, `value: in 1 month`. That includes overdue notes, which is usually wanted. To leave them out, add a second condition: `op: after`, `value: yesterday`.

### Relationship values

- A plain value with `contains` is a substring of the link target: `value: tolaria` matches `"[[tolaria]]"` and `"[[projects/tolaria-app]]"`.
- A bracketed value, `value: "[[tolaria]]"`, matches that exact target or its label.
- To collect the notes around one hub, filter on what they already share: `field: belongs_to`, `op: contains`, `value: <hub filename>`. To include the hub itself, wrap that in `any` with a second condition: `field: filename`, `op: equals`, `value: <hub filename>.md`. A shared tag does the same job when there is no hub.

### Sort

`<what>:asc` or `<what>:desc`, where `<what>` is `modified`, `created`, `title`, `status`, or `property:<Key>`.

- `property:<Key>` needs the exact key spelling and case. Notes without the key sort last.
- `status` sorts `Active`, `Paused`, `Done`, `Finished`, then the rest.

## Type definitions

A type definition is a note with `type: Type` whose H1 is the type's name. Put it at the vault root as `<name>.md`. A type note with no H1 takes its name from its filename: `note.md` defines `Note`.

A note belongs to a type when its `type:` value equals that name exactly, including case. `type: project` does not join the `Project` type. A `type:` value with no type note still gets a sidebar section, with default styling and no template or defaults, so a misspelled type shows up as a stray section.

```yaml
---
type: Type
_icon: rocket
_color: blue
_order: 10
_sidebar_label: Projects
_sort: "property:due:asc"
_list_properties_display:
  - status
  - belongs_to
priority: Medium
due:
belongs_to:
template: |
  ## Outcome

  ## Next actions
  - [ ] 
---
# Project

Projects are time-bound efforts that produce an output.
```

| Key | Effect |
| --- | --- |
| `_icon` | Sidebar and row icon. A Phosphor icon name in kebab-case; emoji and URLs fall back to a default here. |
| `_color` | One of the nine view color names above, or any CSS color such as `"#3b82f6"`. Both forms work. |
| `_order` | Integer. Position of the type's section in the sidebar, lowest first. Give a new type the next number after the vault's existing types. Without it the type sorts last, by label. |
| `_sidebar_label` | Section label. Without it the app pluralizes the type name. |
| `_sort` | Default sort for the type's list. Same format as a view's `sort`. |
| `_list_properties_display` | Keys shown as chips on each note row of this type. |
| `visible` | `false` hides the type's sidebar section. Write a real boolean. |
| `template` | Starting body for new notes of the type. |
| a custom key with a value | Default value for new notes of the type (`priority: Medium`). A `status:` here is not copied; set status on each note. |
| a custom key left empty | Placeholder shown in the Properties panel of each note of the type (`due:`). An empty `belongs_to:` or `related_to:` becomes a relationship placeholder; any other empty key becomes a text placeholder. Leave empty keys out of the notes you write. |

Icon names come from [Phosphor](https://phosphoricons.com). Some that exist: `rocket`, `target`, `check`, `list-checks`, `kanban`, `calendar-blank`, `clock`, `user`, `users`, `tag`, `file-text`, `note`, `book-open`, `briefcase`, `folder`, `star`, `heart`, `lightbulb`, `chart-bar`, `currency-dollar`, `house`, `coffee`, `flask`, `wrench`, `map-pin`, `graduation-cap`, `chat-circle`, `arrows-clockwise`. An unknown name shows a default icon on a type and no icon on a view or note.

- A body under the H1 is documentation for humans and agents: say what the type is for and when to use it. If that body contains `## ` headings, `- [ ] ` items, or `Label:` lines and there is no `template:` key, the app uses the body as the template instead, so keep the description as plain prose.
- **The app applies templates and defaults only to notes it creates itself.** When you create a note of a type by writing a file, copy the template into the body and the default values into the frontmatter yourself.
- Older vaults spell some keys without the underscore (`color`, `icon`, `order`, `sidebar label`). Both spellings are read. Match what the vault's other type notes use.
- An archived type note stops acting as a type definition.
