import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { PRODUCTION_TERMS_DATE_TEXT, PRODUCTION_TERMS_VERSION } from '../terms-state';
import { LIVE_COIN, evidencePath, noDemoTrace, productionChain } from './production-fixture';
import { productionTarget } from './production-target';

/** SH-TA-02: the Sepolia test site (`SH_TARGET=sepolia`) shows the test network notice in place of the draft Terms. */
const TEST_SITE = productionTarget() === 'sepolia';

/** The page in full, or only its first screen (the Terms run to some 20,000 px: their top is the evidence). */
async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true) {
  const file = evidencePath(testInfo, name);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: file, fullPage, scale: 'css' });
}

// SH-V2-FE6: the production site (`SH_BUILD=production`, playwright.production.config.ts) against a stubbed Sepolia:
// the feed loads with no Demo trace anywhere, Settings offers Sepolia only, /create opens the format 2 flow with the
// live listings and templates that take their coins from them; nothing asks a wallet, nothing leaves the machine.

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('the feed: Sepolia’s boxes from the indexer, the Sepolia badge, no Demo trace, no wallet request', async ({ page }, testInfo) => {
  const chain = await productionChain(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  // Box 0 (core v1) and the v2 box, both from the stubbed indexer.
  await expect(page.locator(`a[href="/box/11155111/${chain.tokens.v1}"]`).first()).toBeVisible();
  await expect(page.locator(`a[href="/box/11155111/${chain.tokens.v2}"]`).first()).toBeVisible();
  await expect(page.locator('.sh-source-badge')).toHaveAttribute('data-source', 'sepolia');
  await expect(page.locator('.sh-source-badge strong')).toHaveText('Testnet');
  await expect(page).toHaveTitle('Boxes · Square Hole');
  expect(await page.locator('meta[name="description"]').getAttribute('content')).toBe('Different shapes. Same hole.');
  // The stamp the link-preview function goes by (src/share/build-stamp.ts).
  expect(await page.locator('meta[name="squarehole-build"]').getAttribute('content')).toBe('production');
  await noDemoTrace(page, 'feed');
  await shot(page, testInfo, 'feed');
  expect(chain.asked).toContain('/v1/feed');
  expect(chain.asked).toContain('/v2/feed');
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
  // SH-ARWEAVE-PICTURES-WEB: on the Sepolia test site a v2 box's pictures, missing on our node, are only searched for
  // by tag on the three Arweave gateways (no indexer copy in this recording, no candidate in the answers); nothing goes
  // to Turbo. The main site has no Arweave search (deployments-plugin.ts, arweavePictures is Sepolia's), so it asks none.
  if (TEST_SITE) {
    await expect.poll(() => ['https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net'].every((origin) => chain.arweave.includes(`POST ${origin}/graphql`))).toBe(true);
    expect(chain.arweave.every((asked) => /^(?:POST|OPTIONS) https:\/\/(?:turbo-gateway\.com|arweave\.net|goldsky\.arweave\.net)\/graphql$/.test(asked)), chain.arweave.join(', ')).toBe(true);
  } else {
    expect(chain.arweave, chain.arweave.join(', ')).toEqual([]);
  }
  expect(chain.escaped).toEqual([]);
});

test('a box from the feed opens with no Demo trace and no wallet request', async ({ page }, testInfo) => {
  const chain = await productionChain(page);
  await page.goto('/');
  await page.locator(`a[href="/box/11155111/${chain.tokens.v2}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/box/11155111/${chain.tokens.v2}$`));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main h2').first()).toBeVisible();
  await noDemoTrace(page, 'v2 box page');
  await shot(page, testInfo, 'box-v2');
  await page.goto(`/box/11155111/${chain.tokens.v1}`);
  await expect(page.locator('header.sh-box-head')).toBeVisible();
  await noDemoTrace(page, 'box 0');
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

test('Settings offers Sepolia only: no Demo, no local chain', async ({ page }, testInfo) => {
  const chain = await productionChain(page);
  await page.goto('/settings');
  const sources = page.getByTestId('data-source-settings');
  await expect(sources.getByRole('radio')).toHaveCount(1);
  await expect(sources.getByRole('radio', { name: /Sepolia testnet/ })).toBeChecked();
  await expect(sources).not.toContainText(/Demo|Local chain|anvil/);
  await noDemoTrace(page, 'settings');
  await shot(page, testInfo, 'settings');
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

test('/create: the format 2 flow with the live listings; templates take live coins, never a Demo one', async ({ page }, testInfo) => {
  const chain = await productionChain(page);
  await page.goto('/create');
  // SH-254: /create opens the visual way (the default); the steps keep their own address, checked here as before.
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  // ...and it really renders in the production build: the drawing with its ten parts, the ways control, no error page.
  await expect(page.locator('svg.sh-pic [data-part]')).toHaveCount(10);
  await expect(page.getByRole('navigation', { name: 'Launch' }).getByRole('link', { name: 'Visual' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText(/hit a problem/)).toHaveCount(0);
  await page.goto('/create/v2-basics');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 1 of 6: Basics');
  await expect(page.locator('.sh-newbox__source')).toHaveText('Sepolia testnet');
  // The live book: listing 0 (native ETH) and the indexer's test coin, its symbol read over the (stubbed) RPC.
  await expect(page.getByRole('radio', { name: /ETH/ }).first()).toBeVisible();
  await expect(page.getByRole('radio', { name: new RegExp(LIVE_COIN) })).toBeVisible();
  await expect(page.getByRole('radio', { name: /LINK|PAXG|NVDAon|CHOO|WBTC/ })).toHaveCount(0);
  const asked = chain.asked.filter((path) => path.startsWith('/v2/listings/'));
  expect(asked.length).toBeGreaterThan(0);
  expect(chain.rpc).toContain('eth_call symbol');
  // Templates (generic recipes since 2026-10-11): named by what the box does; a choice never picks the price coin.
  const tile = (name: string) => page.locator('.sh-v2-template', { has: page.locator('.sh-v2-template__name', { hasText: new RegExp(`^${name}$`) }) });
  // SH-V21-FE13: Shop, generic, now that the flow has its step.
  await expect(page.locator('.sh-v2-template__name')).toHaveText(['Liquidity token', 'Burn', 'To the creator', 'To holders', 'Collection', 'Collection that burns', 'Coin pile', 'Shop', 'Blank']);
  await expect(tile('Liquidity token').locator('.sh-v2-template__tag')).toHaveText('Token · Grow the pool');
  await expect(page.locator('.sh-v2-templates')).not.toContainText(/Deep End|Link Marines|Next Stop|Junkyard/);
  await shot(page, testInfo, 'create-basics');
  await page.getByRole('radio', { name: new RegExp(LIVE_COIN) }).check();
  await tile('Liquidity token').click();
  await expect(tile('Liquidity token')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('radio', { name: new RegExp(LIVE_COIN) })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  // SH-V2-FE8: the coin's issuer powers are read from its listed contract (the stub reverts every getter: none to name),
  // never the old "have not been checked" placeholder.
  expect(chain.rpc).toContain('eth_call');
  expect(chain.rpc).toContain('eth_getCode');
  await expect(page.locator('[data-pricing-card]')).not.toContainText(/have not been checked|could not be read|The issuer can/);
  await tile('Burn').click();
  await expect(page.getByRole('radio', { name: new RegExp(LIVE_COIN) })).toBeChecked();
  await tile('Shop').click();
  await expect(tile('Shop')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('radio', { name: new RegExp(LIVE_COIN) })).toBeChecked();
  await noDemoTrace(page, 'create basics');
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

test('the first handoff’s pair pages are not part of the site: their links open the boxes and My Box', async ({ page }) => {
  const chain = await productionChain(page);
  await page.goto('/pairs');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/rewards');
  await expect(page).toHaveURL(/\/my-box$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await noDemoTrace(page, 'my box');
  await page.goto('/create/basics');
  await expect(page).toHaveURL(/\/create\/v2-basics$/);
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

/**
 * SH-ALPHA-NOTICE (F156): the trading card each target shows, in the slot before the Terms card: the main site's "No
 * trading here", word for word, or the Sepolia alpha's "Test trades only" (the trade code is in the Sepolia build only).
 */
const TRADING = TEST_SITE
  ? {
      title: 'Test trades only',
      figures: ['Real money0', 'Wallet amountsExact'],
      lead: 'Box pages buy and sell test tokens only; browsing never opens your wallet.',
      details: ['Trades open your wallet only when you press Buy or Sell, for the exact amount; a wallet Privy made signs on that press, with no window of its own.', 'In a box’s first 6.4 min, buys go through the box’s launch router and pay its tax.', 'Other trades go through Uniswap’s test swap contract, with a price limit but no deadline; they can fill in part.', 'Square Hole never holds your test tokens or your keys.'],
      strip: 'Test trades only',
      other: /No trading here|Trade forms|Wallet pop-ups|outside venues|link only to reviewed sites/,
    }
  : {
      title: 'No trading here',
      figures: ['Trade forms0', 'Wallet pop-ups0'],
      lead: 'Trades happen on outside venues; browsing never opens your wallet.',
      details: ['Box pages link only to reviewed sites', 'A wallet asks for your approval only after you connect and start an action: creating a box, a vault action, a claim or closing a box.', 'A browser wallet you connected here reconnects when you come back, without opening; Disconnect stops that.', 'Square Hole never holds your tokens or keys.'],
      strip: 'None today',
      other: /Test trades only|Real money|Wallet amounts|test swap contract|launch router and pay its tax/,
    };

test('About & risks (the core v2 cards, the same as the development build’s) and the Misfits link: no Demo trace', async ({ page }, testInfo) => {
  const chain = await productionChain(page);
  await page.goto('/about/risks');
  await expect(page.getByRole('heading', { level: 1, name: 'About & risks' })).toBeVisible();
  await expect(page.locator('.sh-risks__status')).toContainText('Sepolia testnet (11155111)');
  await expect(page.locator('.sh-risks__status')).toContainText(/Test tokens\s*No value/);
  await expect(page.locator('.sh-risks__status')).toContainText(new RegExp(`In-app trading\\s*${TRADING.strip}`));
  const cards = page.locator('.sh-about-grid > .sh-about-card h2');
  await expect(cards).toHaveText(['What’s a box', 'Curve & graduation', 'Fees & payouts', 'Failure & claim', 'Coins, stocks & gold', 'Box 0 · The Misfits', 'Our boxes', 'More risks', TRADING.title, 'Terms']);
  // The trading card: figures first, one lead line, its details behind a disclosure that starts closed.
  const trading = page.locator('[data-card="risks-trading"]');
  await expect(trading.locator('h2')).toHaveText(TRADING.title);
  await expect(trading.locator('.sh-about-figure')).toHaveText(TRADING.figures);
  await expect(trading.locator('.sh-about-card__lead')).toHaveText(TRADING.lead);
  // SH-ALPHA-SITE (the trade box's finding 2): the footer follows the build too: test trades on the Sepolia alpha, none
  // on the main site.
  await expect(page.locator('.sh-footer')).toContainText(TEST_SITE ? 'Test trades only' : 'No in-app trading');
  await expect(page.locator('.sh-footer')).not.toContainText(TEST_SITE ? 'No in-app trading' : 'Test trades only');
  // SH-THIRD-PARTY-NOTICES integrator request 1: the production build's notices file, linked from the Terms card.
  const notices = page.getByRole('link', { name: 'Third-party notices' });
  await expect(notices).toHaveAttribute('href', '/third-party-notices.txt');
  const file = await page.request.get('/third-party-notices.txt');
  expect(file.status()).toBe(200);
  expect(await file.text()).toMatch(/^Third-party notices\n/);
  await expect(trading.locator('details')).toHaveJSProperty('open', false);
  await expect(trading.locator('summary')).toHaveText(`Details: ${TRADING.title}`);
  await expect(page.getByRole('main')).not.toContainText(TRADING.other);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await trading.screenshot({ path: evidencePath(testInfo, `alpha-notice-card-${TEST_SITE ? 'sepolia' : 'mainnet'}`), scale: 'css' });
  await trading.locator('summary').click();
  for (const line of TRADING.details) await expect(trading.locator('details li').filter({ hasText: line })).toHaveCount(1);
  await trading.screenshot({ path: evidencePath(testInfo, `alpha-notice-card-${TEST_SITE ? 'sepolia' : 'mainnet'}-open`), scale: 'css' });
  await trading.locator('summary').click();
  await expect(trading.locator('details')).toHaveJSProperty('open', false);
  // F133 (SH-V2-FE10): Square Hole's own boxes by contract address, box 0 first; its mainnet address is still the open item
  // on the main site. The Sepolia test site ships no open item (SH-TA-02): it says box 0 is not on mainnet yet.
  const ours = page.getByRole('region', { name: 'Our boxes' }).locator('.sh-about-ours__box');
  await expect(ours).toHaveCount(1);
  await expect(ours.first()).toContainText('The Misfits');
  await expect(ours.first()).toContainText('Box 0 · FIT');
  if (TEST_SITE) {
    await expect(ours.first().locator('mark')).toHaveCount(0);
    await expect(ours.first().locator('.sh-about-ours__address')).toHaveText('Not on mainnet yet');
  } else {
    await expect(ours.first().locator('mark')).toHaveText('[FOUNDER: box 0’s mainnet addresses once deployed (counsel pack, Question 1).]');
  }
  await expect(page.getByRole('region', { name: 'This is a demo' })).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText(/\bpairs?\b|production gates/i);
  await noDemoTrace(page, 'about & risks');
  await shot(page, testInfo, 'risks');
  await page.evaluate(() => document.querySelectorAll('main details').forEach((details) => ((details as HTMLDetailsElement).open = true)));
  await noDemoTrace(page, 'about & risks, every detail open');
  // Every detail open, on the phone only (the width the founder checks; the desktop one adds nothing but bytes).
  if (testInfo.project.name === 'mobile') await shot(page, testInfo, 'risks-open');
  await page.goto('/misfits');
  await expect(page).toHaveURL(new RegExp(`/box/11155111/${chain.tokens.v1}$`));
  await noDemoTrace(page, 'misfits');
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

test('the Terms and the privacy notice: the production drafts for counsel, with no Demo trace and every open item marked (SH-V2-FE7)', async ({ page }, testInfo) => {
  test.skip(TEST_SITE, 'the Sepolia test site shows the test network notice instead (production-test-network.spec.ts)');
  const chain = await productionChain(page);
  await page.goto('/about/terms');
  await expect(page.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(`Version ${PRODUCTION_TERMS_VERSION} · Draft of ${PRODUCTION_TERMS_DATE_TEXT}`);
  await noDemoTrace(page, 'terms');
  const main = page.getByRole('main');
  await expect(main).not.toContainText(/test build|test pairs|Planned design|demo data/i);
  await expect(main).toContainText('Payouts are claimed, never sent.');
  expect((await main.locator('mark').allInnerTexts()).length).toBeGreaterThan(50);
  await shot(page, testInfo, 'terms', false);
  await page.goto('/about/privacy');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeVisible();
  await noDemoTrace(page, 'privacy');
  await shot(page, testInfo, 'privacy', false);
  await expect(page.getByRole('main')).toContainText('the server receives that wallet address together with your IP address');
  await expect(page.getByRole('main')).not.toContainText(/local chain|this build/i);
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});
