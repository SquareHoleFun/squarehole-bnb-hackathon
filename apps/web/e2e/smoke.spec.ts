import { expect, test } from '@playwright/test';

test('app boots without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  // SH-003 replaced the placeholder: the brand lives in the top bar; since the launch set the home is the box feed.
  await expect(page.getByRole('link', { name: 'Square Hole home' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  expect(errors).toEqual([]);
});
