#!/usr/bin/env node
/**
 * SH-300: the second chain-97 release (the ten-minute shop), rehearsed on a fork of the REAL test network, and the
 * writer of the site's files with two releases. Run from packages/contracts:
 *
 *   node --experimental-transform-types script/bnb/short-wait.mjs rehearse [--port 8574] [--out <dir>]
 *   node --experimental-transform-types script/bnb/short-wait.mjs check --rpc-url <url> --factory <second factory>
 *   node --experimental-transform-types script/bnb/short-wait.mjs files --rpc-url <url> --factory <second factory>
 *        --start-block <its first block> [--commit <the source commit, 40 hex>] [--out <dir>] [--write-repo]
 *   node --experimental-transform-types script/bnb/short-wait.mjs parse --rpc-url <url>
 *        the site's own parser (parseCoreManifestV2) and SH-258's chain check on the repository's
 *        deployments/core-v1/97.json; prints {"ok": ..., "releases": n} and exits non-zero when either refuses
 *
 * check prints {"ok": ..., "checks": [...]} (44 points, plus two per linked library: every part's code against this folder's build, each linked library's address and code, the wiring, the reused addresses) and exits non-zero when any point fails.
 *
 * rehearse: an anvil fork of chain 97 that mines a block every second (so the chain's clock is the real clock: nothing
 * is warped), the deploy wallet impersonated at its real nonce and balance. It runs what the real run sends:
 *   1. the second release (DeployCoreV2BnbShortWait) through the driver's extra hook;
 *   2. its six listings (BnbTestnetSetup.runListings: the same coins and raises as the first release);
 *   3. sixteen new starter cards (ids 9 to 12 of each of the four live card collections, minted to the deploy wallet);
 * and then, as the life script will on the real chain, a card shop box on the second release whose shop opens gives
 * ten minutes after creation: create, load (starter set, seed), graduate (past the launch window, waited for in real
 * time), a pick; a give refused before the ten minutes and accepted after them (waited for, not warped).
 * Never a key: the fork's sender is impersonated. Writes result.json, the files and the gas into --out.
 */
import '../../../chain/scripts/register-ts.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS, DEPLOYER, ROOT, rpc, runStep, saveState } from './bnb-testnet.mjs';
import { TIERS, artifact, create, graduate, json, load, pick, roles } from './card-shop.mjs';
import { makeChain, nodeSender, stateStore } from '../../../chain/scripts/bnb-boxes/chain.mjs';

const require = createRequire(join(ROOT, 'packages/chain/package.json'));
const { encodeAbiParameters, encodeFunctionData, getAddress, keccak256 } = require('viem');
const { buildKit, settingsText, starterEntries } = await import('../../../../scripts/kits/settings.mjs');
const { readExampleSettings } = await import('../../../chain/scripts/create-example-v2-settings.mjs');
const { encodeBoxSpecV2 } = await import('../../../box-spec/src/generated/box-spec.v2.ts');
const { shopConfigV2, shopConfigV2Parameters } = await import('../../../chain/src/core/v2/m2-spec-v2.ts');

export const FORK_URL = 'https://bsc-testnet-rpc.publicnode.com';
export const SHORT_WAIT = 600n;
/** The four live card collections (SH-262's stock on chain 97; owner: the deploy wallet). */
export const CARDS = Object.freeze({ 'common-cards': '0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174',
  'uncommon-cards': '0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577', 'rare-cards': '0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC',
  'legendary-cards': '0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143' });
/** The new box's starter cards: these ids of each collection (the live box holds ids 1 to 4, testers 5 to 8). */
export const STARTER_IDS = Object.freeze([9n, 10n, 11n, 12n]);
export const RELEASE_STEP = 'extra:script/bnb/DeployCoreV2BnbShortWait.s.sol:DeployCoreV2BnbShortWait:run(address,address,address,address,address)';
const C5 = '(address,address,address,address,address)';
export const LISTINGS_STEP = `extra:script/bnb/BnbTestnetSetup.s.sol:BnbTestnetSetup:runListings(address,${C5},(uint256,uint256,uint256,uint256,uint256,uint256))`;
export const CARDS_STEP = 'extra:script/bnb/ShortWaitCards.s.sol:ShortWaitCards:run(address[4],address,uint256[4])';
/** The first release's six raises (raw units), the second release's too. */
export const RAISES = Object.freeze({ native: 10n ** 15n, usdc: 1_000_000n, nvda: 10n ** 15n, gold: 10n ** 15n, pepe: 10n ** 15n, teth: 10n ** 17n });
const tuple = values => `(${values.join(',')})`;
const hex = n => `0x${BigInt(n).toString(16)}`;
const delay = ms => new Promise(done => setTimeout(done, ms));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The live first release, from the repository's approved files (read only). */
export function liveState() {
  const s = JSON.parse(readFileSync(join(ROOT, 'hackathon/rehearsals/real-97-state-steps-1-8.json'), 'utf8'));
  return { chainId: 97, deployer: DEPLOYER, dependencies: s.dependencies, coins: s.coins };
}

