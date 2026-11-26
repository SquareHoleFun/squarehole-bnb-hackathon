import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { TERMS_SECTIONS } from '../legal/terms';
import { appCopyFraming, renderedCopy } from '../legal/wording';
import { liveDataFromDirect } from './direct-source';
import { FeeDisclosure, feeLine } from './FeeDisclosure';
import { DEMO_FIT_TARGET, type FitMarketTarget } from './fit-target';
import type { LiveData } from './live-model';
import { LAUNCH_HINTS, type FitMarketNames } from './market-names';
import { visibleText } from './test-support/visible-text';

afterEach(cleanup);

/** Terms 5.7 (e) as the Terms page shows it, cut into sentences: read from terms.ts, never from a copy. */
function outsideLiquidityTerms(): string[] {
  const text = TERMS_SECTIONS.find((section) => section.n === '5')
    ?.clauses.find((clause) => clause.n === '5.7')
    ?.items?.find((item) => item.text.startsWith('(e)'))?.text;
  if (!text) throw new Error('Terms 5.7 (e) not found');
  const body = text.replace(/^\(e\) \*\*Outside liquidity\.\*\*\s*/, '').replace(/\s*\[COUNSEL:[^\]]*\]\s*$/, '');
  return body.split(/(?<=\.)\s+(?=[A-Z])/);
}
const T: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', rpcUrl: 'http://127.0.0.1:8599' };

/** Chain data at `block`, in the given phase (the Fees card reads the phase, the window and the head only). */
function at(block: bigint, phase: 'curve' | 'migrated' = 'curve'): LiveData {
  return liveDataFromDirect(
    {
      block: { number: block, hash: `0x${'12'.repeat(32)}`, timestamp: 1_790_726_400n },
      safeBlock: null,
      finalizedBlock: null,
      sqrtPriceX96: T.curve.sqrtPriceUpperX96,
      tick: T.curve.tickUpper,
      phase,
      completedBlock: phase === 'migrated' ? block - 40n : null,
      migratedBlock: phase === 'migrated' ? block - 8n : null,
      liquidityOpensAtBlock: phase === 'migrated' ? block + 24n : null,
      openBlock: T.openBlock,
      totalSupplyRaw: 10n ** 27n,
    },
    T,
  );
}

function renderFees(data: LiveData | null = null, names?: FitMarketNames, deployment: 'demo' | 'chain' = 'demo'): string {
  render(
    <MemoryRouter>
      <FeeDisclosure data={data} names={names} deployment={deployment} />
    </MemoryRouter>,
  );
  return (screen.getByRole('region', { name: 'Fees' }).textContent ?? '').replace(/\s+/g, ' ');
}

