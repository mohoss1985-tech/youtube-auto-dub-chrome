// v1.2 (E): per-line emotion known AHEAD of playback (the dub is synthesized before the original line plays).
// Cues: original punctuation (! ?), ALL CAPS in the original captions (Line.emph / Line.shout, captured before cleanup),
// interjections, money/number hype, stretched letters ("sooo"), NBA commentary patterns, plus an optional on-device
// Gemini Nano tag (batched, never blocking, feature-detected). Pure module except the Nano bridge (no chrome.*).
import type { EmotionStyle, Line, LineEmotion } from '../../shared/types';
import { bridgeRequest } from '../yt';
import type { LanguageModelStatic, LMSession } from './nano';

export const EMOTION_STYLES: readonly EmotionStyle[] = ['neutral', 'excited', 'happy', 'question', 'surprised', 'sad', 'calm', 'shout'] as const;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const norm = (s: string) => ` ${s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ')} `;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const anyOf = (s: string, words: readonly string[]) => words.filter((w) => s.includes(w)).length;

// Interjections / hype words. Matched on " text " (lower case, padded) so a leading/trailing space marks word edges.
const HYPE_EN = [
  ' wow', ' whoa', ' woah', 'oh my god', 'oh my gosh', ' omg', "let's go", ' lets go', 'no way', ' yes!', ' yes ', ' yeah!', ' boom',
  ' insane', ' crazy', ' unbelievable', ' incredible', ' amazing', ' holy ', ' epic', ' huge', ' massive', ' biggest', ' craziest',
  ' legendary', ' ridiculous', ' sick!', ' fire!', ' goat', ' win ', ' won ', ' winner', ' victory', ' destroyed', ' explode',
];
const HYPE_FR = [
  ' waouh', ' wouah', ' ouah', ' wow', ' incroyable', "c'est parti", ' allez', 'oh mon dieu', ' oui !', ' boum', ' énorme', ' dingue',
  ' de ouf', ' trop fort', ' magnifique', ' fou ', ' folle', ' gagné', ' victoire', ' géant', ' gigantesque', ' le plus grand',
];
/** NBA / sports commentary (play-by-play is always high energy). */
const SPORTS = [
  'and one', 'and-one', 'from downtown', 'for three', 'for 3', ' bang', ' dunk', ' slam', 'count it', ' buzzer', 'game winner',
  'game-winner', ' clutch', 'on fire', 'nothing but net', ' swish', ' rejected', 'get that out', 'what a shot', 'what a play',
  'what a pass', 'what a block', 'what a dunk', ' posterized', ' poster', ' alley-oop', ' alley oop', ' block', ' steal', 'three-pointer',
  'game over', 'puts it in', ' oh!', 'en un contre un', 'à trois points', ' smash', ' panier', 'contre !',
];
const SURPRISE = [
  'no way', 'are you serious', 'are you kidding', 'what?!', 'what!?', 'wait,', 'wait what', 'really?!', ' what the', 'oh no', 'impossible',
  'quoi ?!', 'quoi !', 'sérieux ?', 'sérieusement', 'pas possible', "c'est pas vrai", 'attends', 'non mais',
];
const HAPPY = [
  ' thank', ' love', 'congratulations', ' congrats', ' happy', ' yay', ' awesome', ' nice', ' fun', ' best day', ' beautiful', ' cool',
  ' merci', ' bravo', 'félicitations', ' génial', ' super', ' content', ' heureux', ' trop bien', ' adore', ' joyeux',
];
const SAD = [
  ' sorry', ' sad', ' cry', ' crying', ' lost', 'unfortunately', 'miss you', ' died', ' passed away', ' hurt', ' broke my heart',
  ' désolé', ' triste', ' perdu', ' dommage', ' pleure', ' malheureusement', ' mort',
];
const CALM = [
  'let me explain', ' calm', ' quietly', ' shh', ' relax', ' slowly', ' gently', 'take a breath', ' doucement', ' calme', ' tranquille',
  ' explique',
];

