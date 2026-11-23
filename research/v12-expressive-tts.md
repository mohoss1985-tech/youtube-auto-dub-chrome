# v12: making the French dub less monotone (2026-11-23)

**Problem.** Piper `fr_FR-siwis-medium` sounds flat. Siwis was recorded as neutral read speech, and Piper (VITS) reproduces the *average* prosody of its training data. Because no style input goes into the model, the same sentence always comes out with the same melody. There are three ways to fix this:
- add a prosody layer around Piper (cheap, works in the browser);
- switch to a model that has emotion control;
- retrain Piper on expressive data.

## Sources
- Kokoro voices: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
- Chatterbox: https://github.com/resemble-ai/chatterbox · ONNX ports: https://huggingface.co/onnx-community/chatterbox-multilingual-ONNX, https://huggingface.co/Vocabook/chatterbox-multilingual-ONNX-q4, https://huggingface.co/hugbos/chatterbox-multilingual-ONNX-v2 · Transformers.js CFG gap: https://cdn.jsdelivr.net/npm/voxshot@0.3.0/README.md
- Supertonic: https://github.com/supertone-inc/supertonic, https://huggingface.co/Supertone/supertonic-2
- Kyutai: https://huggingface.co/kyutai/tts-1.6b-en_fr · Pocket TTS: https://github.com/kyutai-labs/pocket-tts
- XTTS-v2: https://huggingface.co/coqui/XTTS-v2
- F5 French: https://huggingface.co/RASPIAUDIO/F5-French-MixedSpeakers-reduced
- Voxtral TTS: https://mistral.ai/news/voxtral-tts/, https://docs.mistral.ai/models/voxtral-tts-26-03.md
- mlx-audio: https://github.com/Blaizzy/mlx-audio
- Att-HACK: https://openslr.org/88/ · CaFE: https://zenodo.org/record/1219620
- Piper training: https://github.com/rhasspy/piper/blob/master/TRAINING.md, https://github.com/rhasspy/piper/discussions/308, https://huggingface.co/datasets/rhasspy/piper-checkpoints
- Piper parameters: https://deepwiki.com/TigreGotico/phoonnx/5.2-synthesis-configuration
- WORLD in WASM: https://delta-kimigatame.github.io/TSWorld, https://github.com/mmorise/World · Rubber Band WASM (GPL): https://github.com/Daninet/rubberband-wasm
- Chrome Prompt API: https://developer.chrome.com/docs/extensions/ai/prompt-api, https://groups.google.com/a/chromium.org/g/blink-dev/c/iR6R7-nQeHI

## Models table
Expressiveness (Expr) and French quality (FR) are scored 1–5. I took the speed figures from the sources. Figures marked "est." are my own estimates and have not been measured.

