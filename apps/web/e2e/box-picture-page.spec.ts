import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, toHex, type Hex } from 'viem';
import manifestJson from './fixtures/core-local/manifest-11155111.json' with { type: 'json' };
import answers from './fixtures/sepolia-readonly/indexer-answers.json' with { type: 'json' };
import { FORBIDDEN, installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { reach, tallest } from './sheet-reach';
import { parseCoreManifestV2 } from '../../../packages/chain/src/core/v2';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { onManifestV2 } from '../src/features/core/v2/test-support/life-v2';
import { candleAnswerV2 } from '../src/features/core/v2/test-support/candles-v2';
import { BOX_PICTURE_ANSWERS, BOX_PICTURE_COINS, BOX_PICTURE_NAMES } from '../src/features/core/v2/test-support/box-picture-answers';

// SH-255 in the browser: the top of a v2 box's page is its picture. The six boxes live on Sepolia (their answers of
// 23 November 2026, block 12,195,510) through the real source, feed and box page on the local twin (the indexer's
// routes and the RPC answered here, nothing leaves the machine): the picture draws each, every part opens its sheet,
// each sheet's last control can be reached at four sizes, no control names a trade and no wallet is touched.
// SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to docs/evidence/SH-255/.

const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const manifest = parseCoreManifestV2(manifestJson);
type Wire = Record<string, unknown>;
const SEPOLIA_REGISTRY = '0x5d2866ef084d801ae734d3a2a6e4f7179898737c';
const listingsPath = `/v2/listings/11155111/${SEPOLIA_REGISTRY}`;
const SYMBOLS = new Map(BOX_PICTURE_COINS.map((pair) => [pair.coin.toLowerCase(), pair.symbol]));
const SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 358, height: 700 }] as const;

const bodies = BOX_PICTURE_NAMES.map((name) => onManifestV2({ body: structuredClone(BOX_PICTURE_ANSWERS[name] as Wire), activity: { items: [] } }, manifest).body);
const tokenOf = (name: string) => ((bodies[BOX_PICTURE_NAMES.indexOf(name)] as Wire).token as string).toLowerCase();
const swapRegistry = (text: string) => text.replace(new RegExp(SEPOLIA_REGISTRY, 'gi'), (manifest.releases[0]?.registry.address ?? '').toLowerCase());

async function serve(page: Page, cards: readonly Wire[] = bodies) {
  const data = await mixedDeployment();
  const last = cards.reduce((a, b) => (BigInt((a.asOf as Wire).block as string) >= BigInt((b.asOf as Wire).block as string) ? a : b));
  const listings = JSON.parse(swapRegistry(JSON.stringify((answers.answers as Record<string, unknown>)[listingsPath])));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const url = new URL(route.request().url());
    let answer: unknown = null;
    let status = 200;
    if (url.pathname === '/v1/feed') answer = data.v1.feed;
    else if (url.pathname === '/v2/feed') answer = { schema: 'sh.core-feed.v2', chainId: manifest.chainId, asOf: last.asOf, cards, hidden: [], platform: [] };
    else if (url.pathname.startsWith('/v2/listings/')) answer = listings;
    else if (url.pathname.endsWith('/activity') && url.pathname.startsWith('/v2/')) answer = { asOf: last.asOf, items: [], next: null };
    else if (url.pathname.endsWith('/candles') && url.pathname.startsWith('/v2/')) ({ status, body: answer } = candleAnswerV2([], url, last.asOf));
    await route.fulfill({ status: answer ? status : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer ?? { error: 'not found' }) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] };
    let answer: Wire = { error: { code: -32601, message: 'not answered here' } };
    if (call.method === 'eth_chainId') answer = { result: toHex(manifest.chainId) };
    else if (call.method === 'eth_call') {
      const { to, data: input } = call.params?.[0] as { to: string; data: Hex };
      const symbol = (() => { try { return decodeFunctionData({ abi: erc20Abi, data: input }).functionName === 'symbol'; } catch { return false; } })();
      const known = SYMBOLS.get(to.toLowerCase());
      answer = { result: symbol && known ? encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: known }) : '0x' };
    }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.clock.setFixedTime(new Date(Number((last.asOf as Wire).timestamp) * 1000));
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
}

