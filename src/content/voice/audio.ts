// API voices (OpenAI / ElevenLabs) played via <audio> in the content script (§4, C1). Owner: B.
import { DubError, type Lang, type Line, type TtsRequest } from '../../shared/types';
import { sendToSW, type ResponseOf } from '../../shared/messages';
import type { PlayEnd, Prepared, PlayHandle, TtsEngine } from './engine';
import { defaultApiVoice } from './voices';

/** Max concurrent TTS requests to the SW (§4). */
export const MAX_CONCURRENT = 3;
/** Blob URLs kept alive (prepared lines); older ones are revoked. ~60 × 60 KB. */
export const URL_LRU = 60;

/** base64 → Blob. */
export function b64ToBlob(b64: string, mime = 'audio/mpeg'): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Duration (ms) of an audio Blob URL via <audio> metadata; undefined if unknown within `timeoutMs`. */
export function probeDurationMs(url: string, timeoutMs = 3000): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined') return resolve(undefined);
    const a = new Audio();
    let settled = false;
    const end = (v: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      a.onloadedmetadata = a.onerror = null;
      a.removeAttribute('src');
      resolve(v);
    };
    const t = setTimeout(() => end(undefined), timeoutMs);
    a.preload = 'metadata';
    a.onloadedmetadata = () => end(Number.isFinite(a.duration) && a.duration > 0 ? a.duration * 1000 : undefined);
    a.onerror = () => end(undefined);
    a.src = url;
  });
}

/** Rough mp3 duration from size (fallback when metadata is unavailable). */
export function estimateMp3Ms(bytes: number, kbps: number): number {
  return (bytes * 8) / kbps;
}

export interface AudioEngineOptions {
  /** Transport to the SW (default `sendToSW`); injectable for tests. */
  send?: (msg: { type: 'TTS' } & TtsRequest) => Promise<ResponseOf<'TTS'>>;
  /** Called once per error that should make the session fall back to Web Speech (§4). */
  onFallback?: (err: DubError) => void;
  /** User voice speed passed to the provider (default: none; rate is applied via playbackRate). */
  speed?: number;
  /** Duration probe (default: <audio> metadata, 3 s timeout); injectable for tests. */
  probe?: (url: string) => Promise<number | undefined>;
}

type Entry = { prepared: Prepared; url: string; at: number };

/** Audio engine: prepare sends TTS to the SW, base64 → Blob URL, decodes duration (knownMs); play uses one <audio> per line with playbackRate = rate. */
export class AudioEngine implements TtsEngine {
  readonly id: 'openai' | 'elevenlabs';
  private readonly opts: AudioEngineOptions;
  private inflight = 0;
  private waiters: (() => void)[] = [];
  private pending = new Map<string, Promise<Prepared>>();
  private entries = new Map<string, Entry>();
  private playing = new Set<{ stop(): void }>();
  private failed = false;

  constructor(id: 'openai' | 'elevenlabs', opts: AudioEngineOptions = {}) {
    this.id = id;
    this.opts = opts;
  }

  /** Register / replace the fallback listener. */
  onFallback(cb: (err: DubError) => void): void {
    this.opts.onFallback = cb;
  }

