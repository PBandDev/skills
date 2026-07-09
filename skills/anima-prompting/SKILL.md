---
name: anima-prompting
description: Use when formatting, cleaning, enhancing, or troubleshooting prompts for CircleStone Labs Anima, including Anima tag order, quality/score/safety tags, artist tags, dataset tags, negative prompts, natural-language captions, LoRA syntax, and generation settings.
---

# Anima Prompting

## Overview

Anima is an illustration-focused text-to-image model trained on Danbooru-style tags, natural-language captions, and mixtures of both. Default to strict compliance: preserve the user's idea, clean ordering/formatting, and avoid adding creative details unless the user explicitly asks to enhance.

## Mode


| User asks for...                                               | Behavior                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| format, convert, clean up, make Anima-compliant, fix tag order | Strict compliance. Reorder, normalize, and split negatives without expanding the idea.                                                      |
| enhance, improve, polish, cinematic, aesthetic, make better    | Enhancement mode. Add fitting image-making details while preserving subject, count, identity, action, outfit, setting, and intent.          |
| accurate tags, character/series/artist help                    | Verify tags. Prefer official Anima guidance, then Gelbooru, Danbooru, Safebooru, Civitai tags, then authoritative character/artist sources. |




## Output Format

Always return exactly these sections unless the user asks for analysis:

```text
Positive prompt:
[prompt text only]

Negative prompt:
[prompt text only]

Recommended settings:
Steps: 30-50
CFG: 4-5
Sampler: er_sde
Resolution: use any resolution between 512^2 and 1536^2 pixels.
Suggested aspect ratio: [one ratio], for example [width]x[height]
```

Keep labels outside prompt text. Do not put settings inside prompt blocks.

## Prompt Rules

Use this tag order:

```text
[quality/meta/year/safety] [1girl/1boy/1other/etc.] [character] [series] [artist] [general tags]
```

Rules:

- Normal tags are lowercase and use spaces, not underscores.
- Score tags keep underscores: `score_9`, `score_8`, through `score_1`.
- Character and series names use standard English capitalization.
- Known character prompts should include both character and series when available.
- Artist tags must start with `@`; user-provided artist names become artist tags without commentary.
- Mix tags and natural language when that best preserves intent.
- If a concept has no verified tag, preserve it in natural language instead of inventing a fake tag.
- Preserve user-provided LoRA syntax and weights. Do not invent or recommend LoRAs.
- Preserve explicit aspect ratios/resolutions unless the user asks for suggestions.

Default positive prefix (the official recommendation):

```text
masterpiece, best quality, score_7, safe,
```

Swap the rating tag to match the request (see Rating Tags below), and follow user-stated quality tags (for example `score_9`, `highres`) when given.

## Rating Tags

Anima uses Danbooru-style rating/safety tags: `safe`, `sensitive`, `nsfw`, `explicit`. Use exactly one, placed in the quality/meta prefix. Default to `safe`; if the user names a rating or the requested content clearly implies one, use that tag instead.

## Negative Prompt

Default negative:

```text
worst quality, low quality, score_1, score_2, score_3, artist name
```

Keep it short. Move exclusions such as "no hat" or "avoid blood" into the negative prompt. Do not add giant generic negatives like bad hands, extra fingers, watermark, text, blurry, malformed anatomy, etc. unless the user asks or the exclusion is specific to the prompt.

Only move explicit exclusions into the negative prompt. Descriptors like "non-anime", "source-style", "not photorealistic", or "DeviantArt-style" should stay as positive intent, not become automatic negatives. Add `anime`, `manga`, `photo`, or similar negatives only when the user says no, avoid, exclude, without, or remove.

## Settings

Default:

- Steps: `30-50`
- CFG: `4-5`
- Sampler: `er_sde`
- Resolution: total pixel area between `512^2` and `1536^2`; suggestions should be divisible by 64 and near or under `1536x1536` total pixels.

Sampler notes:

