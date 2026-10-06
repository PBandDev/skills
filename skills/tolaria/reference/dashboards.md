# Dashboards: HTML Blocks, Vault Expressions, HTML Files

An HTML block is a fenced `html` block inside a note. Tolaria renders it in a sandbox and fills `{{...}}` **vault expressions** with live values from the vault. Use one for a glance view: status tiles on a project hub, a KPI row on a responsibility, a progress bar, a styled summary.

## Anatomy

````md
---
type: Project
status: In progress
budget: 24000
progress: 0.65
owner: "[[jane-doe]]"
---
# Billing Rewrite

```html height="200"
<style>
  .row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .tile { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; padding: 14px; }
  .label { font-size: 12px; opacity: .65; text-transform: uppercase; }
  .value { font-size: 22px; font-weight: 700; margin-top: 6px; }
  .bar { height: 6px; border-radius: 3px; margin-top: 10px; background: color-mix(in srgb, currentColor 15%, transparent); }
  .fill { height: 100%; border-radius: 3px; background: currentColor; }
</style>
<section class="row">
  <div class="tile"><div class="label">Status</div><div class="value">{{title(status)}}</div></div>
  <div class="tile"><div class="label">Budget</div><div class="value">{{formatCurrency(budget, "USD", 0)}}</div></div>
  <div class="tile"><div class="label">Progress</div><div class="value">{{formatPercent(progress, 0)}}</div>
    <div class="bar"><div class="fill" style="width: {{formatPercent(progress, 0)}}"></div></div></div>
</section>
```
````

The values live in frontmatter, so the user edits them in the Properties panel and the block updates.

## The fence

- `height="N"` sets the preview height in pixels, from 180 to 960. A value outside that range resets to 320. Estimate it from the content: about 115 per row of tiles plus 40 for the frame's padding, so 270 for two rows. Too large leaves an empty gap under the block; too small cuts it off. The user can drag the block's edge to adjust it.
- `scripts="sandboxed"` allows inline `<script>`. Leave it off unless the block must build markup from data.
- Other attributes are dropped.

## What renders

| Works | Removed by the sandbox |
| --- | --- |
| HTML structure, `<style>`, inline `style` | Every `src`: images, video, audio, external scripts |
| CSS grid, flex, custom properties, gradients, `color-mix` | CSS `url(...)` and `@import`, `<link>`, web fonts |
| `<details>`, `<button>`, tables | Static `<svg>` markup |
| Links to `https:`, `mailto:`, `tel:`, `tolaria:` (they open outside the frame) | Links to `#anchors` inside the block, form submission, network requests |

- **The frame is pre-styled.** It gives the body a system font, 16 px of padding, and the app's text and background colors. Start from that; a block needs no font or page background of its own.
- **Follow the app theme.** The frame sets `color-scheme: light dark`. Build colors from `currentColor`, `color-mix(...)`, and system colors (`Canvas`, `CanvasText`), and the block reads well in light and dark. A hard-coded background breaks one of them.
- **Charts.** Draw bars and rings with CSS: a `width` or a `conic-gradient` stop fed by `formatPercent(...)`. An SVG or canvas chart needs `scripts="sandboxed"` and a script that builds it.

## Vault expressions

| Expression | Value |
| --- | --- |
| `{{status}}` or `{{this.status}}` | A property of this note |
| `{{[[q3-launch]].status}}` | A property of another note |
| `{{[[device]].power.watts}}` | A nested property |
| `{{[[q3-launch]].title}}` | Built in on every note: `title`, `status`, `path`, `filename` |
| `{{[[budget]].E6}}` | A cell of a sheet note, as displayed |
| `{{[[brief]].2}}` | Line 2 of another note's body |
| `{{[[essay]].related_to}}` | A list or relationship, as comma-separated text |

