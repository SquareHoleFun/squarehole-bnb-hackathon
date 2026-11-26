/** The live curve's waits use the logo loader (F51): connecting, and the live service catching up. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CurvePanel } from './CurvePanel';
import { liveDataFromDirect } from './direct-source';
import { DEMO_FIT_TARGET, type FitMarketTarget } from './fit-target';
import { CATCHING_UP_REASON, type LiveView } from './live-controller';

afterEach(cleanup);

const T: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', rpcUrl: 'http://127.0.0.1:8599', indexerOrigin: 'http://127.0.0.1:8598' };
const BLOCK = DEMO_FIT_TARGET.openBlock + 60n;

const DATA = liveDataFromDirect(
  {
    block: { number: BLOCK, hash: `0x${'12'.repeat(32)}`, timestamp: 1_790_726_400n },
    safeBlock: null,
    finalizedBlock: null,
    sqrtPriceX96: T.curve.sqrtPriceUpperX96,
    tick: T.curve.tickUpper,
    phase: 'curve',
    completedBlock: null,
    migratedBlock: null,
    liquidityOpensAtBlock: null,
    openBlock: T.openBlock,
    totalSupplyRaw: 10n ** 27n,
  },
  T,
);

const CONNECTING: LiveView = { freshness: 'connecting', source: null, data: null, staleSinceBlock: null, reason: null, reorg: null, transport: 'stream', checkedBlock: null, catchingUp: false };

const curve = () => screen.getByRole('region', { name: 'Bonding curve' });

describe('CurvePanel waits', () => {
  it('connecting: one card-size loader over one line; the chip beside it keeps its still clock', () => {
    render(<CurvePanel view={CONNECTING} target={T} />);
    const empty = curve().querySelector('.sh-fit-empty') as HTMLElement;
    expect(empty.getAttribute('aria-busy')).toBe('true');
    expect(empty.querySelector('.sh-loader')?.getAttribute('data-size')).toBe('card');
    expect(empty.querySelector('.sh-skeleton')).toBeNull();
    expect(empty.textContent).toBe('Connecting to the live curve…');
    // One wait, one loader: the chip does not animate a second mark next to the curve's.
    expect(curve().querySelectorAll('.sh-loader')).toHaveLength(1);
    const chip = curve().querySelector('.sh-fit-chip') as HTMLElement;
    expect(chip.querySelector('.sh-loader')).toBeNull();
    expect(chip.querySelector('.sh-glyph')?.getAttribute('aria-hidden')).toBe('true');
    // The chip's text stays the one word.
    expect(chip.textContent).toBe('Connecting');
  });

  it('catching up: the reason line is a wait (breathing mark), other reasons keep the alert', () => {
    const stale: LiveView = { ...CONNECTING, freshness: 'stale', source: 'stream', data: DATA, staleSinceBlock: BLOCK, reason: CATCHING_UP_REASON, catchingUp: true };
    const { rerender } = render(<CurvePanel view={stale} target={T} />);
    let reason = curve().querySelector('.sh-fit-reason') as HTMLElement;
    expect(reason.textContent).toBe('The live service is catching up with the chain.');
    expect(reason.hasAttribute('data-catching-up')).toBe(true);
    expect(reason.querySelector('.sh-loader')?.getAttribute('data-size')).toBe('button');
    expect(reason.querySelector('.sh-glyph')).toBeNull();

    rerender(<CurvePanel view={{ ...stale, reason: 'The live service reports stale data: no new block.', catchingUp: false }} target={T} />);
    reason = curve().querySelector('.sh-fit-reason') as HTMLElement;
    expect(reason.hasAttribute('data-catching-up')).toBe(false);
    expect(reason.querySelector('.sh-loader')).toBeNull();
    expect(reason.querySelector('.sh-glyph')).not.toBeNull();
  });
});
