import { expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { assertSendableCallV2 } from './write-calls-v2';
const a = (n: string) => `0x${n.padStart(40, '0')}` as Address;
const target = { chainId: 1, token: a('1'), coordinator: a('2'), receiver: a('3'), p: a('4') };
it('PF08 permissionless move targets only the recorded receiver with zero value', () => {
  const data = encodeFunctionData({ abi: parseAbi(['function moveToPile() returns (uint256)']), functionName: 'moveToPile' });
  const call = { to: target.receiver, data, value: 0n };
  expect(() => assertSendableCallV2(call, target, a('5'))).not.toThrow();
  expect(() => assertSendableCallV2({ ...call, to: target.p }, target, a('5'))).toThrow();
  expect(() => assertSendableCallV2({ ...call, value: 1n }, target, a('5'))).toThrow();
});

import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';
import { receiverPileV21Abi } from './abi-v2';
import { readPileFeeStateV21, moveToPileCallV21 } from './pile-fees-v21';
import { pileConfigV2 } from './m3-spec-v2';
it('PF21 reads exact pending and cumulative raw P at the requested block hash', async () => {
  const hash = `0x${'12'.repeat(32)}` as Hex;
  const amount = (1n << 240n) + 1n;
  const reader = { callAt: async (to: Address, data: Hex, at: Hex) => {
    expect(to).toBe(target.receiver); expect(at).toBe(hash);
    const { functionName } = decodeFunctionData({ abi: receiverPileV21Abi, data });
    if (functionName === 'moveToPile') throw new Error('reads cannot move money');
    return encodeFunctionResult({ abi: receiverPileV21Abi, functionName, result: functionName === 'pilePendingP' ? amount : 3n });
  } };
  expect(await readPileFeeStateV21(reader, target.receiver, hash)).toEqual({ pendingP: amount, movedP: 3n });
  expect(() => assertSendableCallV2(moveToPileCallV21(target), target, a('5'))).not.toThrow();
  await expect(readPileFeeStateV21({ callAt: async () => { throw new Error('unavailable'); } }, target.receiver, hash)).rejects.toThrow('unavailable');
});
it('PF22 decodes legacy and extended presets without accepting noncanonical words or tail bytes', () => {
  const encode = (bps: number) => encodeAbiParameters(parseAbiParameters('address,uint256,uint16'), [target.p, 123n, bps]);
  const legacy = encodeAbiParameters(parseAbiParameters('address,uint256'), [target.p, 123n]);
  expect(pileConfigV2(legacy)).toEqual({ asset: target.p, seedAmount: 123n, leaveBehindBps: 0n });
  for (const bps of [0, 500]) expect(pileConfigV2(encode(bps)).leaveBehindBps).toBe(BigInt(bps));
  for (const data of [encode(499), `${legacy}00`, `${encode(500)}00`, '0x']) expect(() => pileConfigV2(data as Hex)).toThrow();
});
