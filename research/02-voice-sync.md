# 02 — Voice + sync (research, 2026-11-23)

## Sources
- S1 Readium, "SpeechSynthesis in browsers and OSes": https://readium.org/speech/docs/WebSpeech.html
- S2 MDN, voiceschanged / getVoices: https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/voiceschanged_event
- S3 PhET utterance-queue issue (Chrome ~15 s cutoff, pause/resume fix): https://github.com/phetsims/utterance-queue/issues/60
- S4 SO archive, "chrome speech synthesis with longer texts": https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/21947730/chrome-speech-synthesis-with-longer-texts
- S5 PlayCanvas forum, "onend gets called instantly on chrome": https://forum.playcanvas.com/t/window-speechsynthesis-onend-gets-called-instantly-on-chrome/29515
- S6 chrome.tts API: https://developer.chrome.com/docs/extensions/reference/api/tts
- S7 chrome.offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- S8 guest271314 gist, capturing speechSynthesis output (needs OS loopback): https://gist.github.com/guest271314/baaa0b8d4b034ff4e9352af4f2bbf42c
- S9 chromium-dev, "speechSynthesis.pause() does not pause ... when recording via getDisplayMedia": https://groups.google.com/a/chromium.org/g/chromium-dev/c/FShFi397rvo
- S10 OpenAI pricing: https://developers.openai.com/api/docs/pricing
- S11 OpenAI TTS guide: https://developers.openai.com/api/docs/guides/text-to-speech
- S12 ElevenLabs models: https://elevenlabs.io/docs/models
- S13 ElevenLabs API pricing: https://elevenlabs.io/pricing/api

## Findings

### Web Speech API in Chrome (macOS)
- **Voices.** Chrome desktop lists (a) all installed macOS system voices (`localService: true`) and (b) ~19 "Google …" network voices across ~15 languages (`localService: false`), which need internet (S1, S2). Google voices exist for fr-FR, es-ES/es-US, en-US/en-GB; **no Google Arabic or Turkish voice is in the desktop set** (from memory, not confirmed by S1, which does not list the languages). So ar and tr rely on macOS voices (e.g. Maged ar-SA, Yelda tr-TR; Siri/"enhanced" variants need downloading in System Settings > Accessibility > Spoken Content). Treat as unverified until the voice-probe in Decision 2 runs.
- **Async load.** `getVoices()` returns `[]` at first in Chrome; wait for `voiceschanged` (S2).
- **~14–15 s cutoff.** Utterances on Google network voices stop silently after ~14–15 s, with no `end`/`error` event (S1, S3). Fixes: keep every utterance short (chunk under ~12 s of speech), or run a pause()+resume() timer every ~14 s only for `localService:false` voices (S3, S4). AutoDub lines are sentence-sized, so chunking is enough.
- **Events.** Google desktop voices **do not fire `boundary` events** (S1). `onend` is mostly reliable, but known failures are: fires instantly when the utterance object is garbage-collected (keep a strong reference), never fires after the cutoff, and a stuck queue after `cancel()` (S5, S3). So a watchdog timeout is needed.
- **Rate.** Spec range 0.1–10; chrome.tts says voices "may limit the range further" (S6). Google voices sound good up to about 1.5. 1.3 is safe for all.
- **Where it runs.** `window.speechSynthesis` works in a content script (it is a page-world DOM API; no offscreen document needed). Alternatively `chrome.tts` (permission `tts`) gives `start/end/word/interrupted/cancelled/error` events and a `remote` flag (S6). An offscreen document with reason `AUDIO_PLAYBACK` is only needed for audio played outside a tab, and it closes after 30 s of silence (S7).

### Casting to TV (Cast tab)
- Cast tab mirrors the **tab's** audio output. `speechSynthesis` audio is **not tab audio**: macOS voices are played by the OS speech service, and Google network voices are played by Chrome's built-in TTS component extension, not the page. Capturing speechSynthesis needs OS-level loopback (S8). Related: Chromium's getDisplayMedia capture treats speech synthesis apart from page media (S9). **Conclusion (inferred, verify with a 1-minute manual test): Web Speech dubs will play on the Mac speakers, not on the TV.**
- What works: audio produced as **bytes and played inside the YouTube tab** (an `<audio>` element or a WebAudio `AudioContext` created in the content script). Tab-cast and tab-capture pick that up. Audio played in an offscreen document or the popup is not in the tab, so it is not cast either.
- So the TV path = OpenAI/ElevenLabs engine (or any engine returning audio bytes) with playback in the content script.

