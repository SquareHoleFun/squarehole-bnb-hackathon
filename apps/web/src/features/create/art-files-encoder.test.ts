/**
 * SH-ARWEAVE-PICTURES-WEB: the browser encoder behind the free ladder, on a fake canvas that writes no WebP (as Safari
 * and every iPhone browser): the encoder is detected at run time, every drawing is painted on the site ground before the
 * picture (a transparent logo keeps its look in JPEG), and the JPEG ladder runs with its own steps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_ART, BROWSER_ENCODER } from './art-files';
import { fitsFree } from '../pictures/arweave-publish';
import { SITE_GROUND, UNREADABLE } from '../pictures/shrink';

interface Call { readonly op: string; readonly args: readonly unknown[] }
const calls: Call[] = [];
/** A canvas whose encoder writes PNG and JPEG only, sized by `jpegBytes(width, quality)`. */
let jpegBytes: (width: number, quality: number | undefined) => number = () => 50_000;

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      set fillStyle(value: string) { calls.push({ op: 'fillStyle', args: [value] }); },
      set imageSmoothingQuality(_value: string) { /* kept */ },
      fillRect: (...args: unknown[]) => calls.push({ op: 'fillRect', args }),
      drawImage: (_bitmap: unknown, ...args: unknown[]) => calls.push({ op: 'drawImage', args }),
    }),
    toBlob: (done: (blob: Blob | null) => void, type: string, quality?: number) => {
      calls.push({ op: 'toBlob', args: [canvas.width, type, quality] });
      const written = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      done(new Blob([new Uint8Array(written === 'image/jpeg' ? jpegBytes(canvas.width, quality) : 300_000)], { type: written }));
    },
  };
  return canvas;
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('createImageBitmap', async () => ({ width: 2000, height: 1000, close: () => undefined }));
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'canvas' ? fakeCanvas() : create(tag))) as typeof document.createElement);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('BROWSER_ENCODER without a WebP encoder', () => {
  it('detects it at run time (a WebP ask that answers PNG)', async () => {
    expect(await BROWSER_ENCODER.webp()).toBe(false);
  });

  it('paints the site ground under the picture first, then draws it within the edge', async () => {
    const canvas = await BROWSER_ENCODER.draw(new Blob([new Uint8Array(8)]), 768, SITE_GROUND);
    expect(canvas).not.toBeNull();
    expect(calls.filter((c) => c.op !== 'toBlob')).toEqual([
      { op: 'fillStyle', args: ['#1b2638'] },
      { op: 'fillRect', args: [0, 0, 768, 384] },
      { op: 'drawImage', args: [0, 0, 768, 384] },
    ]);
    calls.length = 0;
    await BROWSER_ENCODER.draw(new Blob([new Uint8Array(8)]), 1200, null);
    expect(calls.map((c) => c.op)).toEqual(['drawImage']);
  });

  it('the logo through encodeFree: JPEG at 768 px on the ground, the first quality that fits', async () => {
    jpegBytes = (width, quality) => (width === 768 && quality === 0.7 ? 90_000 : 150_000);
    const result = await BROWSER_ART.encodeFree?.(new Blob([new Uint8Array(8)]), fitsFree(11155111, 107_520));
    expect(result && 'bytes' in result ? result.bytes.byteLength : result).toBe(90_000);
    // (The 1 px canvas is the once-per-page WebP check.)
    expect(calls.filter((c) => c.op === 'toBlob' && c.args[0] !== 1).map((c) => c.args)).toEqual([[768, 'image/jpeg', 0.9], [768, 'image/jpeg', 0.8], [768, 'image/jpeg', 0.7]]);
    expect(calls.find((c) => c.op === 'fillStyle')?.args).toEqual([SITE_GROUND]);
  });

  it('nothing fits: refused with one short line', async () => {
    jpegBytes = () => 150_000;
    expect(await BROWSER_ART.encodeFree?.(new Blob([new Uint8Array(8)]), fitsFree(11155111, 107_520))).toEqual({ error: 'Too detailed to store for free. Try a simpler picture.' });
  });
});

describe('fix round 1, F3: a picture this browser cannot draw', () => {
  it('the free ladder and the cover path give the same existing line (one constant), never a new one', async () => {
    vi.stubGlobal('createImageBitmap', async () => { throw new DOMException('cannot decode', 'InvalidStateError'); });
    const file = new Blob([new Uint8Array(8)]);
    expect(await BROWSER_ART.encodeFree?.(file, fitsFree(11155111, 107_520))).toEqual({ error: UNREADABLE });
    expect(await BROWSER_ART.encodeCover(file, 512)).toEqual({ error: UNREADABLE });
    expect(UNREADABLE).toBe('This browser could not read the picture.');
  });
});
