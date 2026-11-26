/**
 * R2: the RPC reader's anchored range reads. Two local JSON-RPC endpoints (no network): one still on another branch
 * (or lagging, or moving during the read), one on the anchor's. An anchored read takes its logs only from an endpoint
 * that holds every anchor before and after its `eth_getLogs`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { RpcCoreReader, type CoreReader, type LogFilter } from '../../src/core/core-reader';

const h = (c: string): Hex => `0x${c.repeat(64)}` as Hex;
const ADDRESS = `0x${'11'.repeat(20)}`;
const FILTER: LogFilter = { addresses: [ADDRESS as Hex], topics: [h('7')], poolManager: null, poolIds: [], poolTopics: [],
  settlementAddresses: [], settlementTopics: [], settlementOwners: [] };

interface Endpoint {
  /** Hash this endpoint has at each number (absent: it does not have the block yet). */
  readonly hashes: Map<bigint, Hex>;
  readonly logBlockHash: Hex;
  getLogs: number;
  /** Runs right after this endpoint answers an `eth_getLogs` (a reorg on that node during the read). */
  readonly afterGetLogs?: (endpoint: Endpoint) => void;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
});

async function serve(endpoint: Endpoint): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      let result: unknown = null;
      if (method === 'eth_getBlockByNumber') {
        const n = BigInt(params[0] as string);
        const hash = endpoint.hashes.get(n);
        result = hash ? { number: `0x${n.toString(16)}`, hash, parentHash: h('0'), timestamp: '0x1', transactions: [], logsBloom: `0x${'0'.repeat(512)}`, gasLimit: '0x1', gasUsed: '0x0', miner: ADDRESS, difficulty: '0x0', extraData: '0x', size: '0x1', uncles: [] } : null;
      } else if (method === 'eth_getLogs') {
        endpoint.getLogs += 1;
        result = [{ address: ADDRESS, topics: [h('7')], data: '0x', blockNumber: '0x32', blockHash: endpoint.logBlockHash, transactionHash: h('9'), transactionIndex: '0x0', logIndex: '0x0', removed: false }];
        endpoint.afterGetLogs?.(endpoint);
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ANCHOR = { number: 69n, hash: h('b') };

describe('R2: anchored range reads', () => {
  it('skips an endpoint on another branch and reads from one on the anchor', async () => {
    const stale: Endpoint = { hashes: new Map([[69n, h('a')]]), logBlockHash: h('a'), getLogs: 0 };
    const live: Endpoint = { hashes: new Map([[69n, h('b')]]), logBlockHash: h('c'), getLogs: 0 };
    const reader: CoreReader = new RpcCoreReader({ urls: [await serve(stale), await serve(live)] });
    const logs = await reader.rangeLogs(10n, 69n, FILTER, [ANCHOR]);
    expect(logs.map((l) => l.blockHash)).toEqual([h('c')]);
    expect(stale.getLogs).toBe(0);
  });

  it('skips a lagging endpoint (it lacks the anchor block)', async () => {
    const lagging: Endpoint = { hashes: new Map(), logBlockHash: h('a'), getLogs: 0 };
    const live: Endpoint = { hashes: new Map([[69n, h('b')]]), logBlockHash: h('c'), getLogs: 0 };
    const reader: CoreReader = new RpcCoreReader({ urls: [await serve(lagging), await serve(live)] });
    expect((await reader.rangeLogs(10n, 69n, FILTER, [ANCHOR])).map((l) => l.blockHash)).toEqual([h('c')]);
  });

  it('drops an answer from an endpoint that leaves the anchor during the read', async () => {
    const moving: Endpoint = { hashes: new Map([[69n, h('b')]]), logBlockHash: h('a'), getLogs: 0, afterGetLogs: (e) => e.hashes.set(69n, h('a')) };
    const live: Endpoint = { hashes: new Map([[69n, h('b')]]), logBlockHash: h('c'), getLogs: 0 };
    const reader: CoreReader = new RpcCoreReader({ urls: [await serve(moving), await serve(live)] });
    expect((await reader.rangeLogs(10n, 69n, FILTER, [ANCHOR])).map((l) => l.blockHash)).toEqual([h('c')]);
    expect(moving.getLogs).toBe(1);
  });

  it('refuses when no endpoint holds the anchor', async () => {
    const stale: Endpoint = { hashes: new Map([[69n, h('a')]]), logBlockHash: h('a'), getLogs: 0 };
    const reader: CoreReader = new RpcCoreReader({ urls: [await serve(stale)] });
    await expect(reader.rangeLogs(10n, 69n, FILTER, [ANCHOR])).rejects.toThrow(/not on block 69/);
  });

  it('without anchors reads as before (the first endpoint answers)', async () => {
    const stale: Endpoint = { hashes: new Map([[69n, h('a')]]), logBlockHash: h('a'), getLogs: 0 };
    const live: Endpoint = { hashes: new Map([[69n, h('b')]]), logBlockHash: h('c'), getLogs: 0 };
    const reader: CoreReader = new RpcCoreReader({ urls: [await serve(stale), await serve(live)] });
    expect((await reader.rangeLogs(10n, 69n, FILTER)).map((l) => l.blockHash)).toEqual([h('a')]);
  });
});
