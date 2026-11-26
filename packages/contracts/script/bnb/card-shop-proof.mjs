#!/usr/bin/env node
/**
 * SH-262: the proof of the card shop's real-run steps (card-shop.mjs on lane d's keystore sender) on a LOCAL chain with
 * id 97, the way lane d proved its boxes (packages/chain/scripts/bnb-boxes/proof.mjs). Run from packages/contracts:
 *
 *   node --experimental-transform-types --no-warnings=ExperimentalWarning script/bnb/card-shop-proof.mjs [--port <port>] [--out <dir>]
 *
 * It starts anvil from lane c's plain rehearsal dump (a port that answers is refused), makes three THROWAWAY keystores
 * with three different random passwords (cast wallet new; this script writes the password files and never reads a key),
 * runs the card stock step for them through lane c's driver, the settings step, and then the real-run commands as
 * separate processes with `--local-proof`, stopped hard through lane d's hook (`SH_BNB_STOP_AT`) both right before a
 * broadcast (its call and nonce saved) and right after one (its receipt not yet read): `create --dry`; `create` stopped
 * before its first broadcast, then after one, then to the end, and once more (nothing sent); `load --dry`; `load` stopped
 * before its fourth broadcast, then after a third, then to the end; `graduate` stopped after its second broadcast, then
 * to the end; `pick` (picker paid by the creator) stopped before the payment's broadcast, then after one, then to the
 * end, and once more (nothing sent). Last the check
 * that matters: every role's nonce grew by exactly the transactions the state file holds for it: each sent once.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CONTRACTS, DEPLOYER, ROOT, runStep, saveState } from './bnb-testnet.mjs';
import { STOCK_STEP, json } from './card-shop.mjs';
import { keystoreRole, rpc, roleAddress, stateStore } from '../../../chain/scripts/bnb-boxes/chain.mjs';
import { freePort, startChain } from '../../../chain/scripts/bnb-boxes/local-chain.mjs';

const { createPublicClient, encodeFunctionData, erc20Abi, http } = createRequire(join(ROOT, 'packages/chain/package.json'))('viem');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const say = line => process.stdout.write(`${line}\n`);
const hex = n => `0x${BigInt(n).toString(16)}`;
const STEPS = fileURLToPath(new URL('./card-shop.mjs', import.meta.url));
const rehearsal = resolve(ROOT, flag('--rehearsal', 'hackathon/rehearsals/plain-97'));
const out = resolve(flag('--out', join(ROOT, '.cache/card-shop-proof', String(Date.now()))));
mkdirSync(out, { recursive: true });

function run(cmd, argv, { env = {} } = {}) {
  return new Promise(done => {
    const child = spawn(cmd, argv, { cwd: CONTRACTS, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let text = '';
    child.stdout.on('data', d => { text += d; }); child.stderr.on('data', d => { text += d; });
    child.on('close', (code, signal) => done({ code: code ?? signal, text }));
  });
}
/** One card-shop.mjs command as its own process; `stopAt` (lane d's hook, chain.mjs `SH_BNB_STOP_AT`) ends it hard
 * right before the Nth broadcast (its call and nonce already saved) or right after it (before its receipt). */
async function step(argv, { stopAt = '' } = {}) {
  say(`$ ${stopAt ? `SH_BNB_STOP_AT=${stopAt} ` : ''}card-shop.mjs ${argv.join(' ')}`);
  const r = await run(process.execPath, ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', STEPS, ...argv],
    { env: { SH_BNB_STOP_AT: stopAt } });
  for (const line of r.text.split('\n').filter(l => /^(sent|kept|done|\[dry\] (sent|done)|card shop step stopped|stopping hard)/.test(l))) say(`  ${line}`);
  return r;
}

/**
 * `--read-real <endpoint> --cards <97-cards.json>`: READ-ONLY checks of the card shop as it stands on the real chain
 * (eth_call only, nothing sent): the settings rebuilt from the repository's deployment files and the file's four
 * collections give the spec hash the file names and the box holds; the box's roles are the file's; the box graduated
 * with its gate open; the vault holds the 15 starter cards left after the pick and Legendary #1 is with the tester;
 * each tier's give and pick price in the vault's own terms equal the settings'; the tester holds ids 5 to 8.
 */
