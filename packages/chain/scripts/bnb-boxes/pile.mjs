/**
 * SH-261: the converter box's life on chain 97 (The Alchemist priced in BNB: the buyers' fees are converted into a
 * pile of tNVDA through the release's converter route; the sellers' fees buy the box token and burn it), every amount
 * checked to the last raw unit. Local or real (chain.mjs); a run started again with its state file goes on.
 *
 *   1. Two traders buy on the curve, one sells part back; every collect is audited (the 2:1:2:10 split, the buyers'
 *      ten parts waiting for the converter as the receiver's module budget, the sellers' as the buy-back).
 *   2. The curve fills; the box graduates.
 *   3. The route's fixed trigger (the keeper's wallet, `conversionTrigger`) converts the waiting budget: the pile's
 *      tNVDA grows by exactly what the route paid out, the budget drops by exactly what went in.
 *   4. A trader redeems a quarter of its box tokens from the pile: exactly the vault's quote, which is its pro-rata
 *      share less the 5% left behind; the tokens burn.
 * A collect, graduation or buy-back pressed first by another account is read from the chain (life.mjs).
 */
import assert from 'node:assert/strict';
import { erc20Abi, zeroAddress } from 'viem';
import './ts.mjs';
import { readBox, buy, sell, afterGraduationTrades } from './life.mjs';
import { burnStep } from './items.mjs';

const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const { alchemistV21Abi } = await import('../../../../packages/chain/src/core/v2/alchemist-v21.ts');
const { feeAllocation } = await import('../../../../apps/web/e2e/core-v2-chain/examples/support.mjs');

const LEDGERS = [['fitOwed', coreV2.receiverV2Abi], ['platformOwed', coreV2.receiverV2Abi], ['poolHeldP', coreV2.receiverV2Abi], ['growHeldP', coreV2.receiverV2Abi],
  ['creatorP', coreV2.receiverV2Abi], ['buyBackP', coreV2.receiverV2Abi], ['itemsHeldP', coreV2.receiverV2Abi], ['royaltyHeldP', coreV2.receiverV2Abi],
  ['pilePendingP', coreV2.receiverPileV21Abi], ['eatPendingP', coreV2.receiverEatV21Abi], ['rewardsPendingP', coreV2.receiverPayInTV21Abi]];
const CLAIMS = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }];
/** The fee choices as feeAllocation names them; the module side keeps its own name in the rows. */
const ALLOCATED = { alchemist: 'keep', burn: 'burn' };

async function snapshot(chain, box, at) {
  const state = {};
  for (const [field, abi] of LEDGERS) state[field] = await chain.read(box.receiver, abi, field, [], at);
  state.moduleBuyersP = await chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'modulePendingP', [false], at);
  state.moduleSellersP = await chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'modulePendingP', [true], at);
  state.hookClaims = await chain.read(box.manager, CLAIMS, 'balanceOf', [box.hook, BigInt(box.p)], at);
  state.receiverClaims = await chain.read(box.manager, CLAIMS, 'balanceOf', [box.receiver, BigInt(box.p)], at);
  state.booked = await chain.read(box.receiver, coreV2.receiverV2Abi, 'booked', [box.p], at);
  state.dust = state.booked - state.moduleBuyersP - state.moduleSellersP - LEDGERS.reduce((total, [field]) => total + state[field], 0n);
  return state;
}

/**
 * One audited collect of a box without holder or item sources: each side's collected price coin plus its carried
 * remainder splits 2:1:2:10, the remainder below 15 is carried to the next (feeAuditor's unsourced model).
 */
