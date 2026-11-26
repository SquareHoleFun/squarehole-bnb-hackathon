import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { candlesFromTrades, INTERVAL_SECONDS } from '../../src/core/candles';
import { coreGatewaySource } from '../../src/core/core-service';
import { MemoryHistory } from '../../src/history/memory-history';
import { PgHistory } from '../../src/history/pg-history';
import type { HistoryStore } from '../../src/history/types';
import { startTempPostgres, type TempPostgres } from '../history/pg-cluster';
import { required, expanded, gateway, recorded, seconds, steps, type Recorded } from './fixture';

let f: Recorded;
beforeAll(async () => { f = await recorded(); });

function contract(make: () => Promise<HistoryStore>) {
  it('CC-1: all six steps on recorded trades equal the shared candle rule, with only three stored intervals', async () => {
    const store = await make();
    for (const b of f.blocks) await store.writeBlock(b);
    expect(f.trades.length).toBeGreaterThan(5);
    expect(steps.map(s => INTERVAL_SECONDS[s])).toEqual(seconds);
    const { source } = coreGatewaySource(f.indexer, f.life.chain, null, 60000);
    for (const step of steps) {
      const expected = candlesFromTrades(f.trades, step);
      expect(await store.candles(f.indexer.chainId, f.token, step), step).toEqual(expected);
      expect((await source.candles(f.token, step))?.candles, step).toEqual(expected);
    }
    expect(new Set((await store.dump(f.indexer.chainId)).candles.map(s => JSON.parse(s).interval))).toEqual(new Set(['1m', '1h', '1d']));
  });

  it('CC-1/2: exact aggregation, sparse buckets, newest n ascending, and the 1000 default', async () => {
    const store = await make(); const batch = expanded(f);
    await store.writeBlock(batch);
    const trades = required(batch.boxes[0]).trades;
    const recent = vi.spyOn(f.indexer, 'recent').mockReturnValue({ trades, activity: [] });
    try {
      const { source } = coreGatewaySource(f.indexer, f.life.chain, null, 60000);
      for (const step of steps) {
        const expected = candlesFromTrades(trades, step);
        for (const limit of [1, 2, 7, 1000]) {
          expect(await store.candles(f.indexer.chainId, f.token, step, limit), `${step}/${limit}`).toEqual(expected.slice(-limit));
          expect((await source.candles(f.token, step, limit))?.candles).toEqual(expected.slice(-limit));
        }
      }
      expect(await store.candles(f.indexer.chainId, f.token, '1m')).toHaveLength(1000);
      const { send } = gateway(f, null);
      expect((await send('candles', '?interval=1m')).json()['candles']).toHaveLength(1000);
      expect((await send('candles', '?interval=1m&limit=2')).json()['candles']).toEqual(candlesFromTrades(trades, '1m').slice(-2));
    } finally { recent.mockRestore(); }
  });

  it('CC-3: 200 HTTP requests share a read; committed trade and undo each trigger one new read', async () => {
    const store = await make();
    for (const b of f.blocks) await store.writeBlock(b);
    const { send } = gateway(f, store); const read = vi.spyOn(store, 'candles');
    const first = await Promise.all(Array.from({ length: 200 }, () => send()));
    expect(read).toHaveBeenCalledTimes(1); expect(new Set(first.map(r => r.body)).size).toBe(1);
    const batch = expanded(f, 2); await store.writeBlock(batch);
    const next = await send(); expect(read).toHaveBeenCalledTimes(2); expect(next.json()['candles']).not.toEqual(required(first[0]).json()['candles']);
    await store.undoAbove(f.indexer.chainId, required(required(batch.boxes[0]).trades[0]).block - 1n);
    expect((await send()).json()['candles']).toEqual(required(first[0]).json()['candles']); expect(read).toHaveBeenCalledTimes(3);
  });

  it('CC-3: the version advances on committed writes, undo, reorg, wipe and replay but not reads', async () => {
    const store = await make(); const b = expanded(f, 2); const chain = f.indexer.chainId;
    const change = async (fn: () => Promise<unknown>) => { const before = store.version; await fn(); expect(store.version).toBe(before + 1n); };
    await change(() => store.writeBlock(b));
    const before = store.version; await store.candles(chain, f.token, '1h'); await store.activityPage(chain, f.token, { kind: null, before: null, limit: 50 }); expect(store.version).toBe(before);
    await change(() => store.writeBlock({ ...b, block: { ...b.block, hash: `0x${'ef'.repeat(32)}` } }));
    await change(() => store.undoAbove(chain, 0n));
    const boxes = [{ chainId: chain, token: f.token, registry: required(b.boxes[0]).registry, boxId: '0' }];
    await change(() => store.startReplay(chain, boxes));
    await change(() => store.writeBlock(b, new Set([f.token])));
    await change(() => store.writeBlock(b, new Set([f.token])));
    await change(() => store.finishReplay(chain, boxes));
    await change(() => store.wipe(chain));
  });
}

describe('memory', () => contract(async () => new MemoryHistory()));
describe.skipIf(process.env.SH_HISTORY_PG !== '1')('Postgres on a local Unix socket', () => {
  let pg: TempPostgres | null = null; const stores: PgHistory[] = [];
  beforeAll(() => { pg = startTempPostgres(); if (!pg) throw new Error('Postgres binaries unavailable'); });
  afterAll(async () => { for (const store of stores) await store.close(); pg?.stop(); });
  contract(async () => { const store = new PgHistory(required(pg)); stores.push(store); await store.init(); await store.wipe(f.indexer.chainId); return store; });
});
