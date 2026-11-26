import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupJunkyard } from './core-v2-local-junkyard.mjs';
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const chain = { factory: address(1), accounts: { deployer: address(2), actor: address(3), backup: address(4) } };
const keys = ['junkyardGold', 'junkyardSafe', 'scrap0', 'scrap1', 'scrap2', 'scrap3', 'scrap4', 'junkyardUnlisted'];
const output = keys.map((key, i) => `LOCALV2|${key}|${address(i + 10)}`).join('\n') + '\nJUNKYARD_LISTING|8';
test('local setup exposes Test Gold, Safe, five Test Junk bindings and a separate unlisted collection', async () => {
  const calls = [];
  const result = await setupJunkyard(chain, async (...args) => { calls.push(args); return output; });
  assert.equal(result.listingId, '8'); assert.equal(result.gold, address(10)); assert.equal(result.safe, address(11));
  assert.deepEqual(result.collections, Object.fromEntries(['bent-cans', 'lost-cogs', 'split-boots', 'cracked-mugs', 'tangled-wires'].map((key, i) => [key, address(i + 12)])));
  assert.equal(result.unlistedCollection, address(17));
  assert.deepEqual(result.items.starter, ['1', '2']);
  assert.deepEqual(calls[0].slice(2, 5), ['runLocal(address,address,address)', [chain.factory, chain.accounts.actor, chain.accounts.backup], chain.accounts.deployer]);
  assert.match(calls[0][1], /JunkyardLocalSetup$/);
});
test('incomplete or aliased local fixtures fail before creating a Junkyard', async () => {
  await assert.rejects(setupJunkyard(chain, async () => output.replace('LOCALV2|scrap4', 'omitted')), /fixture/);
  await assert.rejects(setupJunkyard(chain, async () => output.replace(address(16), address(15))), /distinct/);
  await assert.rejects(setupJunkyard(chain, async () => output.replace('LOCALV2|junkyardUnlisted', 'omitted')), /fixture/);
  await assert.rejects(setupJunkyard(chain, async () => output.replace(address(17), address(16))), /distinct/);
  await assert.rejects(setupJunkyard(chain, async () => output.replace('JUNKYARD_LISTING|8', '')), /listing/);
});
