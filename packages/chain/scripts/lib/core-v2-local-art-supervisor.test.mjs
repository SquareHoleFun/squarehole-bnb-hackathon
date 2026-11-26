import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as runtime from './core-v2-local-runtime.mjs';
import { localArtEnvironment } from './core-v2-local-art.mjs';
import { shLimit } from '../../../../vitest.timeouts.mjs';

const { ROOT, localOptions, json } = runtime;
// Execute the supervisor's real startup/shutdown body. Only its imports and process boundary are doubles;
// no listener, child process, real timer, network fetch or write is available in this context.
const body = readFileSync(join(ROOT, 'scripts/dev-core-v2-local.mjs'), 'utf8')
  .replace(/^#![^\n]*\n/, '').replace(/^import .*;\n/gm, '');

async function supervise({ occupied = false, argv = [] } = {}) {
  const ports = localOptions({});
  const calls = []; const processes = [];
  const signals = new EventEmitter(); const art = new EventEmitter();
  const chain = { chainId: 11155111, rpcUrl: 'http://127.0.0.1:8566', manifest: 'local-manifest.json', setManifest: 'local-set-manifest.json', boxes: { plain: 'box' } };
  art.closeAllConnections = () => calls.push('art-connections-closed');
  art.close = done => { calls.push('art-closed'); done(); };
  let exit;
  const exited = new Promise(done => { exit = code => { calls.push(['exit', code]); done(); }; });
  const context = {
    ROOT, join, json, localArtEnvironment, localOptions: () => ports,
    // The runtime's own value, so this runs the site's env exactly as the supervisor builds it.
    E2E_DEV_SERVER_ENV: runtime.E2E_DEV_SERVER_ENV,
    process: { argv, once: signals.once.bind(signals), exit },
    console: { error() {}, warn() {} },
    setTimeout: () => 1, clearTimeout() {},
    freePort: async port => calls.push(['free', port]),
    // TA-22: the chain suite (`--e2e`) also serves the pictures a page-created box commits, from a catalogue it empties.
    resetExampleArt: directory => calls.push(['art-reset', directory]),
    startLocalArtGateway: async (actual, ...options) => {
      assert.deepEqual(actual, ports); calls.push('art-start');
      // As JSON: the options object comes from the supervisor's own context (another realm).
      if (argv.includes('--e2e')) assert.equal(JSON.stringify(options), JSON.stringify([{ exampleArt: join(ROOT, '.cache/core-v2-local/run/created-art') }]));
      else assert.deepEqual(options, [], 'the founder stack serves only the committed catalogue, never example art');
      if (occupied) throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
      return art;
    },
    startLocalCoreV2Chain: async () => { calls.push('chain-start'); return { process: new EventEmitter(), chain }; },
    runLocalLife: async () => calls.push('life'), readLocalManifest: async () => ({}),
    // SH-EXISTING-NFTS-E08B: the add-on's set life runs after the v2 life, and the boot waits for both set rows.
    runSetLocalLife: async () => calls.push('set-life'), recipe: () => {}, callLocal: () => {},
    writeFileSync: () => calls.push('manifest-written'),
    writeLocalCreateOptions: manifest => {
      assert.equal(manifest, chain.manifest); assert.ok(calls.includes('manifest-written'));
      calls.push('create-options-written'); return '/local-run/create-options';
    },
    child: (command, args, options) => { processes.push({ command, args: Array.from(args), options }); return new EventEmitter(); },
    fetch: async url => {
      if (url === 'http://127.0.0.1:5395/v2/sets/feed?chain=11155111') return { ok: true, json: async () => ({ boxes: argv.includes('--e2e') ? [] : [{}, {}] }) };
      assert.equal(url, 'http://127.0.0.1:5395/v2/feed?chain=11155111');
      return { json: async () => ({ cards: [{ verified: true, stale: false }] }) };
    },
    AbortSignal, delay: async () => {}, localRunFailed: () => false,
    stopChildren: async options => calls.push(['children-stopped', options.failure]),
  };
  await runInNewContext(`(async () => { ${body}\n })()`, context, { timeout: 1000 });
  return { ports, calls, processes, signals, exited };
}

for (const occupied of [false, true]) {
  test(`LOCAL-ART-STACK: ${occupied ? 'occupied gateway stops startup' : 'gateway env reaches indexer/site and SIGTERM closes it'}`, async () => {
    const { ports, calls, processes, signals, exited } = await supervise({ occupied });
    if (occupied) {
      assert(!calls.includes('chain-start')); assert.equal(processes.length, 0);
      await exited; assert.deepEqual(calls.at(-1), ['exit', 1]);
      return;
    }
    assert(calls.indexOf('art-start') < calls.indexOf('chain-start'));
    assert(calls.indexOf('life') < calls.indexOf('set-life'), 'the set life runs after the v2 life');
    assert.equal(processes.length, 2);
    assert.deepEqual(processes.map(p => p.args[1]), ['@squarehole/indexer', '@squarehole/web']);
    for (const child of processes) {
      for (const [key, value] of Object.entries(localArtEnvironment(ports))) assert.equal(child.options.env[key], value);
    }
    signals.emit('SIGTERM'); await exited;
    assert.deepEqual(calls.slice(-4), ['art-connections-closed', 'art-closed', ['children-stopped', false], ['exit', 0]]);
  });
}

// SH-RC7 open item 30 (SH-V21-RC6-INT P5.5): in the chain suite (`--e2e`) a late file event for the stack's own manifest
// updated the dev server's modules while a box page loaded. There the site's dev server watches no file
// (SH_DEV_SERVER_WATCH=off, vite.config.ts); the founder's `pnpm dev:core-v2-local` keeps its live reload.
for (const e2e of [true, false]) {
  test(`SH-RC7 item 30: ${e2e ? 'the chain suite\'s site watches no file' : 'the founder\'s stack keeps watching'}`, async () => {
    const { calls, processes, signals, exited } = await supervise({ argv: e2e ? ['--e2e'] : [] });
    const site = processes.find(p => p.args[1] === '@squarehole/web');
    assert.equal(calls.some(c => Array.isArray(c) && c[0] === 'art-reset'), e2e, 'only the chain suite empties its created-art catalogue');
    assert.equal(calls.includes('set-life'), !e2e, 'only the founder\'s stack runs the full set life');
    assert.deepEqual(site.args.slice(0, 3), ['--filter', '@squarehole/web', 'dev']);
    assert.equal(site.options.env.SH_DEV_SERVER_WATCH, e2e ? 'off' : undefined);
    const indexer = processes.find(p => p.args[1] === '@squarehole/indexer');
    assert.equal(indexer.options.env.SH_DEV_SERVER_WATCH, undefined, 'only the site reads it');
    signals.emit('SIGTERM'); await exited;
  });
}

// SH-229: on 16 November 2026 the stack's watchdog (21 minutes) ended the stack under a chain suite that takes 22 on
// the laptop, because nothing tied the two numbers. Every settings file that starts the launcher with --e2e is read
// here, and this file runs with `pnpm test:scripts`. A number must be a plain literal: an expression is refused, not
// read as its first number. The list of settings files is checked against the repository, and the launcher may have
// one timer only, so that a new suite or a second watchdog cannot go unread. A limit given on a command line
// (`--global-timeout`) is not seen here; no package script passes one.
test('SH-229: the stack\'s own watchdog outlasts every suite that starts it, by a minute or more', () => {
  const literal = (text, pattern, what) => {
    const found = text.match(pattern);
    assert.ok(found, `${what} is not a plain number`);
    return Number(found[1].replaceAll('_', ''));
  };
  const launcher = readFileSync(join(ROOT, 'scripts/dev-core-v2-local.mjs'), 'utf8');
  assert.equal(launcher.split('setTimeout(').length - 1, 1, 'the launcher has one timer: its watchdog');
  const watchdog = literal(launcher, /void shutdown\(1\); \}, browser \? ([\d_]+) : [\d_]+\);/, 'the launcher\'s --e2e watchdog');
  const suites = ['apps/web/e2e/core-v2-chain/arweave/playwright.config.mjs', 'apps/web/playwright.core-v2-chain.config.ts'];
  // Tracked and new files alike; the pattern names settings files, so this test file and the launcher are not among them.
  const starters = execFileSync('git', ['grep', '--untracked', '-l', '-F', 'scripts/dev-core-v2-local.mjs --e2e', '--',
    '*.config.ts', '*.config.mts', '*.config.mjs', '*.config.js', ':!*.env'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean).sort();
  assert.deepEqual(starters, suites, 'every settings file that starts the launcher with --e2e is read below');
  for (const file of suites) {
    const settings = readFileSync(join(ROOT, file), 'utf8');
    const limit = literal(settings, /\bglobalTimeout:\s*([\d_]+)\s*,/, `${file}: globalTimeout`);
    assert.ok(watchdog >= limit + 60_000, `${file}: the suite may run ${limit} ms, the stack ends itself after ${watchdog} ms`);
  }
});

