import { PICTURE_CASES, pictureFixture } from '../../artwork/src/picture-fixtures';
import { inspectBoxPicture } from '@squarehole/artwork/box-picture';
/**
 * The card itself: its words per state, the logo or the brand mark, a real 1200 x 630 PNG small enough to share, and the
 * same pixels from resvg's native build (the card service) as from its wasm build (the edge's former renderer).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { nodeCardAssets, svgToRgba } from './engine';
import { testCardEngine as nodeCardEngine } from './webp-test-support';
import type { ShareBox, ShareState } from './share-model';
import { base64, cardFonts, cardTree, COLUMN, nameSize, nameText, renderCardPng, textColumn, treeText, type CardEngine, type CardNode } from './share-render';
import { blankPng, edgePng } from './test-support';

/** Box 0's address on the local twin (public; a neutral name keeps the secret scanner's keyword rule quiet). */
const BOX_ADDRESS = '0xbd0a48c997121b66299e558db15b282485495c4a';
const ASSETS = nodeCardAssets();
const BOX: ShareBox = {
  chainId: 11_155_111,
  token: BOX_ADDRESS,
  chainLabel: 'Sepolia',
  name: 'The Misfits',
  ticker: 'FIT',
  demo: false,
  state: { kind: 'upcoming', opensAt: 1_791_734_400, approx: true },
  logoSha256: null,
};
/** A real PNG as a stand-in logo (box 0's collection cover, 1024 x 1024; box 0's logo itself is not pinned yet). */
const SAMPLE_LOGO = new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png')));

const images = (node: CardNode | string): string[] => {
  if (typeof node === 'string') return [];
  const own = node.type === 'img' && node.props.src ? [node.props.src.slice(0, 22)] : [];
  const children = node.props.children;
  return [...own, ...(children === undefined ? [] : (Array.isArray(children) ? children : [children]).flatMap((c: CardNode | string) => images(c)))];
};

describe('the card\'s words', () => {
  const words = (state: ShareState, extra: Partial<ShareBox> = {}) => treeText(cardTree({ ...BOX, ...extra, state }, null, ASSETS));

  it('per state: name, ticker, state (lead and main), the chain and the full address', () => {
    expect(words({ kind: 'upcoming', opensAt: 1_791_734_400, approx: true })).toEqual(['The Misfits', 'FIT', 'Opens about', '11 Oct 2026, 16:00 UTC', 'Sepolia', BOX_ADDRESS]);
    expect(words({ kind: 'upcoming', opensAt: 1_791_734_400, approx: false })).toEqual(['The Misfits', 'FIT', 'Opens', '11 Oct 2026, 16:00 UTC', 'Sepolia', BOX_ADDRESS]);
    expect(words({ kind: 'open' })).toEqual(['The Misfits', 'FIT', 'Open now', 'Sepolia', BOX_ADDRESS]);
    expect(words({ kind: 'graduating' })).toEqual(['The Misfits', 'FIT', 'Graduating', 'Sepolia', BOX_ADDRESS]);
    expect(words({ kind: 'graduated' })).toEqual(['The Misfits', 'FIT', 'Graduated', 'Sepolia', BOX_ADDRESS]);
  });

  it('a Demo box carries a Demo chip', () => {
    expect(words({ kind: 'open' }, { demo: true, chainLabel: 'Demo chain', name: 'Pocket Stamps', ticker: 'STMP' })).toEqual(['Pocket Stamps', 'STMP', 'Demo', 'Open now', 'Demo chain', BOX_ADDRESS]);
  });

  it('the name\'s size: by its length and by its longest unbroken run (a long word gets the small size)', () => {
    expect(nameSize('The Misfits')).toBe(76);
    expect(nameSize('Pocket Stamps Two')).toBe(64);
    expect(nameSize('The Extraordinary Square Pegs XL')).toBe(52);
    expect(nameSize('Squarepegsxyz')).toBe(64);
    expect(nameSize('CryptoPunksReloadedCollection')).toBe(52);
    expect(nameSize('W'.repeat(13))).toBe(64);
  });

  it('the logo in the hole, or the brand mark when there is none', () => {
    expect(images(cardTree(BOX, null, ASSETS))).toEqual(['data:image/svg+xml;bas', 'data:image/svg+xml;bas', 'data:image/svg+xml;bas']);
    expect(images(cardTree(BOX, { bytes: SAMPLE_LOGO, type: 'image/png' }, ASSETS))).toEqual(['data:image/png;base64,', 'data:image/png;base64,', 'data:image/svg+xml;bas', 'data:image/svg+xml;bas']);
  });
});

