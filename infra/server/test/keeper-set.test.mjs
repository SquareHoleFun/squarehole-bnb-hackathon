import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { core, setManifestInput } from '../../../packages/chain/src/core/set-v2/test-support.ts';
import { loadConfig } from '../../../packages/keeper/src/config.ts';
import { parseSetManifest } from '../../../packages/chain/src/core/set-v2/manifest-set-v2.ts';
import { loadServiceConfig, buildSetMonitorView, readPublicManifest } from '../services/keeper.mjs';
import { keeperEnvironment, settings } from '../services/runtime.mjs';

const env = { SH_KEEPER_RPC_URL: 'https://offline.invalid', SH_KEEPER_CHAIN_ID: String(core.chainId),
  SH_KEEPER_ADDRESS: `0x${'12'.repeat(20)}`, SH_KEEPER_BOX_REGISTRY: setManifestInput().registry.address,
  SH_KEEPER_DESTINATION_FORK: 'amsterdam', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
const pair = { SH_KEEPER_CORE_MANIFEST: '/run/service-config/core.json', SH_KEEPER_SET_MANIFEST: '/run/service-config/set.json' };
const service = settings('keeper', env);
const read = path => JSON.stringify(path === pair.SH_KEEPER_CORE_MANIFEST ? core : setManifestInput());

describe('the server selects set mode only from paired mounted public manifests', () => {
  it('preserves the old environment/config exactly and reads no manifest without a pair', () => {
    const reader = vi.fn();
    expect(loadServiceConfig(env, service, reader)).toEqual(loadConfig(keeperEnvironment(env, service)));
    expect(reader).not.toHaveBeenCalled();
  });
  it.each(Object.keys(pair))('refuses a partial pair (%s) before reading it', key => {
    const reader = vi.fn();
    expect(() => loadServiceConfig({ ...env, [key]: pair[key] }, service, reader)).toThrow('set keeper configuration refused');
    expect(reader).not.toHaveBeenCalled();
  });
  it('accepts the real validated pair, retaining independent state and dry-run defaults', () => {
    expect(loadServiceConfig({ ...env, ...pair }, service, read)).toMatchObject({
      setRelease: parseSetManifest(setManifestInput(), core), stateFile: '/state/keeper.json', monitorFile: '/state/monitor.json', dryRun: true,
    });
    const sepolia = path => JSON.stringify({ ...(path.endsWith('core.json') ? core : setManifestInput()), network: 'sepolia', chainId: 11155111 });
    expect(loadServiceConfig({ ...env, ...pair, SH_KEEPER_CHAIN_ID: '11155111' }, service, sepolia).setRelease.network).toBe('sepolia');
  });
  it('refuses escaped paths, empty inputs, malformed JSON, chain/registry mismatch and Box 0 with fixed errors', () => {
    for (const over of [{ SH_KEEPER_CORE_MANIFEST: '' }, { SH_KEEPER_CORE_MANIFEST: '/tmp/core.json' },
      { SH_KEEPER_SET_MANIFEST: '/run/service-config/../secret.json' }, { SH_KEEPER_CHAIN_ID: '11155111' },
      { SH_KEEPER_BOX_REGISTRY: `0x${'34'.repeat(20)}` }, { SH_KEEPER_BOX0: '{}' }]) {
      expect(() => loadServiceConfig({ ...env, ...pair, ...over }, service, read)).toThrow(/^set keeper configuration refused$/);
    }
    for (const reader of [() => 'FAKE_SECRET', () => { throw new Error('FAKE_SECRET'); }]) {
      expect(() => loadServiceConfig({ ...env, ...pair }, service, reader)).toThrow(/^set keeper configuration refused$/);
    }
  });
});

it('bounds real public files and refuses symlink escapes, directories and missing files with fixed errors', () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/set-manifests-')), root = join(dir, 'mount');
  mkdirSync(root); writeFileSync(join(root, 'core.json'), '{}');
  expect(readPublicManifest(join(root, 'core.json'), root)).toBe('{}');
  writeFileSync(join(dir, 'outside.json'), 'FAKE_SECRET');
  symlinkSync(join(dir, 'outside.json'), join(root, 'escape.json'));
  writeFileSync(join(root, 'large.json'), 'x'.repeat(1048577));
  for (const path of ['escape.json', 'large.json', 'missing.json', '.']) {
    expect(() => readPublicManifest(join(root, path), root)).toThrow(/^set keeper configuration refused$/);
  }
});

it('publishes closure state from this tick, independent of optional income reads; incomplete discovery stays incomplete', () => {
  const readings = { complete: true, failedReads: 0, snapshot: { number: 12n, timestamp: 10000n }, drand: { complete: true, requests: [] } };
  const world = { monitor: readings, boxes: [{ id: 7n, coordinator: env.SH_KEEPER_ADDRESS, curveClosed: true,
    graduated: false, failed: false, setLifecycle: { closedAt: 9000n } }] };
  const out = { state: {}, observed: { readings, maxFeePerGas: 2n, income: null, incomeSpend: [] } };
  const view = buildSetMonitorView(11155111, 'identity', out, world);
  expect(view).toMatchObject({ schema: 'squarehole.monitor-keeper-set.v1', complete: true, observedAt: '10000',
    sets: [{ id: '7', coordinator: env.SH_KEEPER_ADDRESS, closed: true, closedAt: '9000', graduated: false, failed: false }] });
  expect(() => JSON.stringify(view)).not.toThrow();
  expect(buildSetMonitorView(11155111, 'identity', { ...out, observed: { ...out.observed, readings: { ...readings, complete: false } } }, world).complete).toBe(false);
  expect(buildSetMonitorView(11155111, 'identity', out, undefined)).toBeNull();
});

it('keeps the original service byte-for-byte and adds an isolated disabled worker from the same image', () => {
  const compose = readFileSync('infra/server/compose.yaml', 'utf8');
  const block = name => compose.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z][a-z-]*:|\\nnetworks:)`))?.[0];
  expect(createHash('sha256').update(block('keeper')).digest('hex')).toBe('0485e24277e3a3039f7215bf019c97de8555c920a6e23865b8896fcb3996fc2b');
  const set = block('keeper-set');
  expect(set).toContain('image: squarehole-keeper:${SH_RELEASE:');
  expect(set).toContain('pull_policy: never');
  expect(set).toContain('path: /etc/squarehole/keeper-set.env\n        required: false');
  expect(set).toContain('source: /etc/squarehole/keeper-set');
  expect(set).toContain('target: /run/service-config\n        read_only: true');
  expect(set).toContain('- keeper_set_state:/state');
  expect(set).not.toMatch(/SH_SERVICE_ENABLED:.*1|keeper_state:/);
  expect(compose).toContain('  keeper_set_state: {}');
  const dockerfile = readFileSync('packages/keeper/Dockerfile', 'utf8');
  expect(dockerfile).toContain('"infra/server/services/run.mjs", "keeper"]');
  expect(dockerfile).toContain('"infra/server/services/run.mjs", "keeper", "--healthcheck"]');
});
