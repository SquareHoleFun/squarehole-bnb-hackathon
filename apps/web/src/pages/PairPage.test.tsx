import type { FeedProvider, PairDetail, PairId } from '@squarehole/domain';
import { createMockFeedProvider } from '@squarehole/providers';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../app-providers';
import type { FeedSourceFor } from '../features/feed/feed-sources';
import { AppRoutes } from '../routes';
import { LEGACY_PAGES } from '../test-support/legacy-pages';
import { FIXTURE_PAIRS } from '../test-support/fixture';

const ORCHARD = '0x0000000000000000000000000000000000000066';
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAt(path: string, feedSources?: FeedSourceFor) {
  return render(
    <AppProviders feedSources={feedSources}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes legacyPages={LEGACY_PAGES} />
      </MemoryRouter>
    </AppProviders>,
  );
}

async function openPair(suffix: string, query = '') {
  const view = renderAt(`/pair/31337/0x${suffix.padStart(40, '0')}${query}`);
  const pair = FIXTURE_PAIRS.find((p) => p.pairId.endsWith(suffix.padStart(40, '0')));
  await screen.findByRole('heading', { level: 1, name: pair?.name ?? '' });
  return view;
}

const main = () => screen.getByRole('main');
const region = (name: string) => screen.getByRole('region', { name });

describe('pair detail header and metrics (SH-012)', () => {
  it('shows identity, pairing, payout, network, canonical status, showcase and lifecycle', async () => {
    await openPair('66');
    const header = main().querySelector('header.sh-pair-head');
    if (!(header instanceof HTMLElement)) throw new Error('no pair header');
    const text = header.textContent ?? '';
    for (const expected of ['NFT collection', 'Not an approved factory', 'Showcase concept', 'ORCH', 'Paired with AAPLx-DEMO', 'Holder fee share paid in AAPLx-DEMO', 'Local chain 31337', 'AMM']) {
      expect(text).toContain(expected);
    }
    expect(within(header).getByText('0x00000000000000000000000000000000000003ea')).toBeTruthy();
    expect(within(header).getByText('0x00000000000000000000000000000000000007d2')).toBeTruthy();
    expect(document.title).toBe('ORCHARD · Pair detail · Square Hole');
  });

  it('metrics carry their basis; unavailable is said in words, never $0', async () => {
    await openPair('70');
    const metrics = region('Key figures');
    expect(within(metrics).getAllByText('Not available').length).toBeGreaterThanOrEqual(3);
    expect(metrics.textContent).not.toContain('$0');
    expect(metrics.textContent).toContain('USD price × circulating supply');
    expect(screen.getByRole('img', { name: 'Artwork not uploaded' })).toBeTruthy();
  });
});

describe('supply (FEED-07)', () => {
  it('shows the concepts separately and explains fractions for an NFT collection', async () => {
    await openPair('66');
    const supply = region('Supply');
    for (const label of ['Current economic supply', 'Initial supply cap', 'Fee-burned', 'Circulating', 'Whole-NFT capacity', 'Active NFTs']) {
      expect(within(supply).getByText(label)).toBeTruthy();
    }
    expect(supply.textContent).toContain('Current supply + fee-burned.');
    expect(supply.textContent).not.toMatch(/demo/i);
    expect(supply.textContent).toContain('1 NFT = 1 ORCH');
    // "Fraction" means one thing everywhere: a part of a whole NFT's worth, never a unit count on its own.
    expect(supply.textContent).toContain('A balance of 3.25 ORCH is 3 NFTs plus 0.25 ORCH not yet a whole NFT.');
    expect(supply.textContent).not.toContain('in fractions');
    expect(supply.textContent).toContain('A balance below a whole NFT is not an NFT, and no balance lets you choose a rare one.');
  });

  it('a token pair has no NFT rows, gallery or NFT notice', async () => {
    await openPair('67');
    expect(region('Supply').textContent).not.toContain('Whole-NFT capacity');
    expect(screen.queryByRole('region', { name: 'Collection gallery' })).toBeNull();
    expect(screen.queryByText('Before you trade externally')).toBeNull();
  });
});

