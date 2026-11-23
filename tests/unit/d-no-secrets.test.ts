// D: DESIGN_SPEC §1 C4 — content code must never touch the API-key store.
// Fails if any file under src/content/** mentions getSecrets / saveSecrets / "secrets".
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

describe('no key-store access from content scripts', () => {
  it('src/content/** never mentions secrets', () => {
    const files = walk(path.resolve('src/content'));
    expect(files.length).toBeGreaterThan(5);
    const hits = files.flatMap((f) =>
      fs.readFileSync(f, 'utf8').split('\n')
        .map((line, i) => ({ f: path.relative(process.cwd(), f), n: i + 1, line }))
        .filter((x) => /getSecrets|saveSecrets|secrets/i.test(x.line)),
    );
    expect(hits.map((h) => `${h.f}:${h.n}: ${h.line.trim()}`)).toEqual([]);
  });
});
