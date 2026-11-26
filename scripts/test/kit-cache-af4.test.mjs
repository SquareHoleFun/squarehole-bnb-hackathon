import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as cache from '../kits/cache.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'cache-af4-'));
const write = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };

test('af4: kit-local renderer code and native dependencies participate in identity', () => {
  const root = scratch();
  for (const [workspace, name] of [['packages/cards', '@resvg/resvg-js'], ['packages/chain', 'viem'], ['packages/box-spec', 'zod'], ['packages/artwork', '@noble/hashes'], ['packages/artwork', 'shamir-secret-sharing']]) {
    write(root, `${workspace}/node_modules/${name}/package.json`, JSON.stringify({ name }));
  }
  const key = () => cache.dependencyKey(cache.builderDependencies(root));
  const original = key();
  for (const kit of ['bag-holders', 'link-marines-v2']) {
    const local = `examples/boxes/${kit}/node_modules/@resvg/resvg-js`;
    write(root, `${local}/package.json`, JSON.stringify({ name: '@resvg/resvg-js', optionalDependencies: { 'resvg-native': '1' } }));
    write(root, `${local}/index.js`, 'renderer one');
    write(root, `${local}/node_modules/resvg-native/package.json`, '{"name":"resvg-native"}');
    write(root, `${local}/node_modules/resvg-native/renderer.node`, 'native one');
    const installed = key();
    assert.notEqual(installed, original, kit);
    write(root, `${local}/index.js`, 'renderer two');
    assert.notEqual(key(), installed, kit);
    const changed = key();
    write(root, `${local}/node_modules/resvg-native/renderer.node`, 'native two');
    assert.notEqual(key(), changed, kit);
  }
  // Node also resolves a package's legacy index.js without a manifest. Its dependency
  // closure cannot be established, so it must not silently fall through to cards identity.
  write(root, 'examples/boxes/rent-free/node_modules/@resvg/resvg-js/index.js', 'exports.Resvg = class {};');
  const unknown = cache.createKitInputKey({ root, dependencies: key, encoder: () => ['encoder'], env: {}, execArgv: [] });
  assert.equal(unknown(), null);
});

test('af4: startup imports, requires, loaders and native overrides refuse cache reuse', () => {
  assert.equal(typeof cache.hasToolOverrides, 'function');
  for (const options of ['--import=adapter.mjs', '--require adapter.cjs', '-r adapter.cjs', '--loader=loader.mjs', '--conditions=custom']) {
    assert.equal(cache.hasToolOverrides({ NODE_OPTIONS: options }, []), true, options);
  }
  for (const args of [['--import', 'adapter.mjs'], ['--require=adapter.cjs'], ['-radapter.cjs'], ['--experimental-loader', 'loader.mjs'], ['--conditions=custom'], ['--preserve-symlinks'], ['--experimental-config-file=config.json'], ['--experimental-default-config-file'], ['--env-file=options']]) {
    assert.equal(cache.hasToolOverrides({}, args), true, args.join(' '));
  }
  for (const name of ['NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES']) assert.equal(cache.hasToolOverrides({ [name]: '/override' }, []), true, name);
  assert.equal(cache.hasToolOverrides({}, ['--no-warnings=ExperimentalWarning']), false);
  const key = cache.createKitInputKey({ root: scratch(), dependencies: () => 'deps', encoder: () => ['encoder'], env: { NODE_OPTIONS: '--import=adapter.mjs' }, execArgv: [] });
  assert.equal(key(), null);
});

// The injected Linux inspector makes these native-library assertions independent of the host OS.
test('af4: native library bytes affect identity and unidentified libraries refuse reuse', () => {
  assert.equal(typeof cache.nativeLibraryKey, 'function');
  const root = scratch(), executable = join(root, 'cwebp'), library = join(root, 'libwebp.so'), loader = join(root, 'ld.so');
  writeFileSync(executable, Buffer.from('\x7fELFfixture'));
  writeFileSync(library, 'library one'); writeFileSync(loader, 'loader one');
  const inspect = () => ({ status: 0, stdout: `linux-vdso.so.1 (0x123)\nlibwebp.so => ${library} (0x123)\n${loader} (0x123)\n` });
  const key = () => cache.nativeLibraryKey(executable, { platform: 'linux', inspect });
  const original = key(); assert.match(original, /^[a-f0-9]{64}$/);
  writeFileSync(library, 'library two'); assert.notEqual(key(), original);
  const changed = key(); writeFileSync(loader, 'loader two'); assert.notEqual(key(), changed);
  for (const stdout of ['libwebp.so => not found', 'unknown library output', '', `lib.so => ${root}/missing (0x123)`]) {
    assert.equal(cache.nativeLibraryKey(executable, { platform: 'linux', inspect: () => ({ status: 0, stdout }) }), null, stdout);
  }
  writeFileSync(executable, '#!/bin/sh\nprintf "1.6.0\\n"\n');
  assert.equal(key(), null, 'script wrappers have an unidentified runtime closure');
});

// A fixture encoder keeps the source-edit/publication regressions active on every platform.
function sourceFixture() {
  const root = scratch(), file = 'scripts/kits/builder.mjs';
  write(root, file, "export const build = () => 'builder A';");
  assert.equal(typeof cache.createKitInputKey, 'function');
  const key = cache.createKitInputKey({ root, dependencies: () => 'deps', encoder: () => ['encoder'], env: {}, execArgv: [] });
  return { root, file, key };
}

test('af4: source baseline precedes builder imports and the first cache lookup', async () => {
  const { root, file, key } = sourceFixture();
  const { build } = await import(pathToFileURL(join(root, file)));
  write(root, file, "export const build = () => { throw Error('builder B'); };");
  assert.equal(build(), 'builder A');
  assert.equal(key(), null, 'loaded A must never be stored under B');
  const settings = readFileSync(new URL('../kits/settings.mjs', import.meta.url), 'utf8');
  for (const module of ['./app.mjs', './pictures.mjs', './catalog.mjs', './unique.mjs', '../../packages/box-spec/examples/v2/registry.mjs']) {
    assert.ok(settings.includes(`await import('${module}')`), `${module} loads only after the cache baseline`);
    assert.ok(!settings.includes(`from '${module}'`), `${module} must not load as a static dependency`);
  }
});

for (const restore of [false, true]) test(`af4: edits during a build prevent publication${restore ? ', even when bytes are restored' : ''}`, async () => {
  const { root, file, key } = sourceFixture(), directory = join(root, 'cache'), before = key();
  assert.match(before, /^[a-f0-9]{64}$/);
  const original = readFileSync(join(root, file));
  const run = cache.createBuildCache(directory);
  assert.equal(await run(before, async () => {
    write(root, file, "throw Error('edited during build');");
    if (restore) write(root, file, original);
    return 'built A';
  }, { isCurrent: () => key() === before }), 'built A');
  assert.deepEqual(readdirSync(directory), [], 'no entry for a build with changing inputs');
  assert.equal(key(), null, 'the process stays ineligible after an edit');
});

test('af4: a source change while waiting for a cache hit cannot reuse it', async () => {
  const directory = scratch(), run = cache.createBuildCache(directory);
  await run('key', () => 'old result');
  assert.equal(await run('key', () => 'current result', { isCurrent: () => false }), 'current result');
});