async function open(page: Page, name: string) {
  await page.goto(`/box/${manifest.chainId}/${tokenOf(name)}`);
  await expect(page.locator('.sh-bpic svg.sh-pic [data-part="token"]')).toBeVisible({ timeout: 30_000 });
}

/** The page's top (the name, the strip, the picture and its side) as the founder sees it first. */
async function shot(page: Page, info: TestInfo, name: string, whole = false) {
  const width = page.viewportSize()?.width ?? 0;
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1' ? fileURLToPath(new URL(`../../../docs/evidence/SH-255/${name}-${width}.png`, import.meta.url)) : info.outputPath(`${name}-${width}.png`);
  const style = await page.addStyleTag({ content: '.sh-topbar { position: static !important; }' });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (whole) {
    // Every read of the page answered (the activity and the chart), then the page top to bottom.
    await expect(page.getByRole('region', { name: 'Activity' })).toBeVisible();
    await page.screenshot({ path, fullPage: true, scale: 'css' });
  } else {
    const bottom = await page.locator('.sh-bpic').evaluate((node) => Math.max(...[node, ...node.querySelectorAll('*')].map((one) => one.getBoundingClientRect().bottom)) + window.scrollY);
    await page.screenshot({ path, fullPage: true, scale: 'css', clip: { x: 0, y: 0, width, height: Math.ceil(bottom + 16) } });
  }
  await style.evaluate((node) => (node as Element).remove());
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.describe('SH-255: the box page as its picture', () => {
  for (const name of BOX_PICTURE_NAMES) {
    test(`${name}: the picture, its numbers as text, and every sheet reachable at four sizes`, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'one run sets each size itself');
      test.setTimeout(300_000);
      await serve(page);
      // The pictures first (the top at 1440 and 390; the whole page for two of the boxes: what stays under the picture).
      for (const size of SIZES.filter((one) => one.width === 1440 || one.width === 390)) {
        await page.setViewportSize(size);
        await open(page, name);
        await shot(page, info, `new-${name}`);
        if (name === 'rent-free' || name === 'sam') await shot(page, info, `full-new-${name}`, true);
      }
      for (const size of SIZES) {
        await page.setViewportSize(size);
        await open(page, name);
        await expect(page.locator('.sh-bpic h1')).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await expect(page.getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
        const parts = await page.locator('.sh-bpic svg [data-part]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-part') ?? ''));
        expect(parts.length).toBe(11);
        for (const part of parts) {
          const control = page.locator(`.sh-bpic svg [data-part="${part}"]`);
          await control.focus();
          await page.keyboard.press('Enter');
          const sheet = page.getByRole('dialog');
          await expect(sheet).toBeVisible();
          // Its (?) open: the tallest state of each sheet.
          const why = sheet.locator('.sh-info-button, button[aria-controls]').first();
          if (await why.count()) await why.click();
          // The sheet's last control can be reached: scrolled into view, it is inside the window and inside the sheet.
          const controls = sheet.locator('button, a[href], summary, [tabindex="0"]');
          const lastControl = controls.last();
          await lastControl.scrollIntoViewIfNeeded();
          const box = await lastControl.boundingBox();
          const view = page.viewportSize();
          expect(box, `${name} ${part} ${size.width}: its last control has a box`).not.toBeNull();
          // Soft: one size failing (the wide-screen sheet waits for SH-254) never stops the other sizes' checks.
          expect.soft((box?.y ?? -1) >= 0 && (box?.y ?? 0) + (box?.height ?? 0) <= (view?.height ?? 0), `${name} ${part} at ${size.width}x${size.height}: the last control in the window`).toBe(true);
          // Its last line too (the sheet scrolls on its own where it is bounded, the page where it is not).
          const lastLine = sheet.locator('.sh-pic-sheet__body > :last-child, .sh-pic-sheet__body dl > div:last-child').last();
          if (await lastLine.count()) {
            await lastLine.scrollIntoViewIfNeeded();
            const line = await lastLine.boundingBox();
            expect.soft((line?.y ?? -1) >= 0 && (line?.y ?? 0) + (line?.height ?? 0) <= (view?.height ?? 0) + 1, `${name} ${part} at ${size.width}x${size.height}: the sheet's last line in the window`).toBe(true);
          }
          // No row widens the sheet or the page, the long exact amounts included (today's own digits, e.g. 984378.355669778200792201 VRAM).
          expect(await sheet.evaluate((node) => node.scrollWidth - node.clientWidth), `${name} ${part} at ${size.width}: the sheet not wider than itself`).toBeLessThanOrEqual(1);
          expect(await overflow(page), `${name} ${part} at ${size.width}: no sideways scroll with the sheet open`).toBeLessThanOrEqual(0);
          if (size.width === 1440 && part === parts[0]) await shot(page, info, `sheet-${name}`);
          // An open (?) takes the first Escape, from wherever focus is in the sheet (here its last control); the next one
          // shuts the sheet (review R-18: exactly so, never either).
          if (await why.count()) {
            await lastControl.focus();
            await page.keyboard.press('Escape');
            await expect(sheet).toBeVisible();
            await expect(why).toHaveAttribute('aria-expanded', 'false');
          }
          await page.keyboard.press('Escape');
          await expect(sheet).toHaveCount(0);
          await expect(control).toBeFocused();
        }
      }
      expect(await walletTouches(page)).toEqual([]);
    });
  }
});

