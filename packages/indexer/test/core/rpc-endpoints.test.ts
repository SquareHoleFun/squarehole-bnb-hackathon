import { afterEach, expect, it, vi } from 'vitest';
import { toHex, type Hex } from 'viem';
import { RpcCoreReader, type LogFilter } from '../../src/core/core-reader';
import { fakeRpc } from './rpc-fixture';

const hash = (n: bigint) => toHex(n, { size: 32 });
const target = `0x${'11'.repeat(20)}` as const;
const filter: LogFilter = { addresses: [target], topics: [hash(1n)], poolManager: null, poolIds: [], poolTopics: [], settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
const header = (n: bigint, h = hash(n)) => ({ number: toHex(n), hash: h, parentHash: hash(n - 1n), timestamp: '0x1', transactions: [] });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['pruned history unavailable', 'missing trie node', 'header not found'])('RPC-2: %s cools old reads only; configured order returns after expiry', async message => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let pruned = true;
  const calls = fakeRpc(({ url, method, params }) => {
    if (method === 'eth_getBlockByNumber') return header(params[0] === 'latest' ? 100n : BigInt(params[0] as Hex));
    if (url.includes('first') && pruned) throw Object.assign(new Error(message), { code: 4444 });
    return method === 'eth_getLogs' ? [] : '0x1234';
  });
  const reader = new RpcCoreReader({ urls: ['https://first.invalid', 'https://second.invalid'] });
  await reader.headerByNumber(10n);
  await reader.callAt(target, '0x1234', hash(10n));
  calls.splice(0);
  await reader.callAt(target, '0x1234', hash(10n));
  expect(calls.map(c => c.url)).toEqual(['https://second.invalid']);
  await reader.headerByNumber(9n);
  expect(calls.at(-1)?.url).toBe('https://second.invalid');
  await reader.latestHeader();
  expect(calls.at(-1)?.url).toBe('https://first.invalid');
  now += 61_000; pruned = false;
  await reader.callAt(target, '0x1234', hash(10n));
  expect(calls.at(-1)?.url).toBe('https://first.invalid');
});

it.each([429, 403])('RPC-2: HTTP %s has bounded exponential cooldown and recovers in configured order', async status => {
  let now = 1_000; let limited = true;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls = fakeRpc(({ url }) => {
    if (limited && url.includes('first')) throw Object.assign(new Error('limited'), { status });
    return header(100n);
  });
  const reader = new RpcCoreReader({ urls: ['https://first.invalid', 'https://second.invalid'] });
  for (let i = 0; i < 10; i++) {
    await reader.latestHeader(); calls.splice(0);
    await reader.latestHeader(); expect(calls.map(c => c.url)).toEqual(['https://second.invalid']);
    now += 31_000;
  }
  limited = false;
  await reader.latestHeader(); expect(calls.at(-1)?.url).toBe('https://first.invalid');
});

it('RPC-2/R2: a pruned range stays skipped, recent reads recover, and fallback checks both anchors before and after logs', async () => {
  const calls = fakeRpc(({ url, method, params }) => {
    if (method === 'eth_getBlockByNumber') return header(params[0] === 'latest' ? 100n : BigInt(params[0] as Hex));
    if (url.includes('first')) throw Object.assign(new Error('pruned history unavailable'), { code: 4444 });
    return [];
  });
  const reader = new RpcCoreReader({ urls: ['https://first.invalid', 'https://second.invalid'] });
  const anchors = [{ number: 20n, hash: hash(20n) }, { number: 9n, hash: hash(9n) }];
  await reader.rangeLogs(10n, 20n, filter, anchors);
  calls.splice(0);
  await reader.rangeLogs(5n, 10n, filter, anchors);
  expect(calls.map(c => c.method)).toEqual(['eth_getBlockByNumber', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getBlockByNumber']);
  expect(calls.every(c => c.url.includes('second'))).toBe(true);
  await reader.latestHeader(); expect(calls.at(-1)?.url).toBe('https://first.invalid');
});

it('RPC-2/R2: never accepts logs when the fallback leaves an anchor during the read', async () => {
  let moved = false;
  fakeRpc(({ method, params }) => {
    if (method === 'eth_getBlockByNumber') return header(BigInt(params[0] as Hex), moved ? hash(999n) : hash(20n));
    moved = true; return [];
  });
  const reader = new RpcCoreReader({ urls: ['https://only.invalid'] });
  await expect(reader.rangeLogs(10n, 20n, filter, [{ number: 20n, hash: hash(20n) }])).rejects.toThrow(/not on block/);
});

it('RPC-2: reads wait for doubling cooldowns capped at 30 s and reject after 30 s of total waiting', async ({ onTestFinished }) => {
  vi.useFakeTimers({ now: 0 });
  onTestFinished(() => { vi.useRealTimers(); });
  const attempts: number[] = [];
  fakeRpc(() => {
    attempts.push(Date.now());
    throw Object.assign(new Error('limited'), { status: 429 });
  });
  const reader = new RpcCoreReader({ urls: ['https://only.invalid'] });
  const rejectionTime = () => expect(reader.latestHeader()).rejects.toThrow(/limited/i).then(() => Date.now());
  const first = rejectionTime();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await first).toBe(30_000);
  expect(attempts).toEqual([0, 1_000, 3_000, 7_000, 15_000]);

  // The 16 s cooldown ends at 31 s. Later failures leave a full 30 s cooldown each.
  for (const due of [31_000, 61_000, 91_000]) {
    attempts.length = 0;
    const start = Date.now();
    const read = rejectionTime();
    await vi.advanceTimersByTimeAsync(due - start - 1);
    expect(attempts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toEqual([due]);
    await vi.advanceTimersByTimeAsync(start + 30_000 - due);
    expect(await read).toBe(start + 30_000);
    expect(attempts).toEqual([due]);
  }
});

it('RPC-2: an unknown refused hash is cooled without cooling another hash or the head', async () => {
  const calls = fakeRpc(({ url, method }) => {
    if (method === 'eth_getBlockByNumber') return header(100n);
    if (url.includes('first')) throw new Error('header not found');
    return '0x1234';
  });
  const reader = new RpcCoreReader({ urls: ['https://first.invalid', 'https://second.invalid'] });
  await reader.callAt(target, '0x1234', hash(8n)); calls.splice(0);
  await reader.callAt(target, '0x1234', hash(8n));
  expect(calls.map(c => c.url)).toEqual(['https://second.invalid']);
  calls.splice(0); await reader.callAt(target, '0x1234', hash(9n));
  expect(calls.map(c => c.url)).toEqual(['https://first.invalid', 'https://second.invalid']);
  await reader.latestHeader(); expect(calls.at(-1)?.url).toBe('https://first.invalid');
});
