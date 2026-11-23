// Thumbs up/down per line in chrome.storage.local 'feedback' (ring ≤ 500) (§7). Owner: D.
import type { Feedback } from './types';

/** Append one entry; oldest dropped beyond 500. */
export async function saveFeedback(fb: Feedback): Promise<void> {
  void fb;
  throw new Error('TODO D');
}

/** All entries, or only those for `videoId`. */
export async function getFeedback(videoId?: string): Promise<Feedback[]> {
  void videoId;
  return []; // TODO D
}
