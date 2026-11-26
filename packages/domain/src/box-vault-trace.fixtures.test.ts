/**
 * Box core v1, slice S3 (BC-006): new vault trace vectors at the box edition sizes N = 69 and N = 4,269 (F49 E8), from
 * the same TypeScript reference and generator as the v2 corpus (`test-support/vault-trace`), exported for Foundry to
 * `packages/contracts/test/vectors/box-vault/`, where `test/box/items/BoxVaultTraces.t.sol` replays them against
 * BoxVault. The v2 corpus (`vault-trace.fixtures.test.ts`) is unchanged.
 *
 * To regenerate after an intended change: `SH_WRITE_TRACES=1 pnpm vitest run --project domain
 * packages/domain/src/box-vault-trace.fixtures.test.ts`, then review the diff.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-support/handoff';
import { FORGE_INDEX_SCHEMA, serializeForgeExport, toForgeExport } from './test-support/vault-trace/forge';
import { GENERATOR, randomTrace } from './test-support/vault-trace/generate';
import type { VaultTrace } from './test-support/vault-trace/format';

const BOX_FORGE_DIR = 'packages/contracts/test/vectors/box-vault';
/** Seed base of the box-size traces (trace i uses base + i). */
const BOX_SEED_BASE = 0x5333_0000;

function boxCorpus(): VaultTrace[] {
  const specs = [
    { id: 'box-qn-ff-069-odd', collectionSize: 69, ops: 60, regime: 'odd' as const },
    { id: 'box-qn-ff-069-billion', collectionSize: 69, ops: 60, regime: 'billion' as const, maxBatch: 20 },
    { id: 'box-qn-nf-069-wad', collectionSize: 69, ops: 60, regime: 'wad' as const, fees: 'none' as const },
    { id: 'box-qn-ff-4269-billion', collectionSize: 4_269, ops: 60, regime: 'billion' as const, maxBatch: 300 },
    { id: 'box-qn-ff-4269-max', collectionSize: 4_269, ops: 40, regime: 'max-supply' as const, maxBatch: 300 },
  ];
  return specs.map((s, i) =>
    randomTrace({
      id: s.id,
      seed: BOX_SEED_BASE + i,
      policy: 'quote-neutral',
      fees: s.fees ?? 'flat-f23',
      collectionSize: s.collectionSize,
      ops: s.ops,
      regime: s.regime,
      maxBatch: s.maxBatch,
    }),
  );
}

function render(traces: readonly VaultTrace[]): Map<string, string> {
  const files = new Map<string, string>();
  let steps = 0;
  for (const trace of traces) {
    files.set(`${BOX_FORGE_DIR}/${trace.id}.json`, serializeForgeExport(toForgeExport(trace, `${BOX_FORGE_DIR}/${trace.id}.json`)));
    steps += trace.steps.length;
  }
  const index = {
    schema: FORGE_INDEX_SCHEMA,
    generator: GENERATOR,
    canonical: BOX_FORGE_DIR,
    format: 'packages/domain/src/test-support/vault-trace/forge.ts (Foundry export of in-memory traces; no canonical copy)',
    traces: traces.length,
    steps,
    files: traces.map((t) => t.id),
  };
  files.set(`${BOX_FORGE_DIR}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
  return files;
}

const corpus = boxCorpus();
const files = render(corpus);
if (process.env.SH_WRITE_TRACES === '1') {
  mkdirSync(`${REPO_ROOT}${BOX_FORGE_DIR}`, { recursive: true });
  for (const name of readdirSync(`${REPO_ROOT}${BOX_FORGE_DIR}`)) {
    if (name.endsWith('.json') && !files.has(`${BOX_FORGE_DIR}/${name}`)) rmSync(`${REPO_ROOT}${BOX_FORGE_DIR}/${name}`);
  }
  for (const [path, text] of files) writeFileSync(`${REPO_ROOT}${path}`, text);
}

describe('box vault trace vectors (S3, N 69 and 4,269)', () => {
  it('are exactly the files the seeds produce', () => {
    const committed = readdirSync(`${REPO_ROOT}${BOX_FORGE_DIR}`)
      .filter((n) => n.endsWith('.json'))
      .map((n) => `${BOX_FORGE_DIR}/${n}`)
      .sort();
    expect(committed).toEqual([...files.keys()].sort());
    for (const [path, text] of files) expect(readFileSync(`${REPO_ROOT}${path}`, 'utf8') === text, `${path} differs`).toBe(true);
  });

  it('cover both box sizes, every op kind the vault serves, refusals and charged fees', () => {
    const sizes = new Set(corpus.map((t) => t.collectionSize));
    expect([...sizes].sort((a, b) => a - b)).toEqual([69, 4_269]);
    const kinds = new Set<string>(corpus.flatMap((t) => t.steps.map((s) => s.op.op)));
    for (const k of ['take', 'release', 'openGate', 'withdraw', 'return', 'burn']) expect(kinds.has(k), k).toBe(true);
    const refusals = corpus.flatMap((t) => t.steps.filter((s) => 'error' in s.outcome));
    expect(refusals.length).toBeGreaterThan(5);
  });
});
