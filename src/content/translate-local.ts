// Chrome built-in Translator API (Chrome 138+, on-device, free). Owner: A.
import type { Lang } from '../shared/types';

/** Translate with the on-device Translator API, keeping line count. Returns null when the API or language pair is unavailable. `onProgress` gets model download progress 0..1. */
export async function translateLocal(texts: string[], from: string, to: Lang, onProgress?: (loaded: number) => void): Promise<string[] | null> {
  void texts; void from; void to; void onProgress;
  return null; // TODO A
}
