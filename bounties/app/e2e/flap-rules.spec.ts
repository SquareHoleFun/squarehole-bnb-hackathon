import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeFunctionData, http, toFunctionSelector, type Abi, type Address, type Hex } from 'viem';
import { injectTestWallet } from './test-wallet';
import { formatBps, toDecimalString } from '../src/lib/amounts';

// SH-287 on the Flap rail: the creator's rules. Needs the fork that scripts/flap-rules-fork.sh brings up (the real
// chain; the token-quote pair and both rules pairs deployed in it, and named in public/local/addresses.json).
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8582';
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-281');
type Pair = { launcherFactory: Address; rulesVaultFactory: Address };
const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as {
  flap: { tokenQuote: { quote: Address }; rules: { token: Pair; native: Pair } };
};
const USD = local.flap.tokenQuote.quote;
const RULES = local.flap.rules;
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;
const abi = (f: string) => JSON.parse(fs.readFileSync(path.join(here, `../../flap/abi/${f}.json`), 'utf8')) as Abi;
const launcherAbi = abi('TokenCurveLauncher');
const rvfAbi = abi('RulesVaultFactory');
const splitterAbi = abi('RulesVault');
const pileAbi = abi('PileVault');
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;
const chain = createPublicClient({ transport: http(RPC) });
const Q = '?addresses=local/addresses.json';
const read = <T,>(address: Address, a: Abi, functionName: string, args: unknown[] = []) => chain.readContract({ address, abi: a, functionName, args }) as Promise<T>;
const bal = (token: Address, who: Address) => chain.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] });
const label = (v: bigint) => `${toDecimalString(v, 18)} USDT (test)`;
const SET_RULES = toFunctionSelector('setRules(address,bytes32,(uint8,uint16,address)[])');
type W = { __wallet: { onNext(m: string, f: () => Promise<void> | void): void } };
type Rule = { kind: number; bps: number; target: Address };

test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function done(page: Page, box: string, labelText: string) {
  await expect(page.getByTestId(box).getByTestId('tx-status').filter({ hasText: `${labelText}: done` }).first()).toBeVisible({ timeout: 90_000 });
}

/** The transactions `who` sent in blocks after `since`: [selector, the call's data]. */
async function sentSince(who: Address, since: bigint): Promise<{ to: Address | null; input: Hex }[]> {
  const out: { to: Address | null; input: Hex }[] = [];
  const to = await chain.getBlockNumber({ cacheTime: 0 });
  for (let n = since + 1n; n <= to; n++) {
    for (const t of (await chain.getBlock({ blockNumber: n, includeTransactions: true })).transactions) {
      if (t.from.toLowerCase() === who.toLowerCase()) out.push({ to: t.to, input: t.input });
    }
  }
  return out;
}

async function setRules(page: Page, creator: string, pile: string, burn: string) {
  await page.getByTestId('rules-creator').fill(creator);
  await page.getByTestId('rules-pile').fill(pile);
  await page.getByTestId('rules-burn').fill(burn);
}

