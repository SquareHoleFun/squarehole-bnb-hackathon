import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { CONTRACTS, localOptions, assertLocalRpc, send, mineTo, run, waitIndexerFollows } from './core-v2-local-runtime.mjs';

test('SH-V2-E2E-LOCAL: ports are isolated, including environment overrides', () => {
  assert.equal(localOptions({}).chainPort, 8566);
  assert.equal(localOptions({}).appPort, 5396);
  for (const port of [8547, 8548, 8549, 8552, 8562, 8564, 0, 65536]) {
    assert.throws(() => localOptions({ SH_CORE_V2_CHAIN_PORT: String(port) }));
  }
  for (const port of [5391, 5392, 4173, 4174, 4175, 5173]) {
    assert.throws(() => localOptions({ DEV_PORT: String(port) }));
    assert.throws(() => localOptions({ SH_CORE_V2_GATEWAY_PORT: String(port) }));
  }
  assert.throws(() => localOptions({ DEV_PORT: '5395' })); // collides with the gateway
});

test('a Sepolia id alone never authorizes local transactions', async () => {
  const read = async (_url, method) => method === 'eth_chainId' ? '0xaa36a7' : 'anvil/v1.8.3';
  await assertLocalRpc('http://127.0.0.1:8566', read);
  await assert.rejects(assertLocalRpc('https://example.com', read), /loopback/);
  await assert.rejects(assertLocalRpc('http://user:secret@127.0.0.1:8566', read), /loopback/);
  await assert.rejects(assertLocalRpc('http://127.0.0.1:8566', async () => '0x1'), /chain/);
  await assert.rejects(assertLocalRpc('http://127.0.0.1:8566', async (_u, m) => m === 'eth_chainId' ? '0xaa36a7' : 'geth'), /anvil/);
});

test('reverted transactions never become successful life stages; raw amounts stay exact', async () => {
  const sent = [];
  const request = async (_url, method, params) => {
    if (method === 'eth_sendTransaction') { sent.push(params[0]); return '0x123'; }
    return { status: '0x0', transactionHash: '0x123' };
  };
  await assert.rejects(send('http://127.0.0.1:8566', { from: 'alice', to: 'box', value: 900719925474099312345n }, request), /reverted/);
  assert.equal(BigInt(sent[0].value), 900719925474099312345n);
});

