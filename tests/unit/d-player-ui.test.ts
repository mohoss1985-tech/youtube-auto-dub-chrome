// D: in-player UI (Shadow DOM) — button placement/states, badge dismiss, thumbs → feedback, subtitles RTL, toasts.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import { mountPlayerUI } from '../../src/content/ui/player-ui';
import { getFeedback } from '../../src/shared/feedback';
import type { DubStatus } from '../../src/shared/types';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakePlayer(): HTMLElement {
  document.body.innerHTML = `<div id="movie_player" class="html5-video-player"><video></video>
    <div class="ytp-chrome-bottom"><div class="ytp-right-controls">
      <button class="ytp-button ytp-subtitles-button"></button><button class="ytp-button ytp-settings-button"></button>
    </div></div></div>`;
  return document.getElementById('movie_player')!;
}

describe('player UI', () => {
  let chromeMock: ReturnType<typeof installChromeMock>;
  beforeEach(() => { chromeMock = installChromeMock({ settings: { showSubtitles: true, targetLang: 'ar' } }); });

  it('mounts the Dub button before CC and toggles via onToggle', async () => {
    const p = fakePlayer();
    const onToggle = vi.fn();
    const ui = mountPlayerUI({ getStatus: () => ({ state: 'idle' }), onToggle });
    const right = p.querySelector('.ytp-right-controls')!;
    const host = right.firstElementChild as HTMLElement;
    expect(host.className).toBe('autodub-btn-host');
    expect(host.nextElementSibling?.classList.contains('ytp-subtitles-button')).toBe(true);
    const btn = host.shadowRoot!.querySelector<HTMLButtonElement>('button.dub')!;
    btn.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    ui.setStatus({ state: 'preparing' });
    expect(host.dataset.state).toBe('preparing');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    ui.setStatus({ state: 'dubbing' });
    expect(btn.getAttribute('aria-label')).toContain('Stop');
    ui.destroy();
    expect(p.querySelector('.autodub-btn-host')).toBeNull();
    expect(p.querySelector('.autodub-overlay-host')).toBeNull();
  });

  it('shows the one-time tooltip once', async () => {
    fakePlayer();
    const ui = mountPlayerUI({ getStatus: () => ({ state: 'idle' }) });
    await sleep(10);
    const host = document.querySelector('.autodub-btn-host') as HTMLElement;
    const tip = host.shadowRoot!.querySelector('.tip');
    expect(tip?.textContent).toContain('Press Dub');
    (tip!.querySelector('button') as HTMLButtonElement).click();
    expect(chromeMock._data.onboarded).toBe(true);
    ui.destroy();
    fakePlayer();
    const ui2 = mountPlayerUI({ getStatus: () => ({ state: 'idle' }) });
    await sleep(10);
    expect(document.querySelector('.autodub-btn-host')!.shadowRoot!.querySelector('.tip')).toBeNull();
    ui2.destroy();
  });

  it('badge shows while dubbing, dismiss saves showBadge=false', async () => {
    fakePlayer();
    let status: DubStatus = { state: 'idle', videoId: 'vid1' };
    const ui = mountPlayerUI({ getStatus: () => status });
    await sleep(10);
    const ov = document.querySelector('.autodub-overlay-host')!.shadowRoot!;
    const badge = ov.querySelector<HTMLElement>('.badge')!;
    expect(badge.dataset.show).toBe('false');
    status = { state: 'dubbing', videoId: 'vid1' };
    ui.setStatus(status);
    expect(badge.dataset.show).toBe('true');
    expect(badge.textContent).toContain('AI dub');
    ov.querySelector<HTMLButtonElement>('[data-close]')!.click();
    expect(badge.dataset.show).toBe('false');
    await sleep(10);
    expect((chromeMock._data.settings as any).showBadge).toBe(false);
    ui.destroy();
  });

  it('thumbs on the current line → saveFeedback with timing meta', async () => {
    fakePlayer();
    const onFeedback = vi.fn();
    const ui = mountPlayerUI({ getStatus: () => ({ state: 'dubbing', videoId: 'vid9' }), onFeedback });
    await sleep(10);
    ui.setStatus({ state: 'dubbing', videoId: 'vid9' });
    const ov = document.querySelector('.autodub-overlay-host')!.shadowRoot!;
    const down = ov.querySelector<HTMLButtonElement>('[data-up="0"]')!;
    expect(down.disabled).toBe(true); // no line yet
    ui.showLine({ id: 'L3', start: 1, end: 3, text: 'مرحبا بكم', source: 'Welcome' }, { lang: 'ar', rate: 1.2, overflowMs: 140 });
    expect(down.disabled).toBe(false);
    down.click();
    await sleep(10);
    const fb = await getFeedback('vid9');
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ videoId: 'vid9', lineId: 'L3', lang: 'ar', up: false, rate: 1.2, overflowMs: 140 });
    expect(onFeedback).toHaveBeenCalledTimes(1);
    ui.destroy();
  });

  it('subtitle overlay is RTL for Arabic and shows the source line', async () => {
    fakePlayer();
    const ui = mountPlayerUI({ getStatus: () => ({ state: 'dubbing' }) });
    await sleep(10);
    ui.setStatus({ state: 'dubbing' });
    ui.showLine({ id: 'a', start: 0, end: 1, text: 'مرحبا', source: 'Hello' }, { lang: 'ar' });
    const sub = document.querySelector('.autodub-overlay-host')!.shadowRoot!.querySelector<HTMLElement>('.sub')!;
    expect(sub.dataset.show).toBe('true');
    expect(sub.getAttribute('dir')).toBe('rtl');
    expect(sub.querySelector('.t')!.textContent).toBe('مرحبا');
    expect(sub.querySelector('.s')!.textContent).toBe('Hello');
    ui.showLine({ id: 'b', start: 1, end: 2, text: 'Bonjour' }, { lang: 'fr' });
    expect(sub.getAttribute('dir')).toBe('ltr');
    ui.showLine(null);
    expect(sub.dataset.show).toBe('false');
    ui.destroy();
  });

  it('toasts on ad pause and on errors (text only, no HTML injection)', async () => {
    fakePlayer();
    const ui = mountPlayerUI({ getStatus: () => ({ state: 'dubbing' }) });
    ui.setStatus({ state: 'paused-ad' });
    ui.toast('<b>x</b>', 'warn');
    ui.setStatus({ state: 'error', error: 'NO_CAPTIONS' });
    const toasts = document.querySelector('.autodub-overlay-host')!.shadowRoot!.querySelectorAll('.toast');
    expect(toasts.length).toBe(3);
    expect(toasts[0].textContent).toContain('Paused for ad');
    expect(toasts[1].querySelector('b')).toBeNull();
    expect(toasts[2].textContent).toContain('no subtitles');
    ui.destroy();
  });

  it('mounts later when the player appears', async () => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    const ui = mountPlayerUI({ getStatus: () => ({ state: 'idle' }) });
    fakePlayer();
    vi.advanceTimersByTime(2100);
    expect(document.querySelector('.ytp-right-controls .autodub-btn-host')).not.toBeNull();
    ui.destroy();
    vi.useRealTimers();
  });
});

