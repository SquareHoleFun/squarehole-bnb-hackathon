import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import * as runtime from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { contractReady, loadExamples } from '../../../../../packages/box-spec/examples/v2/registry.mjs';
import { DEFAULT_PORTS, ROOT, validatePorts } from './support.mjs';

// SH-218: stack.mjs writes its release's Create list before it starts the indexer (lib/local-create-options.mjs).
const CREATE_OPTIONS = '../../../../../packages/chain/scripts/lib/local-create-options.mjs';

async function load(file, bindings, globals = {}) {
  const context = createContext({ URL, ...globals });
  const url = new URL(file, import.meta.url);
  const module = new SourceTextModule(await readFile(url, 'utf8'), {
    context, identifier: url.href, initializeImportMeta: meta => { meta.url = url.href; },
  });
  await module.link(name => {
    assert.ok(bindings[name], `unexpected import: ${name}`);
    return new SyntheticModule(Object.keys(bindings[name]), function () {
      for (const [key, value] of Object.entries(bindings[name])) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

// Evaluate the real suite's declarations without a browser, chain manifest or RPC.
// Only a declaration-time skip can prevent Playwright from creating page fixtures.
async function browserLives() {
  const lives = new Map();
  let skipReason;
  const browserTest = title => lives.set(title.split(' · ')[0], { skipReason });
  browserTest.describe = callback => {
    const previous = skipReason;
    callback();
    skipReason = previous;
  };
  browserTest.describe.configure = () => {};
  browserTest.skip = (condition, reason) => { if (condition) skipReason = reason; };
  const unexpected = () => { throw new Error('browser life must not start during discovery'); };
  await load('../examples.spec.mjs', {
    'node:fs': { readFileSync: unexpected },
    '@playwright/test': { test: browserTest, expect: unexpected },
    '../../../../packages/box-spec/examples/v2/registry.mjs': { loadExamples },
    './examples/create.mjs': { createExample: unexpected },
    './examples/life.mjs': { runLife: unexpected },
    './examples/wallet.mjs': { installWallet: unexpected },
    './examples/support.mjs': { assertProperties: unexpected, RUN: new URL('.cache/examples-e2e/run/', ROOT), stringify: JSON.stringify },
    './helpers.mjs': { followedIndexer: unexpected },
  });
  return lives;
}

for (const [id, standIn] of [['frog-kiln', 'Test Frog (tFROG)'], ['paper-certificates', 'Test Gold (tGOLD)']]) {
  test(`${id} stays contract-ready but skips its browser life before page setup`, async () => {
    const example = loadExamples().find(example => example.id === id);
    assert.equal(example.status, 'ready');
    assert.equal(contractReady(example), true);
    const life = (await browserLives()).get(id);
    assert.ok(life, 'the browser suite must still report the life');
    assert.ok(life.skipReason, 'missing browser prerequisites must skip before page setup');
    assert.ok(life.skipReason.includes(standIn), 'name the missing local test stand-in and actual symbol');
    assert.match(life.skipReason, /private.*draw.*reveal/i, 'retain the hidden-art browser integration prerequisite');
  });
}

test('browser prerequisite gates preserve the other fourteen lives and pending Alchemist', async () => {
  const lives = await browserLives();
  assert.equal(lives.size, loadExamples().length);
  for (const example of loadExamples()) {
    if (['frog-kiln', 'paper-certificates'].includes(example.id)) continue;
    const { skipReason } = lives.get(example.id);
    if (example.status === 'pending') assert.equal(skipReason, `${example.pendingStep}: ${example.pendingReason}`);
    else assert.equal(skipReason, undefined, `${example.id} must remain enabled`);
  }
});

async function runner({ list = false, failOffline = false, portError = false, keep = false, assigned } = {}) {
  const events = []; const calls = [];
  const process = Object.assign(new EventEmitter(), { execPath: 'node', argv: ['node', 'run.mjs', ...(list ? ['--list'] : []), ...(keep ? ['--keep-hidden-art'] : [])],
    env: { SH_FORGE_TIMEOUT_MS: '12', SENTINEL: 'inherited', ...(assigned ? { SH_EXAMPLES_PORTS: JSON.stringify(assigned) } : {}) }, exitCode: 0 });
  await load('./run.mjs', {
    'node:child_process': { spawn(command, args, options) {
      const name = args.some(arg => arg.endsWith('/offline.mjs')) ? 'offline' : command === 'pnpm' ? 'playwright' : 'preflight';
      events.push(name); calls.push({ name, command, args, options });
      const child = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => child.emit('close', failOffline && name === 'offline' ? 1 : 0));
      return child;
    } },
    'node:net': { createServer() {
      const server = new EventEmitter();
      server.listen = (_port, _host, done) => {
        events.push('port');
        queueMicrotask(() => portError ? server.emit('error', Object.assign(new Error('port denied'), { code: 'EPERM' })) : done());
      };
      server.close = done => done();
      return server;
    } },
    'node:url': { fileURLToPath },
    './support.mjs': { ROOT, DEFAULT_PORTS, validatePorts },
  }, { process, console: { warn: message => events.push(message), error: message => events.push(message) } });
  return { events, calls, process };
}

test('runner reports each phase before work and passes a 30-minute Forge budget to its stack', async () => {
  const { events, calls, process } = await runner();
  for (const [message, operation] of [
    ['[examples] Phase: preflight tests', 'preflight'],
    ['[examples] Phase: offline contracts and replay', 'offline'],
    ['[examples] Phase: free-port preflight', 'port'],
    ['[examples] Phase: local stack and browser tests', 'playwright'],
  ]) {
    assert.ok(events.indexOf(message) >= 0 && events.indexOf(message) < events.indexOf(operation), `${message} must precede ${operation}`);
  }
  assert.ok(events.includes('[examples] Phase: complete'));
  assert.equal(calls.filter(call => call.name === 'offline').length, 2, 'run the original replay and Junkyard EVM proof');
  assert.ok(calls.some(call => call.args.includes('--junkyard')));
  const playwright = calls.find(call => call.name === 'playwright');
  assert.equal(playwright.options.env.SH_FORGE_TIMEOUT_MS, '1800000');
  assert.equal(playwright.options.env.SENTINEL, 'inherited');
  assert.equal(process.env.SH_FORGE_TIMEOUT_MS, '12', 'the parent environment is not changed');
  assert.equal(process.exitCode, 0);
});

test('the free-port probe starts at the caller\'s assigned SH_EXAMPLES_PORTS, else at the defaults', async () => {
  const assigned = { appPort: 5540, gatewayPort: 5541, artPort: 5542, chainPort: 8592 };
  const stack = calls => JSON.parse(calls.find(call => call.name === 'playwright').options.env.SH_EXAMPLES_PORTS);
  assert.deepEqual(stack((await runner({ assigned })).calls), assigned);
  assert.deepEqual(stack((await runner()).calls), DEFAULT_PORTS);
  // A refused assignment stops before any listener or browser work.
  const refused = await runner({ assigned: { ...assigned, chainPort: 8566 } });
  assert.equal(refused.process.exitCode, 1);
  assert.ok(!refused.calls.some(call => call.name === 'playwright'));
});

test('discovery reports its phase and skips offline compilation and listeners', async () => {
  const { events, calls } = await runner({ list: true });
  assert.deepEqual(calls.map(call => call.name), ['preflight', 'playwright']);
  assert.ok(!events.includes('port'));
  assert.ok(events.includes('[examples] Phase: browser test discovery'));
});

test('runner forwards --keep-hidden-art only to offline art preparation', async () => {
  const { calls } = await runner({ keep: true });
  assert.ok(calls.find(call => call.name === 'offline').args.includes('--keep-hidden-art'));
  assert.ok(!calls.find(call => call.name === 'playwright').args.includes('--keep-hidden-art'));
});

test('failed offline or port phases stop before browser startup', async () => {
  for (const options of [{ failOffline: true }, { portError: true }]) {
    const { calls, events, process } = await runner(options);
    assert.equal(process.exitCode, 1);
    assert.ok(!calls.some(call => call.name === 'playwright'));
    assert.ok(!events.includes('[examples] Phase: complete'));
    const phase = options.failOffline ? 'offline contracts and replay' : 'free-port preflight';
    assert.ok(events.some(line => line.startsWith(`Examples E2E failed during ${phase}:`)));
  }
});

let examplesGlobalTimeout = 0;
test('Playwright startup and suite budgets leave time for a 30-minute Forge build', async () => {
  const { default: config } = await load('./playwright.config.mjs', {
    '@playwright/test': { defineConfig: config => config, devices: { 'Desktop Chrome': {} } },
    'node:url': { fileURLToPath },
    './support.mjs': { portsFromEnv: () => DEFAULT_PORTS, ROOT },
    '../../terms-state.ts': { TERMS_ACCEPTED: {} },
  });
  assert.ok(config.webServer.timeout >= 1_800_000 + 300_000, 'allow build plus deployment/indexer startup');
  // SH-229: an hour for the lives after startup; they take 28 minutes on the laptop of 2026-11-10.
  assert.ok(config.globalTimeout >= config.webServer.timeout + 3_600_000, 'retain the browser suite budget after startup');
  examplesGlobalTimeout = config.globalTimeout;
});

test('the examples stack watchdog allows both startup and browser work', async () => {
  let watchdog;
  await load('./stack.mjs', {
    'node:fs': { mkdirSync() {}, writeFileSync() {} },
    'node:url': { fileURLToPath },
    '../../../../../packages/chain/scripts/local-core-v2-chain.mjs': { startLocalCoreV2Chain() { throw new Error('unexpected startup'); } },
    '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs': {
      child() {}, delay() {}, stopChildren() {}, freePort() { throw new Error('listener blocked'); }, E2E_DEV_SERVER_ENV: runtime.E2E_DEV_SERVER_ENV,
    },
    '../../../../../packages/chain/scripts/lib/core-v2-local-art.mjs': { localArtEnvironment() {}, resetExampleArt() {}, startLocalArtGateway() {} },
    [CREATE_OPTIONS]: { writeLocalCreateOptions() { throw new Error('unexpected list write'); } },
    './support.mjs': { portsFromEnv: () => DEFAULT_PORTS, RUN: new URL('.cache/examples-e2e/run/', ROOT),
      EXAMPLE_ART: new URL('.cache/examples-e2e/run/art/', ROOT), stringify: JSON.stringify },
  }, {
    process: Object.assign(new EventEmitter(), { exit() {} }),
    console: { error() {} },
    setTimeout(_callback, ms) { watchdog = ms; return 1; }, clearTimeout() {},
  });
  assert.ok(examplesGlobalTimeout > 0, 'the settings test above reads the suite limit first');
  assert.ok(watchdog >= examplesGlobalTimeout + 60_000, 'watchdog must outlast Playwright startup and suite budgets');
});

test('the examples stack starts an empty example art catalogue and serves it only through its own gateway', async () => {
  const calls = [];
  const exampleArt = new URL('.cache/examples-e2e/run/art/', ROOT);
  await load('./stack.mjs', {
    'node:fs': { mkdirSync() { calls.push('run-folder'); }, writeFileSync() {} },
    'node:url': { fileURLToPath },
    '../../../../../packages/chain/scripts/local-core-v2-chain.mjs': { startLocalCoreV2Chain() { calls.push('chain'); throw new Error('stop after art'); } },
    '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs': {
      child() {}, delay() {}, stopChildren() { calls.push('children-stopped'); }, freePort() {}, E2E_DEV_SERVER_ENV: runtime.E2E_DEV_SERVER_ENV,
    },
    '../../../../../packages/chain/scripts/lib/core-v2-local-art.mjs': {
      localArtEnvironment() { return {}; },
      resetExampleArt(directory) { calls.push(['reset', directory]); },
      startLocalArtGateway(ports, options) {
        calls.push(['gateway', ports, options]);
        return { closeAllConnections() { calls.push('connections-closed'); }, close(done) { calls.push('gateway-closed'); done(); } };
      },
    },
    [CREATE_OPTIONS]: { writeLocalCreateOptions() { calls.push('create-options'); return '/run/create-options'; } },
    './support.mjs': { portsFromEnv: () => DEFAULT_PORTS, RUN: new URL('.cache/examples-e2e/run/', ROOT), EXAMPLE_ART: exampleArt, stringify: JSON.stringify },
  }, {
    process: Object.assign(new EventEmitter(), { exit(code) { calls.push(['exit', code]); } }),
    console: { error() {} },
    setTimeout() { return 1; }, clearTimeout() {},
  });
  const directory = fileURLToPath(exampleArt);
  // The options object comes from the module's own realm; compare plain values.
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['run-folder', ['reset', directory], ['gateway', DEFAULT_PORTS, { exampleArt: directory }], 'chain',
    'connections-closed', 'gateway-closed', 'children-stopped', ['exit', 1]]);
});

// SH-RC7 open item 30 (SH-V21-RC6-INT P5.5): the examples ran on a dev server that acted on a late file event for this
// stack's own manifest. The site still runs on the dev server (create.mjs reads the page's draft through its /src/
// modules), but with no file watcher (SH_DEV_SERVER_WATCH=off, vite.config.ts), so no file event can update its modules.
test('SH-RC7 item 30: the examples stack starts its site on a dev server that watches no file', async () => {
  const children = [];
  const lists = [];
  const chain = { chainId: 11155111, rpcUrl: 'http://127.0.0.1:8576', manifest: '/run/core-v2-manifest-11155111.json', boxes: { plain: '0x01' } };
  await load('./stack.mjs', {
    'node:fs': { mkdirSync() {}, writeFileSync() {} },
    'node:url': { fileURLToPath },
    '../../../../../packages/chain/scripts/local-core-v2-chain.mjs': { async startLocalCoreV2Chain() { return { chain, process: new EventEmitter() }; } },
    '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs': {
      child(command, args, options) { children.push({ command, args: [...args], env: { ...options.env } }); return new EventEmitter(); },
      async delay() {}, stopChildren() {}, freePort() {}, E2E_DEV_SERVER_ENV: runtime.E2E_DEV_SERVER_ENV,
    },
    '../../../../../packages/chain/scripts/lib/core-v2-local-art.mjs': {
      localArtEnvironment() { return { SH_CORE_LOCAL_ART_GATEWAYS: 'http://127.0.0.1:5412' }; }, resetExampleArt() {},
      startLocalArtGateway() { return { closeAllConnections() {}, close(done) { done(); } }; },
    },
    [CREATE_OPTIONS]: { writeLocalCreateOptions(manifest) { lists.push(manifest); return '/run/create-options'; } },
    './support.mjs': { portsFromEnv: () => DEFAULT_PORTS, RUN: new URL('.cache/examples-e2e/run/', ROOT),
      EXAMPLE_ART: new URL('.cache/examples-e2e/run/art/', ROOT), stringify: JSON.stringify },
  }, {
    process: Object.assign(new EventEmitter(), { exit() {} }),
    console: { error(error) { throw error; } },
    setTimeout() { return 1; }, clearTimeout() {}, AbortSignal,
    fetch: async () => ({ json: async () => ({ cards: [{ verified: true, stale: false }] }) }),
  });
  assert.deepEqual(children.map(child => child.args[1]), ['@squarehole/indexer', '@squarehole/web']);
  const [indexer, site] = children;
  assert.deepEqual(site.args.slice(0, 3), ['--filter', '@squarehole/web', 'dev']);
  assert.equal(site.env.SH_DEV_SERVER_WATCH, 'off');
  assert.equal(site.env.SH_CORE_LOCAL_MANIFEST, chain.manifest);
  assert.equal(indexer.env.SH_DEV_SERVER_WATCH, undefined, 'only the site reads it');
  // SH-218: the stack writes the Create list of its own release once, and the indexer alone is pointed at it.
  assert.deepEqual(lists, [chain.manifest]);
  assert.equal(indexer.env.SH_CORE_CREATE_OPTIONS_DIR, '/run/create-options');
  assert.equal(site.env.SH_CORE_CREATE_OPTIONS_DIR, undefined, 'only the indexer reads it');
});
