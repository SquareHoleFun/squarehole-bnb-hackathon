// SH-261: the BNB Chain testnet (chain 97) demo boxes' settings and read-back rules (packages/chain/scripts/bnb-boxes).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliArgs, buildKit } from '../kits/settings.mjs';
import { KIT_TEXT, KIT_TEXT_BNB } from '../kits/catalog.mjs';
import { loadProfileExamples } from '../../packages/box-spec/examples/v2/registry.mjs';
import { bindingsFor, writeBnbSettings } from '../../packages/chain/scripts/bnb-boxes/settings.mjs';
import { expectedSpec, feeChoiceOf, sheetSpec } from '../../packages/chain/scripts/bnb-boxes/readback.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The plain rehearsal's files (SH-260): a LOCAL chain's, with the same addresses the real run deploys at.
const EXTRAS_PATH = resolve(ROOT, 'hackathon/rehearsals/plain-97/bnb-testnet/97-extras.json');
const EXTRAS = JSON.parse(readFileSync(EXTRAS_PATH, 'utf8'));
const STOCK_SETTINGS = resolve(ROOT, 'examples/boxes/gpu-poor/settings/bnb/gpu-poor-boxspec-v2.json');
const stockRow = () => loadProfileExamples('bnb').find(e => e.id === 'gpu-poor');

test('the stock box binds to chain 97\'s tNVDA listing from the extras file, nothing typed by hand', () => {
  const tnvda = EXTRAS.listings.find(l => l.symbol === 'tNVDA');
  assert.deepEqual(bindingsFor(stockRow(), EXTRAS), {
    priceListing: { id: String(tnvda.id), token: tnvda.token, raise: tnvda.raise },
    nativeRaise: EXTRAS.listings.find(l => l.id === 0).raise,
    assets: { TEST_USDC: EXTRAS.coins.tUSDC.address, TEST_NVDA: EXTRAS.coins.tNVDA.address, TEST_GOLD: EXTRAS.coins.tGOLD.address, TEST_PEPE: EXTRAS.coins.tPEPE.address },
  });
  assert.equal(tnvda.id, 2);
  assert.throws(() => bindingsFor(stockRow(), { ...EXTRAS, chainId: 11155111 }), /chain 97/);
  assert.throws(() => bindingsFor(stockRow(), { ...EXTRAS, listings: EXTRAS.listings.filter(l => l.symbol !== 'tNVDA') }), /lists no tNVDA/);
  assert.throws(() => bindingsFor({ ...stockRow(), priceCoin: { symbol: 'LINK', decimals: '18' } }, EXTRAS), /no chain-97 stand-in/);
});

test('the committed stock box settings are the kit tool\'s bytes, holders paid in tNVDA on both sides', async () => {
  mkdirSync(join(ROOT, '.cache/tmp'), { recursive: true });
  const out = join(mkdtempSync(join(ROOT, '.cache/tmp/bnb-settings-')), 'gpu-poor.json');
  await writeBnbSettings('gpu-poor', EXTRAS_PATH, out);
  assert.equal(readFileSync(out, 'utf8'), readFileSync(STOCK_SETTINGS, 'utf8'), 'regenerate with packages/chain/scripts/bnb-boxes/settings.mjs');
  const spec = sheetSpec(readFileSync(STOCK_SETTINGS, 'utf8'));
  const tnvda = EXTRAS.listings.find(l => l.symbol === 'tNVDA');
  assert.deepEqual([spec.tokenName, spec.tokenSymbol, spec.boxType], ['GPU Poor', 'VRAM', 3]);
  assert.equal(spec.pricing.listingId, tnvda.id);
  assert.equal(spec.pricing.token.toLowerCase(), tnvda.token);
  assert.equal(spec.raise, BigInt(tnvda.raise));
  assert.equal(spec.deadlineDays, 30);
  assert.equal(spec.creatorBuy, 0n);
  for (const side of [spec.buyers, spec.sellers]) {
    // AsPaid (1) to Holders (6), paid in the price coin (holders currency P = 1): FeeChoice.Holders.
    assert.deepEqual([side.a.leg, side.a.dest, BigInt(side.a.destParams)], [1, 6, 1n]);
    assert.equal(feeChoiceOf(side), 4);
  }
  assert.equal(spec.description, KIT_TEXT_BNB['gpu-poor']);
});

