import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUILDER_SOURCE_ROOTS, BUILDER_WORKSPACES, createBuildCache, createLoadedSourceGuard, dependencyKey, hashFiles, inputKey, kitInputKey, sourceKey, writeCacheAsset } from '../kits/cache.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'kit-cache-'));
const realEncoder = { skip: process.platform !== 'linux' && 'Kit reuse requires Linux native-library identity' };

// These are source-only exclusions. Asset folders and fixture-named runtime modules still count.
for (const [kind, paths] of [
  ['test modules', BUILDER_SOURCE_ROOTS.flatMap(root => ['case.test.ts', 'case.test.tsx', 'case.test.mjs', 'case.spec.js'].map(name => `${root}/${name}`))],
  ['test support', BUILDER_SOURCE_ROOTS.filter(root => root.endsWith('/src')).flatMap(root => [`${root}/test-support/fixture.json`, `${root}/nested/test-support.ts`])],
  ['BoxSpec test fixtures', ['packages/box-spec/src/m1-11/fixtures/add-ons.v2.fixture.json']],
  ['kit tooling README', ['scripts/kits/README.md']],
]) test(`af3: adding, editing or removing ${kind} preserves a warm cache`, async () => {
  const root = scratch(), cache = createBuildCache(join(root, 'cache'));
  for (const path of BUILDER_SOURCE_ROOTS) mkdirSync(join(root, path), { recursive: true });
  const key = sourceKey(root);
  await cache(key, () => 'built once');
  for (const path of paths) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    for (const bytes of ['first', 'edited']) {
      writeFileSync(file, bytes);
      assert.equal(sourceKey(root), key, path);
      assert.equal(await cache(sourceKey(root), () => assert.fail(`rebuilt after ${path}`)), 'built once');
    }
    renameSync(file, join(root, 'removed-test'));
    assert.equal(sourceKey(root), key, path);
  }
});

test('af3: runtime fixtures, test collections, registry JSON and example documents remain inputs', () => {
  const root = scratch();
  for (const path of [
    'packages/domain/src/accounts-fixture.ts', 'packages/box-spec/src/generated/fixtures.v1.ts',
    'examples/boxes/junkyard/test-collections/catalog.json', 'examples/boxes/bag-holders/unique/manifest.json',
    'packages/box-spec/examples/v2/example.test.json', 'examples/boxes/rent-free/README.md',
  ]) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'before');
    const before = sourceKey(root);
    writeFileSync(file, 'after');
    assert.notEqual(sourceKey(root), before, path);
  }
});

