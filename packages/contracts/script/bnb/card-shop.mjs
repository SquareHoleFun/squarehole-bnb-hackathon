#!/usr/bin/env node
/**
 * SH-262, the card shop on chain 97: the settings step and the box's steps on lane d's chain (SH-261,
 * packages/chain/scripts/bnb-boxes/chain.mjs, imported): every transaction prepared here, sent once by its sender
 * (`castSender`: `cast send` from a keystore, explicit nonces, never below the network's price; a dry run's
 * `nodeSender` on a local fork, priced against the real endpoint), its hash kept in the state file before its receipt
 * is awaited; a step started again awaits what it sent and never sends it twice. Run from packages/contracts with
 * `node --experimental-transform-types --no-warnings=ExperimentalWarning script/bnb/card-shop.mjs`:
 *
 *   settings --driver-state <97-state.json> [--deployments <dir>] [--creator <0x>] [--out <new dir>]
 *       The Create settings file bound to the chain: factory from <deployments>/core-v1/97.json, listings 0 and 1 (tUSDC)
 *       from <deployments>/bnb-testnet/97-extras.json, the four card collections from the driver state's `extra`
 *       section (CardShopStock's printed lines). Writes card-shop-boxspec-v2.json, bindings.json and starter.json into a
 *       new folder. No chain read, no transaction.
 *   create   --creator <keystore>                 the tUSDC approval and createBox (the site's createPaymentCallsV2)
 *   load     --creator <keystore>                 seed and card approvals, loadStarter, fundSeed, complete
 *   graduate --buyer <keystore>                   after the launch window: buy the curve full, then graduate
 *   pick     --picker <keystore> --card <tier key> --id <n> [--to <0x>] [--payer <keystore>] [--operation <name>]
 *                                                 one card for exactly its pick price (the payer, if given, first sends
 *                                                 the picker exactly that price in CARD)
 *   every box step: --rpc <url>[,<url>...] --settings <dir> --state <file> [--password-dir <dir> | --password-file <path>]
 *                   [--keystore-dir <dir>] [--dry [--dry-port <port>]] [--local-proof [--unlocked]]
 *   settings also takes --release 0|1 (SH-300: 1 = the second release; default 0, the live first release)
 *   --unlocked (with --local-proof only): the roles' addresses impersonated on the loopback anvil, its clock waited for
 *
 * --rpc takes lane c's ALLOWED_RPCS (sends go to the first; reads fail over); --local-proof also takes a loopback node.
 * --dry starts a fork of the endpoint on a free port, lets the roles send there (a role may then be an address) and
 * prices every send against the real endpoint (refused below its eth_gasPrice); the real chain and the state file are
 * not touched. No key is ever read here: keystore names and password file paths go to cast unread.
 */
import '../../../chain/scripts/register-ts.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS, ROOT } from './bnb-testnet.mjs';
import { GAS, castEndpoint, castSender, isLoopback, keystoreRole, makeChain, nodeSender, roleAddress, rpc, setReadEndpoints, stateStore,
  usedNonces } from '../../../chain/scripts/bnb-boxes/chain.mjs';
import { freePort, startFork } from '../../../chain/scripts/bnb-boxes/local-chain.mjs';

const require = createRequire(join(ROOT, 'packages/chain/package.json'));
const { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, isAddress, keccak256, zeroAddress } = require('viem');
const { buildKit, settingsText } = await import('../../../../scripts/kits/settings.mjs');
const { readExampleSettings } = await import('../../../chain/scripts/create-example-v2-settings.mjs');
const { encodeBoxSpecV2 } = await import('../../../box-spec/src/generated/box-spec.v2.ts');
const { boxCurve } = await import('../../../box-spec/src/layout-v2.ts');
const { factoryV2Abi } = await import('../../../chain/src/core/v2/abi-v2.ts');
const { findCreateSaltsV2 } = await import('../../../chain/src/core/v2/create-salts.ts');
const { buildCreateCallsV2, createPaymentCallsV2 } = await import('../../../chain/src/core/v2/create-calls-v2.ts');
const { shopConfigV2 } = await import('../../../chain/src/core/v2/m2-spec-v2.ts');

