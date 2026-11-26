import './register-ts.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { decodeFunctionData, decodeAbiParameters, encodeAbiParameters, erc20Abi, erc721Abi, keccak256, parseAbi, toHex, zeroHash, zeroAddress } from 'viem';
import { buildExampleSpec, stringify } from './create-example-v2.mjs';
import { loadExamples } from '../../box-spec/examples/v2/registry.mjs';
const { encodeBoxSpecV2, decodeBoxSpecV2 } = await import('../../box-spec/src/generated/box-spec.v2.ts');
import { buildInfrastructure, buildKitPack, writeTemplates, writePack, KIT_IDS } from './sepolia-launch-pack.mjs';
import { factoryV2Abi, starterSetLoaderV2Abi, shopVaultV2Abi, pileVaultV2Abi } from '../src/core/v2/abi-v2.ts';

const { Resvg } = createRequire(new URL('../../cards/package.json', import.meta.url))('@resvg/resvg-js');
const { encodeBoxMetadataTable } = await import('../../artwork/src/box-commitment.ts');
const addr = n => toHex(BigInt(n), { size: 20 });
const coins = Object.fromEntries(['tLINK', 'tUSDC', 'tNVDA', 'tGOLD', 'tPEPE', 'tFROG'].map((s, i) => [s, addr(i + 100)]));
const poolAbi = parseAbi(['function seed((address coin,uint160 sqrtPriceX96,int24 tickLower,int24 tickUpper,uint256 amount0Max,uint256 amount1Max,uint256 deadline) s) payable returns (uint128)']);
const examples = loadExamples();
function fixture(id) {
  const e = examples.find(e => e.id === id);
  const native = e.priceCoin.symbol === 'ETH';
  const listing = { id: native ? '0' : '8', token: native ? zeroAddress : addr(100), decimals: e.priceCoin.decimals, class: native ? '1' : '5', kind: '1', raise: native ? '100000000000000000' : id === 'link-marines-v2' ? '100000000000000000000' : e.priceCoin.decimals === '6' ? '100000000' : '1000000000000000000' };
  const bootstrapQ = ((BigInt(listing.raise) * 1500000000000000n + 4206980085000000000n - 1n) / 4206980085000000000n).toString();
  const inputs = { art: { metadataTable: toHex(encodeBoxMetadataTable({ description: 'Test metadata', traitTypes: [] })),
    revealRoot: toHex(1n, { size: 32 }), generatorHash: zeroHash, revealListId: e.contents.art.mode === 'hidden' ? zeroHash : toHex(2n, { size: 32 }) }, creator: addr(1), factory: addr(2), listingId: listing.id,
    assets: { USDC: listing.token, TEST_GOLD: addr(101) }, alchemistId: '7',
    collections: Object.fromEntries(['bent-cans', 'lost-cogs', 'split-boots', 'cracked-mugs', 'tangled-wires'].map((s, i) => [s, addr(i + 10)])) };
  const bound = { ...listing, id: Number(listing.id), decimals: Number(listing.decimals), class: Number(listing.class), kind: 1, burnSelector: '0x42966c68', raise: BigInt(listing.raise) };
  const { spec } = buildExampleSpec(e, inputs, bound, 10n ** 17n, BigInt(bootstrapQ));
  const picture = (role, file) => {
    const bytes = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><image width="128" height="128" href="data:image/png;base64,${readFileSync(file).toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render().asPng();
    return { role, sha256: `0x${createHash('sha256').update(bytes).digest('hex')}`, base64: bytes.toString('base64') };
  };
  const sourceSettings = id === 'junkyard' ? JSON.parse(readFileSync('examples/boxes/junkyard/settings/junkyard-boxspec-v2.json')) : null;
  const logo = sourceSettings?.pictures.find(p => p.role === 'logo') ?? picture('logo', e.logo);
  spec.coverSha256 = logo.sha256;
  const pictures = [logo];
  if (e.contents.kind === 'collection') {
    const cover = picture('collection cover', e.contents.art.source); spec.collectionCoverSha256 = cover.sha256; pictures.push(cover);
  }
  const encoded = encodeBoxSpecV2(spec);
  const settingsText = stringify({ format: 'squarehole.boxspec/2', spec, encoded, specHash: keccak256(encoded),
    pictures, revealList: null });
  return { id, chainId: '11155111', settingsText, inputs, listing: { ...listing, burnSelector: '0x42966c68' }, bootstrapQ, nativeRaise: '100000000000000000', evidenceBlock: '42',
    cs: zeroHash, hs: zeroHash, roles: { coordinator: addr(20), token: addr(21), vault: addr(22),
      ...(e.contents.kind === 'shop' ? { starterLoader: addr(23) } : {}),
      ...(Object.values(e.fees).some(s => ['holders', 'holders-t'].includes(s.choice)) ? { holderLedger: addr(24) } : {}) } };
}

