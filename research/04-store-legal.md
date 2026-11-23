# 04 — Chrome Web Store + legal

Researched 2026-11-23. Not legal advice. GOAL scope: personal use, unpacked; store publishing raises the bar (F9–F11).

## Sources

1. Offscreen API — https://developer.chrome.com/docs/extensions/reference/api/offscreen
2. Service worker lifecycle — https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
3. Remote hosted code (MV3) — https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
4. CWS Program Policies — https://developer.chrome.com/docs/webstore/program-policies/policies
5. CWS Limited Use — https://developer.chrome.com/docs/webstore/program-policies/limited-use
6. YouTube Terms of Service — https://www.youtube.com/static?template=terms
7. YouTube API Services Developer Policies — https://developers.google.com/youtube/terms/developer-policies
8. YouTube API Branding Guidelines — https://developers.google.com/youtube/branding_guidelines
9. OpenAI TTS guide — https://developers.openai.com/api/docs/guides/text-to-speech ; OpenAI Service Terms — https://openai.com/policies/service-terms/
10. ElevenLabs ElevenAPI Terms — https://elevenlabs.io/elevenapi-terms ; Use Policy — https://elevenlabs.io/use-policy
11. Existing "AutoDub" products — https://chromewebstore.google.com/detail/kallpmoklcckbobcoccenpphbhbijndc , https://addons.mozilla.org/en-US/firefox/addon/autodub-youtube-ai-dubbing/ , https://www.crunchbase.com/organization/autodub-ltd

## Findings

**F1 — Remote code ban.** MV3 forbids executing JS/WASM not shipped in the package (remote `<script>`, fetch-then-eval, remote code pulled in by a dependency). Remote *data* (JSON, audio, caption XML/JSON, CSS) is fine. Reviewers inspect the compiled bundle, so dependencies must be bundled and must not lazy-load from CDNs [3].

**F2 — Service worker lifetime.** Chrome stops the SW after 30 s idle, after any single event/API call over 5 min, or when a `fetch()` response takes over 30 s to start. Events, API calls and port messages reset the timer; globals are lost, so state goes in `chrome.storage`/IndexedDB [2]. Sync logic belongs in the content script.

**F3 — Offscreen documents.** Need the `"offscreen"` permission; one open document per extension; only `chrome.runtime` is available inside. `AUDIO_PLAYBACK` documents auto-close after **30 s with no audio**; other reasons have no limit. Other relevant reasons: `BLOBS`, `DOM_PARSER`, `WORKERS`, `LOCAL_STORAGE` [1].

**F4 — Offscreen is probably not needed here.** The content script can play `<audio>` Blob URLs and `speechSynthesis` itself; offscreen adds a permission and a 30 s auto-close race. **Casting consequence (needs verification in build):** "Cast tab" mirrors *the tab's* audio. Audio played by an offscreen document is not part of the YouTube tab, so it would likely **not** reach the TV; audio from an `<audio>` element in the content script is part of the tab. `speechSynthesis` on macOS is rendered by the OS speech engine and may also bypass tab capture — test early; if it does, the TV tip must say "use an OpenAI/ElevenLabs voice for TV" or route Web Speech differently.

