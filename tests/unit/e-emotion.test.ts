// E (v1.2): emotion known ahead of playback — text cues on MrBeast / NBA lines, caps captured before cleanup, Nano tags.
import { describe, it, expect, vi } from 'vitest';
import { analyzeEmotion, annotateEmotions, EmotionTagger, emphasisWords, mergeTag, numberHype, parseTags, stretched } from '../../src/content/text/emotion';
import { emphasisOf } from '../../src/content/text/cleanup';
import { cleanCues } from '../../src/content/pipeline';
import { mergeSentences } from '../../src/content/captions';
import type { EmotionStyle, Line } from '../../src/shared/types';

const L = (source: string, text: string, extra: Partial<Line> = {}): Line => ({ id: 'x', start: 0, end: 3, source, text, ...extra });

describe('analyzeEmotion: MrBeast / NBA fixtures', () => {
  const cases: [string, string, Partial<Line>, EmotionStyle][] = [
    ['Today we are going to the store.', "Aujourd'hui, on va au magasin.", {}, 'neutral'],
    ['I just gave him $10,000!', 'Je viens de lui donner 10 000 dollars !', {}, 'excited'],
    ['Oh my god, this is insane!', "Oh mon dieu, c'est incroyable !", {}, 'excited'],
    ['Do you want the money?', "Tu veux l'argent ?", {}, 'question'],
    ['Wait, what?!', 'Attends, quoi ?!', {}, 'surprised'],
    ["No way, are you serious? You won!", 'Pas possible, sérieux ? Tu as gagné !', {}, 'surprised'],
    ['I just bought the world\'s largest pizza!', "Je viens d'acheter la plus grande pizza du monde !", { shout: true }, 'shout'],
    ['Last to leave the circle wins $500,000!!!', 'Le dernier à quitter le cercle gagne 500 000 dollars !!!', {}, 'shout'],
    ['Let\'s gooo', "C'est parti", {}, 'excited'],
    ['Curry from downtown, bang!', 'Curry à trois points, bang !', {}, 'excited'],
    ['And one! He gets the bucket and the foul', 'Et un ! Il marque et obtient la faute', {}, 'excited'],
    ['LeBron with the dunk', 'LeBron avec le dunk', {}, 'excited'],
    ['Thank you so much, I love you guys.', 'Merci beaucoup, je vous aime.', {}, 'happy'],
    ['Unfortunately he lost everything.', 'Malheureusement, il a tout perdu.', {}, 'sad'],
    ['Okay, let me explain the rules slowly...', 'Bon, je vous explique les règles doucement...', {}, 'calm'],
  ];
  it.each(cases)('%s → %s', (src, fr, extra, want) => {
    const e = analyzeEmotion(L(src, fr, extra));
    expect(e.style).toBe(want);
    expect(e.intensity).toBeGreaterThanOrEqual(0);
    expect(e.intensity).toBeLessThanOrEqual(1);
  });

  it('works on French-only lines (tlang track, no English source)', () => {
    expect(analyzeEmotion({ text: 'Waouh, il a gagné un million de dollars !' }).style).toBe('excited');
    expect(analyzeEmotion({ text: 'Tu es prêt ?' }).style).toBe('question');
    expect(analyzeEmotion({ text: 'On va au parc.' }).style).toBe('neutral');
  });

  it('excited lines are more intense with more cues', () => {
    const a = analyzeEmotion(L('Nice shot!', 'Joli tir !'));
    const b = analyzeEmotion(L('WOW, $1,000,000!', 'Waouh, un million de dollars !', { emph: ['wow'] }));
    expect(b.intensity).toBeGreaterThan(a.intensity);
  });

  it('helpers: money hype and stretched letters', () => {
    expect(numberHype('$1,000,000')).toBeGreaterThan(0.6);
    expect(numberHype('10 000 dollars')).toBeGreaterThan(0.5);
    expect(numberHype('3 apples')).toBe(0);
    expect(stretched('sooo good')).toBe(true);
    expect(stretched('good')).toBe(false);
  });
});

