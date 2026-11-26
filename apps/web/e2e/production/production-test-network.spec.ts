import { expect, test, type Page } from '@playwright/test';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { NO_TERMS_ACCEPTANCE, TEST_NETWORK_NOTICE_VERSION } from '../terms-state';
import { evidencePath, noDemoTrace, productionChain } from './production-fixture';
import { productionTarget } from './production-target';

// SH-TA-02 (founder 2026-10-23): the Sepolia test site (`SH_BUILD=production SH_TARGET=sepolia`) shows a short test
// network notice instead of the draft production Terms. Only that build runs this file: `SH_TARGET=sepolia pnpm
// check:production` (the main site's Terms specs are skipped there).
test.skip(productionTarget() !== 'sepolia', 'the Sepolia test site only (SH_TARGET=sepolia)');

const NOTICE = 'Test network notice';
const AUDIT = 'The smart contracts have not been audited by an outside firm. Our own reviews are not audits.';
/** SH-ALPHA-NOTICE, SH-ALPHA-SITE: version 4's points for the closed alpha (F156, F157, F161 (4)), as a tester reads them. */
const ALPHA_POINTS = [
  'Closed alpha. You sign in with X. We let in the X accounts we approve.',
  'Test trades only. Box pages buy and sell test tokens only. Nothing on this site uses real money.',
  'Launch tax. In a box’s first 6.4 minutes, a tax takes 93.2% of a buy at first, falling to 8.1%. The box shows the current tax.',
  'tETH. A test token with no value. Its faucet opens for the wallet you claim with.',
  'Nothing carries over. The alpha gives no points or prizes.',
  'Pictures. We hide a picture on this site only if it is illegal or comes with a legal notice. Its copies on Arweave stay where they are.',
  'Contact. hello@squarehole.fun, for questions, feedback and legal notices.',
];
const SIGN_IN = 'You sign in with X through Privy, a Stripe company. X shows Privy’s name. Privy and our server log sign-ins.';

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** No open item of the legal drafts anywhere on the page, marked or not. */
async function noOpenItem(page: Page): Promise<void> {
  await expect(page.locator('mark')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/\[(?:COUNSEL|FOUNDER|ENGINEERING)\b/);
}

/** The notice as /about/terms and /about/privacy show it. */
async function expectNotice(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: NOTICE })).toBeVisible();
  await expect(page).toHaveTitle(`${NOTICE} · Square Hole`);
  const main = page.getByRole('main');
  await expect(main).toContainText('It runs on the Sepolia test network only.');
  await expect(main).toContainText('They have no value.');
  await expect(main).toContainText('Nothing on this site uses real money.');
  await expect(main).toContainText(AUDIT);
  await expect(main).toContainText('The full Terms of Use come before Square Hole runs on mainnet.');
  await expect(main).toContainText(`Version ${TEST_NETWORK_NOTICE_VERSION}`);
  // Versions 3 and 4 (SH-ALPHA-NOTICE, SH-ALPHA-SITE): the closed alpha's points, eleven in all, and the sign-in in the data part.
  const points = main.getByRole('region', { name: 'In short' }).getByRole('listitem');
  await expect(points).toHaveCount(11);
  for (const line of ALPHA_POINTS) await expect(points.filter({ hasText: line })).toHaveCount(1);
  const data = main.getByRole('region', { name: 'Your data' });
  await expect(data).toContainText(SIGN_IN);
  await expect(data).toContainText('If you write to us, we receive your email address and your message.');
  await expect(main).not.toContainText(/do not sign up|no accounts/i);
  await expect(main).not.toContainText(/Square Hole Terms of Use|DRAFT pending legal review|Draft of/);
  await expect(main.locator('.sh-chip')).toHaveCount(0);
  // SH-THIRD-PARTY-NOTICES integrator request 2: the notice links the build's notices file.
  await expect(main.getByRole('link', { name: 'Third-party notices' })).toHaveAttribute('href', '/third-party-notices.txt');
  await noOpenItem(page);
  await noDemoTrace(page, 'the test network notice');
}

