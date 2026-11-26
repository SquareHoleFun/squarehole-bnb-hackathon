import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// SH-252 in the browser, at 400 px (mobile project, its width set to 400) and 1440 px (desktop project): the app's
// /examples opens the explainer's own page (apps/web/public/examples, the generator's output with the /examples
// prefix); Basics step by step, one example opened from its tab, one part of its picture selected with its line; the
// way back to Create; every request stays on the app's origin; no wallet is touched and nothing can be typed; what a
// phone downloads on a first open and for one example. Reduced motion, so no slide plays by itself (follow.js: every
// step is then shown still). SH_EVIDENCE_SCREENSHOTS=1 writes the pictures and the weights to docs/evidence/SH-252/.
const EVIDENCE = process.env.SH_EVIDENCE_SCREENSHOTS === '1';
const PAGE = '/examples/index.html';
const width = (info: TestInfo) => (info.project.name === 'mobile' ? '400' : '1440');
const evidencePath = (info: TestInfo, file: string) => (EVIDENCE ? fileURLToPath(new URL(`../../../docs/evidence/SH-252/${file}`, import.meta.url)) : info.outputPath(file));

async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = evidencePath(info, `${name}-${width(info)}.png`);
  mkdirSync(dirname(path), { recursive: true });
  if ('goto' in target) await target.screenshot({ path, scale: 'css', animations: 'disabled' });
  else await target.screenshot({ path, scale: 'css', animations: 'disabled' });
}

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 400, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** Every request from now on, and the bytes of every answer. */
function traffic(page: Page) {
  const urls: string[] = [];
  const bodies: Promise<number>[] = [];
  page.on('request', (request) => urls.push(request.url()));
  page.on('response', (response) => bodies.push(response.body().then((body) => body.length, () => 0)));
  return { urls, bytes: async () => (await Promise.all(bodies)).reduce((sum, size) => sum + size, 0) };
}

/** A slide's follow bar is in place (follow.js has taken the slide over). */
const followed = (slide: Locator) => expect(slide).toHaveClass(/\bslide--follow\b/, { timeout: 15_000 });

/** One part of a slide's picture that shows on screen at its own middle: its name, id and that point. */
async function partOnScreen(slide: Locator) {
  await slide.locator('.slide__frame').scrollIntoViewIfNeeded();
  return slide.evaluate((figure) => {
    for (const spot of figure.querySelectorAll<HTMLButtonElement>('button.spot')) {
      const box = spot.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = box.width > 0 && y > 0 && y < window.innerHeight ? document.elementFromPoint(x, y) : null;
      if (hit instanceof HTMLElement && hit.dataset.spot === spot.dataset.spot) return { name: spot.getAttribute('aria-label') ?? '', spot: spot.dataset.spot ?? '', x, y };
    }
    return null;
  });
}

