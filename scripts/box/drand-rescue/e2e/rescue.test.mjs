import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startLocalCoreChain } from '../../../../packages/chain/scripts/local-core-chain.mjs';
import { main } from '../main.mjs';
import { ABI } from '../abi.mjs';
import { viem } from '../deps.mjs';
import { roundTime } from '../quicknet.mjs';
import { connection, errorName, hex } from '../chain.mjs';

const { generatePrivateKey, privateKeyToAccount } = createRequire(
  new URL('../../../../packages/keeper/package.json', import.meta.url),
)('viem/accounts');
const rehearsalAbi = [...ABI, ...viem.parseAbi([
  'function enterTerminal()',
  'event GraduationWordStored(bytes32 word, uint256 placeholders, uint256 readyAt)',
])];

test('withheld graduation round is rescued before silence and stays usable after it', { timeout: 600000 }, async t => {
  const port = Number(process.env.SH_RESCUE_E2E_PORT ?? '8584');
  assert.ok(Number.isInteger(port) && port >= 8550 && port <= 8599, 'SH_RESCUE_E2E_PORT must be within 8550-8599');
  const out = `.cache/drand-rescue/e2e-${randomBytes(6).toString('hex')}`;
  await mkdir(out, { recursive: true });
  const chain = await startLocalCoreChain({ port, outDir: out, log: line => process.stderr.write(`${line}\n`) });
  t.after(() => chain.stop());
  await chain.life({ until: 'graduated' }); // No keeper: the round is deliberately withheld.
  const vectors = JSON.parse(await readFile('packages/contracts/test/vectors/drand-quicknet-box.json', 'utf8'));
  const keyName = `RESCUE_E2E_${randomBytes(6).toString('hex')}`;
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const relay = 'https://offline-rescue.invalid';
  let output = '';
  const hashes = [];
  const io = {
    env: { [keyName]: key }, stdin: Readable.from(['yes\n']), spawn,
    stdout: { write: text => { output += text; } }, stderr: { write: text => { output += text; } },
    fetch: async (url, init) => {
      if (url.startsWith(`${relay}/`)) {
        const round = BigInt(url.split('/').at(-1));
        const i = vectors.rounds.findIndex(r => BigInt(r) === round);
        assert.notEqual(i, -1, 'rehearsal must request a committed round');
        return Response.json({ round: String(round), signature: vectors.signatures[i].slice(2), randomness: vectors.randomness[i].slice(2) });
      }
      const request = JSON.parse(init.body);
      assert.notEqual(request.method, 'eth_getLogs');
      const response = await globalThis.fetch(url, init);
      if (request.method === 'eth_sendRawTransaction') {
        const body = await response.clone().json();
        if (body.result) hashes.push(body.result);
      }
      return response;
    },
  };
  const conn = connection(io, chain.rpcUrl);
  const read = (name, args = []) => conn.client.readContract({
    address: name === 'requestOf' ? chain.randomness : chain.tickets, abi: ABI, functionName: name, args,
  });
  const [requestedAt, round] = await read('requestOf', [chain.tickets, 0n]);
  await conn.rpc('anvil_setBalance', [account.address, hex(10n ** 18n)]);
  const warp = async timestamp => {
    await conn.rpc('evm_setNextBlockTimestamp', [hex(timestamp)]);
    await conn.rpc('evm_mine');
  };
  const terminal = () => conn.client.simulateContract({
    address: chain.tickets, abi: rehearsalAbi, functionName: 'enterTerminal', account: account.address,
  });
  const rejects = async name => {
    await assert.rejects(terminal, error => errorName(error) === name);
  };
  const deadline = requestedAt + 604800n;
  await warp(requestedAt + 6n * 86400n + 23n * 3600n);
  await rejects('HeadNotDead');
  const snapshot = await conn.rpc('evm_snapshot');
  await warp(deadline + 1n);
  await terminal(); // Control: without rescue, this really can enter terminal mode.
  assert.equal(await conn.rpc('evm_revert', [snapshot]), true);
  assert.ok((await conn.block()).now < deadline, 'snapshot must restore the request clock');
  // SH-RC8-DRAND-RESCUE requests 1 and 8 (integrator): before posting, a keyless plan on the twin, its placeholder
  // sender at zero balance, prints the real gas and fee quote, exits 0 and changes neither a nonce nor the state.
  const placeholder = '0x000000000000000000000000000000000000dEaD';
  await conn.rpc('anvil_setBalance', [placeholder, '0x0']);
  const unposted = () => conn.client.readContract({ address: chain.randomness, abi: ABI, functionName: 'wordOf', args: [chain.tickets, 0n] });
  const still = async () => [await conn.rpc('eth_blockNumber'), await conn.rpc('eth_getBalance', [placeholder, 'latest']),
    await conn.rpc('eth_getTransactionCount', [placeholder, 'latest']), await conn.rpc('eth_getTransactionCount', [account.address, 'latest']),
    (await unposted())[1], (await read('status')).wordAcceptedAt];
  const before = await still();
  assert.equal(BigInt(before[1]), 0n);
  assert.equal(before[4], 0n);
  let plan = '';
  const keyless = { ...io, env: {}, stdin: Readable.from([]), stdout: { write: text => { plan += text; } }, stderr: { write: text => { plan += text; } } };
  assert.equal(await main(['--now', '--manifest', chain.manifest, '--rpc', chain.rpcUrl, '--relay', relay], keyless), 0, plan);
  const quote = /^post tickets=\S+ key=0 round=(\d+) .* gas=(\d+) maxFee=(\d+) urgent=true totalWei=(\d+)$/m.exec(plan);
  assert.ok(quote, plan);
  const [base, tip] = [(await conn.block()).base, BigInt(await conn.rpc('eth_maxPriorityFeePerGas'))];
  assert.equal(BigInt(quote[1]), round);
  assert.ok(BigInt(quote[2]) > 21000n, plan);
  assert.equal(BigInt(quote[3]), 2n * base + tip);
  assert.equal(BigInt(quote[4]), BigInt(quote[2]) * BigInt(quote[3]));
  assert.match(plan, /plan only; no signer/);
  assert.deepEqual(await still(), before);
  const argv = ['--now', '--manifest', chain.manifest, '--rpc', chain.rpcUrl, '--key-env', keyName, '--relay', relay];
  assert.equal(await main(argv, io), 0, output);
  const logs = [];
  for (const hash of hashes) {
    const r = await conn.rpc('eth_getTransactionReceipt', [hash]);
    assert.equal(r.status, '0x1');
    for (const log of r.logs) {
      try { logs.push({ ...viem.decodeEventLog({ abi: rehearsalAbi, data: log.data, topics: log.topics, strict: true }), address: log.address }); }
      catch { /* other contract events */ }
    }
  }
  assert.ok(logs.some(l => l.eventName === 'RoundPosted' && l.args.round === round && l.address.toLowerCase() === chain.drand.toLowerCase()));
  assert.ok(logs.some(l => l.eventName === 'GraduationWordStored'));
  assert.notEqual(BigInt((await read('status')).wordAcceptedAt), 0n);
  await rejects('NothingPending');
  await warp(deadline + 1n);
  await rejects('NothingPending');
  const nonce = await conn.rpc('eth_getTransactionCount', [account.address, 'latest']);
  io.stdin = Readable.from(['yes\n']);
  assert.equal(await main(argv, io), 0, output);
  assert.equal(await conn.rpc('eth_getTransactionCount', [account.address, 'latest']), nonce);
  assert.ok(!output.includes(key));
});


