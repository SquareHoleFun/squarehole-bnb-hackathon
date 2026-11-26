import { afterEach, expect, it, vi } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { writeFileSync } from 'node:fs';
import { readsFixture } from './support/reads-fixture';

afterEach(() => vi.useRealTimers());

async function withoutWallWait<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const observed = work.finally(() => { done = true; });
  // Advance viem's unchanged 8 ms batch windows; count exactly the requests that its batching emits.
  while (!done) await vi.advanceTimersByTimeAsync(8);
  return observed;
}

it.each(process.env.SH_TEST_CAPACITY === '1' ? [50, 150] : [4])('CAP-3: measures idle and one trade per block at %i keeper boxes', async boxes => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  for (const active of [false, true]) {
    // Newly deployed alpha population: the finalized income range starts ten blocks before initial finality.
    // The original multi-page history replay remains unchanged in reads-counts.test.ts.
    const batchBytes = process.env.SH_MEASURE_BATCH_BYTES ? Number(process.env.SH_MEASURE_BATCH_BYTES) : undefined;
    const fixture = readsFixture(boxes - 1, true, active, true, batchBytes);
    const rounds = [];
    const pendingCalls = [];
    for (let round = 0; round < 4; round++) {
      const result = await withoutWallWait(fixture.tick());
      const snapshots = result.decisions.snapshots as { boxes: { version: number; v2?: { depthBudget: string; royalty?: { coins: unknown[] } } }[] }[];
      expect(snapshots[0]?.boxes).toHaveLength(boxes);
      expect(snapshots[0]?.boxes.filter(b => b.version === 2)).toHaveLength(boxes - 1);
      expect(snapshots[0]?.boxes[1]?.v2?.depthBudget).toBe(String(1000n + (active ? BigInt(round * 2) : 0n)));
      for (const box of snapshots[0]?.boxes ?? []) if (box.version === 2) expect(box.v2?.royalty?.coins).toHaveLength(6);
      const methods: Record<string, number> = {};
      for (const r of fixture.requests) methods[r.method] = (methods[r.method] ?? 0) + 1;
      expect(methods['eth_sendRawTransaction']).toBeUndefined();
      expect(Object.values(methods).reduce((sum, count) => sum + count, 0)).toBe(result.count);
      // No-work collections must keep the pre-B reads.
      // BATCH-1/2/4: exact per-method pins, with the supplied baseline retained for comparison. SH-247 (SH-190) removes
      // the platform Safe's open SafeReceived range: five log queries become four.
      const before = boxes === 4 ? [38, 31] : boxes === 50 ? [343, 310] : [1021, 927];
      expect.soft(methods['eth_call']).toBeLessThan(before[round === 0 ? 0 : 1] ?? 0);
      if (batchBytes === undefined) {
        const calls = boxes === 4 ? [27, 21] : boxes === 50 ? [177, 166] : [510, 487];
        expect.soft(methods).toEqual({ eth_chainId: boxes === 150 && round === 0 ? 2 : 1,
          eth_getBlockByNumber: round === 2 ? 7 : 8, eth_call: calls[round === 0 ? 0 : 1],
          eth_getLogs: 4, eth_getCode: boxes - 1, eth_estimateGas: 1,
          ...(round === 0 ? { eth_getStorageAt: (boxes - 1) * 6 } : {}),
        });
      }
      pendingCalls.push(fixture.requests.filter(r => r.method === 'eth_call' && (r.params as unknown[])[1] === 'pending').length);
      rounds.push(methods);
    }
    const measured = { boxes, active, batchBytes, rounds, pendingCalls, aggregates: fixture.aggregates };
    console.warn('CAPACITY-KEEPER', JSON.stringify({ boxes, active, batchBytes, rounds }));
    writeFileSync(new URL(`../../../.cache/capacity-keeper-${boxes}-${active}-${batchBytes ?? 'default'}.json`, import.meta.url), JSON.stringify(measured, null, 2));
  }
}, shLimit(900_000));