**F5 — Permissions policy.** Request the narrowest set; never request permissions for future features [4]. `content_scripts.matches` already grants access to those pages. Fetches from the SW to third-party APIs need host permission (or the API's own CORS); declaring them as `optional_host_permissions` and calling `chrome.permissions.request()` when the user picks that engine keeps the install warning to "youtube.com" only. `permissions.request()` must come from a user gesture (popup button) and is exempt from the 5-min SW limit [2].

**F6 — User data, privacy policy, Limited Use.** Any extension handling user data needs an accurate privacy policy linked in the dashboard, consistent dashboard privacy fields, prominent pre-use disclosure, secure (HTTPS) transmission, and **authentication information kept secure** [4]. Limited Use: data only for the single purpose; transfers to third parties only when necessary for it; no ads/selling; web-browsing activity only for a prominently described user-facing feature; a **Limited Use compliance statement on an extension-owned website** [5]. AutoDub sends caption text (derived from what the user watches) to OpenAI/ElevenLabs only when the user opts in — this is a disclosable third-party transfer necessary for the feature. The API key is authentication info.

**F7 — YouTube ToS (applies to every user, API or not).** Users may watch content "for personal, non-commercial use". Prohibited: accessing the Service by automated means (robots, scrapers); altering/modifying the Service or Content; interfering with the Service; circumventing features that prevent copying [6]. Reading captions the player already loads and overlaying audio the viewer hears is a grey area, not a clear violation, but "modify the Content" is broad. Mitigate: no downloading, no bulk fetching, current video only, no ad interference.

**F8 — YouTube API Developer Policies** (bind only API clients; AutoDub does not use the Data API, but they show Google's stance): no scraping YouTube applications (III.E.6); no undocumented APIs without permission (III.D.7) — `timedtext` / `ytInitialPlayerResponse` caption URLs are undocumented; must not "separate, isolate, or modify the audio or video components… you must not apply alternate audio tracks to videos" (III.I.7); must not modify/block player functionality or ads (III.I.4–6) [7]. The official Data API would not help (`captions.download` is owner-only) and would import III.I.7, so stay off it.

**F9 — "YouTube" in the name.** Branding guidelines forbid "YouTube", "YT", "You-Tube" or derivatives in an app name, and pairing YouTube logos with the app name; "for YouTube" / "works with YouTube" phrasing in descriptions is allowed [8]. CWS also bans implied endorsement and trademark infringement and may reduce visibility on suspicion [4].

**F10 — "AutoDub" is taken.** An existing Chrome/Edge/Firefox extension "AutoDub – YouTube AI Dubbing & Translator" (autodub.net) does *the same thing*, and "AutoDub Ltd" sells a Mac dubbing app [11]. No registered trademark was found in this quick search, but common-law/unregistered rights plus an identical-purpose product make a store listing named "AutoDub" a likely confusion/takedown complaint, and a CWS "misleading metadata/impersonation" risk [4]. Fine as an internal/unpacked codename.

**F11 — Downloads.** CWS bans enabling unauthorized downloading/streaming of copyrighted media [4]. AutoDub never downloads media; say so in the listing.

**F12 — OpenAI.** Usage policies / Service Terms require a **clear disclosure to end users that TTS voice is AI-generated**, not human; don't strip AI-origin indicators [9]. The planned "AI dub" badge satisfies this — it must not be hideable to the point of no disclosure (keep a disclosure in the popup even when the player badge is hidden).

**F13 — ElevenLabs.** ElevenAPI Terms say the customer must not make an API key "available in any browser, mobile application, or other client… accessible to a third party", and must revoke exposed keys [10]. A user's own key in their own browser is not third-party exposure, but AutoDub must never ship, sync or expose a key to page context, and should advise a dedicated revocable key. Stock voices, no cloning, keeps us clear of the Use Policy.

**F14 — Casting.** Casting your own playback to your own TV is personal, non-commercial use (F7); public screenings are not.

## Decisions for AutoDub

1. **Ship as personal-use, unpacked** (matches GOAL). Store publication is a separate, later decision gated on items 12–14.
2. **Zero remote code:** bundle everything with the build (no CDN imports, no `eval`, no `new Function`); default MV3 CSP, no `content_security_policy` override. CI grep for `eval(`/`new Function`.
3. **SW = stateless proxy:** handles `translate` and `tts` fetches only; state in `chrome.storage.local` + IndexedDB. Keep each TTS request short (one sentence) so responses start well under 30 s; abort at 20 s and fall back to Web Speech.
4. **No offscreen document in v1.** Play TTS audio from the content script (`<audio>` + Blob URL from bytes returned by the SW), so Cast tab carries it. Add `offscreen` (reason `AUDIO_PLAYBACK`, re-create on demand) only if a measured blocker appears.
5. **Day-1 casting test:** confirm Web Speech and `<audio>` dub audio reach a Cast-tab TV; update the popup "Watch on TV" tip with the result.
6. **Captions:** read only the current video's track(s) the player exposes, once per video+language, cached; no crawling, no background fetching of other videos, no media download.
7. **Never touch ads:** during ads pause the dub, do not skip/mute/hide ads. Never hide YouTube controls, links or attribution; the badge sits in a corner and can be dismissed.
8. **Instant restore:** "off" restores original volume immediately (honours "don't interfere"; already in GOAL).
9. **API keys:** `chrome.storage.local` only (never `sync`, never `session` exposed to content scripts: call `chrome.storage.local.setAccessLevel` default `TRUSTED_CONTEXTS`); read only in SW/popup; never sent to content script, never logged, masked in UI, "Remove key" button; sent only via HTTPS `Authorization`/`xi-api-key` header to the chosen provider. Popup text: "Use a dedicated key you can revoke."
10. **Opt-in host access:** API hosts in `optional_host_permissions`, requested by the popup on engine selection (user gesture); revoked via `chrome.permissions.remove` when the user switches back to free voices.
11. **AI disclosure:** "AI dub" badge on player plus permanent "Voice is AI-generated" line in the popup and README (OpenAI requirement); hiding the badge never removes the popup disclosure.
12. **Rename before any store listing.** Keep "AutoDub" as codename only. Candidate pattern: a distinctive coined word + "– dub videos for YouTube" in the subtitle (allowed phrasing). Run a CWS/USPTO/EUIPO search on the final name. Never use "YouTube"/"YT" or YouTube logos in name or icon.
13. **Privacy policy + Limited Use page** (needed for store; good hygiene anyway): a `PRIVACY.md` published at a project-owned URL stating: no server, no analytics; settings/keys/feedback stored locally; when the user picks OpenAI/ElevenLabs, caption text of the current video and their key are sent only to that provider; plus the statement "The use of information received from this extension adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements."
14. **Single-purpose statement** for the dashboard: "Plays an AI-voiced translation of a YouTube video's captions while it plays." Disclose that browsing activity (current video ID + captions) is processed locally, and only for this feature.
15. **README:** personal non-commercial use, no downloading, YouTube ToS grey-area note, provider costs/terms.

### Proposed manifest permissions block

```json
{
  "manifest_version": 3,
  "name": "AutoDub",
  "minimum_chrome_version": "116",
  "permissions": ["storage"],
  "host_permissions": [],
  "optional_host_permissions": [
    "https://api.openai.com/*",
    "https://api.elevenlabs.io/*"
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [{
    "matches": ["https://www.youtube.com/*", "https://m.youtube.com/*"],
    "exclude_matches": ["https://www.youtube.com/shorts/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_popup": "popup.html" }
}
```

Notes: no `tabs`, `scripting`, `tts`, `offscreen` or `<all_urls>`. Whole-site match because YouTube is an SPA (also exclude Shorts in code). Drop `m.youtube.com` if desktop-only. Add `unlimitedStorage` only if the cache hits quota, `offscreen` only if Decision 4 fails.
