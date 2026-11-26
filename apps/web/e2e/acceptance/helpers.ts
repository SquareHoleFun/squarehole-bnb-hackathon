/**
 * Page helpers for the M1 feed acceptance suite. Every locator here is taken from the SHARED UI CONTRACT (see
 * README.md): accessible roles and names, `data-pair-id`, URL parameters. Nothing depends on class names or on the
 * implementation's component structure.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { idFromSuffix, type FeedQuery } from './expected';

export type Scenario =
  | 'default'
  | 'loading'
  | 'stale'
  | 'partial'
  | 'unavailable'
  | 'no_launches'
  | 'root_unlaunched'
  | 'ranking_updated';

export interface FeedUrlOptions extends FeedQuery {
  scenario?: Scenario | string;
}

/** The pair feed's path: the box feed took `/` in the launch set (F46); the feed and its URL state moved here. */
export const FEED_PATH = '/pairs';

/** `/pairs?…` for a feed state. Values are passed through verbatim so tests can also build hostile URLs. */
export function feedUrl(options: FeedUrlOptions = {}): string {
  const params = new URLSearchParams();
  const entries: [string, string | undefined][] = [
    ['q', options.q],
    ['sort', options.sort],
    ['type', options.type],
    ['reward', options.reward],
    ['lifecycle', options.lifecycle],
    ['scenario', options.scenario],
  ];
  for (const [key, value] of entries) if (value !== undefined && value !== '') params.set(key, value);
  const query = params.toString();
  return query ? `${FEED_PATH}?${query}` : FEED_PATH;
}

export const searchbox = (page: Page): Locator => page.getByRole('searchbox', { name: 'Search pairs', exact: true });
/** The header's search trigger (named for the box feed since the launch set; on the pair feed it focuses its field). */
export const searchTrigger = (page: Page): Locator =>
  page.getByRole('banner').getByRole('button', { name: 'Search boxes', exact: true });
export const sortGroup = (page: Page): Locator => page.getByRole('radiogroup', { name: 'Sort by', exact: true });
export const typeGroup = (page: Page): Locator => page.getByRole('radiogroup', { name: 'Asset type', exact: true });
export const sortRadio = (page: Page, name: 'Market cap' | 'New' | 'Turnover (24h)'): Locator =>
  sortGroup(page).getByRole('radio', { name, exact: true });
export const typeRadio = (page: Page, name: 'All' | 'Tokens' | 'NFT collections'): Locator =>
  typeGroup(page).getByRole('radio', { name, exact: true });
export const rewardSelect = (page: Page): Locator => page.getByRole('combobox', { name: 'Fee share in', exact: true });
export const lifecycleSelect = (page: Page): Locator => page.getByRole('combobox', { name: 'Lifecycle', exact: true });
export const pin = (page: Page): Locator => page.getByRole('region', { name: 'Platform pin', exact: true });

/** The organic result container: a table on desktop widths or a list on narrow widths, named "Launched pairs". */
export const results = (page: Page): Locator =>
  page
    .getByRole('table', { name: 'Launched pairs', exact: true })
    .or(page.getByRole('list', { name: 'Launched pairs', exact: true }));

/** Outermost `data-pair-id` elements inside the results (a nested avatar carrying the id is not a second row). */
export const ROW_SELECTOR = '[data-pair-id]:not([data-pair-id] [data-pair-id])';
export const rows = (page: Page): Locator => results(page).locator(ROW_SELECTOR);
export const row = (page: Page, pairId: string): Locator => results(page).locator(`[data-pair-id="${pairId}"]`);

/** The organic count: the one `role="status"` whose whole text is "<n> pairs" / "1 pair". */
export const countStatus = (page: Page): Locator => page.getByRole('status').filter({ hasText: /^\s*\d+ pairs?\s*$/ });

/** Row ids in DOM order. A navigation in flight yields a marker instead of throwing, so `expect.poll` retries. */
export async function rowIds(page: Page): Promise<string[]> {
  try {
    return await rows(page).evaluateAll((elements) => elements.map((el) => el.getAttribute('data-pair-id') ?? ''));
  } catch (error) {
    if (/context was destroyed|navigat/i.test(String(error))) {
      return ['<navigating>'];
    }
    throw error;
  }
}

/** Waits for the feed to settle on exactly these rows, in this order, without duplicates. */
export async function expectRows(page: Page, ids: readonly string[]): Promise<void> {
  await expect.poll(() => rowIds(page), { message: 'organic rows (data-pair-id, DOM order)' }).toEqual([...ids]);
  expect(new Set(ids).size, 'no duplicate rows').toBe(ids.length);
}

