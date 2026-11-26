import assert from 'node:assert/strict';
import { constants, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { need, privyVerifier } from '../../../services/alpha/auth.mjs';

// Execute the real runtime with isolated process/filesystem doubles. Model Linux DAC
// without root read overrides, matching Compose's SETUID/SETGID-only capabilities.
const enabled = process.argv[2] === '1', user = process.argv[3], probeArgs = JSON.parse(process.argv[4]);
// Optional: a verification-key value. Startup then builds the real Privy verifier from it, as createAlphaApi does
// first; without it the API double never reads the key, as before.
const privyKey = process.argv[5];
const source = readFileSync(new URL('../../../services/alpha/server.mjs', import.meta.url), 'utf8');
const files = new Map(), healthPath = '/tmp/alpha-health.json';
async function launch(args) {
  let [uid, gid] = user.split(':').map(Number), groups = [], mask = 0o022;
  const result = { stdout: '', stderr: '', keyReads: 0, apiCalls: 0, listeners: 0, events: [] };
  const runtime = {
    argv: ['node', 'infra/server/services/alpha-api.mjs', ...args],
    env: { SH_ALPHA_ENABLED: enabled ? '1' : '0', SH_ALPHA_ORIGIN: 'https://test-app.example.org',
      SH_ALPHA_PRIVY_APP_ID: 'fixture-app', SH_ALPHA_PRIVY_VERIFICATION_KEY: privyKey ?? 'fixture-public-key',
      SH_ALPHA_COOKIE_KEY_FILE: '/run/alpha-config/cookie.key', SH_ALPHA_ACCESS_TEAM: 'https://fixture.cloudflareaccess.com',
      SH_ALPHA_ACCESS_AUD: 'fixture-desk' },
    getuid: () => uid,
    setgroups(value) { assert.equal(uid, 0); groups = [...value]; result.events.push(['setgroups', groups]); },
    setgid(value) { assert.equal(uid, 0); gid = value; result.events.push(['setgid', gid]); },
    setuid(value) { assert.equal(uid, 0); uid = value; result.events.push(['setuid', uid]); },
    umask(value) { mask = value; }, once() {},
    stdout: { write(value) { result.stdout += value; } },
    stderr: { write(value) { result.stderr += value; } },
  };
  const fs = {
    constants,
    openSync(path) {
      result.keyReads++;
      assert.equal(path, '/run/alpha-config/cookie.key'); assert.equal(uid, 0);
      assert.equal(args.length, 0, 'healthcheck must never load the HMAC');
      return 42;
    },
    fstatSync: () => ({ uid: 0, mode: 0o100600, size: 64, isFile: () => true }), closeSync() {},
    readFileSync(path) {
      if (path === 42) return '07'.repeat(32);
      const file = files.get(path); assert.ok(file, 'startup must publish the heartbeat before probing');
      result.events.push(['read', uid, gid, groups]);
      const readBit = uid === file.uid ? 0o400 : (gid === file.gid || groups.includes(file.gid)) ? 0o040 : 0o004;
      if (!(file.mode & readBit)) { result.readError = 'EACCES'; throw new Error('EACCES'); }
      return file.body;
    },
    writeFileSync(path, body, { mode }) { files.set(path, { body, uid, gid, mode: mode & ~mask }); },
    renameSync(from, to) { assert.ok(files.has(from)); files.set(to, files.get(from)); },
  };
  const server = { once() {}, listen(_port, _host, ready) { result.listeners++; ready(); }, setTimeout() {}, close() {} };
  const context = createContext({ process: runtime, Buffer, URL, setInterval: () => 1, clearInterval() {} });
  const modules = { 'node:fs': fs, 'node:http': { createServer: () => server }, 'node:stream': { Readable }, './auth.mjs': { need } };
  const entry = new SourceTextModule(source, { context });
  await entry.link(specifier => {
    const exports = modules[specifier]; assert.ok(exports, `unexpected import: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await entry.evaluate();
  await entry.namespace.start(config => {
    result.apiCalls++; if (privyKey !== undefined) privyVerifier(config.privyPublicKey, config.privyAppId);
    return { close() {} };
  });
  return { ...result, exitCode: runtime.exitCode ?? 0 };
}

const startup = await launch([]), probe = await launch(probeArgs);
const { uid, gid, mode } = files.get(healthPath) ?? {};
process.stdout.write(JSON.stringify({ startup, probe, heartbeat: { uid, gid, mode } }));
