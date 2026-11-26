import { expect, test, type Page } from '@playwright/test';
import { C2PA_FIXTURES, caBX, pngStore, readC2paFixture } from '../../../packages/artwork/src/test-support/c2pa';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { installUntouchableWallet } from './box-helpers';

// SH-ACCEPT-C2PA (founder decision 2026-10-24): pictures made by AI tools (ChatGPT / GPT Image) are accepted as they are,
// C2PA "content credentials" included. In a real browser: a real AI picture as the logo and as the collection cover
// (both re-drawn from pixels by the page), and as an item with others that carry each real store (items as uploaded).

const main = (page: Page) => page.getByRole('main');
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });
const upload = (name: string, bytes: Uint8Array) => ({ name, mimeType: 'image/png', buffer: Buffer.from(bytes) });

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('AI pictures with C2PA content credentials are accepted as the logo, the collection cover and items', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/create/v2-basics');
  await page.getByRole('textbox', { name: 'Name' }).fill('Credentials');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('CRED');
  await page.locator('#create-logo').setInputFiles(upload('logo-original.png', readC2paFixture('junkyard-logo')));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached({ timeout: 30_000 });
  await expect(main(page)).not.toContainText(/polyglot|hides web markup/i);
  await next(page).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  await page.getByRole('radio', { name: /^New collection/ }).check();
  // Item 1 is a real AI picture under one raw block; items 2-7 are small pictures carrying each fixture's real store.
  const fitting = C2PA_FIXTURES.find((fixture) => fixture.bytes <= 1_048_576);
  if (!fitting) throw new Error('no fixture fits one raw block');
  const items = [
    upload('1.png', readC2paFixture(fitting.name)),
    ...C2PA_FIXTURES.map((fixture, i) => upload(`${i + 2}.png`, makePng({ width: 32 + i, height: 32, decodable: true, before: [caBX(pngStore(readC2paFixture(fixture.name)))] }))),
  ];
  await page.getByLabel('Images + traits').setInputFiles(items);
  await expect(main(page).getByRole('status').filter({ hasText: /items/ })).toHaveText(`${items.length} items · 0 traits`, { timeout: 30_000 });
  await expect(main(page).getByRole('list', { name: 'Art problems' })).toHaveCount(0);
  await page.locator('#create-collection-cover').setInputFiles(upload('cover-original.png', readC2paFixture('rent-free-cover')));
  await expect(page.getByRole('button', { name: /^Collection cover Change/ })).toBeAttached({ timeout: 30_000 });
  await expect(main(page)).not.toContainText(/polyglot|hides web markup/i);
  expect(errors).toEqual([]);
});
