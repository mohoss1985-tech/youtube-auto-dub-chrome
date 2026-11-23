// Captions → translated, merged Line[] for one video+language (§3). Owner: A.
import type { Lang, Line } from '../shared/types';

/** Full pipeline with SW cache `lines:<videoId>:<lang>`. Throws DubError NO_CAPTIONS | NO_TRANSLATION | RATE_LIMITED. `onProgress` gets user-facing status text (e.g. "Downloading French translator…"). */
export async function getLines(videoId: string, lang: Lang, onProgress?: (message: string) => void): Promise<Line[]> {
  void videoId; void lang; void onProgress;
  throw new Error('TODO A');
}
