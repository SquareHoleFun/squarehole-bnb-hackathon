import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { TRADE_PATTERN } from '../../production-check';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { noDemoTrace } from './production-fixture';
import { productionTarget } from './production-target';

/**
 * F161 (4), SH-ALPHA-SITE: the alpha's own pages in the release build (build/alpha-pages.ts), as the build the caller's
 * target names ships them. On the Sepolia test site: the public join page (`/join/`) and the founder's desk (`/desk/`),
 * each loading only its own files and nothing of Privy's at first paint; the join page offers "Sign in with X" for the
 * founder's Privy app (alpha-sepolia/privy-config.ts), behind its box, and loads Privy only on the press (which no test
 * here makes: it would ask Privy's service). Our server's answers are the real ones' (alpha-api.mjs), given in the
 * browser; every other request leaving the machine is aborted. On the main site: no such page.
 * SH_ALPHA_SITE_SCREENSHOTS=1 writes docs/evidence/SH-ALPHA-SITE/release-<name>-<width>.png.
 */
const SEPOLIA = productionTarget() === 'sepolia';

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const file = process.env.SH_ALPHA_SITE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../../docs/evidence/SH-ALPHA-SITE/release-${name}-${width}.png`, import.meta.url))
    : testInfo.outputPath(`${name}-${width}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true, scale: 'css', animations: 'disabled' });
}

