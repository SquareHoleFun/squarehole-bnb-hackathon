import { AddOnId, BOX_0_MISFITS } from '@squarehole/box-spec';
import { toHex, type Address, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { RpcCoreReader } from '../../src/core/core-reader';
import { agreeingCalls, synthBox, synthManifest, World } from './core-synth';
import { addressRefusal, chainRpcAnswer, fakeRpc, type Request } from './rpc-fixture';

const creation = 12_003_304n;
const firstHead = creation + 174_000n;
const urls = ['https://pruned.invalid', 'https://archive.invalid'] as const;
const rateLimit = () => Object.assign(new Error('rate limit exceeded'), { status: 429, code: -32005 });
const pruned = (n: bigint) => Object.assign(new Error(`pruned history unavailable: requested ${n}, earliest available ${firstHead - 10_000n}`), { code: 4444 });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function startup(capacity: number, blackoutUntil = 0) {
  vi.useFakeTimers({ now: 0 });
  const world = new World();
  const spec = { ...BOX_0_MISFITS, addOns: BOX_0_MISFITS.addOns.filter(a => a.id === AddOnId.PerItemStream) };
  const boxes = Array.from({ length: 6 }, (_, i) => synthBox({ boxId: BigInt(i), creationBlock: creation, spec }));
  expect(boxes.map(box => box.codes.size)).toEqual([10, 10, 10, 10, 10, 10]);
  const { hash } = world.block(creation, boxes.map(box => world.created(box)));
  // The backfill jumps to the 32-block tail. Only the creation and tail headers need to exist.
  const tail = new World();
  tail.block(firstHead - 32n);
  tail.to(firstHead + 19n);
  world.headers.push(...tail.headers);
  const chain = world.chain();
  chain.tip = firstHead;
  const reader = new RpcCoreReader({ urls });
  const manifest = synthManifest();
  const newIndexer = () => {
    const indexer = new CoreChainIndexer({ reader, manifest: { ...manifest,
      versions: manifest.versions.map(v => ({ ...v, startBlock: String(creation) })) } });
    chain.callAnswers = agreeingCalls(indexer);
    return indexer;
  };
  const answer = chainRpcAnswer(chain);
  function requestedBlock({ method, params }: Request) {
    if (method === 'eth_getBlockByNumber') return params[0] === 'latest' ? chain.tip : BigInt(params[0] as Hex);
    const filter = params[0] as { fromBlock?: Hex; blockHash?: Hex } | undefined;
    if (filter?.fromBlock) return BigInt(filter.fromBlock);
    const blockHash = method === 'eth_getBlockByHash' ? params[0] : filter?.blockHash ?? (params[1] as { blockHash?: Hex } | undefined)?.blockHash;
    return chain.byHash.get(blockHash as Hex)?.number ?? chain.tip;
  }
  const counters = () => ({ requests: 0, active: 0, peak: 0, limited: 0, oversizedLogRequests: 0 });
  const endpoints = [counters(), counters()] as const;
  const calls = fakeRpc(async request => {
    const archive = request.url === urls[1];
    const endpoint = endpoints[archive ? 1 : 0];
    endpoint.requests++;
    const inFlight = ++endpoint.active;
    endpoint.peak = Math.max(endpoint.peak, inFlight);
    const refused = archive && (Date.now() < blackoutUntil || inFlight > capacity);
    try {
      if (!archive && request.method === 'eth_getLogs') {
        const { address } = request.params[0] as { address: Address | Address[] };
        if (Array.isArray(address) && address.length > 10) {
          endpoint.oversizedLogRequests++;
          await new Promise(resolve => setTimeout(resolve, 3_300));
          throw addressRefusal;
        }
      }
      // A quick refusal can be retried at 300 ms while all seven admitted archive code reads are still busy.
      const latency = archive && request.method === 'eth_getCode' && !refused ? 350 : 10;
      await new Promise(resolve => setTimeout(resolve, latency));
      const block = requestedBlock(request);
      const earliest = chain.tip - 10_000n;
      if (!archive && block < earliest) throw Object.assign(new Error(`pruned history unavailable: requested ${block}, earliest available ${earliest}`), { code: 4444 });
      if (refused) {
        endpoint.limited++;
        throw rateLimit();
      }
      return await answer(request);
    } finally { endpoint.active--; }
  });
  const creationReads = () => calls.filter(c => c.method === 'eth_getCode' && (c.params[1] as { blockHash: Hex }).blockHash === hash);
  return { chain, newIndexer, endpoints, creationReads };
}

async function drain<T>(task: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return task;
}

it.each([7, 2])('starts six boxes at the first head with archive capacity %i', async capacity => {
  const { chain, newIndexer, endpoints, creationReads } = startup(capacity);
  const indexer = newIndexer();
  const elapsed = await drain(indexer.start().then(() => Date.now()));
  console.warn(`K=${capacity} first head: ${elapsed}ms, boxes=${indexer.boxes.size}, A/B=${JSON.stringify(endpoints)}`);
  expect(indexer.metrics.lastError).toBeNull();
  expect(indexer.head()?.number).toBe(firstHead);
  expect(indexer.boxes.size).toBe(6);
  // Discovery reads the ten roles of a box together on the primary.
  expect(endpoints[0].peak).toBe(10);
  expect(endpoints[1].peak).toBeLessThanOrEqual(4);
  expect(endpoints[1].limited).toBe(capacity === 2 ? 48 : 0);
  expect(endpoints[1].requests).toBe(capacity === 2 ? 340 : 292);
  expect(endpoints[0].requests).toBe(365);
  expect(endpoints[0].oversizedLogRequests).toBe(1);
  // Each start includes the single 3,300 ms refusal that teaches the reader the address limit (R1).
  expect(elapsed).toBe(capacity === 2 ? 57_130 : 13_090);
  expect(new Set(creationReads().map(c => c.params[0])).size).toBe(60);

  // Force discovery to run again at a new head, even though every box was already published.
  indexer.stop();
  chain.tip++;
  const restarted = newIndexer();
  const before = creationReads().length;
  await drain(restarted.start());
  expect(restarted.head()?.number).toBe(firstHead + 1n);
  expect(restarted.boxes.size).toBe(6);
  expect(creationReads().length - before).toBe(0);
  restarted.stop();
});

it('publishes the next head after the archive refuses all RPCs for 40 s', async () => {
  const { chain, newIndexer } = startup(7, 40_000);
  const indexer = newIndexer();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await drain(indexer.start());
  expect(indexer.head()).toBeNull();
  expect(indexer.metrics.errors).toBe(1);
  expect(indexer.metrics.lastError).toMatch(/anchor unavailable|request exceeds defined limit/i);
  expect(Date.now()).toBeLessThan(40_000);

  await vi.advanceTimersByTimeAsync(40_000 - Date.now());
  chain.tip++;
  await drain(indexer.enqueue(chain.header(chain.tip)));
  expect(indexer.head()?.number).toBe(chain.tip);
  expect(indexer.boxes.size).toBe(6);
  expect(indexer.metrics.errors).toBe(1);
  indexer.stop();
});

it('exhausts 30 s of cooldowns during a 40 s outage and retries only missing code at the next head', async () => {
  vi.useFakeTimers({ now: 0 });
  const address = toHex(1, { size: 20 });
  const missing = toHex(2, { size: 20 });
  const hash = toHex(creation, { size: 32 });
  const attempts: number[] = [];
  let outage = false;
  const calls = fakeRpc(({ url, params }) => {
    if (url === urls[0]) throw Object.assign(new Error(`pruned history unavailable: requested ${creation}, earliest available ${firstHead - 10_000n}`), { code: 4444 });
    if (params[0] === missing) attempts.push(Date.now());
    if (outage && Date.now() < 40_000) throw rateLimit();
    return '0x6000';
  });
  const reader = new RpcCoreReader({ urls });
  // This role was authenticated before the archive outage began.
  await reader.codeAt(address, hash);
  outage = true;
  const failed = expect(reader.codeAt(missing, hash)).rejects.toThrow(/rate limit exceeded|request exceeds defined limit/i);
  await drain(failed);
  expect(Date.now()).toBe(30_000);
  expect(attempts).toEqual([0, 1_000, 3_000, 7_000, 15_000]);

  await vi.advanceTimersByTimeAsync(10_000);
  reader.observeHead({ number: firstHead + 1n, hash: toHex(firstHead + 1n), parentHash: toHex(firstHead), timestamp: 40n });
  const before = calls.length;
  expect(await reader.codeAt(address, hash)).toBe('0x6000');
  expect(await reader.codeAt(missing, hash)).toBe('0x6000');
  expect(calls.slice(before).map(c => [c.url, c.params[0]])).toEqual([[urls[1], missing]]);
  expect(attempts.at(-1)).toBe(40_000);
});

function latencyProbe() {
  let active = 0, peak = 0;
  return {
    get peak() { return peak; },
    async delay() {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
    },
  };
}

it('sends all 40 head views together when Multicall3 has no code', async () => {
  vi.useFakeTimers({ now: 0 });
  const reader = new RpcCoreReader({ urls: [urls[0]] });
  const hash = toHex(firstHead, { size: 32 });
  reader.observeHead({ number: firstHead, hash, parentHash: toHex(firstHead - 1n), timestamp: 0n });
  const endpoint = latencyProbe();
  const calls = fakeRpc(async ({ method, params }) => {
    await endpoint.delay();
    if (method === 'eth_getCode') return '0x';
    return (params[0] as { data: Hex }).data;
  });
  const views = Array.from({ length: 40 }, (_, i) => ({ to: toHex(i, { size: 20 }), data: toHex(i, { size: 1 }) }));
  const results = await drain(reader.callViewsAt(views, hash));
  expect(results).toEqual(views.map(({ data }) => ({ status: 'fulfilled', value: data })));
  expect(calls.map(c => c.method)).toEqual(['eth_getCode', ...Array(40).fill('eth_call')]);
  expect(endpoint.peak).toBe(40);
});

it('sends 40 code reads together to the first endpoint when both have the block', async () => {
  vi.useFakeTimers({ now: 0 });
  const reader = new RpcCoreReader({ urls });
  const endpoint = latencyProbe();
  const calls = fakeRpc(async () => {
    await endpoint.delay();
    return '0x6000';
  });
  const hash = toHex(creation, { size: 32 });
  const reads = Array.from({ length: 40 }, (_, i) => reader.codeAt(toHex(i, { size: 20 }), hash));
  expect(await drain(Promise.all(reads))).toEqual(Array(40).fill('0x6000'));
  expect(calls.map(c => c.url)).toEqual(Array(40).fill(urls[0]));
  expect(endpoint.peak).toBe(40);
});

it('shares four archive FIFO slots between anchored log reads and queued calls', async () => {
  vi.useFakeTimers({ now: 0 });
  const reader = new RpcCoreReader({ urls });
  const address = toHex(1, { size: 20 });
  const hash = toHex(creation, { size: 32 });
  const filter = { addresses: [address], topics: [], poolManager: null, poolIds: [], poolTopics: [], settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
  const archive = latencyProbe();
  const calls = fakeRpc(async ({ url, method, params }) => {
    if (url === urls[0]) throw pruned(method === 'eth_getBlockByNumber' ? BigInt(params[0] as Hex) : creation);
    await archive.delay();
    if (method === 'eth_getBlockByNumber') {
      const n = BigInt(params[0] as Hex);
      return { number: toHex(n), hash: toHex(n, { size: 32 }), parentHash: hash, timestamp: '0x1', transactions: [] };
    }
    return method === 'eth_getLogs' ? [] : '0x';
  });
  const blocks = Array.from({ length: 4 }, (_, i) => creation + BigInt(i));
  const ranges = blocks.map(n => reader.rangeLogs(n, n, filter, [{ number: n, hash: toHex(n, { size: 32 }) }]));
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.filter(c => c.url === urls[1]).map(c => c.params[0])).toEqual(blocks.map(n => toHex(n)));
  const data = Array.from({ length: 8 }, (_, i) => toHex(i));
  const queued = data.map(d => reader.callAt(address, d, hash));
  await drain(Promise.all([...ranges, ...queued]));
  const primary = calls.filter(c => c.url === urls[0]);
  expect(primary.filter(c => c.method === 'eth_getBlockByNumber').map(c => c.params[0])).toEqual(blocks.map(n => toHex(n)));
  expect(primary.filter(c => c.method === 'eth_call').map(c => (c.params[0] as { data: Hex }).data)).toEqual(data);
  expect(primary).toHaveLength(ranges.length + queued.length);
  const served = calls.filter(c => c.url === urls[1]);
  expect(archive.peak).toBe(4);
  expect(served.map(c => c.method)).toEqual([
    ...Array(4).fill('eth_getBlockByNumber'), ...Array(4).fill('eth_getLogs'), ...Array(4).fill('eth_getBlockByNumber'), ...Array(8).fill('eth_call'),
  ]);
  expect(served.filter(c => c.method === 'eth_call').map(c => (c.params[0] as { data: Hex }).data)).toEqual(data);
});

it('serves a current read after HTTP 500 while the archive FIFO is full', async () => {
  vi.useFakeTimers({ now: 0 });
  const reader = new RpcCoreReader({ urls });
  const address = toHex(1, { size: 20 });
  const old = toHex(creation, { size: 32 }), head = toHex(firstHead, { size: 32 });
  reader.observeHead({ number: firstHead, hash: head, parentHash: toHex(firstHead - 1n), timestamp: 0n });
  const calls = fakeRpc(async ({ url, method, params }) => {
    const { blockHash } = params[1] as { blockHash: Hex };
    if (url === urls[0]) {
      if (blockHash === old) throw pruned(creation);
      throw Object.assign(new Error('internal server error'), { status: 500 });
    }
    if (method === 'eth_getCode') return '0x6000';
    if (blockHash === old) await new Promise(resolve => setTimeout(resolve, 100));
    return (params[0] as { data: Hex }).data;
  });
  // Warm the history exclusion. All eight old calls must skip the primary on entry.
  await reader.codeAt(address, old);
  const data = Array.from({ length: 8 }, (_, i) => toHex(i, { size: 1 }));
  const queued = Promise.all(data.map(d => reader.callAt(address, d, old)));
  const archiveCalls = () => calls.filter(c => c.url === urls[1] && c.method === 'eth_call').map(c => (c.params[0] as { data: Hex }).data);
  await vi.advanceTimersByTimeAsync(0);
  expect(archiveCalls()).toEqual(data.slice(0, 4));
  const current = reader.callAt(address, '0xff', head);
  await vi.advanceTimersByTimeAsync(0);
  expect(archiveCalls()).toEqual([...data.slice(0, 4), '0xff']);
  expect(await current).toBe('0xff');
  expect(await drain(queued)).toEqual(data);
  expect(archiveCalls()).toEqual([...data.slice(0, 4), '0xff', ...data.slice(4)]);
  expect(calls.filter(c => c.url === urls[0]).map(c => c.method)).toEqual(['eth_getCode', 'eth_call']);
});

it.each([
  ['HTTP text', { status: 429, message: 'rate limit exceeded' }],
  ['Tenderly JSON-RPC', rateLimit()],
  ['JSON-RPC with alternate wording', { status: 429, code: -32005, message: 'Too Many Requests' }],
  ['Infura requests per second', { status: 429, code: -32005, message: 'project ID request rate exceeded',
    data: { current_rps: 12, allowed_rps: 10, backoff_seconds: 1 } }],
  ['Infura daily requests', { status: 429, code: -32005, message: 'daily request count exceeded, request rate limited' }],
  ['Infura -33200', { status: 429, code: -33200, message: 'Too Many Requests' }],
  ['Alchemy compute units', { status: 429, code: 429, message: 'Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message. If not, check out https://docs.alchemy.com/reference/throughput' }],
  ['Alchemy empty body', { status: 429, message: '' }],
  // SH-259: BNB Chain's official dataseed endpoints answer a JSON-RPC error without an HTTP 429 (probe of 25 November).
  ['BNB dataseed limit exceeded', { code: -32005, message: 'limit exceeded' }],
] as const)('recovers an old code read after three seconds of %s refusals', async (_, refusal) => {
  vi.useFakeTimers({ now: 0 });
  const reader = new RpcCoreReader({ urls });
  const attempts: [string, number][] = [];
  fakeRpc(({ url }) => {
    attempts.push([url, Date.now()]);
    if (url === urls[0]) throw Object.assign(new Error('pruned history unavailable'), { code: 4444 });
    if (Date.now() < 3_000) throw refusal;
    return '0x6000';
  });
  const result = reader.codeAt(toHex(1, { size: 20 }), toHex(creation, { size: 32 }));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(attempts).toEqual([[urls[0], 0], [urls[1], 0], [urls[1], 1_000], [urls[1], 3_000]]);
  expect(await result).toBe('0x6000');
});

it('uses the ordinary retry after a closed Alchemy connection', async () => {
  vi.useFakeTimers({ now: 0 });
  const attempts: number[] = [];
  vi.stubGlobal('fetch', async () => {
    attempts.push(Date.now());
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  });
  const reader = new RpcCoreReader({ urls: [urls[0]] });
  const failed = expect(reader.codeAt(toHex(1, { size: 20 }), toHex(creation, { size: 32 }))).rejects.toMatchObject({
    name: 'HttpRequestError', details: 'fetch failed', cause: { cause: { code: 'UND_ERR_SOCKET' } },
  });
  await drain(failed);
  expect(attempts).toEqual([0, 150]);
});

it('falls through the Alchemy Free range refusal on each read and groups on the next endpoint', async () => {
  vi.useFakeTimers({ now: 0 });
  const alchemy = 'https://free.invalid';
  const reader = new RpcCoreReader({ urls: [alchemy, ...urls] });
  reader.observeHead({ number: firstHead, hash: toHex(firstHead), parentHash: toHex(firstHead - 1n), timestamp: 0n });
  const addresses = Array.from({ length: 57 }, (_, i) => toHex(i + 1, { size: 20 }));
  const filter = { addresses, topics: [], poolManager: null, poolIds: [], poolTopics: [],
    settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
  const calls = fakeRpc(({ url, params }) => {
    if (url === alchemy) throw { status: 400, code: -32600, message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0xb6b4f1, 0xb6b4fa]. Upgrade to PAYG for expanded block range.' };
    if (url === urls[0] && (params[0] as { address: Address[] }).address.length > 10) throw addressRefusal;
    return [];
  });
  for (let read = 0; read < 2; read++) {
    expect(await reader.rangeLogs(0xb6b4f1n, 0xb6b4f1n + 63n, filter)).toEqual([]);
    expect(calls.splice(0).map(c => [c.url, (c.params[0] as { address: Address[] }).address.length])).toEqual([
      [alchemy, 57], ...(read === 0 ? [[urls[0], 57]] : []), ...[10, 10, 10, 10, 10, 7].map(n => [urls[0], n]),
    ]);
  }
  expect(Date.now()).toBe(0);
});

it('uses the ordinary retry for a JSON-RPC -32005 log result-size limit', async () => {
  vi.useFakeTimers({ now: 0 });
  const reader = new RpcCoreReader({ urls: [urls[1]] });
  const attempts: number[] = [];
  fakeRpc(() => {
    attempts.push(Date.now());
    throw Object.assign(new Error('query returned more than 10000 results'), { code: -32005 });
  });
  const filter = { addresses: [toHex(1, { size: 20 })], topics: [], poolManager: null, poolIds: [], poolTopics: [], settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
  const failed = expect(reader.logsByHash(toHex(creation, { size: 32 }), filter)).rejects.toThrow(/more than 10000 results/i);
  await drain(failed);
  expect(attempts).toEqual([0, 150]);
});

it.each([
  { archiveOnly: false, timeoutMs: undefined },
  { archiveOnly: true, timeoutMs: undefined },
  { archiveOnly: true, timeoutMs: 250 },
])('bounds 50 stalled response bodies (archive-only $archiveOnly, transport timeout $timeoutMs)', async ({ archiveOnly, timeoutMs }) => {
  vi.useFakeTimers({ now: 0 });
  const stalledUrl = 'https://stalled.invalid';
  const sources = archiveOnly ? [urls[0], stalledUrl, urls[1]] : [stalledUrl, urls[1]];
  const reader = new RpcCoreReader({ urls: sources, timeoutMs });
  const deadline = (timeoutMs ?? 10_000) + 5_000;
  const stalled: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fallbacks: number[] = [];
  fakeRpc(({ url }) => {
    if (url === urls[0]) throw pruned(creation);
    fallbacks.push(Date.now());
    return '0xbeef';
  });
  const respond = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    if (new URL(url).origin === stalledUrl) {
      // Headers arrive immediately. Leave the body open through the entire fallback run.
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stalled.push(controller); } }));
    }
    return respond(url, init);
  });
  const hash = toHex(creation, { size: 32 });
  const reads = Array.from({ length: 50 }, (_, i) => reader.codeAt(toHex(i, { size: 20 }), hash));
  const results = Promise.all(reads);
  await vi.advanceTimersByTimeAsync(deadline - 1);
  const width = archiveOnly ? 4 : reads.length;
  expect(stalled).toHaveLength(width);
  expect(fallbacks).toEqual([]);
  await vi.advanceTimersByTimeAsync(1 + (Math.ceil(reads.length / width) - 1) * deadline);
  expect(stalled).toHaveLength(50);
  expect(fallbacks).toEqual(reads.map((_, i) => (1 + Math.floor(i / width)) * deadline));
  expect(await results).toEqual(Array(50).fill('0xbeef'));
  for (const endpoint of reader['clients']) expect(endpoint).toMatchObject({ active: 0, waiters: [] });
  expect(vi.getTimerCount()).toBe(0);

  // Late success and rejection both settle after all 50 fallback answers have been delivered.
  for (const [i, controller] of stalled.entries()) {
    if (i % 2) controller.error(new Error('late body failure'));
    else {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: i, result: '0xdead' })));
      controller.close();
    }
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(await reader.codeAt(toHex(0, { size: 20 }), hash)).toBe('0xbeef');
});

