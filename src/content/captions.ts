// Caption track selection, json3 parsing, sentence merging. Owner: A.
// Pure module (no DOM, no chrome.*): also bundled into the MAIN-world hook.
import type { AudioTrackInfo, CaptionTrack, Cue, Gender, Json3, Lang, Line, PlayerResponse } from '../shared/types';

// ---------------------------------------------------------------- helpers

/** 'fr-FR' → 'fr', 'zh-Hans' → 'zh'. */
export function langBase(code: string | undefined | null): string {
  return String(code ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
}

export function isAsrTrack(t: Pick<CaptionTrack, 'kind' | 'vssId'>): boolean {
  return t.kind === 'asr' || (typeof t.vssId === 'string' && t.vssId.startsWith('a.'));
}

// ---------------------------------------------------------------- track choice

/** Prefer human (kind !== 'asr') over ASR; within that prefer a track already in `target`. null if no tracks. */
export function pickTrack(tracks: CaptionTrack[], target: Lang): CaptionTrack | null {
  const list = (tracks ?? []).filter((t) => t && typeof t.baseUrl === 'string' && typeof t.languageCode === 'string');
  if (!list.length) return null;
  const human = list.filter((t) => !isAsrTrack(t));
  const asr = list.filter((t) => isAsrTrack(t));
  const inTarget = (ts: CaptionTrack[]) => ts.find((t) => langBase(t.languageCode) === target);
  return inTarget(human) ?? human[0] ?? inTarget(asr) ?? asr[0] ?? null;
}

// ---------------------------------------------------------------- timedtext URL

/** Rewrite a timedtext URL: `fmt=json3`, optional `lang`/`kind` retarget, set or remove `tlang`. Every other param (pot, c, exp, signature, …) is kept. */
export function rewriteTimedtextUrl(url: string, opts: { lang?: string; kind?: string | null; tlang?: string | null } = {}): string {
  const u = new URL(url, 'https://www.youtube.com');
  u.searchParams.set('fmt', 'json3');
  if (opts.lang) u.searchParams.set('lang', opts.lang);
  if ('kind' in opts) {
    if (opts.kind) u.searchParams.set('kind', opts.kind);
    else u.searchParams.delete('kind');
  }
  if (opts.tlang) u.searchParams.set('tlang', opts.tlang);
  else u.searchParams.delete('tlang');
  return u.href;
}

/** `v` param of a timedtext URL, or null. */
export function timedtextVideoId(url: string): string | null {
  try {
    const u = new URL(url, 'https://www.youtube.com');
    return u.pathname.includes('/api/timedtext') ? u.searchParams.get('v') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- speaker labels

const MALE = new Set([
  'man', 'men', 'male', 'boy', 'guy', 'father', 'dad', 'daddy', 'grandpa', 'grandfather', 'mr', 'gentleman', 'king', 'prince',
  'homme', 'hommes', 'garçon', 'masculin', 'masculine', 'père', 'papa', 'monsieur', 'papi', 'roi',
  'hombre', 'niño', 'chico', 'masculino', 'masculina', 'padre', 'señor', 'abuelo', 'rey',
  'adam', 'erkek', 'oğlan', 'baba', 'bey', 'dede',
  'رجل', 'الرجل', 'صبي', 'الصبي', 'ولد', 'الولد', 'ذكر', 'أب', 'الأب', 'رجال',
]);
const FEMALE = new Set([
  'woman', 'women', 'female', 'girl', 'lady', 'mother', 'mom', 'mommy', 'mum', 'grandma', 'grandmother', 'mrs', 'ms', 'miss', 'queen', 'princess',
  'femme', 'femmes', 'fille', 'féminin', 'féminine', 'mère', 'maman', 'madame', 'mamie', 'reine', 'princesse',
  'mujer', 'niña', 'chica', 'femenino', 'femenina', 'madre', 'señora', 'abuela', 'reina', 'princesa',
  'kadın', 'kız', 'hanım', 'nine', 'kraliçe',
  'امرأة', 'امراة', 'المرأة', 'فتاة', 'الفتاة', 'بنت', 'البنت', 'أنثى', 'أم', 'الأم', 'نساء',
]);
const SOUND = new Set([
  'music', 'musique', 'música', 'müzik', 'موسيقى', 'applause', 'applaudissements', 'aplausos', 'alkış', 'alkışlar', 'تصفيق',
  'laughter', 'laughs', 'laughing', 'laugh', 'chuckles', 'rires', 'rire', 'risas', 'kahkaha', 'gülüşmeler', 'ضحك', 'ضحكات',
  'inaudible', 'silence', 'sighs', 'soupir', 'cheering', 'cheers', 'gasps', 'crying', 'pleurs', 'playing', 'upbeat', 'singing',
]);

const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);

/** Gender named in a speaker label such as "Man", "Woman narrator", "homme", "رجل"; undefined if none / ambiguous. */
export function genderFromLabel(label: string): Gender | undefined {
  let m = false;
  let f = false;
  for (const t of tokens(label)) {
    if (MALE.has(t)) m = true;
    if (FEMALE.has(t)) f = true;
  }
  return m === f ? undefined : m ? 'male' : 'female';
}

export interface CleanText { text: string; gender?: Gender; newSpeaker: boolean }

/** Strip non-speech annotations ([Music], (laughs), ♪, >> NAME:) and read speaker hints. */
export function cleanCueText(raw: string): CleanText {
  let t = raw.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  let gender: Gender | undefined;
  let newSpeaker = false;

  if (/^>>/.test(t) || t.includes(' >> ')) newSpeaker = true;
  t = t.replace(/>>/g, ' ').trim();
  // Dialogue dash at the start ("- Bonjour !") = new speaker.
  if (/^[-–—]\s+/.test(t)) {
    newSpeaker = true;
    t = t.replace(/^[-–—]\s+/, '');
  }
  // [Anything] is never spoken; a gender word inside it is a hint.
  // "[Jimmy]: …" / "[MAN 2]:" = a speaker label → new speaker (v1.1).
  t = t.replace(/\[([^\]]{0,60})\](\s*:)?/g, (_all, inner: string, colon?: string) => {
    const g = genderFromLabel(inner);
    if (g) { gender = g; newSpeaker = true; }
    if (colon && inner.trim()) newSpeaker = true;
    return ' ';
  });
  // (label) removed when it is a gender label, a sound tag, or the whole cue.
  const whole = /^\s*\(([^)]{0,60})\)\s*$/.test(t);
  t = t.replace(/\(([^)]{0,60})\)/g, (all, inner: string) => {
    const toks = tokens(inner);
    const g = genderFromLabel(inner);
    if (g && toks.length <= 4) { gender = g; newSpeaker = true; return ' '; }
    if (whole || (toks.length <= 4 && toks.some((x) => SOUND.has(x)))) return ' ';
    return all;
  });
  t = t.trim();
  // "JOHN: hello" / "NARRATOR MALE: …" style speaker prefix (upper-case name).
  const pre = /^([\p{Lu}][\p{Lu}0-9 .'’-]{0,30}):\s+/u.exec(t);
  if (pre && pre[1] && /\p{Lu}{2}/u.test(pre[1])) {
    const g = genderFromLabel(pre[1]);
    if (g) gender = g;
    newSpeaker = true;
    t = t.slice(pre[0].length);
  }
  // Sung lyrics (♪ … ♪, or a cue opening/closing a song) are never dubbed (v1.1).
  t = t.replace(/[♪♫♬][^♪♫♬]*[♪♫♬]/g, ' ');
  if (/[♪♫♬]/.test(t)) t = '';
  t = t.replace(/\s+/g, ' ').trim();
  return gender ? { text: t, gender, newSpeaker } : { text: t, newSpeaker };
}

// ---------------------------------------------------------------- json3

/** json3 → Cue[] (drop events without segs or only "\n"; end capped at next start). Seconds. Speaker labels are stripped and become `gender` hints that carry over until the next speaker change. */
export function parseJson3(json: Json3): Cue[] {
  const evs = (json?.events ?? [])
    .filter((e) => e && Array.isArray(e.segs) && e.segs.length && Number.isFinite(e.tStartMs))
    .slice()
    .sort((a, b) => a.tStartMs - b.tStartMs);
  const raw: { start: number; end: number; text: string }[] = [];
  for (const e of evs) {
    const text = (e.segs ?? []).map((s) => s?.utf8 ?? '').join('');
    if (!text.trim()) continue;
    raw.push({ start: e.tStartMs / 1000, end: (e.tStartMs + Math.max(0, e.dDurationMs ?? 0)) / 1000, text });
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    const next = raw[i + 1];
    if (next && next.start > c.start && c.end > next.start) c.end = next.start;
    if (c.end < c.start) c.end = c.start;
  }
  const out: Cue[] = [];
  let gender: Gender | undefined;
  let pendingNew = false;
  for (const c of raw) {
    const info = cleanCueText(c.text);
    if (info.newSpeaker) gender = info.gender;
    else if (info.gender) gender = info.gender;
    if (!info.text) {
      pendingNew ||= info.newSpeaker;
      continue;
    }
    const cue: Cue = { start: c.start, end: c.end, text: info.text };
    if (gender) cue.gender = gender;
    if (info.newSpeaker || pendingNew) cue.newSpeaker = true;
    pendingNew = false;
    out.push(cue);
  }
  return out;
}

// ---------------------------------------------------------------- sentence merge

const END_CHARS = '.!?…。！？؟؛';
const CLOSERS = `"'”’»)\\]`;
const END_RE = new RegExp(`[${END_CHARS}][${CLOSERS}]*$`);
const ANY_END_RE = new RegExp(`[${END_CHARS}]`);
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'jr', 'sr', 'prof', 'mme', 'mlle', 'sra', 'srta', 'dra', 'e.g', 'i.e', 'fig', 'approx']);
const stripClosers = (s: string) => s.replace(new RegExp(`[${CLOSERS}]+$`), '');

