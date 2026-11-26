import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';

// v2 FIT / Misfits pair page (T19): the contract address with a copy button, links out only (no trading UI), the live
// curve from the indexer's SSE stream with fallbacks to its snapshot and to direct chain reads, honest stale /
// unverified / unavailable states, the read-only vault counters and the F40 L3 fee disclosure, at 1440×900 and
// 390×844. The Demo data drives the Demo stream (with the browser clock); the "Local chain" source reads the fixture
// FIT market (playwright.config.ts), whose live service (8598) and RPC (8599) are answered here from
// e2e/fixtures/fit-live-31337.json. Nothing runs on those ports and nothing is deployed.
// Text diet (2026-10-01): a Demo label on every card with invented data, one freshness chip, explanations behind (i)
// buttons and disclosures, the launch tax on the first screen whenever it applies, and a word budget for the first
// screen that never counts honesty text (docs/evidence/SH-V2-misfits-text-diet.md).
// SH_EVIDENCE_SCREENSHOTS=1 writes the screenshots to docs/evidence/screenshots/T19-*.png.

interface Fixture {
  readonly head: string;
  readonly headAfter: string;
  readonly snapshot: string;
  readonly snapshotAfter: string;
  readonly streams: Readonly<Record<'initial' | 'next' | 'stale' | 'unverified' | 'reorg' | 'wrongPool', string>>;
  readonly rpc: { readonly latest: { readonly number: string; readonly hash: string; readonly timestamp: string }; readonly calls: Readonly<Record<string, string>> };
}

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/fit-live-31337.json', import.meta.url)), 'utf8')) as Fixture;
const MARKET = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/fit-market-31337.json', import.meta.url)), 'utf8')) as { contracts: { token: string }; poolId: string };
const DEMO_FIT = '0x000000000000000000000000000000000000f17e';
const LIVE = 'http://127.0.0.1:8598/**';
const RPC = 'http://127.0.0.1:8599/**';
const STREAM_PATH = `/v1/pools/31337/${MARKET.poolId.toLowerCase()}/stream`;
const SNAPSHOT_PATH = `/v1/pools/31337/${MARKET.poolId.toLowerCase()}/snapshot`;
const FORBIDDEN = /\b(buy|sell|swap)\b/i;
const block = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The whole page from the top, or the viewport with `focus` scrolled to the top of it; CSS pixels either way. */
async function evidence(page: Page, testInfo: TestInfo, name: string, focus?: Locator) {
  const file =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/T19-${name}-${testInfo.project.name}.png`, import.meta.url))
      : testInfo.outputPath(`T19-${name}.png`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (focus) {
    await focus.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 72));
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.screenshot({ path: file, fullPage: !focus, scale: 'css' });
}

/** Records every request a page makes to an injected wallet: browsing must make none (UI-05, EXT-04). */
async function installWalletProbe(page: Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.defineProperty(window, '__walletCalls', { value: calls });
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.reject(new Error('no wallet requests expected'));
    };
    Object.defineProperty(window, 'ethereum', { value: { isMetaMask: true, request: record('request'), send: record('send'), sendAsync: record('sendAsync') } });
  });
}

const walletCalls = (page: Page) => page.evaluate(() => (window as unknown as { __walletCalls: unknown[] }).__walletCalls.length);

async function noTradingControls(page: Page) {
  await expect(page.getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.getByRole('link', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.locator('input, select, textarea, iframe')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

/** WCAG 2.x relative luminance of an rgb()/rgba() colour string. */
function luminance(color: string): number {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The 32 window cells: no faded text, at least 4.5:1 on the card (#111b29, its darkest and most common stop), no overflow. */
async function windowCellsReadable(page: Page) {
  const cells = await page.locator('.sh-fit-window__cell').evaluateAll((elements) =>
    elements.map((cell) => ({
      state: cell.getAttribute('data-state'),
      opacity: getComputedStyle(cell).opacity,
      overflow: cell.scrollWidth > cell.clientWidth,
      // Computed font sizes are "12px"-style strings; a whole-pixel check is enough here.
      fontSize: Number(/^(\d+)/.exec(getComputedStyle(cell).fontSize)?.[1] ?? '0'),
      colors: [...cell.querySelectorAll('.sh-fit-window__offset, .sh-fit-window__tax')].map((part) => getComputedStyle(part).color),
    })),
  );
  expect(cells).toHaveLength(32);
  expect(cells.filter((cell) => cell.state === 'past').length).toBeGreaterThan(0);
  const card = luminance('rgb(17, 27, 41)');
  for (const cell of cells) {
    expect(cell.opacity).toBe('1');
    expect(cell.overflow).toBe(false);
    expect(cell.fontSize).toBeGreaterThanOrEqual(12);
    for (const color of cell.colors) expect((luminance(color) + 0.05) / (card + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
}

const curve = (page: Page) => page.getByRole('region', { name: 'Bonding curve' });
const chip = (page: Page) => curve(page).locator('.sh-fit-chip');
const links = (page: Page) => page.getByRole('region', { name: 'Open on' });
const phaseLine = (page: Page) => page.locator('header.sh-fit-head .sh-fit-phase');
/** The chip shows the freshness word; the newest block is in its title. */
const chipBlock = (value: string) => `Block ${block(value)}`;

/**
 * Words a budget counts (text diet, 2026-10-01): rendered text only, without closed info panels, closed <details>,
 * visually hidden screen-reader text or off-canvas text; a word is a token with a letter in it. Honesty text
 * ([data-disclosure]: Demo badges, why data is not live, a replaced block, the F40 L3 notice) is never budgeted, so a
 * budget cannot push it out. `viewport` counts the words at least partly inside the first screen, `page` all of them.
 * The evidence measurement (scripts/measure-visible-words.mjs) counts everything, honesty text included.
 */
async function visibleWords(page: Page): Promise<{ viewport: number; page: number }> {
  return page.evaluate(() => {
    const srOnly = (element: Element) => {
      for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (rect.width <= 1 && rect.height <= 1 && (style.overflow === 'hidden' || style.clipPath !== 'none')) return true;
      }
      return false;
    };
    let viewport = 0;
    let all = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (!parent || !text.textContent?.trim() || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
      if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || srOnly(parent) || parent.closest('[data-disclosure]')) continue;
      for (const match of (text.textContent ?? '').matchAll(/\S+/g)) {
        if (!/[A-Za-z]/.test(match[0])) continue;
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
        if (rects.length === 0) continue;
        const top = Math.min(...rects.map((rect) => rect.top)) + window.scrollY;
        const bottom = Math.max(...rects.map((rect) => rect.bottom)) + window.scrollY;
        if (bottom <= 0 || Math.max(...rects.map((rect) => rect.right)) <= 0) continue;
        all += 1;
        if (top < window.innerHeight) viewport += 1;
      }
    }
    return { viewport, page: all };
  });
}

test.describe('the sample data', () => {
  test('the contract address first, links out only, the sample stream moving block by block, no Demo label (F130)', async ({ page, context }, testInfo) => {
    await installWalletProbe(page);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.clock.install();
    await page.goto('/fit-pair');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('FIT');
    const header = page.locator('header.sh-fit-head');
    await expect(header.getByText(DEMO_FIT, { exact: true })).toBeVisible();
    // F130 (founder 2026-10-11) supersedes "mock data stays labelled Demo": no Demo badge beside the address, on the
    // curve's chip, on the trades, the vault counts or the pool; the chip says what the stream does.
    await expect(page.locator('main .sh-fit-demo')).toHaveCount(0);
    await expect(chip(page)).toHaveText('Live');
    for (const name of ['Recent trades', 'The Misfits vault', 'Pool']) await expect(page.getByRole('region', { name })).not.toContainText(/\bdemo\b/i);
    await page.evaluate(() => window.scrollTo(0, 0));
    await header.getByRole('button', { name: 'Copy the FIT contract address' }).click();
    await expect(header.getByText('Copied.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(DEMO_FIT);

    await expect(chip(page)).toHaveAttribute('title', 'Block 21,000,960');
    await expect(curve(page).getByRole('progressbar', { name: 'Progress to graduation' })).toHaveAttribute('aria-valuetext', /of 4\.206980085 ETH \(\d+\.\d%\) · after sells/);
    // No link is live for the sample data: one muted line, no boxes that look like buttons.
    await expect(links(page).locator('.sh-fit-links__none')).toHaveText('No links');
    await expect(links(page).locator('a[href], .sh-fit-link')).toHaveCount(0);
    // The Demo runs the F49 E8 edition: 4,269.
    await expect(page.getByRole('region', { name: 'The Misfits vault' })).toContainText('4,269');
    await noTradingControls(page);
    await evidence(page, testInfo, 'demo-curve');

    await page.clock.runFor(12_000);
    await expect(chip(page)).toHaveAttribute('title', 'Block 21,000,961');
    await page.clock.runFor(24_000);
    await expect(chip(page)).toHaveAttribute('title', 'Block 21,000,963');
    await expect(chip(page)).toHaveText('Live');
    expect(await walletCalls(page)).toBe(0);
    // The Demo stream reads no network at all: nothing fails, nothing is logged as an error.
    expect(consoleErrors).toEqual([]);
  });

  test('the first screen reads in seconds: phase, price, progress and the address, in a few words', async ({ page }, testInfo) => {
    await page.goto('/fit-pair');
    await expect(chip(page)).toHaveAttribute('title', /^Block /);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Phone first: the phase, the contract address with its copy button, the freshness chip, the price and the
    // progress band are all on the first screen.
    for (const locator of [
      page.locator('.sh-fit-head__phase'),
      page.locator('.sh-fit-ca__address'),
      page.getByRole('button', { name: 'Copy the FIT contract address' }),
      chip(page),
      curve(page).locator('.sh-fit-hero__value'),
      curve(page).getByRole('progressbar', { name: 'Progress to graduation' }),
    ]) {
      await expect(locator).toBeInViewport();
    }
    const phone = testInfo.project.name === 'mobile';
    // Desktop: the drawing is short and wide, so the three figures are on the first screen too.
    if (!phone) await expect(curve(page).locator('.sh-fit-figures')).toBeInViewport({ ratio: 1 });
    // "Price" and "Progress to graduation" share one line.
    const tops = await curve(page).locator('.sh-fit-hero__price dt, .sh-fit-band__label').evaluateAll((labels) => labels.map((label) => Math.round(label.getBoundingClientRect().top)));
    if (!phone) expect(Math.abs((tops[0] ?? 0) - (tops[1] ?? 0))).toBeLessThanOrEqual(1);
    // 2026-10-01, before the text diet: 116 words on the phone's first screen, 240 on the desktop's, about 1,060 on the
    // whole page (chrome included). The budget keeps it short; honesty text is never counted against it.
    const words = await visibleWords(page);
    expect(words.viewport).toBeLessThanOrEqual(phone ? 45 : 90);
    expect(words.page).toBeLessThanOrEqual(phone ? 185 : 200);
  });

  test('the launch tax is on the first screen whenever it applies: before the open and in the window', async ({ page }) => {
    await page.goto('/fit-pair?scenario=window');
    await expect(page.locator('.sh-fit-head__phase')).toHaveText('Launch window');
    await expect(phaseLine(page)).toHaveText(/^Launch tax \d+\.\d\d% on buys · 22 blocks left$/);
    await expect(phaseLine(page)).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('region', { name: 'Fees' }).locator('.sh-fit-fees__line')).toHaveText('1% pool fee + launch tax on buys until block 21,000,331');
    await page.goto('/fit-pair?scenario=before_open');
    await expect(page.locator('.sh-fit-head__phase')).toHaveText('Not open yet');
    await expect(phaseLine(page)).toHaveText(/^Opens in \d+ blocks · launch tax 93\.20% → 8\.06% on buys$/);
    await expect(phaseLine(page)).toBeInViewport({ ratio: 1 });
    // The cells are labelled as a tax where they are seen, not only for screen readers.
    const window = page.getByRole('region', { name: 'Launch window' });
    await expect(window.locator('.sh-fit-window__caption')).toHaveText('Launch tax per block');
    await expect(window.getByRole('list', { name: 'Launch tax per block' })).toBeVisible();
  });

  test('explanations open on demand: (i) by keyboard and touch, the fee terms behind Details', async ({ page }, testInfo) => {
    await page.goto('/fit-pair');
    const info = curve(page).getByRole('button', { name: 'About the bonding curve' });
    const panel = curve(page).locator('.sh-info-panel');
    await expect(panel).toBeHidden();
    if (testInfo.project.name === 'mobile') {
      // Touch: a tap opens it, a second tap closes it.
      await info.tap();
      await expect(info).toHaveAttribute('aria-expanded', 'true');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('The price follows this curve');
      await info.tap();
    } else {
      // Keyboard: Enter opens it, Escape closes it and leaves focus on the button; Space toggles it too.
      await info.focus();
      await page.keyboard.press('Enter');
      await expect(info).toHaveAttribute('aria-expanded', 'true');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('The price follows this curve');
      await page.keyboard.press('Escape');
      await expect(info).toBeFocused();
      await expect(info).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Space');
      await expect(info).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Space');
    }
    await expect(panel).toBeHidden();
    await expect(info).toHaveAttribute('aria-expanded', 'false');

    const fees = page.getByRole('region', { name: 'Fees' });
    await expect(fees.locator('.sh-fit-fees__line')).toHaveText('1% pool fee');
    // F49 D3: the pool is closed to outside liquidity for good, so the fee-share notice is gone.
    await expect(fees.locator('details')).toHaveCount(0);
    await expect(fees).not.toContainText(/fee share|outside liquidity|section 5\.7/i);
    // F77 (the Misfits like all the others): the Demo shows box 0's split; the launch tax goes into its own pool.
    await fees.getByRole('button', { name: 'About the fees' }).click();
    await expect(fees).toContainText('Of the ETH part, 11/15 buys FIT and burns it, 2/15 goes into this box’s pool and 2/15 to the platform. Of the FIT part,');
    await expect(fees).toContainText('Of the FIT part, 13/15 is burned today');
    await expect(fees).toContainText('(rounded up), into this box’s pool after graduation.');
    await expect(fees).not.toContainText(/treasury/);
    await page.keyboard.press('Escape');
    const pool = page.getByRole('region', { name: 'Pool' });
    await expect(pool.locator('.sh-fit-fees__line')).toHaveText(/^Added: 0 ETH \+ 0 FIT · Waiting: [\d.,]+ ETH \+ [\d.,]+[KMB]? FIT$/);
    await expect(pool.locator('.sh-fit-demo')).toHaveCount(0);
    await noTradingControls(page);
  });

  test('launch window, target reached and graduated', async ({ page }, testInfo) => {
    await page.goto('/fit-pair?scenario=window');
    await expect(links(page).locator('.sh-fit-links__none')).toHaveText('No links');
    await expect(page.getByRole('region', { name: 'Launch window' }).locator('.sh-fit-window__text')).toHaveText(/^Ends after block 21,000,331 · ~.+ UTC \(estimate\)$/);
    await expect(page.locator('.sh-fit-window__cell[aria-current="step"]')).toContainText('+10');
    await windowCellsReadable(page);
    await evidence(page, testInfo, 'demo-window', testInfo.project.name === 'mobile' ? page.getByRole('region', { name: 'Launch window' }) : page.locator('main'));

    await page.goto('/fit-pair?scenario=completed');
    await expect(phaseLine(page)).toHaveText(/^Graduation pending/);
    await expect(page.locator('.sh-fit-head__phase')).toHaveText('Target reached');
    await expect(curve(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    await evidence(page, testInfo, 'demo-completed', testInfo.project.name === 'mobile' ? curve(page) : page.locator('main'));

    await page.goto('/fit-pair?scenario=migrated');
    await expect(page.locator('.sh-fit-head__phase')).toHaveText('Graduated');
    await expect(phaseLine(page)).toHaveText(/^Since block [\d,]+$/);
    await expect(curve(page).getByRole('progressbar', { name: 'Curve complete' })).toBeVisible();
    const fees = page.getByRole('region', { name: 'Fees' });
    // F49 D3: no fee-share notice after graduation either.
    await expect(fees.locator('.sh-fit-fees__line')).toHaveText('1% pool fee');
    await expect(fees.locator('details')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/fee share|outside liquidity/i);
    await expect(page.getByRole('region', { name: 'Pool' }).locator('.sh-fit-fees__line')).toHaveText(/^Added: 0 ETH \+ 0 FIT · Waiting: [\d.,]+ ETH \+ [\d.,]+[KMB]? FIT$/);
    await expect(page.getByRole('region', { name: 'The Misfits vault' }).locator('.sh-fit-vault__shutter')).toHaveText('Open since graduation');
    await noTradingControls(page);
    await evidence(page, testInfo, 'demo-migrated', testInfo.project.name === 'mobile' ? curve(page) : page.locator('main'));
  });

  test('focus is never hidden under the sticky top bar (WCAG 2.4.11)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'the phone top bar scrolls with the page');
    await page.goto('/fit-pair');
    await expect(chip(page)).toHaveText('Live');
    const barBottom = await page.locator('.sh-topbar').evaluate((bar) => bar.getBoundingClientRect().bottom);
    for (const name of ['About the bonding curve', 'About the vault', 'About the fees']) {
      // The card's (i) sits just under the bar (inside the viewport, so nothing would scroll on its own); focus comes
      // back to it from the next control with Shift+Tab, as a keyboard reader moving up the page would.
      await page.evaluate((label) => {
        const target = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label);
        if (!target) throw new Error(`no ${label}`);
        window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 10);
        const focusables = [...document.querySelectorAll<HTMLElement>('a[href], button, summary')];
        focusables[focusables.indexOf(target) + 1]?.focus({ preventScroll: true });
      }, name);
      await page.keyboard.press('Shift+Tab');
      const focused = await page.evaluate(() => ({ name: document.activeElement?.getAttribute('aria-label'), top: document.activeElement?.getBoundingClientRect().top ?? 0 }));
      expect(focused.name).toBe(name);
      expect(focused.top, name).toBeGreaterThanOrEqual(barBottom);
    }
  });

  test('stale and replaced blocks are said in words, and the old address /fit points here', async ({ page }, testInfo) => {
    await page.goto('/fit-pair?scenario=stale');
    await expect(chip(page)).toHaveText('Stale · since block 21,000,960');
    await expect(page.locator('.sh-fit')).toHaveAttribute('data-stale', 'true');
    // The page's one freshness chip sits with the price, on the first screen of a phone too.
    await expect(chip(page)).toBeInViewport();
    await expect(page.locator('.sh-fit-chip')).toHaveCount(1);
    await evidence(page, testInfo, 'demo-stale', testInfo.project.name === 'mobile' ? curve(page) : page.locator('main'));
    await page.clock.install();
    await page.goto('/fit-pair?scenario=reorg');
    await expect(chip(page)).toHaveAttribute('title', 'Block 21,000,960');
    await page.clock.runFor(12_000);
    await expect(curve(page)).toContainText('Block 21,000,960 was replaced; the curve went back to block 21,000,959');
    // /fit and /misfits open the FIT market's box since the launch set.
    await page.goto('/fit');
    await expect(page).toHaveURL(/\/box\/31337\/0x0+f17e$/);
  });
});

test.describe('Local chain (fixture FIT market)', () => {
  test.beforeEach(async ({ page }) => {
    await installWalletProbe(page);
    await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' })));
  });

  /** The live service: each stream connection gets the next body (the browser reconnects after `retry`). */
  async function serveLive(page: Page, streams: readonly string[], snapshot: 'ok' | 'down' = 'ok') {
    let connection = 0;
    await page.route(LIVE, async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === STREAM_PATH) {
        const body = streams[Math.min(connection, streams.length - 1)];
        connection += 1;
        if (body === undefined || body === 'abort') return route.abort();
        return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body });
      }
      if (url.pathname === SNAPSHOT_PATH && snapshot === 'ok') {
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', etag: '"1"', 'x-sh-indexer': 'live', 'access-control-expose-headers': 'ETag, X-SH-Indexer' }, body: FIXTURE.snapshot });
      }
      return route.abort();
    });
  }

  /** The RPC: the latest header and the recorded eth_call answers; safe and finalized are unknown. */
  async function serveRpc(page: Page) {
    await page.route(RPC, async (route: Route) => {
      const request = JSON.parse(route.request().postData() ?? '{}') as { id: number; method: string; params: unknown[] };
      const reply = (body: object) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: request.id, ...body }) });
      if (request.method === 'eth_getBlockByNumber') {
        return reply({ result: request.params[0] === 'latest' ? { ...FIXTURE.rpc.latest, transactions: [] } : null });
      }
      if (request.method === 'eth_call') {
        const call = request.params[0] as { to: string; data: string };
        const result = FIXTURE.rpc.calls[`${call.to.toLowerCase()}:${call.data.slice(0, 10)}`];
        return result ? reply({ result }) : reply({ error: { code: -32000, message: 'execution reverted' } });
      }
      if (request.method === 'eth_chainId') return reply({ result: '0x7a69' });
      return reply({ error: { code: -32601, message: 'method not found' } });
    });
  }

  test('live on the stream, following new blocks; the vault read from the chain', async ({ page }, testInfo) => {
    await serveLive(page, [FIXTURE.streams.initial, FIXTURE.streams.next]);
    await serveRpc(page);
    await page.goto('/fit-pair');
    await expect(page.locator('header.sh-fit-head').getByText(MARKET.contracts.token, { exact: true })).toBeVisible();
    await expect(chip(page)).toHaveText('Live');
    await expect(chip(page)).toHaveAttribute('title', chipBlock(FIXTURE.head));
    await expect(page.locator('.sh-fit-ca__network')).toHaveText('Local chain 31337');
    await expect(page.getByRole('region', { name: 'Recent trades' }).locator('li').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'The Misfits vault' }).locator('.sh-fit-vault__source')).toHaveText(`Chain read · block ${block(FIXTURE.head)}`);
    // The service's price is compared with a direct chain read at the same block; the curve's (i) says so.
    await curve(page).getByRole('button', { name: 'About the bonding curve' }).click();
    await expect(curve(page).locator('.sh-info-panel')).toContainText(`its price matched a direct chain read at block ${block(FIXTURE.head)}`);
    await evidence(page, testInfo, 'local-live', testInfo.project.name === 'mobile' ? curve(page) : page.locator('main'));
    // The browser reconnects after the fixture's retry and gets the next two blocks (a resumed stream).
    await expect(chip(page)).toHaveAttribute('title', chipBlock(FIXTURE.headAfter), { timeout: 10_000 });
    await expect(links(page).locator('a[href]')).toHaveCount(0);
    await expect(links(page).locator('.sh-fit-links__none')).toHaveText('No links on a local chain');
    // A chain source invents nothing: no card says Demo.
    await expect(page.locator('main .sh-fit-demo')).toHaveCount(0);
    await noTradingControls(page);
    expect(await walletCalls(page)).toBe(0);
  });

  test('polls the snapshot when the stream is down, then reads the chain when the service is down too', async ({ page }, testInfo) => {
    await serveLive(page, ['abort']);
    await serveRpc(page);
    await page.goto('/fit-pair');
    await expect(chip(page)).toHaveText('Polling', { timeout: 10_000 });
    await expect(chip(page)).toHaveAttribute('title', chipBlock(FIXTURE.head));
    await page.unroute(LIVE);
    await page.route(LIVE, (route) => route.abort());
    await expect(chip(page)).toHaveText('Direct chain read', { timeout: 15_000 });
    await expect(chip(page)).toHaveAttribute('title', chipBlock(FIXTURE.head));
    await expect(page.getByRole('region', { name: 'Recent trades' }).getByText('No trades: a direct chain read carries none.')).toBeVisible();
    await expect(curve(page).locator('.sh-info-panel')).toContainText('read directly from the chain');
    await evidence(page, testInfo, 'local-direct', testInfo.project.name === 'mobile' ? curve(page) : page.locator('main'));
  });

  test('says unavailable when neither the service nor the chain answers', async ({ page }, testInfo) => {
    await page.route(LIVE, (route) => route.abort());
    await page.route(RPC, (route) => route.abort());
    await page.goto('/fit-pair');
    await expect(chip(page)).toContainText('Unavailable', { timeout: 20_000 });
    await expect(curve(page).getByText('Nothing is shown as empty or zero in its place', { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: 'The Misfits vault' }).locator('.sh-fit-vault__source')).toContainText('Unavailable:');
    // No price and no phase are shown in place of the missing data.
    await expect(page.locator('.sh-fit-hero__value')).toHaveCount(0);
    await expect(page.locator('.sh-fit-head__phase')).toHaveCount(0);
    await evidence(page, testInfo, 'local-unavailable', testInfo.project.name === 'mobile' ? curve(page) : page.locator('main'));
  });

  test('a stale service stays marked stale; an unverified one is replaced by the chain read', async ({ page }) => {
    await serveLive(page, [FIXTURE.streams.stale]);
    await page.route(RPC, (route) => route.abort());
    await page.goto('/fit-pair');
    await expect(chip(page)).toHaveText(`Stale · since block ${block(FIXTURE.head)}`);
    await expect(curve(page).locator('.sh-fit-reason')).toHaveText('The live service reports stale data: no new block.');

    await page.unroute(LIVE);
    await page.unroute(RPC);
    await serveLive(page, [FIXTURE.streams.unverified]);
    await serveRpc(page);
    await page.goto('/fit-pair');
    await expect(chip(page)).toHaveText('Direct chain read');
    await expect(curve(page).locator('.sh-fit-reason')).toHaveText('Live data doesn’t match the chain.');
  });

  test('a reorg drops the replaced block and says so; another pool’s data is refused', async ({ page }) => {
    await serveLive(page, [FIXTURE.streams.reorg]);
    await page.route(RPC, (route) => route.abort());
    await page.goto('/fit-pair');
    const head = BigInt(FIXTURE.head);
    await expect(curve(page)).toContainText(`Block ${block(FIXTURE.head)} was replaced; the curve went back to block ${block((head - 1n).toString())}`);
    await expect(chip(page)).toHaveAttribute('title', chipBlock((head - 1n).toString()));

    await page.unroute(LIVE);
    await serveLive(page, [FIXTURE.streams.wrongPool], 'ok');
    await page.goto('/fit-pair');
    // The stream's snapshot names another pool: dropped; the edge snapshot of this pool is shown instead.
    await expect(chip(page)).toHaveText('Polling', { timeout: 10_000 });
    await expect(chip(page)).toHaveAttribute('title', chipBlock(FIXTURE.head));
  });
});
