// SH-249 at the server's real keeper entry: createDriver (infra/server/services/keeper.mjs) in live mode, with the
// package's real scheduler, chain adapter and StateStore. Only the mounted key file, the /state directory and the RPC
// (a scripted node behind fetch) are doubles. The node takes a transaction and loses the reply, holds it pending, and
// the service restarts: the saved bytes go out again and no nonce is signed for a second call.
// (The new release's replay harness, infra/server/test/support/keeper-entry.mjs, is not on this line.)
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fakeClient, fakeNode, keccak256, parseTransaction } from '../../../packages/keeper/test/support/fake-rpc.ts';
import { privateKeyToAccount } from '../../../packages/keeper/src/viem.ts';
import { runLoop, settings } from '../services/runtime.mjs';

// An obvious dummy key: never a real account.
const KEY = `0x${'01'.repeat(32)}`;
const dirs = vi.hoisted(() => ({ state: '' }));
vi.mock('node:fs', async original => {
  const fs = await original();
  const mounted = p => typeof p === 'string' && p.startsWith('/run/service-config/');
  // run.mjs's health file lives beside the books in this test (it is /tmp/service-health.json on the server).
  const health = p => typeof p === 'string' && p.startsWith('/tmp/service-health.json') ? `${dirs.state}/${p.slice(5)}` : p;
  return { ...fs, writeFileSync: (p, ...a) => fs.writeFileSync(health(p), ...a), renameSync: (a, b) => fs.renameSync(health(a), health(b)),
    readFileSync: (fd, ...a) => mounted(fd) ? `0x${'01'.repeat(32)}\n` : fs.readFileSync(health(fd), ...a), realpathSync: p => mounted(p) ? p : fs.realpathSync(p),
    openSync: (p, ...a) => mounted(p) ? p : fs.openSync(p, ...a),
    fstatSync: fd => mounted(fd) ? { isFile: () => true, size: 66, mode: 0o100600, uid: process.getuid() } : fs.fstatSync(fd),
    closeSync: fd => { if (!mounted(fd)) fs.closeSync(fd); } };
});
vi.mock('../../../packages/keeper/src/state.ts', async original => {
  const m = await original();
  return { ...m, StateStore: class extends m.StateStore {
    constructor(file, identity) { super(file.replace(/^\/state\//, `${dirs.state}/`), identity); }
  } };
});
const { createDriver } = await import('../services/keeper.mjs');

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const time = 1_791_302_400n;

function scriptedNode(me) {
  const node = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n }, chainId: 31337 });
  const registry = addr(10), co = addr(1), hk = addr(2), rc = addr(3), router = addr(6);
  node.versions = { [hk]: 2, [rc]: 2 };
  const owed = { fit: 5n, platform: 6n };
  node.calls = {
    [`${registry}:boxCount`]: () => 1n,
    [`${registry}:roleOf`]: ([, role]) => ({ 0: co, 2: hk, 5: rc, 6: router })[String(role)] ?? addr(0),
    [`${hk}:q`]: () => addr(0), [`${hk}:poolId`]: () => `0x${'11'.repeat(32)}`, [`${hk}:poolManager`]: () => addr(7),
    [`${hk}:closed`]: () => true, [`${hk}:closedAt`]: () => time - 100n, [`${hk}:lastProtocolBlock`]: () => 0n,
    [`${hk}:depthBudget`]: () => 0n, [`${co}:graduated`]: () => true, [`${co}:failed`]: () => false,
    [`${co}:gateOpen`]: () => true, [`${co}:openAt`]: () => time - 100n, [`${co}:deadline`]: () => time + 100n,
    [`${co}:rewardOf`]: () => 0n, [`${rc}:graduationSettled`]: () => true,
    [`${rc}:fitOwed`]: () => owed.fit, [`${rc}:platformOwed`]: () => owed.platform,
    [`${rc}:buyBackP`]: () => 0n, [`${rc}:tBurnPending`]: () => 0n,
    [`${rc}:payFit`]: () => owed.fit, [`${rc}:payPlatform`]: () => owed.platform, [`${router}:sweep`]: () => 0n,
  };
  const pool = new Map(), attempts = [];
  let latest = 7, lose = 0;
  const pending = () => { let n = latest; while (pool.has(n)) n++; return n; };
  node.countOf = (who, tag) => who !== me ? 0 : tag === 'latest' ? latest : pending();
  node.receipt = () => null;
  node.onSend = raw => {
    attempts.push(raw);
    const n = parseTransaction(raw).nonce;
    if (n < latest) throw new Error('nonce too low');
    // A replacement is taken only with both fee fields a tenth higher (geth's rule).
    if (pool.has(n) && pool.get(n) !== raw) {
      const a = parseTransaction(pool.get(n)), b = parseTransaction(raw);
      if (b.maxFeePerGas * 10n < a.maxFeePerGas * 11n || b.maxPriorityFeePerGas * 10n < a.maxPriorityFeePerGas * 11n) throw new Error('replacement transaction underpriced');
    }
    pool.set(n, raw);
    if (lose > 0) { lose--; throw new Error('timeout'); }
  };
  const client = fakeClient(node);
  vi.stubGlobal('fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    const answer = async c => {
      try { return { jsonrpc: '2.0', id: c.id, result: await client.request({ method: c.method, params: c.params }) }; }
      catch (error) { return { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: String(error?.message ?? error) } }; }
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  });
  return { node, pool, attempts, owed, registry, loseNext: n => { lose = n; } };
}

