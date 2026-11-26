// @vitest-environment node
/**
 * SH-ARWEAVE-PICTURES-WEB: the free ladder, step by step, with a fake encoder whose sizes the test sets (no canvas):
 * the WebP path, the Safari path without a WebP encoder (transparency painted onto the site ground first), the fit check,
 * the refusal, and that each edge is drawn once.
 */
import { describe, expect, it } from 'vitest';
import { JPEG_LADDER, SITE_GROUND, TOO_DETAILED, UNREADABLE, WEBP_LADDER, shrinkPicture, type PictureEncoder, type PictureMime, type ShrinkStep } from './shrink';
import { fitsFree } from './arweave-publish';

interface FakeCanvas { readonly edge: number; readonly ground: string | null }
type Sizes = (edge: number, type: PictureMime, quality: number | undefined) => number;

/** An encoder whose output size per step is `sizes`; `webp` false: WebP asks answer PNG, as Safari's canvas does. */
function encoder(sizes: Sizes, { webp = true, unreadable = false }: { webp?: boolean; unreadable?: boolean } = {}) {
  const draws: FakeCanvas[] = [];
  const encodes: string[] = [];
  const fake: PictureEncoder<FakeCanvas> = {
    webp: async () => webp,
    draw: async (_file, edge, ground) => {
      if (unreadable) return null;
      const canvas = { edge, ground };
      draws.push(canvas);
      return canvas;
    },
    encode: async (canvas, type, quality) => {
      encodes.push(`${canvas.edge} ${type.slice(6)}${quality === undefined ? '' : ` ${quality}`}`);
      const written: PictureMime = type === 'image/webp' && !webp ? 'image/png' : type;
      return new Blob([new Uint8Array(sizes(canvas.edge, written, quality))], { type: written });
    },
  };
  return { fake, draws, encodes };
}
const FILE = new Blob([new Uint8Array(8)], { type: 'image/png' });
const KIB = 1024;
const step = (s: ShrinkStep) => `${s.edge} ${s.type.slice(6)}${s.quality === undefined ? '' : ` ${s.quality}`}`;
const ALL_WEBP = WEBP_LADDER.map(step);
const ALL_JPEG = JPEG_LADDER.map(step);
/** Turbo's free size today on Sepolia, as Create checks it. */
const FITS = fitsFree(11155111, 107_520);

describe('the ladders (the AI-size test’s recommended setting)', () => {
  it('WebP browsers: 1200 PNG (≤ 100 KiB) then WebP 0.8/0.7/0.6, 1024 WebP 0.6, 768 WebP 0.8/0.7/0.6, 512 WebP 0.8', () => {
    expect(ALL_WEBP).toEqual(['1200 png', '1200 webp 0.8', '1200 webp 0.7', '1200 webp 0.6', '1024 webp 0.6', '768 webp 0.8', '768 webp 0.7', '768 webp 0.6', '512 webp 0.8']);
    expect(WEBP_LADDER[0]?.maxBytes).toBe(100 * KIB);
  });
  it('no WebP encoder (Safari, iPhones): JPEG 768 0.9/0.8/0.7/0.6, then 512 0.8/0.6, on the site ground', () => {
    expect(ALL_JPEG).toEqual(['768 jpeg 0.9', '768 jpeg 0.8', '768 jpeg 0.7', '768 jpeg 0.6', '512 jpeg 0.8', '512 jpeg 0.6']);
    expect(SITE_GROUND).toBe('#1b2638');
  });
});

