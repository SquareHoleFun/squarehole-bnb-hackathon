/**
 * SH-250 (stage B): hanging sends are replaced at the same nonce, an urgent random-number job may take a hanging ordinary
 * nonce, unconfirmed sends are bounded, and a nonce another transaction used is released on proof. Through the real
 * scheduler, chain adapter and StateStore on the scripted node (pool with the replacement rule, mining only what pays the
 * base fee, receipts, finality, counts at old blocks, block bodies). Each test is shown failing on 2545e0c35 (stage A).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTransaction, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { HANG_BLOCKS, bump } from '../src/sent';
import type { Candidate } from '../src/types';
import type { KeeperState } from '../src/run';
import { crashCopy } from './support/sent-harness';
import { hashOf, model, proc, savedHashes, tmp, type Model } from './support/sent-model';
import { dummy } from './support/sent-quiet';
import { time } from './support/v2';

const GWEI = 1_000_000_000n;
const CEILING = 3n * GWEI;

/** Every transaction signed for a nonce is one call (target and data); only an urgent takeover may differ (B3). */
function expectOneCallPerNonce(t: Model, takeovers: ReadonlySet<number> = new Set()) {
  const calls = new Map<number, Set<string>>();
  for (const raw of t.m.attempts) {
    const tx = parseTransaction(raw);
    const n = tx.nonce ?? -1;
    calls.set(n, (calls.get(n) ?? new Set()).add(`${tx.to}:${tx.data}`));
  }
  for (const [n, set] of calls) expect(set.size, `nonce ${n} signed for ${set.size} calls`).toBeLessThanOrEqual(takeovers.has(n) ? 2 : 1);
}

/** The transactions signed per nonce, in order, as the node saw them. */
const byNonce = (t: Model) => {
  const out = new Map<number, Hex[]>();
  for (const raw of t.m.attempts) {
    const n = parseTransaction(raw).nonce ?? -1;
    const list = out.get(n) ?? [];
    if (!list.includes(raw)) list.push(raw);
    out.set(n, list);
  }
  return out;
};
const fee = (raw: Hex) => parseTransaction(raw).maxFeePerGas ?? 0n;
const record = (dir: string) => JSON.parse(readFileSync(join(dir, 'keeper.json.sent'), 'utf8')) as
  { entries: { nonce: string; txs: { hash: string; maxFeePerGas: string; block: string }[] }[]; renamed?: Record<string, string>; released?: Record<string, string> };

/** Three sends at 1 gwei base (maximum 2.05 gwei), then the base fee rises to `base`. */
async function hangingThree(base: bigint) {
  const t = model(), dir = tmp();
  t.m.respectBase = true;
  t.f.node.block.baseFeePerGas = GWEI;
  const a = proc(t, dir);
  await a.tick(100n);
  expect([...t.m.pool.keys()]).toEqual([7, 8, 9]);
  t.f.node.block.baseFeePerGas = base;
  return { t, dir, a };
}

