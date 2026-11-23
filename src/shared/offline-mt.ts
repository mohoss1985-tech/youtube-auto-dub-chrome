// v1.2.1 (T): free offline translation catalog — Opus-MT (Helsinki-NLP, CC-BY-4.0) Marian models converted to ONNX
// (Xenova/*, quantized q8). Pure data + helpers, shared by the offscreen worker, the SW and tests.
// Model DATA is downloaded from huggingface.co on first use and cached in the extension origin (no remote code).

export interface OpusModel {
  /** Hugging Face repo id. */
  repo: string;
  /** Download size (MB) of the q8 encoder + merged decoder + tokenizer files. */
  sizeMB: number;
}

/**
 * Pairs with a converted ONNX (checked 2026-11-24 on huggingface.co). en→tr only exists as
 * `onnx-community/opus-mt-tc-big-en-tr` (530 MB q8): too big for a kids' extension → not offered, falls through.
 */
export const OPUS_MODELS: Readonly<Record<string, OpusModel>> = {
  'en-fr': { repo: 'Xenova/opus-mt-en-fr', sizeMB: 109 },
  'en-es': { repo: 'Xenova/opus-mt-en-es', sizeMB: 109 },
  // Multi-target model, but no `>>ara<<` prefix: transformers.js 4.x's tokenizer splits it into pieces and the
  // model echoes "<>ara>>"; without it the output is Standard Arabic anyway (measured).
  'en-ar': { repo: 'Xenova/opus-mt-en-ar', sizeMB: 113 },
  'fr-en': { repo: 'Xenova/opus-mt-fr-en', sizeMB: 109 },
  'es-en': { repo: 'Xenova/opus-mt-es-en', sizeMB: 109 },
  'ar-en': { repo: 'Xenova/opus-mt-ar-en', sizeMB: 109 },
  'tr-en': { repo: 'Xenova/opus-mt-tr-en', sizeMB: 109 },
};

/** Cache API name used by transformers.js (`env.cacheKey`). */
export const MT_CACHE = 'autodub-mt-v1';
/** Max sentences per offline request (one batched generate call). */
export const OFFLINE_BATCH = 16;

export const baseLang = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0] ?? code;

/** Models to run in order (pivot through English when there is no direct pair, e.g. fr→es = fr→en→es). null = no offline route. */
export function offlineRoute(from: string, to: string): OpusModel[] | null {
  const a = baseLang(from);
  const b = baseLang(to);
  if (a === b) return [];
  const direct = OPUS_MODELS[`${a}-${b}`];
  if (direct) return [direct];
  const x = OPUS_MODELS[`${a}-en`];
  const y = OPUS_MODELS[`en-${b}`];
  return x && y ? [x, y] : null;
}
