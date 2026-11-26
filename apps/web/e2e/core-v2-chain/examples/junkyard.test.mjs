import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runShopChecks } from './junkyard.mjs';

// Scripted chain responses: these test the life runner's checks, not a substitute shop implementation.
function fixture(corruption) {
  const unit = 10n ** 18n, price = 25n * unit, week = 604800n;
  let budget = 1000n * unit, coins = 10000n * unit, inside = 10n, now = 1000n;
  const owners = new Map(); const moves = []; let sends = 0;
  const listed = ['a', 'b', 'c', 'd', 'e'];
  const entries = listed.flatMap(c => [1n, 2n].map(id => ({ collection: c, id, tier: 0 })));
  for (const item of entries) owners.set(`${item.collection}:${item.id}`, 'vault');
  const io = {
    now: async () => now, mineTo: async t => { now = t; },
    budget: async () => budget + (corruption === 'budget' && sends > 1 ? 1n : 0n),
    coins: async () => coins, inside: async () => inside, supply: async () => 100000n * unit,
    owner: async (c, id) => owners.get(`${c}:${id}`) ?? 'actor',
    terms: async () => [price, price * 2n, 1000n + week],
    approve: async () => {}, curate: async c => { assert.ok(!listed.includes(c), 'cannot add an already listed starter collection'); },
    simulate: async (_method, _args, label) => {
      if (corruption === 'accepted-delay' && label === 'list-delay') return;
      throw Object.assign(new Error('contract refused'), { errorName: label === 'curator-only' ? 'Unauthorized' : 'InvalidRequest' });
    },
    send: async (method, args) => {
      sends++; const [c, id] = args; moves.push([method, c, id]);
      if (method === 'give') { budget -= price; coins += price; inside++; owners.set(`${c}:${id}`, corruption === 'custody' ? 'actor' : 'vault'); }
      else { budget += 2n * price; coins -= 2n * price; inside--; owners.set(`${c}:${id}`, 'actor'); }
    },
  };
  return { io, entries, moves, addresses: { actor: 'actor', vault: 'vault', collections: listed, unlistedCollection: 'extra', openedAt: 1000n, seedT: budget, price } };
}

test('shop life exercises delayed listing, both limits, 2x named picks, floor, last reserve and conservation', async () => {
  const f = fixture(); const result = await runShopChecks(f.io, f.addresses, f.entries);
  assert.deepEqual(result.refusals, ['curator-only', 'list-delay', 'collection-limit', 'weekly-limit', 'receipts-wait', 'last-item']);
  assert.equal(result.pickT, '50000000000000000000');
  assert.equal(result.floorGiveT, '25000000000000000000');
  assert.ok(f.moves.some(([method, c]) => method === 'give' && c === 'extra'));
  assert.equal(result.inside, '1');
});
for (const corruption of ['budget', 'custody', 'accepted-delay']) test(`shop life rejects ${corruption}`, async () => {
  const f = fixture(corruption); await assert.rejects(runShopChecks(f.io, f.addresses, f.entries));
});

import { runShopFeeChecks } from './junkyard.mjs';
function feeFixture(corruption, dust = false) {
  let budget = 1500n, pending = 0n, holders = 0n, fees = 0n;
  return {
    ceiling: async () => 2000n, minimum: async () => 100n, pending: async () => pending,
    budget: async () => budget, holders: async () => holders, fees: async () => fees,
    allowance: async () => corruption === 'allowance' ? 1n : 0n, nextWeek: async () => {},
    wanted: async () => budget < 2000n,
    tradeAndCollect: async () => { if (budget < 2000n) pending += 100n; else holders += 100n; },
    step: async () => {
      if (dust) { pending = 0n; holders += 100n; return 0n; }
      fees = 499n; budget += corruption === 'ceiling' ? 501n : fees;
      pending = 0n; holders += corruption === 'tail' ? 19n : 20n; return 80n;
    },
    giveAndPick: async () => { budget += 25n; }, sellerFunding: async () => holders,
  };
}
test('shop fee life fills to ceiling, conserves P refunds and then pays holders', async () => {
  const result = await runShopFeeChecks(feeFixture(), { seedT: 1000n, price: 25n });
  assert.equal(result.feesT, '499'); assert.equal(result.pendingP, '0'); assert.equal(result.fullBudgetT, '2024');
});
test('G1-C1 rejects a Junkyard life with no fee purchase even if picks fill the shop', async () => {
  await assert.rejects(runShopFeeChecks(feeFixture(undefined, true), { seedT: 1000n, price: 25n }), /sellers fees must buy TRASH/);
});
for (const corruption of ['ceiling', 'tail', 'allowance']) test(`shop fee life rejects ${corruption}`, async () => {
  await assert.rejects(runShopFeeChecks(feeFixture(corruption), { seedT: 1000n, price: 25n }));
});
