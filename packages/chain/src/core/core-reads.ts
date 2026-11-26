/**
 * Direct reads of core v1 for the site when no indexer answers (S10a § 2.2, § 5; C19): rows from the registry
 * (`boxCount`, `recordOf(id)`, and the `BoxSpec` log of each box's creation block, decoded by the same row decoder as the
 * indexer's), and one box's views at ONE block (every call pinned to the same block number). Read-only.
 *
 * What a direct read cannot know (volume, trades, activity: they need the logs of the whole life) is left out; the
 * page says so instead of showing zeros.
 */
import { decodeEventLog, encodeEventTopics, toHex, type Address, type Hex, type PublicClient } from 'viem';
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
import { decodeSlot0, poolStateSlot } from '../reads/reader';
import { BoxRowError, boxRowFromRecord, type BoxRow, type RegistryRecord } from './box-row';

export interface CoreDirectReads {
  readonly block: bigint;
  readonly hash: Hex;
  readonly timestamp: bigint;
  /** IBoxHook.phase(): BoxTypes.BoxPhase (1 upcoming … 5 graduated, 6 failed). */
  readonly phase: number;
  readonly closedAtBlock: bigint;
  readonly migratedAtBlock: bigint;
  readonly layout: { readonly ask: bigint; readonly bid: bigint; readonly sentinel: bigint };
  readonly pairedLiquidity: bigint;
  readonly depthBudget: { readonly q: bigint; readonly t: bigint };
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly totalSupply: bigint;
  readonly totalBurned: bigint;
  readonly poolShare: bigint;
  readonly graduatedAt: bigint;
  readonly receiver: {
    readonly depthHeld: { readonly q: bigint; readonly t: bigint };
    readonly platformEpoch: { readonly epoch: bigint; readonly kept: bigint; readonly remaining: bigint };
    readonly totals: { readonly toFit: bigint; readonly toPlatform: bigint; readonly qToDepth: bigint; readonly tToDepth: bigint; readonly tBurned: bigint };
    /** Box 0's platform share held until graduation (in no total). */
    readonly platformHeld: bigint;
    /** T marked to burn whose burn the vault's floor refused (waiting here; `totals().tBurned` counts real burns). */
    readonly tBurnPending: bigint;
  };
  readonly vault: { readonly escrow: bigint; readonly inside: bigint; readonly hidden: bigint; readonly tickets: bigint; readonly outside: bigint; readonly gateOpen: boolean } | null;
  /** `heldT`: the stream's T balance; held + claimed + burned is all the T it received (the 13/15 after graduation). */
  readonly stream: { readonly started: boolean; readonly index: bigint; readonly outsideCount: bigint; readonly claimed: bigint; readonly burned: bigint; readonly heldT: bigint } | null;
  readonly tickets: { readonly minted: bigint; readonly wordRequested: boolean; readonly wordStored: boolean; readonly terminal: boolean; readonly drawsRequested: bigint; readonly drawsSettled: bigint } | null;
}

type Reader = Pick<PublicClient, 'readContract' | 'getBlock' | 'getBlockNumber' | 'request'>;

const LIQUIDITY_OFFSET = 3n;

/**
 * Rows from the registry without its logs' history: `recordOf(id)` and each box's `BoxSpec` log at its creation block.
 * `known(id)` may hand back a row read before (a row never changes once its creation block is final): it is used as is.
 */
