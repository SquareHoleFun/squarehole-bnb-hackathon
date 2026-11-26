/**
 * SH-261: the life of a demo box on chain 97, every amount checked to the last raw unit. Local (a node's accounts) or
 * real (keystores through `cast send`, chain.mjs); a run started again with its state file goes on where it stopped.
 *
 * The holders box (the stock box: fees To holders in its price coin): two holders buy on the curve, one sells part
 * back; each fee collection is audited against the 2:1:2:10 split of every fee source (the browser suite's own
 * `feeAllocation` and `nextSources`, apps/web/e2e/core-v2-chain/examples/support.mjs, and the checks of its
 * `feeAuditor`); each paid batch is settled and every holder's claim pays exactly its quote in the price coin; the curve
 * fills, the box graduates, trades go on after graduation, their sale fees are sold to the price coin (`sellFees`),
 * collected, settled and claimed the same way.
 *
 * Trades go through the release's swapper (`PriceLimitSwapper`, deployed by the genesis step) with the curve's own
 * price limits (`boxCurve`, packages/box-spec/src/layout-v2.ts), as the local stack's actions trade
 * (packages/contracts/script/local/CoreV2LocalActions.sol). The public steps (collect, graduate, sellFees, settleBatch)
 * are pressed by a keeper role with no tip.
 */
import assert from 'node:assert/strict';
import { erc20Abi, parseAbi, zeroAddress } from 'viem';
import './ts.mjs';
import { gasOf } from './chain.mjs';

const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const { boxCurve } = await import('../../../../packages/box-spec/src/layout-v2.ts');
const { feeAllocation, nextSources } = await import('../../../../apps/web/e2e/core-v2-chain/examples/support.mjs');

const SWAPPER = parseAbi(['function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, int256 amountSpecified, uint160 limit) payable returns (int256)']);
const CLAIMS = parseAbi(['function balanceOf(address owner, uint256 id) view returns (uint256)']);
const LEDGERS = [['fitOwed', coreV2.receiverV2Abi], ['platformOwed', coreV2.receiverV2Abi], ['poolHeldP', coreV2.receiverV2Abi], ['growHeldP', coreV2.receiverV2Abi],
  ['creatorP', coreV2.receiverV2Abi], ['buyBackP', coreV2.receiverV2Abi], ['itemsHeldP', coreV2.receiverV2Abi], ['royaltyHeldP', coreV2.receiverV2Abi],
  ['pilePendingP', coreV2.receiverPileV21Abi], ['eatPendingP', coreV2.receiverEatV21Abi], ['rewardsPendingP', coreV2.receiverPayInTV21Abi]];
