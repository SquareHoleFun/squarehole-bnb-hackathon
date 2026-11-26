/**
 * The hot-store contract, run against every implementation (memory always; Redis when SH_TEST_REDIS_URL is set).
 */
import type { Hex } from 'viem';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame } from '../src/frame';
import { scoreOf } from '../src/model';
import { BLOCKS_KEPT, FRAMES_KEPT, TRADES_KEPT, type BlockCommit, type HotStore, type StoredBlock } from '../src/store/types';

const hash = (n: bigint, branch = 0): Hex => `0x${branch.toString(16).padStart(4, '0')}${n.toString(16).padStart(60, '0')}` as Hex;

function block(n: bigint, branch = 0): StoredBlock {
  return { number: n, hash: hash(n, branch), parentHash: hash(n - 1n, branch), timestamp: 1_790_000_000n + n * 12n };
}

let seq = 1_000;
function frame(type: 'block' | 'reorg' | 'resync' | 'status', n: bigint, extra = ''): string {
  seq += 1;
  return encodeFrame({ type, id: `${seq}-${n}:${hash(n).slice(2, 10)}`, etag: hash(n), event: JSON.stringify({ n: n.toString(), extra }), snapshot: null });
}

function commitFor(n: bigint, trades: number, branch = 0): BlockCommit {
  const b = { ...block(n, branch), ...(trades > 0 ? { logIndexes: Array.from({ length: trades }, (_, i) => i) } : {}) };
  const rows = Array.from({ length: trades }, (_, i) => ({ score: scoreOf(n, i), json: JSON.stringify({ id: `${b.hash}:${i}`, block: n.toString() }) }));
  const snapshot = { json: JSON.stringify({ head: n.toString(), branch }), etag: b.hash };
  return {
    block: b,
    stateJson: JSON.stringify({ block: n.toString(), branch }),
    trades: rows,
    activity: rows.slice(0, 1),
    snapshot,
    message: frame('block', n),
    txSenders: trades > 0 ? [[hash(n, 99), '0x00000000000000000000000000000000000a11ce']] : [],
  };
}

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await new Promise((r) => setTimeout(r, 10));
}

