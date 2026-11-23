// F (v1.1): YouTube's official / auto-dubbed audio track — switch, restore, fallback (MAIN-world + session).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { audioTrackInfo, restoreAudioTrack, switchAudioTrack } from '../../src/content/main-hook';
import { DubSession } from '../../src/content/session';
import type { DubSessionDeps } from '../../src/content/session';
import type { PlayEnd, PlayHandle, Prepared, TtsEngine } from '../../src/content/voice/engine';
import type { EngineId, Line, VoiceInfo } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { installChromeMock } from './helpers/chrome-mock';

/** Minified-shape tracks like the real player ({xyz: {id:'fr.4', name:'French'}}). */
const T = (id: string, name: string) => ({ Qc: { id, name, isDefault: false }, captionTrack: null });
const EN = T('en.4', 'English original');
const FR = T('fr.3', 'French');
const ES = T('es-419.3', 'Spanish (dubbed-auto)');

function installPlayer(tracks: unknown[], opts: { cur?: unknown; throws?: boolean; videoId?: string } = {}) {
  document.getElementById('movie_player')?.remove();
  let cur = opts.cur ?? tracks[0];
  const p = document.createElement('div') as any;
  p.id = 'movie_player';
  p.getPlayerResponse = () => ({ videoDetails: { videoId: opts.videoId ?? 'vid' } });
  p.getAvailableAudioTracks = () => tracks;
  p.getAudioTrack = () => cur;
  p.setAudioTrack = vi.fn((t: unknown) => { if (opts.throws) throw new Error('nope'); cur = t; return true; });
  document.body.appendChild(p);
  return { p, current: () => cur };
}

afterEach(() => document.getElementById('movie_player')?.remove());

describe('MAIN world audio track switch', () => {
  it('reads language from minified track objects', () => {
    expect(audioTrackInfo(FR)).toEqual({ lang: 'fr', name: 'French' });
    expect(audioTrackInfo(ES).lang).toBe('es');
    expect(audioTrackInfo(null).lang).toBeNull();
  });

  it('switches to French and restores the original on Dub off', () => {
    const { p, current } = installPlayer([EN, FR, ES]);
    expect(switchAudioTrack('vid', 'fr')).toMatchObject({ switched: true, name: 'French', autoDubbed: false });
    expect(current()).toBe(FR);
    expect(restoreAudioTrack('vid')).toBe(true);
    expect(current()).toBe(EN);
    expect(p.setAudioTrack).toHaveBeenCalledTimes(2);
    expect(restoreAudioTrack('vid')).toBe(false); // once
  });

  it('auto-dubbed track detected; already on the target → no switch needed', () => {
    installPlayer([EN, ES]);
    expect(switchAudioTrack('vid', 'es')).toMatchObject({ switched: true, autoDubbed: true });
    installPlayer([EN, FR], { cur: FR });
    expect(switchAudioTrack('vid', 'fr')).toMatchObject({ switched: true, already: true });
  });

  it('fallbacks: no target track, single track, API missing, setAudioTrack throws, other video', () => {
    installPlayer([EN, ES]);
    expect(switchAudioTrack('vid', 'fr').switched).toBe(false);
    installPlayer([EN]);
    expect(switchAudioTrack('vid', 'fr').switched).toBe(false);
    installPlayer([EN, FR], { throws: true });
    expect(switchAudioTrack('vid', 'fr')).toMatchObject({ switched: false, reason: 'error' });
    installPlayer([EN, FR], { videoId: 'other' });
    expect(switchAudioTrack('vid', 'fr')).toMatchObject({ switched: false, reason: 'video' });
    document.getElementById('movie_player')!.remove();
    const d = document.createElement('div'); d.id = 'movie_player'; document.body.appendChild(d);
    expect(switchAudioTrack('vid', 'fr')).toMatchObject({ switched: false, reason: 'api' });
  });
});

// ---------------- session wiring

