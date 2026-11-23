# AutoDub — DESIGN_SPEC (v1)

Single source of truth. Research: `research/01..04`. Goal: `GOAL.md`. Codename "AutoDub" (rename before any store listing; see §10).

## 0. Identity
One click on a YouTube watch page → the video's captions are spoken in French, Arabic, English, Spanish or Turkish, in sync, with the original audio ducked. Free browser voices by default; OpenAI / ElevenLabs with the user's own key as an upgrade. Desktop Chrome, personal use, no server.

## 1. Conflicts resolved
| # | Conflict | Decision |
|---|---|---|
| C1 | Offscreen document (kit) vs content-script audio (02, 04) | **No offscreen doc.** API audio plays in the content script via `<audio>` + Blob URL. Web Speech runs in the content script. |
| C2 | TV via Cast tab | **Dropped from v1** (owner, Checkpoint 1). No "Watch on TV" UI. README lists it under v2. |
| C3 | IndexedDB cache "per video" in content script (02) | Content-script IndexedDB belongs to youtube.com's origin. **Cache lives in the service worker** (extension origin); audio crosses messaging as base64. |
| C4 | Keys "never readable by content script" (04 #9) | `storage.local` is always readable by content scripts (`setAccessLevel` only affects `storage.session`). Keys are stored under a separate `secrets` key that **only SW + popup read**; content code never imports `getSecrets`. Enforced by a unit test that greps `src/content/**` for `secrets`. |
| C5 | Which LLM translates when `tlang` fails | **OpenAI key only** (ElevenLabs can't translate). Model is a setting, default `gpt-4o-mini`. No OpenAI key and no `tlang` → `NO_TRANSLATION` error state. |
| C6 | OpenAI `/v1/audio/speech` reported to shut down 2027-01-06 (02, single source) | Unverified. Engines sit behind `TtsEngine`; swapping provider = one file. |
| C7 | Popup "Original audio" vs separate dub volume (03) | Both: `duckLevel` (default 0.15) and `dubVolume` (default 1.0). |
| C8 | Hotkey Alt+D (03) | Yes, via manifest `commands`; SW forwards to active tab. No extra permission. |

## 2. Architecture
```
 YouTube tab                                              Extension
 ┌──────────────────────────────┐                ┌───────────────────────────┐
 │ MAIN world: main-hook.ts     │ window.        │ Service worker            │
 │  fetch/XHR timedtext capture │ postMessage    │  router (index.ts)        │
 │  getPlayerResponse, json3    │◄──────────────►│  translate.ts (OpenAI)    │
 ├──────────────────────────────┤                │  tts.ts (OpenAI/11Labs)   │
 │ ISOLATED: content/index.ts   │ chrome.runtime │  cache.ts (IndexedDB)     │
 │  yt bridge, captions, sync,  │◄──────────────►│  commands (Alt+D)         │
 │  voice engines, player UI    │                └───────────────────────────┘
 └──────────────────────────────┘                           ▲
            ▲  chrome.tabs.sendMessage / runtime STATUS     │ storage.local
            └───────────────── Popup (popup/*) ─────────────┘
```
- **MAIN hook** (`document_start`): captures the player's own `/api/timedtext` URLs (PO token), fetches json3 with page cookies.
- **Isolated content script** (`document_idle`): everything else on the page.
- **Service worker**: stateless proxy for network calls needing keys + cache. Each request ≤ 20 s, then abort → content falls back to Web Speech.
- **Popup**: settings, status, test voice, keys.

## 3. Caption + translation pipeline (owner A)
1. On `yt-navigate-finish` (+`popstate`) for `/watch?v=` → `DubSession` is created only when the user turns dub on.
2. `getPlayerResponse()` via bridge (`movie_player.getPlayerResponse()`, fallback `ytInitialPlayerResponse` if videoId matches).
3. `pickTrack(tracks, target)`: human track first (`kind !== 'asr'`), prefer one already in target lang; else ASR.
4. `getJson3(track, videoId, tlang?)` in MAIN world, order: captured URL → `performance` entry → `baseUrl` (if no `exp=xpe`) → enable CC programmatically, wait ≤ 3 s for capture, restore CC state, hide caption window while we own it. Rewrite `fmt=json3`, set/remove `tlang`, keep `pot/c/exp/signature`. Empty body → next step. 429 → `RATE_LIMITED`.
5. Translation order: track already in target → none. Else `tlang` (one try per video+lang). Else **Chrome built-in Translator API** (free, on-device, Chrome 138+: `Translator.availability/create({sourceLanguage,targetLanguage})`; model download on first use → status "Downloading French translator…"; A must verify it is exposed in the content-script context, else run it in the MAIN world via bridge op `translate`). Else OpenAI via SW (`TRANSLATE`, batches of ≤ 40 lines, keep line count). Else error `NO_TRANSLATION`. **Kids requirement (owner, Checkpoint 2):** a video with a single-language transcript must dub for free into any of the 5 languages.
6. `parseJson3` → `Cue[]` (drop no-`segs` and `"\n"` events; end capped at next start).
7. `mergeSentences(cues, lang)` → `Line[]`: join cues until sentence punctuation (`. ! ? … 。 ؟ ؛`) or gap > 1.2 s or length > 180 chars / ~12 s; ASR (no punctuation) splits on gap > 0.7 s or 120 chars. Translate **after** merging (better sentences).
8. Cache `lines:<videoId>:<lang>` in SW IndexedDB.
9. Also report `audioTracks` (YouTube's official/auto-dub tracks) → popup banner "YouTube has an official <lang> track" (no auto-switch in v1; banner explains how to pick it in ⚙).

## 4. Voice engines (owner B)
```ts
interface TtsEngine {
  id: EngineId;
  prepare(line: Line, lang: Lang): Promise<Prepared>;      // API engines: fetch+cache bytes; WebSpeech: no-op
  play(p: Prepared, rate: number, volume: number): PlayHandle;
  stopAll(): void;
}
```
- `WebSpeechEngine`: waits `voiceschanged` (≤ 3 s), keeps utterances in an array (GC bug), re-applies chosen voice every utterance, watchdog `est*1.6+1500 ms` → cancel. Splits > 180 chars.
- `AudioEngine` (`openai` | `elevenlabs`): `prepare` sends `TTS` to SW, gets base64 → Blob URL, decodes duration (`knownMs`). Plays via one reusable `<audio>` element per line; `playbackRate` = rate.
- Prefetch window: **30 s ahead**, max 3 concurrent `TTS` requests.
- `listVoices(lang)` ranks Web Speech voices: names with Natural/Neural/Google/Premium/Enhanced first; macOS enhanced for ar/tr. None → `NO_VOICE` with help text (System Settings → Accessibility → Spoken Content → System voice → Manage voices).
- OpenAI: `POST https://api.openai.com/v1/audio/speech` model `gpt-4o-mini-tts`, format `mp3`. ElevenLabs: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` model `eleven_flash_v2_5`, `mp3_44100_64`.
- **Speaker gender match (owner request, kids use):** `VoiceInfo` has `gender: 'male'|'female'|'unknown'`, from a name table for macOS/Google voices per language (e.g. fr Thomas=m, Amélie=f; ar Maged=m, Majed=m, Laila=f; tr Yelda=f, Cem=m; es Jorge=m, Mónica=f, Paulina=f; en Daniel=m, Samantha=f; Google voices: unknown→treated as female). `DubSession` asks C's `SpeakerPitch` for each line's median F0 (see §5) and B's `pickVoiceFor(lang, gender)` picks a voice of that gender; same voice for the same gender all video (no flip-flopping). Setting `matchSpeakerGender` (default on). Popup shows which voices are male/female; if a language has only one gender installed, say so with the install steps.
- Engine/key error → toast + automatic fallback to Web Speech for the rest of the session.

## 5. Sync algorithm (owner C)
- `fit(line, next, lang, knownMs?, cal?) → Plan`: slot to next start − 100 ms (cap end + 600 ms); rate = clamp(natural/slot, 1.0, 1.3) × user `voiceSpeed`; still too long → borrow gap; still too long → `maxMs` cut. CPS: en 14, es 15, fr 14, tr 13, ar 12.
- `Scheduler` driven by `video.currentTime` (50 ms tick + `requestVideoFrameCallback` when available), lead 80 ms (WebSpeech) / 30 ms (audio). A line > 300 ms late and not started is skipped. Overrun → cut. **Lag never carries over.**
- Player: `pause` → pause dub; `play` → resume; `seeking` → `stopAll` + binary-search cursor; `ratechange` → multiply rate; total > 1.3× skip lines that can't fit; `ad-showing` class (MutationObserver on `#movie_player`) → stop, restore volume, status `paused-ad`, resync after; `visibilitychange` hidden → keep running (audio continues) but WebSpeech pause if Chrome throttles (detect drift > 1 s → resync).
- **`SpeakerPitch` (C, `src/content/sync/pitch.ts`)**: WebAudio `createMediaElementSource(video)` → `AnalyserNode` → destination (audio unchanged; YouTube MSE media is same-origin so not tainted; if it throws, return 'unknown'). Autocorrelation F0 every 50 ms while dub is on; per line, median F0 over voiced frames of `[start,end]` of the *original* audio (ducking via a GainNode in this graph instead of `video.volume` when the graph exists). Classify: < 165 Hz → male, ≥ 165 Hz → female (children's voices ≥ 250 Hz map to female/child voice), < 30 % voiced frames → unknown (keep previous). Pitch is a heuristic: cartoon voices and music can fool it; it is a preference, never blocks dubbing. Caption hints override: `[Man]`, `[Woman]`, `(homme)`, `>> NAME:` speaker labels if present.
- Ducking: `video.volume` ramp to `duckLevel × userVolume` 150 ms before a line, restore 250 ms after end unless next line within 400 ms. Turning off restores the original volume immediately.
- `DubSession` (orchestrator): `start()` → pipeline → prefetch → scheduler; `stop()` restores everything; emits `DubStatus` changes. Time to first line is measured and logged locally.

## 6. UI (owner D)
### Tokens
- Type scale: 12 / 14 / 16 / 20 px; weights 400/600; system font stack (`-apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", sans-serif`).
- Spacing: 8-px grid (4 allowed for icon gaps). Radius 8 (controls), 12 (cards).
- One accent: `--accent: #3D5AFE` (hover `#2F49E0`). Neutrals: `#111418 / #5B6470 / #E6E8EB / #FFFFFF`; dark mode via `prefers-color-scheme`: bg `#14171B`, surface `#1C2026`, text `#E8EAED`, muted `#9AA3AE`, border `#2A3038`. Status colours only for status: ok `#1E8E3E`, warn `#B06000`, error `#C5221F`.
- Popup width 340 px. No gradients, no emoji-as-icons; inline SVG icons, 16 px.
### Popup (top → bottom)
1. Header: name + On/Off switch (large) + status line (Idle / Preparing… / Dubbing / Paused for ad / Error).
2. Banner slot (official YouTube track available; error with action).
3. Target language: 5 pinned (FR, AR, EN, ES, TR). Arabic labels RTL.
4. Voice: picker filtered by language and engine, quality-ranked, ▶ Test voice (one line; for API engines this is the only allowed paid call without asking).
5. Original audio slider (default 15 %), Dub volume, Voice speed 0.75–1.3×.
6. "Show translated subtitles" toggle (default off; RTL for Arabic).
7. Collapsible **Engine**: Browser (free) / OpenAI / ElevenLabs; key field (masked, Save, Remove), "Use a dedicated key you can revoke", cost hint (chars × price). Choosing an API engine calls `chrome.permissions.request` for its host; switching back removes it.
8. Footer: "Voice is AI-generated · No account · No server · Keys stay on this device."
States: loading (skeleton for voice list), empty (no voices for language → help text), error (message + action), not-on-YouTube ("Open a YouTube video to dub it").
### In-player UI (content script, Shadow DOM)
- **Dub button** in `.ytp-right-controls` before CC; states off / preparing (spinner) / on. One-time tooltip on first video.
- **"AI dub" badge** top-left of player while dubbing; dismissible (setting `showBadge`).
- **Thumbs up/down** on the current line (hover near badge) → `saveFeedback`.
- Subtitle overlay when enabled.
- Toasts (engine fallback, ad pause, errors).

## 7. Storage + privacy
- `chrome.storage.local`: `settings` (Settings), `secrets` ({openaiKey?, elevenKey?}) — SW + popup only, `feedback` (≤ 500 entries ring), `stats` (time-to-first-line samples), `onboarded`.
- SW IndexedDB `autodub` → stores `lines`, `audio` (LRU, cap 200 MB; evict oldest).
- Network: youtube.com (page's own), api.openai.com / api.elevenlabs.io only when chosen. Never log keys, never send captions anywhere else. No analytics. No remote code, no `eval`.
- Manifest: `permissions: ["storage"]`, `optional_host_permissions` for the 2 API hosts, content scripts on `https://www.youtube.com/*` (exclude `/shorts/*`), `commands` Alt+D, `minimum_chrome_version: "116"`.

## 8. SHARED CONTRACT (fixed — owners implement, others code against)
### Files and owners
| File | Owner | Exports |
|---|---|---|
| `src/shared/types.ts` | A | all types below |
| `src/shared/messages.ts` | A | `Msg`, `MsgResponse<T>`, `sendToSW`, `sendToTab`, `BridgeMsg`, `BRIDGE_SOURCE` |
| `src/shared/settings.ts` | A | `DEFAULT_SETTINGS`, `loadSettings`, `saveSettings`, `onSettingsChanged`, `getSecrets`*, `saveSecrets`*, `LANGS` |
| `src/content/main-hook.ts` | A | (MAIN-world entry) |
| `src/content/yt.ts` | A | `getPlayerResponse`, `getVideoId`, `isWatchPage`, `getJson3`, `getPlayer`, `getVideo` |
| `src/content/captions.ts` | A | `pickTrack`, `parseJson3`, `mergeSentences`, `listAudioTracks` |
| `src/content/pipeline.ts` | A | `getLines(videoId, lang): Promise<Line[]>` |
| `src/background/translate.ts` | A | `translateBatch(texts, from, to, key, model)` |
| `src/background/index.ts` | A | SW router (Wave 0 writes it fully; only A edits) |
| `src/content/voice/engine.ts` | B | `TtsEngine`, `Prepared`, `PlayHandle`, `createEngine(id)` |
| `src/content/voice/webspeech.ts` | B | `WebSpeechEngine` |
| `src/content/voice/audio.ts` | B | `AudioEngine` |
| `src/content/voice/voices.ts` | B | `listVoices(lang)`, `pickBestVoice(lang)`, `pickVoiceFor(lang, gender)`, `VoiceInfo {id,name,lang,engine,gender,quality}` |
| `src/background/tts.ts` | B | `synthesize(req, secrets): Promise<TtsResult>` |
| `src/background/cache.ts` | B | `cacheGet<T>(store,key)`, `cachePut(store,key,val)`, `cacheEvict()` |
| `src/content/sync/fit.ts` | C | `fit`, `estimateMs`, `CPS`, `MAX_RATE` |
| `src/content/sync/scheduler.ts` | C | `Scheduler`, `Clock`, `Speaker` |
| `src/content/sync/pitch.ts` | C | `SpeakerPitch` (`start()`, `genderFor(line): Gender`, `setGain(v)`, `stop()`) |
| `src/content/translate-local.ts` | A | `translateLocal(texts, from, to, onProgress?)` (Chrome Translator API) |
| `src/content/sync/player.ts` | C | `PlayerWatcher` (events, ads, ducking), `onNavigate(cb)` |
| `src/content/session.ts` | C | `DubSession` |
| `src/content/index.ts` | C | content entry (wires session + UI + messages) |
| `src/content/ui/player-ui.ts` | D | `mountPlayerUI(session-like api): PlayerUI` |
| `src/shared/feedback.ts` | D | `saveFeedback`, `getFeedback` |
| `src/popup/*` (`popup.html`, `popup.ts`, `popup.css`) | D | popup |
| `manifest.json`, `build.mjs`, configs | Wave 0 | — |

\* never imported from `src/content/**`.

### Types (`src/shared/types.ts`)
```ts
export type Lang = 'fr' | 'ar' | 'en' | 'es' | 'tr';
export type EngineId = 'webspeech' | 'openai' | 'elevenlabs';
export interface CaptionTrack { baseUrl: string; languageCode: string; kind?: string; vssId: string; name?: string }
export interface Cue { start: number; end: number; text: string }               // seconds
export interface Line { id: string; start: number; end: number; text: string; source?: string }
export interface Plan { line: Line; rate: number; startAt: number; maxMs: number; trimmed: boolean }
export interface Settings {
  enabled: boolean; targetLang: Lang; engine: EngineId;
  voiceByLang: Partial<Record<Lang, string>>;   // voiceURI (webspeech) or voice id (API)
  duckLevel: number; dubVolume: number; voiceSpeed: number;
  showBadge: boolean; showSubtitles: boolean; translateModel: string; matchSpeakerGender: boolean;
}
export interface Secrets { openaiKey?: string; elevenKey?: string }
export type DubState = 'idle' | 'preparing' | 'dubbing' | 'paused-ad' | 'error';
export type DubErrorCode = 'NO_CAPTIONS' | 'NO_TRANSLATION' | 'RATE_LIMITED' | 'ENGINE_ERROR' | 'NO_VOICE' | 'NOT_WATCH_PAGE';
export interface DubStatus { state: DubState; videoId?: string; error?: DubErrorCode; message?: string;
  officialTrackLang?: Lang; firstLineMs?: number; currentLineId?: string }
export interface Feedback { videoId: string; lineId: string; lang: Lang; up: boolean; rate: number; overflowMs: number; at: number }
export interface TtsRequest { text: string; lang: Lang; engine: 'openai' | 'elevenlabs'; voice: string; speed?: number }
export interface TtsResult { audioB64: string; mime: string }
```
Defaults: `enabled:false, targetLang:'fr', engine:'webspeech', duckLevel:0.15, dubVolume:1, voiceSpeed:1, showBadge:true, showSubtitles:false, translateModel:'gpt-4o-mini', matchSpeakerGender:true`.
`export type Gender = 'male' | 'female' | 'unknown';` and `Line` gains optional `gender?: Gender`.

### Runtime messages (`Msg`, `src/shared/messages.ts`)
| type | from → to | payload | response |
|---|---|---|---|
| `TRANSLATE` | content → SW | `{texts:string[], from:string, to:Lang}` | `{ok:true, texts:string[]}` \| err |
| `TTS` | content/popup → SW | `TtsRequest` | `{ok:true, ...TtsResult}` \| err |
| `CACHE_GET` | content → SW | `{store:'lines', key}` | `{ok:true, value?:unknown}` |
| `CACHE_PUT` | content → SW | `{store:'lines', key, value}` | `{ok:true}` |
| `DUB_TOGGLE` | popup/SW → tab | `{on?:boolean}` (omit = toggle) | `{ok:true, status:DubStatus}` |
| `GET_STATUS` | popup → tab | — | `{ok:true, status:DubStatus}` |
| `STATUS` | tab → runtime (popup) | `{status:DubStatus}` | — |
| `LIST_VOICES` | popup → tab | `{lang:Lang}` | `{ok:true, voices:VoiceInfo[]}` |
| `TEST_VOICE` | popup → tab | `{lang, engine, voice}` | `{ok:true}` \| err |
Error shape: `{ok:false, error:DubErrorCode|'NETWORK'|'NO_KEY'|'TIMEOUT', message?:string}`.

### Window bridge (MAIN ⇄ ISOLATED, `source: 'autodub'`)
`AD_TIMEDTEXT_URL {url}`; `AD_REQ {reqId, op:'playerResponse'|'json3'|'audioTracks', args}` → `AD_RES {reqId, ok, data?|error?}`.

## 9. Parallel build rules + test plan
- Toolchain: TypeScript strict, **esbuild** (`build.mjs`: 4 entries → `dist/`: `main-hook.js`, `content.js`, `background.js`, `popup.js` + copy `manifest.json`, `popup.html`, `popup.css`, icons), Vitest (jsdom), Playwright (Chromium, `launchPersistentContext` with `--load-extension`).
- Each Wave 1 agent edits **only its files** in §8 + its own tests `tests/unit/<letter>-*.test.ts`. Need a change in someone else's file → write it in `research/wave1-<LETTER>.md` "Requests", don't edit.
- Each agent checks with `npx tsc --noEmit` and `npx vitest run tests/unit/<letter>-*` (no full build into `dist/` while others are running: use `node build.mjs --outdir build-<letter>`).
- Section-8 names are fixed; signatures may only gain optional params.
### Tests
| Area | Test |
|---|---|
| A | `parseJson3` fixtures (human + ASR), `mergeSentences` (no split mid-sentence, ASR gaps, 180-char cap), `pickTrack` preference, URL rewrite keeps `pot` |
| B | voice ranking, base64 → Blob, SW `synthesize` with mocked fetch (headers, no key logged), cache LRU |
| A+ | Translator API path mocked: availability 'downloadable' → progress → translated lines; unavailable → falls to OpenAI/`NO_TRANSLATION` |
| B+ | gender table lookup, `pickVoiceFor` keeps a stable voice per gender |
| C+ | pitch: synthetic 120 Hz / 220 Hz sine → male / female; silence → unknown |
| C | `fit` (rate ≤ 1.3, trimming), Scheduler with fake clock over 1 h synthetic track (every line starts within 300 ms, no drift growth), seek resets cursor, ad pause/resume, ducking restore |
| D | settings round-trip, popup renders each state (jsdom), `secrets` grep test (no content import) |
| e2e | load `dist/` unpacked, open a TED talk with human captions, click Dub, assert STATUS `dubbing` and first line < 5 s; Shorts URL does nothing |
| Manual | 5 acceptance videos (talk, tutorial, vlog, >120-min podcast, ASR-only; include EN→TR) |
Screenshots of popup states → `screenshots/` (Playwright, popup opened as a page `chrome-extension://<id>/popup.html?state=<x>` with a mocked status).

## 9b. Kids notes
- Default voice speed 1.0 but slider allows 0.75 (kids); big in-player Dub button; no paid call ever happens without a key the parent entered.
- e2e/manual set adds 1 kids video with a single English transcript dubbed EN→FR and EN→AR on the free path.

## 10. Later (not v1)
TV (Cast-tab with in-tab voice, native apps), no-caption videos (STT), voice cloning, lip sync, Shorts, mobile, L3 auto-dub, store listing (rename, `PRIVACY.md` at owned URL, Limited Use statement).
