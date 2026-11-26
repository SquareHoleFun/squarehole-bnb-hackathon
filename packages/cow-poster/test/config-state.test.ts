import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLATFORM_SAFE_MAINNET } from '../../box-spec/src/generated/box-spec.v1';
import { labelAddress } from '../../chain/src/core/test-support';
import { synthManifestV2Json } from '../../chain/src/core/v2/test-support/synth-v2';
import { loadConfig, loadManifest, loadPaths, loadService } from '../src/config';
import { FileReservations, writeHealth, jsonLog } from '../src/state';

const env = { SH_COW_CHAIN_ID: '31337', SH_COW_RPC_URL: 'https://rpc.invalid/credential',
  SH_COW_API_BASE: 'https://api.cow.fi/sepolia', SH_COW_MANIFEST: 'release.json' };
describe('startup and durable monitoring', () => {
  it('loads the chain package v2 manifest and refuses a different chain', () => {
    const c = loadConfig(env);
    expect(c.cycleMs).toBe(600_000); expect(c.feeBps).toBe(500n);
    expect(loadManifest(synthManifestV2Json(), c.chainId).chainId).toBe(31337);
    expect(() => loadManifest(synthManifestV2Json(), 11155111)).toThrow('manifest chain mismatch');
    expect(() => loadManifest({ chainId: 31337, releases: [] }, 31337)).toThrow('invalid release manifest');
  });
  it.each([['1', 'mainnet'], ['11155111', 'sepolia']])('selects the %s API default', (chain, network) => {
    expect(loadConfig({ ...env, SH_COW_CHAIN_ID: chain, SH_COW_API_BASE: undefined, SH_SERVICE_ALLOW_MAINNET: '1' }).apiBase)
      .toBe(`https://api.cow.fi/${network}`);
  });
  it('follows the stack’s worker flags: absent is disabled, enabled is a dry run unless live, anything else refused', () => {
    expect(loadService({})).toEqual({ enabled: false, mode: 'dry-run', allowMainnet: false });
    expect(loadService({ SH_SERVICE_ENABLED: '1' })).toEqual({ enabled: true, mode: 'dry-run', allowMainnet: false });
    expect(loadService({ SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live' }).mode).toBe('live');
    for (const flags of [{ SH_SERVICE_ENABLED: 'yes' }, { SH_SERVICE_ENABLED: 'true' }, { SH_SERVICE_MODE: 'send' },
      { SH_SERVICE_MODE: 'LIVE' }, { SH_SERVICE_ALLOW_MAINNET: 'true' }]) expect(() => loadService(flags)).toThrow('invalid SH_SERVICE_');
    expect(loadConfig(env).mode).toBe('dry-run');
    expect(loadConfig({ ...env, SH_SERVICE_MODE: 'live' }).mode).toBe('live');
  });
  it('refuses chain 1 without the stack’s explicit mainnet operator flag', () => {
    expect(() => loadConfig({ ...env, SH_COW_CHAIN_ID: '1', SH_COW_API_BASE: undefined })).toThrow('SH_SERVICE_ALLOW_MAINNET');
  });
  it('reads only the state and health paths when disabled', () => {
    expect(loadPaths({})).toEqual({ stateDir: '.cache/cow-poster', healthFile: '.cache/cow-poster/health.json' });
    expect(loadPaths({ SH_COW_STATE_DIR: '/state', SH_COW_HEALTH_FILE: '/state/h.json' })).toEqual({ stateDir: '/state', healthFile: '/state/h.json' });
  });
  it('takes chain 1 only through the shared parser: the awaiting file and a 1-of-1 platform Safe are refused (SH-188)', async () => {
    const committed = JSON.parse(await readFile(new URL('../../contracts/deployments/core-v1/1.json', import.meta.url), 'utf8')) as unknown;
    expect(() => loadManifest(committed, 1)).toThrow('invalid release manifest');
    const json = synthManifestV2Json();
    expect(() => loadManifest({ ...json, chainId: 1, network: 'mainnet' }, 1)).toThrow('invalid release manifest');
    // The same release once deployed on chain 1 with the 2-of-3 platform Safe (F151) and its owner roles.
    const [founder, bot, backup] = ['founder', 'bot', 'backup'].map(n => labelAddress(`owner:${n}`));
    const release = (json.releases as Record<string, unknown>[])[0] as Record<string, unknown>;
    const safes = release.safes as Record<string, Record<string, unknown>>;
    const chain = json.chain as Record<string, Record<string, unknown>>;
    const mainnet = { ...json, chainId: 1, network: 'mainnet',
      chain: { ...chain, platformSafe: { ...chain.platformSafe, address: PLATFORM_SAFE_MAINNET } },
      releases: [{ ...release, owners: { founder, bot, backup },
        safes: { ...safes, platform: { ...safes.platform, address: PLATFORM_SAFE_MAINNET, threshold: '2',
          owners: [labelAddress('owner:third'), labelAddress('owner:second'), founder] } } }] };
    expect(loadManifest(mainnet, 1).chainId).toBe(1);
    expect(() => loadManifest(mainnet, 11155111)).toThrow('manifest chain mismatch');
    const { owners: _roles, ...withoutRoles } = mainnet.releases[0] as Record<string, unknown>;
    void _roles;
    expect(() => loadManifest({ ...mainnet, releases: [withoutRoles] }, 1)).toThrow('invalid release manifest');
  });
  it.each(['-1', '0.05', '10001', 'NaN'])('refuses invalid fee bps %s without echoing config values', value => {
    expect(() => loadConfig({ ...env, SH_COW_FEE_BPS: value })).toThrow('SH_COW_FEE_BPS');
  });
  it('requires explicit API base for other chains and rejects wrong public network paths', () => {
    expect(() => loadConfig({ ...env, SH_COW_API_BASE: undefined })).toThrow('SH_COW_API_BASE');
    expect(() => loadConfig({ ...env, SH_COW_CHAIN_ID: '1' })).toThrow('SH_COW_API_BASE');
  });
  it('reserves each UID exclusively across store instances and restart', async () => {
    const root = fileURLToPath(new URL('../../../.cache/lane/cow-poster', import.meta.url)); await mkdir(root, { recursive: true });
    const dir = await mkdtemp(`${root}/state-`);
    const uid = `0x${'a'.repeat(112)}`;
    const a = new FileReservations(dir, 31337), b = new FileReservations(dir, 31337);
    const results = await Promise.all([a.reserve(uid), b.reserve(uid)]);
    expect(results.sort()).toEqual([false, true]); expect(await new FileReservations(dir, 31337).has(uid)).toBe(true);
    expect(await new FileReservations(dir, 11155111).has(uid)).toBe(false);
  });
  it('writes atomic health JSON and emits only explicit structured log fields', async () => {
    const root = fileURLToPath(new URL('../../../.cache/lane/cow-poster', import.meta.url)); await mkdir(root, { recursive: true });
    const dir = await mkdtemp(`${root}/health-`), path = `${dir}/health.json`;
    await writeHealth(path, { phase: 'idle', completedAt: 100 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ phase: 'idle', completedAt: 100 });
    const lines: string[] = []; const log = jsonLog(line => { lines.push(line); });
    log('no_data', { uid: 'public', count: 3n });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ event: 'no_data', uid: 'public', count: '3' });
  });
});
