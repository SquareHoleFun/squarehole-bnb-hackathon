import { UNISWAP_TESTNET_MODE_WARNING } from '@squarehole/links';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { liveDataFromDirect } from './direct-source';
import { FitContracts } from './FitContracts';
import { phaseText } from './FitParts';
import { DEMO_FIT_TARGET, graduationBandSqrtX96, type FitMarketTarget } from './fit-target';
import type { Freshness } from './live-controller';
import type { LiveData } from './live-model';
import { executionGate, MarketLinks } from './MarketLinks';
import { LAUNCH_HINTS, type FitMarketNames } from './market-names';
import { visibleText } from './test-support/visible-text';

const NEUTRAL: FitMarketNames = {
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

afterEach(cleanup);

const T: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', rpcUrl: 'http://127.0.0.1:8599' };
const HASH = `0x${'12'.repeat(32)}` as const;
const BAND = graduationBandSqrtX96(T.curve);

function at(block: bigint, options: { phase?: 'curve' | 'completed' | 'migrated'; completedBlock?: bigint | null; sqrtPriceX96?: bigint } = {}): LiveData {
  return liveDataFromDirect(
    {
      block: { number: block, hash: HASH, timestamp: 1_790_726_400n },
      safeBlock: null,
      finalizedBlock: null,
      sqrtPriceX96: options.sqrtPriceX96 ?? T.curve.sqrtPriceUpperX96,
      tick: T.curve.tickUpper,
      phase: options.phase ?? 'curve',
      completedBlock: options.completedBlock ?? null,
      migratedBlock: null,
      liquidityOpensAtBlock: null,
      openBlock: T.openBlock,
      totalSupplyRaw: 10n ** 27n,
    },
    T,
  );
}

describe('the Uniswap gate (route-proof item 4)', () => {
  it('stays closed while the page cannot confirm the launch window has ended', () => {
    const closed = /^Closed until the page can confirm the launch window has ended \(block 21,000,331\)\. Uniswap routes open at block 21,000,332\.$/;
    expect(executionGate(null, T, 'connecting')).toMatch(closed);
    expect(executionGate(null, T, 'unavailable')).toMatch(closed);
    const past = at(T.closeBlock + 5n);
    // Data nobody could check says nothing about the window.
    expect(executionGate(past, T, 'unverified')).toMatch(closed);
    expect(executionGate(past, T, 'live')).toBeNull();
    expect(executionGate(past, T, 'direct')).toBeNull();
    // A stale head already past the window is still past it (blocks only move forward).
    expect(executionGate(past, T, 'stale')).toBeNull();
    expect(executionGate(at(T.openBlock + 3n), T, 'live')).toMatch(/^Closed during the launch window/);
    expect(executionGate(at(T.openBlock - 10n), T, 'stale')).toMatch(/^Closed: no route can buy before block/);
  });
});

describe('the completed phase (Terms 5.6 (f), 5.7 (a))', () => {
  it('names the price band graduation needs, and whether the newest block is inside it', () => {
    const inBand = phaseText(at(T.openBlock + 500n, { phase: 'completed', completedBlock: T.openBlock + 400n, sqrtPriceX96: BAND }), T);
    expect(inBand.label).toBe('Target reached');
    // The header shows one short line; the band rule is behind the curve's (i).
    expect(inBand.short).toBe('Graduation pending · anyone can trigger it');
    expect(inBand.detail).toContain('Target reached at block 21,000,700.');
    expect(inBand.detail).toContain('Anyone can trigger graduation from block 21,000,732, in any block where the price is within about 0.1% of the target.');
    expect(inBand.detail).toContain('At block 21,000,800 the price is within that band.');
    expect(inBand.detail).not.toMatch(/graduation now/);
    const outside = phaseText(at(T.openBlock + 500n, { phase: 'completed', completedBlock: T.openBlock + 400n, sqrtPriceX96: BAND + 1n }), T);
    expect(outside.short).toBe('Graduation pending · price outside the band');
    expect(outside.detail).toContain('At block 21,000,800 the price is outside that band, so graduation waits until it is back inside.');
    const early = phaseText(at(T.openBlock + 410n, { phase: 'completed', completedBlock: T.openBlock + 400n, sqrtPriceX96: BAND }), T);
    expect(early.short).toBe('Graduation pending · possible in 22 blocks');
    expect(early.detail).toContain('Anyone can trigger graduation from block 21,000,732 (in 22 blocks), in any block where the price is within about 0.1% of the target.');
    expect(early.detail).not.toContain('At block');
  });
});

describe('the launch phases in one line (F33: the tax on the first screen whenever it applies)', () => {
  it('names the tax range before the open and the next block’s rate in the window; an open curve needs no line', () => {
    const before = phaseText(at(T.openBlock - 13n), T);
    expect(before).toMatchObject({ label: 'Not open yet', short: 'Opens in 13 blocks · launch tax 93.20% → 8.06% on buys' });
    const during = phaseText(at(T.openBlock + 9n), T);
    expect(during).toMatchObject({ label: 'Launch window', short: 'Launch tax 84.25% on buys · 22 blocks left' });
    expect(during.detail).toContain('The price shown is the pool’s, before that tax.');
    expect(phaseText(at(T.closeBlock + 1n), T)).toEqual({ label: 'Curve open', short: null, detail: null });
  });
});

/** A mainnet-shaped target: its explorer route is reviewed, so Etherscan is a live link and the other two are not. */
const MAINNET: FitMarketTarget = { ...T, chainId: 1, networkLabel: 'Ethereum' };

function renderLinks(data: LiveData | null, freshness: Freshness) {
  cleanup();
  render(<MarketLinks data={data} target={MAINNET} freshness={freshness} />);
  return screen.getByRole('region', { name: 'Open on' });
}

describe('Open on (links out)', () => {
  it('draws a tile only for a live link; the others are plain text with a small state', () => {
    const links = renderLinks(at(T.closeBlock + 5n), 'live');
    expect(within(links).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([`https://etherscan.io/token/${T.token}`]);
    expect(links.querySelectorAll('.sh-fit-link__off .sh-glyph, .sh-fit-link__off svg')).toHaveLength(0);
    expect(visibleText(links)).toBe('Open on Uniswap web app not checked DEX Screener not checked Etherscan etherscan.io');
    // Requirement ids are left out of the reasons; identical reasons are said once.
    const panel = links.querySelector('.sh-info-panel');
    expect(panel?.textContent).not.toMatch(/\(EXT-|\(B-DISC-/);
    expect(panel?.textContent).toContain('Uniswap web app, DEX Screener: Not verified: no recorded external transaction test for this route yet.');
  });

  it('says "not live yet" only while the launch window is known to keep Uniswap shut, "can’t confirm yet" when unknown', () => {
    const word = (data: LiveData | null, freshness: Freshness) => renderLinks(data, freshness).querySelector('[data-kind="execution"]')?.textContent;
    expect(word(at(T.openBlock + 3n), 'live')).toBe('Uniswap web app: not live yet');
    expect(word(at(T.openBlock - 10n), 'stale')).toBe('Uniswap web app: not live yet');
    const past = at(T.closeBlock + 5n);
    for (const freshness of ['unverified', 'unavailable', 'connecting'] as const) expect(word(freshness === 'unverified' ? past : null, freshness), freshness).toBe('Uniswap web app: can’t confirm yet');
    expect(word(past, 'stale')).toBe('Uniswap web app: not checked');
  });

  it('collapses to one muted line when nothing is a link', () => {
    cleanup();
    render(<MarketLinks data={at(T.closeBlock + 5n)} target={T} freshness="live" />);
    const links = screen.getByRole('region', { name: 'Open on' });
    expect(visibleText(links)).toBe('Open on No links on a local chain');
    expect(links.querySelector('.sh-fit-links__list')).toBeNull();
    expect(links.querySelectorAll('a')).toHaveLength(0);
    cleanup();
    render(<MarketLinks data={null} target={{ ...MAINNET, chainId: 11_155_111, networkLabel: 'Sepolia testnet' }} freshness="connecting" />);
    expect(visibleText(screen.getByRole('region', { name: 'Open on' }))).toMatch(/^Open on .*Etherscan/);
  });

  it('says the Sepolia Testnet-mode caveat exactly once: in the info panel while Uniswap is not a link', () => {
    const sepolia: FitMarketTarget = { ...T, chainId: 11_155_111, networkLabel: 'Sepolia testnet', names: NEUTRAL };
    cleanup();
    render(<MarketLinks data={at(T.closeBlock + 5n)} target={sepolia} freshness="live" />);
    const links = screen.getByRole('region', { name: 'Open on' });
    expect((links.textContent ?? '').split(UNISWAP_TESTNET_MODE_WARNING)).toHaveLength(2);
    expect(links.querySelector('.sh-info-panel')?.textContent).toContain(UNISWAP_TESTNET_MODE_WARNING);
    expect(visibleText(links)).toBe('Open on Uniswap web app not checked DEX Screener no link Etherscan (Sepolia) sepolia.etherscan.io');
    // A rehearsal's own words: the explorer link names its token, the panel says "This app" (not the brand).
    expect(within(links).getByRole('link').textContent).toContain('RHT2 on a block explorer');
    expect(links.textContent ?? '').not.toMatch(LAUNCH_HINTS);
    expect(links.textContent).toContain('This app has no trade form.');
  });
});

describe('a rehearsal’s names in the phase text', () => {
  it('names its token and collection after graduation, never the launch’s', () => {
    const migrated = liveDataFromDirect(
      {
        block: { number: T.closeBlock + 900n, hash: HASH, timestamp: 1_790_726_400n },
        safeBlock: null,
        finalizedBlock: null,
        sqrtPriceX96: T.curve.sqrtPriceUpperX96,
        tick: T.curve.tickUpper,
        phase: 'migrated',
        completedBlock: T.closeBlock + 800n,
        migratedBlock: T.closeBlock + 850n,
        liquidityOpensAtBlock: T.closeBlock + 882n,
        openBlock: T.openBlock,
        totalSupplyRaw: 10n ** 27n,
      },
      T,
    );
    const neutral = phaseText(migrated, { ...T, names: NEUTRAL });
    expect(neutral.detail).toContain('the rest of the RHT2 now sit in the same pool');
    expect(neutral.detail).toContain('the Rehearsal Collection vault is open');
    expect(`${neutral.label} ${neutral.short ?? ''} ${neutral.detail ?? ''}`).not.toMatch(LAUNCH_HINTS);
    expect(phaseText(migrated, T).detail).toContain('the rest of the FIT now sit in the same pool');
  });
});

describe('All contract addresses', () => {
  it('keeps its heading outside the disclosure, marks it with a chevron, and copies the pool id as an id', () => {
    render(<FitContracts target={DEMO_FIT_TARGET} />);
    const heading = screen.getByRole('heading', { level: 2, name: 'All contract addresses' });
    expect(heading.closest('summary')).toBeNull();
    expect(heading.closest('details')).toBeNull();
    const summary = document.querySelector('.sh-fit-contracts summary');
    expect(summary?.textContent).toBe('Show all contract addresses');
    expect(visibleText(summary as Element)).toBe('Show all');
    expect(summary?.querySelector('.sh-fit-details__chevron')).not.toBeNull();
    expect(summary?.closest('details')?.open).toBe(false);
    const region = screen.getByRole('region', { name: 'All contract addresses' });
    expect(within(region).getByRole('button', { name: 'Copy the pool id', hidden: true })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Copy the FIT token address', hidden: true })).toBeTruthy();
    expect(within(region).queryAllByRole('button', { name: /pool id.*address/i, hidden: true })).toEqual([]);
  });

  it('states a neutral market’s curve target from its own curve, never a fixed figure', () => {
    const curve = { ...DEMO_FIT_TARGET.curve, raiseWei: 5_123_456_789_000_000_000n, targetWei: 5_123_456_789_000_000_000n };
    const target: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', label: 'A rehearsal', names: NEUTRAL, curve };
    render(<FitContracts target={target} />);
    const note = document.querySelector('.sh-fit-contracts__note')?.textContent ?? '';
    expect(note).toContain('the launch curve, which raises exactly the 5.123456789 ETH target');
    expect(note).not.toContain('4.206980085');
    cleanup();
    render(<FitContracts target={{ ...target, curve: DEMO_FIT_TARGET.curve }} />);
    expect(document.querySelector('.sh-fit-contracts__note')?.textContent).toContain('which raises exactly the 4.206980085 ETH target');
  });
});
