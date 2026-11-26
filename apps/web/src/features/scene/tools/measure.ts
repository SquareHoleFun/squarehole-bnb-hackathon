/**
 * Measures the SH-008 bundle budget from the lab build.
 *
 *   cd apps/web && pnpm exec vite build --config src/features/scene/scene.vite.config.ts \
 *     && node src/features/scene/tools/measure.ts
 *
 * Eager = what a route pays for importing ShapeSorterAccent (accent JS + CSS + one poster).
 * Lazy  = the three.js chunk, fetched only when gating allows WebGL.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const assets = fileURLToPath(new URL('../dist/lab/assets/', import.meta.url));
const GROUPS: readonly { readonly label: string; readonly pattern: RegExp; readonly compressible: boolean }[] = [
  { label: 'eager accent JS', pattern: /^scene-accent-.*\.js$/, compressible: true },
  { label: 'eager accent CSS', pattern: /^scene-accent-.*\.css$/, compressible: true },
  { label: 'lazy three.js chunk', pattern: /^sorterScene-.*\.js$/, compressible: true },
  { label: 'poster (pin)', pattern: /^shape-sorter-pin-.*\.webp$/, compressible: false },
  { label: 'poster (wizard)', pattern: /^shape-sorter-wizard-.*\.webp$/, compressible: false },
  { label: 'react-vendor (lab only, not SH-008 cost)', pattern: /^react-vendor-.*\.js$/, compressible: true },
];

const files = await readdir(assets);
const rows: string[] = ['| Asset | File | Raw bytes | gzip -9 bytes | brotli bytes |', '|---|---|---:|---:|---:|'];
for (const group of GROUPS) {
  const name = files.find((f) => group.pattern.test(f));
  if (!name) throw new Error(`Missing ${group.label}; build the lab first.`);
  const bytes = await readFile(`${assets}${name}`);
  const gzip = group.compressible ? gzipSync(bytes, { level: 9 }).length : bytes.length;
  const brotli = group.compressible
    ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
    : bytes.length;
  rows.push(`| ${group.label} | ${name} | ${bytes.length} | ${gzip} | ${brotli} |`);
}
process.stdout.write(`${rows.join('\n')}\n`);
