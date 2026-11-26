/**
 * The history store contract (S10a § 4; BC-078, BC-077's deep part), run against memory always and against Postgres
 * (a throwaway cluster on a Unix socket, no TCP port) when SH_HISTORY_PG=1 (`pnpm --filter @squarehole/indexer
 * test:history`, in `pnpm verify:all`):
 *
 * - every block written two deep, idempotent, with the cursor;
 * - undo above a block: balances by delta, item owners back, candles recomputed, boxes created above it gone;
 * - activity pages and candles as the gateway asks for them;
 * - BC-078 with 50 synthetic boxes: wipe and rebuild from the chain gives identical rows and candles;
 * - SH-NO-PICTURE-GATE upgrade (fix round 2): a box an older indexer stored as unlisted for its pictures is deleted and
 *   replayed whole at startup: item owners, balances and candles as a fresh store's, also after an unfixed cold start
 *   and after a restart part way; every other box's rows byte-identical;
 * - Postgres and memory dump the same rows for the same blocks.
 */
import { labelAddress } from '@squarehole/chain/core/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreChainIndexer, type HistoryMessage } from '../../src/core/chain-indexer';
import { MemoryHistory } from '../../src/history/memory-history';
import { PgHistory } from '../../src/history/pg-history';
import type { HistoryStore } from '../../src/history/types';
import { HistoryWriter } from '../../src/history/writer';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import type { Abi, Address } from 'viem';
import { ev, event, synthBox, synthManifest, World, type SynthBox } from '../core/core-synth';
import { startTempPostgres, type TempPostgres } from './pg-cluster';

const CHAIN = synthManifest().chainId;

/** `count` boxes created over the first blocks, then trades, transfers, vault actions, batches and stream claims. */
function busyWorld(count: number, blocks = 120n): { w: World; boxes: SynthBox[] } {
  const w = new World();
  const boxes = Array.from({ length: count }, (_, i) => synthBox({ boxId: BigInt(i), creationBlock: 12n + BigInt(i) }));
  w.block(10n);
  for (const box of boxes) {
    w.block(box.row.creationBlock, [w.created(box, [ev.initialize(box, getSqrtPriceAtTick(-30_000), -30_000), ev.mint(box, labelAddress('pool'), 10n ** 27n)])]);
  }
  for (let n = 12n + BigInt(count); n <= blocks; n += 1n) {
    const box = boxes[Number(n) % count] as SynthBox;
    const i = Number(n);
    const who = labelAddress(`holder:${i % 7}`);
    w.block(n, [
      [ev.swap(box, { amount0: -(10n ** 15n) * BigInt(i), amount1: 10n ** 19n * BigInt(i), sqrtPriceX96: getSqrtPriceAtTick(-30_000 - i), tick: -30_000 - i, liquidity: 10n ** 20n }), ev.transfer(box, labelAddress('pool'), who, 10n ** 19n * BigInt(i))],
      ...(i % 5 === 0 ? [[ev.collected(box, 10n ** 16n, 10n ** 20n), ev.split(box, 7n * 10n ** 15n, 10n ** 15n, 10n ** 15n, 8n * 10n ** 19n, 10n ** 19n)]] : []),
      ...(i % 9 === 0 ? [[ev.vault(box, 1n, BigInt(i) * 10n ** 18n, 4_269n - BigInt(i % 50), 1n)]] : []),
      ...(i % 11 === 0 ? [[ev.transfer(box, who, labelAddress('holder:x'), 10n ** 18n)]] : []),
      ...(i % 13 === 0 ? [[ev.streamClaimed(box, who, BigInt(i))]] : []),
    ]);
  }
  return { w, boxes };
}

async function messagesOf(w: World): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
  const indexer = new CoreChainIndexer({ reader: w.chain(), manifest: synthManifest(), onHistory: (m) => void messages.push(m) });
  await indexer.start();
  await indexer.idle();
  return messages;
}

