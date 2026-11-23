// Isolated content-script entry (document_idle): wires DubSession + player UI + runtime messages. Owner: C.
import type { DubStatus, Lang, Line, Settings } from '../shared/types';
import { DubError } from '../shared/types';
import type { Msg, MsgResponse } from '../shared/messages';
import { broadcastStatus, isMsg, isSWMsg, toMsgError } from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings } from '../shared/settings';
import { saveFeedback } from '../shared/feedback';
import { getPlayer, getVideo, getVideoId, isWatchPage } from './yt';
import { createEngine } from './voice/engine';
import { listVoices } from './voice/voices';
import { mountPlayerUI } from './ui/player-ui';
import type { PlayerUI, PlayerUIApi } from './ui/player-ui';
import { DubSession } from './session';
import { onNavigate } from './sync/player';

/** One short sentence per language for "Test voice". */
export const TEST_LINES: Readonly<Record<Lang, string>> = {
  fr: 'Bonjour ! Voici la voix qui va doubler cette vidéo.',
  ar: 'مرحبا! هذا هو الصوت الذي سيدبلج هذا الفيديو.',
  en: 'Hello! This is the voice that will dub this video.',
  es: '¡Hola! Esta es la voz que doblará este video.',
  tr: 'Merhaba! Bu videoyu seslendirecek ses bu.',
};

interface State {
  settings: Settings;
  session: DubSession | null;
  sessionOff: (() => void) | null;
  ui: PlayerUI | null;
  uiListeners: Set<(s: DubStatus) => void>;
  videoId: string | null;
  /** The user turned dub on in this tab: keep dubbing the next videos (playlist) until turned off. */
  wantOn: boolean;
}

const st: State = {
  settings: { ...DEFAULT_SETTINGS, voiceByLang: {} },
  session: null,
  sessionOff: null,
  ui: null,
  uiListeners: new Set(),
  videoId: null,
  wantOn: false,
};

function idleStatus(): DubStatus {
  return st.videoId ? { state: 'idle', videoId: st.videoId } : { state: 'idle' };
}

export function currentStatus(): DubStatus {
  return st.session?.getStatus() ?? idleStatus();
}

function emit(s: DubStatus): void {
  broadcastStatus(s);
  try { st.ui?.update(s); } catch { /* ignore */ }
  for (const cb of [...st.uiListeners]) try { cb(s); } catch { /* ignore */ }
}

function dropSession(): void {
  st.sessionOff?.();
  st.sessionOff = null;
  st.session?.stop();
  st.session = null;
  try { st.ui?.showSubtitle(null); } catch { /* ignore */ }
}

function ensureSession(): DubSession | null {
  const videoId = st.videoId ?? getVideoId();
  if (!videoId) return null;
  if (st.session && st.session.videoId === videoId) return st.session;
  dropSession();
  st.videoId = videoId;
  const s = new DubSession({
    videoId,
    settings: st.settings,
    video: getVideo() ?? undefined,
    player: getPlayer(),
    onToast: (m, k) => { try { st.ui?.showToast(m, k); } catch { /* ignore */ } },
    onLine: (line: Line | null) => {
      if (!st.settings.showSubtitles) return;
      try { st.ui?.showSubtitle(line ? line.text : null, st.settings.targetLang); } catch { /* ignore */ }
    },
  });
  st.session = s;
  st.sessionOff = s.onStatus(emit);
  return s;
}

/** Turn dub on/off for the current video (omit = toggle). */
export async function toggleDub(on?: boolean): Promise<DubStatus> {
  if (!isWatchPage()) return { state: 'error', error: 'NOT_WATCH_PAGE', message: 'Open a YouTube video to dub it' };
  const want = on ?? !(st.session?.isActive() ?? false);
  st.wantOn = want;
  if (!want) {
    st.session?.stop();
    return currentStatus();
  }
  const s = ensureSession();
  if (!s) return { state: 'error', error: 'NOT_WATCH_PAGE', message: 'Open a YouTube video to dub it' };
  return s.toggle(true);
}

const uiApi: PlayerUIApi = {
  getStatus: () => currentStatus(),
  onStatus: (cb) => { st.uiListeners.add(cb); return () => st.uiListeners.delete(cb); },
  toggle: (on) => toggleDub(on),
  currentLine: () => st.session?.currentLine() ?? null,
  getSettings: () => st.settings,
  setSettings: async (patch) => { st.settings = await saveSettings(patch); },
  onThumb: (line, up) => {
    const s = st.session;
    if (!s) return;
    void saveFeedback(s.feedbackFor(line, up)).catch(() => {});
  },
};

