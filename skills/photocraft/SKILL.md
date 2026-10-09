---
name: photocraft
description: Use when editing images with PhotoCraft, the open-source Photoshop clean-room, through its MCP tools or `photocraft-cli`, or when setting up or fixing the PhotoCraft MCP server.
---

# PhotoCraft

Written for PhotoCraft 0.5.0. PhotoCraft is a layered raster editor driven by **engine commands**: every menu item is a command id that takes a JSON params object. The app changes fast, so this skill holds only how to reach the engine and the traps no reply warns about. The command catalog lives in the app.

## Source of truth

The **live registry** is the only reference for command ids and params. Look a command up right before its first use in a session:

- MCP: `command_list {filter: "curves"}`
- CLI: `photocraft-cli commands --json --filter curves`

Each entry has `id`, `params` (`"key":type=default`, ranges as `lo..hi`, choices as `a|b`), and `enabled`. The filter matches ids and labels only, so options hide in params: an ellipse is `select.rect {ellipse: true}`. When a filter finds nothing, search the full `--json` output. `enabled` reflects the open document; from the CLI, with no document open, every document command shows `false`.

PhotoCraft accepts bad params quietly. An unknown key is ignored and the command runs with that param's default; a number out of range is clamped. Both return success and add a history step. Only an invalid choice fails. Ranges differ per command (`file.saveACopy` takes JPEG quality `0..12`), so read them from the registry. Params written from memory or older examples are the usual cause.

`photocraft-cli --help` lists the CLI subcommands. Full protocol: <https://github.com/storytold/photocraft/blob/main/docs/control-protocol.md>

## Connect

Take the first path that fits:

1. **MCP tools present** (`doc_open`, `command_run`, `doc_inspect`, … from a `photocraft` server): use them.
2. **CLI only.** Find `photocraft-cli` on PATH; the Windows MSI installs it to `C:\Program Files\PhotoCraft\photocraft-cli.exe` and leaves PATH unchanged. Then either:
   - Run one-shots with absolute paths: `photocraft-cli run <in> --cmd <id> --params '<json>' [--cmd <id> --params '<json>' …] --out <file>`. Each `--params` belongs to the `--cmd` before it, and each command's JSON result is printed. Replace `<in>` with `--new '{"width":1200,"height":630}'` to start from a blank canvas. A run saves one `--out`; make other formats from it with `photocraft-cli convert <in> <out> --quality <1-100>`. Each run is a fresh session with fresh layer ids, so read ids with `photocraft-cli info <file> --compact` before chaining another run on its output.
   - Or register the stdio MCP server, then start a new session: `photocraft-cli mcp --automation-read-root <dir> --automation-write-root <dir>`. In Claude Code: `claude mcp add photocraft -- <that command>`.
3. **Live window**, when the user wants to watch. The user starts `photocraft --control 7878 --control-token-file <file> --automation-read-root <dir> --automation-write-root <dir>` (PhotoCraft creates the token file if it is missing), and the MCP server runs as `photocraft-cli mcp --bridge 127.0.0.1:7878 --control-token-file <file>`. The `ui_*` tools need this mode, and `doc_render_preview` then returns a screenshot of the window. Details: the protocol doc's "MCP bridge" section.

## Files over MCP

The MCP server reads and writes only beneath its **roots**, set at launch. Every path is relative to its root and uses `/`: `in/photo.jpg`. The roots appear only in the server's launch args (`--automation-read-root`, `--automation-write-root`) in the harness's MCP config; in Claude Code, `claude mcp get photocraft` prints them. With a drive root such as `C:\`, drop the drive: `C:\Users\me\photo.jpg` becomes `Users/me/photo.jpg`.

| Error contains | Fix |
| --- | --- |
| `read authority is absent` / `write authority is absent` | The server started without roots. Register it again with `--automation-read-root` and `--automation-write-root`, then start a new session. |
| `drive, device and stream prefixes are not allowed` | Make the path relative to the root. |
| `alternate separators are not allowed` | Use `/`. |
| `failed (NotFound)` on a save | Create the output folder first. |
| `uses ambient filesystem paths and is disabled` | Path-taking commands (`file.placeEmbedded`, `file.saveACopy`, …) work only in `photocraft-cli run`. Over MCP, combine images by copy and paste (below). |
| `only a PSD, PSB or .pcraft file is written back` | Pass `path` to `doc_save`. |

To put one image onto another: `doc_open` both, run `select.all` and `edit.copy` in the source, `doc_select {index}` the target, then `edit.paste {center: [x, y]}`. The clipboard survives `doc_close`.

## Traps

- **New layers land just above the active layer and become active.** Run `layer.selectTop` before adding a layer meant for the top of the stack. After an adjustment, type, or fill layer is added, filters and `image.adjustments.*` fail with `filters need a pixel layer`; select the pixel layer first: `layer.select {layer: <id>}`.
- **Selections scope edits.** Filters and pixel edits apply only inside an active selection; run `select.deselect` when done. A new adjustment layer ignores the selection: run `layer.layerMask.revealSelection` while the selection is still active, then confirm `hasMask: true` in `doc_inspect`.
- **Layer ids are session-wide counters,** shared by every open document. Read them from command replies (`{"layer": 5}`) and `doc_inspect`.
- **Bounds come in two formats.** Command replies give `[left, top, right, bottom]`; `doc_inspect` and `info` give `[x, y, width, height]`.
- **Batches are not transactions.** `command_batch {steps, stop_on_error: true}` stops at the first failure, and the steps before it stay applied.

## Edit loop

1. **Inspect.** `doc_inspect` gives layer ids, kinds, masks, the selection, and history.
2. **Look up, then run.** `command_list`, then `command_run {id, params}` or `command_batch`. Work **non-destructively**: `layer.newAdjustmentLayer.*` over `image.adjustments.*`, masks over erasing.
3. **Check.** Compare the reply and `doc_inspect` with what you asked for. Render with `doc_render_preview {max_side: 1024}` and look at the image. Undo a mistake with `edit.undo`.
4. **Save.** Save the layered master first (`.psd` or `.pcraft`), then flat exports. The extension picks the format; `quality` sets JPEG and WebP quality. Read the `warnings` in each save reply (flattened layers, lossy compression). From the CLI, `photocraft-cli info <file> --compact` prints a saved file's layer tree.
