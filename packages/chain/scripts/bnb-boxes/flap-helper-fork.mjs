#!/usr/bin/env node
/**
 * SH-293: Flap's whitelist helper (0x77779969a11eff7582f3bCf48135A846A3457777) and our two live launcher factories, on
 * a FORK of chain 97 pinned at one block (nothing reaches the real chain; anvil's own unlocked accounts act).
 *
 * Per factory (BNB 0x151e…, test dollar 0x5103…):
 *   (a) the Portal's `launcherFactoryMultiplier` before; a create through `Portal.newLauncher` with the launch page's
 *       defaults and with a small sale, WITHOUT the helper; then `whitelist(f)` from a stranger and the answer;
 *   (b) for bps 10000, 1000, 100, 0 (`whitelist(f, bps)`): the smallest target `checkConfig(.., viaPortal)` accepts
 *       (the page's curve shape), then a whole sale at that target: create through the Portal, complete, launch, a pool
 *       trade;
 *   (c) what the launch holds per bps: the pool's quote and tokens against the raise, the vault and its factory.
 *
 *   node packages/chain/scripts/bnb-boxes/flap-helper-fork.mjs --rpc <public chain-97 endpoint> [--block <n>]
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { concat, createPublicClient, decodeErrorResult, encodeAbiParameters, encodeFunctionData, erc20Abi, getContractAddress, http, keccak256, parseAbi } from 'viem';
import { rpc } from './chain.mjs';
import { anvil, freePort } from './local-chain.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const say = line => process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
const abi = name => JSON.parse(readFileSync(`${ROOT}bounties/flap/abi/${name}.json`, 'utf8'));

const PORTAL = '0x000042108465206185A077Edc3F3fd2b49060000';
const HELPER = '0x77779969a11eff7582f3bCf48135A846A3457777';
const TOKEN_IMPL = '0x7777c57ff7dc441c1715b2e36fa581c48B782222';
const ROUTER = '0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3';
const WBNB = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';
const USD = '0x190C989D5665a0e404B444b53CAE9AbCfb600157';
const E18 = 10n ** 18n;
const FACTORIES = [
  { kind: 'bnb', address: '0x151e43d81b3Ac5DBf566A1d01B5674cc2C4c7594', fAbi: abi('CurveLauncherFactory'), lAbi: abi('CurveLauncher'), target: 2_350_000_000_000_000_000n, virtual: 16n * E18, small: 50_000_000_000_000_000n },
  { kind: 'usd', address: '0x51034cf27e4234820bCC7152583Ab8e8d95DbE77', fAbi: abi('TokenCurveLauncherFactory'), lAbi: abi('TokenCurveLauncher'), target: 1_700n * E18, virtual: 11_600n * E18, small: 10n * E18 },
];
const PORTAL_ABI = [...abi('FlapPortal'), ...parseAbi(['function launcherFactoryMultiplier(address) view returns (bool, uint16)'])];
const HELPER_ABI = parseAbi(['function whitelist(address)', 'function whitelist(address,uint16)']);
const ROUTER_ABI = parseAbi([
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
]);
const CODE_HASH = keccak256(concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', TOKEN_IMPL, '0x5af43d82803e903d91602b57fd5bf3']));

/** A salt whose token address (the Portal's clone of the token implementation) ends in 7777. */
function mineSalt(seed) {
  for (let i = 0n; ; i += 1n) {
    const salt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [seed, i]));
    if (getContractAddress({ opcode: 'CREATE2', from: PORTAL, salt, bytecodeHash: CODE_HASH }).toLowerCase().endsWith('7777')) return salt;
  }
}

