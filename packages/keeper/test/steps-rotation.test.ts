import { describe, expect, it } from 'vitest';
import { interpret } from '../src/chain';
import type { IncomeSnapshot } from '../src/income';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { restartStarts } from './support/start-state';
import type { Candidate, Sim } from '../src/types';
import type { BoxState, V2State } from '../src/world';
import { addr, box, fundedIncome, options, quiet, time, v2, world } from './support/v2';

// SH-KEEPER-V2-STEPS, STEPS-A: the four pool steps (buyBack, deepen, shopFees, sellFees) share one protocol step per
// block and take turns. A step a policy check defers (income cap, fee pause, budget, gas admission) did no work: it keeps
// its retry eligibility, but its turn passes, so one blocked step cannot starve the others. Every cap stays as strict.
const STEPS = ['buyBack', 'deepen', 'shopFees', 'sellFees'] as const;
const HOOK = box().hook.toLowerCase();
const RECEIVER = box().receiver.toLowerCase();
// maxFeePerGas 3 wei at the fixtures' 1 wei base fee: buyBack and deepen sign their 8M floor (24M wei) from a 100k
// estimate, deepen 12M (36M wei) from a 10M one; shopFees 3.5M; sellFees 8.2M on Osaka.
const BUY_BACK_COST = 8_000_000n * 3n;
const OVER_CAP = 20_000_000n;

interface Setup {
  readonly v?: Partial<V2State>;
  readonly income?: (at: bigint) => IncomeSnapshot;
  /** Supply monitor readings, so the tick tracks the monitor view's queue. */
  readonly monitor?: boolean;
  readonly deepenEstimate?: bigint;
  readonly sellFeesEstimate?: bigint;
  readonly buyBackTip?: bigint | null;
  readonly sellFees?: boolean;
  readonly baseFee?: (block: bigint) => bigint;
  /** More boxes beside the pool box (id 0); only their fixed-Safe payouts find work. */
  readonly others?: readonly BoxState[];
  /** Jobs whose send fails after the node may have accepted it (an ambiguous send). */
  readonly sendError?: (job: string) => boolean;
  readonly retryBlocks?: bigint;
  readonly limits?: Partial<ReturnType<typeof options>['limits']>;
}

function harness(s: Setup = {}) {
  const b = box({ v2: { ...v2, depthBudget: 1000n, buyBackP: 1000n, shopPendingP: 1000n, stepMinQ: 1n, ...s.v } });
  let block = 100n;
  const at = () => time + (block - 100n) * 12n;
  const sends: { block: bigint; job: string }[] = [];
  const skips: { block: bigint; job: string; why: string }[] = [];
  const port: ChainPort = {
    read: async () => ({ ...world(b, block, at()), boxes: [b, ...(s.others ?? [])],
      block: { number: block, timestamp: at(), baseFeePerGas: s.baseFee?.(block) ?? 1n },
      ...(s.monitor ? { monitor: { complete: true, failedReads: 0, snapshot: { number: block - 1n, timestamp: at() - 12n },
        drand: { complete: true, requests: [] } } } : {}) }),
    readIncome: async () => s.income?.(at()) ?? fundedIncome(world(b, block, at())),
    simulate: async (c: Candidate): Promise<Sim> => {
      if (c.job === 'receiverPayFit') return { ok: true, tipWei: null, estimate: 100_000n };
      if (c.boxId !== b.id) return { ok: false, tipWei: null, estimate: 0n };
      if (c.job === 'deepen') return { ok: true, tipWei: null, estimate: s.deepenEstimate ?? 100_000n };
      if (c.job === 'buyBack') return { ok: true, tipWei: s.buyBackTip ?? null, estimate: 100_000n };
      if (c.job === 'shopFees') return { ok: true, tipWei: null, estimate: 100_000n };
      if (c.job === 'sellFees' && s.sellFees !== false) return { ...interpret(c, [0, 100n, 50n, 0n], null), estimate: s.sellFeesEstimate ?? 100_000n };
      return { ok: false, tipWei: null, estimate: 0n };
    },
    send: async (c: Candidate) => {
      if (s.sendError?.(c.job)) throw new Error('accepted then timed out');
      sends.push({ block, job: c.job });
      return `0x${'ab'.repeat(32)}`;
    },
  };
  const base = { ...options(), dryRun: false, priorityFeeWei: 1n, ...(s.retryBlocks === undefined ? {} : { retryBlocks: s.retryBlocks }) };
  const config = { ...base, limits: { ...base.limits, ...s.limits } };
  let state: KeeperState = {};
  return {
    sends, skips,
    get state() { return state; },
    set state(next: KeeperState) { state = next; },
    /** One tick per block up to `to`, the journal written and read back between ticks as across a restart. */
    async run(to: bigint) {
      for (; block <= to; block++) {
        const out = await runTick(port, state, config, quiet);
        for (const k of out.report.skipped) skips.push({ block, job: k.job, why: k.why });
        state = restartStarts(out.state);
      }
    },
  };
}
/** A journal whose pool step was last taken by `job`, sent at block 99: the next turn is the step after it. */
const after = (job: (typeof STEPS)[number]): KeeperState => ({ mem: { cadence: {}, pokes: {}, attempts: {},
  steps: { [HOOK]: { job, block: 99n, sent: true } }, buyBackSince: {} } });