test('withheld graduation round starts and fixes the backup, then accepts before silence', { timeout: 600000 }, async t => {
  const port = Number(process.env.SH_RESCUE_E2E_PORT ?? '8584');
  assert.ok(Number.isInteger(port) && port >= 8550 && port <= 8599, 'SH_RESCUE_E2E_PORT must be within 8550-8599');
  const out = `.cache/drand-rescue/backup-e2e-${randomBytes(6).toString('hex')}`;
  await mkdir(out, { recursive: true });
  const chain = await startLocalCoreChain({ port, outDir: out, log: line => process.stderr.write(`${line}\n`) });
  t.after(() => chain.stop());
  await chain.life({ until: 'graduated' });
  const relay = 'https://offline-backup.invalid';
  const hashes = [];
  let output = '';
  // The only relay is an injected 500. The integrator's only RPC here is the local twin.
  const io = {
    env: {}, stdin: Readable.from([]), spawn,
    stdout: { write: text => { output += text; } }, stderr: { write: text => { output += text; } },
    fetch: async (url, init) => {
      if (url.startsWith(`${relay}/`)) return new Response('', { status: 500 });
      assert.equal(url, chain.rpcUrl);
      const request = JSON.parse(init.body);
      assert.notEqual(request.method, 'eth_getLogs');
      const response = await globalThis.fetch(url, init);
      if (request.method === 'eth_sendRawTransaction') {
        const body = await response.clone().json();
        if (body.result) hashes.push(body.result);
      }
      return response;
    },
  };
  // Keep the random signer in this process's injected environment, never argv or disk.
  const keyName = `RESCUE_BACKUP_E2E_${randomBytes(6).toString('hex')}`;
  const signingKey = generatePrivateKey();
  const signer = privateKeyToAccount(signingKey);
  io.env[keyName] = signingKey;
  const conn = connection(io, chain.rpcUrl);
  const read = (functionName, args = []) => conn.client.readContract({
    address: ['requestOf', 'wordOf', 'backupOf', 'DRAND'].includes(functionName) ? chain.randomness : chain.tickets,
    abi: ABI, functionName, args,
  });
  assert.equal((await read('source')).toLowerCase(), chain.randomness.toLowerCase());
  assert.equal((await read('DRAND')).toLowerCase(), chain.drand.toLowerCase());
  const [requestedAt, round] = await read('requestOf', [chain.tickets, 0n]);
  assert.equal((await read('wordOf', [chain.tickets, 0n]))[1], 0n);
  await conn.rpc('anvil_setBalance', [signer.address, hex(10n ** 18n)]);
  await conn.rpc('evm_setNextBlockTimestamp', [hex(roundTime(round) + 432000n + 3600n)]);
  await conn.rpc('evm_mine');
  const argv = ['--now', '--manifest', chain.manifest, '--rpc', chain.rpcUrl, '--key-env', keyName, '--relay', relay, '--yes'];
  assert.equal(await main(argv, io), 1, output); // The relay failure remains exit 1 even though the start succeeds.
  assert.match(output, /post no valid relay answer/);
  assert.match(output, /backup started target=/);
  assert.equal(hashes.length, 1, output);
  const [startedAt, targetBlock, fixedAt] = await read('backupOf', [round]);
  assert.ok(startedAt > roundTime(round) + 432000n);
  assert.equal(fixedAt, 0n);
  const latest = (await conn.block()).number;
  await conn.rpc('anvil_mine', [hex(targetBlock - latest + 96n), '0xc']);
  const assumption = "rescue backup E2E assumes Anvil's finalized tag exists and reaches the target after mining to target + 96 at 12 seconds per block";
  let final;
  try { final = await conn.rpc('eth_getBlockByNumber', ['finalized', false]); }
  catch { assert.fail(assumption); }
  const head = await conn.block();
  assert.ok(final?.number != null && BigInt(final.number) >= targetBlock && BigInt(final.number) <= head.number, assumption);
  t.diagnostic(`Anvil finalized=${BigInt(final.number)} target=${targetBlock} latest=${head.number}; ${assumption}`);
  assert.ok(head.now + 96n <= requestedAt + 604800n, 'the backup still has time to fix');
  output = '';
  assert.equal(await main(argv, io), 0, output);
  assert.match(output, /backup fixed/);
  assert.equal(hashes.length, 3, output);
  const events = [];
  for (const hash of hashes) {
    const receipt = await conn.rpc('eth_getTransactionReceipt', [hash]);
    assert.equal(receipt.status, '0x1');
    for (const log of receipt.logs) {
      try { events.push({ ...viem.decodeEventLog({ abi: rehearsalAbi, data: log.data, topics: log.topics, strict: true }), address: log.address }); }
      catch { /* other contract events */ }
    }
  }
  for (const name of ['BackupStarted', 'BackupFixed']) assert.ok(events.some(e => e.eventName === name
    && e.args.round === round && e.args.targetBlock === targetBlock && e.address.toLowerCase() === chain.randomness.toLowerCase()), name);
  assert.ok(events.some(e => e.eventName === 'GraduationWordStored' && e.address.toLowerCase() === chain.tickets.toLowerCase()));
  assert.ok(!events.some(e => e.eventName === 'RoundPosted'));
  assert.ok(BigInt((await read('status')).wordAcceptedAt) > 0n);
  await assert.rejects(conn.client.simulateContract({ address: chain.tickets, abi: rehearsalAbi,
    functionName: 'enterTerminal', account: signer.address }), error => errorName(error) === 'NothingPending');
  assert.ok(!output.includes(signingKey));
});
