import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { IncomeCache, type ZeroedTokenIncome } from '../src/income-read';
import { TETH, TETH_CODE, incomeChain, pm, safe, type FloodKind } from './support/income-chain';

/**
 * SH-247 (finding N4): the income each box has paid is read inside that box's own budget. Rows that carry no box's
 * paid income, however many, change no box's income and no planned job; one box's failed reading changes no other box.
 * These tests use only the reader's public entry points, so they also run against the line's reader (the control).
 */
const parity = vi.hoisted(() => ({ entries: undefined as Record<string, unknown> | undefined }));
vi.mock('../src/income-parity-manifest', async importOriginal => {
  const real = await importOriginal<typeof import('../src/income-parity-manifest')>();
  return { ...real, get ethParityManifest() { return parity.entries ?? real.ethParityManifest; } };
});
beforeEach(() => {
  parity.entries = { [`11155111:${TETH.toLowerCase()}`]: { chainId: '11155111', token: TETH, decimals: '18',
    codeHash: keccak256(TETH_CODE), weiPerCoin: '1000000000000000000' } };
});
afterEach(() => { parity.entries = undefined; });

const kinds: readonly FloodKind[] = ['safe deposits', 'empty collections', 'zero transfers', 'zero claim burns'];

describe('P1/P4: rows that carry no box paid income change no box and no planned job', () => {
  it.each(kinds)('%s: more than 20,000 rows in one page leave every box income and every planned job as without them', async kind => {
    const quiet = incomeChain();
    const expected = await quiet.read();
    const planned = await quiet.tick();
    // Every paying box counts, so the comparison below covers native and token income alike.
    for (const x of [quiet.a, quiet.b, quiet.c, quiet.d]) expect(expected.boxes[x.receiver]?.shareWei).toBeGreaterThan(0n);
    expect(planned.sent.some(k => k.startsWith('buyBack') || k.startsWith('deepen'))).toBe(true);
    expect(planned.sent.some(k => k.startsWith('fail:'))).toBe(true);
    expect(planned.sent.some(k => k.startsWith('graduate:'))).toBe(true);

    const busy = incomeChain();
    busy.flood(kind);
    expect(busy.noise.reduce((n, x) => n + x.count, 0)).toBeGreaterThan(20_000);
    const zeroed: ZeroedTokenIncome[] = [];
    // A fresh read, then two rounds through one cache: equal every time.
    expect(await busy.read(undefined, zeroed)).toEqual(expected);
    const cache = new IncomeCache();
    expect(await busy.read(cache, zeroed)).toEqual(expected);
    expect(await busy.read(cache, zeroed)).toEqual(expected);
    expect(zeroed).toEqual([]);
    const flooded = await busy.tick();
    expect(flooded.sent).toEqual(planned.sent);
    expect(flooded.skipped).toEqual(planned.skipped);
    expect(flooded.income).toEqual(planned.income);
  }, shLimit(120_000));
});

