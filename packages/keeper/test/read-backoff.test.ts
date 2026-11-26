import { afterEach, expect, it, vi } from 'vitest';
import { createPublicClient } from 'viem';
import { keeperTransport } from '../src/rpc';

const cfg = { rpcUrl: 'https://rpc.invalid', rpcFallbackUrl: 'https://rpc.invalid', chainId: 11155111 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it.each([undefined, '7', 'Tue, 27 Oct 2026 00:00:09 GMT'])('backs off a recorded publicnode 429, respecting Retry-After %s', async retryAfter => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T00:00:00Z')); vi.spyOn(Math, 'random').mockReturnValue(0);
  let failures = 0;
  const times: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    if (body.method === 'eth_chainId') return Response.json({ jsonrpc: '2.0', id: body.id, result: '0xaa36a7' });
    times.push(Date.now());
    if (failures++ < 2) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32005, message: 'Rate limit exceeded' } },
      { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x12' });
  }));
  const pub = createPublicClient({ transport: keeperTransport(cfg, { retryCount: 2, batch: false }, () => {}) });
  const result = pub.getBlockNumber({ cacheTime: 0 });
  await vi.runAllTimersAsync();
  expect(await result).toBe(18n);
  expect(times).toHaveLength(3);
  expect((times[1] ?? NaN) - (times[0] ?? NaN)).toBeGreaterThanOrEqual(retryAfter ? retryAfter === '7' ? 7000 : 9000 : 2000);
  expect((times[2] ?? NaN) - (times[1] ?? NaN)).toBeGreaterThanOrEqual(4000);
});
it('backs off timeouts before retrying the same endpoint', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
  let calls = 0;
  const times: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    if (body.method === 'eth_chainId') return Response.json({ id: body.id, result: '0xaa36a7' });
    times.push(Date.now());
    if (calls++ === 0) return new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    return Response.json({ id: body.id, result: '0x12' });
  }));
  const pub = createPublicClient({ transport: keeperTransport(cfg, { retryCount: 1, timeout: 100 }, () => {}) });
  const result = pub.getBlockNumber({ cacheTime: 0 });
  await vi.runAllTimersAsync();
  expect(await result).toBe(18n);
  expect((times[1] ?? NaN) - (times[0] ?? NaN)).toBeGreaterThanOrEqual(2100);
});

it('jitters exponential delays and honours headers over the cap', async () => {
  const { rpcBackoff } = await import('../src/rpc');
  expect(rpcBackoff({}, 1, 0, () => 0)).toBe(2000);
  expect(rpcBackoff({}, 1, 0, () => 1)).toBe(2500);
  expect(rpcBackoff({}, 2, 0, () => 0)).toBe(4000);
  expect(rpcBackoff({}, 100, 0, () => 0)).toBe(60000);
  expect(rpcBackoff({ headers: new Headers({ 'Retry-After': '120' }) }, 1, 0, () => 0)).toBe(120000);
});

it('still checks the current chain on later ticks after verifying an endpoint at startup', async () => {
  let chainId = '0xaa36a7';
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    return Response.json({ id: body.id, result: chainId });
  }));
  const pub = createPublicClient({ transport: keeperTransport(cfg, { retryCount: 0 }, () => {}) });
  expect(await pub.getChainId()).toBe(11155111);
  chainId = '0x1';
  expect(await pub.getChainId()).toBe(1);
});
