import { expect, it } from 'vitest';
import { encodeFunctionData, type Address } from 'viem';
import { receiverModulesV21Abi } from './abi-v2';
import { assertSendableCallV2 } from './write-calls-v2';
const a = (v: string) => `0x${v.repeat(40)}` as Address;
const target = { chainId: 1, token: a('1'), coordinator: a('2'), receiver: a('3'), p: a('4'), shop: a('5'), holderLedger: a('6'), sellersChoice: 11 };
it('SF-W permits only the prepared sellers shop step, with no value or arbitrary module', () => {
  const call = { to: target.receiver, data: encodeFunctionData({ abi: receiverModulesV21Abi, functionName: 'executeModule', args: [true] }), value: 0n };
  expect(() => assertSendableCallV2(call, target, a('7'))).not.toThrow();
  expect(shopFeesCallV21(target)).toEqual(call);
  // The shop writer builds the ShopT step only: never for a module side (10), an undeclared side or a missing role.
  for (const wrong of [{ ...target, sellersChoice: 10 }, { ...target, sellersChoice: undefined }, { ...target, shop: undefined }, { ...target, holderLedger: undefined }]) {
    expect(() => shopFeesCallV21(wrong)).toThrow();
  }
  for (const wrong of [{ ...target, shop: undefined }, { ...target, holderLedger: undefined }, { ...target, sellersChoice: 4 }]) {
    expect(() => assertSendableCallV2(call, wrong, a('7'))).toThrow();
  }
  expect(() => assertSendableCallV2({ ...call, value: 1n }, target, a('7'))).toThrow();
  // Since step 8 the same entry is also a directory action's (The Alchemist, AL21): the shared guard admits a declared
  // module side (10) and the buyers side, whose choice the target does not declare; the receiver refuses a side without one.
  expect(() => assertSendableCallV2(call, { ...target, sellersChoice: 10 }, a('7'))).not.toThrow();
  expect(() => assertSendableCallV2({ ...call, data: encodeFunctionData({ abi: receiverModulesV21Abi, functionName: 'executeModule', args: [false] }) }, target, a('7'))).not.toThrow();
});

import { readShopFeeStateV21, shopFeesCallV21 } from './shop-fees-v21';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { receiverV2Abi, shopVaultV2Abi } from './abi-v2';
it('SF-W canonical block reads preserve large raw amounts and authenticate choice 11', async () => {
  const hash = `0x${'1'.repeat(64)}` as Hex; const huge = (1n << 200n) + 19n;
  let choice = 11; const reads: string[] = [];
  const reader = { callAt: async (to: Address, data: Hex, at: Hex): Promise<Hex> => {
    expect(at).toBe(hash);
    if (data === encodeFunctionData({ abi: receiverV2Abi, functionName: 'sellersChoice' })) return encodeFunctionResult({ abi: receiverV2Abi, functionName: 'sellersChoice', result: choice });
    if (to === target.receiver) {
      expect(decodeFunctionData({ abi: receiverModulesV21Abi, data }).args).toEqual([true]);
      return encodeFunctionResult({ abi: receiverModulesV21Abi, functionName: 'modulePendingP', result: huge });
    }
    expect(to).toBe(target.shop);
    const fn = decodeFunctionData({ abi: shopVaultV2Abi, data }).functionName; reads.push(fn);
    if (fn === 'feesWanted') return encodeFunctionResult({ abi: shopVaultV2Abi, functionName: fn, result: true });
    if (fn !== 'budgetT' && fn !== 'ceilingT' && fn !== 'feesT') throw new Error('unexpected read');
    return encodeFunctionResult({ abi: shopVaultV2Abi, functionName: fn, result: huge });
  } };
  expect(await readShopFeeStateV21(reader, target.receiver, target.shop, hash)).toEqual({ pendingP: huge, budgetT: huge, ceilingT: huge, feesT: huge, feesWanted: true });
  expect(reads).toHaveLength(4); choice = 10;
  await expect(readShopFeeStateV21(reader, target.receiver, target.shop, hash)).rejects.toThrow('choice');
  expect(reads).toHaveLength(4);
});