| Helper | Example |
| --- | --- |
| `upper`, `lower`, `title`, `trim` | `{{title(status)}}` |
| `truncate(value, length, suffix?)` | `{{truncate(summary, 120)}}` |
| `replace(value, from, to)` | `{{replace(status, "_", " ")}}` |
| `round(value, digits?)` | `{{round(score, 1)}}` |
| `formatNumber(value, digits?)` | `{{formatNumber(revenue, 0)}}` |
| `formatPercent(value, digits?)` | `{{formatPercent(progress, 0)}}` turns `0.65` into `65%` |
| `formatCurrency(value, code, digits?)` | `{{formatCurrency(budget, "USD", 0)}}` |
| `formatDate(value, format?)` | `{{formatDate(due, "long")}}`. Formats: `short` (9/30/26), `medium` (Sep 30, 2026), `long` (September 30, 2026), `YYYY-MM-DD` |
| `default(value, fallback)` | `{{default(owner, "Unassigned")}}` |
| `isEmpty(value)` | Renders `true` or `false` |
| `json(value)` | Structured data for a script. See below. |

- **Key names.** Write a property exactly as its key is spelled. For a key with spaces, write it in lower case with underscores: `Has Notes` is `has_notes`. The built-ins `status` and `title` work whatever the key's case.
- **Raw values** show as written in the frontmatter: `{{due}}` shows `2026-09-30`, `{{progress}}` shows `0.65`.
- **Sheet cells.** A formula cell comes back formatted the way the sheet shows it (`$585`). A plain cell comes back raw (`900`), so wrap it in a helper: `{{formatCurrency([[budget]].F4, "USD", 0)}}`.
- **No loop back to this note.** A sheet cell that reads a property of the note holding the dashboard shows `#N/A` in that dashboard. When the dashboard and the sheet both need a number, such as a budget, keep it in a plain sheet cell and read it from there.
- **Expressions read; they do not compute or query.** `+` joins text. There is no arithmetic, condition, or loop. For a calculated number, compute it in a sheet note and read the cell. For "all notes where…", build a saved view.
- **Dates.** `formatDate` on a date-only value can show the day before in time zones behind UTC. When the exact day matters, show the raw value: `{{due}}`.
- **A broken expression stays on screen** as its own `{{...}}` text. After writing a block, check each expression against the frontmatter it reads: the note exists, the key exists, the value is a single value.
- **A key that may be missing** goes through `default(...)`. It is the one helper that accepts a missing value; any other helper around a missing key leaves the whole expression broken.
- **Two opening braces always start an expression**, in `<style>` and `<script>` too. Write CSS and JavaScript so `{` never directly follows `{`: put a space between them.

## Lists from relationships

`json(...)` on a relationship returns one object per linked note: `title`, `status`, `path`, `target`, `raw`, `deepLink`. A sandboxed script turns them into markup.

````md
```html height="260" scripts="sandboxed"
<ul id="list"></ul>
<script type="application/json" id="data">{{json(has)}}</script>
<script>
  const notes = JSON.parse(document.getElementById("data").textContent || "[]");
  const list = document.getElementById("list");
  for (const note of notes) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = note.deepLink || "#";
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = note.title + (note.status ? " (" + note.status + ")" : "");
    item.append(link);
    list.append(item);
  }
</script>
```
````

- The list must exist as a frontmatter key on some note. Children that point at a hub with `belongs_to` are shown by the app but are not a stored key, so a hub that lists its parts in a dashboard keeps its own list, for example `has:`.
- Scripts are inline only. They can use the DOM inside the frame and nothing outside it. That covers click and hover handlers, and SVG built with `createElementNS`.
- A link must leave the frame to work. Tolaria adds `target="_blank"` to links written in the HTML; give a link your script creates the same `target` and `rel`, as above.

## Standalone HTML files

A `.html` file in the vault opens as a preview in the app. Use one for a finished, static report or handout.

- Unlike a block, a file keeps `<svg>` and can load images and CSS from inside the vault by relative path.
- Scripts and form fields are removed, and `{{...}}` expressions are plain text there. For anything interactive the user opens it in a browser.
- Create it with file tools, and link it from a note with its extension: `[[q3-report.html]]`.

## Design

- One question per dashboard. Three to six tiles is a glance; more is a report.
- Small muted label, large value.
- Place the block near the top of a hub note, under a one-line summary, and keep the prose below it.
- When the block needs more room, suggest the wide layout to the user (`_width: wide` on the note).