export const releaseArgs = s => [s.dependencies.manager, s.dependencies.weth, s.dependencies.drand, s.dependencies.firstFee, s.dependencies.platform];
export const listingArgs = (s, factory) => [factory, tuple(['usdc', 'nvda', 'gold', 'pepe', 'teth'].map(k => s.coins[k])),
  tuple([RAISES.native, RAISES.usdc, RAISES.nvda, RAISES.gold, RAISES.pepe, RAISES.teth])];
export const cardArgs = to => [`[${TIERS.map(k => CARDS[k]).join(',')}]`, to, `[${STARTER_IDS.join(',')}]`];

/**
 * The card shop box's settings on the second release: the kit's card shop (its own serializer) bound to the second
 * factory and tUSDC, then three changes: the shop's wait is ten minutes, the starter set is ids 9 to 12 of each tier
 * (its ordered hash recomputed as the loader checks it), and the name and ticker given (lane d's choice on the real chain).
 */
export async function shortWaitSettings({ factory, usdc, nativeRaise, name, ticker }) {
  const kit = await buildKit('card-shop', { owner: DEPLOYER, nativeRaise: String(nativeRaise),
    priceListing: { id: '1', token: getAddress(usdc), raise: String(RAISES.usdc) },
    collections: Object.fromEntries(TIERS.map(k => [k, getAddress(CARDS[k])])) });
  assert.deepEqual(kit.unresolved, [], 'every binding resolved');
  const spec = readExampleSettings(settingsText(kit));
  const shop = shopConfigV2(spec.contentsParams);
  const items = TIERS.flatMap((k, tier) => STARTER_IDS.map(id => ({ collection: getAddress(CARDS[k]), id, tier })));
  const entries = starterEntries(items);
  const patched = { ...spec, tokenName: name, tokenSymbol: ticker,
    contentsParams: encodeAbiParameters(shopConfigV2Parameters, [{ ...shop, listDelay: Number(SHORT_WAIT) }]),
    addOns: spec.addOns.map(a => (a.id === 8 ? { id: 8, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [entries[0].hash, items.length]) } : a)) };
  assert.equal(shopConfigV2(patched.contentsParams).listDelay, Number(SHORT_WAIT));
  return { spec: patched, specHash: keccak256(encodeBoxSpecV2(patched)), factory: getAddress(factory), creator: DEPLOYER,
    starter: items, cards: Object.fromEntries(TIERS.map(k => [k, getAddress(CARDS[k])])) };
}

function scratch(path) {
  const p = resolve(path);
  if (![join(ROOT, '.cache'), join(ROOT, 'hackathon', 'rehearsals')].some(r => p.startsWith(r + sep))) throw new Error(`${p}: under .cache/ or hackathon/rehearsals/ only`);
  return p;
}

async function startFork(port, out) {
  const fd = openSync(join(out, 'anvil.log'), 'a');
  // --block-time 1: a block every second at the wall clock's time, so waiting is real time on this chain too.
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--fork-url', FORK_URL, '--chain-id', '97',
    '--hardfork', 'osaka', '--block-time', '1', '--retries', '20', '--timeout', '60000', '--silent'], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error('anvil exited');
    try { if (BigInt(await rpc(url, 'eth_chainId')) === 97n) return { child, url }; } catch { /* starting */ }
    await delay(200);
  }
  throw new Error('anvil readiness');
}

