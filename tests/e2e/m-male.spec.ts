// v1.2.2 (M): male French voice diagnosis + comparison, end to end through the extension (popup → SW → offscreen → worker).
// Renders 6 lines per voice at Expression 0 and 0.7, saves per-line WAVs (research/samples/v122/raw/<tag>/) and one
// listening file per tag (research/samples/v122/<tag>.wav), then measures everything → research/samples/v122/measurements.json.
// Run: node build.mjs --outdir build-m && PIPER_MODELS=<dir> AUTODUB_DIST=build-m M_PHASE=before|after|scan npx playwright test tests/e2e/m-male.spec.ts
//   M_PHASE=measure only re-measures the saved WAVs; M_PHASE=noise = Piper noise grid; M_PHASE=scan = MLS speaker scan
//   (needs a temporary fr_FR-mls-medium entry in neural-catalog.ts: MLS was rejected, see research/v122-M.md).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { prosodyFor } from '../../src/shared/prosody';
import { analyzeEmotion } from '../../src/content/text/emotion';
import { neuralVoice } from '../../src/content/voice/neural-catalog';
import type { Line } from '../../src/shared/types';
import { floatToWav, measure, resample, wavToFloat, type LineMetrics } from './m-metrics';

const MODELS_DIR = process.env.PIPER_MODELS;
const PHASE = process.env.M_PHASE ?? 'after';
const OUT = path.resolve('research/samples/v122');
const RAW = path.join(OUT, 'raw');
const AROUSAL = 0.75;

export const M_LINES: (Pick<Line, 'text' | 'source' | 'shout'> & { name: string })[] = [
  { name: 'neutral', text: "Aujourd'hui, on va construire une maison au milieu de la forêt.", source: "Today we're going to build a house in the middle of the forest." },
  { name: 'excited', text: 'Incroyable ! Il a gagné dix mille dollars !', source: 'Insane! He just won $10,000!' },
  { name: 'question', text: 'Est-ce que tu veux vraiment garder tout cet argent ?', source: 'Do you really want to keep all this money?' },
  { name: 'long', text: "Le dernier qui reste dans le cercle pendant trois jours gagne cinq cent mille dollars, mais personne ne sait encore ce qui va se passer cette nuit.", source: 'The last one to stay in the circle for three days wins five hundred thousand dollars, but nobody knows yet what will happen tonight.' },
  { name: 'shout', text: 'Le dernier à quitter le cercle gagne cinq cent mille dollars !', source: 'LAST TO LEAVE THE CIRCLE WINS $500,000!', shout: true },
  { name: 'soft-end', text: 'On a tout perdu, mais on continue quand même, parce que tu sais.', source: 'We lost everything, but we keep going anyway, because you know.' },
];

type Job = { tag: string; voice: string; x: number };

function jobsFor(phase: string): Job[] {
  const both = (key: string, voice: string, suffix: string): Job[] => [
    { tag: `${key}-${suffix}-expr0`, voice, x: 0 },
    { tag: `${key}-${suffix}`, voice, x: 0.7 },
  ];
  if (phase === 'before') return [...both('male-tom', 'fr_FR-tom-medium', 'before'), ...both('male-pierre', 'fr_FR-upmc-medium#pierre', 'before'), ...both('female-siwis', 'fr_FR-siwis-medium', 'before')];
  const extra = (process.env.M_MLS ?? '').split(',').filter(Boolean).flatMap((s) => both(`male-mls${s}`, `fr_FR-mls-medium#${s}`, 'after'));
  return [
    ...both('male-tom', 'fr_FR-tom-medium', 'after'), ...both('male-pierre', 'fr_FR-upmc-medium#pierre', 'after'),
    ...extra, ...both('female-siwis', 'fr_FR-siwis-medium', 'after'),
  ];
}

function routeModels(context: import('@playwright/test').BrowserContext) {
  if (!MODELS_DIR) return Promise.resolve();
  return context.route(/huggingface\.co\/.*\/([a-zA-Z_]+-[a-z_]+-(?:x_low|low|medium|high)\.onnx(?:\.json)?)$/, (route) => {
    const f = path.join(MODELS_DIR, route.request().url().split('/').pop()!);
    if (!fs.existsSync(f)) return route.fallback();
    return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'Access-Control-Allow-Origin': '*', 'Content-Length': String(fs.statSync(f).size) } });
  });
}