export function storeContract(name: string, make: () => Promise<HotStore>, options: { readonly slow?: boolean } = {}): void {
  describe(`hot store contract: ${name}`, () => {
    let store: HotStore;
    const opened: HotStore[] = [];

    beforeEach(async () => {
      store = await make();
      opened.push(store);
      await store.clear({ frames: true });
    });

    afterAll(async () => {
      for (const s of opened) await s.close();
    });

    it('commits a block atomically with its snapshot and appends the frame in the same step', async () => {
      const heard: string[] = [];
      const unsubscribe = await store.subscribe((message) => heard.push(message));
      await store.commitBlock(commitFor(100n, 2));
      await until(() => heard.length > 0);
      await unsubscribe();
      expect(heard).toHaveLength(1);
      const decoded = decodeFrame(heard[0] ?? '');
      expect(decoded.type).toBe('block');
      expect(decoded.etag).toBe(hash(100n));
      expect(await store.getSnapshot()).toEqual({ json: JSON.stringify({ head: '100', branch: 0 }), etag: hash(100n) });
      const recent = await store.loadRecent({ trades: 10, activity: 10 });
      expect(recent.blocks).toEqual([{ ...block(100n), logIndexes: [0, 1] }]); // the applied log indexes come back
      expect(recent.states).toEqual([{ block: 100n, json: JSON.stringify({ block: '100', branch: 0 }) }]);
      expect(recent.trades).toHaveLength(2);
      expect(await store.txSender(hash(100n, 99))).toBe('0x00000000000000000000000000000000000a11ce');
      expect(await store.txSender(hash(1n, 98))).toBeNull(); // never written (senders are facts: clear() keeps them)
    });

    it('a quiet commit or rollback writes the data but neither the served snapshot nor the stream', async () => {
      await store.commitBlock(commitFor(10n, 0));
      const before = await store.recentFrames(10);
      await store.commitBlock({ ...commitFor(11n, 1), snapshot: null, message: null });
      await store.commitBlock({ ...commitFor(12n, 1), snapshot: null, message: null });
      expect((await store.getSnapshot())?.etag).toBe(hash(10n));
      expect((await store.loadRecent({ trades: 10, activity: 10 })).blocks.map((b) => b.number)).toEqual([10n, 11n, 12n]);
      await store.rollback({ toBlock: 11n, snapshot: null, message: null });
      expect((await store.loadRecent({ trades: 10, activity: 10 })).trades).toHaveLength(1);
      expect((await store.getSnapshot())?.etag).toBe(hash(10n));
      expect((await store.recentFrames(10)).frames).toEqual(before.frames);
      await store.publishUpdate({ snapshot: { json: '{"head":"11"}', etag: hash(11n) }, message: frame('resync', 11n) });
      expect((await store.getSnapshot())?.etag).toBe(hash(11n));
      expect((await store.recentFrames(10)).frames.map((f) => decodeFrame(f).type)).toEqual(['block', 'resync']);
    });

    it('replaces trade rows and the snapshot in one update (a trader resolved after the block)', async () => {
      await store.commitBlock(commitFor(20n, 2));
      const row = { score: scoreOf(20n, 1), json: JSON.stringify({ id: `${hash(20n)}:1`, block: '20', trader: '0xabc' }) };
      await store.publishUpdate({ snapshot: { json: '{"patched":true}', etag: hash(20n) }, message: frame('status', 20n, 'traders'), trades: [row] });
      const recent = await store.loadRecent({ trades: 10, activity: 10 });
      expect(recent.trades).toHaveLength(2);
      expect(recent.trades[1]).toBe(row.json);
      expect((await store.getSnapshot())?.json).toBe('{"patched":true}');
    });

    it('streams frames in order from a cursor, so frames written between two reads are not lost', async () => {
      for (let n = 1n; n <= 3n; n += 1n) await store.commitBlock(commitFor(n, 0));
      const recent = await store.recentFrames(2);
      expect(recent.frames.map((f) => JSON.parse(decodeFrame(f).event).n)).toEqual(['2', '3']);
      // Written after the read and before the subscription: still delivered, once, in order.
      await store.commitBlock(commitFor(4n, 0));
      const heard: string[] = [];
      const unsubscribe = await store.subscribe((m) => heard.push(m), recent.cursor);
      await store.commitBlock(commitFor(5n, 0));
      await store.publish(frame('status', 5n));
      await until(() => heard.length >= 3);
      await unsubscribe();
      expect(heard.map((f) => decodeFrame(f).type)).toEqual(['block', 'block', 'status']);
      expect(heard.slice(0, 2).map((f) => JSON.parse(decodeFrame(f).event).n)).toEqual(['4', '5']);
    });

    it('caps the stream', async () => {
      if (options.slow) return;
      for (let i = 0; i < FRAMES_KEPT + 40; i += 1) await store.publish(frame('status', BigInt(i)));
      const recent = await store.recentFrames(10_000);
      expect(recent.frames.length).toBeGreaterThanOrEqual(FRAMES_KEPT);
      expect(recent.frames.length).toBeLessThan(FRAMES_KEPT + 40 + 1);
      expect(JSON.parse(decodeFrame(recent.frames.at(-1) ?? '').event).n).toBe(String(FRAMES_KEPT + 39));
    });

    it('keeps the last 128 blocks and states, and pages trades newest first', async () => {
      for (let n = 1n; n <= BigInt(BLOCKS_KEPT) + 5n; n += 1n) await store.commitBlock(commitFor(n, n % 3n === 0n ? 1 : 0));
      const recent = await store.loadRecent({ trades: 1_000, activity: 1_000 });
      expect(recent.blocks).toHaveLength(BLOCKS_KEPT);
      expect(recent.blocks[0]?.number).toBe(6n);
      expect(recent.blocks.at(-1)?.number).toBe(BigInt(BLOCKS_KEPT) + 5n);
      expect(recent.states).toHaveLength(BLOCKS_KEPT);
      expect(recent.trades).toHaveLength(44); // blocks 3, 6, …, 132
      const page = await store.tradesPage(null, 5);
      expect(page.map((j) => (JSON.parse(j) as { block: string }).block)).toEqual(['132', '129', '126', '123', '120']);
      const next = await store.tradesPage(scoreOf(120n, 0), 3);
      expect(next.map((j) => (JSON.parse(j) as { block: string }).block)).toEqual(['117', '114', '111']);
    });

    it('rolls back everything above the ancestor and re-commits the new branch', async () => {
      for (let n = 1n; n <= 10n; n += 1n) await store.commitBlock(commitFor(n, 1));
      const heard: string[] = [];
      const unsubscribe = await store.subscribe((message) => heard.push(message));
      await store.rollback({ toBlock: 7n, snapshot: { json: '{"rolledBack":7}', etag: hash(7n) }, message: frame('reorg', 7n) });
      let recent = await store.loadRecent({ trades: 100, activity: 100 });
      expect(recent.blocks.map((b) => b.number)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
      expect(recent.states.map((s) => s.block)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
      expect(recent.trades).toHaveLength(7);
      expect(recent.activity).toHaveLength(7);
      expect((await store.getSnapshot())?.etag).toBe(hash(7n));
      for (let n = 8n; n <= 9n; n += 1n) await store.commitBlock(commitFor(n, 2, 1));
      recent = await store.loadRecent({ trades: 100, activity: 100 });
      expect(recent.blocks.map((b) => b.hash)).toEqual([...[1n, 2n, 3n, 4n, 5n, 6n, 7n].map((n) => hash(n)), hash(8n, 1), hash(9n, 1)]);
      expect(recent.trades).toHaveLength(11);
      await until(() => heard.length >= 3);
      await unsubscribe();
      expect(heard.map((m) => decodeFrame(m).type)).toEqual(['reorg', 'block', 'block']);
    });

    it('replaces a trade re-committed at the same score instead of duplicating it', async () => {
      await store.commitBlock(commitFor(50n, 1));
      await store.commitBlock({ ...commitFor(50n, 1), trades: [{ score: scoreOf(50n, 0), json: '{"id":"again","block":"50"}' }] });
      const recent = await store.loadRecent({ trades: 10, activity: 10 });
      expect(recent.trades).toEqual(['{"id":"again","block":"50"}']);
      expect(recent.blocks).toHaveLength(1);
    });

    it('caps the trade history', async () => {
      if (options.slow) return;
      for (let n = 1n; n <= 60n; n += 1n) await store.commitBlock(commitFor(n, 100));
      const recent = await store.loadRecent({ trades: 10_000, activity: 10 });
      expect(recent.trades).toHaveLength(TRADES_KEPT);
      expect(JSON.parse(recent.trades[0] ?? '{}')).toMatchObject({ block: '11' });
    });

    it('records finality and the indexer heartbeat', async () => {
      expect(await store.lastHeartbeat()).toBeNull();
      await store.heartbeat('{"head":"1"}');
      expect(await store.lastHeartbeat()).toBe('{"head":"1"}');
      expect(await store.getFinality()).toEqual({ safe: null, finalized: null });
      await store.setFinality({ safe: 90n, finalized: 60n }, encodeFrame({ type: 'finality', id: '1', etag: '', event: '{}', snapshot: null }));
      expect(await store.getFinality()).toEqual({ safe: 90n, finalized: 60n });
    });

    it('clear keeps the served snapshot for a rebuild when asked, and the stream unless asked', async () => {
      await store.commitBlock(commitFor(30n, 1));
      await store.clear({ keepSnapshot: true });
      expect((await store.getSnapshot())?.etag).toBe(hash(30n));
      expect((await store.loadRecent({ trades: 10, activity: 10 })).blocks).toEqual([]);
      expect((await store.recentFrames(10)).frames).toHaveLength(1);
      expect(await store.txSender(hash(30n, 99))).toBe('0x00000000000000000000000000000000000a11ce'); // a fact, kept
      await store.clear();
      expect(await store.getSnapshot()).toBeNull();
      await store.clear({ frames: true });
      expect((await store.recentFrames(10)).frames).toEqual([]);
    });
  });
}
