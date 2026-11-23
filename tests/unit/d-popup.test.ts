// D: popup renders every state (mock backend) and round-trips settings + keys through chrome.storage (real backend).
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import { initPopup, MOCK_STATES, pickBanner, statusLine, missingGender, voiceLabel, errorBanner } from '../../src/popup/popup';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { VoiceInfo } from '../../src/shared/types';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 20) { for (let i = 0; i < 5; i++) await sleep(ms / 5); }

function freshRoot(): HTMLElement {
  document.body.innerHTML = '<main id="app"></main>';
  document.documentElement.removeAttribute('data-theme');
  return document.getElementById('app')!;
}

const VOICES: VoiceInfo[] = [
  { id: 'v-am', name: 'Amélie', lang: 'fr-CA', engine: 'webspeech', gender: 'female', quality: 3 },
  { id: 'v-th', name: 'Thomas', lang: 'fr-FR', engine: 'webspeech', gender: 'male', quality: 2 },
];

describe('popup mock states render', () => {
  beforeEach(() => { installChromeMock(); });

  for (const state of MOCK_STATES) {
    it(`renders ${state}`, async () => {
      const root = freshRoot();
      await initPopup(root, { mock: state });
      await settle();
      expect(root.dataset.ready).toBe('true');
      expect(root.querySelector('h1')?.textContent).toBe('AutoDub');
      expect(root.querySelectorAll('[data-lang]').length).toBe(5);
      expect(root.querySelector('.footer')?.textContent).toContain('Keys stay on this device');
      const banner = root.querySelector('[data-banner]');
      const statusText = root.querySelector('[data-el="status-text"]')?.textContent ?? '';
      switch (state) {
        case 'idle': expect(statusText).toBe('Idle'); expect(banner).toBeNull(); break;
        case 'preparing':
          expect(statusText).toBe('Preparing…');
          expect(banner?.textContent).toContain('Downloading French translator');
          expect(root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
          break;
        case 'dubbing': expect(statusText).toBe('Dubbing into Arabic'); expect(root.querySelector<HTMLInputElement>('[data-el="power"]')!.checked).toBe(true); break;
        case 'paused-ad':
          expect(statusText).toBe('Paused for ad');
          expect(root.querySelector('[data-gender-notice]')?.textContent).toContain('Only female Turkish voices');
          expect(root.querySelector('[data-gender-notice]')?.textContent).toContain('Manage voices');
          break;
        case 'error': expect(banner?.getAttribute('data-tone')).toBe('error'); expect(root.querySelector('[data-action="open-engine"]')).not.toBeNull(); break;
        case 'not-youtube':
          expect(banner?.textContent).toContain('Open a YouTube video to dub it');
          expect(root.querySelector<HTMLInputElement>('[data-el="power"]')!.disabled).toBe(true);
          break;
        case 'engine-open':
          expect(root.querySelector<HTMLDetailsElement>('[data-el="engine"]')!.open).toBe(true);
          expect(root.querySelector('[data-key-saved]')?.textContent).toContain('3fQa');
          expect(root.textContent).toContain('Use a dedicated key you can revoke');
          break;
        case 'dark': expect(document.documentElement.dataset.theme).toBe('dark'); break;
        case 'loading': expect(root.querySelector('[data-skeleton]')).not.toBeNull(); expect(statusText).toContain('Checking'); break;
        case 'empty': expect(root.querySelector('[data-empty]')?.textContent).toContain('No Arabic voice'); break;
        case 'official': expect(banner?.textContent).toContain('official French track'); break;
        case 'reload': expect(root.querySelector('[data-action="reload"]')).not.toBeNull(); break;
      }
    });
  }

  it('labels voices Male/Female and Arabic native name is RTL', async () => {
    const root = freshRoot();
    await initPopup(root, { mock: 'dubbing' });
    await settle();
    const opts = [...root.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts[0]).toContain('Male');
    expect(opts[1]).toContain('Female');
    expect(root.querySelector('[data-lang="ar"] .lang-name')?.getAttribute('dir')).toBe('rtl');
  });
});

describe('popup with real backend (chrome mock)', () => {
  function setup(initial: Record<string, unknown> = {}) {
    const c = installChromeMock(initial);
    c.tabs.query.mockResolvedValue([{ id: 7, url: 'https://www.youtube.com/watch?v=abc' }]);
    c.tabs.sendMessage.mockImplementation(async (_id: number, msg: any) => {
      if (msg.type === 'GET_STATUS') return { ok: true, status: { state: 'idle', videoId: 'abc' } };
      if (msg.type === 'LIST_VOICES') return { ok: true, voices: VOICES };
      if (msg.type === 'DUB_TOGGLE') return { ok: true, status: { state: 'preparing', videoId: 'abc' } };
      if (msg.type === 'TEST_VOICE') return { ok: true };
      return undefined;
    });
    return c;
  }

  it('round-trips settings through storage', async () => {
    const c = setup();
    const root = freshRoot();
    await initPopup(root, { mock: null });
    await settle();
    expect(root.dataset.context).toBe('youtube');

    root.querySelector<HTMLElement>('[data-lang="es"]')!.click();
    const duck = root.querySelector<HTMLInputElement>('[data-el="duck"]')!;
    duck.value = '40';
    duck.dispatchEvent(new Event('input', { bubbles: true }));
    const subs = root.querySelector<HTMLInputElement>('[data-el="subs"]')!;
    subs.checked = true;
    subs.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    const sel = root.querySelector<HTMLSelectElement>('[data-el="voice-select"]')!;
    sel.value = 'v-th';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const saved = (c._data as any).settings;
    expect(saved.targetLang).toBe('es');
    expect(saved.duckLevel).toBeCloseTo(0.4);
    expect(saved.showSubtitles).toBe(true);
    expect(saved.voiceByLang.es).toBe('v-th');

    // Re-open: the new popup shows the saved values.
    const root2 = freshRoot();
    await initPopup(root2, { mock: null });
    await settle();
    expect(root2.querySelector('[data-lang="es"]')!.getAttribute('aria-checked')).toBe('true');
    expect(root2.querySelector<HTMLInputElement>('[data-el="duck"]')!.value).toBe('40');
    expect(root2.querySelector('[data-el="duck-val"]')!.textContent).toBe('40%');
    expect(root2.querySelector<HTMLSelectElement>('[data-el="voice-select"]')!.value).toBe('v-th');
  });

  it('toggle sends DUB_TOGGLE and shows Preparing', async () => {
    const c = setup();
    const root = freshRoot();
    await initPopup(root, { mock: null });
    await settle();
    const power = root.querySelector<HTMLInputElement>('[data-el="power"]')!;
    expect(power.disabled).toBe(false);
    power.checked = true;
    power.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(c.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'DUB_TOGGLE', on: true });
    expect(root.querySelector('[data-el="status-text"]')!.textContent).toBe('Preparing…');
  });

  it('STATUS messages update the header', async () => {
    const c = setup();
    const root = freshRoot();
    await initPopup(root, { mock: null });
    await settle();
    c.runtime.onMessage._fire({ type: 'STATUS', status: { state: 'dubbing' } }, { tab: { id: 7 } });
    expect(root.querySelector('[data-el="status-text"]')!.textContent).toBe('Dubbing into French');
  });

  it('API engine requests host permission, saves key masked, removes on return to free', async () => {
    const c = setup();
    const root = freshRoot();
    await initPopup(root, { mock: null });
    await settle();
    const radio = root.querySelector<HTMLInputElement>('input[name="engine"][value="elevenlabs"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(c.permissions.request).toHaveBeenCalledWith({ origins: ['https://api.elevenlabs.io/*'] });
    expect((c._data as any).settings.engine).toBe('elevenlabs');

    const key = 'el_' + 'x'.repeat(30) + 'WXYZ';
    root.querySelector<HTMLInputElement>('[data-el="key-input"]')!.value = key;
    root.querySelector<HTMLElement>('[data-el="key-save"]')!.click();
    await settle();
    expect((c._data as any).secrets.elevenKey).toBe(key);
    expect(root.innerHTML).not.toContain(key);
    expect(root.querySelector('[data-key-saved]')!.textContent).toContain('WXYZ');

    const free = root.querySelector<HTMLInputElement>('input[name="engine"][value="webspeech"]')!;
    free.checked = true;
    free.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(c.permissions.remove).toHaveBeenCalledWith({ origins: ['https://api.elevenlabs.io/*'] });
    expect((c._data as any).settings.engine).toBe('webspeech');
  });

  it('denied permission keeps the old engine', async () => {
    const c = setup();
    c.permissions.request.mockResolvedValue(false);
    const root = freshRoot();
    await initPopup(root, { mock: null });
    await settle();
    const radio = root.querySelector<HTMLInputElement>('input[name="engine"][value="openai"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect((c._data as any).settings?.engine ?? 'webspeech').toBe('webspeech');
    expect(root.textContent).toContain('was not given');
  });

  it('no content script on a non-YouTube tab → not-youtube state', async () => {
    const c = installChromeMock();
    c.tabs.query.mockResolvedValue([{ id: 3, url: 'https://example.com/' }]);
    const root = freshRoot();
    await initPopup(root, { mock: null });
    await sleep(1700);
    expect(root.dataset.context).toBe('not-youtube');
    expect(root.textContent).toContain('Open a YouTube video to dub it');
  }, 5000);
});

describe('popup pure helpers', () => {
  it('statusLine / banners / gender notice', () => {
    expect(statusLine({ state: 'paused-ad' }, 'youtube', 'fr').text).toBe('Paused for ad');
    expect(pickBanner({ state: 'idle' }, 'youtube', { ...DEFAULT_SETTINGS, engine: 'openai' }, {})?.title).toContain('OpenAI key');
    expect(pickBanner({ state: 'idle' }, 'youtube', { ...DEFAULT_SETTINGS }, {})).toBeNull();
    expect(errorBanner('NO_CAPTIONS', 'fr').title).toContain('no subtitles');
    expect(missingGender([VOICES[0]])).toBe('male');
    expect(missingGender(VOICES)).toBeNull();
    expect(voiceLabel(VOICES[1], false)).toBe('Thomas · Male');
    expect(voiceLabel({ ...VOICES[0], name: 'Amélie (Enhanced)' }, true)).toBe('Amélie HD · Female');
  });
});
