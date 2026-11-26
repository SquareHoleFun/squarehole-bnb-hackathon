import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
// The infrastructure manifest also discovers this file under Vitest; both runners exercise the same cases.
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const { runOnce, probeGateway, probeRpc, readInspection, recordRestartFailure } = await import('../heal/main.mjs');

const START = 1800000000;
const container = { identity: 'a'.repeat(64) + ':started', startedAt: START - 3600, chainId: '11155111', urls: ['https://rpc.invalid/private-token'] };
const unavailable = async () => { throw new Error('https://secret.invalid/key DO_NOT_LOG'); };
async function fixture() {
  await mkdir('.cache/tmp', { recursive: true });
  const dir = await mkdtemp('.cache/tmp/heal-');
  const stateFile = join(dir, 'state.json');
  const restarts = [], lines = [];
  let tick = 0;
  return {
    stateFile, restarts, lines,
    async run(overrides = {}) {
      const now = overrides.now ?? START + tick * 60;
      tick++;
      const { restart = async () => { restarts.push(now); }, ...ports } = overrides;
      const output = [];
      let result = await runOnce({ now, stateFile, inspect: async () => container,
        gateway: async () => ({ head: '100' }),
        rpc: async () => ({ head: String(100 + tick), timestamp: String(now), chainId: '11155111' }),
        write: line => output.push(line), ...ports });
      if (['restart-gateway', 'restart-stalled'].includes(result.decision)) {
        try { await restart(); }
        catch {
          output.length = 0;
          result = await recordRestartFailure({ stateFile, now, write: line => output.push(line) });
        }
      }
      lines.push(...output);
      return result;
    },
    async state() { return JSON.parse(await readFile(stateFile, 'utf8')); },
  };
}

test('gateway silence restarts on exactly the third consecutive run; one redacted decision per run', async () => {
  const f = await fixture();
  for (let n = 1; n <= 3; n++) {
    await f.run({ gateway: unavailable });
    assert.equal(f.restarts.length, n === 3 ? 1 : 0);
  }
  assert.equal(f.lines.length, 3);
  assert.ok(f.lines.every(line => line.endsWith('\n') && line.split('\n').length === 2));
  assert.doesNotMatch(f.lines.join(''), /https:|private-token|DO_NOT_LOG/);
  assert.equal(JSON.parse(f.lines[2]).decision, 'restart-gateway');
});

test('stuck indexer restarts after exactly three comparisons with an advancing chain', async () => {
  const f = await fixture();
  await f.run(); // Establish both heads, then observe three unchanged indexer heads.
  for (let n = 1; n <= 3; n++) {
    await f.run();
    assert.equal(f.restarts.length, n === 3 ? 1 : 0);
  }
  assert.equal(JSON.parse(f.lines[3]).decision, 'restart-stalled');
});

test('a responding gateway or advancing indexer resets the respective streak', async () => {
  const f = await fixture();
  await f.run({ gateway: unavailable }); await f.run({ gateway: unavailable });
  await f.run(); await f.run({ gateway: unavailable });
  assert.equal(f.restarts.length, 0);
  const g = await fixture();
  await g.run(); await g.run(); await g.run();
  await g.run({ gateway: async () => ({ head: '101' }) });
  await g.run({ gateway: async () => ({ head: '101' }) });
  assert.equal(g.restarts.length, 0);
});

for (const condition of ['down', 'behind-indexer', 'regressed', 'stale', 'future', 'wrong-chain']) {
  test(`RPC ${condition} prevents both restart conditions and breaks streaks`, async () => {
    for (const silent of [false, true]) {
      const f = await fixture();
      await f.run();
      const rpc = condition === 'down' ? unavailable : async () => ({
        head: condition === 'behind-indexer' ? '99' : condition === 'regressed' ? '100' : '200',
        timestamp: String(condition === 'stale' ? START - 301 : condition === 'future' ? START + 10000 : START),
        chainId: condition === 'wrong-chain' ? '1' : '11155111',
      });
      for (let i = 0; i < 4; i++) await f.run({ rpc, ...(silent ? { gateway: unavailable } : {}) });
      assert.equal(f.restarts.length, 0);
      assert.equal((await f.state()).gatewayFailures, 0);
      assert.equal((await f.state()).stuckRuns, 0);
    }
  });
}

