# Connection and file access

Use the installed `photocraft-cli --help` for supported flags. Find the executable on PATH or in the PhotoCraft installation directory. Command templates below use placeholders; pass paths and JSON as individual arguments using the host shell's quoting rules.

## CLI: independent files

```text
photocraft-cli run <input> --cmd <id> --params '<json>' --out <output>
photocraft-cli convert <input> <output> --quality <1-100>
photocraft-cli batch --actions <actions.json> --in <input-dir> --out <output-dir>
```

`run` accepts multiple `--cmd`/`--params` pairs; each params object belongs to the preceding command. Replace the input with `--new '<document-json>'` to start a blank document. Each run is a fresh session and saves one `--out`; use `convert` for additional formats. These commands use ordinary filesystem paths, without automation roots. Prefer absolute paths when the working directory is uncertain.

For batch action-file syntax, consult the [CLI docs](https://github.com/storytold/photocraft/blob/main/book/src/automation/cli.md). Use a separate output directory unless the user requested replacing inputs.

## Headless: persistent session

Reuse headless MCP when already available. To add it, configure the harness's stdio MCP launcher with executable `photocraft-cli` and these arguments:

```text
mcp --automation-read-root <read-dir> --automation-write-root <write-dir>
```

With shell access, `serve` provides a persistent engine without an MCP catalog:

```text
photocraft-cli serve --automation-read-root <read-dir> --automation-write-root <write-dir>
```

Keep one `serve` session through inspection, adaptive editing, verification, and saving; for stdio, keep stdin open until finished. If the harness cannot retain an interactive pipe, add `--port <port> --control-token-file <token-file>` and send requests over localhost TCP. Authenticate each TCP connection as described under Live desktop below. Stdio needs no token handshake.

Requests and replies are newline-delimited JSON, not MCP messages. Match replies by `id` and check `ok` before continuing. For example, within one session:

```json
{"id":1,"method":"doc.open","params":{"path":"input.psd"}}
{"id":2,"method":"doc.inspect","params":{}}
```

Discover engine commands with `engine.commands`, edit with `engine.execute {command, params}`, and save with `doc.save {path}`. Protocol names and params differ from MCP (`doc.render` uses `maxSide`; MCP `doc_render_preview` uses `max_side`). Consult the [headless protocol](https://github.com/storytold/photocraft/blob/main/docs/control-protocol.md#headless-server) for batching, jobs, previews, and session methods.

## Live desktop

Connect to an existing control-enabled desktop when available. Otherwise launch it with:

```text
photocraft --control <port> --control-token-file <token-file> --automation-read-root <read-dir> --automation-write-root <write-dir>
```

Protect the token file with user-only permissions. PhotoCraft creates it if missing. Reuse the same file for the bridge MCP launcher:

```text
photocraft-cli mcp --bridge 127.0.0.1:<port> --control-token-file <token-file>
```

Preserve unsaved documents before any restart needed to enable control. Roots belong to the desktop process, not the bridging CLI.

Without MCP, use a socket-capable shell/runtime to send JSON lines directly to the desktop's localhost TCP port. The first request on each connection is authentication:

```json
{"id":"auth","method":"auth","params":{"token":"<token-file contents>"}}
```

After a successful reply, use the [desktop control protocol](https://github.com/storytold/photocraft/blob/main/docs/control-protocol.md#methods): `engine.execute` for edits, `ui.inspect` for state, and `app.open`/`app.save` for files. Its methods differ from `serve`; use the appropriate protocol table.

Bridge-specific differences:

- `ui_*` and `control_call` need bridge mode. The common tool catalog also lists tools unavailable in the selected backend.
- `doc_select` and `doc_close` are headless-only. In the desktop, select/close through the window or tab controls and verify the active document with inspection.
- `doc_render_preview` captures the window and rejects `index`. Use headless rendering for a document-only preview.
- `doc_save`/`doc_export` forward to `app.save`, using the active document and a path whose extension selects the format. Explicit `format`, `quality`, `tiffLayers`, and `index` options need headless mode. Save a layered checkpoint before CLI conversion when those options are required.

## Roots and file errors

MCP and `serve` paths are relative to the corresponding automation root and use `/`, such as `in/photo.jpg`. Read and write roots may differ; omitted roots grant no access in that direction. Resolve paths against the actual configured root rather than stripping a drive or guessing.

| Session | Where to find or change roots |
| --- | --- |
| Headless MCP | Its executable arguments in the harness's MCP configuration. |
| `serve` | The headless process's launch arguments. |
| Bridge MCP or direct desktop control | The desktop's launch arguments or `PHOTOCRAFT_AUTOMATION_READ_ROOT` / `PHOTOCRAFT_AUTOMATION_WRITE_ROOT` environment variables. |

The desktop root environment variables do not configure headless MCP or `serve`; pass their flags explicitly. If launch configuration is inaccessible, obtain the configured roots before file I/O. Restart only the process that owns the changed roots, after saving its session work.

| Error contains | Fix |
| --- | --- |
| `read authority is absent` / `write authority is absent` | Configure the missing root on the owning process above. |
| `drive, device and stream prefixes are not allowed` | Pass a path relative to the configured root. |
| `alternate separators are not allowed` | Use `/`. |
| `failed (NotFound)` on a save | Ensure the output's parent directory exists beneath the write root. |
| `uses ambient filesystem paths and is disabled` | For authorized independent file work, use trusted-local CLI `run`; for a live document, preserve its state before transferring to a CLI workflow. |
| `only a PSD, PSB or .pcraft file is written back` | Give the save an explicit output path. |

For compositing within **headless MCP**, open both documents, run `select.all` and `edit.copy` in the source, select the target with `doc_select {index}`, then `edit.paste {center: [x, y]}`. Discover the engine params first. For a live desktop, use its tab controls to switch documents instead.

Full [MCP mapping and file policy](https://github.com/storytold/photocraft/blob/main/docs/control-protocol.md#mcp-bridge).
