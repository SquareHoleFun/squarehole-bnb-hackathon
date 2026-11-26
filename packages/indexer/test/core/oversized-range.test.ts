import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { fromRpcLog } from '../../src/chain-reader';
import { RpcCoreReader, type LogFilter } from '../../src/core/core-reader';
import { addressRefusal, fakeRpc } from './rpc-fixture';

const primary = 'https://pruned.invalid', archive = 'https://archive.invalid', reference = 'https://reference.invalid';
const hash = (n: bigint) => toHex(n, { size: 32 });
const address = (i: number) => toHex(i + 1, { size: 20 });
const limit = 10_485_760;
const data: Hex = `0x${'ab'.repeat(limit / 4)}`;
const from = 100n, to = 5_099n;
const anchors = [from - 1n, to].map(number => ({ number, hash: hash(number) }));
const scope = (start: bigint, end: bigint) => ({ fromBlock: toHex(start), toBlock: toHex(end) });
function rpcLog(n: bigint, i: number, contract = 0, payload: Hex = data) {
  return { address: address(contract), topics: [hash(1n)], data: payload, blockNumber: toHex(n), blockHash: hash(n),
    transactionHash: hash(n), transactionIndex: '0x0' as Hex, logIndex: toHex(i) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(logs: ReturnType<typeof rpcLog>[], grouped = false, mixedFailure = false) {
  vi.useFakeTimers({ now: 6_000 });
  const addresses = Array.from({ length: grouped ? 57 : 1 }, (_, i) => address(i));
  const filter: LogFilter = { addresses, topics: [hash(1n)], poolManager: null, poolIds: [], poolTopics: [],
    settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
  const reader = new RpcCoreReader({ urls: [primary, archive] });
  let head = to + 32n;
  const observe = () => reader.observeHead({ number: head, hash: hash(head), parentHash: hash(head - 1n), timestamp: BigInt(Date.now() / 1000) });
  observe();
  const calls = fakeRpc(async ({ url, method, params }) => {
    if (method === 'eth_getBlockByNumber') {
      const number = BigInt(params[0] as Hex);
      return { number: toHex(number), hash: hash(number), parentHash: hash(number - 1n), timestamp: '0x1', transactions: [] };
    }
    if (method !== 'eth_getLogs') throw new Error(method);
    const p = params[0] as { address: Address[]; topics: Hex[][]; fromBlock: Hex; toBlock: Hex; blockHash?: Hex };
    if (grouped && url === primary && p.address.length > 10) throw addressRefusal;
    if (mixedFailure && url === primary && p.fromBlock === toHex(from) && p.toBlock === toHex(to)
      && p.address[0] === address(10)) throw { status: 500, message: 'early sibling failure' };
    if (url !== reference) await new Promise(resolve => setTimeout(resolve, 6_100));
    // A successful sibling of the oversized group returns a sentinel only in the discarded full-span wave.
    const discarded = grouped && url === primary && p.address.includes(address(55))
      && p.fromBlock === toHex(from) && p.toBlock === toHex(to);
    const responseLogs = discarded ? [...logs, rpcLog(from, 99, 55, '0xdead')] : logs;
    return responseLogs.filter(log => p.address.includes(log.address) && log.topics.some(topic => p.topics[0]?.includes(topic))
      && (p.blockHash ? p.blockHash === log.blockHash : BigInt(log.blockNumber) >= BigInt(p.fromBlock) && BigInt(log.blockNumber) <= BigInt(p.toBlock)));
  });
  async function moving<T>(read: Promise<T>): Promise<T> {
    const nextHead = () => {
      head++;
      observe();
      tick = setTimeout(nextHead, 12_000);
    };
    let tick = setTimeout(nextHead, 12_000 - Date.now() % 12_000);
    const [result] = await Promise.all([read.finally(() => clearTimeout(tick)), vi.runAllTimersAsync()]);
    return result;
  }
  // The test oracle alone accepts the full answer in one body.
  const oracle = createPublicClient({ transport: http(reference, { maxResponseBodySize: 2 * limit, retryCount: 0 }) });
  async function completeAnswer() {
    const result = await oracle.request({ method: 'eth_getLogs', params: [{ address: addresses, topics: [[hash(1n)]], ...scope(from, to) }] });
    return result.map(fromRpcLog);
  }
  return { reader, filter, calls, moving, completeAnswer };
}

it('reads a 5,000-block answer above 10 MiB in two anchored halves and resumes 5,000-block spans beyond it', async () => {
  const logs = [rpcLog(from, 15), rpcLog(to, 1)];
  const { reader, calls, filter, moving, completeAnswer } = setup(logs);
  const truth = await completeAnswer();
  const seen = calls.length;
  expect(await moving(reader.rangeLogs(from, to, filter, anchors))).toEqual(truth);
  const reads = calls.slice(seen);
  const checkAnchors = anchors.map(a => ['eth_getBlockByNumber', toHex(a.number)]);
  const query = (a: bigint, b: bigint) => ['eth_getLogs', { address: filter.addresses, topics: [filter.topics], ...scope(a, b) }];
  expect(reads.map(r => [r.method, r.params[0]])).toEqual([
    ...checkAnchors, query(from, to),
    ...checkAnchors, query(from, from + 2_499n), ...checkAnchors,
    ...checkAnchors, query(from + 2_500n, to), ...checkAnchors,
  ]);
  expect(reads.every(r => r.url === primary)).toBe(true);
  const replay = calls.length;
  expect(await moving(reader.rangeLogs(from, to, filter))).toEqual(truth);
  expect(calls.slice(replay).map(r => [r.method, r.params[0]])).toEqual([query(from, to - 1n), query(to, to)]);
  const beforeNext = calls.length;
  expect(await moving(reader.rangeLogs(to + 1n, to + 5_000n, filter))).toEqual([]);
  expect(calls.slice(beforeNext).map(r => [r.method, r.params[0]])).toEqual([query(to + 1n, to + 5_000n)]);
  for (const endpoint of reader['clients']) {
    expect(endpoint).toMatchObject({ limitedUntil: 0, limitFailures: 0, historyUntil: 0, unavailableThrough: undefined, active: 0, waiters: [] });
    expect(endpoint.unavailableHashes.size).toBe(0);
  }
});

it.each(['number', 'known hash', 'unknown hash'])('reports the single oversized block by %s after one request', async mode => {
  const { reader, calls, filter, moving } = setup([rpcLog(from, 0), rpcLog(from, 1)]);
  if (mode === 'known hash') reader.observeHead({ number: from, hash: hash(from), parentHash: hash(from - 1n), timestamp: 0n });
  const read = mode === 'number' ? reader.rangeLogs(from, from, filter) : reader.logsByHash(hash(from), filter);
  const block = mode === 'unknown hash' ? hash(from) : from;
  await moving(expect(read).rejects.toThrow(`block ${block}: the answer is larger than the client's limit`));
  expect(calls.map(r => [r.url, r.method])).toEqual([[primary, 'eth_getLogs']]);
  if (mode === 'number') {
    const replay = reader.rangeLogs(from, from, filter);
    await moving(expect(replay).rejects.toThrow(`block ${from}: the answer is larger than the client's limit`));
    expect(calls.slice(1)).toEqual([calls[0]]);
  }
});

it.each([false, true])('discards and regroups a six-group oversized wave (earlier sibling HTTP 500: %s)', async mixedFailure => {
  const logs = [rpcLog(from, 0, 55, '0x01'), rpcLog(from, 1), rpcLog(to, 0), rpcLog(to, 1, 15, '0x02')];
  const { reader, calls, filter, moving, completeAnswer } = setup(logs, true, mixedFailure);
  const truth = await completeAnswer();
  const seen = calls.length;
  expect(await moving(reader.rangeLogs(from, to, filter, anchors))).toEqual(truth);
  const reads = calls.slice(seen);
  expect(reads.every(r => r.url === primary)).toBe(true);
  const groups = [0, 10, 20, 30, 40, 50].map(i => filter.addresses.slice(i, i + 10));
  const anchorReads = anchors.map(a => ['eth_getBlockByNumber', toHex(a.number)]);
  const query = (addresses: readonly Address[], a: bigint, b: bigint) =>
    ['eth_getLogs', { address: addresses, topics: [filter.topics], ...scope(a, b) }];
  const wave = (a: bigint, b: bigint) => groups.map(g => query(g, a, b));
  expect(reads.map(r => [r.method, r.params[0]])).toEqual([
    ...anchorReads, query(filter.addresses, from, to), ...wave(from, to),
    ...anchorReads, ...wave(from, from + 2_499n), ...anchorReads,
    ...anchorReads, ...wave(from + 2_500n, to), ...anchorReads,
  ]);
});

it('bisects an odd, dense first chunk repeatedly without replaying a sibling plan or skipping the next chunk', async () => {
  const dense = address(0), sparse = address(1);
  const reader = new RpcCoreReader({ urls: [primary, archive], maxRange: 5n, maxAddresses: 1 });
  const filter: LogFilter = { addresses: [dense, sparse], topics: [], poolManager: null, poolIds: [], poolTopics: [],
    settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
  const logs = [rpcLog(1n, 0, 1, '0xaa'), rpcLog(1n, 1, 0, '0xbb'), rpcLog(9n, 0, 0, '0xcc')];
  const calls = fakeRpc(({ params }) => {
    const p = params[0] as { address: Address[]; fromBlock: Hex; toBlock: Hex };
    return logs.filter(log => p.address.includes(log.address) && BigInt(log.blockNumber) >= BigInt(p.fromBlock) && BigInt(log.blockNumber) <= BigInt(p.toBlock));
  });
  const respond = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const response = await respond(url, init);
    const { address: [contract], fromBlock, toBlock } = JSON.parse(init.body as string).params[0];
    if (contract === dense && fromBlock === '0x1' && toBlock !== fromBlock) {
      // viem also enforces the ceiling as soon as it sees an oversized Content-Length.
      response.headers.set('Content-Length', String(limit + 1));
    }
    return response;
  });
  expect(await reader.rangeLogs(1n, 9n, filter)).toEqual(logs.map(fromRpcLog));
  expect(calls.every(r => r.url === primary)).toBe(true);
  const spans = (contract: Address) => calls.map(c => c.params[0] as { address: Address[]; fromBlock: Hex; toBlock: Hex })
    .filter(p => p.address[0] === contract).map(p => [Number(p.fromBlock), Number(p.toBlock)]);
  expect(spans(dense)).toEqual([[1, 5], [1, 3], [1, 2], [1, 1], [2, 2], [3, 3], [4, 5], [6, 9]]);
  expect(spans(sparse)).toEqual([[1, 5], [6, 9]]);
});

// Model a nearly full block whose answer crosses the body limit when its neighbour is included.
// viem checks Content-Length before consuming the body. The tests above also stream the actual 10 MiB.
function denseRanges(denseBlocks: number[], capacity = 4_096) {
  const reader = new RpcCoreReader({ urls: [primary, archive], maxOversizedRanges: capacity });
  const filter: LogFilter = { addresses: [address(0)], topics: [], poolManager: null, poolIds: [], poolTopics: [],
    settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
  fakeRpc(() => []);
  const respond = globalThis.fetch;
  const trace: [number, number][] = [];
  const cutoffs: [number, number][] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe(primary);
    const p = JSON.parse(init.body as string).params[0];
    const span: [number, number] = [Number(p.fromBlock), Number(p.toBlock)];
    trace.push(span);
    const response = await respond(url, init);
    if (denseBlocks.some(n => span[0] <= n && n + 1 <= span[1])) {
      response.headers.set('Content-Length', String(limit + 1));
      cutoffs.push(span);
    }
    return response;
  });
  async function read(start: number, end: number, addresses = filter.addresses) {
    trace.length = 0;
    cutoffs.length = 0;
    await reader.rangeLogs(BigInt(start), BigInt(end), { ...filter, addresses });
    return { trace: [...trace], cutoffs: [...cutoffs] };
  }
  return read;
}

it('learns one dense block in 5,000, then reads around it without another cutoff', async () => {
  const read = denseRanges([2_600]);
  const learned = await read(100, 5_099);
  expect(learned.cutoffs).toEqual([[100, 5_099], ...[5_099, 3_849, 3_224, 2_912, 2_756, 2_678, 2_639, 2_619, 2_609, 2_604, 2_602, 2_601].map(end => [2_600, end])]);
  expect(learned.trace).toHaveLength(27);
  expect(await read(100, 5_099)).toEqual({ trace: [[100, 2_600], [2_601, 5_099]], cutoffs: [] });
  expect(await read(5_100, 15_099)).toEqual({ trace: [[5_100, 10_099], [10_100, 15_099]], cutoffs: [] });
});

it('cuts at the earliest remembered end across filters and keeps full spans between two dense blocks', async () => {
  const read = denseRanges([100, 16_111]);
  // Learn them in reverse order. A lookup must follow block order, independent of insertion order.
  await read(16_111, 16_112);
  await read(100, 101);
  expect(await read(100, 21_111, [address(1)])).toEqual({ trace: [
    [100, 100], [101, 5_100], [5_101, 10_100], [10_101, 15_100], [15_101, 16_111], [16_112, 21_111],
  ], cutoffs: [] });
  // Both minima fit in this query and the oldest one has the later end.
  const near = denseRanges([100, 110]);
  await near(110, 111);
  await near(100, 101);
  expect(await near(1, 120)).toEqual({ trace: [[1, 100], [101, 110], [111, 120]], cutoffs: [] });
});

it('retains only minimal failed ranges and evicts the oldest at capacity', async () => {
  const read = denseRanges([1, 11, 21], 2);
  await read(1, 2);
  await read(10, 14); // [10,14] contains [10,12]; [10,12] splits between 11 and 12.
  expect((await read(1, 2)).cutoffs).toEqual([]);
  expect((await read(10, 14)).cutoffs).toEqual([]);
  await read(21, 22);
  expect((await read(10, 14)).cutoffs).toEqual([]);
  expect((await read(21, 22)).cutoffs).toEqual([]);
  expect((await read(1, 2)).cutoffs).toEqual([[1, 2]]);
});

it('unions a log returned by both the contract and pool plans when a range splits', async () => {
  const reader = new RpcCoreReader({ urls: [primary, archive] });
  const shared = { ...rpcLog(1n, 2, 0, '0xaa'), topics: [hash(1n), hash(2n)] };
  const first = rpcLog(1n, 1, 1, '0xbb');
  const filter: LogFilter = { addresses: [first.address, shared.address], topics: [hash(1n)],
    poolManager: shared.address, poolIds: [hash(2n)], poolTopics: [hash(1n)], settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
  const calls = fakeRpc(({ params }) => {
    const p = params[0] as { address: Address | Address[]; fromBlock: Hex };
    return p.fromBlock === '0x1' ? (Array.isArray(p.address) ? [shared, first] : [shared]) : [];
  });
  const respond = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const p = JSON.parse(init.body as string).params[0];
    const response = await respond(url, init);
    if (Array.isArray(p.address) && p.fromBlock === '0x1' && p.toBlock === '0x2') {
      response.headers.set('Content-Length', String(limit + 1));
    }
    return response;
  });
  expect(await reader.rangeLogs(1n, 2n, filter)).toEqual([first, shared].map(fromRpcLog));
  expect(calls).toHaveLength(4);
  expect(calls.every(c => c.url === primary)).toBe(true);
});

