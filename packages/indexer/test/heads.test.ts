import { afterEach, describe, expect, it } from 'vitest';
import { SEPOLIA_REHEARSAL } from '../src/config';
import { headerFromNewHeads, HeadFeed } from '../src/heads';
import type { BlockHeader } from '../src/model';
import { fakeHash, fakeHeader, ScriptedChain } from './scripted-chain';
import { startWsServer, type TestWsServer } from './ws-server';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await sleep(10);
  if (!check()) throw new Error('condition not reached in time');
}
async function server(options: { acceptAfter?: number } = {}): Promise<TestWsServer> {
  const s = await startWsServer(options);
  cleanups.push(() => s.close());
  return s;
}
function feedOn(urls: string[], seen: BlockHeader[], extra: { reconnectBaseMs?: number } = {}): HeadFeed {
  // Websockets only: the HTTP poll never answers, so every head comes from the test servers.
  const chain = new ScriptedChain(SEPOLIA_REHEARSAL);
  chain.latestHeader = () => new Promise<BlockHeader>(() => undefined);
  const feed = new HeadFeed({ wsUrls: urls, reader: chain, pollMs: 60_000, slowPollMs: 60_000, silenceMs: 60_000, onHead: (h) => seen.push(h), ...extra });
  cleanups.push(() => feed.stop());
  return feed;
}
const head = (n: bigint) => ({ number: n, hash: fakeHash(3, n), parentHash: fakeHash(3, n - 1n), timestamp: 1_000n + n * 12n });

describe('head feed', () => {
  it('parses a newHeads push', () => {
    const header = headerFromNewHeads({ number: '0xb43c62', hash: '0xaa', parentHash: '0xbb', timestamp: '0x6abcdef0', logsBloom: '0x00' });
    expect(header).toEqual({ number: 11_811_938n, hash: '0xaa', parentHash: '0xbb', timestamp: 1_790_762_736n, logsBloom: '0x00' });
  });

  it('polls when no websocket is configured and delivers each block hash once', async () => {
    const chain = new ScriptedChain(SEPOLIA_REHEARSAL);
    let parent = fakeHeader(1, 100n, fakeHash(1, 99n), 1_000n);
    chain.addBlock(parent, []);
    const seen: BlockHeader[] = [];
    const feed = new HeadFeed({ wsUrls: [], reader: chain, pollMs: 250, silenceMs: 1_000, onHead: (header, source) => (expect(source).toBe('poll'), seen.push(header)) });
    feed.start();
    await new Promise((resolve) => setTimeout(resolve, 600)); // three polls of the same head
    parent = fakeHeader(1, 101n, parent.hash, 1_012n);
    chain.addBlock(parent, []);
    await new Promise((resolve) => setTimeout(resolve, 400));
    feed.stop();
    expect(seen.map((h) => h.number)).toEqual([100n, 101n]);
    expect(feed.status()).toMatchObject({ mode: 'poll', sockets: [], pollFirsts: 2 });
    expect(chain.calls['latestHeader']).toBeGreaterThanOrEqual(3);
  });

  it('recycles a connected but silent socket once another source has delivered two heads it missed (not after 30 s)', async () => {
    const talking = await server();
    const silent = await server();
    const seen: BlockHeader[] = [];
    const feed = feedOn([talking.url, silent.url], seen, { reconnectBaseMs: 20 });
    feed.start();
    await until(() => feed.status().sockets.every((s) => s.connected));
    talking.push(head(100n));
    await until(() => seen.length === 1);
    expect(silent.connections()).toBe(1);
    talking.push(head(101n)); // the silent socket missed 100 and has not got 101
    await until(() => silent.connections() === 2, 1_000);
    expect(feed.status().sockets[1]).toMatchObject({ recycledBehind: 1 });
    expect(feed.status().sockets[0]).toMatchObject({ recycledBehind: 0, heads: 2 });
  });

  it('keeps a socket that is only slower than the other', async () => {
    const fast = await server();
    const slow = await server();
    const seen: BlockHeader[] = [];
    const feed = feedOn([fast.url, slow.url], seen, { reconnectBaseMs: 20 });
    feed.start();
    await until(() => feed.status().sockets.every((s) => s.connected));
    for (const n of [200n, 201n, 202n, 203n]) {
      fast.push(head(n));
      await sleep(20);
      slow.push(head(n)); // the same head a moment later
      await sleep(20);
    }
    await until(() => seen.length === 4);
    expect(slow.connections()).toBe(1);
    expect(feed.status().sockets.map((s) => s.firsts)).toEqual([4, 0]);
  });

  it('resets the backoff once a socket delivers a head (earlier refusals do not slow later reconnects)', async () => {
    const flaky = await server({ acceptAfter: 5 }); // refuses five sockets in a row, as tenderly once did
    const seen: BlockHeader[] = [];
    const feed = feedOn([flaky.url], seen, { reconnectBaseMs: 20 });
    feed.start();
    await until(() => flaky.connections() === 6 && feed.status().sockets[0]?.connected === true, 5_000);
    expect(feed.status().sockets[0]?.failures).toBe(5);
    flaky.push(head(300n));
    await until(() => seen.length === 1);
    expect(feed.status().sockets[0]?.failures).toBe(0);
    const droppedAt = Date.now();
    flaky.dropAll();
    await until(() => flaky.connections() === 7, 2_000);
    // Without the reset the delay would be 20 ms × 2^5 = 640 ms; with it, a healthy socket comes back at once.
    expect((flaky.connectedAt.at(-1) ?? Infinity) - droppedAt).toBeLessThan(400);
  });
});
