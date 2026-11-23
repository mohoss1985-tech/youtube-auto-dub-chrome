// Owner A: MAIN-world hook — timedtext capture, §3.4 json3 order, CC toggle restore, player response.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { captured, recordTimedtext, resolveJson3, readPlayerResponse, type Json3Deps } from '../../src/content/main-hook';
import type { CaptionTrack } from '../../src/shared/types';

const BASE = 'https://www.youtube.com/api/timedtext?v=vid12345678&lang=en&exp=xpe&signature=S';
const CAP = 'https://www.youtube.com/api/timedtext?v=vid12345678&lang=en&pot=PoT%2B1&c=WEB&exp=xpe&fmt=srv3';
const track: CaptionTrack = { baseUrl: BASE, languageCode: 'en', vssId: '.en' };
const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hi.' }] }] });

function deps(over: Partial<Json3Deps> = {}): Json3Deps & { fetch: ReturnType<typeof vi.fn> } {
  return { fetch: vi.fn(), doc: document, perfUrls: () => [], sleep: async () => {}, captureWaitMs: 50, ...over } as any;
}

beforeEach(() => {
  captured.clear();
  document.body.innerHTML = '';
  document.getElementById('autodub-hide-cc')?.remove();
});

describe('capture', () => {
  it('page fetch/XHR to /api/timedtext is recorded per videoId', async () => {
    recordTimedtext(CAP);
    recordTimedtext(CAP);
    recordTimedtext('https://www.youtube.com/youtubei/v1/player');
    expect(captured.get('vid12345678')).toEqual([CAP]);
    // XHR hook installed at import
    const x = new XMLHttpRequest();
    x.open('GET', 'https://www.youtube.com/api/timedtext?v=other0000000&lang=fr');
    expect(captured.get('other0000000')).toHaveLength(1);
  });
});

describe('resolveJson3 order (§3.4)', () => {
  it('captured URL first, rewritten with fmt=json3 + tlang, pot kept', async () => {
    recordTimedtext(CAP);
    const d = deps();
    d.fetch.mockResolvedValue(new Response(body));
    const j = await resolveJson3({ track, videoId: 'vid12345678', tlang: 'fr' }, d);
    expect(j?.events).toHaveLength(1);
    const u = new URL(d.fetch.mock.calls[0]![0]);
    expect(u.searchParams.get('pot')).toBe('PoT+1');
    expect(u.searchParams.get('fmt')).toBe('json3');
    expect(u.searchParams.get('tlang')).toBe('fr');
  });

  it('empty body → performance entry → (baseUrl skipped for exp=xpe) → CC toggle capture, then restores CC', async () => {
    const perf = 'https://www.youtube.com/api/timedtext?v=vid12345678&lang=en&pot=PERF';
    const player = document.createElement('div') as any;
    player.id = 'movie_player';
    player.getOption = vi.fn(() => ({}));
    player.loadModule = vi.fn(() => recordTimedtext('https://www.youtube.com/api/timedtext?v=vid12345678&lang=en&pot=FRESH'));
    player.setOption = vi.fn();
    player.unloadModule = vi.fn();
    document.body.appendChild(player);
    const d = deps({ perfUrls: () => [perf] });
    d.fetch.mockImplementation(async (url: string) => new Response(url.includes('pot=FRESH') ? body : ''));
    const j = await resolveJson3({ track, videoId: 'vid12345678' }, d);
    expect(j?.events).toHaveLength(1);
    const urls = d.fetch.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('pot=PERF');
    expect(urls.some((u) => u.includes('signature=S') && !u.includes('pot='))).toBe(false); // exp=xpe baseUrl skipped
    expect(urls.at(-1)).toContain('pot=FRESH');
    expect(player.setOption).toHaveBeenCalledWith('captions', 'track', { languageCode: 'en' });
    expect(player.unloadModule).toHaveBeenCalledWith('captions'); // CC was off → restored off
    await new Promise((r) => setTimeout(r, 5));
    expect(document.getElementById('autodub-hide-cc')).toBeNull();
  });

  it('baseUrl without exp=xpe is tried; CC was on → previous track restored', async () => {
    const player = document.createElement('div') as any;
    player.id = 'movie_player';
    const prev = { languageCode: 'de' };
    player.getOption = vi.fn(() => prev);
    player.loadModule = vi.fn();
    player.setOption = vi.fn();
    player.unloadModule = vi.fn();
    document.body.appendChild(player);
    const d = deps();
    d.fetch.mockResolvedValue(new Response(''));
    const plain = { ...track, baseUrl: 'https://www.youtube.com/api/timedtext?v=vid12345678&lang=en' };
    expect(await resolveJson3({ track: plain, videoId: 'vid12345678' }, d)).toBeNull();
    expect(String(d.fetch.mock.calls[0]![0])).toContain('fmt=json3');
    expect(player.setOption).toHaveBeenLastCalledWith('captions', 'track', prev);
    expect(player.unloadModule).not.toHaveBeenCalled();
  });

  it('429 → throws RATE_LIMITED', async () => {
    recordTimedtext(CAP);
    const d = deps();
    d.fetch.mockResolvedValue(new Response('', { status: 429 }));
    await expect(resolveJson3({ track, videoId: 'vid12345678', tlang: 'ar' }, d)).rejects.toThrow('RATE_LIMITED');
  });
});

describe('readPlayerResponse', () => {
  it('uses movie_player when videoId matches, else ytInitialPlayerResponse if it matches, else null', () => {
    const player = document.createElement('div') as any;
    player.id = 'movie_player';
    player.getPlayerResponse = () => ({ videoDetails: { videoId: 'new' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } }, streamingData: { adaptiveFormats: [{ itag: 1 }, { audioTrack: { id: 'fr.1' } }] } });
    document.body.appendChild(player);
    (window as any).ytInitialPlayerResponse = { videoDetails: { videoId: 'old' } };
    const pr = readPlayerResponse('new');
    expect(pr?.videoDetails?.videoId).toBe('new');
    expect(pr?.streamingData?.adaptiveFormats).toEqual([{ audioTrack: { id: 'fr.1' } }]);
    expect(readPlayerResponse('old')?.videoDetails?.videoId).toBe('old');
    expect(readPlayerResponse('zzz')).toBeNull();
    delete (window as any).ytInitialPlayerResponse;
  });
});
