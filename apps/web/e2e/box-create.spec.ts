import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { AddOnId, BoxType, CONTEXT_V2, Reason, decodeBoxSpecV1, decodeCollectionMetadataParams, specHash, validateBoxSpecV1 } from '../../../packages/box-spec/src/index';
import { canonicalJson, rawCidV1 } from '../../../packages/artwork/src/index';
import { PNG_SIGNATURE, concat, pngChunk } from '../../../packages/artwork/src/test-support/images';
import { collectWords, summarise, type WordSummary } from '../../../scripts/lib/visible-words.mjs';
import { FORBIDDEN, STORED_NO_PARTS, STORED_V2_DEFAULTS, installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { goInApp } from './feed-helpers';

// SH-BOX-CREATE-v2 (F70, F71; docs/design/box-create-flow.md): launch a box in F70's order (Basics, Contents, Box
// kind, Raise, Opening, Overview), in a real browser at both sizes. Real file reading (content sniffing, WebCrypto
// sha256, canvas re-encoding), the Demo wallet only on the explicit "Connect to create", no injected-wallet access
// anywhere. A plain token box and a hidden-art collection with a banner and teasers are created and checked in the
// feed, on their pages and in the wallet box. SH_EVIDENCE_SCREENSHOTS=1 writes the screenshots and the phone word
// counts to docs/evidence/screenshots/sh-box-create-v2/.

const EVIDENCE = process.env.SH_EVIDENCE_SCREENSHOTS === '1';
const evidenceDir = fileURLToPath(new URL('../../../docs/evidence/screenshots/sh-box-create-v2/', import.meta.url));

type Rgb = readonly [number, number, number];
const COLOURS: readonly [string, Rgb][] = [
  ['Red', [214, 72, 72]],
  ['Teal', [40, 170, 160]],
  ['Gold', [222, 176, 60]],
];
const SHAPES = ['Square', 'Circle', 'Diamond'] as const;

/** A decodable PNG: a coloured field with a lighter shape in the middle (each picture looks different). */
function picturePng(width: number, height: number, [r, g, b]: Rgb, shape: number): Buffer {
  const row = 1 + width * 3;
  const raw = new Uint8Array(row * height);
  const cx = width / 2;
  const cy = height / 2;
  const unit = Math.min(width, height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const inside = shape === 0 ? dx < unit / 4 && dy < unit / 4 : shape === 1 ? dx * dx + dy * dy < (unit / 3.4) ** 2 : dx + dy < unit / 3;
      const stripe = width > height * 2 && Math.floor(x / (width / 8)) % 2 === 0;
      const k = inside ? 1.6 : stripe ? 0.75 : 0.55;
      raw.set([Math.min(255, Math.round(r * k)), Math.min(255, Math.round(g * k)), Math.min(255, Math.round(b * k))], y * row + 1 + x * 3);
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.from(concat(PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(deflateSync(raw))), pngChunk('IEND', new Uint8Array())));
}

/** N item pictures named 1.png … N.png and a traits.csv (Colour, Shape). */
function artFiles(n: number, offset = 0) {
  const lines = ['id,Colour,Shape'];
  const files = Array.from({ length: n }, (_, i) => {
    const [name, rgb] = COLOURS[(i + offset) % COLOURS.length] as [string, Rgb];
    const shape = Math.floor((i + offset) / COLOURS.length) % SHAPES.length;
    lines.push(`${i + 1},${name},${SHAPES[shape]}`);
    return { name: `${i + 1}.png`, mimeType: 'image/png', buffer: picturePng(96, 96, rgb, shape) };
  });
  return [...files, { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) }];
}

const logoFile = (rgb: Rgb, shape: number) => ({ name: 'logo.png', mimeType: 'image/png', buffer: picturePng(512, 512, rgb, shape) });
/** A new collection's own cover (F74 U3): another picture than the logo. */
const collectionCoverFile = (rgb: Rgb) => ({ name: 'collection-cover.png', mimeType: 'image/png', buffer: picturePng(640, 640, rgb, 2) });
const bannerFile = (rgb: Rgb) => ({ name: 'banner.png', mimeType: 'image/png', buffer: picturePng(1024, 256, rgb, 1) });
const teaserFiles = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `teaser-${i + 1}.png`, mimeType: 'image/png', buffer: picturePng(384, 384, COLOURS[i % 3]?.[1] ?? [90, 90, 200], (i + 1) % 3) }));

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true) {
  const file = EVIDENCE ? `${evidenceDir}${name}-${testInfo.project.name}.png` : testInfo.outputPath(`${name}.png`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage, scale: 'css' });
}

/** The words counted on each phone first screen, kept with the counts (evidence: what a reader sees first). */
const firstScreens: Record<string, string> = {};

/** Words in <main> on the first screen (the phone budget is 40), measured as the script does; and on the whole page. */
async function words(page: Page, step?: string): Promise<WordSummary> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const { words: list } = await page.evaluate(collectWords);
  if (step) firstScreens[step] = list.filter((word) => word.inViewport && word.inMain).map((word) => word.token).join(' ');
  return summarise(list);
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const sha256 = (bytes: Uint8Array | string) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const steps = (page: Page) => page.getByRole('navigation', { name: 'Steps' });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });
const main = (page: Page) => page.getByRole('main');
const side = (page: Page, which: 'Buyers’' | 'Sellers’') => page.getByRole('group', { name: new RegExp(`^${which} fees · `) });
const rights = (page: Page) => page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' });

/** On a phone: the focused control sits above the sticky action bar (WCAG 2.2 SC 2.4.11), not under it. */
async function focusAboveBar(page: Page, where: string) {
  const { focusBottom, barTop } = await page.evaluate(() => {
    const focused = (document.activeElement as HTMLElement).closest('label, fieldset, .sh-newbox-field') ?? (document.activeElement as HTMLElement);
    return { focusBottom: focused.getBoundingClientRect().bottom, barTop: (document.querySelector('.sh-newbox__bar') as HTMLElement).getBoundingClientRect().top };
  });
  expect(focusBottom, where).toBeLessThanOrEqual(barTop);
}

/** No trade control, no amount field, no number spinner, no buy/sell/swap in a name, no sideways scroll on a step. */
async function noTrading(page: Page, where: string) {
  await expect(page.getByRole('button', { name: FORBIDDEN }), where).toHaveCount(0);
  await expect(page.getByRole('link', { name: FORBIDDEN }), where).toHaveCount(0);
  await expect(page.getByRole('radio', { name: FORBIDDEN }), where).toHaveCount(0);
  await expect(page.getByRole('spinbutton'), where).toHaveCount(0);
  await expect(page.locator('input[type="number"], input[type="range"], iframe'), where).toHaveCount(0);
  const labelled = await page.evaluate(() =>
    [
      ...[...document.querySelectorAll('main label, main legend, main option')].map((el) => el.textContent ?? ''),
      ...[...document.querySelectorAll('main [aria-label], main [placeholder], main [title]')].flatMap((el) => [el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? '', el.getAttribute('title') ?? '']),
      ...[...document.querySelectorAll('main input, main textarea')].flatMap((el) => [el.getAttribute('name') ?? '', el.id]),
    ].filter((text) => /\b(buy|sell|swap)\b/i.test(text) || /amount/i.test(text)),
  );
  expect(labelled, where).toEqual([]);
  expect(await overflow(page), `${where}: sideways scroll`).toBeLessThanOrEqual(0);
}

async function fillBasics(page: Page, { name, ticker, rgb, shape, website }: { name: string; ticker: string; rgb: Rgb; shape: number; website?: string }) {
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('textbox', { name: 'Ticker' }).fill(ticker);
  await page.locator('#create-logo').setInputFiles(logoFile(rgb, shape));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await expect(main(page).locator('.sh-newbox-thumb').first()).toBeVisible();
  if (website) {
    await main(page).locator('summary', { hasText: 'Links' }).click();
    await page.getByRole('textbox', { name: 'Website' }).fill(website);
  }
}

async function connectDemo(page: Page, persona: 'Box wallet A' | 'Box wallet B') {
  expect(await walletTouches(page)).toEqual([]);
  await page.getByRole('button', { name: 'Connect to create' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: persona }).check();
  await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
  await expect(dialog).toHaveCount(0);
}

