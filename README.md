# AutoDub (v1, personal use)

A Chrome extension that dubs YouTube videos live into **French, Arabic, English, Spanish or Turkish** from the video's subtitles. Built for kids: one click, free voices, the voice follows the speaker (male / female).

> Codename only: "AutoDub" is already used by another Chrome Web Store extension. Rename before any public listing.

## Install (1 minute, no store account)
1. `npm install && npm run build` (already done once: the build is in `dist/`).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. **Load unpacked** → pick the `dist` folder.
4. Pin AutoDub (puzzle icon → pin).

## Use
1. Open a YouTube video that has subtitles (any one language is enough).
2. Click the **Dub** button in the player bar (next to CC), or the popup switch, or press **Alt+D**.
3. Pick the language in the popup. The dub starts from where the video is.
4. **Original audio** to hear the original under the dub. Turn it off to get the original back instantly.

## How a video is translated (free first)
1. Subtitles already in your language → used as is.
2. YouTube's own translated subtitles.
3. **Chrome's built-in translator** (on-device, free; downloads a language pack the first time — the popup shows "Downloading French translator… 40%").
4. OpenAI (only if you entered a key).
If none works, the popup says so clearly. Videos with **no subtitles at all** can't be dubbed in v1.

## Voices
- **Free (default):** the voices installed on your Mac. Several per language, male and female.
  - More / better voices: System Settings → Accessibility → Spoken Content → System voice → **Manage voices** → download "Enhanced"/"Premium" voices for French, Arabic, Spanish, Turkish.
  - The popup shows how many male / female voices each language has.
- **Match speaker's voice** (on by default): AutoDub listens to the speaker's pitch and uses a male or female voice. It is a best guess: cartoons, songs and children's voices (high pitch → female voice) can fool it. Subtitle labels like `[Man]` win over the guess.
- **Paid, more natural (optional):** OpenAI or ElevenLabs with your own key (Engine section). Rough cost: about $1 per hour of video. Set a spending limit in the provider's dashboard and use a dedicated key you can revoke.

## Privacy
No account, no server, no analytics. Settings, feedback (👍/👎) and keys stay in Chrome on this Mac. Keys are only sent to the provider you chose, and only read by the popup and background — never by the code running on YouTube. The voice is AI-generated (badge on the player).

## Limits (v1)
- Personal viewing only. Never downloads or re-uploads video or audio. Dubbing YouTube is a grey area of YouTube's terms: don't share or publish dubbed recordings.
- Desktop Chrome 138+ on youtube.com. Not Shorts, not YouTube Kids site, not mobile.
- **TV: not in v1.** Free Mac voices likely won't reach a TV via Cast tab. Planned for v2 once we know how the TV is watched.
- Ads are never touched: the dub pauses during ads.

## Developer
| Command | What |
|---|---|
| `npm run build` | build to `dist/` |
| `npm test` | 188 unit tests (Vitest) |
| `npm run typecheck` | TypeScript |
| `npx playwright test` | popup screenshots + smoke |
| `LIVE=1 npx playwright test live-dub` | live YouTube test (YouTube returns empty captions to automated Chromium, so it fails there; test by hand in real Chrome) |

Docs: `GOAL.md`, `DESIGN_SPEC.md`, `research/` (research, wave reports, open issues).
