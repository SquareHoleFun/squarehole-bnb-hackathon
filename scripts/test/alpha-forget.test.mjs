import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, counts } from './fixtures/alpha-forget.mjs';

test('wrapper orders backup exclusion, plan, stops, confirmation, execute, check, prior starts and smoke', () => {
  const r = run(); assert.equal(r.status, 0, r.stderr);
  assert.match(wrapperSource, /read -rs confirmation/);
  const calls = r.calls;
  const position = text => { const at = calls.findIndex(c => c.includes(text)); assert.ok(at >= 0, text); return at; };
  const sequence = ['flock -n 9', 'squarehole-pg-backup.service', 'compose images --quiet alpha-sender', 'forget-tester.mjs', 'compose ps --status running --services',
    'show --property=ActiveState --value squarehole-pg-backup.timer', 'stop squarehole-pg-backup.timer',
    'compose stop --timeout 60 alpha-api alpha-sender', '{{.State.Running}}', '--execute', ' -e ', 'compose start alpha-api', 'compose exec -T alpha-api',
    'compose start alpha-sender', 'compose exec -T alpha-sender', 'start squarehole-pg-backup.timer'];
  assert.deepEqual(sequence.map(position), sequence.map(position).sort((a, b) => a - b));
  const containerCalls = calls.filter(c => c.startsWith('docker run ')); assert.equal(containerCalls.length, 3);
  for (const c of containerCalls) {
    for (const flag of ['--network none', '--read-only', '--user 0:2101 --group-add 2103', '--cap-drop ALL', '--cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER', '--security-opt no-new-privileges',
      'type=bind,src=/srv/squarehole/alpha,dst=/alpha', 'type=volume,src=sender-volume,dst=/sender,volume-nocopy', '--entrypoint node']) assert.ok(c.includes(flag), flag);
    assert.doesNotMatch(c, /--env-file|\/run\/.*config|\/etc\/squarehole/);
  }
  assert.ok(!(r.stdout + r.stderr).includes('private_tester'));
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)), counts);
  assert.ok(!existsSync(join(r.root, 'alpha-forget.restore')));
});

for (const running of ['', 'alpha-api', 'alpha-sender', 'alpha-api\nalpha-sender']) for (const timer of ['active', 'inactive']) {
  test(`wrapper restores only prior activity: ${running || 'none'}, timer ${timer}`, () => {
    const r = run({ running, timer }); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls.filter(c => c.startsWith('docker compose start ')), running.split('\n').filter(Boolean).map(s => `docker compose start ${s}`));
    assert.deepEqual(r.calls.filter(c => c.startsWith('docker compose exec -T ')).map(c => c.split(' ')[4]), running.split('\n').filter(Boolean));
    assert.equal(r.calls.includes('systemctl start squarehole-pg-backup.timer'), timer === 'active');
  });
}
for (const failure of ['lock', 'backup', 'backup-inspect', 'ps', 'timer-state', 'timer-stop', 'timer-running', 'backup-race', 'stop',
  'missing-container', 'still-running', 'inspect', 'volume', 'image', 'plan', 'execute', 'manifest', 'counts', 'restart', 'smoke', 'timer-restart']) {
  test(`wrapper refuses ${failure} and never restarts from an exit trap`, () => {
    const r = run({ failure }); assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /no automatic restart/);
    if (!['restart', 'smoke', 'timer-restart'].includes(failure)) assert.ok(!r.calls.some(c => c.includes('compose start ') || c.includes('systemctl start ')));
    if (['execute', 'manifest', 'counts'].includes(failure)) {
      assert.match(r.stderr, /services and timer stopped/); assert.match(r.stderr, /next: bash .\/alpha-forget.sh <x-id> <handle>/);
      assert.ok(existsSync(join(r.root, 'alpha-forget.restore')));
    }
  });
}
for (const input of ['', 'wrong_handle\n']) test(`wrapper refuses confirmation ${input ? 'mismatch' : 'EOF'} before execute`, () => {
  const r = run({ input }); assert.equal(r.status, 1); assert.match(r.stderr, /confirmation/);
  assert.ok(!r.calls.some(c => c.includes('--execute') || c.includes('compose start ')));
});
test('wrapper refuses bad selectors and malformed saved activity', () => {
  for (const args of [[], ['01', 'handle'], ['1', 'bad-handle'], ['1', 'handle', 'extra']]) {
    const r = run({ args }); assert.equal(r.status, 1); assert.deepEqual(r.calls, []);
  }
  const r = run({ saved: 'bad\n' }); assert.equal(r.status, 1); assert.match(r.stderr, /saved activity is invalid/);
  assert.ok(!r.calls.some(c => c.includes(' stop ')));
});
test('wrapper rerun retains the original active set after a failure', () => {
  const failed = run({ failure: 'execute', running: 'alpha-api', timer: 'active' });
  assert.equal(failed.status, 1);
  const r = run({ root: failed.root, running: '', timer: 'inactive' }); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter(c => c.startsWith('docker compose start ')), ['docker compose start alpha-api']);
  assert.ok(r.calls.includes('systemctl start squarehole-pg-backup.timer'));
});

for (const failure of ['restart', 'smoke', 'timer-restart']) test(`wrapper resumes restoration after ${failure} without a second deletion`, () => {
  const failed = run({ failure, running: 'alpha-api', timer: 'active' }); assert.equal(failed.status, 1);
  const r = run({ root: failed.root, running: '', timer: 'inactive' }); assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some(c => c.includes('--execute')), 'completed deletion must not be executed again');
  assert.deepEqual(r.calls.filter(c => c.startsWith('docker compose start ')), ['docker compose start alpha-api']);
});

