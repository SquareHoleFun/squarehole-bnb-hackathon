import { expect, test } from '@playwright/test';
import { boxHeader, DEMO_FIT, evidence, installUntouchableWallet, MISFITS_BOX, noTradingControls, openBox, TIN_CANS, TOY_TRAINS, walletTouches } from './box-helpers';

// The one box template (SH-BOX-UI-launch; F46; BOX-INTERFACE § 4) on the Demo data at 1440×900 and 390×844: the
// Misfits in each Demo state (the state band on the cover with its one figure, the stats with the founder's two
// numbers, the phase, the counters), the peek strip (a Misfit on the first screen), "What's in the box?" (N from the
// data, one ordinary example per family, never a token number, the composition keyed to its bar), the price picture
// (FIT per Misfit from the vault, the ETH price per 1M FIT, never ETH per Misfit; going in and out drawn), no
// fee-share notice (F49 D3), no vault action that looks clickable, no link out in Demo, the phone's counters pill and
// sheet, the tabs by keyboard. SH_EVIDENCE_SCREENSHOTS=1 writes docs/evidence/screenshots/sh-box-ui-launch/.

/** The ordinary examples in order (misfits-content.ts TEASERS): family and role, never a rare piece. */
const TEASERS = ['Sorter, Launcher', 'Coin, Launcher', 'Stonk, Explorer', 'Frame, Mechanic', 'RWA, Vault Keeper', 'Shapes, Creator', 'Coin, Mechanic', 'RWA, Explorer'];
const STATES = [
  { scenario: 'before_open', band: 'Upcoming', figure: /^in \d+ blocks$/, stats: ['Items', '1 Misfit', 'Price', 'Target'], conversion: 'Opens with the curve', phase: /^Launch tax 93\.20% → 8\.06% on buys$/ },
  { scenario: 'window', band: 'Launch window', figure: /^\d+ blocks? left$/, stats: ['Items', 'Reserved', '1 Misfit', 'Price'], conversion: 'Get a placeholder · in the app soon', phase: /^Launch tax \d+\.\d\d% on buys$/ },
  { scenario: 'curve', band: 'Bonding', figure: /^\d+\.\d% · [\d.]+ \/ 4\.206980085 ETH$/, stats: ['Items', 'Reserved', '1 Misfit', 'Price'], conversion: 'Get a placeholder · in the app soon', phase: null },
  { scenario: 'completed', band: 'Graduating', figure: /^not graduated yet$/, stats: ['Items', 'Reserved', '1 Misfit', 'Price'], conversion: 'Graduation pending', phase: /^(Graduation possible in \d+ blocks?|Anyone can trigger graduation|Price outside the graduation band|Graduation pending)$/ },
  { scenario: 'migrated', band: 'Graduated', figure: /^FDV [\d,.]+ ETH$/, stats: ['Items', 'Inside', '1 Misfit', 'Price'], conversion: 'Take one out · Put it back · in the app soon', phase: /^Graduated at block [\d,]+$/ },
] as const;
const band = (page: import('@playwright/test').Page) => boxHeader(page).locator('.sh-box-band');

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
});

