import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** The lazy three.js chunk emitted for sorterScene.ts. */
const CHUNK = /\/assets\/sorterScene-[\w-]+\.js$/;
const ALLOW_SOFTWARE = process.env.SCENE_E2E_ALLOW_SOFTWARE === '1';
const QUIET_MS = 3000;

interface Probe {
  rafRequests: number;
  rafCallbacks: number;
  draws: number;
  cls: number;
}

/** Counts rAF requests/callbacks, WebGL draw calls and layout shifts from before any page script runs. */
function instrument(): void {
  const w = window as unknown as { __probe: Probe };
  w.__probe = { rafRequests: 0, rafCallbacks: 0, draws: 0, cls: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    w.__probe.rafRequests += 1;
    return raf((t) => {
      w.__probe.rafCallbacks += 1;
      callback(t);
    });
  };
  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, unknown>;
  for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = function (this: unknown, ...args: unknown[]) {
      w.__probe.draws += 1;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const shift = entry as unknown as { value: number; hadRecentInput: boolean };
      if (!shift.hadRecentInput) w.__probe.cls += shift.value;
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => ({ ...(window as unknown as { __probe: Probe }).__probe }));

function trackChunk(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (request) => {
    if (CHUNK.test(new URL(request.url()).pathname)) hits.push(request.url());
  });
  return hits;
}

const lab = (query: string, allowSoftware = ALLOW_SOFTWARE): string =>
  `lab.html?${query}${allowSoftware ? '&allowSoftware=1' : ''}`;

const accent = (page: Page, variant: 'pin' | 'wizard' = 'pin'): Locator => page.locator(`[data-scene-variant="${variant}"]`);

async function expectSettled(target: Locator): Promise<void> {
  // A GPU-less machine reports data-scene-reason="software-renderer" here; see SCENE_E2E_ALLOW_SOFTWARE.
  await expect(target).toHaveAttribute('data-scene-phase', 'live', { timeout: 20_000 });
  await expect(target).toHaveAttribute('data-scene-settled', 'true', { timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(instrument);
});

test('poster paints first; three.js is fetched lazily after first paint, load and idle', async ({ page, request }) => {
  const hits = trackChunk(page);
  const html = await (await request.get('lab.html')).text();
  expect(html, 'no modulepreload/script for the lazy chunk').not.toMatch(/sorterScene/);

  await page.goto(lab('variant=pin'));
  const pin = accent(page);
  await expect(pin.locator('img')).toBeVisible();
  await expectSettled(pin);

  const timing = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const chunk = resources.find((r) => /sorterScene-/.test(r.name));
    const poster = resources.find((r) => /shape-sorter-pin/.test(r.name));
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return {
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      loadEnd: nav?.loadEventEnd ?? null,
      posterEnd: poster?.responseEnd ?? null,
      chunkStart: chunk?.startTime ?? null,
    };
  });
  expect(hits).toHaveLength(1);
  expect(timing.fcp).not.toBeNull();
  expect(timing.chunkStart ?? 0).toBeGreaterThan(timing.fcp ?? Infinity);
  expect(timing.chunkStart ?? 0).toBeGreaterThan(timing.posterEnd ?? Infinity);
  expect(timing.chunkStart ?? 0).toBeGreaterThanOrEqual(timing.loadEnd ?? Infinity);
  process.stdout.write(`SH-008 load timing (ms since navigation): ${JSON.stringify(timing)}\n`);
});