const income = (shareWei: bigint, platformWei: bigint) => (at: bigint): IncomeSnapshot =>
  ({ at, platformWei, boxes: { [RECEIVER]: { shareWei, tipsWei: 0n } }, mined: {} });
/** Blocks in (from, to) that are not in `skip`. */
const between = (from: bigint, to: bigint, skip: (b: bigint) => boolean = () => false) => {
  let n = 0n;
  for (let b = from + 1n; b < to; b++) if (!skip(b)) n++;
  return n;
};

describe('STEPS-A1: a deferred deepen no longer blocks a buyBack that is due', () => {
  it.each([
    ['box income cap', { income: income(BUY_BACK_COST, 10n ** 30n), deepenEstimate: 10_000_000n }],
    ['platform income cap', { income: income(10n ** 30n, 4n * BUY_BACK_COST), deepenEstimate: 10_000_000n }],
    ['ours budget spent', { buyBackTip: 10n ** 18n, limits: { oursWeiPerDay: options().limits.reserveWeiPerDay } }],
    ['daily ceiling reached', { deepenEstimate: 10_000_000n, limits: { totalWeiPerDay: options().limits.reserveWeiPerDay + BUY_BACK_COST } }],
    ['gas admission: estimate exceeds destination limit', { deepenEstimate: OVER_CAP }],
  ] as const)('%s', async (why, setup: Setup) => {
    const h = harness({ ...setup, v: { shopPendingP: 0n }, sellFees: false });
    h.state = after('buyBack');
    await h.run(100n);
    expect(h.skips).toContainEqual({ block: 100n, job: 'deepen', why });
    expect(h.sends).toEqual([]);
    await h.run(103n);
    // The turn passed: the next block's step is the due buyBack, not the same deferred deepen again.
    expect(h.sends[0]).toEqual({ block: 101n, job: 'buyBack' });
    expect(h.sends.map(s => s.job)).not.toContain('deepen');
  });
});

