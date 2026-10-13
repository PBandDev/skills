# Connection discovery

Use these entry points to learn the installed interface, then follow the branch for the task:

- CLI: locate `photocraft-cli`, read `--version` and `--help`.
- MCP: inspect server version, launch arguments, and exposed tool schemas.
- Official references: [CLI](https://github.com/storytold/photocraft/blob/main/book/src/automation/cli.md), [control protocol and MCP](https://github.com/storytold/photocraft/blob/main/docs/control-protocol.md).

Use documentation for the installed release when the default branch differs. If a link moves, find the automation docs through the repository README or file tree. Read desktop startup flags from its docs; a GUI executable may open a window instead of printing help.

## Independent files

Use CLI help to choose `run`, `convert`, or `batch` and discover input, creation, action-file, and export syntax. Pass paths and JSON as individual arguments using the host shell's quoting rules. Establish the working directory and keep outputs separate from inputs unless replacement is intended.

Each CLI invocation owns its session. Use a persistent session when later edits depend on earlier replies; otherwise batch known operations or save and reopen a layered checkpoint.

## Persistent headless work

Reuse an existing headless MCP session or discover the installed `serve` interface. Keep the process and its input connection alive through inspection, editing, verification, and saving. Discover supported transports, authentication, and read/write roots before launching.

For direct control, use the documented framing, methods, and reply schema for that server. Match replies to requests and check operation results. MCP tool names and arguments are a separate interface; consult the protocol mapping when switching between them.

## Live desktop

Reuse a control-enabled desktop. Otherwise preserve its unsaved work before starting it with the documented control settings. Configure the MCP bridge or direct client for that desktop's address and authentication; keep token material private and use a loopback connection. Inspect the connection to confirm it reaches the expected open document.

Discover backend support for document selection/closing, previews, and save/export settings. A shared tool catalog can include operations or options unavailable in bridge mode. Use documented desktop controls for live operations. When the backend lacks the required render or export controls, save a layered checkpoint and use a capable headless interface.

## File access

Identify which process enforces file access: the desktop for a live bridge, or the headless server for independent MCP/serve work. Read its configured roots and installed path rules, including relative versus absolute paths, separators, and read/write permissions. CLI file commands can have a different policy from server methods.

For a file error, check the requested operation against those rules, resolve the path under the appropriate root, and confirm the source or destination directory exists. Change the owning process's configuration when necessary, preserving its work before restart. When configuration is inaccessible, obtain the allowed paths before file I/O.

Connection setup is complete when the backend is confirmed and its configured access covers the intended input and output.
