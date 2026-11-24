// Service worker: message router + Alt+D command (DESIGN_SPEC §2, §8). Owner: A (written by Wave 0).
// Stateless proxy for keyed network calls (TRANSLATE, TTS) and the IndexedDB cache.
// Never logs keys; any key text is redacted from error messages before they leave the SW.
import { isSWMsg, toMsgError, sendToTab, type MsgError, type MsgOf, type MsgResponse, type MsgResultMap, type SWMsg } from '../shared/messages';
import { getSecrets, loadSettings } from '../shared/settings';
import { DubError, type Secrets, type TtsResult } from '../shared/types';
import { translateBatch } from './translate';
import { synthesize } from './tts';
import { cacheGet, cachePut } from './cache';
import { onNeuralStatus, onNeuralTts, onOffscreenEvent } from './neural';
import { isOffscreenEventMsg } from '../offscreen/protocol';
import { onOfflineTranslate } from './offline';

/** Per-request network budget (§2): abort after 20 s → content falls back. */
export const SW_TIMEOUT_MS = 20_000;
/** Max lines per OpenAI translation call (§3.5). */
export const TRANSLATE_BATCH = 40;

type Res<T extends keyof MsgResultMap> = MsgResponse<MsgResultMap[T]>;

function redact(err: MsgError, secrets: Secrets): MsgError {
  if (!err.message) return err;
  let m = err.message;
  for (const k of [secrets.openaiKey, secrets.elevenKey]) if (k) m = m.split(k).join('[key]');
  return { ...err, message: m };
}

async function withAbort<T>(fn: (signal: AbortSignal) => Promise<T>, ms = SW_TIMEOUT_MS): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new DubError('TIMEOUT', `No answer in ${ms / 1000} s`));
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function onTranslate(msg: MsgOf<'TRANSLATE'>): Promise<Res<'TRANSLATE'>> {
  const secrets = await getSecrets();
  try {
    if (!secrets.openaiKey) throw new DubError('NO_KEY', 'Add an OpenAI key to translate this video.');
    const key = secrets.openaiKey;
    const { translateModel } = await loadSettings();
    const out: string[] = [];
    for (let i = 0; i < msg.texts.length; i += TRANSLATE_BATCH) {
      const chunk = msg.texts.slice(i, i + TRANSLATE_BATCH);
      const got = await withAbort((signal) => translateBatch(chunk, msg.from, msg.to, key, translateModel, signal));
      if (got.length !== chunk.length) throw new DubError('NO_TRANSLATION', 'Translation returned a different line count.');
      out.push(...got);
    }
    return { ok: true, texts: out };
  } catch (e) {
    return redact(toMsgError(e), secrets);
  }
}

async function onTts(msg: MsgOf<'TTS'>): Promise<Res<'TTS'>> {
  const secrets = await getSecrets();
  try {
    const { type: _type, ...req } = msg;
    const key = 'tts:' + (await sha256(JSON.stringify([req.engine, req.voice, req.lang, req.speed ?? 1, req.text])));
    const hit = await cacheGet<TtsResult>('audio', key).catch(() => undefined);
    if (hit?.audioB64) return { ok: true, ...hit };
    const res = await withAbort((signal) => synthesize(req, secrets, signal));
    await cachePut('audio', key, res).catch(() => {});
    return { ok: true, ...res };
  } catch (e) {
    return redact(toMsgError(e, 'ENGINE_ERROR'), secrets);
  }
}

async function onCacheGet(msg: MsgOf<'CACHE_GET'>): Promise<Res<'CACHE_GET'>> {
  if (msg.store !== 'lines') return { ok: false, error: 'NETWORK', message: 'Unknown store' };
  const value = await cacheGet<unknown>('lines', msg.key);
  return value === undefined ? { ok: true } : { ok: true, value };
}

async function onCachePut(msg: MsgOf<'CACHE_PUT'>): Promise<Res<'CACHE_PUT'>> {
  if (msg.store !== 'lines') return { ok: false, error: 'NETWORK', message: 'Unknown store' };
  await cachePut('lines', msg.key, msg.value);
  return { ok: true };
}

/** Dispatch one SW message. Exported for unit tests. Never rejects. */
export async function handleMessage(msg: SWMsg): Promise<MsgResponse<object>> {
  try {
    switch (msg.type) {
      case 'TRANSLATE': return await onTranslate(msg);
      case 'TTS': return await onTts(msg);
      case 'CACHE_GET': return await onCacheGet(msg);
      case 'CACHE_PUT': return await onCachePut(msg);
      case 'NEURAL_TTS': return await onNeuralTts(msg);
      case 'NEURAL_STATUS': return await onNeuralStatus(msg);
      case 'OFFLINE_TRANSLATE': return await onOfflineTranslate(msg);
    }
  } catch (e) {
    return toMsgError(e);
  }
}

/** Alt+D: toggle dubbing in the active tab (ignored if it has no AutoDub content script). */
export async function onCommand(command: string): Promise<void> {
  if (command !== 'toggle-dub') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  await sendToTab(tab.id, { type: 'DUB_TOGGLE' });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (sender.id === chrome.runtime.id && isOffscreenEventMsg(msg)) { onOffscreenEvent(msg); return false; }
    if (sender.id !== chrome.runtime.id || !isSWMsg(msg)) return false; // STATUS etc. are not for us
    handleMessage(msg).then(sendResponse);
    return true; // async response
  });
  // v1.2.2: Tom (choppy) → Pierre. On update, forget an auto-saved Tom choice once so the new default applies.
  chrome.runtime.onInstalled?.addListener((d) => {
    if (d.reason !== 'update') return;
    void (async () => {
      try {
        const got = await chrome.storage.local.get(['settings', 'migratedV122']);
        if (got.migratedV122) return;
        const st = (got.settings ?? {}) as { voiceByLang?: Record<string, string> };
        if (st.voiceByLang?.fr === 'fr_FR-tom-medium') {
          const { fr: _tom, ...rest } = st.voiceByLang;
          await chrome.storage.local.set({ settings: { ...st, voiceByLang: rest } });
        }
        await chrome.storage.local.set({ migratedV122: true });
      } catch { /* ignore */ }
    })();
  });
  chrome.commands?.onCommand.addListener((command) => {
    onCommand(command).catch(() => {});
  });
}