### OpenAI TTS
- `POST https://api.openai.com/v1/audio/speech`, models `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`; formats mp3 (default), opus, aac, flac, wav, pcm (24 kHz 16-bit LE); chunked streaming; "fastest: wav or pcm" (S11). fr/ar/es/tr work well, voices tuned for English (S11).
- Price: `tts-1` $15/1M chars, `tts-1-hd` $30/1M chars, `gpt-4o-mini-tts` $0.60/1M text-in tokens + $12/1M audio-out tokens (S10), about $0.015/min.
- **The guide says all three models shut down on 2027-01-06**; the replacement is `gpt-realtime-2.1-mini` via the Realtime API, which `/v1/audio/speech` does not serve (S11). Build behind an interface; expect a Realtime adapter soon.
- Latency: not given in the docs. In practice, time to first byte is a few hundred ms for short lines. Pre-generating 30 s ahead hides it.

### ElevenLabs
- `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` (plus `/stream`), header `xi-api-key`.
- `eleven_flash_v2_5`: ~100 ms latency, 32 languages including en/fr/ar/es/tr, 40k-char limit, half price. `eleven_turbo_v2_5` is deprecated in favour of Flash. `eleven_multilingual_v2`: 29 languages, all 5 included. `eleven_v3`: 70+ (S12).
- Price: **$0.04 / 1k chars Flash/Turbo, $0.08 / 1k chars Multilingual v2/v3** (S13). A 10-min video is about 9k chars, so about $0.36 on Flash.

### Timing fit + sync
- Initial speech-rate priors at rate 1.0 (chars/sec, from measured TTS throughput; calibrate live): en 14, es 15, fr 14, tr 13, ar 12 (written Arabic omits short vowels, so fewer chars per second of speech).
- Self-calibrate: after each line, measure `actualMs / chars` per voice (EWMA α=0.2), store per voice in `chrome.storage.local`.
- For API engines the true duration is known after decode (`AudioBuffer.duration`). Fit with `playbackRate` (set `preservesPitch = true` on `<audio>`; WebAudio `playbackRate` shifts pitch, so prefer `<audio>` or accept it up to 1.3).
- Ducking: `video.volume` is simple and works with MSE blob sources. Ramp in ~6 steps over 150 ms and save/restore the user's level. Listen for `volumechange` so a user change is not overwritten. `createMediaElementSource(video)` takes over the element's output for good and can fight YouTube's player, so do not use it in v1.

## Decisions for AutoDub
1. **Engine interface** `TtsEngine { prepare(line): Promise<Prepared>; play(p, rate): Handle; stop() }` with `WebSpeechEngine` (no bytes, speaks live) and `AudioEngine` (OpenAI/ElevenLabs → ArrayBuffer cached in IndexedDB, played in content script).
2. **Voice probe** at startup: await `voiceschanged` (timeout 3 s), pick the best voice per lang: prefer `localService:false` for en/fr/es, macOS enhanced/premium for ar/tr. If none for the target, show "Install an Arabic voice: System Settings > Accessibility > Spoken Content".
3. **Web Speech runs in the content script.** Keep utterances in an array (stops GC from firing `onend` early). Split any line over 180 chars / ~12 s at punctuation. Watchdog: if no `end` within `est*1.6+1500 ms`, call `cancel()` and move on.
4. **No pause/resume hack** (lines are short); still apply it if a single utterance runs over 12 s on a `localService:false` voice.
5. **TV mode:** popup "Watch on TV" says plainly that free voices play on the Mac, not the TV, and offers the API engine. API audio always plays via a content-script `AudioContext`/`<audio>`, never offscreen. Create/resume the AudioContext on the user's click on the in-player Dub badge (autoplay policy).
6. **Fit algorithm:** slot = `nextStart − start` (capped at `end − start + 600 ms` if the gap is longer). Rate = clamp(est/slot, 1.0, 1.3). If it still overflows, borrow the gap up to the next line, minus 100 ms. If it still overflows, start the line anyway and set `debt` so the next line starts at its own time (cancel the remainder); lag never carries over.
7. **Scheduler** is driven by `video.currentTime` (requestVideoFrameCallback or 50 ms timer), not wall clock: fire a line when `t >= start − leadMs` (lead = 80 ms WebSpeech / 30 ms audio). Drift check every tick: if the playing line's media-time offset is > 300 ms off, re-rate (audio) or cancel and speak the next line on time (WebSpeech).
8. **Player events:** `pause` → speechSynthesis.pause()/audio.pause(); `seeking` → cancel all, reset cursor via binary search; `ratechange` → multiply rate by `video.playbackRate`, and above 1.3 total skip lines that do not fit. Ads (`.ad-showing` on the player) → stop + restore volume.
9. **Duck** default 15 %: ramp down 150 ms before a line, restore 250 ms after `end`, unless the next line starts within 400 ms.
10. **OpenAI default model** `gpt-4o-mini-tts`, format `mp3` (cache) or `pcm` (lowest latency). ElevenLabs default `eleven_flash_v2_5`. Show cost estimate in popup: chars × price.
11. **Calibration** per voice stored locally; feeds `estimateMs`. Thumbs-down on a line logs `{lineId, rate, overflowMs}`.

