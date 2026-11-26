/**
 * Direct reads of core v1 (S10a § 5; C19: the site without the indexer): rows from `recordOf(id)` and each box's
 * `BoxSpec` log at its creation block, through the same decoder as the logs; a box's views at ONE block; a wallet's
 * holdings. Against a fake transport that answers calls from a table.
 */
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { boxCollectionAbi } from '../abi/boxCollection';
import { boxCoordinatorAbi } from '../abi/boxCoordinator';
import { boxHookAbi } from '../abi/boxHook';
import { boxItemStreamAbi } from '../abi/boxItemStream';
import { boxReceiverAbi } from '../abi/boxReceiver';
import { boxRegistryAbi } from '../abi/boxRegistry';
import { boxTicketsAbi } from '../abi/boxTickets';
import { boxTokenAbi } from '../abi/boxToken';
import { boxVaultAbi } from '../abi/boxVault';
import { poolManagerAbi } from '../abi/poolManager';
import { poolStateSlot } from '../reads/reader';
import { boxRowFromRecord, type BoxRow } from './box-row';
import { readCoreBox, readCoreWallet, readRegistryRows } from './core-reads';
import { labelAddress, labelHash, registryLogs, syntheticBox } from './test-support';

const REGISTRY = labelAddress('direct:registry');
const box = syntheticBox({ creationBlock: 500n });
const row: BoxRow = boxRowFromRecord(box.record, box.encodedSpec, { chainId: 11_155_111, registry: REGISTRY, box0Registry: REGISTRY });
const ALICE = labelAddress('alice');
const SQRT = 79_228_162_514_264_337_593_543_950_336n * 3n;

/** Every view answer, by contract and function name. */
function answers(): Map<string, unknown> {
  const c = row.contracts;
  const slot0 = SQRT | (BigInt.asUintN(24, BigInt(-1234)) << 160n);
  return new Map<string, unknown>([
    [`${REGISTRY}:boxCount`, 1n],
    [`${REGISTRY}:recordOf`, box.record],
    [`${c.hook}:phase`, 3],
    [`${c.hook}:closedAtBlock`, 0n],
    [`${c.hook}:migratedAtBlock`, 0n],
    [`${c.hook}:graduatedLayout`, [0n, 0n, 0n]],
    [`${c.hook}:pairedLiquidity`, 0n],
    [`${c.hook}:depthBudget`, [0n, 0n]],
    [`${row.poolManager}:extsload:${poolStateSlot(row.poolId)}`, `0x${slot0.toString(16).padStart(64, '0')}`],
    [`${row.poolManager}:extsload:other`, `0x${(77n).toString(16).padStart(64, '0')}`],
    [`${c.token}:totalSupply`, 999n * 10n ** 24n],
    [`${c.token}:totalBurned`, 10n ** 24n],
    [`${c.coordinator}:poolShare`, 5n * 10n ** 26n],
    [`${c.coordinator}:graduatedAt`, 0n],
    [`${c.receiver}:depthHeld`, [12n, 34n]],
    [`${c.receiver}:platformEpoch`, [0n, 0n, 32n * 10n ** 18n]],
    [`${c.receiver}:totals`, [11n, 2n, 2n, 2n, 13n, 0n, 0n]],
    [`${c.receiver}:platformHeld`, 4n],
    [`${c.receiver}:tBurnPending`, 6n],
    [`${c.vault}:escrowPrincipal`, 100n],
    [`${c.vault}:inside`, 4268n],
    [`${c.vault}:hiddenCount`, 4268n],
    [`${c.vault}:pendingTickets`, 1n],
    [`${c.vault}:outside`, 1n],
    [`${c.vault}:gateOpen`, false],
    [`${c.itemStream}:started`, false],
    [`${c.itemStream}:index`, 0n],
    [`${c.itemStream}:outsideCount`, 1n],
    [`${c.itemStream}:totals`, [0n, 0n]],
    [`${c.tickets}:status`, { minted: 1, slots: 1, wordRequestedAt: 0, wordAcceptedAt: 0, terminalAt: 0, drawsRequested: 0, drawsSettled: 0 }],
    [`${c.token}:balanceOf`, 5n * 10n ** 21n],
    [`${c.tickets}:balanceOf`, 1n],
    [`${c.collection}:balanceOf`, 0n],
    [`${c.itemStream}:owedOf`, 0n],
  ]);
}

