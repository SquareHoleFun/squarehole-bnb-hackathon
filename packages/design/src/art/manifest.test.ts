import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../../art/manifest.json';
import { ART, CAST, castArt } from './registry';

const artFile = (name: string) => readFileSync(fileURLToPath(new URL(`../../art/${name}`, import.meta.url)));
const handoffFile = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../square-hole-handoff/${name}`, import.meta.url)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Width/height from a RIFF/WEBP header (VP8, VP8L or VP8X). Test-only parser. */
function webpSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

type Box = readonly [number, number, number, number];
const intersects = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

describe('art manifest (scripts/extract-art.py output)', () => {
  it('pins the handoff sources by hash', () => {
    const handoffManifest = handoffFile('MANIFEST.sha256').toString('utf8');
    for (const [name, source] of Object.entries(manifest.sources)) {
      const actual = sha256(handoffFile(`design/reference/${name}`));
      expect(source.sha256, name).toBe(actual);
      expect(handoffManifest).toContain(`${actual}  design/reference/${name}`);
    }
  });

  it('every crop file matches its recorded hash, size and native crop box (no upscaling)', () => {
    expect(manifest.assets.length).toBeGreaterThanOrEqual(14);
    for (const asset of manifest.assets) {
      const bytes = artFile(asset.output);
      expect(sha256(bytes), asset.id).toBe(asset.sha256);
      expect(bytes.length, asset.id).toBe(asset.bytes);
      const [x0, y0, x1, y1] = asset.box as unknown as Box;
      expect(webpSize(bytes), asset.id).toEqual({ width: x1 - x0, height: y1 - y0 });
      expect({ width: asset.width, height: asset.height }).toEqual({ width: x1 - x0, height: y1 - y0 });
    }
  });

  it('no crop intersects an excluded brand look-alike region', () => {
    expect(manifest.excluded.map((e) => e.what).join(' ')).toMatch(/Bitcoin.*Apple.*CryptoPunk.*Doge/s);
    for (const asset of manifest.assets) {
      for (const excluded of manifest.excluded) {
        if (excluded.source !== asset.source) continue;
        expect(intersects(asset.box as unknown as Box, excluded.box as unknown as Box), `${asset.id} vs ${excluded.what}`).toBe(false);
      }
    }
  });

  it('asset descriptions never name an excluded brand', () => {
    for (const asset of manifest.assets) {
      expect(`${asset.id} ${asset.alt} ${asset.use}`, asset.id).not.toMatch(/bitcoin|btc|punk|doge|apple logo|aapl/i);
    }
  });

  it('The Coin and The Stonk are pending original art', () => {
    expect(manifest.pending.map((p) => [p.cast, p.status])).toEqual([
      ['coin', 'pending-original-art'],
      ['stonk', 'pending-original-art'],
    ]);
  });
});

describe('art registry', () => {
  it('exposes every manifest asset with a URL and native size', () => {
    expect([...ART.keys()].sort()).toEqual(manifest.assets.map((a) => a.id).sort());
    for (const asset of ART.values()) {
      expect(asset.src, asset.id).toMatch(/\.webp/);
      expect(asset.width).toBeGreaterThan(0);
      expect(asset.height).toBeGreaterThan(0);
    }
  });

  it('describes the four-character platform cast, with art only where a clean source exists', () => {
    expect(CAST.map((c) => c.name)).toEqual(['The Sorter', 'The Coin', 'The Collector', 'The Stonk']);
    expect(castArt('sorter')?.id).toBe('sorter');
    expect(castArt('collector')?.id).toBe('collector-frame');
    expect(castArt('coin')).toBeNull();
    expect(castArt('stonk')).toBeNull();
  });
});
