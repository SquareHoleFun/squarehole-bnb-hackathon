import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from 'viem';
import { injectTestWallet } from './test-wallet';

// SH-296 with the creator's rules (SH-287): on the fork that scripts/flap-rules-fork.sh brings up (the rules pairs
// deployed in it and named in public/local/addresses.json), a BNB sale through the rules pair's launcher factory reads
// THAT factory's floor: Flap's helper sets the multiplier per factory (set here by a stranger), and the plain factory's
// entry is not touched. The minimum beside the target and the rules fields at 1440 and 390; a rules sale below the
// floor shows the floor line and its rules panel. Run only when FLOOR_RULES is set.
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8582';
const SHOTS = process.env.FLOOR_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-296');
const Q = '?addresses=local/addresses.json';
type Pair = { launcherFactory: Address; rulesVaultFactory: Address };
const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as {
  flap: { curveLauncherFactory: Address; portal: Address; rules?: { native: Pair } };
};
const HELPER: Address = '0x77779969a11eff7582f3bCf48135A846A3457777';
const helperAbi = parseAbi(['function whitelist(address factory, uint16 bps)']);
const portalAbi = parseAbi(['function launcherFactoryMultiplier(address factory) view returns (bool, uint16)']);
const launcherAbi = parseAbi(['function factory() view returns (address)']);
const chain = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ transport: http(RPC) });
const GAS_PRICE_97 = '0x5f5e100';

test.describe.configure({ mode: 'serial' });
test.skip(!process.env.FLOOR_RULES || !local.flap.rules, 'needs the rules fork run (FLOOR_RULES)');

const accounts = async () => (await chain.request({ method: 'eth_accounts' } as never)) as Address[];
const multiplierOf = async (factory: Address) =>
  (await chain.readContract({ address: local.flap.portal, abi: portalAbi, functionName: 'launcherFactoryMultiplier', args: [factory] })) as readonly [boolean, number];
async function setMultiplier(factory: Address, bps: number) {
  const stranger = (await accounts())[7]!;
  const hash = await wallet.writeContract({ account: stranger, chain: null, address: HELPER, abi: helperAbi, functionName: 'whitelist', args: [factory, bps] });
  expect((await chain.waitForTransactionReceipt({ hash })).status).toBe('success');
  const rules = await multiplierOf(local.flap.rules!.native.launcherFactory);
  const plain = await multiplierOf(local.flap.curveLauncherFactory);
  console.log(`a stranger (${stranger}) set ${factory} to ${bps}: rules factory ${rules.join(' ')}, plain factory ${plain.join(' ')}`);
  return { rules, plain };
}
/** Chain 97's own gas price (0.1 gwei) for the page and the test wallet; anvil suggests 1 gwei (as flap-floor.spec.ts). */
async function chainGasPrice(page: Page) {
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
async function both(page: Page, name: string, check: () => Promise<void>) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await check();
    // Nothing wider than the window (the minimum and the rules fields side by side must still fit).
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function connect(page: Page) {
  const button = page.getByTestId('connect');
  if (await button.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await button.click();
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

test('rules pair: its own factory\'s floor decides the default and the sale\'s line; the plain factory\'s entry is untouched', async ({ page }) => {
  const RULES = local.flap.rules!.native.launcherFactory;
  const plainBefore = await multiplierOf(local.flap.curveLauncherFactory);
  const set0 = await setMultiplier(RULES, 0);
  expect(set0.rules).toEqual([true, 0]);
  expect(set0.plain).toEqual(plainBefore);

  await injectTestWallet(page, RPC, 8);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await connect(page);
  await page.getByTestId('way-steps').click();
  await page.getByTestId('quote-native').click();
  await expect(page.getByTestId('rules-fields')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-target')).toHaveValue('0.003', { timeout: 60_000 });
  await expect(page.getByTestId('create-min')).toHaveText('min 0.0002', { timeout: 60_000 });
  await page.getByTestId('create-name').fill('Rules Floor');
  await page.getByTestId('create-symbol').fill('RLFL');
  await page.getByTestId('rules-creator').fill('40');
  await page.getByTestId('rules-pile').fill('0');
  await page.getByTestId('rules-burn').fill('60');
  await expect(page.getByTestId('create')).toBeEnabled({ timeout: 60_000 });
  // The shown minimum, typed in, has no floor line here either; then back to the default.
  await page.getByTestId('create-target').fill('0.0002');
  await expect(page.getByTestId('create')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('create-floor')).toHaveCount(0);
  await page.getByTestId('create-target').fill('0.003');
  await expect(page.getByTestId('create')).toBeEnabled({ timeout: 60_000 });
  await both(page, 'floor-rules-create', async () => {
    await expect(page.getByTestId('create-min')).toBeVisible();
    await expect(page.getByTestId('rules-fields')).toBeVisible();
    await level(page);
  });
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 180_000 });
  const launcher = page.url().split('/').pop() as Address;
  expect(((await chain.readContract({ address: launcher, abi: launcherAbi, functionName: 'factory' })) as Address).toLowerCase()).toBe(RULES.toLowerCase());
  await expect(page.getByTestId('rules-panel')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('floor-rose')).toHaveCount(0);

  // The rules factory back at the full floor: this sale cannot launch; the line and the rules panel both show.
  const set1 = await setMultiplier(RULES, 10_000);
  expect(set1.plain).toEqual(plainBefore);
  await page.reload();
  await connect(page);
  await expect(page.getByTestId('floor-rose')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('rules-panel')).toBeVisible();
  await expect(page.getByTestId('launch')).toBeDisabled();
  await both(page, 'floor-rules-sale', async () => {
    await expect(page.getByTestId('floor-rose')).toBeVisible();
    await expect(page.getByTestId('rules-panel')).toBeVisible();
  });
});
