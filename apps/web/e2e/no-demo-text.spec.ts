import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { installUntouchableWallet, notTheErrorPage, walletTouches } from './box-helpers';
import { LEGACY_REDIRECTS } from './legacy-off';

// F130 (founder desk round 44, 2026-10-11, R44B): "Remove all Demo badges, mentions, no need for that. People know
// which version they are using." No Demo badge, tape, chip, word or explanation anywhere in the UI, in the development
// build too (the production build has none: e2e/production/). It supersedes "mock data stays labelled Demo" for labels;
// the sample data still never ships to production (pnpm check:production). Settings names it "Sample data".
//
// Read on every route with the sample data (the default source), at both viewports: all text in the page (hidden and
// visually hidden text included: a screen reader or a closed disclosure is still the UI), the accessible names,
// descriptions, tooltips, placeholders and alt texts, the page title and the page head's description and link-preview
// tags. e2e never imports src, so the rule is restated here: the words demo and mock, alone or as part of a name
// ("Demo", "USDC-DEMO", "Mock"), never inside another word.
//
// No exception any more (F134 R46B, founder desk round 46, 2026-10-11): the first handoff's pages (/pairs, /pair/…,
// /rewards, /portfolio), the only ones that showed the M1 fixture's coins (USDC-DEMO, AAPLx-DEMO, WETH-DEMO) and its
// descriptions, are off in every build, as on the production site. Their old links are crawled like every route: they
// open the boxes or My Box, and nothing there may say demo or mock either.

/** The words, alone or as a part of a symbol or a name ("USDC-DEMO", "Demos"), never inside another word. */
export const DEMO_WORD = /(?<![a-z])(?:demo|mock)s?(?![a-z])/i;
/**
 * The founder's wording rule (2026-10-11), read on the same routes: a box with no NFTs is a "Token" box, never "just the
 * token" or "token only" (it belittles the creator). src/copy-wording.test.ts checks the source.
 */
const BELITTLING = /\bjust (?:the|a) token\b|\btoken[- ]only\b|\bonly (?:the|a) token\b/i;

const FIT = '/box/31337/0x000000000000000000000000000000000000f17e';
const v2 = (n: number) => `/box/31337/0xde027${'0'.repeat(31)}${n.toString(16).padStart(4, '0')}`;
const ORCHARD = '0x0000000000000000000000000000000000000066';

const ROUTES = [
  '/',
  '/?state=bonding&view=list',
  FIT,
  `${FIT}?tab=token`,
  `${FIT}?tab=owning`,
  `${FIT}?tab=about`,
  `${FIT}?scenario=window`,
  `${FIT}?scenario=completed`,
  `${FIT}?scenario=migrated&tab=owning`,
  '/box/31337/0xde00700000000000000000000000000000000003',
  '/box/31337/0xde00700000000000000000000000000000000003?tab=token',
  '/box/31337/0xde00700000000000000000000000000000000005',
  v2(1),
  `${v2(1)}?tab=token`,
  v2(2),
  v2(3),
  `${v2(3)}?tab=owning`,
  v2(4),
  '/wallet/0xde00000000000000000000000000000000000a11',
  '/wallet/0xde00000000000000000000000000000000000b22',
  '/my-box',
  '/misfits',
  '/fit-pair',
  '/fit-pair?scenario=migrated',
  // The first handoff's old links (F134 R46B): each opens the boxes or My Box.
  ...LEGACY_REDIRECTS.map(([from]) => from),
  '/create/v2-basics',
  '/create/v2-contents',
  '/create/v2-fees',
  '/create/v2-raise',
  '/create/v2-opening',
  '/create/v2-overview',
  // SH-251: the visual Create (the picture way).
  '/create/v2-picture',
  // SH-AI-PLAN: the plan guide, with its prompt for an AI.
  '/create/plan',
  '/create/basics',
  '/create/kind',
  '/create/overview',
  '/settings',
  '/about/risks',
  '/about/terms',
  '/about/privacy',
  '/no-such-page',
];

/** Every piece of text the page holds for a reader, a screen reader or a link preview, one entry per text run. */
async function everyText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) continue;
      texts.push(node.textContent ?? '');
    }
    const named = ['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt'];
    for (const element of document.querySelectorAll('*')) for (const name of named) texts.push(element.getAttribute(name) ?? '');
    for (const option of document.querySelectorAll('option, input[type="submit"], input[type="button"]')) texts.push((option as HTMLInputElement).value);
    texts.push(document.title);
    for (const meta of document.head.querySelectorAll('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]')) texts.push(meta.getAttribute('content') ?? '');
    return texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => text.length > 0);
  });
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator('h1').first()).toBeVisible();
  // The launch flow's steps load lazily: wait for the form (the plan guide, /create/plan, is a page of its own).
  const { pathname } = new URL(page.url());
  // SH-251: the picture way has no form until a sheet opens: it is settled once its picture is drawn.
  if (pathname === '/create/v2-picture') await expect(page.locator('.sh-newbox[data-step] svg.sh-pic')).toBeVisible();
  else if (pathname.startsWith('/create') && pathname !== '/create/plan') await expect(page.locator('.sh-newbox[data-step] form')).toBeVisible();
  if (new URL(page.url()).pathname.startsWith('/box/')) await expect(page.locator('header.sh-box-head:not([data-state="unavailable"])').first()).toBeVisible();
}

const found = (texts: readonly string[]): string[] => [...new Set(texts.filter((text) => DEMO_WORD.test(text) || BELITTLING.test(text)))];

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
});

