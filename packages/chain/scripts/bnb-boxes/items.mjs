/**
 * SH-261: a collection box's items on chain 97 (Rent Free): its open reveals, and its life, every amount checked to the
 * last raw unit. Local or real (chain.mjs); a run started again with its state file goes on where it stopped.
 *
 * Reveals: the created box's own reveal file (its BoxSpec with the reveal list and the salts the creation dealt, kept
 * in the state file by launch.mjs) is checked against the collection's on-chain root and folded into Multicall3
 * `aggregate3` batches of 40 reveals by the chain package's own planner (`planOpenRevealBatchesV2`, SH-RENT-FREE-SEPOLIA:
 * 500 houses in 13 sends). One batch at a time; each receipt must show every item of its batch revealed.
 *
 * The life (buyers' fees To items with the inside share burned, sellers' fees Burn): two traders buy on the curve, one
 * sells part back, the curve fills and the box graduates (fees before graduation wait for the houses, and graduation
 * burns them as the share of houses still inside); A takes house 1 out for its quote plus the pick fee; trades after
 * graduation pay the houses: house 1's part is kept for its owner, the inside share and the sellers' fees buy the box
 * token and burn it; A claims house 1's money in the price coin, exactly its credit. Every collect is audited as the
 * browser suite audits it (feeAuditor, apps/web/e2e/core-v2-chain/examples/accounting.mjs, Items and Burn).
 */
import assert from 'node:assert/strict';
import { erc20Abi, getAddress, zeroAddress } from 'viem';
import './ts.mjs';
import { readBox, buy, sell, receiverCursors, allocatedSources, afterGraduationTrades } from './life.mjs';

const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const { boxCollectionAbi } = await import('../../../../packages/chain/src/abi/boxCollection.ts');
const reveals = await import('../../../../packages/chain/src/core/v2/open-reveal-batches-v2.ts');
const { MULTICALL3 } = await import('../../../../packages/chain/src/core/v2/reveal-batch-calls-v2.ts');
const { feeAllocation, nextSources } = await import('../../../../apps/web/e2e/core-v2-chain/examples/support.mjs');
const { CHAIN_ID } = await import('./chain.mjs');

/** Multicall3's runtime code hash (the same keyless deployment on every chain; read on chain 97 on 25 November 2026). */
export const MULTICALL3_CODE_HASH = '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';
/** One reveal batch's gas limit: 40 reveals measured up to 14,107,115 on Sepolia; below EIP-7825's 16,777,216. */
export const REVEAL_BATCH_GAS = 16_000_000n;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Every item of a created open collection revealed, in batches, by `from`. Returns the batches and their outcomes. */
export async function revealAll(chain, coordinator, revealText, from) {
  const collection = await chain.read(coordinator, coreV2.coordinatorV2Abi, 'collection');
  const code = await chain.client.getCode({ address: MULTICALL3 });
  assert.ok(code && code !== '0x', 'Multicall3 has no code on this chain');
  const { keccak256 } = await import('viem');
  assert.equal(keccak256(code), MULTICALL3_CODE_HASH, 'Multicall3\'s code is not the canonical deployment');
  const plan = await chain.act('reveals: plan', async () => {
    const root = await chain.read(collection, boxCollectionAbi, 'revealRoot');
    const file = reveals.checkOpenRevealFileV2(JSON.parse(revealText), { root });
    const batches = [...reveals.planOpenRevealBatchesV2(file, { collection })];
    return { collection, root, size: file.size, batches: batches.map(b => ({ index: b.index, ids: b.ids, data: b.data, to: b.to, value: b.value })) };
  });
  const outcomes = [];
  for (const batch of plan.batches) {
    outcomes.push(await chain.act(`reveals: batch ${batch.index} of ${plan.batches.length}`, async () => {
      const receipt = await chain.sendRaw({ from, to: batch.to, data: batch.data, value: 0n, gas: REVEAL_BATCH_GAS, label: `aggregate3 reveal ${batch.ids[0]}-${batch.ids.at(-1)}` });
      const outcome = reveals.readOpenRevealReceiptV2({ ...batch, value: '0' }, { status: receipt.status, logs: receipt.logs });
      assert.deepEqual([outcome.failed, outcome.unknown], [[], []], `batch ${batch.index}: every item revealed`);
      assert.equal(outcome.succeeded.length, batch.ids.length);
      return { index: batch.index, revealed: outcome.succeeded.length, hash: receipt.transactionHash, gasUsed: receipt.gasUsed };
    }));
  }
  const total = outcomes.reduce((n, o) => n + o.revealed, 0);
  assert.equal(BigInt(total), BigInt(plan.size), 'every item revealed');
  for (const id of [1n, BigInt(plan.size)]) assert.equal(await chain.read(collection, boxCollectionAbi, 'isRevealed', [id]), true, `item ${id} reads revealed`);
  return { collection, root: plan.root, batches: outcomes, total };
}

