#!/usr/bin/env node
/** Fresh, offline 31337 alpha. No URL/key/fork input; all broadcasts target our own anvil. */
import './register-ts.mjs';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, decodeAbiParameters, decodeErrorResult, decodeEventLog, decodeFunctionData,
  encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, parseAbi, parseAbiParameters, toFunctionSelector, toHex, zeroAddress } from 'viem';
import { artifact as readArtifact, readAlphaLocalManifest } from './lib/core-v2-local-manifest.mjs';
import { ROOT, CONTRACTS, ALPHA_CHAIN_ID, assertLocalRpc, child, delay, freePort, hex, json, mineTo, rpc, run, stopChild } from './lib/core-v2-local-runtime.mjs';

// Resolve after register-ts has installed its extensionless-source hook.
const { prepareTradeSepolia, submitTradeWriteSepolia, decodeTradeRevert, TRADE_ABI } = await import('../src/trade-sepolia/index.ts');
const { getSqrtPriceAtTick } = await import('../../box-spec/src/v4-math.ts');

const ETHER = 10n ** 18n;
const forgeOut = join(ROOT, '.cache/alpha-forge-out');
const forgeCache = join(ROOT, '.cache/alpha-forge-cache');
const artifact = name => readArtifact(name, { outDir: forgeOut });

/** Build before starting Anvil; artifact-only CREATEs must not depend on a previous test run's output. */
export async function buildAlphaArtifacts({ outDir = forgeOut, cacheDir = forgeCache } = {}) {
  return run('forge', ['build',
    'script/local/CoreV2LocalGenesis.s.sol', 'script/local/DeployCoreV2Local.s.sol',
    'script/local/AlphaRehearsalSetup.s.sol',
    // vm.deployCode does not add this source to the script graph. Keep its upstream compiler profile separate.
    'lib/v4-core/src/PoolManager.sol',
    // _deployLocalCoreV2 and _receiverCode load these through vm.getCode, including _localItemLedgerArtifact.
    'src/box-v2/BoxRegistryV2.sol', 'src/box-v2/ListingRegistry.sol', 'src/box-v2/BoxCoordinatorV2.sol',
    'src/box-v2/BoxTokenV2.sol', 'src/box-v2/BoxHookV2Extension.sol', 'src/box-v2/BoxHookV2.sol',
    'src/box-v2/BoxVaultV2.sol', 'src/box-v2/BoxCollectionV2.sol', 'src/box-v2/BoxReceiverV2.sol',
    'src/box-v2/BoxLaunchRouterV2.sol', 'src/box-v2/BoxTicketsV2.sol', 'src/box-v2/BoxRoyaltyRouterV2.sol',
    'src/box-v2/HolderLedgerV2.sol', 'src/box-v2/StarterSetLoaderV2.sol', 'src/box-v2/BoxTokenV2Ledger.sol',
    'src/box-v2/ShopVaultV2.sol', 'src/box-v2/ItemLedgerV2.sol', 'src/box-v2/PileVaultV2.sol',
    'src/box-v2/BoxSpecV2Validator.sol', 'src/box-v2/BoxFactoryV2Parts.sol', 'src/box-v2/BoxFactoryV2Planner.sol',
    'src/box-v2/libraries/BoxFactoryV2Checks.sol', 'src/box-v2/BoxFactoryV2.sol',
    'src/box-v2/libraries/ReceiverViews.sol', 'src/box-v2/modules/EatPriceCoinFeeModuleV21.sol',
    'src/box-v2/modules/HoldersTFeeModuleV21.sol', 'src/box-v2/modules/ItemsTFeeModuleV21.sol',
    'src/box-v2/modules/PileFeeModuleV21.sol', 'src/box-v2/FeeModuleDirectoryV21.sol',
    'src/box-v2/BoxReceiverV2Extension.sol',
    '--out', relative(CONTRACTS, outDir), '--cache-path', relative(CONTRACTS, cacheDir)],
  { cwd: CONTRACTS, env: { FOUNDRY_OFFLINE: 'true', FOUNDRY_THREADS: '4' }, timeoutMs: 900_000 });
}

const MIN_PRICE = 4295128740n;
const MAX_PRICE = 1461446703485210103287273052203988822378723970341n;
const wrappedErrorAbi = parseAbi(['error WrappedError(address target,bytes4 selector,bytes reason,bytes details)']);
const hookErrors = {
  trading_not_open: 'TradingNotOpen(uint256)', buy_through_launch_router: 'BuyThroughLaunchRouter(address,uint256)',
  curve_closed: 'CurveIsClosed(uint256)', failure_pending: 'FailurePending(uint256)', below_curve_floor: 'BelowCurveFloor(uint160)',
};
const routerErrors = {
  not_open: 'NotOpen(uint256)', window_closed: 'WindowClosed(uint256)', curve_closed: 'CurveIsClosed()',
  expired: 'Expired(uint256)', wrong_value: 'WrongValue(uint256,uint256)', insufficient_output: 'InsufficientOutput(uint256,uint256)',
  amount_too_small: 'AmountTooSmall()', recipient_refused: 'RecipientRefused(address)',
};
const directErrorsAbi = parseAbi([...Object.values(routerErrors), 'UnknownPool()', 'NotAdmitted()',
  'InsufficientAllowance(uint256,uint256)', 'InsufficientBalance(uint256,uint256)'].map(signature => `error ${signature}`));