test('the founder’s wording rule: "Token", never "just the token" or "token only"', () => {
  for (const text of ['Just the token', 'Sky Lanterns, LANT, Just the token, Upcoming', 'Token only', 'token-only']) expect(BELITTLING.test(text), text).toBe(true);
  for (const text of ['Token', 'Sky Lanterns, LANT, Token, Upcoming', 'Token No NFTs', 'None: a token box']) expect(BELITTLING.test(text), text).toBe(false);
});

test('the rule itself: the words alone or inside a name, never inside another word', () => {
  for (const text of ['Demo', 'demo data', 'Box created · Demo', 'USDC-DEMO', 'Demos', 'a mock wrapper', 'MOCK']) expect(DEMO_WORD.test(text), text).toBe(true);
  for (const text of ['Sample data', 'demonstrate', 'Democracy', 'mockup', 'hammock', 'Local chain 31337']) expect(DEMO_WORD.test(text), text).toBe(false);
});

test('F130: no Demo or mock word on any route with the sample data, nor a source badge or chip for it', async ({ page }) => {
  // About fifty routes, each settled before it is read: longer than the default 30 s on the phone project.
  test.setTimeout(120_000);
  const findings: string[] = [];
  for (const route of ROUTES) {
    await page.goto(route);
    await settled(page);
    findings.push(...found(await everyText(page)).map((text) => `${route}: ${text}`));
    // The sample data has no badge in the top bar (Local chain and Testnet keep theirs).
    await expect(page.locator('.sh-source-badge')).toHaveCount(0);
  }
  expect(findings).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
});

test('F130: Settings names the sample data "Sample data", and nothing else there says demo', async ({ page }) => {
  await page.goto('/settings');
  const option = page.getByRole('radio', { name: 'Sample data' });
  await expect(option).toBeChecked();
  expect(found(await everyText(page))).toEqual([]);
});

/** Client-side navigation (the sample wallet's connection lives in memory, so a reload would drop it). */
async function inApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState(window.history.state, '', to);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, path);
}

test('F130: the sample wallet and the pages it connects say no Demo either', async ({ page }) => {
  await page.goto('/my-box');
  await settled(page);
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await expect(dialog).toBeVisible();
  const findings = found(await everyText(page)).map((text) => `wallet window: ${text}`);
  await dialog.getByRole('radio', { name: 'Box wallet B' }).check();
  await dialog.getByRole('button', { name: 'Connect sample wallet' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ })).toBeVisible();
  // The Claims page this test signed a claim on is off (F134 R46B); its old links open My Box, still connected.
  // SH-254: and Launch's pages (the visual way and the steps' first), which wallet B could not open before.
  for (const path of ['/my-box', FIT, v2(3), '/wallet/0xde00000000000000000000000000000000000b22', '/rewards', '/portfolio', `/pair/31337/${ORCHARD}`, '/create/v2-picture', '/create/v2-basics']) {
    await inApp(page, path);
    await settled(page);
    await notTheErrorPage(page, `${path} (connected)`);
    findings.push(...found(await everyText(page)).map((text) => `${path} (connected): ${text}`));
    await expect(page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ }), path).toBeVisible();
  }
  expect(findings).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
});

test('F134 R46B: the first handoff’s pages are off; each old link opens the boxes or My Box, and the old fixture’s coins show nowhere', async ({ page }) => {
  const OLD_FIXTURE = /\b(?:USDC|AAPLx|WETH|UNSET)-DEMO\b|ORCHARD|TINY FRAMES|Launched pairs|Holder fee share/;
  for (const [from, to] of LEGACY_REDIRECTS) {
    await page.goto(from);
    const escaped = to.replace(/[.*+?^$()|[\]\\/{}]/g, (char) => `\\${char}`);
    await expect(page, from).toHaveURL(new RegExp(`${escaped}$`));
    await settled(page);
    const texts = await everyText(page);
    expect(texts.filter((text) => OLD_FIXTURE.test(text) || DEMO_WORD.test(text)), from).toEqual([]);
  }
  expect(await walletTouches(page)).toEqual([]);
});

/** The first screen of the pages that carried Demo labels before F130, for docs/evidence/SH-V2-FE8/ (evidence only). */
const SHOTS: ReadonlyArray<readonly [string, string]> = [
  ['feed', '/'],
  ['box-misfits', FIT],
  ['box-v2-marbles', v2(1)],
  ['box-token-tab', `${FIT}?tab=token`],
  ['fit-pair', '/fit-pair'],
  ['wallet-box', '/wallet/0xde00000000000000000000000000000000000b22'],
  ['create-v2-basics', '/create/v2-basics'],
  ['settings', '/settings'],
  ['about-risks', '/about/risks'],
];

test('F130 evidence: the first screen of each page that carried a Demo label (SH_EVIDENCE_SCREENSHOTS=1)', async ({ page }, testInfo) => {
  test.skip(process.env.SH_EVIDENCE_SCREENSHOTS !== '1', 'evidence screenshots only: SH_EVIDENCE_SCREENSHOTS=1');
  const dir = fileURLToPath(new URL('../../../docs/evidence/SH-V2-FE8/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [name, route] of SHOTS) {
    await page.goto(route);
    await settled(page);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(found(await everyText(page)), route).toEqual([]);
    await page.screenshot({ path: `${dir}${name}-${testInfo.project.name}.png`, scale: 'css' });
  }
  await page.goto('/my-box');
  await settled(page);
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByRole('dialog', { name: 'Sample wallet' })).toBeVisible();
  await page.screenshot({ path: `${dir}sample-wallet-${testInfo.project.name}.png`, scale: 'css' });
});
