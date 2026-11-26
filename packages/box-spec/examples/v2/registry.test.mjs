import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { contractReady, loadExamples, loadProfileExamples, validateExample, jsonSchema, ROOT, SITE_STEPS, KIT_STEPS } from './registry.mjs';

const EXISTING = ['bag-holders', 'dragons-hoard', 'exit-liquidity', 'gas-guzzlers', 'gpu-poor', 'gpu-poor-miners', 'junkyard', 'link-marines', 'one-collection-shop', 'one-dollar', 'rent-free', 'rug-rugs', 'staking-snails'];

const READY = [...EXISTING, 'frog-kiln', 'paper-certificates', 'link-marines-v2'].sort();

test('versioned kit ids retain own-art validation and Items accepts Depth on either side', () => {
  const example = structuredClone(loadExamples().find(e => e.id === 'bag-holders'));
  example.id = 'link-marines-v2';
  example.logo = 'examples/boxes/link-marines-v2/art/logo.png';
  example.contents.art.source = 'examples/boxes/link-marines-v2/art/cover.png';
  example.fees = { buyers: { choice: 'items', inside: 'depth' }, sellers: { choice: 'items', inside: 'depth' } };
  assert.equal(validateExample(example), example);
  example.fees.sellers.choice = 'items-t';
  assert.equal(validateExample(example), example);
  const bad = mutate => { const row = structuredClone(example); mutate(row); assert.throws(() => validateExample(row)); };
  bad(e => { e.logo = 'examples/boxes/link-marines/art/logo.png'; });
  bad(e => { e.logo = 'examples/boxes/link-marines-v2/../link-marines/art/logo.png'; });
  bad(e => { e.id = 'link-marines-v2/other'; });
  bad(e => { e.fees.buyers.inside = 'pool'; });
  bad(e => { e.fees.buyers.choice = 'grow'; });
});

test('the Shop template accepts its label and rejects a mismatched label', () => {
  const example = loadExamples().find(e => e.id === 'one-collection-shop');
  example.template = { id: 'shop', name: 'Shop' };
  assert.equal(validateExample(example), example);
  example.template.name = 'To holders';
  assert.throws(() => validateExample(example), /template id\/name disagree/);
  assert.ok(jsonSchema.properties.template.properties.id.enum.includes('shop'));
  const committed = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url)));
  assert.ok(committed.properties.template.properties.id.enum.includes('shop'));
});

test('the shop rows use the Shop template and no other row does', () => {
  const examples = loadExamples();
  const shops = examples.filter(e => e.contents.kind === 'shop');
  assert.deepEqual(shops.map(e => e.id), ['card-shop', 'junkyard', 'one-collection-shop']); // SH-262 adds the card shop
  for (const e of shops) assert.deepEqual(e.template, { id: 'shop', name: 'Shop' }, e.id);
  assert.deepEqual(examples.filter(e => e.template.id === 'shop').map(e => e.id), shops.map(e => e.id));
});

test('registry has sixteen example lives; chain prerequisites stay pending', () => {
  const examples = loadExamples();
  // FE12: the create flow offers To the pile and the 5% leave-behind, eating the price coin and payouts in the box
  // token, so Dragon's Hoard, Link Marines and GPU Poor Miners run in the browser too.
  assert.deepEqual(examples.filter(e => e.status === 'ready').map(e => e.id).sort(), READY);
  // Both hidden kits and Link Marines v2 have their lives (SH-EX-LMV2); the Alchemist waits on its chain prerequisite,
  // and Lake House (SH-LAKE-HOUSE) on EXAMPLE-LIFE, the step for a kit whose lives are not written yet.
  assert.deepEqual(KIT_STEPS, ['EXAMPLE-LIFE']);
  assert.deepEqual(Object.fromEntries(examples.filter(e => e.status === 'pending').map(e => [e.id, e.pendingStep])),
    { 'card-shop': 'EXAMPLE-LIFE', 'lake-house': 'EXAMPLE-LIFE', 'the-alchemist': 'ALCHEMIST-REGISTRATION' });
  assert.ok(examples.filter(e => e.status === 'pending').every(e => !contractReady(e)), 'a kit row never runs a life it does not have');

  for (const e of examples) {
    assert.equal(validateExample(e), e);
    for (const file of [e.logo, e.contents.art.source]) if (file) assert.ok(existsSync(resolve(ROOT, file)), `${e.id}: ${file}`);
  }
});

