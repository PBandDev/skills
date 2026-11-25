---
name: breeze-tts-2-prompting
description: Use when writing or fixing a Breeze TTS 2 prompt — a voice design description, a voice direction instruction, a clone reference clip and transcript, inline vocal-event tags, or CFG — in ComfyUI, the official CLI or API, or the hosted BreezeBlue API. Triggers on "Breeze TTS", "BreezeBlue".
---

# Breeze TTS 2 Prompting

Breeze TTS 2 is a 3B text-to-speech model for English and Chinese, released as open weights by BreezeBlue. Every request is built from up to four parts:

- `text`: the words spoken, with inline vocal-event tags.
- `instruction`: natural-language direction (design and direction modes only).
- reference clip + transcript: a voice to clone and the exact words in it.
- CFG: how hard the model follows the instruction.

## Surface

The prompt writing below is the same everywhere. Only field names and defaults change:

| Surface | Fields | Watch out |
| --- | --- | --- |
| [ComfyUI-Breeze-TTS-2](https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2) nodes | Read [references/comfyui.md](references/comfyui.md) | Node names, Multi-Speaker scripts, limits |
| Official [`infer.py` / streaming API](https://github.com/breezeblue-ai/breeze-tts) | `--text` `--instruction` `--ref-audio` `--ref-text` `--cfg-scale` `--seed` | CFG defaults to 1.0. Pass `--cfg-scale 4` for design and direction. |
| Hosted [BreezeBlue API](https://docs.breezeblue.ai/) | `text`, `instructions`, `voice_settings.guidance_scale`; design uses `voice_description` | A saved voice ID replaces the clip and transcript |

**Sources.** Two official layers, ranked:

1. **Open weights**, authoritative for a local model: the [model card](https://huggingface.co/BreezeBlue/Breeze-TTS-2) and the [breeze-tts code](https://github.com/breezeblue-ai/breeze-tts).
2. **Hosted docs**: [Voice Design prompting](https://docs.breezeblue.ai/guides/voice-design-prompting), [Voice instruction prompting](https://docs.breezeblue.ai/guides/voice-instruction-prompting), [Audio tags](https://docs.breezeblue.ai/guides/audio-tags). The writing advice transfers to the open weights. Their guidance ranges and 34-tag list are hosted facts, not verified on the open weights.

When the two layers disagree, follow layer 1 and say so.

## Pick the mode

| You have | Mode | CFG |
| --- | --- | --- |
| A clip of the voice, no direction | **Voice Clone** | 1.0 |
| No clip, a voice in mind | **Voice Design** | 4 |
| A clip, plus a tone, emotion, or pace you want | **Voice Direction** | 4 |

Write the instruction in the **same language as the text**. Instructions are not translated.

## Voice Design instruction

The instruction is a **character sheet** for the voice. Pick from these dimensions. More detail does not guarantee a better voice:

- **Base voice**: gender, age, pitch, accent, in everyday words ("a middle-aged man with a deep, warm voice").
- **Texture**: one or two audible traits ("soft and breathy", "slightly rough", "nasal tenor").
- **Habitual pace and articulation**: "slow and deliberate", "crisp, precise pronunciation".
- **Role and situation**: who speaks, to whom ("a late-night radio host talking to someone who cannot sleep").
- **Emotional center**: "tired but professional", "calm with faint amusement".

Two official registers both work:

- **Prose** (card, hosted docs): `A warm, thoughtful young woman with a clear voice and a calm, reflective delivery.`
- **Terse fragments** (blog, benchmark; 11–31 words): `Masculine, late 40s-50s, gravelly baritone, rough West Country accent. Slow, deliberate, menacing. Authority with a volatile, predatory edge.`

Make the `text` a line this character would naturally say: every official example pairs the sheet with an in-character line.

**Recurring character.** A designed voice drifts between generations. Lock the seed once a take sounds right. To reuse a voice across many lines, save the best take (10–20 s, complete sentences) and use it as the clip in Voice Clone or Voice Direction from then on. This mirrors the hosted flow: design once, save the voice, then direct each line.

## Voice Direction instruction

The clip fixes **who** speaks; the instruction directs **how**. Combine two or three of these dimensions. All five is over-direction:

- **Situation**: a circumstance that shapes delivery ("as if afraid of being overheard").
- **Intent**: what the speaker wants: reassure, persuade, warn, conceal, command.
- **Emotion with a bound**: "restrained panic", "mild impatience", "urgent but not panicked".
- **Rhythm and emphasis**: "Emphasize 'right now' without shouting", "slow, with a pause before the last word".
- **Physical state with its sound**: "breathless from running", "holding back tears, with a cracked voice".

Patterns from the official benchmark:

- **Accent**: `Use a moderate, consistent Cockney English accent throughout the line.` Name the degree.
- **Mid-line shift**: name the trigger word in quotes. `Start with a confident, reassuring tone. At 'Wait', suddenly shift to terrified, breathless alarm.`
- **Role**: `Speak as an elegant, chilling antagonist. Polite, smooth, dangerously calm delivery.`

Keep identity with the clip: direct performance and accent, and leave age and gender to the clip. Keep directions compatible ("whispered" and "booming" in one line cancel out). Hosted cap: 1,000 characters.

More examples, verbatim: [references/examples.md](references/examples.md).

## Vocal-event tags

Tags go **inside `text`**, at the point where the sound happens. English uses parentheses; Chinese uses square brackets. Use one syntax per line.

**Confirmed** on the open weights (model card):

- English: `(laugh)` `(cough)` `(clears throat)` `(sigh)`
- Chinese: `[笑]` `[咳嗽]` `[清嗓子]` `[叹气]`

**Hosted list**, try by ear on the open weights. English uses the `-s` form:

| Kind | English | Chinese |
| --- | --- | --- |
| Laughter | `(laughs)` `(chuckles)` `(giggles)` | `[笑]` `[轻笑]` `[咯咯笑]` |
| Crying, pain | `(crying)` `(sobs)` `(whimpers)` `(groans)` `(moans)` | `[哭声]` `[抽泣]` `[呜咽]` `[呻吟]` `[哀号]` |
| Breathing | `(sighs)` `(gasps)` `(inhales)` `(exhales)` `(breathing heavily)` | `[叹气]` `[惊呼]` `[吸气]` `[呼气]` `[喘息]` |
| Delivery | `(whispers)` `(shouts)` `(screams)` `(singing)` `(humming)` `(stutters)` `(pause)` | `[耳语]` `[喊叫]` `[惨叫]` `[唱歌]` `[哼歌]` `[结巴]` `[停顿]` |
| Throat, nose | `(clears throat)` `(coughs)` `(sniffs)` | `[清嗓]` `[咳嗽]` `[吸鼻子]` |
| Mouth | `(smacks lips)` `(clicks tongue)` | `[咂嘴]` `[啧嘴]` |
| Reflexes | `(yawns)` `(sneezes)` `(hiccups)` `(burps)` `(gulps)` `(gags)` | `[打哈欠]` `[打喷嚏]` `[打嗝]` `[打饱嗝]` `[吞咽]` `[干呕]` |
| Reactions | `(grunts)` `(scoffs)` `(snorts)` | `[闷哼]` `[冷笑]` `[哼鼻子]` |

A tag that fails gets **read aloud** ("bracket laugh"). Listen for that first. For a sound with no tag, write it as words ("Heh...") or move it to the instruction ("with a nervous laugh after the first phrase"). Parenthesized stage directions like `(angrily)` belong in the instruction, never in `text`.

## Reference clip and transcript

- One speaker. No music, no background noise.
- Length: at least 3 s. Aim for 10–20 s. Every second of the clip uses prompt budget, so a long clip leaves less room for speech.
- Cut on a complete sentence. The hosted service trims to the last full sentence within 30 s and normalizes loudness to −18 LUFS.
- The transcript must match the clip **word for word**, fillers included. A wrong transcript hurts the clone. Read and fix any machine transcript.
- The clip carries timbre, rhythm, emotion, and style. A shouted clip makes shouty output. Pick a clip in the register you want.

## CFG and sampling

- **Clone: 1.0.** The official code only runs clone at 1.0.
- **Design and direction: 4** (model card). If a take sounds over-acted or harsh, try 2–3. The hosted docs start instructions at 1–3 and design at 2–4.
- Keep the official sampling defaults: temperature 0.9, top_k 50, top_p 1.0.
- Vary the seed to audition takes. Lock it to keep a take.
- When a take misses, keep the seed fixed and change **one** direction at a time.

## Text

- Split long text at paragraph breaks. One generation has a length cap, and a long clip lowers it.
- Write numbers and abbreviations as spoken ("fifty grand", not "50k"). This is community advice; the card gives no rule.
- For dialogue, generate one line per speaker turn and keep each character on a fixed clip or seed.

## Output

Give each field as its own paste-ready code block, labeled with the user's surface field name: the mode, `text`, the instruction (design and direction), and CFG. For clone and direction, also say what the clip must contain. Keep the user's spoken words unchanged unless they ask for a rewrite.