describe('SH-250 B1/B2: replaced once, both outcomes', () => {
  it('the replacement lands: one final transaction, one settled charge, the other released, no gap', async () => {
    const { t, dir, a } = await hangingThree(2_500_000_000n);
    const before = a.state.budget?.totalWei ?? 0n;
    // Three observed heads below the base fee: each nonce is replaced once, at the 3 gwei ceiling (above the 12.5% step).
    for (const block of [103n, 106n, 109n]) await a.tick(block, false);
    const signed = byNonce(t);
    for (const n of [7, 8, 9]) {
      expect(signed.get(n), `nonce ${n}`).toHaveLength(2);
      const [first, second] = signed.get(n) as [Hex, Hex];
      expect(fee(second)).toBe(CEILING);
      expect(fee(second) >= bump(fee(first))).toBe(true);
    }
    // The day holds each nonce at its highest maximum: original plus the extra, under the journal's one hash.
    const pending = a.state.budget?.pending ?? [];
    expect(pending).toHaveLength(6);
    const extra = (a.state.budget?.totalWei ?? 0n) - before;
    const gas = [...signed.values()].reduce((n, l) => n + (parseTransaction(l[1] as Hex).gas ?? 0n), 0n);
    expect(extra).toBe(gas * (CEILING - 2_050_000_000n));
    t.mine();
    const out = await a.tick(112n, false);
    expect([...t.m.mined.keys()].sort()).toEqual([...signed.values()].map(l => hashOf(l[1] as Hex)).sort());
    // One settled charge per nonce (each paid 1 wei on this node), the originals released with them.
    expect(out.state.budget?.pending ?? []).toEqual([]);
    expect(out.state.budget?.totalWei).toBe(3n);
    expect(savedHashes(dir).size).toBe(0);
    const names = record(dir).renamed ?? {};
    expect(Object.keys(names)).toHaveLength(3);
    // The F111 spend follows the winner, so it ages out as mined.
    expect(out.state.incomeSpend?.map(s => s.hash)).toEqual([hashOf((signed.get(9) as Hex[])[1] as Hex)]);
    t.f.node.block.baseFeePerGas = GWEI;
    await a.tick(140n);
    expect([...t.m.pool.keys()].filter(n => n > 9).sort((x, y) => x - y)).toEqual([10, 11, 12]);
    expectOneCallPerNonce(t);
    a.close();
  });

  it('the original lands after the replacement was broadcast and refused: the original settles, one charge, no gap', async () => {
    const { t, dir, a } = await hangingThree(2_500_000_000n);
    const originals = new Set([...t.m.pool.values()]);
    t.m.lose = raw => originals.has(raw) ? undefined : 'before';
    for (const block of [103n, 106n, 109n]) await a.tick(block, false);
    expect([...byNonce(t).values()].every(l => l.length === 2)).toBe(true);
    t.m.lose = undefined;
    t.f.node.block.baseFeePerGas = GWEI;
    t.mine();
    const out = await a.tick(112n, false);
    expect([...t.m.mined.keys()].sort()).toEqual([...originals].map(hashOf).sort());
    expect(out.state.budget?.pending ?? []).toEqual([]);
    expect(out.state.budget?.totalWei).toBe(3n);
    expect(savedHashes(dir).size).toBe(0);
    expect(Object.keys(record(dir).renamed ?? {})).toHaveLength(0);
    await a.tick(140n);
    expect([...t.m.pool.keys()].filter(n => n > 9).sort((x, y) => x - y)).toEqual([10, 11, 12]);
    expectOneCallPerNonce(t);
    a.close();
  });
});

describe('SH-250 B2/B4: a fee that keeps rising', () => {
  it('replaces at most once per hanging period, each step at least an eighth, and stops at the ceiling; charges within the ceilings', async () => {
    const t = model(), dir = tmp();
    t.m.respectBase = true;
    t.f.node.block.baseFeePerGas = 100_000_000n;
    const a = proc(t, dir);
    await a.tick(100n);
    const rounds: bigint[] = [];
    let block = 100n;
    for (const base of [300_000_000n, 700_000_000n, 1_500_000_000n, 3_500_000_000n, 9_000_000_000n]) {
      t.f.node.block.baseFeePerGas = base;
      for (let i = 0; i < 4; i++) { block += 3n; rounds.push(block); await a.tick(block, false); }
    }
    for (const [n, list] of byNonce(t)) {
      const fees = list.map(fee);
      for (let i = 1; i < fees.length; i++) expect(fees[i] as bigint >= bump(fees[i - 1] as bigint), `nonce ${n} step ${i}`).toBe(true);
      expect(fees.every(f => f <= CEILING), `nonce ${n} under the ceiling`).toBe(true);
      expect(fees.at(-1)).toBe(CEILING);
      expect(list.length).toBeLessThanOrEqual(5);
    }
    // One replacement per hanging period: consecutive transactions of a nonce were signed at least three heads apart.
    for (const e of record(dir).entries) {
      const blocks = e.txs.map(x => BigInt(x.block));
      for (let i = 1; i < blocks.length; i++) expect((blocks[i] as bigint) - (blocks[i - 1] as bigint) >= 9n).toBe(true);
    }
    const b = a.state.budget;
    expect((b?.totalWei ?? 0n) <= t.f.cfg.limits.totalWeiPerDay).toBe(true);
    expect((b?.oursWei ?? 0n) <= t.f.cfg.limits.oursWeiPerDay).toBe(true);
    // The day holds each nonce at the highest maximum it signed, never more.
    for (const e of record(dir).entries) {
      const name = e.txs[0]?.hash;
      const held = (b?.pending ?? []).filter(r => r.hash === name).reduce((n, r) => n + r.costWei, 0n);
      const raw = byNonce(t).get(Number(e.nonce))?.at(-1) as Hex;
      expect(held).toBe((parseTransaction(raw).gas ?? 0n) * fee(raw));
    }
    a.close();
  });
});