function ensureUI(): void {
  if (st.ui) return;
  try {
    st.ui = mountPlayerUI(uiApi, getPlayer());
    st.ui.update(currentStatus());
  } catch (e) {
    st.ui = null;
    console.warn('[autodub] player UI not mounted', e instanceof Error ? e.message : e);
  }
}

function destroyUI(): void {
  try { st.ui?.destroy(); } catch { /* ignore */ }
  st.ui = null;
}

/** Navigation: tear down the old session; on a new /watch page re-mount UI and (if the user had dub on) restart. */
export function handleNavigation(url: string): void {
  const watch = isWatchPage(url);
  const videoId = watch ? getVideoId(url) : null;
  if (st.session && st.session.videoId !== videoId) dropSession();
  st.videoId = videoId;
  if (!watch || !videoId) {
    destroyUI();
    emit(idleStatus());
    return;
  }
  ensureUI();
  try { st.ui?.update(currentStatus()); } catch { /* ignore */ }
  if (st.wantOn && !st.session?.isActive()) {
    // YouTube swaps the video source after navigation; give the player a moment.
    setTimeout(() => {
      if (st.videoId === videoId && st.wantOn && isWatchPage()) void toggleDub(true);
    }, 500);
  }
}

function onSettings(next: Settings, prev: Settings): void {
  st.settings = next;
  st.session?.updateSettings(next);
  if (prev.showSubtitles && !next.showSubtitles) try { st.ui?.showSubtitle(null); } catch { /* ignore */ }
  // Popup switch persisted as settings.enabled: follow it in the visible tab only.
  if (next.enabled !== prev.enabled) {
    if (!next.enabled) void toggleDub(false);
    else if (typeof document === 'undefined' || document.visibilityState === 'visible') void toggleDub(true);
  }
  try { st.ui?.update(currentStatus()); } catch { /* ignore */ }
}

async function testVoice(msg: Extract<Msg, { type: 'TEST_VOICE' }>): Promise<MsgResponse> {
  const engine = createEngine(msg.engine);
  const line: Line = { id: 'test', start: 0, end: 4, text: TEST_LINES[msg.lang] ?? TEST_LINES.en };
  const p = await engine.prepare(line, msg.lang, msg.voice || undefined);
  const h = engine.play(p, st.settings.voiceSpeed, st.settings.dubVolume);
  const r = await h.done;
  try { engine.dispose?.(); } catch { /* ignore */ }
  if (r === 'error') throw new DubError('ENGINE_ERROR', 'The voice could not play');
  return { ok: true };
}

/** Runtime message handler (exported for tests). Returns a promise of the response, or undefined if not ours. */
export function handleMessage(msg: unknown): Promise<MsgResponse<object>> | undefined {
  if (!isMsg(msg) || isSWMsg(msg)) return undefined;
  switch (msg.type) {
    case 'DUB_TOGGLE':
      return toggleDub(msg.on).then((status) =>
        status.state === 'error' && status.error === 'NOT_WATCH_PAGE'
          ? { ok: false as const, error: 'NOT_WATCH_PAGE' as const, message: status.message }
          : { ok: true as const, status });
    case 'GET_STATUS':
      return Promise.resolve({ ok: true as const, status: currentStatus() });
    case 'LIST_VOICES':
      return listVoices(msg.lang, st.settings.engine).then((voices) => ({ ok: true as const, voices }), (e) => toMsgError(e, 'NO_VOICE'));
    case 'TEST_VOICE':
      return testVoice(msg).catch((e) => toMsgError(e, 'ENGINE_ERROR'));
    default:
      return undefined;
  }
}

let booted = false;

/** Register message listener (DUB_TOGGLE, GET_STATUS, LIST_VOICES, TEST_VOICE), navigation watcher and UI. */
export function bootstrap(): void {
  if (booted) return;
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage || typeof document === 'undefined') return;
  booted = true;

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const p = handleMessage(msg);
    if (!p) return false;
    p.then(sendResponse, (e) => sendResponse(toMsgError(e)));
    return true; // async response
  });

  onSettingsChanged(onSettings);
  void loadSettings().then((s) => { st.settings = s; }, () => {});

  onNavigate(handleNavigation);
  handleNavigation(location.href);

  // Leaving the page: restore the original volume.
  window.addEventListener('pagehide', () => dropSession());
}

/** Test hook: reset module state. */
export function _resetForTests(): void {
  dropSession();
  destroyUI();
  st.settings = { ...DEFAULT_SETTINGS, voiceByLang: {} };
  st.videoId = null;
  st.wantOn = false;
  st.uiListeners.clear();
  booted = false;
}

bootstrap();
