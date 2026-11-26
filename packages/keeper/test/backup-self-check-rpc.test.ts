import { afterEach, expect, it, vi } from 'vitest';
import { createPublicClient, zeroHash } from 'viem';
import { RANDOMNESS_SOURCE as source } from '../../box-spec/src/generated/box-spec.v1';
import { ViemChain } from '../src/chain';
import { keeperTransport } from '../src/rpc';
import { runTick } from '../src/run';
import { fakeClient, fakeNode } from './support/fake-rpc';
import { fakeHeader } from './support/backup';
import { addr, keeper, options, quiet, time } from './support/v2';

afterEach(() => vi.unstubAllGlobals());

type Stage = 'latest' | 'raw' | 'fields';
interface Request { id: number; method: string; params?: unknown[]; }
const stageOf = (r: Request): Stage | undefined => r.method === 'debug_getRawHeader' ? 'raw'
  : r.method === 'eth_getBlockByNumber' ? r.params?.[0] === 'latest' ? 'latest'
    : r.params?.[0] === '0x3e7' ? 'fields' : undefined : undefined;

function fixture({ hold, fallback = false, fail = false, wrongChain = false, diagnostic = true }: {
  hold?: Stage; fallback?: boolean; fail?: boolean; wrongChain?: boolean; diagnostic?: boolean;
} = {}) {
  const node = fakeNode({ block: { number: 1001n, timestamp: time, baseFeePerGas: 1n } });
  const base = fakeClient(node);
  const on = (address: string, fn: string, value: unknown) => { node.calls[`${address.toLowerCase()}:${fn}`] = () => value; };
  on(addr(1), 'randomness', source); on(addr(1), 'tickets', addr(7));
  on(addr(7), 'source', source); on(addr(7), 'coordinator', addr(1)); on(addr(7), 'phase', 2);
  on(addr(7), 'status', { minted: 2, slots: 2, wordRequestedAt: 100, wordAcceptedAt: 0, terminalAt: 0, drawsRequested: 0, drawsSettled: 0 });
  on(source, 'requestOf', [time - 100n, 123n]); on(source, 'wordOf', [`0x${'12'.repeat(32)}`, time - 50n]);
  on(source, 'isSilent', false);
  const cfg = { ...options(), dryRun: false, monitorFile: '.cache/self-check-rpc-view.json',
    rpcUrl: 'https://primary.invalid', rpcFallbackUrl: fallback || wrongChain ? 'https://fallback.invalid' : null,
    box0: { coordinator: addr(1), hook: addr(2), receiver: addr(3), executor: addr(9) } };
  const log = { ...quiet, info: vi.fn(), warn: vi.fn() };
  const batches: { url: string; batched: boolean; requests: Request[] }[] = [];
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let waiting = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input).origin;
    const body = JSON.parse(String(init.body)) as Request | Request[];
    const requests = Array.isArray(body) ? body : [body];
    const batched = Array.isArray(body);
    batches.push({ url, batched, requests });
    if (fallback && url === cfg.rpcUrl) return new Response('unavailable', { status: 503 });
    if (hold && requests.some(r => stageOf(r) === hold)) { waiting = true; await held; }
    const answers = await Promise.all(requests.map(async r => {
      try {
        const tag = r.params?.[0] as string;
        let result: unknown;
        if (wrongChain && !batched && url === cfg.rpcUrl && r.method === 'eth_chainId') result = '0x1';
        else if (r.method === 'debug_getRawHeader') {
          if (fail || hold === 'fields') throw new Error('private provider payload');
          result = fakeHeader(BigInt(tag), time).raw;
        } else if (r.method === 'eth_getBlockByNumber') {
          const n = tag === 'pending' ? 1001n : tag === 'latest' ? 1000n : BigInt(tag);
          const block = fakeHeader(n, time).block;
          result = tag === 'pending' ? { ...block, parentHash: fakeHeader(n - 1n, time).block.hash }
            : fail && stageOf(r) === 'fields' ? { ...block, hash: zeroHash } : block;
        } else result = await base.request({ method: r.method, params: r.params } as never);
        return { jsonrpc: '2.0', id: r.id, result };
      } catch {
        return { jsonrpc: '2.0', id: r.id, error: stageOf(r)
          ? { code: -32000, message: 'private provider payload' } : { code: 3, message: 'execution reverted' } };
      }
    }));
    return new Response(JSON.stringify(batched ? answers : answers[0]), { headers: { 'content-type': 'application/json' } });
  }));
  const transport = keeperTransport(cfg, { batch: true, retryCount: 0, timeout: 15000 }, message => log.warn(message));
  const pub = createPublicClient({ transport: diagnostic ? transport : parameters => ({ ...transport(parameters), value: {} }) });
  const chain = new ViemChain(cfg, pub, keeper, { public: null, private: null }, null, log);
  const send = vi.fn(async () => 'hash');
  const tick = () => runTick({ read: () => chain.read(), simulate: async () => ({ ok: true, tipWei: null, estimate: 100000n }), send }, {}, cfg, log);
  const diagnostics = () => batches.filter(b => b.requests.some(r => stageOf(r)));
  return { chain, log, send, tick, batches, diagnostics, release, waiting: () => waiting };
}

