// @vitest-environment node
/**
 * SH-276 (addendum): a raise a price row sets on BNB Chain testnet (0.001854565578800516 BNB) broke the feed card's
 * line and the box page's stepper; there it is short now, and a raise that fits keeps every digit.
 */
import { describe, expect, it } from 'vitest';
import { raiseShownV2, statFiguresV2 } from './stats-v2';
import { raiseBarV2, raiseTextV2 } from './life-state';

const LONG = 1_854_565_578_800_516n;

describe('the raise on the card and the stepper', () => {
  it('a long raise is short; one that fits keeps every digit', () => {
    expect(raiseShownV2(LONG, 18)).toBe('0.001854');
    expect(raiseShownV2(420_698_008_500_000_000n, 18)).toBe('0.4206980085');
    expect(raiseShownV2(1_000_000n, 6)).toBe('1');
  });

  it('the card\'s raised line and the stepper\'s raise use it', () => {
    const stats = { raiseProgress: { raisedP: 654_600_000_000n, raiseP: LONG, progressBps: 3n }, pricePPerTX18: null, marketCapP: null, holderCount: 1n, burnedT: 0n, volume24hP: 0n, tradeCount: 1n } as never;
    expect(statFiguresV2(stats, 18).raised).toBe('0.0000006546 / 0.001854');
    expect(raiseTextV2({ record: { raise: LONG }, decimals: 18 } as never, 'BNB')).toBe('0.001854 BNB');
    const bar = raiseBarV2({ statistics: stats, decimals: 18, closedAt: 0n, record: { raise: LONG }, graduated: false } as never, 'BNB');
    expect(bar?.amount).toBe('0.0000006546 / 0.001854 BNB');
  });
});