// Review R-19: a 30-digit amount in a six-decimal coin (Rent Free's tUSDC) at 358 px: every figure the drawing prints
// stays inside the drawing and clear of its neighbour, Where the fees go and the sheets stay inside the page.
test('R-19: a 30-digit amount at 358 px stays inside its place', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one run sets its size itself');
  test.setTimeout(180_000);
  const huge = '123456789012345678901234567890';
  // Round 3b (G6): a six-digit holder count and an inbox with another coin, so both badges are measured.
  const withBadges = (body: Wire): Wire => {
    // The answer names the inbox's read `money.royalty` (the parser's `money.inbox`).
    const money = body.money as Wire; const inbox = money.royalty as Wire;
    return { ...body, statistics: { ...(body.statistics as Wire), holderCount: '123456' },
      money: { ...money, royalty: { ...inbox, complete: true, balances: { ...(inbox.balances as Wire), '0x00000000000000000000000000000000000000ee': '5' } } } };
  };
  const cards = bodies.map((body, i) => (BOX_PICTURE_NAMES[i] === 'rent-free' ? withBadges({ ...body, fees: { ...(body.fees as Wire), buyersP: huge, sellersP: huge } }) : body));
  await serve(page, cards);
  await page.setViewportSize({ width: 358, height: 700 });
  await open(page, 'rent-free');
  await shot(page, info, 'long-amount-rent-free');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const boxes = await page.locator('.sh-bpic svg.sh-pic').evaluate((svg) => {
    const own = svg.getBoundingClientRect();
    return [...svg.querySelectorAll('text[data-number]')].map((node) => {
      const r = node.getBoundingClientRect();
      return { id: node.getAttribute('data-number') ?? '', text: node.textContent ?? '', left: r.left - own.left, right: r.right - own.left, top: r.top, bottom: r.bottom, width: own.width };
    });
  });
  expect(boxes.find((b) => b.id === 'fee-buyers')?.text).toMatch(/B$/);
  for (const b of boxes) expect(b.left >= -0.5 && b.right <= b.width + 0.5, `${b.id} "${b.text}" inside the drawing`).toBe(true);
  for (const [a, c] of [['fee-buyers', 'fee-sellers'], ['buyers', 'sellers']] as const) {
    const one = boxes.find((b) => b.id === a); const two = boxes.find((b) => b.id === c);
    if (one && two) expect(one.right <= two.left || two.right <= one.left || one.bottom <= two.top || two.bottom <= one.top, `${a} clear of ${c}`).toBe(true);
  }
  // Each badge's digits inside the badge's own shape, not only inside the drawing (round 3b, G6).
  const badges = await page.locator('.sh-bpic svg.sh-pic').evaluate((svg) => [...svg.querySelectorAll('[data-badge-shape]')].map((shape) => {
    const id = shape.getAttribute('data-badge-shape') ?? '';
    const words = svg.querySelector(`text[data-number="${id}"]`);
    const a = shape.getBoundingClientRect(); const b = words?.getBoundingClientRect();
    return { id, text: words?.textContent ?? '', inside: b !== undefined && b.left >= a.left - 0.5 && b.right <= a.right + 0.5, inDrawing: a.right <= svg.getBoundingClientRect().right + 0.5 };
  }));
  expect(badges.map((b) => b.id).sort()).toEqual(['holders', 'inbox']);
  for (const b of badges) expect(b.inside && b.inDrawing, `${b.id} "${b.text}" inside its badge and the drawing`).toBe(true);
  // The coordinator's look: no ledger label taller than two lines, no word broken inside, at 358 and 390 (the amount
  // takes the line below the label when it does not fit beside it).
  for (const width of [358, 390]) {
    await page.setViewportSize({ width, height: width === 358 ? 700 : 844 });
    const labels = await page.locator('.sh-bpic .sh-pic-ledger__label').evaluateAll((nodes) => nodes.map((node) => {
      const line = Number.parseInt(getComputedStyle(node).lineHeight, 10) || 20; // a length in px, not an amount
      const words = [...(node.textContent ?? '').matchAll(/\S+/g)];
      const text = node.firstChild?.firstChild ?? node.firstChild;
      const broken = text instanceof Text ? words.filter((w) => { const r = document.createRange(); r.setStart(text, w.index ?? 0); r.setEnd(text, (w.index ?? 0) + w[0].length); return r.getClientRects().length > 1; }).map((w) => w[0]) : [];
      return { text: node.textContent ?? '', lines: Math.round(node.getBoundingClientRect().height / line), broken };
    }));
    for (const label of labels) expect(label.lines <= 2 && label.broken.length === 0, `${width}: "${label.text}" ${label.lines} lines, broken ${label.broken.join(' ')}`).toBe(true);
    if (width === 390) await shot(page, info, 'long-amount-rent-free');
  }
  await page.setViewportSize({ width: 358, height: 700 });
  const ledger = await page.locator('.sh-bpic .sh-pic-ledger').first().evaluate((list) => ({ scroll: list.scrollWidth, client: list.clientWidth }));
  expect(ledger.scroll - ledger.client).toBeLessThanOrEqual(1);
  // By keyboard, as the spec above opens every part (a pointer at the part's middle can land between its drawn spots).
  await page.locator('.sh-bpic svg [data-part="buyers"]').focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('123456789012345678901234.56789');
  expect(await sheet.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await walletTouches(page)).toEqual([]);
});

