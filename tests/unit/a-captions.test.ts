// Owner A: parseJson3, mergeSentences, pickTrack, URL rewrite, speaker labels, audio tracks, page helpers.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanCueText, endsSentence, genderFromLabel, listAudioTracks, mergeSentences, parseJson3, pickTrack,
  rewriteTimedtextUrl, splitLongText, timedtextVideoId,
} from '../../src/content/captions';
import { getVideoId, isWatchPage } from '../../src/content/yt';
import type { CaptionTrack, Cue, Json3 } from '../../src/shared/types';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8')) as Json3;

describe('parseJson3', () => {
  it('human track: drops header/no-segs and "\\n" events, strips labels, caps end at next start', () => {
    const cues = parseJson3(fx('json3-human-en.json'));
    expect(cues.map((c) => c.text)).toEqual([
      'Hello everyone, and welcome',
      'to our garden.',
      'Today we plant tomatoes. Ready?',
      "Yes! Let's go, Mr. Brown is here",
      'with the seeds.',
      'First, dig a small hole',
      'about this deep.',
    ]);
    expect(cues[0]).toMatchObject({ start: 3.1, end: 5.5, gender: 'female', newSpeaker: true });
    expect(cues[3]).toMatchObject({ start: 9.3, end: 12, gender: 'male', newSpeaker: true }); // 12.3 capped to 12.0
    expect(cues[4]!.gender).toBe('male'); // label carries over
  });

  it('ASR track: joins word segs, ignores append "\\n" events and [Music]', () => {
    const cues = parseJson3(fx('json3-asr-en.json'));
    expect(cues.map((c) => c.text)).toEqual(['so today we are going', 'to build a little robot', 'with cardboard', 'first cut the box', 'then paint it']);
    expect(cues[0]!.end).toBeCloseTo(2.01);
    for (const c of cues) expect(c.end).toBeGreaterThanOrEqual(c.start);
  });

  it('handles empty / missing events', () => {
    expect(parseJson3({ events: [] })).toEqual([]);
    expect(parseJson3({} as Json3)).toEqual([]);
  });
});

describe('mergeSentences', () => {
  it('human: sentence punctuation, internal splits, abbreviations, gap > 1.2 s, speaker change', () => {
    const lines = mergeSentences(parseJson3(fx('json3-human-en.json')), 'en');
    expect(lines.map((l) => l.text)).toEqual([
      'Hello everyone, and welcome to our garden.',
      'Today we plant tomatoes.',
      'Ready?',
      'Yes!',
      "Let's go, Mr. Brown is here with the seeds.",
      'First, dig a small hole',
      'about this deep.',
    ]);
    expect(lines[0]).toMatchObject({ start: 3.1, end: 7.5, gender: 'female' });
    expect(lines[3]!.gender).toBe('male');
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.start).toBeGreaterThanOrEqual(lines[i - 1]!.start);
  });

  it('never splits mid-sentence when cues continue without a gap', () => {
    const cues: Cue[] = [
      { start: 0, end: 1, text: 'The quick brown fox' },
      { start: 1, end: 2, text: 'jumps over' },
      { start: 2.5, end: 3, text: 'the lazy dog.' },
      { start: 3, end: 4, text: 'Then it sleeps.' },
    ];
    expect(mergeSentences(cues, 'en').map((l) => l.text)).toEqual(['The quick brown fox jumps over the lazy dog.', 'Then it sleeps.']);
  });

  it('ASR: splits on gap > 0.7 s (auto-detected: no punctuation)', () => {
    const lines = mergeSentences(parseJson3(fx('json3-asr-en.json')), 'en');
    expect(lines.map((l) => l.text)).toEqual(['so today we are going to build a little robot with cardboard', 'first cut the box', 'then paint it']);
  });

  it('ASR: 120-char cap', () => {
    const cues: Cue[] = Array.from({ length: 20 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.5, text: 'word word word' }));
    const lines = mergeSentences(cues, 'en', { asr: true });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(120);
  });

  it('180-char cap on punctuated text and ~12 s cap', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ start: i * 0.3, end: i * 0.3 + 0.3, text: 'and then more words,' }));
    // force punctuated mode
    const lines = mergeSentences(long, 'en', { asr: false });
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(180);
    const slow: Cue[] = Array.from({ length: 10 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: 'ok,' }));
    for (const l of mergeSentences(slow, 'en', { asr: false })) expect(l.end - l.start).toBeLessThanOrEqual(12);
  });

  it('a single cue longer than the cap is split into timed chunks', () => {
    const text = Array.from({ length: 50 }, () => 'lorem').join(' ') + '.';
    const lines = mergeSentences([{ start: 0, end: 10, text }], 'en', { asr: false });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.start).toBe(0);
    expect(lines.at(-1)!.end).toBe(10);
    expect(lines.map((l) => l.text).join(' ')).toBe(text);
  });

  it('Arabic / CJK punctuation', () => {
    const lines = mergeSentences([{ start: 0, end: 1, text: 'كيف حالك؟' }, { start: 1, end: 2, text: 'أنا بخير.' }], 'ar', { asr: false });
    expect(lines.map((l) => l.text)).toEqual(['كيف حالك؟', 'أنا بخير.']);
    expect(endsSentence('今日は。')).toBe(true);
    expect(endsSentence('Mr.')).toBe(false);
    expect(endsSentence('He said "go."')).toBe(true);
  });

  it('splitLongText prefers commas then spaces', () => {
    const parts = splitLongText('aaaa bbbb cccc, dddd eeee ffff gggg', 20);
    expect(parts[0]).toBe('aaaa bbbb cccc,');
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(20);
  });
});

