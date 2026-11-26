import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { createOptionsDirectoryOf } from '../../../src/core/core-config';
import { idleUntilDeployed } from '../../../src/core/idle';
import { startCoreService, type RunningCoreService } from '../../../src/core/core-service';
import { receiverV2Abi } from '../../../src/core/v2/chain-v2';
import { creatorQuoteCodeV2 } from '../../../src/core/v2/claims-quote-code';
import { A, H, m2Fixture } from '../../../src/core/v2/m2-fixture.test-support';

// Only the listening address is a stand-in. Every other reader of the settings is the module's own, as on the server.
vi.mock('../../../src/core/core-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/core-config')>()),
  idleOptionsOf: () => ({ port: 5391, host: '127.0.0.1', manifestPollMs: 1000 }),
}));
vi.mock('../../../src/core/idle', () => ({ idleUntilDeployed: vi.fn() }));
vi.mock('../../../src/core/core-service', () => ({ startCoreService: vi.fn() }));
vi.mock('../../../src/history/history-service', () => ({ startHistory: async () => null }));
vi.mock('../../../src/service', () => ({ logLine: vi.fn() }));
vi.mock('../../../src/core/redact', () => ({ redactConsole: vi.fn(), urlRedactor: vi.fn(), redactUrl: (url: string) => url }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('FE5-01 CLI supplies canonical sender and override reads with the configured RPC fallback', async () => {
  const f = m2Fixture(false);
  const urls = ['https://rpc-a.example/', 'https://rpc-b.example/'];
  vi.mocked(idleUntilDeployed).mockResolvedValue({
    manifest: f.manifest, httpUrls: urls, wsUrls: [], port: 5391, host: '127.0.0.1', pollMs: 1000,
    history: { kind: 'memory' }, art: { gateways: [], dir: null }, maxStreamsPerClient: 3, trustedProxies: [],
  } as unknown as Awaited<ReturnType<typeof idleUntilDeployed>>);
  vi.mocked(startCoreService).mockResolvedValue({ indexer: { head: () => null, boxes: new Map() }, stop: async () => undefined } as unknown as RunningCoreService);
  // Import the actual CLI without installing process handlers in the test worker.
  vi.spyOn(process, 'on').mockReturnValue(process);
  const rpc = vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).startsWith(urls[0] ?? 'missing')) return new Response('unavailable', { status: 503 });
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    expect(body.method).toBe('eth_call');
    expect(body.params[1]).toEqual({ blockHash: H(100), requireCanonical: true });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id,
      result: encodeFunctionResult({ abi: receiverV2Abi, functionName: 'claimCreator', result: 1234n }) }),
    { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', rpc);
  await import('../../../src/core/core-main');
  await vi.waitFor(() => expect(startCoreService).toHaveBeenCalledOnce());
  const options = vi.mocked(startCoreService).mock.calls[0]?.[0];
  expect(options?.claimsReader?.callFromAt).toBeTypeOf('function');
  expect(options?.claimsReader?.creatorEntitlementAt).toBeTypeOf('function');
  if (!options?.claimsReader?.callFromAt || !options.claimsReader.creatorEntitlementAt) throw new Error('missing CLI claims reader');
  expect(rpc).not.toHaveBeenCalled();
  expect(options).toMatchObject({ port: 5391, host: '127.0.0.1', maxStreamsPerClient: 3, trustedProxies: [] });
  // SH-218: the service gets the folder of Create lists that the settings reader chose (the packaged lists when unset).
  expect(options.createOptionsDirectory).toEqual(createOptionsDirectoryOf());
  const data: Hex = '0x1234';
  await options.claimsReader.callFromAt(A, f.at(5), data, H(100));
  expect(await options.claimsReader.creatorEntitlementAt(A, f.at(5), f.row.q, H(100))).toBe(1234n);
  expect(rpc.mock.calls.map(([url]) => String(url))).toEqual([urls[0], urls[1], urls[0], urls[1]]);
  const sent = rpc.mock.calls.filter(([url]) => url === urls[1]).map(([, init]) => JSON.parse(String(init.body)) as { params: unknown[] });
  expect(sent[0]?.params).toEqual([{ from: A, to: f.at(5), data, gas: '0x4c4b40' }, { blockHash: H(100), requireCanonical: true }]);
  const quoteAbi = parseAbi(['function quote(address receiver,address asset) returns (uint256)']);
  // The quote and the ordinary simulation share the same gas/hash contract. Only the quote overrides code.
  expect(sent[1]?.params).toEqual([
    { from: A, to: A, data: expect.stringMatching(/^0x/), gas: '0x4c4b40' },
    { blockHash: H(100), requireCanonical: true }, { [A]: { code: creatorQuoteCodeV2 } },
  ]);
  const quote = sent[1]?.params[0] as { data: Hex };
  expect(decodeFunctionData({ abi: quoteAbi, data: quote.data }).args?.map(address => address.toLowerCase())).toEqual([f.at(5).toLowerCase(), f.row.q.toLowerCase()]);
});
