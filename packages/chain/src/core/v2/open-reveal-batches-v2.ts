/**
 * SH-199. Browser-safe, offline open reveals from a final BoxSpec or saved open reveal copy. No RPC, wallet,
 * sending, uploads, salt generation or settings import. The caller supplies the collection's on-chain root and
 * freshly read revealed IDs, verifies chain/collection provenance, and estimates the actual batch before sending.
 * Hidden-mode openDraw is out of scope: it must stay direct and sequential because msg.sender controls rights.
 *
 * parseOpenRevealFileV2 streams a Blob or byte iterable and discards embedded assets. checkOpenRevealFileV2 accepts
 * an already parsed copy. Both own their checked data. Iterate planOpenRevealBatchesV2 to retain only one batch's
 * calldata at a time. A 10,000-item list is accepted even above the CLI publisher's 1 MiB raw-IPFS block limit;
 * this module does not publish lists or assert that those large lists can be hosted as a single raw block.
 */
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { boxLeaf, verifyBoxProof } from '@squarehole/domain/box-commitment';
import { boxCollectionAbi } from '../../abi/boxCollection';
import { foldReveals, MAX_PER_BATCH, multicall3Abi, type RevealBatch, type RevealCall } from './reveal-batch-calls-v2';
import { checkReveal } from './reveal-check';
import { readOpenRevealJsonV2, type OpenRevealReadLimitsV2, type OpenRevealSourceV2 } from './open-reveal-json-v2';
import { validateOpenBoxSpecV2, type OpenRevealCommitmentV2 } from './open-reveal-spec-v2';

export type { OpenRevealCommitmentV2, OpenRevealReadLimitsV2, OpenRevealSourceV2, RevealBatch };

/**
 * docs/evidence/SH-RENT-FREE-SEPOLIA.md: single estimate 384,842; measured 40-call batches up to 14,107,115.
 * Use the higher single-item estimate for each slot: default 15,393,680 for 40. This is a planning allowance,
 * not an RPC estimate or guarantee. More complex items/state can need a smaller batch after estimation.
 */
export const OPEN_REVEAL_GAS_PER_ITEM = 384_842n;
export const DEFAULT_OPEN_REVEAL_GAS_BUDGET = OPEN_REVEAL_GAS_PER_ITEM * 40n;

export interface CheckedOpenRevealFileV2 {
  readonly root: Hex;
  readonly size: bigint;
  readonly firstId: bigint;
  readonly specHash: Hex;
  readonly revealListId: Hex;
}
const checkedFiles = new WeakMap<CheckedOpenRevealFileV2, ReturnType<typeof validateOpenBoxSpecV2>>();

/** Root is mandatory, even for a self-consistent file. No caller-owned input is changed. */
export function checkOpenRevealFileV2(input: unknown, commitment: OpenRevealCommitmentV2): CheckedOpenRevealFileV2 {
  checkReveal(commitment && /^0x[0-9a-fA-F]{64}$/.test(commitment.root), 'on-chain revealRoot required');
  const data = validateOpenBoxSpecV2(input, { commitment });
  const handle = Object.freeze({ root: data.spec.revealRoot, size: BigInt(data.spec.n), firstId: data.spec.firstId,
    specHash: data.specHash, revealListId: data.spec.revealListId });
  checkedFiles.set(handle, data);
  return handle;
}

export async function parseOpenRevealFileV2(source: OpenRevealSourceV2, commitment: OpenRevealCommitmentV2, limits?: OpenRevealReadLimitsV2): Promise<CheckedOpenRevealFileV2> {
  return checkOpenRevealFileV2(await readOpenRevealJsonV2(source, limits), commitment);
}

export function openRevealBatchSizeV2(gasBudget = DEFAULT_OPEN_REVEAL_GAS_BUDGET): number {
  checkReveal(typeof gasBudget === 'bigint' && gasBudget >= OPEN_REVEAL_GAS_PER_ITEM, 'gas budget cannot fit one reveal');
  let count = 1;
  while (count < MAX_PER_BATCH && BigInt(count + 1) * OPEN_REVEAL_GAS_PER_ITEM <= gasBudget) count++;
  return count;
}

function encodeBatch(calls: readonly RevealCall[], perBatch: number, index: number): RevealBatch {
  const batch = foldReveals(calls, perBatch)[0];
  checkReveal(batch, 'empty reveal batch');
  return { ...batch, index };
}

