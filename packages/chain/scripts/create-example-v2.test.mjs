import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, decodeAbiParameters, encodeFunctionData, zeroAddress, zeroHash, toHex } from 'viem';
import { contractReady, loadExamples } from '../../box-spec/examples/v2/registry.mjs';
import { buildExampleSpec, prepareExample, parseArgs, stringify } from './create-example-v2.mjs';
import { factoryV2Abi } from '../src/core/v2/abi-v2.ts';
import { shopConfigV2 } from '../src/core/v2/m2-spec-v2.ts';

const addr = n => toHex(BigInt(n), { size: 20 });
const { encodeBoxMetadataTable } = await import('../../artwork/src/box-commitment.ts');
const examples = loadExamples();
const junkyard = examples.find(e => e.id === 'junkyard');
export const inputs = { creator: addr(1), factory: addr(2), listingId: '8', collections: Object.fromEntries(['bent-cans', 'lost-cogs', 'split-boots', 'cracked-mugs', 'tangled-wires'].map((s, i) => [s, addr(i + 10)])) };
const listing = { id: 8, token: addr(3), decimals: 18, class: 5, kind: 1, raise: BigInt(junkyard.raise.amount) };
const nativeRaise = 4206980085000000000n;

test('Items Depth compiles to policy 3 on both fee sides, keeping price-coin payouts', () => {
  const example = examples.find(e => e.id === 'link-marines-v2');
  const art = { metadataTable: toHex(encodeBoxMetadataTable({ description: 'Rations', traitTypes: [] })),
    revealRoot: toHex(1n, { size: 32 }), generatorHash: zeroHash, revealListId: toHex(2n, { size: 32 }) };
  const { spec } = buildExampleSpec(example, { ...inputs, art }, listing, nativeRaise);
  for (const side of [spec.buyers, spec.sellers]) {
    assert.equal(side.split, 1);
    assert.equal(side.a.leg, 1);
    assert.equal(side.a.dest, 8);
    assert.equal(side.a.destParams, toHex(3n, { size: 32 }));
  }
});

test('JY creation encodes SHOP, exact TRASH tiers, Safe curator, starter hash and gold holder sides', () => {
  const { spec, starter } = buildExampleSpec(junkyard, inputs, listing, nativeRaise);
  assert.equal(spec.boxType, 4); assert.equal(spec.creatorBuy, 71278844301225191n);
  assert.equal(spec.deadlineDays, 30); assert.equal(spec.n, 0);
  const config = shopConfigV2(spec.contentsParams);
  assert.equal(config.curator, inputs.creator); assert.equal(config.seedT, 180_000_000n * 10n ** 18n);
  assert.equal(config.pickBps, 20000); assert.equal(config.listDelay, 604800);
  assert.deepEqual(config.collections.map(c => c.toLowerCase()), Object.values(inputs.collections));
  assert.equal(starter.length, 10);
  assert.equal(spec.addOns.find(a => a.id === 10), undefined, 'retired cap is never encoded');
  assert.equal(decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], spec.addOns.find(a => a.id === 8).params)[0], starter[0].hash);
  assert.equal(spec.buyers.a.dest, 6);
  assert.equal(spec.sellers.a.leg, 2); assert.equal(spec.sellers.a.dest, 7);
  assert.equal(spec.sellers.a.destParams, toHex(2n, { size: 32 }));
  assert.equal(spec.buyers.a.leg, 1); assert.equal(spec.buyers.a.destParams, toHex(1n, { size: 32 }));
  assert.equal(JSON.parse(stringify(spec)).creatorBuy, '71278844301225191');
});