async function rehearse(o) {
  const port = Number(o.port ?? 8574);
  const out = scratch(o.out ?? join(ROOT, '.cache/short-wait', `fork-${Date.now()}`));
  mkdirSync(out, { recursive: true });
  const result = { started: new Date().toISOString(), complete: false };
  const { child, url } = await startFork(port, out);
  const log = (step, text) => writeFileSync(join(out, `${step.replace(/[^A-Za-z0-9_-]+/g, '_')}.log`), text);
  const s = liveState();
  const ctx = { url, signer: ['--unlocked'], log, broadcastRoot: join(out, 'broadcast'), save: st => saveState(join(out, 'driver-state.json'), st) };
  const nonce = async () => BigInt(await rpc(url, 'eth_getTransactionCount', [DEPLOYER, 'latest']));
  const balance = async () => BigInt(await rpc(url, 'eth_getBalance', [DEPLOYER, 'latest']));
  const now = async () => BigInt((await rpc(url, 'eth_getBlockByNumber', ['latest', false])).timestamp);
  try {
    assert.ok((await rpc(url, 'web3_clientVersion')).startsWith('anvil/'), 'anvil only');
    result.forkBlock = BigInt(await rpc(url, 'eth_blockNumber')).toString();
    await rpc(url, 'anvil_impersonateAccount', [DEPLOYER]);
    result.deployerAtStart = { nonce: (await nonce()).toString(), balance: (await balance()).toString() };
    const costs = {};
    const measure = async (name, fn) => {
      const [n0, b0] = [await nonce(), await balance()];
      const value = await fn();
      costs[name] = { transactions: (await nonce() - n0).toString(), tBNB: (b0 - await balance()).toString() };
      return value;
    };
    // 1. The second release.
    const startBlock = BigInt(await rpc(url, 'eth_blockNumber')) + 1n;
    await measure('release', () => runStep(RELEASE_STEP, s, { extraArgs: releaseArgs(s) }, ctx));
    const factory = s.extra[RELEASE_STEP].factory;
    result.release = { factory, startBlock: startBlock.toString() };
    result.releaseCheck = await checkRelease(url, factory);
    // 2. Its six listings.
    await measure('listings', () => runStep(LISTINGS_STEP, s, { extraArgs: listingArgs(s, factory) }, ctx));
    // 3. The sixteen new starter cards.
    await measure('cards', () => runStep(CARDS_STEP, s, { extraArgs: cardArgs(DEPLOYER) }, ctx));
    // 4. The site's files with both releases (staged; the rehearsal never writes the repository's).
    await rpc(url, 'anvil_mine', [hex(200n)]);
    result.files = await writeTwoReleases({ url, factory, startBlock, out: join(out, 'files'), publish: false });
    // 5. The box (the life script's steps on the real chain), on the second release, with the clock as it runs.
    const store = stateStore(join(out, 'card-shop-state.json'));
    const chain = makeChain({ url, sender: nodeSender(url), store, clock: 'wait', log: line => writeFileSync(join(out, 'life.log'), `${line}\n`, { flag: 'a' }) });
    const listings = JSON.parse(readFileSync(result.files.staged.manifest, 'utf8')).releases[1].listingRegistry.address;
    const settings = await shortWaitSettings({ factory, usdc: s.coins.usdc, nativeRaise: RAISES.native, name: 'Rehearsal Quick Cards', ticker: 'QCARD' });
    result.box = await measure('box', async () => {
      const made = await create(chain, settings, DEPLOYER);
      await load(chain, settings, DEPLOYER);
      await graduate(chain, settings, DEPLOYER, { swapper: s.dependencies.swapper });
      return made;
    });
    const r = await roles(chain, result.box.box);
    const V = artifact('ShopVaultV2');
    const [, , activeAt] = await chain.read(r.vault, V, 'collectionTerms', [CARDS['common-cards']]);
    result.box.activeAt = activeAt.toString();
    result.box.listedAt = (activeAt - SHORT_WAIT).toString();
    result.box.listingRegistry = listings;
    // 6. A pick (the shop is open after graduation; no wait).
    await measure('pick', () => pick(chain, settings, DEPLOYER, { card: 'common-cards', id: 9n }));
    // 7. The give: refused while the ten minutes run, accepted after them (the fork's clock is the wall clock).
    const C = artifact('TestTradingCards');
    const giveData = encodeFunctionData({ abi: V, functionName: 'give', args: [CARDS['common-cards'], 9n, 0n] });
    const early = await now();
    result.give = { triedAt: early.toString(), activeAt: activeAt.toString() };
    if (early < activeAt) {
      await chain.act('short-wait:give-approve', () => chain.send(DEPLOYER, CARDS['common-cards'], C, 'approve', [r.vault, 9n]).then(x => x.transactionHash));
      result.give.earlyRefused = await rpc(url, 'eth_call', [{ from: DEPLOYER, to: r.vault, data: giveData }, 'latest']).then(() => false, () => true);
      assert.ok(result.give.earlyRefused, 'a give before the ten minutes is refused');
      while (await now() < activeAt) await delay(5_000);
    } else {
      await chain.act('short-wait:give-approve', () => chain.send(DEPLOYER, CARDS['common-cards'], C, 'approve', [r.vault, 9n]).then(x => x.transactionHash));
    }
    const before = await chain.read(r.token, artifact('BoxTokenV2'), 'balanceOf', [DEPLOYER]);
    await measure('give', () => chain.act('short-wait:give', () => chain.sendRaw({ from: DEPLOYER, to: r.vault, data: giveData, value: 0n,
      gas: 15_000_000n, label: 'give' }).then(x => x.transactionHash)));
    const paid = await chain.read(r.token, artifact('BoxTokenV2'), 'balanceOf', [DEPLOYER]) - before;
    assert.ok(same(await chain.read(CARDS['common-cards'], C, 'ownerOf', [9n]), r.vault), 'the card is back in the shop');
    result.give = { ...result.give, givenAt: (await now()).toString(), paidT: paid.toString() };
    result.costs = costs;
    result.deployerAtEnd = { nonce: (await nonce()).toString(), balance: (await balance()).toString() };
    // The whole fork state at the end, for another lane's stand (anvil --load-state takes this file's JSON).
    if (o.dump) writeFileSync(scratch(o.dump), JSON.stringify(await rpc(url, 'anvil_dumpState', [])));
    result.complete = true;
  } catch (error) {
    result.error = String(error.stack ?? error);
  } finally {
    if (child.exitCode === null) child.kill('SIGINT');
    writeFileSync(join(out, 'result.json'), json(result));
  }
  process.stdout.write(`${result.complete ? 'SHORT-WAIT REHEARSAL COMPLETE' : 'SHORT-WAIT REHEARSAL FAILED'} -> ${out}\n`);
  if (!result.complete) { process.stdout.write(`${result.error}\n`); process.exitCode = 1; }
}

// ---- The files with two releases.