test('The Alchemist pins test stand-ins, an empty gold pile and its chain gate', () => {
  const e = loadExamples().find(e => e.id === 'the-alchemist');
  assert.ok(e, 'The Alchemist recipe must exist');
  assert.deepEqual([e.name, e.ticker, e.template], ['The Alchemist', 'LEAD', { id: 'pile', name: 'Coin pile' }]);
  assert.deepEqual(e.priceCoin, { symbol: 'TEST_PEPE', decimals: '18' });
  assert.deepEqual(e.contents.seed, { symbol: 'TEST_GOLD', amount: '0' });
  assert.equal(e.contents.kind, 'pile');
  assert.equal(e.contents.leaveBehindBps, '500');
  assert.deepEqual(e.fees, { buyers: { choice: 'alchemist' }, sellers: { choice: 'burn' } });
  assert.equal(e.raise.amount, null, 'TA-30 listing raise is unresolved, never a made-up quote');
  assert.equal(e.status, 'pending');
  assert.equal(e.pendingStep, 'ALCHEMIST-REGISTRATION');
  assert.match(e.pendingReason, /TA-30/);
  assert.match(e.pendingReason, /directory/i);
  assert.match(e.pendingReason, /lives/i);
  assert.equal(contractReady(e), false);
  assert.ok(e.properties.includes('pile-pro-rata'));
  assert.equal(e.logo, 'examples/boxes/the-alchemist/art/logo.png');
});

test('Alchemist recipes cannot bypass chain registration or use an incompatible pile', () => {
  const original = loadExamples().find(e => e.id === 'the-alchemist');
  assert.ok(original, 'The Alchemist recipe must exist');
  const bad = (mutate, reason) => {
    const e = structuredClone(original); mutate(e);
    assert.throws(() => validateExample(e), reason);
  };
  bad(e => { e.status = 'ready'; delete e.pendingStep; delete e.pendingReason; e.raise.amount = '1000000'; }, /Alchemist requires/);
  bad(e => { e.pendingStep = 'FE12'; }, /Alchemist requires/);
  bad(e => { e.pendingStep = 'EXAMPLE-LIFE'; }, /Alchemist requires/);
  bad(e => { e.contents.kind = 'token'; e.contents.seed = null; delete e.contents.leaveBehindBps; }, /Alchemist requires/);
  bad(e => { e.contents.seed.symbol = e.priceCoin.symbol; }, /Alchemist requires/);
  bad(e => { e.fees.buyers.choice = 'pile'; }, /registration step requires Alchemist/);
  bad(e => { e.fees.sellers.choice = 'pile'; }, /pile fees require the price coin pile/);
  bad(e => { e.properties = e.properties.filter(p => p !== 'pile-pro-rata'); }, /pile-pro-rata/);
  bad(e => { e.contents.seed.amount = (1n << 256n).toString(); }, /seed/);
  bad(e => { e.contents.seed.amount = 0; });
  const funded = structuredClone(original);
  funded.contents.seed.amount = '1000000000000000000';
  funded.raise.amount = '1000000';
  assert.equal(validateExample(funded), funded, 'reviewed raw amounts can be supplied while registration stays pending');
  for (const id of ['dragons-hoard', 'frog-kiln']) {
    const e = loadExamples().find(e => e.id === id);
    e.raise.amount = null;
    assert.throws(() => validateExample(e), /unresolved raise/);
  }
  const hoard = loadExamples().find(e => e.id === 'dragons-hoard');
  hoard.contents.seed.amount = '0';
  assert.throws(() => validateExample(hoard), /seed/, 'ordinary pile seed rule stays unchanged');
});

