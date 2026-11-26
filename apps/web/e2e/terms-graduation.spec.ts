import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, walletTouches } from './m3-helpers';
import { NO_TERMS_ACCEPTANCE, TERMS_KEY, TERMS_VERSION } from './terms-state';

// SH-V2-graduation review fixes (F40 L3; security review 2026-09-30): Terms draft-5. A visitor who accepted draft-4 is
// asked again, and /about/terms states the completion rule (5.6 (f): no buying pause, a completed curve can reopen),
// graduation (5.7 (a), (b)) and outside liquidity with the reduced fee share (5.7 (e)). Clean storage, like
// terms-gate.spec.ts.
test.use({ storageState: NO_TERMS_ACCEPTANCE });

const GATE = 'Before you enter Square Hole';
const DRAFT_4 = '2026-09-30-draft-4';

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

/** Into docs/evidence/screenshots/sh-v2-graduation with SH_EVIDENCE_SCREENSHOTS=1, else into the test output. */
async function screenshot(page: Page, testInfo: TestInfo, what: string, clip?: Clip) {
  const file = `SH-V2-graduation-${what}-${testInfo.project.name}.png`;
  const path =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/sh-v2-graduation/${file}`, import.meta.url))
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

// draft-6 since SH-V2-FE8 (F130: the sample data named for what it is): a draft-5 acceptance is asked again too; draft-7
// since SH-V2-FE11 (F135's reconnect in 5.2(c), the test boxes): a draft-6 acceptance as well.
const DRAFT_5 = '2026-09-30-draft-5';
const DRAFT_6 = '2026-10-11-draft-6';
for (const accepted of [DRAFT_4, DRAFT_5, DRAFT_6]) test(`a visitor who accepted ${accepted.slice(-7)} is asked again, and the gate shows draft-7`, async ({ page }, testInfo) => {
  await installUntouchableWallet(page);
  await page.addInitScript(
    ([key, version]) => {
      window.localStorage.setItem(key, JSON.stringify({ version, acceptedAt: '2026-09-30T08:00:00.000Z' }));
    },
    [TERMS_KEY, accepted] as const,
  );
  await page.goto('/');
  expect(TERMS_VERSION).toBe('2026-10-11-draft-7');
  await expect(gate(page)).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(0);
  await expect(gate(page)).toContainText(`Version ${TERMS_VERSION}`);
  await expect(gate(page)).not.toContainText(accepted);
  await expect(gate(page)).not.toContainText(/\bdemo\b/i);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await screenshot(page, testInfo, accepted === DRAFT_4 ? 'regate' : accepted === DRAFT_5 ? 'regate-draft-5' : 'regate-draft-6');
  expect(await walletTouches(page)).toEqual([]);
});

test('/about/terms states the completion rule, graduation and the reduced fee share plainly, with no buying pause', async ({ page }, testInfo) => {
  await installUntouchableWallet(page);
  await page.goto('/about/terms');
  await expect(page.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(`Version ${TERMS_VERSION} · Draft of 11 October 2026`);
  const curve = clause(page, '5.6');
  const graduation = clause(page, '5.7');
  await expect(curve).toContainText('The curve counts as complete when a block ends with the price at, or past, the target');
  await expect(curve).toContainText('the curve reopens');
  await expect(curve).toContainText('A completed curve is not sold out for good.');
  await expect(graduation).toContainText('From 32 blocks (about 6.4 minutes) after the block that completed the curve');
  await expect(graduation).toContainText('Outside liquidity.');
  await expect(graduation).toContainText('People who add liquidity keep the fees their liquidity collects.');
  await expect(graduation).toContainText('it is smaller when others add liquidity');
  await expect(page.getByRole('main')).not.toContainText(/buying pauses/i);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await curve.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'terms-5-6-to-5-7', await spanning(page.locator('#terms-5'), curve, graduation));
  expect(await walletTouches(page)).toEqual([]);
});