test('one-collection shop: a zero curator, one Test Junk collection, ids 3 to 12, paid in ETH with no approval', async () => {
  const shop = examples.find(e => e.id === 'one-collection-shop');
  const bound = { creator: addr(1), factory: addr(2), listingId: '0', collections: { 'bent-cans': addr(14) } };
  const native = { id: 0, token: zeroAddress, decimals: 18, class: 1, kind: 1, raise: nativeRaise };
  const { spec, starter } = buildExampleSpec(shop, bound, native, nativeRaise);
  const config = shopConfigV2(spec.contentsParams);
  assert.equal(spec.boxType, 4); assert.equal(spec.pricing.token, zeroAddress);
  assert.equal(config.curator, zeroAddress, 'nobody can add a collection');
  assert.deepEqual(config.collections.map(c => c.toLowerCase()), [addr(14)]); assert.deepEqual(config.tiers, [0]);
  assert.equal(config.seedT, 2n * config.givePricesT[0]);
  // Same listing for price and native raise: the 0.01 ETH-equivalent buy is exactly 0.01 ETH.
  assert.equal(spec.creatorBuy, 10n ** 16n);
  assert.deepEqual(starter.map(i => i.id), Array.from({ length: 10 }, (_, i) => BigInt(i + 3)));
  assert.equal(decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], spec.addOns.find(a => a.id === 8).params)[0], starter[0].hash);
  assert.throws(() => buildExampleSpec(shop, { ...bound, collections: {} }, native, nativeRaise), /collection binding required: bent-cans/);
  // Sepolia's native listing 0 has the zero token; the shared reader's listing is a gold stand-in.
  const client = reader(); const readListing = client.readContract;
  client.readContract = async q => (q.functionName === 'listing' ? { ...native } : readListing(q));
  const plan = await prepareExample(shop, bound, { chainId: '11155111', client });
  assert.equal(plan.approval, null, 'native ETH needs no token approval');
  assert.equal(plan.transaction.value, (750000000000000n + 10n ** 16n).toString(), 'bootstrap plus creator buy, sent as value');
  assert.equal(shopConfigV2(decodeFunctionData({ abi: factoryV2Abi, data: plan.transaction.data }).args[0].contentsParams).curator, zeroAddress);
});

// Hidden commitments stay private; only the root and metadata table enter creation.
const hidden = examples.filter(e => e.contents.art.mode === 'hidden');
const creationExamples = examples.filter(contractReady);

test('every contract-ready registry recipe produces validated current creation fields, with explicit collection commitments', () => {
  for (const example of creationExamples) {
    const native = example.priceCoin.symbol === 'ETH';
    const context = { ...inputs, collections: { ...inputs.collections, 'bent-cans': addr(15) }, listingId: native ? '0' : '8', assets: { USDC: addr(3), ETH: zeroAddress },
      art: { metadataTable: '0x', revealRoot: zeroHash, generatorHash: zeroHash, revealListId: zeroHash } };
    if (example.contents.kind === 'collection') context.art = {
      metadataTable: toHex(encodeBoxMetadataTable({ description: 'Public test collection', traitTypes: [] })),
      revealRoot: toHex(1n, { size: 32 }), generatorHash: toHex(2n, { size: 32 }), revealListId: example.contents.art.mode === 'hidden' ? zeroHash : toHex(3n, { size: 32 }),
    };
    const { spec } = buildExampleSpec(example, context, { ...listing, id: native ? 0 : 8, token: native ? zeroAddress : addr(3), decimals: Number(example.priceCoin.decimals), class: native ? 1 : 5, burnSelector: '0x42966c68', raise: BigInt(example.raise.amount) }, nativeRaise);
    assert.equal(spec.tokenSymbol, example.ticker);
    assert.equal(spec.raise, BigInt(example.raise.amount));
  }
});

test('Alchemist stays pending until directory registration, outside automatic example lives', () => {
  const alchemist = examples.find(e => e.id === 'the-alchemist');
  assert.ok(alchemist);
  assert.equal(alchemist.status, 'pending');
  assert.equal(alchemist.pendingStep, 'ALCHEMIST-REGISTRATION');
  assert.equal(alchemist.raise.amount, null);
  assert.equal(contractReady(alchemist), false);
  // Reuse the test listing to isolate the missing directory selection from the unresolved recipe raise.
  assert.throws(() => buildExampleSpec(alchemist, inputs, listing, nativeRaise), /Alchemist directory id/);
  assert.equal(creationExamples.includes(alchemist), false, 'pending Alchemist must not enter successful creation preflight');
});

