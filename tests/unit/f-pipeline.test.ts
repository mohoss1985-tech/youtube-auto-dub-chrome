// F (v1.1): speaker markers survive parse → clean → merge → translate; Nano "smart French" through getLines.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import type { CaptionTrack, Json3, Line } from '../../src/shared/types';

vi.mock('../../src/content/yt', () => ({
  getPlayerResponse: vi.fn(),
  getJson3: vi.fn(),
  bridgeRequest: vi.fn(async () => { throw new Error('no MAIN hook in tests'); }),
}));

import * as yt from '../../src/content/yt';
import { parseJson3, mergeSentences } from '../../src/content/captions';
import { getLines, _resetPipeline, linesFromJson3 } from '../../src/content/pipeline';

const ev = (t: number, d: number, s: string) => ({ tStartMs: t, dDurationMs: d, segs: [{ utf8: s }] });
/** MrBeast-style human captions with speaker changes. */
const MRBEAST: Json3 = {
  events: [
    ev(0, 1500, '[Music]'),
    ev(1500, 2000, ">> I JUST BOUGHT A PRIVATE ISLAND!"),
    ev(3600, 1500, '>> No way.'),
    ev(5200, 1800, '- Um, how much did it cost?'),
    ev(7100, 1800, '[Karl]: Like, $10,000?'),
    ev(9000, 1500, 'It was way more.'),
    ev(10600, 1500, '♪ Happy birthday to you ♪'),
    ev(12200, 2000, '>> [Applause]'),
    ev(14300, 2000, 'Thank you guys.'),
  ],
};

function installTranslator() {
  (globalThis as any).Translator = {
    availability: vi.fn(async () => 'available'),
    create: vi.fn(async () => ({ translate: vi.fn(async (s: string) => `FR(${s})`), destroy: vi.fn() })),
  };
}

describe('speaker markers', () => {
  it('parse + merge keep Line.newSpeaker and never merge across a change; markers not spoken', () => {
    const lines = mergeSentences(parseJson3({ events: [ev(0, 1000, 'so we went'), ev(1000, 1000, '>> to the store'), ev(2000, 1000, 'and then')] }), 'en', { asr: true });
    expect(lines.map((l) => [l.text, !!l.newSpeaker])).toEqual([['so we went', false], ['to the store and then', true]]);
  });

  it('MrBeast fixture: cleanup drops tags/lyrics/fillers, flags move to the next spoken line', () => {
    const lines = linesFromJson3(MRBEAST, 'en');
    expect(lines.map((l) => l.text)).toEqual([
      'I just bought a private island!',
      'That is impossible.',
      'How much did it cost?',
      '$10,000?',
      'It was way more.',
      'Thank you guys.',
    ]);
    expect(lines.map((l) => !!l.newSpeaker)).toEqual([true, true, true, true, false, true]);
    expect(lines.some((l) => /[>\[\]♪]/.test(l.text))).toBe(false);
  });
});

describe('getLines (v1.1 text)', () => {
  const human: CaptionTrack = { baseUrl: 'https://www.youtube.com/api/timedtext?v=vid&lang=en', languageCode: 'en', vssId: '.en' };
  const pr = { videoDetails: { videoId: 'vid' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ ...human, isTranslatable: false }] } } };
  let cache: Map<string, unknown>;

  beforeEach(() => {
    _resetPipeline();
    cache = new Map();
    const chromeMock = installChromeMock();
    chromeMock.runtime.sendMessage.mockImplementation(async (msg: any) => {
      if (msg.type === 'CACHE_GET') return cache.has(msg.key) ? { ok: true, value: cache.get(msg.key) } : { ok: true };
      if (msg.type === 'CACHE_PUT') { cache.set(msg.key, msg.value); return { ok: true }; }
      return { ok: false, error: 'NO_KEY' };
    });
    vi.mocked(yt.getPlayerResponse).mockResolvedValue(pr as any);
    vi.mocked(yt.getJson3).mockResolvedValue(MRBEAST);
    installTranslator();
  });
  afterEach(() => { delete (globalThis as any).Translator; });

  it('translation keeps ids, count, newSpeaker; French polished for TTS', async () => {
    (globalThis as any).Translator.create = vi.fn(async () => ({ translate: vi.fn(async (s: string) => (s === '$10,000?' ? '10 000 $ ?' : `FR(${s})`)), destroy: vi.fn() }));
    const src = linesFromJson3(MRBEAST, 'en');
    const out = await getLines('vid', 'fr');
    expect(out.map((l) => l.id)).toEqual(src.map((l) => l.id));
    expect(out.map((l) => !!l.newSpeaker)).toEqual(src.map((l) => !!l.newSpeaker));
    expect(out[3]!.text).toBe('10 000 dollars ?');
    expect(out[3]!.source).toBe('$10,000?');
  });

  it('smartFrench: over-long lines rewritten in the background via onUpdate; short ones untouched; never blocks', async () => {
    const LONG = "C'est vraiment absolument incroyable que nous ayons réussi à acheter une île privée entière aujourd'hui";
    (globalThis as any).Translator.create = vi.fn(async () => ({ translate: vi.fn(async (s: string) => (s.startsWith('I just') ? LONG : `FR(${s})`)), destroy: vi.fn() }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const rewrite = vi.fn(async () => { await gate; return "On a acheté une île privée, c'est fou !"; });
    const updates: Line[][] = [];
    const first = await getLines('vid', 'fr', undefined, { onUpdate: (l) => updates.push(l), smartFrench: true, rewrite });
    expect(first[0]!.text).toBe(LONG); // returned before Nano answered
    expect(rewrite).toHaveBeenCalledTimes(1); // only the over-long line
    release();
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 2000 });
    const last = updates.at(-1)!;
    expect(last[0]!.text).toBe("On a acheté une île privée, c'est fou !");
    expect(last[0]!.newSpeaker).toBe(true);
    expect(last.slice(1).map((l) => l.text)).toEqual(first.slice(1).map((l) => l.text));
  });
});