const swapCallback = after => toFunctionSelector(`${after ? 'afterSwap' : 'beforeSwap'}(address,(address,address,uint24,int24,address),(bool,int256,uint160),${after ? 'int256,' : ''}bytes)`);

/** Single curve position: T input to its upper edge, grossed up for the live directional fee.
 * One whole T beyond that bound covers v4's per-bitmap-word rounding (at most 117 words in the entire tick domain).
 * The probe limits the resulting price to floor + 1 and independently checks the hook's actual revert bytes.
 */
export function belowFloorSellAmount({ spot, floor, liquidity, fee }) {
  assert.ok(spot > 0n && spot <= floor && liquidity > 0n && fee >= 0n && fee < 1_000_000n, 'invalid curve state');
  const up = (n, d) => (n + d - 1n) / d;
  return up(up((floor - spot) * liquidity, 1n << 96n) * 1_000_000n, 1_000_000n - fee) + ETHER;
}

function inspectAlphaHookError(data) {
  const decoded = decodeErrorResult({ abi: wrappedErrorAbi, data });
  const [target, callback, inner, details] = decoded.args;
  return { target, callback, inner, details, innerSelector: inner.slice(0, 10), innerReason: decodeTradeRevert(inner) };
}

export function assertAlphaHookError(data, { hook, reason, floor }) {
  const error = inspectAlphaHookError(data); // Direct token/router errors cannot satisfy this assertion.
  assert.equal(error.target.toLowerCase(), hook.toLowerCase(), 'wrapped error target');
  assert.equal(error.callback, swapCallback(reason === 'below_curve_floor'), 'wrapped hook callback');
  assert.equal(error.details, toFunctionSelector('HookCallFailed()'), 'v4 hook failure details');
  assert.equal(error.innerSelector, toFunctionSelector(hookErrors[reason]), 'hook error selector');
  assert.equal(error.innerReason, reason, 'inner hook reason');
  assert.equal(decodeTradeRevert(data), reason, 'wrapped trade reason');
  if (reason === 'below_curve_floor') {
    const [price] = decodeAbiParameters(parseAbiParameters('uint160'), `0x${error.inner.slice(10)}`);
    assert.ok(price > floor, 'hook price must cross the curve floor');
  }
  return error;
}

export function writeAlphaEvidence(out, result) {
  writeFileSync(join(out, 'result.json'), json(result));
  writeFileSync(join(out, 'transactions.json'), json(result.transactions));
  const rows = result.transactions.map(t => `| ${t.step} | ${t.signer} | ${t.status} | ${t.gas} | ${t.expectedReason} | ${t.actualReason} | ${t.expectedContractReason ?? '—'} | ${t.contractReason ?? '—'} | ${t.hash} |`);
  writeFileSync(join(out, 'transactions.md'), ['| Step | Signer | Status | Gas | Expected reason | Actual reason | Expected contract error | Actual contract error | Hash |',
    '|---|---|---|---:|---|---|---|---|---|', ...rows, ''].join('\n'));
}
const dependencies = parseAbiParameters('(address manager,address weth,address drand,address fit,address platform,address swapper,address poolSwapTest)');
const assets = parseAbiParameters('(address teth,address gold,address usdc,address nvda,address pepe,address pairs,address nativePools)');
const printed = (output, name) => {
  const value = output.match(new RegExp(`ALPHA\\|${name}\\|\\s*(0x[0-9a-fA-F]+)`))?.[1];
  assert.ok(value, `forge omitted ${name}`); return value;
};

