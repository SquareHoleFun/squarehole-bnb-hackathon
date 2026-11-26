import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { LEGACY_OFF } from './legacy-off';
import { card, claimButton, connectAs, evidence, main, overflow, txPanel } from './m3-helpers';

// The logo loader (F51) in a real browser, at 1440x900 and 390x844: the 160 px page wait (the FIT pair page's own
// chunk held back), the 48 px card wait (account reads that never finish, ?scenario=loading), the live curve
// connecting and the live service catching up (local chain fixture, answered here), and the 16 px mark on a waiting
// transaction. Each loader keeps its fixed box, animates only transform and opacity, and is still under reduced motion.
// SH_EVIDENCE_SCREENSHOTS=1 writes the screenshots to docs/evidence/screenshots/SH-LOGO-LOADER-*.png.

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/fit-live-31337.json', import.meta.url)), 'utf8')) as {
  readonly head: string;
  readonly streams: Readonly<Record<'stale', string>>;
};
const LIVE = 'http://127.0.0.1:8598/**';
const RPC = 'http://127.0.0.1:8599/**';
const block = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Pauses every loader animation at the same moment (a cube on its way into the hole), so screenshots are stable. The
 * delayed fade-in (of a big loader or a whole waiting block) is finished first, so the frame is at full strength.
 */
async function holdFrame(page: Page, atMs = 420) {
  await page.evaluate((time) => {
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (!(target instanceof Element)) continue;
      if (animation instanceof CSSAnimation && animation.animationName === 'sh-loader-in') {
        animation.finish();
      } else if (target.closest('.sh-loader')) {
        animation.pause();
        animation.currentTime = time;
      }
    }
  }, atMs);
}

/** The CSS animation an element runs ("none" when it runs none). */
const animationName = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).animationName);

/** A loader's vertical centre against its line's first line of text (px), and the line's height against one line. */
async function firstLineFit(line: Locator) {
  return line.evaluate((element) => {
    const loader = element.querySelector('.sh-loader')?.getBoundingClientRect();
    const text = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (!loader || !text) return null;
    const range = document.createRange();
    range.selectNodeContents(text);
    const first = range.getClientRects()[0];
    if (!first) return null;
    const lineHeight = Number(getComputedStyle(element).lineHeight.replace('px', ''));
    return {
      offset: loader.top + loader.height / 2 - (first.top + first.height / 2),
      extra: element.getBoundingClientRect().height - lineHeight * range.getClientRects().length,
    };
  });
}

/** The loader animations running now, and every property they change. */
async function loaderMotion(page: Page) {
  return page.evaluate(() => {
    const animations = document.getAnimations().filter((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && target.closest('.sh-loader') !== null;
    });
    const properties = new Set<string>();
    for (const animation of animations) {
      for (const frame of (animation.effect as KeyframeEffect).getKeyframes()) {
        for (const key of Object.keys(frame)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) properties.add(key);
      }
    }
    return { count: animations.length, properties: [...properties].sort() };
  });
}

