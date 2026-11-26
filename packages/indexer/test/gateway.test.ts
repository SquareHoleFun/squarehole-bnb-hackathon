import { connect, type Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { SEPOLIA_REHEARSAL } from '../src/config';
import { encodeFrame, eventId, seqOf } from '../src/frame';
import { Gateway, type GatewayOptions } from '../src/gateway/server';
import { firstScoreOf, type BlockHeader } from '../src/model';
import { PoolIndexer } from '../src/pipeline';
import { MemoryStore } from '../src/store/memory-store';
import type { BlockEvent, LiveSnapshot, TradeView } from '../src/views';
import { fakeHeader, loadRecordedFixture, ScriptedChain } from './scripted-chain';
import { openSse, type SseConnection } from './sse-client';
import { synthSwap, txHash } from './synth';

const T = SEPOLIA_REHEARSAL;
const fixture = loadRecordedFixture();
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await sleep(10);
  if (!check()) throw new Error('condition not reached in time');
}

async function setup(options: Partial<GatewayOptions> = {}, existing?: { store: MemoryStore; chain: ScriptedChain; indexer: PoolIndexer }) {
  const chain = existing?.chain ?? ScriptedChain.fromFixture(fixture, T);
  const store = existing?.store ?? new MemoryStore();
  const indexer = existing?.indexer ?? new PoolIndexer({ reader: chain, store, target: T, confirmations: 2 });
  if (!existing) await indexer.start();
  await indexer.idle();
  const gateway = new Gateway({ store, target: T, port: 0, host: '127.0.0.1', heartbeatMs: 40, aliveCheckMs: 20, ...options });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  if (!existing) cleanups.push(() => store.close());
  const { port } = gateway.address();
  const base = `http://127.0.0.1:${port}/v1/pools/11155111/${T.poolId}`;
  let parent = chain.headerAt(fixture.toBlock);
  let sqrt = fixture.atEnd.sqrtPriceX96;
  let branch = 9;
  const mine = async (withTrade: boolean, from?: BlockHeader): Promise<BlockHeader> => {
    if (from) {
      parent = from;
      branch += 1;
    }
    const header = fakeHeader(branch, parent.number + 1n, parent.hash, parent.timestamp + 12n);
    const swap = withTrade ? synthSwap(T, header, txHash(Number(header.number % 100_000n) + branch * 1_000), 3, sqrt, true, 10n ** 17n) : null;
    if (swap) sqrt = swap.sqrtAfter;
    if (from) chain.reorgTo([{ header, logs: swap?.logs ?? [] }]);
    else chain.addBlock(header, swap?.logs ?? []);
    parent = header;
    indexer.onHead(header, 'ws', Date.now());
    await indexer.idle();
    return header;
  };
  /** The indexer's heartbeat as service.ts writes it. */
  const beat = async (): Promise<void> => store.heartbeat(JSON.stringify({ ...indexer.heartbeatInfo(), atMs: Date.now() }));
  const sse = (path = '/stream', headers: Record<string, string> = {}): SseConnection => {
    const connection = openSse(`${base}${path}`, { headers });
    cleanups.push(() => connection.close());
    return connection;
  };
  return { chain, store, indexer, gateway, base, port, mine, sse, beat };
}

/** A frame with the next sequence number after the gateway's newest (as the indexer would write it). */
function nextFrame(gateway: Gateway, type: 'block' | 'status', event: string, skip = 0): string {
  const seq = (gateway.metrics.lastSeq ?? 0) + 1 + skip;
  return encodeFrame({ type, id: type === 'block' ? eventId(seq, 99_000_000n + BigInt(seq % 1_000), `0x${'ab'.repeat(32)}`) : eventId(seq), etag: '', event, snapshot: null });
}

