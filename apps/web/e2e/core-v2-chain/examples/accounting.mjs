import { expect } from '@playwright/test';
import { encodeAbiParameters, keccak256, zeroAddress } from 'viem';
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick } from '../../../../../packages/box-spec/src/v4-math.ts';
import { read, call, events, balance } from './chain.mjs';
import { feeAllocation, nextSources } from './support.mjs';

// v2.1: P waiting to be eaten (step 1) and to buy T for holders or items (step 2) is booked like every other ledger.
const ledgers = ['fitOwed', 'platformOwed', 'poolHeldP', 'growHeldP', 'creatorP', 'buyBackP', 'itemsHeldP', 'royaltyHeldP', 'pilePendingP', 'eatPendingP', 'rewardsPendingP'];
async function snapshot(chain, box) {
  const state = Object.fromEntries(await Promise.all(ledgers.map(async field => [field, await read(chain, 'BoxReceiverV2', box.receiver, field)])));
  const manager = await read(chain, 'BoxReceiverV2', box.receiver, 'poolManager');
  const claims = address => address === zeroAddress ? 0n : read(chain, 'PoolManager', manager, 'balanceOf', [address, BigInt(box.p)]);
  state.hookClaims = await claims(box.hook);
  state.holderClaims = await claims(box.holderLedger);
  state.itemClaims = await claims(box.itemLedger);
  state.receiverClaims = await claims(box.receiver);
  state.booked = await read(chain, 'BoxReceiverV2', box.receiver, 'booked', [box.p]);
  state.shopPendingP = box.spec?.sellers.a.leg === 2 && box.spec.sellers.a.dest === 7
    ? await read(chain, 'BoxReceiverV2', box.receiver, 'modulePendingP', [true]) : 0n;
  state.dust = state.booked - state.shopPendingP - ledgers.reduce((total, field) => total + state[field], 0n);
  return state;
}

/** Value the live curve from its pre-transition position and spot, with removal rounding. */
async function curvePrincipal(chain, box) {
  const manager = await read(chain, 'BoxReceiverV2', box.receiver, 'poolManager');
  const id = await read(chain, 'BoxHookV2', box.hook, 'poolId');
  // Pinned v4 StateLibrary: pools is slot 6; the low 160 bits of slot0 are sqrtPriceX96.
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]));
  const spot = BigInt(await read(chain, 'PoolManager', manager, 'extsload', [slot])) & ((1n << 160n) - 1n);
  const [lower, upper, liquidity] = await read(chain, 'BoxHookV2', box.hook, 'curve');
  expect(BigInt(box.p)).toBeLessThan(BigInt(box.token)); // These examples price in currency0.
  const a = getSqrtPriceAtTick(lower); const b = getSqrtPriceAtTick(upper);
  expect(spot).toBeGreaterThanOrEqual(a); expect(spot).toBeLessThanOrEqual(b);
  // Every registry raise fits a single int128 removal, avoiding per-chunk rounding.
  expect(box.raise).toBeLessThan((1n << 127n) - 1n);
  return { spot, liquidity, q: getAmount0Delta(spot, b, liquidity, false), t: getAmount1Delta(a, spot, liquidity, false) };
}

