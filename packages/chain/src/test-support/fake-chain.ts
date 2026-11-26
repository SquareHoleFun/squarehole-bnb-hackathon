/**
 * A scripted JSON-RPC chain for unit tests (a mocked viem transport; no network). It serves blocks (with hashes that
 * change on a simulated reorg), eth_getLogs with address/topic filters and an optional range limit, and eth_call by
 * ABI-decoding the calldata against contracts registered with `contract(address, abi, handlers)`.
 */
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  multicall3Abi,
  numberToHex,
  hexToBigInt,
  stringToHex,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  type Transport,
} from 'viem';

export const FAKE_MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

export interface FakeLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly txHash: Hex;
}

type Handler = (args: readonly unknown[], blockNumber: bigint) => unknown;

interface Contract {
  readonly abi: Abi;
  readonly handlers: Readonly<Record<string, Handler>>;
}

export class FakeChain {
  chainId = 31_337;
  head = 0n;
  /** Blocks at or below this are finalized; null = the node does not report finality. */
  finalizedLag: bigint | null = 64n;
  maxLogRange: number | null = null;
  /** False = the node rejects the 'safe' block tag (older clients). */
  supportsSafe = true;
  /** Throw a transport error for these methods (count = remaining failures, Infinity = always). */
  readonly failures = new Map<string, number>();
  readonly calls: string[] = [];
  private readonly logs: FakeLog[] = [];
  private readonly salts = new Map<bigint, string>();
  private readonly timestamps = new Map<bigint, bigint>();
  private readonly contracts = new Map<string, Contract>();
  private readonly codes = new Map<string, Hex>();
  genesisTime = 1_790_000_000n;

  constructor(head = 0n) {
    this.head = head;
  }

  hashOf(number: bigint): Hex {
    return keccak256(stringToHex(`block:${number}:${this.salts.get(number) ?? 'a'}`));
  }

  timestampOf(number: bigint): bigint {
    return this.timestamps.get(number) ?? this.genesisTime + number * 12n;
  }

  setTimestamp(number: bigint, seconds: bigint): void {
    this.timestamps.set(number, seconds);
  }

  mine(count = 1n): bigint {
    this.head += count;
    return this.head;
  }

  addLog(log: Omit<FakeLog, 'logIndex' | 'txHash'> & { logIndex?: number; txHash?: Hex }): FakeLog {
    const inBlock = this.logs.filter((existing) => existing.blockNumber === log.blockNumber).length;
    const full: FakeLog = {
      ...log,
      logIndex: log.logIndex ?? inBlock,
      txHash: log.txHash ?? keccak256(stringToHex(`tx:${log.blockNumber}:${inBlock}:${this.salts.get(log.blockNumber) ?? 'a'}`)),
    };
    this.logs.push(full);
    if (log.blockNumber > this.head) this.head = log.blockNumber;
    return full;
  }

  /** Replaces every block from `fromBlock` on (new hashes) and drops their logs: a reorg to a fork without them. */
  reorg(fromBlock: bigint, salt: string): void {
    for (let number = fromBlock; number <= this.head; number += 1n) this.salts.set(number, salt);
    for (let index = this.logs.length - 1; index >= 0; index -= 1) {
      if ((this.logs[index] as FakeLog).blockNumber >= fromBlock) this.logs.splice(index, 1);
    }
  }

  contract(address: Address, abi: Abi, handlers: Record<string, Handler>): void {
    this.contracts.set(address.toLowerCase(), { abi, handlers });
  }

  /** Runtime bytecode served by eth_getCode (any block); '0x' removes it. Unset addresses have no code. */
  setCode(address: Address, code: Hex): void {
    this.codes.set(address.toLowerCase(), code);
  }

  private block(tag: string): Record<string, unknown> | null {
    let number: bigint;
    if (tag === 'latest' || tag === 'pending') number = this.head;
    else if (tag === 'safe') {
      if (!this.supportsSafe) throw new Error('unknown block tag safe');
      number = this.head > 32n ? this.head - 32n : 0n;
    }
    else if (tag === 'finalized') {
      if (this.finalizedLag === null) throw new Error('finalized block not supported');
      number = this.head > this.finalizedLag ? this.head - this.finalizedLag : 0n;
    } else number = hexToBigInt(tag as Hex);
    if (number > this.head) return null;
    return {
      number: numberToHex(number),
      hash: this.hashOf(number),
      parentHash: number === 0n ? `0x${'00'.repeat(32)}` : this.hashOf(number - 1n),
      timestamp: numberToHex(this.timestampOf(number)),
      transactions: [],
      logsBloom: `0x${'00'.repeat(256)}`,
      miner: '0x0000000000000000000000000000000000000000',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      baseFeePerGas: '0x1',
      difficulty: '0x0',
      extraData: '0x',
      nonce: '0x0000000000000000',
      sha3Uncles: `0x${'00'.repeat(32)}`,
      size: '0x1',
      stateRoot: `0x${'00'.repeat(32)}`,
      receiptsRoot: `0x${'00'.repeat(32)}`,
      transactionsRoot: `0x${'00'.repeat(32)}`,
      mixHash: `0x${'00'.repeat(32)}`,
      totalDifficulty: '0x0',
      uncles: [],
    };
  }