test('the kit tool takes a profile; Sepolia\'s answers and texts are unchanged', async () => {
  assert.deepEqual(cliArgs(['rent-free']), { ids: ['rent-free'], bindings: {} });
  assert.deepEqual(cliArgs(['gpu-poor', '--profile', 'bnb']), { ids: ['gpu-poor'], bindings: {}, profile: 'bnb' });
  assert.deepEqual(cliArgs(['all', '--profile', 'bnb']).ids, Object.keys(KIT_TEXT_BNB));
  assert.throws(() => cliArgs(['gpu-poor', '--profile', 'mainnet']), /supported profile/);
  assert.throws(() => cliArgs(['gpu-poor', '--profile']), /usage/);
  await assert.rejects(buildKit('junkyard', {}, { profile: 'bnb' }), /not built for profile bnb/);
  assert.match(KIT_TEXT['gpu-poor'], /burns VRAM/);
  assert.doesNotMatch(KIT_TEXT_BNB['gpu-poor'], /burn|Sepolia/i);
});

test('the read-back fills only the creator\'s own fields and maps fee sides as the factory does', () => {
  const spec = sheetSpec(readFileSync(STOCK_SETTINGS, 'utf8'));
  const creator = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  // A token box names no owner or payee: nothing changes.
  assert.deepEqual(expectedSpec(spec, creator), spec);
  const owned = expectedSpec({ ...spec, marketplaceOwner: '0x0000000000000000000000000000000000000001' }, creator);
  assert.equal(owned.marketplaceOwner, creator);
  assert.equal(owned.creatorFeeRecipient, spec.creatorFeeRecipient);
  const side = (leg, dest) => ({ a: { leg, dest } });
  // BoxFactoryV2Parts.sol `_choice`: Keep 1, Burn 2, Grow 3, Holders 4, Items 5, EatPriceCoin 6, HoldersT 7, ItemsT 8, Pile 9, Module 10, ShopT 11.
  assert.deepEqual([side(1, 2), side(2, 1), side(1, 4), side(1, 6), side(1, 8), side(1, 1), side(2, 6), side(2, 8), side(1, 7), side(1, 9), side(2, 7)].map(feeChoiceOf),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('a loopback node is asked directly: never a public endpoint, and not at all once its process is gone', async () => {
  const chain = await import('../../packages/chain/scripts/bnb-boxes/chain.mjs');
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => { asked.push(String(url)); throw new Error('connection refused'); };
  try {
    chain.setReadEndpoints(['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet-dataseed.bnbchain.org']);
    // A failed request to a local node (a send, an impersonation, a clock move, a fork read) is not retried elsewhere.
    await assert.rejects(chain.rpc('http://127.0.0.1:1', 'eth_sendTransaction', [{}]), /connection refused/);
    assert.deepEqual(asked, ['http://127.0.0.1:1']);
    // A node this process started whose process has exited is not asked at all.
    chain.registerLocalNode('http://127.0.0.1:2', { exitCode: 1, signalCode: null });
    await assert.rejects(chain.rpc('http://127.0.0.1:2', 'eth_chainId'), /is gone/);
    assert.deepEqual(asked, ['http://127.0.0.1:1']);
    // An endpoint of the --rpc list (however it is spelled) fails over within that list only.
    asked.length = 0;
    chain.setReadEndpoints(['http://127.0.0.1:3', 'http://127.0.0.1:4']);
    globalThis.fetch = async url => { asked.push(String(url)); return String(url).includes(':3') ? new Response('Rate limit exceeded', { status: 429 }) : new Response('{"jsonrpc":"2.0","id":1,"result":"0x61"}'); };
    assert.equal(await chain.rpc('http://127.0.0.1:3/', 'eth_chainId'), '0x61');
    assert.deepEqual(asked, ['http://127.0.0.1:3/', 'http://127.0.0.1:4']);
  } finally {
    globalThis.fetch = realFetch;
    chain.setReadEndpoints([]);
  }
});

test('a kept transaction is replayed only for the same call', async () => {
  const chain = await import('../../packages/chain/scripts/bnb-boxes/chain.mjs');
  const slot = { from: '0x0000000000000000000000000000000000000001', to: '0x0000000000000000000000000000000000000002', data: '0x1234', value: 0n, nonce: 7n, hash: null };
  const store = { save: () => undefined };
  for (const other of [{ ...slot, data: '0x1235' }, { ...slot, from: '0x0000000000000000000000000000000000000003' }, { ...slot, value: 1n }, { ...slot, to: '0x0000000000000000000000000000000000000004' }]) {
    await assert.rejects(chain.reconcile({ store, slot, tx: other, client: null, sender: null }), /another call/);
  }
});
