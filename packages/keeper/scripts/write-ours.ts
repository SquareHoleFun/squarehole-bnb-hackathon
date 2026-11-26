/** Writes OURS.md (F95 R19S) and the test-only Solidity floor fixture. `--check` fails on drift. */
import { readFileSync, writeFileSync } from 'node:fs';
import { JOBS, renderOursList } from '../src/jobs';
import { renderReleaseGas } from './release-gas';

for (const [file, text] of [
  ['OURS.md', renderOursList(JOBS)],
  ['../contracts/test/box-v2/final/round3/PublishedGas.sol', renderReleaseGas()],
] as const) {
  const path = new URL(`../${file}`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== text) {
      console.error(`${file} is stale: run pnpm --filter @squarehole/keeper ours:write`);
      process.exitCode = 1;
    }
  } else {
    writeFileSync(path, text);
  }
}
