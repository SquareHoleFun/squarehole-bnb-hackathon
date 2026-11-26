import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpRequestError, RpcRequestError, TimeoutError, createPublicClient, custom, type Transport, type Hex, type LocalAccount } from 'viem';
import { RPC_PRIMARY_REST_MS, keeperTransport } from '../src/rpc';
import { describeConfig, loadConfig, secretsOf } from '../src/config';
import { checkChainId, ViemChain } from '../src/chain';
import { runTick } from '../src/run';
import { fakeClient, fakeNode } from './support/fake-rpc';
import { addr, keeper, options, quiet } from './support/v2';
import { feesFor } from '../src/gas';
const mocks = vi.hoisted(() => ({ transports: new Map<string, Transport>() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), http: (url: string) => {
  const t = mocks.transports.get(url); if (!t) throw new Error('missing fake'); return t;
} }));
afterEach(() => { mocks.transports.clear(); vi.restoreAllMocks(); });
const primary = 'https://primary.invalid';
const secondary = 'https://fallback.invalid';
const config = () => ({ ...options(), rpcUrl: primary, rpcFallbackUrl: secondary });
const down = () => custom({ request: async () => { throw new Error('offline'); } }, { retryCount: 0 });

it('fails over reads, simulations and raw sends, checks chain once and logs use hourly', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
  const node = fakeNode(); node.calls[`${addr(1)}:requestGraduationWord`] = () => undefined;
  const fake = fakeClient(node); const requests = vi.fn(fake.transport.request);
  mocks.transports.set(primary, down()); mocks.transports.set(secondary, custom({ request: requests }, { retryCount: 0 }));
  const onFallback = vi.fn(); const cfg = config();
  const pub = createPublicClient({ transport: keeperTransport(cfg, { batch: false, retryCount: 0 }, onFallback) });
  await checkChainId(pub, cfg.chainId); expect(await pub.getBlockNumber()).toBe(node.block.number - 1n);
  const sign = vi.fn(async () => '0x1234' as Hex);
  const port = new ViemChain({ ...cfg, dryRun: false }, pub, keeper, { public: { address: keeper, signTransaction: sign } as unknown as LocalAccount, private: null }, null, quiet);
  const c = { job: 'drandRequestWord' as const, key: 'request', to: addr(1), fn: 'requestGraduationWord', args: [] };
  expect((await port.simulate(c, feesFor(1n, 0n))).ok).toBe(true);
  await port.send(c, 250000n, feesFor(1n, 0n), false);
  expect(node.sent).toHaveLength(1); expect(onFallback).toHaveBeenCalledExactlyOnceWith('rpc fallback in use');
  vi.spyOn(Date, 'now').mockReturnValue(1800003600000); await pub.getBlockNumber({ cacheTime: 0 });
  expect(onFallback).toHaveBeenCalledTimes(2);
});
it('refuses another chain for the process lifetime and logs it once', async () => {
  const request = vi.fn(async () => '0x1');
  mocks.transports.set(primary, down()); mocks.transports.set(secondary, custom({ request }, { retryCount: 0 }));
  const onFallback = vi.fn(); const pub = createPublicClient({ transport: keeperTransport(config(), { retryCount: 0 }, onFallback) });
  await expect(pub.getBlockNumber()).rejects.toThrow('rpc on another chain');
  request.mockResolvedValue('0xaa36a7');
  await expect(pub.getBlockNumber()).rejects.toThrow('rpc on another chain');
  expect(request).toHaveBeenCalledTimes(1); expect(onFallback).toHaveBeenCalledExactlyOnceWith('rpc fallback refused');
});
it('both down fails the tick, and a wrong primary can be skipped', async () => {
  mocks.transports.set(primary, down()); mocks.transports.set(secondary, down());
  let pub = createPublicClient({ transport: keeperTransport(config(), { retryCount: 0 }, () => {}) });
  let port = new ViemChain(config(), pub, keeper, { public: null, private: null }, null, quiet);
  await expect(runTick(port, {}, options(), quiet)).rejects.toThrow();
  mocks.transports.set(primary, custom({ request: async () => '0x1' }, { retryCount: 0 }));
  mocks.transports.set(secondary, custom({ request: fakeClient(fakeNode()).transport.request }, { retryCount: 0 }));
  pub = createPublicClient({ transport: keeperTransport(config(), { retryCount: 0 }, () => {}) });
  port = new ViemChain(config(), pub, keeper, { public: null, private: null }, null, quiet);
  await expect(port.read()).resolves.toBeDefined();
});
it('parses and redacts the fallback, describes only its host and pins both public entry points', () => {
  const env = { SH_KEEPER_RPC_URL: primary, SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
  const url = 'https://alice:secret@fallback.invalid/token?key=value';
  const cfg = loadConfig({ ...env, SH_KEEPER_RPC_FALLBACK_URL: url });
  expect(secretsOf(cfg)).toEqual(expect.arrayContaining([url, '/token?key=value', '?key=value', 'alice', 'secret']));
  expect(describeConfig(cfg)).toContain('rpc fallback fallback.invalid');
  expect(describeConfig(loadConfig(env))).toContain('rpc fallback none');
  expect(() => loadConfig({ ...env, SH_KEEPER_RPC_FALLBACK_URL: 'broken' })).toThrow(/SH_KEEPER_RPC_FALLBACK_URL/);
  for (const file of ['../src/main.ts', '../../../infra/server/services/keeper.mjs']) {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toMatch(/createPublicClient\(\{ chain, transport: keeperTransport\(cfg,/);
  }
});

// Review of rc8 part 1 (P1R-1): viem's fallback asks the primary first on every request, and the primary's own http
// transport waits for its timeout and retries (the server: 15 s, one retry). A primary that hangs instead of refusing
// would cost about 30 s per request, so a tick of tens of sequential reads outlives the service's 240 s cycle limit
// and the fallback never finishes a tick. After a transport failure (no answer: a timeout or an HTTP error) the primary
// rests for RPC_PRIMARY_REST_MS and the fallback answers at once; a JSON-RPC error from a node that answered does not
// rest it, and a keeper without a fallback never rests its only endpoint.
it('rests a primary that times out or fails over HTTP, so the fallback answers without waiting on it again', async () => {
  let now = 1800000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const REST = 300_000;
  const node = fakeNode(); const backup = fakeClient(node).transport.request;
  let mode: 'hang' | 'http' | 'rpc' | 'up' = 'hang';
  const primaryCalls = vi.fn(async (args: { method: string; params?: unknown }) => {
    if (mode === 'hang') throw new TimeoutError({ body: { method: args.method }, url: primary });
    if (mode === 'http') throw new HttpRequestError({ url: primary, status: 503 });
    if (mode === 'rpc' && args.method !== 'eth_chainId') throw new RpcRequestError({ body: {}, url: primary, error: { code: -32000, message: 'header not found' } });
    return backup(args as never);
  });
  const backupCalls = vi.fn(backup);
  mocks.transports.set(primary, custom({ request: primaryCalls }, { retryCount: 0 }));
  mocks.transports.set(secondary, custom({ request: backupCalls }, { retryCount: 0 }));
  const pub = createPublicClient({ transport: keeperTransport(config(), { batch: false, retryCount: 0 }, () => {}) });
  const read = () => pub.getBlockNumber({ cacheTime: 0 });
  for (let i = 0; i < 6; i++) expect(await read()).toBe(node.block.number - 1n);
  expect(primaryCalls).toHaveBeenCalledTimes(1);
  now += REST - 1; await read(); expect(primaryCalls).toHaveBeenCalledTimes(1);
  now += 2; await read(); expect(primaryCalls).toHaveBeenCalledTimes(2);
  mode = 'http'; now += REST + 1; await read(); await read(); expect(primaryCalls).toHaveBeenCalledTimes(3);
  // A node that answers, even with an error, is not resting: the next request asks it again.
  mode = 'rpc'; now += REST + 1; await read(); await read(); expect(primaryCalls).toHaveBeenCalledTimes(3 + 2 + 1);
  mode = 'up'; const before = backupCalls.mock.calls.length; await read();
  expect(backupCalls.mock.calls.length).toBe(before);
  // Without a fallback the only endpoint is asked every time.
  mode = 'hang'; primaryCalls.mockClear();
  const alone = createPublicClient({ transport: keeperTransport({ ...config(), rpcFallbackUrl: null }, { retryCount: 0 }, () => {}) });
  for (let i = 0; i < 3; i++) await expect(alone.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
  expect(primaryCalls).toHaveBeenCalledTimes(3);
  expect(RPC_PRIMARY_REST_MS).toBe(REST);
});
