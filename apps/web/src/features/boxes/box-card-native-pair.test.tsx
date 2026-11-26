import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_FIT_TARGET } from '../fit-pair/fit-target';
import type { BoxSummary } from './box-model';
import { launchRecord } from './box-sources';

/**
 * SH-258 (re-read finding 12): a feed card names its price coin after the ticker unless the coin is the chain's own.
 * Sepolia never showed "· ETH"; BNB Chain testnet (`SH_TESTNET=bnb`) shows no "· BNB". Other coins keep their name.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function pairOn(bnb: boolean, pairAsset: string, q?: string): Promise<string | null> {
  if (bnb) vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  const { BoxCard } = await import('./BoxCard');
  const summary: BoxSummary = { record: { ...launchRecord(DEMO_FIT_TARGET), pairAsset, ...(q ? { v2Chain: { snapshot: { record: { q } } } } : {}) } as BoxSummary['record'], state: 'bonding', figure: { text: '30.5%', barBps: 3050 }, mcapRaw: null, progressBps: 3050, volumeRaw: null, notice: null };
  const view = render(<MemoryRouter><ul><BoxCard summary={summary} to="/box/x" /></ul></MemoryRouter>);
  const pair = view.container.querySelector('.sh-box-card__pair')?.textContent ?? null;
  cleanup();
  return pair;
}

describe('the feed card\'s pair name', () => {
  it('BNB Chain testnet: no "· BNB" for the native coin (zero address); a token whose symbol is BNB or ETH keeps it', async () => {
    expect(await pairOn(true, 'BNB', '0x0000000000000000000000000000000000000000')).toBeNull();
    expect(await pairOn(true, 'BNB', '0x00000000000000000000000000000000000000b1')).toBe(' · BNB');
    expect(await pairOn(true, 'ETH', '0x00000000000000000000000000000000000000b1')).toBe(' · ETH');
    expect(await pairOn(true, 'tUSDC', '0x00000000000000000000000000000000000000c1')).toBe(' · tUSDC');
  });

  it('Sepolia, as before: no "· ETH"; another coin keeps its name', async () => {
    expect(await pairOn(false, 'ETH', '0x0000000000000000000000000000000000000000')).toBeNull();
    expect(await pairOn(false, 'tUSDC', '0x00000000000000000000000000000000000000c1')).toBe(' · tUSDC');
  });
});
