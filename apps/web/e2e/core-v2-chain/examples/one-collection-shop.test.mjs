import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadExamples } from '../../../../../packages/box-spec/examples/v2/registry.mjs';
import { fixedListChecks, junkKind, oneShopRow, pickChecks, pickPrice, shopFeeChecks } from './one-collection-shop.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const examples = loadExamples();
const row = examples.find(e => e.id === 'one-collection-shop');

test('the life takes only a one-collection, no-curator, ETH shop row, and TA-40 keys by catalog place', () => {
  const r = oneShopRow(row);
  assert.deepEqual([r.key, r.tier, r.starterIds.length, r.pickBps, r.weeklyBps, r.collectionBps], ['bent-cans', 0, 10, 20000, 1000n, 250n]);
  assert.equal(r.seedT, 2n * r.price);
  assert.throws(() => oneShopRow(examples.find(e => e.id === 'junkyard')), /one-collection shop row/);
  const curated = structuredClone(row); curated.contents.shop.curator = 'creator';
  assert.throws(() => oneShopRow(curated), /no curator/);
  const gold = structuredClone(row); gold.priceCoin = { symbol: 'PAXG', decimals: '18' };
  assert.throws(() => oneShopRow(gold), /native ETH/);
  assert.deepEqual(['bent-cans', 'lost-cogs', 'split-boots', 'cracked-mugs', 'tangled-wires'].map(junkKind), [0, 1, 2, 3, 4]);
  assert.throws(() => junkKind('scrap-a'), /not a TA-40 collection/);
  assert.equal(pickPrice(10n ** 24n, 20000), 2n * 10n ** 24n);
  assert.equal(pickPrice(3n, 12500), 4n, 'a pick price rounds up');
});

// Scripted chain responses: these test the life's checks, not a substitute shop implementation.
function fixture(corrupt, { afterGive = false } = {}) {
  const unit = 10n ** 24n; const week = 604800n; const createdAt = 1000n;
  const activeAt = createdAt + week + (corrupt === 'delay' ? 1n : 0n);
  const pickT = corrupt === 'pick-1x' ? unit : 2n * unit;
  let now = createdAt + 3600n; let budget = 2n * unit; let inside = 10n; let supply = 10n ** 27n; let spentThisWeek = 0n;
  const owners = new Map([...Array.from({ length: 10 }, (_, i) => [`c:${i + 3}`, 'vault']), ['c:200', 'holder'], ['c:100', 'actor'], ['c:101', 'actor'], ['o:1', 'actor']]);
  const coins = new Map([['holder', 0n], ['actor', 100n * unit]]);
  // The state fixedListChecks leaves: the holder's NFT inside, one give spent this week.
  if (afterGive) { owners.set('c:200', 'vault'); inside = 11n; budget = unit; spentThisWeek = unit; now = activeAt; }
  const refuse = name => { throw Object.assign(new Error('contract refused'), { errorName: name }); };
  const io = {
    now: async () => now, mineTo: async t => { if (t > now) now = t; },
    curator: async () => (corrupt === 'curator' ? '0x0000000000000000000000000000000000000001' : ZERO),
    budget: async () => budget, inside: async () => inside, supply: async () => supply,
    coins: async who => coins.get(who) ?? 0n,
    owner: async (c, id) => owners.get(`${c}:${id}`) ?? 'nobody',
    terms: async c => (c === 'c' ? [unit, pickT, activeAt] : [0n, 0n, 0n]),
    simulate: async (_from, method, args) => {
      if (method === 'addCollection' || method === 'proposeCurator') refuse(corrupt === 'wrong-error' ? 'InvalidRequest' : 'Unauthorized');
      if (method === 'give' && args[0] !== 'c') refuse('InvalidRequest');
      if (method === 'give' && now < activeAt) refuse('InvalidRequest');
      if (method === 'give' && spentThisWeek >= unit && corrupt !== 'second-give') refuse('InvalidRequest');
      if (method === 'pick' && inside <= 1n && corrupt !== 'last-pick') refuse('InvalidRequest');
    },
    send: async (from, method, args) => {
      const [c, id] = args;
      if (method === 'give') {
        const paid = corrupt === 'underpaid' ? unit - 1n : unit;
        budget -= paid; coins.set(from, coins.get(from) + paid); inside++; owners.set(`${c}:${id}`, 'vault'); spentThisWeek += unit;
      } else {
        budget += pickT; coins.set(from, coins.get(from) - pickT); inside--; owners.set(`${c}:${id}`, from);
        if (corrupt === 'minted') supply++;
      }
    },
  };
  const params = { creator: 'safe', actor: 'actor', holder: 'holder', vault: 'vault', collection: 'c', other: 'o', price: unit, pickBps: 20000,
    weeklyBps: 1000n, collectionBps: corrupt === 'big-budget' ? 10000n : 250n, seedT: 2n * unit, createdAt, starterCount: 10, holderId: 200n, actorIds: [100n, 101n], otherId: 1n };
  return { io, params };
}

