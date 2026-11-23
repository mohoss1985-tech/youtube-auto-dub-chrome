// B: voice ranking, gender table, pickVoiceFor stability.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import {
  genderFromName, rankWebVoices, chooseVoice, pickVoiceFor, pickBestVoice, listVoices, resetVoiceChoices,
  gendersOf, OPENAI_VOICES,
} from '../../src/content/voice/voices';

type V = { name: string; lang: string; voiceURI: string; localService: boolean; default: boolean };
const v = (name: string, lang: string, localService = true): V => ({ name, lang, voiceURI: name, localService, default: false });

const VOICES: V[] = [
  v('Thomas', 'fr-FR'), v('Amélie', 'fr-CA'), v('Audrey (Enhanced)', 'fr-FR'), v('Google français', 'fr-FR', false),
  v('Microsoft Denise Online (Natural) - French (France)', 'fr-FR', false), v('Jacques', 'fr-FR'),
  v('Maged', 'ar-SA'), v('Laila', 'ar_SA'), v('Majed (Premium)', 'ar-SA'),
  v('Yelda', 'tr-TR'), v('Cem', 'tr-TR'),
  v('Samantha', 'en-US'), v('Daniel', 'en-GB'), v('Google UK English Male', 'en-GB', false), v('Zarvox', 'en-US'),
  v('Bad News', 'en-US'), v('Grandpa (English (US))', 'en-US'),
  v('Mónica', 'es-ES'), v('Jorge', 'es-ES'), v('Paulina', 'es-MX'),
];

function installSynth(list: V[]) {
  (globalThis as any).speechSynthesis = {
    getVoices: () => list,
    addEventListener() {}, removeEventListener() {},
    speak() {}, cancel() {}, pause() {}, resume() {}, speaking: false, pending: false,
  };
}

describe('gender table', () => {
  it.each([
    ['Thomas', 'male'], ['Amélie', 'female'], ['Audrey (Enhanced)', 'female'], ['Aurélie', 'female'],
    ['Maged', 'male'], ['Majed (Premium)', 'male'], ['Laila', 'female'], ['Tarik', 'male'], ['Mariam', 'female'],
    ['Yelda', 'female'], ['Cem', 'male'], ['Jorge', 'male'], ['Mónica', 'female'], ['Paulina', 'female'],
    ['Juan', 'male'], ['Diego', 'male'], ['Daniel (English (UK))', 'male'], ['Samantha', 'female'], ['Alex', 'male'],
    ['Karen', 'female'], ['Moira', 'female'], ['Fred', 'male'], ['Tom', 'male'], ['Ava (Premium)', 'female'],
    ['Allison', 'female'], ['Google UK English Female', 'female'], ['Google UK English Male', 'male'],
    ['Google français', 'unknown'], ['Google US English', 'unknown'], ['Xyzzy', 'unknown'],
    ['Microsoft Henri Online (Natural) - French (France)', 'male'],
  ])('%s → %s', (name, g) => expect(genderFromName(name)).toBe(g));
});

describe('ranking', () => {
  it('puts Natural/Enhanced/Google first and filters by language', () => {
    const fr = rankWebVoices(VOICES as unknown as SpeechSynthesisVoice[], 'fr');
    expect(fr.map((x) => x.name).slice(0, 3)).toEqual([
      'Microsoft Denise Online (Natural) - French (France)', 'Audrey (Enhanced)', 'Google français',
    ]);
    expect(fr.every((x) => x.lang.startsWith('fr'))).toBe(true);
    expect(fr.find((x) => x.name === 'Thomas')!.gender).toBe('male');
  });
  it('accepts ar_SA style tags; Premium first', () => {
    const ar = rankWebVoices(VOICES as unknown as SpeechSynthesisVoice[], 'ar');
    expect(ar.map((x) => x.name)).toEqual(['Majed (Premium)', 'Laila', 'Maged']);
  });
  it('drops novelty voices and ranks Eloquence low', () => {
    const en = rankWebVoices(VOICES as unknown as SpeechSynthesisVoice[], 'en').map((x) => x.name);
    expect(en).not.toContain('Zarvox');
    expect(en).not.toContain('Bad News');
    expect(en[0]).toBe('Google UK English Male');
    expect(en.at(-1)).toBe('Grandpa (English (US))');
  });
});

describe('pickVoiceFor', () => {
  beforeEach(() => { installChromeMock(); installSynth(VOICES); resetVoiceChoices(); });
  afterEach(() => { delete (globalThis as any).speechSynthesis; });

  it('returns a voice of the requested gender and the same one every call', async () => {
    const m1 = await pickVoiceFor('fr', 'male');
    const f1 = await pickVoiceFor('fr', 'female');
    expect(m1!.gender).toBe('male');
    expect(['female', 'unknown']).toContain(f1!.gender);
    for (let i = 0; i < 5; i++) {
      expect((await pickVoiceFor('fr', 'male'))!.id).toBe(m1!.id);
      expect((await pickVoiceFor('fr', 'female'))!.id).toBe(f1!.id);
    }
  });

  it('honours the user chosen voice for its own gender (from settings)', async () => {
    installChromeMock({ settings: { voiceByLang: { fr: 'Thomas' } } });
    expect((await pickVoiceFor('fr', 'male'))!.id).toBe('Thomas');
    expect((await pickVoiceFor('fr', 'female'))!.gender).not.toBe('male');
    expect((await pickBestVoice('fr'))!.id).toBe('Thomas');
    expect((await pickVoiceFor('fr', 'unknown'))!.id).toBe('Thomas');
  });

  it('prefers exact gender over unknown (Google) when asked for female', () => {
    const list = rankWebVoices(VOICES.filter((x) => !x.name.includes('Denise')) as unknown as SpeechSynthesisVoice[], 'fr');
    expect(list[0].name).toBe('Audrey (Enhanced)');
    expect(chooseVoice(list, 'female')!.name).toBe('Audrey (Enhanced)');
    const onlyGoogle = rankWebVoices([v('Google français', 'fr-FR', false), v('Thomas', 'fr-FR')] as unknown as SpeechSynthesisVoice[], 'fr');
    expect(chooseVoice(onlyGoogle, 'female')!.name).toBe('Google français');
    expect(chooseVoice(onlyGoogle, 'male')!.name).toBe('Thomas');
  });

  it('falls back to best voice when the gender is not installed', async () => {
    installSynth([v('Yelda', 'tr-TR')]);
    expect((await pickVoiceFor('tr', 'male'))!.name).toBe('Yelda');
    expect(gendersOf(await listVoices('tr'))).toEqual({ male: false, female: true });
  });

  it('returns null when no voice exists for the language', async () => {
    installSynth([v('Samantha', 'en-US')]);
    expect(await pickVoiceFor('ar', 'male')).toBeNull();
    expect(await pickBestVoice('ar')).toBeNull();
  });

  it('API voices carry gender labels', async () => {
    const oa = await listVoices('fr', 'openai');
    expect(oa.length).toBe(OPENAI_VOICES.length);
    expect((await pickVoiceFor('fr', 'male', 'openai'))!.gender).toBe('male');
    expect((await pickVoiceFor('ar', 'female', 'elevenlabs'))!.gender).toBe('female');
  });
});