const plain = (rs: readonly Rule[]) => rs.map((r) => ({ kind: Number(r.kind), bps: Number(r.bps), target: r.target.toLowerCase() }));

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('Visual: rules 20 / 50 / 30 in the Tax sheet, two presses, the launch, a share-out and its three effects on the page', async ({ page }) => {
  const me = ((await chain.request({ method: 'eth_accounts' as never })) as Address[])[2]!;
  await injectTestWallet(page, RPC, 2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('way-visual')).toHaveAttribute('aria-current', 'true');

  // The Tax sheet holds the three parts; Pile 100 by default.
  await page.locator('[data-part="tax"] .sh-pic-hit').first().click();
  await expect(page.getByTestId('rules-fields')).toBeVisible();
  await expect(page.getByTestId('rules-pile')).toHaveValue('100');
  await expect(page.getByTestId('rules-creator')).toHaveValue('0');
  await expect(page.getByTestId('rules-burn')).toHaveValue('0');
  // A sum of 90 marks Tax, and Create opens it.
  await setRules(page, '20', '70', '0');
  await expect(page.getByTestId('rules-refusal')).toHaveText('The three parts add up to 100.');
  await page.getByTestId('part-close').click();
  await expect(page.locator('[data-warn="tax"]')).toBeVisible();
  await expect(page.getByTestId('create-review')).toHaveCount(0);
  await page.getByTestId('create').click();
  await expect(page.locator('[data-part="tax"]')).toHaveAttribute('aria-expanded', 'true');
  await shot(page, 'rules-sum-wrong');
  await setRules(page, '20', '50', '30');
  await expect(page.getByTestId('rules-refusal')).toHaveCount(0);
  await shot(page, 'rules-sheet');
  await page.getByTestId('part-close').click();
  await expect(page.locator('[data-warn="tax"]')).toHaveCount(0);
  // The trays: 2 of 10 burned at once (the default 20%), the other 8 by the parts: creator 2, pile 4, buy back 2.
  const tray = page.getByTestId('launch-picture');
  await expect(tray.locator('[data-cell="burn"]')).toHaveCount(4);
  await expect(tray.locator('[data-cell="creator"]')).toHaveCount(4);
  await expect(tray.locator('[data-cell="pile"]')).toHaveCount(8);
  await expect(tray.locator('[data-cell="buyburn"]')).toHaveCount(4);
  await expect(tray.locator('[data-creator-tag]')).toHaveText('20%of the rest');
  await expect(tray).toContainText('buy back 30%');
  await expect(tray).toContainText('50% of the rest');

  // The test dollar for the buys.
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('mint').click();
    await done(page, 'mint-box', 'Get');
  }
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'rules-create');

  // Two presses in one dialog, each named; the dialog's steps are read before its Close.
  await page.removeLocatorHandler(page.getByTestId('press-close'));
  const b0 = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('create').click();
  await expect(page.getByTestId('press-step')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId('press-step').nth(0)).toContainText('Set the rules');
  await expect(page.getByTestId('press-step').nth(1)).toContainText('Create');
  await expect(page.getByTestId('press-close')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('press-step').nth(1)).toHaveAttribute('data-state', 'confirmed');
  await page.getByTestId('press-close').click();
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 60_000 });
  const launcher = page.url().split('/').pop() as Address;
  const sent = await sentSince(me, b0);
  expect(sent.map((t) => t.input.slice(0, 10))).toEqual([SET_RULES, toFunctionSelector('newLauncher(address,bytes)')]);
  expect(sent[0]!.to!.toLowerCase()).toBe(RULES.token.rulesVaultFactory.toLowerCase());
  // The same factory in both: the rules call names it, and the Portal call creates through it.
  const setArgs = decodeFunctionData({ abi: rvfAbi, data: sent[0]!.input }).args as readonly [Address, Hex, readonly Rule[]];
  expect(setArgs[0].toLowerCase()).toBe(RULES.token.launcherFactory.toLowerCase());
  const stored = await read<readonly Rule[]>(RULES.token.rulesVaultFactory, rvfAbi, 'rulesOf', [launcher]);
  expect(plain(stored)).toEqual([
    { kind: 1, bps: 2000, target: me.toLowerCase() },
    { kind: 2, bps: 5000, target: '0x0000000000000000000000000000000000000000' },
    { kind: 3, bps: 3000, target: '0x0000000000000000000000000000000000000000' },
  ]);

  // Before the launch: the stored rules, read from rulesOf.
  await expect(page.getByTestId('flap-sale')).toHaveAttribute('data-trusted', 'yes', { timeout: 30_000 });
  const panel = page.getByTestId('rules-panel');
  await expect(panel.getByTestId('rule-0-bps')).toHaveText(formatBps(2000n));
  await expect(panel.getByTestId('rule-1-bps')).toHaveText(formatBps(5000n));
  await expect(panel.getByTestId('rule-2-bps')).toHaveText(formatBps(3000n));
  await expect(panel.getByTestId('share-out')).toHaveCount(0);
  // the words of step 4c: the payee named by who it is, what the parts share, the Flap buy back, when the parts are final
  await expect(panel.getByTestId('rule-0-name')).toHaveText('Creator');
  await panel.getByRole('button', { name: 'About the rules' }).click();
  await expect(panel.getByTestId('rules-of')).toHaveText("Of the curve fees at the launch, and of the tax left after Flap's share and the burned part. Nobody, not the creator either, can change the parts once the sale exists.");
  await expect(panel.getByTestId('rules-buy-back')).toHaveText('Buys the token on its pool at each share-out and sends it to the dead address.');
  await shot(page, 'rules-sale-selling');

  // Buy, launch, claim.
  await page.getByTestId('buy-amount').fill('300');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('buy').click();
  await done(page, 'buy-box', 'Buy');
  await page.getByTestId('launch').click();
  await done(page, 'launch-status', 'Launch');
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 30_000 });
  await page.getByTestId('claim').click();
  await done(page, 'claim-box', 'Claim');
  const [token, , vault] = await read<readonly [Address, Address, Address]>(launcher, launcherAbi, 'launchInfo');
  expect(vault.toLowerCase()).toBe((await read<Address>(RULES.token.rulesVaultFactory, rvfAbi, 'vaultOf', [token])).toLowerCase());
  const pile = await read<Address>(RULES.token.rulesVaultFactory, rvfAbi, 'pileOf', [token]);

  // Pool trades until tax waits; then send it to the rules.
  for (let round = 0; round < 6; round++) {
    await page.getByTestId('trade-buy-tab').click();
    await page.getByTestId('trade-amount').fill('100');
    await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
    for (const step of ['Approve', 'Buy']) {
      if (step === 'Approve' && !((await page.getByTestId('trade').textContent()) ?? '').startsWith('Approve')) continue;
      await page.getByTestId('trade').click();
      await done(page, 'pool-trade', step);
      if (step === 'Approve') await expect(page.getByTestId('trade')).toHaveText('Buy', { timeout: 30_000 });
    }
    const held = await bal(token, me);
    await page.getByTestId('trade-sell-tab').click();
    await page.getByTestId('trade-amount').fill(toDecimalString(held / 3n, 18));
    await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
    for (const step of ['Approve', 'Sell']) {
      if (step === 'Approve' && !((await page.getByTestId('trade').textContent()) ?? '').startsWith('Approve')) continue;
      await page.getByTestId('trade').click();
      await done(page, 'pool-trade', step);
      if (step === 'Approve') await expect(page.getByTestId('trade')).toHaveText('Sell', { timeout: 30_000 });
    }
    if (await page.getByTestId('dispatch').isEnabled({ timeout: 10_000 }).catch(() => false)) break;
  }
  await expect(page.getByTestId('dispatch')).toHaveText('Send to the rules');
  await page.getByTestId('dispatch').click();
  await done(page, 'dispatch-box', 'Send to the rules');
  const pending = await read<bigint>(vault, splitterAbi, 'pending');
  expect(pending > 0n).toBe(true);
  await expect(panel.getByTestId('rules-pending').locator('.amount').first()).toHaveAttribute('title', label(pending), { timeout: 30_000 });

  // Share out: each rule's effect, measured on the chain around the press and read on the page.
  const usd0 = await bal(USD, me);
  const pile0 = await read<bigint>(pile, pileAbi, 'pile');
  const dead0 = await bal(token, DEAD);
  await panel.getByTestId('share-out').click();
  await done(page, 'rules-panel', 'Share out');
  const [d0, d1, d2, burned2] = await Promise.all([
    read<bigint>(vault, splitterAbi, 'delivered', [0n]),
    read<bigint>(vault, splitterAbi, 'delivered', [1n]),
    read<bigint>(vault, splitterAbi, 'delivered', [2n]),
    read<bigint>(vault, splitterAbi, 'burned', [2n]),
  ]);
  const usdGain = (await bal(USD, me)) - usd0;
  const pileGain = (await read<bigint>(pile, pileAbi, 'pile')) - pile0;
  const deadGain = (await bal(token, DEAD)) - dead0;
  console.log(`SHARE-OUT pending ${pending}: creator delivered ${d0} (wallet +${usdGain}), pile delivered ${d1} (pile +${pileGain}), buy back delivered ${d2} burned ${burned2} (dead +${deadGain})`);
  expect(d0 > 0n && d1 > 0n && d2 > 0n && burned2 > 0n).toBe(true);
  expect(d0 + d1 + d2).toBe(pending);
  expect(usdGain).toBe(d0);
  expect(pileGain).toBe(d1);
  expect(deadGain >= burned2).toBe(true);
  await expect(panel.getByTestId('rule-0-delivered').locator('.amount').first()).toHaveAttribute('title', label(d0), { timeout: 30_000 });
  await expect(panel.getByTestId('rule-1-delivered').locator('.amount').first()).toHaveAttribute('title', label(d1));
  await expect(panel.getByTestId('rule-2-delivered').locator('.amount').first()).toHaveAttribute('title', label(d2));
  await expect(panel.getByTestId('rule-2-burned').locator('.amount').first()).toHaveAttribute('title', new RegExp(`^${toDecimalString(burned2, 18).replace('.', '\\.')} `));
  await expect(panel.getByTestId('rules-pending').locator('.amount').first()).toHaveAttribute('title', label(0n));
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', label(pileGain + pile0), { timeout: 30_000 });
  await shot(page, 'rules-sale-launched');
});

