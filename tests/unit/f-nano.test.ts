// F (v1.1): Gemini Nano shortener — only over-long lines, falls back on error / timeout / bad output.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Line } from '../../src/shared/types';
import { FrenchShortener, acceptRewrite, makeNanoRewriter, runWarmUp, shortenTarget, type LanguageModelStatic } from '../../src/content/text/nano';

const est = (t: string) => (t.length / 14) * 1000; // 14 chars/s
const L = (id: string, start: number, end: number, text: string, extra: Partial<Line> = {}): Line => ({ id, start, end, text, source: 'src ' + id, ...extra });
const LONG = 'Ceci est une phrase française beaucoup trop longue pour le tout petit créneau disponible ici.'; // 93 chars ≈ 6.6 s
const lines = [
  L('a', 0, 2, LONG, { newSpeaker: true }), // slot 2.6 s → over-long
  L('b', 3, 7, 'Courte et ça tient.'),
  L('c', 8, 9, 'Bon.'), // tiny but short text (< 25 chars) → skipped
];

afterEach(() => vi.useRealTimers());

describe('shortenTarget', () => {
  it('flags only lines whose estimate > 1.25 × slot', () => {
    expect(shortenTarget(lines[0]!, lines[1], est)).toBeGreaterThan(30);
    expect(shortenTarget(lines[1]!, lines[2], est)).toBeNull();
    expect(shortenTarget(lines[2]!, undefined, est)).toBeNull();
  });
});

describe('acceptRewrite', () => {
  it('cleans quotes/labels, rejects longer, too short, or number-changing output', () => {
    expect(acceptRewrite(LONG, '« Phrase bien trop longue pour ce créneau. »')).toBe('Phrase bien trop longue pour ce créneau.');
    expect(acceptRewrite(LONG, 'Nouvelle réplique : Trop longue pour ce petit créneau.')).toBe('Trop longue pour ce petit créneau.');
    expect(acceptRewrite(LONG, LONG + ' encore')).toBeNull();
    expect(acceptRewrite(LONG, 'Oui.')).toBeNull();
    expect(acceptRewrite('Il a gagné 10 000 dollars en une seule journée de travail.', 'Il a gagné 5 000 dollars en un jour.')).toBeNull();
    expect(acceptRewrite(LONG, null)).toBeNull();
  });
});

describe('FrenchShortener', () => {
  it('rewrites only over-long lines; ids, times, flags kept', async () => {
    const rewrite = vi.fn(async (_req: { fr: string; source?: string }) => 'Phrase bien trop longue pour ce créneau.');
    const onChange = vi.fn();
    const sh = new FrenchShortener({ rewrite, estimateMs: est, onChange, debounceMs: 0 });
    sh.feed(lines);
    await sh.idle();
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(rewrite.mock.calls[0]![0]).toMatchObject({ fr: LONG, source: 'src a' });
    const out = sh.apply(lines);
    expect(out[0]).toEqual({ ...lines[0], text: 'Phrase bien trop longue pour ce créneau.' });
    expect(out[1]).toBe(lines[1]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    sh.feed(lines); // already tried → no new call
    await sh.idle();
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  it('error → original kept; 3 consecutive failures disable the pass', async () => {
    const many = Array.from({ length: 6 }, (_, i) => L('x' + i, i * 3, i * 3 + 1, LONG));
    const rewrite = vi.fn(async () => { throw new Error('boom'); });
    const sh = new FrenchShortener({ rewrite, estimateMs: est, onChange: vi.fn() });
    sh.feed(many);
    await sh.idle();
    expect(rewrite).toHaveBeenCalledTimes(3);
    expect(sh.isDisabled).toBe(true);
    expect(sh.apply(many)).toEqual(many);
  });

  it('timeout → original kept, next line still tried', async () => {
    vi.useFakeTimers();
    const two = [L('a', 0, 1, LONG), L('b', 5, 6, LONG)];
    const rewrite = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(async () => 'Phrase bien trop longue pour ce créneau.');
    const sh = new FrenchShortener({ rewrite, estimateMs: est, onChange: vi.fn(), timeoutMs: 1000 });
    sh.feed(two);
    await vi.advanceTimersByTimeAsync(1500);
    await sh.idle();
    const out = sh.apply(two);
    expect(out[0]!.text).toBe(LONG);
    expect(out[1]!.text).toBe('Phrase bien trop longue pour ce créneau.');
  });

  it('stops when the session is gone', async () => {
    let alive = true;
    const many = Array.from({ length: 5 }, (_, i) => L('x' + i, i * 3, i * 3 + 1, LONG));
    const rewrite = vi.fn(async () => { alive = false; return 'Phrase bien trop longue pour ce créneau.'; });
    const sh = new FrenchShortener({ rewrite, estimateMs: est, onChange: vi.fn(), isAlive: () => alive });
    sh.feed(many);
    await sh.idle();
    expect(rewrite).toHaveBeenCalledTimes(1);
  });
});

describe('makeNanoRewriter / warm-up (mocked LanguageModel)', () => {
  function fakeLM(state: string) {
    const prompts: string[] = [];
    const base = {
      prompt: vi.fn(async () => 'base'),
      clone: vi.fn(async () => ({ prompt: vi.fn(async (p: string) => { prompts.push(p); return 'Phrase bien trop longue pour ce créneau.'; }), destroy: vi.fn() })),
      destroy: vi.fn(),
    };
    const LM: LanguageModelStatic = { availability: vi.fn(async () => state), create: vi.fn(async () => base) };
    return { LM, base, prompts };
  }

  it('one base session (FR system prompt), cloned per line', async () => {
    const { LM, base, prompts } = fakeLM('available');
    const rw = makeNanoRewriter(LM);
    expect(await rw({ fr: LONG, source: 'This is way too long', maxChars: 50 })).toBe('Phrase bien trop longue pour ce créneau.');
    await rw({ fr: LONG, maxChars: 50 });
    expect(LM.create).toHaveBeenCalledTimes(1);
    expect(base.clone).toHaveBeenCalledTimes(2);
    expect((LM.create as any).mock.calls[0][0].expectedOutputs[0].languages).toEqual(['fr']);
    expect(prompts[0]).toContain('Original anglais : This is way too long');
    expect(prompts[0]).toContain('au plus 50 caractères');
  });

  it("'unavailable' → throws (counted as failure, original kept)", async () => {
    const { LM } = fakeLM('unavailable');
    await expect(makeNanoRewriter(LM)({ fr: LONG, maxChars: 50 })).rejects.toThrow();
  });

  it('warm-up creates (download) only when downloadable', async () => {
    const a = fakeLM('downloadable');
    expect(await runWarmUp(a.LM)).toBe(true);
    expect(a.LM.create).toHaveBeenCalledTimes(1);
    const b = fakeLM('available');
    expect(await runWarmUp(b.LM)).toBe(true);
    expect(b.LM.create).not.toHaveBeenCalled();
    const c = fakeLM('downloadable');
    (c.LM.create as any).mockRejectedValueOnce(new DOMException('needs activation', 'NotAllowedError'));
    expect(await runWarmUp(c.LM)).toBe(false);
  });
});
