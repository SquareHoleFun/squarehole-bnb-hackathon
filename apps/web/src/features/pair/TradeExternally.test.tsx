import { DRAFT_FEE_TERMS, type ExternalDestination, type ExternalLinkProvider, type PairRecord } from '@squarehole/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePair } from '../../test-support/fixture';
import { TradeExternally } from './TradeExternally';

afterEach(cleanup);

const SEPOLIA = 11155111;
const base = fixturePair('ROUND TRIP');
/** ROUND TRIP's identity moved to Sepolia, for render-boundary tests only (no such pair exists). */
const pair: PairRecord = {
  ...base,
  pairId: `${SEPOLIA}:0x0000000000000000000000000000000000000067`,
  chainId: SEPOLIA,
  token: { ...base.token, chainId: SEPOLIA },
  quote: { ...base.quote, chainId: SEPOLIA },
};
const venue = `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=${pair.quote.address}&outputCurrency=${pair.token.address}`;

function linksReturning(destinations: ExternalDestination[]): ExternalLinkProvider {
  return { destinations: () => destinations };
}

const available = (overrides: Partial<ExternalDestination> = {}): ExternalDestination => ({
  kind: 'execution',
  provider: 'Uniswap web app',
  state: 'available',
  href: venue,
  chainId: SEPOLIA,
  assetAddress: pair.token.address,
  validatedAt: '2026-09-26T00:00:00Z',
  ...overrides,
});

function renderCard(destinations: ExternalDestination[]) {
  render(<TradeExternally pair={pair} links={linksReturning(destinations)} feeTerms={DRAFT_FEE_TERMS} nftNotice={false} />);
  return screen.getByRole('list', { name: 'External destinations' });
}

describe('TradeExternally render boundary (EXT-02, EXT-03, EXT-04)', () => {
  it('an available, allowlisted, identity-matching destination opens in a new tab without opener or referrer', () => {
    const list = renderCard([available()]);
    const link = within(list).getByRole('link', { name: /^Open Uniswap web app/ });
    expect(link.getAttribute('href')).toBe(venue);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('opens app.uniswap.org in a new tab');
    expect(list.textContent).toContain('Route verified');
  });

  it.each<[string, Partial<ExternalDestination>]>([
    ['a lookalike origin', { href: 'https://app.uniswap.org.evil.example/swap' }],
    ['a javascript URL', { href: 'javascript:alert(1)' }],
    ['a wallet-connect parameter', { href: `${venue}&connect=1` }],
    ['another chain', { chainId: 1 }],
    ['another asset', { assetAddress: pair.quote.address }],
    ['an explorer origin posing as a venue', { href: `https://sepolia.etherscan.io/token/${pair.token.address}` }],
  ])('%s never becomes a link', (_label, overrides) => {
    const list = renderCard([available(overrides)]);
    expect(within(list).queryByRole('link')).toBeNull();
    expect(list.textContent).toContain('Route unverified');
  });

  it('never renders the NFT notice for tokens and always shows the exact identity to copy', () => {
    renderCard([]);
    expect(screen.queryByText('Before you trade externally')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy ROUND (T) address' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy WETH-DEMO (Q) address' })).toBeTruthy();
    expect(screen.getByText(/Chain 11155111/)).toBeTruthy();
  });
});
