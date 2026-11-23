// Translated French → TTS-friendly French (v1.1, owner F). Pure module.
// Money ("$10,000" → "10 000 dollars"), percent, NBA terms left in English by the translator,
// and names/acronyms pronounced the French way ("NBA" → "N B A", "MrBeast" → "Mister Beast").

const NBSP = ' ';
/** A number as English or French write it: 10,000 · 10 000 · 10 000 · 1.5 · 1,5 · 250. */
const NUM = String.raw`\d{1,3}(?:[,   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;

/** "10,000" / "10 000" / "10000" → "10 000" (NBSP-grouped); "1.5" → "1,5". */
export function frenchNumber(raw: string): string {
  let s = raw.trim();
  let int = s;
  let dec = '';
  const grouped = /^\d{1,3}(?:[,   ]\d{3})+/.exec(s);
  if (grouped) {
    int = grouped[0].replace(/[,   ]/g, '');
    const rest = s.slice(grouped[0].length);
    dec = rest ? rest.slice(1) : '';
  } else {
    const m = /^(\d+)(?:[.,](\d+))?$/.exec(s);
    if (!m) return s;
    int = m[1]!;
    dec = m[2] ?? '';
  }
  const g = int.length > 4 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) : int;
  s = dec ? `${g},${dec}` : g;
  return s;
}

const numValue = (raw: string): number => {
  const f = frenchNumber(raw).replace(/ /g, '').replace(',', '.');
  return Number(f);
};

const BIG: Record<string, [string, string]> = {
  k: ['', ''], thousand: ['', ''], mille: ['', ''],
  m: ['million', 'millions'], million: ['million', 'millions'], millions: ['million', 'millions'], mio: ['million', 'millions'],
  b: ['milliard', 'milliards'], billion: ['milliard', 'milliards'], billions: ['milliard', 'milliards'], milliard: ['milliard', 'milliards'], milliards: ['milliard', 'milliards'],
};

function money(num: string, big: string | undefined, currency: 'dollar' | 'euro'): string {
  const unit = currency;
  const b = big ? BIG[big.toLowerCase()] : undefined;
  if (b && b[0] === '') {
    // "$10k" → 10 000 dollars
    const v = Math.round(numValue(num) * 1000);
    return `${frenchNumber(String(v))} ${unit}s`;
  }
  const v = numValue(num);
  const n = frenchNumber(num);
  if (b) return `${n} ${v >= 2 ? b[1] : b[0]} d${/^[aeiou]/.test(unit) ? "'" : 'e '}${unit}s`;
  return `${n} ${unit}${v >= 2 ? 's' : ''}`;
}

const BIG_RE = String.raw`(?:\s?(k|K|M|B|thousand|million|millions|billion|billions|mille|mio|milliard|milliards)\b)?`;

function moneyPass(t: string): string {
  let s = t;
  // $10,000 · $ 1.5 million · $10K · US$ 5
  s = s.replace(new RegExp(String.raw`(?:US)?\$\s?(${NUM})${BIG_RE}(?:\s?(?:de\s)?dollars?\b)?`, 'gu'), (_a, n: string, big?: string) => money(n, big, 'dollar'));
  // 10 000 $ · 1,5 million $ · 1,5 million de $ · 10 000 USD · 10 000 dollars
  s = s.replace(new RegExp(String.raw`(${NUM})${BIG_RE}\s?(?:de\s|d')?(?:\$|USD\b|dollars?\b)`, 'gu'), (_a, n: string, big?: string) => money(n, big, 'dollar'));
  s = s.replace(new RegExp(String.raw`€\s?(${NUM})${BIG_RE}`, 'gu'), (_a, n: string, big?: string) => money(n, big, 'euro'));
  s = s.replace(new RegExp(String.raw`(${NUM})${BIG_RE}\s?(?:d'|de\s)?(?:€|EUR\b|euros?\b)`, 'gu'), (_a, n: string, big?: string) => money(n, big, 'euro'));
  return s;
}

/** English sports / show words the translator left untranslated → French. [pattern, singular, plural]. */
const SPORTS: [RegExp, string][] = [
  [/\b(?:three|3)[- ]pointers\b/giu, 'tirs à trois points'],
  [/\b(?:three|3)[- ]pointer\b/giu, 'tir à trois points'],
  [/\b(?:un|le|du)\s+(?:3|trois)[- ]points?\b(?!\s+(?:de|d'))/giu, 'un tir à trois points'],
  [/\b(?:two|2)[- ]pointer\b/giu, 'tir à deux points'],
  [/\bbuzzer[- ]beaters?\b/giu, 'tir au buzzer'],
  [/\bfree[- ]throws\b/giu, 'lancers francs'],
  [/\bfree[- ]throw\b/giu, 'lancer franc'],
  [/\bhalf[- ]court shots?\b/giu, 'tir du milieu de terrain'],
  [/\bgame[- ]winners?\b/giu, 'panier de la victoire'],
  [/\bslam dunks?\b/giu, 'smash'],
  [/\brebounds\b/giu, 'rebonds'],
  [/\brebound\b/giu, 'rebond'],
  [/\bassists\b/giu, 'passes décisives'],
  [/\bfull[- ]court\b/giu, 'tout le terrain'],
  [/\bhoop\b/giu, 'panier'],
  [/\bplayoffs?\b/giu, 'playoffs'],
  [/\bvs\.?\s/giu, 'contre '],
];

/** Pronunciation for French TTS. Applied last (also changes the subtitle text). */
const SAY: [RegExp, string][] = [
  [/\bMr\.?\s?Beast\b/gu, 'Mister Beast'],
  [/\bWNBA\b/gu, 'W N B A'],
  [/\bNBA\b/gu, 'N B A'],
  [/\bNFL\b/gu, 'N F L'],
  [/\bNCAA\b/gu, 'N C deux A'],
  [/\bMVP\b/gu, 'M V P'],
  [/\bESPN\b/gu, 'E S P N'],
  [/\bUFC\b/gu, 'U F C'],
  [/\bGOAT\b/gu, 'meilleur de tous les temps'],
  [/\bOMG\b/gu, 'oh mon Dieu'],
  [/(\d)\s?%/gu, `$1${NBSP}pour cent`],
  [/\s?&\s?/gu, ' et '],
  [/#(\d+)/gu, 'numéro $1'],
];

/** Hesitations the translator may keep ("euh", "hum"). */
const FR_FILLERS = /(^|[\s,.!?])(?:euh+|heu+|hum+|bah)(?=$|[\s,.!?])/giu;

/** Translated French line → what the French voice should say. Never returns '' for a non-empty input. */
export function frenchForSpeech(text: string): string {
  const orig = String(text ?? '');
  let s = orig;
  s = moneyPass(s);
  for (const [re, to] of SPORTS) s = s.replace(re, to);
  s = s.replace(FR_FILLERS, '$1');
  for (const [re, to] of SAY) s = s.replace(re, to);
  // Bare big English-grouped numbers ("10,000 personnes") → French grouping.
  s = s.replace(/\b\d{1,3}(?:,\d{3})+\b(?![.,]\d)/gu, (m) => frenchNumber(m));
  s = s
    .replace(/\s+([,.])/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/^[\s,;:]+/u, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return s || orig.trim();
}

/** Per-language TTS-friendly pass on translated text (only French for now). */
export function speechFriendly(text: string, lang: string): string {
  return /^fr\b/i.test(lang) ? frenchForSpeech(text) : text;
}