const castTool = async (...args) => {
  const { execFile } = await import('node:child_process');
  return new Promise((done, fail) => execFile('cast', args, { env: { PATH: process.env.PATH, HOME: process.env.HOME } },
    (error, stdout) => (error ? fail(error) : done(stdout.trim()))));
};
const words = data => data.slice(2).match(/.{64}/g) ?? [];
const wordAddress = w => `0x${w.slice(24)}`;
const IMPLEMENTATIONS = { 0: 'coordinator', 1: 'token', 2: 'hook', 3: 'vault', 4: 'collection', 5: 'receiver', 6: 'launchRouter',
  7: 'tickets', 8: 'royaltyRouter', 16: 'itemLedger', 17: 'holderLedger', 19: 'starterSetLoader', 20: 'tokenLedger', 21: 'shopVault', 22: 'pileVault' };
const CLASSES = ['NONE', 'NATIVE', 'STANDARD', 'STABLE', 'STOCK', 'OTHER'];
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;

/**
 * The second release read at ONE finalized block, in the same shape as the first (bnb-testnet.mjs `readFiles`), and
 * the site's files: core-v1/97.json with releases [first, second] (the first copied byte for byte from the committed
 * file), 97-extras.json with every existing key unchanged and `secondRelease` added, the second factory's create-options
 * data. Checked with SH-258's parser and on-chain check (both releases) before anything is published.
 */