function isAbbrevEnd(text: string): boolean {
  const m = /([\p{L}.]+)\.$/u.exec(text);
  return !!m && ABBR.has(m[1]!.toLowerCase());
}

/** True when `text` ends a sentence (., !, ?, …, 。, ؟, ؛ — not "Mr."). */
export function endsSentence(text: string): boolean {
  const t = text.trim();
  return END_RE.test(t) && !isAbbrevEnd(stripClosers(t));
}

/** Heuristic: a track is "punctuated" when sentence marks appear in ≥ 15 % of cues. */
export function isPunctuated(cues: Cue[]): boolean {
  if (!cues.length) return false;
  let n = 0;
  for (const c of cues) if (ANY_END_RE.test(c.text)) n++;
  return n / cues.length >= 0.15;
}

interface Piece { start: number; end: number; text: string; gender?: Gender; newSpeaker?: boolean; emph?: string[]; shout?: boolean }

/** Split a cue at sentence ends inside it; times shared by character count. */
function splitInternal(c: Cue): Piece[] {
  const parts: string[] = [];
  const re = new RegExp(`[${END_CHARS}]+[${CLOSERS}]*\\s+`, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c.text))) {
    const cut = m.index + m[0].length;
    const seg = c.text.slice(last, cut).trim();
    if (isAbbrevEnd(stripClosers(seg))) continue;
    parts.push(seg);
    last = cut;
  }
  const rest = c.text.slice(last).trim();
  if (rest) parts.push(rest);
  return share(c, parts);
}