describe('trade externally (SH-013: EXT-01, EXT-03, EXT-06, EXT-08)', () => {
  it('lists execution, discovery and explorer destinations, all unverified, none a link', async () => {
    await openPair('66');
    const card = region('Trade externally');
    const items = within(within(card).getByRole('list', { name: 'External destinations' })).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-kind'))).toEqual(['execution', 'discovery', 'explorer']);
    for (const item of items) {
      expect(item.textContent).toContain('Route unverified');
      expect(item.textContent).toContain('no reviewed route exists');
      expect(within(item).queryByRole('link')).toBeNull();
    }
    expect(card.textContent).toContain('DEX Screener');
    expect(card.textContent).toContain('Draft policy: 3% target · native T fees burned · realized Q split 1/3 protocol : 2/3 holders');
    expect(card.textContent).toContain('Before you trade externally');
  });

  it('the page has no external link, and no link to a fixture address except internal app routes', async () => {
    const { container } = await openPair('66');
    const hrefs = Array.from(container.querySelectorAll('a[href]'), (a) => a.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => /^(https?:|\/\/|javascript:|data:)/i.test(href))).toEqual([]);
    expect(container.querySelectorAll('a[target], iframe, form, input, textarea, select')).toHaveLength(0);
    const fixtureAddresses = FIXTURE_PAIRS.flatMap((pair) => [pair.token.address, pair.quote.address, pair.mirrorAddress ?? '', pair.pairId.split(':')[1] ?? ''])
      .filter(Boolean)
      .map((address) => address.toLowerCase());
    const carrying = hrefs.filter((href) => fixtureAddresses.some((address) => href.toLowerCase().includes(address)));
    expect(carrying).toEqual([`/rewards?pair=31337%3A${ORCHARD}`]);
  });

  it('copy actions put the exact address on the clipboard and say so', async () => {
    await openPair('66');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy AAPLx-DEMO (Q) address' })));
    expect(writeText).toHaveBeenCalledWith('0x0000000000000000000000000000000000002329');
    expect(screen.getByText('Copied.')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy NFT mirror address' })));
    expect(writeText).toHaveBeenLastCalledWith('0x00000000000000000000000000000000000007d2');
  });

  it('a refused clipboard is reported in words, not silently', async () => {
    writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await openPair('66');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy token address' })));
    expect(screen.getByText('Copy failed: select the address and copy it by hand.')).toBeTruthy();
  });
});

