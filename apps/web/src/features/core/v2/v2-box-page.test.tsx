/**
 * The v2 box page on the Demo data (M1-53-b; F99, F100, F103, F104; CLAUDE.md "no wallet requests on navigation"):
 * - "Close box" only on a box that can be closed (past its deadline with the curve open, or still closed past the
 *   gate's cap), never on one that cannot;
 * - no wallet is asked anything until "Close box" is pressed; then the wallet window, then one confirmation naming the
 *   exact entry, `fail()` or `failClosed()`, on the box's coordinator;
 * - once closed: "Closed", the closing price per 1M tokens in the box's own pricing token and the closing pool;
 * - every v2 box's token card says "Clone, not upgradeable" with its implementation; a v1 box's never does;
 * - no "refund" anywhere on a v2 box page, in any section, and the copy passes the app's wording rule.
 */
import { DEMO_CHAIN_ID } from '@squarehole/domain';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, connectAs, flush, renderM3 } from '../../../test-support/m3';
import { boxPath, formatBoxId } from '../../boxes/box-id';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { DEMO_WALLET_TITLE } from '../../wallet';
import { DEMO_V2_IMPLEMENTATION, DEMO_V2_TOKENS, resetDemoV2ForTests } from './demo-v2';
import { CLONE_LINE, CLOSE_BOX, CLOSING_POOL, CLOSING_PRICE } from './v2-words';

await import('../../../pages/BoxPage');

type Slug = keyof typeof DEMO_V2_TOKENS;
const SLUGS = Object.keys(DEMO_V2_TOKENS) as Slug[];
const pathOf = (slug: Slug, tab?: string) => `${boxPath(formatBoxId(DEMO_CHAIN_ID, DEMO_V2_TOKENS[slug]))}${tab ? `?tab=${tab}` : ''}`;
const TIN_CANS = '/box/31337/0xde00700000000000000000000000000000000005';
const header = () => document.querySelector('header.sh-box-head') as HTMLElement;
const bandLabel = () => header().querySelector('.sh-box-band__label')?.textContent;
const statLabels = () => [...header().querySelectorAll('.sh-box-stat dt')].map((dt) => dt.textContent);
const closeButton = () => screen.queryByRole('button', { name: CLOSE_BOX });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetDemoV2ForTests();
});

async function open(path: string) {
  renderM3(path);
  await flush(8);
}

async function connectInTheWindow() {
  const dialog = screen.getByRole('dialog', { name: DEMO_WALLET_TITLE });
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Box wallet A' }));
  await click(within(dialog).getByRole('button', { name: 'Connect sample wallet' }));
  await flush();
}

describe('"Close box" (F99): only once the box can be closed', () => {
  it('past its deadline (Glass Marbles) or past the gate’s cap (Brass Keys); never before (Cork Boats), once closed (Felt Hats) or on a v1 box', async () => {
    for (const [path, shown] of [
      [pathOf('marbles'), true],
      [pathOf('keys'), true],
      [pathOf('boats'), false],
      [pathOf('hats'), false],
      [TIN_CANS, false],
    ] as const) {
      await open(path);
      expect(header().querySelector('h1')?.textContent, path).toBeTruthy();
      expect(closeButton() !== null, path).toBe(shown);
      cleanup();
    }
  });
});