/** v1.2 (E): emphasis words of a cue that fall in one of its pieces. */
function emphIn(emph: string[] | undefined, text: string): string[] | undefined {
  if (!emph?.length) return undefined;
  const low = text.toLowerCase();
  const got = emph.filter((w) => low.includes(w));
  return got.length ? got : undefined;
}

function share(c: Piece, parts: string[]): Piece[] {
  if (parts.length <= 1) return [{ ...c }];
  const total = parts.reduce((a, p) => a + p.length, 0) || 1;
  const dur = c.end - c.start;
  let t = c.start;
  return parts.map((text, i) => {
    const start = t;
    const end = i === parts.length - 1 ? c.end : t + (dur * text.length) / total;
    t = end;
    const p: Piece = { start, end, text };
    if (c.gender) p.gender = c.gender;
    if (i === 0 && c.newSpeaker) p.newSpeaker = true;
    if (c.shout) p.shout = true;
    const em = emphIn(c.emph, text);
    if (em) p.emph = em;
    return p;
  });
}

/** Split text into chunks ≤ max chars, preferring , ; : then spaces; hard cut for scripts without spaces. */
export function splitLongText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const win = rest.slice(0, max + 1);
    let cut = -1;
    for (const re of [/[,;:،，、]\s/g, /\s/g]) {
      let m: RegExpExecArray | null;
      let best = -1;
      while ((m = re.exec(win))) if (m.index >= max * 0.3) best = m.index + 1;
      if (best > 0) { cut = best; break; }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Join cues into sentences (punctuation / gap > 1.2 s / 180 chars / ~12 s; ASR: gap > 0.7 s or 120 chars). `asr` defaults to "no punctuation detected". Speaker changes always break a line; `Line.gender` comes from caption labels. */
export function mergeSentences(cues: Cue[], lang: string, opts?: { asr?: boolean }): Line[] {
  const list = (cues ?? []).filter((c) => c && c.text && c.text.trim());
  const asr = opts?.asr ?? !isPunctuated(list);
  const maxChars = asr ? 120 : 180;
  const maxGap = asr ? 0.7 : 1.2;
  const maxDur = 12;
  const sep = /^(ja|zh|th|ko)$/.test(langBase(lang)) ? '' : ' ';

  const pieces: Piece[] = [];
  for (const c of list) {
    const ps = asr ? [{ ...c }] : splitInternal(c);
    for (const p of ps) {
      if (p.text.length > maxChars) pieces.push(...share(p, splitLongText(p.text, maxChars)));
      else pieces.push(p);
    }
  }

  const lines: Line[] = [];
  const ids = new Set<string>();
  let cur: Piece | null = null;
  const flush = (): void => {
    const c = cur;
    cur = null;
    if (!c) return;
    const text = c.text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const ms = Math.round(c.start * 1000);
    let id = 'l' + ms;
    for (let k = 2; ids.has(id); k++) id = `l${ms}_${k}`;
    ids.add(id);
    const line: Line = { id, start: round3(c.start), end: round3(Math.max(c.end, c.start)), text };
    if (c.gender) line.gender = c.gender;
    if (c.newSpeaker) line.newSpeaker = true;
    if (c.shout) line.shout = true;
    if (c.emph?.length) line.emph = [...new Set(c.emph)];
    lines.push(line);
  };

  for (const p of pieces) {
    const c = cur as Piece | null;
    if (
      c &&
      (p.start - c.end > maxGap ||
        c.text.length + sep.length + p.text.length > maxChars ||
        p.end - c.start > maxDur ||
        p.newSpeaker ||
        p.gender !== c.gender)
    ) flush();
    const open = cur as Piece | null;
    if (!open) {
      cur = { start: p.start, end: p.end, text: p.text, ...(p.gender ? { gender: p.gender } : {}), ...(p.newSpeaker ? { newSpeaker: true } : {}) };
      if (p.shout) cur.shout = true;
      if (p.emph?.length) cur.emph = [...p.emph];
    } else {
      open.text += sep + p.text;
      open.end = Math.max(open.end, p.end);
      // v1.2 (E): a line is "shouted" when its longer part was; emphasis words add up.
      if (p.shout && (open.shout || p.text.length >= open.text.length / 2)) open.shout = true;
      if (p.emph?.length) open.emph = [...(open.emph ?? []), ...p.emph];
    }
    if (!asr && endsSentence((cur as Piece | null)?.text ?? '')) flush();
  }
  flush();
  return lines;
}

// ---------------------------------------------------------------- audio tracks

interface RawAudioTrack { id?: string; displayName?: string; audioIsDefault?: boolean; isAutoDubbed?: boolean }

/** YouTube's alternative audio tracks (official / auto-dub) from the player response; [] if none (or only the original). */
export function listAudioTracks(pr: PlayerResponse | null): AudioTrackInfo[] {
  const fmts = (pr?.streamingData?.adaptiveFormats ?? []) as { audioTrack?: RawAudioTrack }[];
  const seen = new Map<string, AudioTrackInfo>();
  for (const f of fmts) {
    const at = f?.audioTrack;
    if (!at || typeof at.id !== 'string') continue;
    const languageCode = at.id.split('.')[0] ?? '';
    if (!languageCode || seen.has(languageCode)) continue;
    const info: AudioTrackInfo = { languageCode };
    if (at.displayName) info.displayName = at.displayName;
    if (at.audioIsDefault) info.isDefault = true;
    if (at.isAutoDubbed || /auto[- ]?dub|dubbed[- ]auto|doublage automatique|doblaje automático/i.test(at.displayName ?? '')) info.isAutoDubbed = true;
    seen.set(languageCode, info);
  }
  return seen.size > 1 ? [...seen.values()] : [];
}
