/**
 * A fake JSON-RPC node for the adapter's tests (review round 1, finding L5): it answers `eth_call` from handlers keyed
 * by `address:function`, encoding results with the keeper's own ABIs, and records `eth_getLogs` ranges and raw sends.
 * A handler that throws `REVERT` answers as a node does for a revert; any other throw is a transport failure.
 */
import {
  RpcRequestError, createPublicClient, custom, decodeFunctionData, encodeFunctionResult,
  erc20Abi, keccak256, numberToHex, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex, type PublicClient,
} from 'viem';
import { ABI_SOURCES } from '../../src/abi';

export const REVERT = new Error('revert');

const functionsFor = (version: number) => ABI_SOURCES.filter((s) => version === 2 ? !['hookV1', 'receiverV1'].includes(s.name) : !['hookV2', 'receiverV2'].includes(s.name)).flatMap((s) => s.abi).filter((i): i is AbiFunction => i.type === 'function');

// ABI sources are immutable. Keep first-match precedence without hashing every selector on every RPC call.
const selectorTables = new Map<number, Map<string, AbiFunction>>();
function functionFor(version: number, selector: string): AbiFunction | undefined {
  let table = selectorTables.get(version);
  if (!table) {
    table = new Map();
    for (const item of [...functionsFor(version), ...erc20Abi.filter(f => f.type === 'function')]) {
      const key = toFunctionSelector(item);
      if (!table.has(key)) table.set(key, item);
    }
    selectorTables.set(version, table);
  }
  return table.get(selector);
}

export interface FakeNode {
  block: { number: bigint; timestamp: bigint; baseFeePerGas: bigint };
  chainId: number;
  versions: Record<string, 1 | 2>;
  calls: Record<string, (args: readonly unknown[]) => unknown>;
  /** Each account's count as the node reports it (it never sees a private send). */
  counts: Record<string, number>;
  logs: (address: Address, from: bigint, to: bigint) => readonly Record<string, unknown>[];
  ranges: { address: Address; from: bigint; to: bigint }[];
  sent: { endpoint: string; raw: Hex }[];
  /** Raw node reply, or a handler for transport-failure tests. */
  estimateGas: Hex | ((params: readonly unknown[]) => Hex);
  /** Throws to reject a send. */
  onSend: (raw: Hex, endpoint: string) => void;
  /** SH-249: the mined (`latest`) count; without it every tag answers from `counts`. */
  latestCounts?: Record<string, number>;
  /** SH-249: answers every count read (a lagging or load-balanced node); overrides both maps. */
  countOf?: (address: string, tag: string) => number;
  /** SH-249: `eth_getTransactionReceipt`; absent, the method is unsupported, as before. A throw is a refusal. */
  receipt?: (hash: Hex) => Record<string, unknown> | null;
  /** SH-249: the finalized header, and canonical hashes of numbered blocks; absent, headers carry no hash, as before. */
  finalized?: { number: bigint; hash: Hex };
  blockHashes?: Record<string, Hex>;
  /** SH-250: a numbered block's transactions (hash, from, nonce) when asked with full transactions. */
  blockTxs?: (n: bigint) => readonly Record<string, unknown>[];
  /** SH-249 report: balances, and `eth_getTransactionByHash`; absent, both methods are unsupported. */
  balances?: Record<string, bigint>;
  transaction?: (hash: Hex) => Record<string, unknown> | null;
  /** Every method asked, in order (SH-249 read counts). */
  asked?: string[];
  /** SH-259: `eth_gasPrice`; absent, the method is unsupported. A throw is a failed quote; a non-bigint is answered raw. */
  gasPrice?: () => unknown;
}

export function fakeNode(over: Partial<FakeNode> = {}): FakeNode {
  return {
    block: { number: 1_000n, timestamp: 1_791_302_405n, baseFeePerGas: 10n ** 9n }, chainId: 11_155_111, versions: {}, calls: {}, counts: {},
    logs: () => [], ranges: [], sent: [], estimateGas: '0x186a0', onSend: () => {}, ...over,
  };
}

const revertError = () => new RpcRequestError({ body: {}, url: 'fake', error: { code: 3, message: 'execution reverted', data: '0x' } });

