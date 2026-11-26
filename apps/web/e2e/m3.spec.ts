import { expect, test } from '@playwright/test';
import { goInApp } from './feed-helpers';
import { LEGACY_OFF } from './legacy-off';
import {
  FRAMES_ID,
  ORCHARD_ID,
  ROUND_ID,
  card,
  chooseScenario,
  claimButton,
  connectAs,
  disconnect,
  evidence,
  figure,
  installUntouchableWallet,
  main,
  overflow,
  recordStatuses,
  recordedStatuses,
  txPanel,
  walletTouches,
} from './m3-helpers';

// M3 (SH-014, SH-015 part 2) in a real browser, at 1440x900 and 390x844: /portfolio, /rewards and /settings, the three
// demo personas and every M3 gate. Scripted demo steps are 700 ms apart; nothing is signed or broadcast. Claims and
// Portfolio are off in every build since F134 R46B (they open My Box): their tests skip themselves, Settings' run.

const SIGNED = ['preparing', 'awaiting_signature', 'submitted', 'pending'];

test.describe('disconnected', () => {
  test.skip(true, LEGACY_OFF);
  test('rewards and portfolio explain what they need and only offer an explicit button (UI-09)', async ({ page }) => {
    await installUntouchableWallet(page);
    for (const [path, prompt] of [
      ['/rewards', 'Connect a wallet to see your claims'],
      ['/portfolio', 'Connect a wallet to see your portfolio'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 2, name: prompt })).toBeVisible();
      const button = main(page).getByRole('button', { name: 'Connect wallet' });
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(main(page).locator('article')).toHaveCount(0);
    }
    await page.waitForTimeout(300);
    expect(await walletTouches(page)).toEqual([]);
  });
});

test.describe('personas', () => {
  test.skip(true, LEGACY_OFF);
  test('past holder (zero balance) sees earlier earnings per asset, with a read-only estimate (ECO-05)', async ({ page }, testInfo) => {
    await installUntouchableWallet(page);
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    await expect(page.getByRole('heading', { level: 2, name: 'Your claims' })).toBeFocused();
    const orchard = card(page, 'ORCHARD');
    await expect(orchard.getByText(/You hold no ORCH now/)).toBeVisible();
    await expect(figure(orchard, 'claimable')).toHaveText('9.705953 AAPLx-DEMO');
    await expect(claimButton(orchard)).toHaveText('Claim 9.705953 AAPLx-DEMO');
    const frames = card(page, 'TINY FRAMES');
    const estimate = frames.getByTestId('conversion-estimate');
    await expect(estimate).toContainText('≈ 163.149767 FRAME');
    await expect(estimate).toContainText('161.518269 FRAME');
    await expect(estimate).toContainText('25 Sep 2026, 12:20 UTC');
    await expect(frames.getByTestId('emergency-settlement')).toHaveCount(0);
    await expect(main(page).getByRole('textbox')).toHaveCount(0);
    await expect(main(page).getByRole('spinbutton')).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await evidence(page, testInfo, 'M3-rewards-past-holder', { fullPage: true });
    expect(await walletTouches(page)).toEqual([]);
  });

  test('current holder: portfolio shows each balance once, whole NFTs + fraction beneath, and NFT ids', async ({ page }, testInfo) => {
    await page.goto('/portfolio');
    await connectAs(page, 'Current holder');
    const orchard = card(page, 'ORCHARD');
    await expect(figure(orchard, 'balance')).toHaveText('3.25 ORCH');
    await expect(figure(orchard, 'representation')).toContainText('3 whole NFTs + 0.25 ORCH, not yet a whole NFT');
    await expect(orchard.getByRole('list', { name: 'ORCHARD NFT ids' }).getByRole('listitem')).toHaveText(['#7', '#12', '#31']);
    await expect(figure(card(page, 'TINY FRAMES'), 'representation')).toContainText('0 whole NFTs + 0.5 FRAME, not yet a whole NFT');
    await expect(figure(card(page, 'ROUND TRIP'), 'representation')).toHaveText('Tokens only (no NFT representation)');
    await expect(page.getByRole('heading', { name: 'Fractions are not a piece of a particular NFT' })).toBeVisible();
    await expect(orchard.getByRole('link', { name: 'Pair detail: ORCHARD' })).toHaveAttribute('href', '/pair/31337/0x0000000000000000000000000000000000000066');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await evidence(page, testInfo, 'M3-portfolio', { fullPage: true });

    await orchard.getByRole('link', { name: 'Claims for ORCHARD' }).click();
    await expect(page).toHaveURL(/\/rewards\?pair=31337%3A0x0+66$/);
    await expect(main(page).locator('article').first()).toHaveAttribute('data-pair-id', ORCHARD_ID);
    await expect(main(page).locator('article').first()).toHaveAttribute('data-selected', 'true');
  });

  test('current holder with ?pair= on a pair without rewards: "Nothing claimable yet", disabled', async ({ page }) => {
    await page.goto(`/rewards?pair=${ROUND_ID}`);
    await connectAs(page, 'Current holder');
    const round = card(page, 'ROUND TRIP');
    await expect(round).toHaveAttribute('data-selected', 'true');
    await expect(claimButton(round)).toHaveText('Nothing claimable yet');
    await expect(claimButton(round)).toBeDisabled();
    await expect(figure(card(page, 'ORCHARD'), 'pending')).toHaveText('0.00001 AAPLx-DEMO');
  });

  test('never held: honest empty states on both pages', async ({ page }) => {
    await page.goto('/rewards');
    await connectAs(page, 'Never held');
    await expect(page.getByTestId('rewards-empty')).toContainText('No claims on this account');
    await expect(main(page).getByTestId('claim-button')).toHaveCount(0);
    await goInApp(page, '/portfolio');
    await expect(page.getByTestId('portfolio-empty')).toContainText('No current balances');
  });
});