it.each(['0x', null, 12, 'bad code', '0xgg', '0x1'])('asks again after empty or malformed code (%j) and keeps valid bytecode', async invalid => {
  const reader = new RpcCoreReader({ urls });
  const address = toHex(1, { size: 20 });
  const hash = toHex(creation, { size: 32 });
  let code = invalid;
  const calls = fakeRpc(() => code);
  expect(await reader.codeAt(address, hash)).toBe(invalid);
  code = '0x6000';
  expect(await reader.codeAt(address, hash)).toBe('0x6000');
  expect(await reader.codeAt(address, hash)).toBe('0x6000');
  expect(calls.map(call => call.method)).toEqual(['eth_getCode', 'eth_getCode']);
});

it('exhausts 30 s of cooldown waits even when the wall clock stays frozen', async () => {
  vi.useFakeTimers({ now: 1_000 });
  vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const reader = new RpcCoreReader({ urls: [urls[1]] });
  const calls = fakeRpc(() => { throw rateLimit(); });
  let rejected = false;
  const failure = expect(reader.latestHeader()).rejects.toThrow(/rate limit exceeded/i).then(() => { rejected = true; });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(rejected).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(rejected).toBe(true);
  await failure;
  expect(calls).toHaveLength(1);
});

it('evicts the oldest of 2,048 non-empty code answers keyed by address and hash', async () => {
  const reader = new RpcCoreReader({ urls });
  const calls = fakeRpc(() => '0x6000');
  const address: Address = toHex(0xab, { size: 20 });
  const hash = (i: number) => toHex(i, { size: 32 });
  for (let i = 0; i < 2_048; i++) await reader.codeAt(address, hash(i));
  await reader.codeAt(address.toUpperCase().replace('0X', '0x') as Address, hash(0));
  await reader.codeAt(address, hash(2_048));
  await reader.codeAt(address, hash(1));
  expect(calls).toHaveLength(2_049);
  await reader.codeAt(address, hash(0));
  expect(calls).toHaveLength(2_050);
});

it('uses the archive as soon as it cools even while the primary waits for head propagation', async () => {
  vi.useFakeTimers({ now: 0 });
  const reader = new RpcCoreReader({ urls });
  const hash = toHex(firstHead, { size: 32 });
  reader.observeHead({ number: firstHead, hash, parentHash: toHex(firstHead - 1n), timestamp: 0n });
  const requests: [string, number][] = [];
  fakeRpc(({ url }) => {
    requests.push([url, Date.now()]);
    if (url === urls[0]) throw Object.assign(new Error('block not found'), { code: -32001 });
    if (Date.now() < 1_000) throw rateLimit();
    return '0x12';
  });
  const read = reader.callAt(toHex(1, { size: 20 }), '0x', hash);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(requests).toEqual([[urls[0], 0], [urls[1], 0], [urls[1], 1_000]]);
  expect(await read).toBe('0x12');
});