/** Audit real raw-unit changes, not an event compared to itself. No keeper tip obscures either side. */
export function feeAuditor(chain, example, box, evidence) {
  // One source cursor a side, tracked here from the hook's own sources, never read back from the receiver.
  let carry = { buyers: 0n, sellers: 0n }; let lastSource = { buyers: 0n, sellers: 0n };
  const sourced = box.holderLedger !== zeroAddress || box.itemLedger !== zeroAddress;
  const collect = async function () {
    const before = await snapshot(chain, box);
    const wantsShop = example.fees.sellers.choice === 'shop' && await read(chain, 'ShopVaultV2', box.vault, 'feesWanted') && await read(chain, 'ShopVaultV2', box.vault, 'budgetT') < await read(chain, 'ShopVaultV2', box.vault, 'ceilingT');
    const graduated = await read(chain, 'BoxCoordinatorV2', box.coordinator, 'graduated');
    const receipt = await call(chain, 'BoxReceiverV2', box.receiver, 'collect', [zeroAddress]);
    const [collected] = events(receipt, 'BoxReceiverV2', box.receiver, 'Collected');
    expect(collected).toBeDefined(); expect(collected.tip).toBe(0n);
    const allocations = [];
    const totals = { buyers: 0n, sellers: 0n };
    if (sourced) {
      // RC7: two quota places plus up to five sub-unit passes per side, buyers first (support.mjs `nextSources`).
      // Each side stops at its own unready source; this audit observes ordinary collects on live boxes.
      const next = await nextSources(lastSource, id => read(chain, 'BoxHookV2', box.hook, 'tradeBatch', [id]));
      for (const { side, id, netP } of next.picked) {
        totals[side] += netP;
        allocations.push({ ...feeAllocation(netP, example.fees[side].choice), side, batch: id });
      }
      lastSource = next.last;
      // Graduation may forward unused reserve. It is unearned buyer-side money, never a holder entitlement.
      const unearned = collected.buyersP - totals.buyers;
      expect(unearned).toBeGreaterThanOrEqual(0n);
      const holders = example.fees.buyers.choice === 'holders' || example.fees.buyers.choice === 'holders-t';
      if (unearned > 0n) allocations.push({ ...feeAllocation(unearned, holders ? 'grow' : example.fees.buyers.choice), side: 'buyers', batch: 0n });
      expect(collected.sellersP).toBe(totals.sellers);
    } else {
      for (const side of ['buyers', 'sellers']) {
        const allocation = feeAllocation(collected[`${side}P`] + carry[side], example.fees[side].choice);
        carry[side] = allocation.dust;
        allocations.push({ ...allocation, side, batch: 0n });
      }
    }
    const sum = key => allocations.reduce((n, row) => n + row[key], 0n);
    const branch = choice => allocations.filter(row => row.choice === choice).reduce((n, row) => n + row.branch, 0n);
    const funded = events(receipt, 'BoxReceiverV2', box.receiver, 'ItemFunded');
    const itemPaid = funded.reduce((n, row) => n + row.ledgerP, 0n);
    // Pin the retention rule independently of the receipt's paid amount: the inside items' share buys back and burns
    // under Burn, and goes to the box's own pool under Depth (v2.1 step 5); Keep pays the whole receipt to the ledger.
    const retained = { burn: 0n, depth: 0n };
    for (const row of funded) {
      const funding = await read(chain, 'BoxReceiverV2', box.receiver, 'itemFunding', [row.receiptId]);
      const side = row.side === 1 ? 'buyers' : 'sellers';
      const { choice, inside } = example.fees[side];
      // Items paid in T publish Depth receipts on an equal-item basis at purchase; no registry row has one yet.
      expect(inside === 'depth' && choice !== 'items', `${side}: Depth receipts in the price coin only`).toBe(false);
      const share = inside === 'burn' || inside === 'depth' ? BigInt(funding.insideCount) * (row.choiceP / BigInt(example.contents.size)) : 0n;
      expect(row.ledgerP).toBe(row.choiceP - share);
      if (share > 0n) retained[inside] += share;
    }
    const after = await snapshot(chain, box);
    const delta = field => after[field] - before[field];
    expect(delta('fitOwed')).toBe(sum('fit'));
    expect(delta('platformOwed')).toBe(sum('platform'));
    expect(delta('pilePendingP')).toBe(branch('pile'));
    expect(delta('eatPendingP')).toBe(branch('eat'));
    expect(delta('rewardsPendingP')).toBe(branch('holders-t') + branch('items-t'));
    expect(delta('creatorP')).toBe(branch('keep'));
    expect(delta('buyBackP')).toBe(branch('burn') + retained.burn);
    expect(delta('shopPendingP')).toBe(wantsShop ? branch('shop') : 0n);
    expect(delta('holderClaims')).toBe(branch('holders') + (wantsShop ? 0n : branch('shop')));
    expect(delta('itemsHeldP')).toBe(graduated ? 0n : branch('items'));
    expect(delta('itemClaims')).toBe(itemPaid);
    expect(funded.reduce((n, row) => n + row.choiceP, 0n)).toBe(graduated ? branch('items') : 0n);
    expect(delta('poolHeldP')).toBe(graduated ? 0n : sum('pool'));
    expect(delta('growHeldP')).toBe(graduated ? 0n : branch('grow'));
    expect(delta('hookClaims')).toBe((graduated ? sum('pool') + branch('grow') + retained.depth : 0n) + (sourced ? sum('dust') : 0n));
    expect(after.dust).toBe(sourced ? 0n : carry.buyers + carry.sellers);
    expect(after.receiverClaims).toBeGreaterThanOrEqual(after.booked);
    expect(delta('booked') + delta('hookClaims') + delta('holderClaims') + delta('itemClaims')).toBe(collected.buyersP + collected.sellersP);
    evidence.fees ??= [];
    evidence.fees.push({ hash: receipt.transactionHash, graduated, collected, allocations, before, after });
    return collected;
  };
  collect.carry = () => ({ ...carry });
  /**
   * F138 (R53 G-J): price-coin money the inbox delivers is booked like a buyers' fee, with the same carry. Audit the
   * receiver's ledgers around `deliver` against that split; only unsourced boxes after graduation, as in this registry.
   */
  collect.royalty = async function (deliver) {
    expect(sourced, 'royalty audit: no holder or item sources').toBe(false);
    expect(await read(chain, 'BoxCoordinatorV2', box.coordinator, 'graduated')).toBe(true);
    const before = await snapshot(chain, box);
    const receipt = await deliver();
    const after = await snapshot(chain, box);
    const [funded] = events(receipt, 'BoxReceiverV2', box.receiver, 'RoyaltyFunded');
    expect(funded, 'royalty intake receipt').toBeDefined();
    const allocation = feeAllocation(funded.amount + carry.buyers, example.fees.buyers.choice);
    carry = { ...carry, buyers: allocation.dust };
    const delta = field => after[field] - before[field];
    expect(delta('fitOwed')).toBe(allocation.fit);
    expect(delta('platformOwed')).toBe(allocation.platform);
    expect(delta('creatorP')).toBe(allocation.choice === 'keep' ? allocation.branch : 0n);
    expect(delta('buyBackP')).toBe(allocation.choice === 'burn' ? allocation.branch : 0n);
    expect(delta('hookClaims')).toBe(allocation.pool + (allocation.choice === 'grow' ? allocation.branch : 0n));
    expect(delta('royaltyHeldP')).toBe(0n);
    expect(after.dust).toBe(carry.buyers + carry.sellers);
    expect(delta('booked') + delta('hookClaims')).toBe(funded.amount);
    evidence.royaltyBooking = { hash: receipt.transactionHash, amount: funded.amount, allocation, before, after };
    return funded.amount;
  };
  return collect;
}

