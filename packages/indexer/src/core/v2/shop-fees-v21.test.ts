import { expect, it } from 'vitest';
import { feeChoiceV2 } from './views-v2';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
it('SF-I decodes the canonical shop choice separately from pile and module', () => {
  const empty = { leg: 0, dest: 0, legParams: '0x' as const, destParams: '0x' as const };
  for (const preset of [2, 4, 8]) expect(feeChoiceV2({ split: 1, splitParams: '0x', b: empty,
    a: { leg: 2, dest: 7, legParams: '0x', destParams: encodeAbiParameters(parseAbiParameters('uint8'), [preset]) } })).toBe('shop');
});

import { projectShopFeesV21 } from './shop-fees-v21';
import type { CoreEventV2 } from './events-v2';
import { H, A, B, m2Fixture } from './m2-fixture.test-support';
import { checkBoxV2 } from './discovery-v2';
import { encodeBoxSpecV2 } from './chain-v2';
import { keccak256, type Hex } from 'viem';
const event = (name: string, args: Record<string, unknown>): CoreEventV2 => ({ name, args, source: 'receiver', address: A, boxId: 1n, listingId: null,
  ref: { blockNumber: 1n, blockHash: H(1), txHash: H(2), txIndex: 0, logIndex: 1 } });
it('SF-I refunds original batch intervals exactly across purchases, incremental reads and rollback', () => {
  const queued = [event('ShopBatchQueued', { batchId: 2n, startP: 0n, endP: 17n }), event('ShopBatchQueued', { batchId: 4n, startP: 17n, endP: 36n })];
  const bought = [event('ShopPendingConsumed', { consumedP: 10n, refundedP: 0n }), event('ShopFunded', { sellers: true, spentP: 10n, boughtT: 9007199254741009n })];
  const partial = projectShopFeesV21([...queued, ...bought], 1n, A);
  expect(partial.events.filter(e => e.name === 'HolderBatchFunded')).toHaveLength(0);
  const refund = event('ShopPendingConsumed', { consumedP: 36n, refundedP: 26n });
  const final = projectShopFeesV21([refund], 1n, A, partial.state);
  expect(final.events.filter(e => e.name === 'HolderBatchFunded').map(e => e.args)).toEqual([{ batchId: 2n, netP: 7n }, { batchId: 4n, netP: 19n }]);
  expect(final.state).toEqual(projectShopFeesV21([...queued, ...bought, refund], 1n, A).state);
  expect(partial.state.consumedP).toBe(10n);
  expect(projectShopFeesV21([{ ...refund, address: B }], 1n, A, partial.state).state).toEqual(partial.state);
  expect(() => projectShopFeesV21([event('ShopPendingConsumed', { consumedP: 37n, refundedP: 27n })], 1n, A, partial.state)).toThrow();
  expect(() => projectShopFeesV21([event('ShopBatchQueued', { batchId: 2n, startP: 0n, endP: 17n })], 1n, A, partial.state)).toThrow();
});
it('SF-I authenticates the shop ceiling suffix and mandatory holder ledger with buyers Grow', async () => {
  const f = m2Fixture();
  const spec = { ...f.spec, buyers: { ...f.spec.buyers, a: { leg: 1, dest: 4, legParams: '0x' as const, destParams: '0x' as const } },
    sellers: { ...f.spec.sellers, a: { leg: 2, dest: 7, legParams: '0x' as const, destParams: H(2) } } };
  const encodedSpec = encodeBoxSpecV2(spec);
  const address = f.at(3).toLowerCase(); const original = f.code.get(address) as Hex;
  f.code.set(address, `${original}02`);
  const record = { ...f.record, specHash: keccak256(encodedSpec), codeHashes: f.record.codeHashes.map((h, i) => i === 3 ? keccak256(f.code.get(address) as Hex) : h) };
  const check = () => checkBoxV2(f.reader, f.manifest, { registry: f.row.registry, record, encodedSpec }, { creationHash: H(100), headHash: H(101), reviewed: [] });
  expect((await check()).classification).toBe('shown');
  f.code.set(address, `${original}04`);
  expect((await check()).classification).toBe('refused');
});
