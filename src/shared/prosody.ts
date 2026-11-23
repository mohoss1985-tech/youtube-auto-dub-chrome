// v1.2 (E): emotion + scene arousal + user expressiveness → rendering parameters (pure, shared by content and tests).
// Neural (Piper): inference noise + F0 contour expansion + energy (ProsodyParams, applied in the offscreen worker).
// Web Speech: utterance pitch/volume. Both: a small speed hint the pacing planner may apply (it keeps owning the rate).
import type { EmotionStyle, LineEmotion, ProsodyParams } from './types';

/** Default "Expression" slider value (0..1). */
export const DEFAULT_EXPRESSIVENESS = 0.7;
/** Scene arousal when the original audio cannot be analysed. */
export const DEFAULT_AROUSAL = 0.5;
/** Scene arousal assumed by the ▶ Test sample (a lively MrBeast-like scene). */
export const TEST_AROUSAL = 0.7;

interface StyleBase {
  /** Contour expansion k at the reference expressiveness. */
  k: number; shift: number; end: number; endMs: number; gain: number; ns: number; nw: number; speed: number;
  /** Web Speech pitch offset. */
  wp: number;
}

/** Values at expressiveness 0.7 and full intensity. Piper defaults: noise_scale 0.667, noise_w 0.8. */
export const STYLE_BASE: Readonly<Record<EmotionStyle, StyleBase>> = {
  neutral: { k: 1.3, shift: 0, end: -1.2, endMs: 350, gain: 0, ns: 0.72, nw: 0.85, speed: 1, wp: 0.04 },
  excited: { k: 1.65, shift: 2.5, end: 0.5, endMs: 300, gain: 3, ns: 0.85, nw: 1.0, speed: 1.05, wp: 0.22 },
  happy: { k: 1.5, shift: 1.5, end: -0.5, endMs: 300, gain: 1.5, ns: 0.78, nw: 0.92, speed: 1, wp: 0.15 },
  question: { k: 1.45, shift: 0.5, end: 4, endMs: 380, gain: 0.5, ns: 0.75, nw: 0.9, speed: 1, wp: 0.1 },
  surprised: { k: 1.75, shift: 2.5, end: 3, endMs: 320, gain: 2.5, ns: 0.85, nw: 1.0, speed: 1.04, wp: 0.25 },
  sad: { k: 1.1, shift: -1, end: -1.8, endMs: 450, gain: -2, ns: 0.58, nw: 0.65, speed: 0.96, wp: -0.08 },
  calm: { k: 1.15, shift: -0.5, end: -1.2, endMs: 400, gain: -1, ns: 0.6, nw: 0.7, speed: 0.97, wp: -0.04 },
  shout: { k: 1.6, shift: 3, end: -0.5, endMs: 300, gain: 4, ns: 0.88, nw: 1.05, speed: 1.06, wp: 0.3 },
};

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Amount of expression: 0 at expressiveness 0, 1 at the default 0.7, 1.43 at 1. */
function amount(expressiveness: number): number {
  return clamp(expressiveness, 0, 1) / DEFAULT_EXPRESSIVENESS;
}

function context(e: LineEmotion | undefined, arousal: number) {
  const style = e?.style ?? 'neutral';
  const I = clamp(e?.intensity ?? 0.3, 0, 1);
  const a = clamp(Number.isFinite(arousal) ? arousal : DEFAULT_AROUSAL, 0, 1);
  // Intensity scales the style; scene arousal (8 s of the original) lifts everything a little (MrBeast ≈ always high).
  const g = (0.6 + 0.4 * I) * (0.85 + 0.3 * a);
  return { style, I, a, g, b: STYLE_BASE[style] };
}

/**
 * Piper rendering parameters for one line, or undefined when expressiveness is 0 (exact v1.1 sound).
 * `text` = the target text actually synthesized (for emphasis spans as character fractions).
 */