test('ticket recipes, quantities and deliberately different fee sides remain explicit', () => {
  const byId = Object.fromEntries(loadExamples().map(e => [e.id, e]));
  assert.equal(byId['exit-liquidity'].fees.buyers.choice, 'grow');
  assert.deepEqual(byId['exit-liquidity'].fees.sellers, { choice: 'items', inside: 'burn' });
  assert.equal(byId['gas-guzzlers'].contents.size, '100');
  assert.equal(byId['gas-guzzlers'].royalties.destination, 'fees');
  assert.equal(byId['rent-free'].contents.size, '500');
  assert.equal(byId['bag-holders'].contents.size, '420');
  assert.equal(byId['bag-holders'].priceCoin.symbol, 'LINK');
  assert.deepEqual(byId['one-dollar'].contents.seed, { symbol: 'USDC', amount: '1000000' });
  // One Dollar's ticker is 1 and GPU Poor's VRAM; the archival Link Marines v1 retains MARINE and Eat.
  assert.deepEqual([byId['one-dollar'].name, byId['one-dollar'].ticker], ['One Dollar is all you need', '1']);
  assert.deepEqual([byId['gpu-poor'].ticker, byId['gpu-poor'].priceCoin.symbol], ['VRAM', 'NVDAon']);
  assert.deepEqual([byId['link-marines'].ticker, byId['link-marines'].fees], ['MARINE', { buyers: { choice: 'eat' }, sellers: { choice: 'eat' } }]);
  assert.deepEqual([byId['frog-kiln'].fees, byId['frog-kiln'].priceCoin.symbol], [{ buyers: { choice: 'eat' }, sellers: { choice: 'items-t', inside: 'burn' } }, 'TEST_FROG']);
  assert.deepEqual([byId['paper-certificates'].fees, byId['paper-certificates'].priceCoin.symbol], [{ buyers: { choice: 'burn' }, sellers: { choice: 'items-t', inside: 'burn' } }, 'TEST_GOLD']);
  assert.equal(byId['rug-rugs'].life, 'failure');
});

test('invalid data cannot silently become an executable example', () => {
  const good = loadExamples().find(e => e.id === 'gas-guzzlers');
  const bad = mutate => { const e = structuredClone(good); mutate(e); assert.throws(() => validateExample(e)); };
  bad(e => { e.raise.amount = 4206980085000000000; });
  bad(e => { e.raise.amount = '4.2'; });
  bad(e => { e.raise.amount = '-1'; });
  bad(e => { e.raise.amount = '01'; });
  bad(e => { e.raise.amount = '0'; });
  bad(e => { e.raise.amount = (1n << 256n).toString(); });
  bad(e => { e.template.id = 'made-up'; });
  bad(e => { e.status = 'pending'; });
  bad(e => { e.pendingStep = 'V21-02'; });
  bad(e => { e.properties = ['looks-fine']; });
  bad(e => { e.properties = []; });
  bad(e => { e.properties = e.properties.filter(id => id !== 'own-pictures'); }); // every box must be shown with its own pictures
  bad(e => { e.contents.size = '0'; });
  bad(e => { e.contents.art.source = '../elsewhere.png'; });
  bad(e => { e.fees.buyers = { choice: 'keep', inside: 'burn' }; });
  bad(e => { e.royalties.bps = '10001'; });
  for (const destination of ['creator', 'pool']) bad(e => { e.royalties.destination = destination; });
  bad(e => { e.accidental = 'unreviewed'; });
});

test('each runnable box has pictures no other runnable box has, so own-pictures can only pass with its own', () => {
  const ready = loadExamples().filter(e => e.status === 'ready');
  const files = [...ready.map(e => e.logo), ...ready.filter(e => e.contents.kind === 'collection').map(e => e.contents.art.source)];
  const digest = file => createHash('sha256').update(readFileSync(resolve(ROOT, file))).digest('hex');
  assert.equal(new Set(files.map(digest)).size, files.length, 'every logo and collection cover is a distinct picture');
});