test('hidden kits encode placeholders and reject a public reveal list for exactly that reason', () => {
  assert.deepEqual(hidden.map(e => e.id), ['frog-kiln', 'paper-certificates']);
  for (const example of hidden) {
    const context = { ...inputs, art: { metadataTable: toHex(encodeBoxMetadataTable({ description: 'Hidden collection', traitTypes: [] })),
      revealRoot: toHex(1n, { size: 32 }), generatorHash: toHex(2n, { size: 32 }), revealListId: zeroHash } };
    const bound = { ...listing, burnSelector: '0x42966c68', raise: BigInt(example.raise.amount) };
    const { spec } = buildExampleSpec(example, context, bound, nativeRaise);
    assert.equal(spec.artMode, 2);
    assert.equal(spec.revealListId, zeroHash);
    const placeholder = spec.addOns.find(a => a.id === 1);
    assert.ok(placeholder);
    const values = decodeAbiParameters(Array.from({ length: 5 }, () => ({ type: 'string' })), placeholder.params);
    assert.equal(values[1], example.ticker);
    assert.match(values[4], /<svg/);
    assert.throws(() => buildExampleSpec(example, { ...context, art: { ...context.art, revealListId: toHex(3n, { size: 32 }) } }, bound, nativeRaise),
      { name: 'AssertionError', message: /^hidden art requires a zero reveal list id\n/ });
  }
});

function reader(chainId = 11155111, symbol = 'tGOLD', burn = '0x42966c68') {
  const calls = [];
  return { calls, getChainId: async () => chainId, getBlockNumber: async () => 42n,
    getCode: async () => '0x1234',
    readContract: async q => {
      encodeFunctionData({ abi: q.abi, functionName: q.functionName, args: q.args });
      calls.push(q);
      if (q.functionName === 'listingRegistry') return addr(20);
      if (q.functionName === 'listing') return q.args[0] === 0 ? { ...listing, id: 0, raise: nativeRaise } : listing;
      if (q.functionName === 'boxQParameters') return { bootstrapQ: 750000000000000n };
      if (q.functionName === 'symbol') return symbol;
      if (q.functionName === 'checkedBurnSelector') return burn;
      if (q.functionName === 'tokenAddressLimit') return addr(1000);
      if (q.functionName === 'predictBox') return [addr(40), addr(50), zeroHash];
      throw new Error(`unexpected read ${q.functionName}`);
    } };
}

test('unsigned plan uses the exact factory ABI, creator-bound salts, precise approval and one evidence block', async () => {
  const client = reader();
  const result = await prepareExample(junkyard, inputs, { chainId: '11155111', client });
  const decoded = decodeFunctionData({ abi: factoryV2Abi, data: result.transaction.data });
  assert.equal(decoded.functionName, 'createBox');
  assert.equal(decoded.args[0].creatorBuy, 71451889527854326n);
  assert.equal(result.transaction.value, '0'); assert.equal(result.transaction.from, inputs.creator);
  assert.equal(result.transaction.chainId, '11155111');
  assert.equal(result.approval.amount, '72201889527854326');
  assert.ok(client.calls.every(c => c.blockNumber === 42n));
  assert.deepEqual(Object.keys(client).sort(), ['calls', 'getBlockNumber', 'getChainId', 'getCode', 'readContract']);
});

test('SH-LAKE-HOUSE: an empty tUSDC pile both fee sides feed, created by a Safe that approves only the bootstrap', async () => {
  const house = examples.find(e => e.id === 'lake-house');
  const usdc = { id: 2, token: addr(3), decimals: 6, class: 3, kind: 1, raise: 100000000n };
  const bound = { creator: addr(1), factory: addr(2), listingId: '2', assets: { USDC: addr(3) } };
  const { spec, starter } = buildExampleSpec(house, bound, usdc, 10n ** 17n, 35656n);
  assert.deepEqual([spec.boxType, spec.creatorBuy, spec.n, spec.tokenName, spec.tokenSymbol], [5, 0n, 0, 'Lake House', 'HOUSE']);
  assert.deepEqual(starter, []);
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], spec.contentsParams), [addr(3), 0n, 0],
    'the pile is the price coin, empty, with nothing left behind');
  for (const side of [spec.buyers, spec.sellers]) assert.deepEqual([side.a.leg, side.a.dest, side.split], [1, 7, 1], 'To the pile');
  assert.deepEqual([spec.marketplaceOwner, spec.creatorFeeRecipient], [zeroAddress, zeroAddress], 'no seat names the Safe');
  assert.throws(() => buildExampleSpec(house, { ...bound, assets: { USDC: addr(4) } }, usdc, 10n ** 17n, 35656n), /same binding/);
  const client = reader(11155111, 'tUSDC');
  const base = client.readContract;
  client.readContract = async q => {
    if (q.functionName === 'listing') return q.args[0] === 0 ? { id: 0, token: zeroAddress, decimals: 18, class: 1, kind: 1, raise: 10n ** 17n } : usdc;
    if (q.functionName === 'boxQParameters') return { bootstrapQ: 35656n };
    return base(q);
  };
  const plan = await prepareExample(house, bound, { chainId: '11155111', client });
  assert.deepEqual([plan.approval.token, plan.approval.amount, plan.transaction.value], [addr(3), '35656', '0'], 'exactly 0.035656 tUSDC, no value');
  assert.equal(plan.creatorPolicy, null);
  assert.ok(client.calls.every(c => c.blockNumber === 42n));
});

