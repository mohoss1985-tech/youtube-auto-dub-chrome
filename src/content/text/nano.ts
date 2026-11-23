// "Smart French" (v1.1, owner F): Chrome's built-in Prompt API (Gemini Nano, `LanguageModel` global, Chrome 138+)
// rewrites French lines that are much longer than their caption slot into shorter natural spoken French.
// Optional and never blocking: runs in the background ahead of playback; any failure keeps the original line.
// No chrome.* here (bundled into the MAIN-world hook too).
import type { Line } from '../../shared/types';
import { bridgeRequest } from '../yt';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available' | string;
export interface LMSession {
  prompt(input: string, o?: { signal?: AbortSignal }): Promise<string>;
  clone?(o?: { signal?: AbortSignal }): Promise<LMSession>;
  destroy?(): void;
}
interface CreateMonitor { addEventListener(type: 'downloadprogress', cb: (e: { loaded?: number }) => void): void }
export interface LanguageModelStatic {
  availability(o?: unknown): Promise<Availability>;
  create(o?: Record<string, unknown> & { monitor?: (m: CreateMonitor) => void; initialPrompts?: { role: string; content: string }[] }): Promise<LMSession>;
}

/** Languages declared to the model (docs: en, ja, es, de, fr are supported). */
export const NANO_LANG_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en', 'fr'] }],
  expectedOutputs: [{ type: 'text', languages: ['fr'] }],
} as const;

export const NANO_SYSTEM =
  "Tu adaptes des répliques pour le doublage français d'une vidéo regardée par des enfants. " +
  "On te donne la réplique anglaise originale (pour le sens) et sa traduction française, trop longue pour le temps de parole. " +
  'Réécris la réplique française en français parlé, naturel et simple, plus courte, avec le même sens. ' +
  "Garde les noms et les nombres. N'ajoute aucune information. Réponds uniquement avec la nouvelle réplique, sur une seule ligne, sans guillemets.";

export interface RewriteRequest { fr: string; source?: string; maxChars: number }
export type RewriteFn = (req: RewriteRequest, signal?: AbortSignal) => Promise<string | null>;

