import { describe, expect, it } from 'vitest';
import { FAILURES_SHOWN, figuresOf, floorOf, LIMIT_REASONS, MAX_APPROVALS, QUIET_REASONS, QUIET_RETRY_MS, quietFailure, sameTrade, withinLimit } from './one-press';
import { lineFor, TRADE_LINES, tradeLine } from './trade-words';

const ETHER = 10n ** 18n;
const whole = (output: bigint | null, amountIn = ETHER) => ({ amountIn, expectedInput: amountIn, expectedOutput: output });

describe('withinLimit: the plan made after the approval is still the trade the person saw (SH-ONE-PRESS-TRADE)', () => {
  it('the same figures, and better ones, are within any tolerance', () => {
    expect(withinLimit(whole(1000n), whole(1000n), 10n)).toBe(true);
    expect(withinLimit(whole(1000n), whole(1500n), 10n)).toBe(true);
  });

  it('a lower output is within the tolerance up to its edge, rounded never looser', () => {
    // 2%: 980 of 1000 is the edge; 979 is past it.
    expect(withinLimit(whole(1000n), whole(980n), 200n)).toBe(true);
    expect(withinLimit(whole(1000n), whole(979n), 200n)).toBe(false);
    // Raw figures above 2^53 compare exactly: the edge of 18-decimal amounts, one raw unit either side.
    const shown = 123_456_789_012_345_678_901n;
    const edge = shown * 9_800n / 10_000n + (shown * 9_800n % 10_000n === 0n ? 0n : 1n);
    expect(withinLimit(whole(shown), whole(edge), 200n)).toBe(true);
    expect(withinLimit(whole(shown), whole(edge - 1n), 200n)).toBe(false);
    // 10%, the founder's own setting: 9.0 of 10 is in, just under it is out.
    expect(withinLimit(whole(10n * ETHER), whole(9n * ETHER), 1_000n)).toBe(true);
    expect(withinLimit(whole(10n * ETHER), whole(9n * ETHER - 1n), 1_000n)).toBe(false);
  });

  it('a quote shown whole must still fill whole; a part fill shown may fill more at a rate within the tolerance', () => {
    expect(withinLimit(whole(1000n), { amountIn: ETHER, expectedInput: ETHER - 1n, expectedOutput: 1000n }, 2_000n)).toBe(false);
    const part = { amountIn: 3n * ETHER, expectedInput: ETHER, expectedOutput: 100n };
    expect(withinLimit(part, { amountIn: 3n * ETHER, expectedInput: 2n * ETHER, expectedOutput: 196n }, 200n)).toBe(true);
    expect(withinLimit(part, { amountIn: 3n * ETHER, expectedInput: 2n * ETHER, expectedOutput: 195n }, 200n)).toBe(false);
    // Filling less than shown is never the trade the person saw.
    expect(withinLimit(part, { amountIn: 3n * ETHER, expectedInput: ETHER / 2n, expectedOutput: 100n }, 2_000n)).toBe(false);
  });

  it('a window buy names no input: the whole amount on both sides', () => {
    const shown = { amountIn: ETHER, expectedInput: null, expectedOutput: 5_000n };
    expect(withinLimit(shown, { amountIn: ETHER, expectedInput: null, expectedOutput: 4_900n }, 200n)).toBe(true);
    expect(withinLimit(shown, { amountIn: ETHER, expectedInput: null, expectedOutput: 4_899n }, 200n)).toBe(false);
  });

  it('never without both figures, for another amount, a zero output or a tolerance out of range', () => {
    expect(withinLimit(whole(null), whole(1000n), 2_000n)).toBe(false);
    expect(withinLimit(whole(1000n), whole(null), 2_000n)).toBe(false);
    expect(withinLimit(whole(1000n), whole(1000n, 2n * ETHER), 2_000n)).toBe(false);
    expect(withinLimit(whole(0n), whole(0n), 2_000n)).toBe(false);
    expect(withinLimit(whole(1000n), whole(1000n), -1n)).toBe(false);
    expect(withinLimit(whole(1000n), whole(1000n), 10_000n)).toBe(false);
  });

  it('a press sends at most two approvals before its trade: a reset, then the exact amount', () => {
    expect(MAX_APPROVALS).toBe(2);
  });
});

describe('a quote that fails for a moment is asked for again quietly (item 2)', () => {
  it('a read the RPC did not answer is kept quiet once; the second failure in a row is said', () => {
    expect(QUIET_RETRY_MS).toBe(2_000);
    expect(FAILURES_SHOWN).toBe(2);
    for (const reason of ['rpc_failed', 'read_or_simulation_failed', 'block_unavailable', 'invalid_block', 'pool_simulation_mismatch', 'router_simulation_mismatch']) {
      expect(quietFailure(reason, 1), reason).toBe(true);
      expect(quietFailure(reason, 2), reason).toBe(false);
    }
  });

  it('a refusal that is the chain’s answer is said at once', () => {
    for (const reason of ['balance_low', 'insufficient_balance', 'curve_closed', 'price_limit_unavailable', 'earlier_send', 'amount_too_small']) {
      expect(QUIET_REASONS.has(reason), reason).toBe(false);
      expect(quietFailure(reason, 1), reason).toBe(false);
    }
  });
});

