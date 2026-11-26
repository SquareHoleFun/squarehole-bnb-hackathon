import { pictureFixture as af3Fixture } from '../../../packages/artwork/src/picture-fixtures';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Hex } from 'viem';
import { DEMO_TOKEN_ONLY, encodeBoxSpecV1 } from '@squarehole/box-spec';
import { installUntouchableWallet, overflow, WALLET_A } from './box-helpers';
import { brokenImages, drawnSha, fitOf, fixtureFile, pictureFixture, sha, ZERO, type PictureBox } from './picture-fit-fixture';

// SH-BOX-PICTURE-FIT fix round af2 (the failed review of 2026-11-12, M1, M2, M4). Pictures with readable words at
// their edges (e2e/fixtures/picture-edges/: coloured bars on all four sides, LEFT/RIGHT, TOP/BOTTOM, NW..SE) so a cut
// shows. M2, the integrator's design decision: every rectangular place (cards, headers, list thumbnails, My Box's
// Created tiles, the Launch flow's icon frame) draws its picture whole, for both roles; the round token marks (the
// feed's ticker coin, the header peek, My Box's token tile) cut the logo to the circle, centred, and draw a cover that
// stands in whole. M1: a committed logo whose bytes cannot be decoded is missing. M4: the three-second fallback on a
// controlled clock. SH_AF2_SCREENS=<dir> writes the design review's screenshots there (desktop at 1280, phone at 390).
const WIDE = fixtureFile('picture-edges/wide-logo.png');
const TALL = fixtureFile('picture-edges/tall-logo.png');
const SQUARE = fixtureFile('picture-edges/square-logo.png');
const COVER = fixtureFile('picture-edges/wide-cover.png');
const RENT_LOGO = fixtureFile('rent-free/logo.png');
const RENT_COVER = fixtureFile('rent-free/cover.png');
/** A PNG signature, then bytes no browser can draw: it hashes to its commitment and passes the type gate. */
const UNDECODABLE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 73 + 41) & 0xff))]);
/** A real PNG cut after half its bytes: Chromium draws its top part without an error, so its end is checked. */
const TRUNCATED = SQUARE.subarray(0, Math.floor(SQUARE.length / 2));
// Marker-looking bytes in an unfinished chunk fooled the old tail search.
const FALSE_TAIL = Buffer.concat([TRUNCATED, Buffer.from('IEND')]);
const HUGE = af3Fixture('huge.png');
/** A logo no gateway has. */
const LOST = `0x${'5a'.repeat(32)}` as Hex;

const box = (name: string, symbol: string, logo: Hex, cover: Hex = ZERO): PictureBox => ({ name, symbol, logo, cover });
const EDGE_BOXES = [
  box('Wide Logo', 'WIDE', sha(WIDE)),
  box('Tall Logo', 'TALL', sha(TALL)),
  box('Square Logo', 'SQRE', sha(SQUARE), sha(COVER)),
  box('Lost Logo', 'LOST', LOST, sha(COVER)),
] as const;

async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const dir = process.env.SH_AF2_SCREENS;
  const file = `${name}-${info.project.name === 'mobile' ? 'phone-390' : 'desktop-1280'}.png`;
  if (dir) mkdirSync(dir, { recursive: true });
  const path = dir ? join(dir, file) : info.outputPath(file);
  const page = 'goto' in target ? target : target.page();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if ('goto' in target) await target.screenshot({ path, fullPage: false, scale: 'css' });
  else await target.screenshot({ path, scale: 'css' });
}

/** The review's desktop width for the screenshots (the phone project is 390 already). */
async function reviewWidth(page: Page, info: TestInfo) {
  if (info.project.name !== 'mobile') await page.setViewportSize({ width: 1280, height: 900 });
}

const card = (page: Page, name: string) => page.locator('.sh-box-grid').getByRole('link', { name: new RegExp(`^${name},`) });
const row = (page: Page, name: string) => page.locator('.sh-box-table').getByRole('link', { name: new RegExp(`^${name},`) });

/** Drawn whole: the expected picture (by its natural size), loaded, nothing of it cut. */
async function expectWhole(img: Locator, natural: readonly [number, number], where: string) {
  await expect(img, where).toHaveCount(1);
  await expect.poll(async () => (await fitOf(img)).complete, { message: `${where}: loaded` }).toBe(true);
  const fit = await fitOf(img);
  expect(fit.natural, where).toEqual(natural);
  expect(fit.fit, where).toBe('contain');
  expect(fit.cut, `${where}: px cut`).toBeLessThanOrEqual(0.5);
}