describe('SH-250 B5: bounded in flight', () => {
  it('nine sends wanted with eight unconfirmed: the ninth waits with its reason', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    await a.tick(100n);
    await a.tick(103n);
    const third = await a.tick(106n);
    expect(savedHashes(dir).size).toBe(8);
    expect([...t.m.pool.keys()].sort((x, y) => x - y)).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
    expect(third.report.skipped).toContainEqual(expect.objectContaining({ why: 'unconfirmed transactions at limit', code: 'RATE_LIMIT' }));
    t.mine();
    await a.tick(109n, false);
    const next = await a.tick(112n);
    expect(next.report.sent.length).toBeGreaterThan(0);
    a.close();
  });
});

/** An urgent post (R62-FEE: 50 gwei, rescue allowance) due from `from`, deadline 60 hours ahead. */
function urgentPost(t: Model, from: bigint) {
  const source = `0x${'5e'.repeat(20)}` as const;
  const post: Candidate = { job: 'drandPostRound', key: `drandPostRound:${source}:9`, to: source, fn: 'postRound', args: [9n, `0x${'ab'.repeat(48)}`],
    drandDeadline: time + 60n * 3600n };
  const posted = () => t.m.attempts.some(r => parseTransaction(r).to?.toLowerCase() === source && t.m.mined.has(hashOf(r)));
  // Once signed the post is not planned again here (a live keeper's attempt backoff and the pending post check).
  const signed = () => t.m.attempts.some(r => parseTransaction(r).to?.toLowerCase() === source);
  return { source, post, wire(chain: ReturnType<typeof proc>['chain']) {
    const read = chain.read.bind(chain), simulate = chain.simulate.bind(chain);
    chain.read = async (...args) => {
      const w = await read(...args);
      return w.block.number >= from && !signed() ? { ...w, drand: [post] } : w;
    };
    chain.prepare = async c => c;
    chain.simulate = async (c, fees, start) => c.job === 'drandPostRound' ? { ok: true, tipWei: null, estimate: 100_000n } : simulate(c, fees, start);
  }, posted };
}

describe('SH-250 B3: an urgent random-number job behind a hanging ordinary nonce', () => {
  it('a base fee above the maximum for 100 blocks: the post takes the nonce within its allowance before its deadline; the ordinary job is planned again', async () => {
    const t = model(), dir = tmp();
    t.m.respectBase = true;
    t.f.node.block.baseFeePerGas = GWEI;
    const a = proc(t, dir);
    // Due once nonce 7's latest transaction (replaced at block 109) has been unmined for 25 blocks (rule A).
    const urgent = urgentPost(t, 136n);
    urgent.wire(a.chain);
    await a.tick(100n);
    const payFit = [...t.m.pool.values()][0] as Hex;
    t.f.node.block.baseFeePerGas = 4n * GWEI;
    let state: KeeperState = a.state;
    for (let block = 103n; block <= 200n; block += 3n) {
      state = (await a.tick(block, false)).state;
      t.mine();
    }
    expect(urgent.posted(), 'the post is included').toBe(true);
    const post = t.m.attempts.find(r => parseTransaction(r).to?.toLowerCase() === urgent.source) as Hex;
    expect(parseTransaction(post).nonce).toBe(7);
    expect(t.m.mined.get(hashOf(post))).toBeDefined();
    expect((t.m.mined.get(hashOf(post)) ?? 0n) <= 200n).toBe(true);
    // Paid from its own allowance, never above it; the ordinary nonce's charges are released.
    expect((state.budget?.drandRescueWei ?? 0n) > 0n).toBe(true);
    expect((state.budget?.drandRescueWei ?? 0n) <= (t.f.cfg.limits.drandRescueWeiPerDay ?? 0n)).toBe(true);
    expect(record(dir).released?.[hashOf(payFit)]).toBeDefined();
    expect(state.budget?.pending?.some(r => r.hash === hashOf(payFit))).toBe(false);
    // The fee falls: the payout that lost its nonce is planned and sent again at a new nonce.
    t.f.node.block.baseFeePerGas = GWEI;
    const later = await a.tick(240n);
    expect(later.report.sent.map(s => s.job)).toContain('receiverPayFit');
    expectOneCallPerNonce(t, new Set([7]));
    a.close();
  });
});

