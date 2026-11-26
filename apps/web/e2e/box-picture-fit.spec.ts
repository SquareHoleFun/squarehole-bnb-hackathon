import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Hex } from 'viem';
import { installUntouchableWallet, overflow } from './box-helpers';
import { drawn, fixtureFile, pictureFixture, sha, ZERO } from './picture-fit-fixture';

// SH-BOX-PICTURE-FIT (founder 2026-11-02, the Rent Free box: "I can't ever read it in full anywhere"). Rent Free has a
// square logo (a house, 1024 x 1024) and a wide collection cover (1200 x 630: "Rent Free", its line and the house): the
// feed card cut the cover to a square and the header icon showed the same cut. Here three v2 boxes on synthetic reads
// (the M3-52 publication, a JSON-RPC double, and the browser suite's local art gateway and indexer, 127.0.0.1:8595 and
// :8596, answered here; nothing reaches a network), all drawn from the live box's two files
// (e2e/fixtures/rent-free/): Rent Free (logo + wide cover), Little Houses (the logo only) and No Logo (a wide cover
// and a logo no gateway has). The feed card shows each cover whole, every card in a row the same height; the box
// page's header icon shows the logo (No Logo: its cover, whole); the Launch flow says which picture goes where and
// previews both slots. Desktop 1440 x 900 and a phone at 390 px. SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to
// docs/evidence/SH-BOX-PICTURE-FIT/<name>-<project>.png.
const LOGO = fixtureFile('rent-free/logo.png');
const COVER = fixtureFile('rent-free/cover.png');
const LOGO_SHA = sha(LOGO);
const COVER_SHA = sha(COVER);
/** A logo no gateway has (No Logo's): its slots fall back to the cover. */
const LOST_SHA = `0x${'5a'.repeat(32)}` as Hex;

async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/SH-BOX-PICTURE-FIT/${name}-${info.project.name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  if ('goto' in target) {
    await target.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await target.screenshot({ path, fullPage: false, scale: 'css' });
  } else await target.screenshot({ path, scale: 'css' });
}

/** Rent Free (logo + wide cover), Little Houses (the logo only) and No Logo (a wide cover, a logo no gateway has). */
async function fixture(page: Page) {
  const { chainId, tokens } = await pictureFixture(page, [
    { name: 'Rent Free', symbol: 'RENT', logo: LOGO_SHA, cover: COVER_SHA },
    { name: 'Little Houses', symbol: 'HOME', logo: LOGO_SHA, cover: ZERO },
    { name: 'No Logo', symbol: 'NOLO', logo: LOST_SHA, cover: COVER_SHA },
  ], [LOGO, COVER]);
  return { chainId, token: tokens[0] ?? '' };
}