test('G08 rejects mainnet before reads, mismatched chain, missing bindings and malformed inputs', async () => {
  const client = reader(1);
  await assert.rejects(prepareExample(junkyard, inputs, { chainId: '1', client }), /allow-mainnet/);
  assert.equal(client.calls.length, 0);
  await assert.rejects(prepareExample(junkyard, inputs, { chainId: '11155111', client }), /chain/);
  await prepareExample(junkyard, inputs, { chainId: '1', allowMainnet: true, client });
  assert.throws(() => buildExampleSpec(junkyard, { ...inputs, collections: {} }, listing, nativeRaise), /collection/);
  assert.throws(() => buildExampleSpec(junkyard, { ...inputs, listingId: 8 }, listing, nativeRaise));
  assert.throws(() => parseArgs(['--chain-id', '1', '--inputs', 'public.json', '--example', 'junkyard', '--out', 'tx.json', '--rpc', 'https://example.invalid']), /allow-mainnet/);
  assert.throws(() => parseArgs(['--send']), /unknown/);
});


test('Frog Kiln requires the listing checked burn', () => {
  const example = hidden.find(e => e.id === 'frog-kiln');
  const context = { ...inputs, art: { metadataTable: toHex(encodeBoxMetadataTable({ description: '', traitTypes: [] })),
    revealRoot: toHex(1n, { size: 32 }), generatorHash: zeroHash, revealListId: zeroHash } };
  assert.throws(() => buildExampleSpec(example, context, listing, nativeRaise), /Frog Kiln requires a checked burn/);
  assert.throws(() => buildExampleSpec(example, context, { ...listing, burnSelector: '0x00000000' }, nativeRaise), /Frog Kiln requires a checked burn/);
});


test('Frog preparation saves private files, checks the stand-in and never puts secrets in the unsigned plan', async () => {
  const example = hidden.find(e => e.id === 'frog-kiln');
  await assert.rejects(prepareExample(example, inputs, { chainId: '11155111', generateHiddenArt: true, client: reader(11155111, 'LINK') }), /price coin symbol mismatch/);
  await assert.rejects(prepareExample(example, inputs, { chainId: '11155111', generateHiddenArt: true, client: reader(11155111, 'tFROG', '0x00000000') }), /checked burn/);
  const client = reader(11155111, 'tFROG');
  const messages = [];
  const plan = await prepareExample(example, inputs, { chainId: '11155111', client, generateHiddenArt: true, log: message => messages.push(message) });
  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes(plan.localFiles.directory));
  assert.ok(messages[0].toLowerCase().includes('private')); assert.match(messages[0], /must.*keep/i);
  assert.match(plan.localFiles.directory, /^\.cache\/hidden-art\/frog-kiln-/);
  const secret = JSON.parse(readFileSync(plan.localFiles.secret, 'utf8'));
  const reveal = JSON.parse(readFileSync(plan.localFiles.reveal, 'utf8'));
  assert.equal(reveal.revealRoot, plan.spec.revealRoot);
  assert.ok(!stringify(plan).includes(secret.seed));
  assert.ok(reveal.items.every(item => !stringify(plan).includes(item.salt)));
  assert.ok(client.calls.every(c => c.blockNumber === 42n));
});

test('hidden kits require art inputs or explicit generation before any chain read', async () => {
  for (const example of hidden) {
    const client = { getChainId() { throw new Error('unexpected RPC'); } };
    await assert.rejects(prepareExample(example, inputs, { chainId: '11155111', client }), /art input required.*--generate-hidden-art/);
  }
});

