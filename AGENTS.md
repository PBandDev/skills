# Agent Instructions

This repository publishes reusable agent skills through GitHub and skills.sh. Keep changes small, public-facing, and easy to validate.

## Repository Layout

- Skills live in `skills/<skill-name>/`.
- Each skill needs `SKILL.md` with `name` and `description` frontmatter.
- `agents/openai.yaml` is optional UI metadata for Codex-compatible surfaces.

## Skill Authoring

- Use lowercase kebab-case folder names.
- Keep each skill focused on one reusable workflow or domain.
- Optimize `description` for trigger conditions, not workflow summaries.
- Avoid local paths, private notes, research artifacts, or dated claims in public `SKILL.md` files.
- If a skill targets a specific library version, state the version it was written for.

## Validation

Run local discovery before pushing:

```bash
npx skills add . --list
```

## skills.sh Indexing

skills.sh indexes public GitHub skills through `skills` CLI installs. After pushing to GitHub, run installs from a temporary directory so the local repo stays untouched:

```bash
tmp="$(mktemp -d)" && cd "$tmp" && npx skills add PBandDev/skills --skill <skill-name> --yes
```

## Git Hygiene

- Check `git status --short` before editing and before finishing.
- Do not revert unrelated user changes.
- Commit only the files relevant to the requested change.
