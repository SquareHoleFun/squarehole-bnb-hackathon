import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, erc721Abi, keccak256, maxUint256, toHex, zeroAddress, zeroHash, type Hex } from 'viem';
import { assertSendableCreateStepV2, createNeedsRolesV2, createStepsV2, seedApprovalV2, starterApprovalsV2, type CreateSendPlanV2 } from './create-send-v2';
import { pileVaultV2Abi, shopVaultV2Abi, starterSetLoaderV2Abi } from './abi-v2';
import type { StarterItemV2 } from './create-calls-v2';
import { NotSendableError } from '../../write/calls';
import { submitCreateWriteV2 } from '../../write/executor';
import type { Eip1193RequestArguments } from '../../write/eip1193';
import { shopConfigV2Parameters } from './m2-spec-v2';
import { specOf, vectors } from '../../../test/fixtures/create-v2/vectors';
import { TEST_FEE_READER, TEST_SEND_FEE_FIELDS } from '../../write/test-support/index';

/** SH-218 rail 2: no option switched off (the switches' own tests: write/executor-create-v2.test.ts). */
const NO_SWITCHES = async (): Promise<void> => undefined;

const addr = (n: bigint) => toHex(n, { size: 20 });
const first = vectors[0];
if (!first) throw new Error('missing create-v2 vector');
const base: CreateSendPlanV2 = { chainId: 11155111, creator: first.creator, factory: first.factory, coordinator: first.coordinator,
  token: addr(8n), spec: specOf(first), cs: first.cs, hs: first.hs, bootstrapQ: 1_500_000_000_000_000n };
const pileParams = (asset: `0x${string}`, amount: bigint) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [asset, amount]);
const ercPile: CreateSendPlanV2 = { ...base, spec: { ...base.spec, boxType: 5, contentsParams: pileParams(addr(6n), 7n) } };
const nativePile: CreateSendPlanV2 = { ...base, spec: { ...base.spec, boxType: 5, contentsParams: pileParams(zeroAddress, 7n) } };
const shop: CreateSendPlanV2 = { ...base, starterItems: [], spec: { ...base.spec, boxType: 4,
  contentsParams: encodeAbiParameters(shopConfigV2Parameters, [{ seedT: 9n, givePricesT: [1n, 2n, 3n, 4n], pickBps: 20000, weeklyBps: 100,
    collectionBps: 2500, listDelay: 604800, curator: base.creator, collections: [addr(6n)], tiers: [0] }]),
  addOns: [{ id: 8, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [zeroHash, 0]) }] } };
const vault = addr(4n);
const loader = addr(5n);
const ok = (plan: CreateSendPlanV2, call: { to: `0x${string}`; data: Hex; value: bigint }) => assertSendableCreateStepV2(call, plan, plan.creator, plan.chainId);
const approve = (to: `0x${string}`, spender: `0x${string}`, amount: bigint) => ({ to, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });

describe('TA-22 the creation steps in order', () => {
  it('a box with no seed sends TA-21’s calls only; a pile or a shop waits for its roles', () => {
    expect(createNeedsRolesV2(base.spec)).toBe(false);
    expect(createStepsV2(base).map((s) => s.kind)).toEqual(['createBox']);
    expect(createNeedsRolesV2(ercPile.spec)).toBe(true);
    expect(createNeedsRolesV2({ ...ercPile.spec, contentsParams: pileParams(addr(6n), 0n) })).toBe(false);
    expect(createNeedsRolesV2(shop.spec)).toBe(true);
    // Before creation: only the payment steps, so no seed step can be signed before the created box names its vault.
    expect(createStepsV2(ercPile).map((s) => s.kind)).toEqual(['createBox']);
    expect(createStepsV2(shop).map((s) => s.kind)).toEqual(['createBox']);
  });
  it('an ERC-20 pile seed: its exact approval to the pile right before loadSeed; a native seed has none', () => {
    const steps = createStepsV2({ ...ercPile, vault });
    expect(steps.map((s) => s.kind)).toEqual(['createBox', 'approveSeed', 'loadSeed']);
    const seed = steps[1];
    expect(seed?.to).toBe(addr(6n));
    expect(decodeFunctionData({ abi: erc20Abi, data: seed?.data ?? '0x' }).args).toEqual([vault, 7n]);
    expect(createStepsV2({ ...nativePile, vault }).map((s) => [s.kind, s.value])).toEqual([['createBox', base.bootstrapQ + base.spec.creatorBuy], ['loadSeed', 7n]]);
    expect(seedApprovalV2({ ...nativePile, vault })).toBeNull();
  });
  it('a shop seed: the box token’s exact approval to the shop, then fundSeed and complete', () => {
    const steps = createStepsV2({ ...shop, vault, starterLoader: loader });
    expect(steps.map((s) => s.kind)).toEqual(['createBox', 'approveSeed', 'fundSeed', 'complete']);
    expect(steps[1]).toEqual({ kind: 'approveSeed', ...approve(base.token, vault, 9n) });
    expect(steps[2]).toMatchObject({ to: vault, data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'fundSeed' }) });
  });
});