const ABIS: Abi[] = [boxRegistryAbi, boxHookAbi, poolManagerAbi, boxTokenAbi, boxCoordinatorAbi, boxReceiverAbi, boxVaultAbi, boxItemStreamAbi, boxTicketsAbi, boxCollectionAbi] as unknown as Abi[];

function client(blockNumbers: bigint[] = []) {
  const table = answers();
  const [created, spec] = registryLogs(box, { registry: REGISTRY, blockNumber: 500n, blockHash: labelHash('b500') });
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method === 'eth_chainId') return '0xaa36a7';
        if (method === 'eth_blockNumber') return '0x3e8';
        if (method === 'eth_getBlockByNumber') return { number: '0x3e8', hash: labelHash('b1000'), parentHash: labelHash('b999'), timestamp: '0x64', transactions: [], logsBloom: `0x${'0'.repeat(512)}` };
        if (method === 'eth_getLogs') {
          const filter = params[0] as { topics: Hex[] };
          return [created, spec]
            .filter((l) => l.topics[0] === filter.topics[0])
            .map((l) => ({ ...l, blockNumber: '0x1f4', logIndex: `0x${l.logIndex.toString(16)}`, transactionIndex: '0x0', removed: false }));
        }
        if (method === 'eth_call') {
          const [call, tag] = params as [{ to: Address; data: Hex }, Hex];
          blockNumbers.push(BigInt(tag));
          for (const abi of ABIS) {
            try {
              const { functionName, args } = decodeFunctionData({ abi, data: call.data });
              const key = functionName === 'extsload' ? `${call.to}:extsload:${args?.[0] === poolStateSlot(row.poolId) ? args?.[0] : 'other'}` : `${call.to}:${functionName}`;
              if (!table.has(key)) continue;
              return encodeFunctionResult({ abi, functionName, result: table.get(key) } as never);
            } catch {
              // another ABI
            }
          }
          throw new Error(`no answer for ${call.to} ${call.data.slice(0, 10)}`);
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
}

describe('direct reads (no indexer)', () => {
  it('BC-086: rows from recordOf and the BoxSpec log of the creation block, through the same decoder (no indexer)', async () => {
    const { rows, refused } = await readRegistryRows(client(), REGISTRY, { chainId: 11_155_111, box0Registry: REGISTRY });
    expect(refused).toEqual([]);
    expect(rows).toEqual([{ ...row, origin: null }]);
  });

  it('a box\'s views at ONE block', async () => {
    const blocks: bigint[] = [];
    const reads = await readCoreBox(client(blocks), row);
    expect(new Set(blocks)).toEqual(new Set([1000n]));
    expect(reads.phase).toBe(3);
    expect(reads.sqrtPriceX96).toBe(SQRT);
    expect(reads.tick).toBe(-1234);
    expect(reads.liquidity).toBe(77n);
    expect(reads.totalSupply).toBe(999n * 10n ** 24n);
    expect(reads.receiver.totals).toEqual({ toFit: 11n, toPlatform: 2n, qToDepth: 2n, tToDepth: 2n, tBurned: 13n });
    // What no total carries: box 0's platform share held until graduation, a refused burn waiting, the stream's T.
    expect([reads.receiver.platformHeld, reads.receiver.tBurnPending]).toEqual([4n, 6n]);
    expect(reads.stream?.heldT).toBe(5n * 10n ** 21n);
    expect(reads.vault?.inside).toBe(4268n);
    expect(reads.stream?.outsideCount).toBe(1n);
    expect(reads.tickets).toEqual({ minted: 1n, wordRequested: false, wordStored: false, terminal: false, drawsRequested: 0n, drawsSettled: 0n });
  });

  it('a wallet\'s holdings of one box at a block', async () => {
    expect(await readCoreWallet(client(), row, ALICE, 1000n)).toEqual({ t: 5n * 10n ** 21n, tickets: 1n, items: 0n, streamOwed: 0n });
  });
});
