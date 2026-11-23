// Free browser voices via speechSynthesis (§4). Owner: B.
import type { Lang, Line } from '../../shared/types';
import { LANG_INFO } from '../../shared/settings';
import { CPS } from '../sync/fit';
import type { PlayEnd, Prepared, PlayHandle, TtsEngine } from './engine';
import { bestWebVoiceSync, findWebVoice, loadWebVoices } from './voices';

/** Max characters per utterance (Chrome cuts network voices after ~15 s). */
export const MAX_CHUNK = 180;

/** Split text into chunks ≤ max chars, at sentence punctuation, then commas, then spaces. */
export function splitText(text: string, max = MAX_CHUNK): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    const win = rest.slice(0, max + 1);
    let cut = -1;
    for (const re of [/[.!?…。؟؛](?=\s)/g, /[,;:،](?=\s)/g, /\s/g]) {
      let m: RegExpExecArray | null;
      let last = -1;
      while ((m = re.exec(win))) if (m.index > max * 0.3) last = m.index + (m[0].trim() ? 1 : 0);
      if (last > 0) { cut = last; break; }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Watchdog budget for one utterance (§4): est*1.6 + 1500 ms. */
export function watchdogMs(text: string, lang: Lang, rate: number): number {
  const est = (text.length / (CPS[lang] * Math.max(0.1, rate))) * 1000;
  return est * 1.6 + 1500;
}

/** Web Speech engine: waits voiceschanged (≤ 3 s), keeps utterance refs, re-applies voice per utterance, watchdog est*1.6+1500 ms, splits > 180 chars. */
export class WebSpeechEngine implements TtsEngine {
  readonly id = 'webspeech' as const;
  /** Strong refs: Chrome fires `end` instantly when an utterance is garbage-collected. */
  private live: SpeechSynthesisUtterance[] = [];
  private handles = new Set<{ stop(): void }>();

  /** No network; resolves with a text-only Prepared once voices are loaded (≤ 3 s). */
  async prepare(line: Line, lang: Lang, voice?: string): Promise<Prepared> {
    await loadWebVoices();
    return { line, lang, engine: 'webspeech', voice };
  }

  /** Speak now at `rate` and `volume` (0..1). */
  play(p: Prepared, rate: number, volume: number): PlayHandle {
    const s = typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined;
    const chunks = splitText(p.line.text);
    let resolveDone!: (e: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => (resolveDone = r));
    if (!s || typeof SpeechSynthesisUtterance === 'undefined' || !chunks.length) {
      resolveDone(chunks.length ? 'error' : 'ended');
      return { done, stop() {}, pause() {}, resume() {} };
    }
    // Stale queue from an earlier session (Chrome sometimes gets stuck after cancel()).
    if (!this.handles.size && (s.speaking || s.pending)) s.cancel();

    let i = 0;
    let finished = false;
    let paused = false;
    let curRate = rate;
    let curVol = volume;
    let current: SpeechSynthesisUtterance | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (e: PlayEnd) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.handles.delete(handle);
      if (current) this.drop(current);
      current = null;
      resolveDone(e);
    };
    const arm = (u: SpeechSynthesisUtterance) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (finished || current !== u) return;
        // Stuck (no `end`): cancel and move on.
        current = null;
        this.drop(u);
        s.cancel();
        next();
      }, watchdogMs(u.text, p.lang, curRate));
    };
    const next = () => {
      if (finished) return;
      if (i >= chunks.length) return finish('ended');
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      u.lang = LANG_INFO[p.lang].bcp47;
      const v = findWebVoice(p.voice) ?? bestWebVoiceSync(p.lang); // re-applied every utterance
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = clampRate(curRate);
      u.volume = clamp01(curVol);
      u.onend = () => {
        if (current !== u) return;
        current = null;
        this.drop(u);
        next();
      };
      u.onerror = (ev: SpeechSynthesisErrorEvent) => {
        if (current !== u) return;
        current = null;
        this.drop(u);
        if (ev.error === 'interrupted' || ev.error === 'canceled') return finish('stopped');
        finish('error');
      };
      current = u;
      this.live.push(u);
      s.speak(u);
      if (!paused) arm(u);
    };

    const handle: PlayHandle = {
      done,
      stop: () => {
        if (finished) return;
        const u = current;
        finish('stopped');
        if (u) s.cancel();
      },
      pause: () => {
        if (finished || paused) return;
        paused = true;
        clearTimeout(timer);
        s.pause();
      },
      resume: () => {
        if (finished || !paused) return;
        paused = false;
        s.resume();
        if (current) arm(current);
      },
      setRate: (r: number) => { curRate = r; }, // applies from the next chunk
      setVolume: (v: number) => { curVol = v; },
    };
    this.handles.add(handle);
    next();
    return handle;
  }

  /** Cancel everything queued or speaking. */
  stopAll(): void {
    for (const h of [...this.handles]) h.stop();
    this.handles.clear();
    this.live = [];
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  private drop(u: SpeechSynthesisUtterance): void {
    const k = this.live.indexOf(u);
    if (k >= 0) this.live.splice(k, 1);
  }
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
const clampRate = (r: number): number => (Number.isFinite(r) ? Math.min(2, Math.max(0.5, r)) : 1);
