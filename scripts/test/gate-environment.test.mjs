import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function probe(command, values) {
  const root = mkdtempSync(join(tmpdir(), 'gate-environment-')), log = join(root, 'calls');
  const spy = join(root, 'spy.mjs');
  writeFileSync(spy, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),capacity:process.env.SH_TEST_CAPACITY})+'\\n');`);
  mkdirSync(join(root, 'bin'));
  for (const name of ['pnpm', 'vitest']) writeFileSync(join(root, 'bin', name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(spy)} "$@"\n`, { mode: 0o755 });
  // Exercise the real shell syntax, but replace every test runner with an argument recorder.
  const safe = command.split(' && ').map(step => step.startsWith('node --') ? step.replace(/^node /, `node ${quote(spy)} `) : step).join(' && ');
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ...values };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(values)) if (values[key] === undefined) Reflect.deleteProperty(env, key);
  // Regular output files also work on hosts that cannot pipe child Node diagnostics.
  const stdout = openSync(join(root, 'stdout'), 'w'), stderr = openSync(join(root, 'stderr'), 'w');
  let result;
  try { result = spawnSync('/bin/sh', ['-c', safe], { env, stdio: ['ignore', stdout, stderr] }); }
  finally { closeSync(stdout); closeSync(stderr); }
  assert.ifError(result.error);
  let calls = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...result, calls, stderr: readFileSync(join(root, 'stderr'), 'utf8') };
}

test('af4: malformed worker counts stop before any test runner starts', () => {
  for (const workers of ['0', '65', '-1', '+1', '1.5', 'NaN', 'Infinity', ' 1', '1 ', '1\n', '1e1', '1 --test-name-pattern=^$', '1; true', '99999999999999999999999']) {
    const result = probe(scripts['test:scripts'], { SH_SCRIPTS_WORKERS: workers });
    assert.notEqual(result.status, 0, workers);
    assert.match(result.stderr, /SH_SCRIPTS_WORKERS.*whole number.*1.*64/, workers);
    assert.deepEqual(result.calls, [], workers);
  }
});

test('af4: valid workers form one argument; empty and unset retain Node defaults', () => {
  for (const workers of [undefined, '', '1', '2', '64']) {
    const result = probe(scripts['test:scripts'], { SH_SCRIPTS_WORKERS: workers });
    assert.equal(result.status, 0, result.stderr);
    const node = result.calls.find(call => call.args[0] === '--test');
    assert.ok(node);
    assert.deepEqual(node.args.filter(arg => arg.startsWith('--test-concurrency')), workers ? [`--test-concurrency=${workers}`] : []);
    assert.ok(!node.args.includes(''), 'no extra empty argument');
  }
});

test('af4: verify ignores inherited capacity selection and still runs both size lanes', () => {
  for (const capacity of [undefined, '', '0', '1', 'anything']) {
    const result = probe(scripts.verify, { SH_TEST_CAPACITY: capacity });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.find(call => call.args[0] === 'test').capacity, '0');
    assert.equal(result.calls.filter(call => call.args[0] === 'test:capacity').length, 1);
    const large = probe(scripts['test:capacity'], { SH_TEST_CAPACITY: '0' });
    assert.equal(large.status, 0, large.stderr);
    assert.equal(large.calls[0].capacity, '1');
    for (const path of ['packages/keeper/test/capacity.test.ts', 'packages/indexer/test/core/rpc-load.test.ts']) assert.ok(large.calls[0].args.includes(path));
  }
});
