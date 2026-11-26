/**
 * Read access to the chain for the per-block pipeline, behind an interface the tests replace with a scripted chain.
 * The RPC implementation rotates over keyless HTTP endpoints (publicnode and tenderly on Sepolia): an error moves
 * to the next endpoint, and a suspicious empty answer (the bloom said "maybe", `getLogs` said "nothing") is asked
 * again of the next one, since load-balanced public RPCs can route a request to a backend that has not seen the block.
 * Every request pins the block by HASH (EIP-234 for logs, EIP-1898 for calls), never by number.
 */
import { createPublicClient, encodeFunctionData, decodeFunctionResult, http, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { decodeSlot0, poolStateSlot } from '@squarehole/chain';
import { bloomQuery } from './bloom';
import { LAUNCH_TOPIC0, POOL_MANAGER_TOPIC0, type RawLog } from './events';
import { unionLogs } from './log-sets';
import type { BlockHeader } from './model';
import type { PoolTarget } from './config';

export interface PoolSlot {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
}

export interface Finality {
  readonly safe: bigint | null;
  readonly finalized: bigint | null;
}

export interface BlockLogs {
  readonly logs: readonly RawLog[];
  /** How many getLogs calls the block needed (0 when the bloom ruled everything out). */
  readonly calls: number;
}

export interface ChainReader {
  latestHeader(): Promise<BlockHeader>;
  headerByNumber(number: bigint): Promise<BlockHeader | null>;
  headerByHash(hash: Hex): Promise<BlockHeader | null>;
  blockLogs(header: BlockHeader): Promise<BlockLogs>;
  rangeLogs(fromBlock: bigint, toBlock: bigint): Promise<readonly RawLog[]>;
  /**
   * Every log of ours in the block, asked of two endpoints at once, regardless of the bloom, and MERGED: the audit
   * and the repairs use it, and a log that one backend returns for a block hash is real.
   */
  logsByHash(blockHash: Hex): Promise<readonly RawLog[]>;
  /** The transaction's `from`; null when the transaction is unknown. Throws when no endpoint answers. */
  txSender(hash: Hex): Promise<Address | null>;
  /** `from` of every transaction in the block: one `eth_getBlockByHash(hash, true)`. Throws when unavailable. */
  blockSenders(blockHash: Hex): Promise<ReadonlyMap<Hex, Address>>;
  poolSlot(blockHash: Hex): Promise<PoolSlot>;
  totalSupply(blockHash: Hex): Promise<bigint>;
  finality(): Promise<Finality>;
}

const poolManagerReadAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
const tokenReadAbi = parseAbi(['function totalSupply() view returns (uint256)']);
const LIQUIDITY_OFFSET = 3n;

interface RpcBlock {
  number: bigint | null;
  hash: Hex | null;
  parentHash: Hex;
  timestamp: bigint;
  logsBloom: Hex | null;
}

export function headerOf(block: RpcBlock): BlockHeader {
  if (block.number === null || block.hash === null) throw new Error('pending block has no number or hash');
  return { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp, ...(block.logsBloom ? { logsBloom: block.logsBloom } : {}) };
}

/** A log as eth_getLogs returns it (hex quantities). */
interface RpcLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: Hex | null;
  readonly blockHash: Hex | null;
  readonly transactionHash: Hex | null;
  readonly transactionIndex: Hex | null;
  readonly logIndex: Hex | null;
  readonly removed?: boolean;
}

export function fromRpcLog(log: RpcLog): RawLog {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null || log.transactionIndex === null) {
    throw new Error('pending log in a mined block');
  }
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: BigInt(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: Number(log.transactionIndex),
    logIndex: Number(log.logIndex),
    ...(log.removed ? { removed: true } : {}),
  };
}

type LogScope = { readonly blockHash: Hex } | { readonly fromBlock: bigint; readonly toBlock: bigint };

/**
 * Raw eth_getLogs: viem's getLogs builds topics only from ABI items (one event with args, or several without), so the
 * pool filter [[Swap, ModifyLiquidity, Initialize, Donate], poolId] is sent as is.
 */
