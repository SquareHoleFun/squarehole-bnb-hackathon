/**
 * SH-V21-FIX-KEEPER-INDEX, ACC-V21-L01: every exported write builder uses the shared prepared-role guard. These
 * samples carry zero value; SH-TA-32 additionally tests draw's exact prepared ETH bounty. The generic entry
 * executeModule(bool) has two first-party builders: The Alchemist's directory action
 * (choice 10, executeModuleCallV21, either side, AL21) and the sellers core ShopT step (choice 11, shopFeesCallV21,
 * only for the prepared shop and its holder ledger, SF-W).
 */
import { expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, keccak256, zeroHash, type Address } from 'viem';
import * as v2 from './index';
import { receiverModulesV21Abi } from './abi-v2';
import { assertSendableCallV2, type WriteCallV2, type WriteTargetV2 } from './write-calls-v2';

const a = (n: string) => `0x${n.padStart(40, '0')}` as Address;
const target: WriteTargetV2 = { chainId: 1, token: a('1'), coordinator: a('2'), receiver: a('3'), p: a('4'), itemLedger: a('6'), shop: a('7'), holderLedger: a('8'), sellersChoice: 11, royaltyRouter: a('9'), launchRouter: a('b'), vault: a('c'), collection: a('d'), tickets: a('e'), collectionCaller: a('5'), drawValue: 0n };
const from = a('5');
const reveal = { traitsPacked: 0n, imageHash: zeroHash, avatarHash: zeroHash, modelHash: zeroHash, salt: zeroHash, proof: [] };
// SH-EX-L4: a one-item commitment whose root is the item's own leaf, so checkedRevealCallV2's proof check passes.
const revealRoot = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
  [0n, 0n, zeroHash, zeroHash, zeroHash, zeroHash]));
const tokenApprovalTarget: WriteTargetV2 = { ...target, collectionApproval: { kind: 'token', spender: 'vault', amount: 17n } };
const itemApprovalTarget: WriteTargetV2 = { ...target, collectionApproval: { kind: 'item', id: 0n } };
const approvalTargets: Record<string, WriteTargetV2> = { collectionTokenApprovalCallV2: tokenApprovalTarget, collectionItemApprovalCallV2: itemApprovalTarget };
const builders: Record<string, () => WriteCallV2> = {
  claimRoyaltyInKindCallV21: () => v2.claimRoyaltyInKindCallV21(target, target.token),
  observeRoyaltyCoinCallV21: () => v2.observeRoyaltyCoinCallV21(target, a('a0')),
  refreshRoyaltyOrderCallV21: () => v2.refreshRoyaltyOrderCallV21(target, a('a0')),
  // SH-RC7-SITE-INBOX (KF-5): the launch router's public sweep.
  routerSweepCallV2: () => v2.routerSweepCallV2(target),
  executeModuleCallV21: () => v2.executeModuleCallV21(target, false),
  shopFeesCallV21: () => v2.shopFeesCallV21(target),
  eatPriceCoinCallV21: () => v2.eatPriceCoinCallV21(target),
  moveToPileCallV21: () => v2.moveToPileCallV21(target),
  itemClaimTCallV21: () => v2.itemClaimTCallV21(target, 1n, from),
  withdrawCallV2: () => v2.withdrawCallV2(target, 0n, 17n, 1000n, from),
  withdrawBatchCallV2: () => v2.withdrawBatchCallV2(target, [0n, 1n], 17n, 1000n, from),
  returnItemCallV2: () => v2.returnItemCallV2(target, 0n, 0n, 1000n, from),
  returnItemsCallV2: () => v2.returnItemsCallV2(target, [0n, 1n], 0n, 1000n, from),
  takeCallV2: () => v2.takeCallV2(target, 1n, 17n, 1000n, from),
  handBackCallV2: () => v2.handBackCallV2(target, [1n], 0n, 1000n, from),
  drawCallV2: () => v2.drawCallV2(target, 17n, 1000n, from),
  openCallV2: () => v2.openCallV2(target, 1n, reveal, from),
  openDrawCallV2: () => v2.openDrawCallV2(target, 1n, reveal, from),
  revealCallV2: () => v2.revealCallV2(target, 0n, reveal, from),
  checkedRevealCallV2: () => v2.checkedRevealCallV2(target, 0n, reveal, { root: revealRoot, firstId: 0n, size: 1n }, from),
  collectionTokenApprovalCallV2: () => v2.collectionTokenApprovalCallV2(tokenApprovalTarget, from),
  collectionItemApprovalCallV2: () => v2.collectionItemApprovalCallV2(itemApprovalTarget, from),
};

it('L01 every exported v2 write builder passes the shared guard for its prepared role with zero value', () => {
  const exported = Object.entries(v2).filter(([name, value]) => typeof value === 'function' && /CallV2\d*$/.test(name) && !name.startsWith('assert')).map(([name]) => name);
  expect(exported.sort()).toEqual(Object.keys(builders).sort());
  for (const [name, build] of Object.entries(builders)) {
    const call = build();
    const prepared = approvalTargets[name] ?? target;
    expect(call.value, name).toBe(0n);
    expect(() => assertSendableCallV2(call, prepared, from), name).not.toThrow();
    expect(() => assertSendableCallV2({ ...call, value: 1n }, prepared, from), name).toThrow();
    expect(() => assertSendableCallV2({ ...call, to: target.p }, prepared, from), name).toThrow();
  }
});

it('AL21 the shared guard admits the generic entry used by Alchemist', () => {
  for (const sellers of [false, true]) {
    const call = { to: target.receiver, data: encodeFunctionData({ abi: receiverModulesV21Abi, functionName: 'executeModule', args: [sellers] }), value: 0n };
    // The prepared shop target, a declared module side and a target that declares no choice.
    for (const prepared of [target, { ...target, sellersChoice: 10 }, { ...target, shop: undefined, holderLedger: undefined, sellersChoice: undefined }]) {
      expect(() => assertSendableCallV2(call, prepared, from)).not.toThrow();
    }
  }
});

it('SF-W a declared sellers ShopT side needs its shop and holder ledger, and a sellers side with no step is refused', () => {
  const call = { to: target.receiver, data: encodeFunctionData({ abi: receiverModulesV21Abi, functionName: 'executeModule', args: [true] }), value: 0n };
  for (const missing of [{ ...target, shop: undefined }, { ...target, holderLedger: undefined }]) {
    expect(() => assertSendableCallV2(call, missing, from)).toThrow('only the sellers core shop step');
  }
  for (const sellersChoice of [0, 4, 9]) {
    expect(() => assertSendableCallV2(call, { ...target, sellersChoice }, from)).toThrow('the sellers side has no module or shop step');
  }
  for (const sellersChoice of [10, undefined]) expect(() => v2.shopFeesCallV21({ ...target, sellersChoice })).toThrow('only the sellers core shop step');
});
