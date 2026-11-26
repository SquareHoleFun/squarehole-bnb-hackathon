#!/usr/bin/env node
/**
 * SH-274: the judge's walk. The BNB Chain testnet site, driven through its own controls in Chromium, with an injected
 * browser wallet whose every request is answered here, on the Node side:
 * - reads go to the chain's endpoint unchanged;
 * - eth_requestAccounts answers the walk's one account; wallet_switchEthereumChain to 0x61 answers null; anything else a
 *   wallet would refuse is refused;
 * - eth_sendTransaction is checked (from the walk's account, chain 97, a `to`, hex fields), printed, then signed and sent
 *   by `cast send --async` with exactly the request's fields. This script never holds a key: in live mode cast reads
 *   the keystore (--account, --password-file); in fork mode the anvil fork sends from an unlocked account.
 * Every send is logged with its hash, and its receipt is read from the chain here, whatever the page says.
 *
 *   node hackathon/scripts/judge-walk.mjs --fork <loopback anvil url> --site <local BNB site url> [--index <url>] --out <dir>
 *   node hackathon/scripts/judge-walk.mjs --live <origin> [--account <keystore name> --password-file <file>] [--create] --out <dir>
 *
 * Without --account, --live is a dry run: it checks the two endpoints and the gas price, lists the steps and sends
 * nothing. The walk stops at the first step that does not end as expected and says what to look at before a rerun. A
 * step whose effect is already on chain (an earlier run's mined send) is recognised from the chain and not sent again.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(ROOT, 'apps/web/package.json'));
const { chromium } = require('@playwright/test');
const { createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, http, keccak256, parseAbi, parseUnits } = require('viem');

// ------------------------------------------------------------------------------------------------ the chain's facts
const CHAIN_ID = 97;
const PROVIDERS = ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org'];
const COINS = JSON.parse(readFileSync(join(ROOT, 'packages/chain/src/trade-sepolia/coin-deployment-97.json'), 'utf8'));
const TETH = COINS.teth.address;
const coin = (symbol) => COINS.pairs.find((pair) => pair.symbol === symbol);
const BOXES = {
  gpu: { name: 'GPU Poor', token: '0x734C884B480159B3c993f2A95a45e81A36a13a27', ticker: 'VRAM', price: 'tNVDA' },
  rent: { name: 'Rent Free', token: '0x5539280794dd81763afE9dCAf326EF6c52327863', ticker: 'RENT', price: 'tUSDC' },
  cards: { name: 'Card Shop', token: '0x445A859675d9521167878FEe302dC83c6A5DDEb8', ticker: 'CARD', price: 'tUSDC' },
};
const FAUCET = parseAbi(['function nextDripAt(address) view returns (uint256)', 'function dailyRemaining() view returns (uint256)', 'function open() view returns (bool)']);
const NFT = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)', 'function ownerOf(uint256) view returns (address)']);
const SHOP = parseAbi(['function pick(address collection, uint256 id, uint256 maxT, address to) returns (uint256)', 'function give(address collection, uint256 id, uint256 minT) returns (uint256)']);
const NFT_APPROVE = parseAbi(['function approve(address to, uint256 id)']);
/** give(address,uint256,uint256) */
const SHOP_GIVE_SELECTOR = 'd9c24caf';
const MAX_LIVE_GAS_PRICE = 500_000_000n; // 0.5 gwei

// ------------------------------------------------------------------------------------------------------ the options
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };
const has = (name) => args.includes(name);
const fork = flag('--fork');
const live = flag('--live');
const out = resolve(flag('--out') ?? join(ROOT, '.cache/judge-walk', String(Date.now())));
const account = flag('--account');
const passwordFile = flag('--password-file');
const create = has('--create') || fork !== null;
// --steps 1,2,3: only these steps (a partial proof or rerun); every other one is skipped and said so.
const only = flag('--steps') ? new Set(flag('--steps').split(',').map((n) => Number(n.trim()))) : null;
// Fork mode only: --gpu <token> stands in for GPU Poor (a local stand's box priced in tNVDA); --page-rpc <url> is where
// the page's FIRST public endpoint goes (a proxy in front of the fork, say), the second still to --fork.
if (fork !== null && flag('--gpu')) BOXES.gpu.token = flag('--gpu');
const pageFirst = fork !== null ? flag('--page-rpc') ?? fork : null;
if ((fork === null) === (live === null)) throw new Error('usage: --fork <anvil url> --site <url> | --live <origin> [--account <name> --password-file <file>] [--create]');
if (fork !== null && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(fork)) throw new Error('--fork takes a loopback anvil url only');
if (live !== null && !/^https:\/\//.test(live)) throw new Error('--live takes the site\'s https origin');
if ((account === null) !== (passwordFile === null)) throw new Error('--account and --password-file go together');
const site = (fork !== null ? flag('--site') : live)?.replace(/\/$/, '');
if (!site) throw new Error('--fork needs --site <url of the local BNB site>');
const rpcUrl = fork ?? PROVIDERS[0];
const dry = live !== null && account === null;
mkdirSync(out, { recursive: true });

const STEPS = [
  '1 open the site, accept the notice, connect the wallet through the site\'s wallet window',
  '2 test coins: the drip (1 tETH a day), then the page\'s swaps to tNVDA and tUSDC',
  '3 GPU Poor (priced in tNVDA): buy a small amount, then sell half of what arrived',
  '4 Rent Free (priced in tUSDC): buy a small amount (its fees go to the houses: no claim for a token buyer)',
  '5 Card Shop: buy CARD, pick the cheapest card (a Common) out of the shop, read its owner back (picks only: sell-backs open 2 December)',
  `6 launch a box with the Visual form's defaults and a made-up name${create ? '' : ' (skipped: live mode without --create)'}`,
  '7 disconnect and connect again: nothing is sent, the holdings show',
];

// ------------------------------------------------------------------------------------------------------- the log
const log = [];
const say = (line) => { process.stdout.write(`${line}\n`); log.push(line); };
const rows = [];
/** Every transaction the walk sent (hash, receipt), and the one whose receipt is still awaited. */
const sends = [];
let pending = null;
const json = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const save = () => { writeFileSync(join(out, 'walk.json'), `${json({ mode: fork ? 'fork' : 'live', site, rpcUrl, rows, sends })}\n`); writeFileSync(join(out, 'walk.log'), `${log.join('\n')}\n`); };

async function rpc(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message ?? 'rpc error'), { code: body.error.code, data: body.error.data });
  return body.result;
}
const chain = createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) });

// ------------------------------------------------------------------------------------------------- the preflight
for (const url of fork ? [fork] : PROVIDERS) {
  const id = Number(BigInt(await rpc(url, 'eth_chainId')));
  if (id !== CHAIN_ID) throw new Error(`${url} answers chain ${id}, not ${CHAIN_ID}: nothing sent`);
}
const gasPrice = BigInt(await rpc(rpcUrl, 'eth_gasPrice'));
say(`chain ${CHAIN_ID} on ${fork ? 'the fork' : 'both providers'}; gas price ${gasPrice} wei`);
if (live && gasPrice > MAX_LIVE_GAS_PRICE) throw new Error(`gas price ${gasPrice} wei is above 0.5 gwei: nothing sent`);
say('the steps:');
for (const step of STEPS) say(`  ${step}`);
if (dry) { say('dry run (no --account): nothing opened, nothing sent'); save(); process.exit(0); }

