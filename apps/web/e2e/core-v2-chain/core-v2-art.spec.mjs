import { expect, test } from '@playwright/test';
import { description, testWallet, boxPath, readLocalBox } from './helpers.mjs';

/** Real app acceptance: no injected images, intercepted art responses or synthesized feed records. */
async function decodedCover(scope) {
  const cover = scope.locator('.sh-box-cover');
  await expect(cover).toHaveCount(1);
  await expect(cover).toHaveAttribute('data-art', 'image');
  const img = cover.locator('img');
  await expect(img).toHaveCount(1);
  await img.scrollIntoViewIfNeeded();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate(async node => {
    try { await node.decode(); } catch { return false; }
    return node.complete && node.naturalWidth > 0 && node.naturalHeight > 0;
  })).toBe(true);
}

for (const [layout, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`LOCAL-ART-E2E ${layout}: every feed card and every box page decodes its cover`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const chain = description(); const wallet = await testWallet(page, chain);
    const expectedPaths = [];
    for (const coordinator of Object.values(chain.boxes)) {
      expectedPaths.push(boxPath(chain, (await readLocalBox(chain, coordinator)).token));
    }
    await page.goto('/');
    const links = page.locator('.sh-box-card a.sh-box-card__link[href^="/box/"]');
    // The genesis Misfits plus all nine v2 recipes. An art-rejected/missing row cannot silently pass.
    await expect(links).toHaveCount(expectedPaths.length + 1);
    const paths = await links.evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    for (const path of expectedPaths) expect(paths).toContain(path);
    for (let i = 0; i < paths.length; i += 1) await decodedCover(links.nth(i));
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await decodedCover(page.locator('main'));
    }
    expect(wallet.requests, 'viewing art never requests the wallet').toEqual([]);
  });
}
