import { expect, test, type Page } from '@playwright/test';

/**
 * SH-280 STEP 1: Flap's create screen in a browser without any wallet (the visitor who signed in with X on the site), in
 * the sign-in's three states, at 1440 and 390 px. The page reads the public chain 97 (read only, as it does on the site:
 * nothing is sent anywhere, there is no wallet); the site's sign-in service is played here (`/alpha/me`). Screenshots
 * go to the test's output.
 */
async function stand(page: Page, me: 'signed-out' | 'signed-in' | 'off') {
  await page.route('**/alpha/me', (route) => (me === 'off'
    ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Square Hole</title>' })
    : me === 'signed-out'
      ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'sign in required' }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'approved', handle: 'ada_builds', claim: null }) })));
}

for (const me of ['signed-out', 'signed-in', 'off'] as const) {
  test(`no wallet, the site's sign-in ${me}: the button's place says what to do`, async ({ page }, testInfo) => {
    await stand(page, me);
    const said: string[] = [];
    page.on('console', (m) => said.push(`${m.type()}: ${m.text().slice(0, 200)}`));
    page.on('pageerror', (e) => said.push(`error: ${String(e).slice(0, 300)}`));
    page.on('requestfailed', (r) => said.push(`failed: ${r.url().slice(0, 100)} ${r.failure()?.errorText}`));
    const report = () => console.warn(`[${me}] ${said.join(' | ')} || ${(await_body.value ?? '').slice(0, 600)}`);
    const await_body: { value: string | null } = { value: null };
    testInfo.setTimeout(120_000);
    try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await page.goto('./#/flap/create');
      const place = page.getByTestId('no-wallet').last();
      await expect(place).toBeVisible({ timeout: 30_000 });
      await expect(place).toContainText('No browser wallet was found in this browser.');
      // STEP 2 (the orchestrator's points): one place per screen says it; a visitor signed in with X but without a wallet
      // Privy made is led to the platform's "Set me up" (the test-coin page), not to the sign-in again.
      await expect(page.getByTestId('no-wallet')).toHaveCount(1);
      if (me === 'off') {
        await expect(page.getByRole('link', { name: 'Sign in with X' })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Set me up' })).toHaveCount(0);
      } else if (me === 'signed-out') {
        await expect(place.getByRole('link', { name: 'Sign in with X' })).toHaveAttribute('href', '/join');
        await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in with X' })).toHaveAttribute('href', '/join');
      } else {
        await expect(place.getByRole('link', { name: 'Set me up' })).toHaveAttribute('href', '/test-coins');
        await expect(page.getByRole('link', { name: 'Sign in with X' })).toHaveCount(0);
      }
      await page.getByTestId('no-wallet').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`flap-create-${me}-${width}.png`) });
    }
    } catch (e) {
      await_body.value = await page.locator('body').innerText().catch(() => null);
      await page.screenshot({ path: testInfo.outputPath('failed.png') }).catch(() => undefined);
      report();
      throw e;
    }
  });
}
