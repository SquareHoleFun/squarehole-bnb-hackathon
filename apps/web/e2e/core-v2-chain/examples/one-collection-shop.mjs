import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SH-ONE-COLLECTION-SHOP: the shop box over ONE outside ERC-721 collection, with a starter set and no curator. Created
 * as the Junkyard is (registry -> chain prepareExample -> the local contract-holder Safe double), on TA-40's actual
 * `JunkCollection` code deployed to the local twin, so the outside collection runs the Sepolia stock's own contract.
 */
const WEEK = 604800n;
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (actual, expected, message) => assert.equal(actual.toLowerCase(), expected.toLowerCase(), message);
/** A refusal must be a decoded contract error, by name. */
const errorName = error => error?.errorName ?? error?.walk?.(e => e.data?.errorName)?.data?.errorName;
/** IShopVaultV2 collectionTerms: a pick costs the give price times the multiple, rounded up. */
export const pickPrice = (giveT, pickBps) => (giveT * BigInt(pickBps) + 9999n) / 10000n;

/** The row this life supports: a shop of one collection, no curator, priced in native ETH. */
export function oneShopRow(example) {
  const shop = example.contents.shop;
  assert.ok(example.contents.kind === 'shop' && shop?.collections.length === 1, 'a one-collection shop row');
  assert.equal(shop.curator, 'none', 'no curator');
  assert.equal(example.priceCoin.symbol, 'ETH', 'priced in native ETH');
  const [only] = shop.collections;
  return { shop, key: only.id, tier: Number(only.tier), starterIds: only.starterIds.map(BigInt),
    seedT: BigInt(shop.seedT), price: BigInt(shop.givePricesT[Number(only.tier)]), pickBps: Number(shop.pickBps),
    weeklyBps: BigInt(shop.weeklyBps), collectionBps: BigInt(shop.collectionBps) };
}

/**
 * The fixed list, before any fee intake: nobody (the creator included) adds a collection or names a curator; the
 * collection waits its delay from Create; a holder sells one back for exactly the give price; a second give that week is
 * over the week's limit (one cheapest give while 10% and 2.5% of the snapshot are below it); another collection's NFT
 * is refused. Runs against live chain reads or scripted offline observations.
 */
export async function fixedListChecks(io, p) {
  const refusals = [];
  const state = async nft => ({ budget: await io.budget(), inside: await io.inside(), owner: nft ? await io.owner(...nft) : null });
  const refuse = async (from, method, args, label, expected = 'InvalidRequest') => {
    const nft = method === 'give' ? [args[0], args[1]] : null;
    const before = await state(nft);
    let refused;
    try { await io.simulate(from, method, args); } catch (error) { refused = errorName(error); }
    assert.equal(refused, expected, `${label}: refused with ${expected}`);
    assert.deepEqual(await state(nft), before, `${label}: no custody or money change`);
    refusals.push(label);
  };
  same(await io.curator(), ZERO, 'no curator: a fixed list');
  assert.equal(await io.budget(), p.seedT, 'the seed alone: no give, pick or fee purchase yet');
  assert.equal(await io.inside(), BigInt(p.starterCount), 'every starter is inside');
  await refuse(p.creator, 'addCollection', [p.other, 0], 'creator-cannot-add', 'Unauthorized');
  await refuse(p.actor, 'addCollection', [p.other, 0], 'nobody-can-add', 'Unauthorized');
  await refuse(p.creator, 'proposeCurator', [p.actor], 'no-successor', 'Unauthorized');
  const [giveT, pickT, activeAt] = await io.terms(p.collection);
  assert.equal(giveT, p.price, 'the tier\'s give price');
  assert.equal(pickT, pickPrice(giveT, p.pickBps), 'a pick costs the row\'s multiple of the give price');
  assert.equal(activeAt - p.createdAt, WEEK, 'the listed collection waits seven days from Create');
  assert.equal((await io.terms(p.other))[2], 0n, 'another collection is not listed');
  let delay = false;
  if (await io.now() < activeAt - 1n) {
    await io.mineTo(activeAt - 1n);
    await refuse(p.holder, 'give', [p.collection, p.holderId, giveT], 'list-delay'); delay = true;
    await io.mineTo(activeAt);
  }
  // Any holder of the collection sells one back: exactly the give price, the NFT into custody.
  const before = { ...(await state([p.collection, p.holderId])), coins: await io.coins(p.holder) };
  same(before.owner, p.holder);
  await io.send(p.holder, 'give', [p.collection, p.holderId, giveT]);
  assert.equal(before.budget - await io.budget(), giveT, 'the give leaves the budget');
  assert.equal(await io.coins(p.holder) - before.coins, giveT, 'the holder gets exactly the give price');
  assert.equal(await io.inside() - before.inside, 1n);
  same(await io.owner(p.collection, p.holderId), p.vault);
  // The week's limit: max(snapshot x bps, the cheapest active give), snapshot = this week's first budget.
  assert.ok(p.seedT * p.weeklyBps / 10000n < giveT && p.seedT * p.collectionBps / 10000n < giveT, 'the floor of one give binds this budget');
  await refuse(p.actor, 'give', [p.collection, p.actorIds[0], giveT], 'weekly-limit');
  await refuse(p.actor, 'give', [p.other, p.otherId, 0n], 'not-listed');
  return { refusals, delay, giveT: giveT.toString(), pickT: pickT.toString(), activeAt: activeAt.toString(), budgetT: (await io.budget()).toString() };
}