// The walk's one account: the keystore's (cast reads it), or the fork's first unlocked account.
// --as <address> (fork mode, SH-291): the walk's account is that address, impersonated on the fork (a real wallet's state,
// such as a holder payout the live keeper settled, seen as that wallet sees it). Nothing reaches a real network.
const as = fork ? flag('--as') : null;
// --width <px> (SH-297): the window's width for the whole walk (1440 by default).
const walkWidth = Number(flag('--width') ?? 1440);
if (as !== null && !/^0x[0-9a-fA-F]{40}$/.test(as)) throw new Error('--as takes an address');
if (as !== null) { await rpc(fork, 'anvil_impersonateAccount', [as]); await rpc(fork, 'anvil_setBalance', [as, '0x56BC75E2D63100000']); }
const walker = fork ? as ?? (await rpc(fork, 'eth_accounts'))[0] : execFileSync('cast', ['wallet', 'address', '--account', account, '--password-file', passwordFile], { encoding: 'utf8' }).trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(walker)) throw new Error('no account');
say(`account ${walker}; balance ${formatUnits(await chain.getBalance({ address: walker }), 18)} BNB`);

// ------------------------------------------------------------------------------------------------------ the wallet
const HEX = /^0x[0-9a-fA-F]*$/;
const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;

async function receiptOf(hash, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [hash]).catch(() => null);
    if (receipt) return receipt;
    if (Date.now() > until) throw new Error(`no receipt for ${hash} within ${timeoutMs / 1000} s`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

/** One send, exactly as the page asked for it, by cast. */
async function sendTransaction(tx) {
  if (pending) await pending.catch(() => undefined); // the page goes on once it saw the receipt; this wallet too
  if (!tx || typeof tx !== 'object') throw Object.assign(new Error('no transaction'), { code: -32602 });
  if (String(tx.from).toLowerCase() !== walker.toLowerCase()) throw Object.assign(new Error('not this wallet\'s account'), { code: 4100 });
  if (tx.chainId !== undefined && BigInt(tx.chainId) !== BigInt(CHAIN_ID)) throw Object.assign(new Error('not chain 97'), { code: 4901 });
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(tx.to))) throw Object.assign(new Error('no destination'), { code: -32602 });
  for (const field of ['value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce']) {
    if (tx[field] !== undefined && !QUANTITY.test(String(tx[field]))) throw Object.assign(new Error(`${field} is not a hex quantity`), { code: -32602 });
  }
  if (tx.data !== undefined && !HEX.test(String(tx.data))) throw Object.assign(new Error('data is not hex'), { code: -32602 });
  const data = tx.data ?? tx.input ?? '0x';
  const record = { to: tx.to, selector: data.slice(0, 10), value: BigInt(tx.value ?? '0x0'), gas: tx.gas ? BigInt(tx.gas) : null,
    maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : null, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : null, nonce: tx.nonce ?? null };
  say(`  sign: to ${record.to} selector ${record.selector} value ${record.value} gas ${record.gas} fees ${record.maxFeePerGas}/${record.maxPriorityFeePerGas}${record.nonce ? ` nonce ${BigInt(record.nonce)}` : ''}`);
  const castArgs = ['send', '--async', '--rpc-url', rpcUrl, '--chain', String(CHAIN_ID),
    ...(fork ? ['--unlocked', '--from', walker] : ['--account', account, '--password-file', passwordFile]),
    '--value', record.value.toString(),
    ...(record.gas !== null ? ['--gas-limit', record.gas.toString()] : []),
    ...(record.maxFeePerGas !== null ? ['--gas-price', record.maxFeePerGas.toString()] : []),
    ...(record.maxPriorityFeePerGas !== null ? ['--priority-gas-price', record.maxPriorityFeePerGas.toString()] : []),
    ...(record.nonce !== null ? ['--nonce', BigInt(record.nonce).toString()] : []),
    record.to, ...(data !== '0x' ? [data] : [])];
  let hash;
  try { hash = execFileSync('cast', castArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\s+/).pop(); }
  catch (error) { say(`  cast refused: ${String(error.stderr ?? error.message).trim().split('\n').pop()}`); throw Object.assign(new Error('the wallet could not send it'), { code: -32603 }); }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Object.assign(new Error('cast gave no hash'), { code: -32603 });
  const entry = { ...record, data, hash, at: new Date().toISOString(), status: null, gasUsed: null, receipt: null };
  sends.push(entry);
  say(`  sent ${hash}`);
  pending = receiptOf(hash).then((receipt) => {
    entry.status = receipt.status; entry.gasUsed = BigInt(receipt.gasUsed); entry.effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? '0x0'); entry.receipt = receipt;
    say(`  receipt ${hash}: status ${receipt.status}, gas used ${entry.gasUsed}`);
  });
  return hash;
}

async function walletRequest({ method, params = [] }) {
  switch (method) {
    case 'eth_requestAccounts': case 'eth_accounts': return [walker];
    case 'eth_chainId': return `0x${CHAIN_ID.toString(16)}`;
    case 'net_version': return String(CHAIN_ID);
    case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain':
      if (BigInt(params[0]?.chainId ?? 0) === BigInt(CHAIN_ID)) return null;
      throw Object.assign(new Error('this wallet stays on chain 97'), { code: 4902 });
    case 'eth_sendTransaction': return sendTransaction(params[0]);
    case 'personal_sign': case 'eth_sign': case 'eth_signTypedData': case 'eth_signTypedData_v3': case 'eth_signTypedData_v4': case 'wallet_requestPermissions':
      say(`  the page asked ${method}: refused (the walk signs no message)`);
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    default: return rpc(rpcUrl, method, params);
  }
}