it('a lost reply, a transaction held pending and a restart: saved bytes go out again, no nonce serves two calls', async () => {
  dirs.state = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'keeper-sent-entry-'));
  const me = privateKeyToAccount(KEY).address;
  const n = scriptedNode(me.toLowerCase());
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const env = { SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live', SH_KEEPER_RPC_URL: 'https://offline.invalid/fake-test-only',
    SH_KEEPER_CHAIN_ID: '31337', SH_KEEPER_ADDRESS: me, SH_KEEPER_BOX_REGISTRY: n.registry,
    SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_KEY_FILE: '/run/service-config/keeper.key',
    SH_KEEPER_COIN_MINIMUMS: JSON.stringify({ [addr(0)]: { collectRaw: '1' } }) };
  let driver = await createDriver(env, settings('keeper', env));
  n.loseNext(1);
  expect(await driver.cycle()).toBe(true);
  // Both payouts reached the node; the first reply was lost. Both are saved, the journal names both hashes.
  expect([...n.pool.keys()]).toEqual([7, 8]);
  const journal = readFileSync(join(dirs.state, 'keeper.json'), 'utf8');
  for (const raw of n.pool.values()) expect(journal).toContain(keccak256(raw).toLowerCase());
  expect(existsSync(join(dirs.state, 'keeper.json.sent'))).toBe(true);
  driver.close();
  // The node drops its pool (both stay unmined) and the service restarts.
  const held = [...n.pool.values()];
  n.pool.clear();
  n.owed.fit = 0n; n.owed.platform = 0n;
  n.node.block.number = 103n; n.node.block.timestamp = time + 36n;
  driver = await createDriver(env, settings('keeper', env));
  expect(await driver.cycle()).toBe(true);
  expect([...n.pool.values()].sort()).toEqual([...held].sort());
  // Each broadcast of saved bytes reaches the service log with its nonce and hash (review note 5).
  const lines = stderr.mock.calls.map(c => String(c[0]));
  for (const [i, raw] of held.entries()) {
    expect(lines).toContain(`keeper: saved transaction broadcast again nonce=${7 + i} hash=${keccak256(raw).toLowerCase()}\n`);
  }
  // New work after the retry wait (SH_KEEPER_RETRY_BLOCKS, 25) takes the next nonce, never 7 or 8.
  n.owed.fit = 9n;
  n.node.block.number = 130n; n.node.block.timestamp = time + 360n;
  expect(await driver.cycle()).toBe(true);
  expect([...n.pool.keys()].sort()).toEqual([7, 8, 9]);
  const calls = new Map();
  for (const raw of n.attempts) {
    const tx = parseTransaction(raw);
    calls.set(tx.nonce, (calls.get(tx.nonce) ?? new Set()).add(tx.data));
  }
  for (const set of calls.values()) expect(set.size).toBe(1);
  driver.close();
});