| Model | Expr | FR | Where it runs | Size | Licence | How you control emotion | Clone from the original speaker |
|---|---|---|---|---|---|---|---|
| **Chatterbox Multilingual V3** | 5 | 4 | Mac (cpu/mps; mlx-audio). Browser only through community ONNX ports (q4 is 790 MB, needs WebGPU and ~8 GB RAM). Transformers.js does not yet support the CFG step that multilingual needs, so a browser port is not dependable | 500M | MIT. Every output carries the Perth watermark. Repo unmaintained since Aug 2026 | `exaggeration` slider (0.5 is the default; expressive ≈ 0.7+, with `cfg_weight` ≈ 0.3) | Yes, from a ~10 s clip, fully local. The README warns that a reference clip in another language carries its accent over |
| **Supertonic 3** | 3 | 3–4 | **Browser**: official onnxruntime-web WebGPU/WASM example. They claim "under 1 s in a Chrome extension" | 99M | Code MIT, weights **OpenRAIL-M** (commercial use OK, with use restrictions). Repo archived | 10 inline tags (`<laugh>`, `<breath>`, `<sigh>`…) plus preset styles (M1–M5, F1–F5) | No (Voice Builder closes after Aug 2026) |
| **Pocket TTS (Kyutai)** | 3 (copies the reference clip's style) | 4 | Mac CPU: **~6× real time on an M4 Air, 2 cores**. Community ONNX and Rust-WASM ports exist | 100M | MIT | Through the reference clip only (an excited clip gives excited speech) | Yes, local, from a WAV |
| **Kyutai TTS 1.6B en_fr** | 4 | 5 (French-native lab) | Mac (MLX official). Too big for a browser | 1.8B | CC-BY 4.0 | Preset voice embeddings (the tts-voices repo) | Only from pre-computed embeddings |
| **Voxtral 4B TTS** | 5 | 5 | Mac only, heavy (est. RTF > 1 on M-series) | 4B | **CC BY-NC 4.0**. API alias deprecated on 2026-10-31 | Preset expressive voices | Not in the open weights (API only) |
| **XTTS-v2** | 4 | 4 | Mac CPU/MPS (est. RTF ~0.5–1 on CPU) | ~470M | **CPML (non-commercial)**. Coqui no longer exists | Copies the emotion of the reference clip | Yes, from a 6 s clip |
| **F5-TTS French** (RASPIAUDIO) | 4 | 4 | Mac MPS (flow matching, est. RTF 0.3–1) | 336M | **CC BY-NC 4.0** | Copies the reference clip's prosody | Yes |
| **Kokoro-82M** `ff_siwis` | 2 | 3 (grade B-, under 11 h of data) | Browser (kokoro.js, ~80–300 MB) | 82M | Apache-2.0 | None | No |
| **Piper siwis/tom** (current) | 1–2 | 3–4 | Browser, RTF 0.06–0.15 | 63 MB | CC BY 4.0 / AGPL | `noise_scale`, `noise_w`, `length_scale` | No |
| Dia, Orpheus, CSM, OuteTTS, Parler, Sesame | – | **no French** in mlx-audio or the official releases | – | – | – | – | – |

Takeaways:
- **The only model that combines real emotion control, French, a permissive licence and local voice cloning is Chatterbox Multilingual**, and it runs on the Mac, not in the browser.
- **The only light browser model that adds anything over Piper is Supertonic 3**, through its tags and styles. Its gain is moderate and it cannot clone voices.
- Kokoro French uses the same Siwis data as Piper, so it gives no expressiveness gain.

## Fine-tuning
**Free expressive French datasets**

| Dataset | Content | Licence | Usable? |
|---|---|---|---|
| Att-HACK (OpenSLR 88) | 25 speakers × 100 sentences × 4 attitudes (friendly, distant, dominant, seductive), ~30 h | CC BY-NC-ND | Research only. The "ND" term likely forbids sharing a model derived from it, even with friends |
| CaFE | 12 actors, 6 sentences, 6 emotions plus neutral, Québec French | CC BY-NC-SA 4.0 | Too small (≈900 clips, 6 sentences) and the accent is wrong |
| LibriVox French (public domain) | Audiobooks, many of them lively children's stories with dialogue | PD | **Best option**: choose one lively reader |
| **Synthetic data**: Chatterbox outputs (MIT) | Unlimited: you generate it yourself with exaggeration and style labels | MIT (outputs are watermarked) | **Best for adding style control** |

**What fine-tuning can and cannot do.** Fine-tuning Piper on one expressive reader gives a voice that is *livelier on average*. It still cannot follow the emotion of each line, because VITS takes no emotion input. The trick that adds control is to **train a multi-speaker Piper model in which each "speaker ID" is a style** (neutral / excited / question / whisper / shout). AutoDub already passes `speaker_id`, so choosing a style per line costs nothing at runtime.

**Steps**
1. Generate 2–4 h of French with Chatterbox on the Mac. Use one reference voice and 4–5 style buckets (exaggeration from 0.3 to 1.0, plus prompts written in an excited or a calm register). Kids' YouTube-style lines work well, as do exclamations and questions. Alternatively, cut a LibriVox reader into clips.
2. Transcribe the clips with Whisper and filter out the bad ones. Write the `metadata.csv` as `wav|speaker|text`.
3. Fine-tune from the `fr_FR-siwis-medium` checkpoint (rhasspy/piper-checkpoints) with piper1-gpl `--resume_from_checkpoint`, about 1000 additional epochs (TRAINING.md) and `--validation-split 0`.
4. Export to ONNX. The result is about 63 MB and is a drop-in replacement in the current engine.

**Free compute**
- Google Colab free T4: one user fine-tuned on 100 clips for 3.5 h before Colab became unstable. Plan for session limits and save checkpoints to Drive.
- Kaggle: roughly 30 GPU-h per week of T4/P100 (from memory, not checked), with 12 h sessions. This is the most practical free option.
- Apple Silicon: PyTorch Lightning on MPS works but is slow, and some ops fall back to the CPU. Estimate 3–5× slower than a T4. That is fine for an overnight run of about 200 epochs, but too slow for 1000.

**Estimate**
- Dataset: 1 weekend.
- Training: 10–20 GPU-h, which is 1–2 Kaggle weeks.
- Expected result: a clearly livelier, style-switchable Piper at the same speed. Expect artefacts and some loss of clarity in the high-energy styles.
- About 30% risk of a disappointing first attempt.

This is worth trying **after** the DSP layer, not instead of it.

## DSP tricks (no retraining, browser)
1. **Vary Piper's parameters per line.** The voice defaults are noise_scale 0.667, noise_w 0.8 and length_scale 1.0. Lower noise values sound cleaner but more monotone, higher values sound livelier but can produce artefacts. Presets:
   - neutral: 0.667 / 0.8 / 1.0
   - excited ("!"): **0.85 / 1.0 / 0.88**
   - question: 0.75 / 0.9 / 1.0
   - calm or sad: 0.5 / 0.6 / 1.1

   Keep noise_w ≤ 1.1, because values above 1 cause stutters. Add ±5% random jitter to `length_scale` so that lines don't all have the same tempo. The model already takes these values as input tensors (`scales`), so they cost nothing.
2. **Expand the F0 contour.** Two options:
   - **tsworld** (WORLD in Emscripten WASM, npm). Extract F0 with Harvest, then compute `f0' = mean + k·(f0 − mean)` with k = 1.3–1.6 for excited lines. Add a +2–4 semitone rise over the last 300 ms for "?" and a fall for ".". Resynthesise with CheapTrick/D4C/Synthesis. WORLD itself is modified-BSD. I did not check tsworld's licence or its speed (est. RTF 0.2–0.5 at 22 kHz in a Worker). WORLD adds a slight buzz, so apply it only to expressive lines.
   - The cheaper fallback is a PSOLA or WSOLA you write yourself (~200 lines of JS, so no licence issue).
   - **Avoid rubberband-wasm**: it is GPL-2.0.
3. **Energy envelope.**
   - Raise the gain by +3–4 dB on emphasised words. Estimate their position from character offsets, since Piper's ONNX does not return alignments.
   - Excited lines: gentle `DynamicsCompressorNode` plus a +2 dB high-shelf. Calm lines: −3 dB tail.
4. **Text-side cues.**
   - Keep and amplify "!" and "?" (espeak changes intonation on them).
   - Split long sentences at commas into separate Piper calls, so each part gets its own declination contour. Insert 120–250 ms pauses.
   - Map interjections ("Wow" → "Waouh !", "Let's go" → "C'est parti !") and treat CAPS words as emphasis.
5. **On-device emotion tagging.** The Chrome Prompt API (Gemini Nano) has shipped for extensions, but it accepts only **en/ja/es**. That is enough: tag the **English source caption** with `{style: neutral|excited|question|calm|shout, emphasis:[words]}` and apply the result to the French line. Fall back to punctuation heuristics when the model is not available (≥ 22 GB disk, desktop only). Process a batch of 10 lines per prompt ahead of playback.

## Recommendation
**Ship now (v1.2, browser, free, installs by unzip)**
- A "Prosody" module in the Piper worker. Each line is classified by punctuation plus Gemini Nano (optional) and gets a parameter preset, ±5% tempo jitter, F0 expansion (start with PSOLA; try tsworld if it stays at RTF < 0.4), an energy envelope, and pauses at commas.
- A popup slider **"Expression: Calm · Normal · Lively (default for kids)"** that scales k and the noise values.
- This should take the dub from "robot" to "storyteller" at a cost of ~0.1–0.3 RTF.
- Pick **Tom** (44.1 kHz, more natural) as the default male voice for MrBeast and NBA lines.
- Optional experiment: **Supertonic 3** as a second "Lively" browser voice (OpenRAIL-M, about 100–250 MB, with `<laugh>`/`<breath>` tags on MrBeast-style lines). Gate it behind a flag until someone has checked that its French matches Siwis.

**Optional "Local expressive engine" (Mac)**
- Setup: `pip install mlx-audio`, then `mlx_audio.server --port 8000` (OpenAI-compatible `/v1/audio/speech`). AutoDub adds a `local` engine that POSTs to `http://localhost:8000`, with `host_permissions` for localhost.
- Model: **Chatterbox Multilingual** with `exaggeration` 0.6–0.9, driven by the same style tags.
- Speed: est. RTF 0.5–1.5 on M-series. That is enough with prefetch for videos that already have captions, but not for instant start.
- For speed, use **Pocket TTS** (MIT, ~6× real time on CPU) with a French reference clip that is expressive.
- **Voice cloning of the original speaker** works fully locally: take 10 s of MrBeast from the tab audio. Because the reference is English, the French will have an English accent, which may even sound fitting. Offer it as an opt-in, and keep the clips on the device only.
- XTTS-v2, F5-FR and Voxtral are non-commercial: personal use only.

**Later (fine-tuning)**
- A **style-ID multi-speaker Piper** trained on 2–4 h of French synthesised with Chatterbox (MIT), fine-tuned on Kaggle, ~1–2 weekends.
- This gives Chatterbox-like style switching at Piper speed, in the browser.
- Do not train on Att-HACK or CaFE for anything shared, because of their NC/ND licences.