export class AlphaRun {
  constructor(url, out) {
    this.url = url; this.out = out; this.transactions = []; this.trades = []; this.step = 'startup';
    this.client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
    this.request = ({ method, params = [] }) => rpc(this.url, method, params);
  }
  async guard() { await assertLocalRpc(this.url, rpc, { alpha: true }); }
  async read(name, address, functionName, args = [], blockNumber) {
    return this.client.readContract({ abi: name === 'ERC20' ? erc20Abi : artifact(name).abi, address, functionName, args, blockNumber });
  }
  async record(hash, step = this.step, expected = null, context = {}) {
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    let data = '0x';
    if (receipt.status !== 'success') {
      const trace = await this.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer' }] });
      data = trace.output ?? trace.returnValue ?? '0x';
      if (!data.startsWith('0x')) data = `0x${data}`;
    }
    const reason = receipt.status === 'success' ? null : decodeTradeRevert(data);
    const row = { step, signer: receipt.from, hash, block: receipt.blockNumber.toString(),
      status: receipt.status, gas: receipt.gasUsed.toString(), reason, data,
      expectedReason: expected ?? 'success', actualReason: reason ?? 'success', ...context };
    if (reason !== null) {
      try {
        row.hookError = inspectAlphaHookError(data);
        row.contractReason = Object.values(hookErrors).find(signature => toFunctionSelector(signature) === row.hookError.innerSelector)?.split('(')[0];
      } catch {
        try { row.contractReason = decodeErrorResult({ abi: directErrorsAbi, data }).errorName; }
        catch { /* Keep unknown bytes in evidence. */ }
      }
    }
    this.transactions.push(row);
    writeFileSync(join(this.out, 'transactions.json'), json(this.transactions));
    return { receipt, row };
  }
  async send(step, from, to, data, value = 0n, expected = null, context = {}) {
    await this.guard();
    const hash = await this.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value: hex(value), gas: hex(15_000_000n) }] });
    const result = await this.record(hash, step, expected, context);
    if (expected === null) assert.equal(result.receipt.status, 'success', `${step}: ${result.row.reason}`);
    else {
      assert.equal(result.receipt.status, 'reverted', step);
      assert.equal(result.row.reason, expected, step);
    }
    return result;
  }
  async call(step, from, name, to, functionName, args = [], value = 0n, expected = null, context = {}) {
    return this.send(step, from, to, encodeFunctionData({ abi: name === 'ERC20' ? erc20Abi : artifact(name).abi, functionName, args }), value, expected, context);
  }
  async forge(step, target, signature, args, from) {
    await this.guard();
    const before = await this.client.getBlockNumber({ cacheTime: 0 });
    let output;
    try {
      output = await run('forge', ['script', `script/local/${target}.s.sol:${target}`, '--sig', signature, ...args.map(String),
        '--rpc-url', this.url, '--broadcast', '--unlocked', '--sender', from, '--slow', '--isolate', '--no-storage-caching', '--hardfork', 'osaka',
        '--out', relative(CONTRACTS, forgeOut), '--cache-path', relative(CONTRACTS, forgeCache)],
      { cwd: CONTRACTS, env: { FOUNDRY_OFFLINE: 'true', FOUNDRY_THREADS: '4' }, timeoutMs: 900_000 });
      writeFileSync(join(this.out, `${step}.log`), output);
      assert.ok(output.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL'), 'forge broadcast incomplete');
    } finally {
      // Includes linked libraries, deployments, approvals and every script-recorded call, even on partial failure.
      const after = await this.client.getBlockNumber({ cacheTime: 0 });
      for (let blockNumber = before + 1n; blockNumber <= after; blockNumber++) {
        const block = await this.client.getBlock({ blockNumber });
        for (const hash of block.transactions) {
          const { receipt } = await this.record(hash, step);
          assert.equal(receipt.status, 'success', `${step}: forge transaction reverted`);
        }
      }
    }
    return output;
  }
  wallet(from) {
    return async ({ method, params }) => {
      await this.guard();
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [from];
      if (method === 'eth_chainId') return hex(ALPHA_CHAIN_ID);
      assert.equal(method, 'eth_sendTransaction', 'unexpected wallet request');
      assert.equal(params[0].from.toLowerCase(), from.toLowerCase());
      return this.request({ method, params });
    };
  }
  async prepare(box, side, amountIn, from) {
    const result = await prepareTradeSepolia({ rpc: this.request, chainId: ALPHA_CHAIN_ID, coordinator: box,
      from, side, amountIn, localDeployment: this.manifest.localDeployment });
    assert.ok(result.ok, `prepare ${side}: ${result.reason}`);
    return result.plan;
  }
  async submit(step, plan, call) {
    const hash = await submitTradeWriteSepolia({ wallet: this.wallet(plan.from), rpc: this.request, chainId: ALPHA_CHAIN_ID,
      plan, call, from: plan.from, gasLimit: plan.gasLimit });
    const result = await this.record(hash, step);
    assert.equal(result.receipt.status, 'success', `${step}: ${result.row.reason}`);
    return result.receipt;
  }
  async ready(step, box, side, amount, from) {
    let plan = await this.prepare(box, side, amount, from);
    if (plan.reason === 'approval_required') {
      for (const call of plan.approvals) await this.submit(`${step}: exact/reset approval`, plan, call);
      plan = await this.prepare(box, side, amount, from);
    }
    assert.ok(plan.call); assert.equal(plan.toleranceBps, 200n);
    return plan;
  }
  async balance(coin, who) { return coin === zeroAddress ? this.client.getBalance({ address: who }) : this.read('ERC20', coin, 'balanceOf', [who]); }
  async poolPrice(plan) {
    const key = await this.read('BoxHookV2', plan.hook, 'poolKey');
    const poolId = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
    const slot = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256'), [poolId, 6n]));
    const word = await this.client.readContract({ abi: TRADE_ABI, address: plan.deployment.poolManager, functionName: 'extsload', args: [slot] });
    return BigInt(word) & ((1n << 160n) - 1n);
  }
  async execute(step, plan, { full = true } = {}) {
    const inputCoin = plan.side === 'buy' ? plan.p : plan.token;
    const outputCoin = plan.side === 'buy' ? plan.token : plan.p;
    const [inputBefore, outputBefore] = await Promise.all([this.balance(inputCoin, plan.from), this.balance(outputCoin, plan.from)]);
    const receipt = await this.submit(step, plan, plan.call);
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    const spent = inputBefore - await this.balance(inputCoin, plan.from) - (inputCoin === zeroAddress ? fee : 0n);
    const received = await this.balance(outputCoin, plan.from) - outputBefore + (outputCoin === zeroAddress ? fee : 0n);
    assert.ok(received > 0n);
    if (full) assert.equal(spent, plan.amountIn, `${step}: full input`);
    const postPrice = plan.phase !== 2 ? await this.poolPrice(plan) : null;
    if (full && plan.phase !== 2) {
      assert.equal(received, plan.expectedOutput, `${step}: simulated output`);
      assert.equal(postPrice, plan.expectedSqrtPriceX96, `${step}: simulated price`);
    }
    this.trades.push({ step, input: plan.amountIn.toString(), spent: spent.toString(), received: received.toString(),
      refund: (plan.amountIn - spent).toString(), expectedOutput: plan.expectedOutput?.toString(), postPrice: postPrice?.toString() });
    if (plan.revoke) await this.submit(`${step}: revoke`, plan, plan.revoke);
    return { spent, received, refund: plan.amountIn - spent, receipt };
  }
  async trade(step, box, side, amount, from, options) { return this.execute(step, await this.ready(step, box, side, amount, from), options); }
  async snapshot() { return this.request({ method: 'evm_snapshot' }); }
  async restore(id) { assert.equal(await this.request({ method: 'evm_revert', params: [id] }), true); }
}

