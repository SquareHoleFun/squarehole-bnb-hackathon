import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { encodeGlb } from './lib/glb.mjs';
import { makeHouse, NAMES } from './lib/houses.mjs';
import { checkModel } from './check-models.mjs';

export function buildModels(out = fileURLToPath(new URL('./', import.meta.url))) {
  mkdirSync(out, { recursive: true });
  const manifest = NAMES.map((name, i) => {
    const variant = i + 1, file = `variant-${String(variant).padStart(2, '0')}.glb`;
    const bytes = encodeGlb(makeHouse(variant), name);
    const { triangles } = checkModel(bytes);
    writeFileSync(join(out, file), bytes);
    return { variant, name, file, bytes: bytes.length, triangles, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Started as a program (through any symlink), not imported: a path that is no file (an `-e` argument) is not this file. */
function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isEntry()) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node build-models.mjs [--out directory]');
  const manifest = buildModels(args[1]);
  process.stdout.write(manifest.map(m => `${m.file}: ${m.bytes} bytes, ${m.triangles} triangles`).join('\n') + '\n');
}
