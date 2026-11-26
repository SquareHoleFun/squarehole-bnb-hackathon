import { expect, test, type Locator, type Page } from '@playwright/test';
import { makePng } from '../../../../packages/artwork/src/test-support/images';
import { LEGACY_OFF } from '../legacy-off';
import {
  callUint,
  cast,
  confirmAndFinalize,
  connectAnvilWallet,
  evidence,
  formatQuoteFigure18,
  formatRaw18,
  horizontalOverflow,
  installAnvilWallet,
  launchContract,
  localChain,
  manifest,
  quoteFigureBoxes,
  rejectNextSend,
  rpc,
  txPanel,
  chooseLocalSource,
  walletButton,
  walletState,
  type LaunchKey,
} from './chain-helpers';
import { goInApp } from '../feed-helpers';

// SH-C chain E2E: the app built against a real local Square Hole deployment (anvil 31337 on port 8561, deployed and
// seeded by the contracts' own scripts and external-trading harness; see e2e/chain/chain-server.mjs). One chain, one
// worker, in order. The browser wallet is the test-only anvil wallet (chain-helpers.ts).
// The pair feed, pair detail, Claims and Portfolio are off in every build since F134 R46B (e2e/legacy-off.ts): the tests
// that need them skip themselves; Settings, browsing (their old links open the boxes and My Box) and About still run.
//
// The local plan is F10's (packages/contracts/script/config/31337.json): The Misfits (T = FIT, 10,000 NFTs, quote WETH,
// R = Q) and ORCHARD (T = ORCH, 1,000 NFTs, quote FIT, R = T). The seeding leaves alice and bob with claimable rewards
// on both: R = Q on The Misfits (paid in WETH) and R = T on ORCHARD (paid in ORCH).

const FORBIDDEN = /\b(buy|sell|swap)\b/i;
const TERMS_GATE = 'Before you enter Square Hole';
const chain = localChain();
const MISFITS = chain.pairs.THE_MISFITS;
const ORCHARD = chain.pairs.ORCHARD;
const route = (appPairId: string) => `/pair/${appPairId.replace(':', '/')}`;
const escape = (text: string) => text.replace(/[.,]/g, '\\$&');

/** Pool mid price in Q per displayed T, truncated to 6 significant digits, read independently with cast. */
function midPrice(launchKey: LaunchKey): { text: string; num: bigint; den: bigint } {
  const m = manifest();
  const launch = m.launches[launchKey];
  if (!launch) throw new Error(`no launch ${launchKey}`);
  const slot = cast(['index', 'bytes32', launch.poolId, '6']);
  const word = BigInt(cast(['storage', m.contracts.poolManager?.address ?? '', slot]));
  const sqrt = word & ((1n << 160n) - 1n);
  const pair = chain.pairs[launchKey];
  const tIsCurrency0 = pair.token.toLowerCase() < pair.quote.toLowerCase();
  const [num, den] = tIsCurrency0 ? [sqrt * sqrt, 1n << 192n] : [1n << 192n, sqrt * sqrt];
  // Decimal expansion (both assets have 18 decimals), then 6 significant digits, truncated like the app.
  const whole = num / den;
  let rest = num % den;
  let fraction = '';
  for (let i = 0; i < 40; i += 1) {
    rest *= 10n;
    fraction += (rest / den).toString();
    rest %= den;
  }
  const first = fraction.search(/[1-9]/);
  const text = whole > 0n ? whole.toString() : `0.${fraction.slice(0, first + 6).replace(/0+$/, '')}`;
  return { text, num, den };
}

/** Market cap on the ledger's eligible supply at the pool mid price, computed independently: floor(eligible × price). */
function marketCapFigure(launchKey: LaunchKey): string {
  const price = midPrice(launchKey);
  const eligible = callUint(launchContract(launchKey, 'rewardLedger'), 'eligibleSupply()(uint256)');
  return formatQuoteFigure18((eligible * price.num) / price.den);
}

