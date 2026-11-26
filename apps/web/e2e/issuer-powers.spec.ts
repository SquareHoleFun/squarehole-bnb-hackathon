import { createOptionsAnswer } from './create-options-list';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeAbiParameters, erc20Abi, toHex, type Address, type Hex } from 'viem';
import manifest from './fixtures/core-local/manifest-11155111.json' with { type: 'json' };
import { installUntouchableWallet, walletTouches } from './box-helpers';

// SH-V2-FE8 (LOCAL-COINS-B review): on a chain source, each price coin's card shows the issuer powers its own listed
// contract has, read over the source's RPC at the listing's address, never from the ticker, and the stock note by
// class; the old "Issuer powers have not been checked." is gone. The local twin's build manifest names the release; the
// indexer's listing book and the RPC are answered here as the local release's eight coins would answer them
// (packages/contracts/script/local/LocalQuoteMocks.sol: NVDAon and AAPLon name one shared LocalStockControls with
// paused() and frozen(address); USDC, LINK, WBTC, PAXG and XAUt are plain faucets). Nothing leaves the machine and no
// wallet is asked. SH_EVIDENCE_SCREENSHOTS=1 writes the cards to docs/evidence/SH-V2-FE8/.

const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const CHAIN_ID = manifest.chainId;
const REGISTRY = manifest.releases[0]?.registry.address.toLowerCase() ?? '';
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const at = (n: number): Address => `0x50000000000000000000000000000000000000${n.toString(16).padStart(2, '0')}` as Address;
const CONTROLS = at(0x10);

const PAUSE_ALL = 'The issuer can pause or block all its tokens at once.';
const FREEZE = 'The issuer can freeze addresses, including the pool.';
const STOCK = 'Stock-linked: may not be offered to US persons.';

/** The local release's book: symbol, address, decimals, class, raise (the LOCAL-COINS-B table for the new four). */
const COINS = [
  ['ETH', NATIVE, 18, 'NATIVE', 4_206_980_085_000_000_000n],
  ['USDC', at(1), 6, 'STABLE', 8_413_960_170n],
  ['LINK', at(2), 18, 'OTHER', 280_000_000_000_000_000_000n],
  ['WBTC', at(3), 8, 'OTHER', 7_011_634n],
  ['NVDAon', at(4), 18, 'STOCK', 42_069_800_850_000_000_000n],
  ['AAPLon', at(5), 18, 'STOCK', 33_655_840_680_000_000_000n],
  ['PAXG', at(6), 18, 'OTHER', 2_103_490_042_500_000_000n],
  ['XAUt', at(7), 6, 'OTHER', 2_103_491n],
] as const;

const ABI = [
  ...erc20Abi,
  { type: 'function', name: 'controls', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  ...['frozen', 'isFrozen', 'isBlacklisted', 'isBlackListed', 'isBlocked'].map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [{ type: 'address', name: 'account' }], outputs: [{ type: 'bool' }] }) as const),
] as const;
const word = (value: boolean | Address): Hex => (typeof value === 'boolean' ? encodeAbiParameters([{ type: 'bool' }], [value]) : encodeAbiParameters([{ type: 'address' }], [value]));
const ANSWERS: Readonly<Record<string, Readonly<Record<string, Hex>>>> = Object.fromEntries([
  ...COINS.filter(([, token]) => token !== NATIVE).map(([symbol, token]) => [token.toLowerCase(), {
    symbol: encodeAbiParameters([{ type: 'string' }], [symbol]),
    ...(symbol === 'NVDAon' || symbol === 'AAPLon' ? { controls: word(CONTROLS) } : {}),
  }]),
  [CONTROLS.toLowerCase(), { paused: word(false), frozen: word(false) }],
]);

