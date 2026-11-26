#!/usr/bin/env node
/**
 * SH-272: a rehearsal of the move to Atlas's open feeds on a FORK of the real BNB Chain testnet (chain 97) at its head,
 * with the real commands in their dry form and in the real order: the deploy driver's extra-step path
 * (`runStep('extra:…')`, the same forge call, nonce bookkeeping and BNB| lines as `bnb-testnet.mjs deploy --extra`) with
 * the deployer impersonated at its real nonce and a FRESH state file (as the real run's), then the operator's tool
 * `atlas-real.mjs` with `--fork`. Nothing is sent to the real network: every transaction goes to the loopback anvil this
 * script starts and stops.
 *
 *   node --experimental-transform-types script/bnb/atlas-rehearse.mjs [--port 8597] [--target-usd-x18 <wei>]
 *
 * Steps:
 *   1. refused: deployOpen while the live setter holds the lister role (nothing sent); a setter built by hand at this
 *      moment (its returnTo is the live setter) is kept for step 4;
 *   2. handBack of the live setter: the holding contract is the lister again; the live setter's pokes and its
 *      updateRaise are tried against the registry;
 *   3. deployOpen: source, three addDirectFeed, setter; every row's quote answers with direct = true;
 *   4. refused: handover of the hand-built setter (its returnTo is not the holding contract), nothing sent;
 *   5. handover; a poke inside the 600 s after acceptance keeps the raise (RaiseKept, tooSoon);
 *   6. ten real minutes later: Atlas's own latest update of each feed, read from the real chain, is replayed on the fork
 *      from Atlas's updater (impersonated, the same calldata to the same feed), so each feed is fresh at the fork's
 *      clock; then `atlas-real.mjs status` and `poke` (dry form); a row the tool skips (under 2%) is poked by hand to
 *      show RaiseKept;
 *   7. `atlas-real.mjs record --fork --out <rehearsal folder>/97-atlas.json`.
 * Output: .cache/atlas-rehearsal/<time>/result.json and the recorded file beside it. About 12 minutes.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CONTRACTS, DEPLOYER, FORK_URL, KEEPER, ROOT, rpc, run, runStep } from './bnb-testnet.mjs';

const LISTINGS = '0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170';
/** The platform's holding contract (deployments/bnb-testnet/97-atlas.json, holdingContract). */
const CUSTODY = '0x974d108cf896fb4b0981a13df759349d44296d27';
const LIVE_SETTER = '0x2d7BE91672aa149F897064BabF8FfdeEBbf9B079';
const LIVE_SOURCE = '0x44B187F89Ad9aa2f0526a553eBD36425490Bb01D';
/** Atlas's feeds of the new source (as AtlasRaiseDeploy.s.sol), id -> feed. */
const FEEDS = { '0x00000279': '0x3957d289ee9C38272377786787ea34F9dd29788D', '0x000003a6': '0x3eF39d6361EfA1E8Ca066751f438077dA81082A6',
  '0x58415500': '0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764', '0x00000278': '0x35369dEcD8c662954B3D24acc2A862C708A34fD2' };
const ROWS = ['0', '2', '3', '5'];
const SCRIPT = 'script/bnb/AtlasRaiseDeploy.s.sol:AtlasRaiseDeploy';
const RAISE_KEPT_SIG = 'RaiseKept(uint32,uint256,uint256,bool,uint256,bool)';
const RAISE_SET_SIG = 'RaiseSet(uint32,uint256,uint256,uint256,bool,uint256,uint256)';
const json = v => `${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`;