const ProtocolSkip = Object.freeze({ None: 0, StepTaken: 1, BelowMinimum: 2 });
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * The receiver's own source cursors (`allocationCursors`: the last buyer and seller sources it allocated). A collect is
 * audited from them, not from this run's memory, so another account's collect in between (the live keeper's) changes
 * nothing: each collect is checked against the sources it allocated itself.
 */
const CURSORS = parseAbi(['function allocationCursors() view returns (uint256 lastBuyer, uint256 lastSeller, uint256 openBuyer, uint256 openSeller)']);
export async function receiverCursors(chain, box, at) {
  // IBoxReceiverCursorsV21 (IBoxReceiverV2.sol): not in the exported receiver ABI.
  const [buyers, sellers] = await chain.read(box.receiver, CURSORS, 'allocationCursors', [], at);
  return { buyers, sellers };
}

/**
 * The sources a collect allocated, by the receiver's own cursors before and after it (each side's ids step by two:
 * buyers odd from 1, sellers even from 2), with each source's net price coin as the hook closed it. The browser
 * suite's model of the walk (`nextSources`) is computed beside it and recorded as agreeing or not: with another
 * account's collect just before (the live keeper's), the model starts from the wrong place; the cursors do not.
 */
export async function allocatedSources(chain, box, before, after) {
  const picked = [];
  for (const side of ['buyers', 'sellers']) {
    const first = before[side] === 0n ? (side === 'buyers' ? 1n : 2n) : before[side] + 2n;
    for (let id = first; id <= after[side]; id += 2n) picked.push({ side, id, netP: (await chain.read(box.hook, coreV2.hookV2Abi, 'tradeBatch', [id])).netP });
  }
  return picked;
}

/** The box's parts, read from its coordinator. */
export async function readBox(chain, coordinator) {
  const at = fn => chain.read(coordinator, coreV2.coordinatorV2Abi, fn);
  const [token, hook, receiver, p, raise] = await Promise.all([at('token'), at('hook'), at('receiver'), at('q'), at('raise')]);
  const r = fn => chain.read(receiver, coreV2.receiverV2Abi, fn);
  const [holderLedger, itemLedger, manager] = await Promise.all([r('holderLedger'), r('itemLedger'), r('poolManager')]);
  assert.ok(BigInt(p) < BigInt(token), 'the price coin is currency0');
  return { coordinator, token, hook, receiver, p, raise, holderLedger, itemLedger, manager, curve: boxCurve(raise, false) };
}

const graduatedOf = (chain, box) => chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated');

/** The box tokens that moved to (`to`) or from (`from`) an address in one receipt (its Transfer events). */
function tokenMoves(chain, receipt, token, { to = null, from = null }) {
  return chain.events(receipt, erc20Abi, 'Transfer', token)
    .filter(e => (to === null || same(e.to, to)) && (from === null || same(e.from, from))).reduce((n, e) => n + e.value, 0n);
}

/**
 * One buy of `amount` raw price coin (the curve's end as its limit before graduation, the extreme after): approve the
 * swapper exactly, swap, clear the approval. Returns the box tokens received, read from the swap's own receipt (its
 * Transfer events to the buyer, never a balance difference that other activity could change); none received stops.
 * Runs inside an action.
 */
export async function buy(chain, box, from, amount, swapper, swapGas = gasOf('swap')) {
  const limit = await chain.remember('buy limit', async () => ((await graduatedOf(chain, box)) ? 0n : box.curve.sqrtPriceEndX96));
  const key = await chain.read(box.hook, coreV2.hookV2Abi, 'poolKey');
  const native = box.p === zeroAddress;
  if (!native) await chain.send(from, box.p, erc20Abi, 'approve', [swapper, amount]);
  const receipt = await chain.send(from, swapper, SWAPPER, 'swap', [key, true, -amount, limit], native ? amount : 0n, swapGas);
  if (!native) await chain.send(from, box.p, erc20Abi, 'approve', [swapper, 0n]);
  const received = tokenMoves(chain, receipt, box.token, { to: from });
  assert.ok(received > 0n, `the buy of ${amount} raw price coin by ${from} received no box tokens (${receipt.transactionHash})`);
  return received;
}

/** One sale of `amount` raw box tokens; its receipt must show exactly that many leaving the seller. Inside an action. */
export async function sell(chain, box, from, amount, swapper, swapGas = gasOf('swap')) {
  assert.ok(amount > 0n, 'a sale of nothing');
  const limit = await chain.remember('sell limit', async () => ((await graduatedOf(chain, box)) ? 0n : box.curve.sqrtPriceStartX96));
  const key = await chain.read(box.hook, coreV2.hookV2Abi, 'poolKey');
  await chain.send(from, box.token, erc20Abi, 'approve', [swapper, amount]);
  const receipt = await chain.send(from, swapper, SWAPPER, 'swap', [key, false, -amount, limit], 0n, swapGas);
  assert.equal(tokenMoves(chain, receipt, box.token, { from }), amount, `the sale by ${from} moved exactly ${amount} box tokens (${receipt.transactionHash})`);
  return amount;
}

/**
 * After graduation: the sale fees wait in the hook as box tokens (F137) until `sellFees` sells them for the price coin,
 * one step per block, once enough waits. Each round is its own durable actions: the step (sold only with a positive
 * `FeesSold` in its own receipt), else B's buy (its received amount saved) and then B's sale of a quarter of it.
 */
export async function afterGraduationTrades(chain, box, { keeper, b, amount, swapper, swapGas = gasOf('swap'), prefix = 'after graduation' }) {
  let sold = 0n;
  const steps = [];
  for (let round = 1; round <= 24; round += 1) {
    const step = await chain.act(`${prefix} ${round}: sell fees`, async () => {
      const [skip] = await chain.remember('sellFees', () => chain.simulate(keeper, box.hook, coreV2.hookV2Abi, 'sellFees'));
      if (skip === ProtocolSkip.None) {
        const receipt = await chain.send(keeper, box.hook, coreV2.hookV2Abi, 'sellFees');
        const [event] = chain.events(receipt, coreV2.hookV2Abi, 'FeesSold', box.hook);
        assert.ok(event && event.pOut > 0n, `sellFees sold the sale fees for price coin (a positive FeesSold in ${receipt.transactionHash})`);
        return { sold: event.pOut, net: event.pOut - event.tip, tIn: event.tIn, hash: receipt.transactionHash };
      }
      if (sold > 0n) return { done: true };
      assert.ok(skip === ProtocolSkip.BelowMinimum || skip === ProtocolSkip.StepTaken, 'sellFees skipped for another reason than "below the minimum"');
      return { trade: true };
    });
    if (step.sold) { sold += step.sold; steps.push(step); continue; }
    if (step.done) break;
    const got = await chain.act(`${prefix} ${round}: B buys`, () => buy(chain, box, b, amount, swapper, swapGas));
    await chain.act(`${prefix} ${round}: B sells a quarter`, () => sell(chain, box, b, got / 4n, swapper, swapGas));
  }
  assert.ok(sold > 0n, 'the sale fees were sold to the price coin');
  return { sold, steps };
}

async function snapshot(chain, box, at) {
  const state = {};
  for (const [field, abi] of LEDGERS) state[field] = await chain.read(box.receiver, abi, field, [], at);
  const claims = owner => (same(owner, zeroAddress) ? 0n : chain.read(box.manager, CLAIMS, 'balanceOf', [owner, BigInt(box.p)], at));
  state.hookClaims = await claims(box.hook);
  state.holderClaims = await claims(box.holderLedger);
  state.itemClaims = await claims(box.itemLedger);
  state.receiverClaims = await claims(box.receiver);
  state.booked = await chain.read(box.receiver, coreV2.receiverV2Abi, 'booked', [box.p], at);
  state.dust = state.booked - LEDGERS.reduce((total, [field]) => total + state[field], 0n);
  return state;
}

/**
 * One audited `collect` (an action): every receiver book must move by exactly the 2:1:2:10 split of the sources it
 * allocated (feeAuditor's checks, apps/web/e2e/core-v2-chain/examples/accounting.mjs, for the price-coin choices).
 * The sources are counted from the receiver's own cursors at the block before its own; returns the allocations and
 * the new cursor (which must equal the receiver's at its block).
 */
export async function auditedCollect(chain, box, fees, keeper, label) {
  return chain.act(`collect ${label}`, async () => {
    const receipt = await chain.send(keeper, box.receiver, coreV2.receiverV2Abi, 'collect', [zeroAddress]);
    // The books just before this collect's block and at its end: another account's collect in an earlier block (the
    // live keeper's) is outside the audit, which covers exactly the sources this collect allocated.
    const at = receipt.blockNumber;
    const before = await snapshot(chain, box, at - 1n);
    const last = await receiverCursors(chain, box, at - 1n);
    const graduated = await chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated', [], at - 1n);
    const [collected] = chain.events(receipt, coreV2.receiverV2Abi, 'Collected', box.receiver);
    assert.ok(collected, 'Collected');
    assert.equal(collected.tip, 0n);
    const cursors = await receiverCursors(chain, box, at);
    const picked = await allocatedSources(chain, box, last, cursors);
    const model = await nextSources(last, id => chain.read(box.hook, coreV2.hookV2Abi, 'tradeBatch', [id]));
    const modelAgrees = model.last.buyers === cursors.buyers && model.last.sellers === cursors.sellers;
    const next = { picked, last: cursors };
    const totals = { buyers: 0n, sellers: 0n };
    const allocations = next.picked.map(({ side, id, netP }) => {
      totals[side] += netP;
      return { ...feeAllocation(netP, fees[side]), side, batch: id };
    });
    const unearned = collected.buyersP - totals.buyers;
    assert.ok(unearned >= 0n, 'graduation forwards only unearned reserve');
    if (unearned > 0n) allocations.push({ ...feeAllocation(unearned, fees.buyers === 'holders' ? 'grow' : fees.buyers), side: 'buyers', batch: 0n });
    assert.equal(collected.sellersP, totals.sellers, 'sellers P is the closed seller sources');
    const after = await snapshot(chain, box, at);
    const sum = key => allocations.reduce((n, row) => n + row[key], 0n);
    const branch = choice => allocations.filter(row => row.choice === choice).reduce((n, row) => n + row.branch, 0n);
    const delta = field => after[field] - before[field];
    const checks = {
      fitOwed: [delta('fitOwed'), sum('fit')],
      platformOwed: [delta('platformOwed'), sum('platform')],
      holderClaims: [delta('holderClaims'), branch('holders')],
      creatorP: [delta('creatorP'), branch('keep')],
      buyBackP: [delta('buyBackP'), branch('burn')],
      pilePendingP: [delta('pilePendingP'), branch('pile')],
      eatPendingP: [delta('eatPendingP'), branch('eat')],
      poolHeldP: [delta('poolHeldP'), graduated ? 0n : sum('pool')],
      growHeldP: [delta('growHeldP'), graduated ? 0n : branch('grow')],
      hookClaims: [delta('hookClaims'), (graduated ? sum('pool') + branch('grow') : 0n) + sum('dust')],
      dustAfter: [after.dust, 0n],
      conservation: [delta('booked') + delta('hookClaims') + delta('holderClaims') + delta('itemClaims'), collected.buyersP + collected.sellersP],
    };
    for (const [name, [actual, expected]] of Object.entries(checks)) assert.equal(actual, expected, `collect ${label}: ${name}`);
    assert.ok(after.receiverClaims >= after.booked, `collect ${label}: the receiver holds what it booked`);
    return { hash: receipt.transactionHash, graduated, collected, allocations, checks, last: next.last, modelAgrees };
  });
}

/** Every holder the box token enumerates (wallets earn from their first receipt). */
async function holdersOf(chain, box) {
  const count = await chain.read(box.token, coreV2.holderTokenV2Abi, 'holderCount');
  const list = [];
  for (let i = 0n; i < count; i += 1n) list.push(await chain.read(box.token, coreV2.holderTokenV2Abi, 'holderAt', [i]));
  return list;
}

/**
 * A paid holder batch (an action): the receiver paid exactly the allocation's holder share, settlement proves holder
 * credit plus residue equals that funding, the holders' quotes add up to the holder credit, and every holder with a
 * quote claims it from their own wallet and receives exactly that much price coin, which leaves the ledger's claims.
 */
export async function settleAndClaim(chain, box, row, keeper, wallets) {
  return chain.act(`holders batch ${row.batch}`, async () => {
    const paid = await chain.read(box.receiver, coreV2.receiverV2Abi, 'holderBatchPaid', [row.batch]);
    // A batch this run's own collect allocated: the receiver paid exactly its holders' 10/15. One another account's
    // collect allocated (the live keeper's) is taken as the receiver paid it.
    if (row.branch !== null) assert.equal(paid, row.branch, `batch ${row.batch}: the receiver paid the holders' 10/15`);
    let fundingP = 0n; let holderP = 0n; let residueP = 0n;
    for (let page = 0; page < 32; page += 1) {
      const receipt = await chain.send(keeper, box.holderLedger, coreV2.holderLedgerV2Abi, 'settleBatch', [row.batch, 64n]);
      for (const e of chain.events(receipt, coreV2.holderLedgerV2Abi, 'BatchSettled', box.holderLedger)) { fundingP += e.fundingP; holderP += e.holderP; residueP += e.residueP; }
      const [complete] = await chain.read(box.holderLedger, coreV2.holderLedgerV2Abi, 'batchState', [row.batch]);
      if (complete) break;
    }
    if (fundingP === 0n && paid > 0n) {
      // Another account settled it first: its BatchSettled event says what was settled.
      const latest = await chain.client.getBlockNumber({ cacheTime: 0 });
      const logs = await chain.client.getContractEvents({ address: box.holderLedger, abi: coreV2.holderLedgerV2Abi, eventName: 'BatchSettled', args: { batchId: row.batch }, fromBlock: latest > 49_000n ? latest - 49_000n : 0n, toBlock: latest });
      for (const e of logs) { fundingP += e.args.fundingP; holderP += e.args.holderP; residueP += e.args.residueP; }
    }
    assert.equal(fundingP, paid, `batch ${row.batch}: settled funding`);
    assert.equal(holderP + residueP, fundingP, `batch ${row.batch}: holder credit + residue = funding`);
    const quotes = await chain.remember('quotes', async () => {
      const list = [];
      for (const holder of await holdersOf(chain, box)) list.push({ holder, quote: await chain.read(box.holderLedger, coreV2.holderLedgerV2Abi, 'claimable', [row.batch, holder]) });
      return list;
    });
    assert.equal(quotes.reduce((n, q) => n + q.quote, 0n), holderP, `batch ${row.batch}: the quotes add up to the holder credit`);
    const claims = [];
    for (const { holder, quote } of quotes) {
      if (quote === 0n) continue;
      assert.ok(wallets.some(w => same(w, holder)), `batch ${row.batch}: holder ${holder} is one of this life's wallets`);
      const ledgerBefore = await chain.remember(`ledger before ${holder}`, () => chain.read(box.manager, CLAIMS, 'balanceOf', [box.holderLedger, BigInt(box.p)]));
      const before = await chain.remember(`balance before ${holder}`, () => chain.balance(box.p, holder));
      const receipt = await chain.send(holder, box.holderLedger, coreV2.holderLedgerV2Abi, 'claim', [row.batch, holder]);
      const [event] = chain.events(receipt, coreV2.holderLedgerV2Abi, 'HolderPaid', box.holderLedger);
      const got = (await chain.balance(box.p, holder)) - before;
      assert.equal(got, quote, `batch ${row.batch}: ${holder} receives exactly its quote`);
      assert.equal(event.grossP, quote);
      assert.equal(event.tipP, 0n);
      assert.equal(ledgerBefore - await chain.read(box.manager, CLAIMS, 'balanceOf', [box.holderLedger, BigInt(box.p)]), quote, `batch ${row.batch}: the ledger pays from its claims`);
      assert.equal(await chain.read(box.holderLedger, coreV2.holderLedgerV2Abi, 'claimable', [row.batch, holder]), 0n);
      claims.push({ holder, quote, received: got, hash: receipt.transactionHash });
    }
    return { batch: row.batch, side: row.side, paid, fundingP, holderP, residueP, quotes, claims };
  });
}

/**
 * The holders box's life. Roles: `keeper` presses the public steps, `a` and `b` trade and hold (addresses whose
 * sender the chain knows), each holding the price coin. `swapGas` is the swaps' gas limit (15,000,000 by default).
 * Ends with every holder batch that carried price coin claimed.
 */
export async function holdersLife(chain, coordinator, { swapper, keeper, a, b, swapGas = gasOf('swap'), tradeAfter = null }) {
  const box = await readBox(chain, coordinator);
  assert.ok(!same(box.holderLedger, zeroAddress), 'a holders box has its ledger');
  const fees = { buyers: 'holders', sellers: 'holders' };
  const batches = [];
  const handled = new Set();
  const collectAndPay = async label => {
    const collected = await auditedCollect(chain, box, fees, keeper, label);
    for (const row of collected.allocations) {
      if (row.choice !== 'holders' || row.branch === 0n) continue;
      handled.add(row.batch);
      batches.push(await settleAndClaim(chain, box, row, keeper, [a, b]));
    }
    // Batches another account's collect paid in between (the live keeper's): settled and claimed the same way.
    const top = collected.last.buyers > collected.last.sellers ? collected.last.buyers : collected.last.sellers;
    for (let id = 1n; id <= top; id += 1n) {
      if (handled.has(id)) continue;
      if (await chain.read(box.receiver, coreV2.receiverV2Abi, 'holderBatchPaid', [id]) === 0n) continue;
      handled.add(id);
      batches.push(await settleAndClaim(chain, box, { batch: id, branch: null, side: id % 2n === 1n ? 'buyers' : 'sellers' }, keeper, [a, b]));
    }
    return collected;
  };
  const collects = [];
  // Open, and past the launch window (a real run waits for the chain's clock).
  await chain.act('past the launch window', async () => {
    await chain.mineTo((await chain.read(box.hook, coreV2.hookV2Abi, 'windowEndsAt')) + 1n);
    return chain.now();
  });
  // Raising: A and B each buy a tenth of the raise; A sells a quarter of what it bought.
  const tenth = box.raise / 10n;
  const boughtA = await chain.act('raising: A buys a tenth', () => buy(chain, box, a, tenth, swapper, swapGas));
  await chain.act('raising: B buys a tenth', () => buy(chain, box, b, tenth, swapper, swapGas));
  await chain.act('raising: A sells a quarter', () => sell(chain, box, a, boughtA / 4n, swapper, swapGas));
  collects.push(await collectAndPay('raising'));
  // The raise fills (A buys a quarter of the raise at a time), the fees before graduation are collected, it graduates.
  for (let i = 1; i <= 6; i += 1) {
    const filled = await chain.act(`fill ${i}`, async () => {
      if (await chain.remember('closed', () => chain.read(box.hook, coreV2.hookV2Abi, 'closed'))) return 'closed';
      return buy(chain, box, a, box.raise / 4n, swapper, swapGas);
    });
    if (filled === 'closed') break;
  }
  assert.ok(await chain.read(box.hook, coreV2.hookV2Abi, 'closed'), 'the curve filled');
  collects.push(await collectAndPay('filled'));
  await chain.act('graduate', async () => {
    if (await chain.remember('graduated', () => graduatedOf(chain, box))) return 'already';
    try {
      return (await chain.send(keeper, box.coordinator, coreV2.coordinatorV2Abi, 'graduate')).transactionHash;
    } catch (error) {
      // Another account (the live keeper) graduated it between this run's read and its send: the chain decides.
      if (await chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated')) return `graduated by another account (${error.message.split('\n')[0]})`;
      throw error;
    }
  });
  assert.ok(await graduatedOf(chain, box), 'graduated');
  collects.push(await collectAndPay('graduated'));
  // After graduation: B buys and sells in the box's own pool until a sale-fee step sells (durable actions each).
  const { sold } = await afterGraduationTrades(chain, box, { keeper, b, amount: tradeAfter ?? tenth, swapper, swapGas });
  collects.push(await collectAndPay('after graduation'));
  const unique = [...new Map(batches.map(row => [row.batch, row])).values()];
  batches.length = 0; batches.push(...unique);
  const claimed = batches.flatMap(row => row.claims);
  const total = claimed.reduce((n, c) => n + c.quote, 0n);
  assert.ok(claimed.some(c => same(c.holder, a)) && claimed.some(c => same(c.holder, b)), 'both holders were paid');
  return { box: { coordinator, token: box.token, p: box.p, raise: box.raise }, collects, batches, claimed, total, saleFeesSold: sold, gasPaid: chain.gasPaid() };
}
