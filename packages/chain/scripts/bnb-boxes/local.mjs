#!/usr/bin/env node
/**
 * SH-261: a demo box created, read back and lived on a LOCAL chain with id 97, in one run:
 *
 *   node packages/chain/scripts/bnb-boxes/local.mjs stock|rentfree|converter [--port 8575] [--files hackathon/rehearsals/plain-97] [--out <result.json>]
 *     [--trade-after <raw>] [--rival] [--swap-gas <gas>] [--raise-change <raw>]
 *
 * 1. anvil on 127.0.0.1:<port> from the files' state dump (`anvil-state.json.gz`: the release deployed);
 * 2. the creator (the node's first unlocked account) gets the price coin it pays, two holders some to trade with
 *    (local funding from the impersonated deployer, this node only);
 * 3. the box is created from its settings through the Launch form's code path and read back (launch.mjs);
 * 4. its life (life.mjs), every amount checked to the last raw unit;
 * 5. anvil is stopped, whatever happened.
 *
 * Exit 0 only when the creation, the read-back and the life are all green.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SH_TESTNET = 'bnb';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { startChain, localChain, plantMulticall3 } = await import('./local-chain.mjs');
const { rpc } = await import('./chain.mjs');
const { revealAll, itemsLife } = await import('./items.mjs');
const { converterLife } = await import('./pile.mjs');
const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const { loadProfileExamples } = await import('../../../../packages/box-spec/examples/v2/registry.mjs');
const { ALLOWED_RPCS } = await import('../../../contracts/script/bnb/bnb-testnet.mjs');
const { launch, releaseFiles } = await import('./launch.mjs');
const { holdersLife } = await import('./life.mjs');
const json = value => `${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`;

/** The demo boxes this driver runs: their settings and their life. */
export const BOXES = Object.freeze({
  stock: { kit: 'gpu-poor', settings: 'examples/boxes/gpu-poor/settings/bnb/gpu-poor-boxspec-v2.json', coin: 'tNVDA', life: 'holders' },
  rentfree: { kit: 'rent-free', settings: '.cache/bnb-boxes/rent-free/rent-free-boxspec-v2.json', items: '.cache/bnb-boxes/rent-free/items', coin: 'tUSDC', life: 'items' },
  // The converter box: priced in tUSDC, the buyers' fees converted into a tNVDA pile through route id 6 (tUSDC to
  // tNVDA through the 10-tNVDA pair; route 4's BNB pool holds 0.0001 BNB, too shallow for one conversion, SH-261
  // evidence). Selectable one day after its registration: the local clock is moved past its readyAt first. The route's
  // trigger is the keeper's wallet, impersonated on the local node only.
  converter: { kit: 'the-alchemist', settings: 'examples/boxes/the-alchemist/settings/bnb/the-alchemist-boxspec-v2.json', coin: 'tUSDC', life: 'converter', route: 'converter tUSDC to tNVDA' },
});
/** The keeper's wallet: every converter route's fixed trigger (lane c, SH-260). */
const KEEPER_WALLET = '0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const name = args[0];
assert.ok(Object.hasOwn(BOXES, name), `usage: local.mjs <${Object.keys(BOXES).join('|')}> [--port 8575] [--files <dir>] [--out <file>]`);
const spec = BOXES[name];
const filesDir = resolve(ROOT, flag('--files', 'hackathon/rehearsals/plain-97'));
const port = Number(flag('--port', '8575'));
const workDir = join(ROOT, '.cache/bnb-boxes', `${name}-${Date.now()}`);
// The swaps' gas limit (default 15,000,000): `--swap-gas 4000000` replays the site trade box's floor (MIN_TRADE_GAS).
const swapGas = BigInt(flag('--swap-gas', '15000000'));
// `--trade-after <raw>`: what B buys per round after graduation. `--rival`: another account (the node's fifth) presses
// every public step (collect, graduate, settleBatch, sellFees, buyBack, sync) just before this run's keeper does, as
// the live keeper may: the life must read the chain and go on.
const tradeAfter = flag('--trade-after', null) === null ? null : BigInt(flag('--trade-after'));
const rival = args.includes('--rival');
// `--raise-change <raw>`: the listing's raise is changed on the local chain (the lister impersonated) AFTER the sheet
// was written and before the creation: the creation must rebuild the sheet at the chain's raise.
const raiseChange = flag('--raise-change', null) === null ? null : BigInt(flag('--raise-change'));
mkdirSync(workDir, { recursive: true });
const out = resolve(flag('--out', join(workDir, 'result.json')));
const log = line => process.stdout.write(`${line}\n`);