if (flag('--read-real')) {
  const { ALLOWED_RPCS } = await import('./bnb-testnet.mjs');
  const shop = await import('./card-shop.mjs');
  const { shopConfigV2 } = await import('../../../chain/src/core/v2/m2-spec-v2.ts');
  const upstream = flag('--read-real');
  assert.ok(ALLOWED_RPCS.includes(upstream), `a runbook endpoint: ${ALLOWED_RPCS.join(', ')}`);
  const file = JSON.parse(readFileSync(resolve(flag('--cards')), 'utf8'));
  const client = createPublicClient({ transport: http(upstream, { retryCount: 3 }) });
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const B = shop.artifact('BoxCoordinatorV2'); const V = shop.artifact('ShopVaultV2'); const C = shop.artifact('TestTradingCards');
  const keys = { 'common-cards': 'common', 'uncommon-cards': 'uncommon', 'rare-cards': 'rare', 'legendary-cards': 'legendary' };
  const cards = Object.fromEntries(Object.entries(keys).map(([k, f]) => [k, file.collections[f]]));
  const deployments = join(CONTRACTS, 'deployments');
  const built = await shop.buildSettings({ manifest: JSON.parse(readFileSync(join(deployments, 'core-v1/97.json'), 'utf8')),
    extras: JSON.parse(readFileSync(join(deployments, 'bnb-testnet/97-extras.json'), 'utf8')), cards, creator: file.starterHolder });
  const settings = shop.readSettingsDir(shop.writeSettings(join(out, 'settings'), built));
  const config = shopConfigV2(settings.spec.contentsParams);
  const box = file.box.coordinator; const vault = file.box.vault;
  const checks = [];
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const check = (name, ok, seen) => { checks.push({ name, ok, seen: String(seen) }); say(`${ok ? 'same' : 'DIFF'}  ${name}: ${seen}`); };
  const specHash = await read(box, B, 'specHash');
  check('settings rebuilt from the deployment files and the four collections = the file\'s spec hash', settings.specHash === file.box.specHash, settings.specHash);
  check('the box holds that spec', specHash === settings.specHash, specHash);
  for (const [name, fn, args, field] of [['token', 'token', [], 'boxToken'], ['vault', 'roleAddress', [3], 'vault'], ['starter loader', 'starterSetLoader', [], 'starterLoader'], ['hook', 'hook', [], 'hook']]) {
    const at = await read(box, B, fn, args);
    check(`box role ${name} = the file's`, same(at, file.box[field]), at);
  }
  check('graduated', await read(box, B, 'graduated') === true, 'true');
  check('gate open', await read(box, B, 'gateOpen') === true, 'true');
  const inside = await read(vault, V, 'inside');
  check('the vault holds 15 cards (16 starters, one picked)', inside === 15n, inside);
  for (const [tier, key] of shop.TIERS.entries()) {
    const [giveT, pickT, activeAt] = await read(vault, V, 'collectionTerms', [cards[key]]);
    check(`${key}: give price in the vault's terms = the settings' tier ${tier} price`, giveT === config.givePricesT[tier], giveT);
    check(`${key}: pick price in the vault's terms = twice it`, pickT === config.givePricesT[tier] * BigInt(config.pickBps) / 10000n, pickT);
    check(`${key}: sell-backs open seven days after creation`, activeAt - BigInt(file.box.createdAt) === 604_800n, activeAt);
    check(`${key}: the collection's tier and owner`, await read(cards[key], C, 'tier') === tier && same(await read(cards[key], C, 'owner'), DEPLOYER), tier);
    for (let id = 1n; id <= 8n; id++) {
      const owner = await read(cards[key], C, 'ownerOf', [id]);
      const want = id >= 5n ? file.testerHolder : key === 'legendary-cards' && id === 1n ? file.picks[0].to : vault;
      check(`${key} #${id} with ${id >= 5n ? 'the tester' : same(want, vault) ? 'the vault' : 'the pick\'s receiver'}`, same(owner, want), owner);
    }
  }
  const [, legendaryPick] = await read(vault, V, 'collectionTerms', [cards['legendary-cards']]);
  check('the pick price paid (the file) = the vault\'s Legendary pick price', BigInt(file.picks[0].pickPrice) === legendaryPick, legendaryPick);
  const result = { endpoint: upstream, block: (await client.getBlockNumber()).toString(), box, checks, ok: checks.every(c => c.ok) };
  writeFileSync(join(out, 'read-real.json'), json(result));
  say(`read-only proof against the real box ${result.ok ? 'GREEN' : 'RED'}: ${checks.filter(c => c.ok).length} of ${checks.length} checks at block ${result.block}; nothing sent`);
  process.exit(result.ok ? 0 : 1);
}

