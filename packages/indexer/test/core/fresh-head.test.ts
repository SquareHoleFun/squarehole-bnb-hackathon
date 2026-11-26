import { afterEach, expect, it, vi } from 'vitest';
import { toHex, type Hex } from 'viem';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { RpcCoreReader } from '../../src/core/core-reader';
import { synthManifest, World } from './core-synth';
import { fakeRpc } from './rpc-fixture';

const base = 12_174_928n;
const behind = 12_162_210n;
const slot = 12_000;
const hash = (n: bigint) => toHex(n, { size: 32 });
// Spread the missed slots through the run: 275 single, 23 double and two triple slots per 300 heads.
const seenAt = (n: bigint) => {
  const i = Number(n - base);
  return slot * (i + Math.floor(i / 13) + 2 * Math.floor(i / 150));
};
const header = (n: bigint) => ({ number: n, hash: hash(n), parentHash: hash(n - 1n), timestamp: BigInt(seenAt(n) / 1000) + 1_800_000_000n });
const epoch = Number(header(base).timestamp) * 1000;
const urls = ['https://publicnode.invalid', 'https://tenderly.invalid', 'https://0xrpc.invalid'];

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function follow(heads: number, delay: (n: bigint, endpoint: number) => number, timeouts = false) {
  vi.useFakeTimers({ now: epoch });
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(line => errors.push(String(line)));
  const manifest = synthManifest();
  const published = new Map<bigint, number>();
  let tip = base;
  let worstAge = 0;
  const calls = fakeRpc(({ url, method, params }) => {
    const endpoint = urls.indexOf(url);
    const holds = (n: bigint) => endpoint === 2 ? n <= behind
      : n <= tip && (n <= base || Date.now() >= epoch + seenAt(n) + delay(n, endpoint));
    if (method === 'eth_chainId') return toHex(manifest.chainId);
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? (endpoint === 2 ? behind : holds(tip) ? tip : tip - 1n) : BigInt(params[0] as Hex);
      return holds(n) ? { ...header(n), number: toHex(n), timestamp: toHex(header(n).timestamp), transactions: [] } : null;
    }
    if (method === 'eth_getLogs') {
      const scope = params[0] as { blockHash?: Hex; toBlock: Hex };
      if (holds(BigInt(scope.blockHash ?? scope.toBlock))) return [];
      // Publicnode and Tenderly both returned -32001 for a missing hash in the live probes.
      if (endpoint === 2) throw Object.assign(new Error('unknown block'), { code: -32000 });
      throw Object.assign(new Error(`block not found: hash ${scope.blockHash}`), { code: -32001 });
    }
    throw new Error(`unexpected ${method}`);
  });
  let primaryRequests = 0;
  const hungDurations: number[] = [];
  if (timeouts) {
    const respond = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      if (new URL(url).origin !== urls[0] || ++primaryRequests % 50 !== 0) return respond(url, init);
      const start = Date.now();
      const signal = init.signal;
      if (!signal) throw new Error('the reader sends every request with a signal');
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => {
          hungDurations.push(Date.now() - start);
          reject(signal.reason);
        }, { once: true });
      });
    });
  }
  const indexer = new CoreChainIndexer({
    reader: new RpcCoreReader({ urls }),
    manifest: { ...manifest, versions: manifest.versions.map(v => ({ ...v, startBlock: String(base) })) },
    onHistory: message => {
      if (message.type === 'block') published.set(message.result.block.number, Date.now() - epoch);
    },
  });
  await indexer.start();
  expect(indexer.head()?.number).toBe(base);
  for (let i = 1; i <= heads; i++) {
    const next = base + BigInt(i);
    await vi.advanceTimersByTimeAsync(epoch + seenAt(next) - Date.now());
    tip = next;
    indexer.onHead(header(tip)); // A websocket notice, without first warming the reader via HTTP.
    await vi.advanceTimersByTimeAsync(5_000);
    const read = indexer.head();
    if (!read) throw new Error('the indexer has read no block yet');
    worstAge = Math.max(worstAge, Date.now() - Number(read.timestamp) * 1000);
  }
  await vi.advanceTimersByTimeAsync(11_000);
  await indexer.idle();
  indexer.stop();
  const first = base + 1n;
  const firstCalls = calls.filter(c => c.method === 'eth_getLogs' && (c.params[0] as { blockHash?: Hex }).blockHash === hash(first));
  const firstLatency = (published.get(first) ?? Infinity) - seenAt(first);
  return { firstLatency, firstEndpoints: firstCalls.map(c => urls.indexOf(c.url)), errors, published, worstAge, hungDurations };
}