test('stuck chain and indexer do not restart; a stationary chain breaks a stuck-head streak', async () => {
  const f = await fixture();
  await f.run(); await f.run();
  for (let i = 0; i < 5; i++) await f.run({ rpc: async () => ({ head: '102', timestamp: String(START + i * 60), chainId: '11155111' }) });
  assert.equal(f.restarts.length, 0);
  assert.equal((await f.state()).stuckRuns, 0);
});

test('RPC failure on the third observation requires a new three-run streak after recovery', async () => {
  const f = await fixture();
  await f.run({ gateway: unavailable }); await f.run({ gateway: unavailable });
  await f.run({ gateway: unavailable, rpc: unavailable });
  for (let n = 1; n <= 3; n++) {
    await f.run({ gateway: unavailable });
    assert.equal(f.restarts.length, n === 3 ? 1 : 0);
  }
});

test('a responsive idle gateway or replay with advancing heads never restarts', async () => {
  for (const idle of [true, false]) {
    const f = await fixture();
    for (let n = 0; n < 5; n++) await f.run({ gateway: async () => ({ head: idle ? null : String(100 + n) }) });
    assert.equal(f.restarts.length, 0);
  }
});

test('15-minute cooldown includes failed restart attempts and expires at the boundary', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.run({ gateway: unavailable, restart: async () => { f.restarts.push(START + 120); throw new Error('secret'); } });
  const first = START + 120;
  for (const offset of [60, 120, 899]) await f.run({ now: first + offset, gateway: unavailable });
  assert.equal(f.restarts.length, 1);
  assert.equal(JSON.parse(f.lines.at(-1)).decision, 'cooldown');
  await f.run({ now: first + 900, gateway: unavailable });
  assert.equal(f.restarts.length, 2);
});

test('four attempts per rolling 24 hours, not per UTC day', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.run({ gateway: unavailable });
  const first = START + 120;
  for (let n = 1; n <= 3; n++) {
    for (const offset of [-120, -60, 0]) await f.run({ now: first + n * 900 + offset, gateway: unavailable });
  }
  assert.equal(f.restarts.length, 4);
  for (const offset of [3600, 3660, 86400 - 1]) await f.run({ now: first + offset, gateway: unavailable });
  assert.equal(f.restarts.length, 4);
  assert.equal(JSON.parse(f.lines.at(-1)).decision, 'daily-cap');
  await f.run({ now: first + 86400, gateway: unavailable });
  assert.equal(f.restarts.length, 5);
});

test('missing state starts safely; corrupt state fails closed for a day because restart history is unknown', async () => {
  for (const data of [undefined, '{bad', '{}', JSON.stringify({ version: 1, gatewayFailures: 999 })]) {
    const f = await fixture();
    if (data !== undefined) await writeFile(f.stateFile, data);
    await f.run({ gateway: unavailable });
    assert.equal(f.restarts.length, 0);
    assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600);
    if (data !== undefined) {
      await f.run({ gateway: unavailable }); await f.run({ gateway: unavailable });
      assert.equal(f.restarts.length, 0);
      assert.equal((await f.state()).holdUntil, START + 86400);
    }
  }
});

test('startup grace, container replacement and clock rollback cannot trigger a restart', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.run({ gateway: unavailable, inspect: async () => ({ ...container, startedAt: START }) });
  assert.equal(f.restarts.length, 0);
  await f.run({ now: START + 1800, gateway: unavailable });
  await f.run({ now: START + 1860, gateway: unavailable });
  await f.run({ now: START + 1920, gateway: unavailable, inspect: async () => ({ ...container, identity: 'new-container' }) });
  assert.equal(f.restarts.length, 0);
  await f.run({ now: START + 100, gateway: unavailable });
  assert.equal(JSON.parse(f.lines.at(-1)).decision, 'clock-rollback');
});