export async function readRegistryRows(
  client: Reader,
  registry: Address,
  options: { readonly chainId: number; readonly box0Registry: Address | null; readonly blockNumber?: bigint; readonly known?: (boxId: bigint, blockNumber: bigint) => BoxRow | null },
): Promise<{ readonly rows: readonly BoxRow[]; readonly refused: readonly { readonly boxId: bigint; readonly reason: string }[]; readonly blockNumber: bigint }> {
  // One block for the count and every record (a box created meanwhile waits for the next read).
  const blockNumber = options.blockNumber ?? (await client.getBlockNumber());
  const count = (await client.readContract({ address: registry, abi: boxRegistryAbi, functionName: 'boxCount', blockNumber })) as bigint;
  const rows: BoxRow[] = [];
  const refused: { boxId: bigint; reason: string }[] = [];
  const specTopic = encodeEventTopics({ abi: boxRegistryAbi, eventName: 'BoxSpec' })[0] as Hex;
  for (let id = 0n; id < count; id += 1n) {
    const cached = options.known?.(id, blockNumber) ?? null;
    if (cached) {
      rows.push(cached);
      continue;
    }
    try {
      const record = (await client.readContract({ address: registry, abi: boxRegistryAbi, functionName: 'recordOf', args: [id], blockNumber })) as unknown as RegistryRecord;
      const at = toHex(record.creationBlock);
      const logs = (await client.request({
        method: 'eth_getLogs',
        params: [{ address: registry, fromBlock: at, toBlock: at, topics: [specTopic, `0x${id.toString(16).padStart(64, '0')}`] }],
      } as never)) as { topics: Hex[]; data: Hex }[];
      const log = logs[0];
      if (!log) throw new BoxRowError('record_without_spec', `box ${id}: no BoxSpec log in its creation block`);
      const decoded = decodeEventLog({ abi: boxRegistryAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      if (decoded.eventName !== 'BoxSpec') throw new BoxRowError('malformed', `box ${id}: not a BoxSpec log`);
      rows.push(boxRowFromRecord({ ...record, contracts: [...record.contracts], codeHashes: [...record.codeHashes] }, decoded.args.encodedSpec, { chainId: options.chainId, box0Registry: options.box0Registry, registry }));
    } catch (error) {
      refused.push({ boxId: id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { rows, refused, blockNumber };
}

/** One box's views, every call at the same block (the latest unless given). */
export async function readCoreBox(client: Reader, row: BoxRow, blockNumber?: bigint): Promise<CoreDirectReads> {
  const block = await client.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  if (block.number === null || block.hash === null) throw new Error('the node returned a pending block');
  const at = { blockNumber: block.number };
  const c = row.contracts;
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, ...at }) as Promise<T>;
  const hook = c.hook as Address;
  const slot = poolStateSlot(row.poolId);
  const liquiditySlot = `0x${(BigInt(slot) + LIQUIDITY_OFFSET).toString(16).padStart(64, '0')}` as Hex;
  const [phase, closedAtBlock, migratedAtBlock, layout, pairedLiquidity, depthBudget, word, liquidityWord, totalSupply, totalBurned, poolShare, graduatedAt, depthHeld, platformEpoch, totals, platformHeld, tBurnPending] = await Promise.all([
    read<number>(hook, boxHookAbi, 'phase'),
    read<bigint>(hook, boxHookAbi, 'closedAtBlock'),
    read<bigint>(hook, boxHookAbi, 'migratedAtBlock'),
    read<readonly [bigint, bigint, bigint]>(hook, boxHookAbi, 'graduatedLayout'),
    read<bigint>(hook, boxHookAbi, 'pairedLiquidity'),
    read<readonly [bigint, bigint]>(hook, boxHookAbi, 'depthBudget'),
    read<Hex>(row.poolManager, poolManagerAbi, 'extsload', [slot]),
    read<Hex>(row.poolManager, poolManagerAbi, 'extsload', [liquiditySlot]),
    read<bigint>(c.token as Address, boxTokenAbi, 'totalSupply'),
    read<bigint>(c.token as Address, boxTokenAbi, 'totalBurned'),
    read<bigint>(c.coordinator as Address, boxCoordinatorAbi, 'poolShare'),
    read<bigint>(c.coordinator as Address, boxCoordinatorAbi, 'graduatedAt'),
    read<readonly [bigint, bigint]>(c.receiver as Address, boxReceiverAbi, 'depthHeld'),
    read<readonly [bigint, bigint, bigint]>(c.receiver as Address, boxReceiverAbi, 'platformEpoch'),
    read<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]>(c.receiver as Address, boxReceiverAbi, 'totals'),
    read<bigint>(c.receiver as Address, boxReceiverAbi, 'platformHeld'),
    read<bigint>(c.receiver as Address, boxReceiverAbi, 'tBurnPending'),
  ]);
  const vault = c.vault
    ? await Promise.all([
        read<bigint>(c.vault, boxVaultAbi, 'escrowPrincipal'),
        read<bigint>(c.vault, boxVaultAbi, 'inside'),
        read<bigint>(c.vault, boxVaultAbi, 'hiddenCount'),
        read<bigint>(c.vault, boxVaultAbi, 'pendingTickets'),
        read<bigint>(c.vault, boxVaultAbi, 'outside'),
        read<boolean>(c.vault, boxVaultAbi, 'gateOpen'),
      ])
    : null;
  const stream = c.itemStream
    ? await Promise.all([
        read<boolean>(c.itemStream, boxItemStreamAbi, 'started'),
        read<bigint>(c.itemStream, boxItemStreamAbi, 'index'),
        read<bigint>(c.itemStream, boxItemStreamAbi, 'outsideCount'),
        read<readonly [bigint, bigint]>(c.itemStream, boxItemStreamAbi, 'totals'),
        read<bigint>(c.token as Address, boxTokenAbi, 'balanceOf', [c.itemStream]),
      ])
    : null;
  const tickets = c.tickets
    ? await read<{ minted: bigint | number; wordRequestedAt: bigint | number; wordAcceptedAt: bigint | number; terminalAt: bigint | number; drawsRequested: bigint | number; drawsSettled: bigint | number }>(c.tickets, boxTicketsAbi, 'status')
    : null;
  const slot0 = decodeSlot0(word);
  return {
    block: block.number,
    hash: block.hash,
    timestamp: block.timestamp,
    phase: Number(phase),
    closedAtBlock,
    migratedAtBlock,
    layout: { ask: layout[0], bid: layout[1], sentinel: layout[2] },
    pairedLiquidity,
    depthBudget: { q: depthBudget[0], t: depthBudget[1] },
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: slot0.tick,
    liquidity: BigInt(liquidityWord) & ((1n << 128n) - 1n),
    totalSupply,
    totalBurned,
    poolShare,
    graduatedAt,
    receiver: {
      depthHeld: { q: depthHeld[0], t: depthHeld[1] },
      platformEpoch: { epoch: platformEpoch[0], kept: platformEpoch[1], remaining: platformEpoch[2] },
      totals: { toFit: totals[0], toPlatform: totals[1], qToDepth: totals[2], tToDepth: totals[3], tBurned: totals[4] },
      platformHeld,
      tBurnPending,
    },
    vault: vault ? { escrow: vault[0], inside: vault[1], hidden: vault[2], tickets: vault[3], outside: vault[4], gateOpen: vault[5] } : null,
    stream: stream ? { started: stream[0], index: stream[1], outsideCount: stream[2], claimed: stream[3][0], burned: stream[3][1], heldT: stream[4] } : null,
    tickets: tickets
      ? {
          minted: BigInt(tickets.minted),
          wordRequested: BigInt(tickets.wordRequestedAt) > 0n,
          wordStored: BigInt(tickets.wordAcceptedAt) > 0n,
          terminal: BigInt(tickets.terminalAt) > 0n,
          drawsRequested: BigInt(tickets.drawsRequested),
          drawsSettled: BigInt(tickets.drawsSettled),
        }
      : null,
  };
}

/** What one address holds of one box at a block: T, placeholder tickets and items (counts), its stream share owed. */
export async function readCoreWallet(client: Reader, row: BoxRow, account: Address, blockNumber: bigint): Promise<{ readonly t: bigint; readonly tickets: bigint; readonly items: bigint; readonly streamOwed: bigint | null }> {
  const at = { blockNumber };
  const c = row.contracts;
  const balance = (address: Address | null, abi: readonly unknown[]): Promise<bigint> =>
    address ? (client.readContract({ address, abi: abi as never, functionName: 'balanceOf' as never, args: [account] as never, ...at }) as Promise<bigint>) : Promise.resolve(0n);
  const [t, tickets, items, streamOwed] = await Promise.all([
    balance(c.token, boxTokenAbi),
    balance(c.tickets, boxTicketsAbi),
    balance(c.collection, boxCollectionAbi),
    c.itemStream ? (client.readContract({ address: c.itemStream, abi: boxItemStreamAbi, functionName: 'owedOf', args: [account], ...at }) as Promise<bigint>) : Promise.resolve(null),
  ]);
  return { t, tickets, items, streamOwed };
}
