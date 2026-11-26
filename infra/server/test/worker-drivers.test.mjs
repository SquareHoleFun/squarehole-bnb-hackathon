import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../services/runtime.mjs';

const doubles = vi.hoisted(() => ({ tick: vi.fn(), save: vi.fn(), close: vi.fn(), load: vi.fn(() => ({})),
  store: vi.fn(), check: vi.fn(), port: vi.fn(), cycle: vi.fn(), bot: vi.fn(), journal: vi.fn(), sqlite: vi.fn(),
  read: vi.fn(), quote: vi.fn(), safe: vi.fn(), signer: vi.fn(), parse: vi.fn(), readFile: vi.fn(), publish: vi.fn() }));
vi.mock('../../../packages/keeper/src/run.ts', () => ({ runTick: doubles.tick }));
vi.mock('../../../packages/keeper/src/monitor.ts', () => ({ publishMonitorView: doubles.publish }));
vi.mock('../../../packages/keeper/src/chain.ts', () => ({ checkChainId: doubles.check,
  ViemChain: function (...args) { doubles.port(...args); } }));
vi.mock('../../../packages/keeper/src/state.ts', () => ({ StateStore: class {
  constructor(...args) { doubles.store(...args); } load = doubles.load; save = doubles.save; close = doubles.close;
} }));
vi.mock('../../../packages/burn-bot/src/runner.ts', () => ({ runCycle: doubles.cycle }));
vi.mock('../../../packages/burn-bot/src/bot.ts', () => ({ Bot: function (...args) { doubles.bot(...args); } }));
vi.mock('../../../packages/burn-bot/src/journal.ts', () => ({ Journal: function (...args) { doubles.journal(...args); } }));
vi.mock('../../../packages/burn-bot/src/store.ts', () => ({ SqliteAppendStore: class {
  constructor(...args) { doubles.sqlite(...args); } close = doubles.close;
} }));
vi.mock('../../../packages/burn-bot/src/chain.ts', () => ({ ViemChainReader: function (...args) { return doubles.read(...args); } }));
vi.mock('../../../packages/burn-bot/src/quotes.ts', () => ({ ViemQuoteSource: function (...args) { doubles.quote(...args); } }));
vi.mock('../../../packages/burn-bot/src/service.ts', () => ({ SafeTransactionService: function (...args) { doubles.safe(...args); } }));
vi.mock('../../../packages/burn-bot/src/signer.ts', () => ({ CommandDigestSigner: function (...args) { doubles.signer(...args); } }));
// Runner config schema is covered by its owner. Here it records the exact mainnet opt-in, before endpoint creation.
vi.mock('../../../packages/burn-bot/src/config.ts', async (original) => ({ ...await original(), parseRunnerConfig: doubles.parse }));
vi.mock('node:fs', async (original) => ({ ...await original(), readFileSync: (...args) => doubles.readFile(...args) }));