test.describe('M3 gates', () => {
  test.skip(true, LEGACY_OFF);
  test('past holder with zero balance claims prior earnings; only finalized counts; consumed once (ECO-05, ECO-07)', async ({ page }, testInfo) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    const orchard = card(page, 'ORCHARD');
    await recordStatuses(page, ORCHARD_ID);
    await claimButton(orchard).click();
    const sign = orchard.getByRole('button', { name: 'Sign', exact: true });
    await expect(sign).toBeVisible();
    await evidence(page, testInfo, 'M3-claim-flow-signature', { locator: orchard });
    await sign.click();
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'confirmed_unfinalized');
    await expect(txPanel(orchard)).toContainText('It is not final yet');
    await expect(figure(orchard, 'claimable')).toHaveText('9.705953 AAPLx-DEMO');
    await evidence(page, testInfo, 'M3-claim-flow-included', { locator: orchard });
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'finalized');
    await expect(figure(orchard, 'claimable')).toHaveText('0 AAPLx-DEMO');
    await expect(figure(orchard, 'claimed')).toHaveText('9.705953 AAPLx-DEMO');
    await expect(claimButton(orchard)).toHaveText('Nothing claimable yet');
    await expect(claimButton(orchard)).toBeDisabled();
    expect(await recordedStatuses(page)).toEqual(['idle', ...SIGNED, 'confirmed_unfinalized', 'finalized']);
    await evidence(page, testInfo, 'M3-claim-flow-finalized', { locator: orchard });
  });

  test('min-out revert: the failed conversion keeps the claim intact, and the claim button (one retry control) retries it', async ({ page }, testInfo) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    await chooseScenario(page, 'Reverts: payout below the signed minimum');
    const frames = card(page, 'TINY FRAMES');
    await claimButton(frames).click();
    await frames.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(txPanel(frames)).toHaveAttribute('data-tx-status', 'reverted');
    await expect(txPanel(frames)).toContainText('Your claim is still intact.');
    await expect(txPanel(frames)).toContainText('min_payout_not_met');
    await expect(figure(frames, 'claimable')).toHaveText('0.081574 WETH-DEMO');
    await expect(txPanel(frames).getByRole('button', { name: 'Start again' })).toHaveCount(0);
    await expect(claimButton(frames)).toBeEnabled();
    await evidence(page, testInfo, 'M3-claim-flow-reverted', { locator: frames });
    await chooseScenario(page, 'Success: included, then finalized');
    await claimButton(frames).click();
    await frames.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(txPanel(frames)).toHaveAttribute('data-tx-status', 'finalized');
    await expect(figure(frames, 'claimable')).toHaveText('0 WETH-DEMO');
  });

  test('conversion unavailable: the labelled emergency settlement appears only then and pays WETH-DEMO', async ({ page }, testInfo) => {
    await page.goto('/rewards?scenario=conversion_fails');
    await connectAs(page, 'Past holder');
    const frames = card(page, 'TINY FRAMES');
    await expect(frames.getByTestId('emergency-settlement')).toContainText('Emergency settlement: WETH-DEMO paid directly');
    await expect(frames.getByTestId('conversion-estimate')).toHaveCount(0);
    await expect(card(page, 'ORCHARD').getByTestId('emergency-settlement')).toHaveCount(0);
    await evidence(page, testInfo, 'M3-claim-flow-emergency', { locator: frames });
    await claimButton(frames).click();
    await frames.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(txPanel(frames)).toHaveAttribute('data-tx-status', 'finalized');
    await expect(frames.getByTestId('emergency-settlement')).toHaveCount(0);
    await expect(figure(frames, 'claimable')).toHaveText('0 WETH-DEMO');
  });

  test('wrong chain: reads work, the claim asks for an explicit switch, then proceeds', async ({ page }, testInfo) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder', { wrongNetwork: true });
    await expect(page.getByTestId('wrong-network-notice')).toContainText('Your wallet is on Ethereum (1)');
    const orchard = card(page, 'ORCHARD');
    await claimButton(orchard).click();
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'wrong_chain');
    await evidence(page, testInfo, 'M3-claim-flow-wrong-chain', { locator: orchard });
    await orchard.getByRole('button', { name: 'Switch to Local chain (31337)' }).click();
    await expect(page.getByTestId('wrong-network-notice')).toHaveCount(0);
    await orchard.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'finalized');
  });

  test('quote deadline on the demo clock: an unsigned conversion is cancelled and the stale estimate disappears', async ({ page }, testInfo) => {
    await page.clock.install();
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    const frames = card(page, 'TINY FRAMES');
    await claimButton(frames).click();
    await expect(frames.getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
    await page.clock.fastForward('20:01');
    await expect(txPanel(frames)).toHaveAttribute('data-tx-status', 'invalidated');
    await expect(txPanel(frames)).toContainText('Quote expired');
    await expect(frames.getByTestId('needs-quote')).toBeVisible();
    await expect(frames.getByTestId('conversion-estimate')).toHaveCount(0);
    await expect(claimButton(frames)).toHaveText('Waiting for a current quote');
    await expect(claimButton(frames)).toBeDisabled();
    await expect(figure(frames, 'claimable')).toHaveText('0.081574 WETH-DEMO');
    await evidence(page, testInfo, 'M3-claim-flow-quote-expired', { locator: frames });
  });

  test('deadline_expiry scenario: the card shows "No current quote" like a real expiry until the estimate is refreshed', async ({ page }, testInfo) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    await chooseScenario(page, 'Quote deadline passes before signing');
    const frames = card(page, 'TINY FRAMES');
    await claimButton(frames).click();
    await expect(txPanel(frames)).toHaveAttribute('data-tx-status', 'invalidated');
    await expect(txPanel(frames)).toContainText('Refresh the estimate above, then claim again.');
    // One state, no contradiction: the stale quote is not shown as current and there is no second retry button.
    await expect(frames.getByTestId('conversion-estimate')).toHaveCount(0);
    await expect(frames.getByTestId('needs-quote')).toBeVisible();
    await expect(claimButton(frames)).toHaveText('Waiting for a current quote');
    await expect(claimButton(frames)).toBeDisabled();
    await expect(txPanel(frames).getByRole('button', { name: 'Start again' })).toHaveCount(0);
    await expect(figure(frames, 'claimable')).toHaveText('0.081574 WETH-DEMO');
    await evidence(page, testInfo, 'M3-claim-flow-deadline-scenario', { locator: frames });
    await frames.getByRole('button', { name: 'Refresh the estimate' }).click();
    await expect(txPanel(frames)).toHaveCount(0);
    await expect(frames.getByTestId('conversion-estimate')).toBeVisible();
    await expect(claimButton(frames)).toHaveText('Claim as FRAME');
    await expect(claimButton(frames)).toBeEnabled();
  });

  test('reorg: included, back to pending, included again, then finalized', async ({ page }, testInfo) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    await chooseScenario(page, 'Included, reorganised out, included again, finalized');
    const orchard = card(page, 'ORCHARD');
    await recordStatuses(page, ORCHARD_ID);
    await claimButton(orchard).click();
    await orchard.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(txPanel(orchard)).toContainText('Included in block 39601');
    await expect(txPanel(orchard)).toContainText('Waiting for the transaction to be included in a block');
    await evidence(page, testInfo, 'M3-claim-flow-reorg-pending', { locator: orchard });
    await expect(figure(orchard, 'claimable')).toHaveText('9.705953 AAPLx-DEMO');
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'finalized');
    expect(await recordedStatuses(page)).toEqual(['idle', ...SIGNED, 'confirmed_unfinalized', 'pending', 'confirmed_unfinalized', 'finalized']);
    await expect(txPanel(orchard)).toContainText('Finalized in block 39602');
  });

  test('lost connection before signing: the request is dropped and the claim is intact after reconnecting', async ({ page }) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    await claimButton(card(page, 'ORCHARD')).click();
    await expect(card(page, 'ORCHARD').getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
    await disconnect(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Connect a wallet to see your claims' })).toBeVisible();
    await connectAs(page, 'Past holder');
    await expect(txPanel(card(page, 'ORCHARD'))).toHaveCount(0);
    await expect(figure(card(page, 'ORCHARD'), 'claimable')).toHaveText('9.705953 AAPLx-DEMO');
  });

  test('lost connection after signing: the sent claim stays tracked to its result', async ({ page }, testInfo) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    const orchard = card(page, 'ORCHARD');
    await claimButton(orchard).click();
    await orchard.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', /submitted|pending/);
    await disconnect(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Wallet disconnected' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Claims still being tracked' })).toBeVisible();
    await expect(card(page, 'TINY FRAMES')).toHaveCount(0);
    await expect(claimButton(orchard)).toBeDisabled();
    await evidence(page, testInfo, 'M3-claim-flow-disconnected');
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'finalized');
    await expect(figure(orchard, 'claimable')).toHaveText('0 AAPLx-DEMO');
  });

  test('lost connection to the chain after sending: no receipt / unknown status keeps the claim and says to check the hash', async ({ page }) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    const orchard = card(page, 'ORCHARD');
    await chooseScenario(page, 'Receipt unavailable: status unknown');
    await claimButton(orchard).click();
    await orchard.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'unknown');
    await expect(txPanel(orchard)).toContainText('check its hash before trying again');
    await expect(figure(orchard, 'claimable')).toHaveText('9.705953 AAPLx-DEMO');
  });

  test('account data unavailable: an explicit failure with a retry, never zeros', async ({ page }) => {
    await page.goto('/rewards?scenario=unavailable');
    await connectAs(page, 'Past holder');
    await expect(page.getByRole('alert')).toContainText('Claims unavailable');
    await expect(main(page).locator('[data-figure]')).toHaveCount(0);
  });
});