// ------------------------------------------------------------------------------------------------------- the page
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: walkWidth, height: walkWidth >= 1000 ? 1000 : 844 } });
// SH-291: what the page asks of the chain's endpoints and of the index (fork mode: every request is routed here).
const asked = { rpcRequests: 0, rpcCalls: 0, methods: {}, index: 0, to: {} };
let rpcRefusals = 0;
if (fork) {
  // The fork stands in for chain 97: the site's two public read endpoints and, given --index, its index answer from here.
  const index = flag('--index');
  await context.route(/.*/, async (route) => {
    const url = route.request().url();
    const to = url.startsWith(PROVIDERS[0]) ? pageFirst : PROVIDERS.some((p) => url.startsWith(p)) ? fork : index && url.startsWith('https://index.bnb.test') ? index + url.slice('https://index.bnb.test'.length) : null;
    if (!to) return route.continue();
    if (route.request().method() === 'POST' && to !== null && !url.startsWith('https://index.bnb.test')) {
      asked.rpcRequests += 1;
      try {
        const body = JSON.parse(route.request().postData() ?? 'null');
        for (const call of Array.isArray(body) ? body : [body]) {
          asked.rpcCalls += 1; asked.methods[call?.method] = (asked.methods[call?.method] ?? 0) + 1;
          if (call?.method === 'eth_call') { const key = `${String(call.params?.[0]?.to ?? '').toLowerCase()} ${String(call.params?.[0]?.data ?? '').slice(0, 10)}`; asked.to[key] = (asked.to[key] ?? 0) + 1; }
        }
      } catch { /* not JSON */ }
    } else if (url.startsWith('https://index.bnb.test') && route.request().method() === 'GET') asked.index += 1;
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
    const response = await fetch(to, { method: route.request().method(), headers: { 'content-type': 'application/json' }, body: route.request().method() === 'GET' ? undefined : route.request().postData() ?? undefined }).catch(() => null);
    if (!response) return route.fulfill({ status: 502, body: 'unreachable' });
    const bytes = Buffer.from(await response.arrayBuffer());
    // --trace: the chain endpoints' refusals, each with its method (at most 40 lines a walk).
    if (has('--trace') && route.request().method() === 'POST' && !url.startsWith('https://index.bnb.test') && rpcRefusals < 40) {
      try {
        const sent = JSON.parse(route.request().postData() ?? 'null'); const got = JSON.parse(bytes.toString('utf8'));
        const methods = new Map((Array.isArray(sent) ? sent : [sent]).map((call) => [call?.id, `${call?.method} ${JSON.stringify(call?.params ?? []).slice(0, 160)}`]));
        for (const answer of Array.isArray(got) ? got : [got]) if (answer?.error && rpcRefusals < 40) { rpcRefusals += 1; say(`  rpc refused: ${methods.get(answer.id)} -> ${JSON.stringify(answer.error).slice(0, 200)}`); }
      } catch { if (response.status !== 200 && rpcRefusals < 40) { rpcRefusals += 1; say(`  rpc refused: HTTP ${response.status}`); } }
    }
    return route.fulfill({ status: response.status, headers: { 'access-control-allow-origin': '*', 'content-type': response.headers.get('content-type') ?? 'application/json' }, body: bytes });
  });
}
await context.exposeFunction('judgeWalletRequest', walletRequest);
await context.addInitScript(() => {
  const provider = { isJudgeWalk: true, request: (request) => window.judgeWalletRequest(request), on() {}, removeListener() {} };
  window.ethereum = provider;
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: { info: { uuid: '4d2c7a50-6a1e-4c5b-9b7e-2f3a1c9e8d74', name: 'Judge walk wallet', rdns: 'org.example.judge-walk', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
  })));
});
const page = await context.newPage();
page.setDefaultTimeout(60_000);
// --trace (a stand's diagnosis, SH-278): the page's console errors and warnings, and its uncaught errors, in the log.
if (has('--trace')) {
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') say(`  console ${message.type()}: ${message.text().slice(0, 300)}`); });
  page.on('pageerror', (error) => say(`  page error: ${String(error.message).slice(0, 300)}`));
}

// -------------------------------------------------------------------------------------------------- the step frame
let stepNo = 0;
async function shot(name) { await page.screenshot({ path: join(out, `${String(stepNo).padStart(2, '0')}-${name}.png`), fullPage: true }).catch(() => undefined); }
async function step(title, run) {
  stepNo += 1;
  if (only && !only.has(stepNo)) { say(`step ${stepNo} skipped (--steps): ${title}`); return; }
  const before = sends.length;
  say(`step ${stepNo}: ${title}`);
  await shot('before');
  try {
    const row = await run();
    if (pending) await pending;
    await shot('after');
    const mine = sends.slice(before);
    const failed = mine.find((s) => s.status !== '0x1');
    if (failed) throw new Error(`send ${failed.hash} ended with status ${failed.status}`);
    rows.push({ step: stepNo, title, ...row, sends: mine.map((s) => ({ hash: s.hash, to: s.to, selector: s.selector, status: s.status, gasUsed: s.gasUsed })) });
    say(`  ok: ${row.proof}`);
    save();
  } catch (error) {
    await shot('stopped');
    rows.push({ step: stepNo, title, stopped: String(error.message ?? error) });
    say(`STOPPED at step ${stepNo} (${title}): ${error.message ?? error}`);
    say(`before a rerun: look at the screenshots ${join(out, `${String(stepNo).padStart(2, '0')}-*.png`)}, the last sends above (their hashes on testnet.bscscan.com) and the page's line; a step already done on chain is not sent again`);
    save();
    await browser.close();
    process.exit(1);
  }
}
const statusText = async (scope) => (await scope.getByRole('status').allTextContents().catch(() => [])).join(' | ') || null;
/** Waits until a send to one of `targets` made after `since` has its receipt. */
async function sentTo(targets, since, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  const wanted = targets.map((t) => t.toLowerCase());
  for (;;) {
    const found = sends.slice(since).find((s) => wanted.includes(s.to.toLowerCase()) && s.status !== null);
    if (found) return found;
    if (Date.now() > until) throw new Error(`no mined send to ${targets.join(' or ')} within ${timeoutMs / 1000} s`);
    await page.waitForTimeout(1_000);
  }
}
const balance = (token, owner = walker) => chain.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
const tradeBox = () => page.getByRole('region', { name: 'Buy and sell' });
const boxPath = (box) => `${site}/box/97/${box.token.toLowerCase()}`;
const decimal = (raw, decimals) => formatUnits(raw, decimals);

// ------------------------------------------------------------------------------------------------------- the walk
await step('open the site, accept the notice, connect the wallet', async () => {
  await page.goto(`${site}/`, { waitUntil: 'domcontentloaded' });
  const tick = page.getByRole('checkbox');
  if (await tick.count()) { await tick.first().check(); await page.getByRole('button', { name: 'Accept' }).click(); }
  await page.getByRole('button', { name: /Connect wallet/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  await dialog.getByRole('button', { name: /Judge walk wallet/ }).click();
  await page.waitForFunction((short) => document.body.innerText.toLowerCase().includes(short), `${walker.slice(0, 6)}`.toLowerCase(), { timeout: 30_000 });
  return { status: 'connected', proof: `the header shows ${walker.slice(0, 6)}…; no transaction` };
});

await step('test coins: the drip, then swaps to tNVDA and tUSDC', async () => {
  await page.goto(`${site}/test-coins`, { waitUntil: 'domcontentloaded' });
  const faucet = page.getByRole('region', { name: 'Faucet' });
  const now = (await chain.getBlock()).timestamp;
  const next = await chain.readContract({ address: TETH, abi: FAUCET, functionName: 'nextDripAt', args: [walker] });
  const before = await balance(TETH);
  const notes = [];
  if (next > now) notes.push(`no drip: this account's next drip is ${new Date(Number(next) * 1000).toISOString()} (the faucet gives 1 tETH a day)`);
  else {
    const since = sends.length;
    const get = faucet.getByRole('button', { name: /^Get 1 tETH$/ });
    await get.waitFor({ state: 'visible' });
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Get 1 tETH$/.test(x.textContent ?? '')); return b && !b.disabled; }, null, { timeout: 60_000 });
    await get.click();
    await sentTo([TETH], since);
    notes.push('dripped 1 tETH');
  }
  const swap = page.getByRole('region', { name: 'Swap' });
  for (const [symbol, amount] of [['tNVDA', '0.05'], ['tUSDC', '0.1']]) {
    const target = coin(symbol);
    const have = await balance(target.coin);
    if (have > 0n) { notes.push(`already holds ${decimal(have, target.decimals)} ${symbol}: no swap`); continue; }
    const since = sends.length;
    await swap.getByRole('combobox', { name: 'Coin' }).selectOption({ label: symbol });
    await swap.getByRole('textbox', { name: 'Amount in tETH' }).fill(amount);
    const go = swap.getByRole('button', { name: 'Swap', exact: true });
    await go.waitFor({ state: 'visible' });
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Swap'); return b && !b.disabled; }, null, { timeout: 60_000 });
    await go.click();
    await sentTo([COINS.poolSwapTest], since);
    notes.push(`swapped ${amount} tETH for ${decimal(await balance(target.coin), target.decimals)} ${symbol}`);
  }
  const teth = await balance(TETH);
  return { status: await statusText(page.getByRole('region', { name: 'Test coins' })), proof: `${notes.join('; ')}; tETH ${decimal(before, 18)} -> ${decimal(teth, 18)}; tNVDA ${decimal(await balance(coin('tNVDA').coin), 18)}; tUSDC ${decimal(await balance(coin('tUSDC').coin), 6)}` };
});