test('unreadable Docker metadata or unwritable state never restarts, and errors cannot leak credentials', async () => {
  const f = await fixture();
  await f.run({ inspect: unavailable });
  await f.run({ gateway: unavailable }); await f.run({ gateway: unavailable });
  await f.run({ gateway: unavailable, save: unavailable });
  assert.equal(f.restarts.length, 0);
  assert.doesNotMatch(f.lines.join(''), /https:|DO_NOT_LOG/);
});

test('a restart attempt is durably recorded before invoking Docker', async () => {
  const f = await fixture();
  await f.run({ gateway: unavailable }); await f.run({ gateway: unavailable });
  const result = await f.run({ gateway: unavailable, restart: async () => {
    assert.deepEqual((await f.state()).restartTimes, [START + 120]);
  } });
  assert.equal(result.decision, 'restart-gateway');
});

test('restart budgets survive container recreation and a new invocation reading the same state', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.run({ gateway: unavailable });
  const g = await fixture();
  for (let i = 0; i < 3; i++) await g.run({ now: START + 180 + i * 60, stateFile: f.stateFile,
    gateway: unavailable, inspect: async () => ({ ...container, identity: 'recreated' }) });
  assert.equal(g.restarts.length, 0);
  assert.equal(JSON.parse(g.lines.at(-1)).decision, 'cooldown');
});

test('gateway probe uses local healthz, accepts responsive 503 during replay, and retains bigint heads', async () => {
  const head = '9007199254740993000';
  for (const status of [200, 503]) {
    const result = await probeGateway(async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:5394/healthz');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ ok: status === 200, following: true, asOf: { block: head }, history: { ok: status === 200 } }), { status });
    });
    assert.equal(result.head, head);
  }
  assert.deepEqual(await probeGateway(async () => new Response(JSON.stringify({ ok: true, following: false, asOf: null }))), { head: null });
  await assert.rejects(probeGateway(async () => new Response('x'.repeat(65537))));
});

test('RPC probe uses effective URLs in order, checks chain identity and latest height/timestamp', async () => {
  const methods = [];
  const result = await probeRpc({ ...container, urls: ['https://down.invalid', ...container.urls] }, async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    if (url === 'https://down.invalid') throw new Error('offline');
    assert.equal(url, container.urls[0]);
    const call = JSON.parse(init.body); methods.push(call.method);
    const result = call.method === 'eth_chainId' ? '0xaa36a7' : { number: '0x20000000000001', timestamp: '0x6b49d200' };
    if (call.method === 'eth_getBlockByNumber') assert.deepEqual(call.params, ['latest', false]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  });
  assert.deepEqual(methods, ['eth_chainId', 'eth_getBlockByNumber']);
  assert.equal(result.head, '9007199254740993');
  assert.equal(result.chainId, '11155111');
  await assert.rejects(probeRpc(container, async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }))));
});

const id = 'a'.repeat(64);
const startedAt = new Date((START - 3600) * 1000).toISOString();
const inspected = [id, startedAt, 'squarehole', 'indexer', 'SH_CORE_HTTP_URLS=' + container.urls.join(',')];
const inspection = JSON.stringify({ id, inspection: inspected, chainId: 11155111 });
const readInspectionText = text => readInspection(Readable.from([text]));

test('stdin inspection validates the applied RPC list, identity and manifest chain without Docker', async () => {
  const c = await readInspectionText(inspection);
  assert.deepEqual(c, { ...container, identity: `${id}:${startedAt}` });
  for (const input of ['', '{bad', JSON.stringify({ id, inspection: null, chainId: 11155111 }),
    JSON.stringify({ id: 'b'.repeat(64), inspection: inspected, chainId: 11155111 }),
    ...[
      [id, startedAt, 'wrong-project', 'indexer', inspected[4]],
      [id, startedAt, 'squarehole', 'postgres', inspected[4]],
      [id, 'bad', 'squarehole', 'indexer', inspected[4]],
      [...inspected, inspected[4]], inspected.slice(0, 4),
      [...inspected.slice(0, 4), 'SH_CORE_HTTP_URLS=file:///secret'],
      [...inspected.slice(0, 4), 'SH_CORE_HTTP_URLS=https://rpc.invalid/#secret'],
    ].map(value => JSON.stringify({ id, inspection: value, chainId: 11155111 })),
    JSON.stringify({ id, inspection: inspected, chainId: 0 }), 'x'.repeat(65537)]) {
    await assert.rejects(readInspectionText(input));
  }
  const source = await readFile('infra/server/heal/main.mjs', 'utf8');
  assert.doesNotMatch(source, /node:child_process|execFile|\/usr\/bin\/docker/);
});

