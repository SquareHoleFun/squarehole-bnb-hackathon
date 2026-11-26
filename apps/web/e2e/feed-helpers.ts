import { expect, type Locator, type Page } from '@playwright/test';

/** The pair feed's path: the box feed took `/` in the launch set (F46), the pair feed moved here with its URL state. */
export const FEED_PATH = '/pairs';

/**
 * Client-side navigation to a route that left the primary navigation in the launch set (Launch, Claims, Portfolio, the
 * pair feed): the router follows a history entry pushed in the page, so an in-memory wallet connection survives, as it
 * does when a link is clicked. Never a reload.
 */
export async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState(window.history.state, '', to);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

/** Canonical demo pair id by its last address byte, e.g. pid('66') → 31337:0x…0066. */
export const pid = (suffix: string): string => `31337:0x${suffix.padStart(40, '0')}`;

/** Market-cap order of the demo fixture (provider order, FEED-02). */
export const MARKET_CAP_ORDER = ['66', '67', '68', '69', '6a', '6b', '6c', '6d', '6e', '6f', '70'].map(pid);

export const USDC_DEMO = '0x000000000000000000000000000000000000232a';

export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return errors;
}

/** The results container: a table on desktop widths, a list of cards on narrow ones. Whichever is rendered is named. */
export function results(page: Page): Locator {
  return page.locator('[aria-label="Launched pairs"]');
}

export function status(page: Page): Locator {
  return page.getByRole('status');
}

export async function rowIds(page: Page): Promise<string[]> {
  return page.locator('[data-pair-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-pair-id') ?? ''));
}

export function row(page: Page, suffix: string): Locator {
  return page.locator(`[data-pair-id="${pid(suffix)}"]`);
}

/** Loads a feed URL and waits for fonts and a settled result count. */
export async function openFeed(page: Page, url = FEED_PATH, count: string | RegExp = /^\d+ pairs?$/): Promise<void> {
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(status(page)).toHaveText(count);
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY));
}
