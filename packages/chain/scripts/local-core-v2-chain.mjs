#!/usr/bin/env node
/** SH-V2-E2E-LOCAL. Fresh local twin only; never forks or contacts a public network. */
import { closeSync, mkdirSync, openSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, encodeFunctionData, http, zeroAddress } from 'viem';
import { artifact, readLocalBox, readLocalManifest } from './lib/core-v2-local-manifest.mjs';
import { ROOT, CONTRACTS, CHAIN_ID, assertLocalRpc, child, delay, freePort, json, localOptions, mineTo, rpc, run, runLocalStep, send, stopChild, stopChildren } from './lib/core-v2-local-runtime.mjs';

import { deployLocalSet } from './lib/set-v2-local.mjs';
import { runSetLocalLife } from './lib/set-v2-local-life.mjs';
export { runSetLocalLife };

import { setupJunkyard } from './lib/core-v2-local-junkyard.mjs';

const printed = text => Object.fromEntries([...text.matchAll(/LOCALV2\|(\w+)\|(0x[0-9a-fA-F]{40})/g)].map(m => [m[1], m[2]]));
const addressNames = ['plain', 'holders', 'shop', 'failure', 'everyItem', 'coinPile', 'usdc', 'stock', 'gold'];

/** Always checks the loopback node before broadcasting with its unlocked account; no keys. */
export async function localForge(chain, target, signature, args, actor = chain.accounts.actor, name = target,
  actions = { assertLocalRpc, run, runLocalStep }, libraries = []) {
  const { assertLocalRpc, run, runLocalStep } = actions;
  await assertLocalRpc(chain.rpcUrl);
  return runLocalStep(chain, name, async () => {
    const output = await run('forge', ['script', target, '--sig', signature, ...args.map(String), '--rpc-url', chain.rpcUrl,
      '--broadcast', '--unlocked', '--sender', actor, '--slow', '--isolate', '--no-storage-caching', '--hardfork', 'osaka',
      ...libraries.flatMap(library => ['--libraries', library])],
    { env: { SH_CORE_V2_LOCAL_ACTOR: chain.accounts.actor, SH_CORE_V2_LOCAL_BACKUP: chain.accounts.backup } });
    if (!output.includes('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL')) throw new Error(`local forge run did not confirm on-chain execution:\n${output}`);
    return output;
  });
}

export async function callLocal(chain, contract, address, functionName, args = [], from = chain.accounts.actor, value = 0n,
  actions = { assertLocalRpc, send, artifact, runLocalStep }) {
  const { assertLocalRpc, send, artifact, runLocalStep } = actions;
  await assertLocalRpc(chain.rpcUrl);
  const owner = chain.addressLabels?.[address.toLowerCase()] ?? contract;
  return runLocalStep(chain, `${owner}.${functionName}@${address}`, () =>
    send(chain.rpcUrl, { from, to: address, data: encodeFunctionData({ abi: artifact(contract).abi, functionName, args }), value }));
}

export async function recipe(chain, action, coordinator = zeroAddress) {
  const box = Object.entries(chain.boxes ?? {}).find(([, address]) => address === coordinator)?.[0] ?? coordinator;
  const name = ['create-menu', 'trade', 'fill', 'give-pick', 'withdraw-item'][action];
  return localForge(chain, 'script/local/CoreV2LocalLife.s.sol:CoreV2LocalLife',
    'runLocal(uint8,address,address,address,address)', [action, chain.factory, chain.swapper, chain.nft, coordinator],
    chain.accounts.actor, action === 0 ? name : `${box}.${name}`);
}

export async function checkpoint(chain, label) {
  const block = BigInt(await rpc(chain.rpcUrl, 'eth_blockNumber'));
  const states = {};
  for (const name of addressNames) states[name] = await readLocalBox(chain, chain.boxes[name], block);
  chain.addressLabels ??= {};
  for (const [name, state] of Object.entries(states)) {
    for (const role of ['coordinator', 'token', 'hook', 'receiver', 'vault', 'holderLedger', 'itemLedger']) {
      if (state[role] && state[role] !== zeroAddress) chain.addressLabels[state[role].toLowerCase()] = `${name}.${role}`;
    }
  }
  chain.checkpoints[label] = states;
  writeFileSync(join(chain.out, 'local-core-v2-chain.json'), json(chain));
  return states;
}