/** A small binary glTF 2.0 file (a header and a JSON chunk, no geometry), as Create's reader takes one. TEST DATA ONLY. */
function testGlb(json) {
  const text = Buffer.from(JSON.stringify(json));
  const length = Math.ceil(text.length / 4) * 4;
  const out = Buffer.alloc(20 + length, 0x20);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(length, 12); out.writeUInt32LE(0x4e4f534a, 16); text.copy(out, 20);
  return out;
}
/** A `models` entry as Create's Download BoxSpec writes it. */
const modelEntry = bytes => ({ type: 'model/gltf-binary', sha256: `0x${createHash('sha256').update(bytes).digest('hex')}`, base64: bytes.toString('base64') });

test('offline infrastructure emits nineteen platform calls, eighteen pool calls, and six probe transfers', () => {
  const p = buildInfrastructure({ coins, helper: addr(50), owner: addr(51), deadline: '2000000000' });
  assert.equal(p.listings.transactions.length, 19);
  assert.equal(p.pools.length, 18);
  assert.equal(p.transfers.length, 6);
  for (let i = 0; i < 6; i++) {
    const [approval, seed, clear] = p.pools.slice(i * 3, i * 3 + 3);
    const decoded = decodeFunctionData({ abi: poolAbi, data: seed.data });
    assert.equal(seed.value, '1000000000000000000');
    assert.equal(decoded.args[0].amount0Max, 10n ** 18n);
    assert.equal(approval.from, addr(51));
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approval.data }).args, [addr(50), decoded.args[0].amount1Max]);
    assert.equal(decodeFunctionData({ abi: erc20Abi, data: clear.data }).args[1], 0n);
    assert.equal(decodeFunctionData({ abi: erc20Abi, data: p.transfers[i].data }).args[1], 10000n);
  }
  assert.throws(() => buildInfrastructure({ coins, helper: addr(50), owner: addr(51), deadline: 2000000000 }), /decimal/);
});

test('all thirteen requests use v2; open collections use L1 build downloads and post-create reveals', () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = `${mkdtempSync('.cache/tmp/l3-template-')}/packs`;
  writeTemplates(dir);
  assert.equal(KIT_IDS.length, 13);
  assert.ok(KIT_IDS.includes('link-marines-v2'));
  assert.ok(KIT_IDS.includes('lake-house'), 'SH-LAKE-HOUSE: the thirteenth kit');
  assert.ok(!KIT_IDS.includes('link-marines'));
  for (const id of KIT_IDS) {
    const request = JSON.parse(readFileSync(`${dir}/${id}/request.json`));
    assert.equal(request.id, id);
    assert.equal(request.settingsFile, null);
    assert.equal(request.status, 'inputs-required');
    assert.equal(request.protocol, 'v2');
    const open = examples.find(e => e.id === id).contents.kind === 'collection' && !request.hidden;
    assert.equal(request.source, `examples/boxes/${id}/${open ? 'build' : 'settings'}/`);
    assert.equal(existsSync(`${dir}/${id}/open-reveals.json`), open);
  }
  const marines = JSON.parse(readFileSync(`${dir}/link-marines-v2/request.json`));
  assert.equal(marines.inputs.factory, '0xFAe1E6CFF43CAdcBE01885BdD0AA6218263de393');
  assert.equal(marines.listing.symbol, 'tLINK');
  assert.equal(marines.listing.raise, '100000000000000000000');
  assert.equal(marines.listing.class, '5');
  assert.equal(marines.hidden, false);
  const dragon = JSON.parse(readFileSync(`${dir}/dragons-hoard/request.json`));
  assert.deepEqual(dragon.inputs.assets, {}, 'native seed needs no asset binding');
  assert.throws(() => writeTemplates(dir), /exist/i);
});