describe('SH-250 B6: a nonce another transaction used', () => {
  it('releases the entry with its charges only once the other transaction is in a final block', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.m.lostBefore = 1;
    await a.tick(100n);
    expect(t.m.pool.has(7)).toBe(false);
    const ours = [...savedHashes(dir)].find(([, e]) => e.nonce === 7n)?.[0] as string;
    // A send by hand takes nonce 7 before our bytes go out again; mined at 101, not final yet.
    t.f.node.block.number = 101n;
    const hand = await t.foreign(7);
    t.mine();
    t.f.node.finalized = { number: 100n, hash: `0x${'64'.padStart(64, 'b')}` as Hex };
    let out = await a.tick(103n, false);
    expect(savedHashes(dir).get(ours)).toBeDefined();
    expect(out.state.budget?.pending?.some(r => r.hash === ours)).toBe(true);
    // Final now: proof found (count passed 7 at a final block, the transaction there is not ours).
    t.f.node.finalized = { number: 101n, hash: `0x${'65'.padStart(64, 'b')}` as Hex };
    out = await a.tick(130n, false);
    expect(savedHashes(dir).get(ours)).toBeUndefined();
    expect(record(dir).released?.[ours]).toBeDefined();
    expect(out.state.budget?.pending?.some(r => r.hash === ours)).toBe(false);
    expect(hashOf(hand)).not.toBe(ours);
    a.close();
  });

  it('keeps the charges when the transaction at the nonce is its own, even without a readable receipt (re-check note 1: it wins, unsettled)', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    await a.tick(100n);
    t.mine();
    t.m.receiptWindow = 0n;
    let out = await a.tick(103n, false);
    for (let block = 130n; block <= 200n; block += 30n) out = await a.tick(block, false);
    // Found in a final block, each is its nonce's winner: retired, nothing released, every charge kept unsettled.
    expect(savedHashes(dir).size).toBe(0);
    expect(Object.keys(record(dir).released ?? {})).toEqual([]);
    expect(out.state.budget?.pending).toHaveLength(3);
    a.close();
  });

  it('reads per round: counts once per signer, one receipt per transaction, and a bounded search at most once per hanging period, also with a moving head', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.m.lostBefore = 1;
    await a.tick(100n);
    t.f.node.block.number = 101n;
    await t.foreign(7);
    t.mine();
    t.m.receiptWindow = 0n;
    // Every read moves the head after this point.
    t.m.onCount = () => { t.f.node.block.number += 1n; };
    t.f.node.asked = [];
    await a.tick(200n, false);
    const asked = t.f.node.asked ?? [];
    const counts = (tag: (s: string) => boolean) => asked.filter(m => m.startsWith('eth_getTransactionCount:') && tag(m.slice(24))).length;
    expect(counts(s => s === 'latest')).toBe(1);
    expect(counts(s => s === 'pending')).toBe(1);
    // Nonces 7 to 9 used: one receipt each; the search: 2 bounds and at most ceil(log2(range)) steps, one block body.
    expect(asked.filter(m => m === 'eth_getTransactionReceipt').length).toBe(3);
    // Each used nonce without its own final receipt: 2 bounds and ceil(log2(range)) steps (range 3 here), one block body.
    expect(counts(s => s.startsWith('0x'))).toBeLessThanOrEqual(3 * (2 + 2));
    expect(asked.filter(m => m === 'eth_getBlockByNumber').length).toBeGreaterThan(0);
    // 7 released (another transaction), 8 and 9 won by their own transactions found in the block.
    expect(savedHashes(dir).size).toBe(0);
    expect(Object.keys(record(dir).released ?? {})).toHaveLength(1);
    t.f.node.asked = [];
    await a.tick(200n + HANG_BLOCKS - 3n, false);
    expect((t.f.node.asked ?? []).filter(m => m.startsWith('eth_getTransactionCount:0x')).length).toBe(0);
    a.close();
  });
});