/**
 * `--fork-real <endpoint>`: the whole real run, dry, on a local fork of the REAL test network (anvil --fork-url, a free
 * port; nothing reaches that chain): the stock step (lane c's driver, the deploy wallet impersonated on the fork only),
 * the settings from the repository's deployment files, then create, load, graduate and pick (the tester, paid by the
 * deploy wallet) through lane d's nodeSender priced against the real endpoint's eth_gasPrice (refused below it).
 */
if (flag('--fork-real')) {
  const { ALLOWED_RPCS } = await import('./bnb-testnet.mjs');
  const { makeChain, nodeSender } = await import('../../../chain/scripts/bnb-boxes/chain.mjs');
  const { startFork } = await import('../../../chain/scripts/bnb-boxes/local-chain.mjs');
  const shop = await import('./card-shop.mjs');
  const upstream = flag('--fork-real');
  assert.ok(ALLOWED_RPCS.includes(upstream), `a runbook endpoint: ${ALLOWED_RPCS.join(', ')}`);
  const TESTER = '0xc979F6Cb8902f56f76b926358dC451cBF8f310F0'; // keystore hack-bob
  const fork = await startFork({ forkUrl: upstream, port: flag('--port') ? Number(flag('--port')) : await freePort() });
  const result = { upstream, fork: fork.url, ok: false };
  try {
    const url = fork.url;
    result.forkBlock = BigInt(await rpc(url, 'eth_blockNumber')).toString();
    result.deployerNonce = BigInt(await rpc(upstream, 'eth_getTransactionCount', [DEPLOYER, 'latest'])).toString();
    for (const who of [DEPLOYER, TESTER]) await rpc(url, 'anvil_impersonateAccount', [who]);
    const s = { chainId: 97, deployer: DEPLOYER };
    await runStep(STOCK_STEP, s, { extraArgs: [DEPLOYER, TESTER] }, { url, signer: ['--unlocked'], broadcastRoot: join(out, 'broadcast'),
      save: st => saveState(join(out, 'fork-driver-state.json'), st), log: (st, text) => writeFileSync(join(out, 'stock.log'), text) });
    const stockTx = s.gas[STOCK_STEP].transactions;
    result.stock = { cards: shop.cardsFromDriverState(s), transactions: stockTx.length, gasUsed: stockTx.reduce((a, t) => a + BigInt(t.gasUsed), 0n) };
    const deployments = join(CONTRACTS, 'deployments');
    const built = await shop.buildSettings({ manifest: JSON.parse(readFileSync(join(deployments, 'core-v1/97.json'), 'utf8')),
      extras: JSON.parse(readFileSync(join(deployments, 'bnb-testnet/97-extras.json'), 'utf8')), cards: result.stock.cards, creator: DEPLOYER });
    const settings = shop.readSettingsDir(shop.writeSettings(join(out, 'settings'), built));
    const store = stateStore(join(out, 'fork-state.json'));
    const chain = makeChain({ url, sender: nodeSender(url, { priceUrl: upstream }), store, clock: 'warp', log: line => say(`[fork] ${line}`) });
    const swapper = JSON.parse(readFileSync(join(deployments, 'bnb-testnet/97-extras.json'), 'utf8')).trade.swapper;
    result.create = await shop.create(chain, settings, DEPLOYER);
    result.load = await shop.load(chain, settings, DEPLOYER);
    result.graduate = await shop.graduate(chain, settings, DEPLOYER, { swapper });
    result.pick = await shop.pick(chain, settings, TESTER, { card: 'legendary-cards', id: 1n, to: TESTER, payer: DEPLOYER });
    const sent = Object.values(store.data.tx);
    result.boxSteps = { transactions: sent.length, gasUsed: sent.reduce((a, t) => a + BigInt(t.gasUsed ?? 0n), 0n),
      prices: [...new Set(sent.map(t => String(t.price)))], networkPrices: [...new Set(sent.map(t => String(t.network)))] };
    result.specHash = settings.specHash;
    result.ok = true;
    say(`fork of the real chain GREEN: stock ${result.stock.transactions} transactions, box steps ${sent.length} transactions at ${result.boxSteps.prices.join('/')} wei per gas; box ${result.create.box}`);
  } catch (error) {
    result.error = String(error.stack ?? error); process.exitCode = 1; say(`RED: ${result.error}`);
  } finally {
    fork.stop();
    writeFileSync(join(out, 'fork-real.json'), json(result));
    say(`result: ${join(out, 'fork-real.json')}`);
  }
  process.exit();
}