/** Named picks at the multiple until one NFT is left, which nobody can pick; the shop never mints or burns its coin. */
export async function pickChecks(io, p, held) {
  const supply = await io.supply();
  const [giveT, pickT] = await io.terms(p.collection);
  assert.equal(pickT, pickPrice(giveT, p.pickBps), 'a pick costs the row\'s multiple of the give price');
  const picked = [];
  while (held.length > 1) {
    const id = held[0];
    const before = { budget: await io.budget(), coins: await io.coins(p.actor), inside: await io.inside() };
    same(await io.owner(p.collection, id), p.vault, `item ${id} is inside`);
    await io.send(p.actor, 'pick', [p.collection, id, pickT, p.actor]);
    assert.equal(await io.budget() - before.budget, pickT, 'the pick price enters the budget');
    assert.equal(before.coins - await io.coins(p.actor), pickT, `a pick costs ${p.pickBps / 10000}x the give price`);
    assert.equal(before.inside - await io.inside(), 1n);
    same(await io.owner(p.collection, id), p.actor);
    held.shift(); picked.push(id.toString());
  }
  assert.equal(await io.inside(), 1n);
  const [last] = held; const budget = await io.budget();
  let refused;
  try { await io.simulate(p.actor, 'pick', [p.collection, last, pickT, p.actor]); } catch (error) { refused = errorName(error); }
  assert.equal(refused, 'InvalidRequest', 'last-item: the last NFT stays');
  assert.equal(await io.budget(), budget); same(await io.owner(p.collection, last), p.vault);
  assert.equal(await io.supply(), supply, 'shop principal never mints or burns its coin');
  return { picked, last: last.toString(), pickT: pickT.toString(), giveT: giveT.toString(), budgetT: budget.toString(), inside: '1' };
}

/**
 * Fees fill the shop up to a ceiling, then go to holders: sellers' fees buy the shop's coin with live room only (twice the
 * seed), every unspent P stays pending or reaches the original trade's holders, one give and one pick a week raise the
 * budget to the ceiling, and then a ready sellers' batch pays holders. The Junkyard's check also asks for a closed
 * sellers' batch with holder P, which there comes from a tail refund; this small shop can spend all its pending P, so a
 * sellers' batch is only collected (ready) after the next trade: trade until one collected while full has paid holders.
 * `record` fills as the checks pass, so a failure keeps what was measured.
 */
