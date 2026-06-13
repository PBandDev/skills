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

## Publish to skills.sh

skills.sh indexes public GitHub skills through `skills` CLI installs. After pushing changes to GitHub, run the install from a temporary directory so the local repository stays untouched:

```bash
tmp="$(mktemp -d)" && cd "$tmp" && npx skills add PBandDev/skills --skill pixi-vn --yes
```

## Skills

| Skill | Use when |
| --- | --- |
| `electrobun` | Building, editing, or debugging Electrobun desktop apps, including config, BrowserWindow/BrowserView, typed RPC, `views://` assets, bundling, updates, native renderers, and Electron migration issues. |
| `pixi-vn` | Building, editing, debugging, or reviewing Pixi VN visual novel and 2D game projects, including labels, narration, storage, save/load, canvas assets, UI layers, sound, Ink, and templates. |

## Layout

```text
skills/
  <skill-name>/
    SKILL.md
    agents/
      openai.yaml
```

Each skill lives in its own folder under `skills/`. `SKILL.md` contains the agent instructions and trigger metadata. `agents/openai.yaml` is optional Codex UI metadata.

## Local Development

Validate local discovery before pushing changes:

```bash
npx skills add . --list
```

Use lowercase kebab-case skill names, and keep each skill focused on one reusable workflow or domain.
