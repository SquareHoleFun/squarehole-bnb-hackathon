/**
 * The core card's and header's clock (open-at-clock-time.md): when a row's box is seen open (the first block at or after
 * its openAt; on mainnet a round time is met 11 s later), the next block's tax step and the window's progress, all
 * from the head's time, never from this browser's clock.
 */
import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';
import { describe, expect, it } from 'vitest';
import { opensAtBlockTime, slotGenesisOf, windowProgress, windowTaxPips } from './row-summary';

const SIX_PM = 1_791_309_600n; // 2026-10-06 18:00:00 UTC
const row = (chainId: number) => ({ chainId, openAt: SIX_PM, windowEndsAt: SIX_PM + 384n });

describe('when a row opens', () => {
  it('counts to the first block at or after openAt: mainnet 11 s later, Sepolia on the time, a local twin or the Demo the time itself', () => {
    expect(opensAtBlockTime(row(1), 'sepolia')).toBe(SIX_PM + 11n);
    expect(opensAtBlockTime(row(11_155_111), 'sepolia')).toBe(SIX_PM);
    expect(opensAtBlockTime({ chainId: 11_155_111, openAt: SIX_PM + 5n }, 'sepolia')).toBe(SIX_PM + 12n);
    // The local twin carries Sepolia's chain id but mines on demand: no slots.
    expect(slotGenesisOf(row(11_155_111), 'local')).toBeNull();
    expect(opensAtBlockTime({ chainId: 11_155_111, openAt: SIX_PM + 5n }, 'local')).toBe(SIX_PM + 5n);
    expect(slotGenesisOf(row(31_337), 'demo')).toBeNull();
    expect(slotGenesisOf(row(31_337), 'sepolia')).toBeNull();
  });
});

describe('the window from the head\'s time', () => {
  it('taxes the next block (head + 12 s) at its 12-second step; none before the open or after the end', () => {
    const r = row(11_155_111);
    expect(windowTaxPips(r, SIX_PM - 13n)).toBeNull();
    expect(windowTaxPips(r, SIX_PM - 12n)).toBe(LAUNCH_TAX_TABLE_PIPS[0]);
    expect(windowTaxPips(r, SIX_PM - 1n)).toBe(LAUNCH_TAX_TABLE_PIPS[0]);
    expect(windowTaxPips(r, SIX_PM)).toBe(LAUNCH_TAX_TABLE_PIPS[1]);
    expect(windowTaxPips(r, SIX_PM + 11n)).toBe(LAUNCH_TAX_TABLE_PIPS[1]);
    expect(windowTaxPips(r, SIX_PM + 360n)).toBe(LAUNCH_TAX_TABLE_PIPS[31]);
    expect(windowTaxPips(r, SIX_PM + 371n)).toBe(LAUNCH_TAX_TABLE_PIPS[31]);
    expect(windowTaxPips(r, SIX_PM + 372n)).toBeNull();
  });

  it('says how long is left and fills the bar by the head\'s step of 32 (its own block counted, as with blocks before)', () => {
    const r = row(11_155_111);
    expect(windowProgress(r, SIX_PM - 5n)).toEqual({ left: 389n, barBps: 0 });
    expect(windowProgress(r, SIX_PM)).toEqual({ left: 384n, barBps: 312 });
    expect(windowProgress(r, SIX_PM + 39n)).toEqual({ left: 345n, barBps: 1_250 });
    expect(windowProgress(r, SIX_PM + 380n)).toEqual({ left: 4n, barBps: 10_000 });
    expect(windowProgress(r, SIX_PM + 500n)).toEqual({ left: 0n, barBps: 10_000 });
  });
});
