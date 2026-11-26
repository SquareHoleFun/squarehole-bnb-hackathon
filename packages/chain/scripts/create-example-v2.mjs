#!/usr/bin/env node
/** Public inputs and read-only RPC -> unsigned factory call. No signer, wallet client or send method. */
import './register-ts.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createPublicClient, encodeAbiParameters, erc20Abi, http, isAddress, keccak256, zeroAddress, zeroHash } from 'viem';
import { ITEMS_INSIDE_POLICIES, loadExamples, validateExample } from '../../box-spec/examples/v2/registry.mjs';
const { encodeBoxSpecV2, validateBoxSpecV2 } = await import('../../box-spec/src/generated/box-spec.v2.ts');
import { factoryV2Abi, listingRegistryV2Abi, listingBurnV21Abi } from '../src/core/v2/abi-v2.ts';
const { findCreateSaltsV2 } = await import('../src/core/v2/create-salts.ts');
const { createPaymentCallsV2 } = await import('../src/core/v2/create-calls-v2.ts');
import { createHiddenArt, writeHiddenSettings } from './lib/hidden-art.mjs';
import { readExampleSettings, assertRecipeSettings } from './create-example-v2-settings.mjs';
import { quoteJunkyardCreatorBuy } from './create-example-v2-quote.mjs';
const { alchemistSideV21, alchemistRowV21, releaseDirectoryV21 } = await import('../src/core/v2/alchemist-v21.ts');
import { shopConfigV2Parameters } from '../src/core/v2/m2-spec-v2.ts';

const ROOT = new URL('../../../', import.meta.url);
const raw = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) < 1n << 256n);
const address = z.string().refine(v => isAddress(v) && v !== zeroAddress);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
class HiddenArtInputError extends Error {
  constructor() { super('Hidden kit art input required; supply art or pass --generate-hidden-art and keep the private generated folder.'); }
}
const inputSchema = z.strictObject({
  creator: address, factory: address, listingId: raw.refine(v => BigInt(v) < 1n << 32n),
  alchemistId: raw.refine(v => BigInt(v) < 1n << 32n).optional(),
  collections: z.record(z.string(), address).optional(), assets: z.record(z.string(), z.string().refine(isAddress)).optional(),
  art: z.strictObject({ metadataTable: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/), revealRoot: hash, generatorHash: hash, revealListId: hash }).optional(),
});
const digest = path => `0x${createHash('sha256').update(readFileSync(new URL(path, ROOT))).digest('hex')}`;
const small = value => Number(BigInt(value)); // bounded enum/count/timestamp fields only, never money
export const stringify = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const emptyBranch = () => ({ leg: 0, dest: 0, legParams: '0x', destParams: '0x' });
const uint8 = value => encodeAbiParameters([{ type: 'uint8' }], [value]);
function side(pick, inputs) {
  if (pick.choice === 'alchemist') {
    assert.ok(inputs.alchemistId !== undefined, 'Alchemist directory id required');
    return alchemistSideV21(small(inputs.alchemistId));
  }
  const [leg, dest] = { keep: [1, 2], burn: [2, 1], grow: [1, 4], holders: [1, 6], items: [1, 8], pile: [1, 7], shop: [2, 7], eat: [1, 1], 'holders-t': [2, 6], 'items-t': [2, 8] }[pick.choice];
  const destParams = pick.choice === 'shop' ? uint8(small(pick.ceilingPreset)) : dest === 6 ? uint8(pick.choice === 'holders-t' ? 2 : 1) : dest === 8 ? uint8(ITEMS_INSIDE_POLICIES[pick.inside]) : '0x';
  return { a: { leg, dest, legParams: '0x', destParams }, b: emptyBranch(), split: 1, splitParams: '0x' };
}

/** Ordered IStarterSetLoaderV2 commitment, also exposing each page's suffix for bounded loading. */
export function starterCommitment(items) {
  let nextHash = zeroHash;
  return items.toReversed().map(item => {
    const hash = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }], [item.collection, item.id, item.tier, nextHash]));
    const entry = { ...item, hash, nextHash }; nextHash = hash; return entry;
  }).reverse();
}

