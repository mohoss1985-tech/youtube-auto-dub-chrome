# Wave 1 — B: voice engines + audio cache (2026-11-23)

## Status
`npx tsc --noEmit` is clean. `npx vitest run tests/unit/b-` passes 4 files and 66 tests. The full `npx vitest run` passes 7 files and 73 tests. `node build.mjs --outdir build-b` builds. `dist/` was not touched and nothing was committed. Dev dependency added: `fake-indexeddb`.

## Built
| File | What |
|---|---|
| `src/content/voice/voices.ts` | Gender table (macOS, Siri, Eloquence and Microsoft voice names for fr/ar/en/es/tr, plus the words "Female" and "Male"; Google voices are `unknown`). Ranking: Natural/Neural +40, Premium +35, Enhanced +30, Google +25, Siri +20, main region +5, Eloquence −8. Novelty voices (Zarvox, Bad News, and similar) are removed. Waits for `voiceschanged` for up to 3 s. Holds the API voice lists (13 OpenAI voices and 15 ElevenLabs default voices, each with a gender). Also contains `pickVoiceFor`, which gives a stable voice per gender. |
| `src/content/voice/webspeech.ts` | `WebSpeechEngine`. `prepare` waits for voices. `play` splits text into chunks of at most 180 chars at punctuation, keeps strong references to the utterances, re-applies the voice on every utterance, and arms a watchdog of `est*1.6+1500 ms` (then `cancel()` and go to the next chunk). It also has pause/resume (the watchdog pauses too), stop, `stopAll`, rate/volume clamping, and `setRate`/`setVolume` for the next chunk. |
| `src/content/voice/audio.ts` | `AudioEngine`. `prepare` sends a `TTS` message to the SW, decodes base64 to a Blob URL, and reads the duration from `<audio>` metadata into `knownMs` (fallback: estimate from mp3 size). It runs at most 3 requests at once, merges duplicate in-flight requests, and memoises prepared lines. Blob URLs are kept in an LRU of 60 and revoked on eviction or on `dispose()`. `play` uses one `<audio>` per line (`playbackRate`, `preservesPitch`, `volume`). On error it throws `DubError` and calls `onFallback(err)` once. |
| `src/content/voice/engine.ts` | Contract plus `createEngine(id, opts?)`. |
| `src/background/tts.ts` | `synthesize`. OpenAI: `gpt-4o-mini-tts` with mp3, sends a short `instructions` (language plus "clear, friendly voice suitable for children"). ElevenLabs: `eleven_flash_v2_5` with `mp3_44100_64` and `language_code`. Aborts after 20 s, and an external signal also aborts it. The key is only sent in a header. Error mapping: 401/403 → NO_KEY, 429 → RATE_LIMITED, other HTTP errors → ENGINE_ERROR, fetch failure → NETWORK, abort → TIMEOUT. Provider error text is cleaned (exact keys and anything like `sk-…` are removed) and cut to 200 chars. Nothing is logged. |
| `src/background/cache.ts` | IndexedDB database `autodub` v1 with stores `lines` and `audio` (keyPath `key`, index `at`). A get refreshes the LRU timestamp. A put on `audio` keeps a running size total; above 200 MB it evicts the oldest entries. Falls back to an in-memory map when IndexedDB is missing, so the jsdom smoke tests still work. |

## Public API (additions beyond §8 are all optional or extra exports)
- `createEngine(id, opts?: AudioEngineOptions)`, where `AudioEngineOptions = {send?, onFallback?, speed?, probe?}`. `TtsEngine.dispose?()` was added as an optional member.
- `AudioEngine.onFallback(cb)`, `AudioEngine.dispose()`, `b64ToBlob(b64, mime)`, `probeDurationMs(url)`, `MAX_CONCURRENT`.
- `WebSpeechEngine`, `splitText(text, max=180)`, `watchdogMs(text, lang, rate)`.
- `listVoices(lang, engine='webspeech')`, `pickBestVoice(lang, engine?, preferredId?)`, `pickVoiceFor(lang, gender, engine?, preferredId?)`, `resetVoiceChoices()`, `gendersOf(voices) → {male, female}` (for the popup's "only one gender installed" note), `genderFromName`, `rankWebVoices`, `chooseVoice`, `loadWebVoices`, `findWebVoice`, `defaultApiVoice`, `NO_VOICE_HELP`, `OPENAI_VOICES`, `ELEVEN_VOICES`.
- `pickVoiceFor` reads `settings.voiceByLang[lang]` unless `preferredId` is given. The chosen voice is returned for its own gender. For the other gender it picks the best voice of that gender, preferring the chosen voice's region. Results are memoised per (engine, lang, gender, chosen voice). An `unknown` voice (Google) counts as female, but a voice that is truly female in the table is preferred.
- `synthesize(req, secrets, signal?)`, `scrub`, `bufToB64`.
- `cacheGet`, `cachePut`, `cacheEvict(limit?)`, `_resetCacheForTests(cap?)`.

## Notes for C (session)
- Prefetch window (30 s ahead) is up to the session. Call `engine.prepare()` freely: the engine itself caps requests at 3 at a time and removes duplicates.
- `stopAll()` (on seek) keeps prepared Blob URLs valid, so a seek back can reuse them. Call `dispose?.()` in `DubSession.stop()`.
- Fallback: pass `onFallback` in `createEngine(id, {onFallback})`, then switch to `createEngine('webspeech')` and show a toast.
- Call `resetVoiceChoices()` at session start or when `voiceByLang` changes.
- `PlayEnd` for WebSpeech is `'ended'` even after a watchdog cancel (the line is over and we moved on).

## Open issues
- The ElevenLabs default voice IDs and the OpenAI voice genders come from memory and have not been checked against live APIs (no paid calls were allowed). The ElevenLabs voice list should come from `GET /v1/voices` when a key is present (v1.1).
- The gender table has not been checked against a real Mac voice list. Run a voice probe on the owner's Mac (`speechSynthesis.getVoices()`) and add any missing names.
- The pause()+resume() fix for Chrome's ~15 s cutoff on network voices is not used, because chunks are ≤ 180 chars (about 12 s).
- `probeDurationMs` relies on `<audio>` metadata, and duration for VBR mp3 can be slightly off. Fine for `fit`.
- The OpenAI `instructions` field is only sent with `gpt-4o-mini-tts` (the model is fixed, so this is fine).

## Requests
1. **A (`background/index.ts`)**: the router already takes care of cache and timeout. No change is needed. Optionally, call `cacheEvict()` once at SW startup.
2. **A (`shared/types.ts`)**: none. `VoiceInfo` is fine as is.
3. **D (popup)**: use `gendersOf(await listVoices(lang))` to show "Only female voices installed for Turkish" plus `NO_VOICE_HELP`. The voice list (`LIST_VOICES`) includes `gender` for male/female labels.
4. **C (`content/index.ts`)**: the `LIST_VOICES` handler should call `listVoices(lang, settings.engine)`. `TEST_VOICE` can use `createEngine(engine).prepare({id:'test',start:0,end:3,text}, lang, voice)` and then `play`.
