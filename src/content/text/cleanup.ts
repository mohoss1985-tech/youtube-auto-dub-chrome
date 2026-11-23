// Source-text cleanup before translation / TTS (v1.1, owner F). Pure module (no DOM, no chrome.*).
// English captions (MrBeast, NBA…): drop non-speech tags, fillers, stutters; shouting ALL CAPS → sentence case.
// Numbers, money and names are kept as-is for the translator (glossary.ts makes the French TTS-friendly).

/** Acronyms kept upper-case when de-shouting (spelled by TTS on purpose). */
export const ACRONYMS = new Set([
  'NBA', 'WNBA', 'NFL', 'NHL', 'MLB', 'MLS', 'UFC', 'WWE', 'ESPN', 'MVP', 'GOAT', 'USA', 'UK', 'EU', 'TV', 'DJ', 'OK', 'ID', 'CEO',
  'GPS', 'PS5', 'PS4', 'PC', 'AI', 'FBI', 'CIA', 'NASA', 'UFO', 'DM', 'VIP', 'HQ', 'ATM', 'IQ', 'LA', 'NYC', 'DC', 'OT', 'PG', 'SG', 'SF',
  'PF', 'TNT', 'ABC', 'BBC', 'CNN', 'HBO', 'XL', 'XXL', 'YT', 'ASAP', 'DIY', 'RV', 'SUV', 'BMW', 'NCAA', 'AAU',
]);

/** Proper casing restored after lower-casing a shouted line. Keys are lower case. */
export const PROPER: Readonly<Record<string, string>> = {
  mrbeast: 'MrBeast', beast: 'Beast', jimmy: 'Jimmy', chandler: 'Chandler', karl: 'Karl', nolan: 'Nolan', tareq: 'Tareq', chris: 'Chris',
  lebron: 'LeBron', james: 'James', steph: 'Steph', curry: 'Curry', kobe: 'Kobe', bryant: 'Bryant', jordan: 'Jordan', michael: 'Michael',
  shaq: 'Shaq', giannis: 'Giannis', luka: 'Luka', doncic: 'Doncic', dončić: 'Dončić', durant: 'Durant', kevin: 'Kevin', wemby: 'Wemby',
  wembanyama: 'Wembanyama', victor: 'Victor', jokic: 'Jokic', jokić: 'Jokić', embiid: 'Embiid', tatum: 'Tatum', jayson: 'Jayson',
  lakers: 'Lakers', celtics: 'Celtics', warriors: 'Warriors', bulls: 'Bulls', knicks: 'Knicks', heat: 'Heat', spurs: 'Spurs', nuggets: 'Nuggets',
  youtube: 'YouTube', america: 'America', american: 'American', christmas: 'Christmas', monday: 'Monday', friday: 'Friday', sunday: 'Sunday',
  saturday: 'Saturday', god: 'God', feastables: 'Feastables', lamborghini: 'Lamborghini', tesla: 'Tesla', iphone: 'iPhone',
};

const FILLER_RE = [
  // Pure hesitation sounds (any position).
  /(^|[\s,.!?])(?:u+m+|u+h+m*|e+r+m+|e+r+|h+m+|m+h*m+)(?=$|[\s,.!?])/giu,
];

/** "you know", "I mean", "like" only when they are fillers (comma-bounded or opening a sentence with a comma). */
function dropPhraseFillers(t: string): string {
  let s = t;
  // ", you know," / ", I mean," / ", like," in the middle → ","
  s = s.replace(/,\s*(?:you know|i mean|like|kinda like|sort of like|basically|literally)\s*,/giu, ',');
  // Sentence start: "You know, …" "I mean, …" "Like, …" "So, like, …"
  s = s.replace(/(^|[.!?]\s+)(?:so,?\s+)?(?:you know|i mean|like|basically|okay so|ok so)\s*,\s*/giu, '$1');
  // Sentence end: "…, you know." "…, like?"
  s = s.replace(/,\s*(?:you know|right)\s*\?/giu, '.'); // tag question, not a real question
  s = s.replace(/,\s*(?:you know|like|i mean|right)\s*([.!?]|$)/giu, '$1');
  // "like" between "was"/"is" and a quote-like continuation ("he was like, ...") is speech framing; keep it.
  return s;
}