export async function paySafes(chain, box, evidence) {
  evidence.safePayments = [];
  for (const [getter, owed, method, event] of [['FIT_SAFE', 'fitOwed', 'payFit', 'FitPaid'], ['PLATFORM_SAFE', 'platformOwed', 'payPlatform', 'PlatformPaid']]) {
    const safe = await read(chain, 'BoxReceiverV2', box.receiver, getter);
    const due = await read(chain, 'BoxReceiverV2', box.receiver, owed);
    expect(due).toBeGreaterThan(0n);
    const before = await balance(chain, box.p, safe);
    const receipt = await call(chain, 'BoxReceiverV2', box.receiver, method);
    expect(await balance(chain, box.p, safe) - before).toBe(due);
    expect(await read(chain, 'BoxReceiverV2', box.receiver, owed)).toBe(0n);
    expect(events(receipt, 'BoxReceiverV2', box.receiver, event)[0].amount).toBe(due);
    evidence.safePayments.push({ safe, due, hash: receipt.transactionHash });
  }
}

/** Release previously held money exactly once; graduation is not another fee split. */
export async function graduate(chain, example, box, evidence) {
  const before = await snapshot(chain, box);
  const principal = await curvePrincipal(chain, box);
  const tokenBudget = await read(chain, 'BoxTokenV2', box.token, 'balanceOf', [box.coordinator]);
  const a = getSqrtPriceAtTick(-887220); const b = getSqrtPriceAtTick(887220); const q96 = 1n << 96n;
  const qLiquidity = principal.q * (principal.spot * b / q96) / (b - principal.spot);
  const tLiquidity = (principal.t + tokenBudget) * q96 / (principal.spot - a);
  const liquidity = qLiquidity < tLiquidity ? qLiquidity : tLiquidity;
  const qUsed = getAmount0Delta(principal.spot, b, liquidity, true);
  const qLeft = principal.q - qUsed;
  const receipt = await call(chain, 'BoxCoordinatorV2', box.coordinator, 'graduate');
  const [migration] = events(receipt, 'BoxHookV2', box.hook, 'MigratedV2');
  expect(migration, 'migration receipt').toBeDefined();
  expect(migration.liquidity, 'migration liquidity from pre-transition budgets').toBe(liquidity);
  expect(await read(chain, 'BoxHookV2', box.hook, 'pairedLiquidity'), 'migration position').toBe(liquidity);
  expect(migration.qLeft, 'migration principal remainder').toBe(qLeft);
  expect(qUsed + migration.qLeft, 'migration principal conservation').toBe(principal.q);
  const after = await snapshot(chain, box);
  const funded = events(receipt, 'BoxReceiverV2', box.receiver, 'ItemFunded');
  let paid = 0n; let burned = 0n; let deepened = 0n;
  for (const row of funded) {
    expect(row.source).toBe(3);
    const side = row.side === 1 ? 'buyers' : 'sellers';
    const { choice, inside } = example.fees[side];
    expect(inside === 'depth' && choice !== 'items', `${side}: Depth releases in the price coin only`).toBe(false);
    // At graduation every item is still inside: inside-burn retires the entire held source, including dust, and Depth
    // (v2.1 step 5) sends all of it to the box's own pool; Keep pays it all to the ledger.
    const retained = inside === 'burn' || inside === 'depth' ? row.choiceP : 0n;
    expect(row.ledgerP).toBe(row.choiceP - retained);
    if (inside === 'depth') deepened += retained; else burned += retained;
    paid += row.ledgerP;
  }
  expect(paid + burned + deepened).toBe(before.itemsHeldP);
  expect(after.itemsHeldP).toBe(0n); expect(after.poolHeldP).toBe(0n); expect(after.growHeldP).toBe(0n);
  expect(after.buyBackP - before.buyBackP).toBe(burned);
  expect(after.itemClaims - before.itemClaims).toBe(paid);
  const receiverRelease = before.poolHeldP + before.growHeldP + deepened;
  expect(after.hookClaims - before.hookClaims).toBe(receiverRelease + qLeft);
  for (const field of ['fitOwed', 'platformOwed', 'creatorP', 'holderClaims', 'pilePendingP', 'eatPendingP', 'rewardsPendingP', 'shopPendingP', 'dust']) expect(after[field]).toBe(before[field]);
  expect(after.booked - before.booked).toBe(-paid - deepened - before.poolHeldP - before.growHeldP);
  evidence.graduation = { hash: receipt.transactionHash, before, after, funded,
    migration: { ...migration, principal, tokenBudget, qUsed, receiverRelease } };
}

