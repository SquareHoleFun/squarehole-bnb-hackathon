import { expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { readItemClaimV2 } from '../../src/core/v2/m3-reads-v2';
import { readHolderClaimV2 } from '../../src/core/v2/m2-reads-v2';
import { m3Fixture, H, A } from '../../src/core/v2/m3-fixture.test-support';
import { m2Fixture } from '../../src/core/v2/m2-fixture.test-support';
const abi = parseAbi([
  'function fundingCursor() view returns (uint256)', 'function lifecycleCursor() view returns (uint256)',
  'function itemFundingCount() view returns (uint256)', 'function itemLifecycleCount() view returns (uint256)',
  'function itemCredit(uint256) view returns (uint256,uint256)', 'function itemCreditT(uint256) view returns (uint256,uint256)',
  'function ownerOf(uint256) view returns (address)', 'function balanceOf(address,uint256) view returns (uint256)',
  'function creatorPayee() view returns (address)', 'function creatorOwed(address) view returns (uint256,uint256)',
  'function failed() view returns (bool)', 'function graduated() view returns (bool)',
  'function claim(uint256[],address) returns (uint256)', 'function claimT(uint256[],address) returns (uint256)',
  'function rewardsPendingP() view returns (uint256)', 'function rewardsPendingByKind() view returns (uint256,uint256,uint256)',
  'function rewardBurnPendingT() view returns (uint256)',
  'function tradeBatch(uint256) view returns ((uint256 tradeUnits,uint256 protocolUnits,uint256 netP,bool closed))',
  'function holderBatchClosed(uint256) view returns (bool)', 'function holderBatchPaid(uint256) view returns (uint256)',
  'function batchState(uint256) view returns (bool,uint256,uint256,uint256)', 'function claimable(uint256,address) view returns (uint256)',
]);
const max = (1n << 127n) - 1n;
const n = 1n << 140n;
function reader(answers: Record<string, unknown>) {
  return { callAt: async (_to: Address, data: Hex, hash: Hex) => {
    expect(hash).toBe(H(101));
    const { functionName } = decodeFunctionData({ abi, data });
    if (!(functionName in answers)) throw new Error(`missing ${functionName}`);
    return encodeFunctionResult({ abi, functionName, result: answers[functionName] as never });
  } };
}
it('T32 mixed item quotes keep both assets exact and distinguish a refusal from an RPC outage', async () => {
  const f = m3Fixture(); const row = { ...f.row, spec: { ...f.row.spec, buyers: { ...f.row.spec.buyers, a: { ...f.row.spec.buyers.a, leg: 2 } } } };
  const answers = { fundingCursor: 2n, lifecycleCursor: 4n, itemFundingCount: 2n, itemLifecycleCount: 4n,
    itemCredit: [11n, 3n], itemCreditT: [n, 17n], balanceOf: n * 2n, ownerOf: A, failed: false, graduated: true,
    rewardsPendingP: 13n, rewardsPendingByKind: [0n, 13n, 0n], rewardBurnPendingT: 0n };
  const r = reader(answers);
  const available = { ...r, callFromAt: async (from: Address, to: Address, data: Hex, hash: Hex) => {
    expect([from, to, hash]).toEqual([A, row.contracts.itemLedger, H(101)]);
    const decoded = decodeFunctionData({ abi, data }); expect(decoded.args).toEqual([[1n], A]);
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result: decoded.functionName === 'claimT' ? max : 14n });
  } };
  expect(await readItemClaimV2(available, row, { id: 1n }, H(101))).toMatchObject({ claimableP: 14n, payout: 'available',
    t: { outsideT: n, stashT: 17n, claimableT: max, payout: 'available' } });
  for (const [error, payout] of [[new Error('offline'), 'unverified'], [Object.assign(new Error('refused'), { code: 3 }), 'unavailable']] as const) {
    expect(await readItemClaimV2({ ...r, callFromAt: async () => { throw error; } }, row, { id: 1n }, H(101))).toMatchObject({ t: { payout, outsideT: n } });
  }
  await expect(readItemClaimV2(reader({ ...answers, balanceOf: 15n }), row, { id: 1n }, H(101))).rejects.toThrow('T credit is not backed');
});
it('T33 holder funding in T is never compared with nominal P and caps only the next payment', async () => {
  const f = m2Fixture(false); const row = { ...f.row, spec: { ...f.row.spec, buyers: { ...f.row.spec.buyers, a: { ...f.row.spec.buyers.a, leg: 2, destParams: H(2) } } } };
  const r = reader({ tradeBatch: { tradeUnits: 10n, protocolUnits: 0n, netP: 7n, closed: true }, holderBatchClosed: true,
    holderBatchPaid: n + 1n, batchState: [true, 3n, 0n, 1n], claimable: n, failed: false });
  expect(await readHolderClaimV2(r, row, { batchId: 1n, holder: A }, H(101))).toMatchObject({ fundingP: 0n, claimableP: 0n,
    t: { fundingT: n + 1n, creditT: n, residueT: 1n, claimableT: max, payout: 'unverified' } });
});
it('AF1 a pending holder tranche cannot hide earlier claimable T', async () => {
  const f = m2Fixture(false); const row = { ...f.row, spec: { ...f.row.spec, buyers: { ...f.row.spec.buyers, a: { ...f.row.spec.buyers.a, leg: 2, destParams: H(2) } } } };
  const r = reader({ tradeBatch: { tradeUnits: 10n, protocolUnits: 0n, netP: 7n, closed: true }, holderBatchClosed: true,
    holderBatchPaid: 180n, batchState: [false, 1n, 0n, 1n], claimable: 49n, failed: false });
  expect(await readHolderClaimV2(r, row, { batchId: 1n, holder: A }, H(101))).toMatchObject({ status: 'settling', complete: false,
    t: { fundingT: 180n, creditT: 49n, claimableT: 49n, payout: 'unverified' } });
});

