// Free browser voices via speechSynthesis (§4). Owner: B.
import type { Lang, Line } from '../../shared/types';
import { LANG_INFO } from '../../shared/settings';
import { CPS } from '../sync/fit';
import type { ExpressionSource, PlayEnd, Prepared, PlayHandle, TtsEngine } from './engine';
import { webSpeechProsody } from '../../shared/prosody';
import { analyzeEmotion } from '../text/emotion';
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

/** Watchdog budget for one utterance: est*2.5 + 3000 ms (generous: a short budget cut slow voices mid-sentence). */
export function watchdogMs(text: string, lang: Lang, rate: number): number {
  const est = (text.length / (CPS[lang] * Math.max(0.1, rate))) * 1000;
  return est * 2.5 + 3000;
}

/** One measured line (Web Speech onstart→onend), for per-voice speed calibration. */
export interface SpeechMeasure { voice?: string; lang: Lang; text: string; rate: number; speechMs: number }

/** One line in the engine queue. */
interface Job {
  p: Prepared;
  chunks: string[];
  /** Index of the first chunk not finished yet. */
  next: number;
  /** Live utterance per chunk (null = not in the synth queue). */
  utts: (SpeechSynthesisUtterance | null)[];
  rate: number;
  volume: number;
  /** v1.2 (E): expressive utterance pitch and volume multiplier (absent = v1.1). */
  pitch?: number;
  volMul?: number;
  finished: boolean;
  resolve: (e: PlayEnd) => void;
  handle: PlayHandle;
  /** Sum of measured onstart→onend ms; NaN once a chunk had no onstart (no measurement). */
  measured: number;
  chunkStart: number | null;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Web Speech engine: waits voiceschanged (≤ 3 s), keeps utterance refs, re-applies the voice per utterance, splits > 180 chars.
 * v1.1: every chunk of a line is queued in speechSynthesis at once, and a line played while another is speaking is
 * queued right behind it (no onend→speak gap). A watchdog (est*2.5+3 s) guards the utterance at the head of the queue.
 * Stopping one line cancels the synth queue and re-queues the other unfinished lines, in order.
 */
export class WebSpeechEngine implements TtsEngine {
  readonly id = 'webspeech' as const;
  /** Strong refs: Chrome fires `end` instantly when an utterance is garbage-collected. */
  private live: SpeechSynthesisUtterance[] = [];
  private handles = new Set<{ stop(): void }>();
  private jobs: Job[] = [];
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private armedFor: SpeechSynthesisUtterance | null = null;
  /** Called after each fully spoken line with its measured speech time (calibration). */
  onMeasure?: (m: SpeechMeasure) => void;
  private expression: ExpressionSource | null = null;

  /** v1.2 (E): per-line pitch/volume from the line's emotion (null or expressiveness 0 = v1.1). */
  setExpression(src: ExpressionSource | null): void { this.expression = src; }

  /** No network; resolves with a text-only Prepared once voices are loaded (≤ 3 s). */
  async prepare(line: Line, lang: Lang, voice?: string): Promise<Prepared> {
    await loadWebVoices();
    return { line, lang, engine: 'webspeech', voice };
  }

  /** True: play() while a line is speaking queues the new line gaplessly behind it. */
  canQueue(): boolean { return true; }

  /** Speak at `rate` and `volume` (0..1): now, or right after the lines already queued. */
  play(p: Prepared, rate: number, volume: number): PlayHandle {
    const s = synth();
    const chunks = splitText(p.line.text);
    let resolveDone!: (e: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => (resolveDone = r));
    if (!s || typeof SpeechSynthesisUtterance === 'undefined' || !chunks.length) {
      resolveDone(chunks.length ? 'error' : 'ended');
      return { done, stop() {}, pause() {}, resume() {} };
    }
    // Stale queue from an earlier session (Chrome sometimes gets stuck after cancel()).
    if (!this.jobs.length && (s.speaking || s.pending)) s.cancel();

    const job: Job = {
      p, chunks, next: 0, utts: chunks.map(() => null), rate, volume, finished: false, resolve: resolveDone,
      handle: null as unknown as PlayHandle, measured: 0, chunkStart: null,
    };
    job.handle = {
      done,
      stop: () => this.stopJob(job),
      pause: () => this.pause(),
      resume: () => this.resume(),
      setRate: (r: number) => { job.rate = r; }, // applies to chunks queued later (requeue)
      setVolume: (v: number) => { job.volume = v; },
    };
    if (this.expression) {
      try {
        const ctx = this.expression();
        const wp = webSpeechProsody(p.line.emotion ?? analyzeEmotion(p.line), ctx.arousal, ctx.expressiveness);
        if (wp) { job.pitch = wp.pitch; job.volMul = wp.volume; }
      } catch { /* plain line */ }
    }
    this.jobs.push(job);
    this.handles.add(job.handle);
    this.enqueue(job);
    this.armHead();
    return job.handle;
  }

  /** Cancel everything queued or speaking. */
  stopAll(): void {
    const jobs = this.jobs.splice(0);
    for (const j of jobs) this.finish(j, 'stopped', false);
    for (const h of [...this.handles]) h.stop();
    this.handles.clear();
    this.live = [];
    this.disarm();
    this.paused = false;
    const s = synth();
    if (s) s.cancel();
  }

