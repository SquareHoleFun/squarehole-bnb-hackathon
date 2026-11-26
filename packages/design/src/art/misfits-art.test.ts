import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../../art/misfits/manifest.json';
import { MISFITS_ART } from './misfits-art';

const DIR = new URL('../../art/misfits/', import.meta.url);
const REPO = new URL('../../../../', import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Width/height from a RIFF/WEBP header (VP8, VP8L or VP8X). Test-only parser. */
function webpSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  throw new Error(`unknown WebP chunk ${chunk}`);
}

/** Art that must never be a teaser or an avatar (F47): one-of-ones, the Classics' art, Diamonds, the Glass Shape. */
const RARE = /^(?:m-)?(?:glass-sorter|golden-sorter|the-hole|the-box|two-in-one|headstand|marble|origami-star|knitted-ball|spectrum-arch|disco-ball|snow-globe|B01|B05|B10|B12|B16|D0\d)(?:-|\.|$)/;

describe('box art (packages/design/art/misfits)', () => {
  it('every file matches its recorded size, hash and source in the box mock-up, byte for byte', () => {
    expect(manifest.files.length).toBe(29);
    for (const file of manifest.files) {
      const bytes = readFileSync(fileURLToPath(new URL(file.path, DIR)));
      expect(sha256(bytes), file.path).toBe(file.sha256);
      expect(bytes.length, file.path).toBe(file.bytes);
      expect(webpSize(bytes), file.path).toEqual({ width: file.width, height: file.height });
      expect(file.source, file.path).toMatch(/^docs\/design\/box-concept\/mock-v0\.2\/img\//);
      expect(sha256(readFileSync(fileURLToPath(new URL(file.source, REPO)))), file.source).toBe(file.sha256);
    }
  });

  it('carries no file the manifest does not list, and the registry bundles every listed file', () => {
    const onDisk = readdirSync(fileURLToPath(DIR)).filter((name) => name.endsWith('.webp')).sort();
    expect(onDisk).toEqual(manifest.files.map((file) => file.path).sort());
    expect([...MISFITS_ART.keys()].sort()).toEqual(onDisk.map((name) => name.replace(/\.webp$/, '')).sort());
  });

  it('holds no rare piece (F47: show ordinary Misfits only)', () => {
    for (const file of manifest.files) expect(file.path, file.path).not.toMatch(RARE);
    expect(manifest.files.filter((file) => file.path.startsWith('m-')).every((file) => /standard finish/.test(file.use))).toBe(true);
  });
});
