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
| `electrobun` | Building, editing, or debugging Electrobun desktop apps, including config, BrowserWindow/BrowserView, typed RPC, `views://` assets, bundling, updates, native renderers, and Electron migration issues. |

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
