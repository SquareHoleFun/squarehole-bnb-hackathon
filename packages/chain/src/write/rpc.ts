/**
 * Minimal typed chain reads the transaction executor needs (simulation, gas, fees, receipts, nonces, blocks), over
 * any EIP-1193 `request` function: the app's configured RPC for the target chain (never the wallet's, so a wallet on
 * another network cannot change what is simulated or tracked), or a test provider. Every response is shape-checked;
 * a malformed or failed read throws and is never turned into zero (06-ARCHITECTURE "A chain read failure is not zero").
 */
import type { Address, TxHash } from '@squarehole/domain';
import { RpcShapeError, isAddressValue, isHexData, isTxHashValue, quantity, toQuantity, type Eip1193Request } from './eip1193';
import { refusedRetryFetch, type FetchLike } from './refused-fetch';

export type Hex = `0x${string}`;
export type BlockTag = 'latest' | 'safe' | 'finalized' | 'pending';

export interface CallRequest {
  readonly from?: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
  readonly gas?: bigint;
}

export interface RpcLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly logIndex: number;
  readonly blockHash: TxHash;
  readonly blockNumber: bigint;
  readonly transactionHash: TxHash;
}

export interface TxReceipt {
  readonly transactionHash: TxHash;
  readonly blockHash: TxHash;
  readonly blockNumber: bigint;
  readonly status: 'success' | 'reverted';
  readonly from: Address;
  readonly to: Address | null;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint | null;
  readonly logs: readonly RpcLog[];
}

export interface RpcTransaction {
  readonly hash: TxHash;
  readonly from: Address;
  readonly to: Address | null;
  readonly nonce: bigint;
  readonly input: Hex;
  readonly value: bigint;
  readonly gas: bigint;
  readonly blockNumber: bigint | null;
  readonly blockHash: TxHash | null;
}

export interface RpcBlock {
  readonly number: bigint;
  readonly hash: TxHash;
  readonly timestamp: bigint;
  readonly baseFeePerGas: bigint | null;
  /** Full transactions when requested, else hashes. */
  readonly transactions: readonly (RpcTransaction | TxHash)[];
}

export interface ChainReader {
  chainId(): Promise<number>;
  /** `eth_call`; a revert throws `RpcRequestError` carrying the revert data. */
  call(request: CallRequest, block?: BlockTag | bigint): Promise<Hex>;
  estimateGas(request: CallRequest): Promise<bigint>;
  maxPriorityFeePerGas(): Promise<bigint>;
  /** `eth_gasPrice` (SH-258: a chain whose price is not its base fee, BNB Chain testnet, sets its fee floor by it). */
  gasPrice?(): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  getBlock(block: BlockTag | bigint, fullTransactions?: boolean): Promise<RpcBlock | null>;
  getTransaction(hash: TxHash): Promise<RpcTransaction | null>;
  getReceipt(hash: TxHash): Promise<TxReceipt | null>;
  getTransactionCount(address: Address, block: BlockTag): Promise<bigint>;
  /** `eth_getBalance` in wei (SH-SEND-FEES: the executor's check that the account can pay a send's most fee). */
  getBalance(address: Address, block: BlockTag): Promise<bigint>;
}

/** A JSON-RPC error answer (code, message and optional data, e.g. revert data). */
export class RpcRequestError extends Error {
  readonly code: number | null;
  readonly data: unknown;
  constructor(message: string, code: number | null, data: unknown) {
    super(message);
    this.name = 'RpcRequestError';
    this.code = code;
    this.data = data;
  }
}

const blockParam = (block: BlockTag | bigint): string => (typeof block === 'bigint' ? toQuantity(block) : block);

function callObject(request: CallRequest): Record<string, string> {
  const out: Record<string, string> = { to: request.to, data: request.data };
  if (request.from) out.from = request.from;
  if (request.value !== undefined) out.value = toQuantity(request.value);
  if (request.gas !== undefined) out.gas = toQuantity(request.gas);
  return out;
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RpcShapeError(`${what} is not an object`);
  return value as Record<string, unknown>;
};
const hash = (value: unknown, what: string): TxHash => {
  if (!isTxHashValue(value)) throw new RpcShapeError(`${what} is not a 32-byte hash`);
  return value;
};
const address = (value: unknown, what: string): Address => {
  if (!isAddressValue(value)) throw new RpcShapeError(`${what} is not an address`);
  return value;
};
const hexData = (value: unknown, what: string): Hex => {
  if (!isHexData(value)) throw new RpcShapeError(`${what} is not hex data`);
  return value;
};

