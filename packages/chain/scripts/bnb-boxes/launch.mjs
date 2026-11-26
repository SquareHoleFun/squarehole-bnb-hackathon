#!/usr/bin/env node
/**
 * SH-261: create a demo box on a LOCAL chain with id 97 through the code path of the site's Launch form, then read it
 * back against its settings sheet (readback.mjs). The steps are the page's own, in its order:
 *
 *   1. Load settings: `readSettingsFile`, `setupOf`, the options check of the file's spec, `finishLoad`, `buildSpecV2`
 *      for the connected creator, the options check again (LoadSettings.tsx);
 *   2. Create: `prepareCreateV2` at one pinned block, then `runCreateV2`, every step through the executor's creation
 *      entry point `submitCreateWriteV2` with `checkBeforeWallet` as its `createOptionsCheck` (CreateV2Flow.tsx,
 *      useCreateSend.ts).
 *
 * The wallet is the local node's unlocked account (`eth_sendTransaction`; no key is read or held here). The reads go
 * to the same node, as `rpcCreateReads` sends them. The price coin's listing rows are read from the chain's listing
 * registry (the page reads the same rows through the indexer). The create-options list is the release's file.
 *
 *   SH_TESTNET=bnb node packages/chain/scripts/bnb-boxes/launch.mjs --rpc http://127.0.0.1:8575 --files <dir> --settings <file>
 *     --creator <address> [--out <result.json>]
 *
 * `--files` holds the release's files as bnb-testnet.mjs writes them (core-v1/97.json, create-options/data/97/,
 * bnb-testnet/97-extras.json). Refuses any RPC that is not a loopback address.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import './ts.mjs';

if (process.env.SH_TESTNET !== 'bnb') throw new Error('run with SH_TESTNET=bnb: the build profile of chain 97');
const viem = await import('viem');
const { createPublicClient, erc20Abi, keccak256, parseEventLogs, toHex, TransactionNotFoundError, TransactionReceiptNotFoundError, zeroAddress } = viem;
const write = await import('../../../../packages/chain/src/write/index.ts');
const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const { sha256Hex } = await import('../../../../packages/artwork/src/index.ts');
const CREATE = '../../../../apps/web/src/features/create';
const load = await import(`${CREATE}/v2/load-settings.ts`);
const { commitArt, revealList, ZERO32 } = await import(`${CREATE}/create-model.ts`);
const { buildSpecV2, boxSpecFile } = await import(`${CREATE}/v2/model.ts`);
const artFiles = await import(`${CREATE}/art-files.ts`);
const send = await import(`${CREATE}/v2/create-send.ts`);
const options = await import(`${CREATE}/v2/create-options.ts`);
const { encodeBoxSpecV2 } = await import(`${CREATE}/v2/spec-types.ts`);
const { readBack } = await import('./readback.mjs');
const { stateStore, nodeSender, readTransport, resilientFetch, durableSend, reconcile, waitMined, lookup } = await import('./chain.mjs');

/** The directory ids of the module routes a spec names (The Alchemist: its side's destParams, a uint32). */
export function routeIdsOf(spec) {
  return [spec.buyers, spec.sellers].filter(side => Number(side.a.dest) === 9).map(side => Number(viem.decodeAbiParameters([{ type: 'uint32' }], side.a.destParams)[0]));
}

export const CHAIN_ID = 97;
const json = value => `${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`;

/**
 * The release's files: a folder as bnb-testnet.mjs `files` writes them (a rehearsal's: core-v1/97.json,
 * create-options/data/97/, bnb-testnet/97-extras.json), or the repository itself (the real chain's committed files:
 * packages/contracts/deployments/{core-v1,bnb-testnet}/ and packages/chain/src/create-options/data/97/).
 */