test.describe('SH-BOX-PICTURE-FIT: box pictures are never cut', () => {
  test.beforeEach(async ({ page }) => page.emulateMedia({ reducedMotion: 'reduce' }));

  test('the feed shows each cover whole, rows even; the box page header icon shows the logo', async ({ page }, info) => {
    test.setTimeout(120_000);
    const { chainId, token } = await fixture(page);
    await page.goto('/');
    const card = (name: string) => page.getByRole('link', { name: new RegExp(`^${name},`) });
    for (const name of ['Rent Free', 'Little Houses', 'No Logo']) await expect(card(name)).toBeVisible();

    // Rent Free's card: its cover, contained, the whole 1200 x 630 picture inside the square.
    const rentCover = card('Rent Free').locator('.sh-box-cover');
    await expect(rentCover).toHaveAttribute('data-picture', 'cover');
    await expect.poll(async () => (await drawn(rentCover.locator('img'))).complete).toBe(true);
    const rent = await drawn(rentCover.locator('img'));
    expect(rent.natural).toEqual([1200, 630]);
    expect(rent.fit).toBe('contain');
    // Little Houses has no collection cover: its card shows its logo; No Logo's card its cover.
    await expect(card('Little Houses').locator('.sh-box-cover')).toHaveAttribute('data-picture', 'cover');
    await expect.poll(async () => (await drawn(card('Little Houses').locator('.sh-box-cover img'))).natural).toEqual([1024, 1024]);
    await expect.poll(async () => (await drawn(card('No Logo').locator('.sh-box-cover img'))).natural).toEqual([1200, 630]);
    // The ticker's coin is the logo (No Logo: its cover, whole, in a rounded square).
    await expect.poll(async () => (await drawn(card('Rent Free').locator('img.sh-box-coin--logo'))).natural).toEqual([1024, 1024]);
    await expect(card('No Logo').locator('img.sh-box-coin--cover')).toHaveCount(1);

    // Every card's cover is the same square (the wide Featured card aside), so the cards in a row are one height.
    const covers = await page.locator('.sh-box-grid > .sh-box-card:not(.sh-box-card--featured) .sh-box-card__cover').evaluateAll((all) => all.map((c) => {
      const box = c.getBoundingClientRect();
      return [Math.round(box.width), Math.round(box.height)];
    }));
    expect(covers.length).toBeGreaterThanOrEqual(3);
    expect(new Set(covers.map(([, height]) => height)).size, JSON.stringify(covers)).toBe(1);
    for (const [width, height] of covers) expect(Math.abs((width ?? 0) - (height ?? 0)), 'a square cover').toBeLessThanOrEqual(1);
    const tops = await page.locator('.sh-box-grid > .sh-box-card').evaluateAll((cards) => cards.map((c) => [Math.round(c.getBoundingClientRect().top), Math.round(c.getBoundingClientRect().height)]));
    for (const [top, height] of tops) for (const [otherTop, otherHeight] of tops) if (top === otherTop) expect(height).toBe(otherHeight);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await card('Rent Free').scrollIntoViewIfNeeded();
    await shot(page, info, '01-feed-grid');

    // The List view: each row's thumbnail is a square slot, so the logo.
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click();
    const row = page.getByRole('link', { name: /^Rent Free,/ });
    await expect(row.locator('.sh-box-cover')).toHaveAttribute('data-picture', 'logo');
    const noLogoRow = page.getByRole('link', { name: /^No Logo,/ });
    await expect(noLogoRow.locator('.sh-box-cover')).toHaveAttribute('data-picture', 'cover');
    await expect(noLogoRow.locator('.sh-box-cover')).toHaveAttribute('data-fit', 'contain');
    await row.scrollIntoViewIfNeeded();
    await shot(page, info, '02-feed-list');
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Grid' }).click();

    // The box page: the header icon is the logo, whole.
    await page.goto(`/box/${chainId}/${token}`);
    const head = page.locator('header.sh-bpic-head');
    await expect(head.getByRole('heading', { name: 'Rent Free' })).toBeVisible();
    const icon = head.locator('.sh-box-cover');
    await expect(icon).toHaveAttribute('data-picture', 'logo');
    await expect.poll(async () => (await drawn(icon.locator('img'))).natural).toEqual([1024, 1024]);
    expect((await drawn(icon.locator('img'))).fit).toBe('contain');
    await shot(page, info, '03-box-header');
  });

  test('a box whose logo no gateway has: its header icon shows the cover whole', async ({ page }, info) => {
    test.setTimeout(120_000);
    const { chainId } = await fixture(page);
    await page.goto(`/box/${chainId}/0x00000000000000000000000000000000000b0a02`);
    const head = page.locator('header.sh-bpic-head');
    await expect(head.getByRole('heading', { name: 'No Logo' })).toBeVisible();
    const icon = head.locator('.sh-box-cover');
    await expect(icon).toHaveAttribute('data-picture', 'cover');
    await expect.poll(async () => (await drawn(icon.locator('img'))).natural).toEqual([1200, 630]);
    expect((await drawn(icon.locator('img'))).fit).toBe('contain');
    await shot(head, info, '04-box-header-no-logo');
  });

  test('the Launch flow says which picture goes where and previews the icon and the card', async ({ page }, info) => {
    test.setTimeout(120_000);
    await installUntouchableWallet(page);
    await page.goto('/create/v2-basics');
    await page.getByRole('textbox', { name: 'Name' }).fill('Rent Free');
    await page.getByRole('textbox', { name: 'Ticker' }).fill('RENT');
    const logoField = page.locator('.sh-newbox-field').filter({ has: page.locator('#create-logo') });
    await expect(logoField.getByText('Square · the icon')).toBeVisible();
    await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: LOGO });
    await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
    const slots = page.getByRole('group', { name: 'Where your pictures show' });
    await expect(slots.locator('figure')).toHaveText(['Icon · logo', 'Card · logo']);
    await slots.scrollIntoViewIfNeeded();
    await shot(page, info, '05-launch-basics');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    await page.getByRole('radio', { name: /^New collection/ }).check();
    const coverField = page.locator('.sh-newbox-field').filter({ has: page.locator('#create-collection-cover') });
    await expect(coverField.getByText('Wide · the card')).toBeVisible();
    await page.locator('#create-collection-cover').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: COVER });
    const contentSlots = coverField.getByRole('group', { name: 'Where your pictures show' });
    await expect(contentSlots.locator('figure')).toHaveText(['Icon · logo', 'Card · cover']);
    const card = contentSlots.locator('figure[data-slot="card"] img');
    await expect.poll(async () => (await drawn(card)).complete).toBe(true);
    const shown = await drawn(card);
    // The picker's processed copy keeps the cover's shape (1200 x 630 within its side), and the card draws it whole.
    const [width = 0, height = 1] = shown.natural;
    expect(Math.abs(width / height - 1200 / 630)).toBeLessThan(0.01);
    expect(shown.fit).toBe('contain');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await contentSlots.scrollIntoViewIfNeeded();
    await shot(page, info, '06-launch-contents');
  });
});