export const suffixes = (list: readonly string[]): string[] => list.map(idFromSuffix);

/** Waits until the result container is present and no longer busy. */
export async function waitForFeed(page: Page): Promise<void> {
  await expect(results(page)).toBeVisible();
  await expect(results(page)).not.toHaveAttribute('aria-busy', 'true');
}

export async function expectCount(page: Page, label: string): Promise<void> {
  await expect(countStatus(page)).toHaveCount(1);
  await expect(countStatus(page)).toHaveText(label);
}

/**
 * The contract does not describe a mobile "Filters" disclosure, but it does not forbid one either. If the sort group is
 * hidden behind such a toggle, open it; this changes no assertion.
 */
export async function revealControls(page: Page): Promise<void> {
  if (await sortGroup(page).isVisible()) return;
  const toggle = page.getByRole('button', { name: /^(show )?(filters?|sort( and | & )filters?|controls)$/i });
  if ((await toggle.count()) === 1) await toggle.click();
  await expect(sortGroup(page)).toBeVisible();
}

export function searchParams(page: Page): Record<string, string> {
  return Object.fromEntries(new URL(page.url()).searchParams.entries());
}

/** Collects uncaught page errors and console errors. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

/**
 * Installs a fake EIP-1193 provider (also announced through EIP-6963) that records every call. The returned function
 * reads the calls made so far, across reloads.
 */
export async function installWalletSpy(page: Page): Promise<() => string[]> {
  const calls: string[] = [];
  await page.exposeFunction('__shRecordWalletCall', (call: string) => {
    calls.push(call);
  });
  await page.addInitScript(() => {
    const record = (call: string) => {
      const sink = (window as unknown as { __shRecordWalletCall?: (c: string) => void }).__shRecordWalletCall;
      if (sink) void sink(call);
    };
    const refuse = () => Promise.reject(Object.assign(new Error('acceptance spy wallet'), { code: 4001 }));
    const provider = {
      isMetaMask: true,
      request(args: { method?: string } | undefined) {
        record(`request:${String(args?.method)}`);
        return refuse();
      },
      enable() {
        record('enable');
        return refuse();
      },
      send(method: unknown) {
        record(`send:${typeof method === 'string' ? method : JSON.stringify(method)}`);
        return refuse();
      },
      sendAsync(payload: unknown) {
        record(`sendAsync:${JSON.stringify(payload)}`);
      },
      on() {
        return provider;
      },
      removeListener() {
        return provider;
      },
    };
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });
    window.addEventListener('eip6963:requestProvider', () => {
      const info = { uuid: '00000000-0000-4000-8000-000000000000', name: 'Acceptance spy', icon: 'data:,', rdns: 'test.acceptance.spy' };
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    });
  });
  return () => [...calls];
}

/**
 * Accessible text of an element: aria-hidden subtrees and display:none/visibility:hidden content are skipped,
 * `aria-label` / `aria-labelledby` replace an element's content and `<img alt>` counts. Visually-hidden text counts.
 */
export async function accessibleText(locator: Locator): Promise<string> {
  return locator.evaluate((root) => {
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
      if (!(node instanceof Element)) return '';
      if (node.getAttribute('aria-hidden') === 'true') return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      const labelledBy = node.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        if (text.trim()) return ` ${text} `;
      }
      const label = node.getAttribute('aria-label');
      if (label && label.trim()) return ` ${label} `;
      if (node.tagName === 'IMG') return ` ${node.getAttribute('alt') ?? ''} `;
      return ` ${Array.from(node.childNodes).map(walk).join('')} `;
    };
    return walk(root).replace(/\s+/g, ' ').trim();
  });
}

/** Scroll offset of the element that scrolls the results (an overflow ancestor, else the document). */
export async function resultsScrollTop(page: Page, scrollToEnd = false): Promise<number> {
  return results(page).evaluate((el, toEnd) => {
    let scroller: Element | null = el.parentElement;
    while (scroller && scroller !== document.body) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 1) break;
      scroller = scroller.parentElement;
    }
    const target = scroller && scroller !== document.body ? scroller : (document.scrollingElement ?? document.documentElement);
    if (toEnd) target.scrollTop = target.scrollHeight;
    return target.scrollTop;
  }, scrollToEnd);
}

/** Visible text of the document body. */
export const bodyText = (page: Page): Promise<string> => page.locator('body').innerText();

/** Every `href` on the page, resolved against the page URL. */
export async function allLinkTargets(page: Page): Promise<URL[]> {
  const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
  return hrefs.map((href) => new URL(href));
}