describe('caps emphasis captured before cleanup', () => {
  it('emphasisOf: shouted line vs emphasis words, acronyms ignored', () => {
    expect(emphasisOf("I JUST BOUGHT THE WORLD'S LARGEST PIZZA!")).toEqual({ shout: true, emph: [] });
    expect(emphasisOf('This is INSANE, Chandler! The NBA MVP is here.')).toEqual({ shout: false, emph: ['insane'] });
    expect(emphasisOf('I am here')).toEqual({ shout: false, emph: [] });
  });

  it('flags survive cleanCues → mergeSentences (text is de-shouted)', () => {
    const cues = cleanCues([
      { start: 0, end: 2, text: 'This is INSANE,' },
      { start: 2, end: 4, text: 'Chandler!' },
      { start: 5, end: 7, text: 'LAST TO LEAVE WINS!' },
    ], 'en');
    const lines = mergeSentences(cues, 'en');
    expect(lines[0].text).toBe('This is incredible, Chandler!');
    expect(lines[0].emph).toEqual(['insane']);
    expect(lines[0].shout).toBeUndefined();
    expect(lines[1].shout).toBe(true);
  });

  it('emphasis words are mapped onto the French text', () => {
    const w = emphasisWords({ source: 'This is INSANE, he won $10,000', text: "C'est incroyable, il a gagné 10 000 dollars", emph: ['insane'] });
    expect(w[0]).toBe('incroyable');
    expect(w).toContain('10');
    expect(w.length).toBeLessThanOrEqual(3);
  });
});

describe('annotateEmotions + Nano tags', () => {
  it('adds emotion to every line, keeps ids/order, idempotent', () => {
    const lines = [L('Hi.', 'Salut.', { id: 'a' }), L('Wow!', 'Waouh !', { id: 'b' })];
    const out = annotateEmotions(lines);
    expect(out.map((l) => l.id)).toEqual(['a', 'b']);
    expect(out.every((l) => l.emotion)).toBe(true);
    expect(annotateEmotions(out)[1]).toBe(out[1]);
  });

  it('mergeTag: Nano decides weak lines, strong text cues win', () => {
    const weak = analyzeEmotion(L('We are here.', 'On est là.'));
    expect(mergeTag(weak, { style: 'excited', intensity: 0.8 }).style).toBe('excited');
    const q = analyzeEmotion(L('Are you ready?', 'Tu es prêt ?'));
    expect(mergeTag(q, { style: 'calm', intensity: 0.3 }).style).toBe('question');
  });

  it('parseTags tolerates model formatting', () => {
    expect(parseTags('1: excited 0.9\n2) **question** 0,5\n3: angry 1\nnoise', 3)).toEqual([
      { style: 'excited', intensity: 0.9 }, { style: 'question', intensity: 0.5 }, null,
    ]);
  });

  it('EmotionTagger batches ahead of playback, never blocks, turns off after failures', async () => {
    vi.useFakeTimers();
    const tag = vi.fn(async (texts: string[]) => texts.map(() => ({ style: 'excited' as const, intensity: 0.7 })));
    const onChange = vi.fn();
    const lines = Array.from({ length: 20 }, (_, i) => L(`Line number ${i}.`, `Ligne ${i}.`, { id: `l${i}`, start: i, end: i + 1 }));
    const t = new EmotionTagger({ tag, onChange, batch: 8, debounceMs: 10 });
    t.feed(lines, 10);
    await vi.advanceTimersByTimeAsync(50);
    expect(tag).toHaveBeenCalledTimes(3);
    expect(tag.mock.calls[0][0][0]).toBe('Line number 9.'); // from the playhead forward first (line 9 ends at 10)
    expect(t.tags.size).toBe(20);
    expect(onChange).toHaveBeenCalled();
    const bad = new EmotionTagger({ tag: async () => { throw new Error('no model'); }, onChange, batch: 2 });
    bad.feed(lines, 0);
    await vi.advanceTimersByTimeAsync(50);
    expect(bad.isDisabled).toBe(true);
    vi.useRealTimers();
  });
});
