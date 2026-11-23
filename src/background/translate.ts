// OpenAI translation in the service worker (§3.5, C5). Owner: A.
// Never logs the key; error messages never contain response bodies for auth failures.
import { DubError, type Lang } from '../shared/types';

export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

const LANG_NAMES: Record<string, string> = { fr: 'French', ar: 'Arabic', en: 'English', es: 'Spanish', tr: 'Turkish' };

function langName(code: string): string {
  const base = code.toLowerCase().split(/[-_]/)[0] ?? code;
  if (LANG_NAMES[base]) return LANG_NAMES[base]!;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Build the chat request body (exported for tests). */
export function buildTranslateBody(texts: string[], from: string, to: Lang, model: string, strict = false): Record<string, unknown> {
  const src = from ? langName(from) : 'the source language';
  const dst = langName(to);
  const system =
    `You translate video subtitles from ${src} to ${dst} for a dubbing app (often used by children). ` +
    `Translate every string into natural, simple spoken ${dst}. Keep names. Do not merge, split, drop, add or reorder items. ` +
    `Reply with JSON only: {"translations": [...]} containing exactly ${texts.length} strings in the same order as the input array.` +
    (strict ? ` The input has ${texts.length} items; your array MUST have ${texts.length} items.` : '');
  return {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(texts) },
    ],
  };
}

/** Pull the string array out of the model's reply ({translations:[…]}, any single array property, or a bare array). */
export function parseTranslations(content: unknown): string[] | null {
  if (typeof content !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
  let arr: unknown = Array.isArray(data) ? data : null;
  if (!arr && data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    arr = Array.isArray(o.translations) ? o.translations : Object.values(o).find(Array.isArray) ?? null;
  }
  if (!Array.isArray(arr)) return null;
  return arr.map((x) => (typeof x === 'string' ? x : x == null ? '' : String(x)));
}

/** Translate ≤ 40 lines with OpenAI chat `model`, returning exactly texts.length strings. Throws DubError (NO_KEY | NETWORK | RATE_LIMITED | TIMEOUT | NO_TRANSLATION). Never logs `key`. */
export async function translateBatch(texts: string[], from: string, to: Lang, key: string, model: string, signal?: AbortSignal): Promise<string[]> {
  if (!key) throw new DubError('NO_KEY', 'Add an OpenAI key to translate this video.');
  if (!texts.length) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(buildTranslateBody(texts, from, to, model || 'gpt-4o-mini', attempt > 0)),
        signal,
      });
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') throw new DubError('TIMEOUT', 'Translation timed out');
      throw new DubError('NETWORK', 'Could not reach OpenAI');
    }
    if (res.status === 401 || res.status === 403) throw new DubError('NO_KEY', `OpenAI rejected the key (${res.status}).`);
    if (res.status === 429) throw new DubError('RATE_LIMITED', 'OpenAI rate limit or quota reached.');
    if (!res.ok) throw new DubError('NETWORK', `OpenAI error ${res.status}`);
    let content: unknown;
    try {
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      content = data?.choices?.[0]?.message?.content;
    } catch {
      content = null;
    }
    const out = parseTranslations(content);
    if (out && out.length === texts.length) return out.map((s) => s.trim());
  }
  throw new DubError('NO_TRANSLATION', 'Translation returned a different line count.');
}