async function render(page: import('@playwright/test').Page, reqs: { voice: string; text: string; prosody?: unknown }[]) {
  return page.evaluate(async (reqs) => {
    const send = (m: unknown) => chrome.runtime.sendMessage(m) as Promise<any>;
    const models = [...new Set(reqs.map((r) => r.voice.split('#')[0]))];
    let st: any = await send({ type: 'NEURAL_STATUS', models, download: models });
    for (let i = 0; i < 600 && !(st.ok && st.models.every((m: any) => m.ready)); i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await send({ type: 'NEURAL_STATUS', models });
    }
    for (const v of new Set(reqs.map((r) => r.voice))) await send({ type: 'NEURAL_TTS', text: 'Bonjour.', lang: 'fr', voice: v });
    const out: any[] = [];
    for (const j of reqs) {
      const m: Record<string, unknown> = { type: 'NEURAL_TTS', text: j.text, lang: 'fr', voice: j.voice };
      if (j.prosody) m.prosody = j.prosody;
      const r = await send(m);
      out.push({ ok: r.ok, ms: r.ms, rtf: r.rtf, postMs: r.postMs, audioB64: r.audioB64, error: r.error, message: r.message });
    }
    return out;
  }, reqs);
}

test('M: render male/female French lines', async ({ context, extensionId }) => {
  test.skip(PHASE !== 'before' && PHASE !== 'after');
  test.setTimeout(900_000);
  await routeModels(context);
  const jobs = jobsFor(PHASE);
  const reqs = jobs.flatMap((j) => M_LINES.map((l) => ({ voice: j.voice, text: l.text, prosody: prosodyFor(analyzeEmotion(l), l.text, AROUSAL, j.x) })));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?mock=idle`);
  const res = await render(page, reqs);
  let i = 0;
  for (const j of jobs) {
    const dir = path.join(RAW, j.tag);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const meta: Record<string, unknown>[] = [];
    const parts: Float32Array[] = [];
    let sr = 0;
    for (const l of M_LINES) {
      const r = res[i++];
      expect(r.ok, `${j.tag} ${l.name}: ${r.error} ${r.message}`).toBe(true);
      const buf = Buffer.from(r.audioB64, 'base64');
      fs.writeFileSync(path.join(dir, `${l.name}.wav`), buf);
      const w = wavToFloat(buf);
      sr = w.sr;
      parts.push(w.pcm, new Float32Array(Math.round(w.sr * 0.4)));
      meta.push({ line: l.name, ms: Math.round(r.ms), rtf: Number(r.rtf.toFixed(3)), postMs: r.postMs != null ? Math.round(r.postMs) : null });
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ voice: j.voice, expr: j.x, sr, lines: meta }, null, 2));
    const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    fs.writeFileSync(path.join(OUT, `${j.tag}.wav`), floatToWav(all, sr));
  }
});

test('M: scan MLS speakers (gender by F0, clarity)', async ({ context, extensionId }) => {
  test.skip(PHASE !== 'scan');
  test.setTimeout(900_000);
  await routeModels(context);
  const cfg = JSON.parse(fs.readFileSync(path.join(MODELS_DIR ?? '', 'fr_FR-mls-medium.onnx.json'), 'utf8')) as { speaker_id_map: Record<string, number> };
  const speakers = Object.keys(cfg.speaker_id_map);
  const text = M_LINES[0]!.text + ' ' + M_LINES[2]!.text;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?mock=idle`);
  const res = await render(page, speakers.map((s) => ({ voice: `fr_FR-mls-medium#${s}`, text })));
  const rows = speakers.map((s, k) => {
    const { pcm, sr } = wavToFloat(Buffer.from(res[k].audioB64, 'base64'));
    const m = measure(pcm, sr, 'male');
    return { speaker: s, meanHz: m.meanHz, hnrDb: m.hnrDb, flatness: m.flatness, clicks: m.clicks, ms: m.ms };
  });
  const males = rows.filter((r) => r.meanHz > 0 && r.meanHz < 150).sort((a, b) => b.hnrDb - a.hnrDb);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'mls-scan.json'), JSON.stringify({ text, all: rows, malesByHnr: males }, null, 2));
  console.log('[m-scan] males by HNR\n' + males.slice(0, 12).map((x) => JSON.stringify(x)).join('\n'));
});

