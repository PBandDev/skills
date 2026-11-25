# Breeze TTS 2: official examples

Verbatim from BreezeBlue sources. Use them as style anchors. Each source is linked at its section.

The benchmark examples use English only. The benchmark `text` lines write tags as `[sigh]`; that is the benchmark's model-neutral marker. On Breeze English text, write `(sigh)`.

## Model card, open weights

From the [Breeze TTS 2 model card](https://huggingface.co/BreezeBlue/Breeze-TTS-2).

**Voice Design**, CFG 4

- EN instruction: `A warm, thoughtful young woman with a clear voice and a calm, reflective delivery.`
  EN text: `(sigh) Welcome aboard. Your journey begins now.`
- ZH instruction: `一位温柔自信的年轻女性，声音清晰，语气亲切，表达轻快而富有感染力。`
  ZH text: `[笑] 欢迎来到今晚的故事时间，让我们一起开始吧。`

**Voice Direction**, CFG 4

- Instruction: `Speak slowly with a restrained, serious tone.`
  Text: `(clears throat) We need to discuss what happened last night.`

**Voice Clone**, CFG 1.0

- EN text: `(sigh) It is good to hear your voice again after all this time.`
- ZH text: `[叹气] 没想到过了这么久，你还记得我的声音。`

## Hosted docs: voice design

From [Voice Design prompting](https://docs.breezeblue.ai/guides/voice-design-prompting).

- **Meditation guide**: `A calm female meditation guide with a soft, breathy voice. Speak slowly and smoothly, with gentle pauses and a warm, reassuring tone that feels peaceful, intimate, and safe.`
  Text: `Let your shoulders drop away from your ears, releasing any tension you might be holding. Breathe in deeply through your nose, feeling the air expand your chest, and then slowly exhale, letting everything soften into this present moment.`
- **Elegant villain**: `A middle-aged man with a deep, smooth voice, playing an elegant villain. Speak slowly and clearly with controlled menace; keep the tone calm, intimate, and faintly amused, never loud.`
  Text: `Did you truly believe you could dismantle my life's work without consequence? I admire the audacity, really, I do. But now that the doors are locked, let us discuss exactly how much your ambition is going to cost you.`
- **Older chronicler**: `An older man with a deep, slightly rough and weathered voice. Speak slowly with measured pauses and restrained emotion, giving narration, warnings, and dark memories a quiet sense of weight.`
  Text: `People think ruin announces itself with thunder. It does not. It sits beside you quietly, waits for compromise, and learns your name before you notice the door is locked.`
- **Digital assistant**: `A friendly digital assistant with a bright, clear voice and a subtle synthetic quality. Speak at a crisp, steady pace with precise pronunciation, sounding warm, helpful, and consistently composed.`
  Text: `Thank you for waiting. I have located your order details and will now summarize the current status, estimated delivery window, and available support options.`

## Hosted docs: one line, five performances

From [Voice instruction prompting](https://docs.breezeblue.ai/guides/voice-instruction-prompting). Text for all five: `I can't believe you brought him here!`

- Whispered: `Say it whispering, very quiet and tense, as if you are afraid of being overheard.`
- Excited: `Say it excitedly, with bright surprise and rising energy, as if his arrival is wonderful and completely unexpected.`
- Sarcastic: `Say it sarcastically, with dry disbelief and a dismissive tone, as if this was obviously a terrible idea.`
- Nervous humor: `Say the line with a nervous laugh after the first phrase, as if trying to hide panic behind humor.`
- Restrained grief: `Say it while holding back tears, with a cracked voice and emotional pauses, as if bringing him here deeply hurt you.`
- Concealed anger: `Speak quietly with restrained anger, as if the unwelcome guest might overhear. Emphasize 'him' without raising your voice.`

## Voice Design benchmark: terse register

From the [TTS-Voice-Design-Benchmark dataset](https://huggingface.co/datasets/BreezeBlue/TTS-Voice-Design-Benchmark). It has 700 cases; the instruction median is 20 words.

- `Male, 40s-50s, Castilian accent. Weathered, gritty baritone, deliberate pace. Paternal, stern, tactical wisdom, high gravitas, unwavering honor.`
  Text: `Hold your line, hijo; fear is loud at dusk, but discipline speaks true. We do not chase glory today, we bring our people home with honor, and that is victory enough.`
- `Feminine, young adult. Velvety, breathy mezzo-soprano. Smoky, intimate. Understated, relaxed, conversational. Gentle swing, soft lilt. Slow, contemplative, warm melancholy.`
  Text: `Stay a little longer, honey; the night is moving slow, and I have one more secret dressed up like a song, waiting right here between this heartbeat and the hush.`
- `Senior male, Mid-Atlantic British, heavy jowly texture, slow deliberate pace, precise dry sardonic wit, morbidly playful deadpan, breathy resonance.`
  Text: `Do come in, do mind the staircase; it has a morbid sense of timing. Still, if one must meet the inevitable, I do think velvet drapes and good manners soften the blow.`
- `Middle-aged male, high-strung nasal shaky tenor. Desperate rapid-fire, vulnerable stuttering pauses. Intellectual pride, social anxiety. Midwestern cadence.`
  Text: `I know, I know, I used to light up a room with one idea, one perfect turn of phrase, but now I just sit here rehearsing hello like it's a final exam, and still somehow fail it.`
- `Young female, high, energetic, bright. Clear, youthful, bouncy rhythm. Adventurous, friendly, fast-paced, warm magical guardian tone.`
  Text: `Hey, easy now, the tide's with us today! Stay close, keep smiling, and if trouble splashes ashore, I'll meet it first, bright as noon and twice as stubborn.`

## Voice Direction benchmark: by category

From the [TTS-Voice-Direction-Benchmark dataset](https://huggingface.co/datasets/BreezeBlue/TTS-Voice-Direction-Benchmark). It has 700 cases and a reference clip for each; the instruction median is 14 words. Category names come from the [benchmark repo](https://github.com/breezeblue-ai/TTS-Voice-Direction-Benchmark).

- **Accent**: `Use a strong, consistent Nigerian English accent throughout the line.`
- **Acoustic attributes**: `Speak at a relaxed, leisurely tempo.` · `The speaker's intonation rises continuously throughout the entire sentence.` · `The speech is delivered in a high-speed blur, speaking extremely fast without pausing.`
- **Emotion**: `Speak in a hushed tone, filled with profound awe.` · `The speaker delivers the lines with a biting, bitter tone, filled with sharp resentment.`
- **Physiological state**: `Speaking through heavy laughter, making the words barely intelligible.` · `Slurred speech, with words running together carelessly.` · `A strained voice, trembling from physical exertion.`
- **Communicative intent**: `Speak with an earnest, desperate tone, pleading with the listener for a small favor. The voice should sound slightly breathless and highly persuasive, begging for leniency.` · `Speak with urgent, projecting volume and a sharp, commanding tone to immediately halt the listener and alert them to imminent physical danger.`
- **Role**: `Act as an unflappable, confident fixer. Speak with a smooth, nonchalant delivery, using relaxed articulation and a steady, unhurried pace to project absolute control over the situation.` · `A dominating, no-nonsense executive speaking with strict, icy authority and a sharp, demanding cadence.`
- **Composition** (several dimensions at once): `Speaking with a soft Irish accent, expressing deep contentment and reassuring the listener that everything is perfect.` · `An exhausted but welcoming pub bartender.`
- **Variation** (a shift at a named point):
  - `Start with a confident, reassuring tone. At the word 'Wait', suddenly shift to terrified, breathless alarm as if reacting to a frightening noise.`
    Text: `There's absolutely nothing to worry about, I've done this a hundred times before. Wait... did you hear that sound? Something's definitely not right here.`
  - `Start with a loud, energetic, and jubilant shout. Suddenly, at "The scan shows", drop to a quiet, breathy, and weak whisper of despair.`
    Text: `We did it! We actually won the championship, all that training paid off, this is the best day ever! The scan shows a torn ligament? I'm out for the season?`
- **Vocal events** (instruction, plus a tag in the text): `Produce a hiccup near the beginning of the line.` Text, shortened, with the tag rewritten in Breeze syntax: `I told you not to let (hiccups) me drink that soda so fast.`