test('the v2.1 recipes are the real ones: pile fees with 5%, eating LINK, items paid in the box token', () => {
  const examples = loadExamples();
  assert.deepEqual(SITE_STEPS, ['FE12']);
  // The fourteen Solidity lives (ExampleLives.t.sol) and their replay cover these recipes; Junkyard has its own runner,
  // and the one-collection shop runs its life on the local chain only (SH-ONE-COLLECTION-SHOP).
  assert.deepEqual(examples.filter(contractReady).map(e => e.id).sort(), READY);
  const byId = Object.fromEntries(examples.map(e => [e.id, e]));
  assert.equal(byId['dragons-hoard'].fees.buyers.choice, 'pile'); assert.equal(byId['dragons-hoard'].contents.leaveBehindBps, '500');
  assert.deepEqual(byId['link-marines'].fees, { buyers: { choice: 'eat' }, sellers: { choice: 'eat' } });
  assert.equal(byId['link-marines'].priceCoin.symbol, 'LINK'); assert.ok(byId['link-marines'].properties.includes('price-coin-eaten'));
  assert.deepEqual(byId['gpu-poor-miners'].fees, { buyers: { choice: 'items-t', inside: 'keep' }, sellers: { choice: 'items-t', inside: 'keep' } });
  assert.ok(byId['gpu-poor-miners'].properties.includes('item-claim'));
  const bad = (id, mutate) => { const e = structuredClone(byId[id]); mutate(e); assert.throws(() => validateExample(e)); };
  bad('link-marines', e => { e.properties = e.properties.filter(p => p !== 'price-coin-eaten'); });
  bad('gpu-poor', e => { e.properties.push('price-coin-eaten'); });
  bad('gpu-poor-miners', e => { delete e.fees.buyers.inside; });
});

test('Junkyard pins J1-J5, claim-only gold, Safe policy and named shop limits', () => {
  const e = loadExamples().find(e => e.id === 'junkyard');
  assert.ok(e, 'Junkyard must be runnable from the registry');
  assert.equal(e.contents.kind, 'shop');
  assert.equal(e.priceCoin.symbol, 'TEST_GOLD');
  assert.equal(e.ticker, 'TRASH');
  assert.equal(e.deadline.days, '30');
  assert.deepEqual(e.fees, { buyers: { choice: 'holders' }, sellers: { choice: 'shop', ceilingPreset: '2' } });
  assert.equal(e.creator.buyEthEquivalent, '300000000000000000');
  assert.equal(e.creator.humbleCap, undefined, 'R47E removes the humble cap');
  assert.equal(e.contents.shop.pickBps, '20000');
  assert.equal(e.contents.shop.weeklyBps, '1000');
  assert.equal(e.contents.shop.collectionBps, '250');
  assert.equal(e.contents.shop.listDelay, '604800');
  assert.equal(e.contents.shop.curator, 'creator');
  assert.equal(e.contents.shop.allowanceFloor, 'cheapest-active-give');
  assert.ok(e.properties.includes('shop-life'));
  const bad = mutate => { const copy = structuredClone(e); mutate(copy); assert.throws(() => validateExample(copy)); };
  bad(e => { e.contents.shop.seedT = 1000; });
  bad(e => { e.contents.shop.seedT = '0'; });
  bad(e => { e.contents.shop.givePricesT[1] = e.contents.shop.givePricesT[0]; });
  bad(e => { e.contents.shop.givePricesT[3] = (1n << 256n).toString(); });
  bad(e => { e.contents.shop.pickBps = '10000'; });
  bad(e => { e.contents.shop.collections[1].id = e.contents.shop.collections[0].id; });
  bad(e => { e.contents.shop.collections[0].tier = '4'; });
  bad(e => { e.contents.shop.collections[0].starterIds.push(e.contents.shop.collections[0].starterIds[0]); });
  bad(e => { e.contents.shop.collections.forEach(c => { c.starterIds = []; }); });
  bad(e => { e.contents.shop.collections[0].starterIds[0] = '01'; });
  bad(e => { e.contents.kind = 'token'; });
  bad(e => { e.fees.buyers.choice = 'pile'; });
  bad(e => { e.fees.buyers = { choice: 'shop', ceilingPreset: '2' }; });
  bad(e => { e.fees.sellers.ceilingPreset = '3'; });
});