export async function shopFeeChecks(io, { seedT, price, pickBps }, record = {}) {
  const ceiling = await io.ceiling(); assert.equal(ceiling, 2n * seedT, 'the ceiling is twice the seed');
  record.ceilingT = ceiling.toString();
  const minimum = await io.minimum();
  for (let i = 0; i < 32 && await io.pending() < minimum; i++) await io.tradeAndCollect();
  assert.ok(await io.pending() >= minimum, "enough sellers' fees for a purchase");
  const startP = await io.pending(), budget = await io.budget(), holders = await io.holders();
  Object.assign(record, { startP: startP.toString(), startBudgetT: budget.toString() });
  let spentP = 0n;
  for (let i = 0; i < 64 && await io.pending() >= minimum; i++) {
    const before = await io.pending();
    spentP += await io.step();
    assert.ok(await io.budget() <= ceiling, 'fees stay below the live ceiling');
    assert.equal(await io.allowance(), 0n, 'approval consumed exactly');
    if (await io.pending() === before) break;
  }
  Object.assign(record, { spentP: spentP.toString(), feesT: (await io.fees()).toString(), afterFeesBudgetT: (await io.budget()).toString() });
  assert.ok(await io.fees() > 0n, "sellers' fees must buy the shop's coin");
  assert.equal(await io.budget() - budget, await io.fees(), 'bought coins enter the budget');
  assert.equal(spentP + await io.pending() + await io.holders() - holders, startP, 'spent, waiting and refunded P conserve');
  record.weeks = 0;
  for (let i = 0n; i < ceiling / price && await io.budget() < ceiling; i++) { await io.nextWeek(); await io.giveAndPick(); record.weeks++; }
  assert.ok(await io.budget() >= ceiling && await io.budget() < ceiling + pickPrice(price, pickBps), 'the budget reaches the ceiling');
  record.fullBudgetT = (await io.budget()).toString();
  await io.nextWeek(); assert.equal(await io.wanted(), false, 'a full shop wants no fees');
  if (await io.pending() > 0n) spentP += await io.step();
  assert.equal(await io.pending(), 0n, 'nothing waits for a full shop');
  assert.equal(spentP + await io.holders() - holders, startP, 'final P conservation');
  const paid = await io.sellerFunding(); const before = await io.holders();
  record.sellerFundingBeforeP = paid.toString(); record.tradesAfterFull = 0;
  for (let i = 0; i < 4 && await io.sellerFunding() === paid; i++) {
    await io.tradeAndCollect(); record.tradesAfterFull++;
    assert.equal(await io.pending(), 0n, 'a full shop takes no fee');
  }
  assert.ok(await io.holders() > before, 'holders are paid');
  assert.ok(await io.sellerFunding() > paid, "once the shop is full, sellers' fees pay holders");
  return Object.assign(record, { spentP: spentP.toString(), pendingP: '0', sellerFundingP: (await io.sellerFunding()).toString() });
}

const TA40 = new URL('../../../../../examples/boxes/junkyard/test-collections/catalog.json', import.meta.url);
/** TA-40's collection kind for a binding key: its place in the catalog (bent-cans 0 to tangled-wires 4). */
export function junkKind(key) {
  const kind = JSON.parse(readFileSync(TA40, 'utf8')).collections.findIndex(c => c.key === key);
  assert.ok(kind >= 0, `not a TA-40 collection: ${key}`);
  return kind;
}

/**
 * Local stock: TA-40's JunkCollection for the row's key (owner: the deployer, as on Sepolia), the row's starter ids
 * minted to the Safe double, a few ids to the two traders, and one NFT of another Test Junk kind, never listed.
 */
async function localStock(chain, key, starterIds, deploy, call) {
  const safe = chain.junkyard.safe; const { deployer, actor, backup } = chain.accounts;
  const kind = junkKind(key);
  const collection = await deploy('JunkCollection', [deployer, kind]);
  const other = await deploy('JunkCollection', [deployer, (kind + 1) % 5]);
  for (const [to, ids] of [[safe, starterIds], [actor, [100n, 101n, 102n]], [backup, [200n]]]) {
    for (const id of ids) await call(chain, 'JunkCollection', collection, 'mint', [to, id, Number(id % 2n) + 1], deployer);
  }
  await call(chain, 'JunkCollection', other, 'mint', [actor, 1n, 1], deployer);
  return { collection, other, kind, actorIds: [100n, 101n, 102n], holderId: 200n, otherId: 1n };
}

