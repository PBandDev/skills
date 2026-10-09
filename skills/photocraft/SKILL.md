---
name: photocraft
description: Use when editing images or automating the desktop in PhotoCraft, running headless PhotoCraft workflows, or setting up or troubleshooting its MCP server or CLI.
---

# PhotoCraft

Written for PhotoCraft 0.5.0. Edits use **engine commands** with JSON params. Discover commands from the installed app; this skill covers routing, editing, and mode-specific traps.

## Choose the session

Route by the document the user wants changed, then by the available tools:

| Task | Route |
| --- | --- |
| Edit an open desktop document, preserve unsaved work, or drive the UI | Bridge MCP connected to that desktop session. Without MCP, use the desktop's TCP control protocol. |
| Edit files independently, convert formats, or process a folder | Shell calls to `photocraft-cli run`, `convert`, or `batch`, even when bridge MCP is available. |
| Keep headless documents open across adaptive edits | Reuse an existing headless MCP session, or use `photocraft-cli serve` through a persistent pipe or localhost TCP connection. |
| Headless work in a harness with MCP but no shell | Headless MCP. |

For live and independent work together, bridge MCP plus CLI/`serve` avoids registering a second MCP tool catalog. Two MCP instances remain an option when both sessions need MCP access. Each MCP process selects one backend at launch; matching tool names do not identify its mode. Check launch configuration to identify the backend and confirm roots cover the intended input and output paths before launching.

Headless and desktop sessions have separate documents and histories. To transfer work, save a layered file and open it in the destination session; this does not synchronize unsaved changes. Confirm the active document with inspection before editing.

For a missing connection, CLI/`serve` invocation, filesystem errors, or mode-specific tools, read [Connection and file access](references/connection.md). Follow the branch for the chosen session.

## Discover commands

The **live registry** is the only reference for command ids and params. Look a command up right before its first use in a session:

- MCP: `command_list {filter: "curves"}`
- CLI: `photocraft-cli commands --json --filter curves`
- JSON protocol: `engine.commands`

Each entry has `id`, `params` (`"key":type=default`, ranges as `lo..hi`, choices as `a|b`), and `enabled`. The filter matches ids and labels only, so options hide in params: an ellipse is `select.rect {ellipse: true}`. When a filter finds nothing, search the full `--json` output. `enabled` reflects the open document; from the CLI, with no document open, every document command shows `false`.

Some engine commands ignore unrecognized params or clamp numbers; success alone does not prove the requested edit happened. Read each command's parameter names, ranges, and choices, then inspect the result. Engine params and MCP tool arguments have separate validation rules.

## Edit loop

1. **Inspect.** Identify the target document, active layer, layer ids, masks, and selection. Use MCP `doc_inspect`, protocol `doc.inspect` in `serve`, or the engine command `document.inspect`. CLI `info <file> --compact` inspects a saved file, not unsaved desktop work.
2. **Look up, then edit.** Use MCP `command_run`/`command_batch`, CLI `run`, or protocol `engine.execute`/`batch` in `serve`. Prefer adjustment layers and masks when the result should remain editable. Read ids from the current session; use a persistent session when later edits depend on earlier replies.
3. **Verify.** Compare inspection with the requested layers, settings, and selection. View MCP `doc_render_preview`, `serve`'s `doc.render`, or a PNG converted from a CLI checkpoint. A bridge preview shows the window; a headless preview shows the document. Correct mistakes before saving final outputs; `edit.undo` applies within the current session.
4. **Save.** For layered edits, save the master (`.pcraft` or `.psd`) before flat exports and inspect the saved layer structure. For conversion-only tasks, save the requested formats. Read any warnings from replies or CLI output. For explicit export quality after bridge editing, save the master, then convert it with the CLI; bridge saves use the app's current settings.

Done when the requested result is visually checked, saved outputs are identified, and any format loss or unverified result is reported.

## Editing traps

- **New layers land just above the active layer and become active.** Run `layer.selectTop` before adding a layer meant for the top of the stack. After an adjustment, type, or fill layer is added, filters and `image.adjustments.*` fail with `filters need a pixel layer`; select the pixel layer first: `layer.select {layer: <id>}`.
- **Selections scope edits.** Filters and pixel edits apply only inside an active selection; run `select.deselect` when done. A new adjustment layer ignores the selection: run `layer.layerMask.revealSelection` while the selection is still active, then confirm `hasMask: true` in `doc_inspect`.
- **Layer ids belong to the session.** They are shared across its open documents. A new CLI `run` opens a fresh session; inspect again instead of carrying ids across runs.
- **Bounds come in two formats.** Command replies give `[left, top, right, bottom]`; `doc_inspect` and `info` give `[x, y, width, height]`.
- **Batches are not transactions.** `command_batch {steps, stop_on_error: true}` stops at the first failure, and the steps before it stay applied.
