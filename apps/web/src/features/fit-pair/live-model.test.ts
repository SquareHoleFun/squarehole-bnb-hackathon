import { curvePoint, MISFITS_CURVE, REHEARSAL_CURVE, toJson } from '@squarehole/indexer/client';
import { describe, expect, it } from 'vitest';
import { DemoChain } from './demo-chain';
import { DEMO_FIT_TARGET, type FitMarketTarget } from './fit-target';
import { applyLiveEvent, LiveDataError, liveWindowAt, MAX_TRADES, mismatchOf, parseLiveEvent, tierOfBlock, type LiveData } from './live-model';

const T = DEMO_FIT_TARGET;

function chainAt(offset: bigint): DemoChain {
  const chain = new DemoChain(T);
  chain.mineTo(T.openBlock + offset);
  return chain;
}

function snapshotOf(chain: DemoChain): LiveData {
  const event = parseLiveEvent('snapshot', toJson(chain.snapshot(0)), T);
  if (event.type !== 'snapshot') throw new Error('not a snapshot');
  return event.data;
}

const tamper = (json: string, edit: (value: Record<string, unknown>) => void): string => {
  const value = JSON.parse(json) as Record<string, unknown>;
  edit(value);
  return JSON.stringify(value);
};

describe('parseLiveEvent: the gateway’s sh.live-pool.v1 frames', () => {
  it('reads a snapshot the indexer’s view builders made, with the curve recomputed from √price', () => {
    const chain = chainAt(200n);
    const data = snapshotOf(chain);
    const head = chain.head.state;
    const point = curvePoint(head.sqrtPriceX96, MISFITS_CURVE);
    expect(data.head.number).toBe(chain.head.header.number);
    expect(data.state.sqrtPriceX96).toBe(head.sqrtPriceX96);
    expect(data.state.figures.retainedWei).toBe(point.retainedWei);
    expect(data.state.figures.fillBps).toBe(point.fillBps);
    expect(data.state.burnedRaw).toBe(head.burnedRaw);
    expect(data.window.status).toBe('open');
    expect(data.trades.length).toBeLessThanOrEqual(MAX_TRADES);
    expect(data.trades[0]?.block).toBeGreaterThanOrEqual(data.trades.at(-1)?.block ?? 0n);
    expect(mismatchOf(data)).toBeNull();
  });

  it('refuses a snapshot for another chain or pool, or of another schema', () => {
    const json = toJson(chainAt(10n).snapshot(0));
    expect(() => parseLiveEvent('snapshot', tamper(json, (v) => (v.poolId = `0x${'ab'.repeat(32)}`)), T)).toThrow(/another chain or pool/);
    expect(() => parseLiveEvent('snapshot', tamper(json, (v) => (v.chainId = 1)), T)).toThrow(/another chain or pool/);
    expect(() => parseLiveEvent('snapshot', tamper(json, (v) => (v.schema = 'sh.live-pool.v0')), T)).toThrow(LiveDataError);
  });

  it('marks figures that do not match the price as unverified, never as live', () => {
    const json = toJson(chainAt(50n).snapshot(0));
    const lying = parseLiveEvent('snapshot', tamper(json, (v) => ((v.state as Record<string, unknown>).retainedWei = '4206980085000000000')), T);
    expect(lying.type === 'snapshot' && lying.data.stateMismatch).toMatch(/do not match the pool price/);
    // The indexer PoC follows the rehearsal curve: a Misfits market flags that as another curve.
    const rehearsal: FitMarketTarget = { ...T, curve: REHEARSAL_CURVE, curveName: 'rehearsal' };
    const other = parseLiveEvent('snapshot', json, rehearsal);
    expect(other.type === 'snapshot' && other.data.curveMismatch).toMatch(/another curve/);
  });

  it('takes the launch window from the head and this market, never from the service, and flags a served window that differs', () => {
    const chain = chainAt(5n); // inside the router window
    const honest = snapshotOf(chain);
    expect(honest.window).toEqual(liveWindowAt(honest.head, T));
    expect(honest.window.status).toBe('router_window');
    expect(mismatchOf(honest)).toBeNull();
    // A gateway following another deployment: its window opened elsewhere and reads "open" during this market's window.
    const json = toJson(chain.snapshot(0));
    const other = parseLiveEvent(
      'snapshot',
      tamper(json, (v) => {
        const w = v.window as Record<string, unknown>;
        w.openBlock = '1000';
        w.closeBlock = '1032';
        w.status = 'open';
        w.blocksToClose = '0';
      }),
      T,
    );
    if (other.type !== 'snapshot') throw new Error('not a snapshot');
    expect(other.data.window).toEqual(liveWindowAt(other.data.head, T));
    expect(other.data.window.status).toBe('router_window');
    expect(other.data.stateMismatch).toMatch(/launch window/);
    expect(mismatchOf(other.data)).toMatch(/launch window/);
    // The same on a block frame (a wrong tax for the next block) and on a reorg frame.
    const block = chain.mineNext();
    const lying = parseLiveEvent('block', tamper(toJson(chain.blockEvent(1, block)), (v) => ((v.window as Record<string, unknown>).nextBlockTaxPips = 0)), T);
    if (lying.type !== 'block') throw new Error('not a block');
    expect(lying.mismatch).toMatch(/launch window/);
    expect(lying.window).toEqual(liveWindowAt(lying.head, T));
    expect(lying.window.nextBlockTaxPips).toBeGreaterThan(0);
    const rolled = chain.rollback(1);
    const reorg = parseLiveEvent('reorg', tamper(toJson(chain.reorgEvent(2, rolled)), (v) => ((v.window as Record<string, unknown>).status = 'open')), T);
    expect(reorg.type === 'reorg' && reorg.mismatch).toMatch(/launch window/);
  });

  it('rejects hostile or malformed fields (UI-10)', () => {
    const json = toJson(chainAt(50n).snapshot(0));
    const cases: ((v: Record<string, unknown>) => void)[] = [
      (v) => ((v.state as Record<string, unknown>).sqrtPriceX96 = '1e30'),
      (v) => ((v.state as Record<string, unknown>).sqrtPriceX96 = '0'),
      (v) => ((v.state as Record<string, unknown>).launchPhase = 'rugged'),
      (v) => ((v.head as Record<string, unknown>).hash = '<script>'),
      (v) => ((v.window as Record<string, unknown>).status = 'soon'),
      (v) => (((v.trades as Record<string, unknown>[])[0] as Record<string, unknown>).side = 'mint'),
      (v) => (((v.trades as Record<string, unknown>[])[0] as Record<string, unknown>).ethRaw = -5),
      (v) => (((v.trades as Record<string, unknown>[])[0] as Record<string, unknown>).id = 'a b'),
      (v) => (v.trades = 'many'),
    ];
    for (const edit of cases) expect(() => parseLiveEvent('snapshot', tamper(json, edit), T)).toThrow(LiveDataError);
    expect(() => parseLiveEvent('snapshot', 'not json', T)).toThrow(/not JSON/);
    expect(() => parseLiveEvent('surprise', '{}', T)).toThrow(/Unknown event/);
    // A trader that is not an address is dropped to "unknown", not shown.
    const odd = parseLiveEvent('snapshot', tamper(json, (v) => (((v.trades as Record<string, unknown>[])[0] as Record<string, unknown>).trader = 'javascript:alert(1)')), T);
    expect(odd.type === 'snapshot' && odd.data.trades[0]?.trader).toBeNull();
  });

  it('reads status, resync, finality and traders events', () => {
    expect(parseLiveEvent('status', '{"indexer":"stale","reason":"no new block\\u0007","atMs":1}', T)).toEqual({ type: 'status', indexer: 'stale', reason: 'no new block' });
    expect(() => parseLiveEvent('status', '{"indexer":"great"}', T)).toThrow();
    expect(parseLiveEvent('resync', '{"reason":"gateway missed frames"}', T)).toEqual({ type: 'resync', reason: 'gateway missed frames' });
    expect(parseLiveEvent('finality', '{"confirmedBlock":"9","safeBlock":"5","finalizedBlock":null}', T)).toEqual({ type: 'finality', finality: { confirmedBlock: 9n, safeBlock: 5n, finalizedBlock: null } });
    expect(parseLiveEvent('traders', `{"block":"7","blockHash":"0x${'1'.repeat(64)}","traders":[{"id":"a:1","trader":"0x${'2'.repeat(40)}"},{"id":"b:2","trader":"nope"}]}`, T)).toEqual({
      type: 'traders',
      block: 7n,
      traders: [{ id: 'a:1', trader: `0x${'2'.repeat(40)}` }],
    });
  });
});