/** The converter's ClaimConverted(token, holder, qIn, tOut) event of a transaction, read from its receipt. */
async function claimConverted(hash: string, token: string, holder: string): Promise<{ qIn: bigint; tOut: bigint }> {
  const converter = manifest().contracts.claimConverter?.address.toLowerCase() ?? '';
  const topic = cast(['keccak', 'ClaimConverted(address,address,uint256,uint256)']);
  const word = (address: string) => `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;
  const receipt = await rpc<{ status: string; logs: { address: string; topics: string[]; data: string }[] }>('eth_getTransactionReceipt', [hash]);
  expect(receipt.status).toBe('0x1');
  const log = receipt.logs.find((entry) => entry.address.toLowerCase() === converter && entry.topics[0] === topic && entry.topics[1] === word(token) && entry.topics[2] === word(holder));
  if (!log) throw new Error(`no ClaimConverted(${token}, ${holder}) in ${hash}`);
  return { qIn: BigInt(`0x${log.data.slice(2, 66)}`), tOut: BigInt(`0x${log.data.slice(66, 130)}`) };
}

/** Every quote amount and mid price is on one line and inside its cell (SH-C review: "1,071.61454" broke mid-number). */
async function expectFiguresFit(page: Page, where: string, atLeast: number) {
  await expect(page.locator('.sh-q-figure .sh-numeric, .sh-chain-price .sh-numeric').nth(atLeast - 1)).toBeVisible();
  const boxes = await quoteFigureBoxes(page);
  expect(boxes.length, where).toBeGreaterThanOrEqual(atLeast);
  expect(boxes.filter((box) => box.lines !== 1 || box.overflow > 0), `${where}: ${JSON.stringify(boxes)}`).toEqual([]);
}

/** Opens `path` with the anvil test wallet installed (never connected here) and the Terms already accepted (F19). */
async function openAs(page: Page, account: string, path: string, chainIdHex?: string) {
  await installAnvilWallet(page, { account, chainIdHex });
  await chooseLocalSource(page);
  await page.goto(path);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.getByRole('dialog', { name: TERMS_GATE })).toHaveCount(0);
}

const claimCard = (page: Page, name: string): Locator => page.locator('article.sh-claim').filter({ has: page.getByRole('heading', { level: 3, name: new RegExp(`^${name}`) }) });

async function audit(page: Page, where: string) {
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.getByRole('button', { name: FORBIDDEN }), where).toHaveCount(0);
  await expect(page.getByRole('link', { name: FORBIDDEN }), where).toHaveCount(0);
  await expect(page.getByRole('spinbutton'), where).toHaveCount(0);
  await expect(page.locator('input[type="number"], input[type="range"], iframe, frame, embed, object'), where).toHaveCount(0);
  expect(await page.locator('main').innerText(), where).not.toMatch(FORBIDDEN);
  const labelled = await page.evaluate((source) => {
    const pattern = new RegExp(source, 'i');
    const texts = [
      ...[...document.querySelectorAll('label, legend, option')].map((el) => el.textContent ?? ''),
      ...[...document.querySelectorAll('[aria-label], [placeholder], [title]')].flatMap((el) => [el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? '', el.getAttribute('title') ?? '']),
      ...[...document.querySelectorAll('input, select, textarea')].flatMap((el) => [el.getAttribute('name') ?? '', el.id]),
    ];
    return texts.filter((text) => pattern.test(text) || /amount/i.test(text));
  }, FORBIDDEN.source);
  expect(labelled, where).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test('Settings: the local chain source is available, Sepolia is disabled as "not deployed yet"; choosing applies at once', async ({ page }, testInfo) => {
  await page.goto('/settings');
  // F19: the Terms are pre-accepted through the config's storageState, on this port too.
  await expect(page.getByRole('dialog', { name: TERMS_GATE })).toHaveCount(0);
  const group = page.getByRole('group', { name: 'Data source' });
  await expect(group.getByRole('radio', { name: /Local chain \(anvil 31337\)/ })).toBeEnabled();
  await expect(group.getByRole('radio', { name: /Sepolia testnet/ })).toBeDisabled();
  await expect(group).toContainText('Not deployed yet: Square Hole has no Sepolia deployment');
  await expect(page.getByRole('banner')).toContainText('Demo · mock data');
  await group.getByRole('radio', { name: /Local chain \(anvil 31337\)/ }).check();
  await expect(page.getByRole('banner')).toContainText('Local chain 31337');
  await expect(page.getByTestId('data-source-status')).toContainText('Showing Local chain 31337. Saved on this device.');
  await expect(page.getByRole('group', { name: 'Data source' }).getByRole('radio', { name: /Local chain/ })).toBeFocused();
  await evidence(page, testInfo, 'C-settings-data-source');
  await page.reload();
  await expect(page.getByRole('banner')).toContainText('Local chain 31337');
});

test('UI-09 / EXT-04: browsing every page on the chain source never pings discovery or asks the wallet anything', async ({ page }) => {
  await openAs(page, chain.accounts.alice, '/');
  for (const path of ['/', route(MISFITS.appPairId), route(ORCHARD.appPairId), '/create/basics', '/portfolio', '/rewards', '/settings', '/about/risks']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
  }
  const wallet = await walletState(page);
  expect(wallet.pings).toBe(0);
  expect(wallet.calls).toEqual([]);
});

test('feed: The Misfits (in WETH) and ORCHARD (in FIT) from the chain, with the pool mid price, market cap and reward side', async ({ page }, testInfo) => {
  test.skip(true, LEGACY_OFF);
  await openAs(page, chain.accounts.alice, '/');
  await expect(page.getByRole('banner')).toContainText('Local chain 31337');
  const source = page.locator('.sh-feed__source');
  await expect(source).toContainText(/Local chain 31337 · block \d+/);
  await expect(page.getByTestId('chain-feed-note')).toContainText('No USD source is adopted for test chains');

  // The Misfits: T = FIT, quote WETH, R = Q. Market cap on the ledger's eligible supply, computed independently; the
  // feed cell shows the bounded figure (6 significant digits, truncated), the pair page the longer one.
  const misfits = page.locator(`[data-pair-id="${MISFITS.appPairId}"]`);
  await expect(misfits).toContainText('The Misfits');
  await expect(misfits.locator('.sh-project__symbol')).toHaveText('FIT');
  await expect(misfits.locator('.sh-pairing__symbol')).toHaveText('Paired with WETH');
  await expect(misfits.locator('.sh-chain-price')).toHaveText(`Price ${midPrice('THE_MISFITS').text} WETH`);
  await expect(misfits.locator('.sh-q-figure').first()).toHaveText(new RegExp(`^${escape(marketCapFigure('THE_MISFITS'))} WETH`));
  await expect(misfits.locator('.sh-reward')).toHaveAttribute('data-reward-side', 'Q');
  await expect(misfits.locator('.sh-reward')).toHaveText('Fee share in WETH');
  await expect(misfits).toContainText('NFT collection');
  await expect(misfits).toContainText('Route unverified');

  // ORCHARD: T = ORCH, quote FIT (The Misfits' token), R = T: every quote figure is in FIT.
  const orchard = page.locator(`[data-pair-id="${ORCHARD.appPairId}"]`);
  await expect(orchard).toContainText('ORCHARD');
  await expect(orchard.locator('.sh-project__symbol')).toHaveText('ORCH');
  await expect(orchard.locator('.sh-pairing__symbol')).toHaveText('Paired with FIT');
  await expect(orchard.locator('.sh-chain-price')).toHaveText(`Price ${midPrice('ORCHARD').text} FIT`);
  await expect(orchard.locator('.sh-q-figure').first()).toHaveText(new RegExp(`^${escape(marketCapFigure('ORCHARD'))} FIT`));
  await expect(orchard.locator('.sh-reward')).toHaveAttribute('data-reward-side', 'T');
  await expect(orchard.locator('.sh-reward')).toHaveText('Fee share in ORCH');
  await expect(orchard).toContainText('NFT collection');
  await expect(orchard).toContainText('Route unverified');

  // No USD source on a test chain: the results bar says the rows are in launch order, and only Age carries the sort
  // mark (never "By market cap, highest first" over quote figures in different units).
  const sortText = page.locator('.sh-results-bar__sort');
  await expect(sortText).toHaveText('No USD market cap on this test chain: ordered by launch time, newest first');
  await expect(page.getByRole('columnheader', { name: /Market cap/ })).not.toHaveAttribute('aria-sort');
  await expect(page.getByRole('columnheader', { name: /24h turnover/ })).not.toHaveAttribute('aria-sort');
  await expect(page.getByRole('columnheader', { name: /Age/ })).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.getByRole('columnheader', { name: /Market cap/ }).locator('svg')).toHaveCount(0);
  await expect(page.locator('tbody .sh-q-figure').first()).toBeVisible();
  await expectFiguresFit(page, 'feed 1440', 5);
  expect(await horizontalOverflow(page)).toBe(0);
  await audit(page, 'feed');
  await evidence(page, testInfo, 'C-feed-local');

  await page.getByRole('radio', { name: 'Turnover (24h)' }).check();
  await expect(sortText).toHaveText('No USD turnover on this test chain: ordered by launch time, newest first');
  await expect(page.getByRole('columnheader', { name: /24h turnover/ })).not.toHaveAttribute('aria-sort');
  await expect(page.getByRole('columnheader', { name: /Age/ })).toHaveAttribute('aria-sort', 'ascending');
});

test('About & risks on the local chain describes the real test deployment, not the demo', async ({ page }, testInfo) => {
  await openAs(page, chain.accounts.alice, '/about/risks');
  const status = page.locator('.sh-risks__status');
  await expect(status).toContainText('Local anvil chain (31337)');
  await expect(status).toContainText('Read from the chain; each page shows its block and time');
  await expect(status).toContainText(/Local anvil deployment \(manifest commit [0-9a-f]{10}/);
  const main = page.locator('main');
  for (const demoOnly of ['Mock data', 'Not deployed anywhere', 'This is a demo', 'invented demo data', 'In this demo no route is verified', 'Local chain']) {
    await expect(main).not.toContainText(demoOnly);
  }
  await expect(status).toContainText(/Test tokens\s*No value/);
  await expect(page.getByRole('region', { name: 'This is a demo' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Failure & claim' })).toBeVisible();
  await audit(page, 'about & risks');
  await evidence(page, testInfo, 'C-risks-local');
});

test('pair detail: The Misfits and ORCHARD supply, price, burns and holders from the chain; no explorer or venue link on a local chain', async ({ page }, testInfo) => {
  test.skip(true, LEGACY_OFF);
  await openAs(page, chain.accounts.alice, route(MISFITS.appPairId));
  await expect(page.getByRole('heading', { level: 1, name: /The Misfits/ })).toBeVisible();
  const market = page.getByTestId('chain-market');
  await expect(market).toContainText('On-chain market (Local chain 31337)');
  const current = callUint(MISFITS.token, 'totalSupply()(uint256)');
  await expect(market.locator('[data-fact="supply"]')).toContainText(`${formatRaw18(current)} / `);
  await expect(market.locator('[data-fact="price"]')).toContainText(`${midPrice('THE_MISFITS').text} WETH per FIT`);
  await expect(market.locator('[data-fact="burned"]')).toContainText('(reconciled with the fee collector)');
  await expect(market.locator('[data-fact="holders"]')).toContainText(/\d+/);
  await expect(market).toContainText('not audited');
  // Local chain: no public explorer, no venue: no external link is built (EXT-02/03/05).
  await expect(page.locator('a[href^="http"]').filter({ hasText: /etherscan|blockscout|uniswap|dex/i })).toHaveCount(0);
  await audit(page, 'pair detail');
  await evidence(page, testInfo, 'C-detail-local');

  // ORCHARD: quoted in FIT, so its price reads "FIT per ORCH"; its burns (ORCH fees) reconcile the same way.
  await page.goto(route(ORCHARD.appPairId));
  await expect(page.getByRole('heading', { level: 1, name: /ORCHARD/ })).toBeVisible();
  const orchardMarket = page.getByTestId('chain-market');
  await expect(orchardMarket).toContainText('On-chain market (Local chain 31337)');
  const orchardSupply = callUint(ORCHARD.token, 'totalSupply()(uint256)');
  await expect(orchardMarket.locator('[data-fact="supply"]')).toContainText(`${formatRaw18(orchardSupply)} / `);
  await expect(orchardMarket.locator('[data-fact="price"]')).toContainText(`${midPrice('ORCHARD').text} FIT per ORCH`);
  await expect(orchardMarket.locator('[data-fact="burned"]')).toContainText('(reconciled with the fee collector)');
  await expect(orchardMarket.locator('[data-fact="holders"]')).toContainText(/\d+/);
  await expect(page.locator('a[href^="http"]').filter({ hasText: /etherscan|blockscout|uniswap|dex/i })).toHaveCount(0);
  await audit(page, 'pair detail ORCHARD');
});

// F69 C1 (SH-BOX-CREATE): /launch now redirects to the box creation flow, which sends nothing until the box factory
// (S7) exists; the pair wizard and its createLaunch path are no longer reachable. Kept, skipped, until the factory lands.
test.skip('create a collection through the wizard → createLaunch finalized and verified → the new pair is in the feed', async ({ page }, testInfo) => {
  const alice = chain.accounts.alice;
  // F10: every collection has exactly 1,000,000,000 fractions, so the contracts accept only N × r = 1e9 (r = 1e9 / N):
  // 10 NFTs of 100,000,000 fractions each. (The wizard still validates the F08 rule N × r ≤ 1e9, which this satisfies.)
  const size = 10;
  await openAs(page, alice, '/launch');
  await expect(page.locator('.sh-launch-hero__demo')).toContainText('Creating sends one real createLaunch transaction');
  await page.getByRole('radio', { name: 'Create NFT collection' }).check();
  await page.getByRole('radio', { name: /^WETH at / }).check();
  await page.getByLabel('Collection size (NFTs)').fill(String(size));
  await page.getByLabel('Fractions per NFT').selectOption({ label: '1 NFT = 100,000,000 fractions' });
  await expect(page.locator('.sh-fraction-readout')).toContainText('Total: 1,000,000,000 of 1,000,000,000 fractions');
  await page.getByRole('radio', { name: 'Paid in T' }).check();
  await page.getByRole('button', { name: 'Continue to identity & artwork' }).click();
  await page.getByLabel('Name').fill('E2E Squares');
  await page.getByLabel('Ticker').fill('SQRE');
  const png = (w: number, h: number) => Buffer.from(makePng({ width: w, height: h, decodable: true }));
  const ids = Array.from({ length: size }, (_, index) => index + 1);
  await page.getByLabel('Images (one per NFT)').setInputFiles(ids.map((id) => ({ name: `${id}.png`, mimeType: 'image/png', buffer: png(300 + id * 4, 300 + id * 4) })));
  await expect(page.getByRole('img', { name: /NFT #\d+ preview \(re-encoded copy\)/ })).toHaveCount(size);
  const csv = `id,Shape\n${ids.map((id) => `${id},${id % 2 === 0 ? 'Circle' : 'Square'}`).join('\n')}\n`;
  await page.getByLabel('Attributes (JSON or CSV)').setInputFiles({ name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText(`Every id from 1 to ${size} has one image and one attributes entry.`)).toBeVisible();
  await page.getByRole('button', { name: 'Continue to review' }).click();
  await expect(page.getByText('Local chain 31337 · a real transaction on your local anvil deployment (test tokens only)')).toBeVisible();
  await audit(page, 'launch review');
  await page.getByRole('checkbox', { name: 'I understand these terms are immutable after creation.' }).check();
  await page.getByRole('button', { name: 'Open browser wallets' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Anvil test wallet/ }).click();
  const pairsBefore = callUint(manifest().contracts.registry?.address ?? '', 'pairCount()(uint256)');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const review = page.getByTestId('chain-signature-request');
  await expect(review).toContainText('createLaunch');
  await expect(review).toContainText('Network fee');
  await confirmAndFinalize(page, 'Verified on chain');
  const success = page.getByTestId('chain-launch-success');
  await expect(success).toContainText('E2E Squares (SQRE) is registered');
  expect(callUint(manifest().contracts.registry?.address ?? '', 'pairCount()(uint256)')).toBe(pairsBefore + 1n);
  expect((await walletState(page)).calls.filter((method) => method === 'eth_sendTransaction')).toHaveLength(1);
  await evidence(page, testInfo, 'C-create-success');

  await success.getByRole('link', { name: 'View the new pair' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /E2E Squares/ })).toBeVisible();
  const token = page.url().split('/').at(-1) ?? '';
  expect(cast(['call', token, 'symbol()(string)'])).toBe('"SQRE"');
  // The fixed F10 supply, 10 NFTs of 1e26 raw each.
  expect(callUint(token, 'totalSupply()(uint256)')).toBe(10n ** 27n);
  expect(callUint(token, 'unit()(uint256)')).toBe(10n ** 26n);
  // A fresh session: the feed snapshot now includes the new pair (indexed from its PairCreated log).
  await page.goto('/?sort=new');
  await expect(page.locator(`[data-pair-id="31337:${token.toLowerCase()}"]`)).toContainText('E2E Squares');
});

test('a holder claims R = Q (The Misfits, paid in WETH) and claims as T (ORCHARD, paid in ORCH), each finalized and verified', async ({ page }, testInfo) => {
  test.skip(true, LEGACY_OFF);
  const alice = chain.accounts.alice;
  const misfitsLedger = launchContract('THE_MISFITS', 'rewardLedger');
  const orchardLedger = launchContract('ORCHARD', 'rewardLedger');
  const claimableQ = callUint(misfitsLedger, 'claimable(address)(uint256)', [alice]);
  expect(claimableQ).toBeGreaterThan(0n);
  const wethBefore = callUint(MISFITS.quote, 'balanceOf(address)(uint256)', [alice]);

  await openAs(page, alice, '/rewards');
  await connectAnvilWallet(page);
  const misfits = claimCard(page, 'The Misfits');
  await expect(misfits.getByTestId('claim-button')).toContainText('Claim');
  await misfits.getByTestId('claim-button').click();
  await expect(misfits.getByTestId('chain-signature-request')).toContainText(/RewardLedger 0x[0-9a-fA-F]{40} · claim/);
  await confirmAndFinalize(misfits, /Finalized on Local chain 31337/);
  // Exactly the entitlement read before, paid in WETH to the holder; the ledger shows nothing left (no swap since).
  const wethAfter = callUint(MISFITS.quote, 'balanceOf(address)(uint256)', [alice]);
  expect(wethAfter - wethBefore).toBe(claimableQ);
  expect(callUint(misfitsLedger, 'claimable(address)(uint256)', [alice])).toBe(0n);
  await expect(misfits.getByTestId('claim-button')).toHaveText('Nothing claimable yet');
  await evidence(page, testInfo, 'C-claim-success');

  // ORCHARD pays R = T: the FIT entitlement is converted through the converter and paid in ORCH.
  const orchardClaimable = callUint(orchardLedger, 'claimable(address)(uint256)', [alice]);
  expect(orchardClaimable).toBeGreaterThan(0n);
  const tBefore = callUint(ORCHARD.token, 'balanceOf(address)(uint256)', [alice]);
  const orchard = claimCard(page, 'ORCHARD');
  await expect(orchard.getByTestId('conversion-estimate')).toContainText(/eth_call/);
  await orchard.getByTestId('claim-button').click();
  await expect(orchard.getByTestId('chain-signature-request')).toContainText('claimAsT(bytes32,uint256,uint256)');
  await confirmAndFinalize(orchard, /Finalized on Local chain 31337/);
  const tAfter = callUint(ORCHARD.token, 'balanceOf(address)(uint256)', [alice]);
  expect(tAfter).toBeGreaterThan(tBefore);
  const wallet = await walletState(page);
  expect(wallet.calls.filter((method) => method === 'eth_sendTransaction')).toHaveLength(2);
  // The converter's own record of that transaction: the whole FIT entitlement read before went in, and exactly the
  // ORCH the holder received came out.
  const converted = await claimConverted(wallet.sent.at(-1) ?? '', ORCHARD.token, alice);
  expect(converted.qIn).toBe(orchardClaimable);
  expect(converted.tOut).toBe(tAfter - tBefore);
  // The conversion is itself an ORCHARD swap that pays the normal pool fee, so the holder (an ORCH holder) accrues a
  // share of it again: less than the entitlement just converted, never the same entitlement twice.
  expect(callUint(orchardLedger, 'claimable(address)(uint256)', [alice])).toBeLessThan(orchardClaimable);
  await evidence(page, testInfo, 'C-claim-as-t-success');
});

test.describe('phone (390 × 844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('feed cards: quote figures on one line inside their cells, no sideways scroll', async ({ page }, testInfo) => {
    test.skip(true, LEGACY_OFF);
    await openAs(page, chain.accounts.alice, '/');
    await expect(page.locator('.sh-card .sh-q-figure').first()).toBeVisible();
    await expect(page.locator('.sh-results-bar__sort')).toHaveText('No USD market cap on this test chain: ordered by launch time, newest first');
    await expect(page.locator(`.sh-card[data-pair-id="${MISFITS.appPairId}"] .sh-chain-price`)).toHaveText(`Price ${midPrice('THE_MISFITS').text} WETH`);
    await expect(page.locator(`.sh-card[data-pair-id="${ORCHARD.appPairId}"] .sh-chain-price`)).toHaveText(`Price ${midPrice('ORCHARD').text} FIT`);
    await expectFiguresFit(page, 'feed 390', 5);
    expect(await horizontalOverflow(page)).toBe(0);
    await evidence(page, testInfo, 'C-feed-local-mobile');
  });

  test('claim as T: the review before the wallet opens fits the phone (every figure visible), then cancel sends nothing', async ({ page }, testInfo) => {
    test.skip(true, LEGACY_OFF);
    // bob holds ORCH (LocalE2E.s.sol) and has a fresh R = T entitlement on ORCHARD (local-chain.mjs step 4).
    await openAs(page, chain.accounts.bob, '/rewards');
    await connectAnvilWallet(page);
    const orchard = claimCard(page, 'ORCHARD');
    await expect(orchard.getByTestId('claim-button')).toContainText('Claim as');
    await orchard.getByTestId('claim-button').click();
    const review = orchard.getByTestId('chain-signature-request');
    await expect(review).toContainText('claimAsT(bytes32,uint256,uint256)');
    await expect(review).toContainText('Signed minimum');
    expect(await horizontalOverflow(page)).toBe(0);
    const clipped = await review.evaluate((el) => [...el.querySelectorAll('dd, p')].filter((node) => node.getBoundingClientRect().right > window.innerWidth + 0.5).map((node) => node.textContent));
    expect(clipped).toEqual([]);
    await review.scrollIntoViewIfNeeded();
    await evidence(page, testInfo, 'C-mobile-claim-review', { fullPage: false });
    await orchard.getByRole('button', { name: 'Cancel request' }).click();
    await expect(txPanel(orchard)).toHaveCount(0);
    expect((await walletState(page)).calls).not.toContain('eth_sendTransaction');
  });

  // F69 C1: the pair wizard is no longer reachable (see the skipped createLaunch test above).
  test.skip('createLaunch: the review before the wallet opens fits the phone, then cancel sends nothing', async ({ page }, testInfo) => {
    await openAs(page, chain.accounts.creator, '/launch');
    await page.getByRole('radio', { name: 'Create token' }).check();
    await page.getByRole('radio', { name: /^WETH at / }).check();
    await page.getByRole('button', { name: 'Continue to identity & artwork' }).click();
    await page.getByLabel('Name').fill('Phone Review');
    await page.getByLabel('Ticker').fill('PHONE');
    await page.getByLabel('Logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 320, height: 320, decodable: true })) });
    await expect(page.getByText('Accepted: logo.png')).toBeVisible();
    await page.getByRole('button', { name: 'Continue to review' }).click();
    await page.getByRole('checkbox', { name: 'I understand these terms are immutable after creation.' }).check();
    await page.getByRole('button', { name: 'Open browser wallets' }).click();
    await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Anvil test wallet/ }).click();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const review = page.getByTestId('chain-signature-request');
    await expect(review).toContainText('createLaunch');
    await expect(review).toContainText('Network fee');
    expect(await horizontalOverflow(page)).toBe(0);
    const clipped = await review.evaluate((el) => [...el.querySelectorAll('dd, p')].filter((node) => node.getBoundingClientRect().right > window.innerWidth + 0.5).map((node) => node.textContent));
    expect(clipped).toEqual([]);
    await review.scrollIntoViewIfNeeded();
    await evidence(page, testInfo, 'C-mobile-launch-review', { fullPage: false });
    await page.getByRole('button', { name: 'Cancel request' }).click();
    expect((await walletState(page)).calls).not.toContain('eth_sendTransaction');
  });
});

test('wrong chain: a wallet on Sepolia is asked to switch before anything is simulated or sent', async ({ page }) => {
  test.skip(true, LEGACY_OFF);
  const bob = chain.accounts.bob;
  await openAs(page, bob, '/rewards', '0xaa36a7');
  await connectAnvilWallet(page);
  await expect(walletButton(page)).toHaveAccessibleName(/wrong network/);
  await expect(page.getByTestId('wrong-network-notice')).toContainText('Sepolia (11155111)');
  const misfits = claimCard(page, 'The Misfits');
  await misfits.getByTestId('claim-button').click();
  await expect(txPanel(misfits)).toHaveAttribute('data-tx-status', 'wrong_chain');
  await misfits.getByRole('button', { name: 'Switch to Local anvil chain (31337)' }).click();
  await expect(txPanel(misfits)).toHaveAttribute('data-tx-status', 'awaiting_signature');
  const wallet = await walletState(page);
  expect(wallet.calls).toContain('wallet_switchEthereumChain');
  expect(wallet.calls).not.toContain('eth_sendTransaction');
  await misfits.getByRole('button', { name: 'Cancel request' }).click();
  await expect(txPanel(misfits)).toHaveCount(0);
});

test('reject: the wallet declines (4001) → rejected, the entitlement is untouched', async ({ page }) => {
  test.skip(true, LEGACY_OFF);
  const bob = chain.accounts.bob;
  const misfitsLedger = launchContract('THE_MISFITS', 'rewardLedger');
  const before = callUint(misfitsLedger, 'claimable(address)(uint256)', [bob]);
  expect(before).toBeGreaterThan(0n);
  await openAs(page, bob, '/rewards');
  await connectAnvilWallet(page);
  const misfits = claimCard(page, 'The Misfits');
  await misfits.getByTestId('claim-button').click();
  await expect(txPanel(misfits)).toHaveAttribute('data-tx-status', 'awaiting_signature');
  await rejectNextSend(page);
  await misfits.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(txPanel(misfits)).toHaveAttribute('data-tx-status', 'rejected');
  expect((await walletState(page)).sent).toEqual([]);
  expect(callUint(misfitsLedger, 'claimable(address)(uint256)', [bob])).toBe(before);
});

test('simulation revert: a conversion whose deadline the chain has passed is refused with the decoded error', async ({ page }) => {
  test.skip(true, LEGACY_OFF);
  const bob = chain.accounts.bob;
  const snapshot = await rpc<string>('evm_snapshot');
  try {
    await openAs(page, bob, '/rewards');
    await connectAnvilWallet(page);
    const orchard = claimCard(page, 'ORCHARD');
    await expect(orchard.getByTestId('claim-button')).toContainText('Claim as');
    // The chain's clock moves 2 hours past the wall clock: the 20-minute deadline of the quote is already over.
    await rpc('evm_increaseTime', [7200]);
    await rpc('evm_mine');
    await orchard.getByTestId('claim-button').click();
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', 'simulation_failed');
    await expect(txPanel(orchard)).toContainText(/Expired/);
    expect((await walletState(page)).calls).not.toContain('eth_sendTransaction');
  } finally {
    await rpc('evm_revert', [snapshot]);
  }
});

test('no-trade audit on the chain source, wallet connected: no trade control on any page', async ({ page }) => {
  test.skip(true, LEGACY_OFF);
  await openAs(page, chain.accounts.alice, '/');
  await connectAnvilWallet(page);
  await audit(page, 'Feed');
  // Client-side navigation keeps the wallet connected (a reload starts disconnected, UI-09).
  await page.locator(`[data-pair-id="${MISFITS.appPairId}"]`).getByRole('link', { name: 'View The Misfits details' }).click();
  await expect(page).toHaveURL(new RegExp(`${route(MISFITS.appPairId)}$`));
  await expect(page.getByTestId('chain-market')).toBeVisible();
  await audit(page, 'Pair detail');
  // The launch-set navigation: Launch (/create, which opens the visual way, SH-254), Settings, About & risks. Claims and
  // Portfolio left the navigation; they are reached in the page (no reload, so the wallet stays connected).
  for (const [href, path] of [['/create', '/create/v2-picture'], ['/settings', '/settings'], ['/about/risks', '/about/risks']] as const) {
    await page.locator(`#primary-nav a[href="${href}"]`).evaluate((link: HTMLAnchorElement) => link.click());
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await audit(page, path);
  }
  for (const path of ['/create/kind', '/create/launch', '/create/overview', '/rewards', '/portfolio']) {
    await goInApp(page, path);
    await audit(page, path);
  }
  await expect(walletButton(page)).toHaveAccessibleName(/Anvil test wallet/);
  expect((await walletState(page)).calls.filter((method) => method === 'eth_sendTransaction')).toEqual([]);
});