  // ---------------- internals ----------------

  /** Put the job's remaining chunks into the synth queue. */
  private enqueue(job: Job): void {
    const s = synth();
    if (!s) return;
    for (let i = job.next; i < job.chunks.length; i++) {
      const u = new SpeechSynthesisUtterance(job.chunks[i]);
      u.lang = LANG_INFO[job.p.lang].bcp47;
      const v = findWebVoice(job.p.voice) ?? bestWebVoiceSync(job.p.lang); // re-applied every utterance
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = clampRate(job.rate);
      u.volume = clamp01(job.volume * (job.volMul ?? 1));
      if (job.pitch != null) u.pitch = Math.min(2, Math.max(0, job.pitch));
      const idx = i;
      u.onstart = () => {
        if (job.utts[idx] !== u) return;
        job.chunkStart = nowMs();
        this.arm(u, job); // re-arm from the real start
      };
      u.onend = () => {
        if (job.utts[idx] !== u) return;
        if (job.chunkStart != null) job.measured += nowMs() - job.chunkStart;
        else job.measured = NaN;
        job.chunkStart = null;
        this.chunkDone(job, idx, u);
      };
      u.onerror = (ev: SpeechSynthesisErrorEvent) => {
        if (job.utts[idx] !== u) return;
        job.utts[idx] = null;
        this.drop(u);
        this.finish(job, ev.error === 'interrupted' || ev.error === 'canceled' ? 'stopped' : 'error');
        this.armHead();
      };
      job.utts[idx] = u;
      this.live.push(u);
      s.speak(u);
    }
  }

  private chunkDone(job: Job, idx: number, u: SpeechSynthesisUtterance): void {
    job.utts[idx] = null;
    this.drop(u);
    job.next = Math.max(job.next, idx + 1);
    if (job.next >= job.chunks.length) {
      if (Number.isFinite(job.measured) && job.measured > 0) {
        try { this.onMeasure?.({ voice: job.p.voice, lang: job.p.lang, text: job.p.line.text, rate: job.rate, speechMs: job.measured }); } catch { /* ignore */ }
      }
      this.finish(job, 'ended');
    }
    this.armHead();
  }

  private finish(job: Job, e: PlayEnd, remove = true): void {
    if (job.finished) return;
    job.finished = true;
    for (let i = 0; i < job.utts.length; i++) {
      const u = job.utts[i];
      if (u) this.drop(u);
      job.utts[i] = null;
    }
    if (remove) {
      const k = this.jobs.indexOf(job);
      if (k >= 0) this.jobs.splice(k, 1);
    }
    this.handles.delete(job.handle);
    job.resolve(e);
  }

  private stopJob(job: Job): void {
    if (job.finished) return;
    const inSynth = job.utts.some(Boolean);
    this.finish(job, 'stopped');
    if (inSynth) this.restartQueue();
  }

  /** cancel() empties the whole synth queue: re-queue the unfinished lines (in order) behind it. */
  private restartQueue(): void {
    const s = synth();
    for (const j of this.jobs) {
      for (let i = 0; i < j.utts.length; i++) {
        const u = j.utts[i];
        if (u) this.drop(u);
        j.utts[i] = null;
      }
      j.chunkStart = null;
    }
    this.disarm();
    if (s) s.cancel();
    for (const j of this.jobs) this.enqueue(j);
    if (this.paused && s) s.pause();
    this.armHead();
  }

  /** Watchdog on the utterance at the head of the queue (Chrome sometimes never fires `end`). */
  private armHead(): void {
    if (this.paused) return;
    const job = this.jobs.find((j) => !j.finished);
    const u = job ? job.utts[job.next] : null;
    if (!job || !u) { this.disarm(); return; }
    if (this.armedFor === u) return;
    this.arm(u, job);
  }

  private arm(u: SpeechSynthesisUtterance, job: Job): void {
    this.disarm();
    if (this.paused) return;
    this.armedFor = u;
    this.timer = setTimeout(() => {
      this.armedFor = null;
      const idx = job.utts.indexOf(u);
      if (job.finished || idx < 0) return;
      // Stuck (no `end`): count it as spoken, cancel, and re-queue what is left.
      job.measured = NaN;
      job.utts[idx] = null;
      this.drop(u);
      job.next = Math.max(job.next, idx + 1);
      if (job.next >= job.chunks.length) this.finish(job, 'ended');
      this.restartQueue();
    }, watchdogMs(u.text, job.p.lang, job.rate));
  }

  private disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.armedFor = null;
  }

  private pause(): void {
    if (this.paused || !this.jobs.length) return;
    this.paused = true;
    this.disarm();
    // A pause breaks the onstart→onend measurement of the chunk in flight.
    for (const j of this.jobs) if (j.chunkStart != null) { j.chunkStart = null; j.measured = NaN; }
    synth()?.pause();
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    synth()?.resume();
    this.armHead();
  }

  private drop(u: SpeechSynthesisUtterance): void {
    const k = this.live.indexOf(u);
    if (k >= 0) this.live.splice(k, 1);
  }
}

function synth(): SpeechSynthesis | undefined {
  return typeof speechSynthesis !== 'undefined' ? speechSynthesis : undefined;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
const clampRate = (r: number): number => (Number.isFinite(r) ? Math.min(2, Math.max(0.5, r)) : 1);
