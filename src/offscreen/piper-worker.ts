// Module Worker spawned by the offscreen document: downloads/caches Piper models and synthesizes speech. Owner: P (v1.1).
// All code + .wasm are packaged files (MV3: no remote code). Only model DATA comes from huggingface.co.
import * as ort from 'onnxruntime-web/wasm';
// emscripten build of rhasspy/piper-phonemize (espeak-ng), MIT. Bundled by esbuild (CJS → ESM).
import createPiperPhonemize from '@diffusionstudio/piper-wasm/build/piper_phonemize.js';
import { NEURAL_CACHE, modelUrls, neuralVoice } from '../content/voice/neural-catalog';
import { bytesToB64, encodeWav, fadeEdges, normalizePeak, synthesizePcm, trimSilence, type LoadedModel, type PhonemizerAssets, type PiperConfig } from './piper';
import type { WorkerReq, WorkerRes, WorkerEvent, DownloadProgress } from './protocol';
import { expressify, voiceProsody } from './prosody-dsp';
import type { ProsodyParams } from '../shared/types';

const BASE = new URL('./', self.location.href).href; // chrome-extension://<id>/
const MAX_SESSIONS = 3;

ort.env.wasm.wasmPaths = { wasm: `${BASE}ort/ort-wasm-simd-threaded.wasm` } as never;
// Threads need SharedArrayBuffer (crossOriginIsolated); otherwise single thread.
ort.env.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.wasm.proxy = false;

// ---------------------------------------------------------------- assets

let assetsP: Promise<PhonemizerAssets> | null = null;
function phonemizerAssets(): Promise<PhonemizerAssets> {
  return (assetsP ??= (async () => {
    const [wasm, data] = await Promise.all([
      WebAssembly.compileStreaming(fetch(`${BASE}piper/piper_phonemize.wasm`)),
      fetch(`${BASE}piper/piper_phonemize.data`).then((r) => r.arrayBuffer()),
    ]);
    return { factory: createPiperPhonemize as unknown as PhonemizerAssets['factory'], wasm, data };
  })().catch((e) => { assetsP = null; throw e; }));
}

// ---------------------------------------------------------------- model cache (Cache API, extension origin)

async function cached(url: string): Promise<Response | undefined> {
  const c = await caches.open(NEURAL_CACHE);
  return c.match(url);
}

async function isReady(model: string): Promise<boolean> {
  const u = modelUrls(model);
  return !!(await cached(u.onnx)) && !!(await cached(u.json));
}

const progress = new Map<string, DownloadProgress>();
const downloads = new Map<string, Promise<void>>();

function emit(ev: WorkerEvent): void {
  (self as unknown as Worker).postMessage(ev);
}

async function fetchWithProgress(url: string, onBytes: (loaded: number, total: number) => void, fallbackTotal: number): Promise<Blob> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || fallbackTotal;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastEmit = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - lastEmit > 250) { lastEmit = now; onBytes(loaded, total); }
  }
  onBytes(loaded, total);
  if (Number(res.headers.get('Content-Length')) && loaded !== Number(res.headers.get('Content-Length'))) throw new Error('Download incomplete');
  return new Blob(chunks as BlobPart[]);
}

function download(model: string): Promise<void> {
  const running = downloads.get(model);
  if (running) return running;
  const job = (async () => {
    if (await isReady(model)) {
      progress.set(model, { model, loaded: 1, total: 1, done: true });
      return;
    }
    const u = modelUrls(model);
    const sizeMB = neuralVoice(model)?.sizeMB ?? 63;
    progress.set(model, { model, loaded: 0, total: sizeMB * 1e6 });
    const json = await fetchWithProgress(u.json, () => {}, 8000);
    JSON.parse(await json.text()); // validate before caching
    const onnx = await fetchWithProgress(u.onnx, (loaded, total) => {
      progress.set(model, { model, loaded, total });
      emit({ event: 'progress', progress: { model, loaded, total } });
    }, sizeMB * 1e6);
    const c = await caches.open(NEURAL_CACHE);
    await c.put(u.json, new Response(json, { headers: { 'Content-Type': 'application/json' } }));
    await c.put(u.onnx, new Response(onnx, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(onnx.size) } }));
    progress.set(model, { model, loaded: onnx.size, total: onnx.size, done: true });
    emit({ event: 'downloaded', model });
  })().catch((e: unknown) => {
    progress.set(model, { model, loaded: 0, total: 0, error: e instanceof Error ? e.message : String(e) });
    emit({ event: 'error', model, message: e instanceof Error ? e.message : String(e) });
  }).finally(() => downloads.delete(model));
  downloads.set(model, job);
  return job;
}

async function remove(model: string): Promise<void> {
  const u = modelUrls(model);
  const c = await caches.open(NEURAL_CACHE);
  await Promise.all([c.delete(u.onnx), c.delete(u.json)]);
  sessions.delete(model);
  progress.delete(model);
}