// Read the launchers as the supervisor tests above do. Execute the real list-write and indexer-start block with
// only process/file boundaries doubled; no chain, listener, timer or browser is started.
const LIST_LAUNCHERS = [
  ['scripts/dev-core-v2-local.mjs', 'chain.manifest', 'writeFileSync(chain.manifest, json(await readLocalManifest(chain)));'],
  ['apps/web/e2e/core-v2-chain/examples/stack.mjs', 'chain.manifest', 'const running = await startLocalCoreV2Chain('],
  ['apps/web/e2e/core-v2-chain/shop/stack.mjs', 'chain.manifest', 'const running = await startLocalCoreV2Chain('],
  ['packages/chain/scripts/alpha-local-stack.mjs', 'files.site', 'writeFileSync(files.site, json(site));'],
];
// The first round named three launchers and missed the shop suite's (review confirmation C1): the list above is
// compared with the repository. A launcher of a stack whose manifest holds no release needs no list and is named here.
const NO_RELEASE_LAUNCHERS = ['scripts/dev-core-local.mjs'];
test('SH-218: every script that starts the core indexer writes its release lists, or is named as having no release', () => {
  // Tracked and new files alike. The pattern is the launchers' own argument list, which this test file does not hold.
  const starters = execFileSync('git', ['grep', '--untracked', '-l', '-E', String.raw`'@squarehole/indexer', 'start:core'\]`, '--',
    '*.mjs', '*.ts', '*.js', ':!*.test.*', ':!*.env'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean).sort();
  assert.deepEqual(starters, [...LIST_LAUNCHERS.map(([file]) => file), ...NO_RELEASE_LAUNCHERS].sort());
  for (const file of NO_RELEASE_LAUNCHERS) assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /SH_CORE_CREATE_OPTIONS_DIR/);
});
for (const [file, manifest, ready] of LIST_LAUNCHERS) {
  test(`SH-218: ${file} writes its release lists before starting the indexer with their folder`, () => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.match(text, /import \{ writeLocalCreateOptions \} from '[^']*\/lib\/local-create-options\.mjs';/);
    const write = `const createOptionsDirectory = writeLocalCreateOptions(${manifest});`;
    const begin = text.indexOf(write);
    assert.ok(text.indexOf(ready) >= 0 && text.indexOf(ready) < begin, 'the release manifest exists before lists are written');
    const start = text.indexOf("'@squarehole/indexer', 'start:core'");
    assert.ok(start > begin, 'write precedes indexer start');
    const end = text.indexOf('\n  });', start) + '\n  });'.length;
    const calls = [];
    const launch = (...args) => {
      assert.deepEqual(calls, ['written']);
      const env = args.at(-1);
      assert.equal(env.SH_CORE_MANIFEST, '/this-run/manifest.json');
      assert.equal(env.SH_CORE_CREATE_OPTIONS_DIR, '/this-run/create-options');
      calls.push('started');
    };
    runInNewContext(text.slice(begin, end), {
      writeLocalCreateOptions: path => {
        assert.equal(path, '/this-run/manifest.json'); calls.push('written'); return '/this-run/create-options';
      },
      start: launch, service: launch,
      chain: { manifest: '/this-run/manifest.json', setManifest: '/this-run/set.json', rpcUrl: 'local' },
      files: { site: '/this-run/manifest.json' }, ports: { gatewayPort: 5395, gateway: 5535 }, url: 'local', artEnv: {},
    }, { timeout: shLimit(1000) });
    assert.deepEqual(calls, ['written', 'started']);
  });
}