describe('the wallet only when pressed, then one confirmation, then the closing price (CLAUDE.md; F99, F104)', () => {
  it('navigation asks no wallet; pressing opens the wallet window; the confirmation names fail() on the coordinator; then the box is Closed', async () => {
    await open(pathOf('marbles'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Connect wallet/ }).length).toBeGreaterThan(0);
    expect(header().textContent).toMatch(/Anyone can close it · tip up to 0\.001 ETH/);
    await click(closeButton() as HTMLElement);
    await connectInTheWindow();
    const confirm = screen.getByRole('group', { name: CLOSE_BOX });
    expect(confirm.textContent).toMatch(/Calls fail\(\) on 0xde02…0001/);
    expect(confirm.textContent).not.toMatch(/demo/i);
    await click(within(confirm).getByRole('button', { name: 'Confirm close' }));
    await flush(4);
    expect(bandLabel()).toBe('Closed');
    expect(statLabels()).toEqual(['Items', CLOSING_PRICE, CLOSING_POOL]);
    expect(closeButton()).toBeNull();
    expect(header().querySelector('.sh-box-phase')?.textContent).toMatch(/^Closed · deadline passed · closer’s tip 0\.001 ETH$/);
  });

  it('a box still closed past the gate’s cap sends failClosed(); Cancel sends nothing', async () => {
    await open(pathOf('keys'));
    await click(closeButton() as HTMLElement);
    await connectInTheWindow();
    const confirm = screen.getByRole('group', { name: CLOSE_BOX });
    expect(confirm.textContent).toMatch(/Calls failClosed\(\) on 0xde02…0002/);
    await click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: CLOSE_BOX })).toBeNull();
    expect(bandLabel()).toBe('Upcoming');
    expect(closeButton()).not.toBeNull();
  });

  it('with a wallet already connected, pressing goes straight to the confirmation', async () => {
    await open(pathOf('marbles'));
    await connectAs('Box wallet B');
    await click(closeButton() as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('group', { name: CLOSE_BOX }).textContent).toMatch(/fail\(\)/);
  });

  it('a closed box in USDC: its closing price per 1M tokens and its pool, in USDC', async () => {
    await open(pathOf('hats'));
    expect(bandLabel()).toBe('Closed');
    const cell = (label: string) => [...header().querySelectorAll('.sh-box-stat')].find((c) => c.querySelector('dt')?.textContent === label)?.querySelector('dd');
    expect(cell(CLOSING_PRICE)?.textContent).toMatch(/^13\.738USDC per 1M HATS/);
    expect(cell(CLOSING_POOL)?.textContent).toMatch(/^8,412\.5USDC/);
  });
});

describe('the token card (F103): "Clone, not upgradeable" with the release’s T implementation', () => {
  it('on every v2 box page, with the implementation’s address; never on a v1 box', async () => {
    for (const slug of SLUGS) {
      await open(pathOf(slug, 'token'));
      const line = document.querySelector('.sh-v2-clone') as HTMLElement | null;
      expect(line?.textContent, slug).toContain(CLONE_LINE);
      expect(line?.querySelector('code')?.getAttribute('title'), slug).toBe(DEMO_V2_IMPLEMENTATION);
      expect(line?.textContent, slug).toContain('No links on a local chain');
      cleanup();
    }
    await open(`${TIN_CANS}?tab=token`);
    expect(document.body.textContent).not.toContain(CLONE_LINE);
  });
});

describe('CQ8-F22 A7: the price-step disclosure', () => {
  const line = 'Buy-backs and deepening share one step per block, within 49 ticks at the current price.';

  it.each(SLUGS)('%s: the Token tab shows the exact line with the fees', async (slug) => {
    await open(pathOf(slug, 'token'));
    const fees = screen.getByRole('region', { name: 'Fees' });
    const disclosure = within(fees).getByText(line);
    expect(disclosure.closest('[hidden]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/last hour’s price|last hour's price|resume within 1-3 hours/i);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the v1 Token tab outside the v2 price-step rule', async () => {
    await open(`${TIN_CANS}?tab=token`);
    expect(screen.queryByText(line)).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Fees' })).getByText('1% pool fee')).toBeTruthy();
  });
});

describe('wording (F99, F100): no "refund" on a v2 box page', () => {
  it('in every section of every v2 box, closed or not, and the copy passes the app’s wording rule', async () => {
    for (const slug of SLUGS) {
      for (const tab of [undefined, 'token', 'owning', 'about']) {
        await open(pathOf(slug, tab));
        const main = screen.getByRole('main');
        expect(main.textContent, `${slug} ${tab ?? 'contents'}`).not.toMatch(/refund/i);
        expect(renderedCopy(main).filter((text) => /refund/i.test(text))).toEqual([]);
        expect(appCopyFraming(renderedCopy(main))).toEqual([]);
        cleanup();
      }
    }
  });
});

describe('SH-V2-FE3: phone layout hooks and short words in the header', () => {
  it('a v2 header is marked for its phone figure rows; a v1 header is not; Owning one names the box’s own ticker', async () => {
    await open(pathOf('marbles'));
    expect(header().hasAttribute('data-v2')).toBe(true);
    expect(statLabels()).toHaveLength(3);
    expect(screen.getAllByText('Fees burn MRBL').length).toBeGreaterThan(0);
    expect(screen.queryByText('Fees burn the token')).toBeNull();
    cleanup();
    await open(TIN_CANS);
    expect(header().hasAttribute('data-v2')).toBe(false);
  });
});