test('Steps, paid in BNB: creator 40 and buy back 60 (no pile); the create refused after the rules landed reuses the salt', async ({ page }) => {
  const me = ((await chain.request({ method: 'eth_accounts' as never })) as Address[])[3]!;
  await injectTestWallet(page, RPC, 3);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await page.getByTestId('way-steps').click();
  await page.getByTestId('quote-native').click();
  await expect(page.getByTestId('create-raise')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('rules-fields')).toBeVisible();
  await setRules(page, '40', '0', '61');
  await expect(page.getByTestId('rules-refusal')).toHaveText('The three parts add up to 100.');
  await expect(page.getByTestId('create')).toBeDisabled();
  await setRules(page, '40', '0', '60');
  await expect(page.getByTestId('create')).toBeEnabled({ timeout: 60_000 });
  await shot(page, 'rules-steps');

  // The rules land; the create is rejected in the wallet.
  await page.removeLocatorHandler(page.getByTestId('press-close'));
  await page.evaluate(() => {
    const w = (window as unknown as W).__wallet;
    w.onNext('eth_sendTransaction', () =>
      w.onNext('eth_sendTransaction', () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      }),
    );
  });
  const b0 = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('create').click();
  await expect(page.getByTestId('press-final')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('press-step').nth(0)).toHaveAttribute('data-state', 'confirmed');
  await expect(page.getByTestId('press-step').nth(1)).toHaveAttribute('data-state', 'notSent');
  await page.getByTestId('press-close').click();

  // Again: the rules are stored for this salt, so only the create is left, with the same salt.
  await page.getByTestId('create').click();
  await expect(page.getByTestId('press-step')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('press-step').nth(0)).toContainText('Create');
  await expect(page.getByTestId('press-close')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('press-close').click();
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 60_000 });
  const launcher = page.url().split('/').pop() as Address;
  const sent = await sentSince(me, b0);
  expect(sent.map((t) => t.input.slice(0, 10))).toEqual([SET_RULES, toFunctionSelector('newLauncher(address,bytes)')]);
  const stored = await read<readonly Rule[]>(RULES.native.rulesVaultFactory, rvfAbi, 'rulesOf', [launcher]);
  expect(plain(stored)).toEqual([
    { kind: 1, bps: 4000, target: me.toLowerCase() },
    { kind: 3, bps: 6000, target: '0x0000000000000000000000000000000000000000' },
  ]);
  const panel = page.getByTestId('rules-panel');
  await expect(panel.getByTestId('rule-0-bps')).toHaveText(formatBps(4000n), { timeout: 30_000 });
  await expect(panel.getByTestId('rule-1-bps')).toHaveText(formatBps(6000n));
  await expect(panel.getByTestId('rule-2-bps')).toHaveCount(0);
  await shot(page, 'rules-steps-sale');
});