describe('P2: one box whose reading fails changes no other box', () => {
  it.each(['token receipt read throws', 'native discovery past the tick\'s rows', 'token pin check throws'] as const)(
    '%s', async failure => {
      const f = incomeChain();
      const expected = await f.read();
      const planned = await f.tick();
      const victim = failure === 'native discovery past the tick\'s rows' ? f.a : f.c;
      if (failure === 'token receipt read throws') {
        const original = f.pub.getTransactionReceipt.getMockImplementation();
        if (!original) throw new Error('missing fixture receipts');
        f.pub.getTransactionReceipt.mockImplementation(async args => {
          if (f.logs.some(l => l.transactionHash === args.hash && l.address === f.c.receiver)) throw new Error('node down');
          return original(args);
        });
      } else if (failure === 'native discovery past the tick\'s rows') {
        // Real tips this box paid to other callers: its own rows, past the tick's 10,000 discovery rows.
        for (let i = 0; i < 10_001; i++) f.logs.push({ address: f.a.receiver, eventName: 'Collected', blockNumber: 60n,
          blockHash: `0x${(60).toString(16).padStart(64, '0')}`, transactionHash: `0x${(900_000 + i).toString(16).padStart(64, '0')}`,
          logIndex: 0, removed: false, args: { caller: f.d.receiver, tipTo: f.d.receiver, tip: 1n } });
      } else {
        const original = f.pub.getBytecode.getMockImplementation();
        if (!original) throw new Error('missing fixture code');
        let calls = 0;
        // The two tETH boxes read the pin in turn; only the first one sees other code.
        f.pub.getBytecode.mockImplementation(async args => (calls++ === 0 ? '0x6080' : original(args)));
      }
      const zeroed: ZeroedTokenIncome[] = [];
      const income = await f.read(undefined, zeroed);
      expect(income.boxes[victim.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
      expect(zeroed.map(z => z.receiver)).toEqual([victim.receiver]);
      for (const x of f.boxes) if (x !== victim) expect(income.boxes[x.receiver]).toEqual(expected.boxes[x.receiver]);
      expect(income.platformWei).toBe(expected.platformWei - (expected.boxes[victim.receiver]?.shareWei ?? 0n));
      // Planning: the snapshot stays available, so every other box's jobs are admitted as before.
      const after = await f.tick();
      // Candidate keys name the job, the version and the box id or one of the box's contracts.
      const mine = [victim.hook, victim.receiver, victim.coordinator].map(a => a.toLowerCase());
      const others = (keys: readonly string[]) => keys.filter(k => k.split(':')[2] !== String(victim.id)
        && !mine.some(a => k.toLowerCase().includes(a)));
      expect(others(after.sent)).toEqual(others(planned.sent));
      expect(after.skipped.every(k => !k.endsWith(':INCOME_UNAVAILABLE'))).toBe(true);
    }, shLimit(60_000));
});

describe('P2: an endpoint that keeps only recent logs and state, while it still serves headers', () => {
  it('degrades box by box: warm proofs keep counting, a cold read zeroes each box with its code, never the snapshot', async () => {
    const f = incomeChain({ final: 5_000n });
    // Payments in the window's first page, older than what the endpoint keeps.
    f.logs.splice(0);
    f.nativePaid(f.a, 10n ** 15n, 101n, 1_000n);
    f.nativeTip(f.a, 7n * 10n ** 12n, 102n, 1_000n);
    f.tokenPaid(f.c, 'PlatformPaid', 10n ** 18n, 301n, undefined, 1_000n);
    const cache = new IncomeCache();
    const full = await f.read(cache);
    expect(full.boxes[f.a.receiver]).toEqual({ shareWei: 10n ** 15n, tipsWei: 7n * 10n ** 12n });
    expect(full.boxes[f.c.receiver]?.shareWei).toBe(10n ** 18n);
    // The node now refuses logs, receipts and state below block 4,000; finality moves on.
    f.state.oldest = 4_000n;
    f.state.final += 2n;
    const warm = await f.read(cache);
    expect(warm.boxes).toEqual(full.boxes);
    expect(warm.valuationFailures ?? []).toEqual([]);
    // Cold: no box can prove anything; each counts zero with its own code and the snapshot is still there.
    const zeroed: ZeroedTokenIncome[] = [];
    const cold = await f.read(new IncomeCache(), zeroed);
    expect(cold.platformWei).toBe(0n);
    for (const x of f.boxes) expect(cold.boxes[x.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    expect(zeroed.map(z => z.receiver).sort()).toEqual(f.boxes.map(x => x.receiver).sort());
    expect(cold.valuationFailures?.length).toBe(f.boxes.length);
    // The runner keeps planning: reserved jobs are sent, income-capped jobs wait on each box's own cap.
    const out = await f.tick(new IncomeCache());
    expect(out.income).not.toBeNull();
    expect(out.sent.some(k => k.startsWith('fail:'))).toBe(true);
    expect(out.sent.some(k => k.startsWith('graduate:'))).toBe(true);
    expect(out.skipped.some(k => k.endsWith(':BOX_INCOME_CAP'))).toBe(true);
    expect(out.skipped.every(k => !k.endsWith(':INCOME_UNAVAILABLE'))).toBe(true);
  }, shLimit(60_000));
});

describe('P1 inputs stay unread', () => {
  it('reads no Safe, coin or PoolManager range, and only the paying boxes\' own receipts', async () => {
    const f = incomeChain();
    for (const kind of kinds) f.flood(kind, 100);
    await f.read();
    const ranges = f.pub.getLogs.mock.calls.flatMap(([c]) => Array.isArray(c.address) ? c.address : [c.address]).map(a => a.toLowerCase());
    for (const open of [TETH, safe, pm]) expect(ranges).not.toContain(open.toLowerCase());
    const paying = new Set(f.logs.filter(l => l.eventName === 'PlatformPaid' || (l.eventName === 'Collected' && l.address === f.c.receiver))
      .map(l => l.transactionHash));
    expect(new Set(f.pub.getTransactionReceipt.mock.calls.map(([c]) => c.hash))).toEqual(paying);
  });
});
