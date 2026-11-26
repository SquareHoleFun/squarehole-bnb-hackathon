import { quoteWithdrawPrincipal } from '@squarehole/domain';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxCard } from '../features/boxes/BoxCard';
import { launchSummary } from '../features/boxes/box-figure';
import { launchRecord } from '../features/boxes/box-sources';
import { launchBand } from '../features/boxes/box-stats';
import { ContentsPanel } from '../features/boxes/ContentsPanel';
import { demoVaultTotals } from '../features/boxes/demo-vault';
import { TEASERS } from '../features/boxes/misfits-content';
import { costTokens } from '../features/boxes/price-format';
import { priceModel } from '../features/boxes/price-model';
import { demoChainFor } from '../features/fit-pair/demo-chain';
import { liveDataFromDirect, type VaultCounters } from '../features/fit-pair/direct-source';
import { formatTokenShort } from '../features/fit-pair/fit-format';
import { DEMO_FIT_TARGET, FIT_ISSUANCE_RAW, type FitMarketTarget } from '../features/fit-pair/fit-target';
import type { LiveDeps } from '../features/fit-pair/live-controller';
import { appCopyFraming, renderedCopy } from '../features/legal/wording';
import { click, connectAs, flush, location, renderM3 } from '../test-support/m3';
import { LaunchBoxPage } from './BoxPage';

// The box pages are lazy routes: load their chunks once so the fake-timer flush can render them.
await Promise.all([import('./BoxFeedPage'), import('./BoxPage'), import('./WalletBoxPage'), import('./LaunchRedirect')]);

const MISFITS = `/box/31337/${DEMO_FIT_TARGET.token}`;
const TOY_TRAINS = '/box/31337/0xde00700000000000000000000000000000000003';
const TIN_CANS = '/box/31337/0xde00700000000000000000000000000000000005';
const WALLET_A = '0xde00000000000000000000000000000000000a11';
const WALLET_B = '0xde00000000000000000000000000000000000b22';
const FORBIDDEN = /\b(buy|sell|swap)\b/i;
const FIT = 10n ** 18n;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function open(path: string) {
  renderM3(path);
  await flush(8);
}

const cards = () => screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/box/'));
const header = () => document.querySelector('header.sh-box-head') as HTMLElement;
const band = () => header().querySelector('.sh-box-band') as HTMLElement;
const bandLabel = () => band().querySelector('.sh-box-band__label')?.textContent;
const bandFigure = () => band().querySelector('.sh-box-band__figure')?.textContent?.replace(/^: /, '');
const counters = () => [...header().querySelectorAll<HTMLElement>('.sh-box-counters > .sh-box-counter')];
const stats = () => [...header().querySelectorAll('.sh-box-stat dt')].map((dt) => dt.textContent);
/** A stat's value and unit as read on the page (its (i) panel left out). */
function stat(label: string): { textContent: string } | undefined {
  const dd = [...header().querySelectorAll('.sh-box-stat')].find((cell) => cell.querySelector('dt')?.textContent === label)?.querySelector('dd');
  if (!dd) return undefined;
  const copy = dd.cloneNode(true) as HTMLElement;
  copy.querySelector('.sh-info-panel')?.remove();
  return { textContent: copy.textContent ?? '' };
}

function noTradingControls() {
  expect(screen.queryAllByRole('button', { name: FORBIDDEN })).toEqual([]);
  expect(screen.queryAllByRole('link', { name: FORBIDDEN })).toEqual([]);
  expect(document.querySelectorAll('input:not([type="search"]), textarea, iframe')).toHaveLength(0);
}

