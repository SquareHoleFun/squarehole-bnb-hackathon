/**
 * SH-252: the examples on the suite's edge (the test host's routes and the release's headers with the alpha switch
 * on, playwright.alpha-access.config.ts): a stranger meets the page lock at every examples address, as at every app
 * path; an approved tester needs no further sign-in, and the explainer's page works under the release's own CSP
 * (its scripts, styles, fonts and pictures all the site's own), with no request leaving the machine.
 */
import { expect, test } from '@playwright/test';
import { TESTERS, alphaContext, decide, lockAnswer, shot, signIn } from './helpers.mjs';

const PAGE = '/examples/index.html';
const LOCKED = ['/examples', '/examples/', PAGE, '/examples/pager.js', '/examples/follow.js', '/examples/follow/rent-free.js', '/examples/styles.css', '/examples/art/stage-crop-800x400.avif', '/examples/fonts/baloo-2-latin-800-normal.woff2', '/examples/missing.js'];

test('the page lock: a stranger gets the join page at every examples address, as at every app path', async ({ page }, testInfo) => {
  await alphaContext(page, testInfo);
  for (const path of LOCKED) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(303);
    expect(response.headers().location, path).toBe('/join');
  }
});

test('an approved tester opens the examples from the app with no further sign-in, under the release’s headers', async ({ page }, testInfo) => {
  const { baseURL, escaped, problems } = await alphaContext(page, testInfo, TESTERS.ada);
  await signIn(page);
  await decide(page, testInfo, TESTERS.ada.xId, 'approve');
  for (const path of ['/examples', '/examples/', PAGE, '/examples/follow.js']) expect(await lockAnswer(page, path), path).toBe(200);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/examples');
  await page.waitForURL(`${baseURL}${PAGE}`);
  // From here on the explainer's page alone (the app's own moment before it is the other specs' business). The
  // session cookie is Secure, so the page's own load is read, not one of Playwright's requests (helpers.mjs).
  const [escapedBefore, problemsBefore] = [escaped.length, problems.length];
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === PAGE);
  await page.reload();
  const headers = await (await answer).allHeaders();
  expect(headers['content-security-policy']).toContain("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['cache-control']).toBe('no-store');
  // The pictures stay a day in this browser only (config.mjs EXAMPLES_ART_CACHE); the page, scripts and fonts are no-store.
  const cacheOf = (path) => page.evaluate(async (target) => (await fetch(target, { cache: 'no-store', credentials: 'same-origin' })).headers.get('cache-control'), path);
  expect(await cacheOf('/examples/art/stage-crop-800x400.avif')).toBe('private, max-age=86400');
  expect(await cacheOf('/examples/follow.js')).toBe('no-store');
  expect(await cacheOf('/examples/fonts/baloo-2-latin-800-normal.woff2')).toBe('no-store');

  await expect(page.getByRole('heading', { level: 2, name: 'Basics' })).toBeVisible();
  const basics = page.locator('#basics-1');
  await basics.scrollIntoViewIfNeeded();
  await expect(basics).toHaveClass(/\bslide--follow\b/, { timeout: 20_000 });
  await basics.getByRole('button', { name: 'Next step' }).click();
  await expect(basics.locator('.bar__say:not(.is-off)')).toHaveText(/^1\/\d+ /);
  await page.getByRole('link', { name: 'Rent Free, Collection that burns' }).click();
  await expect(page.locator('#rent-free-1')).toHaveClass(/\bslide--follow\b/, { timeout: 20_000 });
  await shot(page, testInfo, 'examples-on-the-edge', null, { record: 'SH-252', screen: true });

  // Nothing refused by the release's CSP (scripts, styles, fonts, pictures), no page error, no request off the machine.
  expect(problems.slice(problemsBefore)).toEqual([]);
  expect(escaped.slice(escapedBefore)).toEqual([]);
  await expect(page.getByRole('link', { name: 'Launch a box' })).toHaveAttribute('href', '/create');
});

/** What this document downloaded so far, by the browser's own count (a picture from its cache weighs 0). */
const downloaded = (page) => page.evaluate(() => {
  const entries = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')];
  const pictures = entries.filter((entry) => new URL(entry.name).pathname.startsWith('/examples/art/'));
  return {
    bytes: entries.reduce((sum, entry) => sum + entry.transferSize, 0),
    requests: entries.length,
    pictures: pictures.length,
    picturesFromCache: pictures.filter((entry) => entry.transferSize === 0).length,
    pictureBytes: pictures.reduce((sum, entry) => sum + entry.transferSize, 0),
  };
});

test('a second visit within the day downloads no picture again, only the page and its no-store files', async ({ page }, testInfo) => {
  await alphaContext(page, testInfo, TESTERS.cy);
  await signIn(page);
  await decide(page, testInfo, TESTERS.cy.xId, 'approve');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Playwright turns the browser's cache off while a route is in place (alphaContext's guard against requests off the
  // machine): this test measures the cache, so it lifts the guard; the test above asserts that nothing leaves.
  await page.unrouteAll({ behavior: 'wait' });

  await page.goto(PAGE, { waitUntil: 'networkidle' });
  const first = await downloaded(page);
  await page.goto('/about/risks', { waitUntil: 'networkidle' });
  await page.goto(PAGE, { waitUntil: 'networkidle' });
  const second = await downloaded(page);

  const weights = { width: page.viewportSize()?.width ?? 0, first, second };
  testInfo.annotations.push({ type: 'visits', description: JSON.stringify(weights) });
  if (process.env.SH_EVIDENCE_SCREENSHOTS === '1') {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const folder = fileURLToPath(new URL('../../../../docs/evidence/SH-252/', import.meta.url));
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}visits-${weights.width}.json`, `${JSON.stringify(weights, null, 1)}\n`);
  }
  expect(first.pictures).toBeGreaterThan(0);
  expect(first.picturesFromCache).toBe(0);
  expect(second.pictures).toBe(first.pictures);
  expect(second.picturesFromCache).toBe(second.pictures);
  expect(second.pictureBytes).toBe(0);
  expect(second.bytes).toBeLessThan(first.bytes);
});