const counts: Record<string, WordSummary> = {};

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('/create, /launch and an unknown step open the format 2 flow; v1’s step links keep its steps in F70’s order; Launch is in the navigation', async ({ page, isMobile }) => {
  // Every entry point opens the format 2 flow, as on the production site (founder 2026-10-11); v1's flow is reached by
  // its own step URLs only, which this file's tests use.
  // SH-254: the entry points open the visual way (the default); an unknown step still falls back to the steps' Basics.
  for (const path of ['/launch', '/launch/session/demo-1', '/create']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/create\/v2-picture$/);
    await expect(heading(page)).toHaveAccessibleName('Launch a box');
    await expect(page.locator('svg.sh-pic [data-part]')).toHaveCount(10);
  }
  await page.goto('/create/nope');
  await expect(page).toHaveURL(/\/create\/v2-basics$/);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 1 of 6: Basics');
  // v1's slugs: the steps that now hold their choices.
  for (const [from, to, title] of [
    ['/create/collection', 'contents', 'step 2 of 6: Contents'],
    ['/create/fees', 'kind', 'step 3 of 6: Box kind'],
    ['/create/price', 'raise', 'step 4 of 6: Raise'],
    ['/create/review', 'overview', 'step 6 of 6: Overview'],
  ] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`/create/${to}$`));
    await expect(heading(page)).toHaveAccessibleName(`Launch a box, ${title}`);
  }
  if (isMobile) await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Launch' })).toHaveAttribute('aria-current', 'page');
  await page.goto('/');
  await expect(page.getByText('6 boxes')).toBeVisible();
  await page.getByRole('link', { name: 'Launch a box' }).click();
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  expect(await walletTouches(page)).toEqual([]);
});

test('Next on empty Basics: a focused summary, each link to its field; messages on the controls; later steps closed', async ({ page }, testInfo) => {
  await page.goto('/create/basics');
  await next(page).click();
  const summary = page.getByRole('alert').filter({ hasText: 'things to fix' });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole('link')).toHaveText(['Name: Required', 'Ticker: Required', 'Add a logo']);
  await summary.getByRole('link', { name: 'Add a logo' }).click();
  await expect(page.locator('#create-logo')).toBeFocused();
  await focusAboveBar(page, 'Logo after its summary link');
  await summary.getByRole('link').first().click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('BAD"T');
  await expect(page.locator('#create-ticker-error')).toHaveText('! Plain letters, numbers and punctuation only. No " \\ or emoji.');
  await shot(page, testInfo, '01-basics-errors');
  await expect(steps(page).getByRole('link')).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
});

