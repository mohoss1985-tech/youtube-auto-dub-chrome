// Generates icons/icon{16,32,48,128}.png: accent #3D5AFE rounded square with a white "A".
// Pure Node (zlib), no external deps. Shapes are rasterised with 4x4 supersampling.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ACCENT = [0x3d, 0x5a, 0xfe];
const WHITE = [255, 255, 255];

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Distance from point to segment, for the strokes of the "A".
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Coverage in a unit square [0,1]^2: returns 'bg' | 'fg' | null
function sample(x, y) {
  const r = 0.22; // corner radius
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if (Math.hypot(x - cx, y - cy) > r) return null;
  const w = 0.075; // half stroke width
  const top = [0.5, 0.2], bl = [0.25, 0.8], br = [0.75, 0.8];
  const inA =
    segDist(x, y, ...top, ...bl) < w ||
    segDist(x, y, ...top, ...br) < w ||
    segDist(x, y, 0.36, 0.6, 0.64, 0.6) < w * 0.85;
  return inA ? 'fg' : 'bg';
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const s = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (s === 'bg') bg++;
          else if (s === 'fg') fg++;
        }
      const n = ss * ss, cov = (bg + fg) / n;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let i = 0; i < 3; i++) raw[o + i] = cov ? Math.round((ACCENT[i] * bg + WHITE[i] * fg) / (bg + fg)) : 0;
      raw[o + 3] = Math.round(cov * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync('icons', { recursive: true });
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join('icons', `icon${s}.png`), png(s));
  console.log(`icons/icon${s}.png`);
}
