import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits, type Address } from 'viem';
import { injectTestWallet } from './test-wallet';
import { toDecimalString } from '../src/lib/amounts';

/**
 * SH-290: holder payouts on a Flap rules launch, on lane f's stand (scripts/holders-fork.sh runs
 * bounties/flap/script/stake-stand.sh: a fork of BSC Testnet as it is, the creator's stake paid 40% by the sale's rules, in
 * the sale's test dollar, already staked by the creator and streaming). The test wallet takes some of the token from the
 * creator (a local transfer), stakes (exact approval, then stake), income arrives (the open test dollar's mint, as the
 * rules' share-out pays), the page's Count counts it, time passes on the fork, the page's Claim pays, Unstake returns the
 * token. Every step read back on the page and on the chain. Screenshots at 1440 and 390 go to the test's output.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8622';
const Q = '?addresses=local/addresses.json';
const stand = JSON.parse(fs.readFileSync(path.join(here, '../public/local/holders.json'), 'utf8')) as { launcher: Address; token: Address; stake: Address; creator: Address; quote: Address };
const chain = createPublicClient({ transport: http(RPC) });
const ERC20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function mint(address to, uint256 amount)',
]);
const STAKE = parseAbi([
  'function stakedOf(address) view returns (uint256)', 'function totalStaked() view returns (uint256)', 'function claimable(address) view returns (uint256)',
  'function unsynced() view returns (uint256)', 'function undistributed() view returns (uint256)', 'function claimed() view returns (uint256)',
  'function asset() view returns (address)',
]);

async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
async function send(from: Address, to: Address, data: `0x${string}`) {
  const hash = (await rpc('eth_sendTransaction', [{ from, to, data }])) as `0x${string}`;
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
}
const read = <T,>(address: Address, functionName: string, args: unknown[] = []) => chain.readContract({ address, abi: [...STAKE, ...ERC20], functionName, args } as never) as Promise<T>;
const title = (page: Page, testId: string) => page.getByTestId(testId).locator('.amount').first().getAttribute('title');
const shownOf = async (page: Page, testId: string, decimals: number) => parseUnits(((await title(page, testId)) ?? '0').split(' ')[0]!, decimals);

async function shot(page: Page, testInfo: { outputPath(name: string): string }, name: string) {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    await page.getByTestId('holders-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`${name}-${w}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
  await page.route('**/alpha/me', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
});

