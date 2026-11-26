import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, http, type Abi, type Address } from 'viem';
import { injectTestWallet } from './test-wallet';
import { toDecimalString } from '../src/lib/amounts';

// Needs the fork that scripts/four-fork.sh brings up (it writes public/local/addresses.json).
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const ACCOUNT = process.env.FOUR_ACCOUNT as Address;
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-265');
const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as {
  openfour: { core: Address; tokens: { token: Address; kind: string; pile?: Address; taxVaultClone?: Address }[] };
};
const pileAbi = JSON.parse(fs.readFileSync(path.join(here, '../../openfour/abi/FeeRules.json'), 'utf8')) as Abi;
const taxVaultAbi = JSON.parse(fs.readFileSync(path.join(here, '../../openfour/abi/PileTaxVault.json'), 'utf8')) as Abi;
const erc20 = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;
const chain = createPublicClient({ transport: http(RPC) });
const encodeCreatePile = () => encodeFunctionData({ abi: taxVaultAbi, functionName: 'createPile' }).slice(2);
const Q = '?addresses=local/addresses.json';
const read = <T,>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  chain.readContract({ address, abi, functionName, args }) as Promise<T>;
const preset = local.openfour.tokens.find((t) => t.kind === 'preset')!;
const tax = local.openfour.tokens.find((t) => t.kind === 'tax')!;

test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function done(page: Page, box: string, label: string) {
  await expect(page.getByTestId(box).getByTestId('tx-status')).toContainText(`${label}: done`, { timeout: 60_000 });
}

/** Presses the box's button until it has done `label` (approving first when it asks). */
async function act(page: Page, box: string, button: string, label: string) {
  for (let i = 0; i < 3; i++) {
    const b = page.getByTestId(box).getByTestId(button);
    await expect(b).toBeEnabled({ timeout: 30_000 });
    const text = (await b.textContent()) ?? '';
    const doing = text.startsWith('Approve') ? 'Approve' : text.startsWith('Wrap') ? 'Wrap' : label;
    await b.click();
    await done(page, box, doing);
    if (doing === label) return;
    await expect(b).toHaveText(new RegExp(`^${label}`), { timeout: 30_000 });
  }
}

async function pileOf(pile: Address) {
  const [p, asset] = await Promise.all([read<bigint>(pile, pileAbi, 'pile'), read<Address>(pile, pileAbi, 'asset')]);
  const sym = await chain.readContract({ address: asset, abi: erc20, functionName: 'symbol' });
  return { p, title: `${toDecimalString(p, 18)} ${sym}` };
}

