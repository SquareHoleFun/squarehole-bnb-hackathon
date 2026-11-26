import { decodeErrorResult } from 'viem';
import { smallerBatch } from '@squarehole/box-spec';
import { setVaultV2Abi } from '../abi-set-v2';
import { revertDataOf } from '../../../write/revert';
import { EIP7825_TX_GAS_CAP } from '../../../write/chains';
function transferGas(error: unknown): boolean {
  const data = revertDataOf(error);
  if (!data) return false;
  try { return decodeErrorResult({abi:setVaultV2Abi,data}).errorName === 'TransferGas'; } catch { return false; }
}
/** make must rebuild the call (load suffix / fresh conversion quote and limits) for each smaller batch. */
export async function estimateWithBackoff<T>(size: number, make: (size: number) => T | Promise<T>, estimate: (call: T) => Promise<bigint>) {
  smallerBatch(size); // validates even when no retry is needed
  for (;;) {
    const call = await make(size);
    try {
      const gasEstimate = await estimate(call);
      if (gasEstimate <= 0n) throw new RangeError('invalid estimate');
      const gasLimit = (gasEstimate * 6n + 4n) / 5n;
      if (gasLimit <= EIP7825_TX_GAS_CAP) return {size,call,gasEstimate,gasLimit};
      if (size === 1) throw new RangeError('set transaction margin exceeds cap');
    } catch (error) { if (!transferGas(error) || size === 1) throw error; }
    size = smallerBatch(size);
  }
}