test('decision reserves durably without invoking a restart; failure outcome retains that reservation', async () => {
  const f = await fixture();
  await f.run({ gateway: unavailable }); await f.run({ gateway: unavailable });
  const lines = [];
  const result = await runOnce({ now: START + 120, stateFile: f.stateFile, inspect: async () => container,
    gateway: unavailable, rpc: async () => ({ head: '200', timestamp: String(START + 120), chainId: '11155111' }),
    restart: () => assert.fail('decision container must not restart'), write: line => lines.push(line) });
  assert.equal(result.decision, 'restart-gateway');
  assert.equal(lines.length, 1);
  assert.deepEqual((await f.state()).lastRestart, { at: START + 120, outcome: 'reserved' });
  assert.deepEqual((await f.state()).restartTimes, [START + 120]);
  const failed = await recordRestartFailure({ stateFile: f.stateFile, now: START + 121, write: line => lines.push(line) });
  assert.equal(failed.decision, 'restart-failed');
  assert.equal(failed.code, 1);
  assert.deepEqual((await f.state()).lastRestart, { at: START + 120, outcome: 'restart-failed' });
  assert.deepEqual((await f.state()).restartTimes, [START + 120]);
  assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600);
});

test('recording failure requires a real reservation and cannot create or reset restart history', async () => {
  const f = await fixture();
  const lines = [];
  for (const contents of [undefined, '{bad']) {
    if (contents !== undefined) await writeFile(f.stateFile, contents);
    const result = await recordRestartFailure({ stateFile: f.stateFile, now: START, write: line => lines.push(line) });
    assert.equal(result.decision, 'internal-error');
    assert.equal(result.code, 1);
    if (contents !== undefined) assert.equal(await readFile(f.stateFile, 'utf8'), contents);
  }
});

const compose = ['compose', '--project-name', 'squarehole', '--project-directory', '/srv/squarehole/current/infra/server'];
const inspectFormat = '[{{json .Id}},{{json .State.StartedAt}},{{json (index .Config.Labels "com.docker.compose.project")}},{{json (index .Config.Labels "com.docker.compose.service")}}{{range .Config.Env}}{{if eq (index (split . "=") 0) "SH_CORE_HTTP_URLS"}},{{json .}}{{end}}{{end}}]';
const release = 'b'.repeat(40);

