/** Pure legacy Multicall3 encoding. No sending or hidden openings. */
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { checkReveal } from './reveal-check';

/** Multicall3: the same address on Sepolia and mainnet (deployed by its keyless transaction). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const multicall3Abi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }',
  'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
/**
 * Measured on a Sepolia copy at its current fork (SH-RENT-FREE-SEPOLIA): one Rent Free reveal estimates 384,842 gas
 * alone and about 352,000 inside a batch (100 estimated 35.2M), so 40 fit under the 16,777,216 a send may carry with
 * room to spare (about 14.1M); 100 do not and revert as a whole.
 */
export const DEFAULT_PER_BATCH = 40;
export const MAX_PER_BATCH = 40;

export interface RevealCall { readonly id: string; readonly to: Address; readonly value: string; readonly data: Hex }
export interface RevealBatch { readonly index: number; readonly to: typeof MULTICALL3; readonly value: '0'; readonly ids: readonly string[]; readonly data: Hex }

/** Folds the calls into aggregate3 batches of at most `perBatch`, in order. */
export function foldReveals(calls: readonly RevealCall[], perBatch = DEFAULT_PER_BATCH): readonly RevealBatch[] {
  checkReveal(Number.isSafeInteger(perBatch) && perBatch >= 1 && perBatch <= MAX_PER_BATCH, `per batch: 1 to ${MAX_PER_BATCH}`);
  const batches: RevealBatch[] = [];
  for (let start = 0; start < calls.length; start += perBatch) {
    const part = calls.slice(start, start + perBatch);
    const data = encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3',
      args: [part.map((call) => ({ target: call.to, allowFailure: true, callData: call.data }))] });
    batches.push({ index: batches.length + 1, to: MULTICALL3, value: '0', ids: part.map((call) => call.id), data });
  }
  return batches;
}
