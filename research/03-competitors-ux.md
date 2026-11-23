# 03 — Competitors + UX

Researched 2026-11-23 (CWS = Chrome Web Store, figures read live).

## Sources
1. YouTube Help, "Use automatic dubbing": https://support.google.com/youtube/answer/15569972?hl=en
2. YouTube Blog, auto dubbing and Expressive Speech (4 Feb 2026): https://blog.youtube/news-and-events/youtube-auto-dubbing-expressive-speech/
3. Heise, "Robotic translation annoys users and cannot be turned off": https://heise.de/-10315551
4. PPC Land, viewer opt-out concerns: https://ppc.land/youtube-expands-automatic-dubbing-despite-viewer-concerns-over-missing-opt-out/
5. TechPP, how to turn off auto dub: https://techpp.com/2025/12/24/how-to-turn-off-youtube-auto-dub/
6. CWS "AutoDub: YouTube Video Translator & AI Dubbing" (autodub.net), with its listing and reviews: https://chromewebstore.google.com/detail/kallpmoklcckbobcoccenpphbhbijndc
7. CWS "AI Video Dub – Realtime Translation & Voice" (aivideodub.com), with its listing and reviews: https://chromewebstore.google.com/detail/fmedgpejjgkaeobnibnmfffihondbima
8. CWS "YouTube Dubbing" (angelodevbrasil): https://chromewebstore.google.com/detail/moojifgcgcckdaafoohlfllldnehmfdo
9. voice-over-translation (VOT, a Yandex Browser port), README: https://github.com/ilyhalight/voice-over-translation
10. Immersive Translate, YouTube TV translator page: https://immersivetranslate.com/en/video/tv-youtube-video-translator/
11. Seen in search results but not opened: EarDub, AnyDub, VoxTube, SubDub, TrueAudio.

## Findings

### A. YouTube's own auto-dubbing (the baseline AutoDub must beat)
- Since 4 Feb 2026, auto dubbing is available to all creators in 27 languages. Expressive Speech covers 8 languages: EN, FR, DE, HI, ID, IT, PT, ES. Viewers get a "Preferred language" setting. In Dec 2025, more than 6 M daily viewers watched at least 10 minutes of dubbed content [2].
- **The language matrix is mostly hub-and-spoke through English** [1]:
  - English can be dubbed into 20 targets, including **Arabic, French and Spanish**.
  - Every other source language goes only to English. The exceptions are Spanish (to Arabic and Portuguese), Portuguese (to Spanish), Hindi (to Bengali) and Korean (to Indonesian).
  - **Turkish is never a target.**
  - French can be produced only from English. Arabic can be produced only from English or Spanish.
  - For the owner's languages (FR/AR/EN/ES/TR), most source-to-target pairs other than "English to X" are **not covered by YouTube**.
- Videos are ineligible if they run **over 120 min**, are music or have little speech, have fast speech, contain copyrighted content, use an undetected language, or belong to a creator who turned dubbing off [1][2]. Long podcasts, which are one of the owner's 5 test videos, fall outside YouTube's coverage.
- Viewers dislike it:
  - Heise reports months of Reddit and forum complaints about a "robotic" dub that **cannot be turned off** [3].
  - Viewers have no global opt-out, only a per-video Audio-track menu [4][5].
  - Several extensions exist just to force the original track (TrueAudio, YouTube Anti Translate) [5][11].

### B. Extension competitors (caption-based, like AutoDub)
| Product | Users / rating | Engine | Notable UX |
|---|---|---|---|
| **AutoDub (autodub.net)** [6] | 50,000 / 4.8 (239) | Neural voices, 90+ voices, 42 languages | **Player-controls button** → language → play. Auto source detection. Voice speed 0.5–2× **separate from video speed**. Optional ducking. Cached re-plays start instantly. "Free, no sign-up, no paywall." |
| **AI Video Dub** [7] | 7,000 / 4.1 (35) | Microsoft Translator + MS Neural TTS, 75 languages | Popup "Start Translation" **plus** player button. Two volume sliders. Rate 0.5–1.5×. Searchable language picker. Own .srt upload. **Falls back to the browser voice when its server is down.** |
| **YouTube Dubbing** [8] | 95 / no ratings | Unknown, with in-app purchases | User must turn on CC first, then click a "D" icon on the player and wait for a loading indicator. Two volume sliders. |
| **VOT / Yandex** [9] | ~7.3k GitHub stars | Server-side Yandex voice-over | Targets only **RU/EN/KK**. Two sliders with **adaptive ducking**. Hotkeys. 4 h limit. Userscript/proxy setup. |
| **Immersive Translate** [10] | Large freemium base | Subtitles first; dubbing listed as freemium | AI captions for videos without subtitles are **Pro-only**. Limit of 4 h. |

