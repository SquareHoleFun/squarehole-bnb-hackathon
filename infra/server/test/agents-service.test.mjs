import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { agentSettings, agentHealthy, readSecret } from '../services/agents.mjs';
import { createAgentKey } from '../services/create-agent-key.mjs';
import { privateKeyToAccount } from '../services/agents/chain.mjs';
import { scratch } from './fixtures/agents/helpers.mjs';

describe('agents server boundary', () => {
  it('defaults off, dry-run and hourly; refuses other chains, raw secrets and misspelled flags', () => {
    expect(agentSettings({})).toMatchObject({ enabled: false, mode: 'dry-run', interval: 3600000, dailyBudgetUsd: '2' });
    for (const env of [{ SH_SERVICE_ENABLED: 'yes' }, { SH_SERVICE_MODE: 'send' }, { SH_AGENTS_CHAIN_ID: '1' },
      { SH_SERVICE_ALLOW_MAINNET: '1' }, { ANTHROPIC_API_KEY: 'fixture' }, { SH_AGENTS_PRIVATE_KEY: 'fixture' },
      { SH_AGENTS_DAILY_BUDGET_USD: 'NaN' }, { SH_AGENTS_DAILY_BUDGET_USD: '0' }]) expect(() => agentSettings(env)).toThrow();
  });
  it('offline plan reads no mounted files even when live is requested; enabled host execution is refused', () => {
    const run = spawnSync(process.execPath, ['infra/server/services/agents.mjs', '--dry-run'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live' },
    });
    expect(run.status, run.stderr).toBe(0); expect(run.stdout).toContain('offline plan');
    const bad = spawnSync(process.execPath, ['infra/server/services/agents.mjs'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, SH_SERVICE_ENABLED: '1' },
    });
    expect(bad.status).toBe(1); expect(bad.stderr).toContain('details suppressed');
  });
  it('root-only secrets reject non-root, group access, links and bad contents without echoing them', () => {
    const { root } = scratch(), file = join(root, 'fixture.secret');
    writeFileSync(file, 'fixture-secret', { mode: 0o600 });
    if (process.getuid() !== 0) expect(() => readSecret(file, 'api')).toThrow();
    chmodSync(file, 0o640); expect(() => readSecret(file, 'api')).toThrow();
    chmodSync(file, 0o600); writeFileSync(file, 'bad\nmultiple\nlines'); expect(() => readSecret(file, 'api')).toThrow();
    symlinkSync(file, join(root, 'link')); expect(() => readSecret(join(root, 'link'), 'api')).toThrow();
  });
  it('creates an exclusive 0600 fixture key and prints only the address in create mode', () => {
    const file = join(scratch().root, 'fixture.key'), key = '0x' + '1'.padStart(64, '0');
    expect(createAgentKey(file, () => key)).toBe(privateKeyToAccount(key).address);
    expect(statSync(file).mode & 0o777).toBe(0o600); expect(readFileSync(file, 'utf8')).toBe(key + '\n');
    expect(() => createAgentKey(file, () => { throw new Error('must not generate'); })).toThrow();
    const plan = spawnSync(process.execPath, ['infra/server/services/create-agent-key.mjs', '--dry-run'], { encoding: 'utf8' });
    expect(plan.status).toBe(0); expect(plan.stdout).toContain('dry run');
  });
  it('health accepts an hourly budget hold but rejects stale, failed and mismatched records', () => {
    const cfg = agentSettings({ SH_SERVICE_ENABLED: '1' }), now = 10000000;
    const record = { service: 'agents', mode: 'dry-run', status: 'ok', at: now - 3600000, reason: 'daily-budget' };
    expect(agentHealthy(record, cfg, now)).toBe(true);
    for (const r of [{ ...record, at: 0 }, { ...record, status: 'failed' }, { ...record, mode: 'live' }, { ...record, at: now + 1 }]) expect(agentHealthy(r, cfg, now)).toBe(false);
  });
});
