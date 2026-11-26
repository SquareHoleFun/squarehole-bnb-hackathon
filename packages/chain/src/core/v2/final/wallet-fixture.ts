/** Transport/history double only. Production decoder, projection, readers and pagination run unchanged. */
import { decodeFunctionData, encodeFunctionResult, erc20Abi, parseAbiItem, type Abi, type Address, type Hex } from 'viem';
import { expect } from 'vitest';
import { boxCollectionAbi, poolManagerAbi } from '../../../abi';
import { coordinatorV2Abi, holderLedgerV2Abi, hookV2Abi, itemLedgerV2Abi, receiverV2Abi, receiverItemsV2Abi, vaultItemsV2Abi } from '../abi-v2';
import { m2Fixture, A, B, H, logM2 } from '../../../../../indexer/src/core/v2/m2-fixture.test-support';
import { m3Fixture } from '../../../../../indexer/src/core/v2/m3-fixture.test-support';
import { decodeV2Logs, routeV2 } from '../../../../../indexer/src/core/v2/events-v2';
import { applyV2Block, type LiveStateV2 } from '../../../../../indexer/src/core/v2/views-v2';
import { WalletClaimsIndexV2 } from '../../../../../indexer/src/core/v2/claims-index-v2';
import type { ClaimsReaderV2 } from '../../../../../indexer/src/core/v2/claims-reads-v2';
export { A, B, H };
export const HUGE = 2n ** 120n + 7n;
export const ITEM_CAP = (1n << 127n) - 1n;
const abis: readonly Abi[] = [erc20Abi, boxCollectionAbi, poolManagerAbi, coordinatorV2Abi, holderLedgerV2Abi,
  hookV2Abi, itemLedgerV2Abi, receiverV2Abi, receiverItemsV2Abi, vaultItemsV2Abi];
const funded = parseAbiItem('event HolderBatchFunded(uint256 indexed batchId,uint256 netP)');
const settled = parseAbiItem('event BatchSettled(uint256 indexed batchId,uint256 fundingP,uint256 holderP,uint256 residueP)');
const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');

export function walletFixture(batchCount = 17, itemCount = 70) {
  const holder = m2Fixture(false), item = m3Fixture();
  const itemRow = { ...item.row, spec: { ...item.row.spec, n: 100 } };
  const block = { number: 100n, hash: H(100), parentHash: H(99), timestamp: 1_800_000_000n };
  const holderLogs = Array.from({ length: batchCount }, (_, i) => [
    logM2(funded, holder.at(5), { batchId: BigInt(i + 1), netP: HUGE }, i * 2, block.number, block.hash),
    logM2(settled, holder.at(17), { batchId: BigInt(i + 1), fundingP: HUGE, holderP: HUGE, residueP: 0n }, i * 2 + 1, block.number, block.hash),
  ]).flat();
  const itemLogs = Array.from({ length: itemCount }, (_, i) => logM2(transfer, item.at(4), { from: item.at(3), to: A, tokenId: BigInt(i + 1) }, i, block.number, block.hash));
  const holderState = applyV2Block(undefined, block, decodeV2Logs(holderLogs, routeV2(holder.release, holder.manifest, [], [holder.record])), holder.row).state;
  const itemState = applyV2Block(undefined, block, decodeV2Logs(itemLogs, routeV2(item.release, item.manifest, [], [item.record])), itemRow).state;
  const entries = new Map([
    ['holder', { row: holder.row, states: [holderState] as LiveStateV2[], verified: true, repairing: false }],
    ['item', { row: itemRow, states: [itemState] as LiveStateV2[], verified: true, repairing: false }],
  ]);
  const answers = new Map<string, unknown>();
  const set = (to: Address, fn: string, value: unknown) => answers.set(`${to.toLowerCase()}:${fn}`, value);
  for (const f of [holder, item]) {
    set(f.at(0), 'graduated', true); set(f.at(0), 'failed', false); set(f.at(5), 'creatorPayee', B);
  }
  set(holder.at(2), 'tradeBatch', { tradeUnits: 1n, protocolUnits: 0n, netP: HUGE, closed: true });
  set(holder.at(5), 'holderBatchClosed', true); set(holder.at(5), 'holderBatchPaid', HUGE);
  set(holder.at(17), 'batchState', [true, 1n, 1n, 0n]); set(holder.at(17), 'claimable', HUGE);
  set(item.at(5), 'itemFundingCount', 1n); set(item.at(3), 'itemLifecycleCount', 1n);
  set(item.at(16), 'fundingCursor', 1n); set(item.at(16), 'lifecycleCursor', 1n);
  set(item.at(16), 'itemCredit', [ITEM_CAP, 7n]); set(item.at(4), 'ownerOf', A);
  set(item.row.poolManager, 'balanceOf', (ITEM_CAP + 7n) * BigInt(itemCount));
  let canonicalHash = block.hash;
  let creatorNext = 0n;
  const simulations: { from: Address; to: Address; fn: string; args: readonly unknown[] }[] = [];
  const reader: ClaimsReaderV2 = {
    headerByNumber: async n => ({ ...block, number: n, hash: canonicalHash }),
    callAt: async (to, data, hash) => {
      expect(hash).toBe(block.hash);
      for (const abi of abis) {
        let decoded;
        try { decoded = decodeFunctionData({ abi, data }); } catch { continue; }
        const value = answers.get(`${to.toLowerCase()}:${decoded.functionName}`);
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`unscripted ${to}:${decoded.functionName}`);
        return encodeFunctionResult({ abi, functionName: decoded.functionName, result: value });
      }
      throw new Error('unknown read selector');
    },
    callFromAt: async (from, to, data, hash) => {
      expect(hash).toBe(block.hash); expect(from.toLowerCase()).toBe(A.toLowerCase());
      const abi: Abi = to.toLowerCase() === holder.at(17).toLowerCase() ? holderLedgerV2Abi
        : to.toLowerCase() === item.at(16).toLowerCase() ? itemLedgerV2Abi : receiverV2Abi;
      const decoded = decodeFunctionData({ abi, data });
      simulations.push({ from, to, fn: decoded.functionName, args: decoded.args ?? [] });
      const result = decoded.functionName === 'claimCreator' ? creatorNext : to.toLowerCase() === holder.at(17).toLowerCase() ? HUGE : ITEM_CAP;
      return encodeFunctionResult({ abi, functionName: decoded.functionName, result });
    },
  };
  const source = { chainId: holder.row.chainId, boxesV2: entries, head: () => block, hashAt: () => canonicalHash };
  const index = new WalletClaimsIndexV2(source, reader);
  return { holder, item, itemRow, block, entries, reader, index, source, set, simulations,
    reorg: (hash: Hex) => { canonicalHash = hash; }, creatorNext: (amount: bigint) => { creatorNext = amount; } };
}
