/**
 * SH-V21-07-08 merge: the receiver books a ShopT side's waiting P in its sellers pending slot, so the money audit must
 * count that slot once, whether the read came from the shop (choice 11) or from a module side (choice 10). The
 * amounts in the first case are the local Junkyard life's own block-583 reads, which the examples suite refuted.
 */
import { expect, it } from 'vitest';
import { zeroAddress, type Address } from 'viem';
import { compareMoneyV2, type MoneyV2 } from '../../src/core/v2/money-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';
import { H, m2Fixture } from '../../src/core/v2/m2-fixture.test-support';

const RECONCILE = 'receiver ledgers and two carries do not reconcile to bookedP';
const f = m2Fixture(false);
const state = applyV2Block(undefined, { number: 100n, hash: H(100), parentHash: H(99), timestamp: 1000n }, [], f.row).state;
const owed = { fitOwed: 2698220563492812n, platformOwed: 1349110281746406n, poolHeldP: 2698220563492812n, growHeldP: 0n,
  creatorP: 0n, buyBackP: 0n, itemsHeldP: 0n, royaltyHeldP: 0n, tBurnPending: 0n };
const ledgerSum = Object.entries(owed).filter(([k]) => k !== 'tBurnPending').reduce((s, [, v]) => s + v, 0n);
const shopPendingP = 566325909964100n;
const side = (pendingP: bigint) => ({ module: zeroAddress as Address, codeHash: H(0), pendingP });
const money = (booked: bigint, extra: Partial<MoneyV2>): MoneyV2 => ({ block: 100n, hash: H(100), owed,
  safes: { fit: zeroAddress, platform: zeroAddress }, claim: { pot: 0n, tLeft: 0n, creatorEntitlement: 0n, inboxP: null },
  values: { 'receiver.bookedP': String(booked), 'receiver.balanceP': String(booked) }, ...extra });
const shopFees = { pendingP: shopPendingP, budgetT: 10n ** 21n, ceilingT: 2n * 10n ** 21n, feesT: 0n, feesWanted: true };
const refuted = (m: MoneyV2) => compareMoneyV2(state, m).mismatches.includes(RECONCILE);

it('counts a ShopT side pending P in the booked reconciliation (the Junkyard block-583 reads)', () => {
  expect(ledgerSum + shopPendingP).toBe(7311877318696130n);
  expect(refuted(money(ledgerSum + shopPendingP, { shopFees }))).toBe(false);
  expect(refuted(money(ledgerSum + shopPendingP + 29n, { shopFees }))).toBe(true);
  expect(refuted(money(ledgerSum + shopPendingP - 1n, { shopFees }))).toBe(true);
});

it('counts the sellers pending slot once when a buyers module side and a sellers ShopT side read it both', () => {
  const both = { shopFees, modules: { buyers: side(7n), sellers: side(shopPendingP) } };
  expect(refuted(money(ledgerSum + 7n + shopPendingP, both))).toBe(false);
  expect(refuted(money(ledgerSum + 7n, both))).toBe(true);
  // A module-only box keeps both of its module slots.
  expect(refuted(money(ledgerSum + 7n + 11n, { modules: { buyers: side(7n), sellers: side(11n) } }))).toBe(false);
});
