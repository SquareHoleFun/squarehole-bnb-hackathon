import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, toHex, zeroAddress, zeroHash, toFunctionSelector, type Hex } from 'viem';
import { buildCreateCallsV2, assertSendableCreateCallV2, chunkChainV2, tokenUriTextsV2, estimateCreateGasV2,
  CREATE_CHUNK_MAX_V2, type CreatePlanV2 } from './create-calls-v2';
import { factoryV2Abi, coordinatorV2Abi, pileVaultV2Abi, shopVaultV2Abi, starterSetLoaderV2Abi } from './abi-v2';
import * as frozenAbis from './abi-v2';
import { shopConfigV2Parameters } from './m2-spec-v2';
import { specOf, vectors } from '../../../test/fixtures/create-v2/vectors';

const addr = (n: bigint) => toHex(n, { size: 20 });
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
const first = required(vectors[0]);
const base: CreatePlanV2 = { chainId: 11155111, creator: first.creator, factory: first.factory,
  coordinator: first.coordinator, spec: specOf(first), cs: first.cs, hs: first.hs, bootstrapQ: 1_500_000_000_000_000n };
const authorize = (plan: CreatePlanV2, call: { to: `0x${string}`; data: Hex; value: bigint }) =>
  assertSendableCreateCallV2(call, plan, plan.creator, plan.chainId);

it.each(vectors)('matches partArgs texts and ChunkLoader bytes, suffixes and roots ($cs)', v => {
  expect(CREATE_CHUNK_MAX_V2.toString()).toBe(v.chunkMax);
  expect(tokenUriTextsV2(specOf(v))).toBe(v.texts.data);
  for (const part of [v.table, v.texts]) {
    expect(chunkChainV2(part.data)).toEqual({ root: part.root,
      chunks: part.chunks.map((data, i) => ({ data, nextHash: part.nextHashes[i] })) });
  }
});

it('keeps the TypeScript fixtures byte-identical to the Forge corpus', () => {
  for (const i of [0, 1, 2, 3, 'reserved']) expect(readFileSync(new URL(`../../../test/fixtures/create-v2/${i}.json`, import.meta.url), 'utf8'))
    .toBe(readFileSync(new URL(`../../../../contracts/test/vectors/create-v2/${i}.json`, import.meta.url), 'utf8'));
});

