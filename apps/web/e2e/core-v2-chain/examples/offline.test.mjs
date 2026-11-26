import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ROOT } from './support.mjs';

// These subprocesses own their node:test replay; inheriting the parent's context silently skips it.
const exec = (file, args, options) => promisify(execFile)(file, args, {
  ...options, env: { ...(options.env ?? process.env), NODE_TEST_CONTEXT: undefined },
});
const repo = fileURLToPath(ROOT);
const scratch = join(repo, '.cache/examples-e2e/cache-tests');
const runner = 'apps/web/e2e/core-v2-chain/examples/offline.mjs';

async function treeHash(directory) {
  const hash = createHash('sha256');
  async function visit(path, prefix = '') {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name);
      const stat = await lstat(file);
      hash.update(`${prefix}${name}\0`);
      if (stat.isSymbolicLink()) hash.update(`link:${await readlink(file)}\0`);
      else if (stat.isDirectory()) await visit(file, `${prefix}${name}/`);
      else hash.update(await readFile(file));
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

async function fixture(legacy) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'repo-'));
  const contracts = join(root, 'packages/contracts');
  const examples = join(root, 'apps/web/e2e/core-v2-chain/examples');
  const forge = join(root, '.cache/examples-e2e/forge');
  for (const path of [examples, forge, join(root, 'bin'), ...['src', 'test', 'script', 'lib', 'out', 'cache'].map(name => join(contracts, name))]) {
    await mkdir(path, { recursive: true });
  }
  await copyFile(join(repo, runner), join(root, runner));
  await copyFile(join(repo, 'packages/contracts/foundry.toml'), join(contracts, 'foundry.toml'));
  await writeFile(join(examples, 'support.mjs'), "export const ROOT = new URL('../../../../../', import.meta.url);\n");
  await writeFile(join(examples, 'prepare-hidden.mjs'), `
import { mkdirSync, writeFileSync } from 'node:fs';
const option = process.argv.indexOf('--directory');
const directory = option < 0 ? '.cache/hidden-art' : process.argv[option + 1];
mkdirSync(directory + '/small-kit', { recursive: true });
writeFileSync(directory + '/small-kit/private.json', '{"fixture":"private art"}');
if (process.env.STOP_PHASE === 'prepare') { console.error('fixture ready'); await new Promise(() => setInterval(() => {}, 1000)); }
if (process.env.FAIL_PREPARE === '1') throw new Error('fixture preparation failed');
const index = directory + '/lives-test.json';
writeFileSync(index, JSON.stringify({ 'small-kit': directory + '/small-kit' }));
console.log(index);
`);
  await writeFile(join(examples, 'replay.test.mjs'), "import { test } from 'node:test'; if (process.env.STOP_PHASE === 'replay') { console.error('fixture ready'); await new Promise(() => setInterval(() => {}, 1000)); } if (process.env.FAIL_REPLAY === '1') throw new Error('fixture replay failed'); test('replay transport stub', () => {});\n");
  for (const name of ['out', 'cache']) {
    await writeFile(join(contracts, name, 'owner.json'), '{"owner":"contracts"}\n');
    if (legacy) await symlink(`../../../packages/contracts/${name}`, join(forge, name));
  }
  // Simulate the writes Forge makes in its selected root, without compiling Solidity.
  await writeFile(join(root, 'bin/forge'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(process.argv[process.argv.indexOf('--root') + 1]);
writeFileSync(join(root, 'invocation.json'), JSON.stringify({ profile: process.env.FOUNDRY_PROFILE, hiddenIndex: process.env.SH_HIDDEN_KITS, args: process.argv }));
for (const name of ['out', 'cache']) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'owner.json'), '{"owner":"examples"}');
}
process.stdout.write('{}');
if (process.env.STOP_PHASE === 'forge') { console.error('fixture ready'); await new Promise(() => setInterval(() => {}, 1000)); }
if (process.env.FAIL_FORGE === '1') process.exitCode = 1;
`, { mode: 0o755 });
  return { root, contracts, forge };
}

for (const legacy of [false, true]) {
  test(`offline cache isolation: ${legacy ? 'existing shared symlinks' : 'fresh scratch root'}`, async () => {
    const { root, contracts, forge } = await fixture(legacy);
    const before = await Promise.all(['cache', 'out'].map(name => treeHash(join(contracts, name))));
    for (let attempt = 0; attempt < 2; attempt++) {
      await exec(process.execPath, [runner, '--json'], {
        cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      });
      const after = await Promise.all(['cache', 'out'].map(name => treeHash(join(contracts, name))));
      assert.deepEqual(after, before, 'offline must preserve the contracts cache and artifacts byte-for-byte');
      for (const name of ['cache', 'out']) {
        assert.ok((await lstat(join(forge, name))).isDirectory(), `${name} must be a scratch-owned directory`);
        assert.equal(await readFile(join(forge, name, 'owner.json'), 'utf8'), '{"owner":"examples"}');
      }
    }
    if (legacy) {
      const trash = join(root, '.cache/trash');
      const retained = [];
      for (const dir of await readdir(trash)) {
        for (const name of await readdir(join(trash, dir))) retained.push(await readlink(join(trash, dir, name)));
      }
      assert.deepEqual(retained.sort(), ['../../../packages/contracts/cache', '../../../packages/contracts/out']);
    }
  });
}

test('real offline Forge cache preservation and suite result', {
  skip: process.env.SH_EXAMPLES_REAL_FORGE !== '1', timeout: 1_860_000,
}, async t => {
  const cache = join(repo, 'packages/contracts/cache');
  const before = await treeHash(cache);
  let result;
  try {
    result = await exec(process.execPath, [runner, '--json'], { cwd: repo, timeout: 1_800_000, maxBuffer: 128 * 1024 * 1024 });
  } catch (error) { result = error; }
  finally {
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, 'real-forge.json'), result?.stdout ?? '');
    await writeFile(join(scratch, 'real-replay.log'), result?.stderr ?? '');
    const after = await treeHash(cache);
    await writeFile(join(scratch, 'real-cache-hashes.json'), JSON.stringify({ before, after }, null, 2) + '\n');
    await t.test('packages/contracts/cache is unchanged byte-for-byte', () => {
      assert.equal(after, before, 'the actual contracts cache changed during the real offline run');
    });
  }
  await t.test('offline contracts and replay succeed', () => {
    assert.equal(result instanceof Error, false, 'offline failed; see .cache/examples-e2e/cache-tests/real-forge.json and real-replay.log');
  });
});

test('Junkyard offline proof has isolated output and does not replay unrelated example traces', async () => {
  const { root, contracts } = await fixture(false);
  const before = await treeHash(contracts);
  await exec(process.execPath, [runner, '--junkyard', '--json'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` } });
  assert.equal(await treeHash(contracts), before);
  assert.equal(await readFile(join(root, '.cache/examples-e2e/junkyard-contracts.json'), 'utf8'), '{}');
  const config = await readFile(join(root, '.cache/examples-e2e/junkyard-forge/foundry.toml'), 'utf8');
  assert.match(config, /packages\/chain\/scripts\/solidity\/test/);
});