// Re-check: the entry's own loop with the real driver, in this worker (the mocks above reach a dynamic import here, not a
// child process): run.mjs starts the driver, cycles, publishes health, and a SIGTERM stops it and releases the lock.
it('run.mjs with the real driver: cycles, sends from the record, and stops on SIGTERM without an exit', async () => {
  dirs.state = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'keeper-sent-run-'));
  const me = privateKeyToAccount(KEY).address;
  const n = scriptedNode(me.toLowerCase());
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  const env = { SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live', SH_KEEPER_RPC_URL: 'https://offline.invalid/fake-test-only',
    SH_KEEPER_CHAIN_ID: '31337', SH_KEEPER_ADDRESS: me, SH_KEEPER_BOX_REGISTRY: n.registry, SH_KEEPER_POLL_MS: '20',
    SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_KEY_FILE: '/run/service-config/keeper.key',
    SH_KEEPER_COIN_MINIMUMS: JSON.stringify({ [addr(0)]: { collectRaw: '1' } }) };
  const argv = process.argv;
  const before = new Set(process.listeners('SIGTERM'));
  Object.assign(process.env, env);
  process.argv = [argv[0], 'run.mjs', 'keeper'];
  try {
    const done = import('../services/run.mjs');
    await vi.waitFor(() => expect(n.pool.size).toBe(2), { timeout: 20_000, interval: 20 });
    // Health turns ok once the cycle (and its checkpoints) completed.
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dirs.state, 'service-health.json'), 'utf8')))
      .toMatchObject({ service: 'keeper', mode: 'live', status: 'ok' }), { timeout: 20_000, interval: 20 });
    expect(stdout.mock.calls.map(c => String(c[0]))).toContain('keeper: live\n');
    const stop = process.listeners('SIGTERM').filter(l => !before.has(l));
    expect(stop).toHaveLength(1);
    stop[0]('SIGTERM');
    await done;
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    expect(readdirSync(dirs.state).some(f => /^keeper\.json\.lock\..+\.released$/.test(f))).toBe(true);
    const record = JSON.parse(readFileSync(join(dirs.state, 'keeper.json.sent'), 'utf8'));
    expect(record.entries.map(e => [e.nonce, e.state])).toEqual([['7', 'sent'], ['8', 'sent']]);
  } finally {
    process.argv = argv;
    for (const key of Object.keys(env)) Reflect.deleteProperty(process.env, key);
    process.exitCode = undefined;
  }
});

// SH-250 at the server's driver: a send that hangs below a risen base fee is replaced at the same nonce, saved before it
// goes out, and the service log names it.
it('a hanging send is replaced through the live driver: saved first, broadcast, logged', async () => {
  dirs.state = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'keeper-sent-replace-'));
  const me = privateKeyToAccount(KEY).address;
  const n = scriptedNode(me.toLowerCase());
  n.node.block.baseFeePerGas = 1_000_000_000n;
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const env = { SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live', SH_KEEPER_RPC_URL: 'https://offline.invalid/fake-test-only',
    SH_KEEPER_CHAIN_ID: '31337', SH_KEEPER_ADDRESS: me, SH_KEEPER_BOX_REGISTRY: n.registry,
    SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_KEY_FILE: '/run/service-config/keeper.key',
    SH_KEEPER_COIN_MINIMUMS: JSON.stringify({ [addr(0)]: { collectRaw: '1' } }) };
  const driver = await createDriver(env, settings('keeper', env));
  expect(await driver.cycle()).toBe(true);
  const first = [...n.pool.values()];
  expect(first).toHaveLength(2);
  n.owed.fit = 0n; n.owed.platform = 0n;
  n.node.block.baseFeePerGas = 2_500_000_000n;
  for (const block of [103n, 106n, 109n]) {
    n.node.block.number = block; n.node.block.timestamp = time + (block - 100n) * 12n;
    expect(await driver.cycle()).toBe(true);
  }
  // Both nonces now hold their replacement at the 3 gwei ceiling; the record held each before the node saw it.
  const now = [...n.pool.values()];
  expect(now.map(r => parseTransaction(r).maxFeePerGas)).toEqual([3_000_000_000n, 3_000_000_000n]);
  const record = JSON.parse(readFileSync(join(dirs.state, 'keeper.json.sent'), 'utf8'));
  expect(record.entries.map(e => e.txs.length)).toEqual([2, 2]);
  for (const raw of now) expect(record.entries.flatMap(e => e.txs.map(t => t.hash))).toContain(keccak256(raw).toLowerCase());
  const lines = stderr.mock.calls.map(c => String(c[0]));
  for (const [i, raw] of now.entries()) expect(lines).toContain(`keeper: saved transaction replaced nonce=${7 + i} hash=${keccak256(raw).toLowerCase()}\n`);
  driver.close();
});

