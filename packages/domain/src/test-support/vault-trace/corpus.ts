/**
 * The v2 T06 trace corpora and their files. Test-only.
 *
 * - The committed corpus (`committedCorpus`) is written to `packages/domain/src/__traces__/v2-vault/` (canonical) and
 *   `packages/contracts/test/vectors/v2-vault/` (Foundry export, for the T07 contracts). A test regenerates it from the
 *   seeds below and fails if a committed file differs; `SH_WRITE_TRACES=1` rewrites the files instead.
 * - The extended corpus (`extendedCorpus`) is larger, never written to disk, and replayed on every test run against
 *   the TypeScript reference, the law checker and the Python oracle.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { REPO_ROOT } from '../handoff';
import { adversarialTraces, roundTripWorstTrace, singleMisfitTrace } from './adversarial';
import { exampleTraces } from './examples';
import { parseVaultTrace, serializeVaultTrace, type ConversionFeePolicy, type UnsolicitedFitPolicy, type VaultTrace } from './format';
import { FORGE_INDEX_SCHEMA, serializeForgeExport, toForgeExport } from './forge';
import { GENERATOR, randomTrace, type AllocationRegime } from './generate';
import { createPrng } from '../prng';

export const CANONICAL_DIR = 'packages/domain/src/__traces__/v2-vault';
export const FORGE_DIR = 'packages/contracts/test/vectors/v2-vault';

/** Seed of the committed adversarial families. */
export const COMMITTED_SEED = 0x7006_0001;
/** Seed base of the committed random traces (trace i uses base + i). */
export const COMMITTED_RANDOM_BASE = 0x7006_1000;
/** Seed base of the extended corpus. */
export const EXTENDED_SEED = 0x7006_e000;

interface RandomSpec {
  readonly policy: UnsolicitedFitPolicy;
  readonly fees: ConversionFeePolicy;
  readonly collectionSize: number;
  readonly ops: number;
  readonly regime?: AllocationRegime;
  readonly maxBatch?: number;
}

const COMMITTED_RANDOM: readonly RandomSpec[] = [
  ...[1, 2, 3, 5, 7, 8, 13, 16, 21, 29, 34, 40].map((collectionSize, i) => ({
    policy: 'quote-neutral' as const,
    fees: i % 3 === 0 ? ('none' as const) : ('flat-f23' as const),
    collectionSize,
    ops: 40,
  })),
  ...[6, 11, 24, 37].map((collectionSize, i) => ({ policy: 'raw-balance' as const, fees: i % 2 === 0 ? ('none' as const) : ('flat-f23' as const), collectionSize, ops: 40 })),
  { policy: 'quote-neutral', fees: 'flat-f23', collectionSize: 10_000, ops: 20, regime: 'billion', maxBatch: 400 },
  { policy: 'quote-neutral', fees: 'flat-f23', collectionSize: 4_200, ops: 20, regime: 'billion', maxBatch: 300 },
  { policy: 'raw-balance', fees: 'none', collectionSize: 10_000, ops: 16, regime: 'billion', maxBatch: 400 },
  { policy: 'quote-neutral', fees: 'flat-f23', collectionSize: 37, ops: 40, regime: 'max-supply' },
  { policy: 'quote-neutral', fees: 'flat-f23', collectionSize: 10_000, ops: 14, regime: 'max-supply', maxBatch: 300 },
];

const tag = (policy: UnsolicitedFitPolicy, fees: ConversionFeePolicy): string =>
  `${policy === 'quote-neutral' ? 'qn' : 'rb'}-${fees === 'none' ? 'nf' : 'ff'}`;

function randomFromSpecs(specs: readonly RandomSpec[], base: number, prefix: string): VaultTrace[] {
  return specs.map((spec, i) =>
    randomTrace({ id: `${prefix}-${tag(spec.policy, spec.fees)}-${String(i).padStart(3, '0')}`, seed: base + i, ...spec }),
  );
}

/** The corpus committed as fixtures: EX01–EX08, every adversarial family, and 21 seeded random traces. */
export function committedCorpus(): VaultTrace[] {
  return [
    ...exampleTraces(),
    roundTripWorstTrace(),
    singleMisfitTrace(),
    ...adversarialTraces(COMMITTED_SEED),
    ...randomFromSpecs(COMMITTED_RANDOM, COMMITTED_RANDOM_BASE, 'rnd'),
  ];
}

