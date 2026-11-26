// Run from the repository root after the four SH_MEASURE_BATCH_BYTES capacity measurements.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { multicall3Bytecode } = require(resolve(dirname(require.resolve('viem')), 'constants/contracts.js'));
const directory = '.cache/keeper-batch-gas';
mkdirSync(directory, { recursive: true });
const counts = {};
for (const size of [2048, 8192, 16384, 32768]) {
  const label = process.argv.includes('--final') && size === 16384 ? 'default' : size;
  const batches = [4, 50, 150].flatMap(boxes => [false, true].flatMap(active =>
    JSON.parse(readFileSync(`.cache/capacity-keeper-${boxes}-${active}-${label}.json`, 'utf8')).aggregates));
  // Combine maxima even if they came from different calls: conservative gas/size envelope.
  counts[`b${size}`] = Object.fromEntries(['calls', 'inputBytes', 'outputBytes', 'childBytes'].map(key =>
    [key, Math.max(...batches.map(batch => batch[key]))]));
}
writeFileSync(`${directory}/counts.json`, `${JSON.stringify(counts, null, 2)}\n`);
writeFileSync(`${directory}/multicall.hex`, multicall3Bytecode);
writeFileSync(`${directory}/foundry.toml`, `[profile.default]
src = "../../packages/keeper/test/gas"
test = "../../packages/keeper/test/gas"
out = "out"
cache_path = "cache"
solc = "0.8.26"
evm_version = "cancun"
optimizer = true
optimizer_runs = 1000
fs_permissions = [{ access = "read", path = "." }]
`);
process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