test('committed request folders equal the generator output byte for byte', () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = `${mkdtempSync('.cache/tmp/l3-fresh-')}/packs`;
  writeTemplates(dir);
  const files = root => readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile()).map(e => `${e.parentPath.slice(root.length + 1)}/${e.name}`.replace(/^\//, '')).sort();
  const committed = 'packages/chain/scripts/sepolia-launch-packs';
  assert.deepEqual(files(dir), files(committed));
  for (const file of files(dir)) assert.equal(readFileSync(`${dir}/${file}`, 'utf8'), readFileSync(`${committed}/${file}`, 'utf8'), file);
});

test('four unique open plans require final downloads, exact publication and model-aware execution gates', async () => {
  const expected = [
    ['rent-free', '500', 'nonzero'], ['bag-holders', '420', 'nonzero'],
    ['link-marines-v2', '420', 'zero'], ['exit-liquidity', '404', 'zero'],
  ];
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = `${mkdtempSync('.cache/tmp/t05-plans-')}/packs`;
  writeTemplates(dir);
  let total = 0n, withModels = 0n, withoutModels = 0n;
  for (const [kit, itemCount, modelHashes] of expected) {
    const p = JSON.parse(readFileSync(`${dir}/${kit}/open-reveals.json`));
    assert.equal(p.kit, kit);
    assert.deepEqual(p.art, { kind: 'one-of-a-kind', itemCount, imageHashes: 'distinct', modelHashes,
      modelFormat: modelHashes === 'nonzero' ? 'GLB' : null, animationUrl: modelHashes === 'nonzero' ? 'required' : 'absent' });
    assert.equal(p.revealSends, itemCount);
    assert.equal(p.modelUploadTransactions, '0');
    assert.deepEqual(p.prepareArgs, ['--kit', kit]);
    assert.equal(p.source, 'created-box-download');
    assert.equal(p.box, null);
    assert.equal(p.senderSheet, null);
    assert.equal(p.status, 'after-creation-required');
    assert.deepEqual(p.gas, { status: 'fresh-simulation-required', totalGas: null, maxFeePerGasWei: null, fundingWei: null });
    assert.equal(p.calls, undefined, 'never fabricate final calldata');
    assert.equal(p.revealListId, undefined, 'never substitute template commitments');
    const steps = p.sequence.join('\n');
    for (const gate of [/FINAL/, /fresh salts/, /canonical.*SHA-256.*revealListId/, /template CAR/, /six.*model/, /Simulate/, /bigint/, /receipts/, /traits.*image.*model.*animation_url/, /finalized.*cursor/, /T01\/T02/, /T04/, /step 7.*sender/]) assert.match(steps, gate);
    const compiled = (await buildKitPack(fixture(kit))).openReveals;
    assert.deepEqual(compiled, { ...p, box: addr(20) });
    total += BigInt(itemCount);
    if (modelHashes === 'nonzero') withModels += BigInt(itemCount);
    else withoutModels += BigInt(itemCount);
  }
  assert.deepEqual([total, withModels, withoutModels], [1744n, 920n, 824n]);
});

test('Junkyard batches approve each NFT to the vault, load, fund exact seed, complete and register the Safe', async () => {
  const f = fixture('junkyard');
  const p = await buildKitPack(f);
  const create = p.create.transactions.find(t => t.data.startsWith('0x') && t.to === f.inputs.factory);
  const spec = decodeFunctionData({ abi: factoryV2Abi, data: create.data }).args[0];
  assert.equal(spec.creatorBuy, 71278844301225191n);
  assert.equal(p.create.transactions.length, 4, 'zero, exact factory approval, create, clear');
  const ts = p.afterCreate.transactions;
  assert.equal(ts.filter(t => t.kind === 'approveNFT').length, 10);
  for (const t of ts.filter(t => t.kind === 'approveNFT')) assert.equal(decodeFunctionData({ abi: erc721Abi, data: t.data }).args[0], f.roles.vault);
  const load = ts.find(t => t.kind === 'loadStarter');
  assert.equal(load.to, f.roles.starterLoader);
  assert.equal(decodeFunctionData({ abi: starterSetLoaderV2Abi, data: load.data }).args[1].length, 10);
  assert.equal(ts.find(t => t.kind === 'fundSeed').data, '0x' + keccak256(toHex('fundSeed()')).slice(2, 10));
  assert.equal(decodeFunctionData({ abi: shopVaultV2Abi, data: ts.find(t => t.kind === 'fundSeed').data }).functionName, 'fundSeed');
  assert.ok(ts.findIndex(t => t.kind === 'fundSeed') < ts.findIndex(t => t.kind === 'complete'));
  assert.equal(ts.at(-1).to, f.roles.holderLedger);
  assert.equal(ts.at(-1).data, '0x1aa3a008'); // register()
  const approvals = ts.filter(t => t.to === f.roles.token);
  assert.deepEqual(approvals.map(t => decodeFunctionData({ abi: erc20Abi, data: t.data }).args[1]), [0n, 180000000000000000000000000n, 0n]);
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = `${mkdtempSync('.cache/tmp/l3-pack-')}/junkyard`;
  writePack(dir, p, f.settingsText);
  assert.equal(readFileSync(`${dir}/settings.json`, 'utf8'), f.settingsText);
  assert.ok(existsSync(`${dir}/buy-v2.json`) && existsSync(`${dir}/verify.json`));
});