/** One trade in the box's own trade box: the side, the amount, one press (an approval first when needed), mined. */
async function trade(box, side, amount, unit) {
  const since = sends.length;
  await tradeBox().getByRole('radio', { name: side }).check();
  // A local stand's box (--gpu) may show its coins by address, not by symbol: any "Amount in" field there.
  const field = flag('--gpu') && box === BOXES.gpu ? /^Amount in / : `Amount in ${unit}`;
  await tradeBox().getByRole('textbox', { name: field }).fill(amount);
  const press = tradeBox().getByRole('button', { name: side, exact: true });
  await press.waitFor({ state: 'visible' });
  const until = Date.now() + 60_000;
  while (await press.isDisabled()) { if (Date.now() > until) throw new Error(`${side} stays disabled: ${await statusText(tradeBox())}`); await page.waitForTimeout(500); }
  await press.click();
  return sentTo([COINS.poolSwapTest], since);
}

await step('GPU Poor: buy a small amount, then sell half of what arrived', async () => {
  const box = BOXES.gpu;
  await page.goto(boxPath(box), { waitUntil: 'domcontentloaded' });
  await tradeBox().waitFor({ state: 'visible' });
  const start = await balance(box.token);
  await trade(box, 'Buy', flag('--gpu') ? '0.0001' : '0.01', 'tNVDA');
  const bought = (await balance(box.token)) - start;
  if (bought <= 0n) throw new Error('the buy mined but no VRAM arrived');
  await page.waitForTimeout(3_000);
  const half = bought / 2n;
  await trade(box, 'Sell', formatUnits(half, 18), box.ticker);
  const end = await balance(box.token);
  return { status: await statusText(tradeBox()), proof: `VRAM ${decimal(start, 18)} -> +${decimal(bought, 18)} bought -> ${decimal(end, 18)} after selling ${decimal(half, 18)}` };
});

await step('Rent Free: buy a small amount', async () => {
  const box = BOXES.rent;
  await page.goto(boxPath(box), { waitUntil: 'domcontentloaded' });
  await tradeBox().waitFor({ state: 'visible' });
  const start = await balance(box.token);
  await trade(box, 'Buy', '0.02', 'tUSDC');
  const got = (await balance(box.token)) - start;
  if (got <= 0n) throw new Error('the buy mined but no RENT arrived');
  // A token buyer of Rent Free gets no claim (its fees go to the houses): none is expected here.
  return { status: await statusText(tradeBox()), proof: `RENT +${decimal(got, 18)}` };
});