describe('speaker labels → gender', () => {
  it('reads labels in the 5 languages', () => {
    expect(genderFromLabel('Man')).toBe('male');
    expect(genderFromLabel('Woman narrator')).toBe('female');
    expect(genderFromLabel('homme')).toBe('male');
    expect(genderFromLabel('femme')).toBe('female');
    expect(genderFromLabel('mujer')).toBe('female');
    expect(genderFromLabel('erkek')).toBe('male');
    expect(genderFromLabel('kadın')).toBe('female');
    expect(genderFromLabel('رجل')).toBe('male');
    expect(genderFromLabel('امرأة')).toBe('female');
    expect(genderFromLabel('Music')).toBeUndefined();
    expect(genderFromLabel('man and woman')).toBeUndefined();
  });

  it('cleanCueText strips labels and sound tags', () => {
    expect(cleanCueText('(homme) Bonjour !')).toEqual({ text: 'Bonjour !', gender: 'male', newSpeaker: true });
    expect(cleanCueText('(Femme) Salut')).toMatchObject({ text: 'Salut', gender: 'female' });
    expect(cleanCueText('♪ la la ♪')).toMatchObject({ text: '' }); // v1.1: lyrics are not dubbed
    expect(cleanCueText('(rires)').text).toBe('');
    expect(cleanCueText('JOHN: Hi there')).toMatchObject({ text: 'Hi there', newSpeaker: true });
    expect(cleanCueText('- ¿Qué tal?')).toMatchObject({ text: '¿Qué tal?', newSpeaker: true });
    expect(cleanCueText('I said (quietly, to myself) no').text).toBe('I said (quietly, to myself) no');
  });

  it('a label applies to following cues until the next speaker change', () => {
    const cues = parseJson3({ events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '[Girl] I like cats.' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'They are soft.' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '>> Me too.' }] },
    ] });
    const lines = mergeSentences(cues, 'en');
    expect(lines.map((l) => l.gender)).toEqual(['female', 'female', undefined]);
  });
});