const upstream = flag('--rpc');
assert.ok(/^https:\/\//.test(upstream ?? ''), '--rpc <a public chain-97 endpoint>');
const block = flag('--block') ?? BigInt(await rpc(upstream, 'eth_blockNumber')).toString();
const fork = await anvil(['--fork-url', upstream, '--fork-block-number', String(block), '--chain-id', '97', '--hardfork', 'osaka', '--no-rate-limit'], Number(flag('--port', String(await freePort()))));
const client = createPublicClient({ transport: http(fork.url, { retryCount: 0, timeout: 300_000 }) });
say(`fork of ${upstream} at block ${block} (${fork.url}); nothing is sent to the real chain`);
const [creator, buyer, stranger, trader] = await rpc(fork.url, 'eth_accounts');
for (const a of [creator, buyer, stranger, trader]) assert.equal(await client.getCode({ address: a }) ?? '0x', '0x', 'plain accounts');

/** One fork transaction; its status, and a refusal's decoded reason. */
async function send(from, to, data, value = 0n, decodeWith = []) {
  const hash = await rpc(fork.url, 'eth_sendTransaction', [{ from, to, data, value: `0x${value.toString(16)}`, gas: '0x1c9c380' }]);
  let receipt = await rpc(fork.url, 'eth_getTransactionReceipt', [hash]);
  if (!receipt) { await rpc(fork.url, 'evm_mine'); receipt = await rpc(fork.url, 'eth_getTransactionReceipt', [hash]); }
  if (receipt.status === '0x1') return { ok: true, hash, receipt };
  const why = await client.call({ account: from, to, data, value }).then(() => 'no reason', error => {
    const raw = error.walk?.(e => typeof e.data === 'string')?.data;
    try { const d = decodeErrorResult({ abi: decodeWith, data: raw }); return `${d.errorName}(${(d.args ?? []).join(', ')})`; } catch { return raw ?? error.shortMessage; }
  });
  return { ok: false, hash, why };
}
const view = (address, abiOf, functionName, a = []) => client.readContract({ address, abi: abiOf, functionName, args: a });
const multiplier = f => view(PORTAL, PORTAL_ABI, 'launcherFactoryMultiplier', [f]);
const cfgOf = (f, salt, target) => ({
  name: 'Helper Probe', symbol: 'HPRB', meta: '', salt, saleTokens: 600_000_000n * E18, targetRaise: target, virtualBnb: target * f.virtual / f.target,
  duration: 48n * 3600n, tradeFeeBps: 100, buyTaxBps: 300, sellTaxBps: 500, burnShareBps: 2000, taxDuration: 365 * 86400,
});
const tupleOf = f => f.fAbi.find(x => x.name === 'checkConfig').inputs[0];
const check = (f, cfg) => client.readContract({ address: f.address, abi: f.fAbi, functionName: 'checkConfig', args: [cfg, true] })
  .then(() => 'accepted', error => { const raw = error.walk?.(e => typeof e.data === 'string')?.data; try { const d = decodeErrorResult({ abi: f.fAbi, data: raw }); return `${d.errorName}(${(d.args ?? []).join(', ')})`; } catch { return error.shortMessage; } });

/** A whole sale through Portal.newLauncher: create, complete, launch; the pool's holdings; one pool trade. */
async function wholeSale(f, target, seed, between = null) {
  const salt = mineSalt(seed);
  const cfg = cfgOf(f, salt, target);
  const data = encodeAbiParameters([tupleOf(f)], [cfg]);
  const fee = await view(f.address, f.fAbi, 'creationFee');
  const call = encodeFunctionData({ abi: PORTAL_ABI, functionName: 'newLauncher', args: [f.address, data] });
  const launcher = await client.call({ account: creator, to: PORTAL, data: call, value: fee }).then(r => `0x${r.data.slice(-40)}`, () => null);
  const created = await send(creator, PORTAL, call, fee, [...PORTAL_ABI, ...f.fAbi]);
  if (!created.ok) return { target, created: created.why };
  const meanwhile = between ? await between() : null;
  const cost = await view(launcher, f.lAbi, 'costToComplete');
  let done;
  if (f.kind === 'bnb') done = await send(buyer, launcher, encodeFunctionData({ abi: f.lAbi, functionName: 'complete' }), cost + cost / 10n, f.lAbi);
  else {
    await send(buyer, USD, encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [buyer, cost * 2n] }));
    await send(buyer, USD, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [launcher, cost] }));
    done = await send(buyer, launcher, encodeFunctionData({ abi: f.lAbi, functionName: 'complete', args: [cost] }), 0n, f.lAbi);
  }
  if (!done.ok) return { target, created: 'ok', meanwhile, launcher, cost, completed: done.why };
  const [token, pool, vault] = await view(launcher, f.lAbi, 'launchInfo');
  const quote = f.kind === 'bnb' ? WBNB : USD;
  const raise = await view(launcher, f.lAbi, 'raiseTarget');
  const poolQuote = await view(quote, erc20Abi, 'balanceOf', [pool]);
  const poolTokens = await view(token, erc20Abi, 'balanceOf', [pool]);
  const [, vaultFactory] = await view(PORTAL, PORTAL_ABI, 'getLaunchVault', [token]);
  await rpc(fork.url, 'evm_increaseTime', ['0x259']);
  await rpc(fork.url, 'evm_mine');
  const tradeIn = raise / 20n;
  let trade;
  if (f.kind === 'bnb') trade = await send(trader, ROUTER, encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [0n, [WBNB, token], trader, 2n ** 40n] }), tradeIn);
  else {
    await send(trader, USD, encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [trader, tradeIn] }));
    await send(trader, USD, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, tradeIn] }));
    trade = await send(trader, ROUTER, encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', args: [tradeIn, 0n, [USD, token], trader, 2n ** 40n] }));
  }
  const bought = await view(token, erc20Abi, 'balanceOf', [trader]);
  return { target, meanwhile, launcher, cost, launched: await view(launcher, f.lAbi, 'launched'), token, raise, poolQuote, poolQuoteIsRaise: poolQuote === raise,
    poolTokens, poolTokensAsCurve: poolTokens === await view(launcher, f.lAbi, 'poolToken'), vault, vaultFactory, trade: trade.ok ? `bought ${bought} tokens for ${tradeIn}` : trade.why };
}

