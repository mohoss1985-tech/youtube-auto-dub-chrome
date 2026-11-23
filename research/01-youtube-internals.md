# 01 — YouTube internals for AutoDub (as of Nov 2026)

## Sources
1. yt-dlp PO Token Guide: https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide
2. youtube-transcript-api issue #592, "PoTokenRequired: exp=xpe" (opened Apr 2026, still open): https://github.com/jdepoix/youtube-transcript-api/issues/592
3. dev.to, "Why your YouTube transcript scraper started returning empty strings (2026)": https://dev.to/jamhimself/why-your-youtube-transcript-scraper-started-returning-empty-strings-and-how-to-fix-it-in-2026-20ed
4. NoteLMai/YouTube-Subtitle-Downloader (captures timedtext via webRequest, reads `playerCaptionsTracklistRenderer`): https://github.com/NoteLMai/YouTube-Subtitle-Downloader
5. yt-dlp issue #13831 (429 only on auto-translated `tlang` tracks): https://github.com/yt-dlp/yt-dlp/issues/13831
6. Immersive Translate, "YouTube subtitle 429": https://immersivetranslate.com/docs/youtube-subtitle-429/
7. Invidious issue #4660 (auto captions broke on timedtext): https://www.github.com/iv-org/invidious/issues/4660
8. Chrome docs, content_scripts `world` / `run_at`: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
9. DEV guide on MAIN-world fetch/XHR override in MV3: https://dev.to/wilow445/how-to-intercept-server-sent-events-in-chrome-extensions-mv3-guide-23kb
10. `ad-showing` check (oddlyspaced/skip): https://www.github.com/oddlyspaced/skip/blob/main/background.js
11. `yt-navigate-finish` / `yt-page-type-changed` in userscripts: https://greasyfork.org:4000/sv/scripts/477498-youtube-adblock-ban-bypass/discussions/210019
12. `#movie_player` not always present: https://dev.to/penge/comment/jlh5
13. Firefox "YouTube Subtitle Downloader" listing (search snippet; the page did not load for us): "June 11 2025 change required turning on the CC button to bypass the Proof of Origin Token": https://addons.mozilla.org/addon/youtube-subtitle-downloader

## Findings

### Caption track list
- Track list lives at `playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[]`. Each track has `baseUrl`, `languageCode`, `name`, `vssId` (`.en` = human, `a.en` = ASR), optional `kind: "asr"`, and `isTranslatable` [4]. The renderer also lists `translationLanguages[]` (`languageCode`).
- Sources: `window.ytInitialPlayerResponse` is correct **only on a hard page load**. After SPA navigation it goes stale. `document.getElementById('movie_player').getPlayerResponse()` stays current. Both need the MAIN world. This is community knowledge, not documented by Google.

### The PO token ("pot") problem
- Since about mid-2025, the WEB client needs a PO token for **Subs** (subtitle requests) as well as GVS [1]. Tokens are usually **bound to the video ID**, so each video needs a new one [1][3].
- Symptom: a `baseUrl` containing `exp=xpe` returns **HTTP 200 with an empty body** when fetched directly, even with cookies [2][3]. A working request needs `&pot=<token>&c=WEB` (and `fmt=json3`). A session-only token still comes back empty [3].
- Minting the token takes BotGuard (`bgutils-js`) [3]. That is too heavy and fragile for an extension.
- **Browser workaround used by extensions:** let the player request captions itself (turn CC on), then capture that request's URL, which already carries the valid `pot`, `c`, `exp` and signature [4][13]. Capture options:
  - (a) Hook `fetch`/`XMLHttpRequest.prototype.open` in a MAIN-world script at `document_start` [9]. No extra permission is needed.
  - (b) `chrome.webRequest.onBeforeRequest` in the service worker [4]. This needs the `webRequest` permission plus host permissions for both the URL and the initiator.
  - (c) Check `performance.getEntriesByType('resource')` for `/api/timedtext` entries that already loaded. Cheap, and a good first try.
- After capture, the same URL can be re-fetched (same origin, from page context) with `fmt=json3` and with `tlang` swapped. This is inferred from [4], which "modifies the API URL" to change language, and from common extension practice.
- Some videos with community-contributed captions return empty from timedtext; the only way through is switching language in the player UI [dev.to transcript-extension write-up, search result].

### Translated tracks (`&tlang=`)
- `tlang` still works on timedtext. Auto-translated tracks are the ones YouTube rate-limits with **HTTP 429**; manual and original ASR tracks are not affected [5][6]. Shared exits (VPN/proxy) and bursts make it worse [6].
- Mitigation: one request per video+language, then cache. Fall back to LLM translation of the original track if 429 [6].