  private getLogs(filter: { address?: string | string[]; topics?: (string | string[] | null)[]; fromBlock: Hex; toBlock: Hex }): unknown[] {
    const from = hexToBigInt(filter.fromBlock);
    const to = hexToBigInt(filter.toBlock);
    if (this.maxLogRange !== null && to - from + 1n > BigInt(this.maxLogRange)) {
      throw Object.assign(new Error(`query exceeds max block range ${this.maxLogRange}`), { code: -32005 });
    }
    const addresses = filter.address === undefined ? null : (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
    return this.logs
      .filter((log) => log.blockNumber >= from && log.blockNumber <= to && log.blockNumber <= this.head)
      .filter((log) => addresses === null || addresses.includes(log.address.toLowerCase()))
      .filter((log) =>
        (filter.topics ?? []).every((wanted, index) => {
          if (wanted === null) return true;
          const topic = log.topics[index]?.toLowerCase();
          return Array.isArray(wanted) ? wanted.some((w) => w.toLowerCase() === topic) : wanted.toLowerCase() === topic;
        }),
      )
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
      .map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: numberToHex(log.blockNumber),
        blockHash: this.hashOf(log.blockNumber),
        transactionHash: log.txHash,
        transactionIndex: '0x0',
        logIndex: numberToHex(log.logIndex),
        removed: false,
      }));
  }

  private call(tx: { to: Address; data: Hex }, blockTag: string): Hex {
    const number = blockTag === 'latest' ? this.head : hexToBigInt(blockTag as Hex);
    if (tx.to.toLowerCase() === FAKE_MULTICALL3.toLowerCase()) return this.aggregate3(tx.data, blockTag);
    const contract = this.contracts.get(tx.to.toLowerCase());
    if (!contract) throw Object.assign(new Error('execution reverted: no code'), { code: 3, data: '0x' });
    const selector = tx.data.slice(0, 10).toLowerCase();
    const item = contract.abi.find((entry): entry is AbiFunction => entry.type === 'function' && toFunctionSelector(entry).toLowerCase() === selector);
    if (!item) throw Object.assign(new Error('execution reverted: unknown selector'), { code: 3, data: '0x' });
    const { args } = decodeFunctionData({ abi: [item], data: tx.data });
    const handler = contract.handlers[item.name];
    if (!handler) throw Object.assign(new Error(`execution reverted: ${item.name} not mocked`), { code: 3, data: '0x' });
    const result = handler(args ?? [], number);
    return encodeFunctionResult({ abi: [item], functionName: item.name, result } as Parameters<typeof encodeFunctionResult>[0]);
  }

  /** Multicall3.aggregate3 over the mocked contracts (viem batches reads through it where Multicall3 exists). */
  private aggregate3(data: Hex, blockTag: string): Hex {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data });
    const calls = (args?.[0] ?? []) as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
    const results = calls.map((inner) => {
      try {
        return { success: true, returnData: this.call({ to: inner.target, data: inner.callData }, blockTag) };
      } catch (error) {
        if (!inner.allowFailure) throw error;
        return { success: false, returnData: '0x' as Hex };
      }
    });
    return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.calls.push(method);
    const remaining = this.failures.get(method) ?? 0;
    if (remaining > 0) {
      this.failures.set(method, remaining - 1);
      throw new Error(`fake transport failure for ${method}`);
    }
    const list = (params ?? []) as unknown[];
    switch (method) {
      case 'eth_chainId':
        return numberToHex(this.chainId);
      case 'eth_blockNumber':
        return numberToHex(this.head);
      case 'eth_getBlockByNumber':
        return this.block(list[0] as string);
      case 'eth_getLogs':
        return this.getLogs(list[0] as never);
      case 'eth_call':
        return this.call(list[0] as never, (list[1] as string | undefined) ?? 'latest');
      case 'eth_getCode':
        return this.codes.get(String(list[0]).toLowerCase()) ?? '0x';
      default:
        throw new Error(`fake chain: unsupported method ${method}`);
    }
  }

  transport(): Transport {
    return custom({ request: (args) => this.request(args as never) }, { retryCount: 0 });
  }
}