// SH-250 rule A at the server's driver: a nonce unmined for 25 blocks is taken by the next admitted job; the service log
// names the nonce, the taker's hash and the hash it took the nonce over.
it('a takeover through the live driver is logged with the nonce and both hashes', async () => {
  dirs.state = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'keeper-sent-takeover-'));
  const me = privateKeyToAccount(KEY).address;
  const n = scriptedNode(me.toLowerCase());
  n.node.block.baseFeePerGas = 1_000_000_000n;
  n.owed.platform = 0n;
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const env = { SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live', SH_KEEPER_RPC_URL: 'https://offline.invalid/fake-test-only',
    SH_KEEPER_CHAIN_ID: '31337', SH_KEEPER_ADDRESS: me, SH_KEEPER_BOX_REGISTRY: n.registry,
    SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_KEY_FILE: '/run/service-config/keeper.key',
    SH_KEEPER_COIN_MINIMUMS: JSON.stringify({ [addr(0)]: { collectRaw: '1' } }) };
  const driver = await createDriver(env, settings('keeper', env));
  expect(await driver.cycle()).toBe(true);
  const loser = n.pool.get(7);
  n.owed.fit = 0n; n.owed.platform = 6n;
  n.node.block.number = 127n; n.node.block.timestamp = time + 27n * 12n;
  expect(await driver.cycle()).toBe(true);
  const taker = n.pool.get(7);
  expect(taker).not.toBe(loser);
  expect(stderr.mock.calls.map(c => String(c[0]))).toContain(
    `keeper: saved transaction taken over nonce=7 hash=${keccak256(taker).toLowerCase()} over=${keccak256(loser).toLowerCase()}\n`);
  driver.close();
});