export function releaseFiles(dir) {
  const repo = !existsSync(join(dir, 'core-v1/97.json')) && existsSync(join(dir, 'packages/contracts/deployments/core-v1/97.json'));
  const path = repo
    ? { manifest: 'packages/contracts/deployments/core-v1/97.json', options: 'packages/chain/src/create-options/data/97', extras: 'packages/contracts/deployments/bnb-testnet/97-extras.json' }
    : { manifest: 'core-v1/97.json', options: 'create-options/data/97', extras: 'bnb-testnet/97-extras.json' };
  const manifest = JSON.parse(readFileSync(join(dir, path.manifest), 'utf8'));
  assert.equal(manifest.chainId, CHAIN_ID);
  assert.equal(manifest.releases.length, 1, 'one release');
  const release = manifest.releases[0];
  const optionsDir = join(dir, path.options);
  const optionsFile = readdirSync(optionsDir).find(file => file.toLowerCase() === `${release.factory.address.toLowerCase()}.json`);
  assert.ok(optionsFile, 'the release\'s create-options file');
  const extras = JSON.parse(readFileSync(join(dir, path.extras), 'utf8'));
  return { manifest, release, extras, extrasPath: join(dir, path.extras), createOptionsText: readFileSync(join(optionsDir, optionsFile), 'utf8') };
}

/** The node's reads as the page's `rpcCreateReads` makes them (useCreateSend.ts), over a loopback node. */
export function createReads(rpcUrl) {
  const client = createPublicClient({ transport: readTransport(rpcUrl), ccipRead: false, pollingInterval: 250 });
  return {
    client,
    reads: {
      chainId: () => client.getChainId(),
      blockNumber: () => client.getBlockNumber(),
      blockGasLimit: async () => (await client.getBlock()).gasLimit,
      read: (address, abi, functionName, args = [], blockNumber) => client.readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) }),
      code: async address => (await client.getCode({ address })) ?? '0x',
      estimateGas: r => client.estimateGas({ account: r.account, to: r.to, data: r.data, value: r.value }),
      receipt: async hash => {
        try { return (await client.getTransactionReceipt({ hash })).status; } catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
      },
      known: async hash => {
        try { await client.getTransaction({ hash }); return true; } catch (error) { if (error instanceof TransactionNotFoundError) return false; throw error; }
      },
      wait: async hash => (await client.waitForTransactionReceipt({ hash, timeout: 120_000 })).status,
      feeReader: write.createChainReader(write.createHttpRequest(rpcUrl, { fetch: resilientFetch, timeoutMs: 180_000, refusedRetries: 0 })),
    },
  };
}

/** The listing book as the Create page holds it (SiteListing rows), read from the release's listing registry. */
export async function siteListings(client, release) {
  const registry = release.listingRegistry.address;
  const count = await client.readContract({ address: registry, abi: coreV2.listingRegistryV2Abi, functionName: 'listingCount' });
  const rows = [];
  for (let id = 0; id < Number(count); id += 1) {
    const row = await client.readContract({ address: registry, abi: coreV2.listingRegistryV2Abi, functionName: 'listing', args: [id] });
    const native = row.token === zeroAddress;
    const symbol = native ? 'BNB' : await client.readContract({ address: row.token, abi: erc20Abi, functionName: 'symbol' });
    const q = await client.readContract({ address: release.factory.address, abi: coreV2.factoryV2Abi, functionName: 'boxQParameters', args: [row.id, row.raise] });
    rows.push({ id: Number(row.id), token: row.token, decimals: Number(row.decimals), class: Number(row.class), kind: Number(row.kind), raise: row.raise,
      bootstrap: q.bootstrapQ, listedAt: BigInt(row.listedAt), symbol, name: symbol, powers: [], eat: 'allowed' });
  }
  return rows;
}

/** The release's create-options check, as the page's gate makes it (`checkBeforeWallet`), over the release's file. */
export function createGate(release, extras, createOptionsText) {
  const target = { url: `file:create-options/97/${release.factory.address.toLowerCase()}.json`, release: {
    chainId: CHAIN_ID, factory: release.factory.address.toLowerCase(), registry: release.registry.address.toLowerCase(), versionCodeHash: release.versionCodeHash.toLowerCase() } };
  return { target, moduleDirectory: async () => extras.feeModuleDirectory.address, fetch: async () => new Response(createOptionsText, { status: 200 }) };
}

