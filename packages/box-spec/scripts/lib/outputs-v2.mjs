/** Format 2 sources and outputs. M1-10-a alone owns and encodes the hand-declared vectors. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitSolidityV2 } from './emit-solidity.mjs';
import { emitTsV2 } from './emit-ts.mjs';
import { FROZEN_FILES, RUNTIME_REASON_CODES, loadModelV2 } from './model-v2.mjs';
import { repoDir } from './model.mjs';

export const V2_PATHS = {
  sol: 'packages/contracts/src/box-v2/BoxSpecV2.sol',
  ts: 'packages/box-spec/src/generated/box-spec.v2.ts',
  vectors: 'packages/contracts/test/vectors/box-spec/box-spec-v2.json',
  spec: 'packages/box-spec/box-spec.v2.json',
  addOns: 'packages/box-spec/add-ons.v2.json',
};

/** Missing real sources fail closed; there is no fallback source or vector writer. */
export function readSourcesV2(root = repoDir) {
  const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  return {
    mode: 'real', root, paths: V2_PATHS,
    spec: read(V2_PATHS.spec), addOns: read(V2_PATHS.addOns), cases: null,
    frozen: Object.fromEntries(FROZEN_FILES.map((f) => [f, readFileSync(join(root, f), 'utf8')])),
    labels: { spec: V2_PATHS.spec, addOns: V2_PATHS.addOns },
  };
}

/** Only the twins; encode-vectors.mjs owns box-spec-v2.json. */
export function outputsV2(model) {
  return [
    [join(model.root, model.paths.sol), emitSolidityV2(model)],
    [join(model.root, model.paths.ts), emitTsV2(model)],
  ];
}

export { FROZEN_FILES, RUNTIME_REASON_CODES, loadModelV2 };