/** A round mark: the logo, centred and cut to the circle. */
async function expectRoundLogo(img: Locator, natural: readonly [number, number], where: string) {
  await expect(img, where).toHaveCount(1);
  await expect.poll(async () => (await fitOf(img)).complete, { message: `${where}: loaded` }).toBe(true);
  const fit = await fitOf(img);
  expect(fit.natural, where).toEqual(natural);
  expect(fit, where).toMatchObject({ fit: 'cover', position: '50% 50%', round: true });
}

test.describe('SH-BOX-PICTURE-FIT af2: wide, tall and square pictures in every place', () => {
  test.beforeEach(async ({ page }) => page.emulateMedia({ reducedMotion: 'reduce' }));

  test('M2: the feed and the box headers: rectangular places whole, the ticker coin round with the logo centred, a stand-in cover whole', async ({ page }, info) => {
    test.setTimeout(180_000);
    await reviewWidth(page, info);
    const f = await pictureFixture(page, EDGE_BOXES, [WIDE, TALL, SQUARE, COVER]);
    await page.goto('/');
    for (const b of EDGE_BOXES) await expect(card(page, b.name)).toBeVisible();
    // Cards: a box without a collection cover shows its logo whole; the others their wide cover whole.
    await expectWhole(card(page, 'Wide Logo').locator('.sh-box-cover img'), [1200, 400], 'Wide Logo card');
    await expectWhole(card(page, 'Tall Logo').locator('.sh-box-cover img'), [400, 1200], 'Tall Logo card');
    await expectWhole(card(page, 'Square Logo').locator('.sh-box-cover img'), [1200, 630], 'Square Logo card');
    await expectWhole(card(page, 'Lost Logo').locator('.sh-box-cover img'), [1200, 630], 'Lost Logo card');
    // The ticker coins: round, the logo centred; Lost Logo's stand-in cover whole in its rounded square.
    await expectRoundLogo(card(page, 'Wide Logo').locator('img.sh-box-coin'), [1200, 400], 'Wide Logo coin');
    await expectRoundLogo(card(page, 'Tall Logo').locator('img.sh-box-coin'), [400, 1200], 'Tall Logo coin');
    await expectRoundLogo(card(page, 'Square Logo').locator('img.sh-box-coin'), [800, 800], 'Square Logo coin');
    await expect(card(page, 'Lost Logo').locator('img.sh-box-coin')).toHaveClass(/sh-box-coin--cover/);
    await expectWhole(card(page, 'Lost Logo').locator('img.sh-box-coin'), [1200, 630], 'Lost Logo coin');
    expect(await brokenImages(page)).toEqual([]);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await card(page, 'Wide Logo').scrollIntoViewIfNeeded();
    await shot(page, info, 'feed-wide-tall-square');

    // The List view's thumbnails: square slots, the logo whole (Lost Logo: its cover whole).
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click();
    await expectWhole(row(page, 'Wide Logo').locator('.sh-box-cover img'), [1200, 400], 'Wide Logo row');
    await expectWhole(row(page, 'Tall Logo').locator('.sh-box-cover img'), [400, 1200], 'Tall Logo row');
    await expectWhole(row(page, 'Square Logo').locator('.sh-box-cover img'), [800, 800], 'Square Logo row');
    await expectWhole(row(page, 'Lost Logo').locator('.sh-box-cover img'), [1200, 630], 'Lost Logo row');
    await row(page, 'Wide Logo').scrollIntoViewIfNeeded();
    await shot(page, info, 'feed-list-wide-tall-square');
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Grid' }).click();

    // The box headers: the logo whole; Lost Logo's cover whole.
    const natural: Record<string, [number, number]> = { 'Wide Logo': [1200, 400], 'Tall Logo': [400, 1200], 'Square Logo': [800, 800], 'Lost Logo': [1200, 630] };
    for (const [index, b] of EDGE_BOXES.entries()) {
      await page.goto(f.paths[index] ?? '/');
      const head = page.locator('header.sh-bpic-head');
      await expect(head.getByRole('heading', { name: b.name })).toBeVisible();
      await expect(head.locator('.sh-box-cover')).toHaveAttribute('data-picture', b.logo === LOST ? 'cover' : 'logo');
      await expectWhole(head.locator('.sh-box-cover img'), natural[b.name] ?? [0, 0], `${b.name} header`);
      expect(await brokenImages(page)).toEqual([]);
      if (b.logo !== LOST) await shot(page, info, `box-header-${b.symbol === 'SQRE' ? 'square' : b.symbol.toLowerCase()}-logo`);
    }
  });

  test('M2: the Demo’s token boxes: the header peek and My Box’s token tile cut the logo to the circle, centred; the box header and My Box’s Created tiles draw it whole', async ({ page }, info) => {
    test.setTimeout(180_000);
    await reviewWidth(page, info);
    await installUntouchableWallet(page);
    // Two boxes "created" in this tab (the Demo keeps them as encoded specs in sessionStorage, created-boxes.ts),
    // token-only, by Box wallet A, each with a creator buy (so My Box holds its token): a wide and a tall logo.
    const entry = (name: string, symbol: string, logo: Buffer, at: number) => ({
      encoded: encodeBoxSpecV1({ ...DEMO_TOKEN_ONLY, tokenName: name, tokenSymbol: symbol, coverSha256: sha(logo), creatorFeeRecipient: WALLET_A as `0x${string}` }),
      createdAtMs: at, coverUrl: `data:image/png;base64,${logo.toString('base64')}`, collectionCoverUrl: null, thumbs: [], bannerUrl: null, teaserUrls: [], links: {}, rights: null,
    });
    const stored = JSON.stringify([entry('Wide Token', 'WIDET', WIDE, 1_790_000_000_000), entry('Tall Token', 'TALLT', TALL, 1_790_000_001_000)]);
    await page.addInitScript((value) => window.sessionStorage.setItem('sh.boxes.sample-created.v1', value), stored);
    await page.goto(`/wallet/${WALLET_A}`);
    const holding = (name: string) => page.locator('section.sh-box-holding', { has: page.getByRole('heading', { level: 3, name }) });
    for (const [name, natural] of [['Wide Token', [1200, 400]], ['Tall Token', [400, 1200]]] as const) {
      await expect(holding(name)).toBeVisible();
      await expectRoundLogo(holding(name).locator('.sh-box-wtile__art--token img.sh-box-coin'), natural, `${name} My Box token tile`);
      const created = page.locator('.sh-box-created__link', { hasText: name });
      await expectWhole(created.locator('.sh-box-cover img'), natural, `${name} My Box Created tile`);
    }
    expect(await brokenImages(page)).toEqual([]);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await holding('Wide Token').scrollIntoViewIfNeeded();
    await shot(page, info, 'my-box-token-tiles');
    await page.locator('.sh-box-created').scrollIntoViewIfNeeded();
    await shot(page, info, 'my-box-created-tiles');

    for (const [name, natural, file] of [['Wide Token', [1200, 400], 'wide'], ['Tall Token', [400, 1200], 'tall']] as const) {
      await page.goto(`/wallet/${WALLET_A}`);
      await page.locator('.sh-box-created__link', { hasText: name }).click();
      const header = page.locator('header.sh-box-head');
      await expect(header.getByRole('heading', { level: 1, name })).toBeVisible();
      await expectWhole(header.locator('.sh-box-head__cover .sh-box-cover img'), natural, `${name} box header`);
      const peek = header.locator('.sh-box-peekstrip[data-kind="token"]');
      await expectRoundLogo(peek.locator('img.sh-box-coin'), natural, `${name} header peek`);
      expect(await brokenImages(page)).toEqual([]);
      await shot(header, info, `header-peek-${file}-logo`);
    }
  });

  test('M2: Create’s logo step with a wide upload: the square icon frame draws it whole, the round mark beside it shows what the circle cuts', async ({ page }, info) => {
    test.setTimeout(120_000);
    await reviewWidth(page, info);
    await installUntouchableWallet(page);
    await page.goto('/create/v2-basics');
    await page.getByRole('textbox', { name: 'Name' }).fill('Wide Logo');
    await page.getByRole('textbox', { name: 'Ticker' }).fill('WIDE');
    await page.locator('#create-logo').setInputFiles({ name: 'wide-logo.png', mimeType: 'image/png', buffer: WIDE });
    const slots = page.getByRole('group', { name: 'Where your pictures show' });
    const icon = slots.locator('figure[data-slot="square"]');
    await expect(icon).toHaveText('Icon · logo');
    const frame = icon.locator('.sh-box-cover img');
    await expect.poll(async () => (await fitOf(frame)).complete).toBe(true);
    const shown = await fitOf(frame);
    // The processed upload keeps the logo's shape (3:1), drawn whole in the square frame.
    expect(Math.abs((shown.natural[0] ?? 0) / (shown.natural[1] ?? 1) - 3)).toBeLessThan(0.02);
    expect(shown).toMatchObject({ fit: 'contain', cut: 0 });
    const coin = icon.locator('img.sh-box-coin');
    await expect(coin).toHaveAttribute('src', (await frame.getAttribute('src')) ?? '');
    expect(await fitOf(coin)).toMatchObject({ fit: 'cover', position: '50% 50%', round: true });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await slots.scrollIntoViewIfNeeded();
    await shot(page, info, 'create-logo-step-wide-upload');
  });
});