test('renders on demand: the loop stops after the sequence (0 rAF callbacks, 0 draws over 3s)', async ({ page }) => {
  await page.goto(lab('variant=pin'));
  const pin = accent(page);
  await expectSettled(pin);
  const settled = await probe(page);
  await page.waitForTimeout(QUIET_MS);
  const later = await probe(page);

  const metrics = {
    sequenceFrames: Number(await pin.getAttribute('data-scene-frames')),
    rafCallbacksUntilSettle: settled.rafCallbacks,
    drawCallsUntilSettle: settled.draws,
    rafCallbacksAfterSettle: later.rafCallbacks - settled.rafCallbacks,
    rafRequestsAfterSettle: later.rafRequests - settled.rafRequests,
    drawCallsAfterSettle: later.draws - settled.draws,
    quietWindowMs: QUIET_MS,
    cls: later.cls,
  };
  await writeFile(test.info().outputPath('render-metrics.json'), JSON.stringify(metrics, null, 2));
  process.stdout.write(`SH-008 render metrics: ${JSON.stringify(metrics)}\n`);

  expect(metrics.sequenceFrames).toBeGreaterThan(30);
  expect(metrics.rafCallbacksAfterSettle).toBe(0);
  expect(metrics.rafRequestsAfterSettle).toBe(0);
  expect(metrics.drawCallsAfterSettle).toBe(0);
});

test('a resize after settle redraws on demand without restarting a loop', async ({ page }) => {
  await page.goto(lab('variant=pin'));
  const pin = accent(page);
  await expectSettled(pin);
  const before = await probe(page);
  const widthBefore = (await pin.boundingBox())?.width;
  await page.setViewportSize({ width: 400, height: 800 });
  await expect.poll(async () => (await pin.boundingBox())?.width).not.toBe(widthBefore);
  await page.waitForTimeout(1000);
  const after = await probe(page);
  expect(after.draws - before.draws, 'redrawn for the new size').toBeGreaterThan(0);
  expect(after.rafCallbacks - before.rafCallbacks, 'no animation frames').toBe(0);
  const bufferWidth = await pin.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width);
  expect(bufferWidth).toBe(Math.round((await pin.boundingBox())?.width ?? 0));
});

test('no layout shift when the canvas replaces the poster', async ({ page }) => {
  await page.goto(lab(''));
  const pin = accent(page);
  const wizard = accent(page, 'wizard');
  const before = [await pin.boundingBox(), await wizard.boundingBox()];
  await expectSettled(pin);
  await expectSettled(wizard);
  expect([await pin.boundingBox(), await wizard.boundingBox()]).toEqual(before);
  expect((await probe(page)).cls).toBe(0);
  const pinBox = before[0];
  expect(pinBox && Math.round((pinBox.width / pinBox.height) * 100) / 100).toBeCloseTo(36 / 17, 1);
  await page.screenshot({ path: test.info().outputPath('lab-live-settled.png') });
});

test('Replay is a keyboard-reachable button that plays once and stops again', async ({ page }) => {
  await page.goto(lab('variant=pin'));
  const pin = accent(page);
  await expectSettled(pin);
  const replay = page.getByRole('button', { name: 'Replay shape-sorter animation' });
  await page.keyboard.press('Tab');
  await expect(replay).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pin).toHaveAttribute('data-scene-settled', 'false');
  await expect(pin).toHaveAttribute('data-scene-settled', 'true', { timeout: 20_000 });
  const settled = await probe(page);
  await page.waitForTimeout(1500);
  expect((await probe(page)).rafCallbacks - settled.rafCallbacks).toBe(0);
});