describe('SH-250: a crash around a replacement', () => {
  it.each(['reserved', 'saved', 'broadcast'] as const)('a crash after the replacement was %s: one charge at most, one call per nonce', async point => {
    const { t, dir, a } = await hangingThree(2_500_000_000n);
    let copy: string | undefined, pool: Map<number, Hex> | undefined;
    const take = () => { if (!copy) { copy = crashCopy(dir); pool = new Map(t.m.pool); } };
    const store = a.store as unknown as { saveSent: (r: { entries: readonly { txs: readonly unknown[] }[] }) => void };
    const realSave = store.saveSent.bind(a.store);
    store.saveSent = r => { realSave(r); if (point === 'saved' && r.entries.some(e => e.txs.length > 1)) take(); };
    a.checkpoint = async (next, now) => {
      a.store.save(next, now);
      if (point === 'reserved' && (next.budget?.pending?.length ?? 0) > 3) take();
    };
    t.m.hookSend = (raw, phase) => { if (point === 'broadcast' && phase === 'after' && fee(raw) === CEILING) take(); };
    for (const block of [103n, 106n, 109n]) await a.tick(block, false);
    a.close();
    expect(copy, `crash point ${point}`).toBeDefined();
    t.m.pool = pool ?? new Map();
    t.m.attempts = t.m.attempts.filter(r => [...t.m.pool.values()].includes(r) || parseTransaction(r).maxFeePerGas !== CEILING);
    t.m.hookSend = undefined;
    const b = proc(t, copy as string);
    for (const block of [112n, 115n, 118n, 121n]) await b.tick(block, false);
    t.f.node.block.baseFeePerGas = GWEI;
    t.mine();
    const out = await b.tick(124n, false);
    // Every nonce ended in one final transaction and one settled charge of what it paid (1 wei each here).
    expect(out.state.budget?.pending ?? []).toEqual([]);
    expect(out.state.budget?.totalWei).toBe(BigInt(t.m.mined.size));
    expect(t.m.mined.size).toBe(3);
    expectOneCallPerNonce(t);
    b.close();
  });
});

describe('SH-250: the report', () => {
  it('shows every transaction of a nonce with fees and state, and what the keeper would do next', async () => {
    const { t, dir, a } = await hangingThree(2_500_000_000n);
    for (const block of [103n, 106n, 109n]) await a.tick(block, false);
    a.close();
    const { sentReport, viemReads } = await import('../src/sent-report');
    t.f.node.balances = { [t.f.me]: 1n };
    t.f.node.transaction = () => ({ blockNumber: null });
    t.f.node.block.number = 140n;
    t.f.node.block.baseFeePerGas = 3_500_000_000n;
    const lines = (await sentReport(join(crashCopy(dir), 'keeper.json'), viemReads(t.f.client))).join('\n');
    expect(lines).toMatch(/nonce 7: 2 transactions/);
    expect(lines).toMatch(/tx 1 0x[0-9a-f]{64} maxFee 2050000000 priority 50000000, [^\n]*\n {6}tx 2 0x[0-9a-f]{64} maxFee 3000000000 priority 56250000/);
    expect(lines).toMatch(/next: at its fee ceiling; waits for the base fee or a random-number takeover/);
    expect(dummy.address).toBeDefined();
  });
});

