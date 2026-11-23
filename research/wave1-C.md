# Wave 1 — C: sync engine, player control, pitch, session (2026-11-23)

## Status
- `npx tsc --noEmit`: clean (whole project, at time of writing).
- `npx vitest run tests/unit/c-`: 6 files, 38 tests pass (fit, scheduler, player, pitch, session, smoke).
- `node build.mjs --outdir build-c`: builds. Nothing built into `dist/`, no commit.

## Built
| File | What |
|---|---|
| `sync/fit.ts` | `estimateMs` (CPS × `cpsFactor`, +120 ms per pause mark), `fit`. Slot = min(next−0.1, end+0.6), min 200 ms. Rate = clamp(natural/voiceSpeed/slot, 1, 1.3) × voiceSpeed. `maxMs` = gap up to next−0.1 (last line: end+2.4 s). `trimmed` = still too long, so the cut will apply. |
| `sync/scheduler.ts` | Runs on media time: a 50 ms interval plus `requestVideoFrameCallback` (`opts.video`). Lead 80/30 ms. A line that has not started and is more than 300 ms late is skipped. An overrun is cut at `t0+maxMs`, or when the next line starts. Seek = `stopAll` + binary search (`lowerBound`). It also has pause/resume, `rateChanged()` (rate × playbackRate, capped at `maxTotalRate` 2; a line that would need more than 1.5× that cap is skipped) and `setLines`. If time jumps back more than 0.5 s without a seek event, it resyncs. It also drives ducking (`onDuck`): down 150 ms before the lead, back up 250 ms after speech ends, held if the next line is within 400 ms. |
| `sync/player.ts` | `PlayerWatcher`: video events (pause/play/seek events are ignored during ads), and a MutationObserver for `ad-showing`/`ad-interrupting` → restore volume + `onAdStart`/`onAdEnd`. Ducking ramps 150 ms down / 250 ms up in 25 ms steps. A user volume change becomes the new baseline. `useGain(sink)` sends ducking through the WebAudio GainNode. `stop()` restores volume. `onNavigate` = `yt-navigate-finish` + `popstate`, deduped by URL. |
| `sync/pitch.ts` | `estimateF0` (autocorrelation; halves rates ≥ 32 kHz; picks the shortest lag ≥ 0.9 × best peak; RMS < 0.01 or correlation < 0.5 → unvoiced), `classifyFrames` (< 30 % voiced → unknown; median < 165 Hz → male), `captionGender` (`Line.gender`, `[Man]`/`(femme)`… in 5 languages). `SpeakerPitch`: graph source→gain→destination plus source→analyser, so the analyser hears the original before ducking. One graph per `<video>` (WeakMap; a MediaElementSource can be created only once per element). **It never routes the video through a suspended AudioContext** (that would mute YouTube): it waits ≤ 1 s for `resume`, otherwise closes the context and returns false. `observe(line)` / `predicted()` give the "previous speaker" prediction. |
| `session.ts` | `DubSession`: preparing → `getLines` (progress → `status.message`) → engine → voices (user voice, best voice, `pickVoiceFor` male/female with `preferredId`; `resetVoiceChoices()` on each start) → wait for the first line only (≤ 4 s) → scheduler → `dubbing` (or `paused-ad`). Prefetch: API engines only, 30 s ahead, max 3 in flight. Web Speech prepares at speak time, so the voice follows the live speaker guess. Voice gender: caption label → previous lines' pitch → unknown (best voice). On engine error (`onFallback`, a rejected prepare, or play returning 'error'): toast + switch to Web Speech once. `stop()` = scheduler/engine stop + `dispose?.()` + watcher stop (volume restored) + pitch stop. `firstLineMs` goes into the status and into storage `stats.firstLine` (ring of 50). In-session CPS calibration (EWMA) for Web Speech. `feedbackFor(line, up)` gives a `Feedback` with rate + overflowMs. `updateSettings`: duck level and volume change live; lang/engine/voice/gender-match → restart. Deps are injectable (tests). |
| `index.ts` | `bootstrap()`: `chrome.runtime.onMessage` (DUB_TOGGLE, GET_STATUS, LIST_VOICES → `listVoices(lang, settings.engine)`, TEST_VOICE → `createEngine(engine)`.prepare+play+dispose). It also runs settings changes, navigation (tears the session down on a new video, unmounts the UI off /watch, and restarts dub on the next video if the user turned it on in this tab, i.e. a playlist), `mountPlayerUI(uiApi, getPlayer())` in try/catch, STATUS broadcast + `ui.update` on every status, subtitles via `onLine`, thumbs → `saveFeedback(session.feedbackFor())`, and `pagehide` → stop. Exports `handleMessage`, `handleNavigation`, `toggleDub`, `currentStatus` for tests. |