// SH-273 (the founder's note on the picture's layout: "can we not move the token curve under the visual overview?"): at
// two columns the price chart sits right under the picture, in its column, and the trades and holders follow it; the
// right column keeps the name, the strip, the figures, What you can do here and Where the fees go, then the trade box,
// the claims and the actions. At one column the order is the page's as before. Measured on every box at 1440x900 and
// 1280x720 (two columns) and 390x844 (one column).
test('SH-273: the chart right under the picture at two columns; one column in the page\'s order', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one run sets each size itself');
  test.setTimeout(240_000);
  await serve(page);
  const PLACES = { head: '.sh-bpic-head', main: '.sh-bpic-main', side: '.sh-bpic-side', market: '.sh-v2-top__market', aside: '.sh-v2-top__aside', activity: '.sh-v2-top__activity' } as const;
  type Place = keyof typeof PLACES;
  const boxes = async () => Object.fromEntries(await Promise.all(Object.entries(PLACES).map(async ([key, selector]) => [key, await page.locator(selector).first().boundingBox()]))) as Record<Place, { x: number; y: number; width: number; height: number } | null>;
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    for (const name of BOX_PICTURE_NAMES) {
      await open(page, name);
      await expect(page.locator('.sh-v2-top__market .sh-panel, .sh-v2-top__market section').first()).toBeVisible();
      const at = await boxes();
      const where = `${name} at ${size.width}x${size.height}`;
      for (const key of ['head', 'main', 'side', 'market', 'activity'] as const) expect(at[key], `${where}: ${key} shown`).not.toBeNull();
      const b = at as Record<Place, { x: number; y: number; width: number; height: number }>;
      const bottom = (key: Place) => b[key].y + b[key].height;
      const aside = at.aside && at.aside.height > 0 ? at.aside : null;
      if (size.width >= 900) {
        // The left column: the picture, the chart right under it (one gap), the trades and holders under the chart.
        expect(Math.abs(b.market.x - b.main.x), `${where}: the chart in the picture's column`).toBeLessThanOrEqual(1);
        expect(b.market.y - bottom('main'), `${where}: the chart right under the picture`).toBeGreaterThanOrEqual(0);
        expect(b.market.y - bottom('main'), `${where}: the chart right under the picture`).toBeLessThanOrEqual(24);
        expect(Math.abs(b.activity.x - b.main.x), `${where}: the trades and holders in the picture's column`).toBeLessThanOrEqual(1);
        expect(b.activity.y, `${where}: the trades and holders under the chart`).toBeGreaterThanOrEqual(bottom('market'));
        // The right column: the name, then the figures and the cards, then the trade box and the claims, beside the left.
        expect(b.head.x, `${where}: the name beside the picture`).toBeGreaterThanOrEqual(b.main.x + b.main.width);
        expect(Math.abs(b.side.x - b.head.x), `${where}: the figures under the name`).toBeLessThanOrEqual(1);
        expect(b.side.y, `${where}: the figures under the name`).toBeGreaterThanOrEqual(bottom('head'));
        if (aside) {
          expect(Math.abs(aside.x - b.head.x), `${where}: the trade box in the right column`).toBeLessThanOrEqual(1);
          expect(aside.y, `${where}: the trade box under Where the fees go`).toBeGreaterThanOrEqual(bottom('side'));
        }
      } else {
        // One column, the page's order: name, picture, figures, chart, trade box and claims, trades and holders.
        const order: Place[] = ['head', 'main', 'side', 'market', ...(aside ? ['aside' as const] : []), 'activity'];
        for (let i = 1; i < order.length; i += 1) {
          const [before, after] = [order[i - 1] as Place, order[i] as Place];
          expect(b[after].y, `${where}: ${after} under ${before}`).toBeGreaterThanOrEqual(bottom(before) - 1);
          expect(Math.abs(b[after].x - b.head.x), `${where}: ${after} in the one column`).toBeLessThanOrEqual(1);
        }
      }
      expect(await overflow(page), `${where}: no sideways scroll`).toBeLessThanOrEqual(0);
      if (name === 'gpu-poor' || name === 'rent-free') await shot(page, info, `layout-${name}`, true);
    }
  }
  expect(await walletTouches(page)).toEqual([]);
});