async function getLogsRaw(client: PublicClient, address: Address | readonly Address[], topics: readonly (Hex | readonly Hex[] | null)[] | undefined, scope: LogScope): Promise<RawLog[]> {
  const where = 'blockHash' in scope ? { blockHash: scope.blockHash } : { fromBlock: toHex(scope.fromBlock), toBlock: toHex(scope.toBlock) };
  const params = { address, ...(topics ? { topics } : {}), ...where };
  const logs = (await client.request({ method: 'eth_getLogs', params: [params] } as never)) as RpcLog[];
  return logs.map(fromRpcLog);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RpcReaderOptions {
  readonly urls: readonly string[];
  readonly target: PoolTarget;
  readonly timeoutMs?: number;
  /** Largest block span per getLogs in a backfill (public RPCs refuse wide ranges). */
  readonly maxRange?: bigint;
  readonly onRequest?: (method: string, url: string, ms: number, ok: boolean) => void;
}

export class RpcChainReader implements ChainReader {
  private readonly clients: readonly { url: string; client: PublicClient }[];
  private readonly target: PoolTarget;
  private readonly contracts: readonly Address[];
  private readonly maxRange: bigint;
  private readonly onRequest: RpcReaderOptions['onRequest'];
  private preferred = 0;

  constructor(options: RpcReaderOptions) {
    if (options.urls.length === 0) throw new Error('at least one RPC URL');
    this.clients = options.urls.map((url) => ({
      url,
      client: createPublicClient({ transport: http(url, { timeout: options.timeoutMs ?? 8_000, retryCount: 0, batch: false }) }) as PublicClient,
    }));
    this.target = options.target;
    this.contracts = [options.target.token, options.target.hook, options.target.collector, options.target.executor, options.target.launchRouter, options.target.genesis];
    this.maxRange = options.maxRange ?? 5_000n;
    this.onRequest = options.onRequest;
  }

  /** Runs `fn` on the preferred endpoint, then on each other one; remembers the one that answered. */
  private async withFallback<T>(method: string, fn: (client: PublicClient) => Promise<T>, startOffset = 0): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.clients.length * 2; attempt += 1) {
      const index = (this.preferred + startOffset + attempt) % this.clients.length;
      const entry = this.clients[index];
      if (!entry) continue;
      const started = performance.now();
      try {
        const result = await fn(entry.client);
        this.onRequest?.(method, entry.url, performance.now() - started, true);
        this.preferred = index;
        return result;
      } catch (error) {
        this.onRequest?.(method, entry.url, performance.now() - started, false);
        lastError = error;
        if (attempt >= this.clients.length - 1) await sleep(150 * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${method} failed on every endpoint`);
  }

  async latestHeader(): Promise<BlockHeader> {
    return headerOf(await this.withFallback('eth_getBlockByNumber', (c) => c.getBlock({ blockTag: 'latest' })));
  }

  async headerByNumber(number: bigint): Promise<BlockHeader | null> {
    try {
      return headerOf(await this.withFallback('eth_getBlockByNumber', (c) => c.getBlock({ blockNumber: number })));
    } catch (error) {
      if (error instanceof Error && error.name === 'BlockNotFoundError') return null;
      throw error;
    }
  }

  async headerByHash(hash: Hex): Promise<BlockHeader | null> {
    try {
      return headerOf(await this.withFallback('eth_getBlockByHash', (c) => c.getBlock({ blockHash: hash })));
    } catch (error) {
      if (error instanceof Error && error.name === 'BlockNotFoundError') return null;
      throw error;
    }
  }

  private async logsAt(blockHash: Hex, which: 'pool' | 'contracts', startOffset: number): Promise<RawLog[]> {
    const raw = await this.withFallback('eth_getLogs', (c) => this.scopedLogs(c, which, { blockHash }), startOffset);
    for (const log of raw) if (log.blockHash.toLowerCase() !== blockHash.toLowerCase()) throw new Error(`getLogs returned a log of block ${log.blockHash}`);
    return raw;
  }

  private scopedLogs(client: PublicClient, which: 'pool' | 'contracts', scope: LogScope): Promise<RawLog[]> {
    return which === 'pool'
      ? getLogsRaw(client, this.target.poolManager, [[...POOL_MANAGER_TOPIC0], this.target.poolId], scope)
      : getLogsRaw(client, [...this.contracts], [[...LAUNCH_TOPIC0]], scope);
  }

  /**
   * Asks two endpoints at once and takes the first non-empty answer; an empty answer counts only when both agree
   * (a bloom false positive, or both behind: the audit catches that). Both failing falls back to the rotation.
   * One round trip instead of "ask, wait, ask again": the first live run spent 0.7–1.5 s on that for false positives.
   */
  private raceNonEmpty(blockHash: Hex, which: 'pool' | 'contracts'): Promise<RawLog[]> {
    const racers = Array.from({ length: Math.min(2, this.clients.length) }, (_, i) => this.clients[(this.preferred + i) % this.clients.length]);
    return new Promise<RawLog[]>((resolve, reject) => {
      let pending = racers.length;
      let empty: RawLog[] | null = null;
      const settle = (): void => {
        pending -= 1;
        if (pending > 0) return;
        if (empty) resolve(empty);
        else this.logsAt(blockHash, which, 2).then(resolve, reject);
      };
      for (const entry of racers) {
        if (!entry) {
          settle();
          continue;
        }
        const started = performance.now();
        this.scopedLogs(entry.client, which, { blockHash })
          .then((logs) => {
            this.onRequest?.('eth_getLogs', entry.url, performance.now() - started, true);
            if (logs.some((log) => log.blockHash.toLowerCase() !== blockHash.toLowerCase())) throw new Error('getLogs returned a log of another block');
            if (logs.length > 0) resolve(logs);
            else empty = logs;
          })
          .catch(() => this.onRequest?.('eth_getLogs', entry.url, performance.now() - started, false))
          .finally(settle);
      }
    });
  }

  /** The block's logs of our pool and contracts; skips a query the bloom rules out; races two endpoints otherwise. */
  async blockLogs(header: BlockHeader): Promise<BlockLogs> {
    const query = bloomQuery(header.logsBloom, this.target);
    let calls = 0;
    const fetchOne = async (which: 'pool' | 'contracts'): Promise<RawLog[]> => {
      if (!header.logsBloom) {
        calls += 1;
        return this.logsAt(header.hash, which, 0);
      }
      calls += Math.min(2, this.clients.length);
      return this.raceNonEmpty(header.hash, which);
    };
    const [pool, contracts] = await Promise.all([query.pool ? fetchOne('pool') : Promise.resolve([]), query.contracts ? fetchOne('contracts') : Promise.resolve([])]);
    return { logs: [...pool, ...contracts], calls };
  }

  async rangeLogs(fromBlock: bigint, toBlock: bigint): Promise<readonly RawLog[]> {
    const out: RawLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += this.maxRange) {
      const end = start + this.maxRange - 1n < toBlock ? start + this.maxRange - 1n : toBlock;
      const scope = { fromBlock: start, toBlock: end };
      const [pool, contracts] = await Promise.all([
        this.withFallback('eth_getLogs', (c) => this.scopedLogs(c, 'pool', scope)),
        this.withFallback('eth_getLogs', (c) => this.scopedLogs(c, 'contracts', scope)),
      ]);
      out.push(...pool, ...contracts);
    }
    return out;
  }

  async logsByHash(blockHash: Hex): Promise<readonly RawLog[]> {
    const endpoints = Array.from({ length: Math.min(2, this.clients.length) }, (_, i) => this.clients[(this.preferred + i) % this.clients.length]);
    const both = async (which: 'pool' | 'contracts'): Promise<RawLog[]> => {
      const answers = await Promise.allSettled(
        endpoints.map(async (entry) => {
          if (!entry) throw new Error('no endpoint');
          const started = performance.now();
          try {
            const logs = await this.scopedLogs(entry.client, which, { blockHash });
            this.onRequest?.('eth_getLogs', entry.url, performance.now() - started, true);
            if (logs.some((log) => log.blockHash.toLowerCase() !== blockHash.toLowerCase())) throw new Error('getLogs returned a log of another block');
            return logs;
          } catch (error) {
            this.onRequest?.('eth_getLogs', entry.url, performance.now() - started, false);
            throw error;
          }
        }),
      );
      const ok = answers.filter((a): a is PromiseFulfilledResult<RawLog[]> => a.status === 'fulfilled').map((a) => a.value);
      return ok.length > 0 ? unionLogs(...ok) : this.logsAt(blockHash, which, 2);
    };
    const [pool, contracts] = await Promise.all([both('pool'), both('contracts')]);
    return unionLogs(pool, contracts);
  }

  async txSender(hash: Hex): Promise<Address | null> {
    try {
      const tx = await this.withFallback('eth_getTransactionByHash', (c) => c.getTransaction({ hash }));
      return tx.from;
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionNotFoundError') return null;
      throw error;
    }
  }

  async blockSenders(blockHash: Hex): Promise<ReadonlyMap<Hex, Address>> {
    const block = await this.withFallback('eth_getBlockByHash', (c) => c.getBlock({ blockHash, includeTransactions: true }));
    return new Map(block.transactions.map((tx) => [tx.hash, tx.from] as const));
  }

  private async callAt(to: Address, data: Hex, blockHash: Hex): Promise<Hex> {
    return this.withFallback('eth_call', async (c) => {
      const result = (await c.request({ method: 'eth_call', params: [{ to, data }, { blockHash }] as never })) as Hex;
      return result;
    });
  }

  async poolSlot(blockHash: Hex): Promise<PoolSlot> {
    const slot = poolStateSlot(this.target.poolId);
    const liquiditySlot = `0x${(BigInt(slot) + LIQUIDITY_OFFSET).toString(16).padStart(64, '0')}` as Hex;
    const read = async (key: Hex): Promise<Hex> => {
      const data = encodeFunctionData({ abi: poolManagerReadAbi, functionName: 'extsload', args: [key] });
      return decodeFunctionResult({ abi: poolManagerReadAbi, functionName: 'extsload', data: await this.callAt(this.target.poolManager, data, blockHash) });
    };
    const [word, liquidityWord] = await Promise.all([read(slot), read(liquiditySlot)]);
    const slot0 = decodeSlot0(word);
    return { sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, liquidity: BigInt(liquidityWord) & ((1n << 128n) - 1n) };
  }

  async totalSupply(blockHash: Hex): Promise<bigint> {
    const data = encodeFunctionData({ abi: tokenReadAbi, functionName: 'totalSupply' });
    return decodeFunctionResult({ abi: tokenReadAbi, functionName: 'totalSupply', data: await this.callAt(this.target.token, data, blockHash) });
  }

  async finality(): Promise<Finality> {
    const read = async (blockTag: 'safe' | 'finalized'): Promise<bigint | null> => {
      try {
        const block = await this.withFallback(`eth_getBlockByNumber(${blockTag})`, (c) => c.getBlock({ blockTag }));
        return block.number;
      } catch {
        return null;
      }
    };
    const [safe, finalized] = await Promise.all([read('safe'), read('finalized')]);
    return { safe, finalized };
  }
}
