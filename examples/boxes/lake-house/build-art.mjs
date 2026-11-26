/**
 * Builds the Lake House pictures in art/ from src/: the mark's SVG, its PNG at 1024 and at 48 pixels, and
 * palette.json, the provenance of every colour (ADR-0004: sampled from the approved reference PNGs). Rendered
 * locally with @resvg/resvg-js (no fonts, no network). Running it twice gives the same bytes.
 *
 *   node examples/boxes/lake-house/build-art.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { C } from './src/palette.mjs';
import { logoSvg } from './src/logo.mjs';
import { loadResvg, toPng } from './src/render.mjs';
import { samplePalette } from './src/sample.mjs';

const root = new URL('./', import.meta.url);
const at = rel => new URL(rel, root);

/** Every built file as [path, bytes], or a thrown error when the reference no longer gives the palette. */
export function pieces(Resvg, read) {
  const { colours, provenance } = samplePalette(Resvg, read);
  for (const [name, hex] of Object.entries(colours)) {
    if (C[name] !== hex) throw new Error(`palette ${name}: the reference gives ${hex}, src/palette.mjs has ${C[name]}`);
  }
  const svg = logoSvg();
  const palette = { format: 'squarehole.kit-palette/1', kit: 'lake-house', policy: 'ADR-0004: colours sampled from the approved reference PNGs, inside approved cast crops, clear of excluded crops', samples: provenance };
  return [
    ['art/logo.svg', Buffer.from(svg)],
    ['art/logo.png', toPng(Resvg, svg)],
    ['art/logo-48.png', toPng(Resvg, svg, 48)],
    ['art/palette.json', Buffer.from(`${JSON.stringify(palette, null, 2)}\n`)],
  ];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) throw new Error(`unknown option ${args.join(' ')}; build-art.mjs takes none`);
  const Resvg = await loadResvg();
  mkdirSync(at('art'), { recursive: true });
  const built = pieces(Resvg);
  for (const [path, bytes] of built) writeFileSync(at(path), bytes);
  process.stdout.write(`built ${built.length} files in art/\n`);
}

if (import.meta.main) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
