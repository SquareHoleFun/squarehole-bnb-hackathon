/**
 * The card engine on Node: satori 0.28.2 (its standalone build, yoga's wasm read from node_modules) and resvg 2.6.2,
 * either its native build (@resvg/resvg-js, a prebuilt binary per platform: the card service) or its wasm build
 * (@resvg/resvg-wasm: the fallback when no native binary loads, and the tests' engine). Both are the same resvg
 * release, drawing without system fonts (satori turns every word into paths), and give the same pixels
 * (share-render.test.ts compares them). Also the card's fonts and brand files, from ../assets (the brand kit's files and
 * Plus Jakarta Sans, unchanged).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg as WasmResvg } from '@resvg/resvg-wasm';
import satori, { init } from 'satori/standalone';
import { base64, type CardAssets, type CardEngine } from './share-render';
import type { Logo } from './share-art';
import { WebpDecoder } from './webp-decoder';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The card's fonts and brand files. */
export const CARD_ASSETS_DIR = join(HERE, '..', 'assets');

const require = createRequire(import.meta.url);

export type EngineKind = 'native' | 'wasm';

export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface NodeCardEngine extends CardEngine {
  /** The resvg build in use (a native binary that does not load falls back to wasm). */
  readonly kind: EngineKind;
  /** SVG to RGBA pixels (tests: what a card draws where). */
  rgba(svg: string): Pixels;
}

interface NativeImage {
  asPng(): Uint8Array;
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}
type NativeResvg = new (svg: string, options?: { readonly font?: { readonly loadSystemFonts?: boolean } }) => { render(): NativeImage };

/** satori only lays out and turns text into paths; resvg needs no font of its own (and reading the system's is slow). */
const NO_SYSTEM_FONTS = { font: { loadSystemFonts: false } } as const;
const PROBE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#a78bfa"/></svg>';

/** resvg silently omits damaged images. Force decoded alpha opaque in the probe, so transparent pictures count too. Missing images stay absent. */
function pictureDecoder(rgba: (svg: string) => Pixels): (picture: Logo) => boolean {
  return (picture) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="268" height="268"><defs><filter id="decoded" x="0" y="0" width="1" height="1"><feComponentTransfer><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer></filter></defs><image filter="url(#decoded)" width="268" height="268" href="data:${picture.type};base64,${base64(picture.bytes)}"/></svg>`;
    const { pixels } = rgba(svg);
    return pixels.some((alpha, index) => index % 4 === 3 && alpha > 0);
  };
}

/** A start-up step run once (again after a failure). */
function once(start: () => Promise<void>): () => Promise<void> {
  let ready: Promise<void> | null = null;
  return () => {
    if (ready === null) {
      ready = start();
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };
}

const readySatori = once(() => init(readFileSync(require.resolve('satori/yoga.wasm'))));
const readyWasm = once(() => initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))));

/** SVG to PNG with resvg's wasm build, freeing its memory after each card. */
function wasmPng(svg: string): Uint8Array {
  const resvg = new WasmResvg(svg);
  const image = resvg.render();
  try {
    return image.asPng();
  } finally {
    image.free();
    resvg.free();
  }
}

/** SVG to RGBA pixels with resvg's wasm build (the engine must be ready: `nodeCardEngine()`). */
export function svgToRgba(svg: string): Pixels {
  const resvg = new WasmResvg(svg);
  const image = resvg.render();
  try {
    return { width: image.width, height: image.height, pixels: image.pixels.slice() };
  } finally {
    image.free();
    resvg.free();
  }
}

/** resvg's native build, checked with one tiny drawing; null when its binary does not load on this platform. */
function nativeResvg(): NativeResvg | null {
  try {
    const { Resvg } = require('@resvg/resvg-js') as { Resvg: NativeResvg };
    const probe = new Resvg(PROBE_SVG, NO_SYSTEM_FONTS).render();
    return probe.width === 2 && probe.asPng().length > 0 ? Resvg : null;
  } catch {
    return null;
  }
}

/** The engine: `native` uses resvg's native build when it loads (else wasm); `wasm` the wasm build. */
let sharedWebp: Promise<WebpDecoder> | undefined;
export async function nodeCardEngine(prefer: EngineKind = 'wasm', decoder?: WebpDecoder): Promise<NodeCardEngine> {
  await readySatori();
  const webp = decoder ?? await (sharedWebp ??= WebpDecoder.start());
  const draw = {
    get webpDrawing() { return webp.available; },
    decodeWebp: (picture: Logo) => webp.decode(picture),
    close: () => webp.close(),
    satori: (element: Parameters<CardEngine['satori']>[0], options: Parameters<CardEngine['satori']>[1]) => satori(element as never, options as never),
  };
  const Native = prefer === 'native' ? nativeResvg() : null;
  if (Native !== null) {
    const rgba = (svg: string): Pixels => {
      const image = new Native(svg, NO_SYSTEM_FONTS).render();
      return { width: image.width, height: image.height, pixels: new Uint8Array(image.pixels) };
    };
    return {
      ...draw,
      kind: 'native',
      png: (svg) => new Uint8Array(new Native(svg, NO_SYSTEM_FONTS).render().asPng()),
      rgba,
      pictureDecodes: pictureDecoder(rgba),
    };
  }
  await readyWasm();
  return { ...draw, kind: 'wasm', png: wasmPng, rgba: svgToRgba, pictureDecodes: pictureDecoder(svgToRgba) };
}

const buffer = (path: string): ArrayBuffer => {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

/** The card's fonts and brand files from a folder laid out as ../assets is. Throws when one is missing. */
export function nodeCardAssets(dir: string = CARD_ASSETS_DIR): CardAssets {
  return {
    regular: buffer(join(dir, 'fonts', 'plus-jakarta-sans-latin-500-normal.woff')),
    bold: buffer(join(dir, 'fonts', 'plus-jakarta-sans-latin-700-normal.woff')),
    mark: readFileSync(join(dir, 'brand', 'mark.svg'), 'utf8'),
    wordmark: readFileSync(join(dir, 'brand', 'wordmark.svg'), 'utf8'),
  };
}
