#!/usr/bin/env node
/** Generate the Solidity and TypeScript twins from box-spec.v2.json and add-ons.v2.json.
 * --check refuses stale twins. M1-10-a's encode-vectors.mjs separately owns the vectors.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { loadModelV2, outputsV2, readSourcesV2 } from './lib/outputs-v2.mjs';
import { repoDir } from './lib/model.mjs';

const outputs = outputsV2(loadModelV2(readSourcesV2()));
const check = process.argv.includes('--check');
const stale = [];
for (const [path, content] of outputs) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) continue;
  if (check) stale.push(relative(repoDir, path));
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    process.stdout.write(`wrote ${relative(repoDir, path)}\n`);
  }
}
if (check) {
  if (stale.length) {
    console.error(`check:box-spec v2: stale generated files (run \`node packages/box-spec/scripts/generate-v2.mjs\`):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  process.stdout.write(`check:box-spec v2: ${outputs.length} generated files are up to date\n`);
}