await step('Card Shop: buy CARD, pick the cheapest card, read its owner back', async () => {
  const box = BOXES.cards;
  await page.goto(boxPath(box), { waitUntil: 'domcontentloaded' });
  await tradeBox().waitFor({ state: 'visible' });
  const shop = page.getByRole('region', { name: 'Shop', exact: true });
  if (!(await shop.count())) {
    const tab = page.getByRole('tab', { name: /Shop|Items|Inside/ });
    if (await tab.count()) await tab.first().click();
  }
  await shop.waitFor({ state: 'visible' });
  // --shop-look (SH-297): the Shop card as a visitor meets it (its (?) closed) and with the (?) open.
  if (has('--shop-look')) {
    const w = page.viewportSize()?.width ?? 1440;
    await page.waitForTimeout(6_000);
    await shop.screenshot({ path: join(out, `shop-closed-${w}.png`) }).catch((error) => say(`  look: ${error.message}`));
    const about = shop.getByRole('button', { name: 'About the shop' });
    if (await about.count()) {
      await about.click(); await page.waitForTimeout(800);
      await shop.screenshot({ path: join(out, `shop-open-${w}.png`) }).catch((error) => say(`  look: ${error.message}`));
      await about.click();
    } else say('  look: no (?) on the Shop card');
    say(`  look: the Shop card at ${w} px, the page wider than the window by ${await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)} px`);
  }
  const pick = shop.locator('section', { has: page.getByRole('heading', { name: 'Pick an item', level: 3 }) });
  const items = pick.getByRole('list', { name: 'Items inside' }).getByRole('button');
  await items.first().waitFor({ state: 'visible' });
  const labels = await items.allTextContents();
  const aria = await items.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? ''));
  // The cheapest: the smallest price in the items' names ("<collection> #<id>, <price> CARD").
  const priced = aria.map((label, i) => ({ i, label, price: Number((label.match(/, ([\d,.]+) CARD$/)?.[1] ?? 'NaN').replace(/,/g, '')) })).filter((x) => Number.isFinite(x.price)).sort((a, b) => a.price - b.price);
  if (!priced.length) throw new Error(`no priced item in the shop (${labels.length} items)`);
  const cheapest = priced[0];
  const needRaw = parseUnits(String(cheapest.price), 18);
  const have = await balance(box.token);
  if (have < needRaw) {
    // The card's price in CARD is fixed; CARD's price in tUSDC moves with the market: a larger buy when a small one is short.
    for (const amount of ['0.02', '0.2', '1']) {
      if ((await balance(box.token)) >= needRaw) break;
      await trade(box, 'Buy', amount, 'tUSDC');
      await page.waitForTimeout(2_000);
    }
    if ((await balance(box.token)) < needRaw) throw new Error(`1.22 tUSDC bought too little CARD for ${cheapest.label}`);
    await page.waitForTimeout(3_000);
  }
  // SH-297: the chosen card arms Pick with its price ("Pick · 2,000,000 CARD"); the shop follows a mined buy in the trade
  // box without a reload (SH-274's fix): Pick is off while the wallet's CARD reads short.
  const waitedFrom = Date.now();
  await items.nth(cheapest.i).click();
  const shopLag = `${Math.round((Date.now() - waitedFrom) / 1000)} s after the buy, without a reload`;
  const said = shop.locator('.sh-v2-shop-actions > [role="status"]');
  // SH-297: one press of Pick, its approval first when one is needed; no other button, no confirmation. The pick area is
  // photographed before, while the press runs and after it (`pick-<when>-<width>.png`).
  const width = page.viewportSize()?.width ?? 1440;
  const shot = (when) => pick.screenshot({ path: join(out, `pick-${when}-${width}.png`) }).catch((error) => say(`  look: ${error.message}`));
  if (await pick.getByRole('button', { name: new RegExp(`^Approve`) }).count()) throw new Error('an Approve button is still shown beside Pick');
  const since = sends.length;
  const paidBefore = await balance(box.token);
  const go = pick.getByRole('button', { name: /^Pick/ });
  const until = Date.now() + 60_000;
  while (await go.isDisabled()) { if (Date.now() > until) throw new Error(`Pick stays disabled: ${await statusText(shop)}`); await page.waitForTimeout(500); }
  await shot('before');
  await go.click();
  await page.waitForTimeout(1_500);
  await shot('during');
  const during = await pick.locator('.sh-v2-actions button').first().textContent().catch(() => '');
  await said.waitFor({ state: 'visible', timeout: 240_000 });
  if (await page.getByRole('group', { name: 'Confirm transaction' }).count()) throw new Error('a confirmation was asked for');
  const sent = await new Promise((done, fail) => { const t = setInterval(() => { const s = sends.slice(since).find((x) => x.status !== null && x.to.toLowerCase() !== box.token.toLowerCase()); if (s) { clearInterval(t); done(s); } }, 1_000); setTimeout(() => { clearInterval(t); fail(new Error('no pick mined within 180 s')); }, 180_000); });
  await page.waitForTimeout(2_000);
  await shot('after');
  // What the press sent: the approval (exactly the price, to the shop) when it needed one, and the pick with that price
  // as its maximum; what the wallet paid is the price, to the unit.
  const pressed = sends.slice(since);
  const approvals = pressed.filter((x) => x.to.toLowerCase() === box.token.toLowerCase());
  const approved = approvals.map((x) => { const d = decodeFunctionData({ abi: erc20Abi, data: x.data }); return { spender: d.args[0], amount: d.args[1] }; });
  const pickCall = decodeFunctionData({ abi: SHOP, data: sent.data });
  const paid = paidBefore - await balance(box.token);
  if (pickCall.args[2] !== needRaw || paid !== needRaw || approved.some((a) => a.amount !== needRaw || a.spender.toLowerCase() !== sent.to.toLowerCase())) {
    throw new Error(`the press paid ${paid}, approved ${approved.map((a) => `${a.amount} to ${a.spender}`).join(', ')}, picked at most ${pickCall.args[2]}; the price is ${needRaw}`);
  }
  // The card: the Transfer in the pick's receipt, then its owner read from the collection.
  const transfer = sent.receipt.logs.map((entry) => { try { return { address: entry.address, ...decodeEventLog({ abi: NFT, data: entry.data, topics: entry.topics }) }; } catch { return null; } })
    .find((e) => e && e.eventName === 'Transfer' && e.args.to.toLowerCase() === walker.toLowerCase() && e.args.tokenId !== undefined && e.topics?.length !== 3);
  if (!transfer) throw new Error('the pick mined without a card transfer to this account');
  const owner = await chain.readContract({ address: transfer.address, abi: NFT, functionName: 'ownerOf', args: [transfer.args.tokenId] });
  if (owner.toLowerCase() !== walker.toLowerCase()) throw new Error(`the card's owner is ${owner}`);
  return { status: await said.textContent(), proof: `one press: ${pressed.length} transactions (${approvals.length ? `approve ${approved[0].amount} to the shop, then ` : ''}pick at most ${pickCall.args[2]}); the button said "${during}" meanwhile; paid ${paid} (the price ${needRaw}); picked ${cheapest.label}; ownerOf(${transfer.args.tokenId}) on ${transfer.address} = this account; the shop showed the bought CARD ${shopLag}` };
});