describe('STEPS-A2: no step is starved over many ticks', () => {
  it('serves every unblocked step at least once a rotation while deepen is never admitted', async () => {
    const h = harness({ deepenEstimate: OVER_CAP });
    await h.run(159n);
    expect(h.sends.map(s => s.job)).not.toContain('deepen');
    for (const job of ['buyBack', 'shopFees', 'sellFees']) {
      const served = h.sends.filter(s => s.job === job).map(s => s.block);
      expect(served.length, job).toBeGreaterThanOrEqual(14);
      // At most three blocks between two sends of a step, counting both ends of the 60-block run.
      let previous = 99n;
      for (const at of [...served, 160n]) {
        expect(between(previous, at), `${job} gap before block ${at}`).toBeLessThanOrEqual(3n);
        previous = at;
      }
    }
    // Deepen keeps its place in the rotation and is tried every round, never admitted.
    expect(h.skips.filter(s => s.job === 'deepen' && s.why.startsWith('gas admission')).length).toBeGreaterThanOrEqual(14);
  });

  it('serves every step again within one rotation after a fee pause, and sends nothing during it', async () => {
    const pause = (block: bigint) => block >= 120n && block <= 127n;
    const h = harness({ deepenEstimate: OVER_CAP, baseFee: block => pause(block) ? 2_000_000_000n : 1n });
    await h.run(159n);
    expect(h.sends.filter(s => pause(s.block))).toEqual([]);
    expect(h.skips.filter(s => pause(s.block)).every(s => s.why === 'fee ceiling reached')).toBe(true);
    for (const job of ['buyBack', 'shopFees', 'sellFees']) {
      const served = h.sends.filter(s => s.job === job).map(s => s.block);
      let previous = 99n;
      for (const at of [...served, 160n]) {
        // A fee pause holds every step alike and keeps the turn (af1): counting only live blocks, the bound is unchanged.
        expect(between(previous, at, pause), `${job} gap before block ${at}`).toBeLessThanOrEqual(3n);
        previous = at;
      }
    }
  });

  it('cycles through all four steps while a zero-income box can send none of them (unsupported prices or no start tip)', async () => {
    const h = harness({ income: at => ({ at, platformWei: 0n, boxes: {}, mined: {} }) });
    await h.run(111n);
    expect(h.sends).toEqual([]);
    const tried = new Set(h.skips.filter(s => ['box income cap', 'start tip too small'].includes(s.why)).map(s => s.job));
    for (const job of STEPS) expect(tried, job).toContain(job);
    expect(h.state.incomeSpend).toEqual([]);
    expect(h.state.budget?.totalWei).toBe(0n);
  });
});

/** Payout-only boxes beside the pool: each owes the FIT Safe, so four payouts fill a block's four sends when due. */
const payers = (n: number) => Array.from({ length: n }, (_, i) => box({ id: BigInt(i + 1), coordinator: addr(100 + i * 10),
  hook: addr(101 + i * 10), receiver: addr(102 + i * 10), fitOwed: 1000n,
  v2: { ...v2, buyBackP: 0n, depthBudget: 0n, shopPendingP: 0n, stepMinQ: 1n } }));
const split = (sends: readonly { job: string }[]) => ({ buyBack: sends.filter(s => s.job === 'buyBack').length,
  deepen: sends.filter(s => s.job === 'deepen').length });

describe('STEPS-A5 (af1): a block-wide pause keeps the turn, so a periodic pause starves no step', () => {
  // Review of c8ba1835d: the fee ceiling and the send limit hold every step of a block alike. Passing the turn on them
  // moved the rotation one step a block whether or not the block could send, so a pause on every other block left
  // the same step up on every paused block: buyBack 0 and deepen 100 over 200 blocks.
  it.each([
    ['above 3 gwei on every other block', (b: bigint) => b % 2n === 0n],
    ['above 3 gwei on two blocks of three', (b: bigint) => b % 3n !== 0n],
  ] as const)('a fee %s: buyBack and deepen share the open blocks', async (_name, paused) => {
    const h = harness({ v: { shopPendingP: 0n }, sellFees: false, baseFee: b => paused(b) ? 1_600_000_000n : 1n });
    await h.run(299n);
    let open = 0;
    for (let b = 100n; b <= 299n; b++) if (!paused(b)) open++;
    const { buyBack, deepen } = split(h.sends);
    expect(buyBack + deepen).toBe(open);
    expect(Math.abs(buyBack - deepen), `buyBack ${buyBack}, deepen ${deepen}`).toBeLessThanOrEqual(1);
  });

  it.each([2n, 3n])('four payouts filling the send limit every %i blocks: buyBack and deepen share the other blocks', async period => {
    const h = harness({ v: { shopPendingP: 0n }, sellFees: false, others: payers(4), retryBlocks: period });
    await h.run(299n);
    const limited = new Set(h.skips.filter(s => s.why === 'rate limit').map(s => s.block));
    expect(limited.size).toBeGreaterThan(0);
    const { buyBack, deepen } = split(h.sends);
    expect(buyBack + deepen).toBe(200 - limited.size);
    expect(Math.abs(buyBack - deepen), `buyBack ${buyBack}, deepen ${deepen}`).toBeLessThanOrEqual(1);
  });

  it('a step-specific refusal still passes the turn (Bug A stays fixed under the same pause)', async () => {
    const h = harness({ v: { shopPendingP: 0n }, sellFees: false, deepenEstimate: OVER_CAP,
      baseFee: b => b % 2n === 0n ? 1_600_000_000n : 1n });
    await h.run(299n);
    const { buyBack, deepen } = split(h.sends);
    expect(deepen).toBe(0);
    expect(buyBack).toBeGreaterThanOrEqual(45);
  });
});

