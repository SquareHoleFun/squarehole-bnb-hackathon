import { describe, expect, it } from 'vitest';
import { interpret } from '../src/chain';
import { loadConfig } from '../src/config';
import { runTick, type ChainPort, type KeeperState, type TickReport } from '../src/run';
import { decodeState, encodeState } from '../src/state';
import type { BoxState, InboxCoin, World } from '../src/world';
import { addr, box, keeper, quiet, time, v2 } from './support/v2';
import { seededRng } from '../src/rng';

// Second release review (RC6RR2-MONEY-2, RC6RR2-KEEPER-1, RR2-LIM-1): unblocking work (refreshes and zero-P presses,
// admitted outside F111) must not take the shared daily wallet room that other boxes' income-funded work needs.
const GWEI = 1_000_000_000n;
const env = { SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
/** Production defaults (config.ts), not the suite's toy limits: 0.102 ours, 0.051 reserve, 0.114 total, 0.05 gwei priority. */
const production = () => ({ ...loadConfig(env), keeper, privateEndpoint: false, dryRun: false, rng: seededRng(2) });
const lot = (n: number): InboxCoin => ({ coin: addr(200 + n), lot: 1_000_000n, balance: 1_000_000n, allowance: 0n,
  approved: 0n, oldestUnsoldAt: 0n, registered: false });
const part = (n: number, over: Partial<BoxState['v2'] & object> = {}): BoxState => box({ id: BigInt(n), coordinator: addr(0x100 + n),
  hook: addr(0x200 + n), receiver: addr(0x300 + n),
  v2: { ...v2, buyBackP: 0n, depthBudget: 0n, royalty: { address: addr(0x400 + n), eth: 0n, wrapped: 0n, price: 0n }, ...over } });
const at = (boxes: readonly BoxState[], block: bigint, timestamp: bigint, baseFeePerGas: bigint): World =>
  ({ block: { number: block, timestamp, baseFeePerGas }, fitGraduated: false, boxes });
/** Only `funded` boxes earned confirmed platform income in the last 24 hours. */
const income = (w: World, funded: readonly BoxState[]) => ({ at: w.block.timestamp, platformWei: 10n ** 30n, mined: {},
  boxes: Object.fromEntries(funded.map(b => [b.receiver.toLowerCase(), { shareWei: 10n ** 30n, tipsWei: 0n }])) });
const sent = (r: TickReport, job: string) => r.sent.filter(s => s.job === job).length;

describe('the unblocking wei ceilings', () => {
  it('default to half the ordinary ours room for all boxes and a quarter of that for each box, and parse decimal wei', () => {
    const limits = loadConfig(env).limits;
    expect(limits.unblockingWeiPerDay).toBe((102_000_000_000_000_000n - 51_000_000_000_000_000n) / 2n);
    expect(limits.unblockingWeiPerBoxPerDay).toBe(25_500_000_000_000_000n / 4n);
    const custom = loadConfig({ ...env, SH_KEEPER_OURS_WEI_PER_DAY: '202000000000000000' }).limits;
    expect(custom.unblockingWeiPerDay).toBe(75_500_000_000_000_000n);
    expect(custom.unblockingWeiPerBoxPerDay).toBe(75_500_000_000_000_000n / 4n);
    for (const value of ['0', (2n ** 200n).toString()]) {
      const set = loadConfig({ ...env, SH_KEEPER_UNBLOCKING_WEI_PER_DAY: value, SH_KEEPER_UNBLOCKING_WEI_PER_BOX_PER_DAY: value }).limits;
      expect([set.unblockingWeiPerDay, set.unblockingWeiPerBoxPerDay]).toEqual([BigInt(value), BigInt(value)]);
    }
    for (const value of ['-1', '1.5', '1e8']) {
      expect(() => loadConfig({ ...env, SH_KEEPER_UNBLOCKING_WEI_PER_DAY: value })).toThrow();
      expect(() => loadConfig({ ...env, SH_KEEPER_UNBLOCKING_WEI_PER_BOX_PER_DAY: value })).toThrow();
    }
  });

  it('RC6RR2-MONEY-2: four donated lots in a box with no income no longer take another box\'s collect room for the day', async () => {
    const a = part(1, { q: addr(0), royalty: { address: addr(0x401), eth: 0n, wrapped: 0n, price: 0n, coins: [lot(1), lot(2), lot(3), lot(4)] } });
    const b = part(2);
    let w = at([a, b], 100n, time, GWEI);
    let collectDue = false;
    const port: ChainPort = { read: async () => w, readIncome: async () => income(w, [b]), send: async () => '0x01',
      simulate: async c => c.job === 'royaltyRefresh' ? { ok: true, tipWei: null, estimate: 300_000n }
        : c.job === 'collect' && c.to === b.receiver && collectDue ? { ok: true, tipWei: null, estimate: 600_000n }
          : { ok: false, tipWei: null, estimate: 0n } };
    const first = await runTick(port, {}, production(), quiet);
    // The box's first refresh is admitted (5M at 2.05 gwei, 10.25 mETH); its share of the unblocking room is then spent.
    expect(sent(first.report, 'royaltyRefresh')).toBe(1);
    expect(first.report.skipped.filter(s => s.why === 'box unblocking wei spent')).toHaveLength(3);
    w = at([a, b], 400n, time + 3600n, GWEI); collectDue = true;
    const second = await runTick(port, decodeState(encodeState(first.state, 'test'), 'test'), production(), quiet);
    expect(second.report.sent.map(s => s.job)).toEqual(['collect']);
  });

  it('RC6RR2-KEEPER-1: an income-less box\'s zero-P presses leave another box its buyBacks', async () => {
    const run = async (withA: boolean) => {
      const a = part(1); const b = part(2, { buyBackP: 1000n });
      let w = at(withA ? [a, b] : [b], 100n, time, GWEI / 2n);
      const presses: bigint[] = []; let buyBacks = 0;
      const port: ChainPort = { read: async () => w, readIncome: async () => income(w, [b]),
        simulate: async c => c.job === 'sellFees' && c.to === a.hook ? { ...interpret(c, [0, 36n, 0n, 0n], null), estimate: 800_000n }
          : c.job === 'buyBack' && c.to === b.receiver ? { ok: true, tipWei: 0n, estimate: 1_000_000n } : { ok: false, tipWei: null, estimate: 0n },
        send: async c => { if (c.job === 'sellFees') presses.push(w.block.number); if (c.job === 'buyBack') buyBacks++; return '0x01'; } };
      let state: KeeperState = {};
      for (let i = 0n; i < 40n; i++) {
        w = at(withA ? [a, b] : [b], 100n + i, time + i * 12n, GWEI / 2n);
        state = (await runTick(port, state, { ...production(), priorityFeeWei: 50_000_000n }, quiet)).state;
      }
      return { presses, buyBacks, state };
    };
    const alone = await run(false); const both = await run(true);
    expect(alone.buyBacks).toBe(6);
    // Box A presses while its own unblocking spend is below its share (3.5M at 1.05 gwei: 3.675 mETH each), then waits.
    expect(both.presses).toHaveLength(2);
    expect(both.buyBacks).toBe(5);
    expect(both.state.budget?.unblockingWeiByBox?.[addr(0x301)]).toBe(2n * 3_500_000n * 1_050_000_000n);
  });

  it('RR2-LIM-1: all boxes\' unblocking work together never reserves more than the platform ceiling, and ordinary work keeps the rest', async () => {
    const dusty = Array.from({ length: 8 }, (_, i) => part(10 + i));
    const b = part(2, { buyBackP: 1000n });
    const w = at([...dusty, b], 100n, time, GWEI);
    const port: ChainPort = { read: async () => w, readIncome: async () => income(w, [b]), send: async () => '0x01',
      simulate: async c => c.job === 'sellFees' && dusty.some(d => d.hook === c.to) ? { ...interpret(c, [0, 36n, 0n, 0n], null), estimate: 800_000n }
        : c.job === 'buyBack' ? { ok: true, tipWei: 0n, estimate: 1_000_000n } : { ok: false, tipWei: null, estimate: 0n } };
    const cfg = { ...production(), limits: { ...production().limits, maxTxPerBlock: 20 } };
    const out = await runTick(port, {}, cfg, quiet);
    const unblocking = out.state.budget.unblockingWei ?? 0n;
    // 3.5M at 2.05 gwei is 7.175 mETH: three presses fit the 25.5 mETH ceiling; the other five dusty boxes wait.
    expect(sent(out.report, 'sellFees')).toBe(3);
    expect(unblocking).toBe(3n * 3_500_000n * 2_050_000_000n);
    expect(unblocking).toBeLessThanOrEqual(cfg.limits.unblockingWeiPerDay ?? 0n);
    expect(out.report.skipped.filter(s => s.why === 'unblocking wei spent')).toHaveLength(5);
    // The buyBack (8M at 2.05 gwei, 16.4 mETH) still fits the ordinary room left.
    expect(sent(out.report, 'buyBack')).toBe(1);
  });

  it('charges both counters before signing, keeps them across a restart, and a zero ceiling disables unblocking work', async () => {
    const a = part(1);
    const w = at([a], 100n, time, GWEI);
    const port: ChainPort = { read: async () => w, readIncome: async () => income(w, []), send: async () => '0x01',
      simulate: async c => c.job === 'sellFees' ? { ...interpret(c, [0, 36n, 0n, 0n], null), estimate: 800_000n } : { ok: false, tipWei: null, estimate: 0n } };
    const saved: KeeperState[] = [];
    const out = await runTick(port, {}, { ...production(), checkpoint: async s => { saved.push(s); } }, quiet);
    expect(saved[0]?.budget?.unblockingWei).toBe(3_500_000n * 2_050_000_000n);
    expect(decodeState(encodeState(out.state, 'test'), 'test').budget?.unblockingWeiByBox).toEqual({ [addr(0x301)]: 3_500_000n * 2_050_000_000n });
    for (const limits of [{ unblockingWeiPerDay: 0n }, { unblockingWeiPerBoxPerDay: 0n }]) {
      const none = await runTick(port, {}, { ...production(), limits: { ...production().limits, ...limits } }, quiet);
      expect(none.report.sent).toEqual([]);
    }
  });
});