describe('price chart (FEED-10)', () => {
  it('ORCHARD: only covered timeframes, a visible gap, and a text table of observations', async () => {
    await openPair('66');
    const chart = region('Price USD per ORCH');
    const group = within(chart).getByRole('group', { name: 'Chart timeframe' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['24H', 'All']);
    expect(within(group).getByRole('button', { name: 'All observed history' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(chart).getByRole('img', { name: /ORCHARD price in USD per ORCH/ })).toBeTruthy();
    expect(within(chart).getByText('No observation', { selector: 'text' })).toBeTruthy();
    const rows = within(within(chart).getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(8);
    expect(rows[3]?.textContent).toContain('No observation');

    fireEvent.click(within(group).getByRole('button', { name: 'Last 24 hours' }));
    expect(within(group).getByRole('button', { name: 'Last 24 hours' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(within(chart).getByRole('table')).getAllByRole('row')).toHaveLength(4);
    expect(within(chart).queryByText('No observation', { selector: 'text' })).toBeNull();
  });

  it('pairs without history say so and offer no timeframe', async () => {
    await openPair('67');
    const chart = region('Price USD per ROUND');
    expect(chart.textContent).toContain('No observed price history in this snapshot');
    expect(within(chart).queryByRole('group')).toBeNull();
  });
});

describe('gallery, rewards and activity', () => {
  it('gallery: lazy images with the metadata name as alt text, attributes as text, unavailable art labelled', async () => {
    await openPair('66');
    const gallery = region('Collection gallery');
    const images = within(gallery).getAllByRole('img');
    expect(images.map((img) => img.getAttribute('alt') ?? img.getAttribute('aria-label'))).toEqual([
      'ORCHARD #7',
      'ORCHARD #12',
      'ORCHARD #31',
      'ORCHARD #44',
      'ORCHARD #58: artwork unavailable',
    ]);
    expect(images.slice(0, 4).every((img) => img.getAttribute('loading') === 'lazy')).toBe(true);
    expect(gallery.textContent).toContain('Sunglasses');
    expect(gallery.textContent).toContain('not a count of the collection');
  });

  it('rewards: payout asset, per-asset figures and a Claim on the Claims page link', async () => {
    await openPair('6a');
    const rewards = region('Holder fee share');
    expect(rewards.textContent).toContain('Holder fee share paid in FRAME, converted from credited WETH-DEMO');
    expect(rewards.textContent).toContain('500 FRAME');
    expect(rewards.textContent).toContain('4.969999 WETH-DEMO');
    expect(rewards.textContent).not.toMatch(/APY|APR/);
    expect(within(rewards).getByRole('link', { name: 'Claim on the Claims page' }).getAttribute('href')).toBe(
      '/rewards?pair=31337%3A0x000000000000000000000000000000000000006a',
    );
  });

  it('activity: newest first, no links', async () => {
    await openPair('66');
    const list = within(region('Activity')).getByRole('list', { name: 'Pair activity' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(15);
    expect(items[0]?.textContent).toContain('25 Sep 2026, 08:00 UTC');
    expect(items.at(-1)?.textContent).toContain('Launch');
    expect(within(list).queryAllByRole('link')).toEqual([]);
  });
});

describe('route and data states', () => {
  it('an unknown pair on the demo chain is not found; nothing is guessed', async () => {
    renderAt('/pair/31337/0x0000000000000000000000000000000000000099');
    expect(await screen.findByRole('heading', { level: 1, name: 'Pair not found' })).toBeTruthy();
    expect(main().textContent).toContain('31337:0x0000000000000000000000000000000000000099');
    expect(document.title).toBe('Pair not found · Square Hole');
  });

  it.each([
    ['/pair/1/0x0000000000000000000000000000000000000066', 'only shows pairs on local chain 31337'],
    ['/pair/031337/0x0000000000000000000000000000000000000066', 'not a positive whole number'],
    ['/pair/31337/orchard', 'not 0x followed by 40 hexadecimal characters'],
  ])('%s is not a valid pair address', (path, reason) => {
    renderAt(path);
    expect(screen.getByRole('heading', { level: 1, name: 'Not a valid pair address' })).toBeTruthy();
    expect(main().textContent).toContain(reason);
  });

  it('unavailable: an alert with Try again, never an empty or zero page', async () => {
    renderAt(`/pair/31337/${ORCHARD}?scenario=unavailable`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Pair unavailable' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Nothing is shown as empty or zero');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('loading: the page heading exists while the read is pending', () => {
    renderAt(`/pair/31337/${ORCHARD}?scenario=loading`);
    expect(screen.getByRole('heading', { level: 1, name: 'Loading pair' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Loading pair' }).getAttribute('aria-busy')).toBe('true');
  });

  it('stale: the snapshot notice names its time', async () => {
    await openPair('66', '?scenario=stale');
    expect(main().textContent).toContain('Stale data');
    expect(main().textContent).toContain('Scenario: stale');
  });
});

describe('untrusted metadata (AGENTS.md; ART-01 spirit)', () => {
  it('description and gallery names render as text, never as markup', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const sources: FeedSourceFor = () => {
      const base = createMockFeedProvider();
      const provider: FeedProvider = {
        readFeed: (query, signal) => base.readFeed(query, signal),
        readPair: (pairId, signal) => base.readPair(pairId, signal),
        async readPairDetail(pairId: PairId, signal?: AbortSignal): Promise<PairDetail | null> {
          const detail = await base.readPairDetail(pairId, signal);
          if (!detail?.nft) return detail;
          return {
            ...detail,
            description: hostile,
            nft: { ...detail.nft, gallery: detail.nft.gallery.map((item) => ({ ...item, name: `${item.name} ${hostile}` })) },
          };
        },
      };
      return { provider, mode: 'demo' };
    };
    const { container } = renderAt(`/pair/31337/${ORCHARD}`, sources);
    await screen.findByRole('heading', { level: 1, name: 'ORCHARD' });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(region('About ORCHARD').textContent).toContain(hostile);
    expect(within(region('Collection gallery')).getAllByRole('img')[0]?.getAttribute('alt')).toBe(`ORCHARD #7 ${hostile}`);
  });
});