describe('the box feed (home, the sample data)', () => {
  it('pins the Misfits first (Featured) and names every sample box with its network, never Demo (F130)', async () => {
    await open('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Boxes' })).toBeTruthy();
    expect(screen.getByText('6 boxes')).toBeTruthy();
    const names = cards().map((card) => card.getAttribute('aria-label') ?? '');
    expect(names[0]).toMatch(/^The Misfits, FIT, Genesis box, Bonding, .*, 4,269 Misfits, Local chain 31337, Featured$/);
    expect(names.slice(1).map((name) => name.split(',')[0])).toEqual(['Paper Kites', 'Pocket Stamps', 'Toy Trains', 'Clay Pots', 'Tin Cans']);
    for (const name of names) expect(name).toMatch(/, Local chain 31337(, Featured)?$/);
    // F130: no Demo tape, chip or word on any card.
    expect(document.querySelectorAll('.sh-box-tape')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/\bdemo\b/i);
    // The sample data is current: no card says Stale or Unverified.
    expect(document.querySelectorAll('.sh-box-card__notice')).toHaveLength(0);
    noTradingControls();
  });

  it('counts each state on its chip, filters by it and searches names, tickers, addresses and wallets; the count is announced', async () => {
    await open('/');
    // The count is a polite live region that follows the search and the state chip.
    const live = () => document.querySelector('.sh-box-feed__count[role="status"]')?.textContent;
    expect(live()).toBe('6 boxes');
    const chips = within(screen.getByRole('group', { name: 'State' }));
    expect(chips.getAllByRole('button').map((chip) => chip.textContent)).toEqual(['All 6', 'Upcoming 1', 'Launch window 0', 'Bonding 3', 'Graduating 0', 'Graduated 1', 'Failed 1']);
    await click(chips.getByRole('button', { name: /^Graduated/ }));
    expect(location()).toBe('/?state=graduated');
    expect(cards().map((card) => card.getAttribute('aria-label')?.split(',')[0])).toEqual(['Toy Trains']);
    expect(live()).toBe('1 of 6 boxes');
    await click(chips.getByRole('button', { name: /^All/ }));
    const search = screen.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' });
    await act(async () => fireEvent.change(search, { target: { value: 'choo' } }));
    expect(cards().map((card) => card.getAttribute('aria-label')?.split(',')[0])).toEqual(['Toy Trains']);
    // The short address a card shows, and its last four digits.
    await act(async () => fireEvent.change(search, { target: { value: '0x0000…f17e' } }));
    expect(cards().map((card) => card.getAttribute('aria-label')?.split(',')[0])).toEqual(['The Misfits']);
    await act(async () => fireEvent.change(search, { target: { value: 'f17e' } }));
    expect(cards().map((card) => card.getAttribute('aria-label')?.split(',')[0])).toEqual(['The Misfits']);
    await act(async () => fireEvent.change(search, { target: { value: 'nothing like this' } }));
    expect(live()).toBe('0 of 6 boxes');
    // A space typed between two words stays in the field (the URL keeps the trimmed query).
    await act(async () => fireEvent.change(search, { target: { value: 'paper ' } }));
    expect((search as HTMLInputElement).value).toBe('paper ');
    expect(location()).toBe('/?q=paper');
    await act(async () => fireEvent.change(search, { target: { value: 'paper kites' } }));
    expect(cards().map((card) => card.getAttribute('aria-label')?.split(',')[0])).toEqual(['Paper Kites']);
    // A full address that is no box: the wallet as a box-shaped card; the state chips (all 0) step aside.
    await act(async () => fireEvent.change(search, { target: { value: WALLET_A } }));
    const wallet = screen.getByRole('link', { name: 'Wallet 0xde00…0a11, 2 items from 2 boxes, View only' });
    expect(wallet.getAttribute('href')).toBe(`/wallet/${WALLET_A}`);
    expect(wallet.textContent).toContain('2 items from 2 boxes');
    expect(wallet.querySelector('.sh-box-shell')).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'State' })).toBeNull();
    expect(live()).toBe('1 wallet');
  });

  it('switches to the List view and says when a sort cannot be honest', async () => {
    await open('/?view=list&sort=mcap');
    expect(screen.getByRole('table')).toBeTruthy();
    // Every Demo box is paired with ETH (F74 U5: one raise; another Q's "ETH equivalent" is open, S12): no note needed.
    expect(screen.queryByText('Sorted within each pair asset')).toBeNull();
    expect((screen.getByRole('option', { name: 'FDV' }) as HTMLOptionElement).selected).toBe(true);
    const volume = screen.getByRole('option', { name: /24h volume/ }) as HTMLOptionElement;
    expect(volume.disabled).toBe(true);
    expect(volume.textContent).toBe('24h volume · not yet');
  });

  it('an old pair-feed link opens the box feed with its search: the pair feed is off in every build (F134 R46B)', async () => {
    await open('/?q=orch&type=token');
    expect(location()).toBe('/?q=orch');
    expect(document.body.textContent).not.toMatch(/-DEMO\b|ORCHARD/);
  });

  it('follows the safe wording rule (F23)', async () => {
    await open('/');
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
  });
});