it('rechecks a pending plan after another read learns a range during its anchor check', async () => {
  const reader = new RpcCoreReader({ urls: [primary, archive] });
  const filter: LogFilter = { addresses: [address(0)], topics: [], poolManager: null, poolIds: [], poolTopics: [],
    settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
  let anchorStarted!: () => void;
  let releaseAnchor!: () => void;
  const checking = new Promise<void>(resolve => { anchorStarted = resolve; });
  const blocked = new Promise<void>(resolve => { releaseAnchor = resolve; });
  const calls = fakeRpc(async ({ method }) => {
    if (method === 'eth_getLogs') return [];
    anchorStarted();
    await blocked;
    return { number: toHex(to), hash: hash(to), parentHash: hash(to - 1n), timestamp: '0x1', transactions: [] };
  });
  const respond = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const p = JSON.parse(init.body as string).params[0];
    const response = await respond(url, init);
    if (p.fromBlock === '0xa' && p.toBlock === '0xb') response.headers.set('Content-Length', String(limit + 1));
    return response;
  });
  const pending = reader.rangeLogs(1n, 20n, filter, [{ number: to, hash: hash(to) }]);
  await checking;
  await reader.rangeLogs(10n, 11n, filter);
  releaseAnchor();
  await pending;
  expect(calls.filter(c => c.method === 'eth_getLogs').map(c => {
    const p = c.params[0] as { fromBlock: Hex; toBlock: Hex };
    return [Number(p.fromBlock), Number(p.toBlock)];
  })).toEqual([[10, 11], [10, 10], [11, 11], [1, 10], [11, 20]]);
});
