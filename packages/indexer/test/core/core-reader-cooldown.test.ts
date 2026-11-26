import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { toHex } from 'viem';
import { RpcCoreReader, type LogFilter } from '../../src/core/core-reader';
import { refusedAtHash } from '../../src/core/v2/money-v2';
import { fakeRpc } from './rpc-fixture';

const hash = (n: bigint) => toHex(n, { size: 32 });
const target = `0x${'11'.repeat(20)}` as const;
const header = (n: bigint) => ({ number: toHex(n), hash: hash(n), parentHash: hash(n - 1n), timestamp: '0x1', transactions: [] });
const filter: LogFilter = { addresses: [target], topics: [hash(1n)], poolManager: null, poolIds: [], poolTopics: [], settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
const anchors = [{ number: 30n, hash: hash(30n) }, { number: 9n, hash: hash(9n) }];
const anchoredMethods = ['eth_getBlockByNumber', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getBlockByNumber'];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([[true, 'text'], [false, 'text'], [true, 'JSON-RPC'], [false, 'JSON-RPC']] as const)(
  'a cached pruning refusal must not later become an unrelated EVM revert (known number: %s, HTTP 429 body: %s)', async (knownNumber, body) => {
  vi.useFakeTimers({ now: 1_000 });
  onTestFinished(() => { vi.useRealTimers(); });
  let limited = false;
  const calls = fakeRpc(({ url, method, params }) => {
    if (url.includes('second') && limited) {
      if (body === 'JSON-RPC') throw Object.assign(new Error('rate limit exceeded'), { status: 429, code: -32005 });
      throw Object.assign(new Error('limited'), { status: 429 });
    }
    if (method === 'eth_getBlockByNumber') return header(BigInt(params[0] as string));
    if ((params[1] as { blockHash: string }).blockHash === hash(11n)) throw Object.assign(new Error('execution reverted: bad listing'), { code: 3 });
    if (url.includes('first')) throw Object.assign(new Error('pruned history unavailable'), { code: 4444 });
    return '0x1234';
  });
  const reader = new RpcCoreReader({ urls: ['https://first.invalid', 'https://second.invalid'] });
  if (knownNumber) await reader.headerByNumber(10n);
  await reader.callAt(target, '0x1234', hash(10n));
  const revert = expect(reader.callAt(target, '0x5678', hash(11n))).rejects.toSatisfy(refusedAtHash);
  await vi.runAllTimersAsync();
  await revert;
  limited = true;
  const firstRead = reader.callAt(target, '0x1234', hash(10n)).catch(error => error);
  await vi.advanceTimersByTimeAsync(30_000);
  const firstFailure = await firstRead;
  expect(firstFailure).toBeInstanceOf(Error);
  expect(refusedAtHash(firstFailure)).toBe(false);
  calls.splice(0);
  const secondRead = reader.callAt(target, '0x1234', hash(10n)).catch(error => error);
  // The last 429 was 15 s into the first read and its 16 s cooldown has 1 s left.
  await vi.advanceTimersByTimeAsync(999);
  expect(calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls.map(call => call.url)).toEqual(['https://second.invalid']);
  await vi.advanceTimersByTimeAsync(29_000);
  const cooldownFailure = await secondRead;
  expect(calls.map(call => call.url)).toEqual(['https://second.invalid']);
  expect(cooldownFailure).toBeInstanceOf(Error);
  expect(refusedAtHash(cooldownFailure)).toBe(false);
  if (body === 'JSON-RPC') {
    expect(cooldownFailure).toMatchObject({ name: 'LimitExceededRpcError', code: -32005, details: 'rate limit exceeded' });
    expect(cooldownFailure).not.toHaveProperty('status');
  } else {
    expect(cooldownFailure).not.toHaveProperty('code');
    expect(cooldownFailure).not.toHaveProperty('cause');
    expect(cooldownFailure).toHaveProperty('status', 429);
  }
});

it('a retained anchor known to be unavailable should skip its endpoint on a later range and recover after expiry', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let unavailable = true;
  const calls = fakeRpc(({ url, method, params }) => {
    if (method === 'eth_getBlockByNumber') {
      const n = BigInt(params[0] as string);
      if (url.includes('first') && n === 9n && unavailable) throw Object.assign(new Error('header not found'), { code: -32000 });
      return header(n);
    }
    return [];
  });
  const reader = new RpcCoreReader({ urls: ['https://first.invalid', 'https://second.invalid'] });
  await reader.rangeLogs(10n, 20n, filter, anchors);
  calls.splice(0);
  await reader.rangeLogs(21n, 30n, filter, anchors);
  expect(calls.every(call => call.url.includes('second'))).toBe(true);
  expect(calls.map(call => call.method)).toEqual(anchoredMethods);
  unavailable = false;
  calls.splice(0);
  now += 59_999;
  await reader.rangeLogs(21n, 30n, filter, anchors);
  expect(calls.every(call => call.url.includes('second'))).toBe(true);
  expect(calls.map(call => call.method)).toEqual(anchoredMethods);
  expect(calls.filter(call => call.method === 'eth_getBlockByNumber').map(call => call.params[0]))
    .toEqual([toHex(30n), toHex(9n), toHex(30n), toHex(9n)]);
  calls.splice(0);
  now++;
  await reader.rangeLogs(21n, 30n, filter, anchors);
  expect(calls.every(call => call.url.includes('first'))).toBe(true);
  expect(calls.map(call => call.method)).toEqual(anchoredMethods);
  expect(calls.filter(call => call.method === 'eth_getBlockByNumber').map(call => call.params[0]))
    .toEqual([toHex(30n), toHex(9n), toHex(30n), toHex(9n)]);
});

it('an anchor hash cooldown skips every log chunk and filter until expiry', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls = fakeRpc(({ url, method, params }) => {
    if (method === 'eth_getBlockByNumber') return header(BigInt(params[0] as string));
    if (method === 'eth_call') {
      if (url.includes('first')) throw Object.assign(new Error('pruned history unavailable'), { code: 4444 });
      return '0x1234';
    }
    return [];
  });
  const reader = new RpcCoreReader({ urls: ['https://first.invalid', 'https://second.invalid'], maxRange: 5n, maxAddresses: 1 });
  await reader.callAt(target, '0x1234', hash(9n));
  const twoFilters = { ...filter, addresses: [target, `0x${'22'.repeat(20)}` as const] };
  calls.splice(0);
  now += 59_999;
  await reader.rangeLogs(21n, 30n, twoFilters, anchors);
  expect(calls.every(call => call.url.includes('second'))).toBe(true);
  expect(calls.filter(call => call.method === 'eth_getLogs')).toHaveLength(4);
  // viem coalesces the two filters' concurrent header requests; each chunk still checks both anchors twice.
  expect(calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === toHex(9n))).toHaveLength(4);
  expect(calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === toHex(30n))).toHaveLength(4);
  calls.splice(0);
  now++;
  await reader.rangeLogs(21n, 30n, twoFilters, anchors);
  expect(calls.every(call => call.url.includes('first'))).toBe(true);
  expect(calls.filter(call => call.method === 'eth_getLogs')).toHaveLength(4);
  expect(calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === toHex(9n))).toHaveLength(4);
  expect(calls.filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] === toHex(30n))).toHaveLength(4);
});
