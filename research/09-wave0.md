# 09 — Wave 0 scaffold (2026-11-23)

## Status
`npm run build`, `npm run typecheck`, `npm test` (4 files, 10 tests) and `npm run e2e` (1 smoke: extension loads, popup opens) all pass.
Playwright Chromium is installed (chromium-1255 + headless shell).

## Toolchain (installed versions)
typescript 7.0.2 (native `tsc`), esbuild 0.28.2, vitest 5.1.1, jsdom 31.0.1, @playwright/test 1.65.1, @types/chrome 0.3.7, @types/node (added: needed by the Playwright config, the fixtures and the build/test helpers).

## Commands
| Command | What |
|---|---|
| `npm install` | deps |
| `npm run build` | `node build.mjs` → `dist/` (load unpacked) |
| `node build.mjs --outdir build-<letter>` | private build for Wave 1 agents (gitignored) |
| `node build.mjs --watch` / `--sourcemap` | dev |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` / `npx vitest run tests/unit/<letter>-*` | unit tests (jsdom) |
| `npm run e2e` (`HEADED=1` for a window) | Playwright, persistent context loading `dist/` (`AUTODUB_DIST` overrides) |
| `npm run icons` | regenerate `icons/*.png` (pure Node) |

## Tree
```
manifest.json  build.mjs  package.json  tsconfig.json  vitest.config.ts  playwright.config.ts  .gitignore
icons/icon{16,32,48,128}.png         scripts/make-icons.mjs
src/shared/      types.ts (FULL)  messages.ts (FULL)  settings.ts (FULL)  feedback.ts (D stub)
src/background/  index.ts (FULL router)  translate.ts (A)  tts.ts (B)  cache.ts (B)
src/content/     main-hook.ts  yt.ts  captions.ts  pipeline.ts  translate-local.ts   (A)
                 session.ts  index.ts  sync/{fit,scheduler,pitch,player}.ts         (C)
                 voice/{engine,webspeech,audio,voices}.ts                           (B)
                 ui/player-ui.ts                                                    (D)
src/popup/       popup.html  popup.css  popup.ts                                    (D)
tests/unit/      {a,b,c,d}-smoke.test.ts   helpers/chrome-mock.ts (shared storage/runtime/tabs mock)
tests/e2e/       fixtures.ts (context + extensionId)  smoke.spec.ts
```

## What is already implemented (beyond stubs)
- `shared/types.ts`: all §8 types + extras below.
- `shared/messages.ts`: `Msg` union (flat payloads: `{type:'TRANSLATE', texts, from, to}` etc.), `MsgResultMap`, `MsgResponse<T>`, `ResponseOf<type>`, `sendToSW`/`sendToTab` (never reject; 25 s client timeout → `TIMEOUT`; no listener → `NETWORK`), `broadcastStatus`, `toMsgError`, `isSWMsg`, `BridgeMsg`, `BRIDGE_SOURCE`, `isBridgeMsg`.
- `shared/settings.ts`: defaults, `normalizeSettings` (clamps; voiceSpeed 0.75–1.3), `loadSettings`, `saveSettings(patch)` (merges `voiceByLang`), `onSettingsChanged(cb) → unsubscribe`, `getSecrets`, `saveSecrets(patch)` (`''`/undefined removes a key), `LANGS`, `LANG_INFO` (names, native, bcp47, rtl), `STORAGE_KEYS`.
- `background/index.ts`: router for TRANSLATE (needs OpenAI key → `NO_KEY`; chunks by 40; checks line count), TTS (audio cache in `audio` store keyed by sha256 of engine/voice/lang/speed/text, then `synthesize`), CACHE_GET/PUT (`lines` only). Each network call: 20 s `AbortController` + race → `TIMEOUT`. Key text redacted from error messages. Ignores messages from other senders and non-SW types (STATUS). `commands` `toggle-dub` → `DUB_TOGGLE` to active tab. `handleMessage` and `onCommand` exported for tests.
- Constants `CPS`, `MAX_RATE` in `sync/fit.ts` (data from §5).

## Deviations / additions vs §8 (all additive; no §8 name changed)
1. `manifest.json` `minimum_chrome_version` = **"138"** (spec §7 says "116"): §3.5 relies on the Translator API (Chrome 138+). Requested by the orchestrator.
2. **Optional params added** (allowed by §9): `translateBatch(..., signal?)`, `synthesize(req, secrets, signal?)` (SW timeout/abort); `TtsEngine.prepare(line, lang, voice?)` (gender-matched voice per line); `mergeSentences(cues, lang, opts?: {asr?})`; `listVoices/pickBestVoice/pickVoiceFor(..., engine?)`; `getLines(videoId, lang, onProgress?)`; `estimateMs(text, lang, cal?)`.
3. **`VoiceInfo` is defined in `shared/types.ts`** and re-exported from `voice/voices.ts` (`export type { VoiceInfo }`), because `messages.ts` (`LIST_VOICES` response) needs it and shared must not import from content. B still "owns" its shape; changes go through A via a request.
4. **Extra shared types** in `types.ts`: `Gender`, `ErrorCode` (= `DubErrorCode | 'NETWORK' | 'NO_KEY' | 'TIMEOUT'`), `CacheStore`, `Json3`/`Json3Event`/`Json3Seg`, `AudioTrackInfo`, `PlayerResponse`, and class **`DubError(code, message)`** — thrown by A/B/C code, mapped to `{ok:false,error}` by routers.
5. `BridgeOp` includes `'translate'` (MAIN-world Translator API fallback named in §3.5).
6. Contract helpers not named in §8: `engine.ts` `PlayEnd`, `PlayHandle {done, stop, pause, resume, setRate?, setVolume?}`, `Prepared {line, lang, engine, voice?, url?, knownMs?}`; `scheduler.ts` `SchedulerOptions` (+ public `tick()`, `seek`, `pause`, `resume`, `setLines`); `fit.ts` `Calibration`; `player.ts` `PlayerHandlers`, `PlayerWatcher.duck/restoreVolume/isAdShowing`; `session.ts` `DubSessionOptions`, `DubSession.toggle/getStatus/onStatus/currentLine/updateSettings`; `player-ui.ts` `PlayerUIApi`, `PlayerUI`; `popup.ts` `initPopup(root)`; `main-hook.ts` `installHook()`; `index.ts` `bootstrap()`. Owners may extend these (optional members only once others depend on them).
7. `SpeakerPitch` takes the `<video>` in its constructor; `start()` returns `boolean` (false = WebAudio failed).
8. Popup uses an `iife` bundle (plain `<script src="popup.js">`); background is ESM (`"type":"module"`).

## Notes for Wave 1
- Stubs throw `Error('TODO <owner>')` or return safe empties (`null`, `[]`, `'unknown'`, `{state:'idle'}`), so the built extension loads without errors.
- Use `installChromeMock()` from `tests/unit/helpers/chrome-mock.ts` for storage/runtime/tabs. It is Wave 0 property: ask for changes in your `research/wave1-<L>.md`, or copy it into your own test file.
- `getSecrets`/`saveSecrets` live in `shared/settings.ts`; content code imports only the other exports (D's grep test enforces this).
