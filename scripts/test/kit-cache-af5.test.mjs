import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import * as cache from '../kits/cache.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'cache-af5-'));
const write = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value)); };
const require = createRequire(join(cache.ROOT, 'package.json'));
const hook = realpathSync(join(dirname(require.resolve('vitest/package.json')), 'suppress-warnings.cjs'));
const nodePath = [join(dirname(hook), 'node_modules'), dirname(dirname(hook)), join(cache.ROOT, 'node_modules/.pnpm/node_modules')].join(delimiter);
const workerArgs = ['--experimental-import-meta-resolve', '--require', hook, '--conditions', 'node', '--conditions', 'development'];

test('af5: the pinned Vitest worker options and plain Node share an input key', () => {
  assert.equal(cache.hasToolOverrides({}, workerArgs), false);
  // Inject only the encoder so this option/identity regression also runs off Linux.
  const options = { encoder: () => ['fixture encoder'], env: {} };
  const plain = cache.createKitInputKey({ ...options, execArgv: [] })();
  assert.match(plain, /^[a-f0-9]{64}$/);
  assert.equal(cache.createKitInputKey({ ...options, execArgv: workerArgs })(), plain);
  assert.equal(cache.createKitInputKey({ ...options, env: { NODE_PATH: nodePath }, execArgv: workerArgs })(), plain);
  assert.equal(cache.hasToolOverrides({}, ['--conditions=node', '--conditions=production']), false);
});

test('af5: only pnpm Vitest launcher search paths are recognized', () => {
  assert.equal(cache.hasToolOverrides({ NODE_PATH: nodePath }, workerArgs), false);
  for (const value of [`${nodePath}${delimiter}/override`, `/override${delimiter}${nodePath}`, '/override', nodePath.split(delimiter)[0]]) {
    assert.equal(cache.hasToolOverrides({ NODE_PATH: value }, workerArgs), true, value);
  }
  assert.equal(cache.hasToolOverrides({ NODE_PATH: nodePath, NODE_OPTIONS: '--import=unknown.mjs' }, workerArgs), true);
});

test('af5: only the resolved Vitest hook is accepted, including require flag aliases', () => {
  const copy = join(scratch(), 'suppress-warnings.cjs');
  copyFileSync(hook, copy);
  const spellings = target => [['--require', target], [`--require=${target}`], ['-r', target], [`-r${target}`]];
  for (const args of spellings(hook)) assert.equal(cache.hasToolOverrides({}, args), false, args.join(' '));
  for (const target of [copy, join(scratch(), 'missing.cjs')]) {
    for (const args of spellings(target)) assert.equal(cache.hasToolOverrides({}, args), true, args.join(' '));
  }
  for (const args of [['--require'], ['--require='], ['-r'], ['--conditions', 'custom'], ['-Ccustom'], ['-C', 'custom'], ['--conditions'], ['--conditions=']]) {
    assert.equal(cache.hasToolOverrides({}, args), true, args.join(' '));
  }
});

for (const condition of ['development', 'production']) for (const field of ['exports', 'imports']) {
  test(`af5: ${condition} in hashed ${field} refuses reuse for workspace and transitive manifests`, () => {
    const targets = ['package.json', ...cache.BUILDER_WORKSPACES.map(path => `${path}/package.json`),
      'examples/boxes/fixture/package.json', 'node_modules/parent/node_modules/child/package.json'];
    for (const target of targets) {
      const root = scratch();
      write(root, 'node_modules/parent/package.json', { name: 'parent', optionalDependencies: { child: '1' } });
      write(root, 'node_modules/parent/node_modules/child/package.json', { name: 'child' });
      const options = { root, dependencies: () => cache.dependencyKey([join(root, 'node_modules/parent/package.json')]),
        encoder: () => ['fixture encoder'], env: {} };
      const args = ['--conditions', condition];
      const before = cache.createKitInputKey({ ...options, execArgv: args });
      assert.match(before(), /^[a-f0-9]{64}$/, target);
      const name = field === 'exports' ? '.' : '#fixture';
      write(root, target, { name: 'fixture', [field]: { [name]: [{ node: { [condition]: './special.js', default: './default.js' } }] } });
      assert.match(cache.createKitInputKey({ ...options, execArgv: [] })(), /^[a-f0-9]{64}$/, target);
      assert.equal(cache.createKitInputKey({ ...options, execArgv: args })(), null, target);
      assert.equal(before(), null, 'an edit after the baseline also refuses reuse');
    }
  });
}