test('Pile 100: the create alone, through the rules pair, and the sale shows Pile 100%', async ({ page }) => {
  const me = ((await chain.request({ method: 'eth_accounts' as never })) as Address[])[4]!;
  await injectTestWallet(page, RPC, 4);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 60_000 });
  await page.removeLocatorHandler(page.getByTestId('press-close'));
  const b0 = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('create').click();
  await expect(page.getByTestId('press-close')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('press-step')).toHaveCount(1);
  await page.getByTestId('press-close').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 60_000 });
  const launcher = page.url().split('/').pop() as Address;
  const sent = await sentSince(me, b0);
  expect(sent.map((t) => t.input.slice(0, 10))).toEqual([toFunctionSelector('newLauncher(address,bytes)')]);
  expect(await read<boolean>(RULES.token.rulesVaultFactory, rvfAbi, 'rulesSet', [launcher])).toBe(false);
  // Shown only because the rules pair's launcher factory created this sale (its creation event).
  const panel = page.getByTestId('rules-panel');
  await expect(panel.getByTestId('rule-0')).toContainText('Pile', { timeout: 30_000 });
  await expect(panel.getByTestId('rule-0-bps')).toHaveText(formatBps(10_000n));
  await expect(panel.getByTestId('rule-1')).toHaveCount(0);
});
