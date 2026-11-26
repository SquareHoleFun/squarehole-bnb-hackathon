import { decodeFunctionData, encodeFunctionResult, multicall3Abi, toHex, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { receiverV2Abi } from '../../src/abi';
import { receiptLogs } from './income-receipts';
import { pm, safe, type incomeChain, type Log } from './income-chain';
import { keeper } from './v2';

type Chain = ReturnType<typeof incomeChain>;
type Request = { id: number; jsonrpc: string; method: string; params?: unknown[] };
type Filter = { address?: string | string[]; topics?: (string | string[] | null)[]; fromBlock?: string; toBlock?: string };

/**
 * SH-247: the income chain fixture behind a JSON-RPC `fetch`, so the server's own driver (infra/server/services/keeper.mjs,
 * which run.mjs starts) reads it through its real transport, batching and multicall. Answers only what the income
 * reading asks: chain id, headers, the receivers' wiring views, logs by address and topics, and receipts.
 */
export function incomeRpc(f: Chain) {
  const calls: string[] = [];
  const encoded = new Map<Log, ReturnType<typeof receiptLogs>[number]>();
  const encode = (l: Log) => {
    let e = encoded.get(l);
    if (!e) { e = receiptLogs([l])[0]; if (!e) throw new Error('fixture log'); encoded.set(l, e); }
    return e;
  };
  const json = (l: Log) => {
    const e = encode(l);
    return { address: l.address, topics: e.topics, data: e.data, blockNumber: toHex(l.blockNumber), blockHash: l.blockHash,
      transactionHash: l.transactionHash, transactionIndex: '0x0', logIndex: toHex(l.logIndex), removed: l.removed };
  };
  const block = (n: bigint) => ({ number: toHex(n), hash: toHex(n, { size: 32 }), parentHash: toHex(n > 0n ? n - 1n : 0n, { size: 32 }),
    timestamp: toHex(f.stamp(n)), baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], uncles: [],
    logsBloom: `0x${'00'.repeat(256)}`, miner: `0x${'00'.repeat(20)}`, difficulty: '0x0', extraData: '0x', size: '0x0',
    nonce: '0x0000000000000000', mixHash: toHex(0n, { size: 32 }), sha3Uncles: toHex(0n, { size: 32 }),
    stateRoot: toHex(0n, { size: 32 }), receiptsRoot: toHex(0n, { size: 32 }), transactionsRoot: toHex(0n, { size: 32 }) });
  const view = (to: string, data: Hex): Hex => {
    const x = f.boxes.find(b => b.receiver.toLowerCase() === to.toLowerCase());
    if (!x) throw new Error('no fixture contract');
    const { functionName } = decodeFunctionData({ abi: receiverV2Abi, data });
    const result = functionName === 'q' ? x.v2?.q : functionName === 'PLATFORM_SAFE' ? safe : functionName === 'poolManager' ? pm : undefined;
    if (result === undefined) throw new Error('no fixture view');
    return encodeFunctionResult({ abi: receiverV2Abi, functionName, result } as never);
  };
  const matches = (l: Log, filter: Filter) => {
    const from = BigInt(filter.fromBlock ?? '0x0'), to = BigInt(filter.toBlock ?? '0x0');
    const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address ?? '']).map(a => a.toLowerCase());
    if (!addresses.includes(l.address.toLowerCase()) || l.blockNumber < from || l.blockNumber > to) return false;
    const topics = encode(l).topics as readonly string[];
    return (filter.topics ?? []).every((want, i) => want === null || (Array.isArray(want) ? want : [want])
      .some(w => w.toLowerCase() === topics[i]?.toLowerCase()));
  };
  const answer = (r: Request): unknown => {
    calls.push(r.method);
    const p = r.params ?? [];
    switch (r.method) {
      case 'eth_chainId': return toHex(sepolia.id);
      case 'eth_blockNumber': return toHex(f.state.final + 3n);
      case 'eth_getBlockByNumber': {
        const tag = p[0] as string;
        return block(tag === 'finalized' ? f.state.final : tag === 'latest' || tag === 'pending' ? f.state.final + 3n : BigInt(tag));
      }
      case 'eth_call': {
        const call = p[0] as { to: string; data: Hex };
        if (call.to.toLowerCase() !== sepolia.contracts.multicall3.address.toLowerCase()) return view(call.to, call.data);
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data });
        if (decoded.functionName !== 'aggregate3') throw new Error('no fixture multicall');
        const results = (decoded.args[0] as readonly { target: string; callData: Hex }[]).map(c => {
          try { return { success: true, returnData: view(c.target, c.callData) }; } catch { return { success: false, returnData: '0x' as Hex }; }
        });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
      }
      case 'eth_getLogs': {
        const filter = p[0] as Filter;
        const found = f.logs.filter(l => matches(l, filter)).map(json);
        for (const n of f.noise) if ((Array.isArray(filter.address) ? filter.address : [filter.address ?? ''])
          .some(a => a.toLowerCase() === n.address.toLowerCase())) {
          for (let i = 0; i < n.count; i++) { const l = n.row(i); if (matches(l, filter)) found.push(json(l)); }
        }
        return found;
      }
      case 'eth_getTransactionReceipt': {
        const rows = f.logs.filter(l => l.transactionHash === p[0]);
        const first = rows[0];
        if (!first) return null;
        return { transactionHash: first.transactionHash, transactionIndex: '0x0', blockHash: first.blockHash,
          blockNumber: toHex(first.blockNumber), status: '0x1', from: keeper, to: first.address,
          cumulativeGasUsed: '0x0', gasUsed: '0x0', effectiveGasPrice: '0x1', contractAddress: null, type: '0x2',
          logsBloom: `0x${'00'.repeat(256)}`, logs: rows.map(json) };
      }
      default: throw new Error(`no fixture for ${r.method}`);
    }
  };
  const reply = (r: Request) => {
    try { return { jsonrpc: '2.0', id: r.id, result: answer(r) }; }
    catch (error) { return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: error instanceof Error ? error.message : 'fixture' } }; }
  };
  const fetch = async (_url: unknown, options?: { body?: string }) => {
    const input = JSON.parse(options?.body ?? 'null') as Request | Request[];
    return new Response(JSON.stringify(Array.isArray(input) ? input.map(reply) : reply(input)), { headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls };
}