const LEDGERS = [['fitOwed', coreV2.receiverV2Abi], ['platformOwed', coreV2.receiverV2Abi], ['poolHeldP', coreV2.receiverV2Abi], ['growHeldP', coreV2.receiverV2Abi],
  ['creatorP', coreV2.receiverV2Abi], ['buyBackP', coreV2.receiverV2Abi], ['itemsHeldP', coreV2.receiverV2Abi], ['royaltyHeldP', coreV2.receiverV2Abi],
  ['pilePendingP', coreV2.receiverPileV21Abi], ['eatPendingP', coreV2.receiverEatV21Abi], ['rewardsPendingP', coreV2.receiverPayInTV21Abi]];
const CLAIMS = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }];

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
 * One audited collect of an Items box (an action), the feeAuditor's checks for Items with an inside rule and Burn:
 * each ItemFunded receipt's ledger part is its choice part less the inside items' equal shares (Burn: they join the
 * buy-back), the books move by exactly the 2:1:2:10 split of the sources allocated.
 */
export async function itemsCollect(chain, box, fees, size, keeper, label) {
  return chain.act(`collect ${label}`, async () => {
    const receipt = await chain.send(keeper, box.receiver, coreV2.receiverV2Abi, 'collect', [zeroAddress]);
    // The books just before this collect's block and at its end (life.mjs auditedCollect): another account's collect in
    // an earlier block is outside the audit.
    const at = receipt.blockNumber;
    const before = await snapshot(chain, box, at - 1n);
    const last = await receiverCursors(chain, box, at - 1n);
    const graduated = await chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated', [], at - 1n);
    const [collected] = chain.events(receipt, coreV2.receiverV2Abi, 'Collected', box.receiver);
    assert.ok(collected, 'Collected');
    assert.equal(collected.tip, 0n);
    const cursors = await receiverCursors(chain, box, at);
    const model = await nextSources(last, id => chain.read(box.hook, coreV2.hookV2Abi, 'tradeBatch', [id]));
    const modelAgrees = model.last.buyers === cursors.buyers && model.last.sellers === cursors.sellers;
    const next = { picked: await allocatedSources(chain, box, last, cursors), last: cursors };
    const totals = { buyers: 0n, sellers: 0n };
    const allocations = next.picked.map(({ side, id, netP }) => { totals[side] += netP; return { ...feeAllocation(netP, fees[side].choice), side, batch: id }; });
    const unearned = collected.buyersP - totals.buyers;
    assert.ok(unearned >= 0n, 'graduation forwards only unearned reserve');
    if (unearned > 0n) allocations.push({ ...feeAllocation(unearned, fees.buyers.choice), side: 'buyers', batch: 0n });
    assert.equal(collected.sellersP, totals.sellers, 'sellers P is the closed seller sources');
    const funded = chain.events(receipt, coreV2.receiverItemsV2Abi, 'ItemFunded', box.receiver);
    const itemPaid = funded.reduce((n, row) => n + row.ledgerP, 0n);
    const retained = { burn: 0n, depth: 0n };
    const receipts = [];
    for (const row of funded) {
      const funding = await chain.read(box.receiver, coreV2.receiverItemsV2Abi, 'itemFunding', [row.receiptId]);
      const side = Number(row.side) === 1 ? 'buyers' : 'sellers';
      const { inside } = fees[side];
      const share = inside === 'burn' || inside === 'depth' ? BigInt(funding.insideCount) * (row.choiceP / BigInt(size)) : 0n;
      assert.equal(row.ledgerP, row.choiceP - share, `${label}: receipt ${row.receiptId} pays the outside items only`);
      if (share > 0n) retained[inside] += share;
      receipts.push({ receiptId: row.receiptId, side, source: Number(row.source), choiceP: row.choiceP, ledgerP: row.ledgerP, insideCount: Number(funding.insideCount) });
    }
    const after = await snapshot(chain, box, at);
    const sum = key => allocations.reduce((n, row) => n + row[key], 0n);
    const branch = choice => allocations.filter(row => row.choice === choice).reduce((n, row) => n + row.branch, 0n);
    const delta = field => after[field] - before[field];
    const checks = {
      fitOwed: [delta('fitOwed'), sum('fit')],
      platformOwed: [delta('platformOwed'), sum('platform')],
      buyBackP: [delta('buyBackP'), branch('burn') + retained.burn],
      itemsHeldP: [delta('itemsHeldP'), graduated ? 0n : branch('items')],
      itemClaims: [delta('itemClaims'), itemPaid],
      itemsFunded: [funded.reduce((n, row) => n + row.choiceP, 0n), graduated ? branch('items') : 0n],
      creatorP: [delta('creatorP'), branch('keep')],
      holderClaims: [delta('holderClaims'), branch('holders')],
      poolHeldP: [delta('poolHeldP'), graduated ? 0n : sum('pool')],
      growHeldP: [delta('growHeldP'), graduated ? 0n : branch('grow')],
      hookClaims: [delta('hookClaims'), (graduated ? sum('pool') + branch('grow') + retained.depth : 0n) + sum('dust')],
      dustAfter: [after.dust, 0n],
      conservation: [delta('booked') + delta('hookClaims') + delta('holderClaims') + delta('itemClaims'), collected.buyersP + collected.sellersP],
    };
    for (const [name, [actual, expected]] of Object.entries(checks)) assert.equal(actual, expected, `collect ${label}: ${name}`);
    assert.ok(after.receiverClaims >= after.booked, `collect ${label}: the receiver holds what it booked`);
    return { hash: receipt.transactionHash, graduated, collected, allocations, receipts, checks, last: next.last, modelAgrees };
  });
}

