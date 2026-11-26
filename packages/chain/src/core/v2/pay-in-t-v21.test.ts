import { expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem';
import { receiverPayInTV21Abi } from './abi-v2';
import { readPayInTStateV21, itemClaimTCallV21 } from './pay-in-t-v21';
import { assertSendableCallV2 } from './write-calls-v2';
const a = (n: string) => `0x${n.padStart(40, '0')}` as Address;
const target = { chainId: 1, token: a('1'), coordinator: a('2'), receiver: a('3'), p: a('4'), itemLedger: a('6') };
it('T23 reads three exact pending amounts at one canonical hash', async () => {
  const hash = `0x${'aa'.repeat(32)}` as Hex; const n = 1n << 140n;
  const reader = { async callAt(to: Address, data: Hex, block: Hex) {
    expect(to).toBe(target.receiver); expect(block).toBe(hash);
    const { functionName } = decodeFunctionData({ abi: receiverPayInTV21Abi, data });
    return encodeFunctionResult({ abi: receiverPayInTV21Abi, functionName, result: functionName === 'rewardsPendingByKind' ? [n, n, n] : functionName === 'rewardsPendingP' ? n * 3n : 7n } as never);
  } };
  expect(await readPayInTStateV21(reader, target.receiver, hash)).toEqual({ pendingP: n * 3n, holdersP: n, buyersItemsP: n, sellersItemsP: n, burnPendingT: 7n });
  await expect(readPayInTStateV21({ callAt: async () => { throw new Error('unavailable'); } }, target.receiver, hash)).rejects.toThrow('unavailable');
});
it('T24 the T item claim builder remains caller-bound and pays no tip or value', () => {
  const call = itemClaimTCallV21(target, 1n, a('5'));
  expect(() => assertSendableCallV2(call, target, a('5'))).not.toThrow();
  expect(() => assertSendableCallV2(call, target, a('7'))).toThrow();
  expect(() => assertSendableCallV2({ ...call, to: target.receiver }, target, a('5'))).toThrow();
  expect(() => assertSendableCallV2({ ...call, value: 1n }, target, a('5'))).toThrow();
});