## Wave 1 integration with A (after A finished)
- `getLines(videoId, lang, onProgress, { fromTime: video.currentTime, onUpdate })` is now called in progressive mode. The first ~40 lines start the scheduler, and later chunks go through `applyLines` → `Scheduler.setLines` (+ prefetch pump).
- `Scheduler.setLines` keeps the cursor by time and never replays a line that has already started: the cursor is set to max(lowerBound(now−300 ms), upperBound(lastStartedAt)). A seek resets this.
- `warmUpTranslator(to, onProgress)` (exported from `session.ts`; dep `warmUpTranslator`) runs synchronously in `start()` before the first `await`, so the Dub click's user activation is still active. While the session is preparing, it shows "Downloading French translator… 40%" in `status.message`. The pipeline's own progress texts also go to `status.message`. The source language is not known at click time, so the warm-up only creates **en → target** (skipped when the target is en, or when `Translator` is not in the isolated world). Other source languages still depend on activation lasting until A's `translateLocal` runs. **Request A:** an exported `warmUpTranslator(from?, to)` that also works through the MAIN-world bridge, or a cheap sync way to read the source track language, would make this exact.

## Public API additions (all additive)
- fit: `GAP_GUARD_S, TAIL_S, LAST_LINE_TAIL_S, MIN_SLOT_MS`.
- scheduler: `SchedulerOptions.{onDuck, duckLeadMs, duckRestoreMs, duckHoldMs, maxTotalRate, video, onTick}`, `Scheduler.{isRunning, current, cursorIndex, getLines, isPaused, rateChanged}`, `lowerBound`. `Speaker.speak` receives `plan.rate` already × playbackRate.
- player: `PlayerWatcher.{useGain, setDuckLevel, checkAd, duckFactor, getUserVolume}`, `DUCK_DOWN_MS`, `DUCK_UP_MS`.
- pitch: `SpeakerPitch(video, opts?)`, `.startAsync()`, `.hasGraph()`, `.addFrame()`, `.observe()`, `.predicted()`; `estimateF0`, `classifyFrames`, `captionGender`, `PitchFrame`, constants.
- session: `DubSessionOptions.{deps, onToast, onLine}`, `DubSessionDeps`, `DubSession.{isActive, feedbackFor, videoId}`, `saveFirstLineStat`, `FirstLineStat`, `PREFETCH_S`, `PREFETCH_CONCURRENCY`.
- index: `TEST_LINES`, `toggleDub`, `currentStatus`, `handleMessage`, `handleNavigation`, `_resetForTests`.

## Behaviour notes / decisions
- `settings.enabled`: when it changes to false, all tabs stop; when it changes to true, only the **visible** tab starts. DUB_TOGGLE does not persist `enabled`; it sets a per-tab "keep dubbing next videos" flag (not L3 auto-dub across browser restarts).
- `firstLineMs` = time from Dub click to the first line actually spoken. If the video's first caption comes late, this is longer than 5 s (that is not a bug in the metric).
- Pitch for API engines: the voice is bound at prefetch time (≤ 30 s ahead), so the speaker guess can be up to 30 s old. Caption labels are always current. We do not prepare both genders, because that would double the paid cost.
- AudioContext is created before the first `await` in `start()`, so a click on the in-player button counts as the user gesture. A toggle from the popup only works if the page already has sticky activation; otherwise pitch is off and ducking uses `video.volume`.

## Open issues
- Real-page checks still to do: whether Chrome reports `AudioContext.state === 'running'` straight after construction with sticky activation; whether YouTube MSE audio reaches the analyser (if it is tainted → always 'unknown', harmless); rVFC + hidden tab behaviour.
- The `cpsFactor` calibration lasts only for the session (not stored per voice, which 02 #11 suggests).
- `visibilitychange` is not used beyond the drift/late-skip logic. An audible tab is not throttled.

## Requests
1. **D (`player-ui.ts`)**: `mountPlayerUI(api, player)` is called once per watch page (C destroys it when leaving /watch). Thumbs go through `api.onThumb(line, up)` (C saves feedback). Toast kinds used: info/warn/error. Please call `api.toggle()` from the Dub button's click handler directly (user gesture → WebAudio).
2. **D (popup)**: send `DUB_TOGGLE` for the On/Off switch. Persisting `settings.enabled` also works (visible tab only). Time-to-first-line samples are in `storage.local.stats.firstLine: {videoId, lang, engine, ms, at}[]`.
3. **A (`yt.ts`)**: C relies on `isWatchPage(url)` and `getVideoId(url)` accepting a URL argument, and `getVideo()` returning the main `<video>`.
4. **B**: done (onFallback, dispose, resetVoiceChoices, preferredId, LIST_VOICES/TEST_VOICE as asked). The provider `speed` is **not** passed: voiceSpeed is already in the fit rate.