export async function writeTwoReleases({ url, factory, startBlock, out, publish, commit = null }) {
  // Nothing is written for a release that fails lane c's release check.
  const failed = (await checkRelease(url, factory)).filter(c => !c.ok);
  if (failed.length) throw new Error(`the release check fails, nothing written: ${failed.map(c => c.what).join('; ')}`);
  // The files are read at the endpoint's finalized block: wait (at most five minutes) until that block holds the
  // second release with its six listings.
  for (let i = 0; ; i++) {
    const fin = (await rpc(url, 'eth_getBlockByNumber', ['finalized', false])).number;
    const has = (await rpc(url, 'eth_getCode', [factory, fin])).length > 2;
    let rows = 0n;
    if (has) {
      const reg = wordAddress(words(await rpc(url, 'eth_call', [{ to: factory, data: await castTool('calldata', 'listingRegistry()') }, fin]))[0]);
      rows = BigInt(await rpc(url, 'eth_call', [{ to: reg, data: await castTool('calldata', 'listingCount()') }, fin]));
    }
    if (has && rows >= 6n) break;
    if (i >= 60) throw new Error('the finalized block does not hold the second release with six listings after five minutes');
    await delay(5_000);
  }
  const block = await rpc(url, 'eth_getBlockByNumber', ['finalized', false]);
  const n = BigInt(block.number); const tag = hex(n);
  const at = async (to, sig, ...args) => rpc(url, 'eth_call', [{ to, data: await castTool('calldata', sig, ...args.map(String)) }, tag]);
  const addr = async (to, sig, ...args) => wordAddress(words(await at(to, sig, ...args))[0]);
  const uint = async (to, sig, ...args) => BigInt(`0x${words(await at(to, sig, ...args))[0]}`);
  const str = async (to, sig) => { const w = words(await at(to, sig)); const len = Number(BigInt(`0x${w[1]}`)); return Buffer.from(w.slice(2).join('').slice(0, len * 2), 'hex').toString('utf8'); };
  const entry = async address => {
    const code = await rpc(url, 'eth_getCode', [address, tag]);
    if (!code || code === '0x') throw new Error(`no code at ${address} in block ${n}`);
    return { address: address.toLowerCase(), codeHash: await castTool('keccak', code) };
  };
  if ((await rpc(url, 'eth_getCode', [factory, hex(startBlock - 1n)])).length > 2) throw new Error('the second factory existed before its start block');
  const implementations = {};
  for (const [role, name] of Object.entries(IMPLEMENTATIONS)) implementations[name] = await entry(await addr(factory, 'implementation(uint256)', role));
  implementations.hookExtension = await entry(await addr(implementations.hook.address, 'extension()'));
  const registry = await entry(await addr(factory, 'registry()'));
  const listingRegistry = await entry(await addr(factory, 'listingRegistry()'));
  const versionCodeHash = `0x${words(await at(factory, 'versionCodeHash()'))[0]}`;
  const directory = await entry(wordAddress(words(await at(implementations.receiver.address, 'receiverCode()'))[2]));
  const safe = async address => {
    const e = await entry(address);
    return { ...e, version: '1.4.1', singleton: e.address, singletonCodeHash: e.codeHash,
      owners: words(await at(address, 'getOwners()')).slice(2).map(wordAddress), threshold: (await uint(address, 'getThreshold()')).toString(),
      guard: ZERO, guardCodeHash: ZERO_HASH, handler: ZERO, handlerCodeHash: ZERO_HASH, modulesEnabled: false,
      controlTransferProof: 'BNB Chain testnet: BnbTestnetCustody, a holding contract owned by the deployer; not a Safe' };
  };
  const safes = { fit: await safe(await addr(implementations.receiver.address, 'FIT_SAFE()')),
    platform: await safe(await addr(implementations.receiver.address, 'PLATFORM_SAFE()')) };
  const second = { version: 2, factory: await entry(factory), registry, listingRegistry, feeModuleDirectory: directory, safes,
    startBlock: startBlock.toString(), implementations, versionCodeHash };

  const committed = {
    manifest: join(CONTRACTS, 'deployments/core-v1/97.json'), extras: join(CONTRACTS, 'deployments/bnb-testnet/97-extras.json') };
  const firstText = readFileSync(committed.manifest, 'utf8');
  const first = JSON.parse(firstText);
  assert.equal(first.releases.length, 1, 'the committed manifest holds the first release only');
  assert.ok(!same(first.releases[0].factory.address, factory), 'a second factory');
  assert.ok(first.releases[0].implementations.shopVault.codeHash !== implementations.shopVault.codeHash, 'the second release has its own shop');
  // The first release byte for byte: its JSON text is cut out of the committed file and placed unchanged.
  const releasesAt = firstText.indexOf('"releases": [');
  const releaseZeroText = firstText.slice(firstText.indexOf('{', releasesAt), firstText.lastIndexOf(']'));
  const manifestObject = { ...first, evidence: { block: { number: n.toString(), hash: block.hash }, finality: 'finalized' },
    releases: [first.releases[0], second] };
  let manifestText = `${JSON.stringify(manifestObject, null, 2)}\n`;
  assert.ok(manifestText.includes(releaseZeroText.trimEnd().replace(/\s+$/, '')), 'the first release is unchanged byte for byte');

  const modules = [];
  const names = ['eat', 'holdersT', 'itemsT', 'pile'];
  for (let id = 0n; id < await uint(directory.address, 'count()'); id++) {
    const w = words(await at(directory.address, 'record(uint32)', id));
    modules.push({ id: Number(id), module: wordAddress(w[0]), codeHash: `0x${w[1]}`, readyAt: BigInt(`0x${w[2]}`).toString(),
      withdrawn: BigInt(`0x${w[3]}`) !== 0n, name: names[Number(id)] ?? null });
  }
  const listings = [];
  for (let id = 0n; id < await uint(listingRegistry.address, 'listingCount()'); id++) {
    const w = words(await at(listingRegistry.address, 'listing(uint32)', id));
    const token = wordAddress(w[1]);
    listings.push({ id: Number(id), token, symbol: BigInt(token) === 0n ? 'BNB' : await str(token, 'symbol()'),
      decimals: Number(BigInt(`0x${w[2]}`)), class: CLASSES[Number(BigInt(`0x${w[3]}`))], raise: BigInt(`0x${w[6]}`).toString(),
      bootstrapQ: BigInt(`0x${w[7]}`).toString(), batchMinQ: BigInt(`0x${w[8]}`).toString(), tipMaxQ: BigInt(`0x${w[9]}`).toString(),
      swapStepMinQ: BigInt(`0x${w[10]}`).toString() });
  }
  assert.equal(listings.length, 6, 'six listings on the second release');
  const extras = JSON.parse(readFileSync(committed.extras, 'utf8'));
  // Each row as the first release's: the same coin, symbol, decimals, class and raise (row 0 included).
  for (const [i, row] of listings.entries()) {
    const want = extras.listings[i];
    for (const k of ['id', 'symbol', 'decimals', 'class', 'raise']) assert.equal(String(row[k]), String(want[k]), `listing ${i} ${k} at block ${n}`);
    assert.ok(same(row.token, want.token), `listing ${i} token at block ${n}`);
  }
  assert.equal(extras.secondRelease, undefined, 'the committed extras have no second release yet');
  // The second release's source commit lives here (the manifest's release entries take no new key: the site's parser
  // is strict); the manifest's top-level gitCommit stays the first release's.
  const extrasObject = { ...extras, secondRelease: { ...(commit ? { gitCommit: commit } : {}), factory: second.factory.address, registry: registry.address,
    listingRegistry: listingRegistry.address, startBlock: second.startBlock,
    feeModuleDirectory: { ...directory, delaySeconds: (await uint(directory.address, 'DELAY()')).toString(), modules }, listings,
    shop: { implementation: implementations.shopVault.address, codeHash: implementations.shopVault.codeHash,
      listDelaysSeconds: ['600', '604800', '1209600', '2592000'] } } };
  const createOptions = { schema: 1, chainId: 97, factory: second.factory.address, registry: registry.address, versionCodeHash, revision: 1,
    off: [{ key: 'addon.1' }] };

  const dir = scratch(out); mkdirSync(dirname(dir), { recursive: true }); mkdirSync(dir, { recursive: false });
  const staged = { manifest: join(dir, 'core-v1/97.json'), extras: join(dir, 'bnb-testnet/97-extras.json'),
    createOptions: join(dir, `create-options/data/97/${createOptions.factory}.json`) };
  for (const p of Object.values(staged)) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(staged.manifest, manifestText);
  writeFileSync(staged.extras, `${JSON.stringify(extrasObject, null, 2)}\n`);
  writeFileSync(staged.createOptions, `${JSON.stringify(createOptions, null, 2)}\n`);
  const check = await checkTwo(url, staged, second);
  let published = null;
  if (publish) published = publishThree(staged, createOptions.factory);
  return { staged, check, published, evidence: n.toString() };
}