class FakeVideo extends EventTarget { currentTime = 0; paused = false; seeking = false; playbackRate = 1; volume = 0.8; }
class FakeEngine implements TtsEngine {
  played: Prepared[] = [];
  constructor(public id: EngineId) {}
  async prepare(line: Line, lang: 'fr', voice?: string): Promise<Prepared> { return { line, lang, engine: this.id, voice }; }
  play(p: Prepared): PlayHandle { this.played.push(p); return { done: new Promise<PlayEnd>(() => {}), stop() {}, pause() {}, resume() {} }; }
  stopAll = vi.fn();
}
const voice: VoiceInfo = { id: 'Amelie', name: 'Amélie', lang: 'fr-FR', engine: 'webspeech', gender: 'female', quality: 3 };

function session(over: Partial<DubSessionDeps>, settings = {}) {
  const engines: FakeEngine[] = [];
  const getLines = vi.fn(async () => [{ id: 'a', start: 0.2, end: 2, text: 'Bonjour.' }] as Line[]);
  const deps: Partial<DubSessionDeps> = {
    getLines,
    createEngine: (id) => { const e = new FakeEngine(id); engines.push(e); return e; },
    listVoices: async () => [voice], pickBestVoice: async () => voice, pickVoiceFor: async () => voice,
    resetVoiceChoices: vi.fn(), warmUpTranslator: vi.fn(), warmUpNano: vi.fn(),
    now: () => 0, saveStat: vi.fn(), loadVoiceCal: async () => ({}), saveVoiceCal: vi.fn(),
    restoreOfficialAudio: vi.fn(),
    ...over,
  };
  const s = new DubSession({ videoId: 'vid', settings: { ...DEFAULT_SETTINGS, matchSpeakerGender: false, ...settings }, video: new FakeVideo() as unknown as HTMLVideoElement, player: document.createElement('div'), deps });
  return { s, deps, getLines, engines };
}

describe('DubSession + official audio', () => {
  beforeEach(() => { installChromeMock(); });

  it('track switched → status dubbing with message, no TTS / no captions; restore on stop', async () => {
    const { s, deps, getLines, engines } = session({ switchOfficialAudio: vi.fn(async () => ({ switched: true, name: 'French' })) });
    await s.start();
    expect(s.getStatus()).toMatchObject({ state: 'dubbing', message: "Using YouTube's official French audio", usingOfficialAudio: true, officialTrackLang: 'fr' });
    expect(getLines).not.toHaveBeenCalled();
    expect(engines).toHaveLength(0);
    expect(deps.warmUpNano).toHaveBeenCalled(); // warm-ups still inside the click
    s.stop();
    expect(deps.restoreOfficialAudio).toHaveBeenCalledWith('vid');
    expect(s.getStatus().state).toBe('idle');
  });

  it('already on the French track → nothing to restore', async () => {
    const { s, deps } = session({ switchOfficialAudio: vi.fn(async () => ({ switched: true, already: true })) });
    await s.start();
    s.stop();
    expect(deps.restoreOfficialAudio).not.toHaveBeenCalled();
  });

  it('switch fails / throws / setting off → normal TTS dubbing', async () => {
    for (const sw of [vi.fn(async () => ({ switched: false, reason: 'none' })), vi.fn(async () => null), vi.fn(async () => { throw new Error('x'); })]) {
      const { s, getLines } = session({ switchOfficialAudio: sw });
      await s.start();
      expect(getLines).toHaveBeenCalled();
      expect(s.getStatus()).toMatchObject({ state: 'dubbing' });
      expect(s.getStatus().usingOfficialAudio).toBeUndefined();
      s.stop();
    }
    const sw = vi.fn(async () => ({ switched: true }));
    const { s, getLines } = session({ switchOfficialAudio: sw }, { preferOfficialAudio: false });
    await s.start();
    expect(sw).not.toHaveBeenCalled();
    expect(getLines).toHaveBeenCalled();
    s.stop();
  });

  it('getLines gets smartFrench + isAlive', async () => {
    const { s, getLines } = session({ switchOfficialAudio: vi.fn(async () => null) });
    await s.start();
    const opts = (getLines.mock.calls[0] as unknown[])[3] as { smartFrench: boolean; isAlive: () => boolean };
    expect(opts.smartFrench).toBe(true);
    expect(opts.isAlive()).toBe(true);
    s.stop();
    expect(opts.isAlive()).toBe(false);
  });
});