import { createDriver as keeperDriver } from '../services/keeper.mjs';
import { createDriver as botDriver } from '../services/burn-bot.mjs';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('keeper service composes the reviewed keeper', () => {
  const env = { SH_SERVICE_ENABLED: '1', SH_KEEPER_RPC_URL: 'https://offline.invalid/fake-test-only',
    SH_KEEPER_CHAIN_ID: '11155111', SH_KEEPER_ADDRESS: `0x${'12'.repeat(20)}`, SH_KEEPER_BOX_REGISTRY: `0x${'34'.repeat(20)}`,
    SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
  function rpc() {
    let head = '0x10';
    const fetcher = vi.fn(async (_url, options) => {
      const input = JSON.parse(options.body);
      const answer = (request) => ({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0xaa36a7' : head });
      return new Response(JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input)), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetcher);
    return { fetcher, advance() { head = '0x11'; } };
  }
  it('shares the keeper journal identity, advances only after checkpoint and retries a failed head', async () => {
    const net = rpc();
    const saved = { budget: { totalWei: 90071992547409930000n } };
    doubles.tick.mockRejectedValueOnce(new Error('offline RPC failed')).mockImplementation(async (_port, _state, cfg) => {
      await cfg.checkpoint(saved, 1700000012n); return { state: saved };
    });
    const driver = await keeperDriver(env, settings('keeper', env));
    expect(doubles.check).toHaveBeenCalledWith(expect.anything(), 11155111, false);
    expect(doubles.store).toHaveBeenCalledWith('/state/keeper.json.dry', `11155111:${env.SH_KEEPER_ADDRESS}:${env.SH_KEEPER_BOX_REGISTRY}:`);
    expect(doubles.port.mock.calls[0][3]).toEqual({ public: null, private: null });
    await expect(driver.cycle()).rejects.toThrow();
    expect(await driver.cycle()).toBe(true);
    expect(doubles.save).toHaveBeenCalledWith(saved, 1700000012n);
    expect(await driver.cycle()).toBe(false);
    net.advance();
    expect(await driver.cycle()).toBe(true);
    expect(doubles.tick.mock.calls[2][1]).toBe(saved);
    expect(doubles.tick.mock.calls[2][2].dryRun).toBe(true);
    driver.close(); expect(doubles.close).toHaveBeenCalledOnce();
  });
  it('publishes the monitor view after each completed tick, beside the dry journal, and survives a failed write', async () => {
    rpc();
    const out = { state: {}, observed: { maxFeePerGas: 1n } };
    doubles.tick.mockResolvedValue(out);
    doubles.publish.mockImplementationOnce(() => { throw new Error('disk full'); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const driver = await keeperDriver(env, settings('keeper', env));
      expect(await driver.cycle()).toBe(true);
      expect(doubles.publish).toHaveBeenCalledWith('/state/monitor.json.dry', 11155111,
        `11155111:${env.SH_KEEPER_ADDRESS.toLowerCase()}:${env.SH_KEEPER_BOX_REGISTRY.toLowerCase()}:`, out);
      expect(stderr).toHaveBeenCalledWith('keeper: keeper monitor view not published\n');
      driver.close();
    } finally { stderr.mockRestore(); }
  });
  it('formats both skip levels with only box, job, code and repeats', async () => {
    rpc();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const hostile = '0x1234567890123456789012345678901234567890 https://rpc.invalid/key\nsecret';
    doubles.tick.mockImplementation(async (_port, _state, _cfg, log) => {
      log.info('skipped', { boxId: 5n, job: 'collect', code: 'NO_WORK', repeats: 0, key: hostile });
      log.warn('skipped', { boxId: '6', job: 'buyBack', code: 'BOX_INCOME_CAP', repeats: 9, error: new Error(hostile) });
      log.warn('skipped', { boxId: 5n, job: 'collect', code: hostile, repeats: 0, receiver: hostile });
      log.info('skipped', { boxId: hostile, job: hostile, code: hostile, repeats: hostile });
      return { state: {} };
    });
    try {
      const driver = await keeperDriver(env, settings('keeper', env));
      await driver.cycle(); driver.close();
      expect(stderr.mock.calls.map(c => c[0])).toEqual([
        'keeper: box=5 job=collect reason=NO_WORK repeats=0\n',
        'keeper: box=6 job=buyBack reason=BOX_INCOME_CAP repeats=9\n',
        'keeper: box=5 job=collect reason=OTHER repeats=0\n',
        'keeper: box=unknown job=unknown reason=OTHER repeats=0\n',
      ]);
      expect(JSON.stringify(stderr.mock.calls)).not.toMatch(/0x|https:|secret/);
    } finally { stderr.mockRestore(); }
  });
  it('refuses unconfigured watches and releases a corrupt state lock', async () => {
    await expect(keeperDriver({ ...env, SH_KEEPER_BOX_REGISTRY: undefined }, settings('keeper', env))).rejects.toThrow('watched');
    doubles.load.mockImplementationOnce(() => { throw new Error('corrupt'); });
    await expect(keeperDriver(env, settings('keeper', env))).rejects.toThrow('corrupt');
    expect(doubles.close).toHaveBeenCalledOnce();
  });
});

describe('burn runner service composition', () => {
  const env = { SH_SERVICE_ENABLED: '1', RPC_FAKE: 'https://offline.invalid/rpc', SAFE_FAKE: 'https://offline.invalid',
    SH_BOT_SIGNER_COMMAND: '/run/service-config/sign' };
  function config() {
    doubles.readFile.mockReturnValue('{}');
    doubles.parse.mockReturnValue({ manifest: { chainId: 11155111n }, rpcEnv: 'RPC_FAKE', serviceEnv: 'SAFE_FAKE',
      journal: '/state/burn-bot.sqlite', quoters: [] });
  }
  it('has separate dry storage and never instantiates a signer until live is selected', async () => {
    config();
    const dry = await botDriver(env, settings('burn-bot', env));
    expect(doubles.sqlite).toHaveBeenCalledWith('/state/burn-bot.sqlite.dry');
    expect(doubles.signer).not.toHaveBeenCalled();
    expect(await dry.cycle()).toBe(true);
    expect(doubles.cycle.mock.calls[0][0]).toMatchObject({ dryRun: true, signer: undefined, allowMainnet: false });
    dry.close();
    const live = await botDriver(env, settings('burn-bot', { ...env, SH_SERVICE_MODE: 'live', SH_SERVICE_ALLOW_MAINNET: '1' }));
    expect(doubles.parse).toHaveBeenLastCalledWith({}, true);
    expect(doubles.sqlite).toHaveBeenCalledWith('/state/burn-bot.sqlite');
    expect(doubles.signer).toHaveBeenCalledWith('/run/service-config/sign');
    doubles.cycle.mockRejectedValueOnce(new Error('fake provider failure'));
    await expect(live.cycle()).rejects.toThrow();
    live.close(); expect(doubles.close).toHaveBeenCalledTimes(2);
  });
  it('bounds reader evidence across 400 advancing finalized heads while keeping the durable bot', async () => {
    config();
    const { ViemChainReader } = await vi.importActual('../../../packages/burn-bot/src/chain.ts');
    let head = 1n;
    const getBlock = vi.fn(async ({ blockNumber = head }) => ({ number: blockNumber,
      hash: `0x${blockNumber.toString(16).padStart(64, '0')}`, timestamp: blockNumber }));
    doubles.read.mockImplementation((manifest) => new ViemChainReader(manifest,
      { getChainId: async () => 11155111, getBlock }, { startBlock: 1n, logChunk: 128n, maxScanBlocks: 1000n }));
    const sizes = [], reads = [], bots = new Set();
    doubles.cycle.mockImplementation(async ({ reader, bot }) => {
      getBlock.mockClear();
      await reader.pin(); // Exercise the actual block-pinning path used by observe/snapshot.
      sizes.push(reader.knownBlocks.size);
      reads.push(getBlock.mock.calls.length);
      bots.add(bot);
    });
    const driver = await botDriver(env, settings('burn-bot', env));
    try {
      for (; head <= 400n; head++) await driver.cycle();
      expect(Math.max(...reads)).toBe(1);
      expect(Math.max(...sizes)).toBe(1);
      expect(bots.size).toBe(1);
      expect(doubles.sqlite).toHaveBeenCalledTimes(1);
    } finally { driver.close(); doubles.read.mockReset(); doubles.cycle.mockReset(); }
  });
  it('passes mainnet refusal through before creating a reader, signer or journal', async () => {
    config();
    doubles.parse.mockImplementationOnce(() => { throw new Error('mainnet'); });
    await expect(botDriver(env, settings('burn-bot', env))).rejects.toThrow('mainnet');
    expect(doubles.read).not.toHaveBeenCalled(); expect(doubles.signer).not.toHaveBeenCalled(); expect(doubles.sqlite).not.toHaveBeenCalled();
  });
});
