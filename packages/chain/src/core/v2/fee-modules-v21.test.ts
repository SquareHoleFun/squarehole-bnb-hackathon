import { expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem';
import { receiverModulesV21Abi } from './abi-v2';
import { readFeeModulesV21 } from './fee-modules-v21';

it('FM18 reads both immutable snapshots and exact pending amounts at one canonical hash', async () => {
  const receiver = `0x${'11'.repeat(20)}` as Address;
  const module = `0x${'22'.repeat(20)}` as Address;
  const hash = `0x${'33'.repeat(32)}` as Hex;
  const codeHash = `0x${'44'.repeat(32)}` as Hex;
  const pending = (1n << 200n) + 123n;
  let reads = 0;
  const value = await readFeeModulesV21({ async callAt(to, data, at) {
    expect(to).toBe(receiver); expect(at).toBe(hash); reads++;
    const call = decodeFunctionData({ abi: receiverModulesV21Abi, data });
    if (call.functionName === 'sideModule') return encodeFunctionResult({ abi: receiverModulesV21Abi, functionName: 'sideModule', result: [module, codeHash] });
    expect(call.functionName).toBe('modulePendingP');
    return encodeFunctionResult({ abi: receiverModulesV21Abi, functionName: 'modulePendingP', result: call.args?.[0] ? pending + 1n : pending });
  } }, receiver, hash);
  expect(reads).toBe(4);
  expect(value).toEqual({ buyers: { module, codeHash, pendingP: pending }, sellers: { module, codeHash, pendingP: pending + 1n } });
  // No executeModule write builder ships in this release; write-builders-v21.test.ts pins the guard's refusal.
});
