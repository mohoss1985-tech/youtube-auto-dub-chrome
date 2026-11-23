// In-player UI in Shadow DOM: Dub button, "AI dub" badge, thumbs, subtitles, toasts (§6). Owner: D.
//
// Usage (DubSession / content index, owner C):
//   const ui = mountPlayerUI({ onToggle: () => session.toggle(), getStatus: () => session.getStatus(),
//                              onFeedback: (fb) => {/* optional: fb already saved */} });
//   session.onStatus((s) => ui.setStatus(s));
//   scheduler: ui.showLine(line, { lang, rate, overflowMs }) when a line starts, ui.showLine(null) when it ends.
//   engine fallback: ui.toast('OpenAI failed, using the browser voice', 'warn');   leaving the page: ui.destroy().
import type { DubStatus, Feedback, Lang, Line, Settings } from '../../shared/types';
import { DEFAULT_SETTINGS, LANG_INFO, STORAGE_KEYS, loadSettings, onSettingsChanged, saveSettings } from '../../shared/settings';
import { saveFeedback } from '../../shared/feedback';

/** What the UI needs from the session. Every member is optional except getStatus. */
export interface PlayerUIApi {
  getStatus(): DubStatus;
  /** Dub button clicked: toggle dubbing. */
  onToggle?(): unknown;
  /** Called after a thumbs vote was saved with saveFeedback (ring 500). */
  onFeedback?(fb: Feedback, line: Line): void;
  // ---- Wave 0 stub names, still accepted ----
  toggle?(on?: boolean): Promise<DubStatus>;
  onStatus?(cb: (s: DubStatus) => void): () => void;
  currentLine?(): Line | null;
  getSettings?(): Settings;
  setSettings?(patch: Partial<Settings>): Promise<void>;
  /** If given, the session saves the vote itself (UI does not call saveFeedback). */
  onThumb?(line: Line, up: boolean): void;
}

/** Extra timing info for the current line, stored with a thumbs vote. */
export interface LineMeta { lang?: Lang; rate?: number; overflowMs?: number }

export type ToastKind = 'info' | 'warn' | 'error';

export interface PlayerUI {
  /** Update button / badge for a new status. Auto-toasts on entering paused-ad and error. */
  setStatus(status: DubStatus): void;
  /** Current spoken line (null = between lines). Drives thumbs + subtitle overlay. */
  showLine(line: Line | null, meta?: LineMeta): void;
  toast(message: string, kind?: ToastKind): void;
  destroy(): void;
  // ---- aliases kept from the Wave 0 stub ----
  update(status: DubStatus): void;
  showToast(message: string, kind?: ToastKind): void;
  showSubtitle(text: string | null, lang?: Lang): void;
}