it('reads a websocket block within three seconds when HTTP obtains it one second later', async () => {
  const result = await follow(6, () => 1_000);
  process.stdout.write(`first block ${base + 1n}: ${result.firstLatency}ms; endpoints ${result.firstEndpoints.join(',')}; failed heads ${result.errors.map(e => e.split(':')[0]).join(',') || 'none'}\n`);
  expect(result.firstLatency).toBeLessThanOrEqual(3_000);
  expect(result.firstEndpoints).toEqual([0, 1, 2, 0]);
  expect(result.errors).toEqual([]);
  expect(result.published.size).toBe(7);
});

it.each([false, true])('publishes the replacement branch within two seconds (parent announced: %s)', async announceParent => {
  const original = new World('original');
  const ancestor = original.block(10n);
  const orphan = original.block(11n);
  const fork = original.fork(ancestor.number, 'replacement');
  const parent = fork.block(11n);
  const child = fork.block(12n);
  fork.to(18n); // Enough subsequent notices to expose the original 60-second hash cooldown.
  const childNotice = Number(child.timestamp) * 1000;
  vi.useFakeTimers({ now: Number(ancestor.timestamp) * 1000 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const manifest = synthManifest();
  let canonical = [ancestor];
  fakeRpc(({ url, method, params }) => {
    const held = url === urls[2] ? [] : canonical;
    if (method === 'eth_chainId') return toHex(manifest.chainId);
    if (method === 'eth_getLogs') {
      const { blockHash, toBlock } = params[0] as { blockHash?: Hex; toBlock: Hex };
      if (held.some(b => blockHash ? b.hash === blockHash : b.number === BigInt(toBlock))) return [];
      if (url === urls[2]) throw Object.assign(new Error('unknown block'), { code: -32000 });
      throw Object.assign(new Error(`block not found: hash ${blockHash}`), { code: -32001 });
    }
    if (method !== 'eth_getBlockByHash' && method !== 'eth_getBlockByNumber') throw new Error(`unexpected ${method}`);
    const block = method === 'eth_getBlockByHash' ? held.find(b => b.hash === params[0])
      : params[0] === 'latest' ? held.at(-1) : held.find(b => b.number === BigInt(params[0] as Hex));
    return block ? { ...block, number: toHex(block.number), timestamp: toHex(block.timestamp), transactions: [] } : null;
  });

  let childLatency: number | undefined;
  const indexer = new CoreChainIndexer({
    reader: new RpcCoreReader({ urls }), manifest,
    onHistory: m => {
      if (m.type === 'block' && m.result.block.hash === child.hash) childLatency = Date.now() - childNotice;
    },
  });
  await indexer.start();
  await vi.advanceTimersByTimeAsync(slot);
  canonical.push(orphan);
  indexer.onHead(orphan);
  await indexer.idle();
  expect(indexer.head()?.hash).toBe(orphan.hash);

  for (const head of fork.headers.slice(2)) {
    await vi.advanceTimersByTimeAsync(Number(head.timestamp) * 1000 - Date.now());
    if (head === child && announceParent) indexer.onHead(parent);
    indexer.onHead(head);
    await vi.advanceTimersByTimeAsync(1_000);
    if (head === child) canonical = [ancestor, parent];
    canonical.push(head);
  }
  await vi.advanceTimersByTimeAsync(slot);
  await indexer.idle();
  indexer.stop();
  expect(childLatency).toBe(2_000);
  expect(indexer.metrics.errors).toBe(0);
  expect(indexer.head()?.hash).toBe(fork.headers.at(-1)?.hash);
});

it.each([false, true])('publishes every one of 300 heads with 0–2000 ms HTTP lag (timeouts: %s)', async timeouts => {
  let seed = 240;
  const draw = () => {
    seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
    return seed % 2_001;
  };
  const delays = Array.from({ length: 300 }, () => [draw(), draw()] as const);
  const delayOf = (n: bigint, endpoint: number): number => {
    const delay = delays[Number(n - base - 1n)]?.[endpoint];
    if (delay === undefined) throw new Error(`no delay drawn for block ${n} at endpoint ${endpoint}`);
    return delay;
  };
  const result = await follow(300, delayOf, timeouts);
  const numbers = Array.from({ length: 300 }, (_, i) => base + BigInt(i + 1));
  const worstLatency = Math.max(...numbers.map(n => (result.published.get(n) ?? Infinity) - seenAt(n)));
  process.stdout.write(`300 heads, timeouts=${timeouts}: ${result.published.size - 1} published, worst age at +5s ${result.worstAge}ms, worst latency ${worstLatency}ms, ${result.hungDurations.length} timeouts\n`);
  expect([...result.published.keys()]).toEqual([base, ...numbers]);
  expect(result.errors).toEqual([]);
  expect(result.hungDurations.length > 0).toBe(timeouts);
  expect(result.hungDurations.every(duration => duration === 10_000)).toBe(true);
  if (timeouts) expect(result.worstAge).toBeLessThan(35_000);
  else {
    expect(result.worstAge).toBeLessThanOrEqual(30_000);
    expect(worstLatency).toBeLessThanOrEqual(3_000);
  }
});

it.each(['unknown block', 'block not found', 'historical state unavailable',
  // SH-259: BNB Chain testnet's prebsc endpoint (probe of 25 November).
  'historical state 0x3f2d9c1e is not available'])('bounds retries for a near-head "%s" and keeps lower blocks readable', async message => {
  vi.useFakeTimers({ now: epoch });
  const head = base + 4n;
  const calls = fakeRpc(({ params }) => {
    const n = BigInt(params[0] as Hex);
    if (n === base) throw Object.assign(new Error(message), { code: message === 'unknown block' ? -32000 : -32001 });
    return { ...header(n), number: toHex(n), timestamp: toHex(header(n).timestamp), transactions: [] };
  });
  const reader = new RpcCoreReader({ urls });
  reader.observeHead(header(head));
  const refused = expect(reader.headerByNumber(base)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.map(c => c.url)).toEqual(urls);
  const before = calls.length;
  await reader.headerByNumber(base - 1n);
  expect(calls.slice(before).map(c => c.url)).toEqual([urls[0]]);
  await vi.advanceTimersByTimeAsync(2_000);
  await refused;
  expect(calls.slice(before + 1).map(c => c.url)).toEqual(urls);
});

it('keeps a historical block-not-found cooldown when a later head notice comes from a lagging source', async () => {
  vi.useFakeTimers({ now: epoch });
  const calls = fakeRpc(({ params, url }) => {
    const n = BigInt(params[0] as Hex);
    if (url === urls[0] && n === base) throw Object.assign(new Error('block not found'), { code: -32001 });
    return { ...header(n), number: toHex(n), timestamp: toHex(header(n).timestamp), transactions: [] };
  });
  const reader = new RpcCoreReader({ urls });
  reader.observeHead(header(base + 5n));
  reader.observeHead(header(behind));
  await reader.headerByNumber(base);
  expect(calls.splice(0).map(c => c.url)).toEqual(urls.slice(0, 2));
  await vi.advanceTimersByTimeAsync(59_999);
  await reader.headerByNumber(base - 1n);
  expect(calls.splice(0).map(c => c.url)).toEqual([urls[1]]);
  await vi.advanceTimersByTimeAsync(1);
  await reader.headerByNumber(base - 1n);
  expect(calls.map(c => c.url)).toEqual([urls[0]]);
});