// Bash DEBUG fires before every executable shell line, including multiline commands and loop bodies.
// Closing fi/done, comments, and lines inside the quoted Node program are not shell stop points.
const wrapperSource = readFileSync(process.env.SH_FORGET_WRAPPER ?? 'infra/server/alpha-forget.sh', 'utf8');
const wrapperLines = wrapperSource.split('\n');
const firstStop = wrapperLines.findIndex(line => line.trim() === 'systemctl stop squarehole-pg-backup.timer') + 1;
const lastLine = wrapperLines.findLastIndex(line => line.startsWith("printf '%s")) + 1;
const trace = run({ trace: true }); assert.equal(trace.status, 0, trace.stderr);
const stopLines = [...new Set(trace.trace)].filter(n => n >= firstStop && n <= lastLine).sort((a, b) => a - b);
assert.ok(stopLines.length >= 25, `missing wrapper boundaries: ${stopLines}`);
for (const stopLine of stopLines) test(`wrapper interruption before line ${stopLine} recovers in one rerun`, () => {
  const failed = run({ stopLine });
  assert.equal(failed.status, 137, failed.stderr);
  const r = run({ root: failed.root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(r.root, 'running'), 'utf8').trim(), 'alpha-api\nalpha-sender');
  assert.equal(readFileSync(join(r.root, 'timer'), 'utf8'), 'active');
  assert.ok(existsSync(join(r.root, 'gone-123456789')));
});
for (const running of ['', 'alpha-api', 'alpha-sender', 'alpha-api\nalpha-sender']) for (const timer of ['active', 'inactive']) {
  test(`wrapper completion interruption restores ${running || 'none'}, ${timer}`, () => {
    const stopLine = wrapperLines.findIndex(line => line === "phase='deletion complete; restoring prior services'") + 1;
    const failed = run({ stopLine, running, timer }); assert.equal(failed.status, 137, failed.stderr);
    const r = run({ root: failed.root }); assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(r.root, 'running'), 'utf8').trim(), running);
    assert.equal(readFileSync(join(r.root, 'timer'), 'utf8'), timer);
  });
}
test('wrapper completed operation never satisfies another selector', () => {
  const failed = run({ failure: 'restart' }); assert.equal(failed.status, 1);
  const other = run({ root: failed.root, args: ['987654321', 'other_tester'], input: 'other_tester\n' });
  assert.equal(other.status, 1, other.stdout);
  assert.match(other.stderr, /selector/);
  assert.ok(!other.calls.some(c => c.includes('compose start ')));
  assert.ok(!existsSync(join(other.root, 'gone-987654321')));
  const same = run({ root: failed.root }); assert.equal(same.status, 0, same.stderr);
  const next = run({ root: failed.root, args: ['987654321', 'other_tester'], input: 'other_tester\n' });
  assert.equal(next.status, 0, next.stderr);
  assert.ok(existsSync(join(next.root, 'gone-987654321')), 'new selector requires its own deletion');
});

test('wrapper refuses a completion receipt from another operation', () => {
  const failed = run({ failure: 'restart' }); assert.equal(failed.status, 1);
  const path = join(failed.root, 'alpha-forget.restore'), lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const receipt = JSON.parse(lines[5]); receipt.operation = '00000000-0000-4000-8000-000000000001';
  lines[5] = JSON.stringify(receipt); writeFileSync(path, lines.join('\n') + '\n');
  const r = run({ root: failed.root }); assert.equal(r.status, 1);
  assert.ok(!r.calls.some(c => c.includes('compose start ')));
  assert.match(r.stderr, /incomplete deletion or invalid counts/);
});

test('wrapper saved completion never bypasses an unfinished manifest', () => {
  const failed = run({ failure: 'restart' }); assert.equal(failed.status, 1);
  writeFileSync(join(failed.root, 'forget-tester.json'), 'unfinished fixture');
  const r = run({ root: failed.root }); assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.some(c => c.includes('--execute')), 'marker requires command recovery');
  assert.ok(!existsSync(join(r.root, 'forget-tester.json')));
  assert.ok(existsSync(join(r.root, 'gone-123456789')));
});

for (const running of ['', 'alpha-api', 'alpha-sender', 'alpha-api\nalpha-sender']) for (const timer of ['active', 'inactive']) {
  test(`wrapper absent target preserves ${running || 'none'}, ${timer} without any stops or starts`, () => {
    const initial = run({ running, timer }); assert.equal(initial.status, 0, initial.stderr);
    const r = run({ root: initial.root }); assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'alpha-forget: tester is absent; services unchanged');
    assert.ok(!r.calls.some(c => / (stop|start) /.test(c)));
    assert.ok(!r.calls.some(c => c.includes('--execute') || c.includes('compose ps --status running') || c.includes('pg-backup.timer')));
    assert.equal(readFileSync(join(r.root, 'running'), 'utf8').trim(), running);
    assert.equal(readFileSync(join(r.root, 'timer'), 'utf8'), timer);
    assert.ok(!existsSync(join(r.root, 'alpha-forget.restore')));
  });
}
test('wrapper plan failure leaves services and timer running without an activity record', () => {
  const r = run({ failure: 'plan' }); assert.equal(r.status, 1);
  assert.ok(!r.calls.some(c => / (stop|start) /.test(c)));
  assert.equal(readFileSync(join(r.root, 'running'), 'utf8'), 'alpha-api\nalpha-sender');
  assert.equal(readFileSync(join(r.root, 'timer'), 'utf8'), 'active');
  assert.ok(!existsSync(join(r.root, 'alpha-forget.restore')));
});