function parseLog(value: unknown): RpcLog {
  const log = record(value, 'log');
  if (!Array.isArray(log.topics)) throw new RpcShapeError('log topics are not a list');
  const logIndex = quantity(log.logIndex, 'logIndex');
  return Object.freeze({
    address: address(log.address, 'log address'),
    topics: Object.freeze(log.topics.map((topic) => hexData(topic, 'log topic'))),
    data: hexData(log.data, 'log data'),
    logIndex: Number(logIndex),
    blockHash: hash(log.blockHash, 'log blockHash'),
    blockNumber: quantity(log.blockNumber, 'log blockNumber'),
    transactionHash: hash(log.transactionHash, 'log transactionHash'),
  });
}

export function parseReceipt(value: unknown): TxReceipt | null {
  if (value === null || value === undefined) return null;
  const r = record(value, 'receipt');
  const status = quantity(r.status, 'receipt status');
  if (status !== 0n && status !== 1n) throw new RpcShapeError('receipt status is neither 0 nor 1');
  if (!Array.isArray(r.logs)) throw new RpcShapeError('receipt logs are not a list');
  return Object.freeze({
    transactionHash: hash(r.transactionHash, 'receipt transactionHash'),
    blockHash: hash(r.blockHash, 'receipt blockHash'),
    blockNumber: quantity(r.blockNumber, 'receipt blockNumber'),
    status: status === 1n ? 'success' : 'reverted',
    from: address(r.from, 'receipt from'),
    to: r.to === null || r.to === undefined ? null : address(r.to, 'receipt to'),
    gasUsed: quantity(r.gasUsed, 'receipt gasUsed'),
    effectiveGasPrice: r.effectiveGasPrice === undefined ? null : quantity(r.effectiveGasPrice, 'receipt effectiveGasPrice'),
    logs: Object.freeze(r.logs.map(parseLog)),
  });
}

export function parseTransaction(value: unknown): RpcTransaction | null {
  if (value === null || value === undefined) return null;
  const t = record(value, 'transaction');
  return Object.freeze({
    hash: hash(t.hash, 'transaction hash'),
    from: address(t.from, 'transaction from'),
    to: t.to === null || t.to === undefined ? null : address(t.to, 'transaction to'),
    nonce: quantity(t.nonce, 'transaction nonce'),
    input: hexData(t.input ?? t.data, 'transaction input'),
    value: quantity(t.value, 'transaction value'),
    gas: quantity(t.gas, 'transaction gas'),
    blockNumber: t.blockNumber === null || t.blockNumber === undefined ? null : quantity(t.blockNumber, 'transaction blockNumber'),
    blockHash: t.blockHash === null || t.blockHash === undefined ? null : hash(t.blockHash, 'transaction blockHash'),
  });
}

function parseBlock(value: unknown): RpcBlock | null {
  if (value === null || value === undefined) return null;
  const b = record(value, 'block');
  if (!Array.isArray(b.transactions)) throw new RpcShapeError('block transactions are not a list');
  return Object.freeze({
    number: quantity(b.number, 'block number'),
    hash: hash(b.hash, 'block hash'),
    timestamp: quantity(b.timestamp, 'block timestamp'),
    baseFeePerGas: b.baseFeePerGas === undefined || b.baseFeePerGas === null ? null : quantity(b.baseFeePerGas, 'baseFeePerGas'),
    transactions: Object.freeze(b.transactions.map((tx) => (typeof tx === 'string' ? hash(tx, 'block transaction') : (parseTransaction(tx) as RpcTransaction)))),
  });
}

/** Wraps an EIP-1193 request so every thrown value becomes an `RpcRequestError` with its code and data. */
async function send(request: Eip1193Request, method: string, params: readonly unknown[]): Promise<unknown> {
  try {
    return await request({ method, params });
  } catch (error) {
    if (error instanceof RpcRequestError) throw error;
    const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown; data?: unknown };
    throw new RpcRequestError(
      typeof e.message === 'string' ? e.message : `${method} failed`,
      typeof e.code === 'number' ? e.code : null,
      e.data,
    );
  }
}