describe('the lines of a price past the person’s limit name their tolerance and what to do', () => {
  it('a mined trade past its price limit, a window buy below its minimum, a press stopped after its approval', () => {
    expect(lineFor('price_limit_already_exceeded', 200n)).toBe('Price moved over your 2% tolerance. Raise it or trade less.');
    expect(lineFor('insufficient_output', 15n)).toBe('Price moved over your 0.15% tolerance. Raise it or trade less.');
    expect(lineFor('price_moved', 1_000n)).toBe('Price moved over your 10% tolerance. Check the new quote.');
    // One short line at every tolerance the box takes: 59 characters at the default 2%, 63 at the widest figure (19.99%).
    expect(lineFor('price_limit_already_exceeded', 200n)).toHaveLength(59);
    for (const bps of [10n, 15n, 200n, 1_999n, 2_000n]) for (const reason of ['price_limit_already_exceeded', 'price_moved']) expect(lineFor(reason, bps).length).toBeLessThanOrEqual(63);
  });

  it('without a tolerance, and for every other reason, the plain line', () => {
    expect(lineFor('price_moved', null)).toBe(TRADE_LINES.price_moved);
    expect(lineFor('balance_low', 200n)).toBe(tradeLine('balance_low'));
    expect(lineFor('toString', 200n)).toBe('Not possible right now.');
  });

  it('a failed quote no longer blames the balance (the founder’s "could not simulate this trade")', () => {
    expect(tradeLine('read_or_simulation_failed')).toBe('Could not get a quote. Try again.');
    expect(tradeLine('rpc_failed')).toBe('The chain could not be read. Try again.');
  });
});

describe('af1: the same trade, its own figures and its bounds', () => {
  const HELPER = '0x0000000000000000000000000000000000000040';
  const ROUTER = '0x0000000000000000000000000000000000000030';
  const COIN = '0x0000000000000000000000000000000000000060';
  const box = (patch: Record<string, unknown> = {}) => ({ side: 'buy', phase: 3, coordinator: '0x0000000000000000000000000000000000000010', p: COIN,
    token: '0xf000000000000000000000000000000000000020', router: ROUTER, deployment: { poolSwapTest: HELPER }, amountIn: ETHER, expectedInput: ETHER,
    expectedOutput: 5n, priceLimitX96: 7n, minimumOutput: null, ...patch }) as never;
  const pair = (patch: Record<string, unknown> = {}) => ({ kind: 'pair', deployment: { poolSwapTest: HELPER }, revoke: { to: COIN, data: '0x', value: 0n },
    amountIn: ETHER, expectedInput: ETHER, expectedOutput: 5n, priceLimitX96: 9n, minimumOutput: null, ...patch }) as never;

  it('a box trade of the same box, phase, side, coin and spender is the same trade; a window that ended is not', () => {
    expect(sameTrade(box(), box({ expectedOutput: 4n }))).toBe(true);
    // The window buy pays the launch router; the same buy after the window pays PoolSwapTest.
    expect(sameTrade(box({ phase: 2 }), box())).toBe(false);
    expect(sameTrade(box(), box({ side: 'sell' }))).toBe(false);
    expect(sameTrade(box(), box({ coordinator: '0x0000000000000000000000000000000000000011' }))).toBe(false);
    expect(sameTrade(box(), pair())).toBe(false);
    expect(sameTrade(pair(), pair())).toBe(true);
    expect(sameTrade(pair(), pair({ revoke: { to: '0x0000000000000000000000000000000000000061', data: '0x', value: 0n } }))).toBe(false);
    expect(sameTrade(pair(), pair({ kind: 'faucet', revoke: null }))).toBe(false);
  });

  it('a plan\'s figures use its own amount (the typed one only when it names none); its bounds are its own', () => {
    expect(figuresOf(box({ amountIn: 3n }), ETHER).amountIn).toBe(3n);
    expect(figuresOf(pair({ amountIn: null }), 2n).amountIn).toBe(2n);
    // Another amount than the shown one is never within the limit.
    expect(withinLimit(figuresOf(box(), ETHER), figuresOf(box({ amountIn: 2n * ETHER }), ETHER), 2_000n)).toBe(false);
    expect(floorOf(box())).toEqual({ sqrtPriceLimitX96: 7n, minimumOutput: null });
    expect(floorOf(box({ priceLimitX96: null, minimumOutput: 11n }))).toEqual({ sqrtPriceLimitX96: null, minimumOutput: 11n });
    expect([...LIMIT_REASONS].sort()).toEqual(['insufficient_output', 'price_limit_already_exceeded']);
  });
});
