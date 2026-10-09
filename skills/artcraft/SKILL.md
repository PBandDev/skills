---
name: artcraft
description: Use when editing or automating PhotoCraft, VectorCraft, FilmCraft, or EffectCraft, including desktop work, headless workflows, and MCP/CLI setup.
---

# ArtCraft

These apps share an automation pattern, not a command language. Learn the installed app's interface and document model before translating the user's request into edits.

## 1. Identify the session

Identify the app, installed version, input, and intended output. Locate its CLI on PATH or in its installation directory and read its help. For MCP routes, inspect launch configuration; a server name or familiar tool name does not establish its backend.

| User's target | Route |
| --- | --- |
| Open window or unsaved document | Live bridge connected to that desktop. Inspect its active document before editing. |
| Independent files or batch processing | Headless CLI, even when a live MCP is connected. |
| Adaptive headless edits needing shared state | Reuse a headless session, or discover a persistent interface supported by this app. Otherwise batch related commands or save/reopen checkpoints. |

With shell access, one live MCP registration per app plus headless CLI work avoids duplicate registered tool catalogs. Headless and live sessions hold separate state; saving and opening a file transfers a checkpoint, not a synchronized document.

For CLI discovery entry points, connection setup, missing tools, or file-access failures, read [Connection discovery](references/connections.md).

Proceed when the backend and existing target or intended new document are established, and the route can read the input and write the output.

## 2. Learn the task's document model

Inspect the current document/project, or discover its creation command when starting empty. Query the app's registry for the requested operation. Use the exposed tool schemas or installed CLI; fetch official automation docs when these leave a gap. Filter results when supported; summarize a full catalog locally before loading it into context.

Let inspection determine what the task acts on: layers and selections, vector objects and artboards, clips and sequences, or compositions and animated properties. Resolve target ids, hierarchy, active selection, dimensions, and any relevant time range, frame rate, or units from that session. Translate the user's editing language into those concrete targets.

Inspect parameters immediately before first use: names, types, ranges, defaults, and whether an operation needs an active document or selection. CLI arguments, engine parameters, MCP tools, and raw control methods are separate interfaces. Use the schema for the interface being called.

Proceed when each planned operation has a discovered command and an unambiguous target. Resolve only the context the requested edit needs.

## 3. Edit, inspect, save

Make a small edit, inspect its structural result, and render a preview. A successful reply alone does not establish the intended change. Check replies for failures before continuing a batch; earlier steps may already have changed state.

Keep adaptive edits in the same session. Reinspect after switching documents or changing structure; ids and active targets can change. For time-based work, verify the affected interval, including animation or audio when relevant, rather than only a still frame. Use a documented preview/export fallback when the selected backend lacks a tool.

Preserve editable structure where the task calls for it. Save the native or layered project separately from rendered deliverables, inspect the saved result, and surface format-loss warnings. Before restarting a desktop for setup, preserve its unsaved work.

Done when the requested change is verified, required project and export files are saved, and the user knows their paths and any unverified behavior or format loss.