/**
 * F137: after graduation a sale's 1% T fee becomes sellers' P only through the hook's public sellFees step (our keeper
 * presses it hourly as a fallback); a step below the minimum skips. Trade, press, and repeat until one step sells.
 */
async function sellLocalFees(chain, coordinator, { recipe, readLocalBox, callLocal }, collect = true) {
  for (let i = 0; i < 16; i += 1) {
    await recipe(chain, 1, coordinator);
    const b = await readLocalBox(chain, coordinator);
    await callLocal(chain, 'BoxHookV2', b.hook, 'sellFees', [], chain.accounts.keeper);
    if ((await readLocalBox(chain, coordinator)).saleFeesPending > 0n) {
      if (collect) await callLocal(chain, 'BoxReceiverV2', b.receiver, 'collect', [chain.accounts.keeper], chain.accounts.keeper);
      return;
    }
  }
  throw new Error(`the sale fees of ${coordinator} never reached the step minimum`);
}

/** Leaves genuine holder/failure credits for browser actions; the dev command completes those claims afterwards. */
export async function runLocalLife(chain, { browser = false } = {}, actions = { checkpoint, mineTo, recipe, readLocalBox, callLocal }) {
  const { checkpoint, mineTo, recipe, readLocalBox, callLocal } = actions;
  const { plain, holders, shop, failure, everyItem, coinPile, usdc, stock, gold } = chain.boxes;
  const initial = await checkpoint(chain, 'created');
  const open = Object.values(initial).reduce((max, b) => b.openAt > max ? b.openAt : max, 0n);
  await mineTo(chain.rpcUrl, open + 384n);
  for (const box of [plain, holders, failure, everyItem]) await recipe(chain, 1, box);
  for (const box of [usdc, stock, gold]) {
    for (let i = 0; i < 3; i += 1) await recipe(chain, 1, box);
  }
  await checkpoint(chain, 'curve-trades');
  for (const box of [plain, holders, everyItem, usdc, stock, gold]) {
    const b = await readLocalBox(chain, box);
    await callLocal(chain, 'BoxReceiverV2', b.receiver, 'collect', [chain.accounts.keeper], chain.accounts.keeper);
  }
  const holder = await readLocalBox(chain, holders);
  // The curve buy (batch 1) and sale (batch 2); settlement never pushes a holder's money (F127). Under F137 the sale's
  // fee is T, burned at graduation or failure, so only batch 1 carries P.
  for (const batch of [1n, 2n]) await callLocal(chain, 'HolderLedgerV2', holder.holderLedger, 'settleBatch', [batch, 64n], chain.accounts.keeper);
  for (const box of [plain, shop, everyItem, coinPile, usdc, stock, gold]) {
    await recipe(chain, 2, box);
    await callLocal(chain, 'BoxCoordinatorV2', box, 'graduate', [], chain.accounts.keeper);
    await callLocal(chain, 'BoxCoordinatorV2', box, 'claimReward', [chain.accounts.keeper], chain.accounts.keeper);
  }
  // Graduated sale fees reach the sellers' side (F137): stock and gold collect theirs; plain collects below.
  for (const box of [stock, gold]) await sellLocalFees(chain, box, { recipe, readLocalBox, callLocal });
  await sellLocalFees(chain, plain, { recipe, readLocalBox, callLocal }, false);
  const p = await readLocalBox(chain, plain);
  await callLocal(chain, 'BoxReceiverV2', p.receiver, 'collect', [chain.accounts.keeper], chain.accounts.keeper);
  await checkpoint(chain, 'before-deepen');
  await callLocal(chain, 'BoxHookV2', p.hook, 'deepen', [chain.accounts.keeper], chain.accounts.keeper);
  for (const method of ['payFit', 'payPlatform']) await callLocal(chain, 'BoxReceiverV2', p.receiver, method, [], chain.accounts.keeper);
  await callLocal(chain, 'BoxReceiverV2', p.receiver, 'claimCreator', [zeroAddress, chain.accounts.actor]);
  await checkpoint(chain, 'plain');
  await recipe(chain, 4, everyItem);
  await recipe(chain, 1, everyItem);
  const item = await readLocalBox(chain, everyItem);
  await callLocal(chain, 'BoxReceiverV2', item.receiver, 'collect', [chain.accounts.keeper], chain.accounts.keeper);
  await callLocal(chain, 'ItemLedgerV2', item.itemLedger, 'sync', [32n], chain.accounts.keeper);
  await checkpoint(chain, 'm3-ready');
  const s = await readLocalBox(chain, shop);
  await mineTo(chain.rpcUrl, s.openAt + 7n * 86400n + 1n);
  await checkpoint(chain, 'before-shop');
  await recipe(chain, 3, shop);
  await checkpoint(chain, 'shop');
  const f = await readLocalBox(chain, failure);
  await mineTo(chain.rpcUrl, f.deadline);
  await callLocal(chain, 'BoxCoordinatorV2', failure, 'fail', [], chain.accounts.keeper);
  await checkpoint(chain, 'claim-ready');
  if (!browser) {
    await callLocal(chain, 'ItemLedgerV2', item.itemLedger, 'claim', [[1n], chain.accounts.actor]);
    const pile = await readLocalBox(chain, coinPile);
    const pileAmount = pile.actorT / 4n;
    const quote = await localClient(chain).readContract({ abi: artifact('PileVaultV2').abi, address: pile.vault,
      functionName: 'quoteRedeem', args: [pileAmount] });
    await callLocal(chain, 'BoxTokenV2', pile.token, 'approve', [pile.vault, pileAmount]);
    await callLocal(chain, 'PileVaultV2', pile.vault, 'redeem', [pileAmount, quote, chain.accounts.actor]);
    // Batch 2 holds no credit (F137), and a claim of nothing reverts, so only batch 1 is claimed.
    await callLocal(chain, 'HolderLedgerV2', holder.holderLedger, 'claim', [1n, chain.accounts.actor]);
    const failed = await readLocalBox(chain, failure);
    const amount = failed.actorT / 2n;
    await callLocal(chain, 'BoxTokenV2', failed.token, 'approve', [failure, amount]);
    await callLocal(chain, 'BoxCoordinatorV2', failure, 'claim', [amount, chain.accounts.actor]);
    await checkpoint(chain, 'claimed');
    await claimLocalFailureAfterYear(chain);
  }
}

