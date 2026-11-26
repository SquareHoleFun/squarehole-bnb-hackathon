#!/usr/bin/env node
/**
 * SH-286: the whole sequence of a box priced in a coin launched on Flap, rehearsed on a FORK of chain 97 pinned at one
 * block (nothing reaches the real chain; no key is used: the real wallets are impersonated on the fork only).
 *
 *   1. the lister role: the setter hands it back, the custody accepts it;
 *   2. the listing: the custody holds 10,000 raw units of the coin, approves the registry for them, adds the coin
 *      (class OTHER, a fixed raise);
 *   3. the role comes back: the custody proposes the setter, the setter accepts; atlas-real.mjs status and poke on the
 *      fork show the setter holds it and a poke goes through;
 *   4. the traders get the coin; the box's sheet is written from the chain's listing (rail-sheet.mjs); the box is created
 *      and read back, and lives (real.mjs create rail / life rail, the real wallets as impersonated roles).
 *
 * Steps 1 to 3 and the traders' coin are the cast commands the hand-back gives, with the same calldata; here each runs
 * with `--unlocked --from <wallet>` against the fork, and its check (a read) must answer as expected.
 *
 *   node packages/chain/scripts/bnb-boxes/rail-rehearsal.mjs --rpc <public chain-97 endpoint> [--block <n>]
 *     [--raise <raw>] [--port <n>] [--commands-only]
 */
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, parseAbi } from 'viem';
import { rpc } from './chain.mjs';
import { freePort, startFork } from './local-chain.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const say = line => process.stdout.write(`${line}\n`);

export const ADDR = Object.freeze({
  deployer: '0x2EF9A78074bbf674bEA16f21154a30c821A3C576',
  alice: '0x2908E3351ec8F20a8a6746773e42EA1D2FFb3c7F',
  bob: '0xc979F6Cb8902f56f76b926358dC451cBF8f310F0',
  keeper: '0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189',
  setter: '0x34A364Bd2E4129E92e1102245e582fe22aa266A8',
  custody: '0x974D108Cf896fb4b0981A13DF759349D44296d27',
  registry: '0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170',
  coin: '0x7Eb53F6D508a9c24A3d0594DB3C41f04FcC37777',
});
const RAISE = BigInt(flag('--raise', '400000000000000000000000'));
const PROBE = 10_000n;
const ALICE_COIN = 2_000_000n * 10n ** 18n;
const BOB_COIN = 1_000_000n * 10n ** 18n;
const REG = parseAbi(['function acceptLister()', 'function proposeLister(address)', 'function add(address,uint8,uint256) returns (uint32)']);
const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)']);
const inner = (abi, functionName, a) => encodeFunctionData({ abi, functionName, args: a });

/** The sequence: [step, wallet, to, signature, args, check: [to, signature, args, expected]]. */
export const STEPS = [
  ['1 the setter proposes the lister role back to the custody', 'deployer', ADDR.setter, 'handBack()', [], [ADDR.registry, 'pendingLister()(address)', [], ADDR.custody]],
  ['2 the custody accepts the lister role', 'deployer', ADDR.custody, 'execute(address,uint256,bytes)', [ADDR.registry, '0', inner(REG, 'acceptLister', [])], [ADDR.registry, 'lister()(address)', [], ADDR.custody]],
  ['3 the custody gets the probe\'s 10,000 raw PILE', 'deployer', ADDR.coin, 'transfer(address,uint256)(bool)', [ADDR.custody, String(PROBE)], [ADDR.coin, 'balanceOf(address)(uint256)', [ADDR.custody], `>=${PROBE}`]],
  ['4 the custody approves the registry for them', 'deployer', ADDR.custody, 'execute(address,uint256,bytes)', [ADDR.coin, '0', inner(ERC20, 'approve', [ADDR.registry, PROBE])], [ADDR.coin, 'allowance(address,address)(uint256)', [ADDR.custody, ADDR.registry], String(PROBE)]],
  ['5 the custody lists PILE (class OTHER, fixed raise)', 'deployer', ADDR.custody, 'execute(address,uint256,bytes)', [ADDR.registry, '0', inner(REG, 'add', [ADDR.coin, 5, RAISE])], [ADDR.registry, 'newestListingOf(address)(bool,uint32)', [ADDR.coin], 'listed']],
  ['6 the custody proposes the lister role to the setter', 'deployer', ADDR.custody, 'execute(address,uint256,bytes)', [ADDR.registry, '0', inner(REG, 'proposeLister', [ADDR.setter])], [ADDR.registry, 'pendingLister()(address)', [], ADDR.setter]],
  ['7 the setter accepts the lister role', 'deployer', ADDR.setter, 'accept()', [], [ADDR.registry, 'lister()(address)', [], ADDR.setter]],
  ['8 Alice gets 2,000,000 PILE for her trades', 'deployer', ADDR.coin, 'transfer(address,uint256)(bool)', [ADDR.alice, String(ALICE_COIN)], [ADDR.coin, 'balanceOf(address)(uint256)', [ADDR.alice], `>=${ALICE_COIN}`]],
  ['9 Bob gets 1,000,000 PILE for his trades', 'deployer', ADDR.coin, 'transfer(address,uint256)(bool)', [ADDR.bob, String(BOB_COIN)], [ADDR.coin, 'balanceOf(address)(uint256)', [ADDR.bob], `>=${BOB_COIN}`]],
];
const KEYSTORE = { deployer: 'hack-deployer' };
const q = value => (/^[0-9a-zA-Zx]+$/.test(value) ? value : `'${value}'`);