/** French words worth stressing (numbers/money/intensifiers). */
const FR_STRESS = new Set([
  'incroyable', 'énorme', 'dingue', 'jamais', 'tout', 'tous', 'rien', 'personne', 'gagné', 'gagne', 'gratuit', 'gratuite', 'géant',
  'gigantesque', 'immense', 'meilleur', 'meilleure', 'pire', 'vraiment', 'trop', 'waouh', 'wow', 'boum', 'non', 'oui', 'million',
  'millions', 'milliard', 'milliards', 'mille', 'dollars', 'premier', 'dernier', 'dernière', 'seul', 'seule', 'fou', 'folle', 'allez',
  'impossible', 'parfait', 'champion', 'victoire',
]);
/** ALL-CAPS English emphasis → likely French words in the translation. */
const EN2FR: Readonly<Record<string, readonly string[]>> = {
  insane: ['incroyable', 'dingue', 'fou', 'folle'], crazy: ['fou', 'folle', 'dingue', 'incroyable'], huge: ['énorme', 'immense', 'géant'],
  massive: ['énorme', 'gigantesque', 'immense'], biggest: ['plus grand', 'plus grande', 'énorme'], never: ['jamais'], ever: ['jamais'],
  everything: ['tout'], everyone: ['tout le monde', 'tous'], nothing: ['rien'], nobody: ['personne'], free: ['gratuit', 'gratuite'],
  win: ['gagner', 'gagne', 'gagné'], won: ['gagné'], winner: ['gagnant', 'gagnante'], million: ['million', 'millions'],
  thousand: ['mille'], dollars: ['dollars'], best: ['meilleur', 'meilleure'], worst: ['pire'], last: ['dernier', 'dernière'],
  first: ['premier', 'première'], only: ['seul', 'seule'], no: ['non'], yes: ['oui'], wow: ['waouh', 'wow'], go: ['allez', 'parti'],
  real: ['vrai', 'vraiment'], really: ['vraiment'], so: ['tellement', 'si'], all: ['tout', 'tous'], impossible: ['impossible'],
  giant: ['géant', 'géante'], perfect: ['parfait', 'parfaite'], dunk: ['dunk', 'smash'], three: ['trois'], one: ['un', 'une'],
};

/** Hype from money / big numbers: "$1,000,000", "10 000 dollars", "$10K", "a million". */
export function numberHype(s: string): number {
  const t = s.toLowerCase();
  let h = 0;
  if (/\$\s?\d|\d[\d.,\s  ]*\s?(?:\$|dollars?|€|euros?)/u.test(t)) h += 0.5;
  if (/\b(?:million|millions|billion|milliards?|thousand|mille)\b/u.test(t) || /\d\s?k\b/u.test(t)) h += 0.4;
  const big = (t.match(/\d[\d,.\s  ]*\d|\d/gu) ?? []).map((x) => Number(x.replace(/[^\d]/gu, ''))).some((n) => n >= 1000);
  if (big) h += 0.3;
  return Math.min(1, h);
}

/** Stretched letters ("sooo", "nooo", "gooo"): excitement. */
export function stretched(s: string): boolean {
  return /(\p{L})\1{2,}/u.test(s);
}

/**
 * Emotion of one line from text cues (English source when present, the French text otherwise/also) and the caption's
 * caps flags. Deterministic and cheap: runs on every line as soon as it is known.
 */