const chainReads = url => ({
  chainId: async () => Number(BigInt(await rpc(url, 'eth_chainId'))),
  blockHash: async b => (await rpc(url, 'eth_getBlockByNumber', [hex(b), false])).hash,
  codeHash: async (address, b) => castTool('keccak', await rpc(url, 'eth_getCode', [address, hex(b)])),
  call: async (address, view, _args, b) => wordAddress(words(await rpc(url, 'eth_call', [{ to: address, data: await castTool('calldata', `${view}()`) }, hex(b)]))[0]),
});

async function checkTwo(url, staged, second) {
  process.env.SH_TESTNET = 'bnb';
  const { parseCoreManifestV2 } = await import(join(ROOT, 'packages/chain/src/core/v2/manifest-v2.ts'));
  const { checkTestnetReleaseOnChain } = await import(join(ROOT, 'packages/chain/src/core/v2/testnet-release-check.ts'));
  const { parseCreateOptions } = await import(join(ROOT, 'packages/chain/src/create-options/schema.ts'));
  const manifest = parseCoreManifestV2(JSON.parse(readFileSync(staged.manifest, 'utf8')));
  assert.equal(manifest.releases.length, 2);
  const problems = await checkTestnetReleaseOnChain(manifest, chainReads(url));
  if (problems.length) throw new Error(`on-chain check: ${problems.join('; ')}`);
  const options = parseCreateOptions(readFileSync(staged.createOptions, 'utf8'), { chainId: 97, factory: second.factory.address,
    registry: second.registry.address, versionCodeHash: second.versionCodeHash });
  if (!options.ok) throw new Error(`create-options: ${options.reason}`);
  return { releases: 2, onChainProblems: problems, createOptions: 'parses for the second release, off: addon.1' };
}

/** All or nothing: each new file beside its place, then renamed in; on a failure the old files are put back. */
function publishThree(staged, factory) {
  const real = { manifest: join(CONTRACTS, 'deployments/core-v1/97.json'), extras: join(CONTRACTS, 'deployments/bnb-testnet/97-extras.json'),
    createOptions: join(ROOT, `packages/chain/src/create-options/data/97/${factory}.json`) };
  const tag = `${Date.now()}-${process.pid}`; const moved = [];
  try {
    for (const k of Object.keys(real)) { mkdirSync(dirname(real[k]), { recursive: true }); copyFileSync(staged[k], `${real[k]}.new-${tag}`); }
    for (const k of Object.keys(real)) {
      const had = existsSync(real[k]);
      if (had) renameSync(real[k], `${real[k]}.old-${tag}`);
      moved.push([k, had]);
      renameSync(`${real[k]}.new-${tag}`, real[k]);
    }
  } catch (error) {
    for (const [k, had] of moved.reverse()) { if (existsSync(real[k])) unlinkSync(real[k]); if (had) renameSync(`${real[k]}.old-${tag}`, real[k]); }
    for (const k of Object.keys(real)) if (existsSync(`${real[k]}.new-${tag}`)) unlinkSync(`${real[k]}.new-${tag}`);
    throw error;
  }
  for (const [k, had] of moved) if (had) unlinkSync(`${real[k]}.old-${tag}`);
  return real;
}

/**
 * The second release as the script must have built it, read on chain (no key, no send): every implementation role
 * non-zero with code (16, 21 and 22 named); the planner's validator byte for byte the variant's artifact (it has no
 * immutables); the shop implementation the variant's artifact with only its immutables differing; the royalty
 * router's minimum lot 0.05 BNB; the five reused addresses those of the first release's committed manifest.
 */