test('M: Piper noise params vs clarity (Tom/Pierre, no DSP)', async ({ context, extensionId }) => {
  test.skip(PHASE !== 'noise');
  test.setTimeout(900_000);
  await routeModels(context);
  const grid = [[0.667, 0.8], [0.85, 1.0], [0.5, 0.8], [0.333, 0.8], [0.5, 0.5], [0.333, 0.333]] as const;
  const voices = (process.env.M_VOICES ?? 'fr_FR-tom-medium,fr_FR-upmc-medium#pierre').split(',');
  const flat = { pitchK: 1, meanShiftSt: 0, endShiftSt: 0, endMs: 300, gainDb: 0, emphasis: [] };
  const reqs = voices.flatMap((voice) => grid.flatMap(([ns, nw]) => M_LINES.map((l) => ({ voice, text: l.text, prosody: { ...flat, noiseScale: ns, noiseW: nw } }))));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?mock=idle`);
  const res = await render(page, reqs);
  const rows: Record<string, unknown>[] = [];
  let i = 0;
  for (const voice of voices) for (const [ns, nw] of grid) {
    const ms: LineMetrics[] = [];
    for (const _l of M_LINES) { const { pcm, sr } = wavToFloat(Buffer.from(res[i++].audioB64, 'base64')); ms.push(measure(pcm, sr, 'male')); }
    const avg = (k: keyof LineMetrics) => Number((ms.reduce((a, x) => a + (x[k] as number), 0) / ms.length).toFixed(3));
    rows.push({ voice, ns, nw, hnrDb: avg('hnrDb'), flatness: avg('flatness'), breaksPerS: avg('breaksPerS'), dips: avg('dips'), clicks: avg('clicks'), gaps: avg('gaps'), ms: avg('ms') });
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'noise-grid.json'), JSON.stringify(rows, null, 2));
  console.log('[m-noise]\n' + rows.map((x) => JSON.stringify(x)).join('\n'));
});

test('M: measure saved renders', async () => {
  test.skip(PHASE === 'scan' || PHASE === 'noise');
  if (!fs.existsSync(RAW)) return;
  const report: Record<string, unknown> = {};
  const summary: Record<string, unknown>[] = [];
  for (const tag of fs.readdirSync(RAW).sort()) {
    const dir = path.join(RAW, tag);
    if (!fs.existsSync(path.join(dir, 'meta.json'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as { voice: string; expr: number; lines: { line: string; ms: number; rtf: number; postMs: number | null }[] };
    const gender = neuralVoice(meta.voice)?.gender ?? 'male';
    const lines = meta.lines.map((l) => {
      const { pcm, sr } = wavToFloat(fs.readFileSync(path.join(dir, `${l.line}.wav`)));
      return { ...l, ...measure(pcm, sr, gender) };
    });
    report[tag] = { voice: meta.voice, expr: meta.expr, lines };
    const sum = (k: keyof LineMetrics) => lines.reduce((a, x) => a + (x[k] as number), 0);
    const avg = (k: keyof LineMetrics) => Number((sum(k) / lines.length).toFixed(2));
    summary.push({
      tag, voice: meta.voice, expr: meta.expr, sr: lines[0]!.sr, clicks: sum('clicks'), gaps: sum('gaps'), maxJump: Math.max(...lines.map((x) => x.maxJump)),
      clipPct: Math.max(...lines.map((x) => x.clipPct)), tailDbMax: Math.max(...lines.map((x) => x.tailDb)), octaveJumps: sum('octaveJumps'), breaksPerS: avg('breaksPerS'), dips: sum('dips'),
      f0: `${Math.min(...lines.map((x) => x.meanHz))}–${Math.max(...lines.map((x) => x.meanHz))} Hz`, rangeSt: avg('rangeSt'), stdSt: avg('stdSt'),
      hnrDb: avg('hnrDb'), flatness: Number((sum('flatness') / lines.length).toFixed(4)), rtfMax: Math.max(...lines.map((x) => x.rtf)),
    });
  }
  fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify({ summary, perLine: report }, null, 2));
  console.log('[m-measure]\n' + summary.map((x) => JSON.stringify(x)).join('\n'));
});