describe('SH-250 rule A: any admitted job may take a nonce unmined for 25 blocks', () => {
  it('the reviewer\'s case: an urgent post on the ordinary counter behind a hanging first collection is included within one hanging period; ordinary work goes on', async () => {
    const t = model(), dir = tmp();
    t.m.respectBase = true;
    t.f.node.block.baseFeePerGas = 100_000_000n;
    t.setFunded(false);
    const a = proc(t, dir);
    const urgent = urgentPost(t, 130n);
    urgent.wire(a.chain);
    await a.tick(100n);
    const start = a.state.incomeSpend?.find(s => s.start)?.hash as string;
    expect(savedHashes(dir).get(start)?.nonce).toBe(9n);
    // The base fee holds at 0.5 gwei, under the 3 gwei ceiling: the payouts are replaced and land, the start (M1) is not.
    t.f.node.block.baseFeePerGas = 500_000_000n;
    let state: KeeperState = a.state;
    for (let block = 103n; block <= 157n; block += 3n) { state = (await a.tick(block, false)).state; t.mine(); }
    const post = t.m.attempts.find(r => parseTransaction(r).to?.toLowerCase() === urgent.source) as Hex;
    expect(parseTransaction(post).nonce).toBe(9);
    expect((t.m.mined.get(hashOf(post)) ?? 999n) <= 155n, 'included within one hanging period of 130').toBe(true);
    expect(state.budget?.drandRescueWei ?? 0n).toBe(0n);
    expect(record(dir).released?.[start]).toBeDefined();
    expect(state.incomeSpend?.some(s => s.hash === start)).toBe(false);
    // Ordinary work behind it goes on, and the first collection is planned again with a new simulation of its tip.
    const later = await a.tick(190n);
    expect(later.report.sent.map(s => s.job).sort()).toEqual(['collect', 'receiverPayFit', 'receiverPayPlatform']);
    t.mine();
    expect(t.m.latest).toBe(13);
    a.close();
  });

  it('guarantee 3: the loser\'s bytes land after the taker was sent; its job ran once, charged once, the taker released and planned again', async () => {
    const t = model(), dir = tmp();
    const warn = vi.fn();
    const a = proc(t, dir, { info: () => {}, warn, error: () => {} });
    await a.tick(100n, { fit: 5n });
    const loser = t.m.pool.get(7) as Hex;
    for (let block = 103n; block <= 124n; block += 3n) await a.tick(block, false);
    // A collection becomes due: nonce 7 has been unmined for 27 blocks, so the collect takes it.
    const took = await a.tick(127n, { buyersP: 10n ** 16n, tip: 1n });
    expect(took.report.sent.map(s => s.job)).toEqual(['collect']);
    const taker = t.m.pool.get(7) as Hex;
    expect(parseTransaction(taker).nonce).toBe(7);
    expect(warn).toHaveBeenCalledWith('saved transaction taken over', { nonce: 7n, hash: hashOf(taker), over: hashOf(loser) });
    expect(fee(taker) >= bump(fee(loser))).toBe(true);
    // Both reservations stay while the outcome is open; both jobs are in flight.
    expect(took.state.budget?.pending?.map(r => r.hash).sort()).toEqual([hashOf(loser), hashOf(taker)].sort());
    const open = await a.tick(130n, { fit: 5n, buyersP: 10n ** 16n, tip: 1n });
    expect(open.report.sent).toEqual([]);
    expect(open.report.skipped.filter(s => s.why === 'in flight').map(s => s.job).sort()).toEqual(['collect', 'receiverPayFit']);
    // The loser's older bytes land after all.
    t.m.pool.set(7, loser);
    t.mine();
    const out = await a.tick(133n, false);
    expect([...t.m.mined.keys()]).toEqual([hashOf(loser)]);
    expect(out.state.budget?.pending ?? []).toEqual([]);
    expect(out.state.budget?.totalWei).toBe(1n);
    expect(record(dir).released?.[hashOf(taker)]).toBeDefined();
    expect(out.state.incomeSpend?.some(s => s.hash === hashOf(taker))).toBe(false);
    const again = await a.tick(136n, { buyersP: 10n ** 16n, tip: 1n });
    expect(again.report.sent.map(s => s.job)).toEqual(['collect']);
    expect(parseTransaction(t.m.pool.get(8) as Hex).nonce).toBe(8);
    a.close();
  });

  it.each(['signed', 'journal', 'promoted'] as const)('a crash around a takeover (%s): one outcome, one charge, one call landing', async point => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    await a.tick(100n, { fit: 5n });
    const loser = t.m.pool.get(7) as Hex;
    for (let block = 103n; block <= 124n; block += 3n) await a.tick(block, false);
    let copy: string | undefined, pool: Map<number, Hex> | undefined, taker: string | undefined;
    const take = () => { if (!copy) { copy = crashCopy(dir); pool = new Map(t.m.pool); } };
    const store = a.store as unknown as { saveSent: (r: { entries: readonly { txs: readonly { hash: string; state?: string; call?: unknown }[] }[] }) => void };
    const realSave = store.saveSent.bind(a.store);
    store.saveSent = r => {
      realSave(r);
      const tx = r.entries.flatMap(e => e.txs).find(x => x.call);
      if (tx) taker = tx.hash;
      if (tx && point === 'signed' && tx.state === 'signed') take();
      if (tx && point === 'promoted' && tx.state === undefined) take();
    };
    a.checkpoint = async (next, now) => { a.store.save(next, now); if (point === 'journal' && taker && next.budget?.pending?.some(x => x.hash === taker)) take(); };
    await a.tick(127n, { buyersP: 10n ** 16n, tip: 1n });
    a.close();
    expect(copy, `crash point ${point}`).toBeDefined();
    t.m.pool = pool ?? new Map();
    t.m.attempts = t.m.attempts.filter(r => [...t.m.pool.values()].includes(r) || r === loser);
    const b = proc(t, copy as string);
    await b.tick(130n, false);
    t.mine();
    const out = await b.tick(133n, false);
    expect(t.m.mined.size).toBe(1);
    expect(out.state.budget?.pending ?? []).toEqual([]);
    expect(out.state.budget?.totalWei).toBe(1n);
    expect(savedHashes(copy as string).size).toBe(0);
    expectOneCallPerNonce(t, new Set([7]));
    b.close();
  });

  it('a stage A entry in flight at the upgrade is never replaced, only sent again, and can lose its nonce under rule A', async () => {
    const t = model(), dir = tmp();
    t.m.respectBase = true;
    t.f.node.block.baseFeePerGas = 100_000_000n;
    let a = proc(t, dir);
    await a.tick(100n, { fit: 5n });
    a.close();
    // The record as stage A wrote it: reservations without `v` (and without counters).
    const file = join(dir, 'keeper.json.sent');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/,"counter":"[^"]*"|,"ours":"[^"]*"|,"v":2/g, ''));
    a = proc(t, dir);
    t.f.node.block.baseFeePerGas = GWEI;
    for (let block = 103n; block <= 124n; block += 3n) { await a.tick(block, false); t.mine(); }
    expect(byNonce(t).get(7)).toHaveLength(1);
    const took = await a.tick(127n, { buyersP: 10n ** 16n, tip: 1n });
    expect(took.report.sent.map(s => s.job)).toEqual(['collect']);
    expect(byNonce(t).get(7)).toHaveLength(2);
    t.mine();
    const out = await a.tick(130n, false);
    expect(out.state.budget?.pending ?? []).toEqual([]);
    expect(t.m.mined.size).toBe(1);
    a.close();
  });

  it('guarantees 2 and 4: only the highest-fee transaction is sent again; at most one takeover per nonce per hanging period', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    await a.tick(100n, { fit: 5n });
    const loser = t.m.pool.get(7) as Hex;
    for (let block = 103n; block <= 124n; block += 3n) await a.tick(block, false);
    await a.tick(127n, { buyersP: 10n ** 16n, tip: 1n });
    const taker = t.m.pool.get(7) as Hex;
    // The node evicts nonce 7; another job is due every round but may not take the nonce again within the period.
    t.m.pool.delete(7);
    const from = t.m.attempts.length;
    for (let block = 130n; block <= 151n; block += 3n) await a.tick(block, { platform: 6n });
    expect(byNonce(t).get(7)).toEqual([loser, taker]);
    await a.tick(154n, { platform: 6n });
    const again = t.m.attempts.slice(from).filter(r => parseTransaction(r).nonce === 7);
    // Sent again from the highest-fee bytes only (never the loser's), and a second takeover only after the period.
    expect(again.includes(loser)).toBe(false);
    expect(again.includes(taker)).toBe(true);
    const list = byNonce(t).get(7) as Hex[];
    expect(list.length).toBeLessThanOrEqual(3);
    if (list.length === 3) expect(fee(list[2] as Hex) >= bump(fee(taker))).toBe(true);
    a.close();
  });

  it('re-check note 1: receipts stop once the takeover landed; one of ours found in a final block wins; the start is released and runs again once', async () => {
    const t = model(), dir = tmp();
    t.m.respectBase = true;
    t.f.node.block.baseFeePerGas = 100_000_000n;
    t.setFunded(false);
    const a = proc(t, dir);
    const urgent = urgentPost(t, 130n);
    urgent.wire(a.chain);
    await a.tick(100n);
    const start = a.state.incomeSpend?.find(s => s.start)?.hash as string;
    t.f.node.block.baseFeePerGas = 500_000_000n;
    for (let block = 103n; block <= 130n; block += 3n) { await a.tick(block, false); t.mine(); }
    const post = t.m.attempts.find(r => parseTransaction(r).to?.toLowerCase() === urgent.source) as Hex;
    expect(t.m.mined.has(hashOf(post))).toBe(true);
    // From here the endpoint serves no receipt at all (counts and block bodies it still serves).
    t.f.node.receipt = () => null;
    let state: KeeperState = a.state;
    for (let block = 133n; block <= 187n; block += 3n) state = (await a.tick(block, false)).state;
    expect(record(dir).released?.[start]).toBeDefined();
    expect(savedHashes(dir).get(hashOf(post))).toBeUndefined();
    // The post's own charge stays unsettled (no receipt to settle it with); nothing else was released or settled.
    expect(state.budget?.pending?.some(r => r.hash === hashOf(post))).toBe(true);
    expect(Object.keys(record(dir).released ?? {})).toEqual([start]);
    const runs: string[] = [];
    for (let block = 190n; block <= 196n; block += 3n) {
      const out = await a.tick(block, block === 190n ? { buyersP: 10n ** 16n, tip: 10n ** 17n } : false);
      runs.push(...out.report.sent.map(s => s.job));
      expect(out.report.skipped.some(s => s.why === 'in flight')).toBe(false);
    }
    expect(runs.filter(j => j === 'collect')).toHaveLength(1);
    a.close();
  });

  it('re-check note 1: with no receipts and no history, the in-flight skip ends once the count passed the nonce at a final block; nothing is released', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    await a.tick(100n, { fit: 5n });
    const loser = t.m.pool.get(7) as Hex;
    for (let block = 103n; block <= 124n; block += 3n) await a.tick(block, false);
    await a.tick(127n, { buyersP: 10n ** 16n, tip: 1n });
    const taker = t.m.pool.get(7) as Hex;
    t.mine();
    // The endpoint now serves neither receipts nor old blocks: the outcome can never be proven.
    t.f.node.receipt = () => null;
    t.f.node.blockTxs = () => [];
    const first = await a.tick(130n, { fit: 5n });
    expect(first.report.skipped.some(s => s.why === 'in flight')).toBe(false);
    expect(first.report.sent.map(s => s.job)).toEqual(['receiverPayFit']);
    let state: KeeperState = first.state;
    for (let block = 133n; block <= 160n; block += 3n) state = (await a.tick(block, false)).state;
    // Ran once; the contested nonce stays charged on both sides (no proof), nothing released.
    expect(new Set(t.m.attempts.filter(r => parseTransaction(r).nonce === 8))).toHaveProperty('size', 1);
    expect(record(dir).released ?? {}).toEqual({});
    expect(state.budget?.pending?.map(r => r.hash)).toEqual(expect.arrayContaining([hashOf(loser), hashOf(taker)]));
    a.close();
  });
});