describe('the box page: one template, the Misfits in each Demo state', () => {
  const table = [
    { scenario: 'before_open', label: 'Upcoming', figure: /^in \d+ blocks$/, stats: ['Items', '1 Misfit', 'Price', 'Target'], phase: 'Launch tax 93.20% → 8.06% on buys', conversion: 'Opens with the curve' },
    { scenario: 'window', label: 'Launch window', figure: /^\d+ blocks? left$/, stats: ['Items', 'Reserved', '1 Misfit', 'Price'], phase: /^Launch tax \d+\.\d\d% on buys$/, conversion: 'Get a placeholder · in the app soon' },
    { scenario: 'curve', label: 'Bonding', figure: /^\d+\.\d% · \d+(\.\d{1,4})? \/ 4\.206980085 ETH$/, stats: ['Items', 'Reserved', '1 Misfit', 'Price'], phase: null, conversion: 'Get a placeholder · in the app soon' },
    { scenario: 'completed', label: 'Graduating', figure: /^not graduated yet$/, stats: ['Items', 'Reserved', '1 Misfit', 'Price'], phase: /^(Graduation possible in \d+ blocks?|Anyone can trigger graduation|Price outside the graduation band|Graduation pending)$/, conversion: 'Graduation pending' },
    { scenario: 'migrated', label: 'Graduated', figure: /^FDV [\d,.]+ ETH$/, stats: ['Items', 'Inside', '1 Misfit', 'Price'], phase: /^Graduated at block [\d,]+$/, conversion: 'Take one out · Put it back · in the app soon' },
  ] as const;
  for (const row of table) {
    it(`${row.scenario}: the ${row.label} band with its one figure, the stats, the phase and the counters; no vault action looks clickable`, async () => {
      await open(row.scenario === 'curve' ? MISFITS : `${MISFITS}?scenario=${row.scenario}`);
      expect(screen.getByRole('heading', { level: 1, name: 'The Misfits' })).toBeTruthy();
      expect(band().dataset.state).toBe(row.scenario === 'before_open' ? 'upcoming' : row.scenario === 'curve' ? 'bonding' : row.scenario === 'completed' ? 'graduating' : row.scenario === 'migrated' ? 'graduated' : 'window');
      expect(bandLabel()).toBe(row.label);
      expect(bandFigure()).toMatch(row.figure);
      expect(stats()).toEqual([...row.stats]);
      // The founder's two numbers side by side: FIT per Misfit (the vault) and the ETH price per 1M FIT (the pool).
      expect(stat('1 Misfit')?.textContent).toMatch(/^2\d\d,\d{3}FIT$/);
      expect(stat('Price')?.textContent).toMatch(/^0\.\d+ETH per 1M FIT$/);
      const phase = header().querySelector('.sh-box-phase');
      if (row.phase === null) expect(phase).toBeNull();
      else expect(phase?.textContent).toMatch(row.phase);
      // The chips: kind, chain (glyph and a short name); no Demo chip (F130); never "Featured" on the page (a feed placement).
      expect(header().querySelector('.sh-box-head__chips')?.textContent).toBe('Genesis boxLocal chainLocal chain 31337');
      const [conv, claims, market] = counters();
      expect(conv?.textContent).toContain(row.conversion);
      expect(claims?.textContent).toContain(row.scenario === 'migrated' ? 'Not built yet' : 'After graduation');
      expect(market?.textContent).toContain(row.scenario === 'before_open' ? 'Starts with the curve' : 'No links on a local chain');
      // Actions not in this app read like closed counters: text behind a lock, never a (disabled) button.
      expect(header().querySelectorAll('.sh-box-counters button:not(.sh-info-button)')).toHaveLength(0);
      expect(header().querySelectorAll('a[href^="http"]')).toHaveLength(0);
      expect(document.body.textContent).not.toMatch(/fee share|outside liquidity/i);
      expect(document.body.textContent).not.toMatch(/Featured/);
      expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
      noTradingControls();
    });
  }

  it('the peek strip shows four ordinary examples and the rest as a count; a tap opens What’s in the box?', async () => {
    await open(`${MISFITS}?tab=about`);
    const strip = screen.getByRole('button', { name: /^Sneak peek: four examples of 4,269 Misfits/ });
    expect(strip.querySelectorAll('img')).toHaveLength(4);
    for (const img of strip.querySelectorAll('img')) expect(img.getAttribute('src')).toMatch(/m-B(09|02|06|13)-256/);
    expect(strip.textContent).toBe('+4,265Sneak peek');
    await click(strip);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(location()).toBe(MISFITS);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: '4,269 Misfits, sealed until graduation' }));
    // "Owning one" in the header: four short items; its label opens the tab.
    const own = header().querySelector('.sh-box-own') as HTMLElement;
    expect([...own.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['Take one out', 'Put it back', 'Claims while outside', 'Your companion']);
    await click(within(own).getByRole('button', { name: 'Owning one' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(location()).toBe(`${MISFITS}?tab=owning`);
    expect(document.activeElement?.id).toBe('box-owning-lead');
  });

  it('What’s in the box?: N from the data, one example per family then two more, the composition keyed to its bar, the sealed count', async () => {
    await open(MISFITS);
    expect(screen.getByRole('heading', { level: 2, name: '4,269 Misfits, sealed until graduation' })).toBeTruthy();
    const peek = screen.getAllByRole('button', { name: /, example$/ });
    expect(peek.map((tile) => tile.getAttribute('aria-label'))).toEqual(TEASERS.map((teaser) => `${teaser.family}, ${teaser.role}, example`));
    expect(peek.map((tile) => tile.textContent)).toEqual(['Sorter', 'Coin', 'Stonk', 'Frame', 'RWA', 'Shapes', 'Coin · Mechanic', 'RWA · Explorer']);
    // One "Examples" chip for the section, none per tile.
    const block = peek[0]?.closest('.sh-box-card-block') as HTMLElement;
    expect([...block.querySelectorAll('.sh-box-example')].map((chip) => chip.textContent)).toEqual(['Examples']);
    expect(document.body.textContent).not.toMatch(/#\d/);
    const comp = document.querySelector('.sh-box-comp') as HTMLElement;
    expect(comp.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Families: Sorter 880, Coin 520, Stonk 840, Frame 880, RWA 864, Shapes about 200, One-of-ones 12, Classics 4, Icons 69');
    // Six coloured parts and one hatched "rare" part; every legend entry has the key of its part.
    expect([...comp.querySelectorAll('.sh-box-comp__bar > span')].map((part) => part.getAttribute('data-key'))).toEqual(['1', '2', '3', '4', '5', '6', 'rare']);
    expect([...comp.querySelectorAll('.sh-box-comp__legend li')].map((item) => `${item.querySelector('.sh-box-comp__key')?.getAttribute('data-key')} ${item.textContent}`)).toEqual([
      '1 Sorter 880',
      '2 Coin 520',
      '3 Stonk 840',
      '4 Frame 880',
      '5 RWA 864',
      '6 Shapes ~200',
      'rare One-of-ones 12',
      'rare Classics 4',
      'rare Icons 69',
    ]);
    // The avatars are the families' ordinary pieces, cropped to the character.
    expect(comp.querySelectorAll('.sh-box-avatar img')).toHaveLength(6);
    expect(comp.textContent).toContain('Diamond 26');
    expect(comp.textContent).toContain('Planned counts');
    // 4,269 is the 4,200 plan plus the Icons: an assumption until confirmed.
    expect(within(comp).getByText('Assumed')).toBeTruthy();
    expect(document.querySelector('.sh-box-sealed')?.textContent).toBe('Sealed inside4,232');
  });

  it('an example opens in a sheet with its family count; Escape closes it and gives focus back', async () => {
    await open(MISFITS);
    const tile = screen.getByRole('button', { name: 'Coin, Mechanic, example' });
    tile.focus();
    await click(tile);
    const sheet = screen.getByRole('dialog', { name: 'Coin · Mechanic' });
    expect(sheet.textContent).toContain('FamilyCoin · 520');
    expect(sheet.textContent).toContain('RoleMechanic');
    expect(sheet.textContent).toContain('FinishStandard');
    expect(sheet.textContent).toContain('Example. Never a token number.');
    expect(document.activeElement).toBe(within(sheet).getByRole('heading', { name: 'Coin · Mechanic' }));
    await act(async () => fireEvent.keyDown(sheet, { key: 'Escape' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(tile);
  });

  it('after graduation: "Inside the vault" (examples), "Edition counts", the outside count said once', async () => {
    await open(`${MISFITS}?scenario=migrated`);
    expect(screen.getByRole('heading', { level: 2, name: '4,269 Misfits · 90 outside the vault' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Inside the vault' })).toBeTruthy();
    expect(screen.queryByText('Sneak peek')).toBeNull();
    expect(screen.getAllByText('Examples').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Examples · Demo/)).toBeNull();
    expect(screen.getByText('Edition counts')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Item list comes with the reveal|sealed until graduation/);
    // Inside is the header's; the panel says how many are outside.
    expect(stat('Inside')?.textContent).toBe('4,179');
    expect(document.querySelector('.sh-box-panel')?.textContent).not.toContain('4,179');
  });

  it('the price picture equals the vault math exactly; going in and out is drawn; never ETH per Misfit', async () => {
    await open(`${MISFITS}?tab=owning`);
    // The Demo stream's burn at the first block (nothing advances the Demo clock here), then the 37 placeholders.
    const burned = demoChainFor(DEMO_FIT_TARGET, 'curve').head.state.burnedRaw;
    const totals = demoVaultTotals('curve', burned, DEMO_FIT_TARGET.collectionSize);
    const model = priceModel({ ...totals, chainQuoteOne: null, block: null });
    if (!model?.fitPerItem || !model.releasePerItem) throw new Error('no quote');
    const cost = costTokens(model.fitPerItem);
    const price = screen.getByRole('region', { name: 'Price' });
    expect(price.querySelector('.sh-box-price__row strong')?.textContent).toBe(`${cost} FIT`);
    expect(stat('1 Misfit')?.textContent).toBe(`${cost}FIT`);
    expect(price.textContent).toMatch(/1M FIT0\.\d+ ETHMarket price/);
    const flow = within(price).getByRole('list', { name: 'What going in and out does to the FIT in the vault' });
    expect([...flow.querySelectorAll('li')].map((item) => item.textContent)).toEqual([`Take one out+${cost} FIT locked · 1% burned`, `Put one back${(model.releasePerItem / FIT).toLocaleString('en-US')} FIT released · 5% burned`]);
    expect(price.querySelector('.sh-box-flow__total')?.textContent).toBe(`37 placeholders · ${formatTokenShort(model.locked, 'FIT')} locked · ${formatTokenShort(model.unlocked, 'FIT')} outside the vault`);
    expect(model.unlocked).toBe(totals.supply - totals.escrow);
    expect(price.textContent).not.toMatch(/ETH per Misfit|per Misfit.*ETH/i);
    expect(within(price).queryByText('Demo')).toBeNull();
    // The take tile states its fee, like the put-back tile.
    expect(screen.getByText(`${cost} FIT + 1% fee`)).toBeTruthy();
    expect(screen.getByText('Today’s quote back, less 5%')).toBeTruthy();
    // The (i) says the mechanics, never a prediction.
    expect(price.textContent).toContain('In and out keep that number; only burned FIT lowers it, slowly.');
    expect(price.textContent).not.toMatch(/\b(rise|increase|grow|value)\w*/i);
  });

  it('the section bar is a tablist: arrows move and select, the tab is in the URL', async () => {
    await open(MISFITS);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['What’s in the box?', 'Token', 'Owning one', 'About']);
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    await act(async () => fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' }));
    await flush(2);
    expect(location()).toBe(`${MISFITS}?tab=token`);
    expect(document.activeElement?.textContent).toBe('Token');
    expect(screen.getByRole('region', { name: 'Bonding curve' })).toBeTruthy();
    // The address on the Token tab and its Copy button, with no Demo badge or words (F130).
    expect(screen.getAllByRole('button', { name: 'Copy the FIT contract address' })).toHaveLength(2);
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' }));
    await flush(2);
    expect(screen.getByText('Different shapes. Same hole.', { selector: '.sh-box-about__tagline' })).toBeTruthy();
    expect(screen.getByText('4,269 toy blocks that don’t fit, trying anyway.')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('SH-BOX0-LIVE-CURVE: the sample page’s Token tab is unchanged: its own live curve card first, then the launch window and the trades', async () => {
    await open(`${MISFITS}?tab=token`);
    const main = document.querySelector('.sh-box-token .sh-fit-grid__main') as HTMLElement;
    expect([...main.children].map((card) => card.getAttribute('aria-labelledby') ?? card.getAttribute('aria-label'))).toEqual(['fit-curve-title', 'fit-window-title', 'fit-tape-title']);
    expect(screen.getAllByRole('region', { name: 'Bonding curve' })).toHaveLength(1);
    const curve = screen.getByRole('region', { name: 'Bonding curve' });
    expect(curve.getAttribute('data-freshness')).toBe('live');
    expect(curve.textContent).toMatch(/^Bonding curve.*Live.*Price[\d.]+ ETH per 1M FITProgress to graduation\d+\.\d%/);
    // The row page's cards (core v1) are not on the sample page.
    expect(document.querySelector('[data-card^="core-"]')).toBeNull();
  });

  it('the header’s address carries no Demo badge (F130)', async () => {
    await open(MISFITS);
    const id = header().querySelector('.sh-fit-ca--compact') as HTMLElement;
    expect(id.querySelector('.sh-fit-demo')).toBeNull();
    expect(id.textContent).not.toMatch(/demo/i);
    expect(within(id).getByRole('button', { name: 'Copy the FIT contract address' })).toBeTruthy();
  });

  it('sample boxes use the same template: Toy Trains shows 12 example blocks, Tin Cans its failed state', async () => {
    await open(TOY_TRAINS);
    expect(screen.getByRole('heading', { level: 2, name: '500 toy blocks · 48 outside the vault' })).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /toy block, example art$/ })).toHaveLength(12);
    expect(bandLabel()).toBe('Graduated');
    expect(bandFigure()).toBe('FDV 18.4 ETH');
    expect(counters()[0]?.textContent).toContain('Take one out · Put it back · in the app soon');
    expect(header().querySelector('.sh-box-peekstrip')?.textContent).toBe('+496Examples');
    cleanup();
    await open(TIN_CANS);
    expect(bandLabel()).toBe('Failed');
    expect(bandFigure()).toBe('refunds open');
    expect(header().querySelector('.sh-box-phase')?.textContent).toBe('Deadline passed');
    expect(header().querySelector('.sh-box-peekstrip')?.textContent).toBe('50Sealed');
    expect(counters()[0]?.textContent).toContain('Open placeholder · Hand back · in the app soon');
    expect(screen.getByText('No preview shared', { selector: '.sh-box-head__line' })).toBeTruthy();
    // The phone bar points at the refund.
    expect(screen.getByRole('region', { name: 'Next step' }).textContent).toBe('Refund · No links on a local chain');
  });

  it('the phone bar: a counters button that opens all three counters in a sheet', async () => {
    await open(MISFITS);
    const bar = screen.getByRole('region', { name: 'Next step' });
    expect(bar.dataset.compact).toBe('true');
    expect(bar.textContent).toBe('');
    const opener = within(bar).getByRole('button', { name: 'All counters: Conversion, Claims, Market' });
    opener.focus();
    await click(opener);
    const sheet = screen.getByRole('dialog', { name: 'Counters' });
    expect(within(sheet).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Counters', 'Conversion', 'Claims', 'Market']);
    expect(sheet.textContent).toContain('Get a placeholder · in the app soon');
    expect(sheet.textContent).toContain('After graduation');
    expect(sheet.textContent).toContain('No links on a local chain');
    await act(async () => fireEvent.keyDown(sheet, { key: 'Escape' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('an id that is not a box on this source says so, without guessing; another spelling is made canonical', async () => {
    await open('/box/31337/0x0000000000000000000000000000000000000001');
    // The sample data names no source on a page: a box it does not hold is "not found", never "not on Local chain 31337".
    expect(screen.getByRole('heading', { level: 1, name: 'Box not found' })).toBeTruthy();
    expect(document.body.textContent).toContain('This box is not in this snapshot.');
    cleanup();
    for (const junk of ['/box/__proto__', '/box/31337/__proto__', '/box/1/0x000000000000000000000000000000000000f17e']) {
      await open(junk);
      expect(screen.getByRole('heading', { level: 1, name: 'Not a box address' }), junk).toBeTruthy();
      cleanup();
    }
    // Upper-case hex, and the earlier /box/<chain>-<token> form: replaced by the canonical path, the query kept.
    await open(`/box/31337/${DEMO_FIT_TARGET.token.toUpperCase().replace('0X', '0x')}?tab=owning`);
    expect(location()).toBe(`${MISFITS}?tab=owning`);
    cleanup();
    await open(`/box/31337-${DEMO_FIT_TARGET.token}?scenario=migrated`);
    expect(location()).toBe(`${MISFITS}?scenario=migrated`);
  });
});

describe('a chain box: the price picture from one vault read', () => {
  const target: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', rpcUrl: 'http://127.0.0.1:8599' };
  const record = launchRecord(target);
  const chain = demoChainFor(target, 'curve');
  const head = chain.head.header;
  const totals = demoVaultTotals('curve', chain.head.state.burnedRaw, 4_269n);
  const live = liveDataFromDirect(
    {
      block: { number: head.number, hash: head.hash, timestamp: head.timestamp },
      safeBlock: null,
      finalizedBlock: null,
      sqrtPriceX96: chain.head.state.sqrtPriceX96,
      tick: chain.head.state.tick,
      phase: 'curve',
      completedBlock: null,
      migratedBlock: null,
      liquidityOpensAtBlock: null,
      openBlock: target.openBlock,
      totalSupplyRaw: FIT_ISSUANCE_RAW - chain.head.state.burnedRaw,
    },
    target,
  );
  const deps: LiveDeps = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    openStream: null,
    fetchSnapshot: null,
    readDirect: async () => live,
  };
  const computed = quoteWithdrawPrincipal(totals, 1n);
  const counters = (over: Partial<VaultCounters> = {}): VaultCounters => ({
    source: 'chain',
    block: head.number,
    inside: totals.inside,
    collectionSize: 4_269n,
    gateOpen: false,
    placeholdersTaken: 37n,
    escrow: totals.escrow,
    supply: totals.supply,
    quoteOne: computed,
    ...over,
  });

  async function show(readVault: () => Promise<VaultCounters>, tab = 'owning') {
    render(
      <MemoryRouter initialEntries={[`/box/x?tab=${tab}`]}>
        <LaunchBoxPage record={record} target={target} scenario="curve" deps={deps} readVault={readVault} />
      </MemoryRouter>,
    );
    await flush(8);
  }

  it('the chain’s own quote agrees: the computed quote, no Unverified, read at the block', async () => {
    const read = async () => counters();
    await show(read);
    const price = screen.getByRole('region', { name: 'Price' });
    expect(price.dataset.check).toBe('matches_chain');
    expect(price.querySelector('.sh-box-price__row strong')?.textContent).toBe(`${costTokens(computed)} FIT`);
    expect(within(price).queryByText('Unverified')).toBeNull();
    expect(price.textContent).toContain(`Read at block ${head.number.toLocaleString('en-US')}.`);
    expect(stat('1 Misfit')?.textContent).toBe(`${costTokens(computed)}FIT`);
  });

  it('the chain’s own quote disagrees: the page shows the vault’s quote, marked unverified, in the row, the stat and the tile', async () => {
    const charged = computed + 5n * FIT;
    const read = async () => counters({ quoteOne: charged });
    await show(read);
    const price = screen.getByRole('region', { name: 'Price' });
    expect(price.dataset.check).toBe('mismatch');
    expect(within(price).getByText('Unverified')).toBeTruthy();
    expect(price.querySelector('.sh-box-price__row strong')?.textContent).toBe(`${costTokens(charged)} FIT`);
    expect(stat('1 Misfit')?.textContent).toBe(`${costTokens(charged)}FIT · unverified`);
    expect(screen.getByText(`${costTokens(charged)} FIT + 1% fee`)).toBeTruthy();
    expect(document.body.textContent).not.toContain(costTokens(computed));
  });

  it('a later vault read fails: the last good figures stay, said to be out of date, with their block', async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
      if (calls > 1) throw new Error('RPC timeout');
      return counters();
    };
    await show(read);
    expect(document.querySelector('.sh-box-notice')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flush(4);
    expect(calls).toBe(2);
    const notices = [...document.querySelectorAll('.sh-box-notice')].map((notice) => notice.textContent);
    expect(notices).toContain(`Vault read failed · figures from block ${head.number.toLocaleString('en-US')}`);
    expect(within(screen.getByRole('region', { name: 'Price' })).getByText('May be out of date')).toBeTruthy();
    expect(stat('Reserved')?.textContent).toBe('37');
  });

  it('a vault that cannot be read says why, and shows nothing as zero', async () => {
    const read = async (): Promise<VaultCounters> => {
      throw new Error('execution reverted');
    };
    await show(read, 'contents');
    expect([...document.querySelectorAll('.sh-box-notice')].map((notice) => notice.textContent)).toContain('Vault not read · execution reverted');
    expect(stat('Reserved')?.textContent).toBe('Not available');
    expect(stat('1 Misfit')?.textContent).toBe('Not availableFIT');
  });

  it('the vault’s N disagrees with the market record’s: the vault’s counts, marked unverified, and no composition', async () => {
    const read = async () => counters({ collectionSize: 4_200n, inside: 4_163n });
    await show(read, 'contents');
    expect(stat('Items')?.textContent).toBe('4,200Unverified');
    expect(screen.getByRole('heading', { level: 2, name: '4,200 Misfits, sealed until graduation' })).toBeTruthy();
    expect(within(document.querySelector('.sh-box-lead') as HTMLElement).getByText('Unverified')).toBeTruthy();
    expect(document.querySelector('.sh-box-comp')).toBeNull();
    expect(document.querySelector('.sh-box-sealed')?.textContent).toBe('Sealed inside4,163');
    expect(document.querySelector('.sh-box-peekstrip')?.textContent).toBe('+4,196Sneak peek');
  });
});

describe('stale or unverified live data on the card and in the header (BOX-INTERFACE § 6, § 8)', () => {
  const target: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', rpcUrl: 'http://127.0.0.1:8599' };
  const record = launchRecord(target);
  const chain = demoChainFor(target, 'migrated');
  const migrated = liveDataFromDirect(
    {
      block: { number: chain.head.header.number, hash: chain.head.header.hash, timestamp: chain.head.header.timestamp },
      safeBlock: null,
      finalizedBlock: null,
      sqrtPriceX96: chain.head.state.sqrtPriceX96,
      tick: chain.head.state.tick,
      phase: 'migrated',
      completedBlock: chain.head.state.completedBlock,
      migratedBlock: chain.head.state.migratedBlock,
      liquidityOpensAtBlock: null,
      openBlock: target.openBlock,
      totalSupplyRaw: FIT_ISSUANCE_RAW - chain.head.state.burnedRaw,
    },
    target,
  );

  function card(freshness: 'live' | 'stale' | 'unverified', staleSinceBlock: bigint | null = null) {
    const summary = launchSummary(record, 'graduated', migrated, target, { freshness, staleSinceBlock });
    render(
      <MemoryRouter>
        <ul>
          <BoxCard summary={summary} to="/box/x" />
        </ul>
      </MemoryRouter>,
    );
    return { summary, link: screen.getByRole('link') };
  }

  it('a stale card says since when, in words and in its name; its figures stay', () => {
    const { link } = card('stale', 21_000_512n);
    expect(link.querySelector('.sh-box-card__notice')?.textContent).toBe('Stale · since block 21,000,512');
    expect(link.querySelector('.sh-box-card__notice')?.hasAttribute('data-disclosure')).toBe(true);
    expect(link.getAttribute('aria-label')).toMatch(/^The Misfits, FIT, Genesis box, Graduated, FDV [\d,.]+ ETH, Stale · since block 21,000,512, 4,269 Misfits, Local chain 31337, Featured$/);
  });

  it('an unverified card has no FDV (built from the price the page hides), on the card and in the header’s band', () => {
    const { summary, link } = card('unverified');
    expect(link.querySelector('.sh-box-card__figure')?.textContent).toBe('FDV not available');
    expect(link.querySelector('.sh-box-card__notice')?.textContent).toBe('Unverified');
    expect(summary.mcapRaw).toBeNull();
    expect(launchBand({ state: 'graduated', data: migrated, target, summary }).figure).toBe('FDV not available');
    cleanup();
    const live = card('live');
    expect(live.link.querySelector('.sh-box-card__notice')).toBeNull();
    expect(launchBand({ state: 'graduated', data: migrated, target, summary: live.summary }).figure).toMatch(/^FDV [\d,.]+ ETH$/);
  });
});

describe('a rehearsal box (neutral names)', () => {
  it('shows its counts and "Test set only", no teasers, no composition and no Misfits wording', () => {
    const neutral: FitMarketTarget = {
      ...DEMO_FIT_TARGET,
      kind: 'chain',
      names: { kind: 'neutral', tokenName: 'Rehearsal Token 2', tokenSymbol: 'RHT2', collectionName: 'Rehearsal Collection', collectionSymbol: 'RHC', placeholderName: 'Rehearsal placeholder', placeholderSymbol: 'RHC-P', item: 'item', items: 'items' },
      collectionSize: 4_200n,
    };
    const record = launchRecord(neutral);
    render(
      <MemoryRouter>
        <ContentsPanel record={record} state="bonding" counts={{ inside: 4_200n, reserved: 0n }} launchContent={false} edition={{ size: 4_200n, check: 'vault', recordSize: 4_200n }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 2, name: '4,200 items, sealed until graduation' })).toBeTruthy();
    expect(screen.getByText('Test set only: made-up traits, no art.')).toBeTruthy();
    expect(screen.queryByText('Sneak peek')).toBeNull();
    expect(screen.queryByText('Composition')).toBeNull();
    expect(document.body.textContent).not.toMatch(/misfit/i);
  });
});

describe('wallet boxes (view only)', () => {
  it('/wallet/<address> shows what a sample wallet holds, view only, with no totals; the address once', async () => {
    await open(`/wallet/${WALLET_A}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Wallet' })).toBeTruthy();
    expect(header().textContent?.split('0xde00…0a11')).toHaveLength(2);
    expect(header().textContent).toContain('View only');
    expect(header().textContent).toContain('During the curve');
    expect(header().textContent).not.toMatch(/demo/i);
    expect([...header().querySelectorAll('.sh-box-stat')].map((cell) => cell.textContent)).toEqual(['Boxes2', 'Items2', 'Claims readyNot built yet']);
    // The wallet is a box: its shell, the companion's slot says what goes there for this wallet.
    expect(header().querySelector('.sh-box-shell__text')?.textContent).toBe('After graduation');
    expect(screen.getByRole('region', { name: 'The Misfits' }).textContent).toContain('1.25M FIT');
    expect(screen.getByRole('region', { name: 'The Misfits' }).textContent).toContain('2 sealed');
    expect(screen.getByText('Other assets not shown')).toBeTruthy();
    noTradingControls();
  });

  it('revealed items are shown as items (example art), never as the sealed box; the companion copy follows the wallet', async () => {
    await open(`/wallet/${WALLET_B}`);
    const misfits = screen.getByRole('region', { name: 'The Misfits' });
    const tile = [...misfits.querySelectorAll('.sh-box-wtile')].find((item) => item.textContent?.includes('3 Misfits')) as HTMLElement;
    expect(tile.textContent).toContain('Example art');
    expect(tile.textContent).not.toMatch(/demo/i);
    expect(tile.querySelectorAll('.sh-box-mosaic img')).toHaveLength(3);
    for (const img of tile.querySelectorAll('img')) expect(img.getAttribute('src')).not.toMatch(/cover-misfits|sealed-/);
    expect(screen.getByRole('region', { name: 'Toy Trains' }).querySelectorAll('.sh-box-mosaic .sh-box-toy')).toHaveLength(4);
    // Not this viewer's wallet: no one but the owner chooses its companion.
    expect(header().querySelector('.sh-box-shell__text')?.textContent).toBe('No companion yet');
    await click(screen.getByRole('tab', { name: 'Companion' }));
    expect(screen.getByRole('heading', { level: 2, name: 'No companion chosen' })).toBeTruthy();
    cleanup();
    await open('/my-box');
    await connectAs('Box wallet B');
    await flush(4);
    expect(header().querySelector('.sh-box-shell__text')?.textContent).toBe('Choose your Misfit');
    await click(screen.getByRole('tab', { name: 'Companion' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Choose one of your 3 Misfits' })).toBeTruthy();
  });

  it('/my-box without a wallet explains how to connect and opens nothing; My Box appears once connected', async () => {
    await open('/my-box');
    expect(screen.getByRole('heading', { level: 1, name: 'My Box' })).toBeTruthy();
    expect(screen.getByText('Connect a wallet (top right) to see your box. Nothing opens by itself.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    const nav = () => screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav()).queryByRole('link', { name: 'My Box' })).toBeNull();
    await connectAs('Box wallet A');
    expect(within(nav()).getByRole('link', { name: 'My Box' }).getAttribute('aria-current')).toBe('page');
    await flush(4);
    expect(header().textContent).not.toContain('View only');
    expect(screen.getByRole('region', { name: 'The Misfits' }).textContent).toContain('2 sealed');
  });
});
