#!/usr/bin/env node
/**
 * BoxSpecV1 generator (launch pipeline v1 § 1, slice S1; BC-001).
 *
 * Reads the single source of truth (packages/box-spec/box-spec.v1.json, add-ons.v1.json and, F78, the build profiles
 * build-profiles.v1.json), the fixtures
 * (packages/box-spec/fixtures/*.json) and the hand-declared vector cases (packages/box-spec/vectors/cases.v1.json),
 * and writes:
 *   - packages/contracts/src/box/BoxSpecV1.sol           the struct, fixed values, validate() and specHash()
 *   - packages/box-spec/src/generated/box-spec.v1.ts      the same in TypeScript, with the zod schema
 *   - packages/box-spec/src/generated/fixtures.v1.ts      the fixtures in wire form, with their spec hashes
 *   - packages/contracts/test/vectors/box-spec/box-spec-v1.json   the shared vectors Foundry and vitest both run
 *   - packages/contracts/src/box/build/<profile>/BoxBuildV1.sol   each build profile's values and guard (F78)
 *   - packages/box-spec/src/generated/build-profiles.v1.ts        the same in TypeScript
 *
 * The vectors' expected verdicts come from cases.v1.json (declared by hand), never from a validator: this script only
 * encodes specs (viem's ABI encoder) and hashes them, so both implementations are checked against an independent
 * oracle.
 *
 * Usage (from the repository root):
 *   node packages/box-spec/scripts/generate.mjs           write every output
 *   node packages/box-spec/scripts/generate.mjs --check   exit 1 when a committed output differs (stale)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { emitFixtures, emitVectors } from './lib/authoring.mjs';
import { buildOutputs } from './lib/build-profiles.mjs';
import { emitSolidity } from './lib/emit-solidity.mjs';
import { emitTs } from './lib/emit-ts.mjs';
import { contractsDir, pkgDir, repoDir } from './lib/model.mjs';

const OUT = {
  sol: join(contractsDir, 'src/box/BoxSpecV1.sol'),
  ts: join(pkgDir, 'src/generated/box-spec.v1.ts'),
  fixtures: join(pkgDir, 'src/generated/fixtures.v1.ts'),
  vectors: join(contractsDir, 'test/vectors/box-spec/box-spec-v1.json'),
};


const outputs = [
  [OUT.sol, emitSolidity()],
  [OUT.ts, emitTs()],
  [OUT.fixtures, emitFixtures()],
  [OUT.vectors, emitVectors()],
  // F78: src/box/build/<profile>/BoxBuildV1.sol and src/generated/build-profiles.v1.ts (build-profiles.v1.json).
  ...buildOutputs(),
];

const check = process.argv.includes('--check');
const stale = [];
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === content) continue;
  if (check) {
    stale.push(relative(repoDir, path));
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    process.stdout.write(`wrote ${relative(repoDir, path)}\n`);
  }
}
if (check) {
  if (stale.length) {
    console.error(`check:box-spec: stale generated files (run \`pnpm box-spec:write\`):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  process.stdout.write(`check:box-spec: ${outputs.length} generated files are up to date\n`);
}
