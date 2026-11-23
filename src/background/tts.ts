// TTS network calls in the service worker (§4). Owner: B.
import { DubError, type Lang, type Secrets, type TtsRequest, type TtsResult } from '../shared/types';

export const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const ELEVEN_TTS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech/';
export const ELEVEN_TTS_MODEL = 'eleven_flash_v2_5';
export const ELEVEN_FORMAT = 'mp3_44100_64';
export const TTS_TIMEOUT_MS = 20_000;
/** Longest text sent in one call (a merged line is ≤ 180 chars; this is a safety cap). */
export const MAX_TTS_CHARS = 4000;

const LANG_NAME: Record<Lang, string> = { fr: 'French', ar: 'Arabic', en: 'English', es: 'Spanish', tr: 'Turkish' };

/** Remove the key (and anything that looks like an API key) from provider text. */
export function scrub(text: string, keys: (string | undefined)[]): string {
  let t = text;
  for (const k of keys) if (k) t = t.split(k).join('[key]');
  return t.replace(/\b(sk-[A-Za-z0-9_\-*]{4,}|sk_[A-Za-z0-9*]{8,})/g, '[key]').slice(0, 200);
}

/** ArrayBuffer → base64 (chunked, safe for large buffers). */
export function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

interface Call { url: string; init: RequestInit }

function buildCall(req: TtsRequest, key: string): Call {
  if (req.engine === 'openai') {
    const body: Record<string, unknown> = {
      model: OPENAI_TTS_MODEL,
      input: req.text,
      voice: req.voice || 'coral',
      response_format: 'mp3',
      instructions: `Speak natural ${LANG_NAME[req.lang]} in a warm, clear, friendly voice suitable for children.`,
    };
    if (req.speed && req.speed !== 1) body.speed = Math.min(4, Math.max(0.25, req.speed));
    return {
      url: OPENAI_TTS_URL,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify(body),
      },
    };
  }
  const body: Record<string, unknown> = { text: req.text, model_id: ELEVEN_TTS_MODEL, language_code: req.lang };
  if (req.speed && req.speed !== 1) body.voice_settings = { speed: Math.min(1.2, Math.max(0.7, req.speed)) };
  return {
    url: `${ELEVEN_TTS_BASE}${encodeURIComponent(req.voice)}?output_format=${ELEVEN_FORMAT}`,
    init: {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify(body),
    },
  };
}

async function providerMessage(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as { error?: { message?: string } | string; detail?: { message?: string } | string };
      const e = j.error ?? j.detail;
      if (typeof e === 'string') return e;
      if (e && typeof e.message === 'string') return e.message;
    } catch { /* not JSON */ }
    return t;
  } catch {
    return '';
  }
}

/** Call OpenAI (gpt-4o-mini-tts, mp3) or ElevenLabs (eleven_flash_v2_5, mp3_44100_64) with the user's key; returns base64 audio. Throws DubError NO_KEY | ENGINE_ERROR | RATE_LIMITED | TIMEOUT | NETWORK. Never logs keys. */
export async function synthesize(req: TtsRequest, secrets: Secrets, signal?: AbortSignal): Promise<TtsResult> {
  const key = req.engine === 'openai' ? secrets.openaiKey : req.engine === 'elevenlabs' ? secrets.elevenKey : undefined;
  const provider = req.engine === 'openai' ? 'OpenAI' : 'ElevenLabs';
  if (req.engine !== 'openai' && req.engine !== 'elevenlabs') throw new DubError('ENGINE_ERROR', 'Unknown engine');
  if (!key) throw new DubError('NO_KEY', `Add your ${provider} key to use this voice.`);
  const text = (req.text ?? '').trim();
  if (!text) throw new DubError('ENGINE_ERROR', 'Nothing to say');
  if (text.length > MAX_TTS_CHARS) throw new DubError('ENGINE_ERROR', 'Line too long');
  if (req.engine === 'elevenlabs' && !req.voice) throw new DubError('ENGINE_ERROR', 'No ElevenLabs voice chosen');

  const { url, init } = buildCall({ ...req, text }, key);
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, TTS_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  if (signal?.aborted) ac.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: ac.signal });
    } catch {
      if (timedOut || ac.signal.aborted) throw new DubError('TIMEOUT', `${provider} did not answer in ${TTS_TIMEOUT_MS / 1000} s`);
      throw new DubError('NETWORK', `Could not reach ${provider}`);
    }
    if (!res.ok) {
      const msg = scrub(await providerMessage(res), [secrets.openaiKey, secrets.elevenKey]);
      if (res.status === 401 || res.status === 403) throw new DubError('NO_KEY', `${provider} rejected the key (HTTP ${res.status}).`);
      if (res.status === 429) throw new DubError('RATE_LIMITED', `${provider} rate limit or quota reached (HTTP 429).${msg ? ' ' + msg : ''}`);
      throw new DubError('ENGINE_ERROR', `${provider} error HTTP ${res.status}${msg ? ': ' + msg : ''}`);
    }
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch {
      if (timedOut || ac.signal.aborted) throw new DubError('TIMEOUT', `${provider} did not answer in ${TTS_TIMEOUT_MS / 1000} s`);
      throw new DubError('NETWORK', `${provider} audio download failed`);
    }
    if (!buf.byteLength) throw new DubError('ENGINE_ERROR', `${provider} returned empty audio`);
    const mime = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim() || 'audio/mpeg';
    return { audioB64: bufToB64(buf), mime: mime.startsWith('audio/') ? mime : 'audio/mpeg' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