test('af5: only condition keys count, and observing an unknown hook permanently disables reuse', () => {
  const root = scratch(), env = {};
  write(root, 'package.json', { name: 'fixture', exports: { '.': './development' }, imports: { '#fixture': './production' } });
  const key = cache.createKitInputKey({ root, dependencies: () => 'fixture deps', encoder: () => ['fixture encoder'],
    env, execArgv: ['--conditions=development', '-Cproduction'] });
  assert.match(key(), /^[a-f0-9]{64}$/);
  env.NODE_OPTIONS = '--import=unknown.mjs';
  assert.equal(key(), null);
  delete env.NODE_OPTIONS;
  assert.equal(key(), null);
});

test('af5: a hit validates identity exactly once after reading the entry', async () => {
  const directory = scratch(), run = cache.createBuildCache(directory);
  await run('key', () => 'cached');
  let checks = 0;
  const result = await run('key', () => assert.fail('rebuilt a warm hit'), { isCurrent: () => {
    checks++;
    assert.ok(readdirSync(directory).includes('key.bin'));
    return true;
  } });
  assert.equal(result, 'cached');
  assert.equal(checks, 1, 'one lookup identity plus one hit validation');
});

test('af5: a build validates identity exactly once after writing the temporary entry', async () => {
  const directory = scratch(), run = cache.createBuildCache(directory);
  let checks = 0, built = false;
  assert.equal(await run('key', () => { built = true; return 'new result'; }, { isCurrent: () => {
    checks++;
    assert.equal(built, true);
    assert.ok(readdirSync(directory).some(name => name.endsWith('.tmp')));
    assert.ok(!readdirSync(directory).includes('key.bin'), 'validation precedes publication');
    return true;
  } }), 'new result');
  assert.equal(checks, 1, 'one lookup identity plus one publication validation');
  assert.deepEqual(readdirSync(directory), ['key.bin']);
});

test('af5: an in-flight consumer validates once and refuses a result after its inputs change', async () => {
  const directory = scratch(), run = cache.createBuildCache(directory);
  let finish;
  const first = run('key', () => new Promise(resolve => { finish = resolve; }));
  let checks = 0, current = true;
  const second = run('key', () => 'changed result', { isCurrent: () => { checks++; return current; } });
  current = false;
  finish('first result');
  assert.deepEqual(await Promise.all([first, second]), ['first result', 'changed result']);
  assert.equal(checks, 1);
  assert.equal(await run('key', () => assert.fail('overwrote the original entry')), 'first result');
});

test('af5: a hit arriving while waiting for another process validates only at return', async () => {
  const directory = scratch(), other = scratch(), run = cache.createBuildCache(directory);
  await cache.createBuildCache(other)('key', () => 'old result');
  const lock = join(directory, 'key.bin.lock');
  writeFileSync(lock, String(process.pid));
  let checks = 0, current = true;
  const waiting = run('key', () => 'changed result', { isCurrent: () => { checks++; return current; } });
  assert.equal(checks, 0, 'no repeated identity walk while waiting');
  current = false;
  copyFileSync(join(other, 'key.bin'), join(directory, 'key.bin'));
  unlinkSync(lock);
  assert.equal(await waiting, 'changed result');
  assert.equal(checks, 1);
  assert.equal(await run('key', () => assert.fail('published the changed result')), 'old result');
});