test('the sample data: a plain token box and a hidden collection with a banner and teasers; both in the feed, on their pages and in the wallet box', async ({ page, isMobile }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The draft's fingerprint holds its opening time, rounded up to the minute from the page's clock (create-model.ts
  // openAtOf), so a minute turning between Create and the step back to Basics would hide "Already created". The test
  // pins the page's clock (Date.now) for its whole run; timers keep running.
  await page.clock.setFixedTime(new Date());

  // ── Box 1: "Token", every step visited, You on the buyers' side with a cap, a first ETH in ──
  await page.goto('/create/basics');
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 1 of 6: Basics');
  await expect(page.getByText('Paired with ETH')).toBeVisible();
  await shot(page, testInfo, '01-basics-empty');
  counts['1 Basics (empty)'] = await words(page, '1 Basics (empty)');
  await fillBasics(page, { name: 'Sky Lanterns', ticker: 'LANT', rgb: [110, 90, 220], shape: 0, website: 'https://skylanterns.example' });
  await page.getByRole('textbox', { name: 'X', exact: true }).fill('@skylanterns');
  await noTrading(page, 'Basics');
  await expect(steps(page).getByRole('link')).toHaveText(['Contents']);
  await shot(page, testInfo, '01-basics');

  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  await shot(page, testInfo, '02-contents-empty');
  counts['2 Contents (nothing picked)'] = await words(page, '2 Contents (nothing picked)');
  // Nothing is pre-chosen: Next asks for a pick; the Overview is not a link yet.
  await next(page).click();
  await expect(page.getByRole('alert').getByRole('link')).toHaveText(['Pick what’s in the box']);
  await expect(steps(page).getByRole('link', { name: /Overview/ })).toHaveCount(0);
  // Coming later: cards, not controls; NFTs you own shows F71's address check.
  const later = page.getByRole('region', { name: 'Coming later' });
  await expect(later.getByRole('listitem')).toHaveCount(3);
  await expect(later.getByRole('radio')).toHaveCount(0);
  await expect(later.getByText('Checked by address')).toBeVisible();
  await expect(later.getByText('Verified', { exact: true })).toBeVisible();
  await expect(later.getByText('Unverified', { exact: true })).toBeVisible();
  await later.getByRole('button', { name: 'About NFTs you own' }).click();
  await expect(later.getByText(/fixes the source collection’s address and links it/)).toBeVisible();
  await expect(later.getByText(/“Not the real \{name\}”/)).toBeVisible();
  await later.getByRole('button', { name: 'About NFTs you own' }).click();
  // The two tiles (D10): tall, an icon and a second line; unselected chips outlined with --sh-border-strong.
  const tile = page.getByRole('radio', { name: /^Token/ });
  await expect(tile).toHaveAccessibleName('Token No NFTs');
  await expect(page.getByRole('radio', { name: /^New collection/ })).toHaveAccessibleName('New collection Your NFTs');
  const tileBox = await page.locator('label.sh-newbox-chip', { has: tile }).boundingBox();
  expect(tileBox?.height ?? 0).toBeGreaterThanOrEqual(72);
  expect(await page.locator('label.sh-newbox-chip', { has: tile }).evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(99, 118, 155)');
  await tile.check();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(steps(page).getByRole('link')).toHaveText(['Basics', 'Box kind', 'Raise', 'Opening', 'Overview']);
  await noTrading(page, 'Contents (token)');
  await shot(page, testInfo, '02-contents-token');
  counts['2 Contents (token)'] = await words(page, '2 Contents (token)');

  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Box kind');
  await expect(page.getByText('1% fee: ⅔ picked · ⅓ fixed')).toBeVisible();
  await page.getByRole('button', { name: 'About the fee split' }).click();
  await expect(main(page).getByText('3/15 of each fee: FIT buy-and-burn')).toBeVisible();
  await page.getByRole('button', { name: 'About the fee split' }).click();
  const buyers = side(page, 'Buyers’');
  const sellers = side(page, 'Sellers’');
  await expect(buyers.getByRole('radio', { name: 'Burn', exact: true })).toBeChecked();
  await expect(buyers.getByRole('radio', { name: 'LANT', exact: true })).toBeChecked();
  await expect(sellers.getByRole('radio', { name: 'LANT', exact: true })).toBeChecked();
  // Holders (F74 U1): offered in the Demo, "Pending" in sight and "Pending legal review" as its description; BP-13:
  // sellers' Burn FIT off beside buyers' Burn LANT, its reason tied.
  await expect(buyers.getByRole('radio', { name: /^Holders/ })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(buyers.getByRole('radio', { name: /^Holders/ })).toHaveAccessibleDescription('Pending legal review');
  await expect(buyers.locator('label', { has: page.getByRole('radio', { name: /^Holders/ }) }).locator('small')).toHaveText('Pending');
  await expect(sellers.getByRole('radio', { name: 'FIT' })).toHaveAttribute('aria-disabled', 'true');
  await expect(sellers.getByRole('radio', { name: 'FIT' })).toHaveAccessibleDescription('Not beside Burn LANT on buyers’ fees: the box would sell and buy back in one pool.');
  // Its reason in sight too (D7).
  await expect(sellers.locator('label', { has: page.getByRole('radio', { name: /^FIT/ }) }).locator('small')).toHaveText('Not with buyers’ Burn LANT');
  // The side is named by its legend's words, not its (i) (D18).
  await expect(sellers).toHaveAccessibleName('Sellers’ fees · LANT');
  await shot(page, testInfo, '03-kind-default');
  counts['3 Box kind (default)'] = await words(page, '3 Box kind (default)');
  // BP-13 the other way round (C1): buyers on Burn FIT, sellers on Burn FIT (a sale); buyers' Burn LANT is off, and its
  // reason names the sellers' choice.
  await buyers.getByRole('radio', { name: 'FIT' }).check();
  await sellers.getByRole('radio', { name: /^FIT/ }).check();
  await expect(sellers.getByText('Sells LANT for ETH', { exact: true })).toBeVisible();
  const buyersLant = buyers.getByRole('radio', { name: /^LANT/ });
  await expect(buyersLant).toHaveAttribute('aria-disabled', 'true');
  await expect(buyersLant).toHaveAccessibleDescription('Not beside Burn FIT on sellers’ fees (sells LANT for ETH): the box would sell and buy back in one pool.');
  await expect(buyers.locator('label', { has: page.getByRole('radio', { name: /^LANT/ }) }).locator('small')).toHaveText('Not with sellers’ Burn FIT');
  await shot(page, testInfo, '03-kind-off-buyers');
  // The worst case for the budget: You on both sides, sellers' paid in ETH (a sell, flagged).
  await buyers.getByRole('radio', { name: 'You' }).check();
  await sellers.getByRole('radio', { name: 'You' }).check();
  await sellers.getByRole('radio', { name: 'ETH' }).check();
  await expect(sellers.getByText('Sells LANT for ETH', { exact: true })).toBeVisible();
  await expect(sellers.getByRole('radio', { name: 'ETH' })).toHaveAccessibleDescription('Sells LANT for ETH');
  await noTrading(page, 'Box kind (sell flagged)');
  counts['3 Box kind (worst: You both sides, sells)'] = await words(page, '3 Box kind (worst: You both sides, sells)');
  await shot(page, testInfo, '03-kind-sell');
  // What this box keeps: You on buyers' fees paid in ETH, sellers' burned, the cap at 4 ETH with the excess burned.
  await sellers.getByRole('radio', { name: 'Burn', exact: true }).check();
  await expect(sellers.getByText('Sells LANT for ETH', { exact: true })).toHaveCount(0);
  await expect(buyers.getByRole('radio', { name: 'ETH' })).toBeChecked();
  // The fee cap (add-on 5): closed until wanted, only while a side pays you.
  await main(page).locator('summary', { hasText: 'Fee cap' }).click();
  // F74 U2: fixed amounts per 30 days, 1 to 32 ETH; never a share of the target.
  const capChips = page.getByRole('group', { name: 'Cap your fees' }).locator('label.sh-newbox-chip');
  await expect(capChips).toHaveText(['Off', '1 ETH', '4 ETH', '8 ETH', '16 ETH', '32 ETH']);
  await page.getByRole('radio', { name: '4 ETH', exact: true }).check();
  // The amount once (its chip) while open; the hint names the period; closed, the summary carries the amount.
  await expect(page.locator('#create-cap-hint')).toHaveText('Per 30 days');
  await expect(page.getByRole('group', { name: 'Cap your fees' })).toHaveAccessibleDescription('Per 30 days');
  await expect(main(page).locator('summary', { hasText: 'Fee cap' })).toHaveText('Fee cap');
  await expect(main(page).locator('details', { has: page.getByRole('group', { name: 'Cap your fees' }) }).getByText(/\b4 ETH\b/)).toHaveCount(1);
  const above = page.getByRole('group', { name: 'Above the cap' });
  await expect(above.getByRole('radio', { name: 'Burn' })).toBeChecked();
  // Holders as the excess: offered in the Demo, marked as the sides are (F74 U1).
  await expect(above.getByRole('radio', { name: /^Holders/ })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(above.getByRole('radio', { name: /^Holders/ })).toHaveAccessibleDescription('Pending legal review');
  await shot(page, testInfo, '03-kind');

  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 4 of 6: Raise');
  // F74 U5: one target for every box, a fact with every digit; no 1 / 4.2 / 10 ETH choice, no "too small" help.
  await expect(page.locator('#create-target .sh-newbox-target__value')).toHaveText('4.206980085 ETH');
  await expect(page.getByRole('radio', { name: /ETH/ })).toHaveCount(0);
  await expect(main(page).getByText(/too small/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'About the target' }).click();
  await expect(main(page).getByText('Every box raises this same amount, so nobody picks one.')).toBeVisible();
  await page.getByRole('button', { name: 'About the target' }).click();
  await page.getByRole('radio', { name: '60 days' }).check();
  // The cap no longer follows the target (F74 U2): no cap line here.
  await expect(page.locator('#create-target-cap')).toHaveCount(0);
  await noTrading(page, 'Raise');
  await shot(page, testInfo, '04-raise');
  counts['4 Raise'] = await words(page, '4 Raise');

  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 5 of 6: Opening');
  await expect(page.getByText('First 6.4 min: falling tax', { exact: true })).toBeVisible();
  // Opens Now by default (founder 2026-10-04): the first chip, already chosen.
  await expect(page.getByRole('radio', { name: 'Now', exact: true })).toBeChecked();
  // The worst case for the budget (D17): a picked time adds its field and its UTC line.
  await page.getByRole('radio', { name: 'Pick a time' }).check();
  await expect(page.locator('#create-open-time-utc')).toHaveText(/^in (?:1 h|5\d min)$/);
  await page.getByRole('textbox', { name: 'Your ETH at start' }).fill('0.05');
  counts['5 Opening (pick a time)'] = await words(page, '5 Opening (pick a time)');
  await page.getByRole('radio', { name: '5 min' }).check();
  const first = page.getByRole('textbox', { name: 'Your ETH at start' });
  await first.fill('0.05');
  await expect(page.locator('.sh-newbox-share')).toHaveText(/^≈ \d+(\.\d)?% of LANT$/);
  await expect(rights(page)).not.toBeChecked();
  await noTrading(page, 'Opening');
  await shot(page, testInfo, '05-opening');
  counts['5 Opening'] = await words(page, '5 Opening');

  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(page.getByRole('list', { name: 'Warnings' }).getByRole('listitem')).toHaveText(['Not full in 60 days: refunds', /^Your ETH: ≈ \d+(\.\d)?% of LANT$/]);
  await expect(page.getByRole('group', { name: /^Preview: Sky Lanterns, LANT, Token, Upcoming, Opens in ~5 min, Local chain 31337$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Contents' })).toContainText('Token');
  await expect(page.getByRole('region', { name: 'Box kind' })).toContainText('You · ETH');
  await expect(page.getByRole('region', { name: 'Box kind' })).toContainText('Burn · LANT');
  await expect(page.getByRole('region', { name: 'Box kind' })).toContainText('4 ETH / 30 days · burn above');
  await expect(page.getByRole('region', { name: 'Raise' })).toContainText('4.206980085 ETH · 60 days');
  await expect(page.getByRole('region', { name: 'Basics' })).toContainText('Sky Lanterns · LANT');
  // The links as plain text, so a typo shows before Create (C2, D4).
  await expect(page.getByRole('region', { name: 'Basics' })).toContainText('skylanterns.example · @skylanterns');
  await expect(page.getByText('Collection page data')).toHaveCount(0);
  await expect(main(page).locator('.sh-newbox-cost')).toHaveText(/^Cost ≈ [\d.]+ ETH/);
  // F70 (6), D1: every parameter, then Create. Each group and the fixed values sit above the bar, on both sizes.
  const barTop = (await main(page).locator('.sh-newbox__bar').boundingBox())?.y ?? 0;
  for (const group of ['Basics', 'Contents', 'Box kind', 'Raise', 'Opening']) {
    const box = await page.getByRole('region', { name: group }).boundingBox();
    expect((box?.y ?? Infinity) + (box?.height ?? 0), `${group} above Create`).toBeLessThanOrEqual(barTop);
  }
  expect(((await main(page).locator('summary', { hasText: 'Fixed for every box' }).boundingBox())?.y ?? Infinity)).toBeLessThan(barTop);
  await main(page).locator('summary', { hasText: 'Fixed for every box' }).click();
  await expect(main(page).getByText('2/15 of buyers’ fees and 2/15 of sellers’ fees into this box’s pool. Paired and locked: the box adds both sides together and owns the liquidity for good')).toBeVisible();
  await expect(main(page).getByText('80% of LANT on the curve, its price ×14.7 from the first trade to the last; after graduation the pool spreads over all prices')).toBeVisible();
  await main(page).locator('summary', { hasText: 'Fixed for every box' }).click();
  await noTrading(page, 'Overview (token)');
  await shot(page, testInfo, '06-overview-token');
  counts['6 Overview (token)'] = await words(page, '6 Overview (token)');

  // Every group's Edit link opens its step with "Back to overview", which returns here.
  for (const [group, slug] of [['Basics', 'basics'], ['Contents', 'contents'], ['Box kind', 'kind'], ['Raise', 'raise'], ['Opening', 'launch']] as const) {
    await main(page).getByRole('link', { name: `Edit ${group}` }).click();
    await expect(page).toHaveURL(new RegExp(`/create/${slug}$`));
    await expect(page.getByRole('button', { name: 'Back to overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Back to / })).toHaveCount(0);
    // The target is a fact: Edit Raise opens the deadline, the step's only choice.
    if (slug === 'raise') await expect(page.getByRole('radio', { name: '60 days' })).toBeFocused();
    if (slug === 'raise') await shot(page, testInfo, '04-raise-from-overview');
    await page.getByRole('button', { name: 'Back to overview' }).click();
    await expect(page).toHaveURL(/\/create\/overview$/);
  }

  // Create stays off until the rights box is ticked; pressing it says so.
  await connectDemo(page, 'Box wallet A');
  await expect(main(page).getByText('0xDe00…0A11')).toBeVisible();
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toHaveAttribute('aria-disabled', 'true');
  await expect(create).toHaveAccessibleDescription('I hold the rights. No impersonation.');
  // aria-disabled, still focusable and pressable: the press names what is missing.
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').getByRole('link')).toHaveText(['Confirm your rights']);
  await page.getByRole('alert').getByRole('link').click();
  await expect(rights(page)).toBeFocused();
  await rights(page).check();
  await shot(page, testInfo, '06-overview-token-ready');
  await create.click();

  await expect(page).toHaveURL(/\/box\/31337\/0xde00c[0-9a-f]{35}$/);
  const tokenBox = new URL(page.url()).pathname;
  await expect(page.getByRole('heading', { level: 1, name: 'Sky Lanterns' })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Box created' })).toBeVisible();
  const header = page.locator('header.sh-box-head');
  await expect(header.locator('.sh-box-kind').first()).toHaveText('Token');
  await expect(header.locator('.sh-box-stat dt')).toHaveText(['Supply', 'Target', 'Deadline', 'Creator']);
  await expect(header.locator('.sh-box-stat').first()).toHaveText(/^Supply1BLANT$/);
  // A launch in its own right (D3): one "Token" tile with the logo, no Owning one row, no Conversion, the
  // Token tab first.
  await expect(header.getByRole('button', { name: /^Token: LANT, no NFTs, no vault/ })).toBeVisible();
  await expect(header.locator('.sh-box-peekstrip img')).toBeVisible();
  await expect(header.locator('.sh-box-own')).toHaveCount(0);
  await expect(header.locator('.sh-box-counters .sh-box-counter__title')).toHaveText(['Claims', 'Market']);
  await expect(page.getByRole('tab', { name: 'Token' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { level: 3, name: 'Bonding curve' })).toBeVisible();
  await shot(page, testInfo, '07-box-token');
  await page.getByRole('tab', { name: 'About' }).click();
  const about = page.locator('.sh-box-about');
  await expect(about.locator('.sh-box-collection')).toContainText('None: a token box');
  await expect(about).toContainText('Creator · ETH');
  await expect(about).toContainText('4 ETH / 30 days · above it burned');
  await expect(about.locator('dt').first()).toHaveText('In the box');
  await expect(about.getByRole('link', { name: 'skylanterns.example' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(about.getByRole('link', { name: '@skylanterns' })).toHaveAttribute('href', 'https://x.com/skylanterns');
  await shot(page, testInfo, '07-box-token-about');

  // ── Box 2: a hidden collection with a banner and teasers, the shortest path plus one Edit (a sell) ──
  // Back to v1's Basics in the page (Launch opens the format 2 flow since 2026-10-11; v1 has no link any more).
  await page.evaluate(() => {
    window.history.pushState(window.history.state, '', '/create/basics');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  });
  await expect(page).toHaveURL(/\/create\/basics$/);
  // v1's flow is a lazy chunk of its own; under the full suite's load it can take longer than the default 5 s.
  await expect(page.getByText(/^Already created/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Start a new box' }).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  await fillBasics(page, { name: 'Tin Stars', ticker: 'STAR', rgb: [200, 140, 40], shape: 2, website: 'https://tinstars.example' });
  await next(page).click();
  await page.getByRole('radio', { name: 'New collection' }).check();
  // F74 U3: the collection's own cover, a separate upload (no "same as logo"), required.
  await expect(main(page).getByText('Your logo', { exact: true })).toHaveCount(0);
  await page.getByLabel('Images + traits').setInputFiles(artFiles(10, 4));
  await expect(page.getByRole('status').filter({ hasText: '10 items · 2 traits' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change art' })).toBeVisible();
  await next(page).click();
  await expect(page.getByRole('alert').getByRole('link')).toHaveText(['Add a collection cover']);
  await page.getByRole('alert').getByRole('link').click();
  await expect(page.locator('#create-collection-cover')).toBeFocused();
  await page.locator('#create-collection-cover').setInputFiles(collectionCoverFile([60, 120, 200]));
  await expect(page.getByRole('button', { name: 'Collection cover Change' })).toBeAttached();
  await expect(page.getByRole('alert')).toHaveCount(0);
  counts['2 Contents (new collection, art read, open)'] = await words(page, '2 Contents (new collection, art read, open)');
  await page.getByRole('radio', { name: 'Hidden until drawn' }).check();
  await page.getByRole('button', { name: 'About open and hidden art' }).click();
  await expect(page.getByText(/Keep the reveal file you save on the Overview: items reveal only with it\./)).toBeVisible();
  await page.getByRole('button', { name: 'About open and hidden art' }).click();
  counts['2 Contents (new collection, art read, hidden)'] = await words(page, '2 Contents (new collection, art read, hidden)');
  await main(page).locator('summary', { hasText: /^Collection page$/ }).click();
  // A square banner is refused (C7): shown at 4:1, it would be cropped hard, and its hash is fixed for good.
  await page.locator('#create-banner').setInputFiles(logoFile([200, 140, 40], 1));
  await expect(page.locator('#create-banner-error')).toHaveText('! Use a wide picture, about 4:1.');
  await page.locator('#create-banner').setInputFiles(bannerFile([200, 140, 40]));
  await expect(page.getByRole('button', { name: 'Banner Change' })).toBeAttached();
  // The banner full width at 4:1 (D5), Change and Remove side by side.
  const preview = await main(page).locator('.sh-newbox-wide-preview').boundingBox();
  expect(Math.round((preview?.width ?? 0) / (preview?.height ?? 1))).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole('button', { name: 'Remove banner' })).toBeVisible();
  await page.locator('#create-teasers').setInputFiles(teaserFiles(3));
  await expect(main(page).getByRole('img', { name: /^Teaser \d$/ })).toHaveCount(3);
  // Teasers: label and count, the picker described by its hint, then the list (D5).
  await expect(page.locator('#create-teasers')).toHaveAccessibleName('Teasers Add images');
  await expect(page.locator('#create-teasers')).toHaveAccessibleDescription('Labelled Teaser, never an item');
  await expect(main(page).locator('#create-teasers-label + .sh-newbox-count')).toHaveText('Chosen: 3/4');
  await expect(page.getByRole('textbox', { name: 'Link' })).toHaveValue('https://tinstars.example');
  await expect(page.getByRole('textbox', { name: 'Link' })).toHaveAccessibleDescription('From your website');
  await page.getByRole('radio', { name: '2.5%' }).check();
  await page.getByRole('radio', { name: 'Pool depth' }).check();
  await noTrading(page, 'Contents (collection)');
  await shot(page, testInfo, '02-contents-collection');
  await steps(page).getByRole('link', { name: /Overview/ }).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  // An Edit link: sellers' fees to you, paid in ETH (a sell), then back.
  await main(page).getByRole('link', { name: 'Edit Box kind' }).click();
  await side(page, 'Sellers’').getByRole('radio', { name: 'You' }).check();
  await side(page, 'Sellers’').getByRole('radio', { name: 'ETH' }).check();
  await page.getByRole('button', { name: 'Back to overview' }).click();
  await expect(page).toHaveURL(/\/create\/overview$/);
  await expect(page.getByRole('list', { name: 'Warnings' }).getByRole('listitem')).toHaveText(['Sells STAR for ETH', 'Not full in 30 days: refunds', 'Keep the reveal file']);
  const overviewContents = page.getByRole('region', { name: 'Contents' });
  await expect(overviewContents).toContainText('10 · hidden');
  // Every parameter by step (C2): traits, the marketplace owner, the page as pictures (D5), the hidden texts behind (i).
  await expect(overviewContents.locator('dt')).toHaveText(['Items', 'Traits', 'Collection cover', 'Owner', 'Royalty', 'Page']);
  // Both pictures (F74 U3): the logo under Basics, the collection's own cover here.
  await expect(overviewContents.getByRole('img', { name: 'Collection cover added' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Basics' }).getByRole('img', { name: 'Logo added' })).toBeVisible();
  await expect(overviewContents.locator('.sh-newbox-row', { hasText: 'Traits' }).locator('dd')).toHaveText('2');
  await expect(overviewContents.locator('.sh-newbox-row', { hasText: 'Owner' }).locator('dd')).toHaveText('You');
  await expect(overviewContents.getByRole('img', { name: 'Banner' })).toBeVisible();
  await expect(overviewContents.getByRole('img', { name: /^Teaser \d$/ })).toHaveCount(3);
  await expect(overviewContents.locator('.sh-newbox-page-row__teaser small')).toHaveText(['Teaser', 'Teaser', 'Teaser']);
  await expect(overviewContents.locator('.sh-newbox-page-row__link')).toHaveText('tinstars.example');
  await overviewContents.getByRole('button', { name: 'About the hidden texts' }).click();
  await expect(overviewContents.getByText('Ticket: Opens into one item once its number is drawn.')).toBeVisible();
  await overviewContents.getByRole('button', { name: 'About the hidden texts' }).click();
  await expect(page.getByRole('region', { name: 'Contents' })).toContainText('2.5% · Pool depth');
  await main(page).locator('summary', { hasText: 'Collection page data' }).click();
  const uri = JSON.parse((await page.getByLabel('contractURI JSON').textContent()) ?? '{}') as Record<string, string>;
  expect(Object.keys(uri)).toEqual(['name', 'symbol', 'description', 'image', 'banner_image', 'external_link']);
  expect(uri).toMatchObject({ name: 'Tin Stars', symbol: 'STAR', external_link: 'https://tinstars.example' });
  expect(uri.image).toMatch(/^ipfs:\/\/b[a-z2-7]{58}$/);
  await main(page).locator('summary', { hasText: 'Collection page data' }).click();
  await rights(page).check();
  await noTrading(page, 'Overview (collection)');
  await shot(page, testInfo, '06-overview-collection');
  counts['6 Overview (collection)'] = await words(page, '6 Overview (collection)');
  // Hidden art: the bar saves the reveal file first; Create comes after.
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
  const [reveal] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save reveal file' }).click()]);
  expect(reveal.suggestedFilename()).toBe('star-reveal-file.json');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page).toHaveURL(/\/box\/31337\/0xde00c[0-9a-f]{35}$/);
  const hiddenBox = new URL(page.url()).pathname;
  expect(hiddenBox).not.toBe(tokenBox);
  await expect(page.getByRole('heading', { level: 1, name: 'Tin Stars' })).toBeVisible();
  await expect(header.locator('.sh-box-head__banner img')).toBeVisible();
  await expect(header.getByRole('button', { name: /^3 teasers, not items; 10 items sealed\. Opens/ })).toBeVisible();
  await expect(header.locator('.sh-box-peekstrip__text small')).toHaveText('Teasers · not items');
  // The banner spans the header (D14).
  const headBox = await header.boundingBox();
  const bannerBox = await header.locator('.sh-box-head__banner').boundingBox();
  expect((bannerBox?.width ?? 0) / (headBox?.width ?? 1)).toBeGreaterThan(0.9);
  const teasers = page.locator('[data-block="teasers"]');
  // Teasers last in What's in the box? (C5, D11): after the traits and the sealed count.
  await expect(page.locator('.sh-box-contents > .sh-box-card-block').last()).toHaveAttribute('data-block', 'teasers');
  await expect(teasers.getByRole('img')).toHaveCount(3);
  await expect(teasers.getByRole('img').first()).toHaveAccessibleName('Teaser 1 of 3');
  await expect(teasers.locator('.sh-box-teasers__label')).toHaveText(['Teaser', 'Teaser', 'Teaser']);
  await expect(page.getByRole('heading', { level: 2, name: '10 items, sealed until graduation' })).toBeVisible();
  await shot(page, testInfo, '07-box-hidden');
  await page.getByRole('tab', { name: 'About' }).click();
  await expect(about).toContainText('Sells STAR for ETH');
  await expect(about.locator('.sh-box-collection')).toContainText('Address at creation');
  await expect(about.locator('.sh-box-collection')).toContainText('Explorer · No address yet');
  await expect(about.locator('.sh-box-collection')).toContainText('Marketplace · No marketplace on a local chain');
  await expect(about).toContainText('https://tinstars.example');
  await expect(about.getByRole('img', { name: 'Collection cover' })).toBeVisible();
  await shot(page, testInfo, '07-box-hidden-about');
  // Hidden art keeps its item pictures out of the record; the teasers, the banner and the collection cover are kept.
  const stored = await page.evaluate(() =>
    (JSON.parse(window.sessionStorage.getItem('sh.boxes.sample-created.v1') ?? '[]') as { thumbs: string[]; teaserUrls: string[]; bannerUrl: string | null; collectionCoverUrl: string | null }[]).map((entry) => [
      entry.thumbs.length,
      entry.teaserUrls.length,
      entry.bannerUrl !== null,
      entry.collectionCoverUrl !== null,
    ]),
  );
  expect(stored).toEqual([
    [0, 0, false, false],
    [0, 3, true, true],
  ]);

  // ── Both side by side: the feed, each page, the creator's wallet box; a reload keeps them ──
  await goInApp(page, '/');
  await expect(page.getByText('8 boxes')).toBeVisible();
  const kites = page.getByRole('link', { name: /^Sky Lanterns, LANT, Token, Upcoming, .*Local chain 31337$/ });
  const stars = page.getByRole('link', { name: /^Tin Stars, STAR, New collection, Upcoming, .*10 items, Local chain 31337$/ });
  await expect(kites).toBeVisible();
  await expect(stars).toBeVisible();
  await expect(kites.locator('.sh-box-card__meta')).toHaveText('Token');
  // The banner is the box page's (D15): every card keeps one shape, so a row lines up.
  await expect(stars.locator('.sh-box-card__banner')).toHaveCount(0);
  const [kiteBox, starBox] = [await kites.boundingBox(), await stars.boundingBox()];
  if (kiteBox && starBox && Math.abs(kiteBox.y - starBox.y) < 1) expect(Math.abs(kiteBox.height - starBox.height)).toBeLessThan(1);
  // The token's mark is the creator's logo (D3).
  await expect(kites.locator('.sh-box-card__ticker img')).toBeVisible();
  await shot(page, testInfo, '08-feed-two-created');
  await page.reload();
  await expect(page.getByText('8 boxes')).toBeVisible();
  await kites.click();
  await expect(page).toHaveURL(new RegExp(`${tokenBox}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Sky Lanterns' })).toBeVisible();
  await page.goto(hiddenBox);
  await expect(page.getByRole('heading', { level: 1, name: 'Tin Stars' })).toBeVisible();
  await expect(page.locator('header.sh-box-head .sh-box-head__banner img')).toBeVisible();

  // Wallet A's box by address (a reload disconnects the Demo wallet; /my-box would show the same once connected).
  await page.goto('/wallet/0xde00000000000000000000000000000000000a11');
  const created = page.getByRole('region', { name: 'Created' });
  await expect(created.getByRole('link')).toHaveCount(2);
  await expect(created.getByRole('link', { name: 'Sky Lanterns, LANT, Token' })).toBeVisible();
  await expect(created.getByRole('link', { name: 'Tin Stars, STAR, 10 items' })).toBeVisible();
  // The token box's creator buy is a holding of its token.
  await expect(page.getByRole('region', { name: 'Sky Lanterns' })).toContainText('LANT');
  await shot(page, testInfo, '09-wallet-created');

  expect(await walletTouches(page)).toEqual([]);
  expect(errors).toEqual([]);
  if (EVIDENCE && isMobile) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}word-counts-phone.json`, `${JSON.stringify(counts, null, 2)}\n`);
    writeFileSync(`${evidenceDir}first-screens-phone.json`, `${JSON.stringify(firstScreens, null, 2)}\n`);
  }
  if (isMobile) {
    for (const [step, count] of Object.entries(counts)) expect(count.viewportMain.words, `${step}: words in <main> on the first screen`).toBeLessThanOrEqual(40);
    for (const step of ['6 Overview (token)', '6 Overview (collection)']) expect(counts[step]?.pageMain.words, `${step}: words in <main> on the whole page`).toBeLessThanOrEqual(140);
  }
});

const SEPOLIA = JSON.stringify({ source: 'sepolia' });

async function onSepolia(page: Page) {
  await page.route((url) => !url.href.startsWith('http://127.0.0.1'), (route) => route.abort());
  await page.addInitScript((value) => window.localStorage.setItem('squarehole.data-source.v1', value), SEPOLIA);
}

interface SpecFile {
  readonly context: string;
  readonly network: string;
  readonly specHash: string;
  readonly encoded: `0x${string}`;
  readonly spec: Record<string, unknown>;
  readonly builtAt: string;
  readonly cover: { readonly sha256: string; readonly base64: string } | null;
  readonly collectionCover: { readonly sha256: string; readonly base64: string } | null;
  readonly banner: { readonly sha256: string; readonly base64: string } | null;
  readonly teasers: readonly { readonly sha256: string; readonly base64: string }[];
  readonly revealList: unknown;
  readonly contractURI: Record<string, string> | null;
  readonly site: { readonly links: Record<string, string>; readonly rights: Record<string, string> | null; readonly storage: string };
}

async function downloadSpec(page: Page): Promise<{ name: string; body: SpecFile }> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('.sh-newbox__bar').getByRole('button', { name: 'Download BoxSpec' }).click()]);
  return { name: file.suggestedFilename(), body: JSON.parse(readFileSync(await file.path(), 'utf8')) as SpecFile };
}

const PASTED = '0x27aeE84839B05524B5A6eb3335D9fC21037059D4';

test('a chain source: the same Overview, Create off with its reason, Download BoxSpec with every part of § 4.3', async ({ page }, testInfo) => {
  await onSepolia(page);
  await page.goto('/create/basics');
  await expect(page.locator('.sh-newbox__source')).toHaveText('Sepolia testnet');
  await fillBasics(page, { name: 'Glass Fish', ticker: 'FISH', rgb: [60, 150, 210], shape: 1, website: 'https://glassfish.example' });
  await next(page).click();
  await page.getByRole('radio', { name: 'New collection' }).check();
  await page.getByLabel('Images + traits').setInputFiles(artFiles(10, 2));
  await expect(page.getByRole('status').filter({ hasText: '10 items · 2 traits' })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles(collectionCoverFile([200, 90, 60]));
  await expect(page.getByRole('button', { name: 'Collection cover Change' })).toBeAttached();
  await main(page).locator('summary', { hasText: /^Collection page$/ }).click();
  await page.locator('#create-banner').setInputFiles(bannerFile([60, 150, 210]));
  await page.locator('#create-teasers').setInputFiles(teaserFiles(2));
  await expect(main(page).getByRole('img', { name: /^Teaser \d$/ })).toHaveCount(2);
  for (const [step, label] of [['kind', 'Box kind'], ['raise', 'Raise'], ['launch', 'Opening']] as const) {
    await steps(page).getByRole('link', { name: new RegExp(`^${label}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/create/${step}$`));
    await noTrading(page, `Sepolia ${step}`);
    if (step === 'kind') {
      // F74 U1: a chain source offers no holder payout: off, "Demo only" in sight, its one-line reason as the description.
      for (const which of ['Buyers’', 'Sellers’'] as const) {
        const holders = side(page, which).getByRole('radio', { name: /^Holders/ });
        await expect(holders).toHaveAttribute('aria-disabled', 'true');
        await expect(holders).toHaveAccessibleDescription('Not offered here yet: pending legal review.');
        await expect(side(page, which).locator('label', { has: page.getByRole('radio', { name: /^Holders/ }) }).locator('small')).toHaveText('Not offered here yet');
      }
    }
    if (step === 'raise') await expect(page.locator('#create-target .sh-newbox-target__value')).toHaveText('4.206980085 ETH');
  }
  await steps(page).getByRole('link', { name: /Overview/ }).click();
  await expect(page.getByRole('group', { name: /^Preview: Glass Fish/ })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toHaveAttribute('aria-disabled', 'true');
  await expect(create).toHaveAccessibleDescription('Creation opens with the box factory.');
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#create-off-reason')).toBeFocused();
  await expect(page).toHaveURL(/\/create\/overview$/);
  // Your address is pasted (no wallet asked); the rights box is needed for the file too.
  await page.getByRole('textbox', { name: 'Your address' }).fill(PASTED.slice(0, -1));
  await page.locator('.sh-newbox__bar').getByRole('button', { name: 'Download BoxSpec' }).click();
  await expect(page.getByRole('alert').getByRole('link')).toHaveText(['Your address: Not a full 0x address', 'Confirm your rights']);
  await page.getByRole('textbox', { name: 'Your address' }).fill(PASTED);
  await rights(page).check();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await noTrading(page, 'Sepolia overview');
  const shown = await page.locator('[data-spec-hash]').getAttribute('data-spec-hash');
  expect(shown).toMatch(/^0x[0-9a-f]{64}$/);
  await expect(page.locator('#create-spec-hash')).toHaveText(`Spec ${shown?.slice(0, 8)}…${shown?.slice(-4)}`);
  await shot(page, testInfo, '06-overview-chain');
  const { name, body } = await downloadSpec(page);
  expect(name).toBe('fish-boxspec-v1.json');
  const decoded = decodeBoxSpecV1(body.encoded);
  expect(body.context).toBe('v2');
  // F74 U1: checked with Sepolia's rules (the checker's --network); mainnet's validate() accepts it too (no holder payout).
  expect(body.network).toBe('sepolia');
  expect(validateBoxSpecV1(decoded, CONTEXT_V2)).toEqual({ reason: Reason.OK, field: 0 });
  // F74 U5: the one raise.
  expect(decoded.raise).toBe(4_206_980_085n * 10n ** 9n);
  expect(specHash(decoded)).toBe(shown);
  expect(body.specHash).toBe(shown);
  expect(decoded.boxType).toBe(BoxType.NEW_COLLECTION);
  expect(body.spec.marketplaceOwner).toBe(PASTED);
  // What the spec commits to: the logo's, banner's and teasers' bytes, the open reveal list.
  expect(sha256(Buffer.from(body.cover?.base64 ?? '', 'base64'))).toBe(decoded.coverSha256);
  // F74 U3: the collection's own cover, its bytes beside the logo's, a different picture; contractURI's image is it.
  expect(sha256(Buffer.from(body.collectionCover?.base64 ?? '', 'base64'))).toBe(decoded.collectionCoverSha256);
  expect(decoded.collectionCoverSha256).not.toBe(decoded.coverSha256);
  expect(body.contractURI?.image).toBe(`ipfs://${rawCidV1(decoded.collectionCoverSha256)}`);
  const page6 = decodeCollectionMetadataParams(decoded.addOns.find((addOn) => addOn.id === AddOnId.CollectionMetadata)?.params ?? '0x');
  expect(sha256(Buffer.from(body.banner?.base64 ?? '', 'base64'))).toBe(page6.bannerSha256);
  expect(body.teasers.map((teaser) => sha256(Buffer.from(teaser.base64, 'base64')))).toEqual(page6.teaserSha256s);
  expect(page6.externalLink).toBe('https://glassfish.example');
  expect(sha256(canonicalJson(body.revealList as Parameters<typeof canonicalJson>[0]))).toBe(decoded.revealListId);
  // contractURI as shown on the Overview; the site record beside the spec, never in it.
  expect(body.contractURI).toMatchObject({ name: 'Glass Fish', symbol: 'FISH', external_link: 'https://glassfish.example' });
  expect(body.contractURI?.banner_image).toMatch(/^ipfs:\/\/b/);
  expect(body.site.links).toEqual({ website: 'https://glassfish.example', x: '', telegram: '' });
  expect(body.site.rights).toMatchObject({ specHash: shown, creator: PASTED, statement: 'rights-statement-draft-1' });
  expect(Object.keys(body.spec)).not.toContain('rights');
  await expect(page.getByRole('status').filter({ hasText: 'Saved fish-boxspec-v1.json' })).toBeVisible();
  expect(await walletTouches(page)).toEqual([]);
});

// SH-open-at-ts (F80): SH_OPEN_AT_SHOTS=1 writes the Opening step with a picked UTC time and the Overview's Opening group
// at 1280 px (desktop project) and 400 px (mobile project) to docs/evidence/screenshots/open-at/.
const OPEN_AT_SHOTS = process.env.SH_OPEN_AT_SHOTS === '1';
const openAtDir = fileURLToPath(new URL('../../../docs/evidence/screenshots/open-at/', import.meta.url));

async function openAtShot(page: Page, testInfo: TestInfo, name: string) {
  if (!OPEN_AT_SHOTS) return;
  mkdirSync(openAtDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${openAtDir}${name}-${testInfo.project.name === 'mobile' ? '400' : '1280'}.png`, fullPage: true, scale: 'css' });
}

test('a picked opening time is an exact UTC time: the Overview shows it, and the downloaded file has it and the hash shown there', async ({ page, isMobile }, testInfo) => {
  await page.setViewportSize(isMobile ? { width: 400, height: 844 } : { width: 1280, height: 900 });
  await page.clock.install({ time: new Date('2026-10-03T10:00:00Z') });
  await onSepolia(page);
  await page.goto('/create/basics');
  await fillBasics(page, { name: 'Clock Work', ticker: 'TICK', rgb: [120, 180, 90], shape: 1 });
  await next(page).click();
  await page.getByRole('radio', { name: /^Token/ }).check();
  await steps(page).getByRole('link', { name: /^Opening/ }).click();
  await page.getByRole('radio', { name: 'Pick a time' }).check();
  // The field starts an hour ahead, in UTC (the next whole minute), whatever the browser's own zone.
  await expect(page.getByLabel('Time (UTC)')).toHaveValue(/^2026-10-03T11:0[01]$/);
  await expect(page.locator('#create-open-time-utc')).toHaveText('in 1 h');
  // Typed as UTC: 12:30 is 12:30 UTC, two and a half hours after the page's clock.
  await page.getByLabel('Time (UTC)').fill('2026-10-03T12:30');
  await expect(page.locator('#create-open-time-utc')).toHaveText(/^in (?:2|3) h$/);
  await rights(page).check();
  await openAtShot(page, testInfo, 'opening-pick-a-utc-time');
  await steps(page).getByRole('link', { name: /Overview/ }).click();
  await expect(page.getByRole('region', { name: 'Opening' })).toContainText(/12:30 UTC · in (?:2|3) h/);
  await page.getByRole('textbox', { name: 'Your address' }).fill(PASTED);
  await openAtShot(page, testInfo, 'overview-utc-time');
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);
  await page.clock.fastForward(13_000);
  await page.waitForTimeout(200);
  const shown = await page.locator('[data-spec-hash]').getAttribute('data-spec-hash');
  const { body } = await downloadSpec(page);
  expect(body.specHash).toBe(shown);
  const decoded = decodeBoxSpecV1(body.encoded);
  expect(specHash(decoded)).toBe(shown);
  // A token-only file: TOKEN_ONLY, no collection cover, no banner, no teasers, no contractURI (no collection).
  expect(decoded.boxType).toBe(BoxType.TOKEN_ONLY);
  expect([body.collectionCover, body.banner, body.teasers, body.contractURI]).toEqual([null, null, [], null]);
  // Field 15 openAt: the picked time in Unix seconds, exactly (open-at-clock-time.md).
  expect(Number(body.spec.openAt)).toBe(Date.UTC(2026, 9, 3, 12, 30) / 1000);
  expect(decoded.openAt).toBe(Date.UTC(2026, 9, 3, 12, 30) / 1000);
  expect(validateBoxSpecV1(decoded, CONTEXT_V2)).toEqual({ reason: Reason.OK, field: 0 });
});

// SH-open-now: "Now" is the Opening step's first chip and the default (founder 2026-10-04): 1 block, the version's least
// delay, so the box opens in the block after its creation block, never in it. SH_OPEN_NOW_SHOTS=1 writes the Opening
// step and the Overview at 1280 px (desktop project) and 400 px (mobile project) to docs/evidence/screenshots/open-now/.
const OPEN_NOW_SHOTS = process.env.SH_OPEN_NOW_SHOTS === '1';
const openNowDir = fileURLToPath(new URL('../../../docs/evidence/screenshots/open-now/', import.meta.url));

async function openNowShot(page: Page, testInfo: TestInfo, name: string) {
  if (!OPEN_NOW_SHOTS) return;
  mkdirSync(openNowDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${openNowDir}${name}-${testInfo.project.name === 'mobile' ? '400' : '1280'}.png`, fullPage: true, scale: 'css' });
}

test('Opens Now by default: the first chip, "Now · next block" on the Overview, openAt 0 in the downloaded file', async ({ page, isMobile }, testInfo) => {
  await page.setViewportSize(isMobile ? { width: 400, height: 844 } : { width: 1280, height: 900 });
  await onSepolia(page);
  await page.goto('/create/basics');
  await fillBasics(page, { name: 'Quick Kites', ticker: 'QKITE', rgb: [90, 140, 220], shape: 0 });
  await next(page).click();
  await page.getByRole('radio', { name: /^Token/ }).check();
  await steps(page).getByRole('link', { name: /^Opening/ }).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 5 of 6: Opening');
  const opens = page.getByRole('group', { name: 'Opens', exact: true });
  await expect(opens.getByRole('radio')).toHaveCount(5);
  await expect(opens.locator('label')).toHaveText(['Now', '5 min', '1 h', '24 h', 'Pick a time']);
  await expect(opens.getByRole('radio', { name: 'Now', exact: true })).toBeChecked();
  // A preset has no time field and no UTC line: those belong to Pick a time.
  await expect(page.getByLabel('Time (UTC)', { exact: true })).toHaveCount(0);
  await noTrading(page, 'Opening (Now)');
  const tally: Record<string, WordSummary> = {};
  tally['5 Opening (Now)'] = await words(page);
  await openNowShot(page, testInfo, 'opening-now');
  // The budget's worst case with the extra chip: a picked time and its UTC line, and an amount typed (D17).
  await opens.getByRole('radio', { name: 'Pick a time', exact: true }).check();
  await page.getByRole('textbox', { name: 'Your ETH at start' }).fill('0.05');
  tally['5 Opening (pick a time, Sepolia)'] = await words(page);
  await openNowShot(page, testInfo, 'opening-pick-a-time');
  await page.getByRole('textbox', { name: 'Your ETH at start' }).fill('');
  // 1 h and back: the choice moves, Now comes back.
  await opens.getByRole('radio', { name: '1 h', exact: true }).check();
  await expect(opens.getByRole('radio', { name: 'Now', exact: true })).not.toBeChecked();
  await opens.getByRole('radio', { name: 'Now', exact: true }).check();
  await rights(page).check();
  await steps(page).getByRole('link', { name: /Overview/ }).click();
  await expect(page.getByRole('region', { name: 'Opening' })).toContainText('Now · next block');
  await expect(page.getByRole('group', { name: /^Preview: Quick Kites, QKITE, Token, Upcoming, Opens in <1 min, / }).first()).toBeAttached();
  await page.getByRole('textbox', { name: 'Your address' }).fill(PASTED);
  tally['6 Overview (token, Now)'] = await words(page);
  await openNowShot(page, testInfo, 'overview-now');
  if (isMobile) {
    // The budget (≤ 40 on the first screen) holds for Now and the Overview here. A picked time is the budget's worst
    // case, enforced on the Demo at 390 px by the flow test above (40 with the Now chip); on a chain source the
    // two-word source tag ("Sepolia testnet") makes it one more: recorded, and left to the founder (SH-open-now).
    for (const step of ['5 Opening (Now)', '6 Overview (token, Now)']) expect(tally[step]?.viewportMain.words, `${step}: words in <main> on the first screen`).toBeLessThanOrEqual(40);
    expect(tally['5 Opening (pick a time, Sepolia)']?.viewportMain.words).toBeLessThanOrEqual(41);
    expect(tally['6 Overview (token, Now)']?.pageMain.words, 'Overview: words in <main> on the whole page').toBeLessThanOrEqual(140);
    if (OPEN_NOW_SHOTS) writeFileSync(`${openNowDir}word-counts-400.json`, `${JSON.stringify(tally, null, 2)}\n`);
  }
  const { body } = await downloadSpec(page);
  expect(Number(body.spec.openAt)).toBe(0);
  const decoded = decodeBoxSpecV1(body.encoded);
  expect(decoded.openAt).toBe(0);
  expect(validateBoxSpecV1(decoded, CONTEXT_V2)).toEqual({ reason: Reason.OK, field: 0 });
  // Now is 0 (the block after the creation block, never in it); a delay or a block count is refused, never read as 1970.
  expect(validateBoxSpecV1({ ...decoded, openAt: 1 }, CONTEXT_V2).reason).toBe(Reason.OUT_OF_RANGE);
  expect(await walletTouches(page)).toEqual([]);
});

test('a far-off year and a huge ETH amount: the steps say so, the Overview still renders, and a reload too', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/create/basics');
  await fillBasics(page, { name: 'Far Off', ticker: 'FAR', rgb: [90, 90, 200], shape: 0 });
  await next(page).click();
  await page.getByRole('radio', { name: /^Token/ }).check();
  await steps(page).getByRole('link', { name: /^Opening/ }).click();
  await page.getByRole('radio', { name: 'Pick a time' }).check();
  await page.locator('#create-open-time').fill('9999-12-31T23:59');
  await page.getByRole('textbox', { name: 'Your ETH at start' }).fill(`1${'0'.repeat(80)}`);
  await next(page).click();
  await expect(page.getByRole('alert').getByRole('link')).toHaveText(['Pick a time within 14 days', 'Your ETH: Below the target: less than 4.206980085 ETH']);
  await steps(page).getByRole('link', { name: /Overview/ }).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(page.getByRole('region', { name: /^Opening · Fix/ })).toBeVisible();
  await expect(main(page).locator('.sh-newbox-cost')).toHaveText(/≈ [\d.,]+ ETH/);
  await page.reload();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(page.getByText(/^Draft restored/)).toBeVisible();
  expect(errors).toEqual([]);
});

// ── F74 (DECISION-LOG F74: U1, U2, U3, U5): SH_F74_SCREENSHOTS=1 writes docs/evidence/screenshots/F74/<name>-desktop.png
// (1440 px) and <name>-400.png (400 px wide); otherwise the test output folder, so an ordinary run never dirties the tree.
const F74_SHOTS = process.env.SH_F74_SCREENSHOTS === '1';
const f74Dir = fileURLToPath(new URL('../../../docs/evidence/screenshots/F74/', import.meta.url));

async function f74Shot(page: Page, testInfo: TestInfo, name: string) {
  const size = testInfo.project.name === 'mobile' ? '400' : 'desktop';
  const file = F74_SHOTS ? `${f74Dir}${name}-${size}.png` : testInfo.outputPath(`f74-${name}.png`);
  if (F74_SHOTS) mkdirSync(f74Dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true, scale: 'css' });
}

/** The phone size the F74 evidence is taken at: 400 px wide. */
async function f74Size(page: Page, isMobile: boolean) {
  if (isMobile) await page.setViewportSize({ width: 400, height: 844 });
}

test('F74 in the Demo: the collection cover, Holders with "Pending legal review", the cap in ETH, the one target; the Overview, the file and the box say so', async ({ page, isMobile }, testInfo) => {
  test.setTimeout(150_000);
  await f74Size(page, isMobile);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/create/basics');
  await fillBasics(page, { name: 'Snail Mail', ticker: 'SNAIL', rgb: [80, 160, 120], shape: 1 });
  await next(page).click();
  // U3: the collection's own cover beside the art, its own upload; the logo stays the token's picture.
  await page.getByRole('radio', { name: 'New collection' }).check();
  await page.getByLabel('Images + traits').setInputFiles(artFiles(10, 1));
  await expect(page.getByRole('status').filter({ hasText: '10 items · 2 traits' })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles(collectionCoverFile([220, 120, 60]));
  await expect(page.getByRole('button', { name: 'Collection cover Change' })).toBeAttached();
  await noTrading(page, 'F74 Contents');
  await f74Shot(page, testInfo, '02-contents-collection-cover');
  await page.getByRole('button', { name: 'About the collection cover' }).click();
  // Open art (the default): it is also each item's picture until the item is revealed.
  await expect(main(page).getByText('The collection’s picture on marketplaces, and each item’s until it is revealed. Your logo stays the token’s picture.')).toBeVisible();
  await page.getByRole('button', { name: 'About the collection cover' }).click();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Box kind');
  // U1: Holders on the buyers' side, paid in SNAIL (a buy), with its note in words; sellers' fees to you.
  const buyers = side(page, 'Buyers’');
  await buyers.getByRole('radio', { name: /^Holders/ }).check();
  await expect(buyers.getByRole('group', { name: 'Paid in' }).locator('label.sh-newbox-chip')).toHaveText(['ETH', 'SNAIL']);
  await buyers.getByRole('radio', { name: 'SNAIL', exact: true }).check();
  await expect(buyers.locator('p.sh-newbox-pending')).toHaveText('Pending legal review');
  await side(page, 'Sellers’').getByRole('radio', { name: 'You' }).check();
  // U2: the cap in fixed ETH per 30 days; the excess to holders (Demo, pending legal review).
  await main(page).locator('summary', { hasText: 'Fee cap' }).click();
  await page.getByRole('radio', { name: '32 ETH', exact: true }).check();
  await page.getByRole('group', { name: 'Above the cap' }).getByRole('radio', { name: /^Holders/ }).check();
  await expect(page.locator('#create-cap-excess-note')).toHaveText('Pending legal review');
  await noTrading(page, 'F74 Box kind');
  await f74Shot(page, testInfo, '03-kind-holders-demo');
  await next(page).click();
  // U5: the one target, a fact.
  await expect(page.locator('#create-target .sh-newbox-target__value')).toHaveText('4.206980085 ETH');
  await expect(page.getByRole('radio', { name: /ETH/ })).toHaveCount(0);
  await f74Shot(page, testInfo, '04-raise-one-target');
  await steps(page).getByRole('link', { name: /Overview/ }).click();
  const kind = page.getByRole('region', { name: 'Box kind' });
  await expect(kind).toContainText('Holders · SNAIL');
  await expect(kind).toContainText('You · SNAIL');
  await expect(kind).toContainText('32 ETH / 30 days · holders above');
  await expect(kind.locator('.sh-newbox-pending')).toHaveText(['Pending legal review', 'Pending legal review']);
  await expect(page.getByRole('region', { name: 'Raise' })).toContainText('4.206980085 ETH · 30 days');
  await expect(page.getByRole('region', { name: 'Contents' }).getByRole('img', { name: 'Collection cover added' })).toBeVisible();
  await rights(page).check();
  await connectDemo(page, 'Box wallet B');
  await noTrading(page, 'F74 Overview');
  await f74Shot(page, testInfo, '06-overview-demo');
  // The BoxSpec file names the Demo: holder payouts validate there only (never on mainnet).
  await main(page).locator('summary', { hasText: 'Details' }).click();
  const [saved] = await Promise.all([page.waitForEvent('download'), main(page).locator('.sh-newbox-spec').getByRole('button', { name: 'Download BoxSpec' }).click()]);
  const body = JSON.parse(readFileSync(await saved.path(), 'utf8')) as SpecFile;
  const decoded = decodeBoxSpecV1(body.encoded);
  expect(body.network).toBe('demo');
  expect(validateBoxSpecV1(decoded, CONTEXT_V2, 'demo')).toEqual({ reason: Reason.OK, field: 0 });
  expect(validateBoxSpecV1(decoded, CONTEXT_V2).reason).toBe(Reason.NOT_OFFERED);
  expect(validateBoxSpecV1(decoded, CONTEXT_V2, 'sepolia').reason).toBe(Reason.NOT_OFFERED);
  expect(decoded.raise).toBe(4_206_980_085n * 10n ** 9n);
  expect(sha256(Buffer.from(body.collectionCover?.base64 ?? '', 'base64'))).toBe(decoded.collectionCoverSha256);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/box\/31337\/0xde00c[0-9a-f]{35}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Snail Mail' })).toBeVisible();
  // The box: holder claims in the header's Owning one row, "Pending legal review" on its tile; About's sides, the cap in
  // ETH and the collection cover.
  await expect(page.locator('header.sh-box-head .sh-box-own')).toContainText('Holder claims');
  await page.getByRole('tab', { name: 'Owning one' }).click();
  await expect(page.locator('.sh-box-tile', { hasText: 'Holder claims' })).toContainText('Pending legal review');
  await page.getByRole('tab', { name: 'About' }).click();
  const about = page.locator('.sh-box-about');
  await expect(about).toContainText('Holders · SNAIL');
  await expect(about).toContainText('32 ETH / 30 days · above it to holders');
  await expect(about.locator('.sh-box-flag', { hasText: 'Pending legal review' })).toHaveCount(2);
  await expect(about.getByRole('img', { name: 'Collection cover' })).toBeVisible();
  // The header's cell states the one raise exactly, as box 0's does (F74 U5); why behind its (i).
  const target = page.locator('header.sh-box-head .sh-box-stat', { hasText: 'Target' });
  await expect(target).toContainText('4.206980085');
  await target.getByRole('button', { name: 'About Target' }).click();
  await expect(page.getByText('Every box raises the same.')).toBeVisible();
  await target.getByRole('button', { name: 'About Target' }).click();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await f74Shot(page, testInfo, '07-box-about-holders');
  // The Demo boxes raise the same: every bonding card reads the one target.
  await goInApp(page, '/');
  await expect(page.getByRole('link', { name: /^Pocket Stamps,/ })).toContainText('1.4303 / 4.206980085 ETH');
  await expect(page.getByRole('link', { name: /^Clay Pots,/ })).toContainText('2.6083 / 4.206980085 ETH');
  await f74Shot(page, testInfo, '08-feed-one-raise');
  expect(await walletTouches(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('F74 on a chain source: holder payouts off with "Not offered here yet", the one target; a sample draft with Holders is named there', async ({ page, isMobile }, testInfo) => {
  await f74Size(page, isMobile);
  // A draft made in the Demo with Holders on the buyers' side, then opened on Sepolia.
  await page.addInitScript((extras) => {
    if (window.sessionStorage.getItem('sh.create.draft.v2')) return;
    const form = {
      qIndex: 0, name: 'Snail Mail', ticker: 'SNAIL', description: '', links: { website: '', x: '', telegram: '' }, contents: 'token', separateCollection: false,
      collectionName: '', collectionSymbol: '', artMode: 'open', specials: [], ticketLine: 'Opens into one item once its number is drawn.', hiddenLine: 'This item is not revealed yet.',
      royaltyBps: 0, royaltyTo: 'fees', storeAll: false, pageLink: '', pageLinkEdited: false, qStream: 4, tStream: 1, capPerEpoch: '0', capExcess: 2, deadlineDays: 30,
      open: { kind: 'preset', blocks: 300 }, firstIn: '', rights: false, ownerText: '',
    };
    window.sessionStorage.setItem('sh.create.draft.v2', JSON.stringify({ form, cover: null, collectionCover: null, revealSaved: false, ...extras }));
  }, { v2: STORED_V2_DEFAULTS, parts: STORED_NO_PARTS });
  await onSepolia(page);
  await page.goto('/create/basics');
  await expect(page.locator('.sh-newbox__source')).toHaveText('Sepolia testnet');
  await expect(page.getByText(/^Draft restored/)).toBeVisible();
  await fillBasics(page, { name: 'Snail Mail', ticker: 'SNAIL', rgb: [80, 160, 120], shape: 1 });
  await next(page).click();
  await expect(page.getByRole('radio', { name: /^Token/ })).toBeChecked();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Box kind');
  for (const which of ['Buyers’', 'Sellers’'] as const) {
    const holders = side(page, which).getByRole('radio', { name: /^Holders/ });
    await expect(holders).toHaveAttribute('aria-disabled', 'true');
    await expect(holders).toHaveAccessibleDescription('Not offered here yet: pending legal review.');
  }
  await next(page).click();
  await expect(page.getByRole('alert').getByRole('link')).toHaveText(['Buyers’ fees: Not offered here yet, pending legal review']);
  // The Overview tags the kept holder payout "Demo only" here, never "Pending legal review" (that is the Demo's note).
  await steps(page).getByRole('link', { name: /^Overview/ }).click();
  const kindGroup = page.getByRole('region', { name: 'Box kind' });
  await expect(kindGroup).toContainText('Holders · ETH');
  await expect(kindGroup.locator('.sh-newbox-pending')).toHaveText(['Not offered here yet']);
  await steps(page).getByRole('link', { name: /^Box kind/ }).click();
  await side(page, 'Buyers’').getByRole('radio', { name: 'Burn', exact: true }).check();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await noTrading(page, 'F74 Sepolia Box kind');
  await f74Shot(page, testInfo, '03-kind-sepolia');
  await steps(page).getByRole('link', { name: /^Raise/ }).click();
  await expect(page.locator('#create-target .sh-newbox-target__value')).toHaveText('4.206980085 ETH');
  expect(await walletTouches(page)).toEqual([]);
});
