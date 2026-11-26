import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runLocalLife } from '../local-core-v2-chain.mjs';

function life() {
  const names = ['plain', 'holders', 'shop', 'failure', 'everyItem', 'coinPile', 'usdc', 'stock', 'gold'];
  const chain = { boxes: Object.fromEntries(names.map(name => [name, name])), accounts: { actor: 'actor', keeper: 'keeper' } };
  const calls = [];
  const state = name => ({ coordinator: name, receiver: `${name}-receiver`, hook: `${name}-hook`,
    holderLedger: `${name}-ledger`, itemLedger: `${name}-ledger`, openAt: 100n, deadline: 10000000n, actorT: 1000n, saleFeesPending: 1n });
  const actions = {
    checkpoint: async (_chain, label) => { calls.push(['checkpoint', label]); return Object.fromEntries(names.map(n => [n, state(n)])); },
    mineTo: async (_url, when) => { calls.push(['mine', when]); },
    recipe: async (_chain, action, box) => { calls.push(['recipe', action, box]); },
    readLocalBox: async (_chain, box) => state(box),
    callLocal: async (_chain, contract, to, method, args, from) => { calls.push([contract, to, method, args, from]); },
  };
  return { chain, calls, actions };
}

test('M3 life graduates both boxes, picks before item trades, syncs credits and leaves browser claims untouched', async () => {
  const { chain, calls, actions } = life();
  await runLocalLife(chain, { browser: true }, actions);
  for (const box of ['plain', 'shop', 'everyItem', 'coinPile']) {
    assert(calls.some(c => c[1] === box && c[2] === 'graduate'), `${box} graduates`);
  }
  const pick = calls.findIndex(c => c[0] === 'recipe' && c[1] === 4 && c[2] === 'everyItem');
  const trade = calls.findIndex((c, i) => i > pick && c[0] === 'recipe' && c[1] === 1 && c[2] === 'everyItem');
  const collect = calls.findIndex(c => c[1] === 'everyItem-receiver' && c[2] === 'collect');
  const graduate = calls.findIndex(c => c[1] === 'everyItem' && c[2] === 'graduate');
  assert(collect >= 0 && collect < graduate, 'held item fees are funded before graduation');
  const sync = calls.findIndex(c => c[1] === 'everyItem-ledger' && c[2] === 'sync');
  assert(pick >= 0 && trade > pick && sync > trade, 'real outside ownership precedes the fee receipt and sync');
  assert(!calls.some(c => ['claim', 'redeem'].includes(c[2])), 'browser retains all claim/redemption rights');
});

test('LOCAL-COINS: the USDC box gets three real trade recipes and graduates before the long failure wait', async () => {
  const { chain, calls, actions } = life();
  await runLocalLife(chain, { browser: true }, actions);
  const trades = calls.filter(c => c[0] === 'recipe' && c[1] === 1 && c[2] === 'usdc');
  assert.equal(trades.length, 3);
  const graduate = calls.findIndex(c => c[1] === 'usdc' && c[2] === 'graduate');
  const fail = calls.findIndex(c => c[1] === 'failure' && c[2] === 'fail');
  assert(graduate >= 0 && graduate < fail, 'USDC stays live when the demo advances through failure and sweep');
});

test('LOCAL-COINS-B: stock and gold trade and graduate before the failure time advance', async () => {
  const { chain, calls, actions } = life();
  await runLocalLife(chain, { browser: true }, actions);
  const fail = calls.findIndex(c => c[1] === 'failure' && c[2] === 'fail');
  for (const box of ['stock', 'gold']) {
    const collect = calls.findIndex(c => c[1] === `${box}-receiver` && c[2] === 'collect');
    const fill = calls.findIndex(c => c[0] === 'recipe' && c[1] === 2 && c[2] === box);
    const graduate = calls.findIndex(c => c[1] === box && c[2] === 'graduate');
    const trades = calls.flatMap((c, i) => c[0] === 'recipe' && c[1] === 1 && c[2] === box ? [i] : []);
    assert.equal(trades.filter(i => i < fill).length, 3, `${box} trades on the curve`);
    assert(collect >= 0 && fill > collect && graduate > fill && graduate < fail, `${box} life order`);
    // F137: a graduated sale whose T fee the public sellFees step sells, then a collection books the sellers' P.
    const sold = calls.findIndex((c, i) => i > graduate && c[1] === `${box}-hook` && c[2] === 'sellFees');
    const booked = calls.findIndex((c, i) => i > sold && c[1] === `${box}-receiver` && c[2] === 'collect');
    assert(trades.some(i => i > graduate && i < sold) && booked > sold && booked < fail, `${box} sells a graduated sale fee`);
  }
});

test('a reverted M3 stage stops the life immediately instead of fabricating later checkpoints', async () => {
  const { chain, calls, actions } = life();
  actions.recipe = async (_chain, action, box) => {
    calls.push(['recipe', action, box]);
    if (box === 'everyItem' && action === 4) throw new Error('withdraw reverted');
  };
  await assert.rejects(runLocalLife(chain, { browser: true }, actions), /withdraw reverted/);
  assert(!calls.some(c => c[0] === 'checkpoint' && c[1] === 'claim-ready'));
});