test('One Dollar seeds exactly one tUSDC; Dragon seeds native ETH; Alchemist starts empty', async () => {
  for (const id of ['one-dollar', 'dragons-hoard', 'the-alchemist']) {
    const f = fixture(id);
    const p = await buildKitPack(f);
    const load = p.afterCreate.transactions.find(t => t.kind === 'loadSeed');
    if (id === 'the-alchemist') { assert.equal(load, undefined); continue; }
    assert.equal(decodeFunctionData({ abi: pileVaultV2Abi, data: load.data }).functionName, 'loadSeed');
    assert.equal(load.value, id === 'one-dollar' ? '0' : '1000000000000000000');
    if (id === 'one-dollar') assert.deepEqual(p.afterCreate.transactions.filter(t => t.kind === 'approve').map(t => decodeFunctionData({ abi: erc20Abi, data: t.data }).args[1]), [0n, 1000000n, 0n]);
  }
});

test('SH-LAKE-HOUSE: a Safe creates an empty tUSDC pile with both fee sides To the pile; nothing follows the create batch', async () => {
  const f = fixture('lake-house');
  const request = JSON.parse(readFileSync('packages/chain/scripts/sepolia-launch-packs/lake-house/request.json', 'utf8'));
  assert.deepEqual([request.listing.symbol, request.listing.decimals, request.listing.class, request.listing.raise], ['tUSDC', '6', '3', '100000000']);
  assert.deepEqual(request.inputs.assets, { USDC: null }, 'the pile coin is bound like the price coin');
  assert.deepEqual(Object.keys(request.roles), ['coordinator', 'token', 'vault'], 'a pile: no holder ledger, no starter loader');
  assert.deepEqual(request.pileSeed, { symbol: 'USDC', amount: '0' });
  const p = await buildKitPack(f);
  assert.equal(p.listing.symbol, 'tUSDC');
  // Zero the price allowance, approve exactly the bootstrap (no creator buy), create, zero it again: four Safe calls.
  assert.deepEqual(p.create.transactions.map(t => t.kind), ['approve', 'approve', 'createBox', 'approve']);
  assert.equal(p.create.meta.createdFromSafeAddress, f.inputs.creator);
  const approvals = p.create.transactions.filter(t => t.kind === 'approve');
  for (const t of approvals) assert.equal(t.to, f.listing.token);
  assert.deepEqual(approvals.map(t => decodeFunctionData({ abi: erc20Abi, data: t.data }).args), [[f.inputs.factory, 0n], [f.inputs.factory, BigInt(f.bootstrapQ)], [f.inputs.factory, 0n]]);
  assert.equal(f.bootstrapQ, '35656', 'a 100 tUSDC raise bootstraps 0.035656 tUSDC');
  const create = p.create.transactions[2];
  assert.deepEqual([create.to, create.value], [f.inputs.factory, '0']);
  const spec = decodeFunctionData({ abi: factoryV2Abi, data: create.data }).args[0];
  assert.deepEqual([spec.boxType, spec.tokenName, spec.tokenSymbol, spec.creatorBuy, spec.n], [5, 'Lake House', 'HOUSE', 0n, 0]);
  for (const side of [spec.buyers, spec.sellers]) assert.deepEqual([side.a.leg, side.a.dest, side.split], [1, 7, 1], 'To the pile');
  const [asset, seed, leave] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], spec.contentsParams);
  assert.deepEqual([asset, seed, leave], [f.listing.token, 0n, 0], 'the pile is the price coin, empty, nothing left behind');
  // No seed to load and no holder ledger to join: the launch window opens at createBox itself.
  assert.deepEqual(p.afterCreate.transactions, []);
  assert.equal(p.afterCreate.meta.createdFromSafeAddress, f.inputs.creator);
  assert.deepEqual(p.starter, []);
  assert.equal(p.openReveals, null);
  assert.equal(p.verify.roles.vault, f.roles.vault);
  assert.equal(p.verify.roles.holderLedger, undefined);
  assert.equal(p.buy.amountIn, '1600000000');
  // The registry's zero seed is only for a pile both sides feed: the same recipe with Burn on one side is refused.
  const row = structuredClone(examples.find(e => e.id === 'lake-house'));
  row.fees.sellers = { choice: 'burn' };
  await assert.rejects(async () => buildExampleSpec(row, f.inputs, { ...f.listing, id: 8, decimals: 6, class: 3, kind: 1, raise: 100000000n }, 10n ** 17n, 35656n), /seed/);
});

