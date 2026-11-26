import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { FORBIDDEN, PICTURE_THEN_CLOSING, boxHeader, brokenRuns, h2Order, installUntouchableWallet, noTradingControls, openBox, overflow, walletTouches } from './box-helpers';
import { decodeFunctionData, encodeErrorResult, encodeFunctionData, encodeFunctionResult, erc20Abi, parseAbi, toHex, type Hex } from 'viem';
import { coordinatorV2Abi, launchRouterV2Abi, receiverV2Abi, vaultV2Abi } from '../../../packages/chain/src/core/v2';
import { boxCollectionAbi } from '../../../packages/chain/src/abi/boxCollection';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { safeHistory } from '../src/features/core/v2/test-support/safe-history';

// The v2 box page on the Demo data (M1-53-b; F99, F100, F103, F104), at 1440×900 and 390×844: "Close box" only once a
// box can be closed; nothing touches a wallet on navigation, and the wallet window opens only when the button is
// pressed; one confirmation naming fail() or failClosed(); then "Closed" with the closing price and pool; every v2 box's
// token card says "Clone, not upgradeable" with its implementation; no "refund" anywhere; no trading control.
// SH_EVIDENCE_SCREENSHOTS=1 writes docs/evidence/screenshots/sh-v2-m1-53b/.