async function pileCollect(chain, box, fees, keeper, carry, label) {
  return chain.act(`collect ${label}`, async () => {
    const receipt = await chain.send(keeper, box.receiver, coreV2.receiverV2Abi, 'collect', [zeroAddress]);
    const at = receipt.blockNumber;
    const before = await snapshot(chain, box, at - 1n);
    const graduated = await chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated', [], at - 1n);
    const [collected] = chain.events(receipt, coreV2.receiverV2Abi, 'Collected', box.receiver);
    assert.ok(collected, 'Collected');
    assert.equal(collected.tip, 0n);
    const allocations = [];
    const next = { ...carry };
    for (const side of ['buyers', 'sellers']) {
      const row = feeAllocation(collected[`${side}P`] + carry[side], ALLOCATED[fees[side].choice]);
      next[side] = row.dust;
      allocations.push({ ...row, choice: fees[side].choice, side });
    }
    const after = await snapshot(chain, box, at);
    const sum = key => allocations.reduce((n, row) => n + row[key], 0n);
    const branch = choice => allocations.filter(row => row.choice === choice).reduce((n, row) => n + row.branch, 0n);
    const delta = field => after[field] - before[field];
    const checks = {
      fitOwed: [delta('fitOwed'), sum('fit')],
      platformOwed: [delta('platformOwed'), sum('platform')],
      moduleBuyersP: [delta('moduleBuyersP'), branch('alchemist')],
      buyBackP: [delta('buyBackP'), branch('burn')],
      poolHeldP: [delta('poolHeldP'), graduated ? 0n : sum('pool')],
      hookClaims: [delta('hookClaims'), graduated ? sum('pool') : 0n],
      carried: [after.dust, next.buyers + next.sellers],
      conservation: [delta('booked') + delta('hookClaims'), collected.buyersP + collected.sellersP],
    };
    for (const [name, [actual, expected]] of Object.entries(checks)) assert.equal(actual, expected, `collect ${label}: ${name}`);
    // The converter's budget after this collect, the anchor of a conversion sent by another account.
    const budget = await chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'modulePendingP', [false], at);
    return { hash: receipt.transactionHash, block: at, budget, graduated, collected, allocations, checks, carry: next };
  });
}

/**
 * The converter box's life. Roles: `keeper` presses the public steps and must be the route's conversion trigger,
 * `a` and `b` trade (they hold BNB). `fees` from the registry row.
 */