/** Rug Rugs' failure: value inputs BEFORE fail(), then audit routing before any refund. */
export async function fail(chain, example, box, carry, evidence) {
  // This registry failure uses unsourced creator fees. Refuse new recipes until their
  // source-specific final allocations have an independent oracle as well.
  expect(example.fees.buyers.choice).toBe('keep'); expect(example.fees.sellers.choice).toBe('keep');
  expect(box.holderLedger).toBe(zeroAddress); expect(box.itemLedger).toBe(zeroAddress);
  const before = await snapshot(chain, box);
  const principal = await curvePrincipal(chain, box);
  const manager = await read(chain, 'BoxReceiverV2', box.receiver, 'poolManager');
  const claims = owner => read(chain, 'PoolManager', manager, 'balanceOf', [owner, BigInt(box.p)]);
  const coordinatorClaims = await claims(box.coordinator);
  const reserve = await read(chain, 'BoxHookV2', box.hook, 'reserveMinted');
  const tipCap = await read(chain, 'BoxHookV2', box.hook, 'deepenTipCap');
  const router = await read(chain, 'BoxReceiverV2', box.receiver, 'launchRouter');
  const routerP = await balance(chain, box.p, router);
  // No trades intervene between the last audited collection and this snapshot.
  expect(await read(chain, 'BoxHookV2', box.hook, 'saleFeesPending')).toBe(0n);
  expect(before.receiverClaims).toBe(before.booked);
  expect(before.dust).toBe(carry.buyers + carry.sellers);
  expect(reserve).toBeLessThanOrEqual(coordinatorClaims);
  expect(routerP, 'Rug Rugs has no creator buy or router gifts').toBe(0n);

  // The D6 reserve is split like fees on the buyers' side, its remainder becoming that side's carry.
  const allocation = feeAllocation(reserve + carry.buyers, 'keep');
  // RC5-A (F136): grow money and both side carries join the pot (FailureTableV2 DEPTH_BRANCH and SIDE_CARRY to
  // CLOSING_POOL); only the reserve split's FIT and platform shares stay owed to their Safes.
  const heldForPot = before.poolHeldP + before.creatorP + before.buyBackP + before.itemsHeldP + before.royaltyHeldP + before.growHeldP;
  const grossPot = principal.q + before.hookClaims + coordinatorClaims - reserve
    + heldForPot + allocation.pool + allocation.branch + allocation.dust + carry.sellers;
  const tip = grossPot < tipCap ? grossPot : tipCap;
  const expected = {
    pot: grossPot - tip, tip,
    fitOwed: before.fitOwed + allocation.fit,
    platformOwed: before.platformOwed + allocation.platform,
  };
  const input = principal.q + before.hookClaims + coordinatorClaims + before.receiverClaims + routerP;
  expect(expected.pot + expected.tip + expected.fitOwed + expected.platformOwed, 'failure input conservation').toBe(input);
  const closerBefore = await balance(chain, box.p, chain.accounts.keeper);
  const receipt = await call(chain, 'BoxCoordinatorV2', box.coordinator, 'fail');
  const after = await snapshot(chain, box);
  const [fixed] = events(receipt, 'BoxCoordinatorV2', box.coordinator, 'PotFixed');
  expect(fixed, 'failure receipt').toBeDefined();
  expect(fixed.pot, 'failure pot from pre-failure inputs').toBe(expected.pot);
  expect(fixed.tip, 'failure closer tip').toBe(expected.tip);
  expect(fixed.closer.toLowerCase()).toBe(chain.accounts.keeper.toLowerCase());
  expect((await read(chain, 'BoxCoordinatorV2', box.coordinator, 'claimState'))[0], 'failure claim pot').toBe(expected.pot);
  expect(await claims(box.coordinator), 'failure pot backing').toBe(expected.pot);
  expect(after.fitOwed, 'failure FIT destination').toBe(expected.fitOwed);
  expect(after.platformOwed, 'failure platform destination').toBe(expected.platformOwed);
  expect(after.receiverClaims).toBe(expected.fitOwed + expected.platformOwed);
  expect(after.booked).toBe(after.receiverClaims);
  for (const field of ['poolHeldP', 'growHeldP', 'creatorP', 'buyBackP', 'itemsHeldP', 'royaltyHeldP', 'dust', 'hookClaims']) expect(after[field]).toBe(0n);
  const closerAfter = await balance(chain, box.p, chain.accounts.keeper);
  const gas = box.p === zeroAddress ? receipt.gasUsed * receipt.effectiveGasPrice : 0n;
  expect(closerAfter - closerBefore + gas, 'failure paid closer tip').toBe(expected.tip);
  expect(expected.pot + (closerAfter - closerBefore + gas) + after.receiverClaims, 'failure output conservation').toBe(input);
  evidence.failureRouting = { hash: receipt.transactionHash, before, after, principal, coordinatorClaims, reserve,
    routerP, carry, allocation, heldForPot, input, expected, fixed };
  return { receipt, fixed, expected };
}