import { WalletClaimsIndexV2 } from '../../src/core/v2/claims-index-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';
import { B } from '../../src/core/v2/m2-fixture.test-support';
it('T35 wallet pages publish independent P and T item claims under the actual asset', async () => {
  const f = m3Fixture(); const row = { ...f.row, spec: { ...f.row.spec, buyers: { ...f.row.spec.buyers, a: { ...f.row.spec.buyers.a, leg: 2 } } } };
  const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n };
  const base = applyV2Block(undefined, header, [], row).state;
  if (!base.view.m3?.items) throw new Error('missing item projection');
  const state = { ...base, view: { ...base.view, m3: { ...base.view.m3, items: { ...base.view.m3.items, owners: { '1': A.toLowerCase() as Address } } } } };
  const source = { chainId: row.chainId, head: () => header, hashAt: () => H(101), boxesV2: new Map([[f.at(1), { row, states: [state], verified: true, repairing: false }]]) };
  const r = reader({ fundingCursor: 2n, lifecycleCursor: 4n, itemFundingCount: 2n, itemLifecycleCount: 4n,
    itemCredit: [11n, 3n], itemCreditT: [n, 17n], balanceOf: n * 2n, ownerOf: A, failed: false, graduated: true,
    rewardsPendingP: 13n, rewardsPendingByKind: [0n, 13n, 0n], rewardBurnPendingT: 0n, creatorPayee: B, creatorOwed: [0n, 0n] });
  const index = new WalletClaimsIndexV2(source, { ...r, headerByNumber: async () => header });
  const page = await index.page(A);
  expect(page.items.filter(i => i.kind === 'item').map(i => [i.asset, i.amountP])).toEqual([
    [row.q.toLowerCase(), '14'], [f.at(1).toLowerCase(), String(max)],
  ]);
  expect(new Set(page.items.map(i => i.id)).size).toBe(page.items.length);
});

import type { CoreEventV2 } from '../../src/core/v2/events-v2';
import { rewardClaimPaymentsV21 } from '../../src/core/v2/pay-in-t-claims-v21';
it('T36 settled T batches remain discoverable after a bounded partial claim, with correctly denominated receipts', async () => {
  const f = m2Fixture(false); const row = { ...f.row, spec: { ...f.row.spec, buyers: { ...f.row.spec.buyers, a: { ...f.row.spec.buyers.a, leg: 2, destParams: H(2) } } } };
  const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n };
  const event = (source: CoreEventV2['source'], name: string, args: Record<string, unknown>, logIndex: number): CoreEventV2 => ({
    source, name, args, boxId: row.boxId, listingId: null, address: source === 'receiver' ? f.at(5) : f.at(17),
    ref: { blockNumber: 101n, blockHash: H(101), txHash: H(200), txIndex: 0, logIndex },
  });
  const paid = event('holderLedger', 'HolderPaid', { batchId: 1n, holder: A, to: A, grossP: max, tipP: 0n }, 2);
  const state = applyV2Block(undefined, header, [
    event('receiver', 'RewardsBought', { choice: 7, side: 0, spentP: 7n, boughtT: n, ledgerT: n, burnT: 0n, tipP: 0n }, 0),
    event('holderLedger', 'BatchSettled', { batchId: 1n, fundingP: n, holderP: n, residueP: 0n }, 1), paid,
  ], row).state;
  const source = { chainId: row.chainId, head: () => header, hashAt: () => H(101), boxesV2: new Map([[f.at(1), { row, states: [state], verified: true, repairing: false }]]) };
  const r = reader({ tradeBatch: { tradeUnits: 10n, protocolUnits: 0n, netP: 7n, closed: true }, holderBatchClosed: true,
    holderBatchPaid: n, batchState: [false, 1n, 0n, 0n], claimable: n - max, failed: false, graduated: true, creatorPayee: B, creatorOwed: [0n, 0n] });
  const page = await new WalletClaimsIndexV2(source, { ...r, headerByNumber: async () => header }).page(A);
  expect(page.items.filter(i => i.kind === 'holder')).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'claimed', asset: f.at(1).toLowerCase(), amountP: String(max) }),
    expect.objectContaining({ status: 'claimable', asset: f.at(1).toLowerCase(), amountP: String(max) }),
  ]));
  const item = { ...paid, source: 'itemLedger' as const, name: 'ItemPaidT', args: { id: 1n, owner: A, to: B, amountT: 17n } };
  const receipts = rewardClaimPaymentsV21([], [item], 101n, row);
  expect(receipts).toMatchObject([{ kind: 'item', asset: f.at(1), amountP: 17n, wallet: A.toLowerCase(), to: B.toLowerCase() }]);
  expect(rewardClaimPaymentsV21(receipts, [], 102n, row)).toEqual(receipts);
});
it('SH-279 a holder batch paid in T with a final funding of zero keeps its rule: settling until complete', async () => {
  const f = m2Fixture(false); const row = { ...f.row, spec: { ...f.row.spec, buyers: { ...f.row.spec.buyers, a: { ...f.row.spec.buyers.a, leg: 2, destParams: H(2) } } } };
  const r = reader({ tradeBatch: { tradeUnits: 10n, protocolUnits: 0n, netP: 0n, closed: true }, holderBatchClosed: true,
    holderBatchPaid: 0n, batchState: [false, 0n, 0n, 0n], claimable: 0n, failed: false });
  expect(await readHolderClaimV2(r, row, { batchId: 1n, holder: A }, H(101))).toMatchObject({ status: 'settling', complete: false });
});