describe('the Fees card (C3, F33; F49 D3: no fee-share notice)', () => {
  it('a deployed pool whose hook still opens to outside liquidity says so in one factual line; the Demo and a closed pool say nothing', () => {
    const migrated = at(T.closeBlock + 500n, 'migrated');
    renderFees(migrated, undefined, 'chain');
    const fees = screen.getByRole('region', { name: 'Fees' });
    const line = fees.querySelector('.sh-fit-fees__outside');
    // The deployed hook (today's contracts, the Sepolia rehearsal) reports liquidityOpensAt(): the fact stays on the
    // page until the pool rebuild (D3) removes it, and the Terms say the same (5.7 (e)).
    expect(line?.textContent).toBe('This deployed pool accepts outside liquidity from block 21,000,856, which lowers the pool’s fee share (Terms 5.7 (e)).');
    expect(line?.hasAttribute('data-disclosure')).toBe(true);
    expect(fees.querySelector('a[href="/about/terms"]')).not.toBeNull();
    cleanup();
    // Already open: "since".
    const later = { ...migrated, head: { ...migrated.head, number: migrated.state.liquidityOpensAtBlock ?? 0n } };
    expect(renderFees(later, undefined, 'chain')).toContain('accepts outside liquidity since block 21,000,856');
    cleanup();
    // Before graduation the hook reports nothing (0 = none), the Demo follows D3, and a rebuilt pool reports nothing.
    for (const [data, deployment] of [
      [at(T.closeBlock + 3n), 'chain'],
      [migrated, 'demo'],
      [{ ...migrated, state: { ...migrated.state, liquidityOpensAtBlock: null } }, 'chain'],
    ] as const) {
      expect(renderFees(data, undefined, deployment)).not.toMatch(/outside liquidity|fee share/i);
      cleanup();
    }
  });

  it('shows one line and no disclosure: the pool is closed to outside liquidity for good (F49 D3)', () => {
    renderFees();
    const fees = screen.getByRole('region', { name: 'Fees' });
    expect(visibleText(fees)).toBe('Fees 1% pool fee');
    expect(fees.querySelector('details')).toBeNull();
    expect(fees.hasAttribute('data-emphasis')).toBe(false);
  });

  it('carries no reduced-fee-share text and no Terms 5.7 (e) sentence, before or after graduation', () => {
    const sentences = outsideLiquidityTerms();
    expect(sentences.length).toBeGreaterThan(0);
    for (const data of [null, at(T.closeBlock + 500n, 'migrated')]) {
      const text = renderFees(data);
      expect(text).not.toMatch(/fee share|outside liquidity|Terms of Use, section 5\.7/i);
      for (const sentence of sentences) expect(text, sentence).not.toContain(sentence);
      cleanup();
    }
  });

  it('adds the launch tax to the fee line before the open and during the window, never after it', () => {
    expect(feeLine(at(T.openBlock - 10n))).toBe('+ launch tax on buys until block 21,000,331');
    expect(feeLine(at(T.openBlock + 3n))).toBe('+ launch tax on buys until block 21,000,331');
    expect(feeLine(at(T.closeBlock + 3n))).toBeNull();
    expect(feeLine(null)).toBeNull();
  });

  it('states the launch tax from the router’s own table, never understated (F33: 93.20% → 8.06%)', () => {
    expect(LAUNCH_TAX_TABLE_PIPS).toHaveLength(32);
    const text = renderFees();
    expect(text).toContain('93.20% in its first block, falling to 8.06% in its last');
  });

  it('says what happens to the FIT part today before the planned stream (the Demo: F77; a deployed pool: its v2 code)', () => {
    const text = renderFees();
    const today = 'Of the FIT part, 13/15 is burned today';
    expect(text).toContain(today);
    expect(text).toContain('per-Misfit stream (Terms 5.10), which is not built yet; 2/15 goes into this pool.');
    expect(text.indexOf(today)).toBeLessThan(text.indexOf('per-Misfit stream (Terms 5.10)'));
    cleanup();
    const deployed = renderFees(null, undefined, 'chain');
    expect(deployed).toContain('all of the FIT part is burned today');
    expect(deployed).toContain('per-Misfit stream (Terms 5.10), which is not built yet.');
  });

  it('shows box 0’s F77 split on the Demo, from the version’s constants; a deployed pool keeps its own code’s split', () => {
    const demo = renderFees();
    expect(demo).toContain(
      'Of the ETH part, 11/15 buys FIT and burns it, 2/15 goes into this box’s pool and 2/15 to the platform. Of the FIT part,',
    );
    expect(demo).toContain('falling to 8.06% in its last (rounded up), into this box’s pool after graduation.');
    expect(demo).not.toMatch(/treasury/);
    cleanup();
    const deployed = renderFees(null, undefined, 'chain');
    expect(deployed).toContain('Of the ETH part, 2/15 (about 13%) goes to the treasury and 13/15 buys FIT and burns it');
    expect(deployed).toContain('(rounded up), to the treasury.');
  });

  it('follows the safe wording rule (F23)', () => {
    renderFees();
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
  });

  it('a rehearsal’s card uses its own names and names nothing of the launch', () => {
    const neutral: FitMarketNames = {
      kind: 'neutral',
      tokenName: 'Rehearsal Token 2',
      tokenSymbol: 'RHT2',
      collectionName: 'Rehearsal Collection',
      collectionSymbol: 'RHC',
      placeholderName: 'Rehearsal placeholder',
      placeholderSymbol: 'RHC-P',
      item: 'item',
      items: 'items',
    };
    // A rehearsal is a deployed pool (today's v2 code on Sepolia): it keeps its own code's split.
    const text = renderFees(null, neutral, 'chain');
    expect(text).not.toMatch(LAUNCH_HINTS);
    expect(text).toContain('in ETH on a buy, in RHT2 on a sell.');
    expect(text).toContain('13/15 buys RHT2 and burns it; all of the RHT2 part is burned today');
    expect(text).toContain('per-item stream (Terms 5.10)');
    expect(visibleText(screen.getByRole('region', { name: 'Fees' }))).toBe('Fees 1% pool fee');
    cleanup();
    const launch = renderFees();
    expect(launch).toContain('in ETH on a buy, in FIT on a sell.');
  });
});