## TypeScript draft
```ts
export type Lang = 'en' | 'fr' | 'ar' | 'es' | 'tr';
export interface Line { id: string; start: number; end: number; text: string } // seconds
export interface Plan { line: Line; rate: number; startAt: number; maxMs: number; trimmed: boolean }

const CPS: Record<Lang, number> = { en: 14, es: 15, fr: 14, tr: 13, ar: 12 };
const MAX_RATE = 1.3, GAP_GUARD = 0.1, TAIL = 0.6;

export function estimateMs(text: string, lang: Lang, cal?: number): number {
  const cps = cal ?? CPS[lang];
  const pauses = (text.match(/[,.;:!?،؟]/g)?.length ?? 0) * 120;
  return (text.replace(/\s+/g, ' ').length / cps) * 1000 + pauses;
}

/** knownMs = decoded audio duration for API engines. */
export function fit(line: Line, next: Line | undefined, lang: Lang, knownMs?: number, cal?: number): Plan {
  const natural = knownMs ?? estimateMs(line.text, lang, cal);
  const hardEnd = next ? next.start - GAP_GUARD : line.end + TAIL * 4;
  const slotMs = Math.max(200, (Math.min(hardEnd, line.end + TAIL)) * 1000 - line.start * 1000);
  let rate = Math.min(MAX_RATE, Math.max(1, natural / slotMs));
  let maxMs = slotMs, trimmed = false;
  if (natural / rate > slotMs) {                      // borrow the gap
    maxMs = Math.max(slotMs, (hardEnd - line.start) * 1000);
    trimmed = natural / rate > maxMs;                 // will be cut at maxMs
  }
  return { line, rate, startAt: line.start, maxMs, trimmed };
}

export interface Clock { now(): number }              // media time (s); fake in tests
export interface Speaker { speak(p: Plan, playbackRate: number): Promise<void>; cancel(): void }

export class Scheduler {
  private i = 0; private busy = false; private cutTimer?: ReturnType<typeof setTimeout>;
  constructor(private plans: Plan[], private clock: Clock, private spk: Speaker,
              private leadS = 0.08, private videoRate = () => 1) {}

  seek(t: number) {                                   // binary search, drop everything
    this.spk.cancel(); this.busy = false; clearTimeout(this.cutTimer);
    let lo = 0, hi = this.plans.length;
    while (lo < hi) { const m = (lo + hi) >> 1; this.plans[m].startAt < t ? lo = m + 1 : hi = m; }
    this.i = lo;
  }

  tick() {                                            // call ~every 50 ms while playing
    const t = this.clock.now(), p = this.plans[this.i];
    if (!p) return;
    if (t > p.startAt + 0.3 && !this.busy) { this.i++; return this.tick(); } // stale: skip, no lag carry
    if (t < p.startAt - this.leadS) return;
    if (this.busy) { this.spk.cancel(); clearTimeout(this.cutTimer); }      // previous overran: cut
    this.busy = true; this.i++;
    const vr = this.videoRate();
    this.cutTimer = setTimeout(() => this.spk.cancel(), p.maxMs / vr + 150);
    this.spk.speak(p, p.rate * vr).finally(() => { this.busy = false; clearTimeout(this.cutTimer); });
  }
}
```
Unit tests: fake `Clock` that advances by 50 ms steps; assert each line starts within 300 ms of `start` over a 1 h synthetic track (no growing lag), that a seek resets the cursor, and that rate is never above 1.3.