/** Sizes of the extended corpus (kept here so the evidence can quote them). */
export const EXTENDED = {
  adversarialSeeds: 8,
  quoteNeutral: 400,
  rawBalance: 150,
  billion: 4,
  maxSupply: 20,
  opsSmall: 40,
} as const;

/** The larger in-memory corpus: more seeds of every family and 574 random traces. Never written to disk. */
export function extendedCorpus(): VaultTrace[] {
  const prng = createPrng(EXTENDED_SEED);
  const specs: RandomSpec[] = [];
  const fees = (): ConversionFeePolicy => (prng.int(3) === 0 ? 'none' : 'flat-f23');
  for (let i = 0; i < EXTENDED.quoteNeutral; i += 1) specs.push({ policy: 'quote-neutral', fees: fees(), collectionSize: 1 + prng.int(40), ops: EXTENDED.opsSmall });
  for (let i = 0; i < EXTENDED.rawBalance; i += 1) specs.push({ policy: 'raw-balance', fees: fees(), collectionSize: 1 + prng.int(40), ops: EXTENDED.opsSmall });
  for (let i = 0; i < EXTENDED.billion; i += 1) {
    specs.push({ policy: i % 2 === 0 ? 'quote-neutral' : 'raw-balance', fees: fees(), collectionSize: i < 2 ? 10_000 : 4_200, ops: 12, regime: 'billion', maxBatch: 2000 });
  }
  for (let i = 0; i < EXTENDED.maxSupply; i += 1) {
    specs.push({ policy: i % 4 === 0 ? 'raw-balance' : 'quote-neutral', fees: fees(), collectionSize: 1 + prng.int(40), ops: 32, regime: 'max-supply' });
  }
  const adversarial: VaultTrace[] = [];
  for (let s = 1; s <= EXTENDED.adversarialSeeds; s += 1) {
    for (const trace of adversarialTraces(EXTENDED_SEED + s)) adversarial.push({ ...trace, id: `x${s}-${trace.id}`.slice(0, 64) });
  }
  return [...adversarial, ...randomFromSpecs(specs, EXTENDED_SEED + 0x100, 'xrnd')];
}

/** Every committed file, path (relative to the repository root) → exact text. */
export function renderCorpusFiles(traces: readonly VaultTrace[]): Map<string, string> {
  const files = new Map<string, string>();
  let steps = 0;
  for (const trace of traces) {
    const canonical = `${CANONICAL_DIR}/${trace.id}.json`;
    files.set(canonical, serializeVaultTrace(trace));
    files.set(`${FORGE_DIR}/${trace.id}.json`, serializeForgeExport(toForgeExport(trace, canonical)));
    steps += trace.steps.length;
  }
  const index = {
    schema: FORGE_INDEX_SCHEMA,
    generator: GENERATOR,
    canonical: CANONICAL_DIR,
    format: 'packages/domain/src/test-support/vault-trace/format.ts (canonical) and forge.ts (this export)',
    traces: traces.length,
    steps,
    files: traces.map((trace) => trace.id),
  };
  files.set(`${FORGE_DIR}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
  return files;
}

/** Relative paths of the .json files currently in the two fixture directories. */
export function committedFilePaths(): string[] {
  const out: string[] = [];
  for (const dir of [CANONICAL_DIR, FORGE_DIR]) {
    const absolute = `${REPO_ROOT}${dir}`;
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) if (name.endsWith('.json')) out.push(`${dir}/${name}`);
  }
  return out.sort();
}

export const readRepoText = (relativePath: string): string => readFileSync(`${REPO_ROOT}${relativePath}`, 'utf8');

/** Write the corpus files and remove stale .json files from the two fixture directories. */
export function writeCorpusFiles(files: ReadonlyMap<string, string>): void {
  for (const dir of [CANONICAL_DIR, FORGE_DIR]) mkdirSync(`${REPO_ROOT}${dir}`, { recursive: true });
  for (const path of committedFilePaths()) if (!files.has(path)) rmSync(`${REPO_ROOT}${path}`);
  for (const [path, text] of files) writeFileSync(`${REPO_ROOT}${path}`, text);
}

/** The committed canonical traces, parsed strictly. */
export function readCommittedTraces(): VaultTrace[] {
  return committedFilePaths()
    .filter((path) => path.startsWith(`${CANONICAL_DIR}/`))
    .map((path) => parseVaultTrace(JSON.parse(readRepoText(path)) as unknown));
}
