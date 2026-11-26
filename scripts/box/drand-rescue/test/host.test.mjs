import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fixture, root, read, ticket1 } from './model.mjs';

function unit(path) {
  const sections = {};
  let section;
  for (const raw of read(path).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { section = line.slice(1, -1); sections[section] = {}; }
    else {
      const at = line.indexOf('=');
      assert.ok(at > 0 && section, line);
      const name = line.slice(0, at);
      assert.equal(sections[section][name], undefined, `duplicate ${name}`);
      sections[section][name] = line.slice(at + 1);
    }
  }
  return sections;
}
test('#9/#11: the hourly timer replaces Actions and the service cannot write code or expose credentials', () => {
  const timer = unit('infra/rescue-host/squarehole-rescue.timer');
  assert.equal(timer.Timer.OnCalendar, '*:17');
  assert.equal(timer.Timer.Persistent, 'true');
  assert.equal(timer.Timer.RandomizedDelaySec, '0');
  assert.equal(timer.Timer.Unit, 'squarehole-rescue.service');
  assert.equal(timer.Install.WantedBy, 'timers.target');
  const service = unit('infra/rescue-host/squarehole-rescue.service').Service;
  for (const [key, value] of Object.entries({
    Type: 'oneshot', User: 'squarehole-rescue', Group: 'squarehole-rescue',
    NoNewPrivileges: 'true', ProtectSystem: 'strict', ProtectHome: 'true', PrivateTmp: 'true',
    UMask: '0077', EnvironmentFile: '/etc/squarehole-rescue/rescue.env',
    ReadOnlyPaths: '/opt/squarehole-rescue', TimeoutStartSec: '10min',
  })) assert.equal(service[key], value, key);
  assert.equal(service.ReadWritePaths, undefined, 'the poster needs no writable state');
  assert.equal(service.Restart, 'no');
  const text = read('infra/rescue-host/squarehole-rescue.service');
  assert.doesNotMatch(text, /https?:|Bearer |PRIVATE_KEY=|TOKEN=|RPC_URL=/);
  assert.equal(existsSync(new URL('.github/workflows/drand-rescue.yml', root)), false);
});
test('#9: setup is release-tag-only, verifies Node before extraction and leaves the timer disabled', () => {
  const setup = read('infra/rescue-host/setup.sh');
  const pack = read('infra/rescue-host/pack.mjs');
  assert.match(setup, /^NODE_VERSION=24\.22\.1$/m);
  assert.match(setup, /https:\/\/nodejs.org\/dist/);
  assert.ok(setup.indexOf('sha256sum --check') < setup.indexOf('tar -xJf'));
  for (const phrase of ['24.04', 'useradd --system', 'chmod -R a-w', '-m 0600', 'systemctl daemon-reload']) assert.ok(setup.includes(phrase), phrase);
  assert.doesNotMatch(setup, /systemctl (?:enable|start)/);
  assert.match(pack, /refs\/tags\//);
  assert.match(pack, /'archive'/);
  assert.doesNotMatch(pack, /fetch|https?:/);
  assert.doesNotMatch(setup, /git (?:clone|pull|fetch)|npm install|pnpm install/);
});
test('#9: the host scripts pass shellcheck if installed, otherwise bash syntax checking', () => {
  const dir = new URL('infra/rescue-host/', root);
  const files = readdirSync(dir).filter(f => f.endsWith('.sh')).map(f => new URL(f, dir).pathname);
  assert.ok(files.length > 0);
  const hasShellcheck = spawnSync('shellcheck', ['--version']).status === 0;
  for (const file of files) {
    const result = spawnSync(hasShellcheck ? 'shellcheck' : 'bash', hasShellcheck ? [file] : ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
const nodePins = {
  x64: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
  arm64: 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e',
};
test('#9 / F1: both Node archive pins are the integrator-supplied 64-hex literals', () => {
  const setup = read('infra/rescue-host/setup.sh');
  for (const [arch, expected] of Object.entries(nodePins)) {
    const pin = setup.match(new RegExp(`^NODE_SHA256_${arch.toUpperCase()}='([0-9a-f]{64})'$`, 'm'));
    assert.ok(pin, `${arch} requires a nonempty literal pin`);
    assert.equal(pin[1], expected);
  }
});
function nodeSelection(machine, after) {
  const setup = read('infra/rescue-host/setup.sh');
  const end = setup.indexOf('if [[ $EUID');
  assert.ok(end > 0, 'architecture selection precedes installation');
  return spawnSync('bash', ['-c', `uname() { printf '%s\\n' "$TEST_MACHINE"; }\n${setup.slice(0, end)}\n${after}`],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, TEST_MACHINE: machine } });
}
test('#9 / F1: uname selects the matching pinned archive for Intel/AMD and Arm and refuses other machines', () => {
  for (const [machine, arch] of [['x86_64', 'x64'], ['aarch64', 'arm64']]) {
    const result = nodeSelection(machine, 'printf "%s %s" "$NODE_ARCH" "$NODE_SHA256"');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${arch} ${nodePins[arch]}`);
  }
  const result = nodeSelection('riscv64', 'printf "installation reached"');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Unsupported architecture; installation refused\n');
  assert.equal(result.stdout, '');
});
test('#9 / F1: either architecture refuses a mismatched archive before extraction, without a network request', () => {
  const setup = read('infra/rescue-host/setup.sh');
  const start = setup.indexOf('archive=');
  const end = setup.indexOf('tar -xJf');
  assert.ok(start > 0 && end > start);
  const scratch = new URL('.cache/rescue-host/', root);
  mkdirSync(scratch, { recursive: true });
  for (const [machine, arch] of [['x86_64', 'x64'], ['aarch64', 'arm64']]) {
    const dir = mkdtempSync(new URL('checksum-', scratch).pathname);
    mkdirSync(`${dir}/download`);
    const quoted = `'${dir.replaceAll("'", "'\\''")}'`;
    // Execute the installer's actual selection/download/check, with curl replaced by local corrupt bytes.
    // Nothing invokes apt, extracts an archive, writes system paths or opens a listener.
    // shasum accepts the GNU check flags on macOS too; both paths perform the actual SHA-256 check.
    const result = nodeSelection(machine, `install_root=${quoted}
curl() { printf '%s\\n' "$@"; printf 'wrong archive' > "$archive"; }
sha256sum() { if command -v shasum >/dev/null; then shasum -a 256 "$@"; else command sha256sum "$@"; fi; }
${setup.slice(start, end)}
printf 'extraction reached'`);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '', 'the checksum rejects the archive without a shell or tool error');
    assert.ok(result.stdout.includes(`https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-${arch}.tar.xz`));
    assert.ok(!result.stdout.includes('extraction reached'));
  }
});
test('#9/#10: the host reads a private service-owned file and sends email using only configured credentials', async () => {
  const { runHost } = await import('../../../../infra/rescue-host/run.mjs');
  for (const mode of ['ok', 'permissions', 'owner', 'symlink', 'missing']) {
    const m = fixture();
    Object.assign(m.env, { DRAND_RESCUE_RPC_URL: m.env.RESCUE_RPC,
      DRAND_RESCUE_KEY_FILE: '/etc/squarehole-rescue/signing-material', DRAND_RESCUE_TICKETS: ticket1,
      DRAND_RESCUE_MAILER_URL: m.env.MAIL_URL, DRAND_RESCUE_MAILER_TOKEN: m.env.MAIL_TOKEN });
    m.io.uid = () => 123;
    m.io.lstat = async () => ({ mode: mode === 'permissions' ? 0o100644 : 0o100600,
      uid: mode === 'owner' ? 124 : 123, isFile: () => mode !== 'symlink' });
    m.io.readFile = async path => {
      assert.equal(path, m.env.DRAND_RESCUE_KEY_FILE);
      if (mode === 'missing') throw new Error(path + m.env.MAIL_TOKEN);
      return `${m.env.RESCUE_KEY}\n`;
    };
    assert.equal(await runHost(m.io), mode === 'ok' ? 0 : 1);
    assert.equal(m.sent.length, mode === 'ok' ? 2 : 0);
    assert.equal(m.mail.length, mode === 'ok' ? 1 : 0);
    if (mode !== 'ok') assert.equal(m.err, 'rescue host configuration unavailable\n');
    m.safe();
  }
});
test('#9: the release carries a working viem closure without any keeper code or dependencies on the checkout', async () => {
  const { copyDependencies } = await import('../../../../infra/rescue-host/pack.mjs');
  const scratch = new URL('.cache/rescue-host/', root);
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(new URL('package-', scratch).pathname);
  copyDependencies(new URL('packages/keeper/', root).pathname, `${dir}/node_modules`);
  const result = spawnSync(process.execPath, ['-e', "const v=require('viem'); const a=require('viem/accounts'); if(v.keccak256('0x') !== '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') process.exit(1); a.generatePrivateKey();"],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(`${dir}/packages`), false);
});
test('rc8.1 review: the host refuses a plaintext or non-URL RPC before reading the key or sending anything', async () => {
  // The RPC URL carries the provider key and every read the host signs on; the CLI keeps http for local chains,
  // the unattended host does not.
  const { runHost } = await import('../../../../infra/rescue-host/run.mjs');
  for (const rpc of ['http://rpc.invalid/x', 'ws://rpc.invalid/x', 'rpc.invalid', 'https://user:pass@rpc.invalid/x']) {
    const m = fixture();
    let read = false;
    Object.assign(m.env, { DRAND_RESCUE_RPC_URL: rpc,
      DRAND_RESCUE_KEY_FILE: '/etc/squarehole-rescue/signing-material', DRAND_RESCUE_TICKETS: ticket1,
      DRAND_RESCUE_MAILER_URL: m.env.MAIL_URL, DRAND_RESCUE_MAILER_TOKEN: m.env.MAIL_TOKEN });
    m.io.uid = () => 123;
    m.io.lstat = async () => { read = true; return { mode: 0o100600, uid: 123, isFile: () => true }; };
    m.io.readFile = async () => { read = true; return `${m.env.RESCUE_KEY}\n`; };
    assert.equal(await runHost(m.io), 1, rpc);
    assert.equal(read, false, rpc);
    assert.equal(m.sent.length, 0, rpc);
    assert.equal(m.err, 'rescue host configuration unavailable\n', rpc);
  }
});
test('rc8.1 review: the unit adds the kernel, clock, hostname, namespace, syscall-ABI and /proc protections', () => {
  const service = unit('infra/rescue-host/squarehole-rescue.service').Service;
  for (const [key, value] of Object.entries({
    ProtectKernelLogs: 'true', ProtectClock: 'true', ProtectHostname: 'true', RestrictNamespaces: 'true',
    SystemCallArchitectures: 'native', ProtectProc: 'invisible', PrivateDevices: 'true', CapabilityBoundingSet: '',
  })) assert.equal(service[key], value, key);
  // V8 compiles code at run time, so MemoryDenyWriteExecute would stop Node; it stays out on purpose.
  assert.equal(service.MemoryDenyWriteExecute, undefined);
});
