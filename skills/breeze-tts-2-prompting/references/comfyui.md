# Breeze TTS 2 in ComfyUI

Facts for the [ComfyUI-Breeze-TTS-2](https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2) node pack, written for v1.4.8. The prompt writing itself is in [../SKILL.md](../SKILL.md).

## Nodes

| Node | Mode | Inputs | `cfg_scale` default |
| --- | --- | --- | --- |
| **Breeze TTS 2 Voice Clone** | Clone | `text`, `reference_audio`, `reference_text` | 1.0 |
| **Breeze TTS 2 Voice Design** | Design | `text`, `instruction` | 4.0 |
| **Breeze TTS 2 Voice Direction** | Direction | `text`, `reference_audio`, `reference_text`, `instruction` | 4.0 |
| **Breeze TTS 2 Speaker** | One cast member for Multi-Speaker | `name`, `audio` (or `none`), `reference_text`, `instruction` | 1.0 |
| **Breeze TTS 2 Multi-Speaker** | Dialogue from a script | `text` script, `speaker_1`…`speaker_8` | per Speaker |
| **Breeze TTS 2 Whisper Transcribe** | Writes `reference_text` from a clip | audio | — |

- The Clone node allows CFG above 1.0. That pushes the voice away from the clip; keep 1.0 to clone.
- On a **Speaker** node set `cfg_scale` yourself: 1.0 for a cloned voice, about 4 for a designed voice or a strong direction. The default is 1.0 even when `audio` is `none`.
- `stitch_reference` on Voice Direction plays the original clip `before` or `after` the output. It edits the output only; generation is unchanged.

## Limits

- Reference clip: hard maximum 60 s. The node author advises under about 20 s.
- `max_new_tokens`: default 1500 frames at 12.5 frames per second, about 2 minutes. The model stops by itself at the end of the text.
- Output: 24 kHz mono.

## Sampling widgets

Defaults: `temperature` 0.9, `top_k` 50, `top_p` 1.0, `repetition_penalty` 1.1, the same values for the `depth_*` set, and `seed` 42. A seed of 0 uses the current random state; a positive seed repeats a take.

## Whisper transcripts

An empty `reference_text` on a **Speaker** node is filled by whisper-large-v3-turbo. The transcript shows on the node. Read it and fix wrong words: a wrong transcript hurts the clone.

## Multi-Speaker script

Wire one **Speaker** node per character into **Multi-Speaker**, then write the script in its `text` widget in one of two formats:

- **Plain text**: one `Name: line` per line. A line without a name continues the previous speaker. `[Name]:` and `**Name:**` also work.
- **JSON**: text that starts with `[` or `{` is parsed as JSON. Keys `speaker`/`name`/`character`/`role` and `text`/`line`/`content`/`message` are accepted.

```
[{"speaker": "Ada", "text": "(sigh) Who steered my ship into the harbor wall?"},
 {"speaker": "Bob", "text": "Technically, captain, the harbor steered into us."}]
```

- Name matching ignores case, spaces, and punctuation (`Ali G` matches `alig`). Every name is checked before generation starts.
- Each Speaker holds one instruction for the whole script. Put the emotional arc in the words and tags.
- Each speaker keeps a fixed seed offset, so a designed voice stays the same across turns.
- `pause_between_speakers` sets the gap between turns (default 0.3 s).
- Budget about 150 words per minute. Short turns (10–18 per minute) sound more natural than monologues.
- The node author ships a full dialogue-writing guide: [SKILL.md in the node repo](https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2/blob/main/SKILL.md).