for (const hardfork of [[], ['--hardfork', 'amsterdam']]) {
  test(`Junkyard gets the whole-release gas profile (${hardfork.at(-1) ?? 'default EVM'})`, async () => {
    const { root } = await fixture(false);
    await exec(process.execPath, [runner, '--junkyard', '--json', ...hardfork], {
      cwd: root, env: { ...process.env, FOUNDRY_PROFILE: 'default', PATH: `${join(root, 'bin')}:${process.env.PATH}` },
    });
    const invocation = JSON.parse(await readFile(join(root, '.cache/examples-e2e/junkyard-forge/invocation.json'), 'utf8'));
    assert.equal(invocation.profile, 'sepolia-rehearsal');
    if (hardfork.length) assert.deepEqual(invocation.args.slice(-2), hardfork);
  });
}


test('hidden kit proof isolates results and runs both hidden lives without unrelated replay', async () => {
  const { root } = await fixture(false);
  await exec(process.execPath, [runner, '--hidden', '--json'], { cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` } });
  assert.equal(await readFile(join(root, '.cache/examples-e2e/hidden-contracts.json'), 'utf8'), '{}');
  const invocation = JSON.parse(await readFile(join(root, '.cache/examples-e2e/hidden-forge/invocation.json'), 'utf8'));
  assert.ok(invocation.args.includes('test_(frogKiln|paperCertificates)'));
  assert.match(invocation.hiddenIndex, /^\.cache\/hidden-art\/lives-[^/]+\/lives-test.json$/);
});

for (const failure of [null, 'FAIL_PREPARE', 'FAIL_FORGE', 'FAIL_REPLAY']) {
  for (const keep of [false, true]) {
    test(`offline owns and cleans small hidden kit on ${failure ?? 'success'}; keep=${keep}`, async () => {
      const { root, forge } = await fixture(false);
      const base = join(root, '.cache/hidden-art');
      await mkdir(join(base, 'preexisting'), { recursive: true });
      await writeFile(join(base, 'preexisting/owner.txt'), 'another run');
      const result = await exec(process.execPath, [runner, '--json', ...(keep ? ['--keep-hidden-art'] : [])], {
        cwd: root, env: { ...process.env, SH_HIDDEN_KITS: '', PATH: `${join(root, 'bin')}:${process.env.PATH}`, ...(failure ? { [failure]: '1' } : {}) },
      }).catch(error => error);
      assert.equal(result instanceof Error, failure !== null);
      const created = (await readdir(base)).filter(name => name !== 'preexisting');
      if (keep) {
        assert.equal(created.length, 1);
        assert.match(result.stderr, /Kept private hidden art: \.cache\/hidden-art\/lives-/);
        assert.equal(await readFile(join(base, created[0], 'small-kit/private.json'), 'utf8'), '{"fixture":"private art"}');
      } else assert.deepEqual(created, [], 'run-owned hidden art must not survive completion or failure');
      assert.equal(await readFile(join(base, 'preexisting/owner.txt'), 'utf8'), 'another run');
      if (failure !== 'FAIL_PREPARE') {
        const invocation = JSON.parse(await readFile(join(forge, 'invocation.json'), 'utf8'));
        assert.ok(!invocation.args.includes('--keep-hidden-art'), 'runner flag must not reach Forge');
      }
    });
  }
}

test('caller-supplied hidden index and art are never cleaned by offline', async () => {
  const { root } = await fixture(false);
  const base = join(root, '.cache/hidden-art');
  await mkdir(base, { recursive: true });
  const index = '.cache/hidden-art/external.json';
  await writeFile(join(root, index), '{"caller":"owns these files"}');
  await exec(process.execPath, [runner, '--hidden'], { cwd: root,
    env: { ...process.env, SH_HIDDEN_KITS: index, PATH: `${join(root, 'bin')}:${process.env.PATH}` } });
  assert.deepEqual(await readdir(base), ['external.json']);
});

for (const phase of ['prepare', 'forge', 'replay']) {
  test(`offline cleans its generated art after SIGTERM during ${phase}`, { timeout: 10000 }, async () => {
    const { root } = await fixture(false);
    const child = spawn(process.execPath, [runner, '--json'], { cwd: root,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, SH_HIDDEN_KITS: '', STOP_PHASE: phase, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', signalled = false;
    child.stderr.on('data', chunk => {
      output += chunk;
      if (!signalled && output.includes('fixture ready')) { signalled = true; child.kill('SIGTERM'); }
    });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 1, output);
    assert.deepEqual(await readdir(join(root, '.cache/hidden-art')), []);
  });
}
