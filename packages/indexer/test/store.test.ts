import { describe, expect, it } from 'vitest';
import { SEPOLIA_REHEARSAL } from '../src/config';
import { MemoryStore } from '../src/store/memory-store';
import { RedisStore } from '../src/store/redis-store';
import { decodeStoredBlock, encodeStoredBlock, storeKeys } from '../src/store/types';
import { storeContract } from './store.contract';

storeContract('memory', async () => new MemoryStore());

// The same contract against a real Redis (the local Docker one: SH_TEST_REDIS_URL=redis://127.0.0.1:5395/15).
const redisUrl = process.env['SH_TEST_REDIS_URL'];
if (redisUrl) {
  // Its own namespace, so a live service on the same Redis never sees test data.
  storeContract('redis', async () => {
    const store = new RedisStore({ url: redisUrl, chainId: 11_155_111, poolId: SEPOLIA_REHEARSAL.poolId, namespace: 'test', blockMs: 200 });
    await store.ping();
    return store;
  });

  describe('redis namespaces and pools', () => {
    it('keep two environments on one Redis apart, streams included', async () => {
      const a = new RedisStore({ url: redisUrl, chainId: 11_155_111, poolId: SEPOLIA_REHEARSAL.poolId, namespace: 'test-a', blockMs: 200 });
      const b = new RedisStore({ url: redisUrl, chainId: 11_155_111, poolId: SEPOLIA_REHEARSAL.poolId, namespace: 'test-b', blockMs: 200 });
      await b.clear({ frames: true });
      const heard: string[] = [];
      const unsubscribe = await b.subscribe((m) => heard.push(m));
      await a.publish('status|1|\n{}\n');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await unsubscribe();
      expect(heard).toEqual([]);
      await a.clear({ frames: true });
      await a.close();
      await b.close();
    });

    it('a subscriber that was away reads on from its cursor (no frame lost across a reconnect)', async () => {
      const store = new RedisStore({ url: redisUrl, chainId: 11_155_111, poolId: SEPOLIA_REHEARSAL.poolId, namespace: 'test-c', blockMs: 200 });
      await store.clear({ frames: true });
      await store.publish('status|1|\n{"n":1}\n');
      const { cursor } = await store.recentFrames(1);
      // "Away": frames written while no reader is attached.
      await store.publish('status|2|\n{"n":2}\n');
      await store.publish('status|3|\n{"n":3}\n');
      const heard: string[] = [];
      const unsubscribe = await store.subscribe((m) => heard.push(m), cursor);
      for (let i = 0; i < 50 && heard.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
      await unsubscribe();
      expect(heard.map((m) => m.split('|')[1])).toEqual(['2', '3']);
      await store.clear({ frames: true });
      await store.close();
    });
  });
} else {
  describe.skip('hot store contract: redis (set SH_TEST_REDIS_URL to run)', () => {
    it('skipped', () => undefined);
  });
}

describe('memory store expiry', () => {
  it('expires tx senders after 24 h and the heartbeat after 30 s', async () => {
    let now = 1_000_000;
    const store = new MemoryStore(() => now);
    await store.commitBlock({
      block: { number: 1n, hash: '0x01', parentHash: '0x00', timestamp: 1n },
      stateJson: '{}',
      trades: [],
      activity: [],
      snapshot: { json: '{}', etag: '0x01' },
      message: 'block|1-1:01|0x01\n{}\n{}',
      txSenders: [['0xaa', '0x00000000000000000000000000000000000000bb']],
    });
    await store.heartbeat('{}');
    now += 29_000;
    expect(await store.lastHeartbeat()).toBe('{}');
    now += 2_000;
    expect(await store.lastHeartbeat()).toBeNull();
    expect(await store.txSender('0xAA')).toBe('0x00000000000000000000000000000000000000bb');
    now += 86_400_000;
    expect(await store.txSender('0xaa')).toBeNull();
  });
});

describe('key design', () => {
  it('scopes everything the indexer writes to the pool; tx senders stay chain-level facts', () => {
    const keys = storeKeys(11_155_111, SEPOLIA_REHEARSAL.poolId);
    const pool = `sh:v1:11155111:pool:${SEPOLIA_REHEARSAL.poolId.toLowerCase()}:`;
    expect(keys.head).toBe(`${pool}head`);
    expect(keys.blocks).toBe(`${pool}blocks`);
    expect(keys.alive).toBe(`${pool}indexer:alive`);
    expect(keys.snapshot).toBe(`${pool}snapshot`);
    expect(keys.trades).toBe(`${pool}trades`);
    expect(keys.frames).toBe(`${pool}frames`);
    expect(keys.poolKeys.every((key) => key.startsWith(pool))).toBe(true);
    expect(keys.txSender('0xAB')).toBe('sh:v1:11155111:tx:0xab:from');
    const other = storeKeys(11_155_111, `0x${'11'.repeat(32)}`);
    expect(other.poolKeys.some((key) => keys.poolKeys.includes(key))).toBe(false);
    expect(storeKeys(11_155_111, SEPOLIA_REHEARSAL.poolId, 'test').frames).toBe(`sh:v1:test:11155111:pool:${SEPOLIA_REHEARSAL.poolId.toLowerCase()}:frames`);
    expect(() => storeKeys(1, SEPOLIA_REHEARSAL.poolId, 'Bad Space')).toThrow();
  });

  it('round-trips a stored block with and without its applied log indexes', () => {
    const block = { number: 5n, hash: '0x05', parentHash: '0x04', timestamp: 60n } as const;
    expect(decodeStoredBlock(encodeStoredBlock(block))).toEqual(block);
    expect(encodeStoredBlock({ ...block, logIndexes: [] })).toBe('5:0x05:0x04:60');
    expect(decodeStoredBlock(encodeStoredBlock({ ...block, logIndexes: [3, 4, 17] }))).toEqual({ ...block, logIndexes: [3, 4, 17] });
    expect(() => decodeStoredBlock('5:0x05')).toThrow();
    expect(() => decodeStoredBlock('5:0x05:0x04:60:x')).toThrow();
  });
});