test('one-collection shop: one TA-40 collection, no curator, a two-give seed and ten starters, priced in ETH', () => {
  const e = loadExamples().find(e => e.id === 'one-collection-shop');
  assert.ok(e, 'the one-collection shop must be runnable from the registry');
  assert.deepEqual([e.name, e.ticker, e.status, e.contents.kind, e.life], ['One-collection shop', 'SHOP', 'ready', 'shop', 'graduate']);
  // Sepolia has native ETH at listing 0: no stand-in, no price-coin binding.
  assert.deepEqual(e.priceCoin, { symbol: 'ETH', decimals: '18' });
  assert.equal(e.raise.amount, '4206980085000000000');
  const s = e.contents.shop;
  assert.equal(s.curator, 'none', 'a fixed list: ShopConfigV2.curator is zero');
  assert.equal(s.collections.length, 1);
  const [only] = s.collections;
  // TA-40's first Test Junk collection. Ids 1 and 2 are the Junkyard's starters, so this shop starts at 3.
  const junk = JSON.parse(readFileSync(resolve(ROOT, 'examples/boxes/junkyard/test-collections/catalog.json'), 'utf8'));
  assert.equal(only.id, 'bent-cans'); assert.ok(junk.collections.some(c => c.key === only.id));
  assert.equal(only.tier, '0');
  assert.deepEqual(only.starterIds, ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], 'the smallest full starter set, 10 items');
  // The creator seeds T worth exactly two sell-backs (F132's minimum); a pick costs 2x the sell-back.
  assert.equal(BigInt(s.seedT), 2n * BigInt(s.givePricesT[0]));
  assert.deepEqual(s.givePricesT, ['1', '2', '4', '8'].map(n => (BigInt(n) * 10n ** 24n).toString()));
  assert.deepEqual([s.pickBps, s.weeklyBps, s.collectionBps, s.listDelay], ['20000', '1000', '250', '604800']);
  assert.deepEqual(e.fees, { buyers: { choice: 'holders' }, sellers: { choice: 'shop', ceilingPreset: '2' } });
  assert.deepEqual(e.creator, { kind: 'safe', buyEthEquivalent: '10000000000000000', registerHolder: true });
  assert.equal(e.logo, 'examples/boxes/one-collection-shop/art/logo.png');
  const bad = mutate => { const copy = structuredClone(e); mutate(copy); assert.throws(() => validateExample(copy)); };
  bad(e => { e.contents.shop.curator = 'nobody'; });
  bad(e => { e.contents.shop.curator = '0x0000000000000000000000000000000000000000'; }); // a key, never an address
  bad(e => { e.contents.shop.seedT = (2n * BigInt(e.contents.shop.givePricesT[0]) - 1n).toString(); }); // one raw unit short
  bad(e => { e.contents.shop.collections[0].starterIds.pop(); }); // nine starters is not a full set
  bad(e => { e.contents.shop.collections = []; });
  bad(e => { delete e.creator; });
  const funded = structuredClone(e); funded.contents.shop.seedT = (2n * BigInt(e.contents.shop.givePricesT[0])).toString();
  assert.equal(validateExample(funded), funded, 'exactly two gives is enough');
  const curated = structuredClone(e); curated.contents.shop.curator = 'creator';
  assert.equal(validateExample(curated), curated, 'the curator stays a creator choice');
});

test('a ticker is 1 to 11 capitals or digits, inside what BoxSpecV2 takes, so the digit ticker 1 is valid', () => {
  // BoxSpecV2.sol checks tokenSymbol as 1 to 11 bytes of JSON text; the registry keeps to capitals and digits inside it.
  const good = loadExamples().find(e => e.id === 'gas-guzzlers');
  const withTicker = ticker => { const e = structuredClone(good); e.ticker = ticker; return e; };
  for (const ticker of ['1', '1A', 'A1', '42', 'GUZZLERSTKN', '12345678901']) assert.equal(validateExample(withTicker(ticker)).ticker, ticker);
  for (const ticker of ['', 'one', 'One', 'a1', 'GUZZLERSTOKE', '123456789012', '$' + '1', '1.', ' 1', '1 ', 'ÄB', 'A-B']) {
    assert.throws(() => validateExample(withTicker(ticker)), { name: 'ZodError' }, JSON.stringify(ticker));
  }
});