test('pack refuses stale settings, missing shop roles and wrong chain', async () => {
  const f = fixture('junkyard');
  await assert.rejects(buildKitPack({ ...f, chainId: '1' }), /Sepolia/);
  await assert.rejects(buildKitPack({ ...f, roles: { ...f.roles, holderLedger: undefined } }), /holder/);
  await assert.rejects(buildKitPack({ ...f, listing: { ...f.listing, raise: '2000000000000000000' } }), /listing/);
  await assert.rejects(buildKitPack({ ...f, settingsText: f.settingsText.replace('squarehole.boxspec/2', 'wrong') }), /settings/);
  const s = JSON.parse(f.settingsText); s.spec.creatorBuy = '3000000000000000000';
  await assert.rejects(buildKitPack({ ...f, settingsText: stringify(s) }), /settings/);
});

test('keyless post-launch check pins reads and requires graduation plus a fresh complete keeper view', async () => {
  const { checkLaunch } = await import('./sepolia-launch-pack-check.mjs');
  const p = await buildKitPack(fixture('junkyard'));
  const seen = [];
  const state = { ...p.verify, registry: addr(25), token: p.verify.roles.token, q: p.verify.priceCoin, gateOpen: true, failed: false, graduated: true };
  const client = { getChainId: async () => 11155111, getBlock: async () => ({ number: 100n, timestamp: 2000n }), getCode: async () => '0x1234',
    readContract: async q => { seen.push(q); return q.functionName === 'roleAddress'
      ? state.roles[Object.keys(p.verify.roleNumbers).find(k => BigInt(p.verify.roleNumbers[k]) === q.args[0])]
      : state[q.functionName]; } };
  const keeper = { schema: 'squarehole.monitor-keeper.v1', chainId: '11155111', identity: `11155111:${addr(51)}:${addr(25)}:`, observedAt: '1999', block: '100', complete: true, drand: { complete: true }, queue: { count: '0' } };
  assert.equal((await checkLaunch(p.verify, client, keeper)).status, 'graduated');
  assert.ok(seen.every(q => q.blockNumber === 100n));
  state.graduated = false;
  await assert.rejects(checkLaunch(p.verify, client, keeper), /graduated/);
  state.graduated = true;
  await assert.rejects(checkLaunch(p.verify, client, { ...keeper, complete: false }), /keeper/);
  await assert.rejects(checkLaunch(p.verify, client, { ...keeper, observedAt: '1699' }), /stale/);
  await assert.rejects(checkLaunch(p.verify, client, { ...keeper, observedAt: '2001' }), /future/);
});

test('settings reject extra private fields and role aliases before producing Safe calls', async () => {
  const f = fixture('one-dollar');
  const s = JSON.parse(f.settingsText); s.secret = { seed: 'private-marker' };
  await assert.rejects(buildKitPack({ ...f, settingsText: stringify(s) }), /settings fields/);
  await assert.rejects(buildKitPack({ ...f, roles: { ...f.roles, token: f.roles.vault } }), /distinct/);
});