test('explicit hidden art commitments need no generation flag or private files', async () => {
  for (const example of hidden) {
    const art = { metadataTable: toHex(encodeBoxMetadataTable({ description: '', traitTypes: [] })),
      revealRoot: toHex(1n, { size: 32 }), generatorHash: zeroHash, revealListId: zeroHash };
    const plan = await prepareExample(example, { ...inputs, art }, { chainId: '11155111',
      client: reader(11155111, example.id === 'frog-kiln' ? 'tFROG' : 'tGOLD') });
    assert.equal(plan.localFiles, undefined);
    assert.equal(plan.spec.revealRoot, art.revealRoot);
  }
});

test('CLI accepts explicit generation exactly once', () => {
  const args = ['--chain-id', '11155111', '--inputs', 'public.json', '--example', 'frog-kiln', '--out', 'tx.json', '--rpc', 'https://example.invalid'];
  assert.equal(parseArgs(args).generateHiddenArt, undefined);
  assert.equal(parseArgs([...args, '--generate-hidden-art']).generateHiddenArt, true);
  assert.throws(() => parseArgs([...args, '--generate-hidden-art', '--generate-hidden-art']), /duplicate/);
});

test('verify reaches the hidden-art and creation regression suites through test:scripts', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.ok(scripts.verify.split(' && ').includes('pnpm test:scripts'));
  const nodeTests = scripts['test:scripts'].split(' && ').find(command => command.startsWith('node --test '));
  assert.ok(nodeTests.startsWith('node --test --experimental-transform-types '), 'Node options must precede the test paths');
  // SH-EX-L3: the Sepolia listing batch and the founder launch packs run in the same gate.
  assert.ok(nodeTests.endsWith('scripts/test/*.test.mjs packages/chain/scripts/lib/hidden-art.test.mjs packages/chain/scripts/create-example-v2.test.mjs'
    + ' packages/chain/scripts/sepolia-listing-batch.test.mjs packages/chain/scripts/sepolia-launch-pack.test.mjs'));
});

test('Sepolia uses all six stand-in symbols while mainnet keeps issuer symbols', async () => {
  for (const [id, symbol] of [['gpu-poor', 'tNVDA'], ['one-dollar', 'tUSDC'], ['bag-holders', 'tLINK']]) {
    const example = examples.find(e => e.id === id);
    const client = reader(11155111, symbol);
    const old = client.readContract;
    client.readContract = async q => q.functionName === 'listing' && q.args[0] !== 0
      ? { ...listing, decimals: Number(example.priceCoin.decimals) } : old(q);
    const art = { metadataTable: toHex(encodeBoxMetadataTable({ description: '', traitTypes: [] })),
      revealRoot: toHex(1n, { size: 32 }), generatorHash: zeroHash, revealListId: toHex(2n, { size: 32 }) };
    await prepareExample(example, { ...inputs, assets: { USDC: addr(3) }, art }, { chainId: '11155111', client });
  }
});

test('Alchemist encodes the explicit directory pick, and refuses a missing pick', () => {
  const example = examples.find(e => e.id === 'the-alchemist');
  const bound = { ...inputs, assets: { TEST_GOLD: addr(31) }, alchemistId: '7' };
  const { spec } = buildExampleSpec(example, bound, listing, nativeRaise);
  assert.equal(spec.buyers.a.leg, 1);
  assert.equal(spec.buyers.a.dest, 9);
  assert.equal(decodeAbiParameters([{ type: 'uint32' }], spec.buyers.a.destParams)[0], 7);
  assert.throws(() => buildExampleSpec(example, { ...bound, alchemistId: undefined }, listing, nativeRaise), /Alchemist directory id/);
});