describe('player UI with the content-index API (C)', () => {
  beforeEach(() => { installChromeMock(); });
  it('Dub click calls api.toggle synchronously; thumbs use currentLine + onThumb', async () => {
    fakePlayer();
    const toggle = vi.fn(async () => ({ state: 'preparing' as const }));
    const onThumb = vi.fn();
    const line = { id: 'L1', start: 0, end: 1, text: 'Bonjour' };
    const ui = mountPlayerUI({ getStatus: () => ({ state: 'dubbing' }), toggle, onThumb, currentLine: () => line });
    document.querySelector('.autodub-btn-host')!.shadowRoot!.querySelector<HTMLButtonElement>('button.dub')!.click();
    expect(toggle).toHaveBeenCalledTimes(1);
    ui.update({ state: 'dubbing' });
    const up = document.querySelector('.autodub-overlay-host')!.shadowRoot!.querySelector<HTMLButtonElement>('[data-up="1"]')!;
    expect(up.disabled).toBe(false);
    up.click();
    expect(onThumb).toHaveBeenCalledWith(line, true);
    ui.showSubtitle('مرحبا', 'ar');
    const sub = document.querySelector('.autodub-overlay-host')!.shadowRoot!.querySelector<HTMLElement>('.sub')!;
    expect(sub.dataset.show).toBe('true');
    expect(sub.getAttribute('dir')).toBe('rtl');
    ui.destroy();
  });
});