// Source the real Bash wrapper and replace only external ports/host paths. Fake Docker runs the real Node
// decision code with injected probes; neither a Docker daemon nor a network nor node on the host PATH is used.
async function wrapperFixture(options = {}) {
  const f = await fixture();
  const dir = resolve(f.stateFile, '..');
  const driver = join(dir, 'docker.mjs');
  const callsFile = join(dir, 'calls.jsonl');
  await writeFile(join(dir, 'release.env'), `SH_RELEASE=${release}\n`);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ chainId: 11155111 }));
  await writeFile(driver, String.raw`
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { runOnce, readInspection, recordRestartFailure } from ${JSON.stringify(pathToFileURL(resolve('infra/server/heal/main.mjs')).href)};
const args = process.argv.slice(2), options = ${JSON.stringify(options)};
const callsFile = ${JSON.stringify(callsFile)}, stateFile = ${JSON.stringify(resolve(f.stateFile))};
const stdin = args[0] === 'run' ? readFileSync(0, 'utf8') : '';
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
appendFileSync(callsFile, JSON.stringify({ args, stdin, state, timeout: process.env.HEAL_TEST_TIMEOUT }) + '\n');
if (args.includes('ps')) { process.stdout.write(${JSON.stringify(id)} + '\n'); }
else if (args[0] === 'inspect') {
  if (options.inspectFails) { process.stderr.write('DO_NOT_LOG'); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify(${JSON.stringify(inspected)}) + '\n');
}
else if (args.includes('restart')) { process.stderr.write('https://secret.invalid/DO_NOT_LOG'); process.exitCode = options.restartFails ? 1 : 0; }
else if (args[0] === 'run') {
  process.stderr.write('https://secret.invalid/DO_NOT_LOG');
  if (args.includes('--restart-failed')) {
    if (options.recordFails) { process.stdout.write('DO_NOT_LOG'); process.exitCode = 125; }
    else process.exitCode = (await recordRestartFailure({ stateFile, now: ${START + 120} })).code;
  } else if (options.output !== undefined) { process.stdout.write(options.output); process.exitCode = options.runCode ?? 0; }
  else {
    process.exitCode = (await runOnce({ stateFile, now: ${START + 120}, inspect: () => readInspection((async function* () { yield stdin; })()),
      gateway: async () => { if (options.silent) throw Error('DO_NOT_LOG'); return { head: '101' }; },
      rpc: async () => ({ head: '200', timestamp: '${START + 120}', chainId: '11155111' }) })).code;
  }
} else { throw Error('unexpected Docker call'); }
`);
  const shell = `
source infra/server/heal/check.sh
state_dir=$HEAL_TEST_DIR
release_file=$HEAL_TEST_DIR/release.env
manifest_file=$HEAL_TEST_DIR/manifest.json
flock() { [[ $HEAL_TEST_LOCK == yes ]]; }
docker() { HEAL_TEST_TIMEOUT=$docker_timeout "$HEAL_TEST_NODE" "$HEAL_TEST_DRIVER" "$@"; }
node() { printf 'unexpected host node\n' >&2; return 99; }
main
`;
  return { ...f, dir, async invoke() {
    return spawnSync('/bin/bash', ['-c', shell], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin',
      HEAL_TEST_DIR: dir, HEAL_TEST_NODE: process.execPath, HEAL_TEST_DRIVER: driver, HEAL_TEST_LOCK: options.locked ? 'no' : 'yes' } });
  }, async calls() {
    try { return (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  } };
}

function assertRedacted(result) {
  assert.doesNotMatch(result.stdout + result.stderr, /https?:|private-token|DO_NOT_LOG|SH_CORE_HTTP_URLS|unexpected host node/);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
}

test('host wrapper pins inspect/run/restart argv, passes secrets only on stdin and persists failed restart', async () => {
  for (const restartFails of [false, true]) {
    const f = await wrapperFixture({ silent: true, restartFails });
    await f.run({ gateway: unavailable, inspect: async () => ({ ...container, identity: `${id}:${startedAt}` }) });
    await f.run({ gateway: unavailable, inspect: async () => ({ ...container, identity: `${id}:${startedAt}` }) });
    const result = await f.invoke();
    assert.equal(result.status, restartFails ? 1 : 0, result.stderr);
    assertRedacted(result);
    assert.equal(JSON.parse(result.stdout).decision, restartFails ? 'restart-failed' : 'restart-gateway');
    const calls = await f.calls();
    const run = ['run', '--rm', '--pull', 'never', '--name', 'squarehole-indexer-heal-check', '--network', 'host',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', String(process.getuid()),
      '--no-healthcheck', '--log-driver', 'none', '--mount', `type=bind,src=${f.dir},dst=/var/lib/squarehole-indexer-heal`,
      '--mount', `type=bind,src=${resolve('infra/server/heal/main.mjs')},dst=/heal.mjs,readonly`,
      '--entrypoint', 'node', '-i', `squarehole-indexer:${release}`, '/heal.mjs'];
    assert.deepEqual(calls.map(call => call.args), [[...compose, 'ps', '--all', '--quiet', 'indexer'],
      ['inspect', '--format', inspectFormat, id], run, [...compose, 'restart', 'indexer'],
      ...(restartFails ? [[...run, '--restart-failed']] : [])]);
    assert.deepEqual(JSON.parse(calls[2].stdin), JSON.parse(inspection));
    assert.deepEqual(calls[3].state.restartTimes, [START + 120]);
    assert.equal(calls[3].state.lastRestart.outcome, 'reserved');
    assert.doesNotMatch(JSON.stringify(calls.map(call => call.args)), /https?:|private-token|DO_NOT_LOG/);
    assert.equal((await f.state()).lastRestart.outcome, restartFails ? 'restart-failed' : 'reserved');
    assert.deepEqual((await f.state()).restartTimes, [START + 120]);
  }
});