async function write(store: HistoryStore, messages: readonly HistoryMessage[]): Promise<void> {
  const writer = new HistoryWriter(store);
  for (const m of messages) await writer.accept(m);
  await writer.flush();
}

/**
 * What an indexer before SH-NO-PICTURE-GATE wrote while `token`'s pictures were not available: its row not shown, with
 * the picture check's reason, and none of its rows. Blocks only it touched were passed over by that indexer's range
 * backfill (up to block 40) and held without its rows once it followed the head (above 40).
 */
function pictureHiddenBefore(messages: readonly HistoryMessage[], token: string): HistoryMessage[] {
  return messages.flatMap((m): HistoryMessage[] => {
    if (m.type !== 'block') return [m];
    const rows = m.result.rows.map((seen) => (seen.row.contracts.token?.toLowerCase() === token ? { row: seen.row, verdict: { classification: 'unlisted', reason: 'art not available: logo missing (bafkreiaaaa)' } as unknown as typeof seen.verdict } : seen));
    const boxes = m.result.boxes.filter((b) => b.token !== token);
    if (m.result.block.number <= 40n && rows.length === 0 && m.result.boxes.length > 0 && boxes.length === 0) return [];
    return [{ type: 'block', result: { ...m.result, rows, boxes } }];
  });
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const itemTransfer = (box: SynthBox, from: Address, to: Address, tokenId: bigint) => event(boxCollectionAbi as Abi, box.row.contracts.collection as Address, 'Transfer', { from, to, tokenId });

/** Review XR-SH-NO-PICTURE-GATE-R2: box 1's item 7 minted to Alice at block 20 (box 0 trades there too), sent to Bob at 30 (only box 1). */
function itemWorld(): { w: World; boxes: SynthBox[]; alice: Address; bob: Address } {
  const w = new World();
  const boxes = [synthBox({ boxId: 0n, creationBlock: 12n }), synthBox({ boxId: 1n, creationBlock: 13n })];
  const [a, b] = boxes as [SynthBox, SynthBox];
  const alice = labelAddress('alice');
  const bob = labelAddress('bob');
  w.block(10n);
  for (const box of boxes) w.block(box.row.creationBlock, [w.created(box, [ev.initialize(box, getSqrtPriceAtTick(-30_000), -30_000), ev.mint(box, labelAddress('pool'), 10n ** 27n)])]);
  for (let n = 14n; n <= 60n; n += 1n) {
    const i = Number(n);
    const logs = n === 30n ? [] : [[ev.swap(a, { amount0: -(10n ** 15n) * BigInt(i), amount1: 10n ** 19n * BigInt(i), sqrtPriceX96: getSqrtPriceAtTick(-30_000 - i), tick: -30_000 - i, liquidity: 10n ** 20n }), ev.transfer(a, labelAddress('pool'), labelAddress(`holder:${i % 5}`), 10n ** 19n * BigInt(i))]];
    if (n === 20n) logs.push([itemTransfer(b, ZERO_ADDRESS, alice, 7n)]);
    if (n === 30n) logs.push([itemTransfer(b, alice, bob, 7n)]);
    w.block(n, logs);
  }
  return { w, boxes, alice, bob };
}

/** Every dump line that does not belong to `token` (block rows excluded: a replay may write blocks the old store passed over). */
const others = (dump: Awaited<ReturnType<HistoryStore['dump']>>, token: string): Record<string, readonly string[]> =>
  Object.fromEntries(Object.entries(dump).filter(([table]) => table !== 'chainBlocks').map(([table, lines]) => [table, (lines as string[]).filter((l) => !l.includes(token))]));
const mine = (dump: Awaited<ReturnType<HistoryStore['dump']>>, token: string): string[] =>
  Object.entries(dump).filter(([table]) => table !== 'chainBlocks').flatMap(([, lines]) => (lines as string[]).filter((l) => l.includes(token)));

function contract(name: string, make: () => Promise<HistoryStore>): void {
  describe(`history store contract: ${name}`, () => {
    it('ACT-1: legacy v2 null traders use whole stored T transactions outside the page, with v1 reads unchanged', async () => {
      const store = await make(); await store.wipe(CHAIN);
      const w = new World('legacy-traders'); const box = synthBox({ boxId: 0n, creationBlock: 12n });
      const pool = labelAddress('pool'); const router = labelAddress('router'); const alice = labelAddress('alice'); const bob = labelAddress('bob');
      const swap = (buy: boolean) => ev.swap(box, { amount0: buy ? -7n : 7n, amount1: buy ? 9n : -9n,
        sqrtPriceX96: getSqrtPriceAtTick(-30000), tick: -30000, liquidity: 100n });
      w.block(10n); w.block(12n, [w.created(box, [ev.mint(box, pool, 1000n)])]);
      w.block(13n, [[swap(true), ev.transfer(box, pool, router, 9n), ev.transfer(box, router, alice, 9n)]]);
      w.block(14n, [[ev.transfer(box, bob, router, 9n), swap(false), ev.transfer(box, router, pool, 9n)]]);
      const messages = (await messagesOf(w)).map(m => m.type === 'block' ? { ...m, result: { ...m.result,
        boxes: m.result.boxes.map(b => ({ ...b, trades: b.trades.map(t => ({ ...t, trader: null })) })) } } : m);
      await write(store, messages);
      const token = box.row.contracts.token as string;
      const options = { kind: 'trade', before: null, limit: 1, v2Contracts: [pool, ...Object.values(box.row.contracts).filter((a): a is Address => a !== null)] };
      const sells = await store.activityPage(CHAIN, token, options);
      expect(sells[0]).toMatchObject({ side: 'sell', trader: bob.toLowerCase() });
      const buys = await store.activityPage(CHAIN, token, { ...options, before: `${sells[0]?.block}-${sells[0]?.logIndex}` });
      expect(buys[0]).toMatchObject({ side: 'buy', trader: alice.toLowerCase() });
      expect((await store.activityPage(CHAIN, token, { kind: 'trade', before: null, limit: 1 }))[0]).toMatchObject({ trader: null });
    });

    it('writes every block once (two deep, idempotent), with the cursor; the writer keeps the newest block back', async () => {
      const store = await make();
      await store.wipe(CHAIN);
      const { w } = busyWorld(3, 60n);
      const messages = await messagesOf(w);
      const writer = new HistoryWriter(store);
      for (const m of messages) await writer.accept(m);
      await writer.idle();
      const blocks = messages.filter((m) => m.type === 'block');
      expect(writer.written).toBe(blocks.length - 1);
      await writer.flush();
      const first = await store.dump(CHAIN);
      // Writing the same blocks again changes nothing (balances move by delta, so this would show).
      await write(store, messages);
      expect(await store.dump(CHAIN)).toEqual(first);
      expect((await store.cursor(CHAIN))?.block).toBe(60n);
      expect(first.trades.length).toBeGreaterThan(30);
      expect(first.balances.length).toBeGreaterThan(5);
    });

    it('undo above a block: rows gone, balances and owners back, candles recomputed, later boxes gone', async () => {
      const store = await make();
      await store.wipe(CHAIN);
      const { w } = busyWorld(3, 80n);
      const all = await messagesOf(w);
      const upTo50 = all.filter((m) => m.type !== 'block' || m.result.block.number <= 50n);
      await write(store, upTo50);
      const at50 = await store.dump(CHAIN);
      await store.wipe(CHAIN);
      await write(store, all);
      await store.undoAbove(CHAIN, 50n);
      expect(await store.dump(CHAIN)).toEqual(at50);
      expect((await store.cursor(CHAIN))?.block).toBe(50n);
    });

    it('activity pages (newest first, by kind, before a cursor) and candles, as the gateway asks', async () => {
      const store = await make();
      await store.wipe(CHAIN);
      const { w, boxes } = busyWorld(2, 70n);
      await write(store, await messagesOf(w));
      const token = (boxes[0] as SynthBox).row.contracts.token?.toLowerCase() as string;
      const page = await store.activityPage(CHAIN, token, { kind: null, before: null, limit: 10 });
      expect(page).toHaveLength(10);
      for (let i = 1; i < page.length; i += 1) {
        const [a, b] = [page[i - 1], page[i]];
        if (!a || !b) continue;
        expect(a.block > b.block || (a.block === b.block && a.logIndex > b.logIndex)).toBe(true);
      }
      const last = page.at(-1);
      const next = await store.activityPage(CHAIN, token, { kind: null, before: `${last?.block}-${last?.logIndex}`, limit: 10 });
      expect(next[0] && last && (next[0].block < last.block || next[0].logIndex < last.logIndex)).toBe(true);
      const trades = await store.activityPage(CHAIN, token, { kind: 'trade', before: null, limit: 200 });
      expect(trades.every((t) => t.kind === 'trade')).toBe(true);
      const batches = await store.activityPage(CHAIN, token, { kind: 'batch', before: null, limit: 200 });
      expect(batches.length).toBeGreaterThan(0);
      const candles = await store.candles(CHAIN, token, '1m');
      expect(candles.reduce((n, c) => n + c.trades, 0)).toBe(trades.length);
    });

    it('BC-078: a write the store refuses (a restart, a reset connection) is kept and retried in order; nothing is lost or applied twice', async () => {
      const store = await make();
      await store.wipe(CHAIN);
      const { w } = busyWorld(3, 60n);
      const messages = await messagesOf(w);
      await write(store, messages);
      const clean = await store.dump(CHAIN);
      await store.wipe(CHAIN);
      // The same store, refusing its 10th write once (and the undo path of the writer stays the store's own).
      let writes = 0;
      let refused: bigint | null = null;
      const flaky = Object.assign(Object.create(store) as HistoryStore, {
        writeBlock: async (result: Parameters<HistoryStore['writeBlock']>[0]) => {
          writes += 1;
          if (writes === 10) {
            refused = result.block.number;
            throw new Error('connection reset');
          }
          return store.writeBlock(result);
        },
      });
      const writer = new HistoryWriter(flaky, { retryBaseMs: 60_000 });
      // Intake still processes rollback/reset messages while persistence retries; acknowledgements wait for recovery.
      const accepted = messages.map((m) => writer.accept(m));
      await writer.idle();
      // Behind, and says why: nothing after the refused block was written (the cursor stops below it).
      expect(writer.health()).toMatchObject({ ok: false, failures: 1, lastError: expect.stringContaining('connection reset') as unknown as string });
      expect(writer.health().pending).toBeGreaterThan(1);
      expect((await store.cursor(CHAIN))?.block).toBe((refused ?? 0n) - 1n);
      // The retry (flush retries at once) writes it and everything after it, in order.
      await writer.flush();
      await Promise.all(accepted);
      writer.stop();
      expect(writer.health()).toMatchObject({ ok: true, pending: 0, lastError: null });
      expect(await store.dump(CHAIN)).toEqual(clean);
    });

    it('BC-082 upgrade (review R2): item 7, minted to Alice at block 20 and sent to Bob at 30, ends with Bob after an unfixed cold start, the replay and a restart', async () => {
      const store = await make();
      const { w, boxes, alice, bob } = itemWorld();
      const now = await messagesOf(w);
      const token = (boxes[1] as SynthBox).row.contracts.token?.toLowerCase() as string;
      const owner = (dump: Awaited<ReturnType<HistoryStore['dump']>>) => dump.items.filter((l) => l.includes(token) && l.includes('"id":"7"'));
      await store.wipe(CHAIN);
      await write(store, now);
      const whole = await store.dump(CHAIN);
      expect(owner(whole)).toEqual([expect.stringContaining(bob.toLowerCase())]);
      // The older indexer's store: block 20 held (box 0 traded there), block 30 passed over (only box 1's transfer).
      await store.wipe(CHAIN);
      await write(store, pictureHiddenBefore(now, token));
      expect((await store.dump(CHAIN)).chainBlocks.some((l) => l.includes('"number":"30"'))).toBe(false);
      // An unfixed cold start (tip 8d74ddfef): block 30 written (Bob), block 20 skipped.
      await write(store, now);
      // The fixed start: deleted whole, then replayed in chain order.
      const writer = new HistoryWriter(store);
      expect(await writer.relistPictureHidden()).toBe(1);
      for (const m of now) await writer.accept(m);
      await writer.flush();
      expect(writer.health()).toMatchObject({ ok: true, relisting: 0 });
      expect(owner(await store.dump(CHAIN))).toEqual([expect.stringContaining(bob.toLowerCase())]);
      expect(owner(await store.dump(CHAIN))).not.toEqual([expect.stringContaining(alice.toLowerCase())]);
      expect(await store.dump(CHAIN)).toEqual(whole);
      // A restart keeps it.
      const again = new HistoryWriter(store);
      expect(await again.relistPictureHidden()).toBe(0);
      for (const m of now) await again.accept(m);
      await again.flush();
      expect(await store.dump(CHAIN)).toEqual(whole);
    });

    it('BC-082 upgrade: a fungible box is deleted at startup and replayed whole; its balances and candles as a fresh store\'s, every other box byte-identical', async () => {
      const store = await make();
      const { w, boxes } = busyWorld(3, 80n);
      const now = await messagesOf(w);
      const token = (boxes[1] as SynthBox).row.contracts.token?.toLowerCase() as string;
      await store.wipe(CHAIN);
      await write(store, now);
      const whole = await store.dump(CHAIN);
      expect(whole.balances.filter((l) => l.includes(token)).length).toBeGreaterThan(2);
      expect(whole.candles.filter((l) => l.includes(token)).length).toBeGreaterThan(2);
      await store.wipe(CHAIN);
      await write(store, pictureHiddenBefore(now, token));
      await write(store, now); // an unfixed cold start: part of the box's rows, its record still hidden
      const before = await store.dump(CHAIN);
      expect(mine(before, token).length).toBeGreaterThan(0);
      const writer = new HistoryWriter(store);
      expect(await writer.relistPictureHidden()).toBe(1);
      // After the startup step, before any block: nothing of the box is stored, its record included; the others as they were.
      const deleted = await store.dump(CHAIN);
      expect(mine(deleted, token)).toEqual([]);
      expect(others(deleted, token)).toEqual(others(before, token));
      expect(writer.health()).toMatchObject({ ok: false, relisting: 1 });
      for (const m of now) await writer.accept(m);
      await writer.flush();
      const after = await store.dump(CHAIN);
      expect(after).toEqual(whole);
      expect(others(after, token)).toEqual(others(before, token));
      expect(after.balances.filter((l) => l.includes(token))).toEqual(whole.balances.filter((l) => l.includes(token)));
    });

    it('BC-082 upgrade: an interrupted replay is deleted and replayed again from the start at the next start (item 7 still ends with Bob)', async () => {
      const store = await make();
      const { w, boxes, bob } = itemWorld();
      const now = await messagesOf(w);
      const token = (boxes[1] as SynthBox).row.contracts.token?.toLowerCase() as string;
      await store.wipe(CHAIN);
      await write(store, now);
      const whole = await store.dump(CHAIN);
      await store.wipe(CHAIN);
      await write(store, pictureHiddenBefore(now, token));
      await write(store, now); // an unfixed cold start
      const untouched = others(await store.dump(CHAIN), token);
      // Two starts that stop part way (block 25, between Alice and Bob; then block 45): health not ok, the marker kept.
      for (const stop of [25n, 45n]) {
        const partway = new HistoryWriter(store);
        expect(await partway.relistPictureHidden()).toBe(1);
        for (const m of now.filter((m) => m.type !== 'block' || m.result.block.number <= stop)) await partway.accept(m);
        await partway.idle();
        expect(partway.health()).toMatchObject({ ok: false, relisting: 1 });
        partway.stop();
        expect(await store.pictureHidden()).toEqual([expect.objectContaining({ chainId: CHAIN, token })]);
      }
      // The next start runs through: not healthy until the newest held block is written, then exactly the fresh store.
      const writer = new HistoryWriter(store);
      expect(await writer.relistPictureHidden()).toBe(1);
      for (const m of now) await writer.accept(m);
      await writer.idle();
      expect(writer.health()).toMatchObject({ ok: false, relisting: 1 });
      await writer.flush();
      expect(writer.health()).toMatchObject({ ok: true, relisting: 0 });
      expect(await store.pictureHidden()).toEqual([]);
      const done = await store.dump(CHAIN);
      expect(done.items.filter((l) => l.includes(token) && l.includes('"id":"7"'))).toEqual([expect.stringContaining(bob.toLowerCase())]);
      expect(done).toEqual(whole);
      expect(others(done, token)).toEqual(untouched);
    });

    it('BC-082 upgrade: a box the pipeline no longer lists is gone after the replay, as in a fresh store, and the replay ends', async () => {
      const store = await make();
      await store.wipe(CHAIN);
      const { w, boxes } = busyWorld(3, 60n);
      const now = await messagesOf(w);
      const token = (boxes[2] as SynthBox).row.contracts.token?.toLowerCase() as string;
      await write(store, pictureHiddenBefore(now, token));
      const untouched = others(await store.dump(CHAIN), token);
      // Today's pipeline without that box at all (a release no longer in the manifest, say).
      const without = now.map((m): HistoryMessage => (m.type !== 'block' ? m : { type: 'block', result: { ...m.result, rows: m.result.rows.filter((r) => r.row.contracts.token?.toLowerCase() !== token), boxes: m.result.boxes.filter((b) => b.token !== token) } }));
      const writer = new HistoryWriter(store);
      expect(await writer.relistPictureHidden()).toBe(1);
      for (const m of without) await writer.accept(m);
      await writer.flush();
      expect(writer.health()).toMatchObject({ ok: true, relisting: 0 });
      expect(await store.pictureHidden()).toEqual([]);
      expect(mine(await store.dump(CHAIN), token)).toEqual([]);
      expect(others(await store.dump(CHAIN), token)).toEqual(untouched);
    });

    it('BC-078 (50 synthetic boxes): wiped and rebuilt from the chain, identical rows and candles; nothing expires', async () => {
      const store = await make();
      await store.wipe(CHAIN);
      const { w } = busyWorld(50, 160n);
      await write(store, await messagesOf(w));
      const before = await store.dump(CHAIN);
      expect(before.boxes).toHaveLength(50);
      await store.wipe(CHAIN);
      expect((await store.dump(CHAIN)).trades).toEqual([]);
      // The rebuild: a fresh pipeline from the manifest's start block (range backfill), into the same store.
      await write(store, await messagesOf(w));
      expect(await store.dump(CHAIN)).toEqual({ ...before, chainBlocks: (await store.dump(CHAIN)).chainBlocks });
      expect((await store.dump(CHAIN)).trades).toEqual(before.trades);
    });
  });
}

contract('memory', async () => new MemoryHistory());

const withPg = process.env['SH_HISTORY_PG'] === '1';
describe.skipIf(!withPg)('Postgres (a throwaway cluster on a Unix socket)', () => {
  let pg: TempPostgres | null = null;
  const stores: PgHistory[] = [];
  beforeAll(() => {
    pg = startTempPostgres();
    if (!pg) throw new Error('SH_HISTORY_PG=1 but no Postgres binaries were found (SH_PG_BIN)');
  });
  afterAll(async () => {
    for (const s of stores) await s.close();
    pg?.stop();
  });
  const make = async (): Promise<HistoryStore> => {
    if (!pg) throw new Error('no cluster');
    const store = new PgHistory({ host: pg.host, port: pg.port, database: pg.database, user: pg.user });
    stores.push(store);
    await store.init();
    return store;
  };
  contract('postgres', make);

  it('ACT-4: a concurrent writer reorg between the two page reads leaves the whole page on one branch', async () => {
    const { w, boxes } = busyWorld(1, 16n);
    const original = await messagesOf(w);
    const fork = w.fork(15n, 'activity-page-reorg');
    const box = boxes[0] as SynthBox;
    fork.block(16n, [[ev.swap(box, { amount0: -7n, amount1: 9n, sqrtPriceX96: getSqrtPriceAtTick(-30000), tick: -30000, liquidity: 100n }),
      ev.transfer(box, labelAddress('pool'), labelAddress('replacement'), 9n)]]);
    const replacement = (await messagesOf(fork)).filter(m => m.type === 'block' && m.result.block.number === 16n);
    const store = await make(); await store.wipe(CHAIN); await write(store, original);
    const writerStore = await make(); const writer = new HistoryWriter(writerStore, { depth: 1 });
    const token = box.row.contracts.token as string;
    const before = await store.activityPage(CHAIN, token, { kind: null, before: null, limit: 200 });
    // Hook the real client SELECT, whether called by pool.query (the old bug) or a checked-out transaction.
    type Query = (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    type Client = { query: Query; release(): void };
    const pool = (store as unknown as { pool: {
      connect(): Promise<Client>;
      on(event: 'connect', listener: (client: Client) => void): void;
      off(event: 'connect', listener: (client: Client) => void): void;
    } }).pool;
    const originals = new Map<Client, Query>();
    let interleaved = false;
    const read = (query: Query): Query => {
      const execute: Query = async (sql, args) => {
        const result = await query(sql, args);
        if (!interleaved && sql.includes('FROM trades WHERE')) {
          interleaved = true;
          await writer.accept({ type: 'rollback', chainId: CHAIN, toBlock: 15n });
          for (const message of replacement) await writer.accept(message);
          await writer.flush();
        }
        return result;
      };
      // pool.query uses callbacks; transaction queries use promises. Preserve both overloads for the regression.
      return ((sql: string, args?: unknown[], callback?: (error: unknown, result?: Awaited<ReturnType<Query>>) => void) => {
        const result = execute(sql, args);
        if (callback) { void result.then(value => callback(null, value), error => callback(error)); return; }
        return result;
      }) as Query;
    };
    const intercept = (client: Client) => {
      if (originals.has(client)) return;
      originals.set(client, client.query); client.query = read(client.query.bind(client));
    };
    pool.on('connect', intercept);
    const existing = await pool.connect(); intercept(existing); existing.release();
    try {
      expect(await store.activityPage(CHAIN, token, { kind: null, before: null, limit: 200 })).toEqual(before);
      expect(interleaved).toBe(true);
      const after = await store.activityPage(CHAIN, token, { kind: null, before: null, limit: 200 });
      expect(after).not.toEqual(before);
      expect(new Set(after.filter(item => item.block === 16n).map(item => item.blockHash))).toEqual(new Set([fork.headers.at(-1)?.hash]));
    } finally {
      pool.off('connect', intercept);
      for (const [client, query] of originals) client.query = query;
      writer.stop();
    }
  });

  it('Postgres and memory dump the same rows for the same blocks (one rule for both)', async () => {
    const { w } = busyWorld(5, 100n);
    const messages = await messagesOf(w);
    const memory = new MemoryHistory();
    await write(memory, messages);
    const store = await make();
    await store.wipe(CHAIN);
    await write(store, messages);
    expect(await store.dump(CHAIN)).toEqual(await memory.dump(CHAIN));
  });
});
