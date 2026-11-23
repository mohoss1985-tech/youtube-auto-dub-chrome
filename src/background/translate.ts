// OpenAI translation in the service worker (§3.5, C5). Owner: A.
import type { Lang } from '../shared/types';

/** Translate ≤ 40 lines with OpenAI chat `model`, returning exactly texts.length strings. Throws DubError (NO_KEY | NETWORK | RATE_LIMITED | TIMEOUT). Never logs `key`. */
export async function translateBatch(texts: string[], from: string, to: Lang, key: string, model: string, signal?: AbortSignal): Promise<string[]> {
  void texts; void from; void to; void key; void model; void signal;
  throw new Error('TODO A');
}