it.each([
  { hold: 'latest', fallback: false }, { hold: 'raw', fallback: false }, { hold: 'fields', fallback: false },
  { hold: 'latest', fallback: true }, { hold: 'raw', fallback: true }, { hold: 'fields', fallback: true },
] as const)('a held $hold response cannot delay candidates or sends (fallback=$fallback)', async cfg => {
  const f = fixture(cfg);
  let done = false;
  const tick = f.tick().then(out => { done = true; return out; });
  try {
    await vi.waitFor(() => expect(f.waiting()).toBe(true));
    await vi.waitFor(() => expect(done, 'tick must finish before the diagnostic response is released').toBe(true));
    const out = await tick;
    expect(out.report.sent.map(c => c.job)).toContain('drandAcceptWord');
    expect(f.send).toHaveBeenCalled();
    expect(out.observed.readings).not.toHaveProperty('backupHeader');
    expect(f.batches.some(b => b.batched && b.requests.some(r => r.method === 'eth_call'))).toBe(true);
  } finally {
    f.release();
    await tick;
    await vi.waitFor(() => expect(f.log.info).toHaveBeenCalledWith('backup header self-check ok', {
      block: 999n, path: cfg.hold === 'fields' ? 'fields' : 'raw',
    }));
  }
  expect(f.diagnostics().map(b => b.batched)).toEqual([false, false, false]);
  expect(f.diagnostics().map(b => b.url)).toEqual(Array(3).fill(cfg.fallback ? 'https://fallback.invalid' : 'https://primary.invalid'));
});

it('a refused header and mismatched fields change neither candidate work nor drand completeness', async () => {
  const good = fixture();
  const expected = await good.tick();
  await vi.waitFor(() => expect(good.log.info).toHaveBeenCalledWith('backup header self-check ok', { block: 999n, path: 'raw' }));
  const bad = fixture({ fail: true });
  const actual = await bad.tick();
  await vi.waitFor(() => expect(bad.log.warn).toHaveBeenCalledWith('backup header self-check failed', { block: 999n }));
  expect(actual.report).toEqual(expected.report);
  expect(actual.report.sent.map(c => c.job)).toContain('drandAcceptWord');
  expect(bad.send.mock.calls).toEqual(good.send.mock.calls);
  const before = (await good.chain.read()).monitor, after = (await bad.chain.read()).monitor;
  expect(after).toMatchObject({ complete: true, failedReads: 0, drand: { complete: true },
    backupHeader: { checkedAt: time, block: 999n, ok: false, path: null } });
  expect(after?.drand).toEqual(before?.drand);
  expect(bad.log.warn.mock.calls.filter(([s]) => s === 'backup header self-check failed')).toEqual([
    ['backup header self-check failed', { block: 999n }],
  ]);
  expect(bad.diagnostics().every(b => !b.batched)).toBe(true);
});

it('the diagnostic path checks each endpoint chain before use and keeps primary then fallback order', async () => {
  const f = fixture({ wrongChain: true });
  await f.tick();
  await vi.waitFor(() => expect(f.log.info).toHaveBeenCalledWith('backup header self-check ok', { block: 999n, path: 'raw' }));
  expect(f.log.warn).toHaveBeenCalledWith('rpc fallback refused');
  expect(f.log.warn).toHaveBeenCalledWith('rpc fallback in use');
  expect(f.batches.filter(b => !b.batched).map(b => [b.url, b.requests.map(r => r.method)])).toEqual([
    ['https://primary.invalid', ['eth_chainId']],
    ['https://fallback.invalid', ['eth_chainId']],
    ['https://fallback.invalid', ['eth_getBlockByNumber']],
    ['https://fallback.invalid', ['debug_getRawHeader']],
    ['https://fallback.invalid', ['eth_getBlockByNumber']],
  ]);
});

it('a missing diagnostic transport reports failure without using the candidate transport for the check', async () => {
  const f = fixture({ diagnostic: false });
  const out = await f.tick();
  expect(out.report.sent.map(c => c.job)).toContain('drandAcceptWord');
  expect(out.observed.readings).toMatchObject({ complete: true, failedReads: 0, drand: { complete: true },
    backupHeader: { checkedAt: time, block: 999n, ok: false, path: null } });
  expect(f.log.warn).toHaveBeenCalledWith('backup header self-check failed', { block: 999n });
  expect(f.diagnostics()).toHaveLength(0);
});