/** The LanguageModel global in this JS world, or null. */
export function getLanguageModelGlobal(): LanguageModelStatic | null {
  const L = (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;
  return L && typeof L.availability === 'function' && typeof L.create === 'function' ? L : null;
}

export function buildPrompt(req: RewriteRequest): string {
  return (
    (req.source ? `Original anglais : ${req.source}\n` : '') +
    `Traduction française (${req.fr.length} caractères) : ${req.fr}\n` +
    `Nouvelle réplique (au plus ${req.maxChars} caractères) :`
  );
}

/** Clean the model's reply and accept it only when it is a real, shorter line. null = keep the original. */
export function acceptRewrite(orig: string, reply: string | null | undefined): string | null {
  if (typeof reply !== 'string') return null;
  let s = reply.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? '';
  s = s.replace(/^(?:nouvelle réplique|réplique|version courte|réponse)\s*:\s*/iu, '');
  s = s.replace(/^["«“'\s]+|["»”'\s]+$/gu, '').replace(/\s+/g, ' ').trim();
  if (!s || !/\p{L}/u.test(s)) return null;
  if (s.length > orig.length * 0.92) return null; // not shorter
  if (s.length < Math.max(4, orig.length * 0.35)) return null; // meaning probably dropped
  // Numbers must survive.
  const nums = (x: string) => (x.match(/\d+/g) ?? []).join(' ');
  if (nums(orig) && nums(s) !== nums(orig)) return null;
  if (!/[.!?…]$/u.test(s) && /[.!?…]$/u.test(orig)) s += orig.trim().slice(-1);
  return s;
}

/**
 * A rewriter over one LanguageModel: one base session (created lazily, never re-created after a failure),
 * cloned per line so prompts never pile up in one context. Resolves null for an unusable reply; throws when
 * the model is unavailable or the prompt fails (the shortener counts those as failures).
 */
export function makeNanoRewriter(LM: LanguageModelStatic): RewriteFn {
  let base: Promise<LMSession | null> | null = null;
  const getBase = () =>
    (base ??= (async () => {
      try {
        const a = await LM.availability(NANO_LANG_OPTS);
        if (a === 'unavailable' || a === 'no') return null;
        return await LM.create({ ...NANO_LANG_OPTS, initialPrompts: [{ role: 'system', content: NANO_SYSTEM }] });
      } catch {
        return null;
      }
    })());
  return async (req, signal) => {
    const b = await getBase();
    if (!b) throw new Error('LanguageModel unavailable');
    let s: LMSession | null = null;
    try {
      s = typeof b.clone === 'function' ? await b.clone({ signal }) : b;
      const out = await s.prompt(buildPrompt(req), { signal });
      return acceptRewrite(req.fr, out);
    } finally {
      if (s && s !== b) try { s.destroy?.(); } catch { /* ignore */ }
    }
  };
}

let isolatedRewriter: RewriteFn | null = null;

/** Default rewriter: LanguageModel in this (isolated) world, else the MAIN-world hook (bridge op 'nano'). */
export const nanoRewrite: RewriteFn = async (req, signal) => {
  const L = getLanguageModelGlobal();
  if (L) return (isolatedRewriter ??= makeNanoRewriter(L))(req, signal);
  const r = await bridgeRequest<string | null>('nano', req, { timeoutMs: 8000 });
  return acceptRewrite(req.fr, r);
};

/**
 * Inside the Dub click (transient user activation): start the Gemini Nano download if needed.
 * Best effort; the MAIN-world variant shares the same window activation.
 */
export function warmUpNano(LM: LanguageModelStatic | null = getLanguageModelGlobal()): void {
  if (!LM) {
    void bridgeRequest('nanoWarmup', {}, { timeoutMs: 3000 }).catch(() => {});
    return;
  }
  void runWarmUp(LM);
}

export async function runWarmUp(LM: LanguageModelStatic): Promise<boolean> {
  try {
    const a = await LM.availability(NANO_LANG_OPTS);
    if (a !== 'downloadable' && a !== 'downloading') return a === 'available';
    const s = await LM.create({ ...NANO_LANG_OPTS });
    try { s.destroy?.(); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- which lines, and the background pass

/** Over-long when the estimated French speech is > `ratio` × the line's slot (slot may borrow up to 0.6 s of the gap). */
export const OVERLONG_RATIO = 1.25;

export function slotS(line: Line, next: Line | undefined): number {
  const end = next ? Math.max(line.end, Math.min(next.start, line.end + 0.6)) : line.end + 0.6;
  return Math.max(0.3, end - line.start);
}

/** Target length for a line that should fit its slot at a comfortable ~1.1× speed; null when it already fits. */
export function shortenTarget(line: Line, next: Line | undefined, estimateMs: (t: string) => number, ratio = OVERLONG_RATIO): number | null {
  const est = estimateMs(line.text) / 1000;
  const slot = slotS(line, next);
  if (!(est > ratio * slot) || line.text.length < 25) return null;
  return Math.max(Math.round(line.text.length * 0.5), Math.floor((line.text.length * slot * 1.1) / est));
}

export interface ShortenerOptions {
  rewrite: RewriteFn;
  estimateMs: (text: string) => number;
  /** Called (debounced) when new rewrites are ready; re-apply() your latest lines. */
  onChange: () => void;
  isAlive?: () => boolean;
  /** Per-line timeout (ms). Default 6000 (first call may load the model). */
  timeoutMs?: number;
  /** Give up after this many consecutive failures/timeouts. Default 3. */
  maxFailures?: number;
  /** onChange debounce (ms). Default 400. */
  debounceMs?: number;
}

/** Background "make long French lines shorter" pass. Keeps ids, times, speaker flags; only `text` changes. */
export class FrenchShortener {
  private readonly short = new Map<string, string>();
  private readonly tried = new Set<string>();
  private queue: { line: Line; maxChars: number }[] = [];
  private running = false;
  private failures = 0;
  private disabled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleWaiters: (() => void)[] = [];
  constructor(private readonly o: ShortenerOptions) {}

  /** Lines with ready rewrites applied (same ids/order; `source` kept). */
  apply(lines: Line[]): Line[] {
    if (!this.short.size) return lines;
    return lines.map((l) => {
      const s = this.short.get(l.id);
      return s && l.text !== s ? { ...l, text: s } : l;
    });
  }

  /** Queue over-long lines (from `fromTime` forward first). Safe to call with every new snapshot. */
  feed(lines: Line[], fromTime = 0): void {
    if (this.disabled) return;
    const sorted = [...lines].sort((a, b) => a.start - b.start);
    const cands: { line: Line; maxChars: number }[] = [];
    sorted.forEach((l, i) => {
      if (this.tried.has(l.id) || this.short.has(l.id)) return;
      const max = shortenTarget(l, sorted[i + 1], this.o.estimateMs);
      if (max == null) return;
      this.tried.add(l.id);
      cands.push({ line: l, maxChars: max });
    });
    const ahead = cands.filter((c) => c.line.end >= fromTime);
    const behind = cands.filter((c) => c.line.end < fromTime);
    this.queue.push(...ahead, ...behind);
    void this.loop();
  }

  /** Number of rewritten lines. */
  get size(): number { return this.short.size; }
  get isDisabled(): boolean { return this.disabled; }

  /** Resolves when the queue is empty (tests). */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private alive(): boolean {
    try { return this.o.isAlive ? this.o.isAlive() : true; } catch { return false; }
  }

  private async loop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disabled && this.alive()) {
        const { line, maxChars } = this.queue.shift()!;
        const res = await this.once(line, maxChars);
        if (!this.alive()) break;
        if (res) {
          this.failures = 0;
          this.short.set(line.id, res);
          this.schedule();
        } else if (res === undefined && ++this.failures >= (this.o.maxFailures ?? 3)) {
          this.disabled = true;
        }
      }
    } finally {
      this.running = false;
      if (this.disabled || !this.alive()) this.queue = [];
      if (this.timer && !this.alive()) { clearTimeout(this.timer); this.timer = null; }
      const w = this.idleWaiters.splice(0);
      w.forEach((f) => f());
    }
  }

  /** string = accepted rewrite; null = model answered but not usable; undefined = error/timeout (counts as failure). */
  private async once(line: Line, maxChars: number): Promise<string | null | undefined> {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let to: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<'timeout'>((r) => { to = setTimeout(() => r('timeout'), this.o.timeoutMs ?? 6000); });
      const req: RewriteRequest = { fr: line.text, maxChars };
      if (line.source) req.source = line.source;
      const r = await Promise.race([this.o.rewrite(req, ac?.signal).catch(() => undefined), timeout]);
      if (r === 'timeout') { ac?.abort(); return undefined; }
      if (r === undefined) return undefined;
      return r ? acceptRewrite(line.text, r) : null;
    } finally {
      if (to) clearTimeout(to);
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.alive()) try { this.o.onChange(); } catch { /* ignore */ }
    }, this.o.debounceMs ?? 400);
  }
}
