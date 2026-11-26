import { createPublicClient, http, toHex, type Address, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { RpcCoreReader, type LogFilter } from '../../src/core/core-reader';
import { addressRefusal } from './rpc-fixture';

const archive = 'https://archive.invalid', fallback = 'https://fallback.invalid';
const first = 0xb99b03n, hint = 0xb99bb8n, last = first + 4_999n;
const measuredBody = '{"id":1,"jsonrpc":"2.0","error":{"code":-32602,"message":"invalid params","data":"Query returned more than 20000 results. Try with this block range [0xb99b03, 0xb99bb8]."}}';
const address = (i: number) => toHex(i + 1, { size: 20 });
const hash = (n: bigint) => toHex(n, { size: 32 });
const filter: LogFilter = { addresses: [address(0)], topics: [hash(1n)], poolManager: null, poolIds: [], poolTopics: [],
  settlementAddresses: [], settlementTopics: [], settlementOwners: [] };

type Params = { address: Address[] } & (
  { fromBlock: Hex; toBlock: Hex; blockHash?: never } | { fromBlock?: never; toBlock?: never; blockHash: Hex }
);
const scope = (from: bigint, to: bigint) => ({ fromBlock: toHex(from), toBlock: toHex(to) });
function rpcError(message: string, data?: string, code = -32602) {
  return JSON.stringify({ id: 1, jsonrpc: '2.0', error: { code, message, data } });
}
const sameSpan = (p: Params, a: bigint, b: bigint) => p.fromBlock === toHex(a) && p.toBlock === toHex(b);

function log(number: bigint, index: number, contract: number) {
  return { address: address(contract), topics: filter.topics, data: '0x', blockNumber: toHex(number),
    blockHash: hash(number), transactionHash: hash(number), transactionIndex: '0x0', logIndex: toHex(index) };
}

// Serve the supplied response bytes directly. The second endpoint serves the uncut reference logs.
function setup(refuse: (p: Params) => string | undefined, logs: ReturnType<typeof log>[] = [], maxAddresses = 200) {
  const reader = new RpcCoreReader({ urls: [archive, fallback], maxAddresses });
  const reference = new RpcCoreReader({ urls: [fallback] });
  const calls: { url: string; p: Params }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { method, params: [p], id } = JSON.parse(init.body as string) as { method: string; params: [Params]; id: number };
    if (method !== 'eth_getLogs') throw new Error(method);
    const origin = new URL(url).origin;
    calls.push({ url: origin, p });
    if (origin === archive) {
      if (p.address.length > 10) return Response.json({ id, jsonrpc: '2.0', error: { code: addressRefusal.code, message: addressRefusal.message } },
        { status: addressRefusal.status });
      const bytes = refuse(p);
      if (bytes) return new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
    }
    const result = logs.filter(l => p.address.includes(l.address) && (p.blockHash !== undefined ? p.blockHash === l.blockHash
      : BigInt(l.blockNumber) >= BigInt(p.fromBlock) && BigInt(l.blockNumber) <= BigInt(p.toBlock)));
    return Response.json({ jsonrpc: '2.0', id, result });
  });
  const spans = () => calls.map(({ url, p }) => [url, p.fromBlock, p.toBlock]);
  return { reader, reference, calls, spans };
}
const sent = (a: bigint, b: bigint, url = archive) => [url, toHex(a), toHex(b)];

afterEach(() => { vi.unstubAllGlobals(); });

it('preserves the measured HTTP 200 error on viem 2.56.8 and splits its 5,000-block range at the suggestion', async () => {
  const logs = [log(first, 1, 0), log(hint, 0, 0), log(hint + 1n, 0, 0), log(last, 0, 0)];
  const { reader, reference, calls, spans } = setup(p => sameSpan(p, first, last) ? measuredBody : undefined, logs);
  const client = createPublicClient({ transport: http(archive, { retryCount: 0 }) });
  const wireError = JSON.parse(measuredBody).error;
  await expect(client.request({ method: 'eth_getLogs', params: [{ ...scope(first, last), address: [address(0)] }] })).rejects.toMatchObject({
    name: 'InvalidParamsRpcError', code: -32602, details: 'invalid params',
    cause: { name: 'RpcRequestError', code: -32602, details: 'invalid params', data: wireError.data, cause: wireError },
  });
  const truth = await reference.rangeLogs(first, last, filter);
  expect(truth).toHaveLength(4);
  calls.length = 0;
  expect(await reader.rangeLogs(first, last, filter)).toEqual(truth);
  expect(spans()).toEqual([sent(first, last), sent(first, hint), sent(hint + 1n, last)]);
  calls.length = 0;
  expect(await reader.rangeLogs(first, last, filter)).toEqual(truth);
  expect(spans()).toEqual([sent(first, last - 1n), sent(last, last)]);
  for (const endpoint of reader['clients']) {
    expect(endpoint).toMatchObject({ limitedUntil: 0, limitFailures: 0, historyUntil: 0, unavailableThrough: undefined, active: 0, waiters: [] });
    expect(endpoint.unavailableHashes.size).toBe(0);
  }
});

