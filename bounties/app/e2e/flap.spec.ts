import { expect, test, type Page, type Request } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, http, parseAbiItem, toFunctionSelector, type Abi, type Address } from 'viem';
import { injectTestWallet } from './test-wallet';
import { toDecimalString } from '../src/lib/amounts';

// Needs the fork that scripts/flap-fork.sh brings up (it writes public/local/addresses.json).
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-265');
const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as {
  flap: { sales: { launcher: Address }[]; curveLauncherFactory: Address };
};
const launcherAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/CurveLauncher.json'), 'utf8')) as Abi;
const factoryAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/CurveLauncherFactory.json'), 'utf8')) as Abi;
const portalAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/FlapPortal.json'), 'utf8')) as Abi;
const pileAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/PileVault.json'), 'utf8')) as Abi;
const chain = createPublicClient({ transport: http(RPC) });
const Q = '?addresses=local/addresses.json';
const read = <T,>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  chain.readContract({ address, abi, functionName, args }) as Promise<T>;
const exact = (v: bigint) => `${toDecimalString(v, 18)} BNB`;

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

// FLAP_REAL=1: a fork of the real chain with the REAL factories (scripts/flap-real-fork.sh): no scripted short sale,
// screenshots named real-fork-*, and the gas of every write printed ("GAS <box> <gas used>").
const REAL = process.env.FLAP_REAL === '1';
const PREFIX = REAL ? 'real-fork-' : '';

/** Waits for "<label>: done" in the box's status and returns its transaction (printing its gas). */
async function done(page: Page, box: string, label: string) {
  const status = page.getByTestId(box).getByTestId('tx-status').filter({ hasText: `${label}: done` }).first();
  await expect(status).toBeVisible({ timeout: 60_000 });
  const href = await status.locator('a').first().getAttribute('href');
  const hash = href?.split('/tx/')[1] as `0x${string}`;
  const r = await chain.getTransactionReceipt({ hash });
  console.log(`GAS ${box} ${label} ${r.gasUsed}`);
  return chain.getTransaction({ hash });
}