const NORMALISE: [RegExp, string][] = [
  [/\bkinda\b/giu, 'kind of'],
  [/\bsorta\b/giu, 'sort of'],
  [/\bgonna\b/giu, 'going to'],
  [/\bwanna\b/giu, 'want to'],
  [/\bgotta\b/giu, 'have to'],
  [/\bgimme\b/giu, 'give me'],
  [/\blemme\b/giu, 'let me'],
  [/\bdunno\b/giu, "don't know"],
  [/\b'?cause\b/giu, 'because'],
  [/\bya\b/giu, 'you'],
  [/\by'all\b/giu, 'you all'],
];

/** "I- I- I think" → "I think", "w-what" → "what", "the the" → "the". */
export function dropStutters(t: string): string {
  let s = t;
  // Word-dash repeats: "I- I- I" / "we— we"
  s = s.replace(/\b([\p{L}']+)(?:[-–—]\s*\1\b)+/giu, '$1');
  s = s.replace(/\b([\p{L}']+)[-–—]\s+(?=\1\b)/giu, '');
  // Partial-word stutter: "w-what", "b-b-but"
  s = s.replace(/\b(\p{L}{1,2})(?:-\1)*-(\1\p{L}*)/giu, (all, a: string, w: string) => (w.toLowerCase().startsWith(a.toLowerCase()) ? w : all));
  // Immediate repeats ("the the", "I I I"), not numbers.
  s = s.replace(/\b(\p{L}+)(?:\s+\1\b)+/giu, (all, w: string) => (/^(no|yes|go|very|so|bye|ha|really|wow)$/i.test(w) ? all : w));
  return s;
}

const isLetter = (c: string) => /\p{L}/u.test(c);

/** True when most letters are upper case (a shouted line). */
export function isShouting(t: string): boolean {
  const letters = [...t].filter(isLetter);
  if (letters.length < 6) return false;
  const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  return upper / letters.length >= 0.6;
}

/** Shouted line → sentence case; in a normal line only long ALL-CAPS emphasis words ("INSANE") are lowered. Acronyms kept. */
export function deShout(t: string): string {
  const shouting = isShouting(t);
  let changed = false;
  let s = t.replace(/[\p{L}][\p{L}\d'’]*/gu, (w) => {
    const letters = w.replace(/[^\p{L}]/gu, '');
    const allCaps = (letters.length > 1 || (shouting && letters === 'A')) && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
    if (!allCaps) return w;
    if (ACRONYMS.has(w.toUpperCase().replace(/['’]S$/u, ''))) return w;
    if (!shouting && letters.length < 4) return w; // GPS, NBA-like unknown acronyms in a normal line
    changed = true;
    const low = w.toLowerCase();
    return PROPER[low] ?? (low === "i" ? 'I' : low);
  });
  if (!changed) return s;
  // Re-capitalise "I", sentence starts and known names.
  s = s.replace(/\bi\b(?=['’\s,.!?]|$)/gu, 'I');
  s = s.replace(/(^|[.!?…]\s+)(["'“]?)(\p{Ll})/gu, (_a, p: string, q: string, c: string) => p + q + c.toUpperCase());
  return s;
}

/** True for a caption that is only a non-speech annotation or lyrics. */
export function isNonSpeech(t: string): boolean {
  const s = t.trim();
  if (!s) return true;
  if (/^[♪♫♬]/u.test(s) || /[♪♫♬]$/u.test(s)) return true;
  return /^[[(][^\])]*[\])]$/u.test(s);
}

/**
 * Clean one source caption/line for translation. Language-aware for English; other languages only get
 * tag removal, stutters and de-shouting. Returns '' when nothing speakable is left.
 */
export function cleanSourceText(raw: string, lang: string): string {
  let t = String(raw ?? '');
  // Non-speech tags that survived parsing, and lyrics.
  t = t.replace(/[♪♫♬][^♪♫♬]*[♪♫♬]/gu, ' ');
  if (/[♪♫♬]/u.test(t)) return '';
  t = t.replace(/\[[^\]]{0,60}\]/gu, ' ').replace(/\((?:music|applause|laughter|laughs|laughing|cheering|cheers|crowd \w+|gasps|sighs|inaudible|chuckles|screams?|screaming)\)/giu, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const en = /^en\b/i.test(lang);
  if (en) {
    for (const re of FILLER_RE) t = t.replace(re, '$1');
    t = dropPhraseFillers(t);
    for (const [re, to] of NORMALISE) t = t.replace(re, (m) => keepCase(m, to));
  }
  t = dropStutters(t);
  t = deShout(t);
  // Tidy punctuation left behind by removals.
  t = t
    .replace(/^fr\b/i.test(lang) ? /\s+([,.])/g : /\s+([,.!?;:])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:.-]+/u, '')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\p{L}|\d/u.test(t)) return '';
  // Capitalise the first letter if the cleanup removed the original start.
  if (en && /^\p{Ll}/u.test(t) && /^\p{Lu}/u.test(String(raw).replace(/^[^\p{L}]+/u, ''))) t = t[0]!.toUpperCase() + t.slice(1);
  return t;
}

function keepCase(src: string, to: string): string {
  return /^\p{Lu}/u.test(src) ? to[0]!.toUpperCase() + to.slice(1) : to;
}

/**
 * v1.2 (E): emphasis written in the ORIGINAL caption, read before `deShout` removes it.
 * `shout` = mostly capitals; `emph` = lower-cased ALL-CAPS words (2+ letters, not known acronyms) of a normal line.
 */
export function emphasisOf(raw: string): { shout: boolean; emph: string[] } {
  const t = String(raw ?? '').replace(/\[[^\]]{0,60}\]|\([^)]{0,40}\)/gu, ' ');
  const shout = isShouting(t);
  const emph: string[] = [];
  if (!shout) {
    for (const w of t.match(/[\p{L}][\p{L}'’]*/gu) ?? []) {
      const letters = w.replace(/[^\p{L}]/gu, '');
      if (letters.length < 2 || letters !== letters.toUpperCase() || letters === letters.toLowerCase()) continue;
      if (ACRONYMS.has(w.toUpperCase().replace(/['’]S$/u, ''))) continue;
      const low = w.toLowerCase();
      if (low !== 'i' && !emph.includes(low)) emph.push(low);
    }
  }
  return { shout, emph };
}