export const TIERS = Object.freeze(['common-cards', 'uncommon-cards', 'rare-cards', 'legendary-cards']);
/** CardShopStock's printed names, per collection key. */
export const PRINTED = Object.freeze({ 'common-cards': 'cardsCommon', 'uncommon-cards': 'cardsUncommon', 'rare-cards': 'cardsRare', 'legendary-cards': 'cardsLegendary' });
export const STOCK_STEP = 'extra:script/bnb/CardShopStock.s.sol:CardShopStock:run(address,address)';
export const json = value => `${JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const artifact = name => JSON.parse(readFileSync(join(CONTRACTS, `out/${name}.sol/${name}.json`), 'utf8')).abi;
const swapperAbi = () => JSON.parse(readFileSync(join(CONTRACTS, 'out/HookGasKit.sol/PriceLimitSwapper.json'), 'utf8')).abi;
// Checksummed: the read-back files keep addresses in lower case, and the settings reader compares the spec it decodes
// (checksummed) with the file's spec text.
const address = (value, what) => { assert.ok(typeof value === 'string' && isAddress(value, { strict: false }) && !same(value, zeroAddress), `${what}: an address`); return getAddress(value); };

// ---- Settings: the kit tooling, bound to the chain's files. No chain read.

/** The four collections from the driver state's `extra` section (the stock step's printed lines). */
export function cardsFromDriverState(state) {
  const printed = state.extra?.[STOCK_STEP];
  assert.ok(printed, `the driver state has no ${STOCK_STEP} result: run the stock step first`);
  return Object.fromEntries(TIERS.map(key => [key, address(printed[PRINTED[key]], PRINTED[key])]));
}

/** The kit's public bindings from the deployment files and the four collections. */
export function bindingsFrom({ manifest, extras, cards, creator, release = 0 }) {
  assert.equal(manifest.chainId, 97); assert.equal(extras.chainId, 97);
  // SH-300: release 0 is the live first release (the default, unchanged); release 1 the second (its own listings).
  assert.ok(release === 0 || release === 1, 'release 0 or 1');
  const factory = address(manifest.releases?.[release]?.factory?.address, `the factory of release ${release}`);
  const rows = release === 0 ? extras.listings : extras.secondRelease?.listings;
  assert.ok(Array.isArray(rows), `the extras file has the listings of release ${release}`);
  if (release === 1) assert.ok(same(extras.secondRelease.factory, factory), 'the extras\' second release is the manifest\'s');
  const native = rows.find(l => l.id === 0); const usdc = rows.find(l => l.id === 1);
  assert.ok(native && same(native.token, zeroAddress), 'listing 0 is native BNB');
  assert.ok(usdc && usdc.symbol === 'tUSDC' && usdc.decimals === 6 && same(usdc.token, extras.coins.tUSDC.address), 'listing 1 is tUSDC');
  return { factory, bindings: { owner: address(creator, 'creator'), nativeRaise: native.raise,
    priceListing: { id: '1', token: address(usdc.token, 'tUSDC'), raise: usdc.raise }, collections: cards } };
}

/** Builds the bound Create settings file (Create's own serializer) and the ordered starter list. */
export async function buildSettings({ manifest, extras, cards, creator, release = 0 }) {
  const { factory, bindings } = bindingsFrom({ manifest, extras, cards, creator, release });
  const kit = await buildKit('card-shop', bindings);
  assert.deepEqual(kit.unresolved, [], 'every binding resolved');
  const text = settingsText(kit);
  const starter = kit.starter.map(item => ({ collection: item.collection, id: String(item.id), tier: item.tier }));
  return { text, specHash: keccak256(encodeBoxSpecV2(kit.spec)), factory, bindings, starter, creator: bindings.owner };
}

export function writeSettings(dir, built) {
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir); // a new folder only: an earlier settings folder is never overwritten
  writeFileSync(join(dir, 'card-shop-boxspec-v2.json'), built.text, { flag: 'wx' });
  writeFileSync(join(dir, 'bindings.json'), json({ factory: built.factory, creator: built.creator, specHash: built.specHash, ...built.bindings }), { flag: 'wx' });
  writeFileSync(join(dir, 'starter.json'), json(built.starter), { flag: 'wx' });
  return dir;
}

export function readSettingsDir(dir) {
  const text = readFileSync(join(dir, 'card-shop-boxspec-v2.json'), 'utf8');
  const bindings = JSON.parse(readFileSync(join(dir, 'bindings.json'), 'utf8'));
  const starter = JSON.parse(readFileSync(join(dir, 'starter.json'), 'utf8')).map(i => ({ collection: i.collection, id: BigInt(i.id), tier: Number(i.tier) }));
  const spec = readExampleSettings(text);
  const specHash = keccak256(encodeBoxSpecV2(spec));
  assert.equal(specHash, bindings.specHash, 'the settings file is the one the bindings name');
  // The collections come from the decoded spec (its shop config: collection and tier), never from bindings.json alone.
  const shop = shopConfigV2(spec.contentsParams);
  assert.equal(shop.collections.length, TIERS.length, 'four collections in the spec');
  const cards = Object.fromEntries(shop.collections.map((collection, i) => [TIERS[shop.tiers[i]], getAddress(collection)]));
  assert.deepEqual(Object.keys(cards).sort(), [...TIERS].sort(), 'one collection per tier in the spec');
  for (const key of TIERS) assert.ok(same(bindings.collections[key], cards[key]), `bindings.json names ${key} as the spec does`);
  // The starter list is checked against the spec's committed starter set before anything is sent: the site's own call
  // builder refuses a list whose ordered hash or count differs (roles here are placeholders; nothing is sent).
  const placeholder = n => `0x${n.toString(16).padStart(40, '0')}`;
  buildCreateCallsV2({ factory: getAddress(bindings.factory), spec, cs: `0x${'0'.repeat(64)}`, hs: `0x${'0'.repeat(64)}`, bootstrapQ: 0n, chainId: 97,
    creator: getAddress(bindings.creator), coordinator: placeholder(0xc0), vault: placeholder(0xc1), starterLoader: placeholder(0xc2), starterItems: starter });
  return { text, spec, specHash, bindings, starter, cards, factory: bindings.factory, creator: bindings.creator };
}

// ---- The box's steps on lane d's chain (`makeChain`): each a named action; reads that decide what to send are
// remembered, so a run started again repeats the same sends in the same order and the kept ones are only awaited.

const B = () => artifact('BoxCoordinatorV2'); const V = () => artifact('ShopVaultV2'); const T = () => artifact('BoxTokenV2');
const C = () => artifact('TestTradingCards'); const L = () => artifact('StarterSetLoaderV2'); const H = () => artifact('BoxHookV2');
const code = async (chain, at) => (await rpc(chain.url, 'eth_getCode', [at, 'latest'])).length > 2;
const tx = (chain, from, call, gas = call.kind === 'approve' ? GAS.approve : GAS.other) =>
  chain.sendRaw({ from, to: call.to, data: call.data, value: call.value ?? 0n, gas, label: call.kind });

/** The box's roles, read from the coordinator. */
export async function roles(chain, box) {
  return { box, token: await chain.read(box, B(), 'token'), vault: await chain.read(box, B(), 'roleAddress', [3]),
    loader: await chain.read(box, B(), 'starterSetLoader'), hook: await chain.read(box, B(), 'hook') };
}

/** The box this state file created. */
export const boxOf = chain => chain.store.data.done['card-shop:create']?.box ?? null;

/** Every command's first check: the box has code and holds exactly the spec of the settings this command was given. */
export async function boxHolds(chain, settings, box = boxOf(chain)) {
  assert.ok(box && await code(chain, box), 'no created box in the state file: create first');
  assert.equal(await chain.read(box, B(), 'specHash'), settings.specHash, `the box ${box} does not hold the spec of these settings`);
  return box;
}

/** Step 1, create: the price-coin approval and createBox, as the creator. */
export async function create(chain, settings, creator) {
  const result = await createAction(chain, settings, creator);
  await boxHolds(chain, settings, result.box); // also when the action's result was kept from an earlier run
  return result;
}
function createAction(chain, settings, creator) {
  return chain.act('card-shop:create', async () => {
    const { spec, specHash, factory } = settings;
    assert.ok(same(creator, settings.creator), 'the creator the settings name sends the creation');
    const plan = await chain.remember('plan', async () => {
      const q = await chain.read(factory, factoryV2Abi, 'boxQParameters', [spec.pricing.listingId, spec.raise]);
      const limit = await chain.read(factory, factoryV2Abi, 'tokenAddressLimit', [spec.pricing.token]);
      // Salts depend on the spec and creator only, so a run without this state file finds the same coordinator.
      const p = await findCreateSaltsV2({ priceToken: spec.pricing.token, tokenAddressLimit: limit,
        predictBox: cs => chain.read(factory, factoryV2Abi, 'predictBox', [creator, spec, cs]) });
      const payment = q.bootstrapQ + spec.creatorBuy;
      return { cs: p.cs, hs: p.hs, box: p.coordinator, bootstrapQ: q.bootstrapQ, payment, exists: await code(chain, p.coordinator),
        approved: await chain.read(spec.pricing.token, erc20Abi, 'allowance', [creator, factory]) === payment,
        holds: await chain.read(spec.pricing.token, erc20Abi, 'balanceOf', [creator]) >= payment };
    });
    let block = null;
    if (!plan.exists) {
      assert.ok(plan.holds, `the creator holds the payment (${plan.payment} raw)`);
      for (const call of createPaymentCallsV2({ factory, spec, cs: plan.cs, hs: plan.hs, bootstrapQ: plan.bootstrapQ })) {
        if (call.kind === 'approve' && plan.approved) continue;
        const receipt = await tx(chain, creator, call);
        if (call.kind === 'createBox') block = receipt.blockNumber;
      }
    }
    assert.equal(await chain.read(plan.box, B(), 'specHash'), specHash, 'the box holds exactly the settings file\'s spec');
    const createdAt = block === null ? null : (await chain.client.getBlock({ blockNumber: block })).timestamp;
    return { box: plan.box, specHash, bootstrapQ: plan.bootstrapQ, creatorBuyP: spec.creatorBuy, block, createdAt, alreadyCreated: plan.exists };
  });
}

/** Step 2, load: the seed approval, one approval per starter card still with the creator, then the site's
 * loadStarter, fundSeed and complete calls (buildCreateCallsV2), each only if the chain still lacked it. */
export async function load(chain, settings, creator) {
  await boxHolds(chain, settings);
  return chain.act('card-shop:load', async () => {
    const box = boxOf(chain);
    const r = await roles(chain, box);
    const shop = shopConfigV2(settings.spec.contentsParams);
    const plan = await chain.remember('plan', async () => {
      const [loaded, , notified] = await chain.read(r.loader, L(), 'progress');
      const seedReady = await chain.read(r.vault, V(), 'seedReady');
      const approvals = [];
      for (const item of settings.starter.slice(Number(loaded))) {
        if (!same(await chain.read(item.collection, C(), 'getApproved', [item.id]), r.vault)) approvals.push(`${item.collection}:${item.id}`);
      }
      return { gateOpen: await chain.read(box, B(), 'gateOpen'), loaded: Number(loaded), notified, seedReady, approvals,
        seedApproved: await chain.read(r.token, T(), 'allowance', [creator, r.vault]) === shop.seedT,
        holdsSeed: await chain.read(r.token, T(), 'balanceOf', [creator]) >= shop.seedT };
    });
    if (plan.gateOpen) return { ...r, alreadyLoaded: true };
    if (!plan.seedReady && !plan.seedApproved) {
      assert.ok(plan.holdsSeed, 'the creator holds the seed');
      await chain.send(creator, r.token, T(), 'approve', [r.vault, shop.seedT]);
    }
    for (const entry of plan.approvals) {
      const [collection, id] = entry.split(':');
      await chain.send(creator, collection, C(), 'approve', [r.vault, BigInt(id)]);
    }
    const calls = buildCreateCallsV2({ factory: settings.factory, spec: settings.spec, cs: `0x${'0'.repeat(64)}`, hs: `0x${'0'.repeat(64)}`, bootstrapQ: 0n,
      chainId: 97, creator, coordinator: box, vault: r.vault, starterLoader: r.loader, starterItems: settings.starter });
    let page = 0;
    for (const call of calls) {
      if (['approve', 'createBox', 'loadChunk'].includes(call.kind)) continue;
      if (call.kind === 'loadStarter' && page++ * 32 < plan.loaded) continue;
      if (call.kind === 'fundSeed' && plan.seedReady) continue;
      if (call.kind === 'complete' && plan.notified) continue;
      await tx(chain, creator, call);
    }
    assert.equal(await chain.read(box, B(), 'gateOpen'), true, 'the gate opened');
    return { ...r };
  });
}

/** Step 3, graduate: past the launch window, one buy through the deployment's swapper up to the curve's end price
 * (the exact approval first, the unused part cleared after), then graduate. */
export async function graduate(chain, settings, buyer, { swapper }) {
  await boxHolds(chain, settings);
  return chain.act('card-shop:graduate', async () => {
    const box = boxOf(chain);
    const hook = await chain.read(box, B(), 'hook');
    const plan = await chain.remember('plan', async () => ({ graduated: await chain.read(box, B(), 'graduated'),
      closed: await chain.read(hook, H(), 'closed'), windowEndsAt: await chain.read(hook, H(), 'windowEndsAt'), raise: await chain.read(box, B(), 'raise') }));
    if (plan.graduated) return { box, alreadyGraduated: true };
    await chain.mineTo(plan.windowEndsAt + 1n); // a local node's clock moves; the real chain's is waited for
    if (!plan.closed) {
      const key = await chain.read(hook, H(), 'poolKey');
      const p = key.currency0; assert.ok(!same(p, zeroAddress), 'a coin-priced box');
      const amount = plan.raise * 2n; // more than the curve takes: the end price stops the buy
      await chain.send(buyer, p, erc20Abi, 'approve', [swapper, amount]);
      await chain.send(buyer, swapper, swapperAbi(), 'swap', [key, true, -amount, boxCurve(plan.raise, false).sqrtPriceEndX96]);
      await chain.send(buyer, p, erc20Abi, 'approve', [swapper, 0n]);
      assert.ok(await chain.read(hook, H(), 'closed'), 'the curve is full');
    }
    await chain.send(buyer, box, B(), 'graduate', []);
    assert.ok(await chain.read(box, B(), 'graduated'), 'graduated');
    return { box };
  });
}

/**
 * Step 4, pick: one card out of the shop for exactly its pick price, as the picker, to `to`. Before any payment or
 * approval it reads that the box holds these settings' spec, that the vault holds the card, that another card stays
 * inside, and the vault's own terms. The operation is bound to the box, the picker, the receiver, the payer and the
 * full pick call; `operation` names a new pick of the same card (after it came back into the shop).
 */
export async function pick(chain, settings, picker, { card, id, to = picker, payer = null, operation = '1' }) {
  const box = await boxHolds(chain, settings);
  const r = await roles(chain, box);
  const collection = settings.cards[card]; assert.ok(collection, `unknown card collection ${card}`);
  assert.ok(!same(to, zeroAddress) && !same(to, r.vault), 'the receiver is a wallet, not the vault');
  const [, pickT, activeAt] = await chain.read(r.vault, V(), 'collectionTerms', [collection]);
  assert.ok(activeAt !== 0n && pickT > 0n, `${card} is listed in this shop`);
  const call = encodeFunctionData({ abi: V(), functionName: 'pick', args: [collection, BigInt(id), pickT, to] });
  const key = `card-shop:pick:${operation}:${keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }],
    [box, picker, to, payer ?? zeroAddress, call]))}`;
  if (!Object.hasOwn(chain.store.data.done, key) && !chain.store.data.memo[`${key}:plan`]) {
    // A new operation: the card must be in the vault and another card must stay inside, before anything is sent.
    assert.ok(same(await chain.read(collection, C(), 'ownerOf', [BigInt(id)]), r.vault), `${card} #${id} is not in the shop`);
    assert.ok(await chain.read(r.vault, V(), 'inside') > 1n, 'the shop keeps its last card');
  }
  return chain.act(key, async () => {
    const plan = await chain.remember('plan', async () => ({ pickT,
      short: await chain.read(r.token, T(), 'balanceOf', [picker]) < pickT,
      approved: await chain.read(r.token, T(), 'allowance', [picker, r.vault]) === pickT }));
    if (plan.short) {
      assert.ok(payer, `the picker holds less than the pick price (${plan.pickT}); name a --payer`);
      await chain.send(payer, r.token, T(), 'transfer', [picker, plan.pickT]);
    }
    if (!plan.approved) await chain.send(picker, r.token, T(), 'approve', [r.vault, plan.pickT]);
    await chain.sendRaw({ from: picker, to: r.vault, data: call, value: 0n, gas: GAS.other, label: 'pick' });
    assert.ok(same(await chain.read(collection, C(), 'ownerOf', [BigInt(id)]), to), 'the card went to its receiver');
    return { box, card, id: String(id), picker, to, payer, pickT: plan.pickT, operation };
  });
}

