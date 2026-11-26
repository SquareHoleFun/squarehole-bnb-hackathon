import assert from 'node:assert/strict';

const WEEK = 604800n;
const same = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase());
/** Runs against live chain reads or scripted offline observations. A refusal must be a decoded contract error. */
export async function runShopChecks(io, { actor, vault, collections, unlistedCollection: added, openedAt, seedT, price }, starter) {
  const [a] = collections;
  assert.ok(added && !collections.some(c => c.toLowerCase() === added.toLowerCase()), 'delay check needs an unlisted collection');
  const supply = await io.supply();
  assert.equal(await io.budget(), seedT, 'no fee purchase has run yet');
  assert.equal(await io.inside(), BigInt(starter.length));
  const refusals = [];
  const state = async (collection, id) => ({ budget: await io.budget(), coins: await io.coins(), inside: await io.inside(), owner: await io.owner(collection, id) });
  const refuse = async (method, args, label) => {
    const snapshot = () => method === 'addCollection' ? Promise.all([io.budget(), io.coins(), io.inside()]) : state(args[0], args[1]);
    const before = await snapshot();
    await assert.rejects(io.simulate(method, args, label), error => {
      const name = error.errorName ?? error.walk?.(e => e.data?.errorName)?.data?.errorName;
      return name === (label === 'curator-only' ? 'Unauthorized' : 'InvalidRequest');
    }, label);
    assert.deepEqual(await snapshot(), before, `${label}: no custody or money change`);
    refusals.push(label);
  };
  const held = starter.map(item => ({ collection: item.collection, id: BigInt(item.id) }));
  const move = async (method, collection, id) => {
    const [giveT, pickT] = await io.terms(collection);
    assert.equal(giveT, price); assert.equal(pickT, 2n * giveT, 'J2 named pick is exactly 2x');
    const before = await state(collection, id);
    const give = method === 'give'; const amount = give ? giveT : pickT;
    same(before.owner, give ? actor : vault);
    await io.send(method, give ? [collection, id, amount] : [collection, id, amount, actor]);
    const after = await state(collection, id);
    assert.equal(after.budget - before.budget, give ? -amount : amount);
    assert.equal(after.coins - before.coins, give ? amount : -amount);
    assert.equal(after.inside - before.inside, give ? 1n : -1n);
    same(after.owner, give ? vault : actor);
    if (give) held.push({ collection, id });
    else held.splice(held.findIndex(item => item.collection === collection && item.id === id), 1);
  };
  await refuse('addCollection', [added, 0], 'curator-only');
  await io.curate(added, 0);
  const [, , activeAt] = await io.terms(added);
  assert.equal(activeAt - await io.now(), WEEK, 'new entry waits exactly seven days');
  for (const collection of [...collections, added]) await io.approve(collection);
  await io.mineTo(activeAt - 1n);
  await refuse('give', [added, 100n, price], 'list-delay');
  await io.mineTo(activeAt);
  const weekly = seedT / 10n;
  const allocation = seedT * 250n / 10000n;
  const perCollection = (allocation < price ? price : allocation) / price;
  const maxGives = weekly / price;
  assert.ok(perCollection > 0n && perCollection < 8n, 'local fixture has eight actor items per collection');
  let spent = 0n;
  for (let i = 0n; i < perCollection; i++) { await move('give', added, 100n + i); spent++; }
  await refuse('give', [added, 100n + perCollection, price], 'collection-limit');
  let blocked;
  for (const collection of collections) {
    for (let i = 0n; i < perCollection; i++) {
      if (spent === maxGives) { blocked = [collection, 100n + i, price]; break; }
      await move('give', collection, 100n + i); spent++;
    }
    if (blocked) break;
  }
  assert.ok(blocked, 'one collection retains room when the weekly allowance is exhausted');
  assert.equal(seedT - await io.budget(), maxGives * price, 'J3 weekly spend rounded down to whole gives');
  await refuse('give', blocked, 'weekly-limit');
  await move('pick', added, 100n);
  await refuse('give', blocked, 'receipts-wait');
  const budget = await io.budget();
  const nextWeek = openedAt + ((await io.now() - openedAt) / WEEK + 1n) * WEEK;
  await io.mineTo(nextWeek);
  await move('give', a, 100n + perCollection);
  const floorGiveT = budget - await io.budget(); assert.equal(floorGiveT, price);
  while (held.length > 1) { const item = held[0]; await move('pick', item.collection, item.id); }
  const last = held[0]; await refuse('pick', [last.collection, last.id, price * 2n, actor], 'last-item');
  assert.equal(await io.inside(), 1n); assert.equal(await io.supply(), supply, 'shop principal never mints or burns T');
  return { refusals, pickT: (price * 2n).toString(), floorGiveT: floorGiveT.toString(), budgetT: (await io.budget()).toString(), inside: '1', last };
}

