# Sheet Notes

A sheet note is a spreadsheet stored as text: ordinary frontmatter plus a CSV body. Use one when the content is rows, numbers, and totals, or a list the user will keep adding rows to: budgets, trackers, inventories, plans, calendars.

## Anatomy

```md
---
type: Note
_display: sheet
belongs_to: "[[q3-launch]]"
_sheet:
  frozen_rows: 1
  columns:
    A:
      width: 200
  cells:
    E6:
      num_fmt: "0.0%"
---
**Workstream**,**Owner**,**June**,**July**,**Total**
Editor polish,[[jane-doe]],4,6,=SUM(C2:D2)
AI workflows,[[jane-doe]],2,3,=SUM(C3:D3)
**Planned**,,=SUM(C2:C3),=SUM(D2:D3),=SUM(E2:E3)
Budget,,,,24000
Share used,,,,=E4/E5
```

- `_display: sheet` makes the note open as a spreadsheet. `type` stays its normal meaning.
- The CSV starts on the line directly after the closing `---`. A blank line there becomes row 1 and shifts every cell address.
- A sheet has no H1. Its title comes from the filename, so `q3-launch-plan.md` shows as "Q3 Launch Plan". Add a `title:` key only when the title needs wording a filename cannot carry.
- The rest of the frontmatter works as on any note: status, dates, relationships.
- One note is one sheet. For a second table, write a second sheet note and link the two.

## Layout

- **A fixed model** (a budget with set lines, a plan by month): totals go under the data, as in the anatomy.
- **A tracker that grows** (purchases, a reading list, a pipeline): put the totals in a side panel to the right of the data, or in the top rows, and sum with ranges that run past the last row: `=SUM(B2:B200)`, `=SUMIF(C2:C200,"Bought",B2:B200)` (quote that second cell as CSV, since it holds commas). The user adds rows at the bottom and nothing has to move.
- Cells that a dashboard or another sheet reads should never move. Keep them in such a panel, at stable addresses.

## Cells

- Row 1 is ordinary data. Use it for headers and freeze it with `frozen_rows: 1`.
- Rows may differ in length. Trailing empty cells are optional.
- Quote a cell that holds a comma, a quote, or a line break, and double any quote inside it: `"=IF(E4>=40,""On track"",""Review"")"`.
- A cell that starts with `=` is a formula. Anything else is a value.
- A wikilink in a value cell is a real vault link: `[[jane-doe]]`.
- Cell styling lives in `_sheet` (below). As a shorthand, a value cell wrapped in `**…**`, `_…_`, or `~~…~~` shows bold, italic, or struck, and the app moves that styling into `_sheet` the first time the user edits the sheet. Use the shorthand for a quick sheet; write `_sheet` when the vault's other sheets do.
- For a real date write `=DATE(2026,6,15)`. For a boolean write `TRUE` or `FALSE`.

## Formulas

Formulas follow Excel conventions and are calculated by IronCalc: `=B2+B3-B4`, `=SUM(B2:D2)`, `=ROUND(E6, 2)`, `=IF(E6>0, "Up", "Down")`, `=$B$2`, `="Q" & 1`.

Function families available: logical (`IF`, `IFS`, `IFERROR`, `AND`, `OR`, `SWITCH`), math (`SUM`, `SUMIF`, `SUMIFS`, `ROUND`, `PRODUCT`), statistical (`AVERAGE`, `COUNT`, `COUNTA`, `COUNTIF`, `MAX`, `MIN`), lookup (`XLOOKUP`, `VLOOKUP`, `INDEX`, `MATCH`), text (`CONCAT`, `TEXT`, `TEXTJOIN`, `LEFT`, `TRIM`, `UPPER`), date (`TODAY`, `NOW`, `DATE`, `YEAR`, `MONTH`, `EDATE`, `EOMONTH`), plus financial and engineering sets. For anything unusual, check <https://docs.ironcalc.com/functions/>.

### Reading other notes

| Formula | Reads |
| --- | --- |
| `=[[revenue]].B5` | One cell of another sheet note |
| `=[[revenue]].$B$5` | The same, fixed when the formula is copied |
| `=[[q3-launch]].budget` | A frontmatter property of a note |
| `=[[device]].power.watts` | A nested frontmatter property |
| `=[[launch-brief]].2` | Line 2 of a note's body, as text |

- A cross-note reference reads one cell. Keep ranges inside one sheet, and build a cross-sheet total from single cells: `=[[a]].E9+[[b]].E9`.
- A property reference needs a single value: a number, text, or boolean. A list or a missing key shows `#N/A`.
- A property whose name looks like a cell address (`q3`, `b2`) is read as a cell. Give such properties a longer name.
- A number that a note's dashboard and this sheet both need lives in the sheet. A cell that reads a property of note A shows `#N/A` when note A's own dashboard reads it, even though the sheet itself looks right. Put the number in a plain cell and let the dashboard read that cell.
- An empty cell counts as 0 in sums.

## Styling with `_sheet`

`_sheet` is optional. Add it for frozen panes, column widths, and number formats. Its indentation is exact: `_sheet:` at column 0, then 2, 4, and 6 spaces as in the anatomy example, always in block style.

| Key | Meaning |
| --- | --- |
| `frozen_rows`, `frozen_columns` | Count of frozen rows from the top, columns from the left |
| `show_grid_lines` | `true` or `false` |
| `columns.<letter>.width` | Column width in pixels |
| `rows."<number>".height` | Row height in pixels. Quote the row number. |
| `cells.<A1>.num_fmt` | Number format: `"#,##0"`, `"#,##0.00"`, `"0.00%"`, `"$#,##0.00"`, `"yyyy-mm-dd"` |
| `cells.<A1>.bold`, `italic`, `underline`, `strike`, `wrap_text` | `true` |
| `cells.<A1>.font_size` | Number |
| `cells.<A1>.font_color`, `fill_color` | A hex color such as `"#d69e2e"` |
| `cells.<A1>.horizontal_align`, `vertical_align` | For example `"center"`, `"top"` |
| `cells.<A1>.border_top`, `border_right`, `border_bottom`, `border_left` | A style and optional color: `"thin #d0d7de"` |

A number format changes how a cell looks, never the value in the CSV. A percentage cell holds `0.35` and shows `35.00%`.

## Editing an existing sheet

1. Read the whole file.
2. Treat the body as CSV, not as text to split on commas.
3. Keep every formula a formula. Never replace one with the number it shows.
4. Keep `_sheet` as it is, unless you move cells.
5. Add rows where no reference has to move. When an insert shifts rows or columns, repair everything that pointed past the insert:
   - Widen the ranges that should include the new row: `=SUM(D2:D5)` becomes `=SUM(D2:D6)`.
   - Shift single references: `=D6/$G$6` becomes `=D7/$G$7`.
   - Shift the `_sheet` addresses the same way, and give the new row the formatting of the rows beside it.
   - Search the vault for `[[this-sheet]].` and shift the cells that other sheets and dashboards read.

Done when each row parses as CSV, every formula range covers the rows it should, and every outside reference still points at the cell it meant.