export async function createOneCollectionShop(page, chain, example, wallet, evidence) {
  const { encodeDeployData, getAddress, zeroHash } = await import('viem');
  const { prepareExample } = await import('../../../../../packages/chain/scripts/create-example-v2.mjs');
  const { localClient, readLocalBox } = await import('../../../../../packages/chain/scripts/local-core-v2-chain.mjs');
  const { assertLocalRpc, send } = await import('../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs');
  const { writeExampleArt } = await import('../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs');
  const { artifact, read, call, balance } = await import('./chain.mjs');
  const { loadExampleChunks } = await import('./create.mjs');
  const { safeCall } = await import('./junkyard-create.mjs');
  const { EXAMPLE_ART, ROOT } = await import('./support.mjs');
  assert.ok(chain.junkyard?.safe, 'the local contract-holder Safe double is required');
  const row = oneShopRow(example);
  const safe = chain.junkyard.safe; const { actor } = chain.accounts;
  // The only browser connection is this explicit test click; creation itself uses the chain package.
  await page.goto('/');
  assert.deepEqual(wallet.requests, []);
  await page.getByRole('banner').locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Example local wallet' }).click();
  const deploy = async (name, args) => {
    const { abi, bytecode } = artifact(name);
    await assertLocalRpc(chain.rpcUrl);
    const receipt = await send(chain.rpcUrl, { from: chain.accounts.deployer, data: encodeDeployData({ abi, bytecode: bytecode.object, args }) });
    return getAddress(receipt.contractAddress);
  };
  const stock = await localStock(chain, row.key, row.starterIds, deploy, call);
  const plan = await prepareExample(example, { factory: chain.factory, creator: safe, listingId: '0', collections: { [row.key]: stock.collection } },
    { chainId: String(chain.chainId), client: localClient(chain) });
  const { spec, predicted, starter } = plan;
  assert.equal(spec.raise, BigInt(example.raise.amount), 'local native listing matches the example');
  same(spec.pricing.token, ZERO); assert.equal(plan.approval, null, 'native ETH: no token approval');
  assert.deepEqual(starter.map(item => item.id), row.starterIds);
  evidence.art = writeExampleArt(fileURLToPath(EXAMPLE_ART), example.id,
    [{ role: 'logo', sha256: spec.coverSha256, bytes: readFileSync(new URL(example.logo, ROOT)) }]);
  // The Safe double pays the bootstrap and its first buy in ETH from its own balance, funded by its owner.
  const value = BigInt(plan.transaction.value);
  await send(chain.rpcUrl, { from: actor, to: safe, value });
  const beforeEth = await balance(chain, ZERO, safe);
  const receipt = await call(chain, 'JunkyardSafeDouble', safe, 'execute', [plan.transaction.to, value, plan.transaction.data], actor);
  assert.equal(beforeEth - await balance(chain, ZERO, safe), value, 'the Safe paid exactly the bootstrap and its buy');
  const createdAt = (await localClient(chain).getBlock({ blockNumber: receipt.blockNumber })).timestamp;
  assert.equal(await read(chain, 'BoxCoordinatorV2', predicted.coordinator, 'specHash'), plan.specHash);
  same(await read(chain, 'BoxCoordinatorV2', predicted.coordinator, 'creator'), safe);
  const q = await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [spec.pricing.listingId, spec.raise]);
  await loadExampleChunks(chain, spec, predicted.coordinator, safe, q, (...args) => safeCall(chain, ...args));
  let box = await readLocalBox(chain, predicted.coordinator);
  same(await read(chain, 'ShopVaultV2', box.vault, 'curator'), ZERO);
  const safeT = await read(chain, 'BoxTokenV2', box.token, 'balanceOf', [safe]);
  assert.ok(safeT > row.seedT, 'the creator buy funds the seed and leaves coins at the Safe');
  await safeCall(chain, 'HolderLedgerV2', box.holderLedger, 'register');
  await safeCall(chain, 'BoxTokenV2', box.token, 'approve', [box.vault, row.seedT]);
  // One approval per starter id (TA-40 founder step 6): each transfer clears its own, so none is left after loading.
  for (const item of starter) await safeCall(chain, 'JunkCollection', item.collection, 'approve', [box.vault, item.id]);
  const loader = await read(chain, 'BoxCoordinatorV2', box.coordinator, 'starterSetLoader');
  for (let offset = 0; offset < starter.length; offset += 32) {
    const items = starter.slice(offset, offset + 32);
    await safeCall(chain, 'StarterSetLoaderV2', loader, 'load', [items.map(i => i.collection), items.map(i => i.id), items.map(i => i.tier), items.at(-1).nextHash]);
  }
  await safeCall(chain, 'ShopVaultV2', box.vault, 'fundSeed');
  await call(chain, 'StarterSetLoaderV2', loader, 'complete');
  assert.deepEqual(await read(chain, 'StarterSetLoaderV2', loader, 'progress'), [starter.length, zeroHash, true]);
  assert.equal(await read(chain, 'ShopVaultV2', box.vault, 'budgetT'), row.seedT);
  assert.equal(await read(chain, 'BoxTokenV2', box.token, 'balanceOf', [safe]), safeT - row.seedT);
  assert.equal(await read(chain, 'BoxTokenV2', box.token, 'allowance', [safe, box.vault]), 0n, 'the seed approval is used up exactly');
  for (const item of starter) {
    same(await read(chain, 'JunkCollection', item.collection, 'ownerOf', [item.id]), box.vault);
    same(await read(chain, 'JunkCollection', item.collection, 'getApproved', [item.id]), ZERO);
  }
  assert.equal(await read(chain, 'JunkCollection', stock.collection, 'isApprovedForAll', [safe, box.vault]), false);
  box = await readLocalBox(chain, predicted.coordinator); assert.equal(box.gateOpen, true);
  evidence.creation = { path: 'registry → chain prepareExample → local contract-holder createBox', specHash: plan.specHash, coordinator: box.coordinator,
    token: box.token, transaction: receipt.transactionHash, creator: safe, createdAt, creatorBuyP: spec.creatorBuy, valueP: value, safeT, seedT: row.seedT,
    starterCount: starter.length, curator: ZERO, collection: stock.collection, kind: stock.kind, other: stock.other,
    ceilingPreset: example.fees.sellers.ceilingPreset, custody: chain.junkyard.custody };
  return { ...box, spec, p: ZERO, decimals: 18, starter, creator: safe, createdAt, stock };
}

