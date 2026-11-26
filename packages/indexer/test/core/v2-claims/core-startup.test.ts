import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { readAllWalletClaimsV2 } from '../../../../chain/src/core/v2/claims-reader';
import { startCoreService } from '../../../src/core/core-service';
import { receiverV2Abi } from '../../../src/core/v2/chain-v2';
import { claimsRpcReaderV2 } from '../../../src/core/v2/claims-reads-v2';
import { A, B, m2Fixture } from '../../../src/core/v2/m2-fixture.test-support';
import { MemoryHistory } from '../../../src/history/memory-history';
import { HistoryWriter } from '../../../src/history/writer';
import { World } from '../core-synth';
import { boxLogsV2, receiverEventV2, serviceChainV2 } from '../scripted-core-chain';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** Only the OS listener is doubled: requests still enter the real server's installed request handler. */
function memoryListener() {
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
    const ready = args.at(-1);
    if (typeof ready !== 'function') throw new Error('missing listening callback');
    ready();
    return this;
  });
  const request = (path: string): Promise<Response> => new Promise((resolve, reject) => {
    const server = listen.mock.contexts[0] as Server | undefined;
    if (!server) return reject(new Error('service did not start its HTTP server'));
    let status = 0;
    let headers: Record<string, string> = {};
    const response = {
      writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
      end(body: string) { resolve(new Response(body, { status, headers })); },
    };
    server.emit('request', { method: 'GET', url: path, headers: {} } as IncomingMessage, response as unknown as ServerResponse);
  });
  return { listen, request };
}

it.each([false, true])('FE5-01 core startup serves feed and complete claims on one server (refused=%s)', async refused => {
  vi.useFakeTimers();
  const http = memoryListener();
  const f = m2Fixture(false);
  const amount = (1n << 120n) + 17n;
  const world = new World('core-claims-startup'); world.block(10n);
  world.block(100n, [boxLogsV2(f)]);
  world.block(101n, [receiverEventV2(f, 'CreatorClaimed', { payee: A, to: B, amount: 7n })]);
  world.to(105n);
  const chain = serviceChainV2(world, [f], (_box, key) => {
    if (key === 'receiver.buyersChoice') return 4;
    if (key === 'receiver.creatorPayee') return A;
    if (key === 'coordinator.graduated') return true;
    return undefined;
  });
  const quoteAbi = parseAbi(['function quote(address receiver,address asset) returns (uint256)']);
  const request = vi.fn(async ({ method, params }: { method: string; params: [{ to: Address; from?: Address; data: Hex; gas?: Hex }, { blockHash: Hex; requireCanonical: boolean }, unknown?] }) => {
    expect(method).toBe('eth_call');
    const [call, block, override] = params;
    expect(block).toEqual({ blockHash: chain.header(105n).hash, requireCanonical: true });
    if (!call.from) return chain.callAt(call.to, call.data, block.blockHash);
    expect(call.from).toBe(A.toLowerCase());
    expect(call.gas).toBe('0x4c4b40');
    if (override) {
      expect(refused).toBe(true);
      expect(call.to).toBe(A.toLowerCase());
      expect(decodeFunctionData({ abi: quoteAbi, data: call.data }).args?.map(address => address.toLowerCase())).toEqual([f.at(5).toLowerCase(), f.row.q.toLowerCase()]);
      return encodeFunctionResult({ abi: quoteAbi, functionName: 'quote', result: amount });
    }
    expect(call.to.toLowerCase()).toBe(f.at(5).toLowerCase());
    const decoded = decodeFunctionData({ abi: receiverV2Abi, data: call.data });
    expect(decoded.functionName).toBe('claimCreator');
    if (decoded.functionName !== 'claimCreator') throw new Error('unexpected simulation');
    expect(decoded.args.map(address => address.toLowerCase())).toEqual([f.row.q.toLowerCase(), A.toLowerCase()]);
    if (refused) throw Object.assign(new Error('payment refused'), { data: encodeErrorResult({
      abi: parseAbi(['error TransferNotExact(uint256 expected,uint256 received)']), errorName: 'TransferNotExact', args: [amount, 0n],
    }) });
    return encodeFunctionResult({ abi: receiverV2Abi, functionName: 'claimCreator', result: amount });
  });
  const claimsReader = claimsRpcReaderV2({ request, getBlock: ({ blockNumber }: { blockNumber: bigint }) => chain.headerByNumber(blockNumber) } as unknown as Pick<PublicClient, 'request' | 'getBlock'>);
  const history = new MemoryHistory();
  await history.init();
  const writer = new HistoryWriter(history);
  const service = await startCoreService({
    reader: chain, claimsReader, manifest: f.manifest, host: '127.0.0.1', port: 5391,
    auditEvery: 10_000, onHistory: writer.accept, history, historyHealth: () => writer.health(),
  });
  try {
    await vi.advanceTimersByTimeAsync(0); // real HeadFeed's initial poll establishes chain liveness
    await service.indexer.idle(); await writer.idle();
    expect(service.indexer.metrics.errors).toBe(0);
    expect(service.indexer.boxesV2.size).toBe(1);
    expect(http.listen).toHaveBeenCalledExactlyOnceWith(5391, '127.0.0.1', expect.any(Function));
    const feed = await http.request('/v2/feed');
    expect(feed.status).toBe(200);
    expect((await feed.json()).cards).toHaveLength(1);
    const path = `/v2/wallets/${f.row.chainId}/${A}/claims`;
    const response = await http.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const page = await response.json();
    expect(page).toMatchObject({ schema: 'sh.core-claims.v2', chainId: f.row.chainId, wallet: A.toLowerCase(),
      asOf: { block: '105', hash: chain.header(105n).hash, timestamp: String(chain.header(105n).timestamp), tier: 'head' }, recentFromBlock: '0', next: null });
    expect(page.items).toHaveLength(2);
    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'creator', status: 'claimable', amountP: String(amount), payout: refused ? 'unavailable' : 'available', payment: null }),
      expect.objectContaining({ kind: 'creator', status: 'claimed', amountP: '7', payout: 'paid', payment: expect.objectContaining({ to: B.toLowerCase(), grossP: '7', tipP: '0' }) }),
    ]));
    const all = await readAllWalletClaimsV2({ baseUrl: 'https://index.example', chainId: f.row.chainId, wallet: A, limit: 1,
      fetch: input => http.request(new URL(String(input)).pathname + new URL(String(input)).search) });
    expect(all.items).toEqual(page.items);
    expect((await history.dump(f.row.chainId)).activity.length).toBeGreaterThan(0);
    expect((await http.request('/v1/feed')).status).toBe(200);
    expect((await http.request('/healthz')).status).toBe(200);
    expect((await http.request(`/v2/wallets/999/${A}/claims`)).status).toBe(404);
    const read = vi.spyOn(chain, 'headerByNumber').mockRejectedValue(new Error('RPC unavailable'));
    expect((await http.request(path)).status).toBe(503);
    read.mockRestore();
    if (!service.feed) throw new Error('service did not start its head feed');
    vi.spyOn(service.feed, 'lastHeardMs').mockReturnValue(null);
    expect((await http.request(path)).status).toBe(503);
  } finally {
    await service.stop(); writer.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});
