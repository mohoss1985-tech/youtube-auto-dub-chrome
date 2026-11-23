// Timing fit: rate + trimming per line (§5). Owner: C.
import type { Lang, Line, Plan } from '../../shared/types';

/** Characters per second at rate 1, per language. */
export const CPS: Readonly<Record<Lang, number>> = { en: 14, es: 15, fr: 14, tr: 13, ar: 12 };
/** Maximum speech-rate speed-up before trimming. */
export const MAX_RATE = 1.3;

/** Gap kept before the next line starts (s). */
export const GAP_GUARD_S = 0.1;
/** Slot may run this far past the line's own end when the gap allows (s). */
export const TAIL_S = 0.6;
/** Without a next line, speech may borrow up to this much past the end (s). */
export const LAST_LINE_TAIL_S = 2.4;
/** Minimum slot (ms). */
export const MIN_SLOT_MS = 200;
/** Extra ms per pause punctuation mark. */
const PAUSE_MS = 120;

/** Optional calibration: user voiceSpeed and a learned CPS factor (feedback loop). */
export interface Calibration { voiceSpeed?: number; cpsFactor?: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Estimated natural duration (ms, rate 1) of `text` in `lang`. `cal.cpsFactor` > 1 = voice talks faster than the prior. */
export function estimateMs(text: string, lang: Lang, cal?: Calibration): number {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 0;
  const factor = cal?.cpsFactor && Number.isFinite(cal.cpsFactor) && cal.cpsFactor > 0 ? cal.cpsFactor : 1;
  const cps = (CPS[lang] ?? 14) * factor;
  const pauses = (clean.match(/[,.;:!?،؟؛…。]/g)?.length ?? 0) * PAUSE_MS;
  return (clean.length / cps) * 1000 + pauses;
}

/**
 * Plan one line: slot to next.start − 100 ms (cap end + 600 ms), rate clamp(natural/slot, 1, 1.3) × voiceSpeed,
 * then borrow the gap up to next.start − 100 ms, then hard cut at `maxMs` (`trimmed` = the cut will bite).
 * `rate` is the speech rate in media time; the scheduler multiplies it by video.playbackRate.
 */
export function fit(line: Line, next: Line | undefined, lang: Lang, knownMs?: number, cal?: Calibration): Plan {
  const vs = cal?.voiceSpeed && Number.isFinite(cal.voiceSpeed) && cal.voiceSpeed > 0 ? cal.voiceSpeed : 1;
  const natural = knownMs != null && Number.isFinite(knownMs) && knownMs > 0 ? knownMs : estimateMs(line.text, lang, cal);
  const hardEnd = next ? next.start - GAP_GUARD_S : line.end + LAST_LINE_TAIL_S;
  const slotEnd = Math.min(hardEnd, line.end + TAIL_S);
  const slotMs = Math.max(MIN_SLOT_MS, (slotEnd - line.start) * 1000);
  // Duration at the user's speed, then speed up to fit (max 1.3x on top of voiceSpeed).
  const atUserSpeed = natural / vs;
  const factor = clamp(atUserSpeed / slotMs, 1, MAX_RATE);
  const rate = factor * vs;
  const duration = natural / rate;
  // Hard boundary: the gap up to the next line (borrowed only if needed; never earlier than the slot).
  const maxMs = Math.max(slotMs, (hardEnd - line.start) * 1000);
  return { line, rate, startAt: line.start, maxMs, trimmed: duration > maxMs + 1 };
}

// ---------------------------------------------------------------- v1.1 track pacing (continuous mode)

/** Lines whose gap is below this (s) belong to one cluster (spoken back to back at one uniform pace). */
export const CLUSTER_GAP_S = 0.7;
/** A cluster may start this early (s) into the preceding silence when it needs the time. */
export const EARLY_START_S = 0.4;
/** Rate cap relative to voiceSpeed. */
export const PACE_CAP = 1.3;
/** Absolute rate ceiling, whatever the settings. */
export const HARD_MAX_RATE = 1.35;
/** Never slow a voice below this × voiceSpeed (pace equalisation of a fast voice). */
export const MIN_RATE_FACTOR = 0.85;
/** Max rate change between consecutive lines in the plan (the runtime limiter allows 0.08: room for lag control). */
export const PLAN_STEP = 0.06;

/**
 * Per-line pacing input. `u` = estimated natural ms at the prior CPS (estimateMs, cpsFactor 1).
 * `f` = how much faster than the prior this line's voice talks (calibrated per voice; exact when the audio duration is known).
 */
export interface PaceInput {
  u: number; f: number; voice?: string;
  /** v1.2 (E): emotion speed hint (≈ 0.95–1.06, default 1): this line is spoken that much faster than its cluster's pace (still capped). */
  hint?: number;
}

export interface PaceOptions {
  voiceSpeed?: number;
  /** Speed factor of the reference (default) voice: pace baseline = voiceSpeed × refFactor, so every voice sounds equally fast. */
  refFactor?: number;
  clusterGapS?: number;
  earlyS?: number;
  tailS?: number;
  step?: number;
}

/** A continuous-mode plan: `rate` is for this line's voice; `pace` = rate × f (voice-independent speed, prior = 1). */
export interface PacedPlan extends Plan {
  /** Estimated speech duration at `rate` (ms). */
  estMs: number;
  /** Voice speed factor used (see PaceInput.f). */
  factor: number;
  /** Max rate for this line (min(1.3 × voiceSpeed, 1.35)). */
  cap: number;
  /** Cluster index (lines spoken back to back). */
  cluster: number;
  voice?: string;
}

const okNum = (v: number | undefined, d: number) => (v != null && Number.isFinite(v) && v > 0 ? v : d);

/** Rate cap for a user voiceSpeed: min(1.3 × vs, 1.35), never below vs. */
export function rateCap(voiceSpeed = 1): number {
  const vs = okNum(voiceSpeed, 1);
  return Math.max(vs, Math.min(PACE_CAP * vs, HARD_MAX_RATE));
}

/**
 * Plan a whole track ahead (continuous mode). Lines with gaps < 0.7 s form clusters; each cluster gets ONE pace so its
 * estimated speech fits from its start (up to 0.4 s early into the preceding silence, after the previous cluster's
 * projected end) to its last end + tail. A cluster that cannot fit pushes its overflow into the next one (projection),
 * so debt is spread instead of skipped. Paces are then smoothed (max step per line both ways, only ever raised).
 */
export function planTrack(lines: readonly Line[], input: (line: Line, i: number) => PaceInput, o: PaceOptions = {}): PacedPlan[] {
  const n = lines.length;
  if (!n) return [];
  const vs = okNum(o.voiceSpeed, 1);
  const cap = rateCap(vs);
  const ref = okNum(o.refFactor, 1);
  const gapS = o.clusterGapS ?? CLUSTER_GAP_S;
  const earlyS = o.earlyS ?? EARLY_START_S;
  const tailS = o.tailS ?? TAIL_S;
  const step = o.step ?? PLAN_STEP;
  const q0 = vs * ref; // baseline pace
  const inp = lines.map((l, i) => {
    const x = input(l, i);
    const hint = x.hint != null && Number.isFinite(x.hint) ? Math.min(1.08, Math.max(0.92, x.hint)) : 1;
    return { u: Math.max(0, Number.isFinite(x.u) ? x.u : 0), f: okNum(x.f, 1), voice: x.voice, hint };
  });
  const q = new Array<number>(n).fill(q0);
  const startAt = lines.map((l) => l.start);
  const clusterOf = new Array<number>(n).fill(0);

  // Clusters.
  const clusters: [number, number][] = [];
  let a = 0;
  for (let i = 0; i < n; i++) {
    const nx = lines[i + 1];
    if (!nx || nx.start - lines[i].end >= gapS) { clusters.push([a, i]); a = i + 1; }
  }

  let projEnd = -Infinity;
  clusters.forEach(([s, e], ci) => {
    const head = lines[s];
    const nextHead = clusters[ci + 1] ? lines[clusters[ci + 1][0]] : undefined;
    const E = nextHead ? Math.min(lines[e].end + tailS, nextHead.start - 0.3) : lines[e].end + LAST_LINE_TAIL_S;
    let U = 0;
    let qcap = Infinity;
    for (let i = s; i <= e; i++) { U += inp[i].u; qcap = Math.min(qcap, cap * inp[i].f); }
    U /= 1000;
    const free = projEnd + 0.05;
    const sOnTime = Math.max(head.start, free);
    let S = sOnTime;
    // Early start only when the cluster needs the time and the voice is free.
    if (U / Math.max(0.2, E - sOnTime) > q0) S = Math.max(head.start - earlyS, free);
    const need = U / Math.max(0.2, E - S);
    const qc = Math.min(qcap, Math.max(q0, need));
    for (let i = s; i <= e; i++) { q[i] = qc; clusterOf[i] = ci; }
    if (S < head.start) startAt[s] = S;
    projEnd = S + U / qc;
  });

  // Smooth: never lower a pace; ramp up before fast clusters, ramp down after them.
  const stepAt = (i: number, j: number) => step * Math.min(inp[i].f, inp[j].f);
  for (let i = n - 2; i >= 0; i--) q[i] = Math.max(q[i], q[i + 1] - stepAt(i, i + 1));
  for (let i = 1; i < n; i++) q[i] = Math.max(q[i], q[i - 1] - stepAt(i, i - 1));

  return lines.map((line, i) => {
    const f = inp[i].f;
    const rate = Math.min(cap, Math.max(MIN_RATE_FACTOR * vs, (q[i] * inp[i].hint) / f));
    const estMs = inp[i].u / f / rate;
    const nx = lines[i + 1];
    const hardEnd = nx ? nx.start - GAP_GUARD_S : line.end + LAST_LINE_TAIL_S;
    const maxMs = Math.max(MIN_SLOT_MS, estMs, (hardEnd - line.start) * 1000);
    return { line, rate, startAt: startAt[i], maxMs, trimmed: false, estMs, factor: f, cap, cluster: clusterOf[i], voice: inp[i].voice };
  });
}

// ---------------------------------------------------------------- per-voice speed calibration

/** chrome.storage.local key: per-voice speed factors. */
export const VOICE_CAL_KEY = 'voiceCal';
/** EMA weight of a new measurement. */
export const CAL_ALPHA = 0.25;
const CAL_MIN = 0.6;
const CAL_MAX = 1.6;

export interface VoiceCalEntry { f: number; n: number; at?: number }

/**
 * Learns, per voice, how much faster (f > 1) or slower than the language prior it really talks, from measured speech
 * (Web Speech onstart→onend × rate, or the decoded duration of API audio). EMA, clamped 0.6–1.6.
 */
export class VoiceCalibration {
  private m = new Map<string, VoiceCalEntry>();
  private dirty = false;

