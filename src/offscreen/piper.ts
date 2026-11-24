// Piper neural TTS core (pure helpers + engine). Runs inside a Worker of the offscreen document. Owner: P (v1.1).
// Text → espeak-ng phoneme ids (piper_phonemize WASM, bundled) → VITS model (onnxruntime-web WASM, bundled) → PCM → WAV.
import type * as OrtNS from 'onnxruntime-web';

/** Subset of a Piper `.onnx.json` config that we use. */
export interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference?: { noise_scale?: number; length_scale?: number; noise_w?: number };
  num_speakers?: number;
  speaker_id_map?: Record<string, number>;
}

/** Peak-normalise to `peak` (Piper's own CLI normalises too) so every voice plays at the same loudness. In place. */
export function normalizePeak(pcm: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > max) max = a;
  }
  if (max < 1e-4) return pcm;
  const g = peak / max;
  for (let i = 0; i < pcm.length; i++) pcm[i] *= g;
  return pcm;
}

/** Cut leading/trailing near-silence (keeps `padMs` of margin) so `knownMs` is the real speech length → tighter sync. */
export function trimSilence(pcm: Float32Array, sampleRate: number, threshold = 0.015, padMs = 30, tailPadMs = padMs * 2): Float32Array {
  let a = 0;
  let b = pcm.length - 1;
  while (a < pcm.length && Math.abs(pcm[a]) < threshold) a++;
  while (b > a && Math.abs(pcm[b]) < threshold) b--;
  if (a >= b) return pcm;
  const pad = Math.round((sampleRate * padMs) / 1000);
  // v1.2.2 (M): a longer tail margin (60 ms) keeps the soft decay of final fricatives/breaths ("…dollars", "…sais").
  const tail = Math.round((sampleRate * tailPadMs) / 1000);
  return pcm.subarray(Math.max(0, a - pad), Math.min(pcm.length, b + 1 + tail));
}

/**
 * v1.2.2 (M): raised-cosine fade-in (`inMs`) and fade-out (`outMs`, ≥ 20 ms) so a line never starts or stops on a
 * non-zero sample (the "cut" click at the end of v1.2.1 lines). Length unchanged. In place.
 */
export function fadeEdges(pcm: Float32Array, sampleRate: number, inMs = 4, outMs = 25): Float32Array {
  const n = pcm.length;
  const fi = Math.min(n >> 2, Math.round((sampleRate * inMs) / 1000));
  const fo = Math.min(n >> 1, Math.round((sampleRate * Math.max(20, outMs)) / 1000));
  for (let i = 0; i < fi; i++) pcm[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
  for (let i = 0; i < fo; i++) pcm[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  return pcm;
}

/** Float32 PCM (mono) → 16-bit PCM WAV bytes. */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Bytes → base64 (chunked: no call-stack overflow on 500 KB WAVs). */
export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Text clean-up before espeak: caption noise out, whitespace collapsed. Keeps punctuation (prosody). */
export function cleanText(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [Music], (rires)
    .replace(/[♪♫#*_~^|<>{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- phonemizer (emscripten module, classic script)

type PhonemizeFactory = (m: Record<string, unknown>) => Promise<{ callMain(args: string[]): number }>;

export interface PhonemizerAssets {
  /** Global `createPiperPhonemize` from piper_phonemize.js. */
  factory: PhonemizeFactory;
  wasm: WebAssembly.Module;
  data: ArrayBuffer;
}

/** Phoneme ids for `text` with espeak voice `voice` (e.g. "fr"). One short-lived module per call (main() exits the runtime). */
export function phonemize(assets: PhonemizerAssets, text: string, voice: string): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    const ids: number[] = [];
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(ids);
    };
    assets.factory({
      noInitialRun: true,
      print: (line: string) => {
        try {
          const j = JSON.parse(line) as { phoneme_ids?: number[] };
          if (Array.isArray(j.phoneme_ids)) ids.push(...j.phoneme_ids);
        } catch { /* not JSON */ }
      },
      printErr: () => { /* espeak warnings */ },
      locateFile: (p: string) => p,
      getPreloadedPackage: () => assets.data,
      instantiateWasm: (imports: WebAssembly.Imports, ok: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
        WebAssembly.instantiate(assets.wasm, imports).then((inst) => ok(inst, assets.wasm), finish);
        return {};
      },
    }).then((mod) => {
      try {
        mod.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
      } catch (e) {
        // emscripten throws ExitStatus(0) on a normal exit
        if (!(e && typeof e === 'object' && (e as { status?: number }).status === 0)) return finish(e);
      }
      finish();
    }, finish);
  });
}

// ---------------------------------------------------------------- model

export interface LoadedModel {
  config: PiperConfig;
  session: OrtNS.InferenceSession;
}

export interface SynthResult {
  pcm: Float32Array;
  sampleRate: number;
  /** Wall time spent (ms): phonemize + inference. */
  computeMs: number;
}

/** Run one utterance through a loaded model. `speaker` = name in speaker_id_map (multi-speaker models). */
export async function synthesizePcm(
  ort: typeof OrtNS, assets: PhonemizerAssets, model: LoadedModel, text: string, speaker?: string, lengthScale?: number,
  /** v1.2 (E): per-line inference noise (expressive rendering); absent = the model's defaults. */
  noise?: { noiseScale?: number; noiseW?: number },
): Promise<SynthResult> {
  const t0 = performance.now();
  const clean = cleanText(text);
  if (!clean) throw new Error('Empty text');
  const ids = await phonemize(assets, clean, model.config.espeak.voice);
  if (!ids.length) throw new Error('No phonemes');
  const inf = model.config.inference ?? {};
  const feeds: Record<string, OrtNS.Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([noise?.noiseScale ?? inf.noise_scale ?? 0.667, lengthScale ?? inf.length_scale ?? 1, noise?.noiseW ?? inf.noise_w ?? 0.8]), [3]),
  };
  const map = model.config.speaker_id_map ?? {};
  if ((model.config.num_speakers ?? 1) > 1 || Object.keys(map).length > 1) {
    const sid = speaker != null && speaker in map ? map[speaker] : 0;
    feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(sid)]), [1]);
  }
  const out = await model.session.run(feeds);
  const first = out.output ?? Object.values(out)[0];
  const pcm = new Float32Array(first.data as Float32Array);
  return { pcm, sampleRate: model.config.audio.sample_rate, computeMs: performance.now() - t0 };
}
