// v1.2.1 (T): free offline translation worker (spawned by the offscreen document). Owner: T.
// Opus-MT Marian models (Helsinki-NLP, CC-BY-4.0, ONNX by Xenova) run with transformers.js on onnxruntime-web WASM.
// All code + .wasm ship in the package (MV3: no remote code; build.mjs aliases transformers' ORT import to the
// onnxruntime-web/wasm build already bundled for Piper). Only model DATA (.onnx/.json) comes from huggingface.co,
// cached by transformers.js in the extension origin (Cache API `autodub-mt-v1`).
import { env, pipeline, type TranslationPipeline } from '@huggingface/transformers';
import { MT_CACHE, offlineRoute, type OpusModel } from '../shared/offline-mt';
import type { MtReq, MtRes } from './protocol';

const BASE = new URL('./', self.location.href).href; // chrome-extension://<id>/

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
(env as { cacheKey?: string }).cacheKey = MT_CACHE;
// Blob-URL factories are blocked by the extension CSP; the bundled ORT build embeds its JS factory, so only the .wasm is fetched (locally).
(env as { useWasmCache?: boolean }).useWasmCache = false;
const onnx = env.backends.onnx as unknown as { wasm: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } };
onnx.wasm.wasmPaths = { wasm: `${BASE}ort/ort-wasm-simd-threaded.wasm` };
// Threads need crossOriginIsolated (manifest COOP/COEP); ≤ 3 threads, leaving a core for Piper's worker.
onnx.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;
onnx.wasm.proxy = false;

interface Slot {
  ready: boolean;
  pipe: Promise<TranslationPipeline>;
  files: Map<string, { loaded: number; total: number }>;
  error?: string;
  failedAt?: number;
}
const slots = new Map<string, Slot>();
/** A failed download is not retried for 60 s (the content script polls). */
const FAIL_HOLD_MS = 60_000;

function load(m: OpusModel): Slot {
  const hit = slots.get(m.repo);
  if (hit && !(hit.error && Date.now() - (hit.failedAt ?? 0) > FAIL_HOLD_MS)) return hit;
  const slot: Slot = { ready: false, files: new Map(), pipe: null as unknown as Promise<TranslationPipeline> };
  slot.pipe = (pipeline('translation', m.repo, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file && typeof p.total === 'number') slot.files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    },
  } as never) as Promise<TranslationPipeline>);
  slot.pipe.then(
    () => { slot.ready = true; },
    (e: unknown) => { slot.error = e instanceof Error ? e.message : String(e); slot.failedAt = Date.now(); },
  );
  slots.set(m.repo, slot);
  return slot;
}

/** Bytes progress over the route's models (expected sizes until the real Content-Lengths are known). */
function progressOf(route: OpusModel[]): number {
  let loaded = 0;
  let total = 0;
  for (const m of route) {
    const s = slots.get(m.repo);
    if (s?.ready) { loaded += m.sizeMB * 1e6; total += m.sizeMB * 1e6; continue; }
    let l = 0;
    let t = 0;
    for (const f of s?.files.values() ?? []) { l += f.loaded; t += f.total; }
    loaded += l;
    total += Math.max(t, m.sizeMB * 1e6);
  }
  return total > 0 ? Math.min(0.99, loaded / total) : 0;
}

/**
 * One sentence per generate call. Measured (research/v121-T.md): batched (padded) generation is ~2.5× faster but
 * changes words (fr: "40 000e note" instead of "point") and makes opus-mt-en-ar append junk ("،، يا سيدي."), so
 * quality wins: ~0.1 s per line on a recent Mac is still far ahead of playback.
 */
async function runModel(m: OpusModel, texts: string[]): Promise<string[]> {
  const pipe = await slots.get(m.repo)!.pipe;
  const out = texts.slice();
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] ?? '';
    if (!t.trim()) continue;
    const gen = { max_new_tokens: Math.min(400, Math.ceil(t.length / 2) + 32), num_beams: 1 };
    const r = (await pipe(t, gen as never)) as { translation_text: string }[];
    out[i] = String(r?.[0]?.translation_text ?? '').trim();
  }
  return out;
}

let queue: Promise<unknown> = Promise.resolve();

async function translate(req: MtReq): Promise<MtRes> {
  const route = offlineRoute(req.from, req.to);
  if (!route) return { ok: false, code: 'NO_TRANSLATION', message: `No offline model for ${req.from} → ${req.to}` };
  if (!route.length) return { ok: true, texts: req.texts.slice(), engine: 'opus-mt' };
  const slotsNow = route.map(load);
  const failed = slotsNow.find((s) => s.error);
  if (failed) return { ok: false, code: 'ENGINE_ERROR', message: `Offline translator download failed: ${failed.error}` };
  if (!slotsNow.every((s) => s.ready)) {
    return { ok: true, pending: true, progress: progressOf(route), sizeMB: route.reduce((a, m) => a + m.sizeMB, 0) };
  }
  const t0 = performance.now();
  let texts = req.texts;
  for (const m of route) texts = await runModel(m, texts);
  return { ok: true, texts, engine: 'opus-mt', computeMs: performance.now() - t0 };
}

async function handle(req: MtReq): Promise<MtRes> {
  // One generate at a time (shared WASM threads); status-only answers (pending) are cheap.
  const run = queue.then(() => translate(req));
  queue = run.catch(() => {});
  return run;
}

// ORT's pthread workers re-load this file (name "em-pthread"): leave their message handler alone.
const IS_PTHREAD = typeof self.name === 'string' && self.name.startsWith('em-pthread');
if (!IS_PTHREAD) self.onmessage = (ev: MessageEvent<{ id: number; req: MtReq }>) => {
  const { id, req } = ev.data;
  handle(req).then(
    (res) => (self as unknown as Worker).postMessage({ id, res }),
    (e: unknown) => (self as unknown as Worker).postMessage({ id, res: { ok: false, code: 'ENGINE_ERROR', message: e instanceof Error ? e.message : String(e) } satisfies MtRes }),
  );
};