async function localChain(page: Page): Promise<{ calls: string[] }> {
  const calls: string[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const listings = COINS.map(([, token, decimals, cls, raise], index) => {
      const id = index + 1;
      const detail = { id, token, decimals, class: cls, kind: 'LISTED', listedAt: '1', raise: raise.toString(), q: { bootstrapQ: '1', batchMinQ: '1', tipMaxQ: '1', swapStepMinQ: '1' } };
      return { id, token, class: cls, kind: 'LISTED', raise: raise.toString(), detail };
    });
    const answer = path === `/v2/listings/${CHAIN_ID}/${REGISTRY}` ? { schema: 'sh.core-listings.v2', chainId: CHAIN_ID, registry: REGISTRY, listings } : createOptionsAnswer(path);
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] } | Array<{ id: number; method: string; params?: unknown[] }>;
    const answer = (call: { id: number; method: string; params?: unknown[] }) => {
      if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: toHex(CHAIN_ID) };
      // Every contract of the release has code; any other address none.
      if (call.method === 'eth_getCode') return { jsonrpc: '2.0', id: call.id, result: ANSWERS[String(call.params?.[0]).toLowerCase()] ? '0x6080' : '0x' };
      if (call.method === 'eth_call') {
        const { to, data } = call.params?.[0] as { to: string; data: Hex };
        let name = 'unknown';
        try { name = decodeFunctionData({ abi: ABI, data }).functionName; } catch { /* not a getter this fixture knows */ }
        calls.push(`${to.toLowerCase()}.${name}`);
        const result = ANSWERS[to.toLowerCase()]?.[name];
        return result ? { jsonrpc: '2.0', id: call.id, result } : { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } };
      }
      return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `the fixture RPC does not answer ${call.method}` } };
    };
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  return { calls };
}

async function evidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.SH_EVIDENCE_SCREENSHOTS === '1' ? fileURLToPath(new URL('../../../docs/evidence/SH-V2-FE8/', import.meta.url)) : testInfo.outputPath('');
  mkdirSync(dir, { recursive: true });
  await page.locator('.sh-v2-pricing').screenshot({ path: `${dir}/${name}-${testInfo.project.name}.png`, scale: 'css' });
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
});

test('SH-V2-FE8: each local coin shows its own issuer powers, read from its listed contract; the stock note by class', async ({ page }, testInfo) => {
  const chain = await localChain(page);
  await page.goto('/create/v2-basics');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 1 of 6: Basics');
  const card = page.locator('[data-pricing-card]');
  const lines = () => card.locator('.sh-newbox-warnings li');
  for (const [symbol, , , cls] of COINS) {
    await page.getByRole('radio', { name: new RegExp(`^${symbol}\\b`) }).check();
    await expect(card, symbol).toContainText(symbol);
    if (cls === 'STOCK') {
      await expect(lines(), symbol).toHaveText([PAUSE_ALL, FREEZE, STOCK]);
      await expect(card, symbol).not.toContainText(/Ondo/);
      await evidence(page, testInfo, `issuer-${symbol}`);
    } else {
      // The local gold, USDC, LINK and WBTC faucets have no issuer power to name; ETH has no issuer.
      await expect(lines(), symbol).toHaveCount(0);
      if (symbol === 'PAXG' || symbol === 'XAUt') await evidence(page, testInfo, `issuer-${symbol}`);
    }
    await expect(card, symbol).not.toContainText(/have not been checked|could not be read/);
  }
  // Gold keeps its own units: PAXG 18 decimals, XAUt 6 (the LOCAL-COINS-B raises).
  await page.getByRole('radio', { name: /^PAXG\b/ }).check();
  await expect(card).toContainText('2.1034900425 PAXG');
  await page.getByRole('radio', { name: /^XAUt\b/ }).check();
  await expect(card).toContainText('2.103491 XAUt');
  // Read at the listing's address: the controller the stocks name, never a lookup by ticker.
  expect(chain.calls).toContain(`${at(4)}.controls`);
  expect(chain.calls).toContain(`${CONTROLS}.paused`);
  expect(chain.calls).toContain(`${CONTROLS}.frozen`);
  expect(chain.calls.some((call) => call.startsWith(NATIVE))).toBe(false);
  expect(await walletTouches(page)).toEqual([]);
});
