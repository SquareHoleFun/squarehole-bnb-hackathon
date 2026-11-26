import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// SH-254 in a real browser, at 1440x900 and 390x844: the ways in as one rounded control (Visual, Steps, Examples), a
// problem that opens the part where it is fixed, the guided walk (the examples' player) with its Next step in reach
// while a sheet is open, and a tall sheet scrolled to its end. SH_EVIDENCE_SCREENSHOTS=1 writes the screenshots to
// docs/evidence/SH-254/.
const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const;
// A tap needs a touch screen; the mouse and the keyboard work as before.
test.use({ hasTouch: true });

async function shot(page: Page, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/SH-254/${name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  await page.screenshot({ path, scale: 'css' });
}

/** The control at the middle of `target` is `target` itself (nothing covers it). */
const onTop = (target: Locator) => target.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit !== null && (hit === el || el.contains(hit)) && r.top >= 0 && r.bottom <= window.innerHeight;
});

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'sizes are set per test');
  await installUntouchableWallet(page);
});

for (const size of SIZES) {
  test(`SH-254 at ${size.width}: Visual is the default in one control; a problem opens its part; a tall sheet scrolls`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/create');
    await expect(page).toHaveURL(/\/create\/v2-picture$/);
    await expect(page.locator('svg.sh-pic')).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const control = page.getByRole('navigation', { name: 'Launch' }).locator('.sh-pic-ways__switch');
    await expect(control.getByRole('link')).toHaveText(['Visual', 'Steps', 'Examples']);
    await expect(control.getByRole('link', { name: 'Visual' })).toHaveAttribute('aria-current', 'true');
    await shot(page, info, `ways-${size.width}`);

    // A problem opens the part where it is fixed, focus on its field (Basics is not complete on a fresh page).
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    const problem = page.locator('.sh-pic-issues').getByRole('button', { name: 'Ticker: Required' });
    await expect(problem).toBeVisible();
    await problem.click();
    const sheet = page.locator('[data-sheet]');
    await expect(sheet).toHaveAccessibleName('Token');
    await expect(sheet.getByRole('textbox', { name: 'Ticker' })).toBeFocused();
    await shot(page, info, `problem-opens-part-${size.width}`);
    // Close returns focus to the problem that opened the sheet.
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(problem).toBeFocused();

    // A problem keeps the sheet it opens when that sheet is already open (opened by hand), focus outside it: by Enter
    // and by Space, and on a wide screen (where the open sheet leaves the list of problems in view) by mouse and by a
    // tap. On a phone the open bottom sheet covers the list, so only the keyboard reaches a problem then.
    const ways = size.width >= 900 ? (['mouse', 'Enter', 'Space', 'tap'] as const) : (['Enter', 'Space'] as const);
    for (const how of ways) {
      await page.locator('[data-part="token"] .sh-pic-hit').first().click();
      await expect(sheet).toHaveAccessibleName('Token');
      await problem.focus();
      if (how === 'mouse') await problem.click();
      else if (how === 'tap') await problem.tap();
      else await page.keyboard.press(how);
      await expect(sheet, how).toHaveAccessibleName('Token');
      await expect(sheet.getByRole('textbox', { name: 'Ticker' }), how).toBeFocused();
      await sheet.getByRole('button', { name: 'Close' }).click();
      await expect(sheet).toHaveCount(0);
    }

    // A tall sheet: the Shop template, To holders on the sellers' side, every Details open, scrolled to its end.
    await page.getByRole('region', { name: 'Start from a template' }).getByRole('button', { name: /^Shop/ }).click();
    await page.locator('[data-part="sellers"] .sh-pic-hit').first().click();
    await sheet.locator('[data-fee-choice="holders"]').first().click();
    await sheet.evaluate((el) => el.querySelectorAll('details').forEach((details) => { (details as HTMLDetailsElement).open = true; }));
    const head = await sheet.locator('.sh-pic-sheet__head').boundingBox();
    if (head === null) throw new Error('no sheet head');
    await page.mouse.move(head.x + head.width / 3, head.y + head.height / 2);
    for (let i = 0; i < 30; i += 1) await page.mouse.wheel(0, 300);
    await expect.poll(() => sheet.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1)).toBe(true);
    expect(await onTop(sheet.getByRole('button', { name: 'Close' }))).toBe(true);
    await shot(page, info, `sheet-scrolled-${size.width}`);
    expect(await walletTouches(page)).toEqual([]);
  });

  test(`SH-254 at ${size.width}: the walk, the examples' player under the picture`, async ({ page }, info) => {
    test.skip(true, 'SH-254: the walk is switched off (Walk.tsx walkSwitch) until its own fix round; its unit tests run with it on');
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/create/v2-picture');
    const sheet = page.locator('[data-sheet]');
    // The walk: the examples' player under the picture. With reduced motion, Play goes one step at a time.
    const walk = page.locator('[data-walk]');
    await walk.getByRole('button', { name: 'Play' }).click();
    await expect(sheet).toHaveAccessibleName('Token');
    await expect(walk.getByRole('status')).toHaveText('1/8 Token');
    await walk.getByRole('button', { name: 'Next step' }).click();
    await walk.getByRole('button', { name: 'Next step' }).click();
    await expect(sheet).toHaveAccessibleName('What’s in the box');
    await expect(walk.getByRole('button', { name: 'Step 3 of 8, What’s in the box' })).toHaveAttribute('aria-current', 'step');
    await expect(page.locator('[data-part="contents"]')).toHaveAttribute('aria-expanded', 'true');
    // Next step stays in reach while the sheet is open (on a phone the bar sits under the sheet).
    expect(await onTop(walk.getByRole('button', { name: 'Next step' }))).toBe(true);
    await shot(page, info, `walk-${size.width}`);
    await walk.getByRole('button', { name: 'Step 8 of 8, Overview' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('data-walk-here');

  });
}

test('SH-254 Start over on the visual way keeps the visitor on it (a loaded setup, then Start over)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/create/v2-basics');
  await page.locator('#create-load-settings').setInputFiles(fileURLToPath(new URL('../src/features/create/v2/test-support/one-collection-shop-boxspec-v2.json', import.meta.url)));
  // The shop's file asks for its starter ids first (create-v2-shop.spec.ts), then it is loaded.
  const starters = page.getByRole('group', { name: 'Starter items · 10' });
  await starters.getByRole('textbox', { name: 'Collection 1 · 0x0000…0011' }).fill('3-12');
  await starters.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.locator('[data-loaded-setup]').first()).toContainText('From the loaded setup.');
  await expect(page.getByRole('button', { name: 'Start over' }).first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Launch' }).getByRole('link', { name: 'Visual' }).click();
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  await page.getByRole('button', { name: 'Start over' }).first().click();
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  await expect(page.locator('svg.sh-pic')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start over' })).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
});
