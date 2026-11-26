/**
 * SH-V21-FIX-KEEPER-INDEX, finding V21-OC-01: the wallet claims API shows a row only to a wallet that can actually
 * have a credit or a staged amount. A settling T tranche is no longer a 'pending' row for every wallet, and a box
 * whose every Items side pays T never publishes a P item row.
 */
import { expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { WalletClaimsIndexV2 } from '../../src/core/v2/claims-index-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';
import type { CoreEventV2 } from '../../src/core/v2/events-v2';
import type { BoxRowV2 } from '../../src/core/core-row';
import { m2Fixture, A, B, H } from '../../src/core/v2/m2-fixture.test-support';
import { m3Fixture } from '../../src/core/v2/m3-fixture.test-support';

const abi = parseAbi([
  'function tradeBatch(uint256) view returns ((uint256 tradeUnits,uint256 protocolUnits,uint256 netP,bool closed))',
  'function holderBatchClosed(uint256) view returns (bool)', 'function holderBatchPaid(uint256) view returns (uint256)',
  'function batchState(uint256) view returns (bool,uint256,uint256,uint256)', 'function claimable(uint256,address) view returns (uint256)',
  'function failed() view returns (bool)', 'function graduated() view returns (bool)',
  'function creatorPayee() view returns (address)', 'function creatorOwed(address) view returns (uint256,uint256)',
  'function fundingCursor() view returns (uint256)', 'function lifecycleCursor() view returns (uint256)',
  'function itemFundingCount() view returns (uint256)', 'function itemLifecycleCount() view returns (uint256)',
  'function itemCredit(uint256) view returns (uint256,uint256)', 'function itemCreditT(uint256) view returns (uint256,uint256)',
  'function ownerOf(uint256) view returns (address)', 'function balanceOf(address,uint256) view returns (uint256)',
  'function rewardsPendingP() view returns (uint256)', 'function rewardsPendingByKind() view returns (uint256,uint256,uint256)',
  'function rewardBurnPendingT() view returns (uint256)',
]);
const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n };
const n = 1n << 140n;
/** A wallet that never held the token. */
const W = '0x000000000000000000000000000000000000c0de' as Address;
type Answer = unknown | ((args: readonly unknown[]) => unknown);
function pages(row: BoxRowV2, state: ReturnType<typeof applyV2Block>['state'], answers: Record<string, Answer>) {
  const callAt = async (_to: Address, data: Hex, hash: Hex) => {
    expect(hash).toBe(H(101));
    const { functionName, args = [] } = decodeFunctionData({ abi, data });
    if (!(functionName in answers)) throw new Error(`unscripted ${functionName}`);
    const answer = answers[functionName];
    return encodeFunctionResult({ abi, functionName, result: (typeof answer === 'function' ? answer(args) : answer) as never });
  };
  const source = { chainId: row.chainId, head: () => header, hashAt: () => H(101),
    boxesV2: new Map([[row.contracts.token as string, { row, states: [state], verified: true, repairing: false }]]) };
  return new WalletClaimsIndexV2(source, { callAt, headerByNumber: async () => header });
}

it('OC-01 a settling T tranche gives no holder row to a wallet without credit; a holder keeps its claimable row', async () => {
  const f = m2Fixture(false);
  const row = { ...f.row, spec: { ...f.row.spec, buyers: { ...f.row.spec.buyers, a: { ...f.row.spec.buyers.a, leg: 2, destParams: H(2) } } } };
  const event = (source: CoreEventV2['source'], name: string, args: Record<string, unknown>, logIndex: number): CoreEventV2 => ({
    source, name, args, boxId: row.boxId, listingId: null, address: source === 'receiver' ? f.at(5) : f.at(17),
    ref: { blockNumber: 101n, blockHash: H(101), txHash: H(200), txIndex: 0, logIndex },
  });
  // One purchased tranche settled; a later purchase raised funding, so batch 1 is settling again.
  const state = applyV2Block(undefined, header, [
    event('receiver', 'RewardsBought', { choice: 7, side: 0, spentP: 7n, boughtT: 2n * n, ledgerT: 2n * n, burnT: 0n, tipP: 0n }, 0),
    event('holderLedger', 'BatchSettled', { batchId: 1n, fundingP: n, holderP: n, residueP: 0n }, 1),
  ], row).state;
  for (const complete of [false, true]) {
    const index = pages(row, state, { tradeBatch: { tradeUnits: 10n, protocolUnits: 0n, netP: 7n, closed: true },
      holderBatchClosed: true, holderBatchPaid: complete ? n : 2n * n, batchState: [complete, 1n, 0n, 0n],
      claimable: (args: readonly unknown[]) => (String(args[1]).toLowerCase() === A.toLowerCase() ? 49n : 0n),
      failed: false, graduated: true, creatorPayee: B, creatorOwed: [0n, 0n] });
    expect((await index.page(W)).items.filter(i => i.kind === 'holder'), `complete=${complete}`).toEqual([]);
    expect((await index.page(A)).items.filter(i => i.kind === 'holder').map(i => [i.status, i.asset, i.amountP]), `complete=${complete}`)
      .toEqual([['claimable', f.at(1).toLowerCase(), '49']]);
  }
});

it('OC-01 a box whose every Items side pays T publishes no P item row, even while its journals are behind', async () => {
  const f = m3Fixture();
  const items = (buyersLeg: number, sellersLeg: number) => {
    const row = { ...f.row, spec: { ...f.row.spec, buyers: { ...f.row.spec.buyers, a: { ...f.row.spec.buyers.a, leg: buyersLeg } },
      sellers: { ...f.row.spec.sellers, a: { ...f.row.spec.sellers.a, leg: sellersLeg } } } };
    const base = applyV2Block(undefined, header, [], row).state;
    if (!base.view.m3?.items) throw new Error('missing item projection');
    const state = { ...base, view: { ...base.view, m3: { ...base.view.m3, items: { ...base.view.m3.items, owners: { '1': A.toLowerCase() as Address } } } } };
    return pages(row, state, { fundingCursor: 1n, lifecycleCursor: 4n, itemFundingCount: 2n, itemLifecycleCount: 4n,
      itemCredit: [11n, 3n], itemCreditT: [n, 17n], balanceOf: n * 2n, ownerOf: A, failed: false, graduated: true,
      rewardsPendingP: 13n, rewardsPendingByKind: [0n, 13n, 0n], rewardBurnPendingT: 0n, creatorPayee: B, creatorOwed: [0n, 0n] });
  };
  const rows = async (buyersLeg: number, sellersLeg: number) =>
    (await items(buyersLeg, sellersLeg).page(A)).items.filter(i => i.kind === 'item').map(i => [i.asset, i.status, i.amountP]);
  const p = f.row.q.toLowerCase(), t = f.at(1).toLowerCase();
  expect(await rows(2, 2)).toEqual([[t, 'pending', null]]);
  // Control: a P Items side keeps its own pending row next to the T row.
  expect(await rows(2, 1)).toEqual([[p, 'pending', null], [t, 'pending', null]]);
});