test('af3: settings and every unique producer import no excluded test or fixture module', () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { fileURLToPath } from 'node:url';
    import { relative } from 'node:path';
    import { ROOT, isBuilderNonInput } from './scripts/kits/cache.mjs';
    const loaded = new Set();
    registerHooks({ load(url, context, next) {
      if (url.startsWith('file:')) {
        const path = relative(ROOT, fileURLToPath(url));
        assert.equal(isBuilderNonInput(path), false, path);
        loaded.add(path);
      }
      return next(url, context);
    }});
    await import('./scripts/kits/settings.mjs');
    for (const id of ['rent-free', 'bag-holders', 'link-marines-v2', 'exit-liquidity']) {
      await import('./examples/boxes/' + id + '/unique/build.mjs');
    }
    assert.ok(loaded.has('apps/web/src/features/create/v2/model.ts'));
    assert.ok(loaded.has('examples/boxes/bag-holders/unique/model.mjs'));
  `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
});

test('generated source assets survive scratch deletion and corrupted files are replaced completely', () => {
  const directory = scratch(), path = join(directory, 'asset.png'), bytes = Buffer.from('complete bytes');
  writeCacheAsset(path, bytes);
  assert.deepEqual(readFileSync(path), bytes);
  writeFileSync(path, 'partial');
  writeCacheAsset(path, bytes);
  writeCacheAsset(path, bytes);
  assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(readdirSync(directory), ['asset.png']);
});
test('content keys see changed bytes, added/removed inputs and tool settings', () => {
  const root = scratch();
  writeFileSync(join(root, 'source'), 'first');
  const key = hashFiles(root, ['source'], 'tool-v1');
  writeFileSync(join(root, 'source'), 'other');
  assert.notEqual(hashFiles(root, ['source'], 'tool-v1'), key);
  assert.notEqual(hashFiles(root, ['source'], 'tool-v2'), hashFiles(root, ['source'], 'tool-v1'));
  assert.notEqual(hashFiles(root, ['source', 'new-input']), hashFiles(root, ['source']));
});
test('shared cache preserves bigint and bytes across processes and isolates mutations', async () => {
  const directory = scratch(), cache = createBuildCache(directory);
  const value = { amount: 42n, bytes: Buffer.from('exact'), nested: { a: 1 } };
  const first = await cache('key', async () => value);
  first.nested.a = 2;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createBuildCache } from ${JSON.stringify(new URL('../kits/cache.mjs', import.meta.url).href)};
    const value = await createBuildCache(${JSON.stringify(directory)})('key', () => { throw Error('rebuilt'); });
    const { writeFileSync, renameSync, statSync, utimesSync } = await import('node:fs');
    writeFileSync(${JSON.stringify(join(directory, 'result'))}, [value.amount.toString(), value.bytes.toString(), value.nested.a].join(' '));
  `], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(readFileSync(join(directory, 'result'), 'utf8'), '42 exact 1');
});
test('concurrent calls build once; fresh and disabled calls really rebuild', async () => {
  const cache = createBuildCache(scratch()); let calls = 0;
  const build = async () => { calls++; return { calls }; };
  assert.deepEqual(await Promise.all([cache('key', build), cache('key', build)]), [{ calls: 1 }, { calls: 1 }]);
  await cache('key', build, { fresh: true });
  await cache('key', build, { fresh: true });
  await cache('key', build, { disabled: true });
  await cache('key', build, { disabled: true });
  assert.equal(calls, 5);
});
test('failures never reach disk or suppress later normal, fresh or disabled builds', async () => {
  const directory = scratch(), cache = createBuildCache(directory); let calls = 0;
  const fail = async () => { calls++; throw Error('broken encoder'); };
  for (const options of [{}, {}, { fresh: true }, { disabled: true }]) await assert.rejects(cache('bad', fail, options), /broken encoder/);
  assert.equal(calls, 4);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(await cache('bad', async () => 'fixed'), 'fixed');
  for (const options of [{ fresh: true }, { disabled: true }]) await assert.rejects(cache('bad', fail, options), /broken encoder/);
  assert.equal(await cache('bad', async () => 'wrong'), 'fixed');
});
test('truncated or changed cache bytes rebuild instead of trusting a partial write', async () => {
  const directory = scratch();
  await createBuildCache(directory)('key', async () => 'good');
  const path = join(directory, 'key.bin');
  const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
  assert.equal(await createBuildCache(directory)('key', async () => 'rebuilt'), 'rebuilt');
});

test('installed package code, native binaries and transitive dependencies participate in the key', () => {
  const root = scratch(), child = join(root, 'node_modules', 'cache-test-dependency');
  mkdirSync(child, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cache-test-root', dependencies: { 'cache-test-dependency': '1' } }));
  writeFileSync(join(child, 'package.json'), JSON.stringify({ name: 'cache-test-dependency', version: '1' }));
  writeFileSync(join(child, 'native.node'), 'one');
  const before = dependencyKey([join(root, 'package.json')]);
  writeFileSync(join(child, 'native.node'), 'two');
  assert.notEqual(dependencyKey([join(root, 'package.json')]), before);
});

for (const [name, change] of [
  ['platform', { platform: 'darwin' }], ['CPU architecture', { arch: 'arm64' }],
  ['Node version', { versions: { node: '24.22.2', v8: 'same' } }], ['libc version', { libc: '2.42' }],
  ['cwebp version', { cwebp: ['1.7.0', '', 'same-executable'] }],
  ['cwebp executable bytes', { cwebp: ['1.6.0', '', 'replaced-executable'] }],
  ['encoder timeout', { encoderTimeout: '1' }],
]) test(`cache identity includes ${name}`, () => {
  const base = { source: 'source', dependencies: 'deps', platform: 'linux', arch: 'x64',
    versions: { node: '24.22.1', v8: 'same' }, libc: '2.41', cwebp: ['1.6.0', '', 'same-executable'], encoderTimeout: null };
  assert.notEqual(inputKey({ ...base, ...change }), inputKey(base));
});

test('every builder source root, workspace manifest, lockfile and cross-kit asset invalidates the key', () => {
  const root = scratch();
  const inputs = [...BUILDER_SOURCE_ROOTS.map(path => `${path}/input.dat`),
    ...BUILDER_WORKSPACES.map(path => `${path}/package.json`), 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'package.json', 'tsconfig.json', 'mise.toml', '.mise.toml',
    'examples/boxes/bag-holders/unique/model.mjs', 'examples/boxes/rent-free/models/lib/glb.mjs',
    'examples/boxes/bag-holders/unique/manifest.json', 'examples/boxes/bag-holders/unique/traits.json',
    'examples/boxes/bag-holders/art/items/variant-09.svg', 'examples/boxes/junkyard/test-collections/catalog.json',
    'examples/boxes/dragons-hoard/art/logo.png', 'examples/boxes/frog-kiln/plan.csv',
    'examples/boxes/frog-kiln/art/hidden.svg', 'examples/boxes/link-marines/assignment.json'];
  for (const path of inputs) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), 'first'); }
  for (const path of inputs) {
    const before = sourceKey(root), file = join(root, path), stat = statSync(file);
    writeFileSync(file, 'other'); utimesSync(file, stat.atime, stat.mtime);
    assert.notEqual(sourceKey(root), before, `${path}: same size and restored mtime`);
    writeFileSync(file, 'first');
  }
  const before = sourceKey(root);
  writeFileSync(join(root, 'examples/boxes/new-input'), 'added even without git');
  assert.notEqual(sourceKey(root), before);
  renameSync(join(root, 'examples/boxes/new-input'), join(root, 'retained-input'));
  assert.equal(sourceKey(root), before);
  renameSync(join(root, inputs[0]), join(root, 'removed-input'));
  assert.notEqual(sourceKey(root), before);
});