// ---- The command line.

function flags(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    assert.ok(args[i].startsWith('--'), `unexpected ${args[i]}`);
    const k = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) o[k] = args[++i]; else o[k] = true;
  }
  return o;
}
const say = line => process.stdout.write(`${line}\n`);

async function main(command, o) {
  if (command === 'settings') {
    const deployments = resolve(o.deployments ?? join(CONTRACTS, 'deployments'));
    const built = await buildSettings({ manifest: JSON.parse(readFileSync(join(deployments, 'core-v1/97.json'), 'utf8')),
      extras: JSON.parse(readFileSync(join(deployments, 'bnb-testnet/97-extras.json'), 'utf8')),
      cards: cardsFromDriverState(JSON.parse(readFileSync(resolve(o['driver-state']), 'utf8'))),
      creator: o.creator ?? '0x2EF9A78074bbf674bEA16f21154a30c821A3C576', release: o.release === undefined ? 0 : Number(o.release) });
    const dir = writeSettings(resolve(o.out ?? join(ROOT, '.cache/card-shop', `settings-${Date.now()}`)), built);
    say(json({ dir, specHash: built.specHash, factory: built.factory, collections: built.bindings.collections }));
    return;
  }
  const ROLES = { create: ['creator'], load: ['creator'], graduate: ['buyer'], pick: ['picker', ...(typeof o.payer === 'string' ? ['payer'] : [])] };
  assert.ok(ROLES[command], 'usage: card-shop.mjs settings|create|load|graduate|pick --flags (see the head comment)');
  for (const name of ['rpc', 'settings', 'state', ...ROLES[command]]) assert.ok(typeof o[name] === 'string', `--${name} is required`);
  const given = String(o.rpc).split(',').map(u => u.trim()).filter(Boolean);
  // As lane d's real.mjs: the local proof's endpoints are all loopback, checked before any endpoint is asked anything.
  if (o['local-proof'] === true) assert.ok(given.every(isLoopback), `--local-proof takes loopback endpoints only: ${given.join(', ')}`);
  const urls = [];
  for (const one of given) urls.push(await castEndpoint(one, { localProof: o['local-proof'] === true }));
  const url = urls[0];
  setReadEndpoints(urls, say);
  const keystore = { keystoreDir: typeof o['keystore-dir'] === 'string' ? resolve(o['keystore-dir']) : null,
    passwordFile: typeof o['password-file'] === 'string' ? o['password-file'] : null, passwordDir: typeof o['password-dir'] === 'string' ? resolve(o['password-dir']) : null };
  // SH-300 --unlocked: a local proof only (loopback anvil, with --local-proof): the roles are the wallets' addresses
  // (by keystore name from the fixed table below, or given), impersonated on that node; nothing is signed, no keystore
  // or password is touched, and the clock is the node's own (waited for, never moved).
  const UNLOCKED = { 'hack-deployer': '0x2EF9A78074bbf674bEA16f21154a30c821A3C576', 'hack-alice': '0x2908E3351ec8F20a8a6746773e42EA1D2FFb3c7F',
    'hack-bob': '0xc979F6Cb8902f56f76b926358dC451cBF8f310F0' };
  if (o.unlocked) {
    assert.ok(o['local-proof'] === true && !o.dry, '--unlocked goes with --local-proof (a loopback node) and never with --dry');
    assert.ok((await rpc(url, 'web3_clientVersion')).startsWith('anvil/'), '--unlocked: the node is anvil');
  }
  const roleOf = {};
  for (const role of ROLES[command]) {
    const name = o[role];
    if (o.unlocked) {
      const at = /^0x[0-9a-fA-F]{40}$/.test(name) ? name : UNLOCKED[name];
      assert.ok(at, `--unlocked: no address for ${name}`);
      roleOf[role] = { name, address: getAddress(at) };
      await rpc(url, 'anvil_impersonateAccount', [roleOf[role].address]);
      say(`${role}: ${name}, address ${roleOf[role].address} (impersonated on the local node)`);
      continue;
    }
    if (o.dry && /^0x[0-9a-fA-F]{40}$/.test(name)) { roleOf[role] = { name, address: getAddress(name) }; say(`${role}: address ${name} (dry run)`); continue; }
    const entry = keystoreRole(name, { ...keystore, requirePassword: !o.dry }); // a real signer needs its password file
    entry.address = await roleAddress(entry);
    roleOf[role] = entry;
    say(`${role}: keystore ${name}, address ${entry.address}`);
  }
  const settings = readSettingsDir(resolve(o.settings));
  const real = stateStore(resolve(o.state));
  let fork = null; let chain;
  if (o.unlocked) {
    chain = makeChain({ url, sender: nodeSender(url), store: real, clock: 'wait', log: say });
  } else if (o.dry) {
    const upstream = urls[1] ?? url;
    fork = await startFork({ forkUrl: upstream, port: o['dry-port'] ? Number(o['dry-port']) : await freePort() });
    for (const role of Object.values(roleOf)) await rpc(fork.url, 'anvil_impersonateAccount', [role.address]);
    const copy = stateStore(null);
    Object.assign(copy.data, copy.plain(real.data));
    chain = makeChain({ url: fork.url, sender: nodeSender(fork.url, { priceUrl: upstream }), store: copy, clock: 'warp', log: line => say(`[dry] ${line}`) });
    say(`dry run on a fork of ${upstream} (${fork.url}); nothing is sent to ${url}`);
  } else {
    chain = makeChain({ url, sender: castSender(url, Object.values(roleOf), { used: usedNonces(real.data), log: say }), store: real,
      clock: o['local-proof'] === true ? 'warp' : 'wait', log: say });
  }
  try {
    const a = role => roleOf[role].address;
    const result = command === 'create' ? await create(chain, settings, a('creator'))
      : command === 'load' ? await load(chain, settings, a('creator'))
        : command === 'graduate' ? await graduate(chain, settings, a('buyer'), { swapper: address(o.swapper ?? JSON.parse(readFileSync(join(CONTRACTS, 'deployments/bnb-testnet/97-extras.json'), 'utf8')).trade.swapper, 'swapper') })
          : await pick(chain, settings, a('picker'), { card: o.card, id: BigInt(o.id), to: typeof o.to === 'string' ? address(o.to, '--to') : a('picker'),
            payer: roleOf.payer?.address ?? null, operation: typeof o.operation === 'string' ? o.operation : '1' });
    say(json({ command, dry: Boolean(o.dry), result }));
  } finally { if (fork) fork.stop(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  main(command, flags(rest)).catch(error => { console.error(`card shop step stopped: ${error.stack ?? error}`); process.exit(1); });
}