test.describe('a first visit', () => {
  test.use({ storageState: NO_TERMS_ACCEPTANCE });

  test('the entry gate asks for the test network notice, its link opens it, Accept opens the feed', async ({ page }, testInfo) => {
    const chain = await productionChain(page);
    await page.goto('/');
    const gate = page.getByRole('dialog', { name: 'Before you enter the test site' });
    await expect(gate).toBeVisible();
    await expect(gate).toContainText('Sepolia test network. Test tokens with no value.');
    await expect(gate).toContainText(AUDIT);
    await expect(gate).toContainText(`Version ${TEST_NETWORK_NOTICE_VERSION}`);
    await expect(gate.getByRole('region', { name: 'Summary of the test network notice' })).toBeVisible();
    // SH-ALPHA-NOTICE: the gate asks for version 3, its eleven points first (the region scrolls on a phone).
    const points = gate.getByRole('region', { name: 'Summary of the test network notice' }).getByRole('listitem');
    await expect(points).toHaveCount(11);
    await expect(points.first()).toHaveText(ALPHA_POINTS[0] ?? '');
    // Who may use it, which the checkbox confirms, comes second: in view without scrolling the points, on both screens.
    await expect(points.nth(1)).toHaveText(/^Who may use it\. Not for anyone under 18/);
    await expect(points.nth(1)).toBeInViewport();
    for (const line of ALPHA_POINTS) await expect(points.filter({ hasText: line })).toHaveCount(1);
    await expect(gate.locator('mark')).toHaveCount(0);
    await noDemoTrace(page, 'the test site gate');
    await page.screenshot({ path: evidencePath(testInfo, 'test-network-gate'), scale: 'css' });
    await page.screenshot({ path: evidencePath(testInfo, 'alpha-notice-gate'), scale: 'css' });
    await gate.getByRole('link', { name: 'Read the test network notice' }).click();
    await expect(page).toHaveURL(/\/about\/terms$/);
    await expectNotice(page);
    await page.goto('/');
    await gate.getByRole('checkbox', { name: /^I have read and accept the test network notice/ }).check();
    await gate.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(gate).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
    expect(await walletTouches(page)).toEqual([]);
    expect(chain.escaped).toEqual([]);
  });
});

test('/about/terms and /about/privacy both show the test network notice, with no open item', async ({ page }, testInfo) => {
  const chain = await productionChain(page);
  await page.goto('/about/terms');
  await expectNotice(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: evidencePath(testInfo, 'test-network-notice'), fullPage: true, scale: 'css' });
  await page.screenshot({ path: evidencePath(testInfo, 'alpha-notice-notice'), fullPage: true, scale: 'css' });
  await page.goto('/about/privacy');
  await expectNotice(page);
  await expect(page.getByRole('region', { name: 'Your data' })).toContainText('squarehole.terms');
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

test('every legal link in the app points to the notice: the footer, About & risks, a box page', async ({ page }, testInfo) => {
  const chain = await productionChain(page);
  /** Every link on the page to a legal page, as [text, href]. */
  const legalLinks = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/about/terms"], a[href*="/about/privacy"]'), (link): [string, string] => [link.innerText.trim(), link.getAttribute('href') ?? '']),
    );
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  expect(await legalLinks()).toEqual([[NOTICE, '/about/terms']]);
  await page.goto('/about/risks');
  await expect(page.getByRole('heading', { level: 1, name: 'About & risks' })).toBeVisible();
  await page.evaluate(() => document.querySelectorAll('main details').forEach((details) => ((details as HTMLDetailsElement).open = true)));
  const risks = await legalLinks();
  expect(risks.length).toBeGreaterThanOrEqual(3);
  for (const [text, href] of risks) {
    expect(href).toBe('/about/terms');
    expect(text.toLowerCase()).toBe(NOTICE.toLowerCase());
  }
  await expect(page.locator('[data-card="risks-legal"]')).toContainText('Using this test site means accepting its test network notice.');
  await noOpenItem(page);
  await noDemoTrace(page, 'about & risks on the test site');
  await page.screenshot({ path: evidencePath(testInfo, 'test-network-risks'), fullPage: true, scale: 'css' });
  await page.goto(`/box/11155111/${chain.tokens.v2}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main h2').first()).toBeVisible();
  for (const [text, href] of await legalLinks()) {
    expect(href).toBe('/about/terms');
    expect(text).toBe(NOTICE);
  }
  await noOpenItem(page);
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});
