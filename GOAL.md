# AutoDub — GOAL (v1)

## Identity
A Chrome extension (Manifest V3) that auto-dubs YouTube videos into another language, live, while the video plays.
Personal viewing only. No own server, no analytics.

## Outcome (Phase 0 — outcome first)
I click **Dub** on any YouTube video that has subtitles and hear it in my language.

### Success metrics
- First dubbed line plays in **< 5 s** after clicking Dub.
- Voice stays within **300 ms** of the matching subtitle (no cumulative lag).
- **Zero errors** on 5 test videos: a talk (TED), a tutorial, a vlog, a long podcast (> 1 h), a video with only auto-generated captions.

## Owner settings
| Setting | Value |
|---|---|
| Target languages | French, Arabic, English, Spanish, Turkish |
| Default voice engine | Free browser voices (Web Speech API); OpenAI TTS / ElevenLabs = optional upgrade with user's key |
| Main browser | Chrome (desktop, macOS) |
| TV | **Not in v1** (owner decision 2026-11-23, Checkpoint 1). v2 |
| OS | macOS |

## Done means
- [ ] Watch pages detected, incl. SPA navigation (`yt-navigate-finish`); Shorts excluded.
- [ ] Caption tracks read (human preferred, auto-generated fallback); YouTube translated track (`tlang`) first, LLM-key translation second, clear message if neither.
- [ ] Caption fragments merged into full sentences with start/end times.
- [ ] Each sentence spoken at its start time — Web Speech (free) or OpenAI/ElevenLabs (user key); pre-generated 30 s ahead, cached per video+language in IndexedDB.
- [ ] Timing fit: rate up to 1.3×, then trim gap; lag never accumulates.
- [ ] Original audio ducked to user level (default 15 %) while dub speaks, restored between lines.
- [ ] Follows player: pause, seek, speed change, ad breaks (dub paused during ads), tab hidden.
- [ ] Popup: on/off, target language, voice, original-audio level, engine + API key, "Test voice".
- [ ] "AI dub" badge on player (can be hidden); instant fallback to original audio.
- [ ] Thumbs up/down per line, saved locally (timing feedback loop).
- [ ] Keys only in `chrome.storage.local`, sent only to chosen provider, never logged.
- [ ] Never downloads or re-uploads video/audio. README states personal use only.
- [ ] Unit tests (sentence merge, timing fit, sync drift with fake clock) + Playwright test on a real captioned video (first line < 5 s) pass.
- [ ] Popup screenshots in every state in `screenshots/`. README: install, settings, costs, privacy, limits.

## Constraints
- Manifest V3, minimum permissions. TypeScript.
- Popup must not look vibe-coded: clean type scale, 8-px spacing, one accent colour, real loading/error/empty states.
- Arabic → RTL-aware popup text where shown.
- Never remove a feature once built. No API key in code, logs or git. Ask owner before any paid API call beyond a 1-line voice test.

## PM checklist (AI for PM course)
- **AI level:** L2 now (AI assists, user in control: one click, stop/change voice anytime); L3 later (auto-dub in chosen language by default).
- **Transparency:** "AI dub" badge, opt-out, instant fallback to original.
- **Fastest aha:** zero setup on free voices; API key = natural upgrade.
- **Feedback loop:** thumbs up/down per line, stored locally.
- **Principles:** keys stay local, data minimised, personal use, no server.

## Out of scope (v2)
- Videos with no captions (audio capture + speech-to-text)
- Voice cloning, lip sync
- Shorts, mobile
- TV: Cast-tab support (needs in-tab audio voice; free Web Speech likely plays on the Mac only) and native TV apps (Android/Google TV, Tizen, webOS)
- L3 auto-dub by default

## Folder layout (target; final names fixed in DESIGN_SPEC §8)
```
AutoDub_v1/
  GOAL.md  DESIGN_SPEC.md  README.md
  research/          # agent reports
  src/
    content/         # content script: page detect, captions, sync, player control, badge
    background/      # service worker: messaging, translation + TTS fetches
    offscreen/       # offscreen doc (audio playback if needed)
    popup/           # popup UI
    shared/          # types, messages, storage
  tests/unit/  tests/e2e/
  dist/              # build output (load unpacked)
  screenshots/
```

## Commands
- `npm install`
- `npm run build` → `dist/`
- `npm test` → Vitest unit tests
- `npm run e2e` → Playwright (loads unpacked extension in Chromium)
