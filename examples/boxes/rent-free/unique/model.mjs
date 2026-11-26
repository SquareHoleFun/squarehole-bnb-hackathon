import assert from 'node:assert/strict';
import { encodeGlb } from '../models/lib/glb.mjs';
import { houseScene } from './lib/scene.mjs';
import { deal } from './deal.mjs';
import { isMain, requireNode, write } from './lib/io.mjs';

export const modelGlb = traits => encodeGlb(houseScene(traits), 'Rent Free house');
if (isMain(import.meta.url)) {
  requireNode();
  const [id, out, extra] = process.argv.slice(2);
  assert.ok(id && out && !extra, 'Usage: node model.mjs <id> <output.glb>');
  const row = deal().find(row => row.id === id);
  assert.ok(row, 'canonical id 1 to 500');
  write(out, modelGlb(row.traits));
}