test.describe('SH-BOX-PICTURE-FIT af2: a picture that cannot be decoded, and the three-second fallback on a controlled clock', () => {
  test.beforeEach(async ({ page }) => page.emulateMedia({ reducedMotion: 'reduce' }));

  test('M1: a committed logo that does not decode (and one cut short): the header, the list and the coin show the verified cover, no broken image', async ({ page }) => {
    test.setTimeout(120_000);
    const f = await pictureFixture(page, [box('Bad Logo', 'BAD', sha(UNDECODABLE), sha(COVER)), box('Cut Logo', 'CUT', sha(TRUNCATED), sha(COVER))], [UNDECODABLE, TRUNCATED, COVER]);
    for (const [index, name] of ['Bad Logo', 'Cut Logo'].entries()) {
      await page.goto(f.paths[index] ?? '/');
      const head = page.locator('header.sh-bpic-head');
      await expect(head.getByRole('heading', { name })).toBeVisible();
      await expect(head.locator('.sh-box-cover')).toHaveAttribute('data-picture', 'cover');
      await expectWhole(head.locator('.sh-box-cover img'), [1200, 630], `${name} header`);
      expect(await drawnSha(head.locator('.sh-box-cover img'))).toBe(sha(COVER));
      expect(await brokenImages(page)).toEqual([]);
    }
    expect(f.gateway.asked).toEqual(expect.arrayContaining([sha(UNDECODABLE), sha(TRUNCATED)]));
    await page.goto('/?view=list');
    await expect(row(page, 'Bad Logo').locator('.sh-box-cover')).toHaveAttribute('data-picture', 'cover');
    await expect(row(page, 'Cut Logo').locator('.sh-box-cover')).toHaveAttribute('data-picture', 'cover');
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Grid' }).click();
    await expect(card(page, 'Bad Logo').locator('img.sh-box-coin')).toHaveClass(/sh-box-coin--cover/);
    await expect(card(page, 'Cut Logo').locator('img.sh-box-coin')).toHaveClass(/sh-box-coin--cover/);
    expect(await brokenImages(page)).toEqual([]);
  });

  /**
   * The box page of `boxes[0]` with the page's clock paused just before its pictures are known, so the header's wait
   * starts at a known time and `runFor` moves it exactly. The page first shows another box (Rent Free, its pictures
   * served), the clock is paused, then the router goes to the box in the app (the feed is already read: nothing
   * else needs a timer to run).
   */
  async function pausedBoxPage(page: Page, boxes: readonly PictureBox[], files: readonly Uint8Array[], hold: readonly Hex[], wrong: readonly [Hex, Uint8Array][] = []) {
    const start = box('Rent Free', 'RENT', sha(RENT_LOGO), sha(RENT_COVER));
    const f = await pictureFixture(page, [start, ...boxes], [RENT_LOGO, RENT_COVER, ...files]);
    for (const [hash, bytes] of wrong) f.gateway.serve(hash, bytes);
    const releases = hold.map((hash) => f.gateway.hold(hash));
    await page.clock.install();
    await page.goto(f.paths[0] ?? '/');
    const head = page.locator('header.sh-bpic-head');
    await expect(head.getByRole('heading', { name: 'Rent Free' })).toBeVisible();
    await expect(head.locator('.sh-box-cover')).toHaveAttribute('data-picture', 'logo');
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 2_000);
    await go(page, f.paths[1] ?? '/');
    await expect(head.getByRole('heading', { name: boxes[0]?.name ?? '' })).toBeVisible();
    return { f, head, icon: head.locator('.sh-box-cover'), releases };
  }

  /** The router's own navigation, in the app, without a reload. */
  const go = (page: Page, path: string) => page.evaluate((to) => { window.history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); }, path);

  /** Lets the page settle (fetches, hashing, decoding) without moving its paused clock. */
  const settle = (page: Page) => page.waitForTimeout(1_000);

  test('M4: the logo stalls: 2,999 ms the slot waits, 3,000 ms the verified cover; the late logo takes the slot back', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'timing, not layout: the desktop run covers it');
    test.setTimeout(120_000);
    const boxes = [box('Slow Logo', 'SLOW', sha(SQUARE), sha(COVER))];
    const { f, icon, releases } = await pausedBoxPage(page, boxes, [SQUARE, COVER], [sha(SQUARE)]);
    await expect.poll(() => f.gateway.asked).toEqual(expect.arrayContaining([sha(SQUARE), sha(COVER)]));
    await settle(page);
    await expect(icon).toHaveAttribute('data-art', 'plain');
    await page.clock.runFor(2_999);
    await settle(page);
    await expect(icon).toHaveAttribute('data-art', 'plain');
    await expect(icon.locator('img')).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(icon).toHaveAttribute('data-picture', 'cover');
    expect(await drawnSha(icon.locator('img'))).toBe(sha(COVER));
    releases[0]?.();
    await expect(icon).toHaveAttribute('data-picture', 'logo');
    expect(await drawnSha(icon.locator('img'))).toBe(sha(SQUARE));
    expect(await brokenImages(page)).toEqual([]);
  });

  test('M1 + M4: an undecodable logo that arrives after the cover took the slot leaves the cover there', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'timing, not layout: the desktop run covers it');
    test.setTimeout(120_000);
    const boxes = [box('Late Bad Logo', 'LATE', sha(UNDECODABLE), sha(COVER))];
    const { f, icon, releases } = await pausedBoxPage(page, boxes, [UNDECODABLE, COVER], [sha(UNDECODABLE)]);
    await expect.poll(() => f.gateway.asked).toEqual(expect.arrayContaining([sha(UNDECODABLE), sha(COVER)]));
    await settle(page);
    await page.clock.runFor(3_000);
    await expect(icon).toHaveAttribute('data-picture', 'cover');
    releases[0]?.();
    await settle(page);
    await page.clock.runFor(10_000);
    await settle(page);
    await expect(icon).toHaveAttribute('data-picture', 'cover');
    expect(await drawnSha(icon.locator('img'))).toBe(sha(COVER));
    expect(await brokenImages(page)).toEqual([]);
  });

  test('M4: a rejected second picture (its bytes do not match): the slot keeps waiting past three seconds and shows the logo when it comes', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'timing, not layout: the desktop run covers it');
    test.setTimeout(120_000);
    const boxes = [box('Wrong Cover', 'WRNG', sha(SQUARE), sha(COVER))];
    const { f, icon, releases } = await pausedBoxPage(page, boxes, [SQUARE], [sha(SQUARE)], [[sha(COVER), WIDE]]);
    const release = () => releases[0]?.();
    await expect.poll(() => f.gateway.asked).toEqual(expect.arrayContaining([sha(SQUARE), sha(COVER)]));
    await settle(page);
    await page.clock.runFor(3_000);
    await settle(page);
    await page.clock.runFor(2_000);
    await settle(page);
    await expect(icon).toHaveAttribute('data-art', 'plain');
    await expect(icon.locator('img')).toHaveCount(0);
    release();
    await expect(icon).toHaveAttribute('data-picture', 'logo');
    expect(await drawnSha(icon.locator('img'))).toBe(sha(SQUARE));
  });

  test('M4: both pictures fail (the logo on no gateway, the cover’s bytes rejected): the placeholder, no broken image', async ({ page }) => {
    test.setTimeout(120_000);
    const boxes = [box('Nothing Shows', 'NONE', LOST, sha(COVER))];
    const f = await pictureFixture(page, boxes, []);
    f.gateway.serve(sha(COVER), WIDE);
    await page.goto(f.paths[0] ?? '/');
    const head = page.locator('header.sh-bpic-head');
    await expect(head.getByRole('heading', { name: 'Nothing Shows' })).toBeVisible();
    await expect.poll(() => f.gateway.asked).toEqual(expect.arrayContaining([LOST, sha(COVER)]));
    await expect(head.locator('.sh-box-cover')).toHaveAttribute('data-art', 'plain');
    await page.waitForTimeout(4_000);
    await expect(head.locator('.sh-box-cover')).toHaveAttribute('data-art', 'plain');
    await expect(head.locator('.sh-box-cover img')).toHaveCount(0);
    await page.goto('/');
    await expect(card(page, 'Nothing Shows').locator('.sh-box-cover')).toHaveAttribute('data-art', 'plain');
    await expect(card(page, 'Nothing Shows').locator('.sh-box-coin')).toHaveAttribute('data-letter', 'N');
    expect(await brokenImages(page)).toEqual([]);
  });

  test('M4: from one box to another with different pictures: never the first box’s picture; the second waits its own three seconds', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'timing, not layout: the desktop run covers it');
    test.setTimeout(120_000);
    const boxes = [box('Square Logo', 'SQRE', sha(SQUARE), sha(COVER)), box('Rent Free', 'RENT', sha(RENT_LOGO), sha(RENT_COVER))];
    const f = await pictureFixture(page, boxes, [SQUARE, COVER, RENT_LOGO, RENT_COVER]);
    const release = f.gateway.hold(sha(RENT_LOGO));
    await page.clock.install();
    await page.goto(f.paths[0] ?? '/');
    const head = page.locator('header.sh-bpic-head');
    const icon = head.locator('.sh-box-cover');
    await expect(head.getByRole('heading', { name: 'Square Logo' })).toBeVisible();
    await expect(icon).toHaveAttribute('data-picture', 'logo');
    expect(await drawnSha(icon.locator('img'))).toBe(sha(SQUARE));
    // In the app, without a reload: the router's own navigation to the other box.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 2_000);
    await go(page, f.paths[1] ?? '/');
    await expect(head.getByRole('heading', { name: 'Rent Free' })).toBeVisible();
    await expect.poll(() => f.gateway.asked).toEqual(expect.arrayContaining([sha(RENT_LOGO), sha(RENT_COVER)]));
    await settle(page);
    await expect(icon).toHaveAttribute('data-art', 'plain');
    await page.clock.runFor(2_999);
    await settle(page);
    await expect(icon).toHaveAttribute('data-art', 'plain');
    await expect(icon.locator('img')).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(icon).toHaveAttribute('data-picture', 'cover');
    expect(await drawnSha(icon.locator('img'))).toBe(sha(RENT_COVER));
    release();
    await expect(icon).toHaveAttribute('data-picture', 'logo');
    expect(await drawnSha(icon.locator('img'))).toBe(sha(RENT_LOGO));
    // And back: the first box's own logo, at once (its bytes are kept), never Rent Free's.
    await go(page, f.paths[0] ?? '/');
    await expect(head.getByRole('heading', { name: 'Square Logo' })).toBeVisible();
    await expect(icon).toHaveAttribute('data-picture', 'logo');
    expect(await drawnSha(icon.locator('img'))).toBe(sha(SQUARE));
    expect(await brokenImages(page)).toEqual([]);
  });
});

