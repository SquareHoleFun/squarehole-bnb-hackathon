import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { CREATE_DEFAULTS, mineSalt, readCreateForm } from '../src/lib/flap';
import { injectTestWallet } from './test-wallet';

// SH-296: Flap's floor on the page, on a local fork of BSC Testnet as it is (the real factories and Flap's Portal),
// with Flap's test-network helper (0x7777…7777) set by a stranger (one of anvil's development accounts):
// 1. multiplier 0 (no floor): the page shows the page's own minimum and the small default; a visitor holding exactly
//    0.01 BNB creates, fills and launches a sale at that default;
// 2. multiplier back at 10000: a small sale made under 0 cannot launch: the page says so and sends no completing buy;
//    the create page is back at today's default and shows Flap's minimum.
// Run only when FLOOR_FORK is set. Shots at 1440 and 390.
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-296');
const Q = '?addresses=local/addresses.json';
// The entry's own ABIs, read as files (a spec runs in Node, where a JSON import needs an attribute the app's code has not).
const entryAbi = (name: string) => JSON.parse(fs.readFileSync(path.join(here, `../../flap/abi/${name}.json`), 'utf8')) as Abi;
const curveFactoryAbi = entryAbi('CurveLauncherFactory');
const flapPortalAbi = entryAbi('FlapPortal');
const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as { flap: { curveLauncherFactory: Address; portal: Address; sales?: { launcher: Address }[] } };
const FACTORY = local.flap.curveLauncherFactory;
const PORTAL = local.flap.portal;
const HELPER: Address = '0x77779969a11eff7582f3bCf48135A846A3457777';
const helperAbi = parseAbi(['function whitelist(address factory, uint16 bps)', 'function whitelist(address factory)']);
const portalAbi = parseAbi(['function launcherFactoryMultiplier(address factory) view returns (bool, uint16)']);
const chain = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ transport: http(RPC) });

test.describe.configure({ mode: 'serial' });
test.skip(!process.env.FLOOR_FORK, 'needs the fork run (FLOOR_FORK)');