// The full test run of 25 November (css-scope.test.ts): the box page's styles for the shared drawing's route classes sit
// under its own wrapper (.sh-bpic) and still apply there: GPU Poor's buyers' routes flow (dashed), its sellers' lane is
// idle (faded); sam, raising, has no flowing route and its lanes idle.
test('the live routes keep their styles under the box page’s own wrapper', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one run');
  test.setTimeout(120_000);
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const styles = () => page.locator('.sh-bpic svg.sh-pic').evaluate((svg) => {
    const one = (selector: string) => { const el = svg.querySelector(selector); return el ? { dash: getComputedStyle(el).strokeDasharray, opacity: getComputedStyle(el).opacity } : null; };
    return { pick: one('.sh-pic-route--flow.sh-pic-route--pick'), pool: one('.sh-pic-route--flow.sh-pic-route--pool'), idleLane: one('.sh-pic-lane.sh-pic-route--idle'), idle: one('.sh-pic-route--idle') };
  });
  await open(page, 'gpu-poor');
  const graduated = await styles();
  expect(graduated.pick?.dash).toBe('12px, 6px');
  expect(graduated.pool?.dash).toBe('5px, 5px');
  expect(graduated.idleLane?.opacity).toBe('0.3');
  await open(page, 'sam');
  const raising = await styles();
  expect(raising.pick).toBeNull();
  expect(raising.idle?.opacity).toBe('0.3');
});