test('Junkyard estimates input and bounds the historical-output shortfall only for the measured preset', async () => {
  const { quoteJunkyardCreatorBuy, estimateJunkyardTokensOut, junkyardMinimumTokensOut, JUNKYARD_TARGET_T } = await import('./create-example-v2-quote.mjs');
  const raise = 10n ** 18n;
  const bootstrap = 356550297290034n;
  const buy = quoteJunkyardCreatorBuy(raise, bootstrap);
  assert.ok(buy > 0n && buy < raise);
  assert.equal(JUNKYARD_TARGET_T, 180195814884384477544867602n);
  assert.equal(buy, 71278844301225191n);
  assert.ok(estimateJunkyardTokensOut(raise, bootstrap, buy) >= JUNKYARD_TARGET_T);
  assert.ok(estimateJunkyardTokensOut(raise, bootstrap, buy - 1n) < JUNKYARD_TARGET_T);
  const minimum = junkyardMinimumTokensOut(raise, bootstrap, buy);
  assert.equal(minimum, 180195814884384475344482735n);
  assert.equal(JUNKYARD_TARGET_T - minimum, 2200384867n);
  assert.equal(estimateJunkyardTokensOut(raise, bootstrap, buy) - minimum, 2685119845n);
  assert.ok(minimum > BigInt(junkyard.contents.shop.seedT));
  for (const args of [[raise + 1n, bootstrap, buy], [raise, bootstrap + 1n, buy], [raise, bootstrap, buy + 1n]]) {
    assert.throws(() => junkyardMinimumTokensOut(...args), /measured preset/);
  }
  assert.ok(JUNKYARD_TARGET_T > BigInt(junkyard.contents.shop.seedT));
  assert.throws(() => quoteJunkyardCreatorBuy(raise, raise), /bootstrap/);
});

test('final L1 settings retain their exact spec and salt prediction inputs', async () => {
  const example = examples.find(e => e.id === 'gpu-poor');
  const { encodeBoxSpecV2 } = await import('../../box-spec/src/generated/box-spec.v2.ts');
  const { keccak256 } = await import('viem');
  const { spec } = buildExampleSpec(example, inputs, listing, nativeRaise);
  spec.description = 'Final reviewed L1 copy.';
  spec.openAt = 2000000000;
  const encoded = encodeBoxSpecV2(spec);
  const settingsText = stringify({ format: 'squarehole.boxspec/2', spec, encoded, specHash: keccak256(encoded),
    pictures: [{ role: 'logo', sha256: spec.coverSha256, base64: readFileSync(example.logo).toString('base64') }], revealList: null });
  const client = reader(11155111, 'tNVDA');
  const p = await prepareExample(example, inputs, { chainId: '11155111', client, settingsText });
  assert.equal(p.encoded, encoded);
  assert.ok(client.calls.filter(q => q.functionName === 'predictBox').every(q => q.args[1].description === spec.description));
});

test('stand-in substitution is Sepolia-specific and includes the Alchemist pair', async () => {
  const { priceSymbol } = await import('./create-example-v2.mjs');
  for (const [recipe, testCoin] of [['LINK', 'tLINK'], ['USDC', 'tUSDC'], ['NVDAon', 'tNVDA']]) {
    assert.equal(priceSymbol(recipe, '11155111'), testCoin);
    assert.equal(priceSymbol(recipe, '1'), recipe);
  }
  assert.equal(priceSymbol('TEST_PEPE', '11155111'), 'tPEPE');
  assert.equal(priceSymbol('TEST_GOLD', '11155111'), 'tGOLD');
});

test('Alchemist creation checks the release directory before salt search, at the same pinned block', async () => {
  const example = examples.find(e => e.id === 'the-alchemist');
  const client = reader(11155111, 'tPEPE');
  const old = client.readContract;
  client.readContract = async q => {
    if (q.functionName === 'implementation') return addr(q.args[0] + 50n);
    if (q.functionName === 'poolManager') return addr(60);
    return old(q);
  };
  const calls = [];
  client.call = async q => { calls.push(q); return { data: '0x' }; };
  await assert.rejects(prepareExample(example, { ...inputs, alchemistId: '4', assets: { TEST_GOLD: addr(31) } }, { chainId: '11155111', client }), /directory/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].blockNumber, 42n);
  assert.ok(!client.calls.some(q => q.functionName === 'predictBox'));
});

test('final settings cannot change the bound listing', async () => {
  const { readExampleSettings, assertRecipeSettings } = await import('./create-example-v2-settings.mjs');
  assert.equal(typeof readExampleSettings, 'function');
  const example = examples.find(e => e.id === 'gpu-poor');
  const { spec } = buildExampleSpec(example, inputs, listing, nativeRaise);
  assert.throws(() => assertRecipeSettings({ ...spec, pricing: { ...spec.pricing, listingId: 99 } }, spec, listing), /settings recipe mismatch: pricing/);
});