describe('TA-22 the step guard', () => {
  const plans = [base, { ...ercPile, vault }, { ...nativePile, vault }, { ...shop, vault, starterLoader: loader }];
  it.each(plans)('admits each exact step and nothing altered ($spec.boxType)', (plan) => {
    for (const step of createStepsV2(plan)) {
      expect(() => ok(plan, step)).not.toThrow();
      for (const bad of [{ ...step, to: addr(99n) }, { ...step, value: step.value + 1n }, { ...step, data: `${step.data}00` as Hex }]) expect(() => ok(plan, bad)).toThrow();
      expect(() => assertSendableCreateStepV2(step, plan, addr(99n), plan.chainId)).toThrow();
      expect(() => assertSendableCreateStepV2(step, plan, plan.creator, 1)).toThrow();
      expect(() => assertSendableCreateStepV2(step, { ...plan, chainId: 1.5 }, plan.creator, 1.5)).toThrow();
    }
  });
  it('refuses seed approvals of another amount, spender or coin, and any seed step before the roles are known', () => {
    const pile = { ...ercPile, vault };
    for (const call of [approve(addr(6n), vault, 8n), approve(addr(6n), addr(99n), 7n), approve(addr(7n), vault, 7n), approve(addr(6n), vault, (1n << 256n) - 1n)]) {
      expect(() => ok(pile, call)).toThrow();
    }
    expect(() => ok(ercPile, approve(addr(6n), vault, 7n))).toThrow();
    expect(() => ok(ercPile, { to: vault, value: 0n, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'loadSeed' }) })).toThrow();
    const full = { ...shop, vault, starterLoader: loader };
    expect(() => ok(full, approve(base.token, loader, 9n))).toThrow();
    expect(() => ok(full, approve(addr(6n), vault, 9n))).toThrow();
    // Pulls the pile may make, never the creator's: redemption and seed return are not creation steps.
    expect(() => ok(pile, { to: vault, value: 0n, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'returnSeed' }) })).toThrow();
  });
  it('refuses a seed approval whose coin is a role, the creator or the factory', () => {
    expect(() => seedApprovalV2({ ...shop, vault, starterLoader: loader, token: vault })).toThrow();
    expect(() => seedApprovalV2({ ...shop, vault, starterLoader: loader, token: base.creator })).toThrow();
    expect(() => seedApprovalV2({ ...ercPile, vault, spec: { ...ercPile.spec, contentsParams: pileParams(base.factory, 7n) } })).toThrow();
    expect(() => createStepsV2({ ...ercPile, coordinator: base.creator })).toThrow();
  });
});

// Two listed collections share ids, in deliberately interleaved order; also list a collection with no starters.
const starterItems = Array.from({ length: 33 }, (_, i): StarterItemV2 => ({
  collection: addr(i % 2 === 0 ? 6n : 7n), id: i < 2 ? 0n : i < 4 ? maxUint256 : (1n << 80n) + BigInt(i), tier: i % 2,
}));
function starterPlan(items: readonly StarterItemV2[] = starterItems): CreateSendPlanV2 {
  let root: Hex = zeroHash;
  for (const item of [...items].reverse()) root = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }], [item.collection, item.id, item.tier, root]));
  return { ...shop, vault, starterLoader: loader, starterItems: items, spec: { ...shop.spec,
    contentsParams: encodeAbiParameters(shopConfigV2Parameters, [{ seedT: 9n, givePricesT: [1n, 2n, 3n, 4n], pickBps: 20000, weeklyBps: 100,
      collectionBps: 2500, listDelay: 604800, curator: base.creator, collections: [addr(6n), addr(7n), addr(9n)], tiers: [0, 1, 0] }]),
    addOns: [{ id: 8, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [root, items.length]) }],
  } };
}
const plannedStarters = () => starterItems.map((item) => approve(item.collection, vault, item.id));
const badStarterCalls = () => [
  approve(addr(6n), vault, 1n), // An unplanned id on a listed collection.
  approve(addr(9n), vault, 0n), // Even another listed collection has no approval without a committed item.
  approve(addr(99n), vault, 0n),
  approve(addr(6n), loader, 0n),
  approve(addr(6n), addr(99n), 0n),
  approve(addr(6n), zeroAddress, 0n),
  { to: addr(6n), value: 0n, data: encodeFunctionData({ abi: erc721Abi, functionName: 'setApprovalForAll', args: [vault, true] }) },
];