### json3 format (community knowledge, stable for years)
`{ events: [{ tStartMs, dDurationMs, segs?: [{ utf8, tOffsetMs? }], aAppend?, wWinId? }] }`. ASR tracks send word-level `segs` with `tOffsetMs`, plus "append" events (`aAppend: 1`) that only contain `"\n"`. Skip events without `segs`. Join `segs[].utf8`.

### Player API / events (MAIN world for `movie_player.*`)
- `#movie_player` methods: `getPlayerResponse()`, `getCurrentTime()`, `getPlaybackRate()`, `getVideoData()` (`video_id`), `loadModule('captions')` / `unloadModule('captions')`, `setOption('captions','track',{languageCode})`, `getOption('captions','tracklist')`, `toggleSubtitlesOn()`. These are undocumented. Verify each with `typeof fn === 'function'`.
- An isolated-world script can rely on the `<video class="html5-main-video">` element instead: `play`, `pause`, `seeking`, `seeked`, `ratechange`, `timeupdate` (about 4 Hz, too coarse; poll `currentTime` with rAF for sync), `waiting`, `emptied`/`loadstart` (source swap, including on ads).
- **Ads:** `#movie_player` gets the class `ad-showing` (and `ad-interrupting`) during ads [10]. `.ytp-ad-player-overlay`, `.ytp-ad-text` and `.ytp-ad-skip-button*` also exist. During an ad, `video.currentTime` is the **ad's** time. Observe the class with a `MutationObserver` on `#movie_player` `attributes:['class']`.
- `#movie_player` may not exist yet on first load or on non-watch pages [12].

### SPA navigation
- `document` events: `yt-navigate-start`, `yt-navigate-finish`, `yt-page-data-updated`, `yt-page-type-changed` [11]. `yt-navigate-finish` fires after the new page's data is in (its `detail.response.playerResponse` is often present). Use it as the trigger, and re-read the player response after it.
- Detect the route by `location.pathname === '/watch'` plus `new URLSearchParams(location.search).get('v')`. Shorts are `/shorts/<id>` (excluded). Also exclude `youtube.com/embed`, and treat `m.youtube.com` as out of scope.

### Isolated vs MAIN world
- The default `ISOLATED` world cannot see page JS globals (`ytInitialPlayerResponse`, `movie_player` methods) or page `fetch`. `"world": "MAIN"` shares the page's environment, and the page can interfere with it [8].
- MAIN-world scripts have **no `chrome.*` APIs**. Bridge them with `window.postMessage` (or `CustomEvent` on `document`) to an isolated script, which talks to the service worker [9]. `run_at: "document_start"` makes the hook load before YouTube's scripts [8][9].

## Decisions for AutoDub
1. **Two content scripts on `https://www.youtube.com/*`:** `content/main-hook.ts` (`world: "MAIN"`, `run_at: "document_start"`) and `content/index.ts` (ISOLATED, `document_idle`). No `webRequest` permission is needed.
2. **The MAIN hook wraps `fetch` and `XMLHttpRequest.prototype.open`.** For any URL containing `/api/timedtext`, it posts `{type:'AD_TIMEDTEXT_URL', url}` to the window. It also answers `AD_GET_PLAYER_RESPONSE` with `movie_player.getPlayerResponse()` (fallback `ytInitialPlayerResponse` only if `videoDetails.videoId` matches the current `v`).
3. **Track choice:** prefer a human track (`kind !== 'asr'`) in the source language. Fall back to ASR (`vssId` starting with `a.`). If the target language equals the track's language, no translation is needed.
4. **Getting a fetchable URL, in order:**
   - (a) A captured timedtext URL for this `v`.
   - (b) A `performance` resource entry for this `v`.
   - (c) If `baseUrl` lacks `exp=xpe`, try `baseUrl` directly.
   - (d) Otherwise turn CC on programmatically (`loadModule('captions')` + `setOption('captions','track',{languageCode})`), wait up to 3 s for the capture, then restore the user's CC state and hide `.ytp-caption-window-container` while we own it.
   - Every fetch runs in the MAIN world (page origin and cookies).