const SVG = (body: string, cls = 'i') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const I = {
  wave: SVG('<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>'),
  up: SVG('<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>'),
  down: SVG('<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>'),
  x: SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  check: SVG('<path d="M20 6 9 17l-5-5"/>'),
  alert: SVG('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
};

const BTN_CSS = `
:host { all: initial; display: inline-flex; align-items: center; height: 100%; vertical-align: top; padding: 0 6px; position: relative; }
* { box-sizing: border-box; }
button.dub {
  all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px 0 10px; border-radius: 16px;
  font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #fff;
  background: rgba(255,255,255,0.12); border: 2px solid rgba(255,255,255,0.85);
  transition: background .15s, border-color .15s, transform .1s;
}
button.dub:hover { background: rgba(255,255,255,0.22); }
button.dub:active { transform: scale(0.96); }
button.dub:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.i { width: 18px; height: 18px; display: block; flex: none; }
.spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; animation: spin .8s linear infinite; display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
:host([data-state="preparing"]) button.dub { background: #3d5afe; border-color: #3d5afe; }
:host([data-state="preparing"]) .spin { display: block; }
:host([data-state="preparing"]) .wave { display: none; }
:host([data-state="dubbing"]) button.dub, :host([data-state="paused-ad"]) button.dub { background: #3d5afe; border-color: #3d5afe; }
:host([data-state="dubbing"]) button.dub:hover { background: #2f49e0; border-color: #2f49e0; }
:host([data-state="paused-ad"]) button.dub { opacity: .7; }
:host([data-state="error"]) button.dub { border-color: #f2706b; }
.tip {
  position: absolute; bottom: calc(100% + 12px); right: 0; width: 240px; padding: 12px 16px;
  background: #fff; color: #111418; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
  font: 400 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; white-space: normal; z-index: 100;
}
.tip::after { content: ""; position: absolute; top: 100%; right: 28px; border: 8px solid transparent; border-top-color: #fff; }
.tip b { font-weight: 600; display: block; margin-bottom: 4px; font-size: 16px; }
.tip button { all: unset; cursor: pointer; margin-top: 8px; color: #3d5afe; font-weight: 600; font-size: 14px; }
.tip button:focus-visible { outline: 2px solid #3d5afe; outline-offset: 2px; border-radius: 4px; }
`;

const OVERLAY_CSS = `
:host { all: initial; position: absolute; inset: 0; pointer-events: none; z-index: 60; }
* { box-sizing: border-box; }
.wrap { position: absolute; inset: 0; container-type: size; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Arabic", sans-serif; }
.i { width: 16px; height: 16px; display: block; flex: none; }
.badge {
  position: absolute; top: 12px; left: 12px; display: none; align-items: center; gap: 4px;
  height: 32px; padding: 0 4px 0 12px; border-radius: 16px; background: rgba(17,20,24,.78); color: #fff;
  font: 600 12px/1 inherit; pointer-events: auto; transition: opacity .2s;
}
.badge[data-show="true"] { display: inline-flex; }
.badge .label { display: inline-flex; align-items: center; gap: 6px; margin-right: 4px; }
.badge .label .i { width: 14px; height: 14px; color: #8c9eff; }
.sep { width: 1px; height: 16px; background: rgba(255,255,255,.25); margin: 0 2px; }
.ib {
  all: unset; box-sizing: border-box; cursor: pointer; width: 28px; height: 28px; border-radius: 14px;
  display: inline-grid; place-items: center; color: rgba(255,255,255,.85);
}
.ib:hover { background: rgba(255,255,255,.16); color: #fff; }
.ib:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.ib:disabled { opacity: .35; cursor: default; background: none; }
.ib[aria-pressed="true"] { color: #8c9eff; }
.ib .i { width: 16px; height: 16px; }
.thanks { font-size: 12px; color: #8c9eff; padding: 0 6px; display: none; }
.badge[data-thanks="true"] .thanks { display: inline; }
.badge[data-thanks="true"] .thumbs { display: none; }
.thumbs { display: inline-flex; gap: 0; }
.sub {
  position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%); max-width: 80%;
  display: none; flex-direction: column; align-items: center; gap: 4px; text-align: center;
}
.sub[data-show="true"] { display: flex; }
:host([data-autohide="true"]) .sub { bottom: 24px; }
.sub .t {
  background: rgba(8,8,8,.75); color: #fff; padding: 4px 12px; border-radius: 8px;
  font: 600 20px/1.4 inherit; white-space: pre-wrap;
}
.sub .s { background: rgba(8,8,8,.6); color: rgba(255,255,255,.8); padding: 2px 8px; border-radius: 6px; font: 400 14px/1.4 inherit; }
.sub .s:empty { display: none; }
.sub[dir="rtl"] .t { direction: rtl; }
.toasts { position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; }
.sub[data-show="true"] ~ .toasts { bottom: 140px; }
.toast {
  display: flex; align-items: center; gap: 8px; max-width: min(480px, 80cqw); padding: 8px 16px; border-radius: 12px;
  background: rgba(17,20,24,.9); color: #fff; font: 400 14px/20px inherit; pointer-events: auto;
  animation: in .18s ease-out; border-left: 4px solid #8c9eff;
}
.toast[data-kind="warn"] { border-left-color: #f0a443; }
.toast[data-kind="error"] { border-left-color: #f2706b; }
.toast .i { width: 16px; height: 16px; }
@keyframes in { from { opacity: 0; transform: translateY(8px); } }
@container (min-width: 1200px) {
  .badge { top: 24px; left: 24px; height: 40px; font-size: 14px; border-radius: 20px; }
  .ib { width: 36px; height: 36px; border-radius: 18px; }
  .ib .i { width: 20px; height: 20px; }
  .sub .t { font-size: 28px; }
  .sub .s { font-size: 18px; }
  .sub, .toasts { bottom: 110px; }
  .toast { font-size: 16px; }
}
`;

const ERR_TEXT: Record<string, string> = {
  NO_CAPTIONS: 'This video has no subtitles, so it can’t be dubbed.',
  NO_TRANSLATION: 'Couldn’t translate this video. Open AutoDub to add a key.',
  RATE_LIMITED: 'YouTube is busy. Try again in a minute.',
  ENGINE_ERROR: 'Voice service failed. Using the browser voice.',
  NO_VOICE: 'No voice installed for this language. Open AutoDub for help.',
};

function videoIdFromUrl(): string {
  try { return new URL(location.href).searchParams.get('v') ?? ''; } catch { return ''; }
}

/** Mount the Dub button into .ytp-right-controls (before CC) and overlays into the player. */
export function mountPlayerUI(api: PlayerUIApi, player?: HTMLElement | null): PlayerUI {
  const findPlayer = () => player ?? document.querySelector<HTMLElement>('#movie_player');

  // ---- Dub button
  const btnHost = document.createElement('span');
  btnHost.className = 'autodub-btn-host';
  const btnRoot = btnHost.attachShadow({ mode: 'open' });
  btnRoot.innerHTML = `<style>${BTN_CSS}</style>
    <button class="dub" type="button" aria-pressed="false" aria-label="Dub this video (Alt+D)" title="AI dub (Alt+D)">
      <span class="wave">${I.wave}</span><span class="spin"></span><span class="txt">Dub</span>
    </button>`;
  const dubBtn = btnRoot.querySelector<HTMLButtonElement>('button.dub')!;

  // ---- Overlay (badge, thumbs, subtitles, toasts)
  const ovHost = document.createElement('div');
  ovHost.className = 'autodub-overlay-host';
  const ovRoot = ovHost.attachShadow({ mode: 'open' });
  ovRoot.innerHTML = `<style>${OVERLAY_CSS}</style><div class="wrap">
    <div class="badge" role="group" aria-label="AI dub">
      <span class="label" title="This voice is AI-generated">${I.wave}AI dub</span>
      <span class="sep"></span>
      <span class="thumbs">
        <button class="ib" type="button" data-up="1" aria-label="This line sounds good" title="Sounds good">${I.up}</button>
        <button class="ib" type="button" data-up="0" aria-label="This line sounds wrong" title="Sounds wrong">${I.down}</button>
      </span>
      <span class="thanks">${I.check}</span>
      <span class="sep"></span>
      <button class="ib" type="button" data-close aria-label="Hide AI dub badge" title="Hide badge">${I.x}</button>
    </div>
    <div class="sub" aria-live="polite"><span class="t"></span><span class="s"></span></div>
    <div class="toasts" role="status" aria-live="polite"></div>
  </div>`;
  const badge = ovRoot.querySelector<HTMLElement>('.badge')!;
  const sub = ovRoot.querySelector<HTMLElement>('.sub')!;
  const subT = sub.querySelector<HTMLElement>('.t')!;
  const subS = sub.querySelector<HTMLElement>('.s')!;
  const toasts = ovRoot.querySelector<HTMLElement>('.toasts')!;
  const thumbBtns = [...ovRoot.querySelectorAll<HTMLButtonElement>('[data-up]')];

  // ---- state
  let status: DubStatus = safeStatus();
  let settings: Settings = api.getSettings?.() ?? { ...DEFAULT_SETTINGS };
  let line: Line | null = null;
  let meta: LineMeta = {};
  let destroyed = false;
  let tip: HTMLElement | null = null;
  let thanksTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanups: (() => void)[] = [];

  function safeCurrentLine(): Line | null {
    try { return api.currentLine?.() ?? null; } catch { return null; }
  }
  function safeStatus(): DubStatus {
    try { return api.getStatus() ?? { state: 'idle' }; } catch { return { state: 'idle' }; }
  }

  // ---- placement (YouTube may rebuild the controls; re-attach when needed)
  let playerObs: MutationObserver | null = null;
  let observed: HTMLElement | null = null;
  const place = () => {
    if (destroyed) return;
    const p = findPlayer();
    if (!p) return;
    const right = p.querySelector<HTMLElement>('.ytp-right-controls');
    if (right && btnHost.parentElement !== right) {
      const cc = right.querySelector('.ytp-subtitles-button');
      right.insertBefore(btnHost, cc && cc.parentElement === right ? cc : right.firstChild);
    }
    if (ovHost.parentElement !== p) p.appendChild(ovHost);
    if (observed !== p) {
      playerObs?.disconnect();
      observed = p;
      playerObs = new MutationObserver(() => {
        ovHost.dataset.autohide = String(p.classList.contains('ytp-autohide'));
      });
      playerObs.observe(p, { attributes: true, attributeFilter: ['class'] });
    }
  };
  place();
  const placeTimer = setInterval(place, 2000);
  cleanups.push(() => clearInterval(placeTimer), () => playerObs?.disconnect());

  // ---- render
  const render = () => {
    btnHost.dataset.state = status.state;
    const on = status.state === 'dubbing' || status.state === 'preparing' || status.state === 'paused-ad';
    dubBtn.setAttribute('aria-pressed', String(on));
    const label = status.state === 'preparing' ? 'Preparing dub…'
      : status.state === 'dubbing' ? 'Stop AI dub (Alt+D)'
      : status.state === 'paused-ad' ? 'Dub paused for ad'
      : 'Dub this video (Alt+D)';
    dubBtn.setAttribute('aria-label', label);
    dubBtn.title = label;
    const showBadge = settings.showBadge && (status.state === 'dubbing' || status.state === 'paused-ad');
    badge.dataset.show = String(showBadge);
    // C's session exposes currentLine(); showLine() is the alternative push API.
    const canVote = status.state === 'dubbing' && (!!line || !!api.currentLine);
    thumbBtns.forEach((b) => { b.disabled = !canVote; });
    renderSub();
  };

  const renderSub = () => {
    const show = settings.showSubtitles && !!line && status.state === 'dubbing';
    sub.dataset.show = String(show);
    if (!show || !line) return;
    const lang = meta.lang ?? settings.targetLang;
    setSubtitle(line.text, lang, line.source);
  };

  const setSubtitle = (text: string, lang: Lang, source?: string) => {
    subT.textContent = text;
    subS.textContent = source && source !== text ? source : '';
    const rtl = LANG_INFO[lang]?.rtl ?? false;
    sub.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    subT.setAttribute('lang', LANG_INFO[lang]?.bcp47 ?? lang);
  };

  // ---- toasts
  const toast = (message: string, kind: ToastKind = 'info') => {
    if (destroyed) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.kind = kind;
    el.innerHTML = kind === 'info' ? I.wave : I.alert;
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    toasts.appendChild(el);
    while (toasts.children.length > 3) toasts.firstElementChild?.remove();
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 4000);
  };

  // ---- one-time tooltip
  const closeTip = () => {
    if (!tip) return;
    tip.remove();
    tip = null;
    void chrome.storage.local.set({ [STORAGE_KEYS.onboarded]: true }).catch(() => {});
  };
  const maybeTip = async () => {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.onboarded);
      if (got[STORAGE_KEYS.onboarded] || destroyed || tip) return;
    } catch { return; }
    const L = LANG_INFO[settings.targetLang]?.name ?? 'your language';
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'dialog');
    tip.innerHTML = `<b>New: AI dub</b><span class="tip-text"></span><br/><button type="button">Got it</button>`;
    tip.querySelector('.tip-text')!.textContent = `Press Dub to hear this video in ${L}. Press again for the original sound.`;
    tip.querySelector('button')!.addEventListener('click', (e) => { e.stopPropagation(); closeTip(); });
    btnRoot.appendChild(tip);
    const t = setTimeout(closeTip, 12000);
    cleanups.push(() => clearTimeout(t));
  };

  // ---- events
  const onBtn = (e: Event) => {
    e.stopPropagation();
    closeTip();
    if (api.onToggle) void Promise.resolve(api.onToggle()).catch(() => {});
    else if (api.toggle) void api.toggle().then((s) => ui.setStatus(s)).catch(() => {});
  };
  dubBtn.addEventListener('click', onBtn);

  ovRoot.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    e.stopPropagation(); // don't let YouTube treat it as a play/pause click
    if (t.hasAttribute('data-close')) {
      settings = { ...settings, showBadge: false };
      render();
      const p = api.setSettings ? api.setSettings({ showBadge: false }) : saveSettings({ showBadge: false });
      void Promise.resolve(p).catch(() => {});
      toast('Badge hidden. Turn it back on in AutoDub settings.');
      return;
    }
    if (t.hasAttribute('data-up')) {
      const l = line ?? safeCurrentLine();
      if (l) vote(l, t.dataset.up === '1');
      else toast('Wait for the next line, then vote.');
    }
  });
  // Clicks inside the overlay must not pause the video.
  for (const ev of ['mousedown', 'mouseup', 'dblclick'] as const) {
    ovRoot.addEventListener(ev, (e) => { if ((e.target as HTMLElement).closest('button')) e.stopPropagation(); });
  }

  const vote = (l: Line, up: boolean) => {
    thumbBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.up === (up ? '1' : '0'))));
    badge.dataset.thanks = 'true';
    if (thanksTimer) clearTimeout(thanksTimer);
    thanksTimer = setTimeout(() => { badge.dataset.thanks = 'false'; }, 1500);
    if (api.onThumb) { api.onThumb(l, up); return; }
    const fb: Feedback = {
      videoId: status.videoId ?? videoIdFromUrl(),
      lineId: l.id,
      lang: meta.lang ?? settings.targetLang,
      up,
      rate: meta.rate ?? 1,
      overflowMs: meta.overflowMs ?? 0,
      at: Date.now(),
    };
    void saveFeedback(fb).then(() => api.onFeedback?.(fb, l)).catch(() => {});
  };

  // ---- settings (content scripts may read settings; never the key store)
  if (!api.getSettings) {
    void loadSettings().then((s) => { settings = s; render(); }).catch(() => {});
  }
  try {
    cleanups.push(onSettingsChanged((s) => { settings = s; render(); }));
  } catch { /* storage unavailable */ }
  if (api.onStatus) cleanups.push(api.onStatus((s) => ui.setStatus(s)));

  const ui: PlayerUI = {
    setStatus(next) {
      const prev = status.state;
      status = next;
      if (next.state !== prev) {
        if (next.state === 'paused-ad') toast('Paused for ad. The dub comes back after it.');
        if (next.state === 'error') toast(next.message || ERR_TEXT[next.error ?? ''] || 'AutoDub stopped. Original sound is back.', 'error');
        if (next.state !== 'dubbing') { line = null; }
        thumbBtns.forEach((b) => b.removeAttribute('aria-pressed'));
      }
      render();
    },
    showLine(l, m) {
      if (l?.id !== line?.id) thumbBtns.forEach((b) => b.removeAttribute('aria-pressed'));
      line = l;
      meta = m ?? {};
      render();
    },
    toast,
    destroy() {
      destroyed = true;
      cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
      if (thanksTimer) clearTimeout(thanksTimer);
      dubBtn.removeEventListener('click', onBtn);
      btnHost.remove();
      ovHost.remove();
    },
    update(s) { ui.setStatus(s); },
    showToast(m, k) { toast(m, k); },
    showSubtitle(text, lang) {
      if (text == null) { sub.dataset.show = 'false'; return; }
      setSubtitle(text, lang ?? settings.targetLang);
      sub.dataset.show = 'true';
    },
  };

  render();
  void maybeTip();
  return ui;
}
