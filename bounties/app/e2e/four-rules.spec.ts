import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, type Abi, type Address } from 'viem';
import { injectTestWallet } from './test-wallet';
import { formatBps, toDecimalString } from '../src/lib/amounts';

// SH-287 on the Four.meme rail: the creator's rules for a tax token. Needs the fork that FOUR_RULES=1
// scripts/four-fork.sh brings up (our RulesTaxVault template deployed and named; the signer stand-in offers the kind).
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const ACCOUNT = process.env.FOUR_ACCOUNT as Address;
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-281');
const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as {
  openfour: { core: Address; rulesTemplate: Address; quotes: Address[] };
};
const abi = (f: string) => JSON.parse(fs.readFileSync(path.join(here, `../../openfour/abi/${f}.json`), 'utf8')) as Abi;
const cloneAbi = abi('RulesTaxVault');
const splitterAbi = abi('RuleSplitter');
const pileAbi = abi('FeeRules');
const vaultAbi = abi('OpenFourVault');
const coreAbi = abi('OpenFourCore');
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;
const view = (name: string, out = 'address') => [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: out }] }] as const;
const chain = createPublicClient({ transport: http(RPC) });
const Q = '?addresses=local/addresses.json';
const read = <T,>(address: Address, a: Abi, functionName: string, args: unknown[] = []) => chain.readContract({ address, abi: a, functionName, args }) as Promise<T>;
const bal = (token: Address, who: Address) => chain.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] });

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

async function done(page: Page, box: string, label: string) {
  await expect(page.getByTestId(box).getByTestId('tx-status').filter({ hasText: `${label}: done` }).first()).toBeVisible({ timeout: 90_000 });
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

async function setRules(page: Page, creator: string, pile: string, burn: string) {
  await page.getByTestId('rules-creator').fill(creator);
  await page.getByTestId('rules-pile').fill(pile);
  await page.getByTestId('rules-burn').fill(burn);
}

/** The bodies the page sends to the signer, in order. */
function signerBodies(page: Page): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('api/four/sign-create')) out.push(JSON.parse(r.postData() ?? 'null') as Record<string, unknown>);
  });
  return out;
}

