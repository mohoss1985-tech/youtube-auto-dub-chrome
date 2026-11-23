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
];

function copyStatic() {
  fs.copyFileSync('manifest.json', path.join(outdir, 'manifest.json'));
  fs.copyFileSync('src/popup/popup.html', path.join(outdir, 'popup.html'));
  fs.copyFileSync('src/popup/popup.css', path.join(outdir, 'popup.css'));
  fs.cpSync('icons', path.join(outdir, 'icons'), { recursive: true });
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