test('fixed list: nobody adds or names a curator, the delay holds, a holder sells back once a week, other NFTs are refused', async () => {
  const { io, params } = fixture();
  const result = await fixedListChecks(io, params);
  assert.deepEqual(result.refusals, ['creator-cannot-add', 'nobody-can-add', 'no-successor', 'list-delay', 'weekly-limit', 'not-listed']);
  assert.equal(result.delay, true);
  assert.equal(result.giveT, (10n ** 24n).toString()); assert.equal(result.pickT, (2n * 10n ** 24n).toString());
  assert.equal(result.budgetT, (10n ** 24n).toString(), 'the seed less one give');
});
for (const [corrupt, reason] of [['curator', /no curator: a fixed list/], ['wrong-error', /creator-cannot-add: refused with Unauthorized/],
  ['big-budget', /the floor of one give binds this budget/],
  ['second-give', /weekly-limit: refused with InvalidRequest/], ['underpaid', /the give leaves the budget/],
  ['delay', /waits seven days from Create/], ['pick-1x', /multiple of the give price/]]) {
  test(`fixed list rejects ${corrupt}`, async () => {
    const { io, params } = fixture(corrupt);
    await assert.rejects(fixedListChecks(io, params), reason);
  });
}

test('picks cost the multiple until one NFT stays, and the coin supply never moves', async () => {
  const { io, params } = fixture();
  await fixedListChecks(io, params);
  const held = [...Array.from({ length: 10 }, (_, i) => BigInt(i + 3)), 200n];
  const result = await pickChecks(io, params, held);
  assert.equal(result.picked.length, 10); assert.equal(result.last, '200'); assert.equal(result.inside, '1');
});
for (const [corrupt, reason] of [['last-pick', /last-item: the last NFT stays/], ['minted', /never mints or burns/], ['pick-1x', /multiple of the give price/]]) {
  test(`picks reject ${corrupt}`, async () => {
    const { io, params } = fixture(corrupt, { afterGive: true });
    await assert.rejects(pickChecks(io, params, [...Array.from({ length: 10 }, (_, i) => BigInt(i + 3)), 200n]), reason);
  });
}
test('the scripted state after the give matches what the fixed-list checks leave', async () => {
  const live = fixture(); await fixedListChecks(live.io, live.params);
  const prepared = fixture(undefined, { afterGive: true });
  for (const read of ['budget', 'inside']) assert.equal(await prepared.io[read](), await live.io[read]());
  assert.equal(await prepared.io.owner('c', 200n), await live.io.owner('c', 200n));
});

// Scripted fee observations, as the Junkyard's fee tests use: a 1,000 seed, a 2,000 ceiling, a 25 give and 50 pick.
function feeFixture(corrupt) {
  let budget = 1500n, pending = 0n, holders = 0n, fees = 0n, sellerPaid = 0n, full = false;
  return {
    ceiling: async () => (corrupt === 'ceiling-preset' ? 4000n : 2000n), minimum: async () => 100n, pending: async () => pending,
    budget: async () => budget, holders: async () => holders, fees: async () => fees,
    allowance: async () => (corrupt === 'allowance' ? 1n : 0n), nextWeek: async () => {},
    wanted: async () => budget < 2000n,
    // A sale's sellers' batch is collected one trade later: the first trade after the shop is full pays buyers' holders only.
    tradeAndCollect: async () => {
      if (budget < 2000n) { pending += 100n; return; }
      if (corrupt === 'pending-after-full') pending += 1n;
      holders += 100n; if (full && corrupt !== 'never-paid') sellerPaid += 40n; full = true;
    },
    step: async () => {
      if (corrupt === 'no-purchase') { pending = 0n; holders += 100n; return 0n; }
      fees = 499n; budget += corrupt === 'overfill' ? 501n : fees;
      pending = 0n; holders += corrupt === 'tail' ? 19n : 20n; return 80n;
    },
    giveAndPick: async () => { budget += 25n; }, sellerFunding: async () => sellerPaid,
  };
}
test('fees fill the shop to its ceiling, conserve P, and once it is full a ready sellers batch pays holders', async () => {
  const record = {};
  const result = await shopFeeChecks(feeFixture(), { seedT: 1000n, price: 25n, pickBps: 20000 }, record);
  assert.equal(result, record, 'the record is the result');
  assert.deepEqual([result.feesT, result.pendingP, result.fullBudgetT, result.tradesAfterFull, result.sellerFundingP], ['499', '0', '2024', 2, '40']);
});
for (const [corrupt, reason] of [['ceiling-preset', /twice the seed/], ['overfill', /below the live ceiling/], ['allowance', /approval consumed exactly/],
  ['no-purchase', /must buy the shop's coin/], ['tail', /conserve/], ['pending-after-full', /a full shop takes no fee/], ['never-paid', /sellers' fees pay holders/]]) {
  test(`fee checks reject ${corrupt}`, async () => {
    const record = {};
    await assert.rejects(shopFeeChecks(feeFixture(corrupt), { seedT: 1000n, price: 25n, pickBps: 20000 }, record), reason);
    if (corrupt === 'never-paid') assert.equal(record.tradesAfterFull, 4, 'a bounded number of trades, kept in the record');
  });
}