async function expectBox(loader: Locator, px: number) {
  const box = await loader.boundingBox();
  expect(box?.width).toBeCloseTo(px, 0);
  expect(box?.height).toBeCloseTo(px, 0);
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

test.describe('page and card waits', () => {
  test('the FIT pair page: a 160 px loader with one line while its code loads, then the page', async ({ page }, testInfo) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let chunk = '';
    await page.route(/\/assets\/FitPairPage-[^/]+\.js$/, async (route: Route) => {
      chunk = route.request().url();
      await held;
      await route.continue();
    });
    await page.goto('/fit-pair');
    const wait = main(page).locator('.sh-loader-wait[data-size="page"]');
    await expect(wait.getByRole('status')).toHaveText('Loading the FIT pair page…');
    expect(chunk).toMatch(/FitPairPage-/);
    const loader = wait.locator('.sh-loader');
    await expect(loader).toHaveAttribute('data-motion', 'allow');
    await expectBox(loader, 160);
    await expect(loader.locator('.sh-loader__shape')).toHaveCount(5);
    // The mark and its line fade in together after a beat, so a fast load flashes neither.
    expect(await animationName(wait)).toBe('sh-loader-in');
    expect(await animationName(loader)).toBe('none');
    // Only transform and opacity move.
    const motion = await loaderMotion(page);
    // The shapes, the glow and the flash (the fade-in may already be over).
    expect(motion.count).toBeGreaterThanOrEqual(7);
    expect(motion.properties).toEqual(['opacity', 'transform']);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await settle(page);
    await holdFrame(page);
    await evidence(page, testInfo, 'SH-LOGO-LOADER-page');
    release();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('FIT');
    await expect(wait).toHaveCount(0);
  });

  test('account reads that never finish: the 48 px loader and what is being read', async ({ page }, testInfo) => {
    // Claims (/rewards) held the only account read and the only sample-wallet transaction of this build.
    test.skip(true, LEGACY_OFF);
    await page.goto('/rewards?scenario=loading');
    await connectAs(page, 'Current holder');
    const panel = main(page).locator('.sh-account-loading');
    await expect(panel.getByRole('status')).toHaveText('Reading your claims…');
    const loader = panel.locator('.sh-loader');
    await expectBox(loader, 48);
    await expect(loader).toHaveAttribute('aria-hidden', 'true');
    await expect(loader.locator('.sh-loader__shape')).toHaveCount(5);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await settle(page);
    await holdFrame(page);
    await evidence(page, testInfo, 'SH-LOGO-LOADER-card', { locator: panel });
  });

  test('reduced motion: the still mark, no animation, the same box and words', async ({ page }, testInfo) => {
    // Claims (/rewards) held the only account read and the only sample-wallet transaction of this build.
    test.skip(true, LEGACY_OFF);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/rewards?scenario=loading');
    await connectAs(page, 'Current holder');
    const panel = main(page).locator('.sh-account-loading');
    await expect(panel.getByRole('status')).toHaveText('Reading your claims…');
    const loader = panel.locator('.sh-loader');
    await expect(loader).toHaveAttribute('data-motion', 'reduce');
    await expect(loader.locator('.sh-loader__shape, .sh-loader__flash')).toHaveCount(0);
    await expectBox(loader, 48);
    expect((await loaderMotion(page)).count).toBe(0);
    await settle(page);
    await evidence(page, testInfo, 'SH-LOGO-LOADER-card-reduced', { locator: panel });
  });

  test('a waiting transaction leads with the 16 px breathing mark', async ({ page }) => {
    // Claims (/rewards) held the only account read and the only sample-wallet transaction of this build.
    test.skip(true, LEGACY_OFF);
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    const orchard = card(page, 'ORCHARD');
    await claimButton(orchard).click();
    await expect(orchard.getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
    const mark = txPanel(orchard).locator('.sh-tx__title .sh-loader');
    await expect(mark).toHaveAttribute('data-size', 'button');
    await expectBox(mark, 16);
    // The status is said once, in words; the mark is not read out.
    await expect(txPanel(orchard).getByRole('status')).toHaveCount(1);
    await expect(mark).toHaveAttribute('aria-hidden', 'true');
    // When the wait ends, the plain mark takes the loader's 16 px box: the title does not move.
    const title = txPanel(orchard).locator('.sh-tx__title > span:last-child');
    const waitingX = (await title.boundingBox())?.x;
    await orchard.getByRole('button', { name: 'Reject' }).click();
    await expect(txPanel(orchard)).not.toHaveAttribute('data-tone', 'waiting');
    await expect(txPanel(orchard).locator('.sh-tx__title .sh-loader')).toHaveCount(0);
    await expectBox(txPanel(orchard).locator('.sh-tx__title .sh-tx__mark'), 10);
    expect((await title.boundingBox())?.x).toBeCloseTo(waitingX ?? Number.NaN, 1);
  });
});

test.describe('the live curve (local chain fixture)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' })));
  });

  const curve = (page: Page) => page.getByRole('region', { name: 'Bonding curve' });

  test('connecting: one 48 px loader in the curve (the chip keeps its still clock); the vault line leads with 16 px', async ({ page }, testInfo) => {
    // Nothing answers yet: the stream, the snapshot and the RPC stay pending.
    await page.route(LIVE, () => undefined);
    await page.route(RPC, () => undefined);
    await page.goto('/fit-pair');
    await expect(curve(page).locator('.sh-fit-chip')).toHaveText('Connecting');
    // One wait, one loader: the chip beside the curve's loader stays still.
    await expect(curve(page).locator('.sh-fit-chip .sh-loader')).toHaveCount(0);
    await expect(curve(page).locator('.sh-fit-chip .sh-glyph')).toHaveCount(1);
    await expect(curve(page).locator('.sh-loader')).toHaveCount(1);
    const empty = curve(page).locator('.sh-fit-empty');
    await expect(empty).toContainText('Connecting to the live curve…');
    await expectBox(empty.locator('.sh-loader'), 48);
    await expect(empty.locator('.sh-skeleton')).toHaveCount(0);
    // A line led by a small loader: the mark sits on the first line and the line keeps its height.
    const vault = main(page).locator('.sh-fit-vault__source.sh-loader-line');
    await expect(vault).toHaveText('Reading the vault…');
    await expectBox(vault.locator('.sh-loader'), 16);
    const fit = await firstLineFit(vault);
    expect(Math.abs(fit?.offset ?? Number.NaN)).toBeLessThanOrEqual(1);
    expect(fit?.extra ?? Number.NaN).toBeLessThanOrEqual(0.5);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await settle(page);
    await holdFrame(page);
    await evidence(page, testInfo, 'SH-LOGO-LOADER-curve-connecting', { locator: curve(page) });
    // Wrapped (a long line on a phone): the mark stays on the first line, not between the lines.
    await vault.evaluate((element) => void (element.style.width = '96px'));
    const wrapped = await firstLineFit(vault);
    expect(Math.abs(wrapped?.offset ?? Number.NaN)).toBeLessThanOrEqual(1);
    expect(wrapped?.extra ?? Number.NaN).toBeLessThanOrEqual(0.5);
    expect(await vault.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(30);
  });

  test('catching up: a wait with the breathing mark, not an alert', async ({ page }, testInfo) => {
    const stream = FIXTURE.streams.stale.replace('"reason":"no new block"', '"reason":"catching up"');
    expect(stream).toContain('"reason":"catching up"');
    await page.route(LIVE, async (route: Route) => {
      if (new URL(route.request().url()).pathname.endsWith('/stream')) {
        return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: stream });
      }
      return route.abort();
    });
    await page.route(RPC, (route) => route.abort());
    await page.goto('/fit-pair');
    await expect(curve(page).locator('.sh-fit-chip')).toHaveText(`Stale · since block ${block(FIXTURE.head)}`);
    const reason = curve(page).locator('.sh-fit-reason');
    await expect(reason).toHaveText('The live service is catching up with the chain.');
    await expect(reason).toHaveAttribute('data-catching-up', 'true');
    await expectBox(reason.locator('.sh-loader'), 16);
    await expect(reason.locator('.sh-glyph')).toHaveCount(0);
    await settle(page);
    await holdFrame(page, 1080);
    await evidence(page, testInfo, 'SH-LOGO-LOADER-curve-catching-up', { locator: curve(page) });
  });
});