/** A raw HTTP client that asks for the stream and then never reads (a stuck or hostile viewer). */
function stuckClient(port: number): Socket {
  const socket = connect(port, '127.0.0.1');
  socket.on('connect', () => {
    socket.write(`GET /v1/pools/11155111/${T.poolId}/stream?snapshot=0 HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`);
    socket.pause();
  });
  socket.on('error', () => undefined);
  cleanups.push(() => void socket.destroy());
  return socket;
}

describe('gateway: snapshot and history endpoints', () => {
  it('serves the pre-built snapshot with an ETag (own tag for gzip), 304 on weak and listed matches, edge-cache headers', async () => {
    const { base, store } = await setup();
    const etag = (await store.getSnapshot())?.etag ?? '';
    const res = await fetch(`${base}/snapshot`, { headers: { 'Accept-Encoding': 'identity' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(`"${etag}"`);
    expect(res.headers.get('x-sh-indexer')).toBe('stale'); // no heartbeat in this test
    expect(res.headers.get('cache-control')).toBe('public, max-age=1, s-maxage=2, stale-while-revalidate=10, stale-if-error=300');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const snapshot = (await res.json()) as LiveSnapshot;
    expect(snapshot.head.number).toBe('11812130');
    for (const header of [`"${etag}"`, `W/"${etag}"`, `"other", W/"${etag}"`, `"${etag}-gz"`, '*']) {
      expect((await fetch(`${base}/snapshot`, { headers: { 'If-None-Match': header } })).status).toBe(304);
    }
    expect((await fetch(`${base}/snapshot`, { headers: { 'If-None-Match': '"other"' } })).status).toBe(200);
    // Raw gzip bytes (node:http, not fetch, so nothing decodes them on the way).
    const { request } = await import('node:http');
    const gz = await new Promise<{ encoding: string | undefined; etag: string | undefined; body: Buffer }>((resolve, reject) => {
      request(`${base}/snapshot`, { headers: { 'Accept-Encoding': 'gzip' } }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => resolve({ encoding: r.headers['content-encoding'], etag: r.headers.etag, body: Buffer.concat(chunks) }));
      }).on('error', reject).end();
    });
    expect(gz.encoding).toBe('gzip');
    expect(gz.etag).toBe(`"${etag}-gz"`);
    expect((JSON.parse(gunzipSync(gz.body).toString('utf8')) as LiveSnapshot).head.hash).toBe(fixture.atEnd.hash);
  });

  it('serves trade history in the same shape as the snapshot and the stream', async () => {
    const { base, store } = await setup();
    const page = (await (await fetch(`${base}/trades?limit=5`)).json()) as { trades: TradeView[] };
    const snapshot = JSON.parse((await store.getSnapshot())?.json ?? '{}') as LiveSnapshot;
    expect(page.trades).toHaveLength(1);
    expect(page.trades[0]).toEqual(snapshot.trades[0]);
    expect(Object.keys(page.trades[0] ?? {}).sort()).toEqual(Object.keys(snapshot.trades[0] ?? {}).sort());
    expect(page.trades[0]).toMatchObject({ route: 'bootstrap', eth: '0.0015' });
  });

  it('caches a history page for a day only when it is full, wholly finalized and the indexer is live; never an empty page', async () => {
    const { base, chain, indexer, beat } = await setup();
    chain.finalityTags = { safe: 11_812_110n, finalized: 11_812_100n };
    await indexer.refreshFinality();
    await beat();
    const before = firstScoreOf(11_812_100n);
    await until(() => true);
    await sleep(60);
    const full = await fetch(`${base}/trades?before=${before}&limit=1`);
    expect((await full.json()) as { trades: unknown[] }).toMatchObject({ trades: [{ route: 'bootstrap' }] });
    expect(full.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    const short = await fetch(`${base}/trades?before=${before}&limit=5`); // one row of five: history may be incomplete
    expect(short.headers.get('cache-control')).toBe('public, max-age=12');
    const empty = await fetch(`${base}/trades?before=${firstScoreOf(50n)}&limit=5`);
    expect(((await empty.json()) as { trades: unknown[] }).trades).toEqual([]);
    expect(empty.headers.get('cache-control')).toBe('public, max-age=12');
    const newer = await fetch(`${base}/trades?limit=1`);
    expect(newer.headers.get('cache-control')).toBe('public, max-age=12');
  });

  it('serves the curve shape; refuses other pools and writes', async () => {
    const { base, port } = await setup();
    const curve = (await (await fetch(`${base}/curve`)).json()) as { points: unknown[]; curve: { raiseWei: string } };
    expect(curve.points).toHaveLength(33);
    expect(curve.curve.raiseWei).toBe('4216794836692248391');
    expect((await fetch(`http://127.0.0.1:${port}/v1/pools/11155111/0x${'00'.repeat(32)}/snapshot`)).status).toBe(404);
    expect((await fetch(`${base}/snapshot`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/snapshot`, { method: 'OPTIONS' })).status).toBe(204);
  });

  it('serves /metrics and the debug page only to a direct local request, unless exposed on purpose', async () => {
    const { port } = await setup();
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('access-control-allow-origin')).toBeNull();
    expect(((await metrics.json()) as { rssBytes: number }).rssBytes).toBeGreaterThan(0);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Read-only');
    expect(html).not.toMatch(/<input|<button|<form|eth_sendTransaction|eth_requestAccounts/);
    // Through a proxy on the same machine (Cloudflare Tunnel, nginx): the peer is loopback, the headers say otherwise.
    const relayed: Record<string, string>[] = [{ 'X-Forwarded-For': '203.0.113.9' }, { 'CF-Connecting-IP': '203.0.113.9' }];
    for (const headers of relayed) {
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { headers })).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/`, { headers })).status).toBe(404);
    }
    const exposed = await setup({ exposeDebug: true });
    expect((await fetch(`http://127.0.0.1:${exposed.port}/metrics`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status).toBe(200);
  });
});

describe('gateway: indexer status (live, stale, unverified)', () => {
  it('is stale without a heartbeat, live with one and fresh blocks; /healthz and X-SH-Indexer follow', async () => {
    const { base, port, sse, beat, mine } = await setup();
    const stream = sse();
    await stream.waitFor((m) => m.event === 'status' && m.data.includes('"stale"'));
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
    await mine(false);
    await beat();
    await stream.waitFor((m) => m.event === 'status' && m.data.includes('"live"'));
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, status: 'live' });
    expect((await fetch(`${base}/snapshot`)).headers.get('x-sh-indexer')).toBe('live');
  });

  it('goes stale when no block arrives for 3 slots even though the indexer process is alive (Medium finding)', async () => {
    const { port, sse, beat, gateway, mine } = await setup({ staleAfterMs: 150 });
    await mine(false);
    await beat();
    const stream = sse();
    await stream.waitFor((m) => m.event === 'status' && m.data.includes('"live"'));
    // The heartbeat keeps coming (the process is alive), but no block is committed: the curve is frozen.
    const timer = setInterval(() => void beat(), 20);
    cleanups.push(() => clearInterval(timer));
    const stale = await stream.waitFor((m) => m.event === 'status' && m.data.includes('no new block'));
    expect(JSON.parse(stale.data)).toMatchObject({ indexer: 'stale', reason: 'no new block' });
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
    expect(gateway.metrics.status).toBe('stale');
    await mine(false);
    await stream.waitFor((m) => m.event === 'status' && m.data.includes('"live"') && m.receivedAtMs > stale.receivedAtMs);
  });

  it('goes stale when the head in the heartbeat stops advancing', async () => {
    const { store, sse, gateway, mine } = await setup({ staleAfterMs: 150 });
    await mine(false);
    const frozen = JSON.stringify({ head: '1', publishedHead: '1', publishedAtMs: Date.now(), verified: true, catchingUp: false, atMs: Date.now() });
    const beats = setInterval(() => void store.heartbeat(frozen), 20);
    const blocks = setInterval(() => void store.publish(nextFrame(gateway, 'block', '{}')), 30);
    cleanups.push(() => clearInterval(beats), () => clearInterval(blocks));
    const stream = sse();
    const stale = await stream.waitFor((m) => m.event === 'status' && m.data.includes('not advancing'));
    expect(JSON.parse(stale.data)).toMatchObject({ indexer: 'stale', reason: 'indexer head not advancing' });
  });

  it('reports "unverified" as soon as the indexer says its state differs from the chain', async () => {
    const { base, port, store, sse, beat, gateway, mine } = await setup();
    await mine(false);
    await beat();
    const stream = sse();
    await stream.waitFor((m) => m.event === 'status' && m.data.includes('"live"'));
    await store.publish(nextFrame(gateway, 'status', JSON.stringify({ verified: false, catchingUp: false, head: '1', atMs: Date.now() })));
    await stream.waitFor((m) => m.event === 'status' && m.data.includes('"unverified"'));
    expect((await fetch(`${base}/snapshot`)).headers.get('x-sh-indexer')).toBe('unverified');
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(503);
  });
});

describe('gateway: SSE stream', () => {
  it('sends the snapshot on connect, then one block event per block with a sequence id and the gateway stamp', async () => {
    const { sse, mine } = await setup();
    const stream = sse();
    expect(await stream.status).toBe(200);
    const first = await stream.waitFor((m) => m.event === 'snapshot');
    expect((JSON.parse(first.data) as LiveSnapshot).head.number).toBe('11812130');
    const header = await mine(true);
    const block = await stream.waitFor((m) => m.event === 'block');
    const event = JSON.parse(block.data) as BlockEvent;
    expect(block.id).toMatch(new RegExp(`^\\d+-${header.number}:${header.hash.slice(2, 10)}$`));
    expect(block.gwAtMs).not.toBeNull();
    expect(event.trades).toHaveLength(1);
    expect(event.state.swapCount).toBe(2);
    expect(event.head.number).toBe(header.number.toString());
    await stream.waitFor(() => false, 120).catch(() => undefined);
    expect(stream.comments.some((c) => c.startsWith('hb '))).toBe(true);
    expect(stream.comments.some((c) => c.startsWith('connected '))).toBe(true);
  });

  it('resumes from Last-Event-ID without a snapshot, and resyncs on an unknown or old-format id', async () => {
    const { sse, mine } = await setup();
    const live = sse();
    await live.waitFor((m) => m.event === 'snapshot');
    const a = await mine(false);
    const firstId = (await live.waitFor((m) => m.event === 'block')).id ?? '';
    const b = await mine(true);
    const c = await mine(false);
    await live.waitFor((m) => m.event === 'block' && m.id?.includes(`-${c.number}:`) === true);
    const resumed = sse('/stream', { 'Last-Event-ID': firstId });
    const next = await resumed.waitFor((m) => m.event === 'block');
    expect(next.id?.includes(`-${b.number}:`)).toBe(true);
    await resumed.waitFor((m) => m.event === 'block' && m.id?.includes(`-${c.number}:`) === true);
    expect(resumed.messages.some((m) => m.event === 'snapshot')).toBe(false);
    expect(a.number + 1n).toBe(b.number);
    for (const id of ['1-1:deadbeef', `${a.number}:${a.hash.slice(2, 10)}`, '99999999999999-1:deadbeef']) {
      const stale = sse('/stream', { 'Last-Event-ID': id });
      await stale.waitFor((m) => m.event === 'resync');
      await stale.waitFor((m) => m.event === 'snapshot');
    }
  });

  it('a client whose last event was a reorg is not sent the orphaned blocks again (Low finding)', async () => {
    const { sse, mine, chain } = await setup();
    const live = sse();
    await live.waitFor((m) => m.event === 'snapshot');
    const base = await mine(false);
    await mine(true); // this block and its trade are replaced below
    const first = await mine(false, base); // a sibling below our head: ignored until its branch is longer
    const second = await mine(false); // at our height on the other branch: reorg to `base`, then `first` and `second`
    const reorg = await live.waitFor((m) => m.event === 'reorg');
    await live.waitFor((m) => m.event === 'block' && m.id?.includes(`-${second.number}:`) === true);
    expect(chain.headerAt(first.number).hash).toBe(first.hash);
    const resumed = sse('/stream', { 'Last-Event-ID': reorg.id ?? '' });
    await resumed.waitFor((m) => m.event === 'block' && m.id?.includes(`-${second.number}:`) === true);
    await sleep(50);
    expect(resumed.messages.filter((m) => m.event === 'reorg' || m.event === 'resync' || m.event === 'snapshot')).toEqual([]);
    expect(resumed.messages.filter((m) => m.event === 'block').map((m) => m.id?.split('-')[1])).toEqual([`${first.number}:${first.hash.slice(2, 10)}`, `${second.number}:${second.hash.slice(2, 10)}`]);
  });

  it('seeds its replay buffer from the stream at start, so a client can resume across a gateway restart', async () => {
    const first = await setup();
    const live = first.sse();
    await live.waitFor((m) => m.event === 'snapshot');
    await first.mine(false);
    const early = (await live.waitFor((m) => m.event === 'block')).id ?? '';
    await first.mine(true);
    const later = await first.mine(false);
    const second = await setup({}, { store: first.store, chain: first.chain, indexer: first.indexer });
    const resumed = second.sse('/stream', { 'Last-Event-ID': early });
    await resumed.waitFor((m) => m.event === 'block' && m.id?.includes(`-${later.number}:`) === true);
    expect(resumed.messages.filter((m) => m.event === 'block')).toHaveLength(2);
    expect(resumed.messages.some((m) => m.event === 'resync')).toBe(false);
  });

  it('forwards an indexer resync as resync + snapshot, and answers a gap in the sequence the same way', async () => {
    const { sse, gateway, store, mine } = await setup();
    const stream = sse();
    await stream.waitFor((m) => m.event === 'snapshot');
    await mine(false);
    await stream.waitFor((m) => m.event === 'block');
    // Frames the gateway never saw (as if its reader was away and the stream had been trimmed): a gap.
    await store.publish(nextFrame(gateway, 'block', '{"lost":true}', 3));
    const resync = await stream.waitFor((m) => m.event === 'resync');
    expect(JSON.parse(resync.data)).toMatchObject({ reason: 'gateway missed frames' });
    await until(() => stream.messages.indexOf(resync) < stream.messages.length - 1);
    const snapshot = stream.messages[stream.messages.indexOf(resync) + 1]; // by order: timestamps can tie
    expect(snapshot?.event).toBe('snapshot');
    expect(seqOf(snapshot?.id ?? '')).toBe(gateway.metrics.lastSeq);
    expect(gateway.metrics.gapsDetected).toBe(1);
    expect(stream.messages.some((m) => m.data.includes('"lost"'))).toBe(false);
    // A frame the gateway already has (a re-read) is dropped.
    const blocksBefore = stream.messages.filter((m) => m.event === 'block').length;
    await store.publish(nextFrame(gateway, 'block', '{"again":true}', -1));
    await sleep(50);
    expect(stream.messages.filter((m) => m.event === 'block')).toHaveLength(blocksBefore);
    expect(gateway.metrics.duplicateFrames).toBe(1);
  });

  it('fans one event out to many connections', async () => {
    const { sse, mine, gateway } = await setup({ maxStreamsPerIp: 1_000 }); // all from 127.0.0.1
    const streams = Array.from({ length: 50 }, () => sse('/stream?snapshot=0'));
    await Promise.all(streams.map((s) => s.status));
    await sleep(50);
    expect(gateway.metrics.clients).toBe(50);
    const header = await mine(true);
    const got = await Promise.all(streams.map((s) => s.waitFor((m) => m.event === 'block' && m.id?.includes(`-${header.number}:`) === true)));
    expect(got).toHaveLength(50);
    expect(new Set(got.map((m) => m.data)).size).toBe(1);
    expect(gateway.metrics.lastFanoutClients).toBe(50);
  });

  it('keeps a stream open past the request timeout (it only bounds receiving the request)', async () => {
    const { sse, gateway } = await setup({ requestTimeoutMs: 200, heartbeatMs: 50 });
    const stream = sse('/stream?snapshot=0');
    expect(await stream.status).toBe(200);
    await sleep(700);
    expect(gateway.metrics.clients).toBe(1);
    const beats = stream.comments.filter((c) => c.startsWith('hb ')).length;
    await sleep(150);
    expect(stream.comments.filter((c) => c.startsWith('hb ')).length).toBeGreaterThan(beats);
  });
});

describe('gateway: limits (Medium finding)', () => {
  it('caps streams per address; trusts CF-Connecting-IP only from a trusted proxy', async () => {
    const direct = await setup({ maxStreamsPerIp: 2, trustedProxies: [] });
    const a = direct.sse('/stream?snapshot=0', { 'CF-Connecting-IP': '198.51.100.1' });
    const b = direct.sse('/stream?snapshot=0', { 'CF-Connecting-IP': '198.51.100.2' });
    expect([await a.status, await b.status]).toEqual([200, 200]);
    // The header is ignored from an untrusted peer: all three come from 127.0.0.1.
    const c = direct.sse('/stream?snapshot=0', { 'CF-Connecting-IP': '198.51.100.3' });
    expect(await c.status).toBe(429);
    expect(direct.gateway.metrics.refusedPerIp).toBe(1);

    const proxied = await setup({ maxStreamsPerIp: 2, trustedProxies: ['127.0.0.1'] });
    const ips = ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.1', '198.51.100.1'];
    const statuses = [];
    for (const ip of ips) statuses.push(await proxied.sse('/stream?snapshot=0', { 'CF-Connecting-IP': ip }).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });

  it('refuses streams beyond the process cap with a jittered Retry-After', async () => {
    const { sse, gateway, base } = await setup({ maxClients: 2 });
    expect([await sse('/stream?snapshot=0').status, await sse('/stream?snapshot=0').status]).toEqual([200, 200]);
    const refused = await fetch(`${base}/stream`);
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(3);
    expect(gateway.metrics.refusedFull).toBe(1);
  });

  it('drops a client that stops reading once its buffer passes the limit', async () => {
    const { port, gateway, store } = await setup({ maxBufferedBytes: 64 * 1024 });
    stuckClient(port);
    await until(() => gateway.metrics.clients === 1);
    const padding = 'x'.repeat(200_000);
    for (let i = 0; i < 40 && gateway.metrics.droppedSlowClients === 0; i += 1) {
      await store.publish(nextFrame(gateway, 'block', JSON.stringify({ padding })));
      await sleep(5);
    }
    expect(gateway.metrics.droppedSlowClients).toBe(1);
    expect(gateway.metrics.clients).toBe(0);
  });

  it('drops a client that has not drained for longer than the stall limit', async () => {
    const { port, gateway, store } = await setup({ maxBufferedBytes: 64 * 1024 * 1024, stallMs: 100 });
    stuckClient(port);
    await until(() => gateway.metrics.clients === 1);
    const padding = 'x'.repeat(100_000);
    for (let i = 0; i < 100 && gateway.metrics.droppedStalledClients === 0; i += 1) {
      await store.publish(nextFrame(gateway, 'block', JSON.stringify({ padding })));
      await sleep(20);
    }
    expect(gateway.metrics.droppedStalledClients).toBe(1);
    expect(gateway.metrics.clients).toBe(0);
  });
});