const token = (n: number) => `0xde027${'0'.repeat(31)}${n.toString(16).padStart(4, '0')}`;
const BOXES = { marbles: `/box/31337/${token(1)}`, keys: `/box/31337/${token(2)}`, hats: `/box/31337/${token(3)}`, boats: `/box/31337/${token(4)}` } as const;
const band = (page: Page) => boxHeader(page).locator('.sh-box-band__label');
const closeBox = (page: Page) => page.getByRole('button', { name: 'Close box', exact: true });

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const file =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/sh-v2-m1-53b/${name}-${testInfo.project.name}.png`, import.meta.url))
      : testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true, scale: 'css' });
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
});

test('"Close box" only on a box that can be closed', async ({ page }) => {
  for (const [path, shown] of [
    [BOXES.marbles, true],
    [BOXES.keys, true],
    [BOXES.boats, false],
    [BOXES.hats, false],
  ] as const) {
    await openBox(page, path);
    await expect(closeBox(page)).toHaveCount(shown ? 1 : 0);
    // Each navigation starts a fresh record (installUntouchableWallet runs per document), so each page is checked.
    expect(await walletTouches(page), path).toEqual([]);
  }
});

test('the wallet only when pressed, one confirmation, then Closed with the closing price', async ({ page }, testInfo) => {
  await openBox(page, BOXES.marbles);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(boxHeader(page).locator('.sh-box-phase')).toHaveText('Anyone can close it · tip up to 0.001 ETH');
  await expect(boxHeader(page).locator('.sh-box-band__figure')).toContainText('Deadline passed');
  await noTradingControls(page);
  await shot(page, testInfo, 'closable');
  await closeBox(page).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Box wallet A' }).check();
  await dialog.getByRole('button', { name: 'Connect sample wallet' }).click();
  const confirm = page.getByRole('group', { name: 'Close box' });
  await expect(confirm).toContainText('Calls fail() on 0xde02…0001');
  await expect(confirm).not.toContainText(/demo/i);
  await shot(page, testInfo, 'confirm');
  await confirm.getByRole('button', { name: 'Confirm close' }).click();
  await expect(band(page)).toHaveText('Closed');
  await expect(boxHeader(page).locator('.sh-box-stat dt')).toHaveText(['Items', 'Closing price', 'Closing pool']);
  await expect(closeBox(page)).toHaveCount(0);
  await shot(page, testInfo, 'closed');
  // The Demo wallet never reaches a browser wallet.
  expect(await walletTouches(page)).toEqual([]);
});

test('a box still closed past the gate’s cap sends failClosed()', async ({ page }) => {
  await openBox(page, BOXES.keys);
  expect(await walletTouches(page)).toEqual([]);
  await closeBox(page).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('button', { name: 'Connect sample wallet' }).click();
  await expect(page.getByRole('group', { name: 'Close box' })).toContainText('Calls failClosed() on 0xde02…0002');
});

test('every v2 box’s token card: "Clone, not upgradeable" with its implementation; no "refund" on any v2 page', async ({ page }, testInfo) => {
  for (const path of Object.values(BOXES)) {
    await openBox(page, `${path}?tab=token`);
    expect(await walletTouches(page), path).toEqual([]);
    const line = page.locator('.sh-v2-clone');
    await expect(line).toContainText('Clone, not upgradeable');
    await expect(line.locator('code')).toHaveAttribute('title', /^0x[0-9a-f]{40}$/);
    for (const tab of ['', '?tab=token', '?tab=owning', '?tab=about']) {
      await openBox(page, `${path}${tab}`);
      await expect(page.getByRole('main')).not.toContainText(/refund/i);
      expect(await walletTouches(page), `${path}${tab}`).toEqual([]);
    }
    await noTradingControls(page);
  }
  await openBox(page, `${BOXES.hats}?tab=token`);
  // SH-V2-FE3: "Closing price" with its (i), "USDC per 1M HATS" and the other figures keep one line each, phone included.
  expect(await brokenRuns(boxHeader(page).locator('.sh-box-stats'))).toEqual([]);
  await shot(page, testInfo, 'token-card');
  expect(await walletTouches(page)).toEqual([]);
});

// CQ11-E4 keeps the established sample records and pages when adding chain-v2 dispatch; F130 took their Demo label.
test('sample records retain their page, with no Demo label (F130); the fee step disclosure follows CQ11', async ({ page }) => {
  await openBox(page, `${BOXES.boats}?tab=token`);
  await expect(page.getByText('Demo', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText(/\bdemo\b/i);
  await expect(page.getByRole('region', { name: 'Fees' })).toContainText('Buy-backs and deepening share one step per block, within 49 ticks at the current price.');
  expect(await walletTouches(page)).toEqual([]);
  await noTradingControls(page);
});

// CQ11-E4: the production source selector, both real feed readers, BoxPage dispatch and wallet/RPC boundary.
// No page component or hook is replaced. All chain responses are controlled fixtures, never public RPC calls.
const CORE_ORIGIN = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const SAFE_ABI = parseAbi(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function VERSION() view returns (string)']);
// SH-TA-33: the items panel's vault and collection views decode too (and answer empty: unavailable on the page).
const READ_ABI = [...coordinatorV2Abi, ...receiverV2Abi, ...erc20Abi, ...SAFE_ABI, ...vaultV2Abi, ...boxCollectionAbi] as const;
/** The launch router's sweep() and its refusal when no launch tax waits (`NothingToSweep`). */
const NO_LAUNCH_TAX = { call: encodeFunctionData({ abi: launchRouterV2Abi, functionName: 'sweep' }), revert: encodeErrorResult({ abi: launchRouterV2Abi, errorName: 'NothingToSweep' }) };
type Tx = { from: string; to: string; data: Hex };

async function chainFixture(page: Page, options: { account?: string; graduated?: boolean; filledAge?: bigint; stale?: boolean; revert?: boolean; fitHistory?: 'burned' | 'empty' | 'unavailable' } = {}) {
  const data = await mixedDeployment();
  const history = options.fitHistory ? await safeHistory() : null;
  // Adapt real indexer burn events to the recorded genesis fixture's block; this is controlled browser data.
  const fitActivity = { asOf: data.v1.feed.asOf, next: null, items: options.fitHistory === 'burned'
    ? (history?.burned.activity.items ?? []).filter((item) => item.kind === 'buyback').map((item) => ({ ...item, block: data.v1.feed.asOf.block, blockHash: data.v1.feed.asOf.hash })) : [] };
  const account = options.account ?? OWNER;
  let allowance = 0n;
  let eligible = true;
  let sends = 0n;
  const sent: Tx[] = [];
  const requests: string[] = [];
  const asked: string[] = [];
  const timestamp = 1700000000n;
  const filled = options.filledAge !== undefined;
  const body = { ...data.body, verified: true, stale: options.stale ?? false,
    safePayments: history?.burned.body.safePayments ?? data.body.safePayments,
    asOf: { ...data.body.asOf, timestamp: timestamp.toString() },
    failed: options.graduated || filled ? null : data.body.failed,
    graduated: options.graduated ?? false,
    closedAt: filled ? (timestamp - (options.filledAge ?? 0n)).toString() : data.body.closedAt,
    gate: { ...data.body.gate, open: true, effectiveOpenAt: '1000', deadline: '1800000000' },
    closing: options.graduated || filled ? null : data.body.closing,
    money: data.body.money ? { ...data.body.money, values: { ...data.body.money.values, 'receiver.creatorPayee': OWNER } } : null,
  };
  const v2Path = `/box/${data.manifest.chainId}/${body.token.toLowerCase()}`;
  const v1Path = `/box/${data.manifest.chainId}/${data.v1Token.toLowerCase()}`;
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    asked.push(path);
    if (path.startsWith('/v1/boxes/') && path.endsWith('/activity') && new URL(route.request().url()).searchParams.get('kind') === 'buyback' && options.fitHistory) {
      return route.fulfill({ status: options.fitHistory === 'unavailable' ? 503 : 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fitActivity) });
    }
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards: [body] }
      : path.startsWith('/v1/boxes/') ? path.endsWith('/activity') ? data.v1.activity : path.endsWith('/candles') ? data.v1.candles : data.v1.box
      : path.endsWith('/activity') ? { items: [], next: null, asOf: body.asOf } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  const hash = (n: bigint) => toHex(n, { size: 32 });
  const block = { number: toHex(BigInt(body.asOf.block)), hash: body.asOf.hash, parentHash: hash(0n), timestamp: toHex(timestamp), transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', miner: OWNER, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', logsBloom: `0x${'00'.repeat(256)}`, nonce: '0x0000000000000000', receiptsRoot: hash(0n), stateRoot: hash(0n), transactionsRoot: hash(0n), sha3Uncles: hash(0n), uncles: [] };
  /**
   * SH-235: with a wallet connected the Items card reads the wallet's transaction count at the head's block, latest,
   * pending and latest again. This chain mines each send at once (its receipt is in the head block), so all four are the
   * sends so far: no earlier transaction under way. Only the fixture's wallet at those three tags is answered.
   */
  const transactionCount = (params: unknown[] | undefined) => {
    const [who, tag] = (params ?? []) as [unknown, unknown];
    if (typeof who !== 'string' || who.toLowerCase() !== account.toLowerCase() || !['latest', 'pending', block.number].includes(String(tag))) {
      throw new Error(`Unexpected fixture RPC eth_getTransactionCount ${JSON.stringify(params)}`);
    }
    return toHex(sends);
  };
  await page.route(`${RPC}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const request = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] };
    let result: unknown;
    if (request.method === 'eth_chainId') result = toHex(data.manifest.chainId);
    else if (request.method === 'eth_blockNumber') result = block.number;
    else if (request.method === 'eth_getBlockByNumber') result = block;
    else if (request.method === 'eth_getTransactionCount') result = transactionCount(request.params);
    else if (request.method === 'eth_estimateGas') result = '0x186a0';
    // SH-SEND-FEES: the sender's tip and funds reads (a 1-wei tip suggestion; the floor applies; 1,000 ETH).
    else if (request.method === 'eth_maxPriorityFeePerGas') result = '0x1';
    else if (request.method === 'eth_getBalance') result = toHex(10n ** 21n);
    else if (request.method === 'eth_getTransactionReceipt') result = { transactionHash: request.params?.[0], transactionIndex: '0x0', blockHash: block.hash, blockNumber: block.number, from: account, to: body.row.record.contracts[0], cumulativeGasUsed: '0x186a0', gasUsed: '0x186a0', effectiveGasPrice: '0x1', contractAddress: null, logs: [], logsBloom: block.logsBloom, status: options.revert ? '0x0' : '0x1', type: '0x2' };
    else if (request.method === 'eth_call' && (request.params?.[0] as { data: Hex }).data === NO_LAUNCH_TAX.call) {
      // SH-RC7-SITE-INBOX (KF-5): the page dry-runs a failed box's launch-router sweep; none waits on this chain.
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted', data: NO_LAUNCH_TAX.revert } }) });
    } else if (request.method === 'eth_call') {
      const call = request.params?.[0] as { data: Hex };
      const { functionName } = decodeFunctionData({ abi: READ_ABI, data: call.data });
      const values: Record<string, unknown> = {
        getOwners: [OWNER, OTHER, body.row.record.creator], getThreshold: 2n, VERSION: '1.4.1',
        failed: eligible && body.failed !== null, graduated: body.graduated,
        balanceOf: 3n * 10n ** 18n, allowance, claimState: [10000001n, 3n * 10n ** 18n], quoteClaim: 3333333n,
        // FINAL-OC01: the payee's own claimCreator (lazy royalties included) is the creator's next payment, not creatorOwed.
        creatorPayee: OWNER, creatorOwed: [900719925474099300000001n, 0n], claimCreator: 1234n,
        // SH-BOX-LIFE-VIEW: the box page names its price coin by the coin's ERC-20 symbol, as Create does.
        symbol: 'tUSDC',
      };
      result = functionName in values ? encodeFunctionResult({ abi: READ_ABI, functionName, result: values[functionName] } as never) : '0x';
    } else throw new Error(`Unexpected fixture RPC ${request.method}`);
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
  });
  await page.exposeFunction('cq11WalletRequest', async ({ method, params }: { method: string; params?: unknown[] }) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return toHex(data.manifest.chainId);
    if (method === 'eth_sendTransaction') {
      const tx = params?.[0] as Tx; sent.push(tx); sends += 1n;
      const decoded = decodeFunctionData({ abi: READ_ABI, data: tx.data });
      if (decoded.functionName === 'approve' && !options.revert) allowance = BigInt(decoded.args?.[1] as bigint);
      return hash(sends);
    }
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (request: unknown) => (window as unknown as { cq11WalletRequest: (request: unknown) => Promise<unknown> }).cq11WalletRequest(request), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name: 'CQ11 fixture wallet', rdns: 'org.example.cq11', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider } })));
  });
  return { body, v2Path, v1Path, sent, requests, asked, stopClaim: () => { eligible = false; } };
}