/** A plain 512 x 512 PNG (one colour), for the logo the form asks for. */
function logoPng() {
  const size = 512;
  const crcOf = (buffer) => zlib.crc32(buffer);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crcOf(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x5a)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

if (create) {
  // --look (a stand's layout proof, SH-276): before Create, the overview's Opening table at 1440 and 390 px; after it,
  // the box list and the new box's page at 1440 px, with the list's card heights and the page's raise figures.
  const looks = async (stage, href) => {
    const pic = (name) => join(out, `look-${name}.png`);
    if (stage === 'overview') {
      const opening = page.locator('section.sh-newbox-group').filter({ has: page.getByRole('heading', { name: 'Opening' }) });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
        await page.waitForTimeout(800);
        await opening.first().screenshot({ path: pic(`opening-${width}`) }).catch((error) => say(`  look: ${error.message}`));
        await page.screenshot({ path: pic(`overview-${width}`), fullPage: true });
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        const rows = await opening.first().locator('.sh-newbox-row').evaluateAll((list) => list.map((row) => {
          const [dt, dd] = [row.querySelector('dt'), row.querySelector('dd')];
          const r = (el) => { const range = document.createRange(); range.selectNodeContents(el); const b = range.getBoundingClientRect(); return Math.round(b.right); };
          return `${dt?.textContent}: label text ends ${dt ? r(dt) : '?'} px, value starts ${dd ? Math.round(dd.getBoundingClientRect().left) : '?'} px`;
        }));
        say(`  look: overview at ${width} px, page wider than the window by ${wide} px; ${rows.join('; ')}`);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      return;
    }
    const box = href.match(/0x[0-9a-fA-F]{40}/)[0].toLowerCase();
    await page.goto(`${site}/`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('li.sh-box-card').filter({ has: page.locator(`a[href*="${box}" i]`) });
    await card.first().waitFor({ state: 'visible', timeout: 120_000 }).catch(() => say('  look: no card for the new box'));
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: pic('list-1440'), fullPage: true });
    const cards = await page.locator('li.sh-box-card').evaluateAll((list, b) => list.map((c) => {
      const r = c.getBoundingClientRect();
      return `${c.innerHTML.toLowerCase().includes(b) ? 'NEW ' : ''}top ${Math.round(r.top)} height ${Math.round(r.height)} "${c.querySelector('.sh-box-card__figure')?.textContent ?? ''}"`;
    }), box);
    say(`  look: cards: ${cards.join(' | ')}`);
    await page.goto(href.startsWith('/') ? `${site}${href}` : href, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: pic('box-1440'), fullPage: true });
    const figures = (await page.locator('main').innerText()).replace(/\s+/g, ' ').match(/[0-9.]+ \/ [0-9.]+ ?[A-Za-z0-9.…]+/g) ?? [];
    say(`  look: the box page's raise figures: ${figures.join(' | ') || '(none)'}`);
  };
  await step('launch a box with the Visual form\'s defaults and a made-up name', async () => {
    const stamp = String(Date.now()).slice(-5);
    const name = `Judge Walk ${stamp}`;
    const ticker = `JW${stamp}`;
    // The name, ticker and logo through the form's Basics (the draft the Visual form shows); everything else its defaults.
    await page.goto(`${site}/create/v2-basics`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await page.getByRole('textbox', { name: 'Ticker' }).fill(ticker);
    await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoPng() });
    await page.getByRole('button', { name: 'Logo Change' }).waitFor({ state: 'attached' });
    // The Visual form's defaults leave two choices to the person ("Pick what's in the box", "Confirm your rights"):
    // the walk makes them as a judge would: a plain token box (Contents, step 2) and the rights box (step 5).
    const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
    await next(); await page.getByRole('radio', { name: /^Token/ }).check();
    await next(); await next(); await next();
    await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
    // Then the Visual form (the same draft), and its own Overview button.
    await page.getByRole('navigation', { name: 'Launch' }).getByRole('link', { name: 'Visual' }).click();
    await page.waitForURL(/\/create\/v2-picture$/);
    const rights = page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' });
    for (let round = 0; round < 3 && /v2-picture$/.test(page.url()); round += 1) {
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await page.waitForTimeout(2_000);
      if (!/v2-picture$/.test(page.url())) break;
      const issues = page.locator('.sh-pic-issues');
      const text = (await issues.first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      say(`  the Visual form says: ${text || '(nothing)'}`);
      if (await rights.count()) { await rights.first().check(); continue; }
      throw new Error(`the Visual form with its defaults does not reach Overview: ${text || 'no line'}`);
    }
    if (await rights.count() && !(await rights.first().isChecked())) await rights.first().check();
    const press = page.getByRole('button', { name: /^(Create|Continue)$/ });
    await press.first().waitFor({ state: 'visible' });
    const plan = (await page.getByRole('list').filter({ hasText: 'Create the box' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    say(`  the plan: ${plan}`);
    const until = Date.now() + 120_000;
    while (await press.first().isDisabled()) { if (Date.now() > until) throw new Error(`Create stays disabled: ${(await page.locator('main').innerText()).slice(0, 300)}`); await page.waitForTimeout(1_000); }
    if (has('--look')) await looks('overview');
    await press.first().click();
    const open = page.getByRole('link', { name: 'Open your box' });
    if (has('--trace')) {
      // Every change of the page's status and alert lines, with the seconds since the press, until the box link shows
      // or --create-wait seconds (default 600) have passed.
      const pressed = Date.now(); const wait = Number(flag('--create-wait') ?? 600) * 1000; let last = '';
      for (;;) {
        if (await open.isVisible()) { say(`  trace ${Math.round((Date.now() - pressed) / 1000)} s: the box link shows`); break; }
        const lines = [...await page.getByRole('status').allTextContents().catch(() => []), ...await page.getByRole('alert').allTextContents().catch(() => [])].join(' | ').replace(/\s+/g, ' ');
        if (lines !== last) { say(`  trace ${Math.round((Date.now() - pressed) / 1000)} s: ${lines || '(no status or alert line)'}`); last = lines; }
        if (Date.now() - pressed > wait) { await shot('trace-end'); throw new Error(`no box link ${wait / 1000} s after the press; the page says: ${lines || 'nothing'}`); }
        await page.waitForTimeout(1_000);
      }
    } else await open.waitFor({ state: 'visible', timeout: 600_000 });
    const href = await open.getAttribute('href');
    const token = href?.match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (!token) throw new Error(`no box address in ${href}`);
    const onChain = await chain.readContract({ address: token, abi: parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']), functionName: 'name' });
    if (onChain !== name) throw new Error(`the box token's name is "${onChain}", not "${name}"`);
    const result = { status: await statusText(page.locator('main')), proof: `box ${token}: name() = "${onChain}" (${ticker})` };
    if (has('--look')) await looks('created', href);
    return result;
  });
} else say('step 6 skipped (live mode without --create)');

await step('disconnect and connect again: nothing sent, the holdings show', async () => {
  const before = sends.length;
  await page.goto(`${site}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: new RegExp(walker.slice(2, 6), 'i') }).first().click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('button', { name: /Connect wallet/ }).first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /Connect wallet/ }).first().click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Judge walk wallet/ }).click();
  await page.goto(`${site}/my-box`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);
  if (sends.length !== before) throw new Error('a transaction was asked for on reconnect');
  const text = (await page.locator('main').innerText().catch(() => '')).slice(0, 400).replace(/\s+/g, ' ');
  return { status: text, proof: `no transaction; VRAM ${decimal(await balance(BOXES.gpu.token), 18)}, RENT ${decimal(await balance(BOXES.rent.token), 18)}, CARD ${decimal(await balance(BOXES.cards.token), 18)} on chain` };
});

/** The Card Shop's vault and collection, as the --give step's mined give names them (for --shop-notes). */
let cardShop = null;
// --give (fork mode, SH-297): one of the wallet's own cards given to the Card Shop with one press of Give; the approval
// is that one card's to the shop, the give's minimum the price shown; the card ends in the shop, the CARD in the wallet.
if (has('--give') && fork) await step('Card Shop: give one of the wallet\'s cards with one press', async () => {
  const box = BOXES.cards;
  await page.goto(boxPath(box), { waitUntil: 'domcontentloaded' });
  const shop = page.getByRole('region', { name: 'Shop', exact: true });
  await shop.waitFor({ state: 'visible' });
  const give = shop.locator('section', { has: page.getByRole('heading', { name: 'Give an item', level: 3 }) });
  const yours = give.getByRole('list', { name: 'Your items' }).getByRole('button');
  await yours.first().waitFor({ state: 'visible', timeout: 120_000 });
  const tiles = await yours.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? ''));
  say(`  your cards: ${tiles.join(' | ')}`);
  await yours.first().click();
  const go = give.getByRole('button', { name: /^Give/ });
  const until = Date.now() + 60_000;
  while (await go.isDisabled()) { if (Date.now() > until) throw new Error(`Give stays disabled: ${await statusText(give)}`); await page.waitForTimeout(500); }
  const label = await go.textContent();
  const since = sends.length; const before = await balance(box.token);
  const w = page.viewportSize()?.width ?? 1440;
  await give.screenshot({ path: join(out, `give-before-${w}.png`) }).catch(() => undefined);
  await go.click();
  await page.waitForTimeout(1_500);
  await give.screenshot({ path: join(out, `give-during-${w}.png`) }).catch(() => undefined);
  const said = shop.locator('.sh-v2-shop-actions > [role="status"]');
  await said.waitFor({ state: 'visible', timeout: 240_000 });
  await page.waitForTimeout(3_000);
  await give.screenshot({ path: join(out, `give-after-${w}.png`) }).catch(() => undefined);
  const pressed = sends.slice(since);
  const gave = pressed.find((x) => x.status !== null && x.selector === '0x' + SHOP_GIVE_SELECTOR);
  if (!gave) throw new Error(`no give mined: ${await said.textContent()}`);
  const call = decodeFunctionData({ abi: SHOP, data: gave.data });
  cardShop = { vault: gave.to, collection: call.args[0] };
  const approvals = pressed.filter((x) => x.to.toLowerCase() === String(call.args[0]).toLowerCase());
  const approved = approvals.map((x) => decodeFunctionData({ abi: NFT_APPROVE, data: x.data }));
  if (approved.some((a) => a.functionName !== 'approve' || a.args[0].toLowerCase() !== gave.to.toLowerCase() || a.args[1] !== call.args[1])) throw new Error('an approval other than this one card to the shop');
  const owner = await chain.readContract({ address: call.args[0], abi: NFT, functionName: 'ownerOf', args: [call.args[1]] });
  const got = (await balance(box.token)) - before;
  if (owner.toLowerCase() !== gave.to.toLowerCase() || got !== call.args[2]) throw new Error(`the card's owner is ${owner}; got ${got}, the give's minimum ${call.args[2]}`);
  return { status: await said.textContent(), proof: `one press of "${label}": ${pressed.length} transactions (${approvals.length ? `approve(shop, ${call.args[1]}) on ${call.args[0]}, then ` : ''}give(${call.args[0]}, ${call.args[1]}, min ${call.args[2]})); got ${got} CARD; ownerOf(${call.args[1]}) = the shop` };
});

// --shop-notes (fork mode, SH-297 notes; after --give): the Give group's new states photographed at the walk's width.
// Each state is made on the fork only, never on a real network: (1) a second card of the shop's collection picked with
// direct sends (approve its price, pick), so a card stays to choose after this week's give; (2) a collection the shop
// takes later: the shop collection's code copied to a new address, its card 1 written to the wallet and sent to itself
// (one Transfer to the wallet), named "Old Set", added by the curator (impersonated), so it takes gives after the
// vault's delay; (3) a card the read cannot find: the wallet's count in the shop's collection raised by one (a card
// with no Transfer anywhere stands for one received before the read's walk back). Pictures: before a choice, the
// shop's card chosen (the limit line with its renewal day), the later card chosen (its start), and My Box.
if (has('--shop-notes') && fork) await step('Card Shop notes: the give line for the chosen card only, limits with their renewal day, a later collection\'s day on its tile, older cards counted', async () => {
  // The shop's vault and collection: from this walk's give, or (a second look on the same fork) --card-shop <vault>,<collection>.
  const named = flag('--card-shop')?.split(',');
  const { vault, collection } = cardShop ?? (named?.length === 2 ? { vault: named[0], collection: named[1] } : {});
  if (!vault || !collection) throw new Error('--shop-notes needs --give first or --card-shop <vault>,<collection>');
  say(`  card shop ${vault},${collection}`);
  const VAULT = parseAbi(['function curator() view returns (address)', 'function nextAdditionAt() view returns (uint256)', 'function addCollection(address collection, uint8 tier)', 'function collectionTerms(address collection) view returns (uint256 giveT, uint256 pickT, uint256 activeAt)']);
  const ERC = parseAbi(['function ownerOf(uint256) view returns (address)', 'function balanceOf(address) view returns (uint256)', 'function transferFrom(address from, address to, uint256 id)']);
  const read = (address, abi, functionName, args = []) => chain.readContract({ address, abi, functionName, args });
  const send = async (from, to, data) => {
    const hash = await rpc(fork, 'eth_sendTransaction', [{ from, to, data, gas: '0x7a1200' }]);
    const receipt = await receiptOf(hash);
    if (receipt.status !== '0x1') throw new Error(`a fork send to ${to} failed: ${hash}`);
    return hash;
  };
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const slotOf = (key, slot) => keccak256(`0x${word(key)}${word(slot)}`);
  const box = BOXES.cards; const w = page.viewportSize()?.width ?? 1440;
  const copy = '0x0000000000000000000000000000000000005297';
  // Made once per fork: a second look on the same fork photographs the states only.
  const made = (await read(vault, VAULT, 'collectionTerms', [copy]))[2] !== 0n;
  if (made) say(`  fork: the states exist already (${copy} listed); photographs only`);
  else {
  // (1) A second card of the shop's collection.
  const [, pickT] = await read(vault, VAULT, 'collectionTerms', [collection]);
  let id = null;
  for (let i = 1n; i <= 200n && id === null; i += 1n) {
    const owner = await read(collection, ERC, 'ownerOf', [i]).catch(() => null);
    if (owner && owner.toLowerCase() === vault.toLowerCase()) id = i;
  }
  if (id === null) throw new Error('no card inside the shop to pick');
  for (const amount of ['0.2', '1']) {
    if ((await balance(box.token)) >= pickT) break;
    await page.goto(boxPath(box), { waitUntil: 'domcontentloaded' }); await tradeBox().waitFor({ state: 'visible' });
    await trade(box, 'Buy', amount, 'tUSDC'); await page.waitForTimeout(2_000);
  }
  await send(walker, box.token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, pickT] }));
  await send(walker, vault, encodeFunctionData({ abi: SHOP, functionName: 'pick', args: [collection, id, pickT, walker] }));
  // (1b) This week's limit reached: the picked card given back and picked again (direct sends) until the shop refuses
  // the give; the wallet then holds the card a give would put over the limit. The CARD for the picks: from the box's
  // creator, impersonated (fork only).
  const [giveT] = await read(vault, VAULT, 'collectionTerms', [collection]);
  const creator = '0x2EF9A78074bbf674bEA16f21154a30c821A3C576';
  await rpc(fork, 'anvil_impersonateAccount', [creator]); await rpc(fork, 'anvil_setBalance', [creator, '0x56BC75E2D63100000']);
  await send(creator, box.token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [walker, 30n * pickT] }));
  await send(walker, box.token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, 30n * pickT] }));
  await send(walker, collection, encodeFunctionData({ abi: parseAbi(['function setApprovalForAll(address operator, bool approved)']), functionName: 'setApprovalForAll', args: [vault, true] }));
  let rounds = 0;
  for (; rounds < 25; rounds += 1) {
    try { await send(walker, vault, encodeFunctionData({ abi: SHOP, functionName: 'give', args: [collection, id, giveT] })); }
    catch { break; }
    await send(walker, vault, encodeFunctionData({ abi: SHOP, functionName: 'pick', args: [collection, id, pickT, walker] }));
  }
  if (rounds === 25) throw new Error('25 gives and no limit reached');
  // (2) A collection the shop takes later. Its storage slots found by probing the shop's collection (owners, balances).
  const count = await read(collection, ERC, 'balanceOf', [walker]);
  let owners = null; let balances = null;
  for (let slot = 0n; slot < 24n && (owners === null || balances === null); slot += 1n) {
    if (owners === null && BigInt(await rpc(fork, 'eth_getStorageAt', [collection, slotOf(id, slot), 'latest'])) === BigInt(walker)) owners = slot;
    if (balances === null && BigInt(await rpc(fork, 'eth_getStorageAt', [collection, slotOf(walker, slot), 'latest'])) === count) balances = slot;
  }
  if (owners === null || balances === null) throw new Error(`the collection's owner and balance slots were not found (owners ${owners}, balances ${balances})`);
  await rpc(fork, 'anvil_setCode', [copy, await rpc(fork, 'eth_getCode', [collection, 'latest'])]);
  await rpc(fork, 'anvil_setStorageAt', [copy, slotOf(1n, owners), `0x${word(walker)}`]);
  await rpc(fork, 'anvil_setStorageAt', [copy, slotOf(walker, balances), `0x${word(1n)}`]);
  // A short string in its slot: the bytes, then the length times two in the last byte (slot 0 when owners sit at 2).
  if (owners === 2n) await rpc(fork, 'anvil_setStorageAt', [copy, `0x${word(0n)}`, `0x${Buffer.from('Old Set').toString('hex').padEnd(62, '0')}${(7 * 2).toString(16).padStart(2, '0')}`]);
  await send(walker, copy, encodeFunctionData({ abi: ERC, functionName: 'transferFrom', args: [walker, walker, 1n] }));
  let curator = await read(vault, VAULT, 'curator');
  const next = await read(vault, VAULT, 'nextAdditionAt');
  const now = BigInt((await rpc(fork, 'eth_getBlockByNumber', ['latest', false])).timestamp);
  if (/^0x0{40}$/.test(curator)) {
    // The live shop has no curator (none named at creation). On the fork only: one written into the vault's curator
    // slot, found by trying each slot and byte offset (the curator packs behind smaller fields) and reading `curator()`
    // back; every other try restored at once.
    const stand = '0x000000000000000000000000000000000000C0dE';
    const mask = (1n << 160n) - 1n;
    for (let slot = 0n; slot < 64n && /^0x0{40}$/.test(curator); slot += 1n) {
      const key = `0x${word(slot)}`; const was = await rpc(fork, 'eth_getStorageAt', [vault, key, 'latest']);
      for (let shift = 0n; shift <= 96n && /^0x0{40}$/.test(curator); shift += 8n) {
        if ((BigInt(was) & (mask << shift)) !== 0n) continue;
        await rpc(fork, 'anvil_setStorageAt', [vault, key, `0x${word(BigInt(was) | (BigInt(stand) << shift))}`]);
        const now = await read(vault, VAULT, 'curator').catch(() => null);
        if (now && now.toLowerCase() === stand.toLowerCase()) { curator = now; say(`  fork: the shop has no curator; ${stand} written as its curator (vault slot ${slot}, bit ${shift})`); }
        else await rpc(fork, 'anvil_setStorageAt', [vault, key, was]);
      }
    }
    if (/^0x0{40}$/.test(curator)) throw new Error('the shop has no curator and its slot was not found: no collection can be added');
  }
  if (next > now) throw new Error(`the curator's next addition opens in ${next - now} s: not on this stand (no time warp)`);
  await rpc(fork, 'anvil_impersonateAccount', [curator]); await rpc(fork, 'anvil_setBalance', [curator, '0x56BC75E2D63100000']);
  await send(curator, vault, encodeFunctionData({ abi: VAULT, functionName: 'addCollection', args: [copy, 0] }));
  const [, , activeAt] = await read(vault, VAULT, 'collectionTerms', [copy]);
  // (3) A card the read cannot find.
  await rpc(fork, 'anvil_setStorageAt', [collection, slotOf(walker, balances), `0x${word(count + 1n)}`]);
  say(`  fork: picked card ${id} (${decimal(pickT, 18)} CARD); given back and picked again ${rounds} times (the next give refused); Old Set ${copy} added by ${curator}, takes gives from ${new Date(Number(activeAt) * 1000).toISOString()}; the wallet's count in ${collection} ${count} -> ${count + 1n} (slots: owners ${owners}, balances ${balances})`);
  // The index follows the fork: the book must hold the new collection before the page is read.
  await page.waitForTimeout(25_000);
  }
  await page.goto(boxPath(box), { waitUntil: 'domcontentloaded' });
  await tradeBox().waitFor({ state: 'visible', timeout: 120_000 });
  const shop = page.getByRole('region', { name: 'Shop', exact: true });
  if (!(await shop.count())) { const tab = page.getByRole('tab', { name: /Shop|Items|Inside/ }); if (await tab.count()) await tab.first().click(); }
  await shop.waitFor({ state: 'visible' });
  const give = shop.locator('section', { has: page.getByRole('heading', { name: 'Give an item', level: 3 }) });
  await give.getByText(/received too long ago to list here\.$/).waitFor({ state: 'visible', timeout: 240_000 });
  const yours = give.getByRole('list', { name: 'Your items' }).getByRole('button');
  const until = Date.now() + 120_000;
  while ((await yours.count()) < 2) { if (Date.now() > until) throw new Error(`fewer than two tiles: ${await statusText(give)}`); await page.waitForTimeout(1_000); }
  const tiles = await yours.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? ''));
  say(`  your cards: ${tiles.join(' | ')}`);
  const lines = async () => (await give.locator(':scope > p').allTextContents()).join(' | ');
  const before = await lines();
  await give.screenshot({ path: join(out, `notes-before-${w}.png`) });
  const later = tiles.findIndex((label) => /takes gives from/.test(label));
  const own = tiles.findIndex((label) => !/takes gives from/.test(label));
  if (later < 0 || own < 0) throw new Error(`no tile of the later collection (${later}) or of an open one (${own})`);
  await yours.nth(own).click();
  await give.getByText(/it renews .* UTC\.$/).waitFor({ state: 'visible', timeout: 30_000 });
  const limit = await lines();
  await give.screenshot({ path: join(out, `notes-limit-${w}.png`) });
  await yours.nth(later).click();
  await give.getByText(/^Takes gives from .* UTC\.$/).waitFor({ state: 'visible', timeout: 30_000 });
  const start = await lines();
  await give.screenshot({ path: join(out, `notes-later-${w}.png`) });
  const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.goto(`${site}/my-box`, { waitUntil: 'domcontentloaded' });
  await page.getByText('More than shown here.').first().waitFor({ state: 'visible', timeout: 240_000 }).catch(() => say('  My Box: no "More than shown here." within 240 s'));
  await page.screenshot({ path: join(out, `notes-mybox-${w}.png`), fullPage: true });
  return { status: `before a choice: ${before || '(no line)'}`, proof: `the shop's card chosen: ${limit}; the later card chosen: ${start}; the page wider than the window by ${wider} px` };
});

// --visit <path> (a stand's look, SH-279): after the steps, the page at <path> with the connected wallet, photographed
// after 20 s, and the text of its "Holder fee share" panel.
if (flag('--visit')) {
  Object.assign(asked, { rpcRequests: 0, rpcCalls: 0, methods: {}, index: 0, to: {} });
  await page.goto(`${site}${flag('--visit')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(20_000);
  await page.screenshot({ path: join(out, 'visit.png'), fullPage: true });
  // SH-291: what the visit asked in its 20 s (fork mode), and the page at phone width too.
  if (fork) say(`visit ${flag('--visit')}: ${asked.rpcRequests} requests to the chain's endpoints (${asked.rpcCalls} calls: ${Object.entries(asked.methods).map(([m, n]) => `${m} ${n}`).join(', ')}), ${asked.index} to the index; eth_call by target and selector: ${Object.entries(asked.to).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: join(out, 'visit-390.png'), fullPage: true });
  say(`visit at 390 px: the page wider than the window by ${await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)} px`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const holders = page.getByRole('region', { name: 'Holder fee share' });
  if (await holders.count()) await holders.first().screenshot({ path: join(out, 'visit-holders.png') }).catch(() => undefined);
  say(`visit ${flag('--visit')}: the holder panel says: ${(await holders.first().innerText().catch(() => '(no panel)')).replace(/\s+/g, ' ')}`);
}

const used = sends.reduce((sum, s) => sum + (s.gasUsed ?? 0n) * (s.effectiveGasPrice ?? 0n), 0n);
say(`walk done: ${sends.length} transactions, ${decimal(used, 18)} BNB for gas`);
save();
await browser.close();
