#!/usr/bin/env node
/**
 * SH-261: the proof of the real-run mode (real.mjs) on a LOCAL chain with id 97. It runs the orchestrator's exact
 * commands, with `--local-proof` and `--keystore-dir` added, against anvil from the plain rehearsal's dump:
 *
 *   node packages/chain/scripts/bnb-boxes/proof.mjs <box> --keystore-dir <dir> --password-file <path>
 *     --creator <name> --a <name> --b <name> [--keeper <name>] [--items <dir>] [--settings <file>] [--port 8575] [--dry-port <port>] [--stop-before <n>] [--stop-after <n>] [--faults]
 *
 * The keystores are throwaway ones made by the caller for anvil's public test accounts; this script never reads them.
 * Steps: the roles get the price coin (local funding from the impersonated deployer); `create --dry`; `create`;
 * `create` again (must send nothing); `life --dry`; `life`, stopped hard right after its `--stop-after-sends`th send (before that receipt
 * is awaited) and run again to the end. Then the check that matters: every role's nonce grew by exactly the number of transactions the
 * state file holds for it, so nothing was sent twice.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keystoreRole, roleAddress, rpc, stateStore } from './chain.mjs';
import { localChain, plantMulticall3, startChain } from './local-chain.mjs';
import { startFaultProxy } from './fault-proxy.mjs';
import { ALLOWED_RPCS } from '../../../contracts/script/bnb/bnb-testnet.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REAL = fileURLToPath(new URL('./real.mjs', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const box = args[0];
const COINS = { stock: 'tNVDA', rentfree: 'tUSDC', converter: 'tUSDC' };
if (box === 'unmined') {
  const say = line => process.stdout.write(`${line}\n`);
  // `proof.mjs unmined`: a node that mines nothing (anvil --no-mining). One send through chain.mjs must stop after 45 s
  // with "sent but not mined", its price and the network's, and nothing more may be sent.
  const { makeChain, nodeSender, stateStore: store, rpc } = await import('./chain.mjs');
  const { anvil } = await import('./local-chain.mjs');
  const node = await anvil(['--no-mining', '--chain-id', '97'], Number(flag('--port', '8575')));
  const { url } = node;
  try {
    const [from] = await rpc(url, 'eth_accounts');
    const chain = makeChain({ url, sender: nodeSender(url), store: store(null), clock: 'wait', log: say });
    const started = Date.now();
    const outcome = await chain.act('one send', () => chain.sendRaw({ from, to: from, data: '0x', gas: 21_000n, label: 'a plain send' })).then(() => 'mined', error => error.message);
    const pending = BigInt(await rpc(url, 'eth_getTransactionCount', [from, 'pending'])) - BigInt(await rpc(url, 'eth_getTransactionCount', [from, 'latest']));
    say(`after ${Math.round((Date.now() - started) / 1000)} s: ${outcome}; transactions waiting: ${pending}`);
    assert.match(outcome, /^sent but not mined: 0x[0-9a-f]{64}, price .*, the network's price \d+$/);
    assert.equal(pending, 1n, 'nothing else was sent');
    say('unmined proof GREEN');
  } catch (error) {
    say(`RED: ${error.stack ?? error}`);
    process.exitCode = 1;
  } finally { node.stop(); }
  process.exit();
}
assert.ok(Object.hasOwn(COINS, box ?? ''), `usage: proof.mjs <${Object.keys(COINS).join('|')}> --keystore-dir <dir> --password-file <path> --creator <name> --a <name> --b <name>`);
const filesDir = resolve(ROOT, flag('--files', 'hackathon/rehearsals/plain-97'));
const workDir = join(ROOT, '.cache/bnb-boxes', `proof-${box}-${Date.now()}`);
mkdirSync(workDir, { recursive: true });
const statePath = join(workDir, `${box}-state.json`);
const port = Number(flag('--port', '8575'));
const say = line => process.stdout.write(`${line}\n`);
// One password file for all (--password-file) or one per keystore (--password-dir: <dir>/<name>.pass).
const keystore = ['--keystore-dir', resolve(flag('--keystore-dir')), ...(flag('--password-dir') ? ['--password-dir', resolve(flag('--password-dir'))] : ['--password-file', resolve(flag('--password-file'))])];
const names = { creator: flag('--creator'), a: flag('--a'), b: flag('--b'), keeper: flag('--keeper', flag('--creator')) };

/** One real.mjs command, its output prefixed; resolves with its exit code (or the signal that stopped it). */
function realRun(argv, { stopAfter = null, stopAt = '' } = {}) {
  say(`$ ${stopAt ? `SH_BNB_STOP_AT=${stopAt} ` : ''}node packages/chain/scripts/bnb-boxes/real.mjs ${argv.join(' ')}`);
  return new Promise(done => {
    const child = spawn(process.execPath, [REAL, ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SH_BNB_STOP_AT: stopAt } });
    const line = prefix => d => { for (const l of String(d).split('\n')) if (l && !/ExperimentalWarning|trace-warnings/.test(l)) say(`  ${prefix}${l}`); };
    child.stdout.on('data', line(''));
    child.stderr.on('data', line('! '));
    const timer = stopAfter ? setTimeout(() => { say(`  (stopping it after ${stopAfter} s)`); child.kill('SIGTERM'); }, stopAfter * 1000) : null;
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); done(code ?? signal); });
  });
}

