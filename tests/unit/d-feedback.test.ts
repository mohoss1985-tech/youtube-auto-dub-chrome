// D: feedback ring buffer (≤ 500) in chrome.storage.local.
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import { saveFeedback, getFeedback, FEEDBACK_MAX } from '../../src/shared/feedback';
import type { Feedback } from '../../src/shared/types';

const fb = (i: number, videoId = 'v1', up = true): Feedback =>
  ({ videoId, lineId: `L${i}`, lang: 'fr', up, rate: 1, overflowMs: 0, at: 1000 + i });

describe('feedback', () => {
  beforeEach(() => { installChromeMock(); });

  it('saves and filters by video', async () => {
    await saveFeedback(fb(1));
    await saveFeedback(fb(2, 'v2'));
    expect(await getFeedback()).toHaveLength(2);
    expect((await getFeedback('v2'))[0].lineId).toBe('L2');
  });

  it('keeps only the last 500 (concurrent writes are not lost)', async () => {
    await Promise.all(Array.from({ length: 520 }, (_, i) => saveFeedback(fb(i))));
    const all = await getFeedback();
    expect(all).toHaveLength(FEEDBACK_MAX);
    expect(all[0].lineId).toBe('L20');
    expect(all.at(-1)!.lineId).toBe('L519');
  });

  it('a second vote on the same line replaces the first', async () => {
    await saveFeedback(fb(1, 'v1', true));
    await saveFeedback(fb(1, 'v1', false));
    const all = await getFeedback('v1');
    expect(all).toHaveLength(1);
    expect(all[0].up).toBe(false);
  });
});