  constructor(initial?: Record<string, VoiceCalEntry> | null) {
    if (initial && typeof initial === 'object') {
      for (const [k, v] of Object.entries(initial)) {
        if (v && Number.isFinite(v.f) && v.f >= CAL_MIN && v.f <= CAL_MAX) this.m.set(k, { f: v.f, n: Math.max(0, v.n | 0), at: v.at });
      }
    }
  }

  /** Speed factor of a voice (1 = the prior). */
  factor(key: string | undefined): number {
    return (key && this.m.get(key)?.f) || 1;
  }

  count(key: string | undefined): number { return (key && this.m.get(key)?.n) || 0; }

  /**
   * Feed one measurement: `u` = estimateMs at the prior, `naturalMs` = measured duration at rate 1.
   * Returns true when the factor moved by more than 1 % (worth replanning). Ignores tiny/absurd samples.
   */
  update(key: string | undefined, u: number, naturalMs: number): boolean {
    if (!key || !(u > 300) || !(naturalMs > 200)) return false;
    const ratio = Math.min(CAL_MAX, Math.max(CAL_MIN, u / naturalMs));
    const cur = this.m.get(key);
    // First samples move faster (1/n up to alpha) so a new voice converges in a few lines.
    const alpha = cur ? Math.max(CAL_ALPHA, 1 / (cur.n + 1)) : 1;
    const prev = cur?.f ?? 1;
    const f = cur ? prev + alpha * (ratio - prev) : ratio;
    this.m.set(key, { f, n: (cur?.n ?? 0) + 1, at: Date.now() });
    this.dirty = true;
    return Math.abs(f - prev) / prev > 0.01;
  }

  isDirty(): boolean { return this.dirty; }

  toJSON(): Record<string, VoiceCalEntry> {
    this.dirty = false;
    // Keep the 60 most recently used voices.
    const list = [...this.m.entries()].sort((x, y) => (y[1].at ?? 0) - (x[1].at ?? 0)).slice(0, 60);
    return Object.fromEntries(list);
  }
}

/** Read stored per-voice calibration ({} when unavailable). */
export async function loadVoiceCal(): Promise<Record<string, VoiceCalEntry>> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return {};
    const got = await chrome.storage.local.get(VOICE_CAL_KEY);
    const v = got?.[VOICE_CAL_KEY];
    return v && typeof v === 'object' ? (v as Record<string, VoiceCalEntry>) : {};
  } catch {
    return {};
  }
}

/** Persist per-voice calibration. */
export async function saveVoiceCal(cal: VoiceCalibration): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [VOICE_CAL_KEY]: cal.toJSON() });
  } catch { /* ignore */ }
}