const node = await startChain({ dumpGz: join(filesDir, 'anvil-state.json.gz'), workDir, port });
const result = { box, statePath, steps: [] };
let proxy = null;
try {
  const chain = localChain(node.url, { log: say });
  const roles = {};
  for (const [role, name] of Object.entries(names)) {
    roles[role] = /^0x[0-9a-fA-F]{40}$/.test(name) ? name
      : await roleAddress(keystoreRole(name, { keystoreDir: keystore[1], ...(keystore[2] === '--password-dir' ? { passwordDir: keystore[3] } : { passwordFile: keystore[3] }) }));
  }
  // An address role (the converter route's trigger) is impersonated by real.mjs on this node; it needs gas money here.
  for (const name of Object.values(names)) if (/^0x[0-9a-fA-F]{40}$/.test(name)) await rpc(node.url, 'anvil_setBalance', [name, '0xde0b6b3a7640000']);
  process.env.SH_TESTNET = 'bnb';
  const { releaseFiles } = await import('./launch.mjs');
  const listing = releaseFiles(filesDir).extras.listings.find(l => l.symbol === COINS[box]);
  // Local funding: the creator pays the bootstrap (creator buy 0); each trader gets ten raises of the price coin.
  await chain.fund(listing.token, roles.creator, BigInt(listing.raise));
  await chain.fund(listing.token, roles.a, 10n * BigInt(listing.raise));
  await chain.fund(listing.token, roles.b, 10n * BigInt(listing.raise));
  const nonces = async () => Object.fromEntries(await Promise.all(Object.entries(roles).map(async ([r, a]) => [r, BigInt(await chain.client.getTransactionCount({ address: a }))])));
  const start = await nonces();
  // --faults: every real-mode command talks to a proxy that answers like a busy endpoint (fault-proxy.mjs): sends go
  // through it, reads may fail over to the node itself (the list's second entry, also the dry runs' upstream).
  proxy = args.includes('--faults') ? await startFaultProxy({ target: node.url, port: Number(flag('--proxy-port', '8597')) }) : null;
  result.faults = proxy?.counts ?? null;
  const common = ['--rpc', proxy ? `${proxy.url},${node.url}` : node.url, '--files', filesDir, '--state', statePath, '--local-proof', ...keystore];
  if (box === 'rentfree') say(`Multicall3 on the local chain: ${await plantMulticall3(node.url, ALLOWED_RPCS[0])}`);
  if (box === 'converter') {
    // The local stand-in for waiting until the route's day: the local clock moves past route 6's readyAt.
    const route = releaseFiles(filesDir).extras.feeModuleDirectory.modules.find(m => m.name === 'converter tUSDC to tNVDA');
    await chain.mineTo(BigInt(route.readyAt) + 1n);
    say(`the local clock moved past route ${route.id}'s readyAt ${route.readyAt}`);
  }
  const create = ['create', box, ...common, '--creator', names.creator, ...(flag('--items') ? ['--items', resolve(flag('--items'))] : []),
    ...(flag('--settings') ? ['--settings', resolve(flag('--settings'))] : []), ...(box === 'converter' ? ['--keeper', names.keeper] : [])];
  const life = ['life', box, ...common, '--creator', names.creator, '--a', names.a, '--b', names.b, '--keeper', names.keeper];
  // The dry runs' forks: --dry-port, or a free port each chooses at start.
  const dry = flag('--dry-port') ? ['--dry', '--dry-port', flag('--dry-port')] : ['--dry'];
  result.steps.push(['create --dry', await realRun([...create, ...dry])]);
  const afterDry = await nonces();
  assert.deepEqual(afterDry, start, 'a dry run sends nothing');
  // Hard stops: after the approval was saved and before it was broadcast; then (the approval reconciled: its own bytes
  // broadcast again) right after the createBox was broadcast and before its receipt. Neither step is ever sent twice.
  result.steps.push(['create, stopped hard before publish 1', await realRun(create, { stopAt: 'before-publish:1' })]);
  assert.equal(result.steps.at(-1)[1], 137, 'the creation stopped after saving its approval');
  assert.deepEqual(await nonces(), start, 'nothing was broadcast before the stop');
  // --raise-moves: the listing's raise moves while the approval is saved and not broadcast: the next create must stop
  // with nothing sent (its nonce kept); with the raise back, the same saved approval is broadcast as it was.
  if (args.includes('--raise-moves')) {
    const { manifest } = releaseFiles(filesDir);
    const registry = manifest.releases[0].listingRegistry.address;
    const coreV2 = await import('../../src/core/v2/index.ts');
    const lister = await chain.read(registry, coreV2.listingRegistryV2Abi, 'lister');
    await rpc(node.url, 'anvil_impersonateAccount', [lister]);
    await rpc(node.url, 'anvil_setBalance', [lister, '0xde0b6b3a7640000']);
    const raise = BigInt(listing.raise);
    await chain.act('the raise moves', () => chain.send(lister, registry, coreV2.listingRegistryV2Abi, 'updateRaise', [BigInt(listing.id), raise + 1n]).then(r => r.transactionHash));
    result.steps.push(['create, the raise moved under the saved approval', await realRun(create)]);
    assert.equal(result.steps.at(-1)[1], 1, 'the creation stopped');
    assert.deepEqual(await nonces(), start, 'the raise moved under the saved approval: nothing was sent');
    await chain.act('the raise moves back', () => chain.send(lister, registry, coreV2.listingRegistryV2Abi, 'updateRaise', [BigInt(listing.id), raise]).then(r => r.transactionHash));
  }
  result.steps.push(['create, stopped hard after publish 1', await realRun(create, { stopAt: 'after-publish:1' })]);
  assert.equal(result.steps.at(-1)[1], 137, 'the creation stopped after broadcasting its createBox');
  result.steps.push(['create', await realRun(create)]);
  const afterCreate = await nonces();
  result.steps.push(['create again', await realRun(create)]);
  assert.deepEqual(await nonces(), afterCreate, 'a second create sends nothing');
  result.steps.push(['life --dry', await realRun([...life, ...dry])]);
  assert.deepEqual(await nonces(), afterCreate, 'a dry life sends nothing');
  // Hard stops in the middle of the life: after the Nth send was saved and before it was broadcast, then after the Mth
  // broadcast of the next run and before its receipt.
  result.steps.push(['life, stopped hard before publish', await realRun(life, { stopAt: `before-publish:${flag('--stop-before', '17')}` })]);
  assert.equal(result.steps.at(-1)[1], 137, 'the life stopped before a broadcast');
  result.steps.push(['life, stopped hard after publish', await realRun(life, { stopAt: `after-publish:${flag('--stop-after', '9')}` })]);
  assert.equal(result.steps.at(-1)[1], 137, 'the life stopped after a broadcast');
  result.steps.push(['life, again', await realRun([...life, '--out', join(workDir, `${box}-life.json`)])]);
  const end = await nonces();
  const state = stateStore(statePath).data;
  const sentBy = {};
  for (const tx of [...Object.values(state.tx), ...(state.memo['create:walletSent'] ?? [])]) {
    assert.ok(tx.hash && tx.from, 'every saved send has its hash and sender');
    sentBy[tx.from.toLowerCase()] = (sentBy[tx.from.toLowerCase()] ?? 0n) + 1n;
  }
  result.nonces = { start, end };
  result.sentBy = sentBy;
  const counted = {};
  for (const [role, address] of Object.entries(roles)) if (end[role] - start[role] > 0n || sentBy[address.toLowerCase()]) counted[address.toLowerCase()] = end[role] - start[role];
  assert.deepEqual(counted, sentBy, 'every role\'s nonce grew by exactly the transactions the state file holds');
  if (proxy) {
    say(`faults answered: ${JSON.stringify(proxy.counts)}`);
    for (const fault of ['nonceTooLow', 'send429', 'gasPrice429', 'jsonLimit', 'lagged']) assert.ok(proxy.counts[fault] > 0, `the proxy answered ${fault} at least once`);
  }
  result.ok = result.steps.every(([step, code]) => code === 0 || step.includes('stopped hard') || (step.includes('raise moved') && code === 1));
  say(`proof ${result.ok ? 'GREEN' : 'RED'}: ${Object.values(sentBy).reduce((n, v) => n + v, 0n)} transactions, each sent once`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  result.ok = false;
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
  say(`RED: ${result.error}`);
} finally {
  // The proxy and the node stop on every path (a RED included), so the process ends.
  proxy?.stop();
  node.stop();
  writeFileSync(join(workDir, 'proof.json'), `${JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  say(`result: ${join(workDir, 'proof.json')}`);
}