// Each press ends in its dialog with Close: it is pressed before the test's next action.
test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('Pile Bonding preset: buy and sell on the curve fill the pile, redeem pays the quote', async ({ page }) => {
  await injectTestWallet(page, RPC, 0, ACCOUNT);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/`);
  await expect(page.getByTestId('four-line').filter({ hasText: 'Pile Demo · PILE' })).toBeVisible({ timeout: 30_000 });
  await shot(page, 'four-home');
  await page.goto(`/${Q}#/four/${preset.token}`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('four-phase')).toHaveText('On the curve', { timeout: 30_000 });
  const pile = preset.pile!;
  const before = await pileOf(pile);

  await page.getByTestId('curve-amount').fill('0.1');
  await expect(page.getByTestId('curve-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'curve-trade', 'curve-trade-btn', 'Buy');
  const afterBuy = await pileOf(pile);
  expect(afterBuy.p > before.p).toBe(true);
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', afterBuy.title, { timeout: 30_000 });
  await expect(page.getByTestId('pile-delta')).toContainText('+');

  await page.getByTestId('curve-sell-tab').click();
  await page.getByTestId('curve-amount').fill('1000000');
  await expect(page.getByTestId('curve-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'curve-trade', 'curve-trade-btn', 'Sell');
  const afterSell = await pileOf(pile);
  expect(afterSell.p > afterBuy.p).toBe(true);
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', afterSell.title, { timeout: 30_000 });

  const quote = await read<bigint>(pile, pileAbi, 'quoteRedeem', [10n ** 24n]);
  await page.getByTestId('redeem-amount').fill('1000000');
  await expect(page.getByTestId('redeem-review').locator('.amount').first()).toHaveAttribute('title', new RegExp(`^${toDecimalString(quote, 18)} `));
  await page.getByTestId('redeem').click();
  await done(page, 'redeem-box', 'Redeem');
  const paid = await read<bigint>(pile, pileAbi, 'totalPaidOut');
  expect(paid).toBe(quote);
  await expect(page.getByTestId('paid-out').locator('.amount')).toHaveAttribute('title', new RegExp(`^${toDecimalString(paid, 18)} `), { timeout: 30_000 });
  await shot(page, 'four-preset');
});

test('tax-vault template: curve, move to PancakeSwap, DEX trades, settle into the pile, redeem', async ({ page }) => {
  await injectTestWallet(page, RPC, 0, ACCOUNT);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/four/${tax.token}`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('four-token')).toHaveAttribute('data-kind', 'tax', { timeout: 30_000 });
  await expect(page.getByTestId('settle-box')).toBeVisible();
  const pile = await read<Address>(tax.taxVaultClone!, taxVaultAbi, 'pile');

  await page.getByTestId('curve-amount').fill('0.2');
  await expect(page.getByTestId('curve-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'curve-trade', 'curve-trade-btn', 'Buy');
  await shot(page, 'four-tax-curve');

  // Buy to the end of the sale: the token moves to PancakeSwap V2.
  const vaultAbi = JSON.parse(fs.readFileSync(path.join(here, '../../openfour/abi/OpenFourVault.json'), 'utf8')) as Abi;
  const coreAbi = JSON.parse(fs.readFileSync(path.join(here, '../../openfour/abi/OpenFourCore.json'), 'utf8')) as Abi;
  const info = await read<readonly unknown[]>(local.openfour.core, coreAbi, 'tokens', [tax.token]);
  const vault = info[10] as Address;
  for (let round = 0; round < 6; round++) {
    if ((await page.getByTestId('four-phase').textContent()) === 'On PancakeSwap') break;
    await page.getByTestId('curve-amount').fill('1');
    await expect(page.getByTestId('curve-review')).toBeVisible({ timeout: 30_000 });
    const raised = await read<bigint>(vault, vaultAbi, 'totalRaised');
    const b = page.getByTestId('curve-trade-btn');
    if (((await b.textContent()) ?? '').startsWith('Approve')) {
      await b.click();
      await done(page, 'curve-trade', 'Approve');
      await expect(b).toHaveText('Buy', { timeout: 30_000 });
    }
    await b.click();
    // The buy that ends the sale replaces the curve box: watch the chain, then the status that stays on screen.
    await expect.poll(() => read<bigint>(vault, vaultAbi, 'totalRaised'), { timeout: 60_000 }).not.toBe(raised);
    await page.waitForTimeout(1500);
  }
  await expect(page.getByTestId('curve-status').getByTestId('tx-status')).toContainText('Buy: done', { timeout: 30_000 });
  await expect(page.getByTestId('four-phase')).toHaveText('On PancakeSwap', { timeout: 30_000 });

  // DEX trades pay the tax, held by the token until a transfer settles it into the pile.
  await page.getByTestId('trade-buy-tab').click();
  await page.getByTestId('trade-amount').fill('0.01');
  await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'pool-trade', 'trade', 'Buy');
  await page.getByTestId('trade-sell-tab').click();
  await page.getByTestId('trade-amount').fill('1000000');
  await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'pool-trade', 'trade', 'Sell');
  const beforeSettle = await pileOf(pile);
  await page.getByTestId('settle').click();
  await done(page, 'settle-box', 'Settle');
  const afterSettle = await pileOf(pile);
  expect(afterSettle.p >= beforeSettle.p).toBe(true);
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', afterSettle.title, { timeout: 30_000 });

  const quote = await read<bigint>(pile, pileAbi, 'quoteRedeem', [10n ** 24n]);
  await page.getByTestId('redeem-amount').fill('1000000');
  await expect(page.getByTestId('redeem-review').locator('.amount').first()).toHaveAttribute('title', new RegExp(`^${toDecimalString(quote, 18)} `));
  await page.getByTestId('redeem').click();
  await done(page, 'redeem-box', 'Redeem');
  expect(await read<bigint>(pile, pileAbi, 'totalPaidOut')).toBeGreaterThanOrEqual(quote);
  await shot(page, 'four-tax-migrated');
});

test('create on the Four.meme rail from the page: the signer signs, the visitor’s wallet sends createToken (both kinds)', async ({ page }) => {
  await injectTestWallet(page, RPC, 0, ACCOUNT);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/four/create`);
  await page.getByTestId('connect').click();
  // The curve-fee launch goes through the Steps way; the tax token below through the Visual way (the default).
  await page.getByTestId('way-steps').click();
  await page.getByTestId('four-name').fill('Page Pile');
  await page.getByTestId('four-symbol').fill('PGP');
  await page.getByTestId('four-buy').fill('2');
  await page.getByTestId('four-sell').fill('1');
  await shot(page, 'four-create');
  await page.getByTestId('four-create-btn').click();
  await expect(page.getByTestId('four-name')).toBeDisabled();
  await expect(page).toHaveURL(/#\/four\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 });
  // Ours: Core made it with our preset; its pile is the Trade module's and names it.
  await expect(page.getByTestId('four-token')).toHaveAttribute('data-trusted', 'yes', { timeout: 30_000 });
  await expect(page.getByTestId('four-phase')).toHaveText('On the curve');
  await page.getByTestId('curve-amount').fill('0.1');
  await expect(page.getByTestId('curve-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'curve-trade', 'curve-trade-btn', 'Buy');
  // The buy's fee is in the new token's pile (it started empty).
  await expect(page.getByTestId('pile-size').locator('.amount').first()).not.toHaveAttribute('title', /^0 /, { timeout: 30_000 });

  // A tax token: created without a pile; the page offers to create it.
  await page.goto(`/${Q}#/four/create`); // the same page: the wallet stays connected
  await expect(page.getByTestId('way-visual')).toHaveAttribute('aria-current', 'true');
  await page.getByTestId('four-kind-tax').click();
  const part = (id: string) => page.locator(`[data-part="${id}"] .sh-pic-hit`).first();
  await part('token').click();
  await page.getByTestId('four-name').fill('Page Tax');
  await page.getByTestId('four-symbol').fill('PGT');
  await part('raise').click();
  await page.getByTestId('four-raise').fill('0.3');
  await part('buyers').click();
  await page.getByTestId('four-buy').fill('3');
  await part('sellers').click();
  await page.getByTestId('four-sell').fill('3');
  await page.getByTestId('part-close').click();
  await expect(page.locator('[data-part="buyers"]')).toHaveAttribute('aria-label', 'Buys: tax 3%');
  await page.getByTestId('four-create-btn').click();
  await expect(page).toHaveURL(/#\/four\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 });
  const created = page.url().split('/').pop() as Address;
  const createTx = (
    await chain.getLogs({ address: local.openfour.core, fromBlock: (await chain.getBlockNumber()) - 5n })
  ).find((l) => l.topics[3]?.toLowerCase().endsWith(created.slice(2).toLowerCase()));
  if (createTx) expect((await chain.getTransaction({ hash: createTx.transactionHash })).gas).toBe(12_000_000n);
  await expect(page.getByTestId('four-token')).toHaveAttribute('data-kind', 'tax', { timeout: 30_000 });
  await expect(page.getByTestId('no-pile')).toContainText('No pile yet.');
  // Someone else creates the pile at the moment the page checks the account before sending: the step reads the
  // vault when it goes to the wallet, finds a pile, and sends nothing (it never claims to have created one).
  const founder = (await chain.readContract({ address: created, abi: [{ type: 'function', name: 'founder', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'founder' })) as Address;
  const clone = (await chain.readContract({ address: founder, abi: [{ type: 'function', name: 'clonedVault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'clonedVault' })) as Address;
  await page.exposeFunction('otherCreatesPile', async () => {
    const [, , , , other] = (await chain.request({ method: 'eth_accounts' as never })) as Address[];
    const hash = (await chain.request({ method: 'eth_sendTransaction' as never, params: [{ from: other, to: clone, data: `0x${encodeCreatePile()}` }] as never })) as `0x${string}`;
    await chain.waitForTransactionReceipt({ hash });
  });
  await page.evaluate(() =>
    (window as unknown as { __wallet: { onNext(m: string, f: () => Promise<void>): void } }).__wallet.onNext('eth_accounts', () =>
      (window as unknown as { otherCreatesPile(): Promise<void> }).otherCreatesPile(),
    ),
  );
  // The Close handler also runs before assertions: off while this dialog's last line is read.
  await page.removeLocatorHandler(page.getByTestId('press-close'));
  await page.getByTestId('create-pile').click();
  await expect(page.getByTestId('press-final')).toHaveText('Nothing was sent: the pile exists already.', { timeout: 60_000 });
  await page.getByTestId('press-close').click();
  await expect(page.getByTestId('pile-panel')).toHaveAttribute('data-writable', 'yes', { timeout: 30_000 });
  await shot(page, 'four-created-tax');
});
