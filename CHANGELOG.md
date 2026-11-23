# Changelog

## v1.2.0 · 2026-11-23 · Emotion in the voice

- **Expression:** the dub now has ups and downs. Each line gets an emotion from the subtitles (!, ?, words in CAPITALS, "wow", "let's go", money, NBA calls) and from how excited the scene sounds; Chrome's free built-in AI can tag emotions too.
- **Livelier neural voice:** wider intonation (pitch range on excited lines 10 → 19 semitones), higher pitch when excited, questions rise at the end, key words stressed, louder when someone shouts. Web Speech voices also vary pitch and volume.
- **Expression slider** in the popup (Flat ↔ Lively, default 70 %); ▶ Test plays a lively line.
- Research on free expressive voices and fine-tuning: `research/v12-expressive-tts.md`.
- 340 unit tests.

## v1.1.1 · 2026-11-23

- French now uses the free neural voice **Siwis** by default (no need to open Engine). The male neural voice Tom is used when a man speaks. Until the voice is downloaded the first time, the Mac voice speaks.

## v1.1.0 · 2026-11-23 · Better French, smoother voice

- **Neural voices (free, on your computer):** natural Piper voices, French female (Siwis) and male (Tom), plus Spanish, English, Arabic and Turkish. Downloaded once (~60 MB per voice), then offline. Recommended for French.
- **Best Mac voices first:** Premium > Enhanced > Google > compact, fr-FR before fr-CA, with steps to download Audrey (Premium) / Thomas (Enhanced).
- **Smooth pacing:** whole passages are planned with one steady speed; no more silence followed by fast talking. Each voice's real speed is learned. Synthetic fast-talker test: 100 % of lines spoken (v1.0: 68 %), longest silence 0.4 s.
- **Smooth speaker switching:** the voice changes only on a new-speaker mark in the subtitles or 2 clear lines in a row, at most every 6 s. A shouting man stays a man.
- **Cleaner French:** fillers, stutters, [Music] tags, lyrics and ALL CAPS removed before translating; French made easy to say (10 000 dollars, tir à trois points, N B A, Mister Beast).
- **Smart French (optional, free):** Chrome's built-in on-device AI shortens French lines that are too long for their slot.
- **Official audio first:** when YouTube has an official French track (many MrBeast videos), AutoDub switches to it instead of the AI dub.
- 289 unit tests.

## v1.0.0 · 2026-11-23 · First release

- One-click dubbing of YouTube videos into French, Arabic, English, Spanish or Turkish, from the video's subtitles.
- Free translation chain: YouTube's translated subtitles → Chrome's built-in on-device translator → optional OpenAI key.
- Free Mac / Chrome voices by default; OpenAI or ElevenLabs voices with your own key.
- **Match speaker's voice:** male speaker → male voice, female → female (pitch-based best guess).
- **Continuous voice:** a sentence is never cut; the next one waits and speeds up slightly to catch up (≤ 2.5 s lag).
- Original audio stays low (10 %) for the whole dub, even when YouTube resets its volume; ads play normally.
- Dub button in the player, Alt+D, "AI dub" badge, 👍 / 👎 per line (kept on your computer).
- 193 unit tests.