### C. What reviews praise and hate
- **Praise:** "Fast, accurate, and very easy to use" [7]; voices bearable for long lectures; no sign-up or limits [6]; both languages on screen for learning [6][7].
- **Hate and failures:**
  - **Robotic voice.** One reviewer was "stuck on the horrible generic female AI voice from like 1997" because the voice choice did not apply [7].
  - **Silent failure.** "DONT WORK" turned out to be a video with no captions. The developer admitted the old error message "looked like a breakage" [7].
  - **Per-cue gaps.** Each subtitle cue was synthesized separately, which left unnatural pauses. Chinese was the worst case. The developer's fix is to **merge cues into sentences before TTS** [7].
  - **Language-specific failures.** One review says it was "Not working on english" [6].
  - **Setup friction.** Having to turn on CC manually is friction [8]. Userscript and proxy setup is friction [9].
  - **Paywalls.** Users dislike in-app purchases and Pro gates [8][10].
- **Lag and sync.** No reviewer praised sync, but the leading products all advertise staying in sync through pause, seek and 2×.

### D. Popup and player UX patterns
- **Primary action lives in the player**, not only in the toolbar popup. Two of the leaders inject a button next to autoplay/CC [6][7], and AI Video Dub points the button out to first-time users [7].
- The popup holds: an on/off control, a **searchable target-language picker**, a voice picker (male/female per language), **two volume controls** (dub / original) or a ducking toggle, voice speed, and a subtitles toggle.
- They auto-detect the source language and show a loading indicator while the first lines are prepared.

### E. TV and casting
- None of the dubbing extensions mention TV or casting.
- Immersive Translate admits smart TVs can't run extensions. It suggests casting or mirroring via Chromecast, AirPlay or HDMI, or loading exported SRT files on the TV [10].
- YouTube's native dubs work on TV apps automatically, which is their one structural advantage.
- **Gap:** no one documents "Cast tab = picture + dubbed audio" clearly.

### F. Gaps AutoDub can win
1. **Pairs YouTube can't produce:** any language to Turkish, non-English to French or Arabic, and videos over 120 min.
2. **No server and keys stay local.** Competitors route text and audio through their own servers or Yandex proxies.
3. **Sentence-merged timing with no cumulative lag**, the exact bug reviewers hit [7].
4. **Honest states and clear TV guidance.**
5. **Name collision:** "AutoDub" is already a 50k-user CWS extension [6]. Rename before any public listing.

## Decisions for AutoDub
1. **Add an in-player "Dub" button** next to the CC button, and keep the popup as the settings surface. On the first video, show a one-time tooltip pointing at the button. Clicking it toggles dubbing on or off in one step, so AutoDub reaches L2 with one click.
2. **Make the dub strictly opt-in.** Never auto-start, which is a v1 rule and stays that way until L3. The player button and popup offer **"Original audio" as an instant revert**, so the dub is never a sticky track like YouTube's.
3. **Turn captions on in code**, by reading the caption tracks directly. Never ask the user to press CC.
4. **Detect YouTube's own audio tracks.** If an official or auto-dubbed track exists in the target language, show a popup banner reading "YouTube has an official [French] track — use it?" Selecting it hands off to the native track. Otherwise, dub as usual.
5. **Show explicit empty and error states** for each of these cases:
   - No captions: "This video has no subtitles — AutoDub can't dub it (v2)."
   - Translation unavailable: no `tlang` and no LLM key.
   - Engine or key error, which **falls back to the browser voice automatically** with a toast.
   - Ad playing: "Paused for ad."
6. **Merge caption cues into sentences before TTS** (this is already in GOAL.md). Add a unit test that asserts no audible gap is inserted inside a sentence.
7. **Popup layout, top to bottom:**
   - A large On/Off switch and a status line (Idle / Preparing… / Dubbing / Error).
   - A target language picker (5 owner languages pinned first, search for the rest).
   - A voice picker filtered to the target language, with a gender/name label and a ▶ "Test voice" button.
   - An "Original audio" slider (default 15%) with a separate dub-volume slider.
   - A voice speed control (0.75–1.3×, independent of video speed).
   - A collapsible "Engine" section (Browser free / OpenAI / ElevenLabs + key field + cost hint).
   - A "Watch on TV" link.
   8. **Rank the voice picker by quality.** List Web Speech voices with "Natural/Neural/Google/Premium" names first and mark the best one as the default. Remember the last voice for each language. Always re-apply the chosen voice on every utterance, which avoids the "stuck on 1997 voice" bug [7].
9. **Show a loading state.** Display "Preparing first line…" with a spinner on the player button until the first utterance plays. Log time-to-first-line locally against the < 5 s target.
10. **Offer an optional subtitle overlay.** Default is off. When turned on, show the translated line (and the original below it) for language learners. Render the overlay RTL for Arabic.
11. **Add "Watch on TV" steps** in the popup and README:
    Chrome ⋮ → Cast… → Sources → **Cast tab** → pick the TV; keep the tab in front and the Mac awake; some TVs add 1–2 s of audio delay. Native TV YouTube apps can't be dubbed (v2).
12. **Keep the hotkey cheap.** `Alt+D` toggles the dub through the `commands` manifest key, with no extra permission.
13. **Make privacy a selling point.** The popup footer reads "No account · No server · Keys stay on this device."
14. **Do not publish as "AutoDub" on the CWS** without a rename, because it collides with autodub.net (50k users). Keep the internal name for personal v1.
15. **Use YouTube's coverage gaps in test selection.** Include one video over 120 min, which YouTube can't dub, and one EN to TR video, a target YouTube doesn't offer, among the 5 acceptance videos.