function call(node: FakeNode, tx: { to: Address; data: Hex }): Hex {
  const item = functionFor(node.versions[tx.to.toLowerCase()] ?? 1, tx.data.slice(0, 10));
  if (!item) throw new Error(`no ABI for ${tx.data.slice(0, 10)}`);
  const abi: Abi = [item];
  const { args } = decodeFunctionData({ abi, data: tx.data });
  const handler = node.calls[`${tx.to.toLowerCase()}:${item.name}`];
  if (!handler) throw revertError();
  let result: unknown;
  try {
    result = handler(args ?? []);
  } catch (error) {
    throw error === REVERT ? revertError() : error;
  }
  return encodeFunctionResult({ abi, functionName: item.name, result } as never);
}

function logsOf(node: FakeNode, filter: { address: Address; fromBlock: Hex; toBlock: Hex }) {
  const [from, to] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)];
  node.ranges.push({ address: filter.address, from, to });
  return node.logs(filter.address, from, to);

}

/** A public client on the fake node; `endpoint` names it in `sent`. */
export function fakeClient(node: FakeNode, endpoint = 'public'): PublicClient {
  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const p = (params ?? []) as unknown[];
    node.asked?.push(method === 'eth_getTransactionCount' ? `${method}:${String(p[1])}` : method);
    switch (method) {
      case 'eth_chainId': return numberToHex(node.chainId);
      case 'eth_blockNumber': return numberToHex(node.block.number - 1n);
      case 'eth_getBlockByNumber': {
        const tag = String(p[0]);
        if (tag === 'finalized' && node.finalized) {
          return { number: numberToHex(node.finalized.number), timestamp: numberToHex(node.block.timestamp), baseFeePerGas: numberToHex(node.block.baseFeePerGas),
            hash: node.finalized.hash, transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0' };
        }
        const known = tag.startsWith('0x') ? node.blockHashes?.[BigInt(tag).toString()] : undefined;
        if (known) {
          return { number: tag, timestamp: numberToHex(node.block.timestamp), baseFeePerGas: numberToHex(node.block.baseFeePerGas),
            hash: known, transactions: p[1] === true ? node.blockTxs?.(BigInt(tag)) ?? [] : [], gasLimit: '0x1c9c380', gasUsed: '0x0' };
        }
        return {
          number: numberToHex(node.block.number), timestamp: numberToHex(node.block.timestamp), baseFeePerGas: numberToHex(node.block.baseFeePerGas),
          hash: null, transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0',
        };
      }
      case 'eth_call': return call(node, p[0] as { to: Address; data: Hex });
      case 'eth_estimateGas': return typeof node.estimateGas === 'function' ? node.estimateGas(p) : node.estimateGas;
      case 'eth_getLogs': return logsOf(node, p[0] as { address: Address; fromBlock: Hex; toBlock: Hex });
      case 'eth_getTransactionCount': {
        const who = (p[0] as string).toLowerCase(), tag = String(p[1]);
        if (node.countOf) return numberToHex(node.countOf(who, tag));
        const map = tag === 'latest' && node.latestCounts ? node.latestCounts : node.counts;
        return numberToHex(map[who] ?? 0);
      }
      case 'eth_getBalance': {
        if (!node.balances) throw new Error(`fake node: ${method}`);
        return numberToHex(node.balances[(p[0] as string).toLowerCase()] ?? 0n);
      }
      case 'eth_getTransactionByHash': {
        if (!node.transaction) throw new Error(`fake node: ${method}`);
        return node.transaction(p[0] as Hex);
      }
      case 'eth_getTransactionReceipt': {
        if (!node.receipt) throw new Error(`fake node: ${method}`);
        return node.receipt(p[0] as Hex);
      }
      case 'eth_gasPrice': {
        if (!node.gasPrice) throw new Error(`fake node: ${method}`);
        const quote = node.gasPrice();
        return typeof quote === 'bigint' ? numberToHex(quote) : quote;
      }
      case 'eth_sendRawTransaction': {
        const raw = p[0] as Hex;
        node.onSend(raw, endpoint);
        node.sent.push({ endpoint, raw });
        return keccak256(raw);
      }
      default: throw new Error(`fake node: ${method}`);
    }
  };
  return createPublicClient({ transport: custom({ request }, { retryCount: 0 }) });
}

/** For tests outside this package (infra/server), which resolve no viem of their own. */
export { keccak256, parseTransaction } from 'viem';