test('stake, income, the count, time passing, claim, unstake: each read back on the page', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const accounts = (await rpc('eth_accounts')) as Address[];
  const me = accounts[0]!;
  const asset = await read<Address>(stand.stake, 'asset');
  const [onChainSym, aDec, tSym] = await Promise.all([read<string>(asset, 'symbol'), read<number>(asset, 'decimals'), read<string>(stand.token, 'symbol')]);
  // The sale's coin as the page names it everywhere: the deployment's label where it has one ("USDT (test)").
  const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as { flap?: { tokenQuote?: { quote: string; label: string } } };
  const tq = local.flap?.tokenQuote;
  const aSym = tq && tq.quote.toLowerCase() === asset.toLowerCase() ? tq.label : onChainSym;
  expect(aSym).toBe('USDT (test)');
  // The holder's tokens: 1,000 from the sale's creator (a local transfer on the fork).
  await send(stand.creator, stand.token, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [me, 1_000n * 10n ** 18n] }));
  const held = await read<bigint>(stand.token, 'balanceOf', [me]);
  expect(held).toBeGreaterThan(0n);

  await injectTestWallet(page, RPC, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/${stand.launcher}`);
  await page.getByTestId('connect').first().click();
  const panel = page.getByTestId('holders-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel).toHaveAttribute('data-stake', stand.stake);
  await shot(page, testInfo, 'holders-before');

  // Stake 400: the exact approval, then the stake; the credit is what arrived (a taxed transfer delivers less).
  await page.getByTestId('holders-stake-amount').fill('400');
  await page.getByTestId('holders-stake').click();
  await expect.poll(() => read<bigint>(stand.stake, 'stakedOf', [me]), { timeout: 60_000 }).toBeGreaterThan(0n);
  const staked = await read<bigint>(stand.stake, 'stakedOf', [me]);
  expect(staked).toBeLessThanOrEqual(400n * 10n ** 18n);
  await expect.poll(() => title(page, 'holders-mine'), { timeout: 30_000 }).toBe(`${toDecimalString(staked, 18)} ${tSym}`);
  // 400 of the creator's 300,000,000 earns: the share never reads 0%.
  await expect(page.getByTestId('holders-share')).toHaveText('<0.01%');
  await expect.poll(async () => title(page, 'holders-total'), { timeout: 30_000 }).toBe(`${toDecimalString(await read<bigint>(stand.stake, 'totalStaked'), 18)} ${tSym}`);

  // Income arrives (the open test dollar's mint, as the rules' share-out pays it): not counted yet, with the Count press.
  const income = 300n * 10n ** BigInt(aDec);
  await send(accounts[5]!, asset, encodeFunctionData({ abi: ERC20, functionName: 'mint', args: [stand.stake, income] }));
  await expect.poll(async () => title(page, 'holders-unsynced'), { timeout: 30_000 }).toBe(`${toDecimalString(await read<bigint>(stand.stake, 'unsynced'), aDec)} ${aSym}`);
  expect(await read<bigint>(stand.stake, 'unsynced')).toBeGreaterThanOrEqual(income);
  await shot(page, testInfo, 'holders-arrived');
  await expect(page.getByTestId('holders-count')).toHaveText('Count');
  await page.getByTestId('holders-count').click();
  await expect.poll(() => read<bigint>(stand.stake, 'unsynced'), { timeout: 60_000 }).toBe(0n);
  // What is still to be paid out: on the page as the chain says, with the end the contract reports.
  await expect.poll(async () => (await shownOf(page, 'holders-paying', aDec)) >= (await read<bigint>(stand.stake, 'undistributed')), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId('holders-until')).toBeVisible();
  await expect(page.getByTestId('holders-rate')).toContainText('a day, until the end shown');
  await expect(page.getByTestId('holders-leftover')).toHaveCount(0);

  // An hour passes on the fork: the visitor's share accrued, read on the page between two chain reads.
  await rpc('evm_increaseTime', [3_600]);
  await rpc('evm_mine', []);
  const owed = await read<bigint>(stand.stake, 'claimable', [me]);
  expect(owed).toBeGreaterThan(0n);
  await expect.poll(async () => {
    const shown = await shownOf(page, 'holders-claimable', aDec);
    return shown >= owed && shown <= (await read<bigint>(stand.stake, 'claimable', [me]));
  }, { timeout: 30_000 }).toBe(true);
  await shot(page, testInfo, 'holders-streaming');
  const before = await read<bigint>(asset, 'balanceOf', [me]);
  const claimedBefore = await read<bigint>(stand.stake, 'claimed');
  await page.getByTestId('holders-claim').click();
  await expect.poll(() => read<bigint>(asset, 'balanceOf', [me]), { timeout: 60_000 }).toBeGreaterThanOrEqual(before + owed);
  const paid = (await read<bigint>(asset, 'balanceOf', [me])) - before;
  expect((await read<bigint>(stand.stake, 'claimed')) - claimedBefore).toBe(paid);
  await expect.poll(async () => title(page, 'holders-claimed'), { timeout: 30_000 }).toBe(`${toDecimalString(await read<bigint>(stand.stake, 'claimed'), aDec)} ${aSym}`);

  // Unstake all: only the token comes back.
  const assetBefore = await read<bigint>(asset, 'balanceOf', [me]);
  const tokenBefore = await read<bigint>(stand.token, 'balanceOf', [me]);
  await page.getByTestId('holders-unstake-amount').fill(toDecimalString(staked, 18));
  await page.getByTestId('holders-unstake').click();
  await expect.poll(() => read<bigint>(stand.stake, 'stakedOf', [me]), { timeout: 60_000 }).toBe(0n);
  const back = (await read<bigint>(stand.token, 'balanceOf', [me])) - tokenBefore;
  expect(back).toBeGreaterThan(0n);
  expect(back).toBeLessThanOrEqual(staked);
  expect(await read<bigint>(asset, 'balanceOf', [me])).toBe(assetBefore);
  await expect.poll(() => title(page, 'holders-mine'), { timeout: 30_000 }).toBe(`${toDecimalString(0n, 18)} ${tSym}`);
  await shot(page, testInfo, 'holders-after');
  console.log(`HOLDERS staked ${staked} income ${income} owed-after-hour ${owed} paid ${paid} unstaked-back ${back}`);
});