const port = flag('--port') ? Number(flag('--port')) : await freePort();
const node = await startChain({ dumpGz: join(rehearsal, 'anvil-state.json.gz'), workDir: out, port });
const result = { port, steps: [], ok: false };
try {
  const { url } = node;
  // Three throwaway keystores, each with its own random password (written to <dir>/<name>.pass for cast to read).
  const keystoreDir = join(out, 'keystores'); const passwordDir = join(out, 'passwords');
  mkdirSync(keystoreDir); mkdirSync(passwordDir);
  const names = { creator: 'card-creator', picker: 'card-alice', tester: 'card-bob' };
  const roles = {};
  for (const name of Object.values(names)) {
    const password = randomBytes(18).toString('hex');
    writeFileSync(join(passwordDir, `${name}.pass`), password, { mode: 0o600 });
    const made = await run('cast', ['wallet', 'new', keystoreDir, name, '--unsafe-password', password]);
    assert.equal(made.code, 0, `cast wallet new ${name}: ${made.text.slice(-300)}`);
    roles[name] = await roleAddress(keystoreRole(name, { keystoreDir, passwordDir }));
  }
  const creator = roles[names.creator]; const picker = roles[names.picker]; const tester = roles[names.tester];
  say(`roles: creator ${creator}, picker ${picker}, tester ${tester}`);
  // Local funding only: gas money, and the creator's tUSDC (payment and the graduation buy) from the impersonated deployer.
  const s = JSON.parse(readFileSync(join(rehearsal, 'state.json'), 'utf8'));
  await rpc(url, 'anvil_impersonateAccount', [DEPLOYER]);
  for (const who of [DEPLOYER, creator, picker, tester]) await rpc(url, 'anvil_setBalance', [who, hex(10n ** 19n)]);
  const fund = await rpc(url, 'eth_sendTransaction', [{ from: DEPLOYER, to: s.coins.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [creator, 10_000_000n] }) }]);
  assert.ok(fund, 'funded');
  // The stock step through lane c's driver (the deployer, unlocked on this node).
  const driverState = join(out, 'driver-state.json');
  await runStep(STOCK_STEP, s, { extraArgs: [creator, tester] }, { url, signer: ['--unlocked'], broadcastRoot: join(out, 'broadcast'),
    save: st => saveState(driverState, st), log: (st, text) => writeFileSync(join(out, 'stock.log'), text) });
  await rpc(url, 'anvil_stopImpersonatingAccount', [DEPLOYER]);
  // The settings step, from the rehearsal's read-back files and this driver state.
  const settingsDir = join(out, 'settings');
  const made = await step(['settings', '--driver-state', driverState, '--deployments', rehearsal, '--creator', creator, '--out', settingsDir]);
  assert.equal(made.code, 0, made.text.slice(-2000));

  const statePath = join(out, 'card-shop-state.json');
  const common = ['--rpc', url, '--local-proof', '--settings', settingsDir, '--state', statePath, '--keystore-dir', keystoreDir, '--password-dir', passwordDir];
  const nonces = async () => Object.fromEntries(await Promise.all(Object.entries(roles).map(async ([n, a]) => [n, BigInt(await rpc(url, 'eth_getTransactionCount', [a, 'latest']))])));
  const start = await nonces();
  const expectCode = (r, code, what) => { result.steps.push([what, r.code]); assert.equal(r.code, code, `${what}: ${r.text.slice(-3000)}`); };
  const cmd = (command, extra) => [command, ...common, ...extra];
  expectCode(await step(cmd('create', ['--creator', names.creator, '--dry'])), 0, 'create --dry');
  assert.deepEqual(await nonces(), start, 'a dry run sends nothing');
  expectCode(await step(cmd('create', ['--creator', names.creator]), { stopAt: 'before-publish:1' }), 137, 'create, stopped hard before broadcasting its approval');
  expectCode(await step(cmd('create', ['--creator', names.creator]), { stopAt: 'after-publish:1' }), 137, 'create, stopped hard right after a broadcast');
  expectCode(await step(cmd('create', ['--creator', names.creator])), 0, 'create, again');
  const afterCreate = await nonces();
  expectCode(await step(cmd('create', ['--creator', names.creator])), 0, 'create, once more');
  assert.deepEqual(await nonces(), afterCreate, 'a finished create sends nothing');
  expectCode(await step(cmd('load', ['--creator', names.creator, '--dry'])), 0, 'load --dry');
  assert.deepEqual(await nonces(), afterCreate, 'a dry load sends nothing');
  expectCode(await step(cmd('load', ['--creator', names.creator]), { stopAt: 'before-publish:4' }), 137, 'load, stopped hard before its fourth broadcast');
  expectCode(await step(cmd('load', ['--creator', names.creator]), { stopAt: 'after-publish:3' }), 137, 'load, stopped hard after its third broadcast');
  expectCode(await step(cmd('load', ['--creator', names.creator])), 0, 'load, again');
  expectCode(await step(cmd('graduate', ['--buyer', names.creator, '--swapper', s.dependencies.swapper]), { stopAt: 'after-publish:2' }), 137, 'graduate, stopped hard after its second broadcast');
  expectCode(await step(cmd('graduate', ['--buyer', names.creator, '--swapper', s.dependencies.swapper])), 0, 'graduate, again');
  const pickArgs = ['--picker', names.picker, '--payer', names.creator, '--card', 'legendary-cards', '--id', '1'];
  expectCode(await step(cmd('pick', pickArgs), { stopAt: 'before-publish:1' }), 137, 'pick, stopped hard before broadcasting the payment');
  expectCode(await step(cmd('pick', pickArgs), { stopAt: 'after-publish:1' }), 137, 'pick, stopped hard right after a broadcast');
  expectCode(await step(cmd('pick', pickArgs)), 0, 'pick, again');
  const afterPick = await nonces();
  expectCode(await step(cmd('pick', pickArgs)), 0, 'pick, once more');
  assert.deepEqual(await nonces(), afterPick, 'a finished pick sends nothing');

  // Every role's nonce grew by exactly the transactions the state file holds for it.
  const state = stateStore(statePath).data;
  const sentBy = {};
  for (const tx of Object.values(state.tx)) sentBy[tx.from.toLowerCase()] = (sentBy[tx.from.toLowerCase()] ?? 0n) + 1n;
  const end = await nonces();
  const grew = {};
  for (const [name, a] of Object.entries(roles)) if (end[name] !== start[name]) grew[a.toLowerCase()] = end[name] - start[name];
  assert.deepEqual(grew, sentBy, 'every role\'s nonce grew by exactly the transactions the state file holds');
  const client = createPublicClient({ transport: http(url) });
  const settings = JSON.parse(readFileSync(join(settingsDir, 'bindings.json'), 'utf8'));
  const owner = await client.readContract({ address: settings.collections['legendary-cards'], abi: [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] }], functionName: 'ownerOf', args: [1n] });
  assert.equal(owner.toLowerCase(), picker.toLowerCase(), 'the picked card is the picker\'s');
  Object.assign(result, { roles, start, end, sentBy, transactions: Object.values(sentBy).reduce((a, v) => a + v, 0n), ok: true });
  say(`proof GREEN: ${result.transactions} transactions through the keystore sender, each sent once; Legendary #1 with the picker`);
} catch (error) {
  result.error = String(error.stack ?? error);
  process.exitCode = 1;
  say(`RED: ${result.error}`);
} finally {
  node.stop();
  writeFileSync(join(out, 'proof.json'), json(result));
  say(`result: ${join(out, 'proof.json')}`);
}