export function analyzeEmotion(line: Pick<Line, 'text' | 'source' | 'emph' | 'shout'>): LineEmotion {
  const src = line.source ?? '';
  const fr = line.text ?? '';
  const both = norm(`${src} ${fr}`);
  const raw = `${src} ${fr}`;
  const exclam = Math.max(count(src, /!/g), count(fr, /!/g));
  const endQ = /\?\s*[!"»”')\]]*\s*$/u.test(src.trim()) || /\?\s*[!"»”')\]]*\s*$/u.test(fr.trim());
  const qBang = /\?!|!\?/u.test(raw);
  const hype = Math.min(3, anyOf(both, HYPE_EN) + anyOf(both, HYPE_FR));
  const sports = Math.min(2, anyOf(both, SPORTS));
  const money = numberHype(raw);
  const stretch = stretched(src || fr);
  const emphN = line.emph?.length ?? 0;
  const surprise = anyOf(both, SURPRISE);
  const happy = anyOf(both, HAPPY);
  const sad = anyOf(both, SAD);
  const calm = anyOf(both, CALM) + (/\.\.\.|…/u.test(raw) && !exclam ? 1 : 0);

  const energy = clamp01(
    0.28 * Math.min(exclam, 3) + 0.22 * hype + 0.3 * sports + 0.3 * money + (stretch ? 0.25 : 0) + 0.15 * Math.min(emphN, 3),
  );
  const shoutCue = !!line.shout || exclam >= 3 || (exclam >= 2 && emphN >= 2);
  let style: EmotionStyle;
  let intensity: number;
  if (shoutCue) {
    style = 'shout';
    intensity = 0.7 + 0.3 * energy;
  } else if (qBang || (surprise && (endQ || exclam))) {
    style = 'surprised';
    intensity = 0.6 + 0.4 * energy;
  } else if (endQ) {
    style = 'question';
    intensity = 0.45 + 0.5 * energy;
  } else if (sad && !exclam && !hype) {
    style = 'sad';
    intensity = 0.4 + 0.15 * sad;
  } else if (happy && happy >= hype && !sports && !money && energy < 0.6) {
    style = 'happy';
    intensity = 0.4 + 0.5 * energy + 0.1 * happy;
  } else if (energy >= 0.25) {
    style = 'excited';
    intensity = 0.3 + 0.7 * energy;
  } else if (calm) {
    style = 'calm';
    intensity = 0.45;
  } else {
    style = 'neutral';
    intensity = 0.2 + 0.4 * energy;
  }
  return { style, intensity: Math.round(clamp01(intensity) * 100) / 100, emphasisWords: emphasisWords(line, style), by: 'rules' };
}

/** Target-text words to stress (≤ 3): caps emphasis mapped to French, numbers/money, French intensifiers, names. */
export function emphasisWords(line: Pick<Line, 'text' | 'source' | 'emph'>, style: EmotionStyle = 'neutral'): string[] {
  const text = line.text ?? '';
  const words = text.match(/[\p{L}\d][\p{L}\d'’  -]*/gu) ?? [];
  const low = text.toLowerCase();
  const out: string[] = [];
  const add = (w: string) => { if (w && out.length < 3 && !out.some((o) => o.toLowerCase() === w.toLowerCase())) out.push(w); };
  // 1. Original ALL-CAPS words: same word (names, numbers, "NBA"…) or a known French equivalent.
  for (const e of line.emph ?? []) {
    const hit = words.find((w) => w.toLowerCase() === e);
    if (hit) { add(hit); continue; }
    for (const f of EN2FR[e] ?? []) {
      const i = low.indexOf(f);
      if (i >= 0 && (i === 0 || !/\p{L}/u.test(low[i - 1]!))) { add(text.slice(i, i + f.length)); break; }
    }
  }
  // 2. Numbers / money (the hype of a MrBeast line is usually the amount).
  for (const w of words) if (/\d/.test(w)) add(w);
  // 3. French intensifiers.
  for (const w of words) if (FR_STRESS.has(w.toLowerCase())) add(w);
  // 4. Expressive lines without anything else: stress the first proper name (not sentence-initial).
  if (!out.length && style !== 'neutral' && style !== 'calm' && style !== 'sad') {
    const name = words.find((w, i) => i > 0 && /^\p{Lu}\p{Ll}+/u.test(w) && !/[.!?]\s*$/u.test(text.slice(0, text.indexOf(w)).trim()));
    if (name) add(name);
  }
  return out;
}

/** Add `emotion` to every line that has none (rules). Same ids/order; untouched lines are the same objects. */
export function annotateEmotions(lines: Line[], tags?: ReadonlyMap<string, NanoTag>): Line[] {
  return lines.map((l) => {
    const tag = tags?.get(l.id);
    if (l.emotion && (!tag || l.emotion.by === 'nano')) return l;
    const rules = l.emotion && l.emotion.by !== 'nano' ? l.emotion : analyzeEmotion(l);
    return { ...l, emotion: tag ? mergeTag(rules, tag) : rules };
  });
}

// ---------------------------------------------------------------- optional Gemini Nano tagging

export interface NanoTag { style: EmotionStyle; intensity: number }

/**
 * Blend a Nano tag into the rule result: the model decides the style when the text cues were weak (neutral or low
 * intensity); strong cues (shout from caps, a question mark) win. Emphasis words always come from the rules.
 */
export function mergeTag(rules: LineEmotion, tag: NanoTag): LineEmotion {
  const strong = rules.style === 'shout' || rules.style === 'question' || rules.style === 'surprised' || rules.intensity >= 0.6;
  if (strong || tag.style === rules.style) {
    return { ...rules, intensity: Math.round(clamp01(Math.max(rules.intensity, (rules.intensity + tag.intensity) / 2)) * 100) / 100, by: 'nano' };
  }
  return { style: tag.style, intensity: Math.round(clamp01(tag.intensity) * 100) / 100, emphasisWords: rules.emphasisWords, by: 'nano' };
}

export const NANO_EMOTION_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
} as const;

export const NANO_EMOTION_SYSTEM =
  'You label how each line of a kids YouTube video (MrBeast challenges, NBA highlights) is spoken. ' +
  'Styles: neutral, excited, happy, question, surprised, sad, calm, shout. ' +
  'For every numbered line answer exactly one output line "n: style intensity" with intensity from 0 to 1. No other text.';

export function buildTagPrompt(texts: readonly string[]): string {
  return texts.map((t, i) => `${i + 1}: ${t.replace(/\s+/g, ' ').trim()}`).join('\n');
}

/** Parse "n: style intensity" lines; unknown or missing lines → null. */
export function parseTags(reply: string, n: number): (NanoTag | null)[] {
  const out: (NanoTag | null)[] = new Array(n).fill(null);
  for (const row of String(reply ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*[:.)-]\s*\**([a-z]+)\**\s*[,(]?\s*([01](?:[.,]\d+)?)?/iu.exec(row);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    const style = m[2]!.toLowerCase() as EmotionStyle;
    if (i < 0 || i >= n || !EMOTION_STYLES.includes(style)) continue;
    const v = m[3] != null ? Number(m[3].replace(',', '.')) : 0.6;
    out[i] = { style, intensity: clamp01(Number.isFinite(v) ? v : 0.6) };
  }
  return out;
}

export type TagFn = (texts: string[], signal?: AbortSignal) => Promise<(NanoTag | null)[]>;

/** Tagger over one LanguageModel. Never triggers a model download (needs 'available'); throws when unusable. */
export function makeNanoTagger(LM: LanguageModelStatic): TagFn {
  let base: Promise<LMSession | null> | null = null;
  const getBase = () =>
    (base ??= (async () => {
      try {
        const a = await LM.availability(NANO_EMOTION_OPTS);
        if (a !== 'available') return null;
        return await LM.create({ ...NANO_EMOTION_OPTS, initialPrompts: [{ role: 'system', content: NANO_EMOTION_SYSTEM }] });
      } catch {
        return null;
      }
    })());
  return async (texts, signal) => {
    const b = await getBase();
    if (!b) throw new Error('LanguageModel unavailable');
    let s: LMSession | null = null;
    try {
      s = typeof b.clone === 'function' ? await b.clone({ signal }) : b;
      return parseTags(await s.prompt(buildTagPrompt(texts), { signal }), texts.length);
    } finally {
      if (s && s !== b) try { s.destroy?.(); } catch { /* ignore */ }
    }
  };
}

let isolatedTagger: TagFn | null = null;

/** Default tagger: LanguageModel in this (isolated) world, else the MAIN-world hook (bridge op 'nanoEmotion'). */
export const nanoTag: TagFn = async (texts, signal) => {
  const L = (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
  if (L && typeof L.availability === 'function') return (isolatedTagger ??= makeNanoTagger(L))(texts, signal);
  const r = await bridgeRequest<(NanoTag | null)[] | null>('nanoEmotion', { texts }, { timeoutMs: 10_000 });
  if (!Array.isArray(r)) throw new Error('LanguageModel unavailable');
  return texts.map((_, i) => {
    const t = r[i];
    return t && EMOTION_STYLES.includes(t.style) ? { style: t.style, intensity: clamp01(Number(t.intensity)) } : null;
  });
};

export interface EmotionTaggerOptions {
  tag: TagFn;
  onChange: () => void;
  isAlive?: () => boolean;
  /** Lines per prompt. Default 8. */
  batch?: number;
  timeoutMs?: number;
  maxFailures?: number;
  debounceMs?: number;
}

/** Background Nano tagging ahead of playback (from `fromTime` forward). Never blocks; turns itself off after failures. */
export class EmotionTagger {
  readonly tags = new Map<string, NanoTag>();
  private readonly tried = new Set<string>();
  private queue: Line[] = [];
  private running = false;
  private failures = 0;
  private disabled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly o: EmotionTaggerOptions) {}

  get isDisabled(): boolean { return this.disabled; }

  feed(lines: readonly Line[], fromTime = 0): void {
    if (this.disabled) return;
    const fresh = [...lines].filter((l) => !this.tried.has(l.id) && (l.source ?? l.text).trim().length > 3).sort((a, b) => a.start - b.start);
    for (const l of fresh) this.tried.add(l.id);
    this.queue.push(...fresh.filter((l) => l.end >= fromTime), ...fresh.filter((l) => l.end < fromTime));
    void this.loop();
  }

  private alive(): boolean {
    try { return this.o.isAlive ? this.o.isAlive() : true; } catch { return false; }
  }

  private async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disabled && this.alive()) {
        const part = this.queue.splice(0, this.o.batch ?? 8);
        let to: ReturnType<typeof setTimeout> | null = null;
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeout = new Promise<'timeout'>((r) => { to = setTimeout(() => r('timeout'), this.o.timeoutMs ?? 10_000); });
        const res = await Promise.race([this.o.tag(part.map((l) => l.source ?? l.text), ac?.signal).catch(() => undefined), timeout]);
        if (to) clearTimeout(to);
        if (!this.alive()) break;
        if (!Array.isArray(res)) {
          ac?.abort();
          if (++this.failures >= (this.o.maxFailures ?? 3)) this.disabled = true;
          continue;
        }
        this.failures = 0;
        let changed = false;
        part.forEach((l, i) => { const t = res[i]; if (t) { this.tags.set(l.id, t); changed = true; } });
        if (changed) this.schedule();
      }
    } finally {
      this.running = false;
      if (this.disabled || !this.alive()) this.queue = [];
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.alive()) try { this.o.onChange(); } catch { /* ignore */ }
    }, this.o.debounceMs ?? 500);
  }
}
