/**
 * TEST SUPPORT (never bundled): an in-memory EIP-1193 chain + wallet for the write side's unit tests. It models just
 * enough of a node for the executor: blocks with hashes, a mempool, receipts that can be reorganised away or moved,
 * per-account nonces, contract view calls answered by ABI-encoded handlers, reverts with custom-error data, and a
 * wallet that can reject (4001), fail, switch or add chains and emit `accountsChanged` / `chainChanged`.
 */
import type { Address, TxHash } from '@squarehole/domain';
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, keccak256, toHex, type Abi, type Hex } from 'viem';
import type { Eip1193Provider, Eip1193RequestArguments } from '../eip1193';
import { revertErrorsAbi } from '../../abi/revertErrors';

export class FakeRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface FakeTx {
  hash: TxHash;
  from: Address;
  to: Address | null;
  nonce: bigint;
  input: Hex;
  value: bigint;
  gas: bigint;
}

export interface FakeBlock {
  number: bigint;
  hash: TxHash;
  timestamp: bigint;
  txs: FakeTx[];
}

interface Receipt {
  tx: FakeTx;
  blockNumber: bigint;
  blockHash: TxHash;
  status: 'success' | 'reverted';
  logs: { address: Address; topics: Hex[]; data: Hex }[];
}

type CallHandler = (args: readonly unknown[], from: Address | undefined, block: string) => unknown;