/** The real command of a step (the orchestrator's: a keystore through cast, legacy at 0.1 gwei) and its read-only check. */
export function realCommand([, wallet, to, sig, a, check]) {
  const send = `cast send ${to} ${q(sig)} ${a.map(q).join(' ')} --account ${KEYSTORE[wallet]} --password-file ~/.secrets/${KEYSTORE[wallet]}.pass --rpc-url "$RPC" --chain 97 --legacy --gas-price 100000000`.replace(/ {2,}/g, ' ');
  const dry = `cast call --from ${ADDR[wallet]} ${to} ${q(sig)} ${a.map(q).join(' ')} --rpc-url "$RPC"`.replace(/ {2,}/g, ' ');
  const read = `cast call ${check[0]} ${q(check[1])} ${check[2].map(q).join(' ')} --rpc-url "$RPC"   # expect ${check[3]}`.replace(/ {2,}/g, ' ');
  return { dry, send, read };
}

function cast(argv) {
  const r = spawnSync('cast', argv, { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`cast ${argv.slice(0, 3).join(' ')}: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout.trim();
}

function expectRead(url, check) {
  const [to, sig, a, expected] = check;
  const answer = cast(['call', to, sig, ...a, '--rpc-url', url]).split('\n');
  const first = answer[0].split(' ')[0];
  if (expected === 'listed') { assert.equal(first, 'true', `${sig}: listed`); return `listed as row ${answer[1].split(' ')[0]}`; }
  if (expected.startsWith('>=')) { assert.ok(BigInt(first) >= BigInt(expected.slice(2)), `${sig} ${first} >= ${expected.slice(2)}`); return first; }
  assert.equal(first.toLowerCase(), String(expected).toLowerCase(), `${sig}`);
  return first;
}

const seen = [];
function node(argv, env = {}) {
  say(`$ node ${argv.join(' ')}`);
  return new Promise(done => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const line = prefix => d => { for (const l of String(d).split('\n')) if (l && !/ExperimentalWarning|trace-warnings/.test(l)) { seen.push(l); say(`  ${prefix}${l}`); } };
    child.stdout.on('data', line(''));
    child.stderr.on('data', line('! '));
    child.on('close', code => done(code));
  });
}

if (args.includes('--commands-only')) {
  for (const step of STEPS) { const c = realCommand(step); say(`# ${step[0]} (from ${KEYSTORE[step[1]]})\n${c.dry}\n${c.send}\n${c.read}\n`); }
  process.exit(0);
}

const upstream = flag('--rpc');
assert.ok(/^https:\/\//.test(upstream ?? ''), '--rpc <a public chain-97 endpoint>');
const block = flag('--block') ?? BigInt(await rpc(upstream, 'eth_blockNumber')).toString();
const fork = await startFork({ forkUrl: upstream, port: Number(flag('--port', String(await freePort()))), forkBlock: block });
const work = join(ROOT, '.cache/bnb-boxes', `rail-${block}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const result = { block, fork: fork.url, steps: [], ok: false };
say(`fork of ${upstream} at block ${block} (${fork.url}); nothing is sent to the real chain`);
try {
  const before = {};
  for (const [name, address] of Object.entries(ADDR)) if (['deployer', 'alice', 'bob', 'keeper'].includes(name)) before[name] = BigInt(await rpc(fork.url, 'eth_getBalance', [address, 'latest']));
  say(`tBNB at the block: ${Object.entries(before).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  // A trader without tBNB for gas gets 0.05 on the fork only (reported: the real run must send it first).
  result.forkOnlyGas = [];
  for (const name of ['alice', 'bob']) {
    if (before[name] < 5n * 10n ** 16n) { await rpc(fork.url, 'anvil_setBalance', [ADDR[name], '0xb1a2bc2ec50000']); result.forkOnlyGas.push(name); before[name] = 5n * 10n ** 16n; }
  }
  if (result.forkOnlyGas.length) say(`given 0.05 tBNB on the fork only (the real run must send it): ${result.forkOnlyGas.join(', ')}`);
  await rpc(fork.url, 'anvil_impersonateAccount', [ADDR.deployer]);
  for (const step of STEPS) {
    const [label, wallet, to, sig, a, check] = step;
    const out = cast(['send', to, sig, ...a, '--unlocked', '--from', ADDR[wallet], '--rpc-url', fork.url, '--legacy', '--gas-price', '100000000', '--json']);
    const receipt = JSON.parse(out);
    assert.equal(receipt.status, '0x1', `${label}: success`);
    const read = expectRead(fork.url, check);
    result.steps.push({ label, hash: receipt.transactionHash, gasUsed: BigInt(receipt.gasUsed).toString(), read });
    say(`${label}: ${receipt.transactionHash}, gas ${BigInt(receipt.gasUsed)}; check: ${read}`);
    if (label.startsWith('7')) {
      // The role is back: the Atlas tool's status and poke on this fork.
      result.status = await node(['packages/contracts/script/bnb/atlas-real.mjs', 'status', '--fork', fork.url]);
      result.poke = await node(['packages/contracts/script/bnb/atlas-real.mjs', 'poke', '--fork', fork.url]);
      assert.equal(result.status, 0, 'atlas-real.mjs status');
      assert.equal(result.poke, 0, 'atlas-real.mjs poke');
    }
  }
  result.sequenceGas = result.steps.reduce((n, s) => n + BigInt(s.gasUsed), 0n).toString();
  // The box: its sheet from the chain's listing, then the demo boxes' own creation and life, the real wallets
  // impersonated on this fork (real.mjs --local-proof takes 0x roles as impersonated accounts).
  // The eat module (the directory's built-in row 0) is selectable from its readyAt (26 November 2026, 15:15:02 +07):
  // before it the factory refuses the createBox (InvalidChoice in the receiver's verifyModules). The fork's clock moves
  // past it here; the real creation waits for it.
  // --rule holders needs no module row and no clock move.
  const rule = flag('--rule', 'eat');
  const box = rule === 'eat' ? 'rail' : 'railholders';
  const sheet = join(ROOT, `.cache/bnb-boxes/rail/${rule === 'eat' ? 'pile-furnace' : 'pile-party'}-boxspec-v2.json`);
  const state = join(work, 'rail.json');
  const common = ['--rpc', fork.url, '--files', '.', '--state', state, '--local-proof', '--creator', ADDR.deployer];
  result.rule = rule;
  result.sheet = await node(['packages/chain/scripts/bnb-boxes/rail-sheet.mjs', '--rpc', fork.url, '--files', '.', '--token', ADDR.coin, '--out', sheet, '--rule', rule]);
  assert.equal(result.sheet, 0, 'the sheet');
  if (rule === 'eat') {
    // Before the eat module's day the creation is refused with nothing sent.
    const nonce = await rpc(fork.url, 'eth_getTransactionCount', [ADDR.deployer, 'latest']);
    result.early = await node(['packages/chain/scripts/bnb-boxes/real.mjs', 'create', box, ...common]);
    assert.equal(result.early, 1, 'the early creation is refused');
    assert.ok(seen.some(l => l.includes('is not selectable yet')), 'refused for the eat module\'s day');
    assert.equal(await rpc(fork.url, 'eth_getTransactionCount', [ADDR.deployer, 'latest']), nonce, 'nothing was sent');
    const warp = BigInt(flag('--warp-to', '1795680903'));
    await rpc(fork.url, 'evm_setNextBlockTimestamp', [`0x${warp.toString(16)}`]);
    await rpc(fork.url, 'evm_mine');
    say(`the fork's clock moved to ${warp} (past the eat module's readyAt 1795680902)`);
  }
  result.create = await node(['packages/chain/scripts/bnb-boxes/real.mjs', 'create', box, ...common]);
  if (result.create !== 0) {
    // The refused estimate's call, traced on this fork.
    const data = seen.map(l => /^\s*data:\s+(0x[0-9a-f]+)/.exec(l)?.[1]).filter(Boolean).at(-1);
    const to = seen.map(l => /^\s*to:\s+(0x[0-9a-fA-F]{40})/.exec(l)?.[1]).filter(Boolean).at(-1);
    if (data && to) {
      const r = spawnSync('cast', ['call', '--trace', '--from', ADDR.deployer, to, data, '--rpc-url', fork.url], { encoding: 'utf8', timeout: 300_000 });
      say(`trace of the refused call:\n${(r.stdout + r.stderr).split('\n').slice(-70).join('\n')}`);
    }
  }
  assert.equal(result.create, 0, 'the creation');
  result.life = await node(['packages/chain/scripts/bnb-boxes/real.mjs', 'life', box, ...common, '--a', ADDR.alice, '--b', ADDR.bob, '--keeper', ADDR.deployer, '--out', join(work, 'rail-life.json')]);
  assert.equal(result.life, 0, 'the life');
  const after = {};
  for (const name of Object.keys(before)) after[name] = BigInt(await rpc(fork.url, 'eth_getBalance', [ADDR[name], 'latest']));
  result.tbnbSpent = Object.fromEntries(Object.keys(before).map(name => [name, (before[name] - after[name]).toString()]));
  say(`tBNB spent on the fork (gas at the fork's prices): ${JSON.stringify(result.tbnbSpent)}`);
  result.ok = true;
  say('rehearsal GREEN');
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
  say(`RED: ${result.error}`);
} finally {
  fork.stop();
  writeFileSync(join(work, 'rehearsal.json'), `${JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  say(`result: ${join(work, 'rehearsal.json')}`);
}
