import { authorizeRevealTestTarget } from './reveal-test-seam.test-support';
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getAddress, sha256, zeroHash, type Hex } from 'viem';
import { rawCidV1, MAX_RAW_BLOCK_BYTES } from '@squarehole/artwork';
import { ASSET_RETRIES, boxFileAssetBytes, revealAssets as executeAssets, type RevealAssetPorts, type RevealAssetScope } from './reveal-assets';
import { addr, digest, must } from './reveal-items.test-support';
import { createRevealAssetUpload } from '../../alpha-sepolia/reveal-asset-upload';

function fixture() {
  const bytes = new Uint8Array([0, 1, 2, 128, 255]); const hash = sha256(bytes); const cid = rawCidV1(hash);
  const scope: RevealAssetScope = { chainId: 11155111, collection: addr(5), ids: [1n] };
  const controller = new AbortController(); const posts: Uint8Array[] = []; const waits: number[] = []; const methods: string[] = [];
  let present = false;
  const ports: Omit<RevealAssetPorts, 'fetch'> & { fetch: typeof fetch } = {
    upload: (...args) => createRevealAssetUpload(ports.fetch)(...args),
    read: async () => ({ block: { number: 100n, hash: digest(100) }, items: new Map([[1n, { revealed: true, image: hash, avatar: zeroHash, model: zeroHash }]]) }),
    canonical: async () => true, bytes: { read: vi.fn(async () => bytes) }, now: () => 0, sleep: async ms => { waits.push(ms); },
    fetch: vi.fn(async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'HEAD') return new Response(null, { status: present ? 200 : 404 });
      if (init?.method === 'GET') return new Response(bytes);
      posts.push(init?.body as Uint8Array); present = true;
      return Response.json({ cid, stored: true });
    }),
  };
  return { bytes, hash, cid, scope, controller, posts, waits, methods, ports, set present(v: boolean) { present = v; },
    run: () => revealAssets(scope, ports, controller.signal) };
}