/** Custom-error revert data (e.g. `revertData('InsufficientOutput', [1n, 2n])`). */
export function revertData(errorName: string, args: readonly unknown[] = []): Hex {
  return encodeErrorResult({ abi: revertErrorsAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);
}

/** The node's answer for a reverted `eth_call` (code 3, "execution reverted", data). */
export function revertError(data: Hex): FakeRpcError {
  return new FakeRpcError(3, 'execution reverted', data);
}

let hashCounter = 0;
export const fakeHash = (label: string): TxHash => keccak256(toHex(`${label}:${(hashCounter += 1)}`));

export class FakeChain {
  chainId: number;
  blocks: FakeBlock[] = [];
  mempool: FakeTx[] = [];
  receipts = new Map<string, Receipt>();
  nonces = new Map<string, bigint>();
  baseFee = 1_000_000_000n;
  tip = 100_000_000n;
  gasEstimate = 100_000n;
  /** SH-SEND-FEES: `eth_getBalance` answers; an account not listed holds `defaultBalance` (1,000 ETH). */
  balances = new Map<string, bigint>();
  defaultBalance = 10n ** 21n;
  /** Methods that fail with an RPC error (e.g. to test read failures): method → error. */
  failing = new Map<string, Error>();
  /** Every request, in order (method names), for assertions like "no wallet request on load". */
  log: string[] = [];
  private readonly handlers = new Map<string, { abi: Abi; fn: string; handler: CallHandler }>();
  /** Revert for every `eth_call` / `eth_estimateGas` to an address (e.g. a simulation failure). */
  reverts = new Map<string, Hex>();
  /** Per-tx logs added when a tx is mined (keyed by lowercase `to`). */
  logsFor = new Map<string, (tx: FakeTx) => Receipt['logs']>();
  /** Status of mined txs (keyed by lowercase `to`). */
  statusFor = new Map<string, 'success' | 'reverted'>();

  constructor(chainId = 31337) {
    this.chainId = chainId;
    this.mine(); // genesis
  }

  get head(): FakeBlock {
    return this.blocks[this.blocks.length - 1] as FakeBlock;
  }

  nonceOf(account: Address): bigint {
    return this.nonces.get(account.toLowerCase()) ?? 0n;
  }

  /** Registers a view/call handler for `fn` at `address` (answers are ABI-encoded with `abi`). */
  onCall(address: Address, abi: Abi, fn: string, handler: CallHandler): void {
    this.handlers.set(`${address.toLowerCase()}:${fn}`, { abi, fn, handler });
  }

  /** Adds a transaction to the mempool (the wallet's send, or another sender's). */
  submit(tx: Omit<FakeTx, 'hash' | 'nonce'> & { nonce?: bigint; hash?: TxHash }): FakeTx {
    const full: FakeTx = {
      ...tx,
      nonce: tx.nonce ?? this.nextPendingNonce(tx.from),
      hash: tx.hash ?? fakeHash(`tx-${tx.from}`),
    };
    this.mempool.push(full);
    return full;
  }

  private nextPendingNonce(from: Address): bigint {
    const pending = this.mempool.filter((t) => t.from.toLowerCase() === from.toLowerCase()).length;
    return this.nonceOf(from) + BigInt(pending);
  }

  /** Mines a block with the given mempool txs (default: all), in nonce order per sender. */
  mine(include: (tx: FakeTx) => boolean = () => true): FakeBlock {
    const number = this.blocks.length === 0 ? 0n : this.head.number + 1n;
    const hash = fakeHash(`block-${number}`);
    const txs: FakeTx[] = [];
    for (const tx of [...this.mempool]) {
      if (!include(tx)) continue;
      const expected = this.nonceOf(tx.from);
      this.mempool = this.mempool.filter((t) => t !== tx);
      if (tx.nonce !== expected) continue; // stale nonce: dropped (a replaced tx)
      this.nonces.set(tx.from.toLowerCase(), expected + 1n);
      txs.push(tx);
      const key = (tx.to ?? '').toLowerCase();
      this.receipts.set(tx.hash.toLowerCase(), {
        tx,
        blockNumber: number,
        blockHash: hash,
        status: this.statusFor.get(key) ?? 'success',
        logs: this.logsFor.get(key)?.(tx) ?? [],
      });
    }
    const block: FakeBlock = { number, hash, timestamp: 1_790_000_000n + number * 12n, txs };
    this.blocks.push(block);
    return block;
  }

  mineEmpty(count = 1): void {
    for (let i = 0; i < count; i += 1) this.mine(() => false);
  }

  /** Drops the last `depth` blocks; their txs go back to the mempool (a reorg). */
  reorg(depth = 1): void {
    for (let i = 0; i < depth; i += 1) {
      const block = this.blocks.pop();
      if (!block) return;
      for (const tx of block.txs) {
        this.receipts.delete(tx.hash.toLowerCase());
        this.nonces.set(tx.from.toLowerCase(), (this.nonces.get(tx.from.toLowerCase()) ?? 1n) - 1n);
        this.mempool.unshift(tx);
      }
    }
  }

  request = async ({ method, params }: Eip1193RequestArguments): Promise<unknown> => {
    this.log.push(method);
    const failure = this.failing.get(method);
    if (failure) throw failure;
    const p = (Array.isArray(params) ? params : []) as unknown[];
    switch (method) {
      case 'eth_chainId':
        return toHex(this.chainId);
      case 'eth_blockNumber':
        return toHex(this.head.number);
      case 'eth_maxPriorityFeePerGas':
        return toHex(this.tip);
      case 'eth_getBalance':
        return toHex(this.balances.get(String(p[0]).toLowerCase()) ?? this.defaultBalance);
      case 'eth_getBlockByNumber':
        return this.blockJson(p[0] as string, p[1] === true);
      case 'eth_getTransactionByHash':
        return this.txJson(p[0] as string);
      case 'eth_getTransactionReceipt':
        return this.receiptJson(p[0] as string);
      case 'eth_getTransactionCount':
        return toHex(p[1] === 'pending' ? this.nextPendingNonce(p[0] as Address) : this.nonceOf(p[0] as Address));
      case 'eth_call':
        return this.call(p[0] as { to: Address; data: Hex; from?: Address }, String(p[1] ?? 'latest'));
      case 'eth_estimateGas': {
        this.call(p[0] as { to: Address; data: Hex; from?: Address }, 'latest', true);
        return toHex(this.gasEstimate);
      }
      default:
        throw new FakeRpcError(-32601, `method ${method} not supported by the fake node`);
    }
  };

  private call(req: { to: Address; data: Hex; from?: Address }, block: string, estimateOnly = false): Hex {
    const revert = this.reverts.get(req.to.toLowerCase());
    if (revert) throw revertError(revert);
    const entries = [...this.handlers.entries()].filter(([key]) => key.startsWith(`${req.to.toLowerCase()}:`));
    for (const [, { abi, fn, handler }] of entries) {
      let decoded: { functionName: string; args?: readonly unknown[] };
      try {
        decoded = decodeFunctionData({ abi, data: req.data }) as { functionName: string; args?: readonly unknown[] };
      } catch {
        continue;
      }
      if (decoded.functionName !== fn) continue;
      const result = handler(decoded.args ?? [], req.from, block);
      if (estimateOnly) return '0x';
      return encodeFunctionResult({ abi, functionName: fn, result } as Parameters<typeof encodeFunctionResult>[0]);
    }
    if (estimateOnly) return '0x';
    throw new FakeRpcError(-32000, `no fake handler for ${req.data.slice(0, 10)} at ${req.to}`);
  }

  private blockJson(tag: string, full: boolean): unknown {
    let block: FakeBlock | undefined;
    if (tag === 'latest' || tag === 'pending' || tag === 'safe') block = this.head;
    else if (tag === 'finalized') block = this.finalizedBlock();
    else block = this.blocks.find((b) => toHex(b.number) === tag);
    if (!block) return null;
    return {
      number: toHex(block.number),
      hash: block.hash,
      timestamp: toHex(block.timestamp),
      baseFeePerGas: toHex(this.baseFee),
      transactions: block.txs.map((tx) => (full ? this.txObject(tx, block) : tx.hash)),
    };
  }

  /** Blocks at or below `finalizedDepth` from the head count as finalized (the `finalized` tag). */
  finalizedDepth = 2n;
  private finalizedBlock(): FakeBlock | undefined {
    const n = this.head.number - this.finalizedDepth;
    return n < 0n ? undefined : this.blocks.find((b) => b.number === n);
  }

  private txObject(tx: FakeTx, block: FakeBlock | null): unknown {
    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      nonce: toHex(tx.nonce),
      input: tx.input,
      value: toHex(tx.value),
      gas: toHex(tx.gas),
      blockNumber: block ? toHex(block.number) : null,
      blockHash: block ? block.hash : null,
    };
  }

  private txJson(hash: string): unknown {
    const mined = this.receipts.get(hash.toLowerCase());
    if (mined) return this.txObject(mined.tx, this.blocks.find((b) => b.hash === mined.blockHash) ?? null);
    const pending = this.mempool.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
    return pending ? this.txObject(pending, null) : null;
  }

  private receiptJson(hash: string): unknown {
    const r = this.receipts.get(hash.toLowerCase());
    if (!r) return null;
    return {
      transactionHash: r.tx.hash,
      blockHash: r.blockHash,
      blockNumber: toHex(r.blockNumber),
      status: r.status === 'success' ? '0x1' : '0x0',
      from: r.tx.from,
      to: r.tx.to,
      gasUsed: toHex(21_000n),
      effectiveGasPrice: toHex(this.baseFee + this.tip),
      logs: r.logs.map((log, index) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: toHex(index),
        blockHash: r.blockHash,
        blockNumber: toHex(r.blockNumber),
        transactionHash: r.tx.hash,
      })),
    };
  }
}