/** Bind recipe data to explicit chain addresses. Collection art is public commitment data, supplied by its author. */
export function buildExampleSpec(example, inputs, listing, nativeRaise, bootstrapQ = (1500000000000000n * listing.raise + 4206980085000000000n - 1n) / 4206980085000000000n) {
  validateExample(example); inputSchema.parse(inputs);
  assert.equal(BigInt(inputs.listingId), BigInt(listing.id), 'listing id mismatch');
  assert.equal(BigInt(listing.decimals), BigInt(example.priceCoin.decimals), 'listing decimals mismatch');
  assert.ok(listing.raise > 0n && nativeRaise > 0n, 'nonzero listing raises required');
  assert.equal(listing.token === zeroAddress, example.priceCoin.symbol === 'ETH', 'price asset mismatch');
  if (example.id === 'frog-kiln') assert.equal(listing.burnSelector, '0x42966c68', 'Frog Kiln requires a checked burn');
  const collection = example.contents.kind === 'collection';
  const creatorBuy = example.id === 'junkyard' ? quoteJunkyardCreatorBuy(listing.raise, bootstrapQ) : example.creator ? (BigInt(example.creator.buyEthEquivalent) * listing.raise + nativeRaise - 1n) / nativeRaise : 0n;
  const spec = { format: 2, version: 2, boxType: { collection: 1, token: 3, shop: 4, pile: 5 }[example.contents.kind],
    tokenName: example.name, tokenSymbol: example.ticker, collectionName: collection ? example.name : '', collectionSymbol: collection ? example.ticker : '',
    description: '', n: small(example.contents.size), firstId: collection ? 1n : 0n,
    pricing: { listingId: small(inputs.listingId), token: listing.token }, raise: listing.raise,
    layout: 1, gradLayout: 3, launchFormat: 1, openAt: 0, deadlineDays: small(example.deadline.days),
    buyers: side(example.fees.buyers, inputs), sellers: side(example.fees.sellers, inputs), artMode: collection ? (example.contents.art.mode === 'open' ? 1 : 2) : 0,
    revealRoot: zeroHash, metadataTable: '0x', generatorHash: zeroHash, coverSha256: digest(example.logo), revealListId: zeroHash,
    marketplaceOwner: collection ? inputs.creator : zeroAddress, creatorFeeRecipient: Object.values(example.fees).some(s => s.choice === 'keep') || example.royalties.bps !== '0' ? inputs.creator : zeroAddress,
    creatorBuy, collectionCoverSha256: collection ? digest(example.contents.art.source) : zeroHash,
    addOns: [], contentsParams: '0x', pickFeeBps: small(example.contents.pickFeeBps) };
  if (collection) {
    assert.ok(inputs.art, 'public collection art commitments required'); Object.assign(spec, inputs.art);
    if (example.contents.art.mode === 'hidden') {
      assert.equal(spec.revealListId, zeroHash, 'hidden art requires a zero reveal list id');
      const svg = readFileSync(new URL(`examples/boxes/${example.id}/art/hidden.svg`, ROOT), 'utf8').trim();
      spec.addOns.push({ id: 1, params: encodeAbiParameters(Array.from({ length: 5 }, () => ({ type: 'string' })),
        [example.name, example.ticker, 'A ticket for a hidden item.', 'Hidden until drawn.', svg]) });
    }
  }
  if (example.royalties.bps !== '0') spec.addOns.push({ id: 4, params: encodeAbiParameters([{ type: 'uint16' }, { type: 'uint8' }], [small(example.royalties.bps), 1]) });
  let starter = [];
  if (example.contents.kind === 'shop') {
    const shop = example.contents.shop;
    const collections = shop.collections.map(c => { const a = inputs.collections?.[c.id]; assert.ok(a, `collection binding required: ${c.id}`); return a; });
    assert.equal(new Set(collections.map(c => c.toLowerCase())).size, collections.length, 'duplicate collection address');
    // 'none' is a fixed list: the zero curator, whom ShopVaultV2 lets nobody act as (IShopVaultV2.sol:20).
    spec.contentsParams = encodeAbiParameters(shopConfigV2Parameters, [{ seedT: BigInt(shop.seedT), givePricesT: shop.givePricesT.map(BigInt),
      pickBps: small(shop.pickBps), weeklyBps: small(shop.weeklyBps), collectionBps: small(shop.collectionBps), listDelay: small(shop.listDelay),
      curator: shop.curator === 'none' ? zeroAddress : inputs.creator, collections, tiers: shop.collections.map(c => small(c.tier)) }]);
    starter = starterCommitment(shop.collections.flatMap((c, i) => c.starterIds.map(id => ({ collection: collections[i], id: BigInt(id), tier: small(c.tier) }))));
    spec.addOns.push({ id: 7, params: '0x' }, { id: 8, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [starter[0].hash, starter.length]) });
  }
  if (example.contents.kind === 'pile') {
    const seed = example.contents.seed;
    const asset = seed.symbol === 'ETH' ? zeroAddress : inputs.assets?.[seed.symbol];
    assert.ok(asset && (seed.symbol === 'ETH' || asset !== zeroAddress), `seed asset binding required: ${seed.symbol}`);
    if (seed.symbol === example.priceCoin.symbol) assert.equal(asset.toLowerCase(), listing.token.toLowerCase(), 'seed and price coin must use the same binding');
    spec.contentsParams = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], [asset, BigInt(seed.amount), small(example.contents.leaveBehindBps ?? '0')]);
  }
  const verdict = validateBoxSpecV2(spec, { listing });
  assert.equal(verdict.reason, 0, `invalid spec: reason ${verdict.reason}, field ${verdict.field}`);
  return { spec, starter };
}