test('warm cache cannot turn corrupt/missing source into success, or retain a repaired failure', async () => {
  const root = scratch(), path = join(root, 'input'), cache = createBuildCache(join(root, 'cache'));
  writeFileSync(path, 'valid');
  let calls = 0;
  const build = () => { calls++; assert.equal(readFileSync(path, 'utf8'), 'valid'); return 'accepted'; };
  const run = () => cache(hashFiles(root, ['input']), build);
  assert.equal(await run(), 'accepted');
  writeFileSync(path, 'wrong');
  await assert.rejects(run());
  renameSync(path, join(root, 'retained'));
  await assert.rejects(run(), /ENOENT/);
  writeFileSync(path, 'valid');
  assert.equal(await run(), 'accepted');
  assert.equal(calls, 3);
});

test('cwebp availability and version are rechecked after a warm key in the same process', realEncoder, () => {
  const path = process.env.PATH, root = scratch();
  // Native fixtures have an identifiable library closure. Script wrappers now refuse reuse.
  // echo/true supply different successful version-probe outputs without encoding any kit.
  copyFileSync('/usr/bin/echo', join(root, 'cwebp'));
  try {
    process.env.PATH = root;
    const first = kitInputKey(); assert.match(first, /^[a-f0-9]{64}$/);
    writeFileSync(join(root, 'cwebp'), Buffer.concat([readFileSync('/usr/bin/echo'), Buffer.from('changed bytes, same output')]));
    assert.notEqual(kitInputKey(), first, 'executable bytes matter even when the version stays the same');
    copyFileSync('/usr/bin/true', join(root, 'cwebp'));
    assert.notEqual(kitInputKey(), first);
    process.env.PATH = scratch();
    assert.equal(kitInputKey(), null);
    process.env.PATH = root;
    assert.notEqual(kitInputKey(), null);
  } finally { process.env.PATH = path; }
});

test('settings and T07 consumers share a key regardless of unrelated imported dependencies', realEncoder, () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const key = imports => {
    const output = join(scratch(), 'key');
    execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', `
      ${imports}
      const { kitInputKey } = await import('./scripts/kits/cache.mjs');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(${JSON.stringify(output)}, kitInputKey());
    `], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const value = readFileSync(output, 'utf8');
    assert.match(value, /^[a-f0-9]{64}$/);
    return value;
  };
  const first = key("await import('./scripts/kits/settings.mjs');");
  assert.equal(key("await import('./scripts/kits/reveal-fixtures.mjs'); await import('typescript');"), first);
});


test('source or dependency changes disable reuse and writes even after restoration, because Node retains loaded modules', () => {
  for (const changed of [['edited source', 'packages'], ['source', 'edited packages']]) {
    const guard = createLoadedSourceGuard();
    assert.equal(guard('source', 'packages'), true);
    assert.equal(guard('source', 'packages'), true);
    assert.equal(guard(...changed), false);
    assert.equal(guard('source', 'packages'), false, 'restoring files cannot unload code imported while edited');
  }
});
