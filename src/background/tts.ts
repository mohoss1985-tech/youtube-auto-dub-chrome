// TTS network calls in the service worker (§4). Owner: B.
import type { Secrets, TtsRequest, TtsResult } from '../shared/types';

/** Call OpenAI (gpt-4o-mini-tts, mp3) or ElevenLabs (eleven_flash_v2_5, mp3_44100_64) with the user's key; returns base64 audio. Throws DubError NO_KEY | ENGINE_ERROR | RATE_LIMITED | TIMEOUT. Never logs keys. */
export async function synthesize(req: TtsRequest, secrets: Secrets, signal?: AbortSignal): Promise<TtsResult> {
  void req; void secrets; void signal;
  throw new Error('TODO B');
}