/** Only Sepolia substitutes issuer names; TEST_* always identify test assets. */
export function priceSymbol(symbol, chainId) {
  const test = { TEST_FROG: 'tFROG', TEST_GOLD: 'tGOLD', TEST_PEPE: 'tPEPE' };
  return test[symbol] ?? (chainId === '11155111' ? { LINK: 'tLINK', USDC: 'tUSDC', NVDAon: 'tNVDA' }[symbol] : undefined) ?? symbol;
}

export function assertChain(chainId, allowMainnet) {
  raw.parse(chainId);
  assert.ok(['1', '11155111'].includes(chainId), 'supported chain ids: 11155111 and explicitly enabled 1');
  assert.ok(chainId !== '1' || allowMainnet === true, 'chain 1 requires --allow-mainnet');
}

/** All chain reads are pinned to one block. Caller supplies only a read client; never signs or broadcasts. */
export async function prepareExample(example, inputs, { chainId, allowMainnet = false, generateHiddenArt = false, settingsText, client, log = message => console.warn(message) }) {
  assertChain(chainId, allowMainnet); inputSchema.parse(inputs);
  const loaded = settingsText === undefined ? null : readExampleSettings(settingsText);
  if (loaded) inputs = { ...inputs, art: { metadataTable: loaded.metadataTable, revealRoot: loaded.revealRoot, generatorHash: loaded.generatorHash, revealListId: loaded.revealListId } };
  const needsArt = example.contents.art.mode === 'hidden' && !inputs.art;
  if (needsArt && generateHiddenArt !== true) throw new HiddenArtInputError();
  assert.equal(BigInt(await client.getChainId()), BigInt(chainId), 'RPC chain does not match requested chain');
  const blockNumber = await client.getBlockNumber();
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber });
  const deployed = async address => assert.ok(!['0x', undefined].includes(await client.getCode({ address, blockNumber })), 'required contract is not deployed');
  await deployed(inputs.factory);
  if (example.creator?.kind === 'safe') await deployed(inputs.creator); // operator must verify actual Safe ownership/threshold
  const registry = await read(inputs.factory, factoryV2Abi, 'listingRegistry');
  const listing = await read(registry, listingRegistryV2Abi, 'listing', [small(inputs.listingId)]);
  const native = await read(registry, listingRegistryV2Abi, 'listing', [0]);
  const symbol = priceSymbol(example.priceCoin.symbol, chainId);
  if (listing.token !== zeroAddress) assert.equal(await read(listing.token, erc20Abi, 'symbol'), symbol, 'price coin symbol mismatch');
  const boundListing = example.id === 'frog-kiln' ? { ...listing, burnSelector: await read(registry, listingBurnV21Abi, 'checkedBurnSelector', [listing.token]) } : listing;
  if (example.id === 'frog-kiln') assert.equal(boundListing.burnSelector, '0x42966c68', 'Frog Kiln requires a checked burn');
  if (Object.values(example.fees).some(s => s.choice === 'alchemist')) {
    assert.ok(inputs.alchemistId !== undefined, 'Alchemist directory id required');
    const reads = {
      call: async (to, data) => (await client.call({ to, data, blockNumber })).data ?? null,
      code: async address => await client.getCode({ address, blockNumber }) ?? '0x',
    };
    const release = {
      poolManager: await read(inputs.factory, factoryV2Abi, 'poolManager'),
      receiverImplementation: await read(inputs.factory, factoryV2Abi, 'implementation', [5n]),
      coordinatorImplementation: await read(inputs.factory, factoryV2Abi, 'implementation', [0n]),
    };
    const directory = await releaseDirectoryV21(reads, release.receiverImplementation);
    assert.ok(directory, 'release module directory required');
    await alchemistRowV21(reads, { ...release, directory }, small(inputs.alchemistId),
      { priceCoin: listing.token, pileCoin: inputs.assets?.[example.contents.seed.symbol] });
  }
  const q = await read(inputs.factory, factoryV2Abi, 'boxQParameters', [small(inputs.listingId), listing.raise]);
  const local = needsArt ? await createHiddenArt(example) : null;
  if (local) log(`You must keep this private hidden-art folder to reveal the collection: ${local.directory}`);
  const { spec: recipe, starter } = buildExampleSpec(example, local ? { ...inputs, art: local.art } : inputs, boundListing, native.raise, q.bootstrapQ);
  if (loaded) assertRecipeSettings(loaded, recipe, boundListing);
  const spec = loaded ?? recipe;
  const settings = local ? writeHiddenSettings(example, local, spec) : null;
  for (const c of new Set(starter.map(i => i.collection))) await deployed(c);
  const limit = await read(inputs.factory, factoryV2Abi, 'tokenAddressLimit', [spec.pricing.token]);
  const predicted = await findCreateSaltsV2({ priceToken: spec.pricing.token, tokenAddressLimit: limit,
    predictBox: cs => read(inputs.factory, factoryV2Abi, 'predictBox', [inputs.creator, spec, cs]) });
  const payment = q.bootstrapQ + spec.creatorBuy;
  const encoded = encodeBoxSpecV2(spec);
  const calls = createPaymentCallsV2({ factory: inputs.factory, spec, cs: predicted.cs, hs: predicted.hs, bootstrapQ: q.bootstrapQ });
  const create = calls.find(call => call.kind === 'createBox');
  const approval = calls.find(call => call.kind === 'approve');
  const transaction = { chainId, from: inputs.creator, to: create.to, value: create.value.toString(), data: create.data };
  return { format: 'squarehole.example-unsigned/1', example: example.id, evidenceBlock: blockNumber.toString(),
    transaction, approval: approval ? { token: approval.to, spender: inputs.factory, amount: payment.toString(), data: approval.data } : null,
    spec, encoded, specHash: keccak256(encoded), predicted, starter,
    creatorPolicy: example.creator ?? null,
    ...(local ? { localFiles: { directory: local.directory, settings, reveal: `${local.directory}/reveal.json`, secret: `${local.directory}/secret.json` } } : {}),
    instructions: ['Review and simulate this exact call at the current head before signing. No transaction has been sent.',
      'Send from the specified creator; a Safe executes the factory call itself. Approve only the exact payment, then clear approval.',
      'Load committed metadata/text chunks and any pile seed or shop seed/starter set before the gate opens.',
      ...(example.creator ? ['Register the Safe itself with the holder ledger. Claims require the holder; no pushed payouts.'] : [])] };
}

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-mainnet') { assert.ok(!options.allowMainnet, 'duplicate flag'); options.allowMainnet = true; continue; }
    if (arg === '--generate-hidden-art') { assert.ok(!options.generateHiddenArt, 'duplicate flag'); options.generateHiddenArt = true; continue; }
    const key = { '--example': 'example', '--chain-id': 'chainId', '--inputs': 'inputs', '--out': 'out', '--rpc': 'rpc', '--settings': 'settings' }[arg];
    assert.ok(key, 'unknown option'); assert.ok(!options[key] && args[i + 1] && !args[i + 1].startsWith('--'), 'missing or duplicate option');
    options[key] = args[++i];
  }
  for (const key of ['example', 'chainId', 'inputs', 'out', 'rpc']) assert.ok(options[key], `--${key} required`);
  assertChain(options.chainId, options.allowMainnet);
  const url = new URL(options.rpc); assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'public RPC URL required');
  return options;
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const example = loadExamples().find(e => e.id === options.example); assert.ok(example, 'unknown example');
    const inputs = inputSchema.parse(JSON.parse(readFileSync(options.inputs, 'utf8')));
    const client = createPublicClient({ transport: http(options.rpc, { retryCount: 0 }) });
    const plan = await prepareExample(example, inputs, { ...options, client, settingsText: options.settings ? readFileSync(options.settings, 'utf8') : undefined });
    writeFileSync(options.out, stringify(plan) + '\n', { flag: 'wx' });
    console.warn('Unsigned example transaction written. Review, simulate and sign separately.');
  } catch (error) {
    // Never echo caller input, credential-bearing URLs, file contents, RPC errors or filesystem paths.
    console.error(error instanceof HiddenArtInputError ? error.message
      : 'Example preparation refused. Check public inputs, chain, --allow-mainnet and output availability.'); process.exitCode = 1;
  }
}