export async function runAlphaRehearsal({ port = 8573 } = {}) {
  // Each run has its own append-only scratch directory. No reuse, deletion or remote RPC options.
  const out = join(ROOT, '.cache/alpha-rehearsal', `${Date.now()}-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const result = { complete: false, transactions: [] };
  let anvil;
  const stop = () => { if (anvil) void stopChild(anvil); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    // Validate the port with the same local guard before trying to bind it.
    await assertLocalRpc(`http://127.0.0.1:${port}`, async (_url, method) => method === 'eth_chainId' ? '0x7a69' : 'anvil/test', { alpha: true });
    writeFileSync(join(out, 'build.log'), await buildAlphaArtifacts());
    await freePort(port);
    const log = openSync(join(out, 'anvil.log'), 'a');
    try {
      anvil = child('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(ALPHA_CHAIN_ID),
        '--enable-tx-gas-limit', '--steps-tracing', '--base-fee', '0', '--hardfork', 'osaka', '--timestamp', '1790000000', '--silent'],
      { stdio: ['ignore', log, log] });
    } finally { closeSync(log); }
    const r = new AlphaRun(`http://127.0.0.1:${port}`, out);
    result.transactions = r.transactions;
    result.trades = r.trades;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (anvil.exitCode !== null) throw new Error('anvil exited before readiness');
      try { await r.guard(); ready = true; break; } catch { await delay(100); }
    }
    assert.ok(ready, 'anvil readiness');
    await r.request({ method: 'anvil_setBlockTimestampInterval', params: [1] });
    await r.request({ method: 'anvil_mine', params: ['0x10'] });
    const [owner, tester, tester2, outsider, admitter] = await r.request({ method: 'eth_accounts' });
    result.signers = { owner, tester, tester2, outsider, admitter };
    const d = decodeAbiParameters(dependencies, printed(await r.forge('dependencies', 'CoreV2LocalGenesis', 'runAlpha()', [], owner), 'dependencies'))[0];
    const factory = printed(await r.forge('release', 'DeployCoreV2Local', 'runAlpha(address,address,address,address,address)',
      [d.manager, d.weth, d.drand, d.fit, d.platform], owner), 'factory');
    const a = decodeAbiParameters(assets, printed(await r.forge('assets', 'AlphaRehearsalSetup', 'runAssets(address)', [d.manager], owner), 'assets'))[0];
    r.manifest = await readAlphaLocalManifest({ rpcUrl: r.url, factory, ...d, assets: a });
    result.manifest = r.manifest;
    writeFileSync(join(out, 'manifest.json'), json(r.manifest));
    assert.equal((await r.read('TestETH', a.teth, 'owner')).toLowerCase(), owner.toLowerCase());
    // SH-TETH-ADMITTER: the server's admitter (one a day here) admits the first tester; the owner admits the second.
    await r.forge('delegated tester admission', 'AlphaRehearsalSetup', 'runAdmission(address,address,address)',
      [a.teth, admitter, tester], owner);
    assert.equal((await r.read('TestETH', a.teth, 'admitter')).toLowerCase(), admitter.toLowerCase());
    assert.equal(await r.read('TestETH', a.teth, 'admitterPerDay'), 1n);
    assert.equal(await r.read('TestETH', a.teth, 'admitted', [tester]), true);
    const capped = await r.call('admitter over its daily cap refused', admitter, 'TestETH', a.teth, 'admitOne', [outsider], 0n,
      'admitter_daily_cap_reached', { expectedContractReason: 'AdmitterDailyCapReached' });
    assert.equal(decodeErrorResult({ abi: artifact('TestETH').abi, data: capped.row.data }).errorName, 'AdmitterDailyCapReached');
    capped.row.contractReason = 'AdmitterDailyCapReached';
    await r.call('owner admits second tester', owner, 'TestETH', a.teth, 'admit', [[tester2]]);
    await r.call('tester drip', tester, 'TestETH', a.teth, 'drip');
    await r.call('second tester drip', tester2, 'TestETH', a.teth, 'drip');
    const denied = await r.call('unadmitted drip refused', outsider, 'TestETH', a.teth, 'drip', [], 0n, 'not_admitted',
      { expectedContractReason: 'NotAdmitted' });
    assert.equal(decodeErrorResult({ abi: artifact('TestETH').abi, data: denied.row.data }).errorName, 'NotAdmitted');
    denied.row.contractReason = 'NotAdmitted';
    await r.forge('listing OTHER raise 1', 'AlphaRehearsalSetup', 'runListing(address,address)', [factory, a.teth], owner);
    const listingId = 1; // Empty local release has only native row zero before this admission.
    const listings = await r.read('BoxFactoryV2', factory, 'listingRegistry');
    const listed = await r.read('ListingRegistry', listings, 'listing', [listingId]);
    assert.equal(listed.token.toLowerCase(), a.teth.toLowerCase()); assert.equal(listed.raise, ETHER); assert.equal(listed.class, 5);
    await r.forge('seed pools', 'AlphaRehearsalSetup', 'runPools((address,address,address,address,address,address,address))',
      [`(${Object.values(a).join(',')})`], owner);
    await mineTo(r.url, (await r.client.getBlock()).timestamp + 86400n);
    const openAt = (await r.client.getBlock()).timestamp + 120n;
    const tbox = printed(await r.forge('create tETH box', 'AlphaRehearsalSetup', 'runBox(address,uint32,uint32)', [factory, listingId, openAt], tester), 'box');
    const ebox = printed(await r.forge('create ETH box', 'AlphaRehearsalSetup', 'runBox(address,uint32,uint32)', [factory, 0, openAt], tester), 'box');
    result.boxes = { tbox, ebox };
    await negativeUpcoming(r, ebox, tester);
    await mineTo(r.url, openAt + 1n);
    result.tax = [];
    for (const [label, box] of [['ETH', ebox], ['tETH', tbox]]) {
      const trade = await r.trade(`window ${label} buy`, box, 'buy', (await r.read('BoxCoordinatorV2', box, 'raise')) / 100n, tester);
      const logs = trade.receipt.logs.flatMap(log => { try { return [decodeEventLog({ abi: artifact('BoxLaunchRouterV2').abi, ...log })]; } catch { return []; } });
      const tax = logs.find(log => log.eventName === 'TaxedBuy'); assert.ok(tax); assert.ok(tax.args.tax > 0n);
      result.tax.push({ coin: label, ...tax.args });
    }
    await negativeWindow(r, ebox, tester);
    await mineTo(r.url, openAt + 384n);
    for (const [label, box] of [['ETH', ebox], ['tETH', tbox]]) {
      await r.trade(`bonding ${label} buy`, box, 'buy', (await r.read('BoxCoordinatorV2', box, 'raise')) / 10n, tester);
      await r.trade(`bonding ${label} sell`, box, 'sell', 1000n * ETHER, tester);
    }
    // Another real trade occurs between prepare and submit. The limit is based on the first quote's post-price.
    const amount = (await r.read('BoxCoordinatorV2', ebox, 'raise')) / 10n;
    const pending = await r.ready('partial ETH buy', ebox, 'buy', amount, tester);
    await r.trade('intervening ETH buy', ebox, 'buy', amount, tester2);
    const partial = await r.execute('partial ETH buy', pending, { full: false });
    assert.ok(partial.spent > 0n && partial.spent < amount); assert.ok(partial.received < pending.expectedOutput);
    assert.equal(await r.client.getBalance({ address: d.poolSwapTest }), 0n);
    const params = decodeFunctionData({ abi: TRADE_ABI, data: pending.call.data }).args[1];
    assert.equal(await r.poolPrice(pending), params.sqrtPriceLimitX96, 'partial stops at prepared limit');
    result.partial = { input: amount.toString(), spent: partial.spent.toString(), refund: partial.refund.toString(), limit: params.sqrtPriceLimitX96.toString() };
    await negativeBonding(r, ebox, tester);
    // Two admitted testers contribute; no extra faucet mint or owner transfer funds this graduation.
    for (const [who, budget] of [[tester, 4n * ETHER / 5n], [tester2, ETHER / 2n]]) {
      if (await r.read('BoxHookV2', await r.read('BoxCoordinatorV2', tbox, 'hook'), 'closed')) break;
      await r.trade('fill tETH curve', tbox, 'buy', budget, who, { full: false });
    }
    const thook = await r.read('BoxCoordinatorV2', tbox, 'hook');
    assert.equal(await r.read('BoxHookV2', thook, 'closed'), true);
    await negativeClosed(r, tbox, tester);
    await r.call('Graduate button', tester, 'BoxCoordinatorV2', tbox, 'graduate');
    result.graduated = await r.read('BoxCoordinatorV2', tbox, 'graduated'); assert.equal(result.graduated, true);
    await r.trade('graduated tETH sell', tbox, 'sell', 1000n * ETHER, tester);
    await r.trade('ETH box sell', ebox, 'sell', 1000n * ETHER, tester);
    result.drain = await drain(r, a, owner, outsider);
    const seen = new Set(r.transactions.filter(t => t.status === 'reverted').map(t => t.reason));
    for (const reason of REQUIRED_REASONS) assert.ok(seen.has(reason), `missing revert ${reason}`);
    result.complete = true;
    return result;
  } catch (error) {
    result.error = error.message;
    result.errorCode = error.code;
    throw error;
  } finally {
    writeAlphaEvidence(out, result);
    if (anvil) await stopChild(anvil);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    console.error(`Alpha evidence: ${relative(ROOT, out)}`);
  }
}

