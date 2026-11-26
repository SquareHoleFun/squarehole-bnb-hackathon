import { expect, it } from 'vitest';
import { type Address, zeroAddress } from 'viem';
import { boxViewV2, feeChoiceV2, type BoxViewContextV2 } from '../../src/core/v2/views-v2';
import type { CoreEventV2 } from '../../src/core/v2/events-v2';
const receiver = '0x0000000000000000000000000000000000000003' as Address;
const ctx: BoxViewContextV2 = { boxId: 1n, creator: receiver, creatorFeeRecipient: null, p: zeroAddress, pDecimals: 18, receiver, pile: receiver, choices: { buyers: null, sellers: null }, notCreator: [] };
const event = (amount: bigint, total: bigint): CoreEventV2 => ({ source: 'receiver', name: 'PileFeesMoved', address: receiver, boxId: 1n, listingId: null, args: { asset: zeroAddress, amount, total, pile: receiver }, ref: { blockNumber: 1n, blockHash: '0x01', txHash: '0x02', txIndex: 0, logIndex: 0 } });
it('PF09 records cumulative per-box moved P as bigint and authenticates asset and receiver', () => {
  const n = 9007199254740993123456n;
  const first = event(n, n);
  const view = boxViewV2([first], ctx);
  expect(view).toHaveProperty('pileMovedP', n);
  expect(boxViewV2([event(7n, n + 7n)], ctx, view)).toHaveProperty('pileMovedP', n + 7n);
  expect(boxViewV2([{ ...first, address: zeroAddress }], ctx)).toHaveProperty('pileMovedP', 0n);
  expect(boxViewV2([{ ...first, args: { ...first.args, asset: receiver } }], ctx)).toHaveProperty('pileMovedP', 0n);
  expect(boxViewV2([{ ...first, boxId: 2n }], ctx)).toHaveProperty('pileMovedP', 0n);
});
it('PF10 recognizes the appended pile choice while preserving buy-back burn', () => {
  const side = { a: { leg: 1, dest: 7, legParams: '0x' as const, destParams: '0x' as const }, b: { leg: 0, dest: 0, legParams: '0x' as const, destParams: '0x' as const }, split: 1, splitParams: '0x' as const };
  expect(feeChoiceV2(side)).toBe('pile');
  expect(feeChoiceV2({ ...side, a: { ...side.a, leg: 2 } })).toBe(null);
});

import { encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';
import { m3Fixture } from '../../src/core/v2/m3-fixture.test-support';
import { m3WiringProblem } from '../../src/core/v2/m3-provenance-v2';
it('PF23 rejects spoofed pile destinations and nonconsecutive cumulative receipts', () => {
  const e = event(5n, 5n);
  expect(boxViewV2([{ ...e, args: { ...e.args, pile: zeroAddress } }], ctx)).toHaveProperty('pileMovedP', 0n);
  for (const bad of [event(5n, 4n), event(0n, 0n), event(-1n, -1n)]) expect(() => boxViewV2([bad], ctx)).toThrow(/cumulative/);
});
it('PF24 verifies appended receiver and vault arguments including immutable preset and P identity', () => {
  const f = m3Fixture(true);
  const code = new Map(f.code);
  const spec = { ...f.spec, contentsParams: encodeAbiParameters(parseAbiParameters('address,uint256,uint16'), [f.record.q, 2n ** 120n + 7n, 500]),
    buyers: { ...f.spec.buyers, a: { leg: 1, dest: 7, legParams: '0x' as Hex, destParams: '0x' as Hex } } };
  const rc = f.at(5).toLowerCase(), pile = f.at(3).toLowerCase();
  const oldRc = code.get(rc) as Hex, oldPile = code.get(pile) as Hex;
  code.set(rc, `${oldRc}00000000${pile.slice(2)}`);
  code.set(pile, `${oldPile}01f4`);
  const read = (a: Address) => code.get(a.toLowerCase()) as Hex;
  expect(m3WiringProblem(f.record, spec, read)).toBeNull();
  code.set(rc, `${oldRc}00000000${zeroAddress.slice(2)}`);
  expect(m3WiringProblem(f.record, spec, read)).toMatch(/receiver/);
  code.set(rc, `${oldRc}00000000${pile.slice(2)}`);
  code.set(pile, `${oldPile}0000`);
  expect(m3WiringProblem(f.record, spec, read)).toMatch(/pile/);
});

import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { receiverPileV21Abi } from '../../src/core/v2/chain-v2';
import { m2Fixture, H } from '../../src/core/v2/m2-fixture.test-support';
import { applyV2Block, liveViewV2 } from '../../src/core/v2/views-v2';
import { readMoneyV2, compareMoneyV2 } from '../../src/core/v2/money-v2';
import { serviceChainV2 } from './scripted-core-chain';
import { jsonV2 } from '../../src/core/core-row';
it('PF26 audits pending claims, cumulative receipts and custody without rejecting redeemed donations', async () => {
  const f = m2Fixture(false);
  const n = (1n << 140n) + 17n;
  const base = serviceChainV2({ headers: [], logs: [] }, [f]);
  const state = applyV2Block(undefined, { number: 100n, hash: H(100), parentHash: H(99), timestamp: 1000n }, [], f.row).state;
  const view = { ...state.view, choices: { buyers: 'pile' as const, sellers: 'burn' as const }, pileMovedP: n };
  const reads: string[] = [];
  const reader = { async callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> {
    expect(hash).toBe(H(100));
    if (to.toLowerCase() === f.at(5).toLowerCase()) {
      let fn: 'pilePendingP' | 'pileMovedP' | undefined;
      try { fn = decodeFunctionData({ abi: receiverPileV21Abi, data }).functionName as typeof fn; } catch { /* old receiver read */ }
      if (fn) {
        reads.push(fn);
        return encodeFunctionResult({ abi: receiverPileV21Abi, functionName: fn, result: n });
      }
    }
    return base.callAt(to, data, hash);
  } };
  const money = await readMoneyV2(reader, f.row, view, 100n, H(100));
  expect(reads.sort()).toEqual(['pileMovedP', 'pilePendingP']);
  expect(money.pileFees).toEqual({ pendingP: n, movedP: n });
  expect(compareMoneyV2({ ...state, view }, money).mismatches).toContain('receiver ledgers and two carries do not reconcile to bookedP');
  expect(compareMoneyV2({ ...state, view: { ...view, pileMovedP: n - 1n } }, money).mismatches.some(x => x.startsWith('receiver.pileMovedP:'))).toBe(true);
  expect(jsonV2(liveViewV2({ ...state, view, money }, 1000n))).toMatchObject({ pileMovedP: n.toString(), money: { pileFees: { pendingP: n.toString(), movedP: n.toString() } } });
  const pile = { asset: zeroAddress, seeder: receiver, seedAmount: 100n, leaveBehindBps: 500n,
    seedLoaded: true, loadedAmount: 100n, seedReturned: false, returnedAmount: 0n, graduated: true, failed: false, redeemedT: 1n, redeemedAsset: 0n };
  const livePile = { ...pile, balance: 110n, balanceStatus: 'verified' as const, supply: 1000n,
    seedReceived: true, seedReturnDue: 0n, seedReturnBacked: true, redemptionOpen: true };
  const audited = { ...money, m3: { hash: H(100), itemBalanceP: null, pile: livePile } };
  const check = (redeemedAsset: bigint, balance: bigint) => compareMoneyV2({ ...state, view: { ...view, pileMovedP: 10n, m3: { items: null, pile: { ...pile, redeemedAsset } } } },
    { ...audited, m3: { ...audited.m3, pile: { ...livePile, balance } } }).mismatches.filter(x => x.startsWith('pile seed'));
  expect(check(0n, 110n)).toEqual([]);
  expect(check(0n, 109n)).toHaveLength(1);
  expect(check(120n, 0n)).toEqual([]); // Ten donated coins also left through redemption.
});