/**
 * The buy-back step (anyone): the waiting price coin buys the box token in its own pool and burns it. Burned only with
 * a positive `tBurned` in the receiver's own `BoughtBack` event of this step's receipt. `required`: nothing waiting, a
 * step that would not run, or nothing burned stops the run (the converter box's sellers' burn); otherwise those are
 * recorded as skipped.
 */
export async function burnStep(chain, box, keeper, label, { required = false } = {}) {
  return chain.act(`buy back and burn ${label}`, async () => {
    const waiting = await chain.remember('waiting', () => chain.read(box.receiver, coreV2.receiverV2Abi, 'buyBackP'));
    // Ready only when the step would buy (its simulated skip is None: not below the step minimum, not taken this block).
    const ready = waiting > 0n && await chain.remember('ready', () => chain.simulate(keeper, box.receiver, coreV2.receiverV2Abi, 'buyBack', [zeroAddress]).then(([skip]) => Number(skip) === 0, () => false));
    if (!ready) {
      assert.ok(!required, `${label}: nothing to buy back (waiting ${waiting}): the burn is not shown`);
      return { skipped: `nothing to buy back now (waiting ${waiting})` };
    }
    const receipt = await chain.send(keeper, box.receiver, coreV2.receiverV2Abi, 'buyBack', [zeroAddress]);
    const [event] = chain.events(receipt, coreV2.receiverV2Abi, 'BoughtBack', box.receiver);
    if (!event || event.tBurned === 0n) {
      assert.ok(!required, `${label}: the buy-back burned nothing (${receipt.transactionHash})`);
      return { skipped: 'the step burned nothing', hash: receipt.transactionHash };
    }
    return { hash: receipt.transactionHash, pSpent: event.pSpent, tBought: event.tBought, tBurned: event.tBurned };
  });
}

/**
 * Rent Free's life. Roles: `keeper` presses the public steps, `a` trades and takes house 1 out, `b` trades; both hold
 * the price coin. `size` is the collection's item count.
 */
