import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { notTheErrorPage } from './box-helpers';
import { goInApp } from './feed-helpers';

// Safe wording audit (F23 "use safe wording everywhere"; core v2 C21; SEC staff FAQ Q2.5), in a real browser at both
// viewports: no route frames holding as earning, rewards, yield, returns, APY, growth or gains, in visible text,
// accessible names, tooltips, placeholders or the page title. e2e never imports src, so the rule is restated here:
//  - never, even negated: earn…, reward(s), accru…, "passive income", "to the moon", "number go up", APY / APR / ROI;
//  - only after a negation in the same clause ("No yield … is predicted"): yield, profit, income, dividends, interest,
//    "return(s) on", grow…, gain(s), apprec…, "price rise / support / floor".
// Unit tests cover every string in the source (src/copy-wording.test.ts) and every rendered route (src/App.wording.test.tsx).

const ORCHARD = '0x0000000000000000000000000000000000000066';
const FRAMES = '0x000000000000000000000000000000000000006a';
const ROUTES = [
  '/',
  '/?state=bonding&view=list',
  '/box/31337/0x000000000000000000000000000000000000f17e',
  '/box/31337/0x000000000000000000000000000000000000f17e?tab=owning',
  '/box/31337/0x000000000000000000000000000000000000f17e?tab=about',
  '/box/31337/0x000000000000000000000000000000000000f17e?scenario=window',
  '/box/31337/0x000000000000000000000000000000000000f17e?scenario=migrated&tab=owning',
  '/box/31337/0xde00700000000000000000000000000000000003',
  '/box/31337/0xde00700000000000000000000000000000000005',
  '/wallet/0xde00000000000000000000000000000000000b22',
  '/my-box',
  '/pairs',
  '/pairs?type=nft_collection',
  '/launch',
  '/create/basics',
  '/create/contents',
  '/create/kind',
  '/create/raise',
  '/create/launch',
  '/create/overview',
  // SH-AI-PLAN: the plan guide, with its prompt for an AI.
  '/create/plan',
  '/rewards',
  '/rewards?scenario=conversion_fails',
  '/portfolio',
  '/settings',
  '/about/risks',
  '/about/terms',
  '/about/privacy',
  `/pair/31337/${ORCHARD}`,
  `/pair/31337/${FRAMES}`,
  '/box/31337/0x000000000000000000000000000000000000f17e?tab=token',
  '/box/31337/0x000000000000000000000000000000000000f17e?scenario=completed',
  '/fit-pair',
  '/fit-pair?scenario=window',
  '/fit-pair?scenario=completed',
  '/fit-pair?scenario=migrated',
];

const NEVER = /\b(earn\w*|rewards?|accru\w*|passive income|to the moon|number go up)\b/i;
const ACRONYMS = /\b(APY|APR|ROI)\b/;
const UNLESS_NEGATED = /\b(yield\w*|profit\w*|income|dividends?|interest|returns? on|grow\w*|gains?|apprec\w*|price (?:rise|support|floor))\b/i;
const NEGATION = /\b(not|no|nothing|never|none|nobody|neither|nor|cannot)\b|n[’']t\b/i;
const CLAUSE_BREAK = /(?<=[.!?:;])\s+|,?\s+\bbut\b\s+/;

/** Clauses that break the rule. */
function violations(texts: readonly string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    // "Grow the pool", the format 2 flow's fee choice, is the one form of "grow" the rule allows (F23, as
    // src/features/create/v2/templates.ts says); Launch opens that flow in every build. No template name is an exception:
    // founder R47J named the creator's and the holders' templates "To the creator" and "To holders".
    const neutral = text.replace(/\bGrow the pool\b/g, 'Add to the pool');
    for (const clause of neutral.split(CLAUSE_BREAK)) {
      const soft = UNLESS_NEGATED.exec(clause);
      if (NEVER.test(clause) || ACRONYMS.test(clause) || (soft !== null && !NEGATION.test(clause.slice(0, soft.index)))) found.push(clause.trim());
    }
  }
  return found;
}

/** Visible text split into lines (blocks), plus accessible names, tooltips, placeholders, alt text and the title. */
async function pageCopy(page: Page): Promise<string[]> {
  const lines = (await page.locator('body').innerText()).split('\n');
  const attributes = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label], [aria-description], [title], [placeholder], [alt]')].flatMap((element) =>
      ['aria-label', 'aria-description', 'title', 'placeholder', 'alt'].map((name) => element.getAttribute(name) ?? ''),
    ),
  );
  return [...lines, ...attributes, await page.title()].map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => text.length > 0);
}