it('follows a second suggestion and resumes full spans from its end without replaying a sibling plan', async () => {
  const end = first + 7_000n, firstHint = 0xb99eean;
  const secondFilter = { ...filter, addresses: [address(0), address(1)] };
  const logs = [log(first, 0, 0), log(hint, 0, 1), log(firstHint, 1, 0), log(last + 1n, 1, 0), log(end, 0, 1)];
  const { reader, reference, calls } = setup(p => {
    if (p.address[0] !== address(0)) return;
    if (sameSpan(p, first, last)) return rpcError('invalid params', 'Query returned more than 20000 results. Try with this block range [0xb99b03, 0xb99eea].');
    if (sameSpan(p, first, firstHint)) return measuredBody;
  }, logs, 1);
  const truth = await reference.rangeLogs(first, end, secondFilter);
  calls.length = 0;
  expect(await reader.rangeLogs(first, end, secondFilter)).toEqual(truth);
  expect(calls.every(c => c.url === archive)).toBe(true);
  const ranges = (contract: Address) => calls.filter(c => c.p.address[0] === contract).map(c => [c.p.fromBlock, c.p.toBlock]);
  const bounds = (a: bigint, b: bigint) => [toHex(a), toHex(b)];
  expect(ranges(address(0))).toEqual([bounds(first, last), bounds(first, firstHint), bounds(first, hint),
    bounds(hint + 1n, hint + 5_000n), bounds(hint + 5_001n, end)]);
  expect(ranges(address(1))).toEqual([bounds(first, last), bounds(last + 1n, end)]);
});

it.each(['[0x11, 0x15]', '[0x10, 0xf]', '[0x10, 0x19]', '[0x10, 0x20]', '[0x10, banana]', ''])(
  'halves a result-count refusal in the message with unusable suggestion "%s"', async suggestion => {
    const { reader, spans } = setup(p => sameSpan(p, 16n, 25n) ? rpcError(`MORE THAN 3 RESULTS. ${suggestion}`) : undefined);
    await reader.rangeLogs(16n, 25n, filter);
    expect(spans()).toEqual([sent(16n, 25n), sent(16n, 20n), sent(21n, 25n)]);
  });

it.each(['number', 'hash'])('names the single block and the endpoint result limit by %s in one send', async mode => {
  const { reader, calls } = setup(() => measuredBody);
  reader.observeHead({ number: first, hash: hash(first), parentHash: hash(first - 1n), timestamp: 0n });
  const message = `block ${first}: the endpoint reports more than 20000 results`;
  if (mode === 'hash') await expect(reader.logsByHash(hash(first), filter)).rejects.toThrow(message);
  else await expect(reader.rangeLogs(first, first, filter)).rejects.toThrow(message);
  expect(calls.map(c => c.url)).toEqual([archive]);
});

it('retries a previously refused single block and keeps its enclosing pair split after recovery', async () => {
  let refusing = true;
  const end = first + 3n;
  const { reader, reference, calls, spans } = setup(p => refusing && p.fromBlock === toHex(first) ? measuredBody : undefined,
    [log(first, 0, 0), log(end, 0, 0)]);
  const truth = await reference.rangeLogs(first, end, filter);
  calls.length = 0;
  await expect(reader.rangeLogs(first, end, filter)).rejects.toThrow(`block ${first}: the endpoint reports more than 20000 results`);
  expect(spans()).toEqual([sent(first, end), sent(first, first + 1n), sent(first, first)]);

  refusing = false;
  calls.length = 0;
  expect(await reader.rangeLogs(first, end, filter)).toEqual(truth);
  expect(spans()).toEqual([sent(first, first), sent(first + 1n, end)]);
});

it('repeats all six address groups on the suggested prefix and remainder when one group hits the count limit', async () => {
  const addresses = Array.from({ length: 57 }, (_, i) => address(i));
  const grouped = { ...filter, addresses };
  const { reader, reference, calls } = setup(p => p.address[0] === address(10) && sameSpan(p, first, last) ? measuredBody : undefined,
    [log(first, 1, 55), log(hint, 0, 11), log(last, 1, 2)]);
  reader.observeHead({ number: last + 32n, hash: hash(last + 32n), parentHash: hash(last + 31n), timestamp: 0n });
  const truth = await reference.rangeLogs(first, last, grouped);
  calls.length = 0;
  expect(await reader.rangeLogs(first, last, grouped)).toEqual(truth);
  const groups = [0, 10, 20, 30, 40, 50].map(i => addresses.slice(i, i + 10));
  const wave = (a: bigint, b: bigint) => groups.map(address => ({ address, ...scope(a, b) }));
  expect(calls.every(c => c.url === archive)).toBe(true);
  expect(calls.map(({ p }) => ({ address: p.address, fromBlock: p.fromBlock, toBlock: p.toBlock }))).toEqual([
    { address: addresses, ...scope(first, last) }, ...wave(first, last), ...wave(first, hint), ...wave(hint + 1n, last),
  ]);
});

it.each([
  rpcError('invalid params', 'More than 0 results'),
  rpcError('invalid params', 'More than 1.5 results'),
  rpcError('invalid params', 'More than 20000 results', -32005),
])('leaves a different refusal on the ordinary fallback path (%s)', async body => {
  const { reader, spans } = setup(() => body);
  await reader.rangeLogs(first, last, filter);
  expect(spans()).toEqual([sent(first, last), sent(first, last, fallback)]);
});