describe('SH-STARTER-GUARD exact committed starter approvals', () => {
  it('plans only the committed collection/id pairs in order, each page approved before its load and before the seed', () => {
    const plan = starterPlan();
    const steps = createStepsV2(plan);
    const approvals = steps.filter((step) => step.kind === 'approveStarter');
    expect(approvals).toEqual(starterItems.map((item, index) => ({ kind: 'approveStarter', index, item, ...approve(item.collection, vault, item.id) })));
    expect(starterApprovalsV2(plan)).toEqual(approvals);
    expect(steps.map((step) => step.kind)).toEqual(['createBox', ...Array(32).fill('approveStarter'), 'loadStarter', 'approveStarter', 'loadStarter', 'approveSeed', 'fundSeed', 'complete']);
    expect(steps.filter((step) => step.kind === 'loadStarter').map((step) => {
      const decoded = decodeFunctionData({ abi: starterSetLoaderV2Abi, data: step.data });
      if (decoded.functionName !== 'load') throw new Error('expected load');
      return decoded.args[1];
    })).toEqual([starterItems.slice(0, 32).map((item) => item.id), starterItems.slice(32).map((item) => item.id)]);
  });

  it('has no starter approval for an empty shop or a non-shop, and none before verified roles', () => {
    expect(starterApprovalsV2({ ...shop, vault, starterLoader: loader })).toEqual([]);
    expect(starterApprovalsV2(base)).toEqual([]);
    expect(starterApprovalsV2({ ...ercPile, vault })).toEqual([]);
    const plan = starterPlan();
    expect(createStepsV2({ ...plan, vault: undefined }).map((step) => step.kind)).toEqual(['createBox']);
    for (const incomplete of [{ ...plan, vault: undefined }, { ...plan, starterLoader: undefined }, { ...plan, vault: loader }, { ...plan, vault: zeroAddress }]) {
      expect(() => ok(incomplete, approve(addr(6n), vault, 0n))).toThrow(NotSendableError);
    }
  });

  it('admits every exact approval, including id zero and uint256 ids, and refuses altered authority or calldata', () => {
    const plan = starterPlan();
    for (const approval of plannedStarters()) {
      expect(() => ok(plan, approval)).not.toThrow();
      expect(() => ok(plan, { ...approval, value: 1n })).toThrow(NotSendableError);
      expect(() => ok(plan, { ...approval, data: `${approval.data}00` })).toThrow(NotSendableError);
      expect(() => assertSendableCreateStepV2(approval, plan, addr(99n), plan.chainId)).toThrow(NotSendableError);
      expect(() => assertSendableCreateStepV2(approval, plan, plan.creator, 1)).toThrow(NotSendableError);
    }
    for (const call of badStarterCalls()) expect(() => ok(plan, call)).toThrow(NotSendableError);
  });

  it('refuses a duplicate beyond the committed count, repeated items even if rehashed, or changed order, ids, collections and tiers', () => {
    const plan = starterPlan();
    const firstItem = starterItems[0];
    if (!firstItem) throw new Error('missing starter');
    const duplicate = [...starterItems, firstItem];
    const invalid = [
      { ...plan, starterItems: duplicate },
      starterPlan(duplicate),
      { ...plan, starterItems: [firstItem, ...starterItems.slice(0, -1)] },
      { ...plan, starterItems: [...starterItems].reverse() },
      { ...plan, starterItems: starterItems.slice(1) },
      ...[{ id: 1n }, { collection: addr(9n) }, { tier: 1 }].map((change) => ({
        ...plan, starterItems: [{ ...firstItem, ...change }, ...starterItems.slice(1)],
      })),
    ];
    for (const bad of invalid) {
      expect(() => createStepsV2(bad)).toThrow(NotSendableError);
      expect(() => starterApprovalsV2(bad)).toThrow(NotSendableError);
      expect(() => ok(bad, approve(firstItem.collection, vault, firstItem.id))).toThrow(NotSendableError);
    }
  });

  it('submitCreateWriteV2 sends each planned approval through the creation guard with exact zero value', async () => {
    const plan = starterPlan();
    const hash = toHex(123n, { size: 32 });
    const wallet = vi.fn(async ({ method }: Eip1193RequestArguments): Promise<unknown> =>
      method === 'eth_chainId' ? toHex(plan.chainId) : method === 'eth_accounts' ? [plan.creator] : hash);
    const approvals = plannedStarters();
    for (const call of approvals) await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet, plan, call, from: plan.creator, gasLimit: 90_000n })).resolves.toBe(hash);
    expect(wallet.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction').map(([request]) => request.params)).toEqual(
      approvals.map((call) => [{ from: plan.creator, to: call.to, data: call.data, value: '0x0', gas: toHex(90_000n), ...TEST_SEND_FEE_FIELDS, chainId: toHex(plan.chainId) }]),
    );
  });

  it('submitCreateWriteV2 refuses unplanned or blanket approvals and a duplicate beyond the plan before any wallet request', async () => {
    const plan = starterPlan();
    const wallet = vi.fn(async (): Promise<unknown> => { throw new Error('must not reach wallet'); });
    for (const call of badStarterCalls()) await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet, plan, call, from: plan.creator, gasLimit: 90_000n })).rejects.toThrow(NotSendableError);
    const firstItem = starterItems[0];
    if (!firstItem) throw new Error('missing starter');
    await expect(submitCreateWriteV2({ feeReader: TEST_FEE_READER, createOptionsCheck: NO_SWITCHES, wallet, plan: { ...plan, starterItems: [...starterItems, firstItem] },
      call: approve(firstItem.collection, vault, firstItem.id), from: plan.creator, gasLimit: 90_000n })).rejects.toThrow(NotSendableError);
    expect(wallet).not.toHaveBeenCalled();
  });
});