export async function claimLocalFailureAfterYear(chain) {
  const f = await readLocalBox(chain, chain.boxes.failure);
  await mineTo(chain.rpcUrl, f.failedAt + 365n * 86400n);
  await callLocal(chain, 'BoxTokenV2', f.token, 'approve', [f.coordinator, f.actorT]);
  await callLocal(chain, 'BoxCoordinatorV2', f.coordinator, 'claim', [f.actorT, chain.accounts.actor]);
  return checkpoint(chain, 'claimed-after-year');
}

/** Owns its fresh anvil. KEEP_CHAIN retains only this node on failure, with no inherited supervisor pipes. */
export async function startLocalCoreV2Chain({ outDir = join(ROOT, '.cache/core-v2-local/run'), ports = localOptions() } = {}) {
  ports = localOptions({ SH_CORE_V2_CHAIN_PORT: String(ports.chainPort), DEV_PORT: String(ports.appPort),
    SH_CORE_V2_GATEWAY_PORT: String(ports.gatewayPort), ...(ports.artPort === undefined ? {} : { SH_CORE_V2_ART_PORT: String(ports.artPort) }) });
  await freePort(ports.chainPort);
  const out = resolve(outDir); mkdirSync(out, { recursive: true });
  const rpcUrl = `http://127.0.0.1:${ports.chainPort}`;
  const log = openSync(join(out, 'anvil.log'), 'a');
  let anvil;
  try {
    anvil = child('anvil', ['--host', '127.0.0.1', '--port', String(ports.chainPort), '--chain-id', String(CHAIN_ID),
      '--enable-tx-gas-limit', '--steps-tracing', '--base-fee', '0', '--hardfork', 'osaka', '--timestamp', '1790000000', '--silent'],
    { keepOnFailure: true, stdio: ['ignore', log, log] });
  } finally { closeSync(log); }
  let spawnError;
  anvil.on('error', error => { spawnError = error; });
  const stop = () => stopChild(anvil);
  const stopDuringStartup = () => { void stopChildren(); };
  process.once('SIGINT', stopDuringStartup); process.once('SIGTERM', stopDuringStartup);
  try {
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      if (spawnError) throw spawnError;
      if (anvil.exitCode !== null || anvil.signalCode !== null) throw new Error('anvil exited before readiness');
      try { await assertLocalRpc(rpcUrl); ready = true; break; } catch { await delay(100); }
    }
    if (!ready) throw new Error('local v2 anvil did not become ready');
    // Each --slow broadcast/direct send has a distinct block and second, independent of host speed.
    await rpc(rpcUrl, 'anvil_setBlockTimestampInterval', [1]);
    await rpc(rpcUrl, 'anvil_mine', ['0x10']);
    const accounts = await rpc(rpcUrl, 'eth_accounts');
    const chain = { chainId: CHAIN_ID, rpcUrl, out, ports, anvilPid: anvil.pid, accounts: { deployer: accounts[0], actor: accounts[1], backup: accounts[2], keeper: accounts[4] },
      manifest: join(out, `core-v2-manifest-${CHAIN_ID}.json`), checkpoints: {} };
    const save = () => writeFileSync(join(out, 'local-core-v2-chain.json'), json(chain));
    save();
    await run('forge', ['build'], { cwd: CONTRACTS, env: { FOUNDRY_LINT_LINT_ON_BUILD: 'false' },
      timeoutHint: 'A cold compile can exceed this limit. In packages/contracts, run forge clean then '
        + 'FOUNDRY_LINT_LINT_ON_BUILD=false forge build before starting the stack.' });
    Object.assign(chain, printed(await localForge(chain, 'script/local/CoreV2LocalGenesis.s.sol:CoreV2LocalGenesis', 'run()', [], chain.accounts.deployer)));
    save();
    for (const key of ['genesisFactory', 'fit', 'swapper', 'nft']) if (!chain[key]) throw new Error(`genesis omitted ${key}`);
    chain.releaseStartBlock = (BigInt(await rpc(rpcUrl, 'eth_blockNumber')) + 1n).toString();
    Object.assign(chain, printed(await localForge(chain, 'script/local/DeployCoreV2Local.s.sol:DeployCoreV2Local',
      'runLocal(address,address)', [chain.genesisFactory, chain.fit], chain.accounts.deployer)));
    if (!chain.factory) throw new Error('release omitted factory');
    chain.junkyard = await setupJunkyard(chain, localForge);
    // This fresh loopback chain observes the production one-day admission delay before creating examples.
    const releaseBlock = await localClient(chain).getBlock();
    await mineTo(chain.rpcUrl, releaseBlock.timestamp + 86400n);
    for (const coin of ['usdc', 'link', 'wbtc', 'nvdaon', 'aaplon', 'paxg', 'xaut']) if (!chain[coin]) throw new Error(`release omitted ${coin}`);
    save();
    chain.boxes = printed(await recipe(chain, 0));
    for (const name of addressNames) if (!chain.boxes[name]) throw new Error(`creation omitted ${name}`);
    writeFileSync(chain.manifest, json(await readLocalManifest(chain)));
    await deployLocalSet(chain, localForge, await readLocalManifest(chain));
    await checkpoint(chain, 'created');
    return { chain, stop, process: anvil };
  } catch (error) { await stopChildren({ failure: true }); throw error; }
  finally {
    process.removeListener('SIGINT', stopDuringStartup); process.removeListener('SIGTERM', stopDuringStartup);
  }
}

export { readLocalBox, readLocalManifest, rpc, mineTo, localOptions };
export const localClient = chain => createPublicClient({ transport: http(chain.rpcUrl, { timeout: 10_000, retryCount: 0 }) });

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const running = await startLocalCoreV2Chain();
  const shutdown = async () => { await stopChildren(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try {
    await runLocalLife(running.chain);
    await runSetLocalLife(running.chain, {recipe, callLocal});
    writeFileSync(running.chain.manifest, json(await readLocalManifest(running.chain)));
    console.warn(`Local core v2 ready at ${running.chain.rpcUrl}; ${running.chain.manifest}`);
  } catch (error) { await stopChildren({ failure: true }); throw error; }
}