async function cloneOf(token: Address) {
  const founder = (await chain.readContract({ address: token, abi: view('founder'), functionName: 'founder' })) as Address;
  return (await chain.readContract({ address: founder, abi: view('clonedVault'), functionName: 'clonedVault' })) as Address;
}

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('Visual: a tax token with rules 20 / 50 / 30; Set up the rules; share-outs before and after the pool, the three effects on the page', async ({ page }) => {
  const bodies = signerBodies(page);
  await injectTestWallet(page, RPC, 0, ACCOUNT);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/four/create`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('way-visual')).toHaveAttribute('aria-current', 'true');
  // The curve-fee kind has no rules.
  await page.locator('[data-part="tax"] .sh-pic-hit').first().click();
  await expect(page.getByTestId('rules-fields')).toHaveCount(0);
  await page.getByTestId('part-close').click();
  await page.getByTestId('four-kind-tax').click();
  // The signer was asked once whether it offers the kind: a request with only the kind, nothing signed.
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  expect(bodies[0]).toEqual({ kind: 'tax-rules' });
  const part = (id: string) => page.locator(`[data-part="${id}"] .sh-pic-hit`).first();
  await part('token').click();
  await page.getByTestId('four-name').fill('Rules Tax');
  await page.getByTestId('four-symbol').fill('RTX');
  await part('raise').click();
  await page.getByTestId('four-raise').fill('0.3');
  await part('tax').click();
  await expect(page.getByTestId('rules-fields')).toBeVisible();
  await expect(page.getByTestId('rules-pile')).toHaveValue('100');
  await setRules(page, '20', '50', '31');
  await expect(page.getByTestId('rules-refusal')).toHaveText('The three parts add up to 100.');
  await page.getByTestId('part-close').click();
  await expect(page.locator('[data-warn="tax"]')).toBeVisible();
  await page.getByTestId('four-create-btn').click();
  await expect(page.locator('[data-part="tax"]')).toHaveAttribute('aria-expanded', 'true');
  await shot(page, 'four-rules-sum-wrong');
  await setRules(page, '20', '50', '30');
  await shot(page, 'four-rules-sheet');
  await page.getByTestId('part-close').click();
  const pic = page.getByTestId('launch-picture');
  await expect(pic.locator('[data-cell="creator"]')).toHaveCount(4);
  await expect(pic.locator('[data-cell="pile"]')).toHaveCount(10);
  await expect(pic.locator('[data-cell="buyburn"]')).toHaveCount(6);
  await expect(pic.locator('[data-creator-tag]')).toHaveText('20%');
  await expect(pic).toContainText('and burn 30%');
  await shot(page, 'four-rules-create');
  await page.getByTestId('four-create-btn').click();
  await expect(page).toHaveURL(/#\/four\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 });
  const token = page.url().split('/').pop() as Address;
  const signed = bodies.filter((b) => b.creator !== undefined);
  expect(signed).toHaveLength(1);
  expect(signed[0]).toMatchObject({ kind: 'tax-rules', creatorBps: 2000, pileBps: 5000, burnBps: 3000, taxBuyBps: 100, taxSellBps: 100 });

  // Ours: a clone of our rules template, the rules as the creator chose them, before createRules.
  const clone = await cloneOf(token);
  expect((await read<Address>(clone, cloneAbi, 'creator')).toLowerCase()).toBe(ACCOUNT.toLowerCase());
  expect([await read<number>(clone, cloneAbi, 'creatorBps'), await read<number>(clone, cloneAbi, 'pileBps'), await read<number>(clone, cloneAbi, 'burnBps')].map(Number)).toEqual([2000, 5000, 3000]);
  await expect(page.getByTestId('four-token')).toHaveAttribute('data-kind', 'tax-rules', { timeout: 30_000 });
  await expect(page.getByTestId('four-token')).toHaveAttribute('data-trusted', 'yes');
  const panel = page.getByTestId('rules-panel');
  await expect(panel.getByTestId('rule-0-bps')).toHaveText(formatBps(2000n));
  await expect(panel.getByTestId('rule-1-bps')).toHaveText(formatBps(5000n));
  await expect(panel.getByTestId('rule-2-bps')).toHaveText(formatBps(3000n));
  await expect(panel.getByTestId('share-out')).toHaveCount(0);
  await expect(panel.getByTestId('rule-0-name')).toHaveText('Creator');
  await panel.getByRole('button', { name: 'About the rules' }).click();
  await expect(panel.getByTestId('rules-buy-back')).toHaveText('Buys the token and sends it to the dead address. It waits until the token moves to PancakeSwap; if it never moves, it waits for good.');
  await expect(page.getByTestId('no-rules').locator('p.empty')).toHaveText('The rules are fixed; one press (anyone, once) sets them up.');
  await shot(page, 'four-rules-token-new');

  // Its own press: createRules makes the pile and the splitter.
  // The box gives way to the pile once the rules exist; the dialog's last line is read before its Close.
  await page.removeLocatorHandler(page.getByTestId('press-close'));
  await page.getByTestId('create-rules').click();
  await expect(page.getByTestId('press-final')).toHaveText('Set up the rules confirmed.', { timeout: 60_000 });
  await page.getByTestId('press-close').click();
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
  await expect(page.getByTestId('create-rules-box')).toHaveCount(0, { timeout: 30_000 });
  const splitter = await read<Address>(clone, cloneAbi, 'splitter');
  const pile = await read<Address>(clone, cloneAbi, 'pile');
  expect(splitter).not.toBe('0x0000000000000000000000000000000000000000');
  await expect(page.getByTestId('pile-size')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId('share-out')).toBeVisible({ timeout: 30_000 });

  // Curve buys pay the tax; settle moves it to the splitter; Share out before the pool: creator and pile paid, the
  // buy-back part owed.
  const quote = local.openfour.quotes[0]!;
  const sym = await chain.readContract({ address: quote, abi: erc20, functionName: 'symbol' });
  const label = (v: bigint) => `${toDecimalString(v, 18)} ${sym}`;
  await page.getByTestId('curve-amount').fill('0.1');
  await expect(page.getByTestId('curve-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'curve-trade', 'curve-trade-btn', 'Buy');
  await page.getByTestId('settle').click();
  await done(page, 'settle-box', 'Settle');
  const shareOut = async () => {
    const pending = await read<bigint>(splitter, splitterAbi, 'pending');
    const d = async () => Promise.all([0n, 1n, 2n].map((i) => read<bigint>(splitter, splitterAbi, 'delivered', [i])));
    const before = { d: await d(), me: await bal(quote, ACCOUNT), pile: await read<bigint>(pile, pileAbi, 'totalReceived'), dead: await bal(token, DEAD), burned: await read<bigint>(splitter, splitterAbi, 'burned', [2n]) };
    await expect(panel.getByTestId('share-out')).toBeEnabled({ timeout: 30_000 });
    await panel.getByTestId('share-out').click();
    await done(page, 'rules-panel', 'Share out');
    const after = { d: await d(), me: await bal(quote, ACCOUNT), pile: await read<bigint>(pile, pileAbi, 'totalReceived'), dead: await bal(token, DEAD), burned: await read<bigint>(splitter, splitterAbi, 'burned', [2n]) };
    const got = { creator: after.d[0]! - before.d[0]!, pile: after.d[1]! - before.d[1]!, buy: after.d[2]! - before.d[2]!, burned: after.burned - before.burned };
    console.log(`SHARE-OUT pending ${pending}: creator +${got.creator} (wallet +${after.me - before.me}), pile +${got.pile} (pile received +${after.pile - before.pile}), buy back +${got.buy} burned +${got.burned} (dead +${after.dead - before.dead}), owed ${await read<bigint>(splitter, splitterAbi, 'owed', [2n])}`);
    expect(after.me - before.me).toBe(got.creator);
    expect(after.pile - before.pile).toBe(got.pile);
    expect(after.dead - before.dead).toBe(got.burned);
    return { pending, got, after };
  };
  const first = await shareOut();
  expect(first.pending > 0n).toBe(true);
  expect(first.got.creator).toBe((first.pending * 2000n) / 10_000n);
  expect(first.got.pile).toBe((first.pending * 5000n) / 10_000n);
  expect(first.got.buy).toBe(0n);
  const owed = await read<bigint>(splitter, splitterAbi, 'owed', [2n]);
  expect(owed).toBe(first.pending - first.got.creator - first.got.pile);
  await expect(panel.getByTestId('rule-0-delivered').locator('.amount').first()).toHaveAttribute('title', label(first.after.d[0]!), { timeout: 30_000 });
  await expect(panel.getByTestId('rule-1-delivered').locator('.amount').first()).toHaveAttribute('title', label(first.after.d[1]!));
  await expect(panel.getByTestId('rule-2-owed').locator('.amount').first()).toHaveAttribute('title', label(owed));
  await shot(page, 'four-rules-owed');

  // Buy to the end of the sale: the token moves to PancakeSwap; a pool trade, settle, Share out: the buy back is
  // bought in one go and burned.
  const info = await read<readonly unknown[]>(local.openfour.core, coreAbi, 'tokens', [token]);
  const vault = info[10] as Address;
  for (let round = 0; round < 8; round++) {
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
    await expect.poll(() => read<bigint>(vault, vaultAbi, 'totalRaised'), { timeout: 60_000 }).not.toBe(raised);
    await page.waitForTimeout(1500);
  }
  await expect(page.getByTestId('four-phase')).toHaveText('On PancakeSwap', { timeout: 30_000 });
  await page.getByTestId('trade-sell-tab').click();
  await page.getByTestId('trade-amount').fill('1000000');
  await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'pool-trade', 'trade', 'Sell');
  await page.getByTestId('settle').click();
  await done(page, 'settle-box', 'Settle');
  const second = await shareOut();
  expect(second.got.burned > 0n).toBe(true);
  expect(await read<bigint>(splitter, splitterAbi, 'owed', [2n])).toBe(0n);
  await expect(panel.getByTestId('rule-2-burned').locator('.amount').first()).toHaveAttribute('title', new RegExp(`^${toDecimalString(second.after.burned, 18).replace('.', '\\.')} `), { timeout: 30_000 });
  await expect(panel.getByTestId('rule-2-delivered').locator('.amount').first()).toHaveAttribute('title', label(second.after.d[2]!));
  await expect(panel.getByTestId('rule-2-owed')).toHaveCount(0);
  await shot(page, 'four-rules-burned');
});

test('Steps: creator 40 and buy back 60 (no pile part); the request and the clone carry them', async ({ page }) => {
  const bodies = signerBodies(page);
  await injectTestWallet(page, RPC, 0, ACCOUNT);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/four/create`);
  await page.getByTestId('connect').click();
  await page.getByTestId('way-steps').click();
  await page.getByTestId('four-kind-tax').click();
  await page.getByTestId('four-name').fill('Rules Steps');
  await page.getByTestId('four-symbol').fill('RST');
  await page.getByTestId('four-raise').fill('0.3');
  await expect(page.getByTestId('rules-fields')).toBeVisible({ timeout: 30_000 });
  await setRules(page, '40', '0', '61');
  await expect(page.getByTestId('four-create-btn')).toBeDisabled();
  await setRules(page, '40', '0', '60');
  await shot(page, 'four-rules-steps');
  await page.getByTestId('four-create-btn').click();
  await expect(page).toHaveURL(/#\/four\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 });
  const token = page.url().split('/').pop() as Address;
  expect(bodies.filter((b) => b.creator !== undefined)[0]).toMatchObject({ kind: 'tax-rules', creatorBps: 4000, pileBps: 0, burnBps: 6000 });
  const clone = await cloneOf(token);
  expect([await read<number>(clone, cloneAbi, 'creatorBps'), await read<number>(clone, cloneAbi, 'pileBps'), await read<number>(clone, cloneAbi, 'burnBps')].map(Number)).toEqual([4000, 0, 6000]);
  const panel = page.getByTestId('rules-panel');
  await expect(panel.getByTestId('rule-0-bps')).toHaveText(formatBps(4000n), { timeout: 30_000 });
  await expect(panel.getByTestId('rule-1-bps')).toHaveText(formatBps(6000n));
  await expect(panel.getByTestId('rule-1')).toContainText('Buy back and burn');
  await expect(panel.getByTestId('rule-2')).toHaveCount(0);
  await shot(page, 'four-rules-steps-token');
  // A pile part of 0: after Set up the rules there is a splitter and no pile; the page keys on the splitter, so the
  // set-up box goes, no pile panel comes, and the share-out and the tax box are there.
  await page.removeLocatorHandler(page.getByTestId('press-close'));
  await page.getByTestId('create-rules').click();
  await expect(page.getByTestId('press-final')).toHaveText('Set up the rules confirmed.', { timeout: 60_000 });
  await page.getByTestId('press-close').click();
  await expect(page.getByTestId('no-rules')).toHaveCount(0, { timeout: 30_000 });
  expect(await read<Address>(clone, cloneAbi, 'pile')).toBe('0x0000000000000000000000000000000000000000');
  await expect(page.getByTestId('pile-panel')).toHaveCount(0);
  await expect(panel.getByTestId('share-out')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('settle-box')).toBeVisible();
  await shot(page, 'four-rules-no-pile');
});