describe('applyLiveEvent', () => {
  it('folds block events: newest trades first, at most 25, head and window move', () => {
    const chain = chainAt(100n);
    let data: LiveData | null = snapshotOf(chain);
    for (let i = 0; i < 40; i += 1) {
      const block = chain.mineNext();
      const event = parseLiveEvent('block', toJson(chain.blockEvent(i + 1, block)), T);
      data = applyLiveEvent(data, event);
    }
    const expected = snapshotOf(chain);
    expect(data?.head).toEqual(expected.head);
    expect(data?.state).toEqual(expected.state);
    expect(data?.trades.map((trade) => trade.id)).toEqual(expected.trades.map((trade) => trade.id));
    expect(data?.trades.length).toBeLessThanOrEqual(MAX_TRADES);
  });

  it('drops the replaced block’s trades on a reorg and snaps to the ancestor', () => {
    const chain = new DemoChain(T);
    chain.mineTo(T.openBlock + 5n); // inside the window: router buys every few blocks
    while (chain.head.trades.length === 0) chain.mineNext();
    const before = snapshotOf(chain);
    const dropped = chain.head.trades.map((trade) => trade.id);
    const rolled = chain.rollback(1);
    const after = applyLiveEvent(before, parseLiveEvent('reorg', toJson(chain.reorgEvent(9, rolled)), T));
    expect(after?.head.number).toBe(rolled.ancestor.header.number);
    expect(after?.trades.some((trade) => dropped.includes(trade.id))).toBe(false);
    expect(after?.state.sqrtPriceX96).toBe(rolled.ancestor.state.sqrtPriceX96);
  });

  it('patches traders and finality, and ignores blocks before any snapshot', () => {
    const chain = chainAt(100n);
    const data = snapshotOf(chain);
    const first = data.trades[0];
    if (!first) throw new Error('no trade');
    const trader = `0x${'9'.repeat(40)}`;
    expect(applyLiveEvent(data, { type: 'traders', block: first.block, traders: [{ id: first.id, trader }] })?.trades[0]?.trader).toBe(trader);
    const finality = applyLiveEvent(data, { type: 'finality', finality: { confirmedBlock: 1n, safeBlock: data.head.number, finalizedBlock: data.head.number - 1n } });
    expect(finality?.finality).toEqual({ confirmedBlock: data.finality.confirmedBlock, safeBlock: data.head.number, finalizedBlock: data.head.number - 1n });
    if (!finality) throw new Error('no data');
    expect(tierOfBlock(data.head.number, finality)).toBe('safe');
    const block = parseLiveEvent('block', toJson(chain.blockEvent(1, chain.mineNext())), T);
    expect(applyLiveEvent(null, block)).toBeNull();
    expect(applyLiveEvent(data, { type: 'status', indexer: 'live', reason: null })).toBe(data);
  });
});