describe('STEPS-A3: the caps still hold', () => {
  it('spends no more of a box than its income room, whichever step has the turn', async () => {
    const h = harness({ income: income(2n * BUY_BACK_COST, 10n ** 30n) });
    await h.run(140n);
    const spent = (h.state.incomeSpend ?? []).reduce((sum, s) => sum + s.costWei, 0n);
    expect(spent).toBeLessThanOrEqual(2n * BUY_BACK_COST);
    expect(h.sends.map(s => s.job)).toEqual(['buyBack', 'deepen']);
    expect(h.state.incomeSpend).toHaveLength(2);
    // Once the room is spent every step is refused by the cap, each in its turn, and nothing more is sent.
    expect(new Set(h.skips.filter(s => s.block > 101n && ['box income cap', 'start tip too small'].includes(s.why)).map(s => s.job))).toEqual(new Set(STEPS));
  });

  it('a deferral records no attempt, keeps the step eligible and charges nothing', async () => {
    const h = harness({ deepenEstimate: OVER_CAP, sellFees: false, v: { shopPendingP: 0n } });
    h.state = after('buyBack');
    await h.run(100n);
    expect(h.state.mem?.attempts[`deepen:2:${HOOK}`]).toBeUndefined();
    expect(h.state.mem?.steps[HOOK]).toEqual({ job: 'deepen', block: 100n, sent: false });
    expect(h.state.budget?.totalWei).toBe(0n);
  });

  it('a step deferred in a block leaves that block\'s protocol step to the next step in turn', async () => {
    const h = harness({ sellFeesEstimate: OVER_CAP, v: { shopPendingP: 0n } });
    h.state = after('shopFees');
    await h.run(100n);
    expect(h.skips).toContainEqual({ block: 100n, job: 'sellFees', why: 'gas admission: estimate exceeds destination limit' });
    expect(h.sends).toEqual([{ block: 100n, job: 'buyBack' }]);
    expect(h.state.mem?.steps[HOOK]).toEqual({ job: 'buyBack', block: 100n, sent: true });
  });

  it('a step deferred after another step was sent in the same block leaves that send\'s mark on the pool', async () => {
    // One send a block: sellFees is sent first, then buyBack meets the rate limit before its slot check.
    const h = harness({ v: { shopPendingP: 0n }, limits: { maxTxPerBlock: 1 } });
    h.state = after('shopFees');
    await h.run(100n);
    expect(h.sends).toEqual([{ block: 100n, job: 'sellFees' }]);
    expect(h.skips).toContainEqual({ block: 100n, job: 'buyBack', why: 'rate limit' });
    // The mark that this block's protocol step is taken survives, as a restart in the same block must see it.
    expect(h.state.mem?.steps[HOOK]).toEqual({ job: 'sellFees', block: 100n, sent: true });
  });

  it('after an ambiguous send of a step, a rate-limited step of the same pool leaves the send\'s mark', async () => {
    // The failed send recorded its step as sent (it may be on chain) but took no slot in the tick's slot set.
    const h = harness({ v: { shopPendingP: 0n }, limits: { maxTxPerBlock: 1 }, sendError: job => job === 'sellFees' });
    h.state = after('shopFees');
    await h.run(100n);
    expect(h.sends).toEqual([]);
    expect(h.skips).toEqual(expect.arrayContaining([{ block: 100n, job: 'sellFees', why: 'send error' },
      { block: 100n, job: 'buyBack', why: 'rate limit' }]));
    expect(h.state.mem?.steps[HOOK]).toEqual({ job: 'sellFees', block: 100n, sent: true });
  });

  it('the monitor queue keeps each deferred step with its first block while turns pass, and drops it once sent', async () => {
    let funded = false;
    const h = harness({ monitor: true, income: at => funded ? fundedIncome(world(box(), 0n, at))
      : { at, platformWei: 0n, boxes: {}, mined: {} } });
    const keys = Object.fromEntries(STEPS.map(job => [job, `${job}:2:${HOOK}`]));
    const waiting = { [keys.buyBack as string]: 99n, [keys.deepen as string]: 100n, [keys.shopFees as string]: 101n, [keys.sellFees as string]: 102n };
    await h.run(103n);
    expect(h.state.monitorQueue).toEqual(waiting);
    // Seven more blocks, each step deferred again in its turn and held in the others: no step comes back young.
    await h.run(110n);
    expect(h.state.monitorQueue).toEqual(waiting);
    funded = true;
    await h.run(115n);
    expect(h.sends.map(s => s.job).sort()).toEqual(expect.arrayContaining([...STEPS].sort()));
    expect(Object.keys(h.state.monitorQueue ?? {}).filter(k => Object.values(keys).includes(k))).toEqual([]);
  });

  it('keeps the fixed daily ceiling: no turn lets a send past the ordinary room', async () => {
    const h = harness({ limits: { totalWeiPerDay: options().limits.reserveWeiPerDay + 3n * BUY_BACK_COST } });
    await h.run(160n);
    expect(h.state.budget?.totalWei).toBeLessThanOrEqual(3n * BUY_BACK_COST);
    expect(h.skips.some(s => s.why === 'daily ceiling reached')).toBe(true);
  });
});