- `er_sde`: neutral, flatter colors, sharp lines; use as default.
- `euler_a`: softer, thinner lines; can lean 2.5D and tolerate slightly higher CFG.
- `dpmpp_2m_sde_gpu`: similar to `er_sde` but more varied/creative; can become too wild.
- `beta57` scheduler can help painterly texture when available through RES4LYF.

Common /64 suggestions:


| Ratio | Resolution |
| ----- | ---------- |
| 1:1   | 1536x1536  |
| 2:3   | 1216x1856  |
| 3:2   | 1856x1216  |
| 3:4   | 1280x1728  |
| 4:3   | 1728x1280  |
| 9:16  | 1152x2048  |
| 16:9  | 2048x1152  |


Pick one ratio from the prompt: portraits usually `2:3` or `3:4`; full-body single characters `2:3` or `9:16`; landscapes/battles/wide/cinematic scenes `16:9` or `3:2`; icons/centered studies `1:1`; tall poster compositions `9:16`; unclear anime illustration `2:3`.

## User Preferences

If `preferences.local.md` exists in this skill's directory, read it when this skill activates and apply its contents as user overrides — locked recipes, default tags, negative prompts, and settings there win over the defaults above. The file is intentionally untracked; copy `preferences.example.md` to create your own.

## Dataset And Natural Language

Use dataset tags for non-anime artistic prompting, not ordinary anime tags. Dataset prompts are an exception to the normal positive prefix: the first character of the positive prompt must be the dataset tag, with no quality/meta tags before it.

Dataset prompt structure:

```text
deviantart
[optional title]
[natural-language caption]
```

or:

```text
ye-pop
[optional alt text/title]
[natural-language caption]
```

Do not add the default positive prefix to dataset prompts unless the user explicitly asks for quality tags. Do not add exclusions like `anime` or `manga` to the negative prompt unless the user specifically wants to avoid them.

For pure natural language, write at least two descriptive sentences unless the user wants a minimal prompt. You can place quality and artist tags before a sentence. For known or multiple characters, name each character and include enough visual description to reduce identity blending.

## Example

Input:

```text
Frieren with staff in a quiet library, by Yusuke Murata, safe, 3:4
```

Output:

```text
Positive prompt:
masterpiece, best quality, score_7, safe, 1girl, Frieren, Sousou no Frieren, @yusuke murata, staff, quiet library

Negative prompt:
worst quality, low quality, score_1, score_2, score_3, artist name

Recommended settings:
Steps: 30-50
CFG: 4-5
Sampler: er_sde
Resolution: use any resolution between 512^2 and 1536^2 pixels.
Suggested aspect ratio: 3:4, for example 1280x1728
```



## Common Mistakes


| Mistake                                                | Fix                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Enhancing a strict formatting request                  | Only reorder, normalize, and split negatives.                                      |
| Using generic SDXL/Pony settings                       | Use Anima settings: 30-50 steps, CFG 4-5, `er_sde`.                                |
| Replacing artist names with style descriptions         | Use `@artist name` unless asked for verified style alternatives.                   |
| Making up tags                                         | Use natural language when no verified tag is known.                                |
| Overstuffing negatives                                 | Keep the default negative plus user-specific exclusions.                           |
| Treating descriptive negation as an exclusion          | "Non-anime" describes the target style; it does not mean add `anime` to negatives. |
| Prefixing dataset prompts with quality tags            | Put `ye-pop` or `deviantart` at the absolute start.                                |
| Forgetting safety tag conflicts                        | Use exactly one safety tag unless the user explicitly asks otherwise.              |
| Listing multiple known characters with no descriptions | Add concise visual descriptions to reduce blending.                                |
| Ignoring `preferences.local.md`                        | If it exists in the skill directory, its overrides win over the defaults here.     |

## Resources

- Official model page: <https://civitai.red/models/2458426/anima>
- Hugging Face: <https://huggingface.co/circlestone-labs/Anima>


