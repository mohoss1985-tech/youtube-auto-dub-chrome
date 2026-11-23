import { describe, it, expect } from 'vitest';
import { cleanSourceText } from '../../src/content/text/cleanup';

const c = (t: string) => cleanSourceText(t, 'en');
describe('v1.2.1 slang → plain English before offline translation', () => {
  it('NBA slang', () => {
    expect(c('Steph Curry pulls up from half court and it is good!')).toBe('Steph Curry shoots from the middle of the court and it goes in!');
    expect(c('Down by three with ten seconds left')).toBe('Losing by three points with ten seconds remaining');
    expect(c('He drains it from downtown')).toBe('He scores from very far away');
  });
  it('MrBeast slang', () => {
    expect(c('Give it up for the winner!')).toBe('Applause for the winner!');
    expect(c("Let's go!")).toBe('Come on!');
    expect(c('This is insane')).toBe('This is incredible');
  });
  it('leaves normal sentences alone', () => {
    expect(c('I just bought a private island!')).toBe('I just bought a private island!');
  });
});