test.describe('keyboard', () => {
  test('connect, claim and sign with the keyboard only; focus never falls back to the page', async ({ page }) => {
    test.skip(true, LEGACY_OFF);
    await page.goto('/rewards');
    const connect = main(page).getByRole('button', { name: 'Connect wallet' });
    await connect.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
    await expect(dialog.getByRole('radio', { name: 'Current holder' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('radio', { name: 'Past holder' })).toBeChecked();
    const submit = dialog.getByRole('button', { name: 'Connect sample wallet' });
    for (let i = 0; i < 6 && !(await submit.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Your claims' })).toBeFocused();

    const orchard = card(page, 'ORCHARD');
    const claim = claimButton(orchard);
    for (let i = 0; i < 30 && !(await claim.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press('Tab');
    await expect(claim).toBeFocused();
    await page.keyboard.press('Enter');
    // Right after pressing Claim, focus stays on the (now aria-disabled) button, never on <body> (WCAG 2.4.3).
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await expect(claim).toBeFocused();
    await expect(claim).toHaveAttribute('aria-disabled', 'true');
    const sign = orchard.getByRole('button', { name: 'Sign', exact: true });
    await expect(sign).toBeVisible();
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    for (let i = 0; i < 10 && !(await sign.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press('Tab');
    await expect(sign).toBeFocused();
    await page.keyboard.press('Enter');
    // The sign button is gone; focus moves to the status panel heading, not to <body>.
    await expect(orchard.locator('[data-tx-status-heading]')).toBeFocused();
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'finalized');
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });

  test('"/" can be turned off in Settings (WCAG 2.1.4), and the choice survives a reload', async ({ page }, testInfo) => {
    await page.goto('/settings');
    await page.keyboard.press('/');
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/settings');
    const toggle = main(page).getByRole('checkbox', { name: 'Press / to search' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();
    await expect(main(page).getByRole('status')).toHaveText('Saved on this device.');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('banner').getByRole('button', { name: 'Search boxes' })).not.toHaveAttribute('aria-keyshortcuts', '/');
    await page.reload();
    await expect(main(page).getByRole('checkbox', { name: 'Press / to search' })).not.toBeChecked();
    await evidence(page, testInfo, 'M3-settings', { fullPage: true });
  });
});

test.describe('settings', () => {
  test('"Reduce motion" is saved and applied to <html>', async ({ page }) => {
    await page.goto('/settings');
    await expect(main(page).getByRole('radio', { name: /^Sample data/ })).toBeChecked();
    await expect(main(page).getByText('Dark only.')).toBeVisible();
    await main(page).getByRole('radio', { name: 'Reduce motion' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
    // The pair feed's pin, which held the 3D accent this test also checked, is off in every build (F134 R46B); the option is "Allow motion" since SH-V2-FE11.
    const radio = await page.goto('/settings').then(() => main(page).getByRole('radio', { name: 'Allow motion' }));
    await radio.check();
    await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduce');
  });

  test('44px targets and no horizontal overflow in Settings', async ({ page }) => {
    await page.goto('/settings');
    for (const name of ['Allow motion', 'Reduce motion']) {
      const option = main(page).locator('label.sh-settings__option').filter({ hasText: name });
      expect((await option.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // Claims and Portfolio, measured here before, are off in every build (F134 R46B).
  });
});

test('FRAMES pair id helper matches the fixture', () => {
  expect(FRAMES_ID).toMatch(/^31337:0x0+6a$/);
});
