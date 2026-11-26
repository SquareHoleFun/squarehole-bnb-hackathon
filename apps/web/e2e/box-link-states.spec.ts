import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';

// SH-SITE-FIXES-10 task 2 in the browser: a v2 box link opened fresh (ship 9 prep, 2026-10-27: "Not in Sepolia testnet"
// for 100-300 ms, and until a reload when the /v2/feed request never answered). The local twin's indexer is answered
// here (core v1's recorded life and a v2 box, mixed-deployment.ts), each state by how /v2/feed answers: late, never,
// refused, or answered without the box. The chain is not reachable (its requests are refused). Desktop at 1440×900 and
// a phone at 375 px. SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to docs/evidence/<SH_EVIDENCE_DIR, default
// SH-SITE-FIXES-10/after>/<state>-<project>.png; each is taken before the state's checks, so a run on the earlier
// code records what it showed ("before").
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const DIR = process.env.SH_EVIDENCE_DIR ?? 'SH-SITE-FIXES-10/after';

async function shot(page: Page, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${DIR}/${name}-${info.project.name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, fullPage: false, scale: 'css' });
}

/** How a /v2/feed request is met: `answer` fulfils it with the feed that lists the box. */
type V2Answer = (route: Route, answer: (route: Route) => Promise<void>) => Promise<void>;
async function open(page: Page, v2: V2Answer, token?: string) {
  const data = await mixedDeployment();
  const asked: number[] = [];
  const started = Date.now();
  const json = { ...data.feed, cards: [data.body] };
  const answer = (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(json) });
  await installUntouchableWallet(page);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${RPC}/**`, (route) => route.abort('connectionrefused'));
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v2/feed') { asked.push(Date.now() - started); return v2(route, answer); }
    const other = path === '/v1/feed' ? data.v1.feed : path.endsWith('/activity') ? { asOf: data.body.asOf, items: [], next: null } : null;
    await route.fulfill({ status: other ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(other) });
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${data.manifest.chainId}/${(token ?? data.body.token).toLowerCase()}`);
  return { data, asked };
}

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
/** The synthetic v2 box's name (published-v2.ts), its page's heading. */
const BOX_NAME = 'Box 4 Items';

test.describe('SH-SITE-FIXES-10 a box link while its sources load', () => {
  test.beforeEach(async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('the v2 feed answers late: "Reading the box…" meanwhile, never "Not in …"; then the box', async ({ page }, info) => {
    let release: () => void = () => undefined;
    const late = new Promise<void>((resolve) => { release = resolve; });
    await open(page, async (route, answer) => { await late; await answer(route); });
    await page.waitForTimeout(1_500);
    await shot(page, info, 'loading');
    await expect(h1(page)).toHaveText('Reading the box…');
    await expect(page.getByRole('main')).not.toContainText(/Not in |Box not found/);
    release();
    // The v2 box's own page: its name as the heading, its region named by it.
    await expect(h1(page)).toHaveText(BOX_NAME);
    await expect(page.getByRole('region', { name: BOX_NAME })).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText(/Not in |Box not found/);
    expect(await walletTouches(page)).toEqual([]);
  });

  test('the v2 feed request is never answered: aborted at its deadline, asked once more, then Unavailable with Retry; Retry shows the box', async ({ page }, info) => {
    test.setTimeout(90_000);
    let answering = false;
    const box = await open(page, async (route, answer) => { if (answering) await answer(route); });
    try {
      await expect(h1(page)).toHaveText('Unavailable', { timeout: 30_000 });
    } finally {
      await shot(page, info, 'unavailable');
    }
    // One request, then one more after its deadline (8 s) and a second's wait; none hangs on.
    expect(box.asked.length).toBeGreaterThanOrEqual(2);
    expect((box.asked[1] ?? 0) - (box.asked[0] ?? 0)).toBeGreaterThanOrEqual(8_000);
    const main = page.getByRole('main');
    await expect(main.getByRole('status')).toHaveText('The box could not be read.');
    await expect(main.locator('details')).not.toHaveAttribute('open', '');
    await expect(main).not.toContainText(/Not in |Box not found/);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    answering = true;
    await main.getByRole('button', { name: 'Retry' }).click();
    await expect(h1(page)).toHaveText(BOX_NAME, { timeout: 15_000 });
    expect(await walletTouches(page)).toEqual([]);
  });

  test('the API refuses: Unavailable after one retry, a few words and Retry, the reason behind Details', async ({ page }, info) => {
    await open(page, (route) => route.abort('connectionrefused'));
    try {
      await expect(h1(page)).toHaveText('Unavailable', { timeout: 15_000 });
    } finally {
      await shot(page, info, 'unavailable-refused');
    }
    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: 'Retry' })).toBeVisible();
    await main.getByText('Details', { exact: true }).click();
    await expect(main.locator('details')).toContainText('V2 data unavailable');
    await shot(page, info, 'unavailable-details');
  });

  test('both feeds answered and the box is in neither: "Not in …", the one honest "not found"', async ({ page }, info) => {
    await open(page, (route, answer) => answer(route), `0x${'5'.repeat(40)}`);
    try {
      await expect(h1(page)).toHaveText(/^Not in /, { timeout: 15_000 });
    } finally {
      await shot(page, info, 'not-found');
    }
  });
});