/** Ascending missing IDs only. All inner calls allowFailure; every outer call has zero ETH value. */
export function* planOpenRevealBatchesV2(file: CheckedOpenRevealFileV2, options: {
  readonly collection: Address;
  readonly revealed?: ReadonlySet<bigint>;
  readonly gasBudget?: bigint;
}): Generator<RevealBatch> {
  const data = checkedFiles.get(file);
  checkReveal(data, 'a checked open reveal file is required');
  checkReveal(isAddress(options.collection) && options.collection.toLowerCase() !== zeroAddress, 'invalid collection address');
  const collection = getAddress(options.collection);
  const perBatch = openRevealBatchSizeV2(options.gasBudget);
  const revealed = new Set(options.revealed);
  for (const id of revealed) checkReveal(typeof id === 'bigint' && id >= file.firstId && id < file.firstId + file.size, 'revealed id outside collection');
  let calls: RevealCall[] = [];
  let index = 0;
  for (const [offset, item] of data.list.items.entries()) {
    const id = BigInt(item.id);
    if (revealed.has(id)) continue;
    const traitsPacked = BigInt(item.traitsPacked);
    const proof = data.tree.proof(offset + 1);
    checkReveal(verifyBoxProof(offset + 1, boxLeaf({ ...item, id: offset + 1, traitsPacked }, data.spec.n), proof, file.root, data.spec.n), 'invalid reveal proof for root');
    calls.push({ id: item.id, to: collection, value: '0', data: encodeFunctionData({ abi: boxCollectionAbi, functionName: 'reveal',
      args: [id, traitsPacked, item.imageSha256, item.avatarSha256, item.modelSha256, item.salt, proof] }) });
    if (calls.length === perBatch) {
      yield encodeBatch(calls, perBatch, ++index);
      calls = [];
    }
  }
  if (calls.length) yield encodeBatch(calls, perBatch, index + 1);
}

export interface OpenRevealOutcomeV2 {
  readonly succeeded: readonly string[];
  readonly failed: readonly string[];
  readonly unknown: readonly string[];
}
type InnerResult = { readonly success: boolean; readonly returnData: Hex };

/**
 * Interpret aggregate3 execution results (decoded or ABI-encoded), preserving their positional ID mapping.
 * Ordinary transaction receipts do not contain return values. Do not pass simulation results as mined evidence;
 * use readOpenRevealReceiptV2 for actual receipts. Outer success without results leaves every item unknown.
 */
export function readOpenRevealResultsV2(batch: RevealBatch, status: 'success' | 'reverted', results?: readonly InnerResult[] | Hex): OpenRevealOutcomeV2 {
  checkReveal(status === 'success' || status === 'reverted', 'invalid receipt status');
  if (status === 'reverted') return { succeeded: [], failed: [...batch.ids], unknown: [] };
  if (results === undefined) return { succeeded: [], failed: [], unknown: [...batch.ids] };
  const decoded = typeof results === 'string' ? decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: results }) : results;
  checkReveal(decoded.length === batch.ids.length, 'inner result count differs from batch');
  const succeeded: string[] = [], failed: string[] = [];
  decoded.forEach((result, i) => {
    checkReveal(typeof result.success === 'boolean' && /^0x(?:[0-9a-fA-F]{2})*$/.test(result.returnData), 'invalid inner result');
    const id = batch.ids[i];
    checkReveal(id !== undefined, 'missing batch id');
    (result.success ? succeeded : failed).push(id);
  });
  return { succeeded, failed, unknown: [] };
}

/**
 * A complete canonical receipt emits Revealed for each successful inner reveal. Match collection, ID, packed
 * traits and all three hashes to the planned calls. Caller binds the receipt to this batch's transaction and
 * handles finality/reorgs. A failed inner call has no matching log; an outer revert rolls every item back.
 */
export function readOpenRevealReceiptV2(batch: RevealBatch, receipt: {
  readonly status: 'success' | 'reverted';
  readonly logs: readonly { readonly address: Address; readonly data: Hex; readonly topics: readonly Hex[] }[];
}): OpenRevealOutcomeV2 {
  checkReveal(receipt.status === 'success' || receipt.status === 'reverted', 'invalid receipt status');
  if (receipt.status === 'reverted') return readOpenRevealResultsV2(batch, 'reverted');
  const inner = decodeFunctionData({ abi: multicall3Abi, data: batch.data }).args[0];
  checkReveal(inner.length === batch.ids.length, 'inner call count differs from batch');
  const events = receipt.logs.flatMap(log => {
    try {
      const event = decodeEventLog({ abi: boxCollectionAbi, eventName: 'Revealed', data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return [{ address: log.address.toLowerCase(), ...event.args }];
    } catch { return []; } // Other events in a receipt are normal.
  });
  return readOpenRevealResultsV2(batch, 'success', inner.map((call, index) => {
    const decoded = decodeFunctionData({ abi: boxCollectionAbi, data: call.callData });
    checkReveal(decoded.functionName === 'reveal' && decoded.args[0].toString() === batch.ids[index], 'batch id differs from reveal calldata');
    const [id, traitsPacked, imageHash, avatarHash, modelHash] = decoded.args;
    return { returnData: '0x', success: events.some(event => event.address === call.target.toLowerCase() && event.id === id
      && event.traitsPacked === traitsPacked && event.imageHash === imageHash && event.avatarHash === avatarHash && event.modelHash === modelHash) };
  }));
}