// Review fixes 1 and 2 (Opus browser review of 3a8c127de): sam raising, past its deadline by an hour of chain time and
// not closed yet, the state every box passes between its deadline and the close call. At four sizes: "Deadline passed"
// whole inside the box's front (two lines), and no graduation promise anywhere on the page.
test('past its deadline, not closed: the front says it whole, and nothing promises graduation, at four sizes', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one run sets each size itself');
  test.setTimeout(240_000);
  const cards = bodies.map((body, i) => {
    if (BOX_PICTURE_NAMES[i] !== 'sam') return body;
    const at = BigInt((body.asOf as Wire).timestamp as string);
    return { ...body, gate: { ...(body.gate as Wire), deadline: String(at - 3600n) } };
  });
  await serve(page, cards);
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await open(page, 'sam');
    if (size.width !== 1280) await shot(page, info, 'past-deadline-sam');
    const lines = await page.locator('.sh-bpic svg.sh-pic').evaluate((svg) => {
      const words = [...svg.querySelectorAll('text')].filter((t) => t.textContent === 'Deadline' || t.textContent === 'passed');
      const front = svg.querySelector('.sh-pic-wood-edge, .sh-bpic-outline')?.getBoundingClientRect();
      return { texts: words.map((t) => t.textContent), inside: words.every((t) => { const r = t.getBoundingClientRect(); return front !== undefined && r.left >= front.left - 0.5 && r.right <= front.right + 0.5; }) };
    });
    expect(lines, `${size.width}x${size.height}`).toEqual({ texts: ['Deadline', 'passed'], inside: true });
    // The strip's Graduate step as on a closed box (the coordinator's look), not "at 100%".
    await expect(page.locator('.sh-bpic-head .sh-life').getByText('at 100%')).toHaveCount(0);
    // The picture: its drawing, its words and Where the fees go (the cards below it are the line's own).
    await expect(page.locator('.sh-bpic')).not.toContainText(/graduation/i);
    for (const part of ['pool', 'buyers', 'holders']) {
      await page.locator(`.sh-bpic svg [data-part="${part}"]`).focus();
      await page.keyboard.press('Enter');
      const sheet = page.getByRole('dialog');
      await expect(sheet).toBeVisible();
      const why = sheet.locator('button[aria-controls][aria-expanded="false"]');
      if (await why.count()) await why.first().click();
      await expect(sheet, `${part} at ${size.width}`).not.toContainText(/graduation/i);
      await page.keyboard.press('Escape');
      if (await sheet.count()) await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    }
  }
  expect(await walletTouches(page)).toEqual([]);
});

// The coordinator's RESUME (25 November): the box page's sheets meet the reach check SH-254's sheet spec makes on
// Launch, at 1440x900, 1280x720 and 390x844, every part of every box in its tallest state (every Details and (?) open).
const REACH_SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }] as const;
test.describe('SH-254 reach on the box page', () => {
test.use({ hasTouch: true });
for (const size of REACH_SIZES) {
  test(`SH-254's sheet reach on the box page at ${size.width}x${size.height}: every sheet of the six boxes`, async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'sizes are set per test');
    test.setTimeout(600_000);
    await serve(page);
    await page.setViewportSize(size);
    const found: Record<string, Awaited<ReturnType<typeof reach>>['checks']> = {};
    const why: Record<string, string> = {};
    for (const name of BOX_PICTURE_NAMES) {
      await open(page, name);
      const parts = await page.locator('.sh-bpic svg [data-part]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-part') ?? ''));
      for (const part of parts) {
        await page.locator(`.sh-bpic svg [data-part="${part}"]`).focus();
        await page.keyboard.press('Enter');
        const sheet = page.locator('[data-sheet]');
        await expect(sheet).toBeVisible();
        await tallest(page, sheet);
        const result = await reach(page, sheet, size.width < 900);
        found[`${name} ${part}`] = result.checks;
        why[`${name} ${part}`] = result.why;
        await sheet.getByRole('button', { name: 'Close' }).click();
        await expect(sheet).toBeHidden();
      }
    }
    const every = { sheetInWindow: true, movedByWheel: true, lastByWheel: true, reachedEnd: true, closeShown: true, movedByTouch: true, lastByFocus: true };
    expect(found, JSON.stringify(why, null, 1)).toEqual(Object.fromEntries(Object.keys(found).map((id) => [id, every])));
    expect(Object.keys(found).length).toBe(6 * 11);
  });
}
});