/**
 * The creator's wallet behind an EIP-1193 function, as the executor talks to it: it answers the chain id and the
 * creator's address, and hands each `eth_sendTransaction` (to, data, value, the executor's gas limit and fees) to a
 * sender (chain.mjs: the local node's account, or a keystore through cast) as a DURABLE send: the call and its nonce are
 * in the state file before it is broadcast (`durableSend`). Before each send `beforeSend` checks the opening step (the
 * live route and raise). A saved send that is not mined is reconciled (its own bytes, `reconcile`) only when the step
 * the page's runner rebuilt NOW is the same call, after those live checks; a different call while one is outstanding
 * stops the run with that nonce kept. A saved call that is mined is never sent again: the run stops.
 */
export function senderWallet({ sender, creator, store, client, log = () => undefined, beforeSend = async () => undefined, poll = 2_000 }) {
  const sent = store.data.memo['create:walletSent'] ?? (store.data.memo['create:walletSent'] = []);
  return async ({ method, params }) => {
    if (method === 'eth_chainId') return toHex(CHAIN_ID);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [creator];
    if (method !== 'eth_sendTransaction') throw new Error(`the creator's wallet does not answer ${method}`);
    const tx = params?.[0] ?? {};
    assert.equal(String(tx.from).toLowerCase(), creator.toLowerCase(), 'the wallet sends for the creator only');
    const call = { from: creator, to: tx.to, data: tx.data, value: BigInt(tx.value ?? '0x0'), gas: BigInt(tx.gas),
      fees: tx.maxFeePerGas ? { maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) } : null };
    const twin = sent.find(entry => entry.to?.toLowerCase() === call.to.toLowerCase() && entry.data?.toLowerCase() === call.data.toLowerCase() && BigInt(entry.value ?? -1) === call.value);
    const mined = async slot => (slot.hash ? (await lookup(client, slot.hash)).receipt : null);
    if (twin) {
      const receipt = await mined(twin);
      if (receipt) throw new Error(`this create step was already sent and mined (${twin.hash}): it is not sent again; stop`);
      // The saved call is the step rebuilt now: the live checks, then its own bytes (or a wait for them).
      await beforeSend(call);
      await reconcile({ store, slot: twin, tx: call, client, sender, log, poll, label: `create step ${sent.indexOf(twin) + 1}` });
      return twin.hash;
    }
    for (const [i, slot] of sent.entries()) {
      const receipt = await mined(slot);
      assert.ok(receipt && receipt.status === 'success', `create step ${i + 1} (nonce ${slot.nonce}, ${slot.hash ?? 'not broadcast'}) is saved and not mined, and the step asked now is another call: nothing was sent; its nonce is kept; stop`);
    }
    await beforeSend(call);
    const slot = {};
    sent.push(slot);
    await durableSend({ store, slot, tx: call, client, sender, log, poll, label: `create step ${sent.length}` });
    log(`the site's fee fields offered ${call.fees?.maxFeePerGas ?? 'none'}`);
    return slot.hash;
  };
}

/** Load settings as LoadSettings.tsx does: the file, its setup, the options check, finishLoad, the creator's spec. */
/**
 * The numbered item files of a collection's settings (Create's "Images + models + traits" pick): `<id>.png`, a 3D kit's
 * `<id>.glb`, `traits.csv`, read from a folder (settings.mjs `--items-out` writes it).
 */
export function itemFiles(directory) {
  const names = readdirSync(directory).filter(name => /^[1-9][0-9]*\.(png|glb)$|^traits\.csv$/.test(name));
  assert.ok(names.includes('traits.csv'), 'the items folder has traits.csv');
  return names.map(name => new File([readFileSync(join(directory, name))], name,
    { type: name.endsWith('.png') ? 'image/png' : name.endsWith('.glb') ? artFiles.MODEL_TYPE : 'text/csv' }));
}