export async function converterLife(chain, coordinator, { swapper, keeper, a, b, fees, tradeAfter = null }) {
  const box = await readBox(chain, coordinator);
  const pile = await chain.read(coordinator, coreV2.coordinatorV2Abi, 'vault');
  const asset = await chain.read(pile, coreV2.pileVaultV2Abi, 'asset');
  const leave = BigInt(await chain.read(pile, coreV2.pileVaultV2Abi, 'leaveBehindBps'));
  const [module] = await chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'sideModule', [false]);
  const trigger = await chain.read(module, alchemistV21Abi, 'conversionTrigger');
  assert.equal(trigger.toLowerCase(), keeper.toLowerCase(), `the keeper role must be the route's conversion trigger ${trigger}`);
  let carry = { buyers: 0n, sellers: 0n };
  const collects = [];
  const collect = async label => { const c = await pileCollect(chain, box, fees, keeper, carry, label); carry = c.carry; collects.push(c); return c; };
  await chain.act('past the launch window', async () => { await chain.mineTo((await chain.read(box.hook, coreV2.hookV2Abi, 'windowEndsAt')) + 1n); return chain.now(); });
  const tenth = box.raise / 10n;
  const boughtA = await chain.act('raising: A buys a tenth', () => buy(chain, box, a, tenth, swapper));
  await chain.act('raising: B buys a tenth', () => buy(chain, box, b, tenth, swapper));
  await chain.act('raising: A sells a quarter', () => sell(chain, box, a, boughtA / 4n, swapper));
  await collect('raising');
  for (let i = 1; i <= 6; i += 1) {
    const filled = await chain.act(`fill ${i}`, async () => {
      if (await chain.remember('closed', () => chain.read(box.hook, coreV2.hookV2Abi, 'closed'))) return 'closed';
      return buy(chain, box, a, box.raise / 4n, swapper);
    });
    if (filled === 'closed') break;
  }
  assert.ok(await chain.read(box.hook, coreV2.hookV2Abi, 'closed'), 'the curve filled');
  await collect('filled');
  // Graduated already (read BEFORE a send, kept): accepted. Otherwise the keeper's graduate is sent and its receipt is
  // required (no catch: a failed or reverted send stops the run).
  await chain.act('graduate', async () => {
    if (await chain.remember('graduated', () => chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated'))) return 'already';
    return (await chain.send(keeper, box.coordinator, coreV2.coordinatorV2Abi, 'graduate')).transactionHash;
  });
  await collect('graduated');
  // Trades after graduation add buyers' fees for the converter and sale fees for the burn: the sale fees are sold for
  // price coin (a positive FeesSold), then collected.
  // The sellers' share must reach the buy-back's step minimum (the listing's swapStepMinQ) before a burn can be shown:
  // rounds of trades and sale-fee steps, each collected, until it does (at most eight).
  const minimum = await chain.act('the buy-back step minimum', async () => (await chain.read(await chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'factory'), coreV2.factoryV2Abi, 'boxQParameters', [await chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'pricingListingId'), box.raise])).swapStepMinQ);
  // At least one pass always runs: each pass's sale fees sold (positive FeesSold) must be exactly what the sellers'
  // collection that follows it took (Collected.sellersP = the sum of pOut less tips), or the run stops.
  const feesSold = { sold: 0n, steps: [], reconciled: [] };
  for (let pass = 1; pass <= 8; pass += 1) {
    const done = pass > 1 && await chain.act(`sellers' share ${pass}: enough to buy back`, async () => (await chain.read(box.receiver, coreV2.receiverV2Abi, 'buyBackP')) >= minimum);
    if (done) break;
    assert.ok(pass < 8, 'the sellers\' share did not reach the buy-back step minimum in seven passes');
    const sold = await afterGraduationTrades(chain, box, { keeper, b, amount: tradeAfter ?? tenth, swapper, prefix: `after graduation, pass ${pass}` });
    feesSold.sold += sold.sold; feesSold.steps.push(...sold.steps);
    const c = await collect(`after graduation, pass ${pass}`);
    const net = sold.steps.reduce((n, step) => n + BigInt(step.net), 0n);
    assert.equal(BigInt(c.collected.sellersP), net, `pass ${pass}: the sellers' collection ${c.hash} took ${c.collected.sellersP}, the sale fees sold were ${net} net (${sold.steps.map(step => step.hash).join(', ')}): stop`);
    feesSold.reconciled.push({ pass, collect: c.hash, sellersP: c.collected.sellersP, sales: sold.steps.map(step => step.hash) });
  }
  // The conversion: the route's trigger converts the waiting budget into the pile's coin.
  const conversion = await chain.act('convert into the pile', async () => {
    const waiting = await chain.remember('waiting', () => chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'modulePendingP', [false]));
    if (waiting === 0n) {
      // Converted by another account first (the live keeper): searched from THIS life's last collect on; the first
      // PileConverted for this receiver, pile and coin after it must be a successful transaction of the route's trigger
      // that took exactly the budget that collect left (the budget before its block), with the pile grown by its output.
      const last = collects.at(-1);
      const latest = await chain.client.getBlockNumber({ cacheTime: 0 });
      const logs = await chain.client.getContractEvents({ address: module, abi: alchemistV21Abi, eventName: 'PileConverted', args: { receiver: box.receiver, pile, asset }, fromBlock: last.block, toBlock: latest });
      const found = logs.find(log => log.blockNumber > last.block || (log.blockNumber === last.block && log.transactionHash !== last.hash));
      assert.ok(found, `nothing waits for the converter, and no conversion into this pile was found after this life's collect ${last.hash}: stop`);
      const receipt = await chain.client.getTransactionReceipt({ hash: found.transactionHash });
      assert.equal(receipt.status, 'success', `the conversion found (${found.transactionHash}) reverted: stop`);
      assert.equal(receipt.from.toLowerCase(), trigger.toLowerCase(), 'the conversion found was sent by the route\'s trigger');
      const at = receipt.blockNumber;
      const before = { pending: await chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'modulePendingP', [false], at - 1n), pile: await chain.read(asset, erc20Abi, 'balanceOf', [pile], at - 1n) };
      const after = { pending: await chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'modulePendingP', [false], at), pile: await chain.read(asset, erc20Abi, 'balanceOf', [pile], at) };
      assert.equal(before.pending, BigInt(last.budget), `the conversion found (${found.transactionHash}) started from another budget than this life's collect left: stop`);
      assert.equal(before.pending - after.pending, found.args.amountIn, 'the budget dropped by exactly what went in');
      assert.equal(after.pile - before.pile, found.args.amountOut, 'the pile grew by exactly what the route paid out');
      assert.ok(found.args.amountOut > 0n, 'the pile received tNVDA');
      return { by: receipt.from, hash: found.transactionHash, block: at, amountIn: found.args.amountIn, amountOut: found.args.amountOut, pileAfter: after.pile };
    }
    const receipt = await chain.send(keeper, box.receiver, coreV2.receiverModulesV21Abi, 'executeModule', [false]);
    const at = receipt.blockNumber;
    const before = { pending: await chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'modulePendingP', [false], at - 1n), pile: await chain.read(asset, erc20Abi, 'balanceOf', [pile], at - 1n) };
    const after = { pending: await chain.read(box.receiver, coreV2.receiverModulesV21Abi, 'modulePendingP', [false], at), pile: await chain.read(asset, erc20Abi, 'balanceOf', [pile], at) };
    const [converted] = chain.events(receipt, alchemistV21Abi, 'PileConverted', module);
    const dust = chain.events(receipt, alchemistV21Abi, 'DustToDepth');
    if (!converted && process.env.SH_BNB_TRACE) {
      const { rpc } = await import('./chain.mjs');
      const trace = await rpc(chain.url, 'debug_traceTransaction', [receipt.transactionHash, { tracer: 'callTracer' }]).catch(e => ({ error: e.message }));
      const walk = (frame, depth = 0) => { if (frame.error || frame.revertReason) process.stdout.write(`${' '.repeat(depth)}${frame.to} ${frame.input?.slice(0, 10)} ${frame.error ?? ''} ${frame.revertReason ?? ''} ${frame.output?.slice(0, 138) ?? ''}\n`); for (const c of frame.calls ?? []) walk(c, depth + 1); };
      walk(trace);
    }
    assert.ok(converted, `the route converted (PileConverted): ${dust.length ? `DustToDepth ${dust[0].amount}` : ''} logs ${receipt.logs.map(l => `${l.address}:${l.topics[0]?.slice(0, 10)}`).join(' ')}; module ${module}; pending before ${before.pending} after ${after.pending}; pile before ${before.pile} after ${after.pile}`);
    assert.equal(before.pending - after.pending, converted.amountIn, 'the budget dropped by exactly what went in');
    assert.equal(after.pile - before.pile, converted.amountOut, 'the pile grew by exactly what the route paid out');
    assert.ok(converted.amountOut > 0n, 'the pile received tNVDA');
    return { hash: receipt.transactionHash, amountIn: converted.amountIn, amountOut: converted.amountOut, pileAfter: after.pile };
  });
  const burned = await burnStep(chain, box, keeper, 'the sellers\' fees', { required: true });
  // A redeems a quarter of its box tokens from the pile: the vault's quote, its pro-rata share less the 5% left behind.
  const redeemed = await chain.act('A redeems a quarter', async () => {
    const quote = await chain.remember('quote', async () => {
      const amount = (await chain.balance(box.token, a)) / 4n;
      const supply = await chain.read(box.token, erc20Abi, 'totalSupply');
      const held = await chain.read(asset, erc20Abi, 'balanceOf', [pile]);
      const expected = held * amount / supply * (10_000n - leave) / 10_000n;
      const quoted = await chain.read(pile, coreV2.pileVaultV2Abi, 'quoteRedeem', [amount]);
      assert.equal(quoted, expected, 'the quote is the pro-rata share less the 5% left behind, to the raw unit');
      assert.ok(amount > 0n && quoted > 0n, `a redemption of ${amount} LEAD quoted ${quoted}: nothing to show, nothing is approved`);
      return { amount, supply, held, quoted, coins: await chain.read(asset, erc20Abi, 'balanceOf', [a]) };
    });
    await chain.send(a, box.token, erc20Abi, 'approve', [pile, quote.amount]);
    await chain.send(a, pile, coreV2.pileVaultV2Abi, 'redeem', [quote.amount, quote.quoted, a]);
    const got = (await chain.read(asset, erc20Abi, 'balanceOf', [a])) - quote.coins;
    assert.equal(got, quote.quoted, 'A received exactly the quote in tNVDA');
    assert.ok(got > 0n, 'A received tNVDA');
    assert.equal(quote.supply - await chain.read(box.token, erc20Abi, 'totalSupply'), quote.amount, 'the redeemed box tokens burned');
    assert.equal(quote.held - await chain.read(asset, erc20Abi, 'balanceOf', [pile]), quote.quoted, 'the pile paid exactly the quote');
    return { ...quote, received: got };
  });
  // GREEN only with every effect's evidence: a conversion with a positive output, a positive burn, a positive payout.
  assert.ok(feesSold.sold > 0n && feesSold.steps.length > 0 && feesSold.reconciled.length > 0, 'sale fees of this life were sold (FeesSold) and collected');
  assert.ok(conversion.amountOut > 0n && conversion.hash, 'the conversion has its transaction and a positive output');
  assert.ok(burned.tBurned > 0n && burned.hash, 'the sellers\' fees burned LEAD (BoughtBack)');
  assert.ok(redeemed.received > 0n, 'the redemption paid tNVDA');
  return { box: { coordinator, token: box.token, p: box.p, raise: box.raise, pile, asset, module, trigger }, collects, feesSold, conversion, burned, redeemed, gasPaid: chain.gasPaid() };
}
