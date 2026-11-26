import { expect, test } from '@playwright/test';

/**
 * SH-280 STEP 3: the platform's frame around the launch pages, at 1440, 820, 390 and 360 px: the side bar (wide) or icon
 * rail (820) with the platform's entries and Launch current; on a phone the menu button with the same entries under the
 * bar; the bar fits (no sideways scroll, the mark at its full size). The page reads the public chain 97 read only; the
 * site's sign-in service is played here (signed out). Screenshots go to the test's output.
 */
const ENTRIES = ['Boxes', 'Launch', 'Test coins', 'Settings', 'About & risks'];

test('the frame at every width', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.route('**/alpha/me', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'sign in required' }) }));
  for (const [width, height] of [[1440, 900], [820, 1180], [390, 844], [360, 780]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('./#/flap/create');
    await expect(page.getByTestId('no-wallet')).toBeVisible({ timeout: 30_000 });
    const rail = page.getByTestId('rail');
    const menuButton = page.getByRole('button', { name: 'Menu' });
    if (width > 640) {
      await expect(rail).toBeVisible();
      await expect(menuButton).toBeHidden();
      await expect(rail.getByRole('link')).toHaveText(ENTRIES);
      await expect(rail.getByRole('link', { name: 'Launch' })).toHaveAttribute('aria-current', 'page');
      await expect(rail.getByRole('link', { name: 'Launch' })).toHaveAttribute('href', '/create');
    } else {
      await expect(rail).toBeHidden();
      await expect(menuButton).toBeVisible();
    }
    const footer = page.getByRole('contentinfo');
    await expect(footer).toContainText('BNB Chain testnet · Test tokens only · Not audited · Test trades only');
    await expect(footer.getByRole('link', { name: 'About & risks' })).toHaveAttribute('href', '/about/risks');
    await expect(footer.getByRole('link', { name: 'Test network notice' })).toHaveAttribute('href', '/about/terms');
    await expect(page.locator('.sh-topbar')).toHaveCSS('height', width <= 640 ? '56px' : '64px');
    if (width > 640) {
      await expect(rail).toHaveCSS('width', width <= 1024 ? '88px' : '192px');
      await expect(rail.getByRole('link').first()).toHaveCSS('min-height', width <= 1024 ? '56px' : '44px');
    }
    const fit = await page.evaluate(() => {
      const logo = document.querySelector('.sh-brand__logo')!.getBoundingClientRect();
      const bar = document.querySelector('.sh-topbar')!.getBoundingClientRect();
      const items = [...document.querySelectorAll('.sh-topbar > *, .sh-topbar__end > *')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
      return { scroll: document.documentElement.scrollWidth - window.innerWidth, logo: logo.width, inside: items.every((r) => r.right <= bar.right + 0.5 && r.left >= bar.left - 0.5) };
    });
    expect(fit.scroll).toBeLessThanOrEqual(0);
    expect(fit.logo).toBe(width <= 640 ? 32 : 40);
    expect(fit.inside).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`frame-${width}.png`) });
    if (width <= 640) {
      await menuButton.click();
      const menu = page.locator('#sh-primary-nav');
      await expect(menu.getByRole('link')).toHaveText(ENTRIES);
      await expect(menu.getByRole('link').first()).toHaveCSS('min-height', '48px');
      await expect(menu.getByRole('link', { name: 'Launch' })).toHaveAttribute('aria-current', 'page');
      await page.screenshot({ path: testInfo.outputPath(`frame-menu-${width}.png`) });
      await menuButton.click();
    }
  }
});