export type SendBehaviour = 'send' | 'reject' | 'error' | 'garbage';

/**
 * A fake injected wallet on top of a FakeChain: accounts, its own chain id (can differ from the node's), send
 * behaviour, EIP-1193 events, and chain switching (only chains in `knownChains`; others answer 4902).
 */
export class FakeWallet implements Eip1193Provider {
  accounts: Address[];
  chainId: number;
  knownChains: Set<number>;
  sendBehaviour: SendBehaviour = 'send';
  sent: Record<string, unknown>[] = [];
  requests: string[] = [];
  /** Account-access requests (the Connect click), counted so app tests need not spell the method name. */
  accountRequests = 0;
  supportsRevoke = true;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly chain: FakeChain;

  constructor(chain: FakeChain, accounts: Address[], options: { chainId?: number; knownChains?: number[] } = {}) {
    this.chain = chain;
    this.accounts = accounts;
    this.chainId = options.chainId ?? chain.chainId;
    this.knownChains = new Set(options.knownChains ?? [this.chainId, chain.chainId]);
  }

  request = async ({ method, params }: Eip1193RequestArguments): Promise<unknown> => {
    this.requests.push(method);
    const p = (Array.isArray(params) ? params : []) as unknown[];
    switch (method) {
      case 'eth_requestAccounts':
        this.accountRequests += 1;
        if (this.sendBehaviour === 'reject') throw new FakeRpcError(4001, 'User rejected the request.');
        return [...this.accounts];
      case 'eth_accounts':
        return [...this.accounts];
      case 'eth_chainId':
        return toHex(this.chainId);
      case 'wallet_switchEthereumChain': {
        const id = Number(BigInt((p[0] as { chainId: string }).chainId));
        if (!this.knownChains.has(id)) throw new FakeRpcError(4902, 'Unrecognized chain ID');
        this.setChain(id);
        return null;
      }
      case 'wallet_addEthereumChain': {
        const id = Number(BigInt((p[0] as { chainId: string }).chainId));
        this.knownChains.add(id);
        return null;
      }
      case 'wallet_revokePermissions':
        if (!this.supportsRevoke) throw new FakeRpcError(4200, 'Unsupported method');
        return null;
      case 'eth_sendTransaction': {
        const tx = p[0] as { from: Address; to: Address; data: Hex; value: Hex; gas: Hex; maxFeePerGas?: Hex; maxPriorityFeePerGas?: Hex; gasPrice?: Hex; chainId?: Hex };
        this.sent.push(tx);
        // Like real wallets: a transaction that names another chain than the wallet's current one is refused.
        if (tx.chainId !== undefined && Number(BigInt(tx.chainId)) !== this.chainId) {
          throw new FakeRpcError(-32602, `Invalid chainId: the transaction is for chain ${Number(BigInt(tx.chainId))}, the wallet is on ${this.chainId}`);
        }
        if (this.sendBehaviour === 'reject') throw new FakeRpcError(4001, 'User denied transaction signature.');
        if (this.sendBehaviour === 'error') throw new FakeRpcError(-32603, 'Internal JSON-RPC error.');
        if (this.sendBehaviour === 'garbage') return 'not-a-hash';
        return this.chain.submit({ from: tx.from, to: tx.to, input: tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas) }).hash;
      }
      default:
        return this.chain.request({ method, params });
    }
  };

  on(event: string, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  setChain(chainId: number): void {
    this.chainId = chainId;
    this.emit('chainChanged', toHex(chainId));
  }

  setAccounts(accounts: Address[]): void {
    this.accounts = accounts;
    this.emit('accountsChanged', accounts);
  }
}

export const ACCOUNT_A: Address = '0x00000000000000000000000000000000000a11ce';
export const ACCOUNT_B: Address = '0x0000000000000000000000000000000000000b0b';
