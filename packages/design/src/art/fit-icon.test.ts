import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../contrast';

/** The FIT token icon set (packages/design/art/fit, built by scripts/fit-icon/build.mjs; DECISION-LOG F20). */
const DIR = fileURLToPath(new URL('../../art/fit/', import.meta.url));
const file = (path: string) => readFileSync(join(DIR, path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Entry {
  path: string;
  kind: string;
  width?: number;
  height?: number;
  bytes: number;
  sha256: string;
}
const manifest = JSON.parse(file('manifest.json').toString('utf8')) as {
  colours: { face: string; rim: string; glow: string; appBackground: string };
  files: Entry[];
};
const entries = new Map(manifest.files.map((f) => [f.path, f]));

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`],
  );
}

interface Rgba {
  width: number;
  height: number;
  at: (x: number, y: number) => [number, number, number, number];
}

/** Test-only decoder for 8-bit RGBA, non-interlaced PNGs (what the Chromium encoder writes). */
function decodePng(bytes: Buffer): Rgba {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect([bytes[24], bytes[25], bytes[28]]).toEqual([8, 6, 0]); // bit depth 8, RGBA, no interlace
  const idat: Buffer[] = [];
  for (let o = 8; o < bytes.length; ) {
    const length = bytes.readUInt32BE(o);
    if (bytes.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(bytes.subarray(o + 8, o + 8 + length));
    o += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= 4 ? (out[y * stride + i - 4] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= 4 ? (out[(y - 1) * stride + i - 4] ?? 0) : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + Math.floor((a + b) / 2);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  const at = (x: number, y: number): [number, number, number, number] => {
    const i = y * stride + x * 4;
    return [out[i] ?? 0, out[i + 1] ?? 0, out[i + 2] ?? 0, out[i + 3] ?? 0];
  };
  return { width, height, at };
}

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const SVGS = ['fit-icon.svg', 'fit-icon-mono.svg', 'fit-icon-small.svg', 'fit-icon-16.svg', 'favicon/favicon.svg'];

describe('FIT icon manifest', () => {
  it('lists every file in the folder (besides README.md and itself), with its size and sha256', () => {
    const onDisk = listFiles(DIR).filter((p) => p !== 'README.md' && p !== 'manifest.json').sort();
    expect([...entries.keys()].sort()).toEqual(onDisk);
    for (const entry of manifest.files) {
      const bytes = file(entry.path);
      expect(bytes.length, entry.path).toBe(entry.bytes);
      expect(sha256(bytes), entry.path).toBe(entry.sha256);
    }
  });

  it('has a PNG at every required size, flat for 16–24 px and 3D from 32 px', () => {
    for (const size of ICON_SIZES) {
      const entry = entries.get(`fit-icon-${size}.png`);
      expect(entry, String(size)).toBeDefined();
      expect([entry?.width, entry?.height]).toEqual([size, size]);
      expect(entry?.kind).toBe(size <= 24 ? 'png-flat' : 'png-3d');
    }
  });
});

describe('FIT icon colours', () => {
  it('uses the lavender face and the violet rim, with the outer edge at 3:1 or more on white and on the canvas', () => {
    expect(manifest.colours.face).toBe('#A78BFA');
    expect(manifest.colours.rim).toBe('#6D4AE2');
    expect(contrastRatio(manifest.colours.rim, '#FFFFFF')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(manifest.colours.rim, '#080D16')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(manifest.colours.face, '#080D16')).toBeGreaterThanOrEqual(3);
  });
});

describe('FIT icon SVGs', () => {
  it.each(SVGS)('%s is geometry only, under 4 KB, evenodd, in the brand colours only (no gold, no text, no symbols)', (path) => {
    const text = file(path).toString('utf8');
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).not.toMatch(/<(text|image|style|script|foreignObject|use)\b/i);
    expect(text).not.toMatch(/[$€¥¢£₿Ξ]/u);
    const paths = text.match(/<path\b[^>]*>/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p).toContain('fill-rule="evenodd"');
    const fills = new Set([...text.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]));
    for (const fill of fills) expect(['#A78BFA', '#6D4AE2', 'currentColor']).toContain(fill);
    // Nothing paints a background: the first shape is the coin, never a full-canvas rectangle.
    expect(text).not.toMatch(/<rect\b/i);
  });

  it('the one-colour variant uses currentColor only', () => {
    const fills = [...file('fit-icon-mono.svg').toString('utf8').matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(fills)).toEqual(new Set(['currentColor']));
  });
});

describe('FIT icon PNGs have a real transparent hole', () => {
  it.each(ICON_SIZES)('%i px: transparent corners and hole centre, opaque coin face', (size) => {
    const png = decodePng(file(`fit-icon-${size}.png`));
    const mid = Math.floor(size / 2);
    expect(png.at(0, 0)[3]).toBe(0);
    expect(png.at(size - 1, size - 1)[3]).toBe(0);
    expect(png.at(mid, mid)[3]).toBe(0);
    expect(png.at(mid - 1, mid - 1)[3]).toBe(0);
    // Face: two thirds of the way from the centre to the left edge, on the middle row.
    expect(png.at(Math.round(size * 0.17), mid)[3]).toBe(255);
  });

  it('the flat 16 and 24 px holes are pixel-aligned and at least 5 px wide', () => {
    for (const [size, from, to] of [
      [16, 5, 10],
      [24, 7, 16],
    ] as const) {
      const png = decodePng(file(`fit-icon-${size}.png`));
      const row = Array.from({ length: size }, (_, x) => png.at(x, size / 2)[3]);
      const clear = row.flatMap((a, x) => (a === 0 ? [x] : [])).filter((x) => x > 1 && x < size - 2);
      expect(clear, String(size)).toEqual(Array.from({ length: to - from + 1 }, (_, i) => from + i));
    }
  });

  it('the app icons with a background are opaque #080D16 in the corners', () => {
    for (const path of ['favicon/apple-touch-icon.png', 'favicon/icon-maskable-512.png']) {
      const png = decodePng(file(path));
      expect(png.at(0, 0), path).toEqual([8, 13, 22, 255]);
    }
  });
});

describe('FIT favicon.ico', () => {
  it('holds the 16, 32 and 48 px PNGs byte-for-byte', () => {
    const ico = file('favicon/favicon.ico');
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    [16, 32, 48].forEach((size, i) => {
      const e = 6 + 16 * i;
      expect(ico.readUInt8(e)).toBe(size);
      const embedded = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8));
      expect(embedded.equals(file(`fit-icon-${size}.png`)), String(size)).toBe(true);
    });
  });
});