// SH-229: a fake gateway (its /healthz answers in order, the last one repeated) and a fake clock that only `sleep` moves.
function indexerFakes(answers, head = '0x1f4') {
  const state = { ms: 0, reads: [], heads: 0 };
  const chain = { rpcUrl: 'http://127.0.0.1:8566', ports: { gatewayPort: 5389 } };
  const options = {
    request: async (url, method) => { assert.deepEqual([url, method], [chain.rpcUrl, 'eth_blockNumber']); state.heads += 1; return head; },
    read: async (url) => {
      state.reads.push(url);
      const answer = answers[Math.min(state.reads.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return { status: answer.status, json: async () => answer.body };
    },
    now: () => state.ms, sleep: async (ms) => { state.ms += ms; },
  };
  return { state, chain, options };
}
const behind = (block) => ({ status: 503, body: { ok: false, following: false, reason: `the index is at block ${block}, the chain at 500`, asOf: { block: String(block) } } });
const follows = (block) => ({ status: 200, body: { ok: true, following: true, reason: null, asOf: { block: String(block) } } });

test('SH-229: the wait ends only when the gateway follows the chain at the head read at its start', async () => {
  // Behind, then following but before the head (a quiet moment in its own backlog), then at the head.
  const { state, chain, options } = indexerFakes([behind(120), new Error('socket hang up'), follows(499), follows(500)]);
  assert.equal(await waitIndexerFollows(chain, options), 1500);
  assert.deepEqual(state.reads, Array(4).fill('http://127.0.0.1:5389/healthz'));
  assert.equal(state.heads, 1); // the head is read once: blocks mined while it waits belong to the test that follows
  // Already following past the head: no wait at all.
  const quiet = indexerFakes([follows(731)]);
  assert.equal(await waitIndexerFollows(quiet.chain, quiet.options), 0);
  assert.equal(quiet.state.reads.length, 1);
});

test('SH-229: an answer that does not prove a followed head keeps the wait going', async () => {
  for (const never of [
    { status: 503, body: { ok: false, following: true, reason: null, asOf: { block: '500' } } }, // the history is not healthy
    { status: 200, body: { ok: true, following: false, asOf: { block: '500' } } },
    { status: 200, body: { ok: true, following: 'yes', asOf: { block: '500' } } },
    { status: 200, body: { ok: true, following: true, asOf: null } }, // nothing indexed yet
    { status: 200, body: { ok: true, following: true, asOf: { block: '0x1f4' } } },
    { status: 200, body: { ok: true, following: true, asOf: { block: '499' } } },
    { status: 200, body: null },
  ]) {
    const { chain, options } = indexerFakes([never]);
    await assert.rejects(waitIndexerFollows(chain, { ...options, timeout: 2_000 }), /does not follow the chain at block 500 after 2000 ms/, JSON.stringify(never));
  }
});

test('SH-229: a wait that runs out names the block and the gateway’s last answer', async () => {
  const stuck = indexerFakes([behind(120)]);
  await assert.rejects(waitIndexerFollows(stuck.chain, { ...stuck.options, timeout: 3_000, interval: 1_000 }),
    /^Error: the local indexer does not follow the chain at block 500 after 3000 ms \(status 503, following false, block 120, the index is at block 120, the chain at 500\)$/);
  assert.equal(stuck.state.reads.length, 4); // at 0, 1, 2 and 3 s
  const silent = indexerFakes([new Error('connect ECONNREFUSED')]);
  await assert.rejects(waitIndexerFollows(silent.chain, { ...silent.options, timeout: 1_000 }), /\(no answer: connect ECONNREFUSED\)$/);
});

test('SH-229: the wait lasts while the gateway’s block moves and ends a minute after it stopped', async () => {
  // A backlog worked off slowly: a new block every 40 s for six minutes, then the head. No stretch reaches a minute.
  const steps = [];
  for (let block = 100; block < 109; block += 1) for (let i = 0; i < 40; i += 1) steps.push(behind(block));
  const slow = indexerFakes([...steps, follows(500)]);
  assert.equal(await waitIndexerFollows(slow.chain, { ...slow.options, interval: 1_000 }), 360_000);
  // The same block for a minute: it stopped. The limit of the whole wait (15 minutes) is far away.
  const stopped = indexerFakes([behind(120)]);
  await assert.rejects(waitIndexerFollows(stopped.chain, { ...stopped.options, interval: 1_000 }),
    /^Error: the local indexer made no progress for 60000 ms before block 500 \(status 503, following false, block 120, the index is at block 120, the chain at 500\)$/);
  assert.equal(stopped.state.ms, 60_000);
  // A block that moved once and then stopped: the minute counts from its last move.
  const late = indexerFakes([behind(100), behind(100), behind(101)]);
  await assert.rejects(waitIndexerFollows(late.chain, { ...late.options, interval: 1_000 }), /made no progress for 60000 ms before block 500/);
  assert.equal(late.state.ms, 62_000);
  // No answer at all is no progress either, and so is a gateway that says it follows but stays short of the head.
  const silent = indexerFakes([new Error('connect ECONNREFUSED')]);
  await assert.rejects(waitIndexerFollows(silent.chain, { ...silent.options, interval: 1_000 }), /made no progress for 60000 ms before block 500 \(no answer: connect ECONNREFUSED\)$/);
  const short = indexerFakes([follows(499)]);
  await assert.rejects(waitIndexerFollows(short.chain, { ...short.options, interval: 1_000 }), /made no progress for 60000 ms before block 500 \(status 200, following true, block 499\)$/);
  // A shorter stall rule of the caller's own.
  const quick = indexerFakes([behind(120)]);
  await assert.rejects(waitIndexerFollows(quick.chain, { ...quick.options, interval: 1_000, stall: 5_000 }), /made no progress for 5000 ms/);
  assert.equal(quick.state.ms, 5_000);
});

test('the 365-day jump mines a block at the exact boundary, without moving the clock backwards', async () => {
  const calls = [];
  const request = async (_url, method, params) => {
    calls.push([method, params]);
    return method === 'eth_getBlockByNumber' ? { timestamp: '0x64' } : null;
  };
  await mineTo('local', 100n + 365n * 86400n, request);
  assert.equal(BigInt(calls[1][1][0]), 31536100n);
  assert.equal(calls[2][0], 'evm_mine');
  calls.length = 0;
  await mineTo('local', 99n, request);
  assert.equal(calls.length, 1);
});

function observeRun(t, { stalled = false, output = '', exitCode = 0 } = {}) {
  const calls = []; const deadlines = [];
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    calls.push({ command, args, options });
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    queueMicrotask(() => {
      proc.stdout.write(output);
      if (!stalled) proc.emit('close', exitCode);
    });
    return proc;
  });
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    deadlines.push(ms);
    return originalTimeout(callback, stalled ? Math.min(ms, 20) : ms);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { calls, deadlines };
}

// Execute the stack's actual build invocation with the real runner and a stubbed spawn. Do not start its anvil,
// probe a port, write manifests or broadcast; the surrounding startup lifecycle is outside this regression.
function runStackBuild() {
  const source = readFileSync(new URL('../local-core-v2-chain.mjs', import.meta.url), 'utf8');
  const build = source.match(/await run\('forge', \['build'\], [\s\S]*?\);/);
  assert.ok(build, 'the stack must invoke its contract build');
  return runInNewContext(`(async () => { ${build[0]} })()`, { run, CONTRACTS, process }, { timeout: 1000 });
}

