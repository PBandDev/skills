# Custom Agent Skills

This repository contains reusable Agent Skills that can be installed from GitHub with the `skills` CLI and discovered on skills.sh.

## Layout

```text
skills/
  electrobun/
    SKILL.md
    agents/openai.yaml
```

Each skill lives in its own folder under `skills/`. The folder name must match the `name` field in that skill's `SKILL.md` frontmatter.

## Install

After pushing this repository to GitHub, install all skills with:

```bash
npx skills add owner/repo
```

Install one skill by name with:

```bash
npx skills add owner/repo --skill electrobun
```

List the skills in this local checkout without installing them:

```bash
npx skills add . --list
```

## Authoring Checklist

- Use lowercase kebab-case skill names.
- Keep each `SKILL.md` focused on one job.
- Put trigger guidance in the `description`, because agents read it before loading the skill body.
- Keep long reference material in `references/`.
- Put deterministic helper code in `scripts/`.
- Put templates and static files in `assets/`.
- Re-run `npx skills add . --list` before publishing.

## Included Skills

- `electrobun`: Guidance for building, editing, and debugging Electrobun desktop apps.