export async function itemsLife(chain, coordinator, { swapper, keeper, a, b, fees, size, tradeAfter = null }) {
  const box = await readBox(chain, coordinator);
  const vault = await chain.read(coordinator, coreV2.coordinatorV2Abi, 'vault');
  const collection = await chain.read(coordinator, coreV2.coordinatorV2Abi, 'collection');
  assert.ok(!same(box.itemLedger, zeroAddress), 'an Items box has its item ledger');
  const collects = [];
  const collect = async label => { const c = await itemsCollect(chain, box, fees, size, keeper, label); collects.push(c); return c; };
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
  await chain.act('graduate', async () => {
    if (await chain.remember('graduated', () => chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated'))) return 'already';
    try {
      return (await chain.send(keeper, box.coordinator, coreV2.coordinatorV2Abi, 'graduate')).transactionHash;
    } catch (error) {
      // Another account (the live keeper) graduated it between this run's read and its send: the chain decides.
      if (await chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated')) return `graduated by another account (${error.message.split('\n')[0]})`;
      throw error;
    }
  });
  await collect('graduated');
  const graduationBurn = await burnStep(chain, box, keeper, 'after graduation');
  // A takes house 1 out: the vault's quote plus the pick fee, rounded up (BoxVaultV2), paid in box tokens.
  const taken = await chain.act('A takes house 1 out', async () => {
    const quote = await chain.remember('quote', async () => {
      const principal = await chain.read(vault, coreV2.vaultV2Abi, 'quoteWithdraw', [1n]);
      const bps = BigInt(await chain.read(vault, coreV2.vaultV2Abi, 'pickFeeBps'));
      return { principal, bps, max: principal + (principal * bps + 9_999n) / 10_000n, tokens: await chain.balance(box.token, a),
        receiptsBefore: await chain.read(box.receiver, coreV2.receiverItemsV2Abi, 'itemFundingCount') };
    });
    await chain.send(a, box.token, erc20Abi, 'approve', [vault, quote.max]);
    const deadline = (await chain.now()) + 3_600n;
    await chain.send(a, vault, coreV2.vaultV2Abi, 'withdraw', [1n, quote.max, deadline]);
    assert.ok(same(await chain.read(collection, boxCollectionAbi, 'ownerOf', [1n]), a), 'A owns house 1');
    const paid = quote.tokens - await chain.balance(box.token, a);
    assert.equal(paid, quote.max, 'house 1 cost its quote plus the pick fee, to the raw unit');
    return { ...quote, paid };
  });
  // After graduation: B trades in the box's own pool until a sale-fee step sells (durable actions each).
  const { sold } = await afterGraduationTrades(chain, box, { keeper, b, amount: tradeAfter ?? tenth, swapper });
  await collect('after graduation');
  const burned = await burnStep(chain, box, keeper, 'the inside share and the sellers\' fees');
  // House 1's money: the ledger syncs the receipts, then A claims exactly its credit in the price coin.
  const claim = await chain.act('A claims house 1', async () => {
    await chain.send(keeper, box.itemLedger, coreV2.itemLedgerV2Abi, 'sync', [32n]);
    // Every receipt published after house 1 left the vault pays each outside house one equal share, whoever's collect
    // published it (this run's or the live keeper's).
    const outsideReceipts = await chain.remember('receipts while outside', async () => {
      const count = await chain.read(box.receiver, coreV2.receiverItemsV2Abi, 'itemFundingCount');
      const list = [];
      for (let id = taken.receiptsBefore + 1n; id <= count; id += 1n) {
        const r = await chain.read(box.receiver, coreV2.receiverItemsV2Abi, 'itemFunding', [id]);
        list.push({ receiptId: id, choiceP: r.choiceP, insideCount: Number(r.insideCount), side: Number(r.side) });
      }
      return list;
    });
    assert.ok(outsideReceipts.length > 0, 'a receipt pays house 1 while it is outside');
    const [outsideP, stashP] = await chain.read(box.itemLedger, coreV2.itemLedgerV2Abi, 'itemCredit', [1n]);
    const expected = outsideReceipts.reduce((n, r) => n + r.choiceP / BigInt(size), 0n);
    assert.equal(outsideP + stashP, expected, 'house 1 is credited one equal share of each receipt paid while it was outside');
    const before = await chain.remember('balance before', () => chain.balance(box.p, a));
    await chain.send(a, box.itemLedger, coreV2.itemLedgerV2Abi, 'claim', [[1n], a]);
    const got = (await chain.balance(box.p, a)) - before;
    assert.equal(got, outsideP + stashP, 'A received exactly house 1\'s credit');
    return { outsideP, stashP, received: got, receipts: outsideReceipts.length };
  });
  assert.ok(claim.received > 0n, 'house 1 collected money');
  return { box: { coordinator, token: box.token, p: box.p, raise: box.raise, vault, collection: getAddress(collection) }, collects, graduationBurn, taken, saleFeesSold: sold, burned, claim, gasPaid: chain.gasPaid(), chainId: CHAIN_ID };
}
