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
| `electrobun` | Building, editing, or debugging Electrobun desktop apps, including config, BrowserWindow/BrowserView, typed RPC, `views://` assets, bundling, updates, native renderers, and Electron migration issues. |
| `pixi-vn` | Building, editing, debugging, or reviewing Pixi VN visual novel and 2D game projects, including labels, narration, storage, save/load, canvas assets, UI layers, sound, Ink, and templates. |

## About

Each skill lives in its own folder under `skills/` and includes the instructions needed for compatible coding agents to use it.