test('the app’s /examples: Basics step by step, an example from its tab, one part of its picture with its line, and the way back', async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.goto('/examples');
  await page.waitForURL((url) => url.pathname === PAGE);
  const origin = new URL(page.url()).origin;
  const seen = traffic(page);
  await page.reload();

  await expect(page.getByRole('heading', { level: 2, name: 'Basics' })).toBeVisible();
  const back = page.getByRole('link', { name: 'Launch a box' });
  await expect(back).toHaveAttribute('href', '/create');
  await expect(back).toBeVisible();
  await shot(page, info, 'examples-first-screen');

  // Basics: each of its six slides, its first step; the first one's "?" with its words.
  for (let n = 1; n <= 6; n += 1) {
    const slide = page.locator(`#basics-${n}`);
    await slide.scrollIntoViewIfNeeded();
    await followed(slide);
    await slide.getByRole('button', { name: 'Next step' }).click();
    await expect(slide.locator('.bar__say:not(.is-off)')).toHaveText(/^1\/\d+ /);
    if (n === 1) {
      await shot(slide, info, 'examples-basics-1-step-1');
      await slide.locator('summary[aria-label="In words"]').click();
      await expect(slide.locator('.slide__panel .slide__step')).toBeVisible();
      await slide.locator('summary[aria-label="In words"]').click();
    }
  }

  // An example from its tab: its page, its own slides file, its first picture's parts.
  await page.getByRole('link', { name: 'Rent Free, Collection that burns' }).click();
  await expect(page).toHaveURL(/#rent-free$/);
  const meet = page.locator('#rent-free-1');
  await followed(meet);
  const part = await partOnScreen(meet);
  expect(part, 'a part of Rent Free’s first picture shows on screen').not.toBeNull();
  if (!part) return;
  if (info.project.name === 'mobile') await page.touchscreen.tap(part.x, part.y);
  else await page.mouse.click(part.x, part.y);
  await expect(meet.locator(`button.spot[data-spot="${part.spot}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(meet.locator('.bar__part:not(.is-off) .bar__name')).toHaveText(`${part.name}.`);
  await shot(meet, info, 'examples-rent-free-part');

  // Only the app's own origin, the example's own slides file among them; no wallet asked; nothing to type; no sideways scroll.
  expect(seen.urls.filter((url) => new URL(url).origin !== origin)).toEqual([]);
  expect(seen.urls.some((url) => new URL(url).pathname === '/examples/follow/rent-free.js')).toBe(true);
  expect(await walletTouches(page)).toEqual([]);
  await expect(page.locator('input, textarea, select, iframe, embed, object')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // The way back: Create, in the app.
  await page.evaluate(() => window.scrollTo(0, 0));
  await back.click();
  await page.waitForURL((url) => url.pathname.startsWith('/create/'));
});

test('Back from the explainer returns to the app page the link was on, and stays there (no loop forward)', async ({ page }) => {
  await page.goto('/about/risks');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // An in-app link to /examples (Create's, SH-251) is a router navigation: the URL is pushed, then the route takes over.
  const pushed = await page.evaluate(() => {
    window.history.pushState({}, '', '/examples');
    window.dispatchEvent(new PopStateEvent('popstate'));
    return window.history.length;
  });
  await page.waitForURL((url) => url.pathname === PAGE);
  await expect(page.getByRole('heading', { level: 2, name: 'Basics' })).toBeVisible();
  // The route replaced its own entry: no entry was added on the way to the explainer.
  expect(await page.evaluate(() => window.history.length)).toBe(pushed);
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/about/risks');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Nothing sends the visitor forward again.
  await page.waitForTimeout(1_500);
  expect(new URL(page.url()).pathname).toBe('/about/risks');
});

test('what a first open and one example download, all from the app’s origin', async ({ page }, info) => {
  const seen = traffic(page);
  await page.goto(PAGE, { waitUntil: 'networkidle' });
  const origin = new URL(page.url()).origin;
  await expect(page.getByRole('heading', { level: 2, name: 'Basics' })).toBeVisible();
  const first = await seen.bytes();
  // Each page loads what it shows: no example's own slides file before an example comes near.
  const examples = () => seen.urls.map((url) => new URL(url).pathname).filter((path) => path.startsWith('/examples/follow/'));
  expect(examples()).toEqual([]);

  await page.getByRole('link', { name: 'Rent Free, Collection that burns' }).click();
  await followed(page.locator('#rent-free-1'));
  await page.waitForLoadState('networkidle');
  const example = (await seen.bytes()) - first;
  expect(examples()).toContain('/examples/follow/rent-free.js');
  expect(examples().filter((path) => /\/(?:link-marines|frog-kiln|paper-certificates|dragons-hoard|junkyard)\.js$/.test(path))).toEqual([]);

  const weights = { width: width(info), firstOpenBytes: first, oneExampleBytes: example, requests: seen.urls.length };
  info.annotations.push({ type: 'weight', description: JSON.stringify(weights) });
  if (EVIDENCE) writeFileSync(evidencePath(info, `weight-${width(info)}.json`), `${JSON.stringify(weights, null, 1)}\n`);
  expect(seen.urls.filter((url) => new URL(url).origin !== origin)).toEqual([]);
  expect(first).toBeLessThan(3_000_000);
  expect(example).toBeLessThan(3_000_000);
});