/** Width and height from a PNG's IHDR. */
const pngSize = (png: Uint8Array): [number, number] => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};

/** The extent of everything drawn (alpha > 0) in an RGBA image, as [minX, minY, maxX, maxY]. */
function drawnExtent(pixels: Uint8Array, width: number): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -1, -1];
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) === 0) continue;
    const x = ((i - 3) / 4) % width;
    const y = Math.floor((i - 3) / 4 / width);
    [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
  }
  return [minX, minY, maxX, maxY];
}

describe('the left column', () => {
  /**
   * The spec allows 32 bytes of printable ASCII and needs no space: the widest letters in one unbroken run, a long
   * plausible word, the widest ticker with the Demo chip and the widest address must all stay inside the column (left
   * of the hole).
   */
  const CASES: readonly Partial<ShareBox>[] = [
    { name: 'W'.repeat(32) },
    { name: 'M'.repeat(13) },
    { name: 'CryptoPunksReloadedCollection' },
    { name: 'Supercalifragilisticexpialidocio' },
    { name: 'The Extraordinary Square Pegs XL' },
    { name: '@'.repeat(32), ticker: 'W'.repeat(11), demo: true, chainLabel: 'Demo chain' },
    // "0" is the widest hex digit in the card's font.
    { token: `0x${'0'.repeat(40)}` },
  ];

  it('every name, chip and the full address stay inside it, drawn alone on a clear canvas', async () => {
    const engine = await nodeCardEngine();
    for (const extra of CASES) {
      const box: ShareBox = { ...BOX, ...extra };
      const root: CardNode = { type: 'div', props: { style: { display: 'flex', position: 'relative', width: 1200, height: 630 }, children: [textColumn(box, ASSETS)] } };
      const { pixels, width } = svgToRgba(await engine.satori(root, { width: 1200, height: 630, fonts: cardFonts(ASSETS) }));
      const [minX, minY, maxX, maxY] = drawnExtent(pixels, width);
      expect([minX >= COLUMN.left, minY >= COLUMN.top, maxX < COLUMN.left + COLUMN.width, maxY < COLUMN.top + COLUMN.height], `${box.name}: ${[minX, minY, maxX, maxY].join(', ')}`).toEqual([true, true, true, true]);
    }
  }, shLimit(60_000));

  it('the name\'s own lines (ellipsis included) fit the column, so its clip cuts nothing: the widest glyphs, unbroken', async () => {
    const engine = await nodeCardEngine();
    for (const glyph of ['W', 'M', '@', '%', 'Q', 'w', 'm', '&', '#']) {
      const name = glyph.repeat(32);
      const root: CardNode = { type: 'div', props: { style: { display: 'flex', width: 1200, height: 630 }, children: [nameText(name)] } };
      const { pixels, width } = svgToRgba(await engine.satori(root, { width: 1200, height: 630, fonts: cardFonts(ASSETS) }));
      expect(drawnExtent(pixels, width)[2], name).toBeLessThan(COLUMN.width);
    }
  }, shLimit(60_000));
});