test('pictures come only from the shared local art or the row\'s own kit, never Square Hole\'s own art', () => {
  const examples = loadExamples();
  const byId = Object.fromEntries(examples.map(e => [e.id, e]));
  assert.equal(byId['link-marines'].logo, 'examples/boxes/link-marines/art/logo.png');
  for (const e of examples) for (const file of [e.logo, e.contents.art.source]) {
    if (!file) continue;
    assert.ok(!/misfit|fit-/i.test(file), `${e.id}: ${file} is Square Hole's own art`);
    if (file.startsWith('examples/')) assert.ok(file.startsWith(`examples/boxes/${e.id}/art/`), `${e.id}: ${file}`);
  }
  const good = byId['link-marines'];
  const bad = mutate => { const e = structuredClone(good); mutate(e); assert.throws(() => validateExample(e)); };
  bad(e => { e.logo = 'examples/boxes/bag-holders/art/logo.png'; }); // another kit's picture
  bad(e => { e.logo = 'examples/boxes/link-marines/art/items/variant-01.png'; }); // only the kit's top-level art
  bad(e => { e.logo = 'examples/boxes/link-marines/art/logo.svg'; });
  bad(e => { e.logo = 'examples/boxes/link-marines/../one-dollar/art/logo.png'; });
  bad(e => { e.logo = 'docs/design/misfits-v2/banner/final/misfits-banner-a-1600x400.png'; });
  bad(e => { e.logo = 'packages/chain/scripts/local-art/misfits-logo.png'; }); // Square Hole's own coin mark
  bad(e => { e.contents.art.source = 'packages/chain/scripts/local-art/misfits-cover.png'; });
  bad(e => { e.logo = 'packages/chain/scripts/local-art/Misfits-logo.png'; }); // a case-insensitive file system serves the same bytes
  bad(e => { e.logo = 'packages/chain/scripts/local-art/MISFITS-logo.png'; });
  bad(e => { e.contents.art.source = 'packages/chain/scripts/local-art/Misfits-cover.png'; });
  bad(e => { e.contents.art.source = 'examples/boxes/frog-kiln/art/cover.png'; });
});

test('the committed schema accepts hidden-kit test stand-ins in both asset fields', () => {
  const committed = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url)));
  const assets = {
    priceCoin: committed.properties.priceCoin.properties.symbol.enum,
    seed: committed.properties.contents.properties.seed.anyOf.find(branch => branch.type === 'object').properties.symbol.enum,
  };
  for (const symbol of ['TEST_FROG', 'TEST_GOLD']) {
    for (const [field, values] of Object.entries(assets)) assert.ok(values.includes(symbol), `${field} must accept ${symbol}`);
  }
});

test('the committed registry schema matches the runtime schema', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url))), jsonSchema);
});

test('launch kits use their own art and Junkyard uses the complete TA-40 starter set', () => {
  const ids = ['gpu-poor', 'one-dollar', 'rent-free', 'bag-holders', 'exit-liquidity', 'link-marines', 'link-marines-v2', 'frog-kiln', 'paper-certificates', 'dragons-hoard', 'junkyard', 'one-collection-shop', 'the-alchemist', 'lake-house'];
  for (const e of loadExamples().filter(e => ids.includes(e.id))) {
    // Junkyard's logo.png is 1 MB, past one raw block: its row uses the kit's own 256 px copy (examples/boxes/junkyard/check.mjs).
    assert.equal(e.logo, `examples/boxes/${e.id}/art/${e.id === 'junkyard' ? 'logo-256' : 'logo'}.png`);
    if (e.contents.kind === 'collection') assert.equal(e.contents.art.source, `examples/boxes/${e.id}/art/cover.png`);
  }
  const junk = loadExamples().find(e => e.id === 'junkyard');
  const catalog = JSON.parse(readFileSync(resolve(ROOT, 'examples/boxes/junkyard/test-collections/catalog.json')));
  assert.equal(junk.priceCoin.symbol, 'TEST_GOLD');
  assert.equal(junk.raise.amount, '1000000000000000000');
  assert.deepEqual(junk.contents.shop.collections, catalog.collections.map(c => ({ id: c.key, tier: '0', starterIds: ['1', '2'] })));
});


test('Link Marines v2 is ready with its lives: rations in LINK on both sides, the inside shares to its own pool', () => {
  const row = JSON.parse(readFileSync(new URL('./link-marines-v2.json', import.meta.url)));
  assert.deepEqual(row.fees, { buyers: { choice: 'items', inside: 'depth' }, sellers: { choice: 'items', inside: 'depth' } });
  assert.equal(row.ticker, 'MARINE');
  assert.equal(row.contents.size, '420');
  assert.deepEqual(row.priceCoin, { symbol: 'LINK', decimals: '18' });
  assert.deepEqual(row.royalties, { bps: '250', destination: 'fees' });
  assert.equal(row.logo, 'examples/boxes/link-marines-v2/art/logo.png');
  assert.equal(row.contents.art.source, 'examples/boxes/link-marines-v2/art/cover.png');
  // SH-EX-LMV2: test_linkMarinesV2 (ExampleLives.t.sol) and the browser life (examples.spec.mjs, kit-open-load.spec.mjs).
  assert.deepEqual([row.status, row.pendingStep, row.pendingReason, contractReady(row)], ['ready', undefined, undefined, true]);
  for (const property of ['own-pictures', 'item-claim', 'pool-growth']) assert.ok(row.properties.includes(property));
  assert.equal(validateExample(row), row);
  // The version 1 kit stays the archival Eat recipe, ready with its own life.
  const v1 = loadExamples().find(e => e.id === 'link-marines');
  assert.deepEqual([v1.status, v1.fees], ['ready', { buyers: { choice: 'eat' }, sellers: { choice: 'eat' } }]);
});