export const REQUIRED_REASONS = ['not_open', 'window_closed', 'curve_closed', 'expired', 'wrong_value',
  'insufficient_output', 'amount_too_small', 'recipient_refused', 'buy_through_launch_router',
  'trading_not_open', 'failure_pending', 'below_curve_floor', 'unknown_pool'];

/** Verify actual Forge return bytes with the consumer's decoder. Never marks the Anvil rehearsal complete. */
export function verifyAlphaControls(output) {
  assert.match(output, /6 tests passed, 0 failed/, 'controls did not pass');
  const calls = [...output.matchAll(/ALPHA_CALL\|([^|\n]+)\|(0x[0-9a-fA-F]{40})\|(success|reverted)\|(\d+)\|(0x[0-9a-fA-F]*)/g)]
    .map(([, step, signer, status, gas, data]) => ({ step, signer, status, gas, data,
      reason: status === 'success' ? null : decodeTradeRevert(data) }));
  const seen = new Set();
  for (const row of calls.filter(row => row.status === 'reverted')) {
    assert.equal(row.reason, row.step, `actual revert bytes: ${row.step}`);
    seen.add(row.reason);
  }
  for (const reason of REQUIRED_REASONS) assert.ok(seen.has(reason), `missing revert ${reason}`);
  const floorProbes = [...output.matchAll(/ALPHA_FLOOR\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)/g)]
    .map(([, spot, floor, liquidity, fee, amount]) => ({ spot, floor, liquidity, fee, amount }));
  assert.ok(floorProbes.length >= 2, 'missing untouched and traded curve probes');
  for (const probe of floorProbes) {
    const state = Object.fromEntries(Object.entries(probe).map(([key, value]) => [key, BigInt(value)]));
    assert.equal(belowFloorSellAmount(state), state.amount, 'JS input must match the real EVM floor probe');
  }
  assert.ok(floorProbes.some(probe => BigInt(probe.amount) > 100_000_000n * ETHER), 'must cover the traded curve, not only its launch state');
  const wrapped = [...output.matchAll(/ALPHA_WRAPPED\|([^|\n]+)\|(0x[0-9a-fA-F]{40})\|(\d+)\|(0x[0-9a-fA-F]+)/g)];
  assert.equal(wrapped.length, calls.filter(row => row.status === 'reverted' && row.data.startsWith(toFunctionSelector('WrappedError(address,bytes4,bytes,bytes)'))).length,
    'every wrapped control must identify its expected hook');
  for (const [, reason, hook, floor, data] of wrapped) assertAlphaHookError(data, { reason, hook, floor: BigInt(floor) });
  const drain = [...output.matchAll(/ALPHA_DRAIN\|(\d+)\|(\d+)/g)].map(([, tethIn, nativeOut]) => ({ tethIn, nativeOut }));
  assert.equal(drain.length, 2);
  assert.equal(drain.find(d => d.tethIn === '500000000000000000000')?.nativeOut, '1986039848828430680');
  assert.equal(drain.find(d => d.tethIn === '1000000000000000000')?.nativeOut, '663336296306204347');
  return { complete: false, kind: 'offline-contract-controls', calls, floorProbes, drain };
}