try {
  const flags = await view(PORTAL, PORTAL_ABI, 'featureFlags').catch(() => 'unread');
  say(`Portal featureFlags ${flags}`);
  for (const f of FACTORIES) {
    say(`== ${f.kind} factory ${f.address}`);
    say({ before: await multiplier(f.address) });
    const salt = mineSalt(keccak256(`0x${Buffer.from(`sh-293-${f.kind}-check`).toString('hex')}`));
    const [, raise, pt, total] = await view(f.address, f.fAbi, 'curveFor', [600_000_000n * E18, f.target, f.virtual]);
    say({ pageDefaults: { target: f.target, checkViaPortal: await check(f, cfgOf(f, salt, f.target)), floorViaPortal: await view(f.address, f.fAbi, 'liquidityFloor', [raise, pt, total, true]) } });
    say({ withoutHelper_pageDefaultSale: await wholeSale(f, f.target, keccak256(`0x${Buffer.from(`sh-293-${f.kind}-default`).toString('hex')}`)) });
    say({ withoutHelper_smallSale: { target: f.small, check: await check(f, cfgOf(f, salt, f.small)) } });
    const one = await send(stranger, HELPER, encodeFunctionData({ abi: HELPER_ABI, functionName: 'whitelist', args: [f.address] }));
    say({ whitelist: f.address, by: 'a stranger', ok: one.ok, why: one.why, after: await multiplier(f.address) });
    for (const bps of (args.includes('--overwrite-only') ? [] : [10_000, 1_000, 100, 0])) {
      const set = await send(stranger, HELPER, encodeFunctionData({ abi: HELPER_ABI, functionName: 'whitelist', args: [f.address, bps] }));
      const after = await multiplier(f.address);
      // The smallest target checkConfig accepts through the Portal, the page's curve shape (binary search).
      let lo = 1n; let hi = f.target;
      if ((await check(f, cfgOf(f, salt, hi))) !== 'accepted') hi = 0n;
      while (hi !== 0n && hi - lo > hi / 1000n + 1n) { const mid = (lo + hi) / 2n; if ((await check(f, cfgOf(f, salt, mid))) === 'accepted') hi = mid; else lo = mid; }
      const refusedBelow = hi === 0n ? null : await check(f, cfgOf(f, salt, lo));
      const [, r2, p2, t2] = await view(f.address, f.fAbi, 'curveFor', [600_000_000n * E18, hi || f.target, (hi || f.target) * f.virtual / f.target]);
      say({ bps, set: set.ok ? 'ok' : set.why, after, smallestTarget: hi, refusedJustBelow: refusedBelow, floorAtIt: await view(f.address, f.fAbi, 'liquidityFloor', [r2, p2, t2, true]) });
      if (hi !== 0n) say({ bps, sale: await wholeSale(f, hi + hi / 50n, keccak256(`0x${Buffer.from(`sh-293-${f.kind}-${bps}`).toString('hex')}`)) });
    }
  }
  // Someone overwrites the number between a small sale's creation and its completing buy.
  for (const f of FACTORIES) {
    await send(stranger, HELPER, encodeFunctionData({ abi: HELPER_ABI, functionName: 'whitelist', args: [f.address, 0] }));
    const overwrite = async () => {
      const r = await send(stranger, HELPER, encodeFunctionData({ abi: HELPER_ABI, functionName: 'whitelist', args: [f.address] }));
      return { overwrittenTo: await multiplier(f.address), ok: r.ok };
    };
    say({ overwriteAfterCreation: f.kind, sale: await wholeSale(f, f.small, keccak256(`0x${Buffer.from(`sh-293-${f.kind}-overwrite`).toString('hex')}`), overwrite) });
  }
  say('flap helper fork run done');
} finally {
  fork.stop();
}