it.each(['osaka', 'amsterdam'] as const)('Rent Free first collection, payouts, sale, second collection and buy-back on %s', async fork => {
  // Independent raw-unit book arithmetic from R=100 P and the supplied quotes. These literals are the oracle.
  const netBuyers = 990102n - 11886n, buyerUnit = netBuyers / 15n;
  expect([netBuyers, buyerUnit * 2n, buyerUnit, buyerUnit * 2n, buyerUnit * 10n, netBuyers % 15n])
    .toEqual([978216n, 130428n, 65214n, 130428n, 652140n, 6n]);
  const netSellers = 164190n - 8209n, sellerUnit = netSellers / 15n;
  expect([netSellers, sellerUnit * 2n, sellerUnit, sellerUnit * 2n, sellerUnit * 10n, netSellers % 15n])
    .toEqual([155981n, 20796n, 10398n, 20796n, 103980n, 11n]);
  expect(652140n + 103980n).toBe(756120n);
  expect(756120n - 11886n).toBe(744234n);
  expect((100000000n * 5000000n + 4206980084n) / 4206980085n).toBe(118851n);
  expect((100000000n * 500000n + 4206980084n) / 4206980085n).toBe(11886n);
  const coin = '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6' as const;
  let b = box({ id: 5n, qPerEthX18: null, v2: { ...v2, q: coin, qDecimals: 6, buyBackP: 0n, depthBudget: 1n, stepMinQ: 118851n } });
  const startAt = time / 86400n * 86400n + 86376n;
  let block = 100n, at = startAt, phase = 0;
  let credit = { shareWei: 0n, tipsWei: 0n };
  const sent: { job: string; hash: string; at: bigint; cost: bigint }[] = [];
  let state: KeeperState = {};
  const collectCost = fork === 'osaka' ? 15000000000000000n : 24000000000000000n;
  const saleCost = fork === 'osaka' ? 24600000000000000n : 48000000000000000n;
  const cfg = { ...options(), dryRun: false, priorityFeeWei: 2999999998n, retryBlocks: 25n };
  const port: ChainPort = {
    read: async () => world(b, block, at),
    gasConstraints: async () => ({ fork, transactionCap: 16777216n, blockGasLimit: 60000000n,
      ...(fork === 'amsterdam' ? { stateGas: 0n } : {}) }),
    readIncome: async () => ({ at, platformWei: credit.shareWei, boxes: { [b.receiver]: credit },
      mined: Object.fromEntries(phase > 0 ? sent.map(s => [s.hash, s.at]) : []),
      startReceipts: phase > 0 && sent[0] ? [{ box: b.receiver, hash: sent[0].hash, at: sent[0].at,
        shareWei: 0n, tipsWei: 118860000000000000n, startTipWei: 118860000000000000n }] : [] }),
    settled: async () => Object.fromEntries(sent.map(s => [s.hash,
      s.job === 'collect' ? 3570000000000000n : s.job === 'sellFees' ? 11190000000000000n : 300000000000000n])),
    simulate: async c => {
      if (c.job === 'collect') return { ...interpret(c, { buyersP: phase === 0 ? 978216n : 0n,
        sellersP: phase >= 2 ? 155981n : 0n, qToReserve: 0n, tip: phase === 0 ? 11886n : 0n }, null),
        startTipWei: phase === 0 ? 118860000000000000n : 0n, estimate: 1190000n };
      if (c.job === 'receiverPayFit' || c.job === 'receiverPayPlatform') return { ok: true, tipWei: null, estimate: 100000n };
      if (c.job === 'deepen') return { ok: true, tipWei: null, estimate: 60000001n }; // deferred step must pass its turn
      if (c.job === 'sellFees') return { ...interpret(c, [sent.some(s => s.job === 'sellFees') ? 1 : 0, 441800n, 164190n, 8209n], null),
        startTipWei: 82090000000000000n, estimate: 3730000n };
      if (c.job === 'buyBack') return { ok: true, tipWei: null, estimate: phase >= 3 ? 100000n : 60000001n };
      return { ok: false, tipWei: null, estimate: 0n };
    },
    send: async (c, gas, fees) => {
      const hash = `0x${BigInt(sent.length + 1).toString(16).padStart(64, '0')}`;
      sent.push({ job: c.job, hash, at, cost: gas * fees.maxFeePerGas }); return hash;
    },
  };
  const tick = async (n: bigint) => {
    block = n; at = startAt + (n - 100n) * 12n;
    const out = await runTick(port, restartStarts(state), cfg, quiet);
    state = out.state; return out;
  };
  const first = await tick(100n);
  expect(first.report.sent.map(s => s.job)).toEqual(['collect']);
  expect(sent[0]?.cost).toBe(collectCost);
  expect(state.budget?.oursWei).toBe(collectCost);
  phase = 1; credit = { shareWei: 0n, tipsWei: 118860000000000000n };
  b = { ...b, fitOwed: 130428n, platformOwed: 65214n, v2: { ...present(b.v2), buyBackP: 652140n, depthBudget: 130428n } };
  const payout = await tick(101n);
  expect(payout.report.sent.map(s => s.job)).toContain('receiverPayFit');
  expect(payout.report.sent.map(s => s.job)).toContain('receiverPayPlatform');
  credit = { shareWei: 652140000000000000n, tipsWei: 118860000000000000n };
  expect(credit.shareWei + credit.tipsWei).toBe(771000000000000000n);
  expect(credit.shareWei / 4n + credit.tipsWei).toBe(281895000000000000n);
  b = { ...b, fitOwed: 0n, platformOwed: 0n };
  // Deferred pool steps pass their turn; Amsterdam's 0.048 sale waits for the UTC budget reset.
  for (const n of [102n, 103n, 104n]) if (!sent.some(s => s.job === 'sellFees')) await tick(n);
  expect(sent.find(s => s.job === 'sellFees')?.cost).toBe(saleCost);
  expect(state.mem?.attempts[`collect:2:${b.hook.toLowerCase()}`]?.next).toBe(125n);
  phase = 2; credit = { ...credit, tipsWei: 200950000000000000n };
  const second = await tick(125n);
  expect(second.report.sent.map(s => s.job)).toContain('collect');
  expect(state.incomeSpend?.filter(s => s.start)).toHaveLength(1);
  phase = 3; b = { ...b, fitOwed: 20796n, platformOwed: 10398n, v2: { ...present(b.v2), buyBackP: 756120n, depthBudget: 151224n } };
  await tick(126n);
  credit = { shareWei: 756120000000000000n, tipsWei: 200950000000000000n };
  expect(credit.shareWei + credit.tipsWei).toBe(957070000000000000n);
  expect(credit.shareWei / 4n + credit.tipsWei).toBe(389980000000000000n);
  b = { ...b, fitOwed: 0n, platformOwed: 0n };
  for (const n of [127n, 128n, 129n]) if (!sent.some(s => s.job === 'buyBack')) await tick(n);
  expect(sent.find(s => s.job === 'buyBack')?.cost).toBe(24000000000000000n);
  expect(present(state.budget).oursWei).toBeLessThanOrEqual(51000000000000000n);
  expect(present(state.budget).totalWei).toBeLessThanOrEqual(63000000000000000n);
  expect(collectCost * 2n + saleCost + 48000000000000000n)
    .toBe(fork === 'osaka' ? 102600000000000000n : 144000000000000000n);
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