describe('SH202 exact asset contract', () => {
  it('checks image/avatar/model hashes locally, posts identical bytes, verifies gateway and counts separately', async () => {
    const f = fixture();
    const read = f.ports.read;
    f.ports.read = async (...args) => ({ ...await read(...args), items: new Map([[1n, { revealed: true, image: f.hash, avatar: f.hash, model: f.hash }]]) });
    const outcome = await f.run();
    expect(outcome.picturesReady).toEqual({ finalized: 1n, latest: 1n });
    expect(outcome.outcomes.map(o => o.reason)).toEqual(['ready', 'ready', 'ready']);
    expect(f.methods).toEqual(['HEAD', 'POST', 'GET', 'HEAD', 'GET', 'HEAD', 'GET']);
    expect(f.posts[0]).toEqual(f.bytes); expect(f.posts[0]).not.toBe(f.bytes);
    expect(f.ports.fetch).toHaveBeenCalledWith(`/alpha/asset/11155111/${addr(5)}/1/image`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin', redirect: 'error', body: f.bytes, signal: expect.any(AbortSignal),
    });
  });
  it('SH-203 af4 E: missing transport still checks hosting, with no byte read or upload', async () => {
    const f = fixture();
    const result = await revealAssets(f.scope, { ...f.ports, upload: undefined }, f.controller.signal);
    expect(result.outcomes).toEqual([{ id: 1n, role: 'image', reason: 'transport-unavailable' }]);
    expect(result.revealed).toEqual({ finalized: 1n, latest: 1n });
    expect(result.picturesReady).toEqual({ finalized: 0n, latest: 0n });
    expect(f.methods).toEqual(['HEAD']);
    expect(must(f.ports.bytes).read).not.toHaveBeenCalled();
  });
  it('af4 E: hosted matching pictures count without transport, even after a missing picture', async () => {
    const f = fixture();
    const scope = { ...f.scope, ids: [1n, 2n] };
    const missing = digest(999);
    f.ports.read = async () => ({ block: { number: 100n, hash: digest(100) }, items: new Map([
      [1n, { revealed: true, image: missing, avatar: zeroHash, model: zeroHash }],
      [2n, { revealed: true, image: f.hash, avatar: zeroHash, model: zeroHash }],
    ]) });
    f.ports.fetch = vi.fn(async (url, init) => init?.method === 'HEAD'
      ? new Response(null, { status: String(url).endsWith(f.cid) ? 200 : 404 }) : new Response(f.bytes));
    const result = await revealAssets(scope, { ...f.ports, upload: undefined }, f.controller.signal);
    expect(result.outcomes.map(o => o.reason)).toEqual(['transport-unavailable', 'ready']);
    expect(result.picturesReady).toEqual({ finalized: 1n, latest: 1n });
    expect(vi.mocked(f.ports.fetch).mock.calls.map(([, init]) => init?.method)).toEqual(['HEAD', 'HEAD', 'GET']);
    expect(must(f.ports.bytes).read).not.toHaveBeenCalled();
  });
  it.each([[401, 'approval-required'], [404, 'unknown-item'], [413, 'too-large'], [415, 'bad-type'], [422, 'hash-mismatch'], [451, 'withheld'], [507, 'storage-full']] as const)(
    'reports %s %s with no automatic retry', async (status, error) => {
      const f = fixture(); const fetch = f.ports.fetch;
      f.ports.fetch = vi.fn(async (url, init) => init?.method === 'POST' ? Response.json({ error }, { status }) : fetch(url, init));
      expect((await f.run()).outcomes[0]?.reason).toBe(error);
      expect(f.waits).toEqual([]);
      expect(vi.mocked(f.ports.fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    });
  it.each([[409, 'not-revealed'], [429, 'rate-limited'], [503, 'busy']] as const)('retries %s %s only with Retry-After and caps attempts', async (status, error) => {
    const f = fixture(); const fetch = f.ports.fetch; let calls = 0;
    f.ports.fetch = async (url, init) => {
      if (init?.method !== 'POST') return fetch(url, init);
      calls++; return Response.json({ error }, { status, headers: { 'Retry-After': '2' } });
    };
    expect((await f.run()).outcomes[0]?.reason).toBe('retry-limit');
    expect(calls).toBe(ASSET_RETRIES + 1); expect(f.waits).toEqual([2000, 2000]);
  });
  it('honors an HTTP-date delay and succeeds on retry without re-encoding', async () => {
    const f = fixture(); const fetch = f.ports.fetch; let calls = 0;
    f.ports.fetch = async (url, init) => init?.method === 'POST' && calls++ === 0
      ? Response.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': new Date(3000).toUTCString() } }) : fetch(url, init);
    expect((await f.run()).picturesReady.finalized).toBe(1n); expect(f.waits).toEqual([3000]);
  });
  it.each(['61', 'garbage', null])('caps delay or refuses absent/malformed Retry-After %s', async retry => {
    const f = fixture(); const fetch = f.ports.fetch;
    f.ports.fetch = async (url, init) => init?.method === 'POST' ? Response.json({ error: 'busy' }, { status: 503, headers: retry ? { 'Retry-After': retry } : {} }) : fetch(url, init);
    expect((await f.run()).outcomes[0]?.reason).toBe(retry === '61' ? 'retry-delay-cap' : 'invalid-response'); expect(f.waits).toEqual([]);
  });
  it('HEAD withheld prevents GET, local byte reads and POST', async () => {
    const f = fixture(); f.ports.fetch = vi.fn(async () => new Response(null, { status: 451 }));
    expect((await f.run()).outcomes[0]?.reason).toBe('withheld'); expect(must(f.ports.bytes).read).not.toHaveBeenCalled(); expect(f.ports.fetch).toHaveBeenCalledTimes(1);
  });
  it('wrong local hash, oversized bytes and missing bytes stop upload', async () => {
    for (const [bytes, reason] of [[new Uint8Array([9]), 'local-hash-mismatch'], [new Uint8Array(MAX_RAW_BLOCK_BYTES + 1), 'too-large'], [null, 'needs-box-file']] as const) {
      const f = fixture(); const ports = { ...f.ports, bytes: { read: async () => bytes } };
      expect((await revealAssets(f.scope, ports, f.controller.signal)).outcomes[0]?.reason).toBe(reason); expect(f.posts).toEqual([]);
    }
  });
  it('GET bytes must match even when HEAD says present or POST says stored', async () => {
    const f = fixture(); f.present = true; const fetch = f.ports.fetch;
    f.ports.fetch = async (url, init) => init?.method === 'GET' ? new Response(new Uint8Array([99])) : fetch(url, init);
    expect((await f.run()).outcomes[0]?.reason).toBe('gateway-hash-mismatch'); expect(f.posts).toEqual([]);
  });
  it('reload mid-way trusts HEAD again; kept-copy cleanup does not remove full-file recovery', async () => {
    const f = fixture(); expect((await f.run()).picturesReady.finalized).toBe(1n);
    expect((await revealAssets(f.scope, { ...f.ports, bytes: null }, f.controller.signal)).picturesReady.finalized).toBe(1n);
    f.present = false; // Gateway lost bytes; there is no trusted uploaded flag.
    expect((await revealAssets(f.scope, { ...f.ports, bytes: null }, f.controller.signal)).outcomes[0]?.reason).toBe('needs-box-file');
    expect((await f.run()).picturesReady.finalized).toBe(1n); expect(f.posts).toHaveLength(2);
  });
  it('hidden item before finalization does not inspect hashes, HEAD, fetch bytes or upload', async () => {
    const f = fixture();
    f.ports.read = async (_scope, tag) => ({ block: { number: 100n, hash: digest(100) }, items: new Map([[1n,
      { revealed: tag === 'latest', get image(): Hex { throw new Error('secret-read'); }, avatar: f.hash, model: f.hash }]]) });
    const outcome = await f.run(); expect(outcome.revealed).toEqual({ finalized: 0n, latest: 1n }); expect(outcome.picturesReady.finalized).toBe(0n);
    expect(f.ports.fetch).not.toHaveBeenCalled(); expect(must(f.ports.bytes).read).not.toHaveBeenCalled();
  });
  it('cancellation and a reorg stop before an upload', async () => {
    const f = fixture(); f.controller.abort(); expect((await f.run()).outcomes[0]?.reason).toBe('cancelled'); expect(f.posts).toEqual([]);
    const g = fixture(); let checks = 0; g.ports.canonical = async () => ++checks <= 2;
    await expect(g.run()).rejects.toThrow('reorg'); expect(g.posts).toEqual([]);
  });
  it('invalid response cid or error code never marks pictures ready', async () => {
    for (const body of [{ cid: 'foreign', stored: true }, { cid: 'bad' }, { error: 'foreign' }]) {
      const f = fixture(); const fetch = f.ports.fetch;
      f.ports.fetch = async (url, init) => init?.method === 'POST' ? Response.json(body, { status: 'error' in body ? 409 : 200 }) : fetch(url, init);
      expect((await f.run()).outcomes[0]?.reason).toBe('error' in body ? 'not-available' : 'invalid-response');
    }
  });
});

describe('SH202 bounded box asset reader', () => {
  it('finds exact image, avatar and model bytes by hash across chunk boundaries', async () => {
    const image = new Uint8Array(100_003).fill(11), avatar = new Uint8Array(83).fill(22), model = new Uint8Array(140_001).fill(33);
    const entry = (bytes: Uint8Array) => ({ sha256: sha256(bytes), base64: Buffer.from(bytes).toString('base64') });
    const file = new Blob([JSON.stringify({ format: 'squarehole.boxspec/2', spec: { description: 'quoted "text"' },
      pictures: [{ role: 'item', ...entry(image) }, { role: 'item', ...entry(avatar) }], models: [{ type: 'model/gltf-binary', ...entry(model) }] })]);
    const slices = vi.spyOn(file, 'slice');
    const indexed = await boxFileAssetBytes(file);
    expect(slices).not.toHaveBeenCalled();
    expect(await indexed.read(sha256(image), 'image')).toEqual(image);
    expect(await indexed.read(sha256(avatar), 'avatar')).toEqual(avatar);
    expect(await indexed.read(sha256(model), 'model')).toEqual(model);
    expect(await indexed.read(digest(123), 'image')).toBeNull();
  });
  it('refuses excess file size and escaped base64; permits reused picture hashes', async () => {
    await expect(boxFileAssetBytes({ size: 256 * 1024 * 1024 + 1 } as Blob)).rejects.toThrow('file-byte-limit');
    const entry = { sha256: digest(1), base64: 'AA==' };
    expect(await (await boxFileAssetBytes(new Blob([JSON.stringify({ pictures: [entry, entry] })]))).read(digest(1), 'image')).toEqual(new Uint8Array([0]));
    const escaped = await boxFileAssetBytes(new Blob([`{"pictures":[{"sha256":"${digest(1)}","base64":"A\\u0041=="}]}\n`]));
    await expect(escaped.read(digest(1), 'image')).rejects.toThrow('noncanonical-base64');
  });
});


describe('af1 asset regressions', () => {
  it.each(['malformed', 'oversize', 'endless'])('M5 rejects and cancels %s response bodies before parsing', async kind => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const fetch = f.ports.fetch; const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        if (kind !== 'endless') { controller.enqueue(new TextEncoder().encode(kind === 'oversize' ? ' '.repeat(65_537) + '{}' : '{')); }
        if (kind === 'malformed') controller.close();
      }, cancel });
      f.ports.fetch = async (url, init) => init?.method === 'POST' ? new Response(stream) : fetch(url, init);
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(30_001);
      // Close the HEAD implementation's unbounded read too, so the red test terminates.
      if (kind !== 'malformed') await stream.cancel().catch(() => undefined);
      const outcome = await Promise.race([pending, Promise.resolve(null)]);
      expect(outcome?.outcomes[0]?.reason).toBe('invalid-response');
      if (kind !== 'malformed') expect(cancel).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('L2 uploads an owned copy when the caller mutates its buffer during canonical checks', async () => {
    const f = fixture(); const original = f.bytes.slice(); let checks = 0;
    f.ports.canonical = async () => { if (++checks === 3) f.bytes.fill(9); return true; };
    await f.run();
    expect(f.posts[0]).toEqual(original); expect(f.posts[0]).not.toBe(f.bytes);
  });
  it.each(['120', '0'])('L3 service backoff stops the entire pass with Retry-After %s', async retry => {
    const f = fixture(); const read = f.ports.read; const fetch = f.ports.fetch; let posts = 0;
    f.ports.read = async (...args) => ({ ...await read(...args), items: new Map([[1n, { revealed: true, image: f.hash, avatar: f.hash, model: f.hash }]]) });
    f.ports.fetch = async (url, init) => { if (init?.method !== 'POST') return fetch(url, init); posts++; return Response.json({ error: 'busy' }, { status: 503, headers: { 'Retry-After': retry } }); };
    const outcome = await f.run();
    expect(posts).toBe(retry === '120' ? 1 : 3);
    expect(outcome.outcomes.slice(1).every(o => o.reason === 'deferred')).toBe(true);
  });
  it.each(['not-available', 'feature-disabled'])('server contract uses lowercase collection and decimal item id and distinguishes %s', async error => {
    const f = fixture(); const fetch = f.ports.fetch; const urls: string[] = [];
    const scope = { ...f.scope, collection: getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'), ids: [123n] };
    f.ports.read = async () => ({ block: { number: 100n, hash: digest(100) }, items: new Map([[123n, { revealed: true, image: f.hash, avatar: zeroHash, model: zeroHash }]]) });
    f.ports.fetch = async (url, init) => { if (init?.method !== 'POST') return fetch(url, init); urls.push(String(url)); return Response.json({ error }, { status: 503 }); };
    const outcome = await revealAssets(scope, f.ports, f.controller.signal);
    expect(urls).toEqual(['/alpha/asset/11155111/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd/123/image']);
    expect(outcome.outcomes[0]?.reason).toBe('not-available');
  });
});

it.each(['request', 'gateway'])('M5 deadlines cancel an endless %s and return invalid-response', async kind => {
  vi.useFakeTimers();
  try {
    const f = fixture(); const fetch = f.ports.fetch; let signal: AbortSignal | null | undefined;
    f.ports.fetch = async (url, init) => {
      if (init?.method === (kind === 'request' ? 'POST' : 'GET')) { signal = init.signal; return new Promise<Response>(() => {}); }
      return fetch(url, init);
    };
    const pending = f.run(); await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).outcomes[0]?.reason).toBe('invalid-response'); expect(signal?.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));

const revealAssets = (...args: Parameters<typeof executeAssets>) => executeAssets(args[0], authorizeRevealTestTarget(args[1]), args[2]);
