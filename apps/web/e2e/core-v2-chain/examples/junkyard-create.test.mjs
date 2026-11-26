import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import * as viem from 'viem';
import { prepareExample } from '../../../../../packages/chain/scripts/create-example-v2.mjs';
import { setupJunkyard } from '../../../../../packages/chain/scripts/lib/core-v2-local-junkyard.mjs';
import { loadExamples } from '../../../../../packages/box-spec/examples/v2/registry.mjs';
import { factoryV2Abi, holderLedgerV2Abi, shopVaultV2Abi, starterSetLoaderV2Abi } from '../../../../../packages/chain/src/core/v2/abi-v2.ts';

const example = loadExamples().find(e => e.id === 'junkyard');
const addr = n => viem.toHex(BigInt(n), { size: 20 });
const chain = { chainId: 11155111, factory: addr(1), accounts: { actor: addr(2), deployer: addr(3), backup: addr(4) } };
// The reviewer's offline reproduction: exercise the real adapter with Forge's output protocol.
// Never replace its result with a hand-built collection map or a prepared plan.
const fixtureKeys = ['junkyardGold', 'junkyardSafe', 'scrap0', 'scrap1', 'scrap2', 'scrap3', 'scrap4', 'junkyardUnlisted'];
const fixtureOutput = fixtureKeys.map((key, i) => `LOCALV2|${key}|${addr(10 + i)}`).join('\n') + '\nJUNKYARD_LISTING|8';
chain.junkyard = await setupJunkyard(chain, async () => fixtureOutput);
const fixtureSource = readFileSync(new URL('../../../../../packages/chain/scripts/solidity/JunkyardLocal.s.sol', import.meta.url), 'utf8');
const fixtureRaise = fixtureSource.match(/uint256 raise = ([0-9]+);/)?.[1];
const box = { coordinator: addr(20), vault: addr(21), token: addr(22), holderLedger: addr(23), receiver: addr(24) };
const abi = { LocalERC20: viem.erc20Abi, BoxTokenV2: viem.erc20Abi, JunkyardCollection: viem.erc721Abi,
  ShopVaultV2: shopVaultV2Abi, HolderLedgerV2: holderLedgerV2Abi, StarterSetLoaderV2: starterSetLoaderV2Abi };
