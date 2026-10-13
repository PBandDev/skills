---
name: photocraft
description: Use when editing images or automating the desktop in PhotoCraft, running headless PhotoCraft workflows, or setting up or troubleshooting its MCP server or CLI.
---

# PhotoCraft

Use the installed app's interfaces as the authority. Discover the commands and session behavior needed for the task; this skill supplies the editing workflow.

## 1. Choose the session

Identify the installed version, input, and intended output. With shell access, locate `photocraft-cli` on PATH or in the installation directory and read `--help`. With MCP, inspect its launch configuration and exposed schemas.

| Task | Route |
| --- | --- |
| Edit an open desktop document or drive the UI | Bridge MCP connected to that desktop, or its direct control protocol. |
| Edit independent files, convert formats, or process a folder | Headless CLI, even when live MCP is available. |
| Keep headless documents open across adaptive edits | Reuse headless MCP, or a persistent CLI `serve` session. |
| Headless work with MCP but no shell | Headless MCP. |

Establish the backend from its configuration and inspected state; matching tool names do not identify the session. Desktop and headless sessions have separate documents and histories. A saved layered file transfers a checkpoint between them, not unsaved state.

For connection setup or failure, CLI invocation, file access, or differences between live and headless capabilities, read [Connection discovery](references/connection.md).

Proceed when the intended session and input/output access are established. Preserve unsaved work before any required restart.

## 2. Inspect and discover

Inspect the target document, active layer, layer types and order, masks, and selection. Obtain ids from that session. Reinspect after switching documents or changing structure; interpret bounds using the schema of the interface returning them.

Look up each engine command before its first use. Discovery entry points:

- MCP: `command_list`
- CLI: `photocraft-cli commands --json`
- Direct protocol: `engine.commands`

Use the installed interface's filtering when available; broaden the search when a parameter supplies the requested behavior rather than a separate command. Read parameter names, types, ranges, defaults, and availability conditions. A disabled command may require a document, selection, or different layer type. CLI arguments, MCP tool schemas, and engine parameters are separate contracts.

Proceed when the operation has a discovered command and an unambiguous target in the chosen backend.

## 3. Edit, verify, save

Make a small edit and inspect its result. Keep dependent edits in one session. Prefer adjustment layers and masks when editability matters.

- **Layer state:** check insertion position, resulting layer type, and active layer before the next operation.
- **Selection state:** establish the intended edit area; inspect the mask created with a new adjustment or fill layer rather than assuming its scope.
- **Recovery:** after an error, partial batch, or lost reply, inspect what applied before retrying or continuing. A success reply alone does not prove the intended change.

Render a preview of the target document and compare it with the requested result. Discover whether the chosen backend returns a document render or a window capture; use a supported alternative when needed.

For layered edits, save an editable master before flat exports. Discover save/export options for the chosen backend, wait for any returned jobs to finish, and inspect the saved structure and warnings. For conversion-only work, verify the requested output format and settings.

Done when the result is visually checked, required outputs are saved, and their paths, format loss, and any unverified behavior are reported.