export async function checkRelease(url, factory) {
  const call = async (to, sig, ...args) => rpc(url, 'eth_call', [{ to, data: await castTool('calldata', sig, ...args.map(String)) }, 'latest']);
  const addr = async (to, sig, ...args) => wordAddress(words(await call(to, sig, ...args))[0]);
  const code = async at => rpc(url, 'eth_getCode', [at, 'latest']);
  const checks = [];
  // Every point is read and reported; the caller sees ok false (and a non-zero exit) when any one fails.
  const ok = (what, pass, detail = '') => { checks.push({ what, ok: Boolean(pass), ...(detail ? { detail } : {}) }); };
  const art = (name, file = `${name}.sol`) => JSON.parse(readFileSync(join(CONTRACTS, `out/${file.split('/').pop()}/${name}.json`), 'utf8')).deployedBytecode;
  /**
   * The code at `at` against this folder's build of `name`: the runtime bytes compared with the artifact's, the
   * immutables and any linked library's address zeroed at the artifact's own offsets on both sides (an immutable is a
   * constructor value, a link a library address: neither is part of the code's identity).
   */
  const libraryChecked = new Set();
  const sameCode = async (what, at, name, { library = false, file } = {}) => {
    const a = art(name, file);
    const onChain = (await code(at)).slice(2).toLowerCase();
    if (!onChain) { ok(`${what} is ${name}`, false, `${at}: no code`); return; }
    let live = onChain; let expected = a.object.slice(2).toLowerCase();
    const spans = Object.values(a.immutableReferences ?? {}).flat();
    // A deployed library starts with PUSH20 <its own address> (the call guard): the artifact holds zeros there.
    if (library && expected.startsWith(`73${'0'.repeat(40)}`)) spans.push({ start: 1, length: 20 });
    const linked = [];
    for (const [file, libs] of Object.entries(a.linkReferences ?? {})) {
      for (const [lib, refs] of Object.entries(libs)) {
        spans.push(...refs);
        // The library's address as the deployed code holds it, at the artifact's own link offsets (all the same).
        const addresses = new Set(refs.map(({ start }) => `0x${onChain.slice(start * 2, (start + 20) * 2)}`));
        linked.push({ file, lib, addresses: [...addresses] });
      }
    }
    for (const { start, length } of spans) {
      const zero = '0'.repeat(length * 2);
      live = live.slice(0, start * 2) + zero + live.slice((start + length) * 2);
      expected = expected.slice(0, start * 2) + zero + expected.slice((start + length) * 2);
    }
    ok(`${what} is ${name}`, live.length > 0 && live === expected, `${at}${linked.length ? `, ${linked.length} linked librar${linked.length === 1 ? 'y' : 'ies'} checked below` : ''}`);
    // Each linked library: one address at every offset, and the code there is that library's artifact.
    for (const { file, lib, addresses } of linked) {
      const where = addresses[0];
      ok(`${name} links ${lib} at one address`, addresses.length === 1, addresses.join(', '));
      const key = `${where.toLowerCase()}:${lib}`;
      if (addresses.length !== 1 || libraryChecked.has(key)) continue;
      libraryChecked.add(key);
      await sameCode(`${name}'s library ${lib}`, where, lib, { library: true, file });
    }
  };
  const ROLE_ARTIFACTS = { 0: 'BoxCoordinatorV2', 1: 'BoxTokenV2', 2: 'BoxHookV2', 3: 'BoxVaultV2', 4: 'BoxCollectionV2', 5: 'BoxReceiverV2',
    6: 'BoxLaunchRouterV2', 7: 'BoxTicketsV2', 8: 'BoxRoyaltyRouterV2', 16: 'ItemLedgerV2', 17: 'HolderLedgerV2', 19: 'StarterSetLoaderV2',
    20: 'BoxTokenV2Ledger', 21: 'ShopVaultV2ShortWait', 22: 'PileVaultV2' };
  const roles = {};
  for (const [role, name] of Object.entries(ROLE_ARTIFACTS)) {
    roles[role] = await addr(factory, 'implementation(uint256)', role);
    await sameCode(`implementation(${role})`, roles[role], name);
  }
  await sameCode('the factory', factory, 'BoxFactoryV2');
  const planner = await addr(factory, 'planner()');
  await sameCode('the planner', planner, 'BoxFactoryV2Planner');
  await sameCode('the planner\'s parts', await addr(planner, 'parts()'), 'BoxFactoryV2Parts');
  await sameCode('the factory\'s checks', await addr(factory, 'checks()'), 'BoxFactoryV2Checks');
  const registry = await addr(factory, 'registry()');
  await sameCode('the registry', registry, 'BoxRegistryV2');
  const listingRegistry = await addr(factory, 'listingRegistry()');
  await sameCode('the listing registry', listingRegistry, 'ListingRegistry');
  await sameCode('the hook\'s extension', await addr(roles[2], 'extension()'), 'BoxHookV2Extension');
  const receiverCode = words(await call(roles[5], 'receiverCode()')).map(wordAddress);
  await sameCode('the receiver\'s views', receiverCode[0], 'ReceiverViews');
  await sameCode('the receiver\'s extension', receiverCode[1], 'BoxReceiverV2Extension');
  const directory = receiverCode[2];
  await sameCode('the fee-module directory', directory, 'FeeModuleDirectoryV21');
  const MODULES = ['EatPriceCoinFeeModuleV21', 'HoldersTFeeModuleV21', 'ItemsTFeeModuleV21', 'PileFeeModuleV21'];
  const readyAts = [];
  for (let id = 0; id < 4; id++) {
    const w = words(await call(directory, 'record(uint32)', id));
    await sameCode(`fee module ${id}`, wordAddress(w[0]), MODULES[id]);
    readyAts.push(BigInt(`0x${w[2]}`));
  }
  const delay = BigInt(await call(directory, 'DELAY()'));
  ok('the directory holds four modules, all ready at one time, a day after the release', BigInt(await call(directory, 'count()')) === 4n
    && delay === 86_400n && readyAts.every(r => r === readyAts[0]), `ready at ${readyAts[0]} (${new Date(Number(readyAts[0]) * 1000).toISOString()})`);
  const validator = await addr(planner, 'validator()');
  const v = art('BoxSpecV2ValidatorShortWait');
  ok('the validator has no immutables and links no library', Object.keys(v.immutableReferences ?? {}).length === 0 && Object.keys(v.linkReferences ?? {}).length === 0);
  ok('the planner\'s validator is the ten-minute variant, byte for byte', (await code(validator)).toLowerCase() === v.object.toLowerCase(), validator);
  ok('the royalty minimum lot is 0.05 BNB', BigInt(await call(roles[8], 'minimumLot()')) === 5n * 10n ** 16n);
  const first = JSON.parse(readFileSync(join(CONTRACTS, 'deployments/core-v1/97.json'), 'utf8'));
  const r0 = first.releases[0];
  ok('poolManager', same(await addr(factory, 'poolManager()'), first.chain.poolManager.address));
  ok('weth', same(await addr(factory, 'weth()'), first.chain.weth.address));
  ok('randomness', same(await addr(factory, 'randomness()'), first.chain.randomness.address));
  ok('first fee holder', same(await addr(roles[5], 'FIT_SAFE()'), r0.safes.fit.address));
  ok('platform holder', same(await addr(roles[5], 'PLATFORM_SAFE()'), r0.safes.platform.address));
  // The wiring: each part names this release's own parts.
  ok('the registry names this factory', same(await addr(registry, 'factory()'), factory));
  ok('the coordinator names this factory', same(await addr(roles[0], 'factory()'), factory));
  ok('the listing registry\'s lister is the platform holder', same(await addr(listingRegistry, 'lister()'), r0.safes.platform.address));
  ok('the listing registry names this registry', same(await addr(listingRegistry, 'boxRegistry()'), registry));
  const owners = async at => words(await call(at, 'getOwners()')).slice(2).map(wordAddress).map(a => a.toLowerCase()).join(',');
  ok('the fit holder\'s owners are the first release\'s', (await owners(r0.safes.fit.address)) === r0.safes.fit.owners.join(','));
  ok('the platform holder\'s owners are the first release\'s', (await owners(r0.safes.platform.address)) === r0.safes.platform.owners.join(','));
  return checks;
}

