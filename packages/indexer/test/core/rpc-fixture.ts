/** In-process JSON-RPC fixture: records actual wire requests, without sockets or network. */
import { decodeFunctionData, encodeFunctionResult, parseAbi, toHex, type Address, type Hex } from 'viem';
import { vi } from 'vitest';
import type { ScriptedCoreChain } from './scripted-core-chain';

export const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const addressRefusal = { status: 403, code: -32602,
  message: 'A maximum of 10 addresses is allowed. No limit on a dedicated node: https://www.allnodes.com/publicnode' };
export const aggregateAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
export interface Request { readonly method: string; readonly params: readonly unknown[] }
export interface RecordedRequest extends Request { readonly url: string }
export function fakeRpc(answer: (request: RecordedRequest) => Promise<unknown> | unknown) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Request & { id: number };
    const request = { url: new URL(String(url)).origin, method: body.method, params: body.params ?? [] };
    requests.push(request);
    try {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: await answer(request) });
    } catch (error) {
      const e = error as { status?: number; code?: number; message: string; data?: unknown };
      if (e.status && e.code === undefined) return new Response(e.message, { status: e.status });
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: e.code ?? -32000, message: e.message, ...(e.data ? { data: e.data } : {}) } },
        { status: e.status ?? 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  });
  return requests;
}

export interface AggregateSize { subcalls: number; calldataBytes: number; responseBytes: number }
export function chainRpcAnswer(chain: ScriptedCoreChain, multicall = true, observe?: (size: AggregateSize) => void) {
  return async ({ method, params }: Request) => {
    if (method === 'eth_chainId') return toHex(chain.id);
    if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') {
      const block = method === 'eth_getBlockByHash' ? await chain.headerByHash(params[0] as Hex)
        : await chain.headerByNumber(params[0] === 'latest' ? chain.tip : BigInt(params[0] as string));
      return block ? { ...block, number: toHex(block.number), timestamp: toHex(block.timestamp), transactions: [] } : null;
    }
    const hash = (params[1] as { blockHash: Hex } | undefined)?.blockHash;
    if (method === 'eth_getCode') {
      if (String(params[0]).toLowerCase() === MULTICALL.toLowerCase()) return multicall ? '0x6000' : '0x';
      return chain.codeAt(params[0] as Address, hash as Hex);
    }
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: Address; data: Hex };
      if (to.toLowerCase() !== MULTICALL.toLowerCase()) return chain.callAt(to, data, hash as Hex);
      if (!multicall) throw new Error('no Multicall3 code');
      const { args: [calls] } = decodeFunctionData({ abi: aggregateAbi, data });
      const result = await Promise.all(calls.map(async call => {
        try { return { success: true, returnData: await chain.callAt(call.target, call.callData, hash as Hex) }; }
        catch (error) {
          const e = error as { code?: number; data?: Hex };
          if (e.code !== 3) throw error; // Transport refusals are not EVM reverts.
          return { success: false, returnData: e.data ?? '0x' as Hex };
        }
      }));
      const encoded = encodeFunctionResult({ abi: aggregateAbi, functionName: 'aggregate3', result });
      observe?.({ subcalls: calls.length, calldataBytes: (data.length - 2) / 2, responseBytes: (encoded.length - 2) / 2 });
      return encoded;
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { address: Address | Address[]; topics: (Hex[] | null)[]; blockHash?: Hex; fromBlock?: Hex; toBlock?: Hex };
      const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map(a => a.toLowerCase());
      const logs = [...chain.logsOf.values()].flat().filter(log => addresses.includes(log.address.toLowerCase())
        && (filter.blockHash ? log.blockHash === filter.blockHash : log.blockNumber >= BigInt(filter.fromBlock as Hex) && log.blockNumber <= BigInt(filter.toBlock as Hex))
        && filter.topics.every((topic, i) => !topic || topic.some(t => t.toLowerCase() === log.topics[i]?.toLowerCase())));
      return logs.map(log => ({ ...log, blockNumber: toHex(log.blockNumber), transactionIndex: toHex(log.transactionIndex), logIndex: toHex(log.logIndex) }));
    }
    throw new Error(`unhandled RPC method ${method}`);
  };
}

export function fixtureRpc(chain: ScriptedCoreChain, multicall = true, observe?: (size: AggregateSize) => void) {
  return fakeRpc(chainRpcAnswer(chain, multicall, observe));
}

export function counts(requests: readonly Request[]) {
  const out: Record<string, number> = {};
  for (const { method } of requests) out[method] = (out[method] ?? 0) + 1;
  return out;
}
