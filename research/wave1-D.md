# Wave 1 — D (popup, in-player UI, feedback) — 2026-11-23

## Built
- `src/popup/popup.{html,ts,css}`: full §6 popup at 340 px with type sizes 12/14/16/20, an 8-px grid, a single accent `#3D5AFE`, inline SVG icons, no emoji and no gradients. It has light and dark themes (`prefers-color-scheme`, or forced with `data-theme`).
  - **Header:** logo, a big On/Off switch that sends `DUB_TOGGLE` and shows a spinner while preparing, and a coloured status line: Idle / Preparing… / Dubbing into X / Paused for ad / Error / Not on a YouTube video / Reload the page.
  - **Banner slot**, in priority order:
    1. Tab context: not on YouTube, or "Reload page" when YouTube is open but no content script answers.
    2. Error banner with an action. Codes covered: NO_CAPTIONS, NO_TRANSLATION ("Add OpenAI key" / "Try again"), RATE_LIMITED, ENGINE_ERROR, NO_KEY, NO_VOICE (uses B's `NO_VOICE_HELP`), NETWORK/TIMEOUT ("Reload page").
    3. `preparing` + `status.message` → progress bar. A "42%" in the message gives a determinate bar; "Downloading French translator…" gets one-time copy.
    4. `officialTrackLang === targetLang` → tells the user how to pick the official track in the player's ⚙.
    5. API engine with no key saved → "Add key".
  - **Languages:** FR AR EN ES TR as a segmented radio group with native names. Arabic uses `dir=rtl`. Arrow keys move between languages.
  - **Voice picker:**
    - Quality-ranked and labelled "Amélie HD · Female" / "Thomas · Male". "(Enhanced)" is shortened to "HD" so the gender stays visible.
    - Web Speech voices come from `LIST_VOICES` to the tab; if no tab answers, B's `listVoices` runs in the popup. API voices come from B's `listVoices(lang, engine)`.
    - Loading skeleton while voices load; an empty-state card with the macOS install path.
  - **Test voice** (▶ Test) sends `TEST_VOICE`. If no tab answers, it falls back to popup `speechSynthesis`, or to SW `TTS` + `<audio>`.
  - **"Match speaker's voice" toggle**, with female/male count chips. If only one gender is installed (B's `gendersOf`), a notice names a suggested voice (e.g. Cem) and the path System Settings → Accessibility → Spoken Content → System voice → Manage voices….
  - **Sliders:** Original audio (15 %), Dub volume, Voice speed 0.75–1.30×. Saves are debounced 150 ms and serialised, which fixed a real read-modify-write race in `saveSettings`.
  - **"Show translated subtitles"** toggle.
  - **Collapsible Engine section:** Browser (free) / OpenAI / ElevenLabs with cost tags.
    - Choosing an API engine calls `chrome.permissions.request` synchronously in the click. If denied, the previous engine stays and a message says why.
    - Going back to free removes the previous host. Exception: OpenAI is kept while an OpenAI key is saved, because it also translates (§1 C5).
    - Masked key field with Save / Remove (`saveSecrets`). Only the last 4 characters are ever shown back.
    - Notes "Use a dedicated key you can revoke…" and the cost hint (characters × price).
  - **Footer:** "Voice is AI-generated · No account · No server · Keys stay on this device."
  - **`popup.html?mock=<state>`** (also accepts `?state=`). States: idle, preparing, dubbing, paused-ad, error, not-youtube, engine-open, dark, loading, empty, official, reload, light.
- `src/shared/feedback.ts`: `saveFeedback` / `getFeedback`. Ring of 500 in `storage.local.feedback`. Writes are serialised (520 concurrent writes are not lost), and a second vote on the same line replaces the first.
- `src/content/ui/player-ui.ts`: Shadow-DOM UI.
  - **Dub pill button** (32 px, icon + "Dub") inserted before the CC button in `.ytp-right-controls`. It is re-attached every 2 s if YouTube rebuilds the controls, and it mounts later if the player appears late.
  - **Button states** (set by `data-state`): off = outlined; preparing = accent + spinner; on = solid accent; paused-ad = dimmed; error = red outline. `aria-pressed` and labels follow the state.
  - **One-time tooltip** ("New: AI dub… Got it"). It sets `storage.local.onboarded = true` and closes itself after 12 s.
  - **"AI dub" badge** at the top left while dubbing, with 👍/👎 for the current line and × to hide it. Hiding saves `showBadge:false` and shows a toast saying where to turn it back on.
  - **Subtitle overlay:** translated line plus the source line underneath, RTL for Arabic. It moves down when the YouTube controls auto-hide.
  - **Toasts:** info / warn / error, at most 3, auto-hidden. An entry into `paused-ad` or `error` toasts automatically.
  - **Large-player scaling:** a container query enlarges everything when the player is ≥ 1200 px wide (fullscreen).
  - Clicks on our buttons don't reach YouTube, so they never pause the video.

## Public API — `mountPlayerUI(api, player?) → PlayerUI` (matches C's `src/content/index.ts`)
```ts
interface PlayerUIApi {            // only getStatus is required
  getStatus(): DubStatus;
  toggle?(on?: boolean): Promise<DubStatus>;   // called synchronously in the Dub click (user gesture → WebAudio)
  onToggle?(): unknown;                        // alternative to toggle (used first if present)
  onStatus?(cb): () => void;                   // UI subscribes; unsubscribed on destroy
  currentLine?(): Line | null;                 // read when a thumb is clicked
  getSettings?(): Settings;  setSettings?(patch): Promise<void>;  // badge hide uses setSettings, else saveSettings
  onThumb?(line, up): void;                    // if given, the caller saves feedback (C does)
  onFeedback?(fb, line): void;                 // else UI calls saveFeedback itself, then this
}
interface PlayerUI {
  setStatus(s) / update(s);                    // same thing
  showLine(line | null, meta?: {lang, rate, overflowMs});   // push API: thumbs + subtitle (with source line)
  showSubtitle(text | null, lang?);            // C's API: subtitle only
  toast(msg, kind?) / showToast(msg, kind?);   // kind: 'info' | 'warn' | 'error'
  destroy();
}
```
The UI also reads settings itself (`loadSettings` + `onSettingsChanged`) for `showBadge`, `showSubtitles` and `targetLang`. It never reads the key store.

## Tests (`npx vitest run tests/unit/d-` → 5 files, 35 tests pass; `npx tsc --noEmit` is clean)
- `d-popup`: every mock state renders with its own assertions; Male/Female labels; Arabic RTL; real backend over chrome-mock:
  - settings round-trip (language, slider, subtitles and voice are saved, then re-shown in a new popup)
  - DUB_TOGGLE → Preparing; STATUS → header
  - permission request and remove
  - key saved masked (the key never appears in the DOM)
  - denied permission keeps the old engine
  - non-YouTube tab → not-youtube state
- `d-player-ui`: placement before CC, states, tooltip shown once, badge dismiss persists, thumbs → feedback (both the push API and C's `currentLine` + `onThumb`), RTL subtitles, toasts (text only, no HTML injection), late mount.
- `d-feedback`: ring of 500, concurrency, vote replacement.
- `d-no-secrets`: greps `src/content/**` for `getSecrets|saveSecrets|secrets` (case-insensitive) and fails on any hit.
- `tests/e2e/popup-screenshots.spec.ts`: `node build.mjs --outdir build-d && EXT_DIR=build-d npx playwright test popup-screenshots` → `screenshots/popup-{idle,preparing,dubbing,paused-ad,error,not-youtube,engine-open,dark,loading,empty,official}.png` at 2× scale (11 pass).

## Open issues
- Thumbs live inside the badge, so hiding the badge also hides voting. A separate small thumbs control could come back if feedback volume drops.
- `showSubtitle(text)` from C passes no source line. With `showLine(line, {lang})` the original would show under the translation, as the competitor research recommends for learners.
- Voice genders for API engines are B's ear-based table. The popup "female/male" chips count `unknown` as female, matching B's `gendersOf`.
- Cost figures (≈ $0.90/h for OpenAI, ≈ 25k credits/h for ElevenLabs Flash) are estimates. Re-check them before the README.
- The in-player UI has only been checked in jsdom. It still needs one visual check on a real YouTube page (control-bar height, fullscreen).

## Requests
1. **B**: the popup imports `listVoices`, `gendersOf` and `NO_VOICE_HELP` from `src/content/voice/voices.ts` (it works in the popup because it is an extension page). Please keep that module free of content-only side effects at import time.
2. **C (optional)**: in `onLine`, call `st.ui?.showLine(line, { lang, rate, overflowMs })` instead of `showSubtitle(line.text)`. That shows the source line too, and the UI then respects `showSubtitles` itself. Calling both `ui.update(s)` and `api.onStatus` is harmless (same state → no duplicate toast).
3. **Wave 0 / orchestrator**: the popup does not persist `settings.enabled`. It sends `DUB_TOGGLE` only, as C asked. `stats.firstLine` is not shown in the popup yet; a small "first line in 2.1 s" readout could be added in a later wave.