test('Lake House is a USDC pile that starts empty, both sides To the pile and nothing left behind, pending its lives', () => {
  const e = loadExamples().find(row => row.id === 'lake-house');
  assert.ok(e, 'the Lake House recipe must exist (SH-LAKE-HOUSE)');
  assert.deepEqual([e.name, e.ticker, e.template, e.life], ['Lake House', 'HOUSE', { id: 'pile', name: 'Coin pile' }, 'graduate']);
  assert.deepEqual(e.priceCoin, { symbol: 'USDC', decimals: '6' });
  assert.deepEqual(e.contents.seed, { symbol: 'USDC', amount: '0' }, 'the pile starts empty, in the price coin');
  assert.equal(e.contents.leaveBehindBps, '0');
  assert.deepEqual(e.fees, { buyers: { choice: 'pile' }, sellers: { choice: 'pile' } });
  assert.equal(e.creator, undefined, 'a pile has no creator policy; the Safe is the launch pack\'s creator binding');
  assert.equal(e.logo, 'examples/boxes/lake-house/art/logo.png');
  assert.deepEqual([e.status, e.pendingStep, contractReady(e)], ['pending', 'EXAMPLE-LIFE', false]);
  assert.match(e.pendingReason, /lives/);
  for (const property of ['graduation', 'pile-pro-rata', 'own-pictures']) assert.ok(e.properties.includes(property));
  assert.equal(validateExample(e), e);
  const bad = (mutate, reason) => { const row = structuredClone(e); mutate(row); assert.throws(() => validateExample(row), reason); };
  // Only a pile both fee sides feed may start empty; with one side not feeding it, the old seed rule holds.
  bad(row => { row.fees.sellers.choice = 'burn'; }, /seed/);
  bad(row => { row.fees.buyers.choice = 'burn'; }, /seed/);
  bad(row => { row.fees = { buyers: { choice: 'burn' }, sellers: { choice: 'burn' } }; }, /seed/);
  bad(row => { row.contents.seed.symbol = 'LINK'; }, /pile fees require the price coin pile/);
  bad(row => { row.contents.seed = null; }, /seed/);
  bad(row => { row.contents.seed.amount = '-1'; });
  bad(row => { row.contents.leaveBehindBps = '250'; });
  const seeded = structuredClone(e); seeded.contents.seed.amount = '1000000';
  assert.equal(validateExample(seeded), seeded, 'a seed stays allowed');
  // Its zero seed opens no other door: Dragon's Hoard (only buyers feed its pile) still needs one.
  const hoard = loadExamples().find(row => row.id === 'dragons-hoard');
  hoard.contents.seed.amount = '0';
  assert.throws(() => validateExample(hoard), /seed/);
});

