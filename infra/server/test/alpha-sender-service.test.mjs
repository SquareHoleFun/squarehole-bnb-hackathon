import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, chmodSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createDeskKey } from '../services/create-desk-key.mjs';
import { readDeskKey, withChainHealth } from '../services/alpha-sender.mjs';
import { scratch, account } from './fixtures/alpha-sender/helpers.mjs';

describe('alpha sender deployment boundary', () => {
  it('key creation is explicit; fixture key is exclusive and mode 0600', () => {
    for (const args of [[], ['--dry-run']]) {
      const run = spawnSync(process.execPath, ['infra/server/services/create-desk-key.mjs', ...args], { encoding: 'utf8' });
      expect(run.status).toBe(0); expect(run.stdout).toContain('dry run');
    }
    const bad = spawnSync(process.execPath, ['infra/server/services/create-desk-key.mjs', '--unknown'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    const file = join(scratch().state, 'fixture.key');
    const key = `0x${'1'.padStart(64, '0')}`;
    expect(createDeskKey(file, () => key)).toBe(account(1).address);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => createDeskKey(file, () => { throw new Error('must not generate'); })).toThrow('existing key preserved');
    expect(readFileSync(file, 'utf8')).toBe(`${key}\n`);
  });
  it('key reader rejects group-readable, malformed, non-root and symlink fixture files', () => {
    const dir = scratch().state, file = join(dir, 'fixture.key');
    writeFileSync(file, `0x${'1'.repeat(64)}\n`, { mode: 0o600 });
    if (process.getuid() !== 0) expect(() => readDeskKey(file)).toThrow();
    chmodSync(file, 0o640); expect(() => readDeskKey(file)).toThrow();
    chmodSync(file, 0o600); writeFileSync(file, 'malformed'); expect(() => readDeskKey(file)).toThrow();
    symlinkSync(file, join(dir, 'link')); expect(() => readDeskKey(join(dir, 'link'))).toThrow();
  });
  it('offline planning opens no key, settings file or RPC, even with live enabled', () => {
    const run = spawnSync(process.execPath, ['infra/server/services/alpha-sender.mjs', '--dry-run'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live' },
    });
    expect(run.status, run.stderr).toBe(0); expect(run.stdout).toContain('offline plan');
  });
  it('health advances during confirmation waits, but stops on a stalled head or failed reconciliation', async () => {
    let block = 1n, fail = false;
    const sender = { cycle: async () => { if (fail) throw new Error('RPC failure'); return false; } };
    const driver = withChainHealth(sender, { head: async () => block });
    expect(await driver.cycle()).toBe(true);
    expect(await driver.cycle()).toBe(false);
    block++; expect(await driver.cycle()).toBe(true);
    fail = true; block++; await expect(driver.cycle()).rejects.toThrow('RPC failure');
  });
  it('Compose puts the sender after cow-poster with only its outbound network and exact mounts', () => {
    const compose = readFileSync('infra/server/compose.yaml', 'utf8');
    const block = compose.match(/^ {2}alpha-sender:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:|^networks:)/m)?.[1];
    expect(block).toBeTruthy();
    expect(compose.indexOf('  cow-poster:')).toBeLessThan(compose.indexOf('  alpha-sender:'));
    expect(block).toContain('networks: [alpha_sender]');
    expect(block).not.toMatch(/ports:|network_mode:|\bbackend\b|\bedge\b|pgdata|caddy/);
    expect(block).toContain('source: /srv/squarehole/alpha/queue');
    expect(block).toMatch(/target: \/queue\n\s+read_only: true/);
    expect(block).toContain('source: /srv/squarehole/alpha/receipts');
    expect(block).toMatch(/source: alpha_sender_state\n\s+target: \/state\n\s+volume:\n\s+nocopy: true/);
    expect(block).toMatch(/target: \/run\/service-config\n\s+read_only: true/);
    expect(block).toContain('infra/server/services/alpha-sender.mjs');
    expect(block).toContain('pull_policy: never');
    expect(block).not.toMatch(/^ {4}build:/m);
    expect(block).toContain('user: "0:2103"');
    expect(block).toContain('cap_drop: [ALL]');
    expect(block).not.toContain('cap_add:');
    expect(block).toContain('source: /etc/squarehole/alpha-sender\n');
    expect(block).not.toContain('source: /etc/squarehole/alpha-sender/desk.key');
    expect(block).not.toContain('source: /srv/squarehole/alpha/state');
  });
});


it.each(['dry-run', 'live'])('sender protects its retained volume before opening the %s journal', mode => {
  const probe = fault => {
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings=ExperimentalWarning',
      'infra/server/test/fixtures/alpha-sender/runtime.mjs', '1', mode, fault], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout);
  };
  const r = probe('none'); expect(r.refused).toBe(false);
  expect(r.events).toEqual(['chain', ...(mode === 'live' ? [['open', '/run/service-config/desk.key']] : []),
    ['open', '/state'], ['mode', 0o700], ['sender', '/state']]);
  for (const fault of ['owner', 'file']) {
    const bad = probe(fault); expect(bad.refused).toBe(true);
    expect(bad.events.some(e => Array.isArray(e) && e[0] === 'sender')).toBe(false);
  }
});
