/** Offline raster adapter for the page's own free ladder; no signer or upload. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { artwork, shrink, arweave } from './app.mjs';
const { inspectImage } = artwork;
const { Resvg } = createRequire(new URL('../../packages/cards/package.json', import.meta.url))('@resvg/resvg-js');
export const FREE_FIT = arweave.fitsFree(11155111, 107_520);
/** One picture encodes in well under a second; two minutes only bounds a stuck encoder. */
const CWEBP_TIMEOUT_MS = 120_000;
const encoder = {
  webp: async () => true,
  async draw(file, edge) {
    const source = Buffer.from(await file.arrayBuffer());
    const info = inspectImage(source, { maxBytes: 10 * 1024 * 1024, minSide: 1, maxSide: 8192 });
    if (!info.ok) return null;
    const scale = Math.min(1, edge / Math.max(info.width, info.height));
    const width = Math.max(1, Math.round(info.width * scale));
    const height = Math.max(1, Math.round(info.height * scale));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${source.toString('base64')}"/></svg>`;
    return new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  },
  async encode(png, type, quality) {
    if (type === 'image/png') return new Blob([png], { type });
    assert.equal(type, 'image/webp');
    // cwebp 1.6.0: stdin/stdout only; no shell, temporary image, network, metadata or native dependency install.
    // A bounded run: once (2026-10-25, under heavy load) cwebp sat on its input for hours and blocked pnpm verify.
    const timeoutMs = Number(process.env.SH_KITS_CWEBP_TIMEOUT_MS ?? CWEBP_TIMEOUT_MS);
    const result = spawnSync('cwebp', ['-quiet', '-q', String(quality * 100), '-metadata', 'none', '-o', '-', '--', '-'],
      { input: png, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' });
    if (result.error?.code === 'ENOENT') {
      const error = new Error('cwebp is required for the offline free-picture encoder', { cause: result.error });
      error.code = 'ERR_CWEBP_REQUIRED';
      throw error;
    }
    if (result.error?.code === 'ETIMEDOUT') {
      const error = new Error(`cwebp did not finish within ${timeoutMs} ms`, { cause: result.error });
      error.code = 'ERR_CWEBP_TIMEOUT';
      throw error;
    }
    assert.equal(result.status, 0, 'cwebp is required for the offline free-picture encoder');
    return new Blob([result.stdout], { type });
  },
};
export const encodeFree = (file, fits) => shrink.shrinkPicture(file, fits, encoder);

/** Same pixels, bounded sides, no metadata; pinned resvg raster decoder/PNG encoder, no browser or fonts. */
export async function encodePicture(file, side) {
  const source = Buffer.from(await file.arrayBuffer());
  const checked = inspectImage(source, { maxBytes: 10 * 1024 * 1024, minSide: 1, maxSide: 8192 });
  assert.ok(checked.ok, 'invalid source picture');
  const longest = Math.max(checked.width, checked.height);
  for (let limit = Math.min(side, longest); limit >= 128; limit = Math.floor(limit * 3 / 4)) {
    const width = Math.max(1, Math.floor(checked.width * limit / longest));
    const height = Math.max(1, Math.floor(checked.height * limit / longest));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${checked.width} ${checked.height}"><image width="${checked.width}" height="${checked.height}" href="data:image/png;base64,${source.toString('base64')}"/></svg>`;
    const bytes = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
    if (bytes.length <= 1_048_576) return { bytes };
  }
  throw new Error('processed picture exceeds raw block limit');
}