async function routerError(r, box, from, reason, overrides = {}) {
  const snapshot = await r.snapshot();
  try {
    const router = await r.read('BoxCoordinatorV2', box, 'launchRouter');
    const p = await r.read('BoxCoordinatorV2', box, 'q');
    const now = (await r.client.getBlock()).timestamp;
    const o = { amount: ETHER / 1000n, min: 1n, to: from, deadline: now + 120n, value: p === zeroAddress ? ETHER / 1000n : 0n, ...overrides };
    assert.ok(await r.balance(p, from) >= o.amount, `router ${reason}: funded input`);
    if (p !== zeroAddress) {
      await r.call(`router ${reason}: exact approval`, from, 'ERC20', p, 'approve', [router, o.amount]);
      assert.equal(await r.read('ERC20', p, 'allowance', [from, router]), o.amount);
    }
    const expectedContractReason = routerErrors[reason].split('(')[0];
    const result = await r.call(`router ${reason}`, from, 'BoxLaunchRouterV2', router, 'buy', [o.amount, o.min, o.to, o.deadline], o.value, reason,
      { expectedContractReason });
    assert.equal(result.row.contractReason, expectedContractReason, 'direct router error');
    if (p !== zeroAddress) await r.call(`router ${reason}: revoke`, from, 'ERC20', p, 'approve', [router, 0n]);
  } finally { await r.restore(snapshot); }
}
async function floorState(r, box, hook, key) {
  const block = await r.client.getBlock();
  const [, upper, liquidity] = await r.read('BoxHookV2', hook, 'curve', [], block.number);
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const base = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256'), [poolId, 6n]));
  const load = async slot => BigInt(await r.client.readContract({ abi: TRADE_ABI,
    address: r.manifest.localDeployment.poolManager, functionName: 'extsload', args: [slot], blockNumber: block.number }));
  const slot0 = await load(base);
  const spot = slot0 & ((1n << 160n) - 1n);
  const floor = getSqrtPriceAtTick(upper);
  const active = await load(toHex(BigInt(base) + 3n, { size: 32 })) & ((1n << 128n) - 1n);
  assert.ok(active === liquidity || (spot === floor && active === 0n), 'single curve liquidity');
  assert.equal(await r.read('BoxHookV2', hook, 'phase', [], block.number), 3, 'floor probe requires Bonding');
  assert.equal((await r.read('BoxCoordinatorV2', box, 'token', [], block.number)).toLowerCase(), key.currency1.toLowerCase());
  const lpFee = (slot0 >> 208n) & 0xffffffn;
  const protocolFee = (slot0 >> 196n) & 0xfffn; // oneForZero (T input), not the buy-direction fee.
  const fee = protocolFee + lpFee - protocolFee * lpFee / 1_000_000n;
  return { block: block.number.toString(), blockHash: block.hash, spot, floor, liquidity, fee };
}