// SH-259 rule A at the server's driver, on a chain whose base fee is 0 (BNB Chain testnet): the signed transactions
// decoded. A failed or malformed eth_gasPrice signs and broadcasts nothing; a quote signs both fee fields at the quote plus
// a quarter; a send that then hangs is never signed again, whatever the chain asks over many ticks: its same bytes go
// out again only with a usable quote, and the log and the health notes say that it waits.
it('a chain whose base fee is 0: fees from the tick\'s quote, nothing without one, no second signature for a hanging send', async () => {
  dirs.state = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'keeper-sent-zero-base-'));
  const me = privateKeyToAccount(KEY).address;
  const n = scriptedNode(me.toLowerCase());
  n.node.block.baseFeePerGas = 0n;
  let quote = null;
  n.node.gasPrice = () => { if (quote === null) throw new Error('gas price unavailable'); return quote; };
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const env = { SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live', SH_KEEPER_RPC_URL: 'https://offline.invalid/fake-test-only',
    SH_KEEPER_CHAIN_ID: '31337', SH_KEEPER_ADDRESS: me, SH_KEEPER_BOX_REGISTRY: n.registry,
    SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_KEY_FILE: '/run/service-config/keeper.key',
    SH_KEEPER_PRIORITY_FEE_WEI: '100000000', SH_KEEPER_MAX_FEE_WEI: '200000000',
    SH_KEEPER_COIN_MINIMUMS: JSON.stringify({ [addr(0)]: { collectRaw: '1' } }) };
  const driver = await createDriver(env, settings('keeper', env));
  const at = block => { n.node.block.number = block; n.node.block.timestamp = time + (block - 100n); };
  const fields = raw => { const t = parseTransaction(raw); return [t.nonce, t.maxPriorityFeePerGas, t.maxFeePerGas]; };
  const sentRecord = () => existsSync(join(dirs.state, 'keeper.json.sent'))
    ? JSON.parse(readFileSync(join(dirs.state, 'keeper.json.sent'), 'utf8')).entries : [];

  // A failed quote, then malformed ones (a boolean, an empty string, zero, a number, a padded quantity): nothing signed,
  // nothing broadcast, nothing saved.
  let block = 100n;
  for (const bad of [null, true, '', '0x0', 100000000, '0x05f5e100 ', '0x005f5e100']) {
    quote = bad; at(block++);
    expect(await driver.cycle()).toBe(true);
    expect(n.attempts).toEqual([]);
    expect(sentRecord()).toEqual([]);
  }

  // 100,000,000 wei: both payouts at 125,000,000 in both fields, once.
  n.owed.fit = 5n; n.owed.platform = 6n; quote = 100_000_000n; const signedAt = block; at(block++);
  expect(await driver.cycle()).toBe(true);
  const first = new Map(n.pool);
  expect([...first.values()].map(fields)).toEqual([[7, 125_000_000n, 125_000_000n], [8, 125_000_000n, 125_000_000n]]);
  n.owed.fit = 0n; n.owed.platform = 0n;

  // They hang for 200 blocks while the chain's price rises past the ceiling and the quote fails now and then: never a
  // second signature (the record keeps one transaction per nonce; every bytes the node sees are the first ones).
  // Every tick: with a usable quote and the rebroadcast due, exactly the two saved bytes go out again; without one
  // (unread, above the ceiling) nothing goes out.
  const asked = [120_000_000n, 150_000_000n, 160_000_000n, 199_000_000n, null, 250_000_000n, 180_000_000n, 160_000_000n];
  let resent = 0;
  for (let i = 0; i < 40; i++) {
    quote = asked[i % asked.length]; block += 5n; at(block);
    const before = n.attempts.length;
    expect(await driver.cycle()).toBe(true);
    const delta = n.attempts.length - before;
    if (quote === null || quote > 200_000_000n) expect(delta).toBe(0);
    else expect([0, 2]).toContain(delta);
    if (delta === 2) resent++;
  }
  expect(resent).toBeGreaterThan(0);
  expect(sentRecord().map(e => e.txs.length)).toEqual([1, 1]);
  expect(new Set(n.attempts)).toEqual(new Set(first.values()));
  expect(n.pool).toEqual(first);

  // Another job eligible while both hang (the platform payout, a different job from nonce 7's, which the old takeover
  // would have put at nonce 7): it takes a NEW nonce at this tick's price plus a quarter; 7 and 8 keep their one
  // transaction each.
  n.owed.platform = 6n;
  quote = 120_000_000n; block += 1n; at(block);
  expect(await driver.cycle()).toBe(true);
  n.owed.platform = 0n;
  const fresh = [...n.pool.entries()].filter(([nonce]) => nonce > 8);
  expect(fresh.length).toBeGreaterThan(0);
  for (const [, raw] of fresh) expect(fields(raw).slice(1)).toEqual([150_000_000n, 150_000_000n]);
  expect(sentRecord().filter(e => ['7', '8'].includes(e.nonce)).map(e => e.txs.length)).toEqual([1, 1]);
  expect(n.pool.get(7)).toBe(first.get(7));
  expect(n.pool.get(8)).toBe(first.get(8));
  quote = 160_000_000n; block += 1n; at(block);
  expect(await driver.cycle()).toBe(true);
  // The log and the health notes say that it waits, with what the chain asks now (the last tick's quote).
  expect(driver.notes()).toEqual({ hanging: `nonce 7 hanging since block ${signedAt} at price 125000000; the chain asks 160000000` });
  const lines = stderr.mock.calls.map(c => String(c[0]));
  expect(lines.some(l => l.startsWith(`keeper: saved transaction hangs; the keeper waits nonce=7 hash=${keccak256(first.get(7)).toLowerCase()} since=${signedAt} price=125000000 asks=`))).toBe(true);

  // Over the ceiling, or unread, its bytes do not even go out again.
  for (const q of [250_000_000n, null]) {
    const tried = n.attempts.length;
    quote = q; block += 30n; at(block);
    expect(await driver.cycle()).toBe(true);
    expect(n.attempts.length).toBe(tried);
  }

  // The service's own loop publishes the hang in its health record (the file the ship and the operator read).
  quote = 160_000_000n; block += 1n; at(block);
  let loops = 0;
  await runLoop(settings('keeper', env), { cycle: () => driver.cycle(), close: () => driver.close(), notes: () => driver.notes() },
    { stopped: () => loops++ > 0, sleep: async () => {} });
  const health = JSON.parse(readFileSync(join(dirs.state, 'service-health.json'), 'utf8'));
  expect(health).toMatchObject({ service: 'keeper', mode: 'live', status: 'ok' });
  expect(health.hanging).toBe(`nonce 7 hanging since block ${signedAt} at price 125000000; the chain asks 160000000`);
});
