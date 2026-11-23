// Wave 0 smoke for owner A: modules import and shared settings work.
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import * as types from '../../src/shared/types';
import * as messages from '../../src/shared/messages';
import * as settings from '../../src/shared/settings';
import * as yt from '../../src/content/yt';
import * as captions from '../../src/content/captions';
import * as pipeline from '../../src/content/pipeline';
import * as translateLocal from '../../src/content/translate-local';
import * as translate from '../../src/background/translate';

describe('A smoke', () => {
  beforeEach(() => void installChromeMock());

  it('exports the §8 names', () => {
    expect(types.DubError).toBeTypeOf('function');
    expect(messages.BRIDGE_SOURCE).toBe('autodub');
    for (const f of [messages.sendToSW, messages.sendToTab]) expect(f).toBeTypeOf('function');
    expect(settings.LANGS).toEqual(['fr', 'ar', 'en', 'es', 'tr']);
    for (const f of [yt.getPlayerResponse, yt.getVideoId, yt.isWatchPage, yt.getJson3, yt.getPlayer, yt.getVideo]) expect(f).toBeTypeOf('function');
    for (const f of [captions.pickTrack, captions.parseJson3, captions.mergeSentences, captions.listAudioTracks]) expect(f).toBeTypeOf('function');
    expect(pipeline.getLines).toBeTypeOf('function');
    expect(translateLocal.translateLocal).toBeTypeOf('function');
    expect(translate.translateBatch).toBeTypeOf('function');
  });

  it('settings round-trip with defaults and clamping', async () => {
    expect(await settings.loadSettings()).toEqual(settings.DEFAULT_SETTINGS);
    const saved = await settings.saveSettings({ targetLang: 'ar', duckLevel: 5, voiceByLang: { ar: 'Maged' } });
    expect(saved.targetLang).toBe('ar');
    expect(saved.duckLevel).toBe(1);
    expect((await settings.loadSettings()).voiceByLang).toEqual({ ar: 'Maged' });
  });

  it('secrets save/remove', async () => {
    await settings.saveSecrets({ openaiKey: ' sk-test ' });
    expect(await settings.getSecrets()).toEqual({ openaiKey: 'sk-test' });
    await settings.saveSecrets({ openaiKey: '' });
    expect(await settings.getSecrets()).toEqual({});
  });

  it('sendToSW never rejects', async () => {
    const c = installChromeMock();
    c.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'));
    const res = await messages.sendToSW({ type: 'CACHE_GET', store: 'lines', key: 'k' });
    expect(res).toMatchObject({ ok: false, error: 'NETWORK' });
  });
});