const equal = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());
async function harness(corrupt) {
  const bootstrapQ = 356550297290034n;
  const listing = { id: 8, token: chain.junkyard.gold, decimals: 18, class: 5, kind: 1, raise: BigInt(fixtureRaise) };
  const client = {
    getChainId: async () => chain.chainId, getBlockNumber: async () => 42n, getCode: async () => '0x1234',
    readContract: async ({ functionName, args, blockNumber }) => {
      assert.equal(blockNumber, 42n);
      if (functionName === 'listingRegistry') return addr(30);
      if (functionName === 'listing') return args[0] === 0 ? { ...listing, id: 0, token: viem.zeroAddress, raise: 4206980085000000000n } : listing;
      // Read the fixture's actual metadata so changing only the adapter cannot hide the symbol mismatch.
      if (functionName === 'symbol') return fixtureSource.match(/string public constant symbol = "([^"]+)";/)[1];
      if (functionName === 'boxQParameters') return { bootstrapQ };
      if (functionName === 'tokenAddressLimit') return addr(1000);
      if (functionName === 'predictBox') return [box.coordinator, box.token, viem.zeroHash];
      throw new Error(`unexpected preparation read ${functionName}`);
    },
  };
  const prepare = (recipe, inputs, options) => prepareExample(recipe, inputs, { ...options, client });
  const plan = await prepare(example, { creator: chain.junkyard.safe, factory: chain.factory, listingId: chain.junkyard.listingId,
    collections: chain.junkyard.collections }, { chainId: String(chain.chainId) });
  const { spec, starter } = plan;
  const seed = BigInt(example.contents.shop.seedT), payment = spec.creatorBuy + bootstrapQ;
  const calls = []; let funded = false, loaded = false, complete = false, created = false, gold = 10n ** 20n, credit = 900719925474099312345n;
  const read = async (_chain, _name, _address, fn) => {
    if (fn === 'specHash') return plan.specHash;
    if (fn === 'creator') return corrupt === 'creator' ? chain.accounts.actor : chain.junkyard.safe;
    if (fn === 'boxQParameters') return { bootstrapQ };
    if (fn === 'balanceOf') return 180195814884384475344482735n - (funded ? seed : 0n);
    if (fn === 'starterSetLoader') return addr(25);
    if (fn === 'budgetT') return funded ? seed : 0n;
    if (fn === 'progress') return [starter.length, viem.zeroHash, complete];
    if (fn === 'ownerOf') return corrupt === 'custody' ? chain.accounts.actor : box.vault;
    if (fn === 'claimable') return credit;
    throw new Error(`unexpected ${fn}`);
  };
  const call = async (_chain, name, target, fn, args, from) => {
    calls.push([name, fn, args, from]);
    if (name === 'StarterSetLoaderV2') { assert.equal(fn, 'complete'); assert.ok(loaded && funded); complete = true; return; }
    assert.equal(name, 'JunkyardSafeDouble'); assert.equal(fn, 'execute'); equal(from, chain.accounts.actor); equal(target, chain.junkyard.safe);
    const [to, value, data] = args; assert.equal(value, 0n);
    const decoded = viem.decodeFunctionData({ abi: [...factoryV2Abi, ...viem.erc20Abi, ...viem.erc721Abi, ...holderLedgerV2Abi, ...shopVaultV2Abi, ...starterSetLoaderV2Abi], data });
    if (decoded.functionName === 'createBox') { equal(to, chain.factory); created = true; gold -= payment; }
    if (decoded.functionName === 'register') assert.ok(created);
    if (decoded.functionName === 'load') { assert.deepEqual(decoded.args[1], starter.map(i => i.id)); assert.equal(decoded.args[3], viem.zeroHash); loaded = true; }
    if (decoded.functionName === 'fundSeed') funded = true;
    if (decoded.functionName === 'claim') { gold += credit; credit = 0n; }
    return { transactionHash: '0x01' };
  };
  const bindings = {
    'node:assert/strict': { default: assert }, 'node:fs': { readFileSync }, 'node:url': await import('node:url'), viem,
    '../../../../../packages/chain/scripts/create-example-v2.mjs': { prepareExample: prepare },
    '../../../../../packages/chain/scripts/local-core-v2-chain.mjs': { localClient: () => ({}), readLocalBox: async () => ({ ...box, gateOpen: complete }) },
    '../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs': { writeExampleArt: () => [] },
    './chain.mjs': { read, call, balance: async () => gold, artifact: name => ({ abi: abi[name] }) },
    './create.mjs': { loadExampleChunks: async (_chain, _spec, coordinator, creator) => { equal(coordinator, box.coordinator); equal(creator, chain.junkyard.safe); } },
    './support.mjs': { ROOT: new URL('../../../../../', import.meta.url), EXAMPLE_ART: new URL('../../../../../.cache/junkyard-art-test/', import.meta.url) },
  };
  const module = new SourceTextModule(readFileSync(new URL('./junkyard-create.mjs', import.meta.url), 'utf8'));
  await module.link(name => {
    assert.ok(bindings[name], `unexpected import ${name}`);
    const values = bindings[name]; return new SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); });
  });
  await module.evaluate();
  const click = { click: async () => {} }; const page = { goto: async () => {}, getByRole: () => ({ locator: () => click, getByRole: () => click }) };
  return { module: module.namespace, calls, page, box: { ...box, p: chain.junkyard.gold }, credit, plan };
}

test('actual setupJunkyard bindings prepare the registry row with the migrated fixture economics', async () => {
  const { plan } = await harness();
  assert.equal(fixtureRaise, example.raise.amount, 'local listing must use the registry raise, independent of native pricing');
  assert.match(fixtureSource, /uint8 public constant decimals = 18;/);
  assert.equal(plan.spec.raise, BigInt(fixtureRaise));
  assert.equal(plan.spec.creatorBuy, 71278844301225191n);
  assert.equal(plan.approval.amount, '71635394598515225');
  assert.equal(plan.transaction.from, chain.junkyard.safe);
  assert.deepEqual(plan.starter.map(({ collection, id, tier }) => ({ collection, id, tier })),
    Object.values(chain.junkyard.collections).flatMap(collection => [1n, 2n].map(id => ({ collection, id, tier: 0 }))));
  assert.equal(plan.starter.length, 10);
});

test('creation executes as the Safe, registers it, loads and funds before completing, and clears approvals', async () => {
  const h = await harness(); const evidence = {};
  const result = await h.module.createJunkyard(h.page, chain, example, { requests: [] }, evidence);
  assert.equal(result.gateOpen, true); assert.equal(evidence.creation.starterCount, 10);
  const clear = h.calls.at(-1)[2][2];
  assert.deepEqual(viem.decodeFunctionData({ abi: viem.erc20Abi, data: clear }).args, [box.vault, 0n]);
});
for (const corrupt of ['creator', 'custody']) test(`creation refuses mismatched ${corrupt} evidence`, async () => {
  const h = await harness(corrupt); await assert.rejects(h.module.createJunkyard(h.page, chain, example, { requests: [] }, {}));
});
test('Safe claims its own precise gold credit only through an owner-authorized execute call', async () => {
  const h = await harness(); const evidence = {};
  await h.module.claimSafeGold(chain, h.box, 1n, evidence);
  assert.equal(evidence.safeHolderClaim.quote, h.credit);
  assert.equal(h.calls.length, 1); equal(h.calls[0][3], chain.accounts.actor);
});