async function fundFloorProbe(r, box, from, token, amount) {
  const before = await r.balance(token, from);
  if (before >= amount) return 0n;
  const shortfall = amount - before;
  assert.ok(await r.balance(token, box) >= shortfall, 'coordinator reserve must cover floor probe');
  // Impossible user inventory is intentional for this invariant probe: transfer existing reserve T,
  // without minting or modifying token/pool storage. The caller owns the surrounding snapshot.
  await r.request({ method: 'anvil_impersonateAccount', params: [box] });
  try {
    await r.request({ method: 'anvil_setBalance', params: [box, hex(ETHER)] });
    await r.call('floor protocol probe: reserve funding (snapshot)', box, 'ERC20', token, 'transfer', [from, shortfall]);
  } finally { await r.request({ method: 'anvil_stopImpersonatingAccount', params: [box] }); }
  return shortfall;
}

export async function poolError(r, box, from, reason, buy = true) {
  const snapshot = await r.snapshot();
  try {
    const hook = await r.read('BoxCoordinatorV2', box, 'hook');
    const key = await r.read('BoxHookV2', hook, 'poolKey');
    const helper = r.manifest.localDeployment.poolSwapTest;
    const state = reason === 'below_curve_floor' ? await floorState(r, box, hook, key) : null;
    const amount = state ? belowFloorSellAmount(state) : buy ? ETHER / 1000n : 1000n * ETHER;
    const input = buy ? key.currency0 : key.currency1;
    const label = `pool ${buy ? 'buy' : 'sell'} ${reason}`;
    const funded = state ? await fundFloorProbe(r, box, from, input, amount) : 0n;
    if (input !== zeroAddress) {
      await r.call(`${label}: exact approval`, from, 'ERC20', input, 'approve', [helper, amount]);
      assert.equal(await r.read('ERC20', input, 'allowance', [from, helper]), amount);
    }
    const balance = await r.balance(input, from);
    assert.ok(balance >= amount, `${label}: funded input`);
    const result = await r.send(label, from, helper,
      encodeFunctionData({ abi: TRADE_ABI, functionName: 'swap', args: [key,
        { zeroForOne: buy, amountSpecified: -amount, sqrtPriceLimitX96: state ? state.floor + 1n : buy ? MIN_PRICE : MAX_PRICE },
        { takeClaims: false, settleUsingBurn: false }, '0x'] }), input === zeroAddress ? amount : 0n, reason,
      { expectedContractReason: hookErrors[reason].split('(')[0], scenario: { ...state, amount, balance, funded, hook, input } });
    assertAlphaHookError(result.row.data, { hook, reason, floor: state?.floor });
    if (input !== zeroAddress) {
      assert.equal(await r.balance(input, from), balance, `${label}: reverted balance`);
      assert.equal(await r.read('ERC20', input, 'allowance', [from, helper]), amount, `${label}: reverted allowance`);
      await r.call(`${label}: revoke`, from, 'ERC20', input, 'approve', [helper, 0n]);
      assert.equal(await r.read('ERC20', input, 'allowance', [from, helper]), 0n);
    }
  } finally { await r.restore(snapshot); }
}
async function negativeUpcoming(r, box, from) {
  await routerError(r, box, from, 'not_open');
  await poolError(r, box, from, 'trading_not_open');
}
async function negativeWindow(r, box, from) {
  const router = await r.read('BoxCoordinatorV2', box, 'launchRouter');
  await routerError(r, box, from, 'expired', { deadline: 1n });
  await routerError(r, box, from, 'wrong_value', { value: 0n });
  await routerError(r, box, from, 'insufficient_output', { min: (1n << 256n) - 1n });
  await routerError(r, box, from, 'amount_too_small', { amount: 0n, value: 0n });
  await routerError(r, box, from, 'recipient_refused', { to: router });
  await poolError(r, box, from, 'buy_through_launch_router');
  const snapshot = await r.snapshot();
  try {
    await r.trade('negative branch: close curve in window', box, 'buy', 200n * ETHER, from, { full: false });
    await routerError(r, box, from, 'curve_closed');
  } finally { await r.restore(snapshot); }
}
async function negativeClosed(r, box, from) {
  const hook = await r.read('BoxCoordinatorV2', box, 'hook');
  assert.equal(await r.read('BoxHookV2', hook, 'phase'), 4, 'closed probes require ungraduated full curve');
  await poolError(r, box, from, 'curve_closed');
  await poolError(r, box, from, 'curve_closed', false);
}
async function negativeBonding(r, box, from) {
  await routerError(r, box, from, 'window_closed');
  await poolError(r, box, from, 'below_curve_floor', false);
  let snapshot = await r.snapshot();
  try {
    await mineTo(r.url, await r.read('BoxCoordinatorV2', box, 'deadline') + 1n);
    assert.equal(await r.read('BoxHookV2', await r.read('BoxCoordinatorV2', box, 'hook'), 'closed'), false);
    await poolError(r, box, from, 'failure_pending');
  } finally { await r.restore(snapshot); }
  // UnknownPool is a manager-only hook invariant, unreachable through a normal tester call.
  snapshot = await r.snapshot();
  const manager = r.manifest.localDeployment.poolManager;
  try {
    const hook = await r.read('BoxCoordinatorV2', box, 'hook');
    const key = { ...await r.read('BoxHookV2', hook, 'poolKey'), fee: 3000 };
    await r.request({ method: 'anvil_impersonateAccount', params: [manager] });
    await r.request({ method: 'anvil_setBalance', params: [manager, hex(100n * ETHER)] });
    const result = await r.call('protocol probe: unknown_pool', manager, 'BoxHookV2', hook, 'beforeSwap',
      [from, key, { zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: MIN_PRICE }, '0x'], 0n, 'unknown_pool',
      { expectedContractReason: 'UnknownPool' });
    assert.equal(decodeErrorResult({ abi: artifact('BoxHookV2').abi, data: result.row.data }).errorName, 'UnknownPool');
  } finally {
    await r.request({ method: 'anvil_stopImpersonatingAccount', params: [manager] });
    await r.restore(snapshot);
  }
}

