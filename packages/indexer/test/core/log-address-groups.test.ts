import { toHex, type Address, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { RANGE_TAIL } from '../../src/core/chain-indexer';
import { LOG_GROUP_TAIL, RpcCoreReader, type LogFilter } from '../../src/core/core-reader';
import { addressRefusal, fakeRpc } from './rpc-fixture';

const primary = 'https://pruned.invalid', archive = 'https://archive.invalid';
const address = (i: number) => toHex(i + 1, { size: 20 });
const addresses = Array.from({ length: 57 }, (_, i) => address(i));
const hash = (n: bigint) => toHex(n, { size: 32 });
const topics = [hash(1n), hash(2n)];
const filter: LogFilter = { addresses, topics, poolManager: null, poolTopics: [], poolIds: [],
  settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
const from = 65_535n, to = from + 1n;
const anchors = [from, to].map(number => ({ number, hash: hash(number) }));
const range = { fromBlock: toHex(from), toBlock: toHex(to) };
const byHash = { blockHash: hash(to) };
const old = { fromBlock: '0x1', toBlock: '0x2' } as const;

function log(block: bigint, index: number, contract: number) {
  return { address: address(contract), topics: [topics[0]], data: '0x', blockNumber: toHex(block),
    blockHash: hash(block), transactionHash: hash(block + 1n), transactionIndex: '0x0', logIndex: toHex(index) };
}
// Block numbers and log indexes both cross a hex digit boundary. The first group has the highest index.
const logs = [log(from, 2, 41), log(from, 16, 0), log(to, 0, 56), log(to, 1, 21), log(to, 15, 53), log(to, 16, 3)];
const groupAddresses = [0, 10, 20, 30, 40, 50].map(i => addresses.slice(i, i + 10));
const primaryHeader = (block: Hex | 'latest') => ({ url: primary, method: 'eth_getBlockByNumber', params: [block, false] });
const anchorCalls = anchors.map(a => primaryHeader(toHex(a.number)));
function logCall(url: string, address: readonly Address[], scope: typeof range | typeof byHash) {
  return { url, method: 'eth_getLogs', params: [{ address, topics: [topics], ...scope }] };
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function observe(reader: RpcCoreReader, number: bigint) {
  reader.observeHead({ number, hash: hash(number), parentHash: hash(number - 1n), timestamp: 0n });
}

function setup({ cap = 10, message = addressRefusal.message, failGroup = false, latest = to } = {},
  serveGroup: (group: readonly Address[]) => Promise<void> = () => delay(10)) {
  vi.useFakeTimers({ now: 0 });
  let active = 0, peak = 0;
  const calls = fakeRpc(async ({ url, method, params }) => {
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? latest : BigInt(params[0] as Hex);
      return { number: toHex(n), hash: hash(n), parentHash: hash(n - 1n), timestamp: '0x0', transactions: [] };
    }
    if (method !== 'eth_getLogs') throw new Error(method);
    const p = params[0] as { address: Address[]; blockHash?: Hex; fromBlock: Hex; toBlock: Hex };
    if (url === primary) {
      if (p.address.length > cap) {
        await delay(3_300);
        throw { ...addressRefusal, message };
      }
      peak = Math.max(peak, ++active);
      try { await serveGroup(p.address); }
      finally { active--; }
      if (p.fromBlock && BigInt(p.fromBlock) < to - 10_000n) throw Object.assign(new Error('pruned history unavailable'), { code: 4444 });
      if (failGroup && p.address[0] === addresses[50]) throw Object.assign(new Error('internal server error'), { status: 500 });
    }
    return logs.filter(l => p.address.includes(l.address) && (p.blockHash ? l.blockHash === p.blockHash
      : BigInt(l.blockNumber) >= BigInt(p.fromBlock) && BigInt(l.blockNumber) <= BigInt(p.toBlock)))
      .map(l => ({ ...l, data: failGroup && url === primary ? '0xaaaa' : l.data }));
  });
  return { reader: new RpcCoreReader({ urls: [primary, archive] }), calls, peak: () => peak, active: () => active };
}

async function drain<T>(task: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return task;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('learns within one pair of anchor checks, then reuses the limit for ranges and block hashes', async () => {
  const { reader, calls, peak } = setup();
  expect(LOG_GROUP_TAIL * 2n).toBe(RANGE_TAIL);
  observe(reader, to + 16n);
  const groupedRange = groupAddresses.map(group => logCall(primary, group, range));
  const first = await drain(reader.rangeLogs(from, to, filter, anchors));
  expect(calls.splice(0)).toEqual([...anchorCalls, logCall(primary, addresses, range), ...groupedRange, ...anchorCalls]);
  expect(peak()).toBe(6);
  expect(Date.now()).toBe(3_310);
  expect(reader['clients'][0]).toMatchObject({ limitedUntil: 0, limitFailures: 0 });

  expect(await drain(reader.rangeLogs(from, to, filter, anchors))).toEqual(first);
  expect(calls.splice(0)).toEqual([...anchorCalls, ...groupedRange, ...anchorCalls]);
  const oneBlock = await drain(reader.logsByHash(byHash.blockHash, filter));
  expect(calls.splice(0)).toEqual(groupAddresses.map(group => logCall(primary, group, byHash)));
  expect(oneBlock.map(l => l.logIndex)).toEqual([0, 1, 15, 16]);

  const reference = new RpcCoreReader({ urls: [archive] });
  expect(first).toEqual(await reference.rangeLogs(from, to, filter));
  expect(oneBlock).toEqual(await reference.logsByHash(byHash.blockHash, filter));
  expect(calls.splice(0)).toEqual([logCall(archive, addresses, range), logCall(archive, addresses, byHash)]);

  const small = addresses.slice(0, 10);
  await drain(reader.logsByHash(byHash.blockHash, { ...filter, addresses: small }));
  expect(calls).toEqual([logCall(primary, small, byHash)]);
});

it('sends the full old range to the archive and skips the primary while its history is excluded', async () => {
  const { reader, calls } = setup();
  observe(reader, to);
  await drain(reader.rangeLogs(1n, 2n, filter));
  expect(calls.splice(0)).toEqual([logCall(primary, addresses, old),
    ...groupAddresses.map(group => logCall(primary, group, old)), logCall(archive, addresses, old)]);
  await drain(reader.rangeLogs(1n, 2n, filter));
  expect(calls).toEqual([logCall(archive, addresses, old)]);
});

it('discards every group after one HTTP 500 and returns the single archive answer', async () => {
  const { reader, calls } = setup({ failGroup: true });
  const answer = await drain(reader.logsByHash(byHash.blockHash, filter));
  expect(calls.splice(0)).toEqual([logCall(primary, addresses, byHash),
    ...groupAddresses.map(group => logCall(primary, group, byHash)), logCall(archive, addresses, byHash)]);
  expect(answer).toEqual(await new RpcCoreReader({ urls: [archive] }).logsByHash(byHash.blockHash, filter));
  expect(reader['clients'][0]).toMatchObject({ limitedUntil: 0, unavailableThrough: undefined });
  // An ordinary failure leaves this block eligible on the primary.
  await drain(reader.logsByHash(byHash.blockHash, { ...filter, addresses: addresses.slice(0, 1) }));
  expect(calls.at(-1)).toEqual(logCall(primary, addresses.slice(0, 1), byHash));
});

it.each(['invalid params', 'maximum of 0 addresses'])('keeps -32602 "%s" on the ordinary fallback path', async message => {
  const { reader, calls } = setup({ message });
  for (let read = 0; read < 2; read++) {
    await drain(reader.rangeLogs(from, to, filter));
    expect(calls.splice(0)).toEqual([logCall(primary, addresses, range), logCall(archive, addresses, range)]);
  }
});

it('uses the positive integer in a case-insensitive refusal', async () => {
  const { reader, calls } = setup({ cap: 25, message: 'A MAXIMUM OF 25 ADDRESSES is allowed.' });
  await drain(reader.logsByHash(byHash.blockHash, filter));
  expect(calls).toEqual([addresses, addresses.slice(0, 25), addresses.slice(25, 50), addresses.slice(50)]
    .map(a => logCall(primary, a, byHash)));
});

const full = Array.from({ length: 200 }, (_, i) => address(i));
function groupedCalls(list: readonly Address[], size: number) {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    logCall(primary, list.slice(i * size, (i + 1) * size), byHash));
}

it('serves 200 addresses in four waves of 6, 6, 6 and 2 requests', async () => {
  const starts: number[] = [];
  const { reader, calls, peak } = setup({}, async () => {
    starts.push(Date.now());
    // Keep the first request of each wave open after its siblings have answered.
    await delay(starts.length % 6 === 1 ? 10 : 1);
  });
  await drain(reader.logsByHash(byHash.blockHash, { ...filter, addresses: full }));
  expect(calls).toEqual([logCall(primary, full, byHash), ...groupedCalls(full, 10)]);
  expect(starts).toEqual([6, 6, 6, 2].flatMap((count, i) => Array<number>(count).fill(3_300 + i * 10)));
  expect(peak()).toBe(6);
});

it('falls back above 32 groups on learning and later reads, and accepts exactly 32', async () => {
  const { reader, calls } = setup({ cap: 1, message: 'A maximum of 1 addresses is allowed.' });
  const read = () => drain(reader.logsByHash(byHash.blockHash, { ...filter, addresses: full }));
  await read();
  expect(calls.splice(0)).toEqual([logCall(primary, full, byHash), logCall(archive, full, byHash)]);
  await read();
  expect(calls.splice(0)).toEqual([logCall(archive, full, byHash)]);
  expect(reader['clients'][0]).toMatchObject({ limitedUntil: 0, limitFailures: 0 });
  const fits = full.slice(0, 32);
  await drain(reader.logsByHash(byHash.blockHash, { ...filter, addresses: fits }));
  expect(calls).toEqual(groupedCalls(fits, 1));
});

it('drains five outstanding requests for 8 seconds after the first fails, then falls back', async () => {
  const { reader, calls, active } = setup({}, async group => {
    if (group[0] === full[0]) throw Object.assign(new Error('internal server error'), { status: 500 });
    await delay(8_000);
  });
  const read = reader.logsByHash(byHash.blockHash, { ...filter, addresses: full }).then(() => Date.now());
  const firstWave = [logCall(primary, full, byHash), ...groupedCalls(full.slice(0, 60), 10)];
  await vi.advanceTimersByTimeAsync(3_300 + 7_999);
  expect(calls).toEqual(firstWave);
  expect(active()).toBe(5);
  await vi.advanceTimersByTimeAsync(1);
  expect(await read).toBe(3_300 + 8_000);
  expect(active()).toBe(0);
  expect(calls).toEqual([...firstWave, logCall(archive, full, byHash)]);
});

it('starts no further wave when an outstanding wave settles after the attempt deadline', async () => {
  const { reader, calls } = setup({}, () => delay(16_000));
  const read = reader.logsByHash(byHash.blockHash, { ...filter, addresses: full }).then(() => Date.now());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await read).toBe(15_000);
  await vi.runAllTimersAsync();
  expect(calls).toEqual([logCall(primary, full, byHash), ...groupedCalls(full.slice(0, 60), 10), logCall(archive, full, byHash)]);
});

it.each([4, 10, 15])('handles a group refusal stating a limit of %i after learning ten', async stated => {
  let refuse = true;
  const { reader, calls } = setup({}, async group => {
    if (refuse && group[0] === full[0]) {
      refuse = false;
      throw { ...addressRefusal, message: `A maximum of ${stated} addresses is allowed.` };
    }
    await delay(10);
  });
  const read = () => drain(reader.logsByHash(byHash.blockHash, filter));
  await read();
  expect(calls.splice(0)).toEqual([logCall(primary, addresses, byHash), ...groupedCalls(addresses, 10),
    logCall(archive, addresses, byHash)]);
  expect(reader['clients'][0]).toMatchObject({ limitedUntil: 0, limitFailures: 0 });
  await read();
  expect(calls).toEqual(groupedCalls(addresses, Math.min(10, stated)));
});

it.each([undefined, to, to + 15n])('skips groups for an anchored range with observed head %s', async head => {
  const { reader, calls } = setup();
  if (head !== undefined) observe(reader, head);
  const read = () => drain(reader.rangeLogs(from, to, filter, anchors));
  const archiveAnchors = anchorCalls.map(call => ({ ...call, url: archive }));
  const fallback = [...archiveAnchors, logCall(archive, addresses, range), ...archiveAnchors];
  const first = await read();
  expect(calls.splice(0)).toEqual([...anchorCalls, logCall(primary, addresses, range), ...fallback]);
  expect(await read()).toEqual(first);
  expect(calls).toEqual(fallback);
  expect(reader['clients'][0]).toMatchObject({ limitedUntil: 0, limitFailures: 0 });
});

it('groups the rebuild range when latestHeader returns a target one block above the last observed head', async () => {
  const target = 65_600n;
  const { reader, calls } = setup({ latest: target });
  await drain(reader.logsByHash(byHash.blockHash, filter));
  expect(calls.splice(0)).toEqual([logCall(primary, addresses, byHash), ...groupedCalls(addresses, 10)]);

  observe(reader, target - 1n);
  const latest = await reader.latestHeader();
  expect(latest.number).toBe(target);
  const end = latest.number - RANGE_TAIL;
  const catchUpAnchors = [end, from - 1n].map(number => ({ number, hash: hash(number) }));
  await drain(reader.rangeLogs(from, end, filter, catchUpAnchors));
  const checks = catchUpAnchors.map(a => primaryHeader(toHex(a.number)));
  const scope = { fromBlock: toHex(from), toBlock: toHex(end) };
  expect(calls.splice(0)).toEqual([primaryHeader('latest'), ...checks,
    ...groupAddresses.map(group => logCall(primary, group, scope)), ...checks]);

  // This range would qualify for groups if latestHeader() had advanced the observed head.
  const boundary = latest.number - LOG_GROUP_TAIL;
  await drain(reader.rangeLogs(from, boundary, filter));
  expect(calls).toEqual([logCall(archive, addresses, { ...scope, toBlock: toHex(boundary) })]);
});
