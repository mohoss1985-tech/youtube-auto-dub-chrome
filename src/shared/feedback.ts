// Thumbs up/down per line in chrome.storage.local 'feedback' (ring ≤ 500) (§7). Owner: D.
import type { Feedback } from './types';

export const FEEDBACK_KEY = 'feedback';
export const FEEDBACK_MAX = 500;

// Serialise read-modify-write so two quick clicks don't drop an entry.
let queue: Promise<unknown> = Promise.resolve();

function isFeedback(x: unknown): x is Feedback {
  const f = x as Feedback;
  return !!f && typeof f === 'object' && typeof f.videoId === 'string' && typeof f.lineId === 'string' && typeof f.up === 'boolean';
}

async function readAll(): Promise<Feedback[]> {
  const got = await chrome.storage.local.get(FEEDBACK_KEY);
  const raw = got[FEEDBACK_KEY];
  return Array.isArray(raw) ? raw.filter(isFeedback) : [];
}

/** Append one entry; oldest dropped beyond 500. A second vote on the same line replaces the first. */
export function saveFeedback(fb: Feedback): Promise<void> {
  const run = queue.then(async () => {
    const list = (await readAll()).filter((f) => !(f.videoId === fb.videoId && f.lineId === fb.lineId && f.lang === fb.lang));
    list.push({ ...fb, at: fb.at || Date.now() });
    await chrome.storage.local.set({ [FEEDBACK_KEY]: list.slice(-FEEDBACK_MAX) });
  });
  queue = run.catch(() => {});
  return run;
}

/** All entries (oldest first), or only those for `videoId`. */
export async function getFeedback(videoId?: string): Promise<Feedback[]> {
  await queue;
  const all = await readAll();
  return videoId ? all.filter((f) => f.videoId === videoId) : all;
}
