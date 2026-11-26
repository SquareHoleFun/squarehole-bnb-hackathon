import { abiCall, decodeFunctionResult, keccak256, lower, need, plain, PROBE_AMOUNT, registryAbi, toHex, ZERO } from './common.mjs';
import { parseInput } from './config.mjs';
import { Reader } from './rpc.mjs';
import { staticChecks, probeChecks } from './checks.mjs';
import { issuerPowers, issuerSheet } from './powers.mjs';
import { Market, roundRaise, runnerEntries } from './market.mjs';
import { listingCalls, multiSend, simulate, transactionBuilder } from './batch.mjs';
import { proposeRoyaltyLot } from './royalty-lots.mjs';

const routeReport = r => ({ path: r.path, pools: r.pools.map(p => ({ kind: p.kind, id: p.id, token0: p.token0, token1: p.token1,
  reserve0: p.reserve0, reserve1: p.reserve1, liquidity: p.liquidity, sqrtPriceX96: p.sqrtPriceX96, fee: p.fee, hooks: p.hooks })),
  referenceAmount: r.referenceAmount, quotedOut: r.quotedOut, spotOut: r.spotOut, impactBps: r.impactBps });

export async function buildListingKit(input, rpc, allowMainnet = false, scanOptions = {}) {
  const config = parseInput(input, allowMainnet);
  const reader = await new Reader(rpc, config, scanOptions).init();
  await reader.pin(config.registry); await reader.pin(config.multiSend);
  need(await reader.code(config.safe) !== '0x', 'Safe contract code required');
  need(lower(await reader.read(config.registry.address, 'function lister() view returns (address)')) === config.safe, 'platform Safe is not lister');
  need(!await reader.read(config.registry.address, 'function renounced() view returns (bool)'), 'lister renounced');
  need(lower(await reader.read(config.registry.address, 'function weth() view returns (address)')) === config.weth, 'registry WETH mismatch');
  need(lower(await reader.read(config.registry.address, 'function poolManager() view returns (address)')) === config.market.v4.manager.address, 'registry PoolManager mismatch');
  const boxRegistry = lower(await reader.read(config.registry.address, 'function boxRegistry() view returns (address)'));
  need(await reader.code(boxRegistry) !== '0x', 'box registry code required');
  const { data } = abiCall('function listing(uint32) view returns (bytes)', [0]);
  const native = decodeFunctionResult({ abi: registryAbi, functionName: 'listing',
    data: await reader.request('eth_call', [{ to: config.registry.address, data }, reader.tag]) });
  need(native.token === ZERO && native.class === 1 && native.raise > 0n, 'invalid native listing');
  const listingCount = BigInt(await reader.read(config.registry.address, 'function listingCount() view returns (uint32)'));
  need(listingCount > 0n, 'native listing required');
  const market = await new Market(reader, config).discover();
  const coins = [], dust = [], candidates = [], entries = [], quoters = [], unavailable = [];
  for (const coin of config.tokens) {
    const state = await staticChecks(reader, config, coin, boxRegistry);
    const powers = await issuerPowers(reader, config, coin.token, state.code);
    const reference = BigInt(coin.referenceAmount ?? config.referenceAmount);
    const discovered = await market.routes(coin, reference);
    const best = discovered.routes[0];
    let raise = null, raiseReport;
    try {
      if (config.raisePolicy.kind === 'fixed') {
        need(config.raisePolicy.amounts[coin.token], 'fixed raise missing');
        raise = BigInt(config.raisePolicy.amounts[coin.token]);
        raiseReport = { amount: raise, policy: config.raisePolicy, method: 'founder fixed raw amount' };
      } else {
        need(best, 'no quoteable route');
        const valuation = await market.raise(best, BigInt(config.raisePolicy.ethRaise ?? native.raise));
        raise = roundRaise(valuation.amount, config.raisePolicy.rounding);
        raiseReport = { ...valuation, unroundedAmount: valuation.amount, amount: raise,
          nativeListingRaise: native.raise, policy: config.raisePolicy, route: best.path };
      }
    } catch { raiseReport = { amount: null, policy: config.raisePolicy, reason: 'raise unavailable: requires full archive history of the deepest route, or an explicit fixed raise' }; }
    let royaltyLot = null;
    const lotCheck = { id: 'royalty-lot', status: 'fail', detail: 'CW2 lot unavailable: a quoted snapshot route and valid decimals are required' };
    try {
      need(best, 'no recorded lot price');
      const price = { tokenAmount: best.referenceAmount.toString(), wethAmount: best.spotOut.toString(),
        source: `Pinned marginal spot via ${best.pools.map(p => `${p.kind}:${p.id}`).join(' -> ')}; path ${best.path.join(' -> ')}; WETH wei per raw token (before fees)`,
        blockNumber: reader.end.number.toString(), blockHash: reader.end.hash, timestamp: reader.end.timestamp.toString() };
      royaltyLot = { token: coin.token, listingId: listingCount, lot: proposeRoyaltyLot(state.decimals, coin.class, price), price };
      lotCheck.status = 'pass'; lotCheck.detail = 'CW2 snapshot value; two significant digits; checked against default and value bounds';
    } catch { /* Missing prices or unrepresentable lots fail closed, including fixed-raise inputs. */ }
    // Each isolated simulation starts at the same current count. The combined batch assigns final IDs below.
    const probe = await probeChecks(reader, config, coin, state, raise, royaltyLot);
    const checks = [...state.checks, lotCheck, { id: 'issuer-policy', status: powers.policyBlocks.length ? 'fail' : 'pass',
      detail: powers.policyBlocks.length ? powers.policyBlocks.join(', ') : 'no known rebase/fee switch or unresolved proxy detected; manual issuer review still required' }, ...probe.checks];
    const eligible = checks.every(c => c.status === 'pass');
    const result = { ...coin, decimals: state.decimals, eligible, checks, powers, raise: raiseReport, royaltyLot,
      route: best ? routeReport(best) : null, routeCandidates: discovered.candidates, quoteableRoutes: discovered.routes.length,
      rejectedRoutes: discovered.rejected, alternatives: discovered.routes.slice(1).map(routeReport) };
    coins.push(result);
    dust.push({ token: coin.token, safe: config.safe, required: PROBE_AMOUNT, held: state.held,
      shortfall: state.held === null ? null : state.held >= PROBE_AMOUNT ? 0n : PROBE_AMOUNT - state.held,
      consumedByProbe: 0n, approvalRemains: PROBE_AMOUNT, eligible });
    if (eligible) {
      royaltyLot.listingId = listingCount + BigInt(candidates.length);
      candidates.push({ calls: listingCalls(config, coin, raise, state.allowance, royaltyLot) });
      if (best) {
        const entry = runnerEntries(config, coin, best, reference);
        if (entry.route) { entries.push(entry.route); quoters.push(entry.quoter); }
        else {
          unavailable.push({ token: coin.token, reason: entry.reason });
          // Report the best supported alternative distinctly; never relabel the deepest route.
          const alternative = discovered.routes.slice(1).find(r => r.pools[0].kind !== 'v2' && r.pools.every(p => p.kind === r.pools[0].kind));
          if (alternative) {
            const fallback = runnerEntries(config, coin, alternative, reference);
            if (fallback.route) { entries.push(fallback.route); quoters.push(fallback.quoter); result.runnerAlternative = routeReport(alternative); }
          }
        }
      } else unavailable.push({ token: coin.token, reason: 'no quoteable route in configured discovery scope' });
    }
  }
  let calls = candidates.flatMap(c => c.calls);
  if (calls.length) {
    try { await simulate(reader, config, calls); }
    catch {
      for (const coin of coins.filter(c => c.eligible)) {
        coin.eligible = false; coin.checks.push({ id: 'combined-batch', status: 'fork run needed', detail: 'combined read-only MultiSend failed; batch withheld' });
      }
      for (const coin of dust) coin.eligible = false;
      calls = []; entries.length = 0; quoters.length = 0;
    }
  }
  reader.assertScansComplete();
  await reader.canonical();
  const lots = coins.filter(c => c.eligible).map(c => c.royaltyLot);
  const royaltyLots = { format: 'squarehole.royalty-lots/1', chainId: config.chainId, registry: config.registry.address, weth: config.weth, entries: lots };
  const issuerSheets = Object.fromEntries(coins.map(c => [c.token, issuerSheet(c, reader.end)]));
  return plain({ format: 'squarehole.listing-kit/1', chainId: config.chainId, snapshot: reader.end, snapshotTag: config.chainId === '31337' ? 'latest' : 'finalized',
    inputHash: keccak256(toHex(JSON.stringify(input))), policy: config.raisePolicy,
    discovery: { bridges: config.bridges, v3Fees: config.market.v3.fees, v4FromBlock: config.market.v4.fromBlock,
      logChunk: config.logChunk, maxScanBlocks: config.maxScanBlocks, scannedBlocks: reader.scannedBlocks,
      allowedV4Hooks: config.market.v4.allowedHooks, excluded: market.excluded, scope: 'deepest quoteable route within supplied factory pins, v3 fee tiers and bridges, at most three hops; no claim of global coverage',
      depthDefinition: 'lowest reference-trade price impact including fees and tick crossings; exact loss fraction, then higher output, then pool IDs; virtual reserves are informational only',
      historicalLimit: 'requires archive state and complete event logs; reconciliation detects changed final prices, not every possible RPC omission' },
    coins, dust, royaltyLots, runner: { routes: entries, quoters, unavailable }, issuerSheets,
    safeBatch: transactionBuilder(config, calls, reader.end.timestamp, lots), multiSend: calls.length ? multiSend(config, calls) : null,
    limits: ['Unsigned and unsent. No Safe signature/guard execution is tested by the Safe-code override.',
      'Repeat against fresh finalized state and rehearse the complete Safe transaction on a fork before signing.',
      'A passing 10000-unit probe does not prove future behavior, larger transfers or all recipients. No payout automation is included.'] });
}
