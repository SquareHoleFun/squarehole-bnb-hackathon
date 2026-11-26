import { describe, expect, it } from 'vitest';
import { enumerateRoutes, rankRoutes, timeWeightedRaise, roundRaise, runnerEntries } from '../market.mjs';
import { A, input } from './rpc.mjs';

const pool = (id, kind, token0, token1, reserve0, reserve1) => ({ id, kind, token0, token1, reserve0, reserve1,
  fee: '3000', venue: input().market[kind], address: A(500), history: [] });
describe('route search and seven day on-chain valuation', () => {
  it('searches mixed venues without cycles, stops at three hops and ranks reference-trade impact', async () => {
    const pools = [pool('thin', 'v2', A(1), A(4), 100n, 100n),
      pool('a', 'v3', A(1), A(2), 10000n, 20000n), pool('b', 'v4', A(2), A(4), 20000n, 10000n),
      pool('c', 'v2', A(2), A(3), 10000n, 10000n), pool('d', 'v2', A(3), A(5), 10000n, 10000n),
      pool('e', 'v2', A(5), A(4), 10000n, 10000n)];
    const routes = enumerateRoutes(pools, A(1), A(4));
    expect(routes.map(r => r.pools.map(p => p.id))).toEqual([['thin'], ['a', 'b']]);
    const ranked = await rankRoutes(routes, 10n, async (_p, _from, amount) => amount);
    expect(ranked[0].pools.map(p => p.id)).toEqual(['a', 'b']);
    expect(ranked[1].quotedOut).toBe(9n);
    expect(ranked[1].impactBps).toBe(1000n);
  });

  it('weights inverse composite route prices by time, not samples or averaged hop products', () => {
    const a = pool('a', 'v2', A(1), A(2), 10n, 10n);
    const b = pool('b', 'v2', A(2), A(4), 10n, 10n);
    a.history = [{ timestamp: 302400n, reserve0: 20n, reserve1: 10n }];
    b.history = [{ timestamp: 302400n, reserve0: 10n, reserve1: 20n }];
    // Both prices change together, but their composite stays 1:1.
    const result = timeWeightedRaise({ pools: [a, b], path: [A(1), A(2), A(4)] }, 0n, 604800n, 1000000n);
    expect(result.amount).toBe(1000000n);
    a.history = [{ timestamp: 151200n, reserve0: 30n, reserve1: 10n }]; b.history = [];
    expect(timeWeightedRaise({ pools: [a, b], path: [A(1), A(2), A(4)] }, 0n, 604800n, 1000000n).amount).toBe(2500000n);
  });

  it('never prices a gap, zero liquidity, short window or number amount', () => {
    const p = pool('a', 'v3', A(1), A(4), 10n, 0n);
    expect(() => timeWeightedRaise({ pools: [p], path: [A(1), A(4)] }, 0n, 604800n, 1n)).toThrow();
    expect(() => timeWeightedRaise({ pools: [p], path: [A(1), A(4)] }, 0n, 10n, 1n)).toThrow();
    expect(() => roundRaise(1000000, { increment: '1', mode: 'up' })).toThrow();
  });

  it('rounds huge raw quantities with bigint and deterministic half-up ties', () => {
    const large = 10n ** 30n + 15n;
    expect(roundRaise(large, { increment: '10', mode: 'up' })).toBe(large + 5n);
    expect(roundRaise(large, { increment: '10', mode: 'nearest' })).toBe(large + 5n);
    expect(roundRaise(large, { increment: '10', mode: 'down' })).toBe(large - 5n);
  });

  it('exports runner-compatible homogeneous routes and reports v2 and mixed routes as unsupported', async () => {
    const config = input();
    const v3 = pool('a', 'v3', A(1), A(4), 100000n, 100000n);
    const result = runnerEntries(config, { token: A(1) }, { pools: [v3], path: [A(1), A(4)] }, 1000n);
    const { routeSchema } = await import('../../../packages/burn-bot/src/schema');
    expect(routeSchema.parse(result.route)).toMatchObject({ kind: 'v3', tokenIn: A(1), tokenOut: A(4) });
    expect(runnerEntries(config, { token: A(1) }, { pools: [{ ...v3, kind: 'v2' }], path: [A(1), A(4)] }, 1000n).reason).toContain('v2');
  });
});

describe('usable reference-trade liquidity and hook refusal', () => {
  it('prefers executable depth over inflated narrow-range virtual reserves', async () => {
    const narrow = pool('narrow', 'v4', A(1), A(4), 10n ** 30n, 10n ** 30n);
    const broad = pool('broad', 'v3', A(1), A(4), 10n ** 22n, 10n ** 22n);
    const ranked = await rankRoutes(enumerateRoutes([narrow, broad], A(1), A(4)), 10n ** 18n,
      async p => p.id === 'narrow' ? 5n * 10n ** 17n : 997n * 10n ** 15n);
    expect(ranked.map(r => r.pools[0].id)).toEqual(['broad', 'narrow']);
    expect(ranked.map(r => r.impactBps)).toEqual([30n, 5000n]);
  });

  it('compares impact before rounding to basis points, with stable output and ID ties', async () => {
    const routes = enumerateRoutes(['worse', 'better', 'tie'].map(id =>
      pool(id, 'v3', A(1), A(4), 10n ** 30n, id === 'worse' ? 2n * 10n ** 30n : 10n ** 30n)), A(1), A(4));
    const ranked = await rankRoutes(routes, 1000000n, async p => p.id === 'worse' ? 1999996n : 999999n);
    expect(ranked.map(r => r.pools[0].id)).toEqual(['better', 'tie', 'worse']);
    expect(ranked.every(r => r.impactBps === 1n)).toBe(true);
  });

  it('refuses to export a disallowed hook even when handed a route directly', () => {
    const p = { ...pool('hostile', 'v4', A(1), A(4), 100n, 100n), hooks: A(999), tickSpacing: '60', hookData: '0x' };
    expect(runnerEntries(input(), { token: A(1) }, { pools: [p], path: [A(1), A(4)] }, 10n))
      .toEqual({ reason: 'v4 hook is not allowed' });
  });
});

describe('rejected quote evidence', () => {
  it('identifies each failed candidate and its failing pool without exposing an upstream error', async () => {
    const p = pool('broken-quoter', 'v3', A(1), A(4), 1000n, 1000n), rejected = [];
    const ranked = await rankRoutes(enumerateRoutes([p], A(1), A(4)), 100n,
      async () => { throw new Error('private upstream message'); }, rejected);
    expect(ranked).toEqual([]);
    expect(rejected).toEqual([{ path: [A(1), A(4)], pools: [{ kind: 'v3', id: 'broken-quoter' }],
      failedPool: { kind: 'v3', id: 'broken-quoter' }, reason: 'reference quote or spot price unavailable' }]);
  });
});
