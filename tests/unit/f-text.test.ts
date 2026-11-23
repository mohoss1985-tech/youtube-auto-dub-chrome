// F (v1.1): English source cleanup + French TTS glossary, on MrBeast-style and NBA-style captions.
import { describe, it, expect } from 'vitest';
import { cleanSourceText, deShout, dropStutters, isShouting } from '../../src/content/text/cleanup';
import { frenchForSpeech, frenchNumber, speechFriendly } from '../../src/content/text/glossary';

const NB = ' ';

describe('cleanSourceText (EN)', () => {
  const mrbeast: [string, string][] = [
    ["I JUST BOUGHT THE WORLD'S LARGEST PIZZA!", "I just bought the world's largest pizza!"],
    ["Um, so, like, we're gonna give away $10,000 to whoever stays the longest.", "So, we're going to give away $10,000 to whoever stays the longest."],
    ["I- I- I can't believe it, you know?", "I can't believe it."],
    ['Karl, uh, w-what are you doing?', 'Karl, what are you doing?'],
    ['This is INSANE, Chandler!', 'This is incredible, Chandler!'],
    ['MRBEAST JUST GAVE ME $1.5 MILLION', 'MrBeast just gave me $1.5 million'],
    ["I mean, it's kinda crazy.", "It's kind of crazy."],
  ];
  const nba: [string, string][] = [
    ['LEBRON JAMES WITH THE THREE-POINTER FOR THE WIN!', 'LeBron James with the three-point shot for the win!'],
    ['He hit a 3-pointer at the buzzer, the the crowd went wild.', 'He hit a three-point shot at the buzzer, the crowd got very excited.'],
    ['Stephen Curry scored 62 points vs the Lakers.', 'Stephen Curry scored 62 points vs the Lakers.'],
    ['The NBA MVP, uh, is here.', 'The NBA MVP, is here.'],
  ];
  it.each([...mrbeast, ...nba])('%s', (src, want) => {
    expect(cleanSourceText(src, 'en')).toBe(want);
  });

  it('non-speech tags and lyrics → empty (line dropped)', () => {
    for (const t of ['[Music]', '[Applause]', '(laughter)', '♪ We wish you a merry Christmas ♪', '♪ la la la', 'um', '[Laughter] uh']) {
      expect(cleanSourceText(t, 'en')).toBe('');
    }
    expect(cleanSourceText('[Music] Welcome back!', 'en')).toBe('Welcome back!');
  });

  it('keeps acronyms, numbers and names; normal lines untouched', () => {
    expect(cleanSourceText('We drove to LA in a BMW with 100 people.', 'en')).toBe('We drove to LA in a BMW with 100 people.');
    expect(cleanSourceText('Go go go!', 'en')).toBe('Go go go!');
    expect(isShouting('OK')).toBe(false);
    expect(deShout('WHAT IS GOING ON WITH THE NBA')).toBe('What is going on with the NBA');
    expect(dropStutters('b-b-but we w-won')).toBe('but we won');
  });

  it('other languages: no English filler rules, still de-shouted', () => {
    expect(cleanSourceText('Like, hola.', 'es')).toBe('Like, hola.');
    expect(cleanSourceText("C'EST INCROYABLE !", 'fr')).toBe("C'est incroyable !");
  });
});

describe('frenchForSpeech', () => {
  const cases: [string, string][] = [
    ['Nous allons donner 10 000 $ à celui qui reste.', `Nous allons donner 10${NB}000 dollars à celui qui reste.`],
    ['Nous allons donner 10,000 $ à celui qui reste.', `Nous allons donner 10${NB}000 dollars à celui qui reste.`],
    ['Il a gagné $10,000 !', `Il a gagné 10${NB}000 dollars !`],
    ['Il a gagné $10K !', `Il a gagné 10${NB}000 dollars !`],
    ['MrBeast vient de me donner 1,5 million $', 'Mister Beast vient de me donner 1,5 million de dollars'],
    ['Il a donné $2 million', 'Il a donné 2 millions de dollars'],
    ['Il a 1 $ seulement.', 'Il a 1 dollar seulement.'],
    ['Il a marqué un 3-pointer au buzzer.', 'Il a marqué un tir à trois points au buzzer.'],
    ['LeBron avec le three-pointer pour la victoire !', 'LeBron avec le tir à trois points pour la victoire !'],
    ['Le MVP de la NBA est ici, euh, incroyable.', 'Le M V P de la N B A est ici, incroyable.'],
    ["C'est un buzzer beater incroyable !", "C'est un tir au buzzer incroyable !"],
    ['50% de réduction', `50${NB}pour cent de réduction`],
    ['Il y avait 10,000 personnes.', `Il y avait 10${NB}000 personnes.`],
  ];
  it.each(cases)('%s', (src, want) => expect(frenchForSpeech(src)).toBe(want));

  it('numbers: grouping and decimals', () => {
    expect(frenchNumber('1000000')).toBe(`1${NB}000${NB}000`);
    expect(frenchNumber('1.5')).toBe('1,5');
    expect(frenchNumber('2024')).toBe('2024');
  });

  it('only French is rewritten; never empties a line', () => {
    expect(speechFriendly('The NBA $5', 'en')).toBe('The NBA $5');
    expect(frenchForSpeech('euh')).toBe('euh');
  });
});