5. **Rewrite the URL:** set `fmt=json3`, set or delete `tlang`, and keep `pot`, `c`, `exp`, `signature` and `lang` untouched. Treat an empty body or non-JSON response as a "PO token needed" error and go to the next step in Decision 4.
6. **Translation order:** `tlang` first (one try per video+lang). On 429 or empty, use LLM translation of the original track (user key). If neither works, show a clear message. Cache the raw json3 per `videoId+lang` in IndexedDB.
7. **Parse json3:** drop events without `segs` and pure-`"\n"` append events. Text is `segs.map(s=>s.utf8).join('')`. Time is `tStartMs`. End is `tStartMs+dDurationMs`, capped at the next start (ASR overlaps). Pass the result to the sentence merger.
8. **Sync uses the `<video>` element** (isolated world is fine): play/pause/seeked/ratechange events plus rAF polling of `currentTime`. Do not rely on `timeupdate`.
9. **Ads:** a `MutationObserver` on `#movie_player` class watches for `ad-showing`. While it is set, pause the dub, restore the original volume, and ignore `currentTime`. After the ad, resync from `currentTime`.
10. **Navigation:** listen to `yt-navigate-finish` (plus `popstate` as a fallback). On every event, tear down the old session (stop TTS, clear timers). Start again only if `pathname === '/watch'` and `v` is present. Never start on `/shorts/`.
11. **Defensive checks:** every `movie_player` method is feature-tested. All YouTube internals live in one module (`content/yt.ts`) so breakage is fixed in one place. The Playwright e2e checks this module first.

## TypeScript draft: robust json3 fetch (runs in MAIN world)
```ts
type Track = { baseUrl: string; languageCode: string; kind?: string; vssId: string };
type J3 = { events?: { tStartMs: number; dDurationMs?: number; segs?: { utf8: string }[] }[] };

const captured = new Map<string, string>(); // videoId -> timedtext URL seen from player
const vid = (u: string) => new URL(u, location.origin).searchParams.get('v');

// install at document_start
const of = window.fetch;
window.fetch = function (i: RequestInfo | URL, init?: RequestInit) {
  const u = typeof i === 'string' ? i : i instanceof URL ? i.href : i.url;
  if (u.includes('/api/timedtext')) { const v = vid(u); if (v) captured.set(v, u); }
  return of.call(this, i, init);
};
const oo = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m: string, u: string | URL, ...r: any[]) {
  const s = String(u);
  if (s.includes('/api/timedtext')) { const v = vid(s); if (v) captured.set(v, s); }
  return (oo as any).call(this, m, u, ...r);
};

function fromPerf(v: string) {
  return performance.getEntriesByType('resource').map(e => e.name)
    .reverse().find(n => n.includes('/api/timedtext') && vid(n) === v);
}

async function waitCapture(v: string, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const u = captured.get(v) ?? fromPerf(v); if (u) return u;
    await new Promise(r => setTimeout(r, 150));
  }
  return undefined;
}

async function tryFetch(url: string, tlang?: string): Promise<J3 | null> {
  const u = new URL(url, location.origin);
  u.searchParams.set('fmt', 'json3');
  tlang ? u.searchParams.set('tlang', tlang) : u.searchParams.delete('tlang');
  const res = await fetch(u.href, { credentials: 'include' });
  if (res.status === 429) throw new Error('RATE_LIMITED');
  const txt = await res.text();
  if (!txt.trim()) return null;               // pot required / empty
  try { return JSON.parse(txt) as J3; } catch { return null; }
}

export async function getJson3(track: Track, videoId: string, tlang?: string): Promise<J3> {
  const p: any = document.getElementById('movie_player');
  // Swap lang/kind so a URL captured for another track still works.
  const retarget = (u: string) => {
    const x = new URL(u, location.origin);
    x.searchParams.set('lang', track.languageCode);
    track.kind ? x.searchParams.set('kind', track.kind) : x.searchParams.delete('kind');
    return x.href;
  };
  const candidates = [captured.get(videoId), fromPerf(videoId)].filter(Boolean) as string[];
  if (!track.baseUrl.includes('exp=xpe')) candidates.push(track.baseUrl);
  for (const c of candidates) { const j = await tryFetch(retarget(c), tlang); if (j?.events) return j; }

  // Make the player request captions itself (it attaches a valid pot).
  const wasOn = !!p?.getOption?.('captions', 'track')?.languageCode;
  p?.loadModule?.('captions');
  p?.setOption?.('captions', 'track', { languageCode: track.languageCode });
  const u = await waitCapture(videoId);
  if (!wasOn) p?.unloadModule?.('captions');
  if (u) { const j = await tryFetch(retarget(u), tlang); if (j?.events) return j; }
  throw new Error('CAPTIONS_UNAVAILABLE');
}
```
Notes: `getJson3` is called through the postMessage bridge from the isolated script. Whether `retarget` works on a token-bound URL is unverified: pot is bound to the video, not the language [1], so it should. The Playwright e2e must confirm this.