const { values: o } = parseArgs({ options: { 'target-usd-x18': { type: 'string' }, port: { type: 'string' } } });
const target = o['target-usd-x18'] ?? '1000000000000000000';
const port = Number(o.port ?? 8597);
const url = `http://127.0.0.1:${port}`;
const out = join(ROOT, '.cache/atlas-rehearsal', String(Date.now()));
mkdirSync(out, { recursive: true });
const statePath = join(out, 'state.json');
const s = { chainId: 97, deployer: DEPLOYER };
const cast = async (...args) => {
  const { code, out: text } = await run('cast', args, { timeoutMs: 180_000 });
  if (code !== 0) throw Object.assign(new Error(`cast ${args[0]} failed: ${text.slice(-600)}`), { out: text });
  return text.trim();
};
const tool = async (...args) => {
  const { code, out: text } = await run('node', ['script/bnb/atlas-real.mjs', ...args, '--fork', url, '--state', statePath], { timeoutMs: 900_000 });
  return { code, lines: text.trim().split('\n') };
};
const raiseOf = async id => BigInt((await cast('call', '--rpc-url', url, LISTINGS, 'listing(uint32)((uint32,address,uint8,uint8,uint8,uint64,uint256))', String(id))).split(',').at(-1).trim().split(' ')[0].replace(')', ''));
const send = async (from, to, sig, ...args) => JSON.parse(await cast('send', '--rpc-url', url, '--unlocked', '--from', from, '--json', to, sig, ...args));
const nonceOf = () => rpc(url, 'eth_getTransactionCount', [DEPLOYER, 'latest']);
const words = hex => hex.slice(2).match(/.{64}/g).map(w => BigInt(`0x${w}`));
const revertOf = error => (String(error.out ?? error.message).match(/(execution reverted|revert)[^\n]*/) ?? [''])[0].slice(0, 200);

/** A step through the driver that must be refused before anything is sent. */
async function refused(step, extraArgs, ctx, expected) {
  const before = await nonceOf();
  try {
    await runStep(step, s, { extraArgs }, ctx);
  } catch (error) {
    delete s.pending;
    const reason = (String(error.out ?? '').match(expected) ?? [null])[0];
    const nonceMoved = (await nonceOf()) !== before;
    if (!reason || nonceMoved) throw new Error(`${step}: refused for another reason or after a send: ${String(error.out ?? error.message).slice(-800)}`, { cause: error });
    return { refused: true, reason, nonceMoved };
  }
  throw new Error(`${step} was not refused`);
}