test('wrapper never restarts on observation, lock contention, malformed/extra output or unsuccessful decision process', async () => {
  for (const options of [{}, { locked: true }, { output: 'https://secret.invalid/DO_NOT_LOG\n' },
    { output: '{"decision":"restart-gateway"}\n' },
    { output: '{"decision":"restart-gateway","gatewayFailures":0,"stuckRuns":0,"restarts24h":1}\n', runCode: 1 },
    { output: '{"decision":"no-action","gatewayFailures":0,"stuckRuns":0,"restarts24h":0,"secret":"DO_NOT_LOG"}\n' },
    { output: '{"decision":"restart-gateway","gatewayFailures":0,"stuckRuns":0,"restarts24h":1}\n{}\n' }]) {
    const f = await wrapperFixture(options);
    const result = await f.invoke();
    assertRedacted(result);
    assert.equal(result.status, options.output ? 1 : 0);
    assert.ok(!(await f.calls()).some(call => call.args.includes('restart')));
    assert.equal(JSON.parse(result.stdout).decision, options.output ? 'internal-error' : options.locked ? 'already-running' : 'no-action');
  }
});

test('wrapper preserves safe internal-error counters from a failed decision process', async () => {
  const output = JSON.stringify({ decision: 'internal-error', gatewayFailures: 2, stuckRuns: 0, restarts24h: 1 });
  const f = await wrapperFixture({ output, runCode: 1 });
  const result = await f.invoke();
  assertRedacted(result);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(output));
  assert.ok(!(await f.calls()).some(call => call.args.includes('restart')));
});

test('every non-restart decision stays observational in the wrapper', async () => {
  for (const decision of ['clock-rollback', 'container-unavailable', 'startup-grace', 'rpc-unavailable',
    'rpc-behind', 'state-recovery-hold', 'observing', 'no-action', 'daily-cap', 'cooldown', 'restart-failed', 'internal-error']) {
    const f = await wrapperFixture({ output: JSON.stringify({ decision, gatewayFailures: 0, stuckRuns: 0, restarts24h: 0 }) });
    const result = await f.invoke();
    assertRedacted(result);
    assert.equal(JSON.parse(result.stdout).decision, decision);
    assert.equal(result.status, ['restart-failed', 'internal-error'].includes(decision) ? 1 : 0);
    assert.ok(!(await f.calls()).some(call => call.args.includes('restart')));
  }
});

test('failed inspection resets streaks and failed outcome persistence retains the reserved budget', async () => {
  for (const options of [{ silent: true, inspectFails: true }, { silent: true, restartFails: true, recordFails: true }]) {
    const f = await wrapperFixture(options);
    for (let i = 0; i < 2; i++) await f.run({ gateway: unavailable,
      inspect: async () => ({ ...container, identity: `${id}:${startedAt}` }) });
    const result = await f.invoke();
    assertRedacted(result);
    const state = await f.state();
    assert.equal(state.gatewayFailures, 0);
    assert.equal(state.stuckRuns, 0);
    assert.equal(result.status, options.inspectFails ? 0 : 1);
    assert.equal(JSON.parse(result.stdout).decision, options.inspectFails ? 'container-unavailable' : 'internal-error');
    assert.deepEqual(state.restartTimes, options.inspectFails ? [] : [START + 120]);
    assert.equal((await f.calls()).filter(call => call.args.includes('restart')).length, options.inspectFails ? 0 : 1);
  }
});

test('legacy state without lastRestart preserves cooldown and daily budget', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.run({ gateway: unavailable });
  const { lastRestart, ...legacy } = await f.state();
  assert.equal(lastRestart.outcome, 'reserved');
  await writeFile(f.stateFile, JSON.stringify(legacy));
  for (let i = 0; i < 3; i++) await f.run({ gateway: unavailable });
  assert.equal(JSON.parse(f.lines.at(-1)).decision, 'cooldown');
  assert.deepEqual((await f.state()).restartTimes, [START + 120]);
  assert.equal((await f.state()).holdUntil, 0);
});

