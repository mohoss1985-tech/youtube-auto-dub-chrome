// E (v1.2): expressive neural French, end to end through the extension (popup page → SW → offscreen → Piper worker).
// Renders 4 lines at Expression 0 (v1.1 sound) and 0.7 with Siwis, saves the WAVs to research/samples/v12/, and reports
// F0 range/std (semitones) before/after and the RTF including post-processing (must stay < 0.3).
// Run: node build.mjs --outdir build-e && PIPER_MODELS=<dir with .onnx/.onnx.json> AUTODUB_DIST=build-e npx playwright test tests/e2e/e-expressive.spec.ts
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { prosodyFor } from '../../src/shared/prosody';
import { analyzeEmotion } from '../../src/content/text/emotion';
import { f0Stats, trackF0 } from '../../src/offscreen/prosody-dsp';
import type { Line } from '../../src/shared/types';

const MODELS_DIR = process.env.PIPER_MODELS;
const OUT = path.resolve('research/samples/v12');
const AROUSAL = 0.75; // a MrBeast-like scene
const LINES: (Pick<Line, 'text' | 'source' | 'shout'> & { name: string })[] = [
  { name: 'neutral', text: "Aujourd'hui, on va construire une maison au milieu de la forêt.", source: "Today we're going to build a house in the middle of the forest." },
  { name: 'excited', text: 'Incroyable ! Il a gagné dix mille dollars !', source: 'Insane! He just won $10,000!' },
  { name: 'question', text: 'Est-ce que tu veux vraiment garder tout cet argent ?', source: 'Do you really want to keep all this money?' },
  { name: 'shout', text: 'Le dernier à quitter le cercle gagne cinq cent mille dollars !', source: 'LAST TO LEAVE THE CIRCLE WINS $500,000!', shout: true },
];

function wavToFloat(b64: string): { pcm: Float32Array; sr: number } {
  const buf = Buffer.from(b64, 'base64');
  const sr = buf.readUInt32LE(24);
  const n = buf.readUInt32LE(40) / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(44 + 2 * i) / 32768;
  return { pcm, sr };
}

test('expressive Siwis (4 lines) + Tom (1 line) at Expression 0 and 0.7', async ({ context, extensionId }) => {
  test.setTimeout(300_000);
  if (MODELS_DIR) {
    await context.route(/huggingface\.co\/.*\/([a-zA-Z_]+-[a-z_]+-(?:x_low|low|medium|high)\.onnx(?:\.json)?)$/, (route) => {
      const f = path.join(MODELS_DIR, route.request().url().split('/').pop()!);
      if (!fs.existsSync(f)) return route.fallback();
      return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'Access-Control-Allow-Origin': '*', 'Content-Length': String(fs.statSync(f).size) } });
    });
  }
  const jobs = [...LINES.map((l) => ({ l, voice: 'fr_FR-siwis-medium' })), { l: { ...LINES[1]!, name: 'tom-excited' }, voice: 'fr_FR-tom-medium' }]
    .flatMap(({ l, voice }) => [0, 0.7].map((x) => {
      const emotion = analyzeEmotion(l);
      return { name: l.name, x, voice, text: l.text, style: emotion.style, prosody: prosodyFor(emotion, l.text, AROUSAL, x) };
    }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?mock=idle`);
  const res = await page.evaluate(async (jobs) => {
    const send = (m: unknown) => chrome.runtime.sendMessage(m) as Promise<any>;
    const models = ['fr_FR-siwis-medium', 'fr_FR-tom-medium'];
    let st: any = await send({ type: 'NEURAL_STATUS', models, download: models });
    for (let i = 0; i < 400 && !(st.ok && st.models.every((m: any) => m.ready)); i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await send({ type: 'NEURAL_STATUS', models });
    }
    for (const voice of models) await send({ type: 'NEURAL_TTS', text: 'Bonjour.', lang: 'fr', voice }); // load the models
    const out: any[] = [];
    for (const j of jobs) {
      const m: Record<string, unknown> = { type: 'NEURAL_TTS', text: j.text, lang: 'fr', voice: j.voice };
      if (j.prosody) m.prosody = j.prosody;
      const r = await send(m);
      out.push({ ok: r.ok, ms: r.ms, rtf: r.rtf, postMs: r.postMs, audioB64: r.audioB64 });
    }
    return out;
  }, jobs);

  fs.mkdirSync(OUT, { recursive: true });
  const report: Record<string, unknown>[] = [];
  res.forEach((r, i) => {
    const j = jobs[i]!;
    expect(r.ok).toBe(true);
    expect(r.audioB64).toBeTruthy();
    const { pcm, sr } = wavToFloat(r.audioB64);
    const s = f0Stats(trackF0(pcm, sr));
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    const file = `${String(Math.floor(i / 2) + 1)}-${j.name}-expr${j.x === 0 ? '0' : '070'}.wav`;
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.audioB64, 'base64'));
    report.push({ file, voice: j.voice, style: j.style, expr: j.x, ms: Math.round(r.ms), rtf: Number(r.rtf.toFixed(3)), postMs: r.postMs != null ? Math.round(r.postMs) : null, meanHz: Math.round(s.meanHz), rangeSt: Number(s.rangeSt.toFixed(2)), stdSt: Number(s.stdSt.toFixed(2)), peak: Number(peak.toFixed(3)) });
    expect(r.rtf).toBeLessThan(0.3);
    expect(peak).toBeLessThanOrEqual(0.96);
  });
  fs.writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify(report, null, 2));
  console.log('[e-expressive]\n' + report.map((x) => JSON.stringify(x)).join('\n'));
  // Expression widens the melody of every expressive line.
  for (let i = 0; i < report.length; i += 2) {
    const flat = report[i] as { rangeSt: number; stdSt: number };
    const lively = report[i + 1] as { rangeSt: number; stdSt: number };
    expect(lively.stdSt).toBeGreaterThan(flat.stdSt);
  }
});
