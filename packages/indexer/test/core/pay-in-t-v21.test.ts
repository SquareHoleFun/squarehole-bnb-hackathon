import { expect, it } from 'vitest';
import { feeChoiceV2 } from '../../src/core/v2/views-v2';
import type { SideV2 } from '../../src/core/v2/chain-v2';
const side = (dest: number, value: number): SideV2 => ({ a: { leg: 2, dest, legParams: '0x', destParams: `0x${value.toString(16).padStart(64, '0')}` }, b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' }, split: 1, splitParams: '0x' });
it('T22 recognizes both canonical T choices and rejects mismatched currency', () => {
  expect(feeChoiceV2(side(6, 2))).toBe('holders-t');
  expect(feeChoiceV2(side(8, 1))).toBe('items-t');
  expect(feeChoiceV2(side(8, 2))).toBe('items-t');
  expect(feeChoiceV2(side(6, 1))).toBe(null);
  expect(feeChoiceV2(side(8, 3))).toBe('items-t');
  expect(feeChoiceV2(side(8, 4))).toBe(null);
});

import { type Address, zeroAddress } from 'viem';
import { boxViewV2 } from '../../src/core/v2/views-v2';
import { m2Fixture } from '../../src/core/v2/m2-fixture.test-support';
import type { CoreEventV2 } from '../../src/core/v2/events-v2';
import { payInTViewV21, priceEventsV21 } from '../../src/core/v2/pay-in-t-v21';
const receiver = '0x0000000000000000000000000000000000000003' as Address;
const event = (source: CoreEventV2['source'], name: string, args: Record<string, unknown>): CoreEventV2 => ({ source, name, args, address: receiver, boxId: 1n, listingId: null, ref: { blockNumber: 1n, blockHash: '0x01', txHash: '0x02', txIndex: 0, logIndex: 0 } });
it('T25 separates burned inside T, keeps P buys unchanged, and conserves claims over snapshots', () => {
  const n = 1n << 140n;
  const buys = [event('token', 'Transfer', { from: receiver, to: zeroAddress, amount: n }),
    event('receiver', 'RewardTBurned', { amountT: n }),
    event('receiver', 'RewardsBought', { choice: 8, side: 1, spentP: 5n, boughtT: n * 3n, ledgerT: n * 2n, burnT: n, tipP: 1n })];
  const ctx = { boxId: 1n, creator: receiver, creatorFeeRecipient: null, p: zeroAddress, pDecimals: 18, receiver, choices: { buyers: 'items-t' as const, sellers: 'burn' as const }, notCreator: [] };
  const v = boxViewV2(buys, ctx);
  expect(v.buyBack).toEqual({ pSpent: 0n, tBought: 0n, tBurned: 0n, tipsP: 0n });
  expect(v.payInT).toMatchObject({ itemsFundedT: n * 2n, burnedT: n, spentP: 5n, tipsP: 1n });
  const paid = event('itemLedger', 'ItemPaidT', { id: 1n, owner: receiver, to: receiver, amountT: n });
  const next = boxViewV2([paid], ctx, v);
  expect(next.payInT?.itemsPaidT).toBe(n); expect(v.payInT?.itemsPaidT).toBe(0n);
  expect(() => boxViewV2([{ ...paid, args: { ...paid.args, amountT: n * 3n } }], ctx, next)).toThrow('conservation');
});
it('T26 mixed holder batches keep original P events and account T in their own units', () => {
  const f = m2Fixture(false); const spec = { ...f.row.spec, buyers: side(6, 2) };
  const buy = event('receiver', 'RewardsBought', { choice: 7, side: 0, spentP: 11n, boughtT: 100n, ledgerT: 100n, burnT: 0n, tipP: 0n });
  const settled = event('holderLedger', 'BatchSettled', { batchId: 1n, fundingP: 100n, holderP: 91n, residueP: 9n });
  const price = { ...settled, args: { ...settled.args, batchId: 2n } };
  expect(priceEventsV21([settled, price], spec)).toEqual([price]);
  const v = payInTViewV21([buy, settled], 1n, receiver, spec);
  const paid = event('holderLedger', 'HolderPaid', { batchId: 1n, holder: receiver, to: receiver, grossP: 91n, tipP: 0n });
  const residue = event('holderLedger', 'ResidueFlushed', { batchId: 1n, amountP: 9n });
  expect(payInTViewV21([paid, residue], 1n, receiver, spec, v)).toMatchObject({ holdersPaidT: 91n, holderResidueT: 9n });
  expect(() => payInTViewV21([paid, paid], 1n, receiver, spec, v)).toThrow('conservation');
});
it('AF1 accumulates purchased holder tranches without losing prior payments or residue', () => {
  const f = m2Fixture(false); const spec = { ...f.row.spec, buyers: side(6, 2) };
  const buy = (n: bigint) => event('receiver', 'RewardsBought', { choice: 7, side: 0, spentP: 1n, boughtT: n, ledgerT: n, burnT: 0n, tipP: 0n });
  const settle = (n: bigint) => event('holderLedger', 'BatchSettled', { batchId: 1n, fundingP: n, holderP: n - 1n, residueP: 1n });
  const pay = (n: bigint) => event('holderLedger', 'HolderPaid', { batchId: 1n, holder: receiver, to: receiver, grossP: n, tipP: 0n });
  const flush = event('holderLedger', 'ResidueFlushed', { batchId: 1n, amountP: 1n });
  const first = payInTViewV21([buy(100n), settle(100n), pay(99n), flush], 1n, receiver, spec);
  const second = payInTViewV21([buy(80n), settle(80n)], 1n, receiver, spec, first);
  expect(second.batches['1']).toEqual({ fundingT: 180n, holderT: 178n, residueT: 2n, paidT: 99n, flushedT: 1n });
  const last = payInTViewV21([pay(79n), flush], 1n, receiver, spec, second);
  expect(last.holdersPaidT + last.holderResidueT).toBe(last.holdersFundedT);
  expect(() => payInTViewV21([pay(1n)], 1n, receiver, spec, last)).toThrow('conservation');
  expect(first.batches['1']?.fundingT).toBe(100n);
});

import { keccak256, type Hex } from 'viem';
import { checkBoxV2 } from '../../src/core/v2/discovery-v2';
import { encodeBoxSpecV2 } from '../../src/core/v2/chain-v2';
import { H } from '../../src/core/v2/m2-fixture.test-support';
import { rewardArgsSuffixV21, receiverArgsHexLengthV21 } from '../../src/core/v2/pay-in-t-provenance-v21';
it('T27 discovery requires the exact appended holder side mask', async () => {
  const f = m2Fixture(false); const spec = { ...f.spec, buyers: side(6, 2) };
  const encodedSpec = encodeBoxSpecV2(spec);
  const old = f.code.get(f.at(17).toLowerCase()) as Hex;
  const check = async (suffix: string) => {
    const runtime = `${old}${suffix}` as Hex; f.code.set(f.at(17).toLowerCase(), runtime);
    const record = { ...f.record, specHash: keccak256(encodedSpec), codeHashes: f.record.codeHashes.map((h, i) => i === 17 ? keccak256(runtime) : h) };
    return checkBoxV2(f.reader, f.manifest, { registry: f.row.registry, record, encodedSpec }, { creationHash: H(100), headHash: H(101), reviewed: [] });
  };
  expect((await check(rewardArgsSuffixV21(spec, 6, f.at(1)))).classification).toBe('shown');
  expect((await check('02')).classification).toBe('refused');
  expect((await check('')).classification).toBe('refused');
});

it('T30 a T reward paired with Eat retains the step-1 receiver suffix', () => {
  const f = m2Fixture(false);
  const spec = { ...f.spec, buyers: side(6, 2), sellers: { ...side(1, 1), a: { leg: 1, dest: 1, legParams: '0x' as Hex, destParams: '0x' as Hex } } };
  expect(receiverArgsHexLengthV21(spec)).toBe(534);
  expect(receiverArgsHexLengthV21({ ...spec, sellers: side(8, 1) })).toBe(526);
});