test('af3: false-tail and huge-dimension primaries yield to the cover before browser decode', async ({ page }) => {
  await page.addInitScript(() => {
    const blobs = new Map<string, Blob>();
    const hashes: Promise<string>[] = [];
    Object.assign(window, { __af3DecodeHashes: hashes });
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      if (blob instanceof Blob) blobs.set(url, blob);
      return url;
    };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      const blob = blobs.get(this.src);
      if (blob) hashes.push(blob.arrayBuffer().then((b) => crypto.subtle.digest('SHA-256', b))
        .then((b) => '0x' + Array.from(new Uint8Array(b), (n) => n.toString(16).padStart(2, '0')).join('')));
      return decode.call(this);
    };
  });
  const cases = [box('False Tail', 'TAIL', sha(FALSE_TAIL), sha(COVER)), box('Huge Dimensions', 'HUGE', sha(HUGE), sha(COVER))];
  const f = await pictureFixture(page, cases, [FALSE_TAIL, HUGE, COVER]);
  for (const [index, b] of cases.entries()) {
    await page.goto(f.paths[index] ?? '/');
    const head = page.locator('header.sh-bpic-head');
    await expect(head.locator('.sh-box-cover')).toHaveAttribute('data-picture', 'cover');
    expect(await drawnSha(head.locator('.sh-box-cover img'))).toBe(sha(COVER));
    expect(await brokenImages(page)).toEqual([]);
    const decoded = await page.evaluate(() => Promise.all((window as unknown as { __af3DecodeHashes: Promise<string>[] }).__af3DecodeHashes));
    expect(decoded).toContain(sha(COVER)); // The instrumentation must see the valid decode too.
    expect(decoded).not.toContain(b.logo);
  }
  expect(f.gateway.asked).toEqual(expect.arrayContaining([sha(FALSE_TAIL), sha(HUGE)]));
});