/** Fee intake uses only live room; every unspent P remains pending or reaches original holders. */
export async function runShopFeeChecks(io, { seedT, price }) {
  const ceiling = await io.ceiling(); assert.equal(ceiling, 2n * seedT);
  const minimum = await io.minimum();
  for (let i = 0; i < 32 && await io.pending() < minimum; i++) await io.tradeAndCollect();
  assert.ok(await io.pending() >= minimum, 'enough sellers fees for a purchase');
  const startP = await io.pending(), budget = await io.budget(), holders = await io.holders();
  let spentP = 0n;
  for (let i = 0; i < 64 && await io.pending() >= minimum; i++) {
    const before = await io.pending();
    spentP += await io.step();
    assert.ok(await io.budget() <= ceiling, 'fees stay below live ceiling');
    assert.equal(await io.allowance(), 0n, 'approval consumed exactly');
    if (await io.pending() === before) break;
  }
  assert.ok(await io.fees() > 0n, 'G1-C1: sellers fees must buy TRASH');
  assert.equal(await io.budget() - budget, await io.fees(), 'bought TRASH enters budget');
  assert.equal(spentP + await io.pending() + await io.holders() - holders, startP, 'spent, waiting and refunded P conserve');
  // Profitable give/pick receipts can finish the budget. A waiting sub-minimum fee tail keeps its
  // original holders until the shop stops wanting fees; no synthetic T is credited as fee intake.
  for (let i = 0n; i < ceiling / price && await io.budget() < ceiling; i++) {
    await io.nextWeek(); await io.giveAndPick();
  }
  assert.ok(await io.budget() >= ceiling && await io.budget() < ceiling + 2n * price);
  await io.nextWeek(); assert.equal(await io.wanted(), false);
  if (await io.pending() > 0n) spentP += await io.step();
  assert.equal(await io.pending(), 0n);
  assert.equal(spentP + await io.holders() - holders, startP, 'final P conservation');
  const before = await io.holders(); await io.tradeAndCollect();
  assert.equal(await io.pending(), 0n); assert.ok(await io.holders() > before, 'full shop pays holders in Test Gold');
  assert.ok(await io.sellerFunding() > 0n, 'seller batch has P funding');
  return { ceilingT: ceiling.toString(), feesT: (await io.fees()).toString(), spentP: spentP.toString(), pendingP: '0', fullBudgetT: (await io.budget()).toString() };
}

export async function runJunkyardShop(chain, example, box, evidence, tradeAndCollect) {
  const { artifact, read, call, events } = await import('./chain.mjs');
  const { localClient, mineTo } = await import('../../../../../packages/chain/scripts/local-core-v2-chain.mjs');
  const { safeCall } = await import('./junkyard-create.mjs');
  const actor = chain.accounts.actor;
  const shop = (fn, args = []) => read(chain, 'ShopVaultV2', box.vault, fn, args);
  await call(chain, 'BoxTokenV2', box.token, 'approve', [box.vault, await read(chain, 'BoxTokenV2', box.token, 'balanceOf', [actor])], actor);
  const io = {
    now: async () => (await localClient(chain).getBlock()).timestamp, mineTo: t => mineTo(chain.rpcUrl, t),
    budget: () => shop('budgetT'), inside: () => shop('inside'),
    supply: () => read(chain, 'BoxTokenV2', box.token, 'totalSupply'),
    coins: () => read(chain, 'BoxTokenV2', box.token, 'balanceOf', [actor]),
    owner: (collection, id) => read(chain, 'JunkyardCollection', collection, 'ownerOf', [BigInt(id)]),
    terms: collection => shop('collectionTerms', [collection]),
    approve: collection => call(chain, 'JunkyardCollection', collection, 'setApprovalForAll', [box.vault, true], actor),
    curate: (collection, tier) => safeCall(chain, 'ShopVaultV2', box.vault, 'addCollection', [collection, tier]),
    simulate: (functionName, args) => localClient(chain).simulateContract({ account: actor, address: box.vault, abi: artifact('ShopVaultV2').abi, functionName, args }),
    send: (method, args) => call(chain, 'ShopVaultV2', box.vault, method, args, actor),
  };
  evidence.shop = await runShopChecks(io, { actor, vault: box.vault, collections: Object.values(chain.junkyard.collections),
    unlistedCollection: chain.junkyard.unlistedCollection,
    openedAt: await read(chain, 'BoxCoordinatorV2', box.coordinator, 'graduatedAt'), seedT: BigInt(example.contents.shop.seedT), price: BigInt(example.contents.shop.givePricesT[0]) }, box.starter);
  const receiver = (fn, args = []) => read(chain, 'BoxReceiverV2', box.receiver, fn, args);
  const manager = await receiver('poolManager');
  evidence.shopFees = await runShopFeeChecks({
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
    giveAndPick: async () => { const c = chain.junkyard.unlistedCollection; const p = BigInt(example.contents.shop.givePricesT[0]); await io.send('give', [c, 100n, p]); await io.send('pick', [c, 100n, 2n * p, actor]); },
    sellerFunding: async () => { let sum = 0n; for (let id = 2n; id <= 100n; id += 2n) if (await receiver('holderBatchClosed', [id])) sum += await receiver('holderBatchPaid', [id]); return sum; },
  }, { seedT: BigInt(example.contents.shop.seedT), price: BigInt(example.contents.shop.givePricesT[0]) });
  await call(chain, 'BoxTokenV2', box.token, 'approve', [box.vault, 0n], actor);
}