test('/misfits and /fit open the FIT market’s box, keeping a Demo scenario', async ({ page }) => {
  await page.goto('/misfits');
  await expect(page).toHaveURL(new RegExp(`${MISFITS_BOX}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'The Misfits' })).toBeVisible();
  await page.goto('/fit?scenario=migrated');
  await expect(page).toHaveURL(new RegExp(`${MISFITS_BOX}\\?scenario=migrated$`));
  await expect(band(page).locator('.sh-box-band__label')).toHaveText('Graduated');
});

for (const state of STATES) {
  test(`${state.scenario}: the ${state.band} band and its figure, the stats, phase and counters, no vault action and no link out`, async ({ page }, testInfo) => {
    await openBox(page, state.scenario === 'curve' ? MISFITS_BOX : `${MISFITS_BOX}?scenario=${state.scenario}`);
    const header = boxHeader(page);
    // The state on the cover, in words, its colour and its one figure, on the first screen.
    await expect(band(page).locator('.sh-box-band__label')).toHaveText(state.band);
    await expect(band(page).locator('.sh-box-band__figure')).toHaveText(new RegExp(`^: ${state.figure.source.slice(1)}`));
    await expect(band(page)).toBeInViewport();
    await expect(header.locator('.sh-box-stat dt')).toHaveText([...state.stats]);
    // The founder's two numbers, side by side on the first screen: FIT per Misfit and the ETH price per 1M FIT.
    for (const label of ['1 Misfit', 'Price']) await expect(header.locator('.sh-box-stat', { has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })).toBeInViewport();
    // An open curve needs no phase line (as on the FIT pair page); every other state names what the band does not.
    if (state.phase === null) await expect(header.locator('.sh-box-phase')).toHaveCount(0);
    else await expect(header.locator('.sh-box-phase')).toHaveText(state.phase);
    // F130: no Demo chip, tape or word on the sample data's box page.
    await expect(header.locator('.sh-box-demo, .sh-box-tape')).toHaveCount(0);
    await expect(header).not.toContainText(/\bdemo\b/i);
    // A Misfit on the first screen: the peek strip's ordinary examples.
    await expect(header.locator('.sh-box-peekstrip img').first()).toBeInViewport();
    // The counters: on wide screens a row; on a phone a 44 px counters button (nothing to do in the app) that opens all three.
    if (testInfo.project.name === 'mobile') {
      await expect(header.locator('.sh-box-counters')).toBeHidden();
      const bar = page.getByRole('region', { name: 'Next step' });
      await expect(bar).toBeVisible();
      await expect(bar).toHaveText('');
      const box = await bar.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
      await bar.getByRole('button', { name: 'All counters: Conversion, Claims, Market' }).click();
      const sheet = page.getByRole('dialog', { name: 'Counters' });
      await expect(sheet.getByRole('region', { name: 'Conversion' })).toContainText(state.conversion);
      await expect(sheet.getByRole('region', { name: 'Market' })).toContainText(state.scenario === 'before_open' ? 'Starts with the curve' : 'No links on a local chain');
      if (state.scenario === 'curve') await evidence(page, testInfo, 'box-counters-sheet', { fullPage: false });
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    } else {
      const conversion = page.getByRole('region', { name: 'Conversion' });
      await expect(conversion).toContainText(state.conversion);
      // Actions not in this app are text behind a lock, like a closed counter: no button that looks clickable.
      await expect(conversion.locator('button:not(.sh-info-button)')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Market' })).toContainText(state.scenario === 'before_open' ? 'Starts with the curve' : 'No links on a local chain');
    }
    await expect(page.locator('main a[href^="http"]')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/fee share|outside liquidity/i);
    await noTradingControls(page);
    await evidence(page, testInfo, `box-${state.scenario}`);
  });
}

test('What’s in the box?: N from the data, one ordinary example per family (never a token number), the keyed composition, the sealed count', async ({ page }, testInfo) => {
  await openBox(page, MISFITS_BOX);
  await expect(page.getByRole('heading', { level: 2, name: '4,269 Misfits, sealed until graduation' })).toBeVisible();
  const peek = page.getByRole('button', { name: /, example$/ });
  await expect(peek).toHaveCount(8);
  expect(await peek.evaluateAll((tiles) => tiles.map((tile) => (tile.getAttribute('aria-label') ?? '').replace(/, example$/, '')))).toEqual(TEASERS);
  for (const src of await page.locator('.sh-box-peek img').evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src))) {
    // Only the ordinary pieces' art is loaded (F47): the hashed file names keep their source name.
    expect(src).toMatch(/\/m-B(02|04|06|09|13|15|17|18)-256-[\w-]+\.webp$/);
  }
  await expect(page.locator('main')).not.toContainText(/#\d/);
  const comp = page.locator('.sh-box-comp');
  await expect(comp.getByRole('img')).toHaveAttribute('aria-label', 'Families: Sorter 880, Coin 520, Stonk 840, Frame 880, RWA 864, Shapes about 200, One-of-ones 12, Classics 4, Icons 69');
  await expect(comp).toContainText('Diamond 26');
  await expect(comp).toContainText('Glass 28');
  await expect(comp).toContainText('Gold 31');
  await expect(comp).toContainText('Assumed');
  // Every legend entry is keyed to its part of the bar; the rare rows are one hatched part, never a sliver.
  await expect(comp.locator('.sh-box-comp__legend .sh-box-comp__key')).toHaveCount(9);
  const rare = await comp.locator('.sh-box-comp__bar > span[data-key="rare"]').boundingBox();
  expect(rare?.width ?? 0).toBeGreaterThanOrEqual(6);
  // The family avatars are cropped to the character (the render scaled up inside its circle).
  const avatar = comp.locator('.sh-box-avatar img').first();
  expect(await avatar.evaluate((image) => getComputedStyle(image).transform)).not.toBe('none');
  await expect(page.locator('.sh-box-sealed')).toContainText('Sealed inside4,232');

  // An example opens in a sheet; Escape closes it and focus goes back to the tile.
  const tile = page.getByRole('button', { name: 'Coin, Mechanic, example' });
  await tile.click();
  const sheet = page.getByRole('dialog', { name: 'Coin · Mechanic' });
  await expect(sheet).toContainText('Coin · 520');
  await expect(sheet).toContainText('Example. Never a token number.');
  await evidence(page, testInfo, 'box-example-sheet', { fullPage: false });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(tile).toBeFocused();
});

test('Owning one: the price picture in FIT and ETH per 1M FIT, from the vault math, going in and out drawn, never an ETH-per-Misfit figure', async ({ page }, testInfo) => {
  await openBox(page, `${MISFITS_BOX}?tab=owning`);
  const price = page.getByRole('region', { name: 'Price' });
  const quote = await price.locator('.sh-box-price__row strong').first().innerText();
  expect(quote).toMatch(/^2\d\d,\d{3} FIT$/);
  // ⌈(S − E)/n⌉ after the Demo stream's burn and the 37 placeholders: a little under the 234,247 of an untouched
  // 4,269 edition. The unit test checks the exact value against the vault math.
  const whole = Number(quote.replace(/[^0-9]/g, ''));
  expect(whole).toBeLessThanOrEqual(234_247);
  expect(whole).toBeGreaterThan(233_000);
  // The same number is the header's "1 Misfit" stat.
  await expect(boxHeader(page).locator('.sh-box-stat', { has: page.locator('dt', { hasText: /^1 Misfit$/ }) }).locator('dd')).toContainText(quote.replace(' FIT', ''));
  await expect(price.locator('.sh-box-price__row strong').nth(1)).toHaveText(/^0\.\d+ ETH$/);
  const flow = price.getByRole('list', { name: 'What going in and out does to the FIT in the vault' });
  await expect(flow.locator('li')).toHaveText([`Take one out+${quote} locked · 1% burned`, /^Put one back2\d\d,\d{3} FIT released · 5% burned$/]);
  await expect(price.locator('.sh-box-flow__total')).toHaveText(/^37 placeholders · [\d.]+M FIT locked · [\d.]+M FIT outside the vault$/);
  await expect(page.locator('main')).not.toContainText(/ETH per Misfit/i);
  await expect(page.getByText(`${quote} + 1% fee`)).toBeVisible();
  await price.getByRole('button', { name: 'About the price' }).click();
  await expect(price).toContainText('In and out keep that number; only burned FIT lowers it, slowly.');
  await expect(price).toContainText('What changes a Misfit’s ETH price is FIT’s market price.');
  await evidence(page, testInfo, 'box-owning');
  // After graduation the totals count Misfits outside, not placeholders.
  await openBox(page, `${MISFITS_BOX}?scenario=migrated&tab=owning`);
  await expect(page.getByRole('region', { name: 'Price' }).locator('.sh-box-flow__total')).toHaveText(/^90 outside · [\d.]+M FIT locked/);
});

test('the tabs work by keyboard and keep the section in the URL; Token reuses the pair page’s cards', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'keyboard');
  await openBox(page, MISFITS_BOX);
  const first = page.getByRole('tab', { name: 'What’s in the box?' });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Token' })).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`${MISFITS_BOX}\\?tab=token$`));
  await expect(page.getByRole('region', { name: 'Bonding curve' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Fees' }).locator('.sh-fit-fees__line')).toHaveText('1% pool fee');
  // F77: box 0's pool grows from its fees and launch tax; the Demo shows the amounts, labelled Demo (BC-142).
  await expect(page.getByRole('region', { name: 'Pool' }).locator('.sh-fit-fees__line')).toHaveText(/^Added: 0 ETH \+ 0 FIT · Waiting: [\d.,]+ ETH \+ [\d.,]+[KMB]? FIT$/);
  await expect(page.getByRole('region', { name: 'Open on' }).locator('.sh-fit-links__none')).toHaveText('No links');
  await expect(page.getByText(DEMO_FIT, { exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'About' })).toBeFocused();
  await expect(page.locator('.sh-box-about__tagline')).toHaveText('Different shapes. Same hole.');
  // F77: the Demo's set-up line gives box 0's split, numbers first.
  await expect(page.getByText('Pool fee 1%: 11/15 burns FIT · 2/15 into this pool · 2/15 platform. Sellers’ FIT: 13/15 burned or to the per-Misfit stream · 2/15 into this pool.')).toBeVisible();
  await expect(page.getByText('4,269 toy blocks that don’t fit, trying anyway.')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`${MISFITS_BOX}$`));
});

test('the peek strip opens What’s in the box? and moves focus to it', async ({ page }) => {
  await openBox(page, `${MISFITS_BOX}?tab=about`);
  await boxHeader(page).getByRole('button', { name: /^Sneak peek: four examples of 4,269 Misfits/ }).click();
  await expect(page).toHaveURL(new RegExp(`${MISFITS_BOX}$`));
  await expect(page.getByRole('heading', { level: 2, name: '4,269 Misfits, sealed until graduation' })).toBeFocused();
});

test('the same template for sample boxes: Toy Trains graduated with example blocks, Tin Cans failed', async ({ page }, testInfo) => {
  await openBox(page, TOY_TRAINS);
  await expect(page.getByRole('heading', { level: 2, name: '500 toy blocks · 48 outside the vault' })).toBeVisible();
  await expect(page.getByRole('img', { name: /toy block, example art$/ })).toHaveCount(12);
  await expect(band(page)).toHaveText(/^Graduated: FDV 18\.4 ETH$/);
  await evidence(page, testInfo, 'box-demo-graduated');
  await openBox(page, TIN_CANS);
  await expect(band(page).locator('.sh-box-band__label')).toHaveText('Failed');
  await expect(boxHeader(page).locator('.sh-box-phase')).toHaveText('Deadline passed');
  await expect(boxHeader(page)).toContainText('No preview shared');
  if (testInfo.project.name === 'mobile') await expect(page.getByRole('region', { name: 'Next step' })).toHaveText('Refund · No links on a local chain');
  await noTradingControls(page);
  expect(await walletTouches(page)).toEqual([]);
});
