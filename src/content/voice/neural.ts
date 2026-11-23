// v1.1 'neural' engine: free Piper voices synthesized on this computer (offscreen WASM), played via <audio>. Owner: P.
// prepare() → NEURAL_TTS (SW → offscreen) → WAV base64 → Blob URL with exact knownMs (great for sync).
// While a model is still downloading (or on an error) the line is voiced by Web Speech instead: never silence.
import { DubError, type Gender, type Lang, type Line } from '../../shared/types';
import { sendToSW, type Msg, type ResponseOf } from '../../shared/messages';
import type { PlayHandle, Prepared, TtsEngine } from './engine';
import { AudioEngine, b64ToBlob } from './audio';
import { WebSpeechEngine } from './webspeech';
import { pickVoiceFor } from './voices';
import { defaultNeuralVoice, neuralVoice } from './neural-catalog';

/** Blob URLs kept alive (prepared lines). WAV ≈ 45 KB/s → ~60 × 200 KB. */
export const NEURAL_URL_LRU = 60;
/** After a "still downloading" answer, skip asking again for this long (use Web Speech directly). */
export const PENDING_BACKOFF_MS = 3000;
/** Consecutive real errors before asking the session to fall back for good. */
export const MAX_ERRORS = 3;
/** Offscreen synthesis budget per line (first line also loads the model). */
const NEURAL_TIMEOUT_MS = 20_000;

export interface NeuralEngineOptions {
  send?: (msg: Extract<Msg, { type: 'NEURAL_TTS' }>) => Promise<ResponseOf<'NEURAL_TTS'>>;
  onFallback?: (err: DubError) => void;
  /** Web Speech voice for a gender while neural audio is not available. */
  webVoiceFor?: (lang: Lang, gender: Gender) => Promise<string | undefined>;
  web?: TtsEngine;
}

type Entry = { prepared: Prepared; url: string; at: number };

export class NeuralEngine implements TtsEngine {
  readonly id = 'neural' as const;
  private readonly opts: NeuralEngineOptions;
  private readonly web: TtsEngine;
  /** Reused only for its <audio> player (play/stopAll). */
  private readonly player = new AudioEngine('openai');
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Prepared>>();
  private pendingUntil = new Map<string, number>();
  private errors = 0;
  private failed = false;
  /** Last download progress seen (0..1) while a model downloads; undefined when ready. */
  downloadProgress: number | undefined;

  constructor(opts: NeuralEngineOptions = {}) {
    this.opts = opts;
    this.web = opts.web ?? new WebSpeechEngine();
  }

  onFallback(cb: (err: DubError) => void): void {
    this.opts.onFallback = cb;
  }

  prepare(line: Line, lang: Lang, voice?: string): Promise<Prepared> {
    const v = neuralVoice(voice)?.lang === lang ? neuralVoice(voice)! : defaultNeuralVoice(lang);
    if (!v) return this.viaWeb(line, lang, 'unknown');
    const key = `${v.id}|${line.id}|${line.text}`;
    const hit = this.entries.get(key);
    if (hit) { hit.at = Date.now(); return Promise.resolve(hit.prepared); }
    const p = this.pending.get(key);
    if (p) return p;
    const job = this.fetchOne(line, lang, v.id, v.model, v.gender, key).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  private async fetchOne(line: Line, lang: Lang, voice: string, model: string, gender: Gender, key: string): Promise<Prepared> {
    if (this.failed || (this.pendingUntil.get(model) ?? 0) > Date.now()) return this.viaWeb(line, lang, gender);
    let res: ResponseOf<'NEURAL_TTS'>;
    try {
      const send = this.opts.send ?? ((m) => sendToSW(m, NEURAL_TIMEOUT_MS));
      res = await send({ type: 'NEURAL_TTS', text: line.text, lang, voice });
    } catch (e) {
      res = { ok: false, error: 'NETWORK', message: e instanceof Error ? e.message : String(e) };
    }
    if (res.ok && res.pending) {
      this.downloadProgress = res.progress ?? 0;
      this.pendingUntil.set(model, Date.now() + PENDING_BACKOFF_MS);
      return this.viaWeb(line, lang, gender);
    }
    if (!res.ok || !res.audioB64) {
      this.errors++;
      if (this.errors >= MAX_ERRORS && !this.failed) {
        this.failed = true;
        const err = new DubError(res.ok ? 'ENGINE_ERROR' : res.error, res.ok ? 'Empty neural audio' : res.message);
        try { this.opts.onFallback?.(err); } catch { /* listener errors are not ours */ }
      }
      return this.viaWeb(line, lang, gender);
    }
    this.errors = 0;
    this.downloadProgress = undefined;
    const url = URL.createObjectURL(b64ToBlob(res.audioB64, res.mime || 'audio/wav'));
    const prepared: Prepared = { line, lang, engine: 'neural', voice, url, knownMs: res.ms };
    this.entries.set(key, { prepared, url, at: Date.now() });
    this.trim();
    return prepared;
  }

  /** Same line through Web Speech, with a browser voice of the same gender. */
  private async viaWeb(line: Line, lang: Lang, gender: Gender): Promise<Prepared> {
    let wv: string | undefined;
    try {
      wv = this.opts.webVoiceFor
        ? await this.opts.webVoiceFor(lang, gender)
        : (await pickVoiceFor(lang, gender, 'webspeech', ''))?.id;
    } catch { wv = undefined; }
    return this.web.prepare(line, lang, wv);
  }

  private trim(): void {
    if (this.entries.size <= NEURAL_URL_LRU) return;
    const old = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k, e] of old.slice(0, this.entries.size - NEURAL_URL_LRU)) {
      URL.revokeObjectURL(e.url);
      this.entries.delete(k);
    }
  }

  play(p: Prepared, rate: number, volume: number): PlayHandle {
    return p.engine === 'webspeech' ? this.web.play(p, rate, volume) : this.player.play(p, rate, volume);
  }

  stopAll(): void {
    this.player.stopAll();
    this.web.stopAll();
  }

  dispose(): void {
    this.stopAll();
    for (const e of this.entries.values()) URL.revokeObjectURL(e.url);
    this.entries.clear();
    this.pending.clear();
    this.pendingUntil.clear();
    this.errors = 0;
    this.failed = false;
  }
}
