import { expect, it } from 'vitest';
import { type Address, zeroAddress } from 'viem';
import { boxViewV2, feeChoiceV2, type BoxViewContextV2 } from '../../src/core/v2/views-v2';
import type { CoreEventV2 } from '../../src/core/v2/events-v2';
const receiver = '0x0000000000000000000000000000000000000003' as Address;
const ctx: BoxViewContextV2 = { boxId: 1n, creator: receiver, creatorFeeRecipient: null, p: zeroAddress, pDecimals: 18, receiver, choices: { buyers: null, sellers: null }, notCreator: [] };
const event = (amount: bigint, total: bigint): CoreEventV2 => ({ source: 'receiver', name: 'PriceCoinEaten', address: receiver, boxId: 1n, listingId: null, args: { asset: zeroAddress, amount, total, burned: false }, ref: { blockNumber: 1n, blockHash: '0x01', txHash: '0x02', txIndex: 0, logIndex: 0 } });
it('EAT13 records cumulative per-box eaten P as bigint and authenticates asset and receiver', () => {
  const n = 9007199254740993123456n;
  const first = event(n, n);
  const view = boxViewV2([first], ctx);
  expect(view).toHaveProperty('eatenP', n);
  expect(boxViewV2([event(7n, n + 7n)], ctx, view)).toHaveProperty('eatenP', n + 7n);
  expect(boxViewV2([{ ...first, address: zeroAddress }], ctx)).toHaveProperty('eatenP', 0n);
  expect(boxViewV2([{ ...first, args: { ...first.args, asset: receiver } }], ctx)).toHaveProperty('eatenP', 0n);
  expect(boxViewV2([{ ...first, boxId: 2n }], ctx)).toHaveProperty('eatenP', 0n);
});
it('EAT14 recognizes the sixth choice while preserving buy-back burn', () => {
  const side = { a: { leg: 1, dest: 1, legParams: '0x' as const, destParams: '0x' as const }, b: { leg: 0, dest: 0, legParams: '0x' as const, destParams: '0x' as const }, split: 1, splitParams: '0x' as const };
  expect(feeChoiceV2(side)).toBe('eat');
  expect(feeChoiceV2({ ...side, a: { ...side.a, leg: 2 } })).toBe('burn');
});

import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
import { decodeV2Logs, type RouteV2 } from '../../src/core/v2/events-v2';
import { listingBookV2 } from '../../src/core/v2/listings-v2';
it('EAT22 decodes only the registered receiver, rejects removed logs, and deduplicates before accumulation', () => {
  const abi = parseAbi(['event PriceCoinEaten(address indexed asset,uint256 amount,uint256 total,bool burned)']);
  const log = { address: receiver, blockNumber: 1n, blockHash: `0x${'11'.repeat(32)}` as Hex, transactionHash: `0x${'22'.repeat(32)}` as Hex, transactionIndex: 0, logIndex: 0,
    topics: encodeEventTopics({ abi, eventName: 'PriceCoinEaten', args: { asset: zeroAddress } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], [7n, 7n, false]), removed: false };
  const route: RouteV2 = { modules: new Set(), registry: zeroAddress, listingRegistry: zeroAddress, poolManager: zeroAddress, randomness: zeroAddress, parts: new Map([[receiver.toLowerCase(), { boxId: 1n, role: 'receiver' }]]), pools: new Map() };
  expect(boxViewV2(decodeV2Logs([log, log], route), ctx)).toHaveProperty('eatenP', 7n);
  expect(decodeV2Logs([{ ...log, removed: true }], route)).toEqual([]);
  expect(decodeV2Logs([{ ...log, address: '0x0000000000000000000000000000000000000999' }], route)).toEqual([]);
  expect(() => boxViewV2([event(7n, 8n)], ctx)).toThrow('cumulative');
});
it('EAT23 checked capability belongs to one permanent listing and survives raise updates', () => {
  const base = { ...event(0n, 0n), source: 'listingRegistry' as const, boxId: null };
  const added = { ...base, name: 'ListingAdded', args: { id: 1, token: receiver, class: 5, kind: 1, raise: 100n } };
  const checked = { ...base, name: 'CheckedBurnRecorded', ref: { ...base.ref, logIndex: 1 }, args: { id: 1, token: receiver, selector: '0x42966c68' } };
  const raised = { ...base, name: 'RaiseUpdated', ref: { ...base.ref, logIndex: 2 }, args: { id: 1, previousRaise: 100n, raise: 200n } };
  expect(listingBookV2([raised, added, checked]).byId(1)).toMatchObject({ raise: 200n, checkedBurnSelector: '0x42966c68' });
  expect(() => listingBookV2([added, { ...checked, args: { ...checked.args, token: zeroAddress } }])).toThrow('checked-burn');
});

import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { receiverEatV21Abi } from '../../src/core/v2/chain-v2';
import { m2Fixture, H } from '../../src/core/v2/m2-fixture.test-support';
import { applyV2Block, liveViewV2 } from '../../src/core/v2/views-v2';
import { readMoneyV2, compareMoneyV2 } from '../../src/core/v2/money-v2';
import { serviceChainV2 } from './scripted-core-chain';
import { jsonV2 } from '../../src/core/core-row';
it('EAT24 audits backed pending claims and the event total, and serializes raw amounts exactly', async () => {
  const f = m2Fixture(false);
  const n = (1n << 140n) + 17n;
  const base = serviceChainV2({ headers: [], logs: [] }, [f]);
  const state = applyV2Block(undefined, { number: 100n, hash: H(100), parentHash: H(99), timestamp: 1000n }, [], f.row).state;
  const view = { ...state.view, choices: { buyers: 'eat' as const, sellers: 'burn' as const }, eatenP: n };
  const reads: string[] = [];
  const reader = { async callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> {
    expect(hash).toBe(H(100));
    if (to.toLowerCase() === f.at(5).toLowerCase()) {
      let fn: 'eatPendingP' | 'eatenP' | 'priceBurnSelector' | undefined;
      try { fn = decodeFunctionData({ abi: receiverEatV21Abi, data }).functionName as typeof fn; } catch { /* old receiver read */ }
      if (fn) {
        reads.push(fn);
        return encodeFunctionResult({ abi: receiverEatV21Abi, functionName: fn, result: fn === 'priceBurnSelector' ? '0x42966c68' : n } as never);
      }
    }
    return base.callAt(to, data, hash);
  } };
  const money = await readMoneyV2(reader, f.row, view, 100n, H(100));
  expect(reads.sort()).toEqual(['eatPendingP', 'eatenP', 'priceBurnSelector']);
  expect(money.eat).toEqual({ pendingP: n, eatenP: n, burnSelector: '0x42966c68' });
  // A synthetic insolvent claim balance must be rejected even though all old ledgers are zero.
  expect(compareMoneyV2({ ...state, view }, money).mismatches).toContain('receiver ledgers and two carries do not reconcile to bookedP');
  const badTotal = compareMoneyV2({ ...state, view: { ...view, eatenP: n - 1n } }, money);
  expect(badTotal.mismatches.some(x => x.startsWith('receiver.eatenP:'))).toBe(true);
  expect(jsonV2(liveViewV2({ ...state, view, money }, 1000n))).toMatchObject({ eatenP: n.toString(), money: { eat: { pendingP: n.toString(), eatenP: n.toString() } } });
});