  /** Fetch (or reuse) audio for the line. Max 3 concurrent. Throws DubError('ENGINE_ERROR' | 'NO_KEY' | 'TIMEOUT' | …). */
  prepare(line: Line, lang: Lang, voice?: string): Promise<Prepared> {
    const v = voice || defaultApiVoice(this.id);
    const key = `${lang}|${v}|${line.id}|${line.text}`;
    const hit = this.entries.get(key);
    if (hit) {
      hit.at = Date.now();
      return Promise.resolve(hit.prepared);
    }
    const p = this.pending.get(key);
    if (p) return p;
    const job = this.fetchOne(line, lang, v, key).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  private async fetchOne(line: Line, lang: Lang, voice: string, key: string): Promise<Prepared> {
    await this.slot();
    let res: ResponseOf<'TTS'>;
    try {
      const send = this.opts.send ?? ((m) => sendToSW(m));
      const req: { type: 'TTS' } & TtsRequest = { type: 'TTS', text: line.text, lang, engine: this.id, voice };
      if (this.opts.speed && this.opts.speed !== 1) req.speed = this.opts.speed;
      res = await send(req);
    } catch (e) {
      res = { ok: false, error: 'NETWORK', message: e instanceof Error ? e.message : String(e) };
    } finally {
      this.release();
    }
    if (!res.ok) {
      const err = new DubError(res.error, res.message);
      if (!this.failed) {
        this.failed = true;
        try { this.opts.onFallback?.(err); } catch { /* listener errors are not ours */ }
      }
      throw err;
    }
    if (!res.audioB64) throw new DubError('ENGINE_ERROR', 'Empty audio');
    const blob = b64ToBlob(res.audioB64, res.mime || 'audio/mpeg');
    const url = URL.createObjectURL(blob);
    const knownMs = (await (this.opts.probe ?? probeDurationMs)(url)) ?? estimateMp3Ms(blob.size, this.id === 'elevenlabs' ? 64 : 128);
    const prepared: Prepared = { line, lang, engine: this.id, voice, url, knownMs };
    this.entries.set(key, { prepared, url, at: Date.now() });
    this.trim();
    return prepared;
  }

  private slot(): Promise<void> {
    if (this.inflight < MAX_CONCURRENT) {
      this.inflight++;
      return Promise.resolve();
    }
    return new Promise((r) => this.waiters.push(() => { this.inflight++; r(); }));
  }

  private release(): void {
    this.inflight--;
    this.waiters.shift()?.();
  }

  /** Revoke the oldest Blob URLs beyond the LRU size. */
  private trim(): void {
    if (this.entries.size <= URL_LRU) return;
    const old = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k, e] of old.slice(0, this.entries.size - URL_LRU)) {
      URL.revokeObjectURL(e.url);
      this.entries.delete(k);
    }
  }

  /** Play prepared audio now. */
  play(p: Prepared, rate: number, volume: number): PlayHandle {
    let resolveDone!: (e: PlayEnd) => void;
    const done = new Promise<PlayEnd>((r) => (resolveDone = r));
    if (!p.url || typeof Audio === 'undefined') {
      resolveDone('error');
      return { done, stop() {}, pause() {}, resume() {} };
    }
    const a = new Audio();
    a.preload = 'auto';
    (a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    a.src = p.url;
    a.playbackRate = safeRate(rate);
    a.defaultPlaybackRate = a.playbackRate;
    a.volume = clamp01(volume);
    let finished = false;
    const finish = (e: PlayEnd) => {
      if (finished) return;
      finished = true;
      a.onended = a.onerror = null;
      this.playing.delete(handle);
      try { a.pause(); } catch { /* jsdom */ }
      a.removeAttribute('src');
      resolveDone(e);
    };
    a.onended = () => finish('ended');
    a.onerror = () => finish('error');
    const handle: PlayHandle = {
      done,
      stop: () => finish('stopped'),
      pause: () => { if (!finished) a.pause(); },
      resume: () => { if (!finished) void Promise.resolve(a.play()).catch(() => finish('error')); },
      setRate: (r: number) => { a.playbackRate = safeRate(r); },
      setVolume: (v: number) => { a.volume = clamp01(v); },
    };
    this.playing.add(handle);
    try {
      void Promise.resolve(a.play()).catch(() => finish('error'));
    } catch {
      finish('error');
    }
    return handle;
  }

  /** Stop all audio. Prepared lines stay valid (seek back reuses them). */
  stopAll(): void {
    for (const h of [...this.playing]) h.stop();
    this.playing.clear();
  }

  /** Stop and revoke every Blob URL (session end). */
  dispose(): void {
    this.stopAll();
    for (const e of this.entries.values()) URL.revokeObjectURL(e.url);
    this.entries.clear();
    this.pending.clear();
    this.failed = false;
  }
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
const safeRate = (r: number): number => (Number.isFinite(r) ? Math.min(4, Math.max(0.25, r)) : 1);