export function prosodyFor(e: LineEmotion | undefined, text: string, arousal: number, expressiveness: number): ProsodyParams | undefined {
  const amt = amount(expressiveness);
  if (!(amt > 0)) return undefined;
  const { style, I, a, g, b } = context(e, arousal);
  // Neutral lines in a lively scene: a bit higher and more melodic (the original is shouting around them).
  const lift = style === 'neutral' || style === 'question' ? 1.2 * Math.max(0, a - 0.4) : 0;
  const pitchK = clamp(1 + (b.k - 1 + (style === 'neutral' ? 0.25 * a : 0)) * amt * g, 1, 1.8);
  const meanShiftSt = clamp((b.shift + lift) * amt * g, -1.5, 3);
  const endShiftSt = clamp(b.end * amt * (0.7 + 0.3 * I), -2.5, 5);
  const gainDb = clamp(b.gain * amt * g, -3, 4);
  const noiseScale = clamp(0.667 + (b.ns - 0.667) * amt * g, 0.55, 0.9);
  const noiseW = clamp(0.8 + (b.nw - 0.8) * amt * g, 0.6, 1.1);
  const emphDb = clamp((3 + 3 * I) * Math.min(1, amt), 0, 6);
  const emphSt = clamp((style === 'sad' || style === 'calm' ? 0.6 : 1.5) * amt * (0.6 + 0.4 * I), 0, 2.5);
  return {
    noiseScale: r3(noiseScale), noiseW: r3(noiseW), pitchK: r3(pitchK), meanShiftSt: r3(meanShiftSt),
    endShiftSt: r3(endShiftSt), endMs: b.endMs, gainDb: r3(gainDb),
    emphasis: emphDb > 0 ? emphasisSpans(text, e?.emphasisWords ?? []).map((s) => ({ ...s, db: r3(emphDb), st: r3(emphSt) })) : [],
  };
}

/** Character-fraction spans [from, to) of `words` inside `text` (first occurrence each). */
export function emphasisSpans(text: string, words: readonly string[]): { from: number; to: number }[] {
  const n = text.length;
  if (!n) return [];
  const low = text.toLowerCase();
  const out: { from: number; to: number }[] = [];
  for (const w of words) {
    const i = low.indexOf(w.toLowerCase());
    if (i < 0 || !w) continue;
    out.push({ from: r3(i / n), to: r3((i + w.length) / n) });
  }
  return out.sort((x, y) => x.from - y.from);
}

/** Speed hint (≈ 0.95–1.06) for the pacing planner: excited lines a touch quicker, sad/calm a touch slower. 1 when off. */
export function speedHint(e: LineEmotion | undefined, arousal: number, expressiveness: number): number {
  const amt = amount(expressiveness);
  if (!(amt > 0)) return 1;
  const { b, g } = context(e, arousal);
  return r3(clamp(1 + (b.speed - 1) * amt * g, 0.95, 1.06));
}

/** Web Speech per-utterance pitch (0.9–1.35) and volume multiplier (0.7–1); null when expressiveness is 0. */
export function webSpeechProsody(e: LineEmotion | undefined, arousal: number, expressiveness: number): { pitch: number; volume: number } | null {
  const amt = amount(expressiveness);
  if (!(amt > 0)) return null;
  const { b, g } = context(e, arousal);
  const pitch = clamp(1 + b.wp * amt * g, 0.9, 1.35);
  // Utterance volume cannot exceed 1: calmer lines get quieter instead (neutral 0.9, shout 1.0).
  const volume = clamp(1 - (0.1 - 0.025 * b.gain) * Math.min(1, amt), 0.7, 1);
  return { pitch: r3(pitch), volume: r3(volume) };
}

/** Stable short key of a parameter set (prepared-audio cache). */
export function prosodyKey(p: ProsodyParams | undefined): string {
  if (!p) return '';
  return [p.noiseScale, p.noiseW, p.pitchK, p.meanShiftSt, p.endShiftSt, p.gainDb, ...p.emphasis.map((s) => `${s.from}-${s.to}`)].map((x) => (typeof x === 'number' ? x.toFixed(2) : x)).join(',');
}