test('offscreen: no download until scrolled into view; pauses when scrolled away mid-sequence', async ({ page }) => {
  const hits = trackChunk(page);
  await page.goto(lab('variant=pin&offset=2400'));
  const pin = accent(page);
  await page.waitForTimeout(2000);
  await expect(pin).toHaveAttribute('data-scene-phase', 'poster');
  expect(hits).toHaveLength(0);

  await pin.scrollIntoViewIfNeeded();
  await expect(pin).toHaveAttribute('data-scene-phase', 'live', { timeout: 20_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300); // let the in-flight frame and the observer callback land
  const paused = await probe(page);
  await page.waitForTimeout(1000);
  expect((await probe(page)).rafCallbacks - paused.rafCallbacks).toBe(0);
  await expect(pin).toHaveAttribute('data-scene-settled', 'false');

  await pin.scrollIntoViewIfNeeded();
  await expect(pin).toHaveAttribute('data-scene-settled', 'true', { timeout: 20_000 });
  expect(hits).toHaveLength(1);
});

test('WebGL context loss falls back to the poster', async ({ page }) => {
  await page.goto(lab('variant=pin'));
  const pin = accent(page);
  await expectSettled(pin);
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-scene-variant="pin"] canvas') as HTMLCanvasElement | null;
    const gl = canvas?.getContext('webgl2');
    (gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  });
  await expect(pin).toHaveAttribute('data-scene-phase', 'fallback');
  await expect(pin).toHaveAttribute('data-scene-reason', 'context-lost');
  await expect(pin.locator('canvas')).toHaveCount(0);
  await expect(pin.locator('img')).toBeVisible();
  await expect(pin.locator('img')).not.toHaveAttribute('data-hidden', 'true');
});

test('unmount releases the renderer: canvas detached, GL context lost, no further frames', async ({ page }) => {
  await page.goto(lab('variant=pin'));
  await expectSettled(accent(page));
  const result = await page.evaluate(async () => {
    const w = window as unknown as { __sceneLabUnmount?: () => void; __probe: Probe };
    const canvas = document.querySelector('[data-scene-variant="pin"] canvas') as HTMLCanvasElement | null;
    const gl = canvas?.getContext('webgl2') ?? null;
    w.__sceneLabUnmount?.();
    const rafBefore = w.__probe.rafCallbacks;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      hadCanvas: canvas !== null,
      connected: canvas?.isConnected ?? null,
      contextLost: gl?.isContextLost() ?? null,
      rafAfterUnmount: w.__probe.rafCallbacks - rafBefore,
    };
  });
  expect(result).toEqual({ hadCanvas: true, connected: false, contextLost: true, rafAfterUnmount: 0 });
});

test.describe('high-density screen', () => {
  test.use({ deviceScaleFactor: 3 });

  test('caps the drawing buffer at 1.5x device pixels', async ({ page }) => {
    await page.goto(lab('variant=pin'));
    const pin = accent(page);
    await expectSettled(pin);
    const size = await pin.locator('canvas').evaluate((c: HTMLCanvasElement) => ({
      dpr: window.devicePixelRatio,
      cssWidth: c.getBoundingClientRect().width,
      bufferWidth: c.width,
    }));
    expect(size.dpr).toBe(3);
    expect(size.bufferWidth).toBe(Math.round(Math.round(size.cssWidth) * 1.5));
  });
});

test.describe('prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' });

  test('never requests the three.js chunk and keeps both posters', async ({ page }) => {
    const hits = trackChunk(page);
    await page.goto(lab(''));
    for (const variant of ['pin', 'wizard'] as const) {
      const target = accent(page, variant);
      await expect(target).toHaveAttribute('data-scene-phase', 'fallback');
      await expect(target).toHaveAttribute('data-scene-reason', 'reduced-motion');
      await expect(target.locator('img')).toBeVisible();
      expect(await target.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    }
    await page.waitForTimeout(2500); // well past load + idle
    expect(hits).toHaveLength(0);
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('lab-reduced-motion-posters.png') });
  });
});

test('@software GPU-free rasteriser keeps the poster and never downloads three.js', async ({ page }) => {
  const hits = trackChunk(page);
  await page.goto(lab('variant=pin', false));
  const pin = accent(page);
  await expect(pin).toHaveAttribute('data-scene-phase', 'fallback', { timeout: 20_000 });
  await expect(pin).toHaveAttribute('data-scene-reason', 'software-renderer');
  await page.waitForTimeout(1500);
  expect(hits).toHaveLength(0);
  await expect(pin.locator('img')).toBeVisible();
  await expect(pin.locator('canvas')).toHaveCount(0);
});
