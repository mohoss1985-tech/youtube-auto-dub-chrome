// AutoDub build: esbuild bundles 4 entries into an unpacked extension folder.
// Usage: node build.mjs [--outdir <dir>] [--watch] [--sourcemap]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const outdir = path.resolve(opt('--outdir', 'dist'));
const watch = flag('--watch');
const sourcemap = flag('--sourcemap') ? 'inline' : false;

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  target: 'chrome138',
  sourcemap,
  logLevel: 'info',
  legalComments: 'none',
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  { ...common, entryPoints: ['src/content/main-hook.ts'], outfile: path.join(outdir, 'main-hook.js'), format: 'iife' },
  { ...common, entryPoints: ['src/content/index.ts'], outfile: path.join(outdir, 'content.js'), format: 'iife' },
  { ...common, entryPoints: ['src/background/index.ts'], outfile: path.join(outdir, 'background.js'), format: 'esm' },
  { ...common, entryPoints: ['src/popup/popup.ts'], outfile: path.join(outdir, 'popup.js'), format: 'iife' },
  // v1.1 neural voices (Piper): offscreen document + module Worker (onnxruntime-web + piper-phonemize, all bundled).
  { ...common, entryPoints: ['src/offscreen/offscreen.ts'], outfile: path.join(outdir, 'offscreen.js'), format: 'iife' },
  {
    ...common, entryPoints: ['src/offscreen/piper-worker.ts'], outfile: path.join(outdir, 'piper-worker.js'), format: 'esm',
    // piper_phonemize.js has Node-only branches (never run in a browser).
    external: ['fs', 'path', 'crypto'],
  },
  // v1.2.1 (T): free offline translation (Opus-MT via transformers.js). Its ORT import is pointed at the
  // onnxruntime-web/wasm build already bundled for Piper, so it reuses ort/ort-wasm-simd-threaded.wasm (no CDN, no JSEP).
  {
    ...common, entryPoints: ['src/offscreen/mt-worker.ts'], outfile: path.join(outdir, 'mt-worker.js'), format: 'esm',
    alias: {
      'onnxruntime-web/webgpu': path.resolve('node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'),
      'onnxruntime-common': path.resolve('node_modules/onnxruntime-common/dist/esm/index.js'),
    },
    external: ['fs', 'path', 'url', 'sharp', 'onnxruntime-node'],
  },
];

function copyStatic() {
  fs.copyFileSync('manifest.json', path.join(outdir, 'manifest.json'));
  fs.copyFileSync('src/popup/popup.html', path.join(outdir, 'popup.html'));
  fs.copyFileSync('src/popup/popup.css', path.join(outdir, 'popup.css'));
  fs.cpSync('icons', path.join(outdir, 'icons'), { recursive: true });
  fs.copyFileSync('src/offscreen/offscreen.html', path.join(outdir, 'offscreen.html'));
  // WASM + data shipped inside the package (MV3: no remote code). Models (.onnx) are downloaded at runtime as data.
  fs.mkdirSync(path.join(outdir, 'ort'), { recursive: true });
  fs.copyFileSync('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', path.join(outdir, 'ort', 'ort-wasm-simd-threaded.wasm'));
  fs.mkdirSync(path.join(outdir, 'piper'), { recursive: true });
  for (const f of ['piper_phonemize.wasm', 'piper_phonemize.data']) {
    fs.copyFileSync(path.join('node_modules/@diffusionstudio/piper-wasm/build', f), path.join(outdir, 'piper', f));
  }
}

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
  copyStatic();
  console.log(`[autodub] watching -> ${outdir}`);
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyStatic();
  console.log(`[autodub] built -> ${outdir}`);
}