const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(port), '--no-storage-caching'], { stdio: ['ignore', 'ignore', 'ignore'] });
const result = { anvilPid: anvil.pid, target, complete: false };
try {
  for (let i = 0; i < 60; i++) { try { await rpc(url, 'eth_chainId'); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
  if (BigInt(await rpc(url, 'eth_chainId')) !== 97n) throw new Error('not a fork of chain 97');
  if (!String(await rpc(url, 'web3_clientVersion')).startsWith('anvil/')) throw new Error('not anvil');
  const head = await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
  result.forkBlock = BigInt(head.number).toString(); result.forkTime = BigInt(head.timestamp).toString();
  for (const a of [DEPLOYER, KEEPER]) {
    await rpc(url, 'anvil_impersonateAccount', [a]);
    await rpc(url, 'anvil_setBalance', [a, '0x56BC75E2D63100000']);
  }
  result.listerAtFork = await cast('call', '--rpc-url', url, LISTINGS, 'lister()(address)');
  if (result.listerAtFork.toLowerCase() !== LIVE_SETTER.toLowerCase()) throw new Error(`the lister at the fork is ${result.listerAtFork}, not the live setter`);
  const ctx = { url, signer: ['--unlocked'], broadcastRoot: join(out, 'broadcast'), save: st => writeFileSync(statePath, json(st)),
    log: (step, text) => writeFileSync(join(out, `${step.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}-${Date.now()}.log`), text) };
  const deployStep = `extra:${SCRIPT}:deployOpen(address,address,uint256)`;
  const handBack = `extra:${SCRIPT}:handBack(address,address)`;
  const handover = `extra:${SCRIPT}:handover(address,address,address,uint256,address)`;

  // 1. deployOpen while the live setter holds the role: refused before anything is sent.
  result.deployWhileHeld = await refused(deployStep, [LISTINGS, CUSTODY, target], ctx, /the registry's lister is not the holding contract given[^"\n]*/);
  // A setter built by hand now (row 2 over the live source; its returnTo is the live setter), for step 4.
  const artifact = JSON.parse(readFileSync(join(CONTRACTS, 'out/AtlasRaise.sol/AtlasRaiseSetter.json'), 'utf8'));
  const args = (await cast('abi-encode', 'f(address,address,uint256,uint32[],uint8[],address[],bytes4[])', LISTINGS, DEPLOYER, target, '[2]', '[3]', `[${LIVE_SOURCE}]`, '[0x000003a6]')).slice(2);
  const made = JSON.parse(await cast('send', '--rpc-url', url, '--unlocked', '--from', DEPLOYER, '--json', '--create', `${artifact.bytecode.object}${args}`));
  result.wrongSetter = { address: made.contractAddress, returnTo: await cast('call', '--rpc-url', url, made.contractAddress, 'returnTo()(address)') };

  // 2. handBack of the live setter, through the driver.
  await runStep(handBack, s, { extraArgs: [LISTINGS, LIVE_SETTER] }, ctx);
  result.handBackGas = s.gas[handBack].transactions.map(x => ({ what: x.what, nonce: x.nonce, gasUsed: x.gasUsed, status: x.status }));
  result.listerAfterHandBack = await cast('call', '--rpc-url', url, LISTINGS, 'lister()(address)');
  if (result.listerAfterHandBack.toLowerCase() !== CUSTODY) throw new Error('the hand-back did not return the role to the holding contract');
  result.oldSetterAfterHandBack = {};
  for (const id of ['0', '2', '3']) {
    try { result.oldSetterAfterHandBack[`poke ${id}`] = `answered ${await cast('call', '--rpc-url', url, '--from', KEEPER, LIVE_SETTER, 'poke(uint32)(bool)', id)}`; }
    catch (error) { result.oldSetterAfterHandBack[`poke ${id}`] = `reverted: ${revertOf(error)}`; }
  }
  try { await cast('call', '--rpc-url', url, '--from', LIVE_SETTER, LISTINGS, 'updateRaise(uint32,uint256)', '2', '1000000000000000'); result.oldSetterAfterHandBack.updateRaise = 'answered'; }
  catch (error) { result.oldSetterAfterHandBack.updateRaise = `reverted: ${revertOf(error)}`; }

  // 3. deployOpen through the driver: predicted addresses, every row direct.
  const nonce = BigInt(await nonceOf());
  result.predicted = {};
  for (const [k, n] of [['atlasSource', nonce], ['atlasRaiseSetter', nonce + 4n]]) result.predicted[k] = (await cast('compute-address', '--nonce', n.toString(), DEPLOYER)).split(' ').at(-1);
  await runStep(deployStep, s, { extraArgs: [LISTINGS, CUSTODY, target] }, ctx);
  const printed = s.extra[deployStep];
  result.deployed = printed;
  for (const k of Object.keys(result.predicted)) if (printed[k]?.toLowerCase() !== result.predicted[k].toLowerCase()) throw new Error(`${k}: printed ${printed[k]}, predicted ${result.predicted[k]}`);
  result.deployGas = s.gas[deployStep].transactions.map(t => ({ what: t.what, nonce: t.nonce, gasUsed: t.gasUsed, status: t.status }));
  const { atlasSource: source, atlasRaiseSetter: setter } = printed;
  result.sourceFeeds = {};
  for (const [id, feed] of Object.entries(FEEDS)) {
    const bound = await cast('call', '--rpc-url', url, source, 'directFeedOf(bytes4)(address)', id);
    if (bound.toLowerCase() !== feed.toLowerCase()) throw new Error(`${id}: the source names ${bound}`);
    result.sourceFeeds[id] = { feed: bound, ageLimit: (await cast('call', '--rpc-url', url, source, 'ageLimitOf(bytes4)(uint256)', id)).split(' ')[0] };
  }
  result.sourceMirror = await cast('call', '--rpc-url', url, source, 'mirror()(address)');
  result.setterReturnTo = await cast('call', '--rpc-url', url, setter, 'returnTo()(address)');
  const quotes = async () => {
    const q = {};
    for (const id of ROWS) {
      const [raise, price, , onchainTs, direct] = (await cast('call', '--rpc-url', url, setter, 'quote(uint32)(uint256,uint256,uint256,uint256,bool)', id)).split('\n').map(x => x.trim().split(' ')[0]);
      const row = (await cast('call', '--rpc-url', url, setter, 'rows(uint32)(bool,uint8,uint8,address,bytes4,uint256,uint64)', id)).split('\n').map(x => x.trim().split(' ')[0]);
      q[id] = { raise, price, onchainTs, direct, startRaise: row[5], ceiling: (BigInt(row[5]) * 10n).toString(), current: (await raiseOf(id)).toString() };
      if (direct !== 'true') throw new Error(`row ${id} does not quote direct`);
    }
    return q;
  };
  result.quotesAfterDeploy = await quotes();
  result.halfAndDouble = {};
  for (const id of ROWS) {
    const raise = BigInt(result.quotesAfterDeploy[id].raise);
    let layoutAtHalf = 'ok';
    try { await cast('call', '--rpc-url', url, LISTINGS, 'checkLayout(uint256)', (raise / 2n).toString()); } catch { layoutAtHalf = 'refused'; }
    result.halfAndDouble[id] = { raiseAtDoublePrice: (raise / 2n).toString(), layoutAtHalf, raiseAtHalfPrice: (raise * 2n).toString(), ceiling: result.quotesAfterDeploy[id].ceiling,
      inside: layoutAtHalf === 'ok' && raise / 2n >= 1_000_000n && raise * 2n <= BigInt(result.quotesAfterDeploy[id].ceiling) };
  }

  // 4. handover of the hand-built setter: refused, nothing sent.
  result.wrongReturnTo = await refused(handover, [LISTINGS, result.wrongSetter.address, KEEPER, target, CUSTODY], ctx, /the setter would hand back to another holding contract/);

  // 5. handover; a poke inside the cooldown keeps the raise.
  await runStep(handover, s, { extraArgs: [LISTINGS, setter, KEEPER, target, CUSTODY] }, ctx);
  result.handoverGas = s.gas[handover].transactions.map(x => ({ what: x.what, nonce: x.nonce, gasUsed: x.gasUsed, status: x.status }));
  result.listerAfterHandover = await cast('call', '--rpc-url', url, LISTINGS, 'lister()(address)');
  result.acceptedAt = (await cast('call', '--rpc-url', url, setter, 'acceptedAt()(uint256)')).split(' ')[0];
  const keptTopic = (await cast('keccak', RAISE_KEPT_SIG)).toLowerCase();
  const setTopic = (await cast('keccak', RAISE_SET_SIG)).toLowerCase();
  const eventsOf = r => r.logs.filter(l => l.address.toLowerCase() === setter.toLowerCase()).map(l => {
    const w = words(l.data);
    return l.topics[0] === keptTopic ? { event: 'RaiseKept', listingId: Number(BigInt(l.topics[1])), price: w[0], direct: w[2] === 1n, raise: w[3], tooSoon: w[4] === 1n }
      : l.topics[0] === setTopic ? { event: 'RaiseSet', listingId: Number(BigInt(l.topics[1])), price: w[0], direct: w[3] === 1n, oldRaise: w[4], newRaise: w[5] } : { event: l.topics[0] };
  });
  const inCooldown = await send(KEEPER, setter, 'poke(uint32)', '5');
  result.pokeInCooldown = { status: inCooldown.status, gasUsed: BigInt(inCooldown.gasUsed).toString(), events: eventsOf(inCooldown), raise5: (await raiseOf(5)).toString() };
  if (!result.pokeInCooldown.events.some(e => e.event === 'RaiseKept' && e.tooSoon)) throw new Error('the poke in the cooldown did not keep the raise as too soon');
  result.statusInCooldown = await tool('status');
  writeFileSync(join(out, 'result.json'), json(result));

  // 6. ten real minutes; then Atlas's own latest updates replayed; the tool's status and poke.
  await new Promise(done => setTimeout(done, 615_000));
  const realHead = BigInt(await rpc(FORK_URL, 'eth_blockNumber'));
  result.replays = {};
  for (const [id, feed] of Object.entries(FEEDS)) {
    const logs = await rpc(FORK_URL, 'eth_getLogs', [{ address: feed, fromBlock: `0x${(realHead - 4000n).toString(16)}`, toBlock: `0x${realHead.toString(16)}` }]);
    if (!logs.length) throw new Error(`${id}: no update of ${feed} on the real chain in the last 4000 blocks`);
    const last = logs.at(-1);
    const tx = await rpc(FORK_URL, 'eth_getTransactionByHash', [last.transactionHash]);
    await rpc(url, 'anvil_impersonateAccount', [tx.from]);
    await rpc(url, 'anvil_setBalance', [tx.from, '0x56BC75E2D63100000']);
    const replay = JSON.parse(await cast('send', '--rpc-url', url, '--unlocked', '--from', tx.from, '--json', '--gas-limit', BigInt(tx.gas).toString(), tx.to, tx.input));
    result.replays[id] = { realTx: last.transactionHash, realBlock: BigInt(last.blockNumber).toString(), updater: tx.from, to: tx.to, status: replay.status };
    if (replay.status !== '0x1') throw new Error(`${id}: the replay failed`);
  }
  await rpc(url, 'evm_mine', []);
  result.quotesAfterReplay = await quotes();
  result.statusAfterCooldown = await tool('status');
  result.toolPoke = await tool('poke');
  if (result.toolPoke.code !== 0) throw new Error(`atlas-real poke failed: ${result.toolPoke.lines.join(' | ')}`);
  result.pokes = {};
  for (const id of ROWS) {
    const at = result.toolPoke.lines.findIndex(l => l.startsWith(`row ${id}: raise now`));
    if (at > 0) {
      const hash = result.toolPoke.lines[at - 1].match(/0x[0-9a-f]{64}/)?.[0];
      const r = JSON.parse(await cast('receipt', '--rpc-url', url, '--json', hash));
      result.pokes[id] = { by: 'atlas-real poke', hash, gasUsed: BigInt(r.gasUsed).toString(), events: eventsOf(r), raise: (await raiseOf(Number(id))).toString() };
    } else {
      const r = await send(KEEPER, setter, 'poke(uint32)', id);
      result.pokes[id] = { by: 'by hand (the tool skipped it)', skipped: result.toolPoke.lines.find(l => l.startsWith(`row ${id}:`)), gasUsed: BigInt(r.gasUsed).toString(), events: eventsOf(r), raise: (await raiseOf(Number(id))).toString() };
    }
  }

  // 7. record, into the rehearsal folder.
  result.record = await tool('record', '--out', join(out, '97-atlas.json'));
  if (result.record.code !== 0) throw new Error(`record failed: ${result.record.lines.join(' | ')}`);
  result.complete = true;
} catch (error) {
  result.error = String(error.stack ?? error);
} finally {
  anvil.kill('SIGTERM');
  writeFileSync(join(out, 'result.json'), json(result));
  process.stdout.write(`${result.complete ? 'ATLAS REHEARSAL COMPLETE' : 'ATLAS REHEARSAL FAILED'} -> ${out}\n`);
  if (!result.complete) { process.stdout.write(`${result.error}\n`); process.exitCode = 1; }
}
