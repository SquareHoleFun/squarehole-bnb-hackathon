import {
  BOX0_FEE_SHARE_FIT,
  BOX0_FEE_SHARE_PLATFORM,
  BOX0_FEE_SHARE_T_BURN,
  FEE_SHARE_DENOMINATOR,
  FEE_SHARE_DEPTH,
} from '@squarehole/box-spec';
import { toJson } from '@squarehole/indexer/client';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { launchRecord } from '../boxes/box-sources';
import { appCopyFraming, renderedCopy } from '../legal/wording';
import { box0FeeWhere, box0SetupLine, demoPoolFigures, POOL_STEPS_LINE, v2SetupLine } from './box0-fees';
import { demoChainFor } from './demo-chain';
import { liveDataFromDirect } from './direct-source';
import { DEMO_FIT_TARGET, FIT_ISSUANCE_RAW, type FitMarketTarget } from './fit-target';
import { parseLiveEvent, type LiveData } from './live-model';
import { PoolCard } from './PoolCard';
import { visibleText } from './test-support/visible-text';

afterEach(cleanup);

const CHAIN: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', rpcUrl: 'http://127.0.0.1:8599' };

/** A Demo frame as the page reads it: the Demo chain's snapshot through the live service's parser. */
function demoData(scenario: 'window' | 'curve' | 'migrated'): LiveData {
  const event = parseLiveEvent('snapshot', toJson(demoChainFor(DEMO_FIT_TARGET, scenario).snapshot(0)), DEMO_FIT_TARGET);
  if (event.type !== 'snapshot') throw new Error('not a snapshot');
  return event.data;
}

describe('box 0’s fees after F77 (the Misfits like all the others)', () => {
  it('derives every share from the version’s constants: 11 + 2 + 2 and 13 + 2 fifteenths', () => {
    expect([BOX0_FEE_SHARE_FIT, FEE_SHARE_DEPTH, BOX0_FEE_SHARE_PLATFORM, BOX0_FEE_SHARE_T_BURN]).toEqual([11n, 2n, 2n, 13n]);
    expect(BOX0_FEE_SHARE_FIT + FEE_SHARE_DEPTH + BOX0_FEE_SHARE_PLATFORM).toBe(FEE_SHARE_DENOMINATOR);
    expect(box0SetupLine('FIT')).toBe(
      'Pool fee 1%: 11/15 burns FIT · 2/15 into this pool · 2/15 platform. Sellers’ FIT: 13/15 burned or to the per-Misfit stream · 2/15 into this pool.',
    );
    expect(box0FeeWhere('FIT', 'Misfit')).toContain('2/15 goes into this box’s pool and 2/15 to the platform. Of the FIT part,');
    // F160, F209 (SH-245): neither line names a cap on the platform's share.
    expect(`${box0SetupLine('FIT')} ${box0FeeWhere('FIT', 'Misfit')}`).not.toMatch(/\bcap\b|at most|a month|per 30 days/);
  });

  it('the Demo’s launch box shows the F77 split; a deployed market keeps its own v2 code’s split', () => {
    expect(launchRecord(DEMO_FIT_TARGET).setup).toBe(box0SetupLine('FIT'));
    const deployed = launchRecord(CHAIN).setup;
    expect(deployed).toBe(v2SetupLine('FIT'));
    expect(deployed).toBe('Pool fee 1%. Of the ETH part, 2/15 goes to the treasury and 13/15 buys FIT and burns it; the FIT part is burned.');
  });

  it('computes the Demo’s waiting amounts exactly: 2/15 of the fees paid on each side plus the launch tax, nothing added before a pair', () => {
    for (const scenario of ['window', 'curve', 'migrated'] as const) {
      const data = demoData(scenario);
      const fees = data.state.feesWei ?? 0n;
      const feesToken = data.state.feesTokenRaw ?? 0n;
      const figures = demoPoolFigures(data);
      expect(figures, scenario).not.toBeNull();
      expect(figures?.waitingEth).toBe((fees / 15n) * 2n + (data.state.taxWei ?? 0n));
      expect(figures?.waitingToken).toBe((feesToken / 15n) * 2n);
      expect(figures?.addedEth).toBe(0n);
      expect(figures?.addedToken).toBe(0n);
    }
    expect(demoData('window').state.taxWei, 'fixture: window buys paid the tax').toBeGreaterThan(0n);
    expect(demoData('curve').state.feesTokenRaw, 'fixture: sellers paid fees').toBeGreaterThan(0n);
  });

  it('has no Demo figures for a direct chain read (no fee totals)', () => {
    const direct = liveDataFromDirect(
      {
        block: { number: CHAIN.openBlock + 100n, hash: `0x${'12'.repeat(32)}`, timestamp: 1_790_726_400n },
        safeBlock: null,
        finalizedBlock: null,
        sqrtPriceX96: CHAIN.curve.sqrtPriceUpperX96,
        tick: CHAIN.curve.tickUpper,
        phase: 'curve',
        completedBlock: null,
        migratedBlock: null,
        liquidityOpensAtBlock: null,
        openBlock: CHAIN.openBlock,
        totalSupplyRaw: FIT_ISSUANCE_RAW,
      },
      CHAIN,
    );
    expect(demoPoolFigures(direct)).toBeNull();
    expect(demoPoolFigures(null)).toBeNull();
  });

  it('the Pool card: numbers first, no Demo label (F130), one line behind the (i); not shown for a deployed pool', () => {
    const data = demoData('curve');
    render(<PoolCard data={data} target={DEMO_FIT_TARGET} />);
    const card = screen.getByRole('region', { name: 'Pool' });
    const figures = demoPoolFigures(data);
    expect(visibleText(card)).toMatch(/^Pool Added: 0 ETH \+ 0 FIT · Waiting: \d[\d.,]* ETH \+ \d[\d.,]*[KMB]? FIT$/);
    expect(figures?.waitingEth).toBeGreaterThan(0n);
    expect(card.textContent).toContain(POOL_STEPS_LINE);
    // F77/F76 with S5.M5 built: the launch tax is Q only, so deepen() swaps part of it into FIT in small capped steps
    // and pairs it (BC-142).
    expect(POOL_STEPS_LINE).toBe('Fees and the launch tax are added in small capped steps; part of the tax is swapped into FIT first.');
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
    cleanup();
    const { container } = render(<PoolCard data={data} target={CHAIN} />);
    expect(container.textContent).toBe('');
  });
});