/** The scripts and styles the page loaded from the preview, with the trade markers each one holds. */
function recordLoads(page: Page): { files: { path: string; markers: string[] }[]; settled: () => Promise<void> } {
  const files: { path: string; markers: string[] }[] = [];
  const reading: Promise<void>[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname !== '127.0.0.1' || !/\.(?:m?js|css)$/.test(url.pathname)) return;
    reading.push(response.text().then((text) => { files.push({ path: url.pathname, markers: [...text.matchAll(new RegExp(TRADE_PATTERN.source, TRADE_PATTERN.flags))].map((match) => match[0]) }); }));
  });
  return { files, settled: async () => { await Promise.all(reading); } };
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.describe('the Sepolia test site', () => {
  test.skip(!SEPOLIA, 'the Sepolia test site only (SH_TARGET=sepolia)');

  test('the join page: the notice and its data part, its own files only, nothing of Privy’s before the press, and the box before “Sign in with X”', async ({ page }, testInfo) => {
    const escaped: string[] = [];
    await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => { escaped.push(new URL(route.request().url()).host); return route.abort(); });
    // A stranger: our server's answer (alpha-api.mjs, no session).
    await page.route('**/alpha/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'sign in required' }) }));
    // SH-198: the join page first asks whether sign-ups are open (alpha-api.mjs, /alpha/intake). Open, and not a returning browser.
    await page.route('**/alpha/intake', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ open: true, returning: false }) }));
    const loads = recordLoads(page);
    await page.goto('/join/');
    await expect(page.getByRole('heading', { level: 1, name: 'Square Hole alpha' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Test network notice' }).getByRole('listitem')).toHaveCount(11);
    // The founder's Privy app is set (XR-ALPHA-SITE af1): the sign-in is offered, behind the notice's box.
    await expect(page.getByText('Sign-in is not set up yet.')).toHaveCount(0);
    const signIn = page.getByRole('button', { name: 'Sign in with X' });
    const box = page.getByRole('checkbox', { name: /^I have read and accept the test network notice, and I confirm that I am at least 18/ });
    await expect(signIn).toBeDisabled();
    await expect(box).not.toBeChecked();
    await shot(page, testInfo, 'join-stranger');
    await box.check();
    await expect(signIn).toBeEnabled();

    // The data part, as it ships: the sign-in through Privy, our cookie and Privy's items, no item of the sample data.
    await page.locator('summary', { hasText: 'Your data' }).click();
    await page.locator('summary', { hasText: 'What stays on your device' }).click();
    const data = page.locator('.sh-join__details').first();
    await expect(data).toContainText('You sign in with X through Privy, a Stripe company.');
    for (const key of ['__Host-alpha_session', 'privy:token', 'privy:refresh_token']) await expect(data.getByText(key, { exact: true })).toBeVisible();
    // The development build's sample-data items (sh.boxes.sample-created.v1, sh.sample-tx-scenario) are not shipped.
    await expect(data).not.toContainText(/sh\.boxes\.sample|sh\.sample-tx/);
    await shot(page, testInfo, 'join-your-data');

    // The release's third-party notices for this page's own files.
    const notices = page.getByRole('link', { name: 'Third-party notices' });
    await expect(notices).toHaveAttribute('href', '/join/assets/third-party-notices.txt');
    const file = await page.request.get('/join/assets/third-party-notices.txt');
    expect(file.status()).toBe(200);
    expect(await file.text()).toMatch(/^Third-party notices\n/);

    await loads.settled();
    expect(loads.files.length).toBeGreaterThan(0);
    expect(loads.files.filter((loaded) => !loaded.path.startsWith('/join/assets/'))).toEqual([]);
    expect(loads.files.filter((loaded) => loaded.markers.length > 0)).toEqual([]);
    await noDemoTrace(page, 'the join page');
    expect(escaped).toEqual([]);
    expect(await walletTouches(page)).toEqual([]);
  });

  // SH-198, in the release build: closed sign-ups offer no sign-in to a new browser, and an unanswered check offers none either.
  for (const [name, answer, line] of [
    ['closed', { status: 200, body: JSON.stringify({ open: false, returning: false }) }, 'New sign-ups are closed.'],
    ['not answered', { status: 503, body: JSON.stringify({ error: 'unavailable' }) }, 'Sign-up availability could not be checked. Try again.'],
  ] as const) test(`the join page with sign-ups ${name}: its line, and no “Sign in with X”`, async ({ page }) => {
    const escaped: string[] = [];
    await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => { escaped.push(new URL(route.request().url()).host); return route.abort(); });
    await page.route('**/alpha/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'sign in required' }) }));
    await page.route('**/alpha/intake', (route) => route.fulfill({ contentType: 'application/json', ...answer }));
    await page.goto('/join/');
    await expect(page.getByRole('heading', { level: 1, name: 'Square Hole alpha' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: line })).toHaveText(line);
    await expect(page.getByRole('button', { name: 'Sign in with X' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /^I have read and accept the test network notice/ })).toHaveCount(0);
    expect(escaped).toEqual([]);
    expect(await walletTouches(page)).toEqual([]);
  });

  test('the desk: our server’s list, with its own files only', async ({ page }) => {
    const escaped: string[] = [];
    await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => { escaped.push(new URL(route.request().url()).host); return route.abort(); });
    const signups = [{ xId: '1849302217654321001', privyDid: 'did:privy:release', handle: 'ada_builds', name: 'Ada Builder', picture: null, status: 'pending', signedUpAt: '2026-10-29T10:00:00.000Z', lastSignIn: '2026-10-29T10:00:00.000Z' }];
    await page.route('**/desk/api/signups', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signups, decisions: [] }) }));
    const loads = recordLoads(page);
    await page.goto('/desk/');
    await expect(page.getByRole('heading', { level: 1, name: 'Alpha desk' })).toBeVisible();
    await expect(page.getByRole('link', { name: /@ada_builds/ })).toHaveAttribute('href', 'https://x.com/i/user/1849302217654321001');
    await expect(page.getByRole('button', { name: 'Approve @ada_builds' })).toBeVisible();
    await loads.settled();
    expect(loads.files.filter((loaded) => !loaded.path.startsWith('/desk/assets/'))).toEqual([]);
    expect(loads.files.filter((loaded) => loaded.markers.length > 0)).toEqual([]);
    await noDemoTrace(page, 'the desk');
    expect(escaped).toEqual([]);
  });
});

test.describe('the main site', () => {
  test.skip(SEPOLIA, 'the main site only (SH_TARGET unset or mainnet)');

  test('has no join page and no desk: their addresses answer nothing of theirs', async ({ page }) => {
    for (const path of ['/', '/join', '/join/', '/join/index.html', '/desk', '/desk/', '/desk/index.html']) {
      const response = await page.request.get(path);
      const body = await response.text();
      expect(body, path).not.toMatch(/\/join\/assets\/|\/desk\/assets\/|Square Hole alpha|Alpha desk/);
    }
  });
});