const node = await startChain({ dumpGz: join(filesDir, 'anvil-state.json.gz'), workDir, port });
const result = { box: name, kit: spec.kit, settings: spec.settings, port, startedAt: new Date().toISOString() };
let chain = null;
try {
  chain = localChain(node.url, { log });
  const { extras } = releaseFiles(filesDir);
  result.startBlock = await chain.client.getBlockNumber();
  const [creator, a, b, nodeKeeper, other] = await chain.accounts();
  let keeper = nodeKeeper;
  if (spec.route) {
    // The route's trigger is the keeper's wallet: it presses the life's public steps here (impersonated, local only).
    await rpc(node.url, 'anvil_impersonateAccount', [KEEPER_WALLET]);
    await rpc(node.url, 'anvil_setBalance', [KEEPER_WALLET, '0xde0b6b3a7640000']);
    keeper = KEEPER_WALLET;
    const route = releaseFiles(filesDir).extras.feeModuleDirectory.modules.find(m => m.name === spec.route);
    await chain.mineTo(BigInt(route.readyAt) + 1n);
    log(`the clock moved past route ${route.id}'s readyAt ${route.readyAt}`);
  }
  result.accounts = { creator, a, b, keeper, ...(rival ? { rival: other } : {}) };
  if (rival) {
    const send = chain.send;
    const steps = ['collect', 'graduate', 'settleBatch', 'sellFees', 'sync'];
    result.rivalSteps = [];
    chain.send = async (from, to, abi, fn, fnArgs = [], value = 0n, gas) => {
      if (from.toLowerCase() === keeper.toLowerCase() && steps.includes(fn)) {
        const { encodeFunctionData, toHex } = await import('viem');
        const hash = await rpc(node.url, 'eth_sendTransaction', [{ from: other, to, data: encodeFunctionData({ abi, functionName: fn, args: fnArgs }), gas: toHex(15_000_000n) }]);
        const receipt = await chain.client.waitForTransactionReceipt({ hash });
        result.rivalSteps.push(`${fn} ${receipt.status}`);
      }
      return send(from, to, abi, fn, fnArgs, value, gas);
    };
  }
  const listing = extras.listings.find(l => l.symbol === spec.coin);
  const coin = listing.token;
  const fundEach = tradeAfter && tradeAfter * 30n > 10n * BigInt(listing.raise) ? tradeAfter * 30n : 10n * BigInt(listing.raise);
  // The creator pays the bootstrap (the kit's creator buy is 0); each holder gets ten raises to trade with.
  if (listing.id !== 0) {
    await chain.fund(coin, creator, BigInt(listing.raise));
    await chain.fund(coin, a, fundEach);
    await chain.fund(coin, b, fundEach);
  }
  if (raiseChange !== null) {
    const { manifest } = releaseFiles(filesDir);
    const registry = manifest.releases[0].listingRegistry.address;
    const lister = await chain.read(registry, coreV2.listingRegistryV2Abi, 'lister');
    await rpc(node.url, 'anvil_impersonateAccount', [lister]);
    await rpc(node.url, 'anvil_setBalance', [lister, '0xde0b6b3a7640000']);
    await chain.act('the listing\'s raise changes', () => chain.send(lister, registry, coreV2.listingRegistryV2Abi, 'updateRaise', [listing.id, raiseChange]).then(r => r.transactionHash));
    result.raiseChange = { listing: listing.id, from: listing.raise, to: raiseChange };
    log(`the chain's raise of listing ${listing.id} changed from ${listing.raise} to ${raiseChange} after the sheet was written`);
  }
  if (spec.items) log(`Multicall3 on the local chain: ${await plantMulticall3(node.url, ALLOWED_RPCS[0])}`);
  log(`funded creator and holders with ${spec.coin} (local, from the impersonated deployer)`);
  const created = await launch({ rpcUrl: node.url, filesDir, settingsPath: resolve(ROOT, spec.settings), creator, sender: chain.sender, store: chain.store,
    itemsDir: spec.items ? resolve(ROOT, spec.items) : null, kit: spec.kit, rebuildDir: workDir, log });
  result.sheet = chain.store.data.memo['create:sheet'];
  result.created = created;
  for (const row of created.readBack.rows) log(`${row.same ? 'same' : 'DIFF'}  ${row.group} / ${row.field}`);
  log(`read-back ${created.readBack.ok ? 'GREEN' : 'RED'}: ${created.readBack.rows.filter(r => r.same).length} of ${created.readBack.rows.length}`);
  assert.ok(created.readBack.ok, 'the read-back found a difference');
  result.swapGas = swapGas;
  if (spec.life === 'holders') {
    result.life = await holdersLife(chain, created.coordinator, { swapper: extras.trade.swapper, keeper, a, b, swapGas, tradeAfter });
    for (const c of result.life.claimed) log(`claimed ${c.quote} raw ${spec.coin} by ${c.holder}`);
    log(`life GREEN: ${result.life.claimed.length} claims, ${result.life.total} raw ${spec.coin} paid to holders`);
  } else if (spec.life === 'converter') {
    const row = loadProfileExamples('bnb').find(e => e.id === spec.kit);
    result.life = await converterLife(chain, created.coordinator, { swapper: extras.trade.swapper, keeper, a, b, fees: row.fees, tradeAfter });
    log(`life GREEN: ${result.life.conversion.amountIn} raw price coin converted into ${result.life.conversion.amountOut} raw tNVDA in the pile; A redeemed ${result.life.redeemed.amount} raw box tokens for ${result.life.redeemed.received} raw tNVDA`);
  } else {
    const revealed = await revealAll(chain, created.coordinator, chain.store.data.memo['create:revealFile'], creator);
    log(`revealed ${revealed.total} items in ${revealed.batches.length} sends`);
    const row = loadProfileExamples('bnb').find(e => e.id === spec.kit);
    result.life = await itemsLife(chain, created.coordinator, { swapper: extras.trade.swapper, keeper, a, b, fees: row.fees, size: Number(row.contents.size), tradeAfter });
    log(`life GREEN: house 1 taken out for ${result.life.taken.paid} raw box tokens; its owner claimed ${result.life.claim.received} raw ${spec.coin} from ${result.life.claim.receipts} receipts`);
  }
  if (rival) log(`the rival pressed first: ${result.rivalSteps.join(', ')}`);
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.done = chain ? Object.keys(chain.store.data.done) : [];
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
  log(`RED: ${result.error}`);
} finally {
  node.stop();
  result.endedAt = new Date().toISOString();
  writeFileSync(out, json(result));
  log(`result: ${out}`);
}
