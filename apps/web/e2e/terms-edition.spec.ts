import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, walletTouches } from './m3-helpers';
import { NO_TERMS_ACCEPTANCE, TERMS_KEY, TERMS_VERSION } from './terms-state';

// SH-V2-edition-4200 (F35, F40 L6; LCH-08): Terms draft-4. A visitor who accepted draft-3 is asked again, and
// /about/terms states the edition (5.5 (a)), the curve (5.6 (a)) and the pool share (5.7 (b)) with FitLaunchShape's
// figures. Starts with clean storage, like terms-gate.spec.ts.
test.use({ storageState: NO_TERMS_ACCEPTANCE });

const GATE = 'Before you enter Square Hole';
const DRAFT_3 = '2026-09-29-draft-3';

const gate = (page: Page) => page.getByRole('dialog', { name: GATE });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** One numbered clause of the Terms page (`TermsText.tsx` renders its number in `.sh-legal__n`). */
const clause = (page: Page, n: string) =>
  page.locator('.sh-legal__clause').filter({ has: page.locator('.sh-legal__n', { hasText: new RegExp(`^${n.replace('.', '\\.')}$`) }) });

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Into docs/evidence/screenshots/sh-v2-edition-4200 with SH_EVIDENCE_SCREENSHOTS=1, else into the test output. */
async function screenshot(page: Page, testInfo: TestInfo, what: string, clip?: Clip) {
  const file = `SH-V2-edition-4200-${what}-${testInfo.project.name}.png`;
  const path =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/sh-v2-edition-4200/${file}`, import.meta.url))
      : testInfo.outputPath(file);
  mkdirSync(dirname(path), { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot(clip ? { path, fullPage: true, clip } : { path });
}

/** The page-coordinate box from the top of `first` to the bottom of `last`, as wide as `card`, with a small margin. */
async function spanning(card: Locator, first: Locator, last: Locator): Promise<Clip> {
  const box = (locator: Locator) =>
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left + window.scrollX, top: rect.top + window.scrollY, width: rect.width, bottom: rect.bottom + window.scrollY };
    });
  const [c, a, b] = await Promise.all([box(card), box(first), box(last)]);
  const margin = 12;
  return { x: c.left, y: Math.max(0, a.top - margin), width: c.width, height: b.bottom - a.top + 2 * margin };
}

test('a visitor who accepted draft-3 is asked again, and the gate shows the current draft', async ({ page }, testInfo) => {
  await installUntouchableWallet(page);
  await page.addInitScript(
    ([key, version]) => {
      window.localStorage.setItem(key, JSON.stringify({ version, acceptedAt: '2026-09-29T12:00:00.000Z' }));
    },
    [TERMS_KEY, DRAFT_3] as const,
  );
  await page.goto('/');
  expect(TERMS_VERSION).not.toBe(DRAFT_3); // draft-4 at SH-V2-edition-4200, draft-5 since SH-V2-graduation, draft-6 since SH-V2-FE8
  await expect(gate(page)).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(0);
  await expect(gate(page)).toContainText(`Version ${TERMS_VERSION}`);
  await expect(gate(page)).not.toContainText(DRAFT_3);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await screenshot(page, testInfo, 'regate');
  expect(await walletTouches(page)).toEqual([]);
});

test('/about/terms states 4,200 Misfits, 798,137,969.32 FIT until exactly 4.206980085 ETH, and a pool share of 201,862,030.68 FIT', async ({ page }, testInfo) => {
  await installUntouchableWallet(page);
  await page.goto('/about/terms');
  await expect(page.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(`Version ${TERMS_VERSION} · Draft of 11 October 2026`);
  const edition = clause(page, '5.5');
  const curve = clause(page, '5.6');
  const graduation = clause(page, '5.7');
  await expect(edition).toContainText('(currently planned: 4,200 NFTs, each called a "Misfit")');
  await expect(curve).toContainText('(currently proposed: 798,137,969.32 FIT, just under 80%)');
  await expect(curve).toContainText('(currently proposed: exactly 4.206980085 ETH)');
  await expect(graduation).toContainText('The rest of the FIT supply (currently proposed: 201,862,030.68 FIT, just over 20%)');
  await expect(page.getByRole('main')).not.toContainText(/10,000 NFTs|currently proposed: (?:80|20)%/);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await edition.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'terms-5-5-to-5-7', await spanning(page.locator('#terms-5'), edition, graduation));
  expect(await walletTouches(page)).toEqual([]);
});
