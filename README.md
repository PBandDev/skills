# Agent Skills

Reusable Agent Skills published through [skills.sh](https://skills.sh/). This repository is a collection of skills that can be installed into compatible coding agents with the `skills` CLI.

## Install

Install all skills from this repository:

```bash
npx skills add PBandDev/skills
```

Preview available skills without installing:

```bash
npx skills add PBandDev/skills --list
```

Install one skill by name:

```bash
npx skills add PBandDev/skills --skill electrobun
```

## Skills

| Skill | Use when |
| --- | --- |
| `anima-prompting` | Formatting, cleaning, enhancing, or troubleshooting prompts for CircleStone Labs Anima, including tag order, quality/score/safety tags, artist and dataset tags, negative prompts, natural-language captions, LoRA syntax, and generation settings. |
| `artcraft` | Editing or automating PhotoCraft, VectorCraft, FilmCraft, and EffectCraft through their discovered desktop, headless, and MCP/CLI interfaces. |
| `electrobun` | Building, editing, or debugging Electrobun desktop apps, including config, BrowserWindow/BrowserView, typed RPC, `views://` assets, bundling, updates, native renderers, and Electron migration issues. |
| `lanraragi` | Searching, reading, tagging, uploading, and organizing archives on a LANraragi server through its HTTP API, including API-key setup, endpoint lookup from the server's own spec, and metadata writes that keep existing tags. Supports personal preferences. |
| `photocraft` | Editing images with PhotoCraft through its MCP tools or `photocraft-cli`, including setup, file access, the live-window bridge, and the traps that make edits fail silently. |
| `pixi-vn` | Building, editing, debugging, or reviewing Pixi VN visual novel and 2D game projects, including labels, narration, storage, save/load, canvas assets, UI layers, sound, Ink, and templates. |
| `spitballing` | Gut-checking a half-baked idea by hand (`/spitballing`): get a verdict and the strongest case against it, then work starts only if the idea holds up and you asked for action. |
| `tolaria` | Working in a Tolaria vault or with Tolaria MCP tools: writing rich notes, sheet notes, HTML dashboards, types, relationships, and saved views, and organizing a Markdown knowledge base with Portent. Supports personal preferences. |
| `tracker-board` | Viewing or monitoring `.scratch/` Markdown issue trackers as a live board that never writes watched repositories, including agent-ready work, blockers, human gates, Digests, and changed-file reconciliation for parser/AI disagreements. |

## About

Each skill lives in its own folder under `skills/` and includes the instructions needed for compatible coding agents to use it.
