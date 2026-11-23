// v1.1 neural voices, service-worker side: owns the offscreen document and routes NEURAL_TTS / NEURAL_STATUS. Owner: P.
// The SW cannot run WASM workers itself, so synthesis happens in an offscreen document (reason WORKERS).
import type { MsgResponse, MsgOf } from '../shared/messages';
import type { NeuralModelState, NeuralTtsResult } from '../shared/types';
import { NEURAL_READY_KEY, neuralVoice } from '../content/voice/neural-catalog';
import { OFFSCREEN_TARGET, type OffscreenEventMsg, type DownloadProgress, type WorkerReq, type WorkerRes } from '../offscreen/protocol';

export const OFFSCREEN_URL = 'offscreen.html';
/** First synthesis loads a 60 MB model (~2 s); later lines take ~0.1–0.5 s. */
const TTS_TIMEOUT_MS = 20_000;

let creating: Promise<void> | null = null;

/** Create the offscreen document once (one per extension). Safe to call concurrently. */
export async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const rt = chrome.runtime as typeof chrome.runtime & { getContexts?: (f: object) => Promise<unknown[]> };
  if (rt.getContexts) {
    const found = await rt.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (found.length) return;
  }
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the free on-device neural voices (Piper text-to-speech in a WebAssembly worker) so dubbing needs no server.',
    }).catch((e: unknown) => {
      // "Only a single offscreen document may be created" = already there.
      if (!/single offscreen/i.test(String((e as Error)?.message ?? e))) throw e;
    }).finally(() => { creating = null; });
  }
  await creating;
}

/** Send one request to the offscreen worker. Never rejects. */
export async function callOffscreen(req: WorkerReq, timeoutMs = TTS_TIMEOUT_MS): Promise<WorkerRes> {
  try {
    await ensureOffscreen();
    const res = await Promise.race([
      chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, req }) as Promise<WorkerRes | undefined>,
      new Promise<WorkerRes>((r) => setTimeout(() => r({ ok: false, code: 'ENGINE_ERROR', message: 'Neural voice timed out' }), timeoutMs)),
    ]);
    return res ?? { ok: false, code: 'ENGINE_ERROR', message: 'No answer from the neural voice' };
  } catch (e) {
    return { ok: false, code: 'ENGINE_ERROR', message: e instanceof Error ? e.message : String(e) };
  }
}

async function readyList(): Promise<string[]> {
  try {
    const got = await chrome.storage.local.get(NEURAL_READY_KEY);
    const v = got[NEURAL_READY_KEY];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function setReady(model: string, ready: boolean): Promise<void> {
  const cur = await readyList();
  const next = ready ? [...new Set([...cur, model])] : cur.filter((m) => m !== model);
  if (next.length !== cur.length || next.some((m, i) => m !== cur[i])) await chrome.storage.local.set({ [NEURAL_READY_KEY]: next });
}

export async function onNeuralTts(msg: MsgOf<'NEURAL_TTS'>): Promise<MsgResponse<NeuralTtsResult>> {
  const v = neuralVoice(msg.voice);
  if (!v) return { ok: false, error: 'NO_VOICE', message: `Unknown neural voice ${msg.voice}` };
  const res = await callOffscreen(msg.prosody ? { op: 'tts', text: msg.text, voice: v.id, prosody: msg.prosody } : { op: 'tts', text: msg.text, voice: v.id });
  if (!res.ok) return { ok: false, error: res.code, message: res.message };
  if (res.pending) return { ok: true, pending: true, progress: typeof res.progress === 'number' ? res.progress : 0 };
  void setReady(v.model, true).catch(() => {});
  const out: MsgResponse<NeuralTtsResult> = { ok: true, audioB64: res.audioB64, mime: res.mime ?? 'audio/wav', ms: res.ms, rtf: res.rtf, threads: res.threads };
  if (res.postMs != null) out.postMs = res.postMs;
  return out;
}

export async function onNeuralStatus(msg: MsgOf<'NEURAL_STATUS'>): Promise<MsgResponse<{ models: NeuralModelState[] }>> {
  if (msg.remove?.length) {
    await callOffscreen({ op: 'remove', models: msg.remove });
    for (const m of msg.remove) await setReady(m, false);
  }
  if (msg.download?.length) await callOffscreen({ op: 'download', models: msg.download });
  const res = await callOffscreen({ op: 'status', models: msg.models }, 10_000);
  if (!res.ok) return { ok: false, error: res.code, message: res.message };
  const ready = new Set(res.ready ?? []);
  const prog = new Map((Array.isArray(res.progress) ? res.progress : []).map((p: DownloadProgress) => [p.model, p]));
  for (const m of msg.models) await setReady(m, ready.has(m));
  return {
    ok: true,
    models: msg.models.map((m): NeuralModelState => {
      const p = prog.get(m);
      const st: NeuralModelState = { model: m, ready: ready.has(m) };
      if (!st.ready && p && !p.error && p.total > 0) st.progress = Math.min(0.99, p.loaded / p.total);
      if (!st.ready && p?.error) st.error = p.error;
      return st;
    }),
  };
}

/** Offscreen → SW events (download finished / failed). */
export function onOffscreenEvent(msg: OffscreenEventMsg): void {
  const ev = msg.ev;
  if (ev.event === 'downloaded') void setReady(ev.model, true).catch(() => {});
}