async function auditWording(page: Page, label: string) {
  await expect(page.locator('h1')).toBeVisible();
  // The launch page (box creation) loads lazily: audit the page (its form, on every step), not its loading line.
  // The plan guide (/create/plan) is a page of its own, with no form.
  const { pathname } = new URL(page.url());
  // SH-254: the visual way (Launch's default) has no form until a sheet opens: it is read once its picture is drawn.
  if (pathname === '/create/v2-picture') await expect(page.locator('.sh-newbox[data-step] svg.sh-pic')).toBeVisible();
  else if (pathname.startsWith('/create') && pathname !== '/create/plan') await expect(page.locator('.sh-newbox[data-step] form')).toBeVisible();
  expect(violations(await pageCopy(page)), label).toEqual([]);
}

/** Desktop screenshots for docs/evidence/SH-V2-safe-wording.md (SH_EVIDENCE_SCREENSHOTS=1), else test output only. */
async function evidence(page: Page, testInfo: TestInfo, name: string, { target, fullPage = false }: { target?: ReturnType<Page['locator']>; fullPage?: boolean } = {}) {
  if (testInfo.project.name !== 'desktop') return;
  const file =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/SH-V2-safe-wording-${name}.png`, import.meta.url))
      : testInfo.outputPath(`SH-V2-safe-wording-${name}.png`);
  if (target) await target.screenshot({ path: file, style: '.sh-topbar { visibility: hidden; }' });
  else await page.screenshot({ path: file, fullPage });
}

test('the rule itself: flags earning and reward framing, allows negated statements and dates', () => {
  expect(violations(['Holders earn USDC-DEMO', 'Rewards', 'An APY of 12%', 'Burns grow your yield.'])).toEqual([
    'Holders earn USDC-DEMO',
    'Rewards',
    'An APY of 12%',
    'Burns grow your yield.',
  ]);
  expect(violations(['No yield, price floor or growth is predicted or promised.', '12 Apr 2026', 'Fee share in USDC-DEMO', 'Holder fee share paid in FRAME, converted from credited WETH-DEMO', 'Claims'])).toEqual([]);
  // The template names (founder R47J) pass as they are; the 2026-10-11 names fail like any other copy, alone or not.
  expect(violations(['To the creator', 'To holders', 'Grow the pool'])).toEqual([]);
  expect(violations(['Creator earns', 'Holders earn', 'Creator earns more', 'Holders earn USDC'])).toEqual(['Creator earns', 'Holders earn', 'Creator earns more', 'Holders earn USDC']);
});

test('every route, disconnected: safe wording in text, names and titles', async ({ page }, testInfo) => {
  for (const route of ROUTES) {
    await page.goto(route);
    // The first handoff's pages are off in every build (F134 R46B): their old links open the boxes and My Box.
    if (/^\/(?:pairs|pair\/)/.test(route)) await expect(page).toHaveURL(/\/$/);
    if (route.startsWith('/rewards') || route === '/portfolio') await expect(page).toHaveURL(/\/my-box$/);
    if (route === '/' || /^\/(?:pairs|pair\/)/.test(route)) await expect(page.getByText('6 boxes')).toBeVisible();
    if (route.startsWith('/box/')) await expect(page.locator('.sh-box-head:not([data-state="unavailable"])')).toBeVisible();
    await auditWording(page, route);
    if (route === '/') await evidence(page, testInfo, 'feed');
    if (route === '/launch') await evidence(page, testInfo, 'launch', { fullPage: true });
  }
});

// The sample wallet's Box wallet B (SH-V2-FE11: the old pairs' holders are no longer offered).
test('connected sample wallet (box wallet B): My Box, Launch and a box page keep the safe wording', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByText('6 boxes')).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  expect(violations(await dialog.innerText().then((text) => text.split('\n'))), 'demo wallet window').toEqual([]);
  await dialog.getByRole('radio', { name: 'Box wallet B' }).check();
  await dialog.getByRole('button', { name: 'Connect sample wallet' }).click();
  await expect(dialog).toHaveCount(0);

  // Claims, Portfolio and the pair detail, audited here before, are off in every build (F134 R46B).
  // SH-254: and the visual way, where Launch opens now, and the steps' first page, connected.
  for (const path of ['/my-box', '/create/basics', '/create/v2-picture', '/create/v2-basics'] as const) {
    await goInApp(page, path);
    await auditWording(page, `${path} (box wallet B)`);
    await notTheErrorPage(page, `${path} (box wallet B)`);
  }
  await goInApp(page, '/');
  await page.getByRole('link', { name: /^The Misfits, FIT/ }).click();
  await expect(page).toHaveURL(/\/box\/31337\/0x0+f17e$/);
  await expect(page.locator('.sh-box-head:not([data-state="unavailable"])')).toBeVisible();
  await auditWording(page, 'box 0 (box wallet B)');
  await notTheErrorPage(page, 'box 0 (box wallet B)');
  await evidence(page, testInfo, 'box-connected');
});
