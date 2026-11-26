import { expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { assertSendableCallV2 } from './write-calls-v2';
const a = (n: string) => `0x${n.padStart(40, '0')}` as Address;
const target = { chainId: 1, token: a('1'), coordinator: a('2'), receiver: a('3'), p: a('4') };
it('EAT12 permissionless eat targets only the recorded receiver with zero value', () => {
  const data = encodeFunctionData({ abi: parseAbi(['function eatPriceCoin() returns (uint256)']), functionName: 'eatPriceCoin' });
  const call = { to: target.receiver, data, value: 0n };
  expect(() => assertSendableCallV2(call, target, a('5'))).not.toThrow();
  expect(() => assertSendableCallV2({ ...call, to: target.p }, target, a('5'))).toThrow();
  expect(() => assertSendableCallV2({ ...call, value: 1n }, target, a('5'))).toThrow();
});

import { encodeFunctionResult, decodeFunctionData, type Hex } from 'viem';
import { readEatStateV21, readCheckedBurnV21, eatLabelV21, eatPriceCoinCallV21 } from './eat-v21';
import { receiverEatV21Abi, listingBurnV21Abi } from './abi-v2';
it('EAT21 reads cumulative and pending amounts at one canonical block and builds the guarded call', async () => {
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  const n = 9007199254740993123456n;
  const reader = { async callAt(to: Address, data: Hex, block: Hex): Promise<Hex> {
    expect(to).toBe(target.receiver); expect(block).toBe(hash);
    const { functionName } = decodeFunctionData({ abi: receiverEatV21Abi, data });
    return encodeFunctionResult({ abi: receiverEatV21Abi, functionName, result: functionName === 'priceBurnSelector' ? '0x42966c68' : n } as never);
  } };
  expect(await readEatStateV21(reader, target.receiver, hash)).toEqual({ pendingP: n, eatenP: n, burnSelector: '0x42966c68' });
  expect(() => assertSendableCallV2(eatPriceCoinCallV21(target), target, a('5'))).not.toThrow();
  expect(eatLabelV21('FIT', '0x42966c68')).toBe('Burn FIT');
  expect(eatLabelV21('ETH', '0x00000000')).toBe('Lock ETH');
  expect(await readCheckedBurnV21({ async callAt(to, data, block) {
    expect(to).toBe(a('6')); expect(block).toBe(hash);
    expect(decodeFunctionData({ abi: listingBurnV21Abi, data }).args).toEqual([target.p]);
    return encodeFunctionResult({ abi: listingBurnV21Abi, functionName: 'checkedBurnSelector', result: '0x00000000' });
  } }, a('6'), target.p, hash)).toBe('0x00000000');
  await expect(readCheckedBurnV21({ callAt: async () => { throw new Error('unavailable'); } }, a('6'), target.p, hash)).rejects.toThrow('unavailable');
});
