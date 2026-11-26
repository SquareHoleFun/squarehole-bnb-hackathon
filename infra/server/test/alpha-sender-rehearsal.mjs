#!/usr/bin/env node
// SH-181's local rehearsal of the alpha sender, opt-in (not part of `pnpm verify` or `pnpm test:infra`;
// docs/evidence/SH-SENDER-SAME-BLOCK.md):
//
//   node infra/server/test/alpha-sender-rehearsal.mjs --port 8612 --out <folder> [--claims 2] [--block-time 12] [--cycle 12]
//
// It starts its own Anvil on 127.0.0.1:<port> (refused if the port answers), as Sepolia: chain 11155111, a block every
// --block-time seconds. W (a fixture account) deploys the repository's TestETH (packages/contracts/out, the real
// artifact) and gives the desk setAdmitter(desk, 20); the desk holds a 1 SepETH float. Fixture testers queue --claims
// claims at once. The production engine and adapter (engine.mjs, chain.mjs: live mode, twelve canonical confirmations,
// a real signer on a fixture key) run a cycle every --cycle seconds, as the service does. The timeline shows when each
// claim was signed and broadcast, the block of each transaction, and when its receipt was written. Only fixture keys,
// no external RPC, no network. Anvil is stopped at the end by the PID this started.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSender } from '../services/alpha/sender/engine.mjs';
import { createChain, abi, STARTER } from '../services/alpha/sender/chain.mjs';
import { account, claim, desk, id, viem } from './fixtures/alpha-sender/helpers.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => i % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[i + 1]]], []));
const port = Number(args.port), blockTime = Number(args['block-time'] ?? 12), cycleSeconds = Number(args.cycle ?? 12);
const claims = Number(args.claims ?? 2), out = args.out && resolve(args.out);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !out || !Number.isInteger(claims) || claims < 1 || claims > 5
  || !(blockTime > 0) || !(cycleSeconds > 0)) {
  process.stderr.write('usage: node infra/server/test/alpha-sender-rehearsal.mjs --port <local port> --out <folder> [--claims 1-5] [--block-time s] [--cycle s]\n');
  process.exit(2);
}
const answers = () => new Promise(done => {
  const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});
if (await answers()) { process.stderr.write(`port ${port} answers already; nothing started\n`); process.exit(3); }
// A journal from an earlier run would be resumed (the deployment is deterministic): one fresh folder per run.
if (existsSync(join(out, 'state', 'journal.json'))) { process.stderr.write(`${out} holds an earlier run; use a fresh folder\n`); process.exit(2); }
const paths = Object.fromEntries(['queue', 'receipts', 'state'].map(k => [k, join(out, k)]));
for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });

const artifact = JSON.parse(readFileSync(new URL('../../../packages/contracts/out/TestETH.sol/TestETH.json', import.meta.url), 'utf8'));
if (JSON.stringify(artifact.metadata.settings.compilationTarget) !== JSON.stringify({ 'src/test-coins/TestETH.sol': 'TestETH' })) throw new Error('not the TestETH artifact');
const rpcUrl = `http://127.0.0.1:${port}`, owner = account(800), started = Date.now();
const lines = [], at = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
const say = line => { lines.push(line); process.stdout.write(`${line}\n`); };

const log = openSync(join(out, 'anvil.log'), 'a');
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--accounts', '0', '--chain-id', '11155111',
  '--hardfork', 'cancun'], { stdio: ['ignore', log, log] });
