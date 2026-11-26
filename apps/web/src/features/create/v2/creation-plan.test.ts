import { BOOTSTRAP_ETH } from '@squarehole/box-spec';
import { concat, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { chunkChainV2, tokenUriTextsV2 } from '../../../../../../packages/chain/src/core/v2';
import { CREATE_CHUNK_MAX, CREATE_GAS_LIMIT_MAX, createGasLimit, creationPlan, boxStatus } from './creation-plan';
import { DEMO_LISTINGS, RAISE_ETH, type SiteListing } from './listings';
import { buildSpecV2, recipeCtx, stillPlayed, type BuildV2Input, type Played } from './model';
import { ChunkPart, specHashV2 } from './spec-types';
import { inputV2Of } from './test-support/v2-fixtures';

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const bytes = (n: number, seed = 1): Hex => `0x${Array.from({ length: n }, (_, i) => ((i * 7 + seed) % 256).toString(16).padStart(2, '0')).join('')}`;
const config = (id: string) => {
  const found = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};
const listing = (symbol: string, listings = DEMO_LISTINGS) => {
  const found = listings.find((entry) => entry.symbol === symbol);
  if (!found) throw new Error(symbol);
  return found;
};

describe('the chunks are the release’s (TA-21: BoxCoordinatorV2.CHUNK_MAX and BoxFactoryV2Parts texts)', () => {
  it('cuts the table and texts with the shared helpers, 8192 bytes a chunk, each sent with the next hash', () => {
    expect(CREATE_CHUNK_MAX).toBe(8_192);
    const spec = { ...buildSpecV2(inputV2Of(config('gas-guzzlers'))), metadataTable: bytes(20_000) };
    const plan = creationPlan(spec, listing('ETH'), options);
    const table = plan.steps.filter((step) => step.part === ChunkPart.Table);
    expect(table.map((step) => ((step.data ?? '0x').length - 2) / 2)).toEqual([8_192, 8_192, 3_616]);
    expect(table.map((step) => [step.data, step.nextHash])).toEqual(chunkChainV2(spec.metadataTable).chunks.map((chunk) => [chunk.data, chunk.nextHash]));
    expect(table[2]?.nextHash).toBe(ZERO32);
    expect(concat(table.map((step) => step.data ?? '0x'))).toBe(spec.metadataTable);
    let next: Hex = ZERO32;
    for (const step of [...table].reverse()) next = keccak256(concat([step.data ?? '0x', next]));
    expect(next).toBe(chunkChainV2(spec.metadataTable).root);
  });
});

const options = { estimate: () => 8_000_000n };

describe('the createBox gas limit (ADR-0017 § 6)', () => {
  it('adds 20% or 150k, whichever is more, and never passes 49.5M', () => {
    expect(createGasLimit(10_000_000n)).toBe(12_000_000n);
    expect(createGasLimit(500_000n)).toBe(650_000n);
    expect(createGasLimit(41_250_000n)).toBe(CREATE_GAS_LIMIT_MAX);
    expect(CREATE_GAS_LIMIT_MAX).toBe(49_500_000n);
  });
  it('an estimate whose margin does not fit under 49.5M is not sent: never capped below its margin', () => {
    expect(createGasLimit(41_250_001n)).toBeNull();
    expect(createGasLimit(45_000_000n)).toBeNull();
    expect(createGasLimit(49_400_000n)).toBeNull();
    expect(createGasLimit(49_500_000n)).toBeNull();
  });
});

describe('what Create sends, in order', () => {
  
  it('an ETH-priced collection: createBox with the bootstrap and the creator buy as value, then its chunks', () => {
    const spec = buildSpecV2(inputV2Of(config('gas-guzzlers'), {}, { firstIn: '0.1' }));
    const plan = creationPlan(spec, listing('ETH'), options);
    expect(plan.steps.map((step) => step.call)).toEqual(['createBox', ...plan.steps.slice(1).map(() => 'loadChunk')]);
    const create = plan.steps[0];
    expect(create?.value).toBe(BOOTSTRAP_ETH + 100_000_000_000_000_000n);
    expect(create?.gasLimit).toBe(9_600_000n);
    const table = plan.steps.filter((step) => step.part === ChunkPart.Table);
    expect(table.length).toBeGreaterThan(0);
    expect(concat(table.map((step) => step.data ?? '0x'))).toBe(spec.metadataTable);
    expect(plan.waits).toBe(true);
  });
  it('an ERC-20 pricing token: one exact approval first, no value', () => {
    const spec = buildSpecV2(inputV2Of(config('depth-reward'), {}, { firstIn: '100' }));
    const usdc = listing('USDC');
    if (usdc.bootstrap === undefined) throw new Error('USDC has its listing’s bootstrap');
    const plan = creationPlan(spec, usdc, options);
    expect(plan.steps.slice(0, 2).map((step) => step.call)).toEqual(['approve', 'createBox']);
    expect(plan.steps[0]?.amount).toBe(usdc.bootstrap + 100_000_000n);
    expect(plan.steps[1]?.value).toBe(0n);
  });
  it('a box token (CHOO once listed; FIT for Square Pegs): the exact approval is the raise’s bootstrap, rounded up, plus the creator buy', () => {
    const ceil = (x: bigint, y: bigint) => (x + y - 1n) / y;
    for (const [id, symbol] of [
      ['box-token-priced', 'CHOO'],
      ['square-pegs', 'FIT'],
    ] as const) {
      const spec = buildSpecV2({ ...inputV2Of(config(id), {}, { firstIn: '1000' }), listings: DEMO_LISTINGS });
      expect(spec.creatorBuy).toBe(1_000n * 10n ** 18n);
      const plan = creationPlan(spec, listing(symbol, DEMO_LISTINGS), options);
      expect(plan.steps.slice(0, 2).map((step) => step.call), symbol).toEqual(['approve', 'createBox']);
      const approve = plan.steps.find((step) => step.call === 'approve');
      expect(approve?.amount, symbol).toBe(ceil(spec.raise * BOOTSTRAP_ETH, RAISE_ETH) + spec.creatorBuy);
      expect(plan.steps.find((step) => step.call === 'createBox')?.value).toBe(0n);
    }
  });
  it('a changed listing cannot reuse a reviewed plan', () => {
    const spec = buildSpecV2(inputV2Of(config('square-pegs')));
    const fit = listing('FIT');
    for (const changed of [{ ...fit, raise: fit.raise + 1n }, { ...fit, id: fit.id + 1 }, { ...fit, token: `0x${'1'.repeat(40)}` as const }]) {
      expect(creationPlan(spec, changed, options)).toMatchObject({ steps: [], blocked: 'listing-changed' });
    }
  });
  it('the removed hide flag (F151 R68-HIDE) blocks nothing: the same listing with a stray `hidden` gets the same plan', () => {
    const spec = buildSpecV2(inputV2Of(config('square-pegs')));
    const fit = listing('FIT');
    const plan = creationPlan(spec, fit, options);
    expect(plan.blocked).toBeNull();
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(creationPlan(spec, { ...fit, hidden: true } as unknown as SiteListing, options)).toEqual(plan);
  });
  it('a real build has no estimate yet: the plan lists its steps and its createBox carries no gas limit until it is estimated on chain', () => {
    const spec = buildSpecV2(inputV2Of(config('depth-reward')));
    const plan = creationPlan(spec, listing('USDC'), { estimate: null });
    expect(plan).toMatchObject({ blocked: null, estimate: null, gasLimit: null });
    expect(plan.steps.find((step) => step.call === 'createBox')?.gasLimit).toBeUndefined();
  });
  it('a token-only box has no chunks: it opens at its open time', () => {
    const spec = buildSpecV2(inputV2Of(config('rug-rugs')));
    const plan = creationPlan(spec, listing('ETH'), options);
    expect(plan.steps.map((step) => step.call)).toEqual(['createBox']);
    expect(plan.waits).toBe(false);
  });
  it('placeholders put their texts in the Texts part', () => {
    const spec = buildSpecV2(inputV2Of(config('ultrasound-owls')));
    expect(tokenUriTextsV2(spec)).not.toBe('0x');
    const plan = creationPlan(spec, listing('ETH'), options);
    expect(plan.steps.some((step) => step.part === ChunkPart.Texts)).toBe(true);
  });
  it('a spec too heavy to send gives no plan', () => {
    const spec = buildSpecV2(inputV2Of(config('gas-guzzlers')));
    expect(creationPlan(spec, listing('ETH'), { ...options, estimate: () => 50_000_000n })).toMatchObject({ steps: [], blocked: 'too-heavy' });
    expect(creationPlan(spec, listing('ETH'), { ...options, estimate: () => 45_000_000n })).toMatchObject({ steps: [], blocked: 'too-heavy' });
  });
});

describe('the box’s status while its chunks load', () => {
  it('waits for its table until the last chunk is in, then opens', () => {
    const spec = { ...buildSpecV2(inputV2Of(config('gas-guzzlers'))), metadataTable: bytes(20_000) };
    const plan = creationPlan(spec, listing('ETH'), options);
    const chunks = plan.steps.filter((step) => step.call === 'loadChunk').length;
    expect(chunks).toBeGreaterThan(1);
    expect(boxStatus(plan, 0)).toEqual({ state: 'sending', done: 0, total: plan.steps.length });
    expect(boxStatus(plan, 1)).toEqual({ state: 'waiting', loaded: 0, chunks, waitsFor: 'table' });
    expect(boxStatus(plan, plan.steps.length - 1)).toEqual({ state: 'waiting', loaded: chunks - 1, chunks, waitsFor: 'table' });
    expect(boxStatus(plan, plan.steps.length)).toEqual({ state: 'open' });
  });

});

describe('a Demo run is its plan’s (review round 3)', () => {
  const at = Date.UTC(2026, 9, 7, 12, 0, 30);
  /** What Create keeps when it plays these choices (CreateV2Flow): the spec's hash, its listing, its clock. */
  const playedOf = (input: BuildV2Input): Played => ({ hash: specHashV2(buildSpecV2(input)), listingId: recipeCtx(input).pricing.id, atMs: input.nowMs });
  it('the clock alone never changes it: a preset open time is built again at the run’s clock', () => {
    const input = { ...inputV2Of(config('gas-guzzlers'), {}, { open: { kind: 'preset', id: '5m' } }), nowMs: at };
    const played = playedOf(input);
    const later = { ...input, nowMs: at + 120_000 };
    expect(specHashV2(buildSpecV2(later))).not.toBe(played.hash);
    expect(stillPlayed(played, later)).toBe(true);
  });
  it('an edit, another pricing token, or a box token’s raise read after its listing makes it another box’s', () => {
    const input = { ...inputV2Of(config('gas-guzzlers')), nowMs: at };
    const played = playedOf(input);
    expect(stillPlayed(played, input)).toBe(true);
    expect(stillPlayed(played, { ...input, v2: { ...input.v2, deadlineDays: 60 } })).toBe(false);
    expect(stillPlayed(played, { ...input, v2: { ...input.v2, pricing: listing('USDC').token } })).toBe(false);
    const choo = { ...inputV2Of(config('box-token-priced')), nowMs: at };
    const listedFirst = playedOf(choo);
    expect(stillPlayed(listedFirst, choo)).toBe(true);
    expect(stillPlayed(listedFirst, { ...choo, listings: DEMO_LISTINGS.map((l) => l.symbol === 'CHOO' ? { ...l, raise: l.raise + 1n } : l) })).toBe(false);
    // Played in another listing: not this run, whatever the hash says.
    expect(stillPlayed({ ...listedFirst, listingId: listedFirst.listingId + 1 }, choo)).toBe(false);
  });
});
