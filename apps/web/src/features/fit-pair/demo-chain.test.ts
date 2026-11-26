import { BAND_TARGET_WEI, curvePoint, LAUNCH_TAX_TABLE_PIPS, MISFITS_CURVE, PIPS, toJson } from '@squarehole/indexer/client';
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_WEI, DEMO_SCENARIOS, DemoChain, demoChainFor, isDemoScenario } from './demo-chain';
import { createDemoStream } from './demo-live';
import { DEMO_FIT_TARGET } from './fit-target';

const T = DEMO_FIT_TARGET;

describe('the Demo chain: invented trades, exact curve math', () => {
  it('starts with the genesis bootstrap buy, its FIT burned', () => {
    const chain = new DemoChain(T);
    const [bootstrap] = chain.trades();
    expect(bootstrap).toMatchObject({ route: 'bootstrap', side: 'buy', ethRaw: BOOTSTRAP_WEI, block: T.deployBlock });
    expect(chain.head.state.burnedRaw).toBe(bootstrap?.tokenRaw);
  });

  it('charges the router’s tax table in the window, and only there', () => {
    const chain = new DemoChain(T);
    chain.mineTo(T.closeBlock + 50n);
    const router = chain.trades().filter((trade) => trade.route === 'launch_router');
    expect(router.length).toBeGreaterThan(0);
    for (const trade of router) {
      expect(trade.block).toBeGreaterThanOrEqual(T.openBlock);
      expect(trade.block).toBeLessThan(T.closeBlock);
      const pips = BigInt(LAUNCH_TAX_TABLE_PIPS[Number(trade.block - T.openBlock)] ?? 0);
      const gross = trade.ethRaw + trade.taxRaw;
      // The tax is the table's share of what the buyer sent (floored); the rest went into the pool.
      expect(trade.taxRaw).toBe((gross * pips) / BigInt(PIPS));
    }
    for (const trade of chain.trades().filter((t) => t.block >= T.closeBlock)) expect(trade.taxRaw).toBe(0n);
    for (const trade of chain.trades().filter((t) => t.block < T.openBlock && t.route !== 'bootstrap')) expect(trade).toBeUndefined();
  });

  it('keeps every trade’s figures equal to the curve at its price', () => {
    const chain = demoChainFor(T, 'curve');
    for (const trade of chain.trades()) {
      const point = curvePoint(trade.sqrtPriceX96After, MISFITS_CURVE);
      expect(trade.retainedAfterWei).toBe(point.retainedWei);
      expect(trade.fillBpsAfter).toBe(point.fillBps);
    }
    expect(chain.head.state.swapCount).toBeGreaterThan(100);
  });

  it('completes at exactly 4.206980085 ETH and graduates after the 32-block latch', () => {
    const completed = demoChainFor(T, 'completed');
    const state = completed.head.state;
    expect(state.phase).toBe('completed');
    expect(state.sqrtPriceX96).toBe(MISFITS_CURVE.sqrtPriceLowerX96);
    expect(curvePoint(state.sqrtPriceX96, MISFITS_CURVE)).toMatchObject({ retainedWei: BAND_TARGET_WEI, fillBps: 10_000 });
    expect(completed.head.header.number).toBe((state.completedBlock ?? 0n) + 12n);
    const migrated = demoChainFor(T, 'migrated').head.state;
    expect(migrated).toMatchObject({ phase: 'migrated' });
    expect(migrated.migratedBlock).toBe((migrated.completedBlock ?? 0n) + 40n);
    expect(() => new DemoChain(T).migrateAt(T.openBlock + 10n)).toThrow(/latch/);
  });

  it('is deterministic: the same scenario gives the same frames', () => {
    for (const scenario of DEMO_SCENARIOS) {
      expect(toJson(demoChainFor(T, scenario).snapshot(0))).toBe(toJson(demoChainFor(T, scenario).snapshot(0)));
    }
    expect(isDemoScenario('window')).toBe(true);
    expect(isDemoScenario('__proto__')).toBe(false);
  });

  it('rolls back and continues on another branch', () => {
    const chain = demoChainFor(T, 'reorg');
    const head = chain.head.header;
    const rolled = chain.rollback(1);
    expect(rolled.ancestor.header.number).toBe(head.number - 1n);
    const next = chain.mineNext();
    expect(next.header.number).toBe(head.number);
    expect(next.header.hash).not.toBe(head.hash);
  });
});

describe('the Demo stream', () => {
  function fakeClock() {
    let now = 0;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let id = 0;
    return {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        id += 1;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        const index = timers.findIndex((timer) => timer.id === handle);
        if (index >= 0) timers.splice(index, 1);
      },
      advance(ms: number) {
        const until = now + ms;
        for (;;) {
          timers.sort((a, b) => a.at - b.at);
          const next = timers[0];
          if (!next || next.at > until) break;
          timers.shift();
          now = next.at;
          next.fn();
        }
        now = until;
      },
    };
  }

  it('opens with a snapshot and a status, then sends one block per 12 s slot', () => {
    const clock = fakeClock();
    const stream = createDemoStream(T, 'curve', clock);
    const seen: string[] = [];
    for (const type of ['open', 'snapshot', 'status', 'block']) stream.addEventListener(type, () => seen.push(type));
    expect(stream.readyState).toBe(0);
    clock.advance(0);
    expect(seen).toEqual(['open', 'snapshot', 'status']);
    clock.advance(36_000);
    expect(seen.filter((type) => type === 'block')).toHaveLength(3);
    stream.close();
    clock.advance(60_000);
    expect(seen.filter((type) => type === 'block')).toHaveLength(3);
  });

  it('sends no block in the stale scenario and a reorg first in the reorg scenario', () => {
    const clock = fakeClock();
    const stale = createDemoStream(T, 'stale', clock);
    const staleSeen: string[] = [];
    for (const type of ['status', 'block']) stale.addEventListener(type, (event) => staleSeen.push(`${type}:${String(event.data).includes('"stale"')}`));
    clock.advance(60_000);
    expect(staleSeen).toEqual(['status:true']);
    const reorg = createDemoStream(T, 'reorg', clock);
    const reorgSeen: string[] = [];
    for (const type of ['reorg', 'block']) reorg.addEventListener(type, () => reorgSeen.push(type));
    clock.advance(24_000);
    expect(reorgSeen).toEqual(['reorg', 'block']);
  });
});
