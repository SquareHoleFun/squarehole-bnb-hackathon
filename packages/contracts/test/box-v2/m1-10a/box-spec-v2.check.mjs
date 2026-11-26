#!/usr/bin/env node
// CQ11-D test manifest: frozen enum/struct parity, deterministic independent vectors and every menu combination.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModelV2, readSourcesV2 } from '../../../../box-spec/scripts/lib/outputs-v2.mjs';
import { buildVectors } from './encode-vectors.mjs';
const model = loadModelV2(readSourcesV2());
if (!model) throw new Error('missing frozen model');
const { text, vectors } = buildVectors();
const file = fileURLToPath(new URL('../../vectors/box-spec/box-spec-v2.json', import.meta.url));
if (readFileSync(file, 'utf8') !== text) throw new Error('stale shared vectors');
for (const buyers of ['keep', 'burn', 'grow']) for (const sellers of ['keep', 'burn', 'grow']) {
  if (!vectors.some((v) => v.name === `menu-0-${buyers}-${sellers}` && v.reason === 0)) throw new Error('missing menu pair');
}
if (!vectors.some((v) => v.name === 'stale-raise' && v.reason !== 0)) throw new Error('missing stale raise refusal');
process.stdout.write(`CQ11-D: frozen shapes and ${vectors.length} independent vectors checked\n`);
