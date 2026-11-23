// Timing fit: rate + trimming per line (§5). Owner: C.
import type { Lang, Line, Plan } from '../../shared/types';

/** Characters per second at rate 1, per language. */
export const CPS: Readonly<Record<Lang, number>> = { en: 14, es: 15, fr: 14, tr: 13, ar: 12 };
/** Maximum speech-rate speed-up before trimming. */
export const MAX_RATE = 1.3;

/** Optional calibration: user voiceSpeed and a learned CPS factor (feedback loop). */
export interface Calibration { voiceSpeed?: number; cpsFactor?: number }

/** Estimated natural duration (ms, rate 1) of `text` in `lang`. */
export function estimateMs(text: string, lang: Lang, cal?: Calibration): number {
  void text; void lang; void cal;
  throw new Error('TODO C');
}

/** Plan one line: slot to next.start − 100 ms (cap end + 600 ms), rate clamp(natural/slot, 1, 1.3) × voiceSpeed, then borrow gap, then maxMs cut. */
export function fit(line: Line, next: Line | undefined, lang: Lang, knownMs?: number, cal?: Calibration): Plan {
  void line; void next; void lang; void knownMs; void cal;
  throw new Error('TODO C');
}