export function createChainReader(request: Eip1193Request): ChainReader {
  return Object.freeze({
    async chainId() {
      const id = quantity(await send(request, 'eth_chainId', []), 'eth_chainId');
      if (id < 1n || id > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcShapeError('chain id out of range');
      return Number(id);
    },
    async call(req: CallRequest, block: BlockTag | bigint = 'latest') {
      return hexData(await send(request, 'eth_call', [callObject(req), blockParam(block)]), 'eth_call result');
    },
    async estimateGas(req: CallRequest) {
      return quantity(await send(request, 'eth_estimateGas', [callObject(req)]), 'eth_estimateGas');
    },
    async maxPriorityFeePerGas() {
      return quantity(await send(request, 'eth_maxPriorityFeePerGas', []), 'eth_maxPriorityFeePerGas');
    },
    async gasPrice() {
      return quantity(await send(request, 'eth_gasPrice', []), 'eth_gasPrice');
    },
    async blockNumber() {
      return quantity(await send(request, 'eth_blockNumber', []), 'eth_blockNumber');
    },
    async getBlock(block: BlockTag | bigint, fullTransactions = false) {
      return parseBlock(await send(request, 'eth_getBlockByNumber', [blockParam(block), fullTransactions]));
    },
    async getTransaction(txHash: TxHash) {
      return parseTransaction(await send(request, 'eth_getTransactionByHash', [txHash]));
    },
    async getReceipt(txHash: TxHash) {
      return parseReceipt(await send(request, 'eth_getTransactionReceipt', [txHash]));
    },
    async getTransactionCount(account: Address, block: BlockTag) {
      return quantity(await send(request, 'eth_getTransactionCount', [account, block]), 'eth_getTransactionCount');
    },
    async getBalance(account: Address, block: BlockTag) {
      return quantity(await send(request, 'eth_getBalance', [account, block]), 'eth_getBalance');
    },
  });
}

export interface HttpRequestOptions {
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  /**
   * SH-276: how many more times a request the endpoint refused with HTTP 429 ("later") is sent to the same endpoint
   * (default 3, after about 400, 900 and 1,800 ms, or the endpoint's own Retry-After of at most two seconds); 0 never.
   */
  readonly refusedRetries?: number;
}

/** Statuses whose response has no body (a buffered copy of one must not carry one). */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * JSON-RPC over HTTP(S) as an EIP-1193 request function (no batching; the executor decides what a failed read means).
 * Only `http:`/`https:` URLs; no credentials in the URL (a keyless endpoint is the documented default).
 *
 * SH-276: one retry rule only, `refusedRetryFetch` (refused-fetch.ts, shared with Create's viem transports since
 * SH-278). A request the endpoint refused with HTTP 429 was not served, so the same request is sent again to the same
 * endpoint, up to `refusedRetries` more times (each try with its own timeout, which covers the answer's body too); then
 * the error is as before. Nothing else is tried again: no other status, no JSON-RPC error, no timeout or unreachable
 * endpoint, no shape error, and never another endpoint. The site's reader sends no transaction (the wallet does), so
 * every method it asks may be repeated. An EIP-1193 request carries no abort signal: a caller that moved on lets the
 * pauses run out (at most 3.1 s with the default pauses).
 */
export function createHttpRequest(url: string, options: HttpRequestOptions = {}): Eip1193Request {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new RangeError('RPC URL must be http(s)');
  if (parsed.username !== '' || parsed.password !== '') throw new RangeError('RPC URL must not carry credentials');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const doFetch = options.fetch ?? fetch;
  let id = 0;
  return async ({ method, params }) => {
    id += 1;
    let timedOut = false;
    // One try: its own timeout over the request and the answer's body (read here, so a stalled body is a timeout too).
    const oneTry: FetchLike = async (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await doFetch(input, { ...init, signal: controller.signal });
        const text = await response.text();
        return new Response(NO_BODY.has(response.status) ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally {
        clearTimeout(timer);
      }
    };
    let response: Response;
    try {
      response = await refusedRetryFetch(oneTry, { retries: options.refusedRetries })(parsed.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? [] }),
      });
    } catch {
      throw new RpcRequestError(timedOut ? `${method} timed out` : `${method} could not reach the RPC`, null, undefined);
    }
    if (!response.ok) throw new RpcRequestError(`RPC HTTP ${response.status}`, null, undefined);
    let json: unknown;
    try { json = await response.json(); } catch { throw new RpcRequestError(`${method} could not reach the RPC`, null, undefined); }
    const body = record(json, 'JSON-RPC response');
    if (body.error !== undefined) {
      const e = record(body.error, 'JSON-RPC error');
      throw new RpcRequestError(typeof e.message === 'string' ? e.message : 'JSON-RPC error', typeof e.code === 'number' ? e.code : null, e.data);
    }
    if (!('result' in body)) throw new RpcShapeError('JSON-RPC response has no result');
    return body.result;
  };
}