async function pairSwap(r, label, from, input, output, amount) {
  const helper = r.manifest.localDeployment.poolSwapTest;
  const zeroForOne = BigInt(input) < BigInt(output);
  const key = { currency0: zeroForOne ? input : output, currency1: zeroForOne ? output : input,
    fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const before = await r.balance(output, from);
  assert.ok(await r.balance(input, from) >= amount, `${label}: funded input`);
  await r.call(`${label}: exact approval`, from, 'ERC20', input, 'approve', [helper, amount]);
  assert.equal(await r.read('ERC20', input, 'allowance', [from, helper]), amount);
  const { receipt } = await r.send(label, from, helper, encodeFunctionData({ abi: TRADE_ABI, functionName: 'swap', args: [key,
    { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_PRICE : MAX_PRICE },
    { takeClaims: false, settleUsingBurn: false }, '0x'] }));
  const out = await r.balance(output, from) - before + (output === zeroAddress ? receipt.gasUsed * receipt.effectiveGasPrice : 0n);
  assert.equal(await r.read('ERC20', input, 'allowance', [from, helper]), 0n, 'drain hop must consume whole input');
  await r.call(`${label}: clear approval`, from, 'ERC20', input, 'approve', [helper, 0n]);
  return out;
}
async function drain(r, a, owner, tester) {
  const outputs = [];
  for (const budget of [ETHER, 500n * ETHER]) {
    const snapshot = await r.snapshot();
    try {
      for (const coin of [a.teth, a.gold, a.pepe]) assert.equal(await r.balance(coin, tester), 0n, 'fresh drain inventory');
      // Models aggregation of already dripped balances. It does not claim one address can drip 500 tETH.
      await r.call(`drain budget ${budget}: aggregate funding`, owner, 'ERC20', a.teth, 'transfer', [tester, budget]);
      assert.equal(await r.balance(a.teth, tester), budget);
      let nativeOut = 0n;
      for (const coin of [a.gold, a.pepe]) {
        const received = await pairSwap(r, 'drain tETH to coin', tester, a.teth, coin, budget / 2n);
        nativeOut += await pairSwap(r, 'drain coin to SepETH', tester, coin, zeroAddress, received);
        assert.equal(await r.balance(coin, tester), 0n);
      }
      assert.equal(await r.balance(a.teth, tester), 0n);
      assert.ok(nativeOut > 0n && nativeOut < 2n * ETHER);
      outputs.push({ tethIn: budget.toString(), nativeOut: nativeOut.toString() });
    } finally { await r.restore(snapshot); }
  }
  return { ...outputs[1], singleTester: outputs[0], split: '50/50 GOLD/PEPE; achievable, not an optimization claim',
    depthSource: 'docs/evidence/SH-TA-30.md:107; docs/design/sepolia-alpha-v1.md Chain facts',
    assumption: '500 admitted daily drips pooled by transfer; recorded 1 SepETH per retained pool, zero protocol fee' };
}

const startedHere = () => { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } };
if (startedHere()) {
  if (process.argv.length !== 2) throw new Error('alpha rehearsal takes no RPC, key, fork or other CLI argument');
  await runAlphaRehearsal();
}