describe('the rendered card', () => {
  it.each([[1200, 630], [400, 1200], [800, 800]])('SH-191: all four edge marks of a %i x %i logo remain inside the picture area', async (width, height) => {
    const engine = await nodeCardEngine('native');
    const logo = { bytes: edgePng(width, height), type: 'image/png' as const };
    const svg = await engine.satori(cardTree(BOX, logo, ASSETS), { width: 1200, height: 630, fonts: cardFonts(ASSETS) });
    const { pixels } = engine.rgba(svg);
    const scale = Math.min(268 / width, 268 / height);
    const left = 900 - width * scale / 2;
    const top = 315 - height * scale / 2;
    const expected = [[240, 20, 20, 255], [20, 220, 20, 255], [20, 20, 240, 255], [240, 220, 20, 255]];
    for (const [i, [x, y]] of ([[0.04, 0.04], [0.96, 0.04], [0.04, 0.96], [0.96, 0.96]] as const).entries()) {
      const px = Math.floor(left + x * width * scale);
      const py = Math.floor(top + y * height * scale);
      expect([px >= 766, px < 1034, py >= 181, py < 449]).toEqual([true, true, true, true]);
      const at = (py * 1200 + px) * 4;
      expect([...pixels.slice(at, at + 4)], `corner ${i}`).toEqual(expected[i]);
    }
  }, shLimit(60_000));

  it('SH-191: transparent art keeps dark and light marks over an opaque blurred ground in the single card theme', async () => {
    const engine = await nodeCardEngine('native');
    const logo = { bytes: edgePng(1200, 630, true), type: 'image/png' as const };
    const tree = cardTree(BOX, logo, ASSETS);
    expect(JSON.stringify(tree)).toContain('blur(16px)');
    const svg = await engine.satori(tree, { width: 1200, height: 630, fonts: cardFonts(ASSETS) });
    const { pixels } = engine.rgba(svg);
    const pixel = (x: number, y: number) => [...pixels.slice((y * 1200 + x) * 4, (y * 1200 + x) * 4 + 4)];
    expect(pixel(Math.floor(766 + 268 * 0.35), 315)).toEqual([0, 0, 0, 255]);
    expect(pixel(Math.floor(766 + 268 * 0.65), 315)).toEqual([255, 255, 255, 255]);
    const ground = pixel(900, 315);
    expect(ground[3]).toBe(255);
    expect(ground.slice(0, 3).every((value) => value > 10 && value < 240)).toBe(true);
  }, shLimit(60_000));

  it('a 1200 x 630 PNG under 300 KB (chat apps skip bigger previews), with and without a logo', async () => {
    const engine = await nodeCardEngine();
    for (const logo of [null, { bytes: SAMPLE_LOGO, type: 'image/png' as const }]) {
      const png = await renderCardPng(BOX, logo, ASSETS, engine);
      expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(pngSize(png)).toEqual([1200, 630]);
      expect(png.length).toBeLessThan(300_000);
    }
  }, shLimit(60_000));

  it('a logo too big once decoded never reaches the renderer, whoever passes it: the brand mark instead', async () => {
    const seen: string[][] = [];
    const spy: CardEngine = { satori: async (element) => (seen.push(images(element as CardNode)), '<svg/>'), png: () => new Uint8Array() };
    await renderCardPng(BOX, { bytes: blankPng(8000, 8000), type: 'image/png' }, ASSETS, spy);
    await renderCardPng(BOX, { bytes: SAMPLE_LOGO, type: 'image/png' }, ASSETS, spy);
    expect(seen.map((list) => list[0])).toEqual(['data:image/svg+xml;bas', 'data:image/png;base64,']);
  });

  it('a logo the renderer cannot draw falls back to the brand mark instead of failing', async () => {
    const engine = await nodeCardEngine();
    const broken = { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), type: 'image/png' as const };
    const png = await renderCardPng(BOX, broken, ASSETS, engine);
    expect(pngSize(png)).toEqual([1200, 630]);
  }, shLimit(60_000));

  it.each(['native', 'wasm'] as const)('SH-191: %s rejects a cut PNG and a silent decode failure before caching a chosen commitment', async (kind) => {
    const engine = await nodeCardEngine(kind);
    const bytes = blankPng(40, 40);
    const broken = bytes.slice();
    broken.fill(0, 41, broken.length - 12); // Keep size headers and IEND, damage the compressed pixels.
    for (const bad of [bytes.slice(0, 40), broken]) {
      const logo = { bytes: bad, type: 'image/png' as const };
      await expect(renderCardPng(BOX, logo, ASSETS, engine, false)).rejects.toThrow('picture cannot be drawn');
      expect(await renderCardPng(BOX, logo, ASSETS, engine)).toEqual(await renderCardPng(BOX, null, ASSETS, engine));
    }
    expect(engine.pictureDecodes?.({ bytes, type: 'image/png' })).toBe(true);
  }, shLimit(60_000));

  it('resvg\'s native build (the card service) draws the same pixels as its wasm build, with and without a logo', async () => {
    const native = await nodeCardEngine('native');
    const wasm = await nodeCardEngine('wasm');
    expect([native.kind, wasm.kind]).toEqual(['native', 'wasm']);
    for (const [box, logo] of [
      [BOX, null],
      [{ ...BOX, state: { kind: 'upcoming', opensAt: 1_791_734_400, approx: true } } as ShareBox, { bytes: SAMPLE_LOGO, type: 'image/png' as const }],
    ] as const) {
      const svg = await native.satori(cardTree(box, logo, ASSETS), { width: 1200, height: 630, fonts: cardFonts(ASSETS) });
      const [a, b] = [native.rgba(svg), wasm.rgba(svg)];
      expect([a.width, a.height]).toEqual([b.width, b.height]);
      let differing = 0;
      let largest = 0;
      for (let i = 0; i < a.pixels.length; i += 1) {
        const d = Math.abs((a.pixels[i] ?? 0) - (b.pixels[i] ?? 0));
        if (d > 0) differing += 1;
        largest = Math.max(largest, d);
      }
      expect({ differing, largest }).toEqual({ differing: 0, largest: 0 });
    }
  }, shLimit(60_000));
});