it('enforces text byte bounds, empty semantics, and chunk encoding', () => {
  expect(tokenUriTextsV2({ ...base.spec, boxType: 1, description: '', addOns: [] })).toBe('0x');
  expect(tokenUriTextsV2({ ...base.spec, description: 'ignored for token' })).toBe('0x');
  expect(() => tokenUriTextsV2({ ...base.spec, boxType: 1, description: 'é'.repeat(32768) })).toThrow();
  const page = (link: string) => [{ id: 6, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32[]' }, { type: 'string' }], [zeroHash, [], link]) }];
  expect(() => tokenUriTextsV2({ ...base.spec, boxType: 1, addOns: page('x'.repeat(256)) })).toThrow();
  expect(() => tokenUriTextsV2({ ...base.spec, boxType: 1, addOns: [{ id: 1, params: '0x' }] })).toThrow();
  for (const invalid of ['0x0', '0xzz', '1234']) expect(() => chunkChainV2(invalid as Hex)).toThrow();
  expect(chunkChainV2(`0x${'ab'.repeat(8192)}`)).toEqual({ root: keccak256(`0x${'ab'.repeat(8192)}${zeroHash.slice(2)}`),
    chunks: [{ data: `0x${'ab'.repeat(8192)}`, nextHash: zeroHash }] });
});

describe('gas from a real estimate', () => {
  const request = { ...required(buildCreateCallsV2(base)[0]), account: base.creator };
  it('passes the exact request, rounds up, and uses a minimum margin', async () => {
    const estimateGas = vi.fn(async () => 1_000_001n);
    expect(await estimateCreateGasV2(estimateGas, request, 30_000_000n)).toEqual({ estimate: 1_000_001n, gasLimit: 1_200_002n });
    expect(estimateGas).toHaveBeenCalledWith(request);
    expect(await estimateCreateGasV2(async () => 21_000n, request, 30_000_000n)).toEqual({ estimate: 21_000n, gasLimit: 171_000n });
  });
  it('accepts exact ceilings and rejects the next estimate without truncation', async () => {
    expect((await estimateCreateGasV2(async () => 41_250_000n, request, 60_000_000n)).gasLimit).toBe(49_500_000n);
    await expect(estimateCreateGasV2(async () => 41_250_001n, request, 60_000_000n)).rejects.toThrow();
    expect((await estimateCreateGasV2(async () => 825_000n, request, 1_000_000n)).gasLimit).toBe(990_000n);
    await expect(estimateCreateGasV2(async () => 825_001n, request, 1_000_000n)).rejects.toThrow();
    await expect(estimateCreateGasV2(async () => 15_000_000n, request, 200_000_000n, 16_777_216n)).rejects.toThrow();
    await expect(estimateCreateGasV2(async () => 1n, request, 200_000_000n, 49_500_001n)).rejects.toThrow();
  });
  it('refuses unsafe estimates, tight blocks and margins; never clips the margin', async () => {
    for (const estimate of [0n, -1n, 50_000_000n]) await expect(estimateCreateGasV2(async () => estimate, request, 60_000_000n)).rejects.toThrow();
    await expect(estimateCreateGasV2(async () => 25_000_000n, request, 30_000_000n)).rejects.toThrow();
    await expect(estimateCreateGasV2(async () => 1n, request, 0n)).rejects.toThrow();
    await expect(estimateCreateGasV2(async () => { throw new Error('simulation reverted'); }, request, 30_000_000n)).rejects.toThrow('simulation reverted');
  });
});

describe('creation authority', () => {
  const ercPlan = { ...base, spec: { ...base.spec, pricing: { listingId: 1, token: addr(3n) } } };
  const collectionPlan = { ...base, spec: specOf(required(vectors[2])) };
  const pilePlan = { ...base, vault: addr(4n), spec: { ...base.spec, boxType: 5,
    contentsParams: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [zeroAddress, 7n]) } };
  const shopPlan: CreatePlanV2 = { ...base, vault: addr(4n), starterLoader: addr(5n), starterItems: [], spec: { ...base.spec, boxType: 4,
    contentsParams: encodeAbiParameters(shopConfigV2Parameters, [{ seedT: 9n, givePricesT: [1n, 2n, 3n, 4n], pickBps: 20000, weeklyBps: 100,
      collectionBps: 2500, listDelay: 604800, curator: base.creator, collections: [addr(6n)], tiers: [0] }]),
    addOns: [{ id: 8, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [zeroHash, 0]) }] } };

  it.each([base, ercPlan, collectionPlan, pilePlan, shopPlan])('accepts only exact derived calls for a plan ($spec.boxType)', plan => {
    const calls = buildCreateCallsV2(plan);
    for (const call of calls) {
      expect(() => authorize(plan, call)).not.toThrow();
      for (const bad of [{ ...call, to: addr(99n) }, { ...call, value: call.value + 1n },
        { ...call, data: `${call.data}00` as Hex }, { ...call, data: `0xdeadbeef${call.data.slice(10)}` as Hex }]) {
        expect(() => authorize(plan, bad)).toThrow();
      }
      expect(() => assertSendableCreateCallV2(call, plan, addr(99n), plan.chainId)).toThrow();
      expect(() => assertSendableCreateCallV2(call, plan, plan.creator, 1)).toThrow();
    }
  });

  it('checks price-coin approvals, full spec, salts, native value, chunk bytes and suffixes', () => {
    const [approve, create] = buildCreateCallsV2(ercPlan);
    expect(decodeFunctionData({ abi: erc20Abi, data: required(approve).data }).args).toEqual([base.factory, base.bootstrapQ + base.spec.creatorBuy]);
    expect(required(create).value).toBe(0n);
    for (const amount of [0n, base.bootstrapQ + base.spec.creatorBuy + 1n, (1n << 256n) - 1n]) expect(() => authorize(ercPlan,
      { ...required(approve), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [base.factory, amount] }) })).toThrow();
    expect(() => authorize(ercPlan, { ...required(approve), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [addr(99n), 1n] }) })).toThrow();
    for (const args of [[{ ...base.spec, tokenName: 'changed' }, base.cs, base.hs], [base.spec, zeroHash, base.hs], [base.spec, base.cs, zeroHash]] as const) {
      if (args[1] === base.cs && args[2] === base.hs && args[0] === base.spec) continue;
      expect(() => authorize(base, { to: base.factory, value: base.bootstrapQ + base.spec.creatorBuy,
        data: encodeFunctionData({ abi: factoryV2Abi, functionName: 'createBox', args }) })).toThrow();
    }
    expect(() => authorize(collectionPlan, { to: base.coordinator, value: 0n,
      data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'loadChunk', args: [2, '0x12', zeroHash] }) })).toThrow();
    expect(buildCreateCallsV2(pilePlan).find(c => c.kind === 'loadSeed')?.value).toBe(7n);
    expect(buildCreateCallsV2(shopPlan).map(c => c.kind)).toEqual(['createBox', 'fundSeed', 'complete']);
  });

  it('uses separate native/erc20 seed funding and refuses wrong roles, overflow and chunk commitments', () => {
    const ercPile = { ...pilePlan, spec: { ...pilePlan.spec, contentsParams: encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }], [addr(6n), 7n]) } };
    const calls = buildCreateCallsV2(ercPile);
    expect(calls.map(c => c.kind)).toEqual(['createBox', 'loadSeed']);
    expect(required(calls.find(c => c.kind === 'loadSeed')).value).toBe(0n);
    expect(() => buildCreateCallsV2({ ...base, coordinator: base.factory })).toThrow();
    expect(() => buildCreateCallsV2({ ...base, bootstrapQ: (1n << 256n) - 1n })).toThrow();
    expect(() => buildCreateCallsV2({ ...base, bootstrapQ: -1n })).toThrow();
    const chunk = required(buildCreateCallsV2(collectionPlan).find(c => c.kind === 'loadChunk'));
    const decoded = decodeFunctionData({ abi: coordinatorV2Abi, data: chunk.data });
    if (decoded.functionName !== 'loadChunk') throw new Error('expected a chunk');
    const [part, data, nextHash] = decoded.args;
    for (const args of [[part === 1 ? 2 : 1, data, nextHash], [part, data, toHex(1n, { size: 32 })]] as const) {
      expect(() => authorize(collectionPlan, { ...chunk, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'loadChunk', args }) })).toThrow();
    }
  });

  it('refuses all other ABI selectors, including direct shop loadStarter and seed approvals', () => {
    const signatures = [
      { to: base.factory, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [addr(9n), 1n] }) },
      { to: base.coordinator, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'fail', args: [] }) },
      { to: pilePlan.vault, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'returnSeed', args: [] }) },
      { to: required(shopPlan.vault), data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'loadStarter', args: [addr(6n), 1n, 0] }) },
      { to: addr(3n), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [required(shopPlan.vault), 9n] }) },
    ];
    for (const call of signatures) for (const plan of [base, ercPlan, pilePlan, shopPlan]) expect(() => authorize(plan, { ...call, value: 0n })).toThrow();
  });

  it('denies every other selector in the frozen release ABIs at every authorized target', () => {
    const plan = ercPlan;
    const calls = buildCreateCallsV2(plan);
    const allowed = new Set(calls.map(c => c.data.slice(0, 10)));
    const selectors = new Set<string>();
    for (const value of Object.values(frozenAbis)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) if (item.type === 'function') selectors.add(toFunctionSelector(item));
    }
    expect(selectors.size).toBeGreaterThan(100);
    for (const selector of selectors) {
      if (allowed.has(selector)) continue;
      for (const to of [plan.factory, plan.coordinator, plan.spec.pricing.token]) {
        expect(() => authorize(plan, { to, value: 0n, data: selector as Hex })).toThrow();
      }
    }
  });

  it('commits starter pages and refuses an altered item, tier, suffix or missing loader', () => {
    const items = Array.from({ length: 33 }, (_, i) => ({ collection: addr(6n), id: BigInt(i + 1), tier: 0 }));
    let root: Hex = zeroHash;
    for (const item of [...items].reverse()) root = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }], [item.collection, item.id, item.tier, root]));
    const plan = { ...shopPlan, starterItems: items, spec: { ...shopPlan.spec, addOns: [{ id: 8,
      params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [root, items.length]) }] } };
    const pages = buildCreateCallsV2(plan).filter(c => c.kind === 'loadStarter');
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(() => authorize(plan, page)).not.toThrow();
    const decoded = decodeFunctionData({ abi: starterSetLoaderV2Abi, data: required(pages[0]).data });
    expect(decoded.functionName).toBe('load');
    expect(() => authorize(plan, { ...required(pages[0]), data: encodeFunctionData({ abi: starterSetLoaderV2Abi,
      functionName: 'load', args: [[addr(6n)], [1n], [0], zeroHash] }) })).toThrow();
    expect(() => buildCreateCallsV2({ ...plan, starterItems: items.slice(1) })).toThrow();
    expect(() => buildCreateCallsV2({ ...plan, starterItems: items.map((x, i) => i === 0 ? { ...x, tier: 1 } : x) })).toThrow();
    expect(() => buildCreateCallsV2({ ...plan, starterLoader: undefined })).toThrow();
  });
});