test('SH-CREATE-ITEM-MODELS: models only beside the public list that names them; never in hidden, token or list-free files', async () => {
  const model = modelEntry(testGlb({ asset: { version: '2.0' }, extras: { item: 1 } }));
  for (const [id, pattern] of [['frog-kiln', /hidden settings must not publish item models/], ['gpu-poor', /settings models must be the reveal list/],
    ['one-dollar', /settings models must be the reveal list/], ['rent-free', /settings models must be the reveal list/]]) {
    const f = fixture(id);
    // Each fixture file is as before (no models key) and compiles; the same file with one model is refused.
    await buildKitPack(f);
    await assert.rejects(buildKitPack({ ...f, settingsText: stringify({ ...JSON.parse(f.settingsText), models: [model] }) }), pattern, id);
  }
});

test('all thirteen v2 packs compile their recipe, exact settings, chunk loads and quote budgets', async () => {
  for (const id of KIT_IDS) {
    const f = fixture(id), p = await buildKitPack(f);
    assert.equal(p.buy.amountIn, (BigInt(f.listing.raise) * 16n).toString());
    assert.equal(p.verify.specHash, JSON.parse(f.settingsText).specHash);
    assert.equal(p.buy.protocol, 'v2');
    assert.equal(p.buy.tool, 'packages/chain/scripts/buy-v2.mjs');
    const e = examples.find(e => e.id === id);
    assert.equal(p.openReveals !== null, e.contents.kind === 'collection' && e.contents.art.mode === 'open');
    if (examples.find(e => e.id === id).contents.kind === 'collection') {
      assert.ok(p.afterCreate.transactions.some(t => t.kind === 'loadChunk'), id);
    }
  }
});

test('Link Marines v2 compiles the actual L1 format-2 public recipe through approval, create, load, buy and reveal preparation', async () => {
  const { buildKit, settingsText } = await import('../../../scripts/kits/settings.mjs');
  const f = fixture('link-marines-v2');
  const kit = await buildKit('link-marines-v2', { owner: f.inputs.creator,
    priceListing: { id: f.listing.id, token: f.listing.token, raise: f.listing.raise } });
  f.settingsText = settingsText(kit);
  const settings = JSON.parse(f.settingsText);
  assert.ok(settings.revealList, 'L1 includes the public reveal list');
  const p = await buildKitPack(f);
  assert.equal(p.listing.symbol, 'tLINK');
  assert.deepEqual(p.create.transactions.map(t => t.kind), ['approve', 'approve', 'createBox', 'approve']);
  const approvals = p.create.transactions.filter(t => t.kind === 'approve');
  for (const t of approvals) assert.equal(t.to, f.listing.token);
  assert.deepEqual(approvals.map(t => decodeFunctionData({ abi: erc20Abi, data: t.data }).args),
    [[f.inputs.factory, 0n], [f.inputs.factory, BigInt(f.bootstrapQ)], [f.inputs.factory, 0n]]);
  const create = p.create.transactions[2];
  assert.equal(create.to, f.inputs.factory);
  assert.equal(create.value, '0');
  const decoded = decodeFunctionData({ abi: factoryV2Abi, data: create.data });
  assert.equal(decoded.functionName, 'createBox');
  const spec = decoded.args[0];
  assert.equal(encodeBoxSpecV2(spec), settings.encoded);
  assert.deepEqual([spec.format, spec.version, spec.boxType, spec.artMode, spec.n], [2, 2, 1, 1, 420]);
  for (const side of [spec.buyers, spec.sellers]) assert.deepEqual([side.a.leg, side.a.dest, BigInt(side.a.destParams)], [1, 8, 3n]);
  assert.ok(p.afterCreate.transactions.length > 0);
  assert.ok(p.afterCreate.transactions.every(t => t.kind === 'loadChunk' && t.to === f.roles.coordinator));
  assert.equal(p.buy.amountIn, '1600000000000000000000');
  assert.equal(p.buy.box, f.roles.coordinator);
  assert.equal(p.buy.protocol, 'v2');
  assert.equal(p.openReveals.tool, 'packages/chain/scripts/reveal-open-v2.ts');
  assert.equal(p.openReveals.box, f.roles.coordinator);
  assert.equal(p.openReveals.source, 'created-box-download');
  assert.equal(p.openReveals.status, 'after-creation-required');
  assert.match(p.openReveals.sequence.join('\n'), /specHash.*revealRoot.*revealListId/);
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = `${mkdtempSync('.cache/tmp/l3b-marines-')}/pack`;
  writePack(dir, p, f.settingsText);
  assert.equal(readFileSync(`${dir}/settings.json`, 'utf8'), f.settingsText);
  assert.deepEqual(JSON.parse(readFileSync(`${dir}/open-reveals.json`)), p.openReveals);
  // SH-CREATE-ITEM-MODELS: a 2D kit's file carries no model; one added is no model its list commits.
  const glb = testGlb({ asset: { version: '2.0' }, extras: { kit: 'link-marines-v2' } });
  await assert.rejects(buildKitPack({ ...f, settingsText: stringify({ ...settings, models: [modelEntry(glb)] }) }), /settings models must be the reveal list/);
});