// Capability checks use the installed engines, never a fetch or a browser. Each file gets its own timeout.
const renderCases = (['native', 'wasm'] as const).flatMap((kind) => PICTURE_CASES.filter((f) => f.outcome === 'same-picture').map((fixture) => ({ kind, fixture, name: fixture.name })));
it.each(renderCases)('af3 $kind draws $name', async ({ kind, fixture }) => {
  const engine = await nodeCardEngine(kind);
  expect(engine.kind).toBe(kind);
  const info = inspectBoxPicture(fixture.bytes);
  if (!info) throw new Error(fixture.name);
  const picture = { bytes: fixture.bytes, type: info.type };
  const decoded = info.type === 'image/webp' ? await engine.decodeWebp?.(picture) : picture;
  expect(decoded, fixture.name).toBeTruthy();
  if (!decoded) throw new Error(`decode failed: ${fixture.name}`);
  expect(engine.pictureDecodes?.(decoded), fixture.name).toBe(true);
  if (info.type === 'image/webp') {
    const reference = { bytes: new Uint8Array(readFileSync(new URL(`./webp-fixtures/${fixture.name.replace('.webp', '.png')}`, import.meta.url))), type: 'image/png' as const };
    const actual = await renderCardPng(BOX, picture, ASSETS, engine, false);
    const expected = await renderCardPng(BOX, reference, ASSETS, engine, false);
    const pixels = (png: Uint8Array) => engine.rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><image width="1200" height="630" href="data:image/png;base64,${base64(png)}"/></svg>`).pixels;
    expect(pngSize(actual)).toEqual([1200, 630]);
    expect(Buffer.from(pixels(actual)).equals(Buffer.from(pixels(expected))), fixture.name).toBe(true);
  }
  // Run the complete Satori/resvg path for each format and transparency, not just the raw resvg probe.
  if (/ordinary|transparent|FIT/.test(fixture.name)) {
    expect(pngSize(await renderCardPng(BOX, picture, ASSETS, engine, false)), fixture.name).toEqual([1200, 630]);
  }
}, shLimit(60_000));

it.each(['native', 'wasm'] as const)('af5 %s draw failures use brand for every format', async (kind) => {
  const engine = await nodeCardEngine(kind);
  expect(engine.kind).toBe(kind);
  for (const fixture of PICTURE_CASES.filter((f) => f.outcome === 'page-picture-card-brand')) {
    const info = inspectBoxPicture(fixture.bytes);
    if (!info) throw new Error(fixture.name);
    const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><image width="3" height="2" href="data:${info.type};base64,${base64(fixture.bytes)}"/></svg>`;
    expect(engine.rgba(probe).pixels.some((n, i) => i % 4 === 3 && n > 0), fixture.name).toBe(false);
  }
  const picture = { bytes: pictureFixture('ordinary-cmyk.jpg'), type: 'image/jpeg' as const };
  expect(await renderCardPng(BOX, picture, ASSETS, engine)).toEqual(await renderCardPng(BOX, null, ASSETS, engine));
  await expect(renderCardPng(BOX, picture, ASSETS, engine, false)).rejects.toThrow('picture cannot be drawn');
}, shLimit(60_000));
