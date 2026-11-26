import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { FORBIDDEN, forbiddenLabelNames, outsideRecipeChoices, RECIPE_CHOICES } from './trading-controls';

/**
 * SH-256: what a stored draft of this version carries beside its form (draft.ts): its v2 part (field `v2`, here the
 * defaults) and the print of its companion parts (field `parts`, here none: no art, logo, cover or page pictures). A
 * seeded draft without them starts clean, as one saved by the version before does.
 */
const BURN = { a: { leg: 2, dest: 1, to: null }, b: { leg: 0, dest: 0, to: null }, split: { kind: 'none' } };
export const STORED_V2_DEFAULTS = Object.freeze({
  v2: { pricing: '0x0000000000000000000000000000000000000000', buyers: BURN, sellers: BURN, pickFeeBps: 2500, deadlineDays: 30, pile: null, shop: null },
  template: null, loaded: null,
});
export const STORED_NO_PARTS = Object.freeze({ art: null, cover: null, collectionCover: null, page: null });

export { FORBIDDEN } from './trading-controls';

/** The box pages (SH-BOX-UI-launch): shared helpers for boxes-feed, box-page, box-page-sepolia and wallet-box specs. */

export const DEMO_FIT = '0x000000000000000000000000000000000000f17e';
export const MISFITS_BOX = `/box/31337/${DEMO_FIT}`;
export const TOY_TRAINS = '/box/31337/0xde00700000000000000000000000000000000003';
export const TIN_CANS = '/box/31337/0xde00700000000000000000000000000000000005';
export const WALLET_A = '0xde00000000000000000000000000000000000a11';
export const WALLET_B = '0xde00000000000000000000000000000000000b22';

/**
 * A fake injected wallet that records every READ of `window.ethereum` and any EIP-6963 discovery: browsing the box
 * pages must touch none of it (UI-09). F135 (founder 2026-10-11) allows one exception, a silent `eth_accounts` on load
 * after this device remembered a browser-wallet connect; these specs never connect a browser wallet, so with no memory
 * nothing may be touched at all. The prompting side of the rule (no account request or any other wallet window on
 * navigation, ever) is checked with a real-shaped fake in e2e/browser-wallet.spec.ts.
 */
export async function installUntouchableWallet(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const touches: string[] = [];
    Object.defineProperty(window, '__walletTouches', { value: touches });
    const provider = new Proxy(
      {},
      {
        get(_target, key) {
          touches.push(`provider.${String(key)}`);
          return () => Promise.reject(new Error('untouchable wallet'));
        },
      },
    );
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      get() {
        touches.push('window.ethereum');
        return provider;
      },
    });
    window.addEventListener('eip6963:requestProvider', () => touches.push('eip6963:requestProvider'));
  });
}

export const walletTouches = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as { __walletTouches: string[] }).__walletTouches]);

export const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The text runs inside `target` that break onto a second line (a hint under a label is its own run); [] when none. */
export const brokenRuns = (target: Locator): Promise<string[]> => target.evaluate((root) => {
  const broken: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || node.parentElement?.closest('.sh-visually-hidden, [hidden]')) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    if (new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size > 1) broken.push(node.textContent.trim());
  }
  return broken;
});

/** Recipe selections have scoped exceptions; links, radios and amount fields never inherit them. */
/**
 * SH-254: an audited page is the page itself, never the error boundary ("This page hit a problem", or a part's "This
 * part of the page hit a problem."): an audit that reads an error page proves nothing about the page.
 */
export async function notTheErrorPage(page: Page, where: string): Promise<void> {
  await expect(page.getByText(/hit a problem/), where).toHaveCount(0);
}

export async function noTradingActions(page: Page, where?: string): Promise<void> {
  await expect.poll(() => page.getByRole('button', { name: FORBIDDEN }).evaluateAll(outsideRecipeChoices, RECIPE_CHOICES), where).toEqual([]);
  for (const role of ['link', 'radio', 'textbox'] as const) {
    await expect(page.getByRole(role, { name: FORBIDDEN }), where).toHaveCount(0);
  }
  await expect(page.getByRole('textbox', { name: /amount/i }), where).toHaveCount(0);
  expect(await page.locator('body').evaluate(forbiddenLabelNames, RECIPE_CHOICES), where).toEqual([]);
}

export async function noTradingControls(page: Page): Promise<void> {
  await noTradingActions(page);
  await expect(page.locator('input:not([type="search"]), textarea, iframe, input[type="number"]')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
}

/** The box header once its state is known (not "unavailable"). */
export const boxHeader = (page: Page): Locator => page.locator('header.sh-box-head');

export async function openBox(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(boxHeader(page)).toBeVisible();
  await expect(boxHeader(page)).not.toHaveAttribute('data-state', 'unavailable');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * The page or an element, in CSS pixels. SH_EVIDENCE_SCREENSHOTS=1 writes docs/evidence/screenshots/sh-box-ui-launch/
 * <name>-<project>.png; otherwise the test output folder, so an ordinary run never dirties the tree.
 */
export async function evidence(page: Page, testInfo: TestInfo, name: string, options: { fullPage?: boolean } = {}): Promise<void> {
  const file =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/sh-box-ui-launch/${name}-${testInfo.project.name}.png`, import.meta.url))
      : testInfo.outputPath(`${name}.png`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: options.fullPage ?? true, scale: 'css' });
}

/**
 * SH-255 (review R-16): a closed box's second-level headings in order, up to the closing price, each marked as the
 * picture's or the page's, compared whole.
 */
export async function h2Order(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('main h2')];
    const end = all.findIndex((h) => h.textContent === 'Closing price');
    return all.slice(0, end + 1).map((h) => `${h.closest('.sh-bpic') ? 'picture' : 'page'}: ${h.textContent ?? ''}`);
  });
}
/** A closed box always has claims: the picture's action card, its fees card, then the closing price (round 3, D13). */
export const PICTURE_THEN_CLOSING = ['picture: What you can do here', 'picture: Where the fees go', 'page: Closing price'];