// SH-CREATE-ITEM-MODELS (R74-ART): Create's own Download BoxSpec with a GLB per NFT (the committed 3D test fixture: ten
// items, kept fresh by apps/web three-d-fixture.test.ts) passes --settings' reader once its Demo label is gone. Each
// model entry is checked as the site's viewer checks a model, by its exact sha256, and against the public list.
test('the settings reader takes a Create download with 3D models and refuses every kind of bad model entry', async () => {
  const { readExampleSettings } = await import('./create-example-v2-settings.mjs');
  const text = readFileSync('apps/web/src/features/create/v2/test-support/three-d-boxspec-v2.json', 'utf8');
  assert.throws(() => readExampleSettings(text), /settings fields must be public/, 'a Demo file is no launch file');
  const { demo, note, ...body } = JSON.parse(text);
  assert.deepEqual([demo, typeof note], [true, 'string']);
  const spec = readExampleSettings(JSON.stringify(body));
  assert.deepEqual([spec.n, spec.artMode, body.models.length], [10, 1, 10]);
  assert.deepEqual(body.models.map(m => m.sha256).sort(), body.revealList.items.map(item => item.modelSha256).sort());
  const glb = json => {
    const bytes = Buffer.from(JSON.stringify(json)); const length = Math.ceil(bytes.length / 4) * 4;
    const out = Buffer.alloc(20 + length, 0x20);
    out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(length, 12); out.writeUInt32LE(0x4e4f534a, 16);
    bytes.copy(out, 20); return out;
  };
  const entry = bytes => ({ type: 'model/gltf-binary', sha256: `0x${createHash('sha256').update(bytes).digest('hex')}`, base64: bytes.toString('base64') });
  const [first, second, ...rest] = body.models;
  const refused = (models, pattern) => assert.throws(() => readExampleSettings(JSON.stringify({ ...body, models })), pattern);
  // Missing, one left out, one the list does not name, empty, repeated.
  refused(undefined, /settings models must be the reveal list/);
  refused([second, ...rest], /settings models must be the reveal list/);
  refused([...body.models, entry(glb({ asset: { version: '2.0' }, extras: { item: 11 } }))], /settings models must be the reveal list/);
  refused([], /settings models/);
  refused([first, first, second, ...rest], /settings model repeated/);
  // Bytes that are not the hash's, an upper-case or untyped entry, an extra field.
  refused([{ ...first, base64: second.base64 }, second, ...rest], /settings model hash/);
  refused([{ ...first, sha256: `0x${first.sha256.slice(2).toUpperCase()}` }, second, ...rest], /settings model hash/);
  refused([{ ...first, type: 'model/gltf+json' }, second, ...rest], /settings model type/);
  refused([{ ...first, uri: 'model.glb' }, second, ...rest], /settings fields must be public/);
  // Longer than one raw block's base64 (never decoded), or base64 that is not canonical.
  refused([{ ...first, base64: 'A'.repeat(Math.ceil(1_048_576 / 3) * 4 + 4) }, second, ...rest], /settings model size/);
  refused([{ ...first, base64: `${first.base64.slice(0, 8)}\n${first.base64.slice(8)}` }, second, ...rest], /settings model base64/);
  // Bytes that are no GLB, and a GLB that loads an outside buffer, each under its own correct sha256.
  refused([entry(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)])), second, ...rest], /self-contained GLB/);
  refused([entry(glb({ asset: { version: '2.0' }, buffers: [{ uri: 'model.bin', byteLength: 4 }] })), second, ...rest], /self-contained GLB/);
  // The list must be the spec's: entries that trade models no longer hash to its revealListId.
  const items = body.revealList.items;
  const swapped = items.map((item, i) => (i < 2 ? { ...item, modelSha256: items[1 - i].modelSha256 } : item));
  assert.throws(() => readExampleSettings(JSON.stringify({ ...body, revealList: { ...body.revealList, items: swapped } })), /settings reveal list hash/);
});

test('One Dollar binds its 1000000 raw seed to the selected tUSDC price coin', () => {
  const example = examples.find(e => e.id === 'one-dollar');
  assert.throws(() => buildExampleSpec(example, { ...inputs, assets: { USDC: addr(30) } }, { ...listing, decimals: 6 }, nativeRaise), /seed and price coin/);
});
