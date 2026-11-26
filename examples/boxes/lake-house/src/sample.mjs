import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MANIFEST, PATCH_RADIUS, REFERENCE_DIR, SAMPLES } from './palette.mjs';
import { pngPixels } from './render.mjs';

const repo = new URL('../../../../', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = ([x0, y0, x1, y1], x, y, r) => x - r >= x0 && x + r < x1 && y - r >= y0 && y + r < y1;
const touches = ([x0, y0, x1, y1], x, y, r) => x + r >= x0 && x - r < x1 && y + r >= y0 && y - r < y1;

/**
 * Samples every palette colour again from the reference PNGs (ADR-0004): checks each source against the SHA-256 the
 * design manifest pins, keeps each 5 x 5 patch inside its named approved crop and clear of every excluded crop, and
 * averages it (integer division). Returns the colours and their provenance, or throws on the first problem.
 */
export function samplePalette(Resvg, read = path => readFileSync(new URL(path, repo))) {
  const manifest = JSON.parse(read(MANIFEST).toString('utf8'));
  const crops = new Map(manifest.assets.map(a => [a.id, a]));
  const decoded = new Map();
  const colours = {};
  const provenance = [];
  for (const s of SAMPLES) {
    const crop = crops.get(s.crop);
    if (!crop) throw new Error(`${s.name}: no approved crop ${s.crop} in ${MANIFEST}`);
    if (!inside(crop.box, s.x, s.y, PATCH_RADIUS)) throw new Error(`${s.name}: its patch leaves the ${s.crop} crop`);
    for (const ex of manifest.excluded) {
      if (ex.source === crop.source && touches(ex.box, s.x, s.y, PATCH_RADIUS)) throw new Error(`${s.name}: its patch touches an excluded crop (${ex.what})`);
    }
    const source = manifest.sources[crop.source];
    if (!decoded.has(crop.source)) {
      const bytes = read(`${REFERENCE_DIR}/${crop.source}`);
      if (sha256(bytes) !== source.sha256) throw new Error(`${crop.source}: SHA-256 differs from ${MANIFEST}`);
      decoded.set(crop.source, pngPixels(Resvg, bytes, source.width, source.height));
    }
    const { data, w } = decoded.get(crop.source);
    const sum = [0, 0, 0];
    let count = 0;
    for (let i = s.x - PATCH_RADIUS; i <= s.x + PATCH_RADIUS; i++) {
      for (let j = s.y - PATCH_RADIUS; j <= s.y + PATCH_RADIUS; j++) {
        const o = (j * w + i) * 4;
        for (let k = 0; k < 3; k++) sum[k] += data[o + k];
        count += 1;
      }
    }
    const hex = `#${sum.map(v => Math.floor(v / count).toString(16).toUpperCase().padStart(2, '0')).join('')}`;
    colours[s.name] = hex;
    provenance.push({ name: s.name, hex, source: `${REFERENCE_DIR}/${crop.source}`, sourceSha256: source.sha256,
      crop: s.crop, cropBox: crop.box, patch: [s.x - PATCH_RADIUS, s.y - PATCH_RADIUS, s.x + PATCH_RADIUS + 1, s.y + PATCH_RADIUS + 1], use: s.use });
  }
  return { colours, provenance };
}