test('compose healthcheck runs Node against its own gateway with a 30-minute replay start period', async () => {
  const config = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.respond_to?(:unsafe_load_file) ? YAML.unsafe_load_file(ARGV[0]) : YAML.load_file(ARGV[0]))', 'infra/server/compose.yaml'], { encoding: 'utf8' }));
  const health = config.services.indexer.healthcheck;
  assert.deepEqual({ interval: health.interval, timeout: health.timeout, retries: health.retries, start_period: health.start_period },
    { interval: '30s', timeout: '5s', retries: 3, start_period: '30m' });
  assert.deepEqual(health.test.slice(0, 3), ['CMD', 'node', '-e']);
  assert.match(health.test[3], /http:\/\/127\.0\.0\.1:5394\/healthz/);
  assert.equal(config.services.indexer.restart, 'unless-stopped');
});

test('units pin cadence, state permissions, stack dependency, Docker access and monitor-level hardening', async () => {
  const service = await readFile('infra/server/systemd/squarehole-indexer-heal.service', 'utf8');
  const timer = await readFile('infra/server/systemd/squarehole-indexer-heal.timer', 'utf8');
  for (const pin of ['Type=oneshot', 'User=root', 'Group=root', 'Requisite=squarehole-stack.service',
    'After=docker.service network-online.target squarehole-stack.service', 'TimeoutStartSec=120',
    'StateDirectory=squarehole-indexer-heal', 'StateDirectoryMode=0700', 'UMask=0077',
    'NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true',
    'ReadWritePaths=/var/lib/squarehole-indexer-heal', 'ReadOnlyPaths=/tmp /var/tmp', 'PrivateTmp=true', 'PrivateDevices=true',
    'ProtectKernelTunables=true', 'ProtectKernelModules=true', 'ProtectControlGroups=true',
    'RestrictSUIDSGID=true', 'RestrictRealtime=true', 'LockPersonality=true',
    'CapabilityBoundingSet=', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6']) assert.ok(service.split('\n').includes(pin), pin);
  assert.equal(service.match(/^ReadWritePaths=.*/gm).length, 1);
  assert.doesNotMatch(service, /EnvironmentFile=|squarehole-monitor|PrivateNetwork=true/);
  for (const pin of ['OnCalendar=*-*-* *:*:00 UTC', 'AccuracySec=1', 'Persistent=true', 'Unit=squarehole-indexer-heal.service', 'WantedBy=timers.target']) assert.ok(timer.split('\n').includes(pin), pin);
});

test('stack install enables healing after stack activation and validator includes the locked shell entry point', async () => {
  const install = await readFile('infra/server/install.sh', 'utf8');
  assert.match(install, /systemd\/squarehole-indexer-heal\.\{service,timer\}/);
  assert.match(install, /^systemctl enable --now squarehole-indexer-heal\.timer$/m);
  assert.doesNotMatch(install, /command -v node|systemctl disable --now squarehole-indexer-heal\.timer/);
  assert.ok(install.indexOf('systemctl enable --now squarehole-indexer-heal.timer') > install.indexOf('systemctl reload squarehole-stack.service'));
  const shell = await readFile('infra/server/heal/check.sh', 'utf8');
  assert.match(shell, /flock --nonblock/);
  assert.match(shell, /state_dir=\/var\/lib\/squarehole-indexer-heal/);
  assert.match(shell, /exec 9>"\$state_dir\/run.lock"/);
  assert.match(shell, /\/usr\/bin\/env -i/);
  assert.match(shell, /DOCKER_HOST=unix:\/\/\/var\/run\/docker.sock DOCKER_CONFIG=\/etc\/squarehole\/docker/);
  const validate = await readFile('infra/server/app/validate.sh', 'utf8');
  assert.match(validate, /infra\/server\/heal\/check\.sh/);
  assert.match(validate, /infra\/server\/install\.sh/);
  assert.match(validate, /shellcheck "\$\{scripts\[@\]\}"/);
});
