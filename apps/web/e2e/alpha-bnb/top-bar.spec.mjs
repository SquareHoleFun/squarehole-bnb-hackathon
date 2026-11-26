/**
 * SH-277: the BNB site's top bar at 360, 390, 480, 640, 820 and 1440 px, in the three states the open-site alpha adds to it:
 * signed out (the sign-in entry in the bar's setup place), a "Set me up" run (its chip in that place) and a connected
 * browser wallet (beside the entry). In each: the brand's mark at its full size (32 px on a phone, 40 px wider), every
 * item of the bar inside the bar and none over another, no sideways scroll, and the entry a link to /join named
 * "Sign in with X" that a thumb can hit (the 44 px of the bar's other buttons). On a phone the entry is an icon; at
 * 820 and 1440 px it keeps its words. Screenshots of the bar go to the test's output (`bar-<state>-<width>.png`).
 */
import { expect, test } from '@playwright/test';
import { WORDS, alphaServer, localChain, problemsReport, sitePage, stack } from './helpers.mjs';

const WIDTHS = [360, 390, 480, 640, 820, 1440];
const HEIGHT = { 360: 780, 390: 844, 480: 900, 640: 900, 820: 1180, 1440: 900 };

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.warn(`[${testInfo.project.name}] ${testInfo.title.slice(0, 40)}: ${problemsReport(page)}`);
});

/** A browser wallet (EIP-6963) for chain 97 that answers only who it is: connecting it asks nothing else. */
async function browserWallet(page) {
  await page.addInitScript(() => {
    const account = '0x00000000000000000000000000000000000a1b2c';
    const provider = {
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'eth_chainId') return '0x61';
        if (method === 'wallet_switchEthereumChain') return null;
        throw Object.assign(new Error(`not answered: ${method}`), { code: 4200 });
      },
      on() {}, removeListener() {},
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '0b3c9a52-6f0e-4e1a-9a55-2f1d7e4c8b61', name: 'Bar test wallet', rdns: 'org.example.bar-test', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
    })));
  });
}

/** The bar's measurements: its items' boxes (left to right), the mark's size, the page's sideways scroll. */
async function measure(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.sh-topbar');
    const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const leaves = [...bar.querySelectorAll('.sh-topbar__menu, .sh-brand__logo, .sh-brand__text, .sh-search-trigger, .sh-topbar__setup > *, .sh-source-badge, .sh-wallet-button')]
      .filter((el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => ({ name: el.className.split(' ')[0], ...box(el) }))
      .sort((a, b) => a.left - b.left);
    const logo = bar.querySelector('.sh-brand__logo');
    return { bar: box(bar), leaves, logo: logo ? box(logo) : null, scroll: document.documentElement.scrollWidth - window.innerWidth };
  });
}

function fits(m, width) {
  console.warn(`[bar ${width}] mark ${m.logo?.width}px, scroll ${m.scroll}, items ${m.leaves.map((leaf) => `${leaf.name} ${Math.round(leaf.left)}-${Math.round(leaf.right)}`).join(', ')}`);
  expect(m.scroll, 'no sideways scroll').toBeLessThanOrEqual(0);
  expect(m.logo?.width, 'the mark at its full size').toBe(width <= 640 ? 32 : 40);
  for (const leaf of m.leaves) {
    expect(leaf.left, `${leaf.name} inside the bar`).toBeGreaterThanOrEqual(m.bar.left - 0.5);
    expect(leaf.right, `${leaf.name} inside the bar`).toBeLessThanOrEqual(m.bar.right + 0.5);
  }
  for (let i = 1; i < m.leaves.length; i += 1) {
    const [a, b] = [m.leaves[i - 1], m.leaves[i]];
    // The brand's text sits beside its mark; any two items side by side may not overlap.
    expect(b.left, `${a.name} and ${b.name} do not overlap`).toBeGreaterThanOrEqual(a.right - 0.5);
  }
}

async function entryChecks(page, width) {
  const entry = page.getByRole('banner').getByRole('link', { name: WORDS.entry });
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute('href', '/join');
  const size = await entry.boundingBox();
  expect(size.height).toBeGreaterThanOrEqual(44);
  expect(size.width).toBeGreaterThanOrEqual(44);
  // Words at 820 and 1440 px; an icon on a phone, the words kept as the link's name.
  await expect(page.locator('.sh-topbar__join-icon')).toBeVisible({ visible: width <= 640 });
  const shown = await page.locator('.sh-topbar__join-text').evaluate((el) => el.getBoundingClientRect().width > 2);
  expect(shown).toBe(width > 640);
}

async function shot(page, testInfo, state, width) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`bar-${state}-${width}.png`), clip: { x: 0, y: 0, width, height: Math.min(160, HEIGHT[width]) } });
}

test.describe('the top bar (SH-277)', () => {
  test('signed out: the entry and the mark fit at every width', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the widths are set here, once');
    const s = stack();
    await alphaServer(page, { signedIn: false });
    await sitePage(page, s, { signedIn: false });
    await localChain(page, s);
    await page.goto('/');
    await expect(page.getByRole('banner').getByRole('link', { name: WORDS.entry })).toBeVisible({ timeout: 120_000 });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT[width] });
      fits(await measure(page), width);
      await entryChecks(page, width);
      await shot(page, testInfo, 'signed-out', width);
    }
  });

  test('signed out with a connected browser wallet: the entry, the wallet and the mark fit', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the widths are set here, once');
    const s = stack();
    await alphaServer(page, { signedIn: false });
    await sitePage(page, s, { signedIn: false });
    await localChain(page, s);
    await browserWallet(page);
    await page.goto('/');
    await expect(page.getByRole('banner').getByRole('link', { name: WORDS.entry })).toBeVisible({ timeout: 120_000 });
    await page.locator('.sh-wallet-button').click();
    const dialog = page.getByRole('dialog', { name: 'Connect a browser wallet' });
    await dialog.getByRole('button', { name: /Bar test wallet/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.sh-wallet-button')).toContainText('0x0000');
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT[width] });
      fits(await measure(page), width);
      await entryChecks(page, width);
      await shot(page, testInfo, 'wallet', width);
    }
  });

  test('a Set me up run: its chip in the entry’s place, and the mark fit', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the widths are set here, once');
    const s = stack();
    await alphaServer(page, { signedIn: true });
    await sitePage(page, s, { signedIn: true });
    await localChain(page, s);
    await page.goto('/');
    const sheet = page.getByRole('region', { name: WORDS.title });
    await sheet.getByRole('button', { name: WORDS.start }).click({ timeout: 120_000 });
    // The run waits for the starter (the test sends none): its chip stays in the bar.
    await expect(page.locator('.sh-setup-chip')).toBeVisible({ timeout: 60_000 });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT[width] });
      await expect(page.getByRole('banner').getByRole('link', { name: WORDS.entry })).toHaveCount(0);
      const chip = await page.locator('.sh-setup-chip__button').boundingBox();
      expect(chip.height).toBeGreaterThanOrEqual(44);
      fits(await measure(page), width);
      await shot(page, testInfo, 'chip', width);
    }
  });
});