let stopping = false;
const stop = async () => {
  if (stopping || anvil.exitCode !== null) return;
  stopping = true;
  await new Promise(done => { anvil.once('exit', done); anvil.kill('SIGINT'); });
  say(`anvil ${anvil.pid} stopped`);
};
try {
  for (let tries = 0; !await answers(); tries++) {
    if (anvil.exitCode !== null || tries > 60) throw new Error('anvil did not start');
    await delay(250);
  }
  say(`anvil ${anvil.pid} on 127.0.0.1:${port}, chain 11155111`);
  const pub = viem.createPublicClient({ transport: viem.http(rpcUrl), cacheTime: 0 });
  const wallet = viem.createWalletClient({ account: owner, transport: viem.http(rpcUrl), chain: viem.defineChain({ id: 11155111,
    name: 'rehearsal', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }) });
  await pub.request({ method: 'anvil_setBalance', params: [owner.address, viem.toHex(10n ** 19n)] });
  await pub.request({ method: 'anvil_setBalance', params: [desk.address, viem.toHex(10n ** 18n)] }); // the 1 SepETH float
  const deploy = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address] });
  const teth = (await pub.waitForTransactionReceipt({ hash: deploy })).contractAddress;
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: teth, abi, functionName: 'setAdmitter', args: [desk.address, 20n] }) });
  // From here on, a block every blockTime seconds, as on Sepolia; the transactions wait in the pool until then.
  await pub.request({ method: 'evm_setAutomine', params: [false] });
  await pub.request({ method: 'evm_setIntervalMining', params: [blockTime] });
  say(`TestETH ${teth} (W ${owner.address}); setAdmitter(desk ${desk.address}, 20); desk float 1 SepETH; a block every ${blockTime} s`);

  const chain = createChain({ rpcUrl, address: desk.address, teth, account: desk }); // twelve confirmations, as deployed
  const events = [];
  const head = () => pub.getBlockNumber({ cacheTime: 0 });
  const watched = { ...chain,
    async prepare(...input) { const tx = await chain.prepare(...input); events.push({ at: Date.now(), event: 'signed', kind: tx.kind, nonce: tx.nonce, hash: tx.hash, head: await head() }); return tx; },
    async broadcast(tx) { const result = await chain.broadcast(tx); events.push({ at: Date.now(), event: 'broadcast', kind: tx.kind, hash: tx.hash, head: await head() }); return result; },
  };
  const testers = Array.from({ length: claims }, (_, i) => i + 1);
  for (const n of testers) { const c = await claim(n); writeFileSync(join(paths.queue, `${c.id}.json`), JSON.stringify(c)); }
  say(`${claims} claim(s) queued at head ${await head()}: ${testers.map(n => account(n).address).join(', ')}`);
  const queuedAt = Date.now();
  const sender = await createSender({ ...paths, chain: watched, address: desk.address, teth, mode: 'live' });
  const receipts = new Map(), mined = new Map();
  const deadline = Date.now() + (claims * 30 + 6) * Math.max(blockTime, cycleSeconds) * 1000;
  try {
    while (receipts.size < claims) {
      if (Date.now() > deadline) throw new Error('rehearsal did not finish in time');
      const cycleAt = Date.now(), done = await sender.cycle(), now = await head();
      const journal = JSON.parse(readFileSync(join(paths.state, 'journal.json'), 'utf8')).entries;
      for (const e of journal) {
        for (const tx of [e.admit, e.send].filter(Boolean)) {
          if (mined.has(tx.hash)) continue;
          const r = await pub.getTransactionReceipt({ hash: tx.hash }).catch(() => null);
          if (!r) continue;
          const { timestamp } = await pub.getBlock({ blockNumber: r.blockNumber });
          mined.set(tx.hash, { kind: tx.kind, claim: e.id, nonce: tx.nonce, block: r.blockNumber, status: r.status, at: Number(timestamp) * 1000 });
        }
        const file = join(paths.receipts, `${e.id}.json`);
        if (!receipts.has(e.id) && existsSync(file)) receipts.set(e.id, { receipt: JSON.parse(readFileSync(file, 'utf8')), head: now, at: Date.now() });
      }
      const monitor = sender.monitor();
      say(`${at()} s  cycle at head ${now}: done=${done} lastError=${monitor.lastError ?? 'none'} queue=${monitor.queueLength} journal=${journal.length} mined=${mined.size} receipts=${receipts.size}`);
      const wait = cycleSeconds * 1000 - (Date.now() - cycleAt);
      if (receipts.size < claims && wait > 0) await delay(wait);
    }
  } finally { sender.close(); }

  say('');
  say('claim | tester | signed at head | broadcast at head | admit block | starter block | receipt at head | s queued->broadcast | s queued->both mined (block time) | s queued->receipt | receipt');
  const summary = [];
  const journal = JSON.parse(readFileSync(join(paths.state, 'journal.json'), 'utf8')).entries;
  for (const [n, e] of testers.map(n => [n, journal.find(x => x.id === id(n))])) {
    const own = events.filter(v => v.hash === e.admit?.hash || v.hash === e.send?.hash);
    const signed = own.filter(v => v.event === 'signed'), sent = own.filter(v => v.event === 'broadcast');
    const admit = e.admit && mined.get(e.admit.hash), send = mined.get(e.send.hash), r = receipts.get(e.id);
    const both = Math.max(admit?.at ?? 0, send.at), seconds = t => Number(((t - queuedAt) / 1000).toFixed(1));
    const balance = await pub.getBalance({ address: account(n).address });
    const admitted = await pub.readContract({ address: teth, abi, functionName: 'admitted', args: [account(n).address] });
    const row = { claim: e.id, tester: account(n).address, signedHeads: signed.map(v => String(v.head)), broadcastHeads: sent.map(v => String(v.head)),
      admitNonce: e.admit?.nonce ?? null, sendNonce: e.send.nonce, admitBlock: admit ? String(admit.block) : null, sendBlock: String(send.block),
      receiptHead: String(r.head), secondsToBroadcast: sent.map(v => seconds(v.at)), secondsToMined: seconds(both), secondsToReceipt: seconds(r.at),
      receipt: r.receipt, starterWei: String(balance), starterExact: balance === STARTER, admitted };
    summary.push(row);
    say(`${n} | ${row.tester} | ${row.signedHeads.join(',')} | ${row.broadcastHeads.join(',')} | ${row.admitBlock} (nonce ${row.admitNonce}) | ${row.sendBlock} (nonce ${row.sendNonce}) | ${row.receiptHead} | ${row.secondsToBroadcast.join(',')} | ${row.secondsToMined} | ${row.secondsToReceipt} | ${row.receipt.status} ${row.receipt.admitTx?.slice(0, 10)}.. ${row.receipt.sendTx.slice(0, 10)}..; starter ${row.starterExact ? 'exactly 0.05' : row.starterWei} SepETH, admitted ${row.admitted}`);
  }
  say(`events: ${events.length} (signed ${events.filter(v => v.event === 'signed').length}, broadcast ${events.filter(v => v.event === 'broadcast').length}); desk nonce ${await pub.getTransactionCount({ address: desk.address })}`);
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ port, blockTime, cycleSeconds, claims, teth, desk: desk.address, rows: summary,
    events: events.map(v => ({ ...v, at: (v.at - queuedAt) / 1000, head: String(v.head) })) }, null, 2)}\n`);
} finally {
  await stop();
  writeFileSync(join(out, 'timeline.txt'), `${lines.join('\n')}\n`);
}