describe('pickTrack', () => {
  const t = (languageCode: string, asr = false): CaptionTrack => ({
    baseUrl: `https://www.youtube.com/api/timedtext?v=x&lang=${languageCode}`, languageCode, vssId: (asr ? 'a.' : '.') + languageCode, ...(asr ? { kind: 'asr' } : {}),
  });
  it('human in target > human other > ASR in target > ASR', () => {
    expect(pickTrack([t('en', true), t('en'), t('fr-FR')], 'fr')!.vssId).toBe('.fr-FR');
    expect(pickTrack([t('fr', true), t('en')], 'fr')!.vssId).toBe('.en');
    expect(pickTrack([t('en', true), t('fr', true)], 'fr')!.vssId).toBe('a.fr');
    expect(pickTrack([t('en', true)], 'tr')!.vssId).toBe('a.en');
    expect(pickTrack([], 'fr')).toBeNull();
  });
  it('treats vssId "a." as ASR even without kind', () => {
    const asrNoKind: CaptionTrack = { baseUrl: 'u', languageCode: 'fr', vssId: 'a.fr' };
    expect(pickTrack([asrNoKind, t('en')], 'fr')!.vssId).toBe('.en');
  });
});

describe('timedtext URL rewrite', () => {
  const url = 'https://www.youtube.com/api/timedtext?v=abcdefghijk&ei=E1&caps=asr&opi=1&exp=xpe&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=1&sparams=ip,ipbits,expire,v,ei,caps,opi,exp,xoaf&signature=SIG.123&key=yt8&kind=asr&lang=en&potc=1&pot=MnT0k%2Bab%2Fcd%3D%3D&fmt=srv3&xorb=2&c=WEB&cver=2.2026';
  it('keeps pot/c/exp/signature, sets fmt=json3 and tlang', () => {
    const out = new URL(rewriteTimedtextUrl(url, { tlang: 'fr' }));
    const src = new URL(url);
    for (const k of ['pot', 'c', 'exp', 'signature', 'potc', 'sparams', 'ei', 'kind', 'lang']) expect(out.searchParams.get(k)).toBe(src.searchParams.get(k));
    expect(out.searchParams.get('pot')).toBe('MnT0k+ab/cd==');
    expect(out.searchParams.get('fmt')).toBe('json3');
    expect(out.searchParams.get('tlang')).toBe('fr');
  });
  it('removes tlang and retargets lang/kind', () => {
    const out = new URL(rewriteTimedtextUrl(url + '&tlang=ar', { lang: 'es', kind: null }));
    expect(out.searchParams.has('tlang')).toBe(false);
    expect(out.searchParams.has('kind')).toBe(false);
    expect(out.searchParams.get('lang')).toBe('es');
    expect(out.searchParams.get('pot')).toBe('MnT0k+ab/cd==');
  });
  it('timedtextVideoId', () => {
    expect(timedtextVideoId(url)).toBe('abcdefghijk');
    expect(timedtextVideoId('https://www.youtube.com/watch?v=abc')).toBeNull();
  });
});

describe('audio tracks + page helpers', () => {
  it('listAudioTracks lists alternatives, [] for a single track', () => {
    const pr = { streamingData: { adaptiveFormats: [
      { audioTrack: { id: 'en.4', displayName: 'English (original)', audioIsDefault: true } },
      { audioTrack: { id: 'en.4', displayName: 'English (original)', audioIsDefault: true } },
      { audioTrack: { id: 'fr.3', displayName: 'French (dubbed-auto)' } },
      { itag: 137 },
    ] } };
    expect(listAudioTracks(pr)).toEqual([
      { languageCode: 'en', displayName: 'English (original)', isDefault: true },
      { languageCode: 'fr', displayName: 'French (dubbed-auto)', isAutoDubbed: true },
    ]);
    expect(listAudioTracks({ streamingData: { adaptiveFormats: [{ audioTrack: { id: 'en.4' } }] } })).toEqual([]);
    expect(listAudioTracks(null)).toEqual([]);
  });
  it('getVideoId / isWatchPage exclude Shorts, embed, mobile', () => {
    expect(getVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(isWatchPage('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(false);
    expect(isWatchPage('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(false);
    expect(isWatchPage('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isWatchPage('https://www.youtube.com/')).toBe(false);
  });
});
