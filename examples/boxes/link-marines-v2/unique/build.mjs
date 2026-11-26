import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deal, schema } from './deal.mjs';
import { pictureSvg, picturePng } from './picture.mjs';
import { model } from './model.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function build(out, progress = () => {}) {
  if (process.versions.node !== '24.22.1') throw new Error('Use Node 24.22.1');
  mkdirSync(out, { recursive: true });
  const manifest = { format: 'link-marines-v2/unique-manifest/1', seed: schema.seed, count: schema.count, items: [] };
  for (const row of deal()) {
    const svg = Buffer.from(pictureSvg(row)), png = picturePng(row), glb = model(row);
    const checked = checkModel(glb);
    if (png.length >= 400*1024) throw new Error(`Picture ${row.id} exceeds budget`);
    for (const [name, bytes] of [[`picture-${row.id}.svg`, svg], [`picture-${row.id}.png`, png], [`model-${row.id}.glb`, glb]]) writeFileSync(join(out,name), bytes);
    const asset = (bytes, file) => ({ file, sha256: hash(bytes), bytes: bytes.length });
    manifest.items.push({ ...row, picture: asset(png, `picture-${row.id}.png`), svg: asset(svg, `picture-${row.id}.svg`), model: { ...asset(glb, `model-${row.id}.glb`), triangles: checked.triangles } });
    if (BigInt(row.id)%60n===0n) progress(`Built ${row.id} / ${schema.count}`);
  }
  writeFileSync(join(out,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);
  return manifest;
}
if (import.meta.main) {
  if(process.argv.length!==4||process.argv[2]!=='--out') throw new Error('Usage: node unique/build.mjs --out <temporary-folder>');
  build(process.argv[3],message => process.stdout.write(`${message}\n`));
}