// ---------------------------------------------------------------- sessions

const sessions = new Map<string, Promise<LoadedModel>>();

function loadModel(model: string): Promise<LoadedModel> {
  const hit = sessions.get(model);
  if (hit) {
    sessions.delete(model); // refresh LRU order
    sessions.set(model, hit);
    return hit;
  }
  const p = (async () => {
    const u = modelUrls(model);
    const [j, o] = [await cached(u.json), await cached(u.onnx)];
    if (!j || !o) throw Object.assign(new Error('Model not downloaded'), { code: 'NOT_READY' });
    const config = (await j.json()) as PiperConfig;
    const session = await ort.InferenceSession.create(new Uint8Array(await o.arrayBuffer()), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return { config, session };
  })();
  p.catch(() => sessions.delete(model));
  sessions.set(model, p);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string;
    const s = sessions.get(oldest);
    sessions.delete(oldest);
    void s?.then((m) => m.session.release()).catch(() => {});
  }
  return p;
}

// ---------------------------------------------------------------- synthesis (serialised: one WASM thread)

let queue: Promise<unknown> = Promise.resolve();

async function tts(text: string, voiceId: string, lengthScale?: number, prosody?: ProsodyParams): Promise<WorkerRes> {
  const v = neuralVoice(voiceId);
  if (!v) return { ok: false, code: 'NO_VOICE', message: `Unknown neural voice ${voiceId}` };
  if (!(await isReady(v.model))) {
    void download(v.model);
    const p = progress.get(v.model);
    return { ok: true, pending: true, progress: p && p.total ? p.loaded / p.total : 0 };
  }
  const [assets, model] = await Promise.all([phonemizerAssets(), loadModel(v.model)]);
  const t0 = performance.now();
  // v1.2.2 (M): per-voice prosody (noise relative to the model's defaults; male: k ≤ 1.4, F0 range 60–250 Hz).
  const vp = prosody ? voiceProsody(prosody, v.gender, model.config.inference) : undefined;
  const r = await synthesizePcm(ort, assets, model, text, v.speaker, lengthScale, vp);
  let pcm: Float32Array = Float32Array.from(trimSilence(normalizePeak(r.pcm), r.sampleRate));
  // v1.2 (E): expressive intonation + energy (duration preserved, so `ms` stays exact).
  let postMs: number | undefined;
  if (vp) {
    const tp = performance.now();
    try { pcm = expressify(pcm, r.sampleRate, vp, false, { gender: v.gender }).pcm; } catch { /* keep the plain line */ }
    postMs = performance.now() - tp;
  }
  // v1.2.2 (M): never end (or start) on a non-zero sample: 25 ms fade-out inside the 60 ms tail margin.
  fadeEdges(pcm, r.sampleRate);
  const wav = encodeWav(pcm, r.sampleRate);
  const ms = (pcm.length / r.sampleRate) * 1000;
  const computeMs = performance.now() - t0;
  const res: WorkerRes = { ok: true, audioB64: bytesToB64(wav), mime: 'audio/wav', ms, computeMs, rtf: computeMs / Math.max(1, ms), threads: ort.env.wasm.numThreads };
  if (postMs != null) res.postMs = postMs;
  return res;
}

async function handle(req: WorkerReq): Promise<WorkerRes> {
  switch (req.op) {
    case 'tts': {
      const run = queue.then(() => tts(req.text, req.voice, req.lengthScale, req.prosody));
      queue = run.catch(() => {});
      return run;
    }
    case 'download':
      for (const m of req.models) void download(m);
      return { ok: true };
    case 'remove':
      for (const m of req.models) await remove(m);
      return { ok: true };
    case 'status': {
      const ready: string[] = [];
      for (const m of req.models ?? []) if (await isReady(m)) ready.push(m);
      return { ok: true, ready, progress: [...progress.values()] };
    }
    case 'warmup': {
      await phonemizerAssets();
      return { ok: true };
    }
  }
}

// ORT's own pthread workers re-load this file (name "em-pthread"): leave their message handler alone.
const IS_PTHREAD = typeof self.name === 'string' && self.name.startsWith('em-pthread');
if (!IS_PTHREAD) self.onmessage = (ev: MessageEvent<{ id: number; req: WorkerReq }>) => {
  const { id, req } = ev.data;
  handle(req).then(
    (res) => (self as unknown as Worker).postMessage({ id, res }),
    (e: unknown) => (self as unknown as Worker).postMessage({
      id,
      res: { ok: false, code: (e as { code?: string })?.code === 'NOT_READY' ? 'NO_VOICE' : 'ENGINE_ERROR', message: e instanceof Error ? e.message : String(e) },
    }),
  );
};
