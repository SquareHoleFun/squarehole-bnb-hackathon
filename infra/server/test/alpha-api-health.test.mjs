import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');

const compose = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))', 'infra/server/compose.yaml'], { encoding: 'utf8' }));
const service = compose.services['alpha-api'];
const dockerfile = readFileSync('infra/server/services/alpha/Dockerfile', 'utf8').replaceAll(/\\\n\s*/g, ' ');
const probeCommand = JSON.parse(dockerfile.match(/^HEALTHCHECK .*? CMD (\[.*\])$/m)?.[1] ?? 'null');

test('alpha health probe uses the Dockerfile command under the restricted Compose root identity', () => {
  assert.equal(service.user, '0:0');
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.deepEqual(service.cap_add, ['SETUID', 'SETGID']);
  assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
  assert.equal(service.build.dockerfile, 'infra/server/services/alpha/Dockerfile');
  assert.equal(service.healthcheck, undefined);
  assert.equal(service.entrypoint, undefined);
  assert.equal(service.command, undefined);
  assert.deepEqual(probeCommand, ['node', 'infra/server/services/alpha-api.mjs', '--healthcheck']);
});

for (const enabled of [false, true]) {
  test(`alpha ${enabled ? 'enabled' : 'disabled'} probe drops to the 0600 heartbeat owner without reading the HMAC`, () => {
    const result = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings=ExperimentalWarning',
      'infra/server/test/fixtures/alpha/health-runtime.mjs', enabled ? '1' : '0', service.user, JSON.stringify(probeCommand.slice(2))], { encoding: 'utf8' }));
    assert.equal(result.startup.exitCode, 0, result.startup.stderr);
    assert.deepEqual(result.heartbeat, { uid: 2101, gid: 2101, mode: 0o600 });
    assert.equal(result.startup.keyReads, enabled ? 1 : 0);
    assert.equal(result.startup.apiCalls, enabled ? 1 : 0);
    assert.equal(result.startup.listeners, enabled ? 1 : 0);
    assert.equal(result.probe.exitCode, 0, `probe failed: ${result.probe.readError ?? result.probe.stderr}`);
    assert.deepEqual(result.probe.events, [['setgroups', [2103]], ['setgid', 2101], ['setuid', 2101], ['read', 2101, 2101, [2103]]]);
    assert.equal(result.probe.keyReads, 0);
    assert.equal(result.probe.apiCalls, 0);
    assert.equal(result.probe.listeners, 0);
    assert.equal(result.probe.stdout, `alpha-api: ${enabled ? 'ready' : 'disabled'}\n`);
    assert.equal(result.probe.stderr, '');
  });
}

for (const enabled of [false, true]) {
  for (const expected of ['disabled', 'ready', 'live', 'typo']) {
    test(`API health expected ${expected} with enabled=${enabled}`, () => {
      const result = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings=ExperimentalWarning',
        'infra/server/test/fixtures/alpha/health-runtime.mjs', enabled ? '1' : '0', service.user,
        JSON.stringify(['--healthcheck', expected])], { encoding: 'utf8' }));
      assert.equal(result.probe.exitCode, expected === (enabled ? 'ready' : 'disabled') ? 0 : 1);
      assert.equal(result.probe.keyReads, 0);
    });
  }
}