// SH-CREATE-ITEM-MODELS (R74-ART): the two 3D kits' actual L1 files, a GLB per NFT, built by the kit builder through
// Create's reader and commitment (scripts/kits/settings.mjs), compile as the runbook's --inputs step runs them; the
// same file without its models, with one model's bytes changed or with one left out is refused before any Safe call.
test('Rent Free and Bag Holders compile their actual L1 3D settings, a GLB per NFT, and refuse them without their models', async () => {
  const { buildKit, settingsText } = await import('../../../scripts/kits/settings.mjs');
  for (const id of ['rent-free', 'bag-holders']) {
    const f = fixture(id);
    const kit = await buildKit(id, { owner: f.inputs.creator, priceListing: { id: f.listing.id, token: f.listing.token, raise: f.listing.raise } });
    assert.deepEqual(kit.unresolved, [], id);
    f.settingsText = settingsText(kit);
    const settings = JSON.parse(f.settingsText);
    assert.deepEqual(Object.keys(settings), ['format', 'specHash', 'encoded', 'spec', 'pictures', 'models', 'revealList']);
    const listed = settings.revealList.items.map(item => item.modelSha256);
    assert.equal(listed.length, Number(settings.spec.n));
    assert.ok(listed.every(hash => hash !== zeroHash), 'a model for every NFT');
    assert.deepEqual(settings.models.map(m => m.sha256), [...new Set(listed)].sort());
    const p = await buildKitPack(f);
    assert.equal(p.verify.specHash, settings.specHash);
    const create = p.create.transactions.find(t => t.kind === 'createBox');
    assert.equal(encodeBoxSpecV2(decodeFunctionData({ abi: factoryV2Abi, data: create.data }).args[0]), settings.encoded);
    assert.equal(p.openReveals.art.modelHashes, 'nonzero');
    assert.equal(p.openReveals.art.itemCount, String(settings.spec.n));
    const refused = (patch, pattern) => assert.rejects(buildKitPack({ ...f, settingsText: stringify({ ...settings, ...patch }) }), pattern);
    await refused({ models: undefined }, /settings models must be the reveal list/);
    await refused({ models: settings.models.slice(1) }, /settings models must be the reveal list/);
    const [first, second] = settings.models;
    await refused({ models: [{ ...first, base64: second.base64 }, ...settings.models.slice(1)] }, /settings model hash/);
  }
});

test('hidden kits retain L1 placeholder text and artwork without relaxing economic add-ons', async () => {
  const f = fixture('frog-kiln');
  const settings = JSON.parse(f.settingsText);
  const spec = decodeBoxSpecV2(settings.encoded);
  const types = Array.from({ length: 5 }, () => ({ type: 'string' }));
  const placeholder = spec.addOns.find(a => a.id === 1);
  const values = [...decodeAbiParameters(types, placeholder.params)];
  values[2] = 'The kiln opens when a toad is drawn.';
  values[3] = 'L1 reviewed hidden description.';
  placeholder.params = encodeAbiParameters(types, values);
  settings.spec = spec;
  settings.encoded = encodeBoxSpecV2(spec);
  settings.specHash = keccak256(settings.encoded);
  const p = await buildKitPack({ ...f, settingsText: stringify(settings) });
  assert.equal(p.verify.specHash, settings.specHash);
  spec.addOns.push({ id: 4, params: encodeAbiParameters([{ type: 'uint16' }, { type: 'uint8' }], [100, 1]) });
  settings.encoded = encodeBoxSpecV2(spec);
  settings.specHash = keccak256(settings.encoded);
  await assert.rejects(buildKitPack({ ...f, settingsText: stringify(settings) }), /unexpected settings add-on/);
});
