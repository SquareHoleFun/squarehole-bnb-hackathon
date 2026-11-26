import { expect, test, type Page } from '@playwright/test';
import { type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * SH-280 STEP 2: the launch pages with the wallet Privy made for the site's X sign-in (Privy's stand-in in the
 * development server, PILE_PRIVY_STANDIN=1), on a local fork of BSC Testnet as it is (scripts/made-wallet-fork.sh): no
 * second sign-in, no "Connect wallet", no window; a Flap sale created through the Portal and a buy on it, every send from
 * the made wallet with both fee fields set by the page (the chain's price read right before, plus a tenth; no legacy
 * price). The site's sign-in service is played here (`/alpha/me`). Screenshots go to the test's output.
 */
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8622';
const Q = '?addresses=local/addresses.json';
const CEILING = 5_000_000_000n;

async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** The site's sign-in (signed in with X) and the stand-in's made wallet in this browser; its sends to the fork. */
async function signedInWithMadeWallet(page: Page, key: Hex) {
  await page.addInitScript((k) => {
    window.localStorage.setItem('sh.standin.privy.wallet.v1', JSON.stringify(k));
  }, key);
  await page.route('**/alpha/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'approved', handle: 'ada_builds', claim: null }) }));
  await page.route('**/__standin/privy/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ chainId: 97, rpcUrl: RPC }) }));
  // The page's sends and fee reads, in order (the made wallet sends to the fork directly; the page reads it too).
  const order: string[] = [];
  const sent: Record<string, string>[] = [];
  // The chain's price as the page read it, and the last answer before each send (the read right before the wallet).
  const prices: { at: number; price: bigint }[] = [];
  const sentAt: number[] = [];
  page.on('response', async (response) => {
    const at = Date.now();
    const request = response.request();
    if (!request.url().startsWith(RPC) || request.method() !== 'POST') return;
    try {
      const calls = [request.postDataJSON()].flat() as { id: number; method: string }[];
      const answers = [await response.json()].flat() as { id: number; result?: string }[];
      for (const call of calls) if (call.method === 'eth_gasPrice') {
        const answer = answers.find((a) => a.id === call.id);
        if (answer?.result) prices.push({ at, price: BigInt(answer.result) });
      }
    } catch { /* not JSON-RPC */ }
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(RPC) || request.method() !== 'POST') return;
    try {
      const body = request.postDataJSON() as { method: string; params?: unknown[] } | { method: string; params?: unknown[] }[];
      for (const call of Array.isArray(body) ? body : [body]) {
        order.push(call.method);
        if (call.method === 'eth_sendTransaction') {
          sent.push(call.params?.[0] as Record<string, string>);
          sentAt.push(Date.now());
        }
      }
    } catch { /* not JSON-RPC */ }
  });
  /** The price of the last answer that arrived before each send. */
  const priceBefore = () => sentAt.map((t) => prices.filter((p) => p.at <= t).sort((a, b) => a.at - b.at).at(-1)?.price ?? 0n);
  return { order, sent, priceBefore };
}

async function shot(page: Page, testInfo: { outputPath(name: string): string }, name: string) {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${w}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('signed in with X on the site: the made wallet creates a Flap sale and buys on it, at the page’s own fee', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const key = generatePrivateKey();
  const made = privateKeyToAccount(key).address as Address;
  await rpc('anvil_setBalance', [made, '0x' + (10n * 10n ** 18n).toString(16)]);
  const { order, sent, priceBefore: pricesBefore } = await signedInWithMadeWallet(page, key);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  // The wallet place shows the made wallet at once: no sign-in, no "Connect wallet".
  const walletButton = page.getByRole('banner').getByTestId('account');
  await expect(walletButton).toHaveAccessibleName(new RegExp(`^Wallet Privy made ${made.slice(0, 6)}`), { timeout: 30_000 });
  await expect(page.getByTestId('connect')).toHaveCount(0);
  await expect(page.getByTestId('no-wallet')).toHaveCount(0);
  // Flap's create screen opens in the Visual way (lane h, SH-281); this test fills the form in the Steps way, one press
  // away (both ways edit the same form and press the same send).
  await page.getByTestId('way-steps').click();
  const hasChoice = await page.getByTestId('quote-choice').waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (hasChoice) await page.getByTestId('quote-native').click();
  await expect(page.getByTestId('create-raise')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('create-target').fill('2.35');
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, 'made-flap-create');
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 });
  await expect(page.getByTestId('sale-phase')).toHaveText('Selling', { timeout: 30_000 });
  await page.getByTestId('buy-amount').fill('0.1');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('buy-box').getByTestId('tx-status').filter({ hasText: 'Buy: done' }).first()).toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, 'made-flap-bought');

  // Every send: from the made wallet, both fee fields, no legacy price, at least the chain's price, under the ceiling,
  // after a fresh read of the chain's price.
  expect(sent.length).toBeGreaterThanOrEqual(2);
  const priceBefore = pricesBefore();
  for (const [i, tx] of sent.entries()) {
    expect(tx.from?.toLowerCase()).toBe(made.toLowerCase());
    expect(tx.gasPrice).toBeUndefined();
    const [tip, max] = [BigInt(tx.maxPriorityFeePerGas!), BigInt(tx.maxFeePerGas!)];
    // At least the chain's price the page read right before this send, plus its tenth.
    expect(priceBefore[i]!).toBeGreaterThan(0n);
    expect(tip).toBeGreaterThanOrEqual(priceBefore[i]! + priceBefore[i]! / 10n);
    expect(max).toBeGreaterThanOrEqual(tip);
    expect(tip).toBeLessThanOrEqual(CEILING);
  }
  const sends = order.flatMap((m, at) => (m === 'eth_sendTransaction' ? [at] : []));
  let from = 0;
  for (const at of sends) { expect(order.slice(from, at)).toContain('eth_gasPrice'); from = at + 1; }
  console.log(`SENDS ${JSON.stringify(sent.map((tx, i) => ({ priceReadBefore: priceBefore[i]!.toString(), to: tx.to, maxFeePerGas: BigInt(tx.maxFeePerGas!).toString(), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas!).toString() })))}`);
});
