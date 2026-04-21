# Electrobun Agent Skill

This repository publishes an Agent Skill for working with [Electrobun](https://github.com/blackboardsh/electrobun), a Bun + native system-webview desktop app framework.

## Install

Install the skill with the `skills` CLI:

```bash
npx skills add PBandDev/skills
```

Install only the Electrobun skill:

```bash
npx skills add PBandDev/skills --skill electrobun
```

Preview the available skills without installing:

```bash
npx skills add PBandDev/skills --list
```

## Included Skill

### `electrobun`

Use this skill when building, editing, or debugging Electrobun desktop apps, including:

- `electrobun.config.ts`
- `BrowserWindow` and `BrowserView`
- `electrobun-webview`
- typed RPC
- `views://` assets
- Bun process APIs
- bundling and updates
- CEF/native renderer behavior
- Electron migration mistakes

## Repository Layout

```text
skills/
  electrobun/
    SKILL.md
    agents/
      openai.yaml
```

`SKILL.md` contains the agent instructions. `agents/openai.yaml` provides optional Codex UI metadata.

## Local Development

Validate local discovery before pushing changes:

```bash
npx skills add . --list
```
