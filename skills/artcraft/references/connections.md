# Connection discovery

Use the installed interface as the authority. These entry points get an agent to app-specific help without carrying a second copy of its API.

| App | CLI help | Official automation docs |
| --- | --- | --- |
| PhotoCraft | `photocraft-cli --help` | [CLI](https://github.com/storytold/photocraft/blob/main/book/src/automation/cli.md), [control and MCP](https://github.com/storytold/photocraft/blob/main/docs/control-protocol.md) |
| VectorCraft | `vectorcraft-cli --help` | [MCP](https://github.com/storytold/vectorcraft/blob/main/docs/mcp.md) |
| FilmCraft | `filmcraft-cli help` | [agent interfaces](https://github.com/storytold/filmcraft/blob/main/docs/agents.md) |
| EffectCraft | `effectcraft-cli --help` | [agent interfaces](https://github.com/storytold/effectcraft/blob/main/docs/agents.md) |

If a link moves, find automation docs from that repository's README or file tree. When docs and the installed executable disagree, consult the source/docs for the installed release. Read desktop startup flags from its docs; a GUI executable may open a window instead of printing help.

## Live connection

1. Inspect existing client and desktop launch settings. Discover the app's control-server and explicit bridge flags; their spelling and address formats differ. Choose explicit live mode so an unavailable window cannot silently become a headless session.
2. Reuse a compatible running desktop. Otherwise preserve unsaved work before launching with control enabled. Give simultaneous apps distinct loopback ports.
3. Configure the harness's stdio MCP launcher with the app's CLI, discovered bridge arguments, and any required authentication. Multiple clients can point their bridges at the same desktop; coordinate edits to its shared active document.
4. Inspect through the connection to confirm the expected document and backend. A tool listed by the server may still be unavailable in that mode.

Discover authentication and filesystem policy for the installed app. Where token files or read/write roots exist, match them between the appropriate processes and check whether API paths are root-relative. Keep shared integration files in an app-owned user directory, independent of any one agent client. Reuse credentials without printing them.

Without MCP, use the app's documented CLI bridge or direct control protocol if available. Raw control messages and MCP messages require their respective framing and method schemas.

## Independent headless work

Find the app's batch/run syntax in CLI help. Establish whether it starts empty, opens a demo, or needs an explicit project. Discover creation, open, save, and export operations from its registry rather than borrowing another app's commands. Preserve JSON with the host shell's argument rules or supported input files/pipes.

One CLI invocation normally owns one session. For work that needs replies between edits, discover whether the app offers a persistent server. Keep that process and its input pipe alive through inspection, editing, verification, and saving. If only headless MCP supplies persistence, a shell-managed MCP client can use it on demand without another registered catalog; follow its initialization and transport protocol. When neither route is available, use saved checkpoints between invocations.

Confirm the renderer and export settings when relevant; headless and desktop defaults may differ. A headless process does not inherit the live window's document, selection, configured roots, or unsaved changes.