const accounts = async () => (await chain.request({ method: 'eth_accounts' } as never)) as Address[];
async function setMultiplier(bps: number | null) {
  const stranger = (await accounts())[7]!;
  const hash = bps === null
    ? await wallet.writeContract({ account: stranger, chain: null, address: HELPER, abi: helperAbi, functionName: 'whitelist', args: [FACTORY] })
    : await wallet.writeContract({ account: stranger, chain: null, address: HELPER, abi: helperAbi, functionName: 'whitelist', args: [FACTORY, bps] });
  expect((await chain.waitForTransactionReceipt({ hash })).status).toBe('success');
  const [enabled, now] = (await chain.readContract({ address: PORTAL, abi: portalAbi, functionName: 'launcherFactoryMultiplier', args: [FACTORY] })) as readonly [boolean, number];
  console.log(`multiplier set by a stranger (${stranger}): ${enabled} ${now}`);
  return now;
}
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
async function both(page: Page, name: string, check: () => Promise<void>) {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await check();
    await shot(page, `${name}-${w}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
/** The page asks to connect after a load: once per load (a page already connected shows no button). */
async function connect(page: Page) {
  const button = page.getByTestId('connect');
  if (await button.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await button.click();
}
async function openCreate(page: Page, account: number | null) {
  if (account !== null) await injectTestWallet(page, RPC, account);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await connect(page);
  await page.getByTestId('way-steps').click();
  if (await page.getByTestId('quote-choice').waitFor({ timeout: 10_000 }).then(() => true, () => false)) await page.getByTestId('quote-native').click();
}

/**
 * Chain 97's own gas price (0.1 gwei, `eth_gasPrice` on the public endpoint, read 26 Nov 2026) for the page and the
 * test wallet: anvil's fork suggests 1 gwei, ten times the real chain, which would make the visitor's 0.01 BNB look
 * short when it is not.
 */
const GAS_PRICE_97 = '0x5f5e100';
async function chainGasPrice(page: Page) {
  // The page's reads go out batched (several methods in one request): the request goes to the fork as it is and only the
  // two price answers are replaced.
  const PRICE = new Set(['eth_gasPrice', 'eth_maxPriorityFeePerGas']);
  await page.route(`${RPC}/**`, async (route) => {
    const body = route.request().postData() ?? '';
    let req: { id: number; method: string } | { id: number; method: string }[] | null = null;
    try { req = body ? JSON.parse(body) : null; } catch { req = null; }
    const list = req === null ? [] : Array.isArray(req) ? req : [req];
    if (!list.some((r) => PRICE.has(r.method))) return route.continue();
    const response = await route.fetch();
    const json = (await response.json()) as { id: number; result?: unknown }[] | { id: number; result?: unknown };
    const priced = new Set(list.filter((r) => PRICE.has(r.method)).map((r) => r.id));
    const fix = (a: { id: number; result?: unknown }) => (priced.has(a.id) ? { ...a, result: GAS_PRICE_97, error: undefined } : a);
    return route.fulfill({ response, json: Array.isArray(json) ? json.map(fix) : fix(json) });
  });
}

/** The target's input sits level with its neighbour's (the minimum must not push it down at any width). */
async function level(page: Page) {
  const [a, b] = await Promise.all([page.getByTestId('create-symbol').boundingBox(), page.getByTestId('create-target').boundingBox()]);
  if (a && b && a.width + b.width < (page.viewportSize()?.width ?? 0)) expect(Math.abs(a.y - b.y), 'symbol and target inputs level').toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => {
  await chainGasPrice(page);
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('multiplier 0: the small default; a visitor with 0.01 BNB creates, fills and launches', async ({ page }) => {
  expect(await setMultiplier(0)).toBe(0);
  const visitor = (await accounts())[5]!;
  await chain.request({ method: 'anvil_setBalance', params: [visitor, `0x${parseEther('0.01').toString(16)}`] } as never);
  const b0 = await chain.getBlockNumber({ cacheTime: 0 });
  await openCreate(page, 5);
  await expect(page.getByTestId('create-target')).toHaveValue('0.003', { timeout: 60_000 });
  await expect(page.getByTestId('create-min')).toHaveText('min 0.0002', { timeout: 60_000 });
  await page.getByTestId('create-name').fill('Small Floor');
  await page.getByTestId('create-symbol').fill('SMFL');
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 90_000 });
  await both(page, 'floor0-create', async () => { await expect(page.getByTestId('create-min')).toBeVisible(); await level(page); });
  console.log(`the create screen: ${(await page.getByTestId('create-form').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 });
  await expect(page.getByTestId('launch')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('floor-rose')).toHaveCount(0);
  const launcher = page.url().split('/').pop() as Address;
  const cost = (await chain.readContract({ address: launcher, abi: parseAbi(['function costToComplete() view returns (uint256)']), functionName: 'costToComplete' })) as bigint;
  console.log(`after creating: visitor holds ${formatEther(await chain.getBalance({ address: visitor }))} BNB; the rest costs ${formatEther(cost)} BNB`);
  await page.getByTestId('launch').click();
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 120_000 });
  const left = await chain.getBalance({ address: visitor });
  console.log(`visitor ${visitor}: 0.01 BNB before; ${formatEther(left)} BNB after creating and launching`);
  // What a wallet checks before each send: value + gas limit × fee cap (the page sets both; SH-280 fees.ts).
  const to = await chain.getBlockNumber({ cacheTime: 0 });
  for (let n = b0 + 1n; n <= to; n++) {
    for (const t of (await chain.getBlock({ blockNumber: n, includeTransactions: true })).transactions) {
      if (t.from.toLowerCase() !== visitor.toLowerCase()) continue;
      const r = await chain.getTransactionReceipt({ hash: t.hash });
      console.log(`SEND to ${t.to} value ${t.value} gasLimit ${t.gas} gasUsed ${r.gasUsed} maxFeePerGas ${t.maxFeePerGas} tip ${t.maxPriorityFeePerGas} effective ${r.effectiveGasPrice}`);
    }
  }
  await both(page, 'floor0-launched', async () => { await expect(page.getByTestId('sale-phase')).toHaveText('Launched'); });
  // With no floor, the page's own minimum holds: a target below 0.0002 BNB is refused on the form.
  await openCreate(page, null);
  await expect(page.getByTestId('create-target')).toHaveValue('0.003', { timeout: 60_000 });
  // The shown minimum, typed in, is accepted (no floor line, no refusal); one step below it is the page's own refusal.
  await page.getByTestId('create-target').fill('0.0002');
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('create-floor')).toHaveCount(0);
  await expect(page.getByTestId('create-refusal')).toHaveCount(0);
  await page.getByTestId('create-target').fill('0.0001');
  await expect(page.getByTestId('create-refusal').filter({ hasText: 'At least 0.0002.' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('create')).toBeDisabled();
  await both(page, 'floor0-page-minimum', async () => { await expect(page.getByTestId('create-refusal').filter({ hasText: 'At least 0.0002.' })).toBeVisible(); });
});

test('multiplier back at 10000: a small sale cannot launch, the page says so and sends nothing; the default is today\'s again', async ({ page }) => {
  await setMultiplier(0);
  await openCreate(page, 6);
  await expect(page.getByTestId('create-target')).toHaveValue('0.003', { timeout: 60_000 });
  await page.getByTestId('create-name').fill('Floor Rose');
  await page.getByTestId('create-symbol').fill('FLRS');
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 });
  const sale = page.url();
  expect(await setMultiplier(null)).toBe(10000);
  await page.goto(sale);
  await page.reload();
  await connect(page);
  await expect(page.getByTestId('floor-rose')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('launch')).toBeDisabled();
  // A buy that would take the rest is refused before the wallet is asked.
  const sentBefore = await page.evaluate(() => (window as unknown as { __wallet: { sent: unknown[] } }).__wallet.sent.length);
  await page.getByTestId('buy-amount').fill('0.01');
  await expect(page.getByTestId('buy')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('buy').click();
  await expect(page.getByText("Nothing was sent: this sale is below Flap's minimum now").first()).toBeVisible({ timeout: 60_000 });
  // The dialog closed (by the handler above or here) before the pictures, so the line in the launch box shows.
  const close = page.getByTestId('press-close');
  await expect(async () => {
    if (await close.isVisible()) await close.click({ timeout: 2_000 }).catch(() => undefined);
    await expect(close).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { __wallet: { sent: unknown[] } }).__wallet.sent.length)).toBe(sentBefore);
  await both(page, 'floor-rose-sale', async () => { await expect(page.getByTestId('floor-rose')).toBeVisible(); });
  await openCreate(page, null);
  await expect(page.getByTestId('create-target')).toHaveValue('2.35', { timeout: 60_000 });
  // The number itself moves with the Portal's BNB price (SH-293 read 2.3018; any four-decimal number here): what is
  // pinned is that it is exact (below).
  await expect(page.getByTestId('create-min')).toHaveText(/^min [12]\.\d{1,4}$/, { timeout: 60_000 });
  await both(page, 'floor-back-create', async () => { await expect(page.getByTestId('create-min')).toBeVisible(); await level(page); });
  // The shown minimum is exact: typed in, Create has no floor line; one step (0.0001) below, it has.
  const shown = (await page.getByTestId('create-min').innerText()).replace(/^min /, '');
  const below = (Number(shown) - 0.0001).toFixed(4);
  console.log(`full floor: shown min ${shown}; one step below ${below}`);
  await page.getByTestId('create-name').fill('Exact Min');
  await page.getByTestId('create-symbol').fill('EXMN');
  await page.getByTestId('create-target').fill(shown);
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('create-floor')).toHaveCount(0);
  await page.getByTestId('create-target').fill(below);
  await expect(page.getByTestId('create-floor')).toBeVisible({ timeout: 60_000 });
  await both(page, 'floor-back-one-below', async () => { await expect(page.getByTestId('create-floor')).toBeVisible(); });
});

test('a sale made directly (createLauncher, not through the Portal): the Portal has no record of it, so the page reads the full floor for it', async ({ page }) => {
  expect(await setMultiplier(0)).toBe(0);
  const creator = (await accounts())[9]!;
  const r = (functionName: string) => chain.readContract({ address: FACTORY, abi: curveFactoryAbi, functionName }) as Promise<unknown>;
  const [tokenImpl, hub, fee] = (await Promise.all([r('tokenImpl'), r('hub'), r('creationFee')])) as [Address, Address, bigint];
  const form = readCreateForm({ ...CREATE_DEFAULTS, name: 'Direct Floor', symbol: 'DRFL' }, 18);
  if (!form.ok) throw new Error('the defaults do not read');
  const { salt } = await mineSalt(tokenImpl, hub, bytesToHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);
  // The direct path checks the FULL floor at creation (checkConfig(c, false)), so the entry's 2.35 is the size to use.
  const hash = await wallet.writeContract({ account: creator, chain: null, address: FACTORY, abi: curveFactoryAbi, functionName: 'createLauncher', args: [{ ...form.config, meta: '', salt }], value: fee });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  const created = parseEventLogs({ abi: curveFactoryAbi, logs: receipt.logs, eventName: 'CurveLauncherCreated' })[0]!.args as { launcher: Address; viaPortal: boolean };
  const record = (await chain.readContract({ address: hub, abi: flapPortalAbi, functionName: 'getLauncher', args: [created.launcher] })) as { launcherFactory: Address };
  const known = local.flap.sales?.[0]?.launcher;
  const knownRecord = known ? ((await chain.readContract({ address: hub, abi: flapPortalAbi, functionName: 'getLauncher', args: [known] })) as { launcherFactory: Address }) : undefined;
  console.log(`direct sale ${created.launcher} (event viaPortal ${created.viaPortal}): Portal record ${record.launcherFactory}; the deployment's sale ${known}: ${knownRecord?.launcherFactory}`);
  expect(created.viaPortal).toBe(false);
  expect(BigInt(record.launcherFactory)).toBe(0n);
  if (knownRecord) expect(knownRecord.launcherFactory.toLowerCase()).toBe(FACTORY.toLowerCase());
  await injectTestWallet(page, RPC, 9);
  await page.goto(`/${Q}#/flap/${created.launcher}`);
  await connect(page);
  await expect(page.getByTestId('sale-phase')).toHaveText('Selling', { timeout: 60_000 });
  await expect(page.getByTestId('launch')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('floor-rose')).toHaveCount(0);
});