export async function loadSettings(text, listings, gate, creator, { itemsDir = null } = {}) {
  const read = await load.readSettingsFile(text, async bytes => sha256Hex(bytes));
  if (!read.ok) throw new Error(`settings refused: ${read.error}`);
  assert.equal(read.value.demo, false, 'a demo file is never created on a chain');
  const setup = await load.setupOf(read.value, listings, async () => null);
  if (!setup.ok) throw new Error(`settings refused: ${setup.error}`);
  const document = await options.readCreateOptions(gate.target, gate.fetch);
  assert.ok(document.ok, 'the release\'s create-options list reads');
  // A spec that names a module row (The Alchemist) is checked against the release's module directory, as the page does.
  const directoryFor = async spec => (options.needsModuleDirectory(spec) ? gate.moduleDirectory() : undefined);
  const fileCheck = options.checkSpec(document.document, setup.value.file.spec, await directoryFor(setup.value.file.spec));
  assert.equal(fileCheck.state, 'ok', `the file's options: ${JSON.stringify(fileCheck)}`);
  // A collection: its item pictures, models and traits, read by Create's own reader without salts (LoadSettings.tsx
  // onItems); finishLoad checks them against the file and only then deals the new box's own salts.
  let art = null;
  if (setup.value.info.items > 0) {
    assert.ok(itemsDir, `this box has ${setup.value.info.items} items: give the folder of its numbered pictures, models and traits.csv`);
    const noPicture = async () => ({ error: 'item files only' });
    art = await artFiles.readArt(itemFiles(itemsDir), { env: { digest: async bytes => sha256Hex(bytes), thumbnail: async () => null, encodeCover: noPicture, salt: () => ZERO32 }, onItemFile: () => undefined });
    assert.deepEqual(art.problems, [], 'Create accepts the item files');
  }
  const finished = load.finishLoad(setup.value, art, listings, setup.value.file.spec.pricing.token, Date.now(), { salt: () => `0x${randomBytes(32).toString('hex')}` });
  if (!finished.ok) throw new Error(`settings refused: ${finished.error}`);
  const loaded = finished.value;
  assert.equal(loaded.info.note, null, `the file's price coin must be listed here (${loaded.info.note})`);
  const spec = buildSpecV2({ form: loaded.form, art: loaded.art, commitment: commitArt(loaded.art, loaded.form.artMode), cover: loaded.cover,
    collectionCover: loaded.collectionCover, page: loaded.page, owner: creator, nowMs: Date.now(), v2: loaded.v2, listings });
  const built = options.checkSpec(document.document, spec, await directoryFor(spec));
  assert.equal(built.state, 'ok', `the loaded spec's options: ${JSON.stringify(built)}`);
  // The new box's own reveal file (open art): its BoxSpec with the reveal list and the salts dealt here, which every
  // reveal needs. The page offers the same download; the creator keeps it (here: the state file).
  const pricing = listings.find(l => l.token.toLowerCase() === spec.pricing.token.toLowerCase());
  const revealText = loaded.art ? boxSpecFile(spec, { pricing, listings }, { revealList: revealList(loaded.art, commitArt(loaded.art, loaded.form.artMode).packed) }).parts.join('') : null;
  return { file: read.value, spec, loaded, revealText };
}

/**
 * The whole creation: load, prepare, send every step, then the read-back against the sheet. `sender` sends for the
 * creator (chain.mjs `nodeSender` for a local node's account, `castSender` for a keystore); `store` keeps the run
 * (its exact spec, salts and sent hashes) so a stopped creation continues where the chain stands: the page's own
 * `runCreateV2` reads what is done (the approval's allowance, the box's code, its chunks) before every step.
 */
/**
 * The sheet a creation sends, at the raise the chain's listing holds NOW (as the site reads it when it builds the
 * spec): a sheet written at another raise (a price keeper moves raises, SH-261 STEP 3) is rebuilt by the kit tool at
 * the chain's raise into `rebuildDir`, never sent as it is. Returns the path of the sheet to use.
 */