async function check(o) {
  assert.equal(BigInt(await rpc(o['rpc-url'], 'eth_chainId')), 97n, 'chain 97');
  let checks;
  try { checks = await checkRelease(o['rpc-url'], getAddress(o.factory)); } catch (error) { checks = [{ what: 'the reads', ok: false, detail: String(error.message ?? error) }]; }
  const all = checks.every(c => c.ok);
  process.stdout.write(json({ ok: all, checks }));
  if (!all) process.exitCode = 1;
}

async function files(o) {
  const url = o['rpc-url'];
  const allowed = ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet-dataseed.bnbchain.org', 'https://bsc-testnet.bnbchain.org', 'https://bsc-prebsc-dataseed.bnbchain.org'];
  // A local proof (a loopback anvil) may write its own folder's copy of the files; a real run reads a public endpoint.
  const local = /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(String(url)) && (await rpc(url, 'web3_clientVersion')).startsWith('anvil/');
  if (o['write-repo'] && !allowed.includes(url) && !local) throw new Error(`--write-repo reads only from ${allowed.join(', ')} (or a local anvil proof)`);
  if (o['write-repo'] && o.out) throw new Error('--write-repo stages into a fresh folder of its own: no --out');
  if (o['write-repo']) assert.match(String(o.commit), /^[0-9a-f]{40}$/, '--write-repo records the source commit: --commit <40 hex>');
  else if (o.commit !== undefined) assert.match(String(o.commit), /^[0-9a-f]{40}$/, '--commit <40 hex>');
  assert.equal(BigInt(await rpc(url, 'eth_chainId')), 97n, 'chain 97');
  const r = await writeTwoReleases({ url, factory: getAddress(o.factory), startBlock: BigInt(o['start-block']),
    out: o.out ?? join(ROOT, '.cache/short-wait', `staging-${Date.now()}-${process.pid}`), publish: Boolean(o['write-repo']), commit: o.commit ?? null });
  process.stdout.write(json(r));
}

/** The site's parser and SH-258's chain check on the repository's manifest, as the site and the indexer read it. */
async function parse(o) {
  const url = o['rpc-url'];
  let out;
  try {
    process.env.SH_TESTNET = 'bnb';
    const { parseCoreManifestV2 } = await import(join(ROOT, 'packages/chain/src/core/v2/manifest-v2.ts'));
    const { checkTestnetReleaseOnChain } = await import(join(ROOT, 'packages/chain/src/core/v2/testnet-release-check.ts'));
    const manifest = parseCoreManifestV2(JSON.parse(readFileSync(join(CONTRACTS, 'deployments/core-v1/97.json'), 'utf8')));
    const problems = await checkTestnetReleaseOnChain(manifest, chainReads(url));
    out = { ok: problems.length === 0, releases: manifest.releases.length, evidence: manifest.evidence.block.number, problems };
  } catch (error) { out = { ok: false, refused: String(error.message ?? error) }; }
  process.stdout.write(json(out));
  if (!out.ok) process.exitCode = 1;
}

function parseFlags(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]; assert.ok(a.startsWith('--'), `unexpected ${a}`);
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) o[a.slice(2)] = args[++i]; else o[a.slice(2)] = true;
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { rehearse, files, check, parse };
  if (!commands[command]) { process.stderr.write('usage: short-wait.mjs rehearse|check|files|parse [--flags]\n'); process.exit(2); }
  commands[command](parseFlags(rest)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
}
