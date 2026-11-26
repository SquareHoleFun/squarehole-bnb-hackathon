import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkModels } from './check-models.mjs';
import { encodePng, decodePng, canvas, blit, label, renderGlb } from './lib/raster.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const manifest = checkModels(root), out = join(root, 'renders');
mkdirSync(out, { recursive: true });
const sheet = canvas(1536, 12 * 560);
for (const [i, entry] of manifest.entries()) {
  const id = `variant-${String(entry.variant).padStart(2, '0')}`;
  const original = decodePng(readFileSync(join(root, '../art/houses', `${id}.png`)));
  blit(sheet, original, 0, i * 560 + 48);
  label(sheet, `${String(entry.variant).padStart(2, '0')} ${entry.name} - ORIGINAL`, 20, i * 560 + 17);
  const bytes = readFileSync(join(root, entry.file));
  for (const [j, camera] of ['front', 'three-quarter'].entries()) {
    const image = renderGlb(bytes, camera);
    writeFileSync(join(out, `${id}-${camera}.png`), encodePng(image));
    blit(sheet, image, (j + 1) * 512, i * 560 + 48);
    label(sheet, camera === 'front' ? 'FRONT' : 'FRONT LEFT - THREE-QUARTER', (j + 1) * 512 + 20, i * 560 + 17);
  }
  process.stdout.write(`${id}: front and three-quarter rendered from GLB\n`);
}
writeFileSync(join(out, 'contact-sheet.png'), encodePng(sheet));
