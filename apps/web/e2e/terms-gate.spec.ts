import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, walletTouches } from './m3-helpers';
import { NO_TERMS_ACCEPTANCE, TERMS_KEY, TERMS_VERSION } from './terms-state';

// SH-F entry terms gate (F19; UI-01, UI-03, UI-06, UI-09). Unlike every other spec, these start with clean storage:
// no accepted Terms.
test.use({ storageState: NO_TERMS_ACCEPTANCE });

const GATE = 'Before you enter Square Hole';
const CHECKBOX = 'I have read and agree to the Square Hole Terms of Use, and I confirm that I am at least 18 and not a Restricted User.';
const DECLINED = 'You need to accept the Terms of Use to use Square Hole. You can close this page, or go back and read them again.';
const FORBIDDEN = /\b(buy|sell|swap)\b/i;

const gate = (page: Page) => page.getByRole('dialog', { name: GATE });
const acceptButton = (page: Page) => gate(page).getByRole('button', { name: 'Accept', exact: true });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const storedRecord = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), TERMS_KEY);

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Into docs/evidence/screenshots/sh-v2-terms-v2 with SH_EVIDENCE_SCREENSHOTS=1, else into the test output. */
async function screenshot(page: Page, testInfo: TestInfo, what: string, fullPage = false) {
  const file = `SH-V2-terms-v2-${what}-${testInfo.project.name}.png`;
  const path =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/sh-v2-terms-v2/${file}`, import.meta.url))
      : testInfo.outputPath(file);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path, fullPage });
}

async function accept(page: Page) {
  await gate(page).getByRole('checkbox', { name: CHECKBOX }).check();
  await acceptButton(page).click();
  await expect(gate(page)).toHaveCount(0);
}

test('a first visit shows only the gate: no app behind it, no wallet touch, no overflow, the choice within reach', async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await installUntouchableWallet(page);
  await page.goto('/');
  await expect(gate(page)).toBeVisible();
  await expect(gate(page)).toHaveAttribute('aria-modal', 'true');
  await expect(gate(page).getByRole('heading', { level: 1, name: GATE })).toBeFocused();
  await expect(page.getByRole('main')).toHaveCount(0);
  await expect(page.getByRole('banner')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(gate(page)).toContainText('anyone in or from the US, Canada or the UK');
  await expect(gate(page)).toContainText('Draft Terms, not yet reviewed by a lawyer.');
  await expect(gate(page)).toContainText('Holding FIT pays you nothing.');
  await expect(gate(page)).toContainText(`Version ${TERMS_VERSION}`);
  await expect(gate(page).getByRole('link', { name: 'Read the full Terms of Use' })).toHaveAttribute('href', '/about/terms');
  await expect(acceptButton(page)).toBeDisabled();
  await expect(page).toHaveTitle('Before you enter · Square Hole');

  // UI-06: no sideways scroll; 16 px gutters on a phone; both buttons at least 44 px tall and on screen.
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const box = await gate(page).boundingBox();
  expect(box).not.toBeNull();
  if (box && testInfo.project.name === 'mobile') {
    expect(box.x).toBeGreaterThanOrEqual(15.5);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 15.5);
  }
  for (const name of ['Decline', 'Accept']) {
    const button = await gate(page).getByRole('button', { name, exact: true }).boundingBox();
    expect(button?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    expect((button?.y ?? 0) + (button?.height ?? 0), name).toBeLessThanOrEqual(viewport.height);
    expect((button?.x ?? 0) + (button?.width ?? 0), name).toBeLessThanOrEqual(viewport.width);
  }
  const checkbox = await gate(page).locator('label').filter({ hasText: CHECKBOX }).boundingBox();
  expect(checkbox?.height ?? 0).toBeGreaterThanOrEqual(44);

  // UI-01: the gate's own controls pass the no-trade audit.
  await expect(gate(page).getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
  await expect(gate(page).getByRole('link', { name: FORBIDDEN })).toHaveCount(0);
  const labels = await gate(page).locator('label, [aria-label]').evaluateAll((elements) =>
    elements.map((element) => `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`),
  );
  expect(labels.filter((text) => FORBIDDEN.test(text) || /amount/i.test(text))).toEqual([]);

  await screenshot(page, testInfo, 'gate');
  expect(await walletTouches(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('Escape does not dismiss; Accept needs the box; accepting stores only the version and time, sends nothing, and survives a reload', async ({ page }) => {
  const errors = trackErrors(page);
  await installUntouchableWallet(page);
  await page.goto('/?state=bonding&view=list');
  await expect(gate(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(gate(page)).toBeVisible();
  await expect(acceptButton(page)).toBeDisabled();
  expect(await storedRecord(page)).toBeNull();

  await gate(page).getByRole('checkbox', { name: CHECKBOX }).check();
  await expect(acceptButton(page)).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(gate(page)).toBeVisible();

  const origin = new URL(page.url()).origin;
  const requests: string[] = [];
  page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));
  await acceptButton(page).click();
  await expect(gate(page)).toHaveCount(0);
  // The page the visitor asked for opens, with its heading focused.
  await expect(page).toHaveURL(/\/\?state=bonding&view=list$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeFocused();
  await expect(page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');

  const stored = JSON.parse((await storedRecord(page)) ?? 'null') as { version: string; acceptedAt: string };
  expect(Object.keys(stored).sort()).toEqual(['acceptedAt', 'version']);
  expect(stored.version).toBe(TERMS_VERSION);
  expect(new Date(stored.acceptedAt).toISOString()).toBe(stored.acceptedAt);
  expect((await page.context().cookies()).map((cookie) => cookie.name)).toEqual([]);
  // Nothing leaves the page on accept: at most same-origin static files of the app.
  expect(requests.filter((request) => !request.startsWith(`GET ${origin}/`))).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Decline keeps the app closed and stores nothing; the terms can be reviewed again', async ({ page }, testInfo) => {
  await page.goto('/');
  await gate(page).getByRole('checkbox', { name: CHECKBOX }).check();
  await gate(page).getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(gate(page)).toContainText(DECLINED);
  await expect(gate(page).getByText(DECLINED)).toBeFocused();
  await expect(gate(page).getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await expect(page.getByRole('main')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await storedRecord(page)).toBeNull();
  expect(await page.context().cookies()).toEqual([]);
  await screenshot(page, testInfo, 'declined');

  // Tab stays inside the window.
  await page.keyboard.press('Tab');
  await expect(gate(page).getByRole('button', { name: 'Review the terms again' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(gate(page).getByRole('button', { name: 'Review the terms again' })).toBeFocused();

  await gate(page).getByRole('button', { name: 'Review the terms again' }).click();
  await expect(gate(page).getByRole('checkbox', { name: CHECKBOX })).not.toBeChecked();
  await expect(acceptButton(page)).toBeDisabled();
  await page.reload();
  await expect(gate(page)).toBeVisible();
});

test('keyboard: Tab cycles inside the gate and never reaches the page behind it', async ({ page }) => {
  await page.goto('/');
  await gate(page).getByRole('checkbox', { name: CHECKBOX }).check();
  const seen: string[] = [];
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => {
      const active = document.activeElement;
      const inside = Boolean(active?.closest('[role="dialog"]'));
      return `${inside ? 'in' : 'OUT'}:${active?.tagName ?? 'none'}:${active?.textContent?.trim().slice(0, 20) ?? ''}`;
    }));
  }
  expect(seen.filter((entry) => !entry.startsWith('in:'))).toEqual([]);
  expect(new Set(seen).size).toBe(5); // summary, full-terms link, checkbox, Decline, Accept
});

test('/about/terms is readable without accepting (both viewports) and shows the version the E2E pre-acceptance uses', async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await installUntouchableWallet(page);
  await page.goto('/about/terms');
  await expect(page.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText(`Version ${TERMS_VERSION} · Draft of`);
  await expect(page.getByRole('main')).toContainText('DRAFT pending legal review. It may change, and you will be asked to accept the final version.');
  await expect(page.getByRole('heading', { level: 2, name: '15. Disputes; class-action waiver; arbitration' })).toBeVisible();
  // The v2 model (F23–F30): lock/release vault, placeholders revealed later, the stream, no FIT-holder payouts.
  await expect(page.getByRole('main')).toContainText('Planned design (not deployed).');
  await expect(page.getByRole('main')).toContainText('FIT holders receive no payouts.');
  await expect(page.getByRole('main')).toContainText('Reveals happen later, in batches.');
  await expect(page.getByRole('main')).not.toContainText(/swap-back|tier price/i);
  // The 18 section cards are not landmarks; only the page and "Read this first" are named regions in main.
  await expect(page.getByRole('main').getByRole('region')).toHaveCount(2);

  // Before acceptance the frame has no wallet, launch or search controls, and nothing touches the wallet.
  const banner = page.getByRole('banner');
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0);
  await expect(banner.getByRole('link', { name: 'Launch pair' })).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Search boxes' })).toHaveCount(0);
  await page.locator('body').press('/');
  await expect(page).toHaveURL(/\/about\/terms$/);
  expect(await walletTouches(page)).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await screenshot(page, testInfo, 'terms-page');

  // A section link jumps to its section.
  await page.getByRole('navigation', { name: 'Contents' }).getByRole('link', { name: '5. The Services and how Square Hole works' }).click();
  await expect(page).toHaveURL(/\/about\/terms#terms-5$/);
  await expect(page.getByRole('heading', { level: 2, name: '5. The Services and how Square Hole works' })).toBeInViewport();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The footer links it next to About & risks; leaving for the app shows the gate.
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Terms of use' })).toHaveAttribute('href', '/about/terms');
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/about/privacy');
  await page.getByRole('main').getByRole('link', { name: 'Back to the feed' }).click();
  await expect(gate(page)).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('/about/privacy is readable without accepting (both viewports): what stays on the device, no wallet touch, no overflow', async ({ page }, testInfo) => {
  const errors = trackErrors(page);
  await installUntouchableWallet(page);
  await page.goto('/about/privacy');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveTitle('Privacy notice · Square Hole');
  const main = page.getByRole('main');
  await expect(main).toContainText('Square Hole has no accounts');
  await expect(main).toContainText('Our host sees your IP address with every page request');
  await expect(main).toContainText('Wallet addresses are public');
  await expect(main.getByRole('heading', { level: 2, name: 'What stays on your device' })).toBeVisible();
  await expect(main.locator('#privacy-device code')).toHaveText([
    'squarehole.terms',
    'squarehole.terms',
    'squarehole.settings.v1',
    'squarehole.data-source.v1',
    'squarehole.feed.pinCollapsed',
    'sh.wallet.last-rdns',
    'sh.wallet.connected.v1',
    'squarehole-chain-index',
    'sh.create.draft.v2',
    'sh.create.art.v2',
    'sh.create.cover.v2',
    // SH-192 af1 (c6ef497bf): the collection cover's tab-only copy.
    'sh.create.collection-cover.v2',
    'sh.create.page.v2',
    'sh.create.send.v2',
    // SH-192: the IndexedDB copy of each created box's reveal data.
    'sh.reveal.keep.v1',
    // SH-203: the reveal run's journal.
    'squarehole-reveal-run-v2',
    'sh.create.v2.arweave',
    'sh.create.set.v1',
    'sh.create.set-send.v1',
    'sh.boxes.sample-created.v1',
    'sh.sample-tx-scenario',
  ]);
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('button', { name: 'Connect wallet' })).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // Reading it stores nothing.
  expect(await storedRecord(page)).toBeNull();
  expect(await page.context().cookies()).toEqual([]);
  await screenshot(page, testInfo, 'privacy-page');

  await main.getByRole('link', { name: 'Terms of Use' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeVisible();
  await main.getByRole('link', { name: 'Back to the feed' }).click();
  await expect(gate(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test('from a deep link, the Terms lead back to the requested page, and accepting there opens it', async ({ page }) => {
  await page.goto('/?state=bonding&view=list');
  await gate(page).getByRole('link', { name: 'Read the full Terms of Use' }).click();
  await expect(page).toHaveURL(/\/about\/terms$/);
  const back = page.getByRole('main').getByRole('link', { name: 'Back to the page you opened' });
  await expect(back).toHaveAttribute('href', '/?state=bonding&view=list');
  await back.click();
  await expect(page).toHaveURL(/\/\?state=bonding&view=list$/);
  await accept(page);
  await expect(page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
});

test('the gate links to the full Terms; Back returns to the gate; About & risks stays open', async ({ page }) => {
  await page.goto('/');
  await gate(page).getByRole('link', { name: 'Read the full Terms of Use' }).click();
  await expect(page).toHaveURL(/\/about\/terms$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeFocused();
  await page.goBack();
  await expect(gate(page)).toBeVisible();

  await page.goto('/about/risks');
  await expect(page.getByRole('heading', { level: 1, name: 'About & risks' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an acceptance of another Terms version asks again', async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, JSON.stringify({ version: '2026-01-01-draft-0', acceptedAt: '2026-01-01T00:00:00.000Z' }));
  }, TERMS_KEY);
  await page.goto('/');
  await expect(gate(page)).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(0);
});

test('with localStorage blocked, acceptance is kept in a first-party cookie', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException('storage blocked by test', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', { get: blocked, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { get: blocked, configurable: true });
  });
  await page.goto('/');
  await expect(gate(page)).toBeVisible();
  await accept(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.map(({ name, path, sameSite, httpOnly }) => ({ name, path, sameSite, httpOnly }))).toEqual([
    { name: TERMS_KEY, path: '/', sameSite: 'Lax', httpOnly: false },
  ]);
  expect(JSON.parse(decodeURIComponent(cookies[0]?.value ?? '')).version).toBe(TERMS_VERSION);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('with localStorage and cookies blocked, the visitor still gets in for this page session', async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException('storage blocked by test', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', { get: blocked, configurable: true });
    Object.defineProperty(Document.prototype, 'cookie', { get: blocked, set: blocked, configurable: true });
  });
  await page.goto('/');
  await accept(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await page.reload();
  await expect(gate(page)).toBeVisible();
  expect(errors).toEqual([]);
});