export async function sheetAtChainRaise({ client, release, extrasPath, settingsPath, kit, rebuildDir, log = () => undefined }) {
  const { sheetSpec } = await import('./readback.mjs');
  const sheet = sheetSpec(readFileSync(settingsPath, 'utf8'));
  const listing = await client.readContract({ address: release.listingRegistry.address, abi: coreV2.listingRegistryV2Abi, functionName: 'listing', args: [sheet.pricing.listingId] });
  if (listing.raise === sheet.raise) { log(`the sheet's raise ${sheet.raise} is the chain's (listing ${sheet.pricing.listingId})`); return settingsPath; }
  assert.ok(kit && rebuildDir, `the sheet's raise ${sheet.raise} is not the chain's ${listing.raise}: rebuild the sheet`);
  log(`the sheet's raise ${sheet.raise} is not the chain's ${listing.raise} (listing ${sheet.pricing.listingId}): the sheet is rebuilt at the chain's raise`);
  const { writeBnbSettings } = await import('./settings.mjs');
  const out = join(rebuildDir, `${kit}-raise-${listing.raise}-boxspec-v2.json`);
  await writeBnbSettings(kit, extrasPath, out, null, { raise: listing.raise });
  return out;
}

export async function launch({ rpcUrl, filesDir, settingsPath: givenSettings, creator, sender, store = stateStore(), itemsDir = null, clock = 'warp', kit = null, rebuildDir = null, log = () => undefined }) {
  assert.ok(sender, 'a sender for the creator');
  if (sender.kind === 'node') assert.match(new URL(rpcUrl).hostname, /^(127\.0\.0\.1|localhost)$/, 'a node account sends on a local chain only');
  const { release, extras, createOptionsText, manifest } = releaseFiles(filesDir);
  const { client, reads } = createReads(rpcUrl);
  // Every wait is chain.mjs's (the wallet's durable send already awaited its receipt and checked its status); a hash this
  // file does not hold is refused.
  const poll = clock === 'warp' ? 100 : 2_000;
  const sentEntry = hash => (store.data.memo['create:walletSent'] ?? []).find(tx => tx.hash?.toLowerCase() === hash.toLowerCase());
  reads.wait = async hash => {
    const slot = sentEntry(hash);
    assert.ok(slot, `a create step's hash this state file does not hold: ${hash}`);
    return (await waitMined(client, sender, slot, poll)).status;
  };
  assert.equal(await client.getChainId(), CHAIN_ID);
  const listings = await siteListings(client, release);
  const gate = createGate(release, extras, createOptionsText);
  const chain = { chainId: CHAIN_ID, factory: release.factory.address, listingRegistry: release.listingRegistry.address,
    coordinatorImplementation: release.implementations.coordinator.address, maxTxGas: write.writeChain(CHAIN_ID).maxTxGas };
  const memo = store.data.memo;
  // The run's identity: a state file holds one box's creation (its kit, its creator).
  if (memo['create:kit'] !== undefined) assert.equal(memo['create:kit'], kit, `the state file holds the creation of ${memo['create:kit']}, not ${kit}`);
  if (memo['create:creator'] !== undefined) assert.equal(memo['create:creator'].toLowerCase(), creator.toLowerCase(), 'the state file is another creator\'s run');
  memo['create:kit'] = kit; memo['create:creator'] = creator; store.save();
  // First, every send an earlier run saved is LOOKED UP; nothing is broadcast here (a failed lookup stops the run).
  // Mined: its status checked. Not mined: outstanding, sent again only as the same call the runner rebuilds now
  // (senderWallet). An older entry without its call and nonce must be mined.
  const factory = release.factory.address.toLowerCase();
  const outstanding = [];
  let created = null;
  for (const [i, slot] of (memo['create:walletSent'] ?? []).entries()) {
    const { receipt } = slot.hash ? await lookup(client, slot.hash) : { receipt: null };
    if (receipt) {
      assert.equal(receipt.status, 'success', `create step ${i + 1} (${slot.hash}) reverted: stop`);
      if (slot.to?.toLowerCase() === factory) created = receipt;
      continue;
    }
    assert.ok(slot.nonce !== undefined && slot.nonce !== null && slot.data, `create step ${i + 1} (${slot.hash ?? 'no hash'}) was saved without its call and nonce, and is not mined: check by hand`);
    outstanding.push(`create step ${i + 1} (nonce ${slot.nonce})`);
  }
  let run = memo['create:run'];
  let spec;
  // A saved factory receipt that names this run's coordinator keeps the run; a later read that disagrees stops it.
  if (created) {
    assert.ok(run, `a mined createBox (${created.transactionHash}) without its kept run: stop`);
    const named = parseEventLogs({ abi: coreV2.registryV2Abi, logs: created.logs, eventName: 'BoxCreated' })
      .some(e => e.address.toLowerCase() === release.registry.address.toLowerCase() && e.args.record.contracts[0].toLowerCase() === run.coordinator.toLowerCase());
    assert.ok(named, `the mined createBox ${created.transactionHash} does not name the kept run's coordinator ${run.coordinator}: stop`);
    assert.notEqual(await client.getCode({ address: run.coordinator }) ?? '0x', '0x', `the createBox ${created.transactionHash} created ${run.coordinator}, but the chain answers no code there now: stop; run again later`);
    log(`the createBox ${created.transactionHash} created the kept run's box ${run.coordinator}: the run is kept`);
  }
  // A kept run whose box is not created yet: the listing's raise is read again now; a changed raise discards the run (a
  // mined approval stays on chain, unused) and the sheet is rebuilt at the chain's raise below. With a saved send still
  // outstanding the run stops instead (its saved bytes are not sent, its nonce kept).
  if (run && !created && (await client.getCode({ address: run.coordinator }) ?? '0x') === '0x') {
    const kept = send.specOfRun(run);
    const live = await client.readContract({ address: release.listingRegistry.address, abi: coreV2.listingRegistryV2Abi, functionName: 'listing', args: [kept.pricing.listingId] });
    if (live.raise !== kept.raise) {
      assert.equal(outstanding.length, 0, `the listing's raise moved from ${kept.raise} to ${live.raise}, and ${outstanding.join(', ')} is saved and not mined: its bytes are not sent; its nonce is kept; stop`);
      log(`the listing's raise moved from ${kept.raise} to ${live.raise} before the box was created: the kept run is set aside and the sheet rebuilt`);
      (memo['create:setAside'] ??= []).push({ run, sheet: memo['create:sheet'], reason: `raise ${kept.raise} -> ${live.raise}` });
      delete memo['create:run']; delete memo['create:sheet']; delete memo['create:sheetDigest']; delete memo['create:revealFile'];
      store.save();
      run = undefined;
    }
  }
  // A kept run keeps the sheet it was prepared from (its digest checked); a new one takes the chain's raise now.
  const settingsPath = memo['create:sheet'] ?? await sheetAtChainRaise({ client, release, extrasPath: releaseFiles(filesDir).extrasPath, settingsPath: givenSettings, kit, rebuildDir, log });
  const text = readFileSync(settingsPath, 'utf8');
  if (memo['create:sheetDigest'] !== undefined) assert.equal(sha256Hex(new TextEncoder().encode(text)), memo['create:sheetDigest'], `the sheet ${settingsPath} changed under the kept run`);
  if (run) {
    spec = send.specOfRun(run);
    log(`continuing the kept run: coordinator ${run.coordinator}`);
  } else {
    let revealText;
    ({ spec, revealText } = await loadSettings(text, listings, gate, creator, { itemsDir }));
    run = await send.prepareCreateV2(reads, chain, spec, creator);
    memo['create:run'] = run;
    memo['create:revealFile'] = revealText;
    memo['create:sheet'] = settingsPath;
    memo['create:sheetDigest'] = sha256Hex(new TextEncoder().encode(text));
    memo['create:coordinator'] = run.coordinator;
    store.save();
    log(`prepared: coordinator ${run.coordinator}, token ${run.token}, bootstrap ${run.bootstrapQ}`);
  }
  // Before the approval and before createBox (the opening steps): the listing's raise read live must be the spec's,
  // and a route the spec names must resolve LIVE in the release's directory (not withdrawn, its code hash unchanged,
  // selectable by the chain's clock now: FeeModuleDirectoryV21.resolve).
  const routes = routeIdsOf(spec);
  const beforeSend = async call => {
    if ((await client.getCode({ address: run.coordinator }) ?? '0x') !== '0x') return;
    const live = await client.readContract({ address: release.listingRegistry.address, abi: coreV2.listingRegistryV2Abi, functionName: 'listing', args: [spec.pricing.listingId] });
    assert.equal(live.raise, spec.raise, `the listing's raise moved to ${live.raise} (the spec has ${spec.raise}): nothing was sent; run create again to rebuild the sheet`);
    for (const id of routes) {
      const [module] = await client.readContract({ address: release.feeModuleDirectory.address, abi: coreV2.feeModuleDirectoryV21Abi, functionName: 'resolve', args: [id] })
        .catch(error => { throw new Error(`route ${id} does not resolve in the release's directory now (withdrawn, changed, or not selectable yet): nothing was sent`, { cause: error }); });
      log(`route ${id} resolves live to ${module} before ${call.to.toLowerCase() === release.factory.address.toLowerCase() ? 'createBox' : 'this step'}`);
    }
  };
  const wallet = senderWallet({ sender, creator, store, client, log, beforeSend, poll });
  const createOptionsCheck = plan => options.checkBeforeWallet(gate, plan);
  const labels = [];
  const ended = await send.runCreateV2(run, {
    reads, chain, ctx: send.labelCtxOf(spec, listings),
    submit: async (opts, kind) => {
      const hash = await write.submitCreateWriteV2({ ...opts, wallet, createOptionsCheck });
      log(`sent ${kind}: ${hash}`);
      return hash;
    },
    onRun: next => { memo['create:run'] = next; store.save(); },
    onProgress: (progress, sending) => { if (sending !== null) labels.push(progress.steps[sending].label); },
    stopped: () => false,
  });
  assert.equal(ended, 'done');
  const receipts = [];
  for (const tx of memo['create:walletSent'] ?? []) {
    const receipt = await client.getTransactionReceipt({ hash: tx.hash });
    assert.equal(receipt.status, 'success', `create step ${tx.hash} reverted`);
    receipts.push({ ...tx, block: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice });
  }
  // The read-back finds the creation as it does after a real one: by the registry's BoxCreated record.
  const back = await readBack({ client, manifest, coordinator: run.coordinator, settingsText: text, creator, revealText: memo['create:revealFile'] ?? null, fromBlock: receipts[0]?.block ?? 0n });
  const createTx = receipts.find(r => r.to.toLowerCase() === release.factory.address.toLowerCase())?.hash;
  if (createTx) assert.equal(back.createTx, createTx, 'the read-back found this run\'s createBox');
  const result = { coordinator: run.coordinator, token: run.token, bootstrapQ: run.bootstrapQ, specHash: keccak256(encodeBoxSpecV2(spec)),
    steps: labels, sent: receipts, readBack: back };
  memo['create:result'] = store.plain(result);
  store.save();
  return result;
}

function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
  try {
    for (const name of ['--rpc', '--files', '--settings', '--creator']) assert.ok(flag(name), `${name} is required`);
    const result = await launch({ rpcUrl: flag('--rpc'), filesDir: resolve(flag('--files')), settingsPath: resolve(flag('--settings')), creator: viem.getAddress(flag('--creator')), sender: nodeSender(flag('--rpc')), log: line => process.stdout.write(`${line}\n`) });
    if (flag('--out')) writeFileSync(resolve(flag('--out')), json(result));
    process.stdout.write(`created ${result.coordinator} (${result.steps.length} steps); read-back ${result.readBack.ok ? 'GREEN' : 'RED'}: ${result.readBack.rows.length} fields\n`);
    if (!result.readBack.ok) { process.stdout.write(json(result.readBack.rows.filter(r => !r.same))); process.exitCode = 1; }
  } catch (error) {
    console.error(`launch refused: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
