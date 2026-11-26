import { afterEach, expect, it, vi } from 'vitest';
import { core, setManifestInput } from '../../../packages/chain/src/core/set-v2/test-support.ts';
import { settings } from '../services/runtime.mjs';

const fake = vi.hoisted(() => ({ read: vi.fn(), tick: vi.fn(), write: vi.fn(), publish: vi.fn(),
  store: vi.fn(), load: vi.fn(), save: vi.fn(), close: vi.fn(), manifest: vi.fn(), port: vi.fn() }));
vi.mock('node:fs', async original => {
  const fs = await original();
  return { ...fs, realpathSync: p => p.startsWith('/run/service-config') ? p : fs.realpathSync(p),
    openSync: (p, ...a) => p.startsWith('/run/service-config/') ? p : fs.openSync(p, ...a),
    fstatSync: fd => typeof fd === 'string' ? { isFile: () => true, size: 100 } : fs.fstatSync(fd),
    readFileSync: (fd, ...a) => typeof fd === 'string' && fd.startsWith('/run/service-config/') ? fake.manifest(fd) : fs.readFileSync(fd, ...a),
    closeSync: fd => { if (typeof fd !== 'string') fs.closeSync(fd); } };
});
vi.mock('../../../packages/keeper/src/chain.ts', () => ({ checkChainId: vi.fn(), ViemChain: class {
  constructor(cfg) { fake.port(cfg); } async read(...args) { return fake.read(...args); }
} }));
vi.mock('../../../packages/keeper/src/state.ts', () => ({ StateStore: class {
  constructor(...args) { fake.store(...args); } load = fake.load; save = fake.save; close = fake.close;
} }));
vi.mock('../../../packages/keeper/src/run.ts', () => ({ runTick: fake.tick }));
vi.mock('../../../packages/keeper/src/monitor.ts', async original => ({ ...await original(),
  publishMonitorView: fake.publish, writeMonitorView: fake.write }));
import { createDriver } from '../services/keeper.mjs';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
const env = { SH_SERVICE_ENABLED: '1', SH_KEEPER_RPC_URL: 'https://offline.invalid',
  SH_KEEPER_CHAIN_ID: String(core.chainId), SH_KEEPER_ADDRESS: `0x${'12'.repeat(20)}`,
  SH_KEEPER_BOX_REGISTRY: setManifestInput().registry.address, SH_KEEPER_DESTINATION_FORK: 'amsterdam',
  SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_CORE_MANIFEST: '/run/service-config/core.json',
  SH_KEEPER_SET_MANIFEST: '/run/service-config/set.json' };

it('the real driver rejects partial manifests before RPC, state or signer setup', async () => {
  await expect(createDriver({ ...env, SH_KEEPER_SET_MANIFEST: undefined }, settings('keeper', env)))
    .rejects.toThrow(/^set keeper configuration refused$/);
  expect(fake.port).not.toHaveBeenCalled(); expect(fake.store).not.toHaveBeenCalled();
});

it('the set driver publishes only the current discovered world and reloads its checkpoint on restart', async () => {
  fake.manifest.mockImplementation(path => JSON.stringify(path.endsWith('core.json') ? core : setManifestInput()));
  vi.stubGlobal('fetch', async (_url, init) => {
    const calls = JSON.parse(init.body), answer = c => ({ jsonrpc: '2.0', id: c.id,
      result: c.method === 'eth_chainId' ? `0x${core.chainId.toString(16)}` : '0x10' });
    return new Response(JSON.stringify(Array.isArray(calls) ? calls.map(answer) : answer(calls)));
  });
  const readings = { complete: true, failedReads: 0, snapshot: { number: 16n, timestamp: 1000n }, drand: { complete: true, requests: [] } };
  fake.read.mockResolvedValue({ monitor: readings, boxes: [{ id: 7n, coordinator: env.SH_KEEPER_ADDRESS,
    curveClosed: true, setLifecycle: { closedAt: 900n }, graduated: false, failed: false }] });
  const saved = { monitorQueue: { graduate: 16n }, mem: { attempts: { graduate: { next: 41n } } } };
  fake.load.mockReturnValueOnce({}).mockReturnValueOnce(saved);
  fake.tick.mockImplementation(async (port, state, cfg) => {
    await port.read(); await cfg.checkpoint(saved, 1012n);
    return { state: saved, observed: { readings, income: null, incomeSpend: [], maxFeePerGas: 2n } };
  });
  let driver = await createDriver(env, settings('keeper', env));
  expect(fake.port.mock.calls[0][0].setRelease.registry.address.toLowerCase()).toBe(env.SH_KEEPER_BOX_REGISTRY);
  expect(await driver.cycle()).toBe(true);
  expect(fake.save).toHaveBeenCalledWith(saved, 1012n);
  const [path, body] = fake.write.mock.calls[0];
  expect(path).toBe('/state/monitor.json.dry');
  expect(JSON.parse(body)).toMatchObject({ schema: 'squarehole.monitor-keeper-set.v1', complete: true,
    sets: [{ id: '7', closedAt: '900' }] });
  expect(fake.publish).not.toHaveBeenCalled();
  driver.close();
  driver = await createDriver(env, settings('keeper', env));
  fake.read.mockResolvedValue({ monitor: readings, boxes: [] });
  expect(await driver.cycle()).toBe(true);
  expect(fake.tick.mock.calls[1][1]).toBe(saved);
  expect(JSON.parse(fake.write.mock.calls[1][1]).sets).toEqual([]);
  expect(fake.store).toHaveBeenLastCalledWith('/state/keeper.json.dry',
    `${core.chainId}:${env.SH_KEEPER_ADDRESS}:${env.SH_KEEPER_BOX_REGISTRY}:`);
  driver.close(); expect(fake.close).toHaveBeenCalledTimes(2);
});