export async function runOneCollectionShop(chain, example, box, evidence, tradeAndCollect) {
  const { artifact, read, call, events } = await import('./chain.mjs');
  const { localClient, mineTo } = await import('../../../../../packages/chain/scripts/local-core-v2-chain.mjs');
  const row = oneShopRow(example);
  const { actor, backup } = chain.accounts; const { collection, other } = box.stock;
  const shop = (fn, args = []) => read(chain, 'ShopVaultV2', box.vault, fn, args);
  const coins = who => read(chain, 'BoxTokenV2', box.token, 'balanceOf', [who]);
  for (const who of [actor, backup]) await call(chain, 'BoxTokenV2', box.token, 'approve', [box.vault, await coins(who)], who);
  for (const who of [actor, backup]) await call(chain, 'JunkCollection', collection, 'setApprovalForAll', [box.vault, true], who);
  await call(chain, 'JunkCollection', other, 'setApprovalForAll', [box.vault, true], actor);
  const io = {
    now: async () => (await localClient(chain).getBlock()).timestamp, mineTo: t => mineTo(chain.rpcUrl, t),
    curator: () => shop('curator'), budget: () => shop('budgetT'), inside: () => shop('inside'), terms: c => shop('collectionTerms', [c]),
    supply: () => read(chain, 'BoxTokenV2', box.token, 'totalSupply'), coins,
    owner: (c, id) => read(chain, 'JunkCollection', c, 'ownerOf', [BigInt(id)]),
    simulate: (from, functionName, args) => localClient(chain).simulateContract({ account: from, address: box.vault, abi: artifact('ShopVaultV2').abi, functionName, args }),
    send: (from, method, args) => call(chain, 'ShopVaultV2', box.vault, method, args, from),
  };
  const params = { creator: box.creator, actor, holder: backup, vault: box.vault, collection, other, price: row.price, pickBps: row.pickBps,
    weeklyBps: row.weeklyBps, collectionBps: row.collectionBps, seedT: row.seedT, createdAt: box.createdAt, starterCount: box.starter.length, holderId: box.stock.holderId, actorIds: box.stock.actorIds, otherId: box.stock.otherId };
  evidence.shop = await fixedListChecks(io, params);
  // Sellers' fees fill the shop up to twice its seed, then go to holders; each later week takes one give at the floor.
  const receiver = (fn, args = []) => read(chain, 'BoxReceiverV2', box.receiver, fn, args);
  const manager = await receiver('poolManager');
  const WEEKLY = { give: box.stock.actorIds[1] };
  const floorGives = [];
  evidence.shopFees = { floorGives };
  await shopFeeChecks({
    ...io, ceiling: () => shop('ceilingT'), fees: () => shop('feesT'), wanted: () => shop('feesWanted'),
    pending: () => receiver('modulePendingP', [true]), minimum: async () => (await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [box.spec.pricing.listingId, box.raise])).swapStepMinQ,
    holders: () => read(chain, 'PoolManager', manager, 'balanceOf', [box.holderLedger, BigInt(box.p)]),
    allowance: () => read(chain, 'BoxTokenV2', box.token, 'allowance', [box.receiver, box.vault]),
    tradeAndCollect,
    step: async () => {
      const receipt = await call(chain, 'BoxReceiverV2', box.receiver, 'executeModule', [true]);
      return events(receipt, 'IBoxReceiverShopV21', box.receiver, 'ShopFunded').reduce((sum, e) => sum + e.spentP, 0n);
    },
    nextWeek: async () => io.mineTo(await io.now() + WEEK),
    giveAndPick: async () => {
      const before = await coins(actor);
      await io.send(actor, 'give', [collection, WEEKLY.give, row.price]);
      assert.equal(await coins(actor) - before, row.price, 'a later week takes one give at the floor');
      floorGives.push(WEEKLY.give.toString());
      await io.send(actor, 'pick', [collection, WEEKLY.give, pickPrice(row.price, row.pickBps), actor]);
    },
    // Sellers' batches are the even trade batches up to the hook's current one.
    sellerFunding: async () => {
      const end = await read(chain, 'BoxHookV2', box.hook, 'currentTradeBatch', [false]);
      let sum = 0n; for (let id = 2n; id <= end; id += 2n) if (await receiver('holderBatchClosed', [id])) sum += await receiver('holderBatchPaid', [id]);
      return sum;
    },
  }, { seedT: row.seedT, price: row.price, pickBps: row.pickBps }, evidence.shopFees);
  // Everything inside is picked but one: the ten starters and the holder's give (the trader picked its weekly gives back).
  const held = [...box.starter.map(item => BigInt(item.id)), box.stock.holderId];
  for (const id of held) same(await io.owner(collection, id), box.vault);
  evidence.picks = await pickChecks(io, params, held);
  for (const who of [actor, backup]) await call(chain, 'BoxTokenV2', box.token, 'approve', [box.vault, 0n], who);
  for (const who of [actor, backup]) await call(chain, 'JunkCollection', collection, 'setApprovalForAll', [box.vault, false], who);
  await call(chain, 'JunkCollection', other, 'setApprovalForAll', [box.vault, false], actor);
}