test('SH-EX-STACKLINT: only the stack build child disables lint, including an inherited true setting', async t => {
  const original = process.env.FOUNDRY_LINT_LINT_ON_BUILD;
  t.after(() => {
    if (original === undefined) delete process.env.FOUNDRY_LINT_LINT_ON_BUILD;
    else process.env.FOUNDRY_LINT_LINT_ON_BUILD = original;
  });
  const { calls } = observeRun(t);
  for (const inherited of [undefined, 'true', 'false']) {
    if (inherited === undefined) delete process.env.FOUNDRY_LINT_LINT_ON_BUILD;
    else process.env.FOUNDRY_LINT_LINT_ON_BUILD = inherited;
    const before = { ...process.env };
    await runStackBuild();
    const { command, args, options } = calls.at(-1);
    assert.equal(command, 'forge');
    assert.deepEqual(Array.from(args), ['build']);
    assert.equal(options.cwd, CONTRACTS);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.env.FOUNDRY_LINT_LINT_ON_BUILD, 'false');
    assert.deepEqual({ ...process.env }, before, 'the caller environment is unchanged');
    await run('forge', ['script', 'fixture']);
    assert.equal(calls.at(-1).options.env.FOUNDRY_LINT_LINT_ON_BUILD, inherited, 'other commands keep their own env');
  }
  assert.equal(calls.length, 6);
});

for (const configured of [undefined, '900000']) {
  test(`SH-EX-STACKLINT: build timeout gives recovery steps with the ${configured ?? 'default'} limit`, async t => {
    const original = process.env.SH_FORGE_TIMEOUT_MS;
    t.after(() => {
      if (original === undefined) delete process.env.SH_FORGE_TIMEOUT_MS;
      else process.env.SH_FORGE_TIMEOUT_MS = original;
    });
    if (configured === undefined) delete process.env.SH_FORGE_TIMEOUT_MS;
    else process.env.SH_FORGE_TIMEOUT_MS = configured;
    const { deadlines } = observeRun(t, { stalled: true, output: 'No files changed, compilation skipped\n' });
    const limit = configured === undefined ? 300000 : 900000;
    await assert.rejects(runStackBuild(), {
      message: `forge timed out after ${limit} ms:\nNo files changed, compilation skipped\n\n`
        + 'A cold compile can exceed this limit. In packages/contracts, run forge clean then '
        + 'FOUNDRY_LINT_LINT_ON_BUILD=false forge build before starting the stack.',
    });
    assert.deepEqual(deadlines, [limit]);
  });
}

test('SH-EX-STACKLINT: ordinary build failures keep their existing diagnostic', async t => {
  observeRun(t, { exitCode: 1, output: 'compiler error\n' });
  await assert.rejects(runStackBuild(), { message: 'forge failed (1):\ncompiler error\n' });
});

test('Forge build and script inherit SH_FORGE_TIMEOUT_MS; default remains five minutes', async t => {
  const original = process.env.SH_FORGE_TIMEOUT_MS;
  t.after(() => {
    if (original === undefined) delete process.env.SH_FORGE_TIMEOUT_MS;
    else process.env.SH_FORGE_TIMEOUT_MS = original;
  });
  delete process.env.SH_FORGE_TIMEOUT_MS;
  const { deadlines } = observeRun(t);
  await run('forge', ['build']);
  await run('forge', ['script', 'fixture']);
  process.env.SH_FORGE_TIMEOUT_MS = '1800000';
  await run('forge', ['build']);
  await run('forge', ['script', 'fixture'], { env: { SH_CORE_V2_LOCAL_ACTOR: 'actor' } });
  await run('forge', ['build'], { env: { SH_FORGE_TIMEOUT_MS: '900000' } });
  await run('forge', ['build'], { timeoutMs: 456 });
  await run(process.execPath, ['--version']);
  assert.deepEqual(deadlines, [300000, 300000, 1800000, 1800000, 900000, 456, 300000]);
});

test('invalid Forge deadlines fail before spawning a process', async t => {
  const { calls } = observeRun(t);
  for (const value of ['', '0', '-1', '1.5', '1e6', ' 1000 ', 'Infinity', 'NaN', '2147483648', '9007199254740993']) {
    await assert.rejects(run('forge', ['build'], { env: { SH_FORGE_TIMEOUT_MS: value } }), /SH_FORGE_TIMEOUT_MS.*positive integer/);
  }
  assert.equal(calls.length, 0);
});

test('a configured Forge deadline actually interrupts a stalled call', async t => {
  const { deadlines } = observeRun(t, { stalled: true });
  // Bound even the old implementation so the red regression never waits five minutes.
  await assert.rejects(run('forge', ['script', 'fixture'], { env: { SH_FORGE_TIMEOUT_MS: '20' } }), { message: 'forge timed out after 20 ms:\n' });
  assert.deepEqual(deadlines, [20]);
});
