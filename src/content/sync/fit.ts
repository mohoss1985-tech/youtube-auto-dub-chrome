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