/** These tests' sales are paid in BNB: where the deployment also has the test token (the default), choose BNB. */
/** This spec's launches go through the Steps way (the Visual way is flap-usdt.spec.ts's): one press away. */
async function chooseBnb(page: Page) {
  await page.getByTestId('way-steps').click();
  await expect(page.getByTestId('way-steps')).toHaveAttribute('aria-current', 'true');
  const hasChoice = await page.getByTestId('quote-choice').waitFor({ timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  if (!hasChoice) return;
  await page.getByTestId('quote-native').click();
  await expect(page.getByTestId('quote-native')).toHaveAttribute('aria-selected', 'true');
}

// Each press ends in its dialog with Close: it is pressed before the test's next action.
test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('create through the Portal, buy, sell back, launch, claim, trade, send the tax, redeem', async ({ page }) => {
  await injectTestWallet(page, RPC, 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/`);
  // On the live chain's fork the row's first reads go through to the public endpoint (measured 7 to 32 s for the
  // name): the row's name is waited for within the test's own time.
  await expect(page.getByTestId('sale-line').first()).toContainText(REAL ? '·' : 'Missed Curve', { timeout: REAL ? 80_000 : 30_000 });
  await shot(page, PREFIX + 'flap-home');
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  // This test's sale is paid in BNB: where the deployment also has the test token (the default), choose BNB.
  await chooseBnb(page);
  await expect(page.getByTestId('create-raise')).toBeVisible({ timeout: 30_000 });
  // A target below the Portal's floor is refused in the form, with the numbers.
  await page.getByTestId('create-target').fill('0.5');
  await expect(page.getByTestId('create-floor')).toContainText('$');
  await expect(page.getByTestId('create')).toBeDisabled();
  await page.getByTestId('create-target').fill('2.35');
  await expect(page.getByTestId('create-floor')).toHaveCount(0);
  // (the factory's check needs the preview salt, mined again when "Paid in" changed)
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 60_000 });
  await shot(page, PREFIX + 'flap-create');
  await page.getByTestId('create').click();
  // Finding 8: from the press until the wallet answered, the settings cannot be edited.
  await expect(page.getByTestId('create-name')).toBeDisabled();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 });
  const launcher = page.url().split('/').pop() as Address;
  {
    const latest = await chain.getBlockNumber();
    const logs = await chain.getLogs({
      address: local.flap.curveLauncherFactory,
      event: parseAbiItem('event CurveLauncherCreated(address indexed launcher, address indexed creator, bytes32 salt, bool viaPortal)'),
      args: { launcher },
      fromBlock: latest - 20n,
    });
    const r = await chain.getTransactionReceipt({ hash: logs[0]!.transactionHash });
    console.log(`GAS create ${r.gasUsed} viaPortal ${logs[0]!.args.viaPortal}`);
    // The value sent is the Portal's salt lock read at the press.
    const fee = await read<bigint>(local.flap.curveLauncherFactory, factoryAbi, 'creationFee');
    expect((await chain.getTransaction({ hash: logs[0]!.transactionHash })).value).toBe(fee);
  }
  await expect(page.getByTestId('sale-phase')).toHaveText('Selling');

  // Buy 0.5 on the curve. Finding 4: someone else buys between the preview and the press, so the quote moved: the
  // page asks again and sends nothing; the second press sends, with the new minimum.
  await page.getByTestId('buy-amount').fill('0.5');
  await expect(page.getByTestId('buy-review')).toBeVisible();
  // The state this step needs: the screen still shows the quote from before the front-run when Buy is pressed. The
  // page re-reads every 30 s; the front-run is sent right after one of its re-reads of this quote, and the press made
  // only while the screen still shows the earlier numbers (a re-read that landed in between starts the round again).
  const others = (await chain.request({ method: 'eth_accounts' as never })) as Address[];
  const QUOTE_BUY = toFunctionSelector('quoteBuy(uint256)');
  const review = page.getByTestId('buy-review').locator('.amount').first();
  const isQuoteRead = (r: Request) => {
    if (!r.url().startsWith(RPC) || r.method() !== 'POST') return false;
    const items = [JSON.parse(r.postData() ?? 'null')].flat() as { method?: string; params?: { to?: string; data?: string }[] }[];
    return items.some((i) => i?.method === 'eth_call' && i.params?.[0]?.to?.toLowerCase() === launcher.toLowerCase() && i.params?.[0]?.data?.startsWith(QUOTE_BUY));
  };
  let stale = false;
  for (let round = 0; round < 4 && !stale; round++) {
    await page.waitForResponse((r) => isQuoteRead(r.request()), { timeout: 60_000 });
    const before = (await read<readonly bigint[]>(launcher, launcherAbi, 'quoteBuy', [5n * 10n ** 17n]))[0]!;
    await expect(review).toHaveAttribute('title', new RegExp(`^${toDecimalString(before, 18).replace('.', '\\.')} `));
    const front = (await chain.request({
      method: 'eth_sendTransaction' as never,
      params: [{ from: others[5], to: launcher, data: encodeFunctionData({ abi: launcherAbi, functionName: 'buy', args: [0n] }), value: '0x' + (3n * 10n ** 17n).toString(16) }] as never,
    })) as `0x${string}`;
    await chain.waitForTransactionReceipt({ hash: front });
    stale = (await review.getAttribute('title'))?.startsWith(`${toDecimalString(before, 18)} `) === true;
    console.log(`front-run round ${round + 1}: the screen ${stale ? 'still shows the earlier quote' : 'was re-read meanwhile'}`);
  }
  expect(stale).toBe(true);
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('buy-box').getByTestId('tx-status')).toContainText('Nothing was sent: the quote moved. Check the new numbers and press again.');
  await page.waitForTimeout(1500);
  await page.getByTestId('buy').click();
  await done(page, 'buy-box', 'Buy');
  const p1 = await read<{ curveBalance: bigint }>(launcher, launcherAbi, 'progress');
  await expect(page.getByTestId('sale-raised').locator('.amount').first()).toHaveAttribute('title', exact(p1.curveBalance));

  // Sell back 1,000,000 tokens.
  const account = (await chain.request({ method: 'eth_accounts' as never }) as Address[])[1]!;
  const before = await read<bigint>(launcher, launcherAbi, 'tokensOf', [account]);
  await page.getByTestId('sell-amount').fill('1000000');
  await expect(page.getByTestId('sell-review')).toBeVisible();
  await page.getByTestId('sell').click();
  await done(page, 'sell-box', 'Sell');
  expect(await read<bigint>(launcher, launcherAbi, 'tokensOf', [account])).toBe(before - 10n ** 24n);
  await shot(page, PREFIX + 'flap-sale-selling');

  // Launch (finding 5): the launcher's own complete(), which launches or reverts, never a plain buy.
  const costBefore = await read<bigint>(launcher, launcherAbi, 'costToComplete');
  await page.getByTestId('launch').click();
  const launchTx = await done(page, 'launch-status', 'Launch');
  expect(launchTx.input.slice(0, 10)).toBe(toFunctionSelector('complete()'));
  // Re-read finding 3: exactly the cost read at the press, nothing more.
  expect(launchTx.value).toBe(costBefore);
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 30_000 });

  // Claim.
  await page.getByTestId('claim').click();
  await done(page, 'claim-box', 'Claim');
  const [token, , pileVault] = await read<readonly [Address, Address, Address]>(launcher, launcherAbi, 'launchInfo');
  expect(token.toLowerCase().endsWith('7777')).toBe(true);

  // Trade on the pool, then send the tax: the pile grows and the page shows by how much.
  // The token keeps its tax in tokens and turns it into BNB during sells: buy, then sell, until tax is waiting.
  const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const;
  for (let round = 0; round < 6; round++) {
    await page.getByTestId('trade-buy-tab').click();
    await page.getByTestId('trade-amount').fill('0.3');
    await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('trade').click();
    await done(page, 'pool-trade', 'Buy');
    if (round === 0) await shot(page, PREFIX + 'flap-traded');
    const bal = await chain.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [account] });
    await page.getByTestId('trade-sell-tab').click();
    await page.getByTestId('trade-amount').fill(toDecimalString(bal / 3n, 18));
    await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
    if (await page.getByTestId('trade').textContent().then((t) => t?.startsWith('Approve'))) {
      await page.getByTestId('trade').click();
      await done(page, 'pool-trade', 'Approve');
      await expect(page.getByTestId('trade')).toHaveText('Sell', { timeout: 30_000 });
    }
    await page.getByTestId('trade').click();
    await done(page, 'pool-trade', 'Sell');
    if (await page.getByTestId('dispatch').isEnabled({ timeout: 10_000 }).catch(() => false)) break;
  }
  await expect(page.getByTestId('dispatch')).toBeEnabled({ timeout: 30_000 });
  const pileBefore = await read<bigint>(pileVault, pileAbi, 'pile');
  await page.getByTestId('dispatch').click();
  await done(page, 'dispatch-box', 'Send to the pile');
  const pileAfter = await read<bigint>(pileVault, pileAbi, 'pile');
  expect(pileAfter > pileBefore).toBe(true);
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', exact(pileAfter), { timeout: 30_000 });
  await expect(page.getByTestId('pile-delta')).toContainText('+');

  // Redeem 1,000,000 tokens: paid exactly the contract's quote.
  const quote = await read<bigint>(pileVault, pileAbi, 'quoteRedeem', [10n ** 24n]);
  await page.getByTestId('redeem-amount').fill('1000000');
  await expect(page.getByTestId('redeem-review').locator('.amount').first()).toHaveAttribute('title', exact(quote));
  await page.getByTestId('redeem').click();
  await done(page, 'redeem-box', 'Redeem');
  const paid = await read<bigint>(pileVault, pileAbi, 'totalPaidOut');
  expect(paid >= quote).toBe(true);
  await expect(page.getByTestId('paid-out').locator('.amount')).toHaveAttribute('title', exact(paid), { timeout: 30_000 });
  await shot(page, PREFIX + 'flap-launched');
});

test('missed deadline: take your money back, exactly what was put in', async ({ page }) => {
  test.skip(REAL, 'the real chain has no scripted short sale');
  const miss = local.flap.sales[0]!.launcher;
  await injectTestWallet(page, RPC, 2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/${miss}`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('sale-phase')).toHaveText('Selling');
  await page.getByTestId('buy-amount').fill('0.1');
  await expect(page.getByTestId('buy-review')).toBeVisible();
  await page.getByTestId('buy').click();
  await done(page, 'buy-box', 'Buy');
  await chain.request({ method: 'evm_increaseTime' as never, params: [400] as never });
  await chain.request({ method: 'evm_mine' as never });
  await page.reload();
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('sale-phase')).toHaveText('Missed', { timeout: 30_000 });
  // Finding 7: the payout the launcher would pay now (its own unwind, simulated), named an estimate; then what the
  // receipt says it paid, and the wallet's balance up by exactly that, less gas.
  await expect(page.getByTestId('owed')).toContainText('Estimate');
  await expect(page.getByTestId('owed').locator('.amount')).toHaveAttribute('title', '0.1 BNB');
  await shot(page, PREFIX + 'flap-missed');
  const who = ((await chain.request({ method: 'eth_accounts' as never })) as Address[])[2]!;
  const b0 = await chain.getBalance({ address: who });
  await page.getByTestId('unwind').click();
  const unwindTx = await done(page, 'unwind-box', 'Take back');
  await expect(page.getByTestId('tx-note')).toHaveText('Paid 0.1 BNB.');
  const r = await chain.getTransactionReceipt({ hash: unwindTx.hash });
  expect((await chain.getBalance({ address: who })) - b0).toBe(10n ** 17n - r.gasUsed * r.effectiveGasPrice);
  await expect(page.getByTestId('owed-none')).toBeVisible({ timeout: 30_000 });
});

test('a 0.05 BNB sale, once Flap sets our factory floor multiplier to 0 (stood in for on the fork)', async ({ page }) => {
  // Stand in for Flap, as the entry's rehearsal does: the Portal's admin sets this factory's multiplier to 0.
  const portal = '0x000042108465206185A077Edc3F3fd2b49060000' as Address;
  const factory = local.flap.curveLauncherFactory;
  const ownerAbi = [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }] as const;
  const admin = await chain.readContract({ address: '0x0000Ed588dfc01749C20bA69b5f8c77d706E0000', abi: ownerAbi, functionName: 'owner' });
  const data = encodeFunctionData({ abi: portalAbi, functionName: 'setLauncherFactoryMultiplier', args: [factory, 0, true] });
  const hash = (await chain.request({ method: 'eth_sendTransaction' as never, params: [{ from: admin, to: portal, data }] as never })) as `0x${string}`;
  expect((await chain.waitForTransactionReceipt({ hash })).status).toBe('success');

  await injectTestWallet(page, RPC, 3);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await chooseBnb(page);
  await page.getByTestId('create-name').fill('Small Curve');
  await page.getByTestId('create-symbol').fill('SMALL');
  await page.getByTestId('create-target').fill('0.05');
  await expect(page.getByTestId('create-raise')).toContainText('0.05', { timeout: 30_000 });
  await expect(page.getByTestId('create-floor')).toHaveCount(0);
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 });
  await page.getByTestId('buy-amount').fill('0.02');
  await expect(page.getByTestId('buy-review')).toBeVisible();
  await page.getByTestId('buy').click();
  await done(page, 'buy-box', 'Buy');
  await shot(page, PREFIX + 'flap-small-selling');
  await page.getByTestId('launch').click();
  await done(page, 'launch-status', 'Launch');
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 30_000 });
  await page.getByTestId('claim').click();
  await done(page, 'claim-box', 'Claim');
  await expect(page.getByTestId('pile-panel')).toBeVisible();
  await shot(page, PREFIX + 'flap-small-launched');
});