/**
 * The chain fixture is a failed box with coins left, so its page rightly shows the closing claim's one amount field
 * ("Coins to claim", used by the approval and claim scenarios below). box-helpers' noTradingControls forbids every
 * text field, which fits the Demo box pages but not this one: here the claim field is the only field allowed.
 */
async function noTradingControlsOnClaimPage(page: Page) {
  await expect(page.getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.getByRole('link', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.locator('textarea, iframe, input[type="number"], input[type="range"]')).toHaveCount(0);
  await expect(page.locator('input:not([type="search"])')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Coins to claim', exact: true })).toHaveCount(1);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
}

async function selectChain(page: Page) {
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
}
async function connectChainWallet(page: Page, button: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /CQ11 fixture wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function confirmChainAction(page: Page, button: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm', exact: true }).click();
}

test('chain v2: actual source and feed routing preserve v1; closing price first and Safe reads without a wallet request', async ({ page }) => {
  const fixture = await chainFixture(page);
  await selectChain(page); await page.goto('/');
  await expect(page.locator(`a[href="${fixture.v1Path}"]`).first()).toBeVisible();
  await page.locator(`a[href="${fixture.v2Path}"]`).first().click();
  // SH-255 (review R-16): the box's picture first (its own cards), then the closing price before any other card.
  await expect.poll(() => h2Order(page)).toEqual(PICTURE_THEN_CLOSING);
  // SH-BOX-LIFE-VIEW: the closing price short per 1M coins, the exact digits behind the closed Claim details.
  await expect(page.getByRole('region', { name: 'Failure claim' }).locator('.sh-v2-value')).toHaveText(/^3,333,333 tUSDC per 1M \S+$/);
  await expect(page.getByRole('region', { name: 'Failure claim' })).toContainText('Exact: 3.333333666666666666666666 tUSDC per ');
  await expect(page.getByRole('region', { name: 'Failure claim' }).getByText(/^Exact: /)).toBeHidden();
  await page.getByText('Safes and payments', { exact: true }).click();
  await expect(page.getByText('2 of 3 signatures · Safe 1.4.1')).toHaveCount(2); // the FIT and platform Safes (RC5-C)
  await expect(page.getByRole('heading', { name: 'FIT buy-back Safe' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  expect(fixture.asked).toContain('/v1/feed'); expect(fixture.asked).toContain('/v2/feed');
  expect(fixture.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]);
  await page.goto(fixture.v1Path);
  await expect(boxHeader(page)).toBeVisible();
  await expect(page.locator('.sh-v2-page')).toHaveCount(0);
  expect(fixture.requests).toEqual([]);
});

for (const fitHistory of ['burned', 'empty', 'unavailable'] as const) test(`chain v2: Safe payouts and ${fitHistory} FIT history stay distinct from the later bot log`, async ({ page }) => {
  const f = await chainFixture(page, { fitHistory });
  await selectChain(page); await page.goto('/');
  await page.locator(`a[href="${f.v2Path}"]`).first().click();
  await page.getByText('Safes and payments', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Safe payouts' })).toBeVisible();
  await expect(page.getByText('Paid to FIT Safe · 900719925474099300.000001 tUSDC')).toBeVisible();
  // RC5-C and F138: two Safes; a royalty in another coin stays in the box's inbox, so no Safe payment shows it.
  await expect(page.getByText('Paid to platform Safe · 2.000001 tUSDC')).toBeVisible();
  await expect(page.getByText(/conversion Safe/)).toHaveCount(0);
  await expect(page.getByText('The bot’s sales, funding and Safe burns will appear here once published.')).toBeVisible();
  const burns = page.getByRole('region', { name: 'FIT executor burns' });
  if (fitHistory === 'burned') {
    await expect(burns.getByText('900719.925474099300000003 FIT', { exact: true })).toBeVisible();
    await burns.getByText('Transaction', { exact: true }).click();
    await expect(burns.locator('.sh-v2-address').first()).toHaveText(/^0x[0-9a-f]{64}$/i);
  } else await expect(burns).toContainText(fitHistory === 'empty' ? 'No FIT executor burns in the latest 100 burn records.' : 'FIT executor history unavailable.');
  await expect(burns).toContainText('Shared across boxes; these burns are not attributed to this box.');
  expect(f.requests).toEqual([]); expect(f.sent).toEqual([]); expect(await walletTouches(page)).toEqual([]);
  await noTradingControlsOnClaimPage(page);
});

test('chain v2: exact approval and a separate claim, with encoded recipients and amounts', async ({ page }) => {
  const f = await chainFixture(page); await selectChain(page); await page.goto(f.v2Path);
  await page.getByRole('textbox', { name: 'Coins to claim' }).fill('1');
  expect(f.requests).toEqual([]);
  await connectChainWallet(page, 'Approve coins');
  await confirmChainAction(page, 'Claim tUSDC');
  await expect(page.getByRole('status')).toContainText('Approve these coins first'); expect(f.sent).toHaveLength(0);
  await confirmChainAction(page, 'Approve coins');
  await expect(page.getByRole('status')).toContainText('Approval confirmed. Claim in a separate transaction.');
  expect(f.sent).toHaveLength(1);
  const approval = f.sent[0]; if (!approval) throw new Error('missing approval');
  expect(approval.to.toLowerCase()).toBe(f.body.token.toLowerCase());
  expect(decodeFunctionData({ abi: erc20Abi, data: approval.data })).toMatchObject({ functionName: 'approve', args: [f.body.row.record.contracts[0], 10n ** 18n] });
  await confirmChainAction(page, 'Claim tUSDC');
  await expect(page.getByRole('status')).toContainText('Confirmed. Reading the updated box');
  const claim = f.sent[1]; if (!claim) throw new Error('missing claim');
  expect(claim.to.toLowerCase()).toBe(f.body.row.record.contracts[0]?.toLowerCase());
  expect(decodeFunctionData({ abi: coordinatorV2Abi, data: claim.data })).toMatchObject({ functionName: 'claim', args: [10n ** 18n, OWNER] });
});

for (const age of [604799n, 604800n]) test(`chain v2: graduation hatch at ${age} seconds`, async ({ page }) => {
  const f = await chainFixture(page, { filledAge: age }); await selectChain(page); await page.goto(f.v2Path);
  await expect(page.getByRole('heading', { name: 'Graduation hatch' })).toBeVisible();
  await expect(closeBox(page)).toHaveCount(age < 604800n ? 0 : 1);
  expect(f.requests).toEqual([]);
  if (age === 604800n) {
    await connectChainWallet(page, 'Close box'); await confirmChainAction(page, 'Close box');
    await expect(page.getByRole('status')).toContainText('Confirmed. Reading the updated box');
    const tx = f.sent[0]; if (!tx) throw new Error('missing closure');
    expect(decodeFunctionData({ abi: coordinatorV2Abi, data: tx.data }).functionName).toBe('fail');
  }
});

for (const account of [OWNER, OTHER]) test(`chain v2: creator authorization ${account === OWNER ? 'owner' : 'other wallet'}`, async ({ page }) => {
  const f = await chainFixture(page, { account, graduated: true }); await selectChain(page); await page.goto(f.v2Path);
  await expect(closeBox(page)).toHaveCount(0); expect(f.requests).toEqual([]);
  await connectChainWallet(page, 'Claim creator fees');
  if (account === OTHER) { await expect(page.getByRole('button', { name: 'Claim creator fees' })).toHaveCount(0); expect(f.sent).toHaveLength(0); }
  else {
    await confirmChainAction(page, 'Claim creator fees');
    await expect(page.getByRole('status')).toContainText('Confirmed. Reading the updated box');
    const tx = f.sent[0]; if (!tx) throw new Error('missing creator claim');
    expect(tx.to.toLowerCase()).toBe(f.body.row.record.contracts[5]?.toLowerCase());
    expect(decodeFunctionData({ abi: receiverV2Abi, data: tx.data })).toMatchObject({ functionName: 'claimCreator', args: [f.body.row.record.q, OWNER] });
    expect(f.sent).toHaveLength(1);
  }
});

test('chain v2: stale published reads disable actions; a changed RPC state refuses a send', async ({ page }) => {
  const f = await chainFixture(page, { stale: true }); await selectChain(page); await page.goto(f.v2Path);
  await page.getByRole('textbox', { name: 'Coins to claim' }).fill('1');
  await expect(page.getByRole('button', { name: 'Approve coins' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Claim tUSDC' })).toBeDisabled();
  expect(f.requests).toEqual([]);
  f.body.stale = false; await page.reload();
  await page.getByRole('textbox', { name: 'Coins to claim' }).fill('1');
  await connectChainWallet(page, 'Approve coins'); f.stopClaim();
  await confirmChainAction(page, 'Approve coins');
  await expect(page.getByRole('status')).toContainText('Claim exceeds your eligible coins'); expect(f.sent).toHaveLength(0);
});

test('chain v2: a reverted receipt never confirms approval or permits a claim', async ({ page }) => {
  const f = await chainFixture(page, { revert: true }); await selectChain(page); await page.goto(f.v2Path);
  await page.getByRole('textbox', { name: 'Coins to claim' }).fill('1');
  await connectChainWallet(page, 'Approve coins'); await confirmChainAction(page, 'Approve coins');
  await expect(page.getByRole('status')).toContainText('Transaction reverted; nothing confirmed');
  await expect(page.getByText('Approval confirmed. Claim in a separate transaction.')).toHaveCount(0);
  await confirmChainAction(page, 'Claim tUSDC');
  await expect(page.getByRole('status')).toContainText('Approve these coins first'); expect(f.sent).toHaveLength(1);
});