test('SH-262: the card shop lists the four test card collections at tiers 0 to 3, and its seed takes one give of each tier a week', () => {
  const e = loadExamples().find(row => row.id === 'card-shop');
  const catalog = JSON.parse(readFileSync(resolve(ROOT, 'examples/boxes/card-shop/test-cards/catalog.json')));
  assert.equal(e.logo, 'examples/boxes/card-shop/art/logo.png');
  assert.deepEqual([e.status, e.pendingStep, contractReady(e)], ['pending', 'EXAMPLE-LIFE', false]);
  assert.deepEqual(e.priceCoin, { symbol: 'USDC', decimals: '6' }); // the test dollar
  assert.deepEqual(e.fees, { buyers: { choice: 'holders' }, sellers: { choice: 'shop', ceilingPreset: '2' } });
  const s = e.contents.shop;
  assert.deepEqual(s.collections, catalog.collections.map((c, tier) => ({ id: c.key, tier: String(tier), starterIds: ['1', '2', '3', '4'] })));
  assert.equal(s.curator, 'none');
  const [seed, weekly, perCollection] = [BigInt(s.seedT), BigInt(s.weeklyBps), BigInt(s.collectionBps)];
  const prices = s.givePricesT.map(BigInt);
  // ShopVaultV2.give: a week's limit is max(snapshot x bps / 10000, the cheapest active give); the first snapshot is the seed.
  const limit = bps => (seed * bps / 10000n > prices[0] ? seed * bps / 10000n : prices[0]);
  assert.ok(prices.every(p => p <= limit(perCollection)), 'each tier\'s give fits its collection\'s week');
  const four = prices.reduce((a, b) => a + b, 0n);
  assert.ok(four <= limit(weekly), 'one give of each tier fits the week');
  assert.ok(four + prices[2] > limit(weekly) && prices[2] * 2n <= limit(perCollection), 'a second Rare that week is over the weekly limit only');
});

test('the BNB Chain testnet profile has its own rows; the Sepolia rows stay as they are', () => {
  // The Sepolia profile is the folder loadExamples() has always read.
  assert.deepEqual(loadProfileExamples('sepolia'), loadExamples());
  assert.ok(loadExamples().every(e => e.$schema === './schema.json'));
  const bnb = loadProfileExamples('bnb');
  assert.deepEqual(bnb.map(e => e.id), ['gpu-poor', 'rent-free', 'the-alchemist']);
  // SH-261 STEP 3: the converter box. The Alchemist priced in the test dollar, its buyers' fees converted into a pile of
  // the stock stand-in (route 6 on chain 97), its rules otherwise the kit's.
  const converter = bnb.find(e => e.id === 'the-alchemist');
  const sepoliaAlchemist = loadExamples().find(e => e.id === 'the-alchemist');
  assert.deepEqual([converter.priceCoin, converter.contents.seed, converter.raise.amount], [{ symbol: 'USDC', decimals: '6' }, { symbol: 'NVDAon', amount: '0' }, '1000000']);
  assert.deepEqual([converter.fees, converter.contents.leaveBehindBps, converter.ticker], [sepoliaAlchemist.fees, '500', 'LEAD']);
  // SH-261 STEP 2: Rent Free's rules unchanged (500 open houses, Items with the inside share burned, sellers Burn, 1%
  // pick fee, priced in the test dollar); only the raise is chain 97's tUSDC listing (1 tUSDC).
  const rent = bnb.find(e => e.id === 'rent-free');
  const sepoliaRent = loadExamples().find(e => e.id === 'rent-free');
  assert.deepEqual({ ...rent, $schema: './schema.json', raise: sepoliaRent.raise }, sepoliaRent);
  assert.equal(rent.raise.amount, '1000000');
  // SH-261 STEP 1: the stock box. GPU Poor priced in the stock stand-in, both fee sides To holders (as Staking Snails),
  // paid in the price coin; the raise is chain 97's tNVDA listing (0.001 tNVDA).
  const stock = bnb.find(e => e.id === 'gpu-poor');
  assert.deepEqual([stock.name, stock.ticker, stock.template], ['GPU Poor', 'VRAM', { id: 'holders', name: 'To holders' }]);
  assert.deepEqual(stock.priceCoin, { symbol: 'NVDAon', decimals: '18' });
  assert.deepEqual(stock.fees, loadExamples().find(e => e.id === 'staking-snails').fees);
  assert.equal(stock.raise.amount, '1000000000000000');
  assert.equal(stock.logo, 'examples/boxes/gpu-poor/art/logo.png');
  assert.ok(stock.properties.includes('holder-claim') && !stock.properties.includes('supply-burn'));
  assert.equal(stock.$schema, '../schema.json');
  // The Sepolia GPU Poor keeps its Burn recipe.
  assert.deepEqual(loadExamples().find(e => e.id === 'gpu-poor').fees, { buyers: { choice: 'burn' }, sellers: { choice: 'burn' } });
  assert.throws(() => loadProfileExamples('mainnet'), /unknown examples profile/);
  assert.throws(() => validateExample({ ...stock, $schema: './other.json' }));
});
