import { describe, expect, it } from 'vitest';
import { toHex } from 'viem';
import { interpret } from '../src/chain';
import { loadConfig } from '../src/config';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import type { BoxState, InboxCoin, World } from '../src/world';
import { seededRng } from '../src/rng';
import { addr, box, keeper, quiet, time, v2 } from './support/v2';

// Second release review, RR2-LIM-1, the limits lens's own day: box A is a dusty sourced box whose every press sells for
// zero P; box B holds whole lots of two listed coins whose orders need refreshing every hour. Production defaults, the
// 0.1 gwei base fee the verifier compared B alone against B beside A at (40 refreshes against 2 at the release), receipts
// final 64 blocks after their send. A's unblocking work must leave B's refreshes as they are alone.
const coin = (n: number): InboxCoin => ({ coin: addr(n), lot: 100n, balance: 200n, allowance: 0n, approved: 0n, oldestUnsoldAt: 0n, registered: false });
const boxA: BoxState = box({ id: 1n, hook: addr(0x2a), receiver: addr(0x3a), coordinator: addr(0x1a),
  v2: { ...v2, buyBackP: 0n, depthBudget: 0n, q: addr(9), royalty: { address: addr(0x8a), eth: 0n, wrapped: 0n, price: 0n, coins: [] } } });
const boxB: BoxState = box({ id: 2n, hook: addr(0x2b), receiver: addr(0x3b), coordinator: addr(0x1b),
  v2: { ...v2, buyBackP: 0n, depthBudget: 0n, q: addr(9), royalty: { address: addr(0x8b), eth: 0n, wrapped: 0n, price: 0n, coins: [coin(20), coin(21)] } } });

async function day(baseFeePerGas: bigint, boxes: readonly BoxState[]) {
  const cfg = { ...loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid' }),
    keeper, privateEndpoint: false, dryRun: false, rng: seededRng(2) };
  let w: World = { block: { number: 0n, timestamp: time, baseFeePerGas }, fitGraduated: false, boxes };
  const sent: { block: bigint; job: string }[] = [];
  const paid = new Map<string, { block: bigint; wei: bigint }>();
  const effective = baseFeePerGas + cfg.priorityFeeWei;
  const port: ChainPort = {
    read: async () => w,
    readIncome: async () => ({ at: w.block.timestamp, platformWei: 0n, boxes: {}, mined: {} }),
    // The merged tree's measured costs (P5.7): a 32-dust zero-P press 755,046 gas; refreshOrder 286,223 (default EVM).
    simulate: async c => c.job === 'sellFees' && c.to === boxA.hook ? { ...interpret(c, [0, 36n, 0n, 0n], null), estimate: 755_046n }
      : c.job === 'royaltyRefresh' ? { ok: true, tipWei: null, estimate: 286_223n } : { ok: false, tipWei: null, estimate: 0n },
    send: async c => {
      const hash = toHex(BigInt(sent.length + 1), { size: 32 });
      sent.push({ block: w.block.number, job: c.job });
      paid.set(hash, { block: w.block.number, wei: (c.job === 'sellFees' ? 755_046n : 286_223n) * effective });
      return hash;
    },
    settled: async hashes => Object.fromEntries(hashes.flatMap(h => {
      const p = paid.get(h); return p && w.block.number >= p.block + 64n ? [[h, p.wei]] : [];
    })),
  };
  let state: KeeperState = {};
  const midnight = time / 86_400n * 86_400n;
  for (let block = 1n; block < 7000n; block++) {
    w = { ...w, block: { number: block, timestamp: midnight + block * 12n, baseFeePerGas } };
    state = (await runTick(port, state, cfg, quiet)).state;
  }
  return { refreshes: sent.filter(s => s.job === 'royaltyRefresh').length, presses: sent.filter(s => s.job === 'sellFees').length, state, cfg };
}

describe('RR2-LIM-1: a dusty box\'s zero-P presses leave another box its refreshes for the day', () => {
  it.each([100_000_000n, 500_000_000n, 1_000_000_000n])('base fee %s wei', async base => {
    const alone = await day(base, [boxB]);
    const both = await day(base, [boxA, boxB]);
    process.stderr.write(`RR2-LIM-1-DAY ${JSON.stringify({ base: base.toString(), aloneRefreshes: alone.refreshes, bothRefreshes: both.refreshes,
      presses: both.presses, unblockingWei: both.state.budget?.unblockingWei?.toString() })}\n`);
    expect(both.refreshes).toBe(alone.refreshes);
    // Two coins, one refresh each per clock hour, all day long at 0.1 gwei; at higher fees B's own share of the
    // unblocking room (a quarter of the all-box ceiling) bounds its refreshes, with or without A: 41 and 22 here.
    expect(alone.refreshes).toBeGreaterThanOrEqual(base === 100_000_000n ? 46 : base === 500_000_000n ? 41 : 22);
    expect(both.presses).toBeGreaterThan(0);
    expect(both.state.budget?.unblockingWei ?? 0n).toBeLessThanOrEqual(both.cfg.limits.unblockingWeiPerDay ?? 0n);
  });
});