describe('shrinkPicture with a WebP encoder', () => {
  it('a flat picture: PNG at 1200 px when it is at most 100 KiB', async () => {
    const e = encoder(() => 40 * KIB);
    const shrunk = await shrinkPicture(FILE, FITS, e.fake);
    expect(shrunk).toMatchObject({ type: 'image/png', step: WEBP_LADDER[0] });
    expect(e.encodes).toEqual(['1200 png']);
    expect(e.draws).toEqual([{ edge: 1200, ground: null }]);
  });

  it('a PNG over 100 KiB is skipped even though the free size would take it; WebP 0.8 at 1200 px wins', async () => {
    const e = encoder((_edge, type) => (type === 'image/png' ? 101 * KIB : 90 * KIB));
    expect(await shrinkPicture(FILE, FITS, e.fake)).toMatchObject({ type: 'image/webp', step: { edge: 1200, quality: 0.8 } });
    expect(e.encodes).toEqual(['1200 png', '1200 webp 0.8']);
  });

  it.each(WEBP_LADDER.map((entry, index) => [step(entry), index] as const))('stops at the first step that fits: %s', async (_name, index) => {
    // Every step before `index` is one byte over the free fit; the step at `index` fits.
    const e = encoder((edge, type, quality) => (step({ edge, type, quality }) === ALL_WEBP[index] ? 50 * KIB : 107_520));
    const shrunk = await shrinkPicture(FILE, FITS, e.fake);
    expect(shrunk).toMatchObject({ step: WEBP_LADDER[index] });
    expect(e.encodes).toEqual(ALL_WEBP.slice(0, index + 1));
    // Each edge is drawn once, however many steps encode it.
    expect(e.draws.map((d) => d.edge)).toEqual([...new Set(WEBP_LADDER.slice(0, index + 1).map((s) => s.edge))]);
  });

  it('the fit is the whole signed item: a picture that leaves no room for the header and tags is one step too big', async () => {
    const limit = 107_520;
    const room = Array.from({ length: 400 }, (_, i) => limit - i).find((n) => FITS(n, 'image/webp'));
    expect(room).toBeDefined();
    expect(limit - (room ?? 0)).toBeGreaterThan(250);
    const e = encoder((_edge, type, quality) => (type === 'image/webp' && quality === 0.8 ? (room ?? 0) + 1 : (room ?? 0)));
    expect(await shrinkPicture(FILE, FITS, e.fake)).toMatchObject({ step: { edge: 1200, quality: 0.7 } });
  });

  it('nothing fits: refused with one short line (no 1 MiB fallback)', async () => {
    const e = encoder(() => 200 * KIB);
    expect(await shrinkPicture(FILE, FITS, e.fake)).toEqual({ error: TOO_DETAILED });
    expect(TOO_DETAILED).toBe('Too detailed to store for free. Try a simpler picture.');
    expect(e.encodes).toEqual(ALL_WEBP);
  });

  it('a picture the browser cannot draw is refused at once', async () => {
    expect(await shrinkPicture(FILE, FITS, encoder(() => 1, { unreadable: true }).fake)).toEqual({ error: UNREADABLE });
  });
});

describe('shrinkPicture without a WebP encoder (Safari, iPhones)', () => {
  it('detects it at run time and takes the JPEG ladder, painting every drawing on the site ground first (no black corners)', async () => {
    const e = encoder((edge, _type, quality) => (edge === 768 && quality === 0.7 ? 90 * KIB : 120 * KIB), { webp: false });
    const shrunk = await shrinkPicture(FILE, FITS, e.fake);
    expect(shrunk).toMatchObject({ type: 'image/jpeg', step: { edge: 768, quality: 0.7 } });
    expect(e.encodes).toEqual(['768 jpeg 0.9', '768 jpeg 0.8', '768 jpeg 0.7']);
    expect(e.draws).toEqual([{ edge: 768, ground: SITE_GROUND }]);
  });

  it('falls to 512 px, then refuses; it never asks for WebP or PNG', async () => {
    const at512 = encoder((edge, _type, quality) => (edge === 512 && quality === 0.6 ? 80 * KIB : 150 * KIB), { webp: false });
    expect(await shrinkPicture(FILE, FITS, at512.fake)).toMatchObject({ step: { edge: 512, quality: 0.6 } });
    expect(at512.encodes).toEqual(ALL_JPEG);
    expect(at512.draws).toEqual([{ edge: 768, ground: SITE_GROUND }, { edge: 512, ground: SITE_GROUND }]);
    const never = encoder(() => 150 * KIB, { webp: false });
    expect(await shrinkPicture(FILE, FITS, never.fake)).toEqual({ error: TOO_DETAILED });
    expect(never.encodes.some((entry) => /webp|png/.test(entry))).toBe(false);
  });

  it('an encoder that reports WebP but answers another type at a step: that step is skipped, never kept', async () => {
    const e = encoder(() => 10 * KIB);
    const lying: PictureEncoder<FakeCanvas> = { ...e.fake, encode: async (canvas, type, quality) => (type === 'image/webp' ? new Blob([new Uint8Array(10)], { type: 'image/png' }) : e.fake.encode(canvas, type, quality)) };
    const big = encoder(() => 200 * KIB);
    const lyingBigPng: PictureEncoder<FakeCanvas> = { ...lying, encode: async (canvas, type, quality) => (type === 'image/png' ? big.fake.encode(canvas, type, quality) : lying.encode(canvas, type, quality)) };
    expect(await shrinkPicture(FILE, FITS, lyingBigPng)).toEqual({ error: TOO_DETAILED });
  });
});
