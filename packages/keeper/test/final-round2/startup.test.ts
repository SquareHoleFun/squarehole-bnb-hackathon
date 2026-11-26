import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainPort } from '../../src/run';

const observed = vi.hoisted(() => ({ results: [] as unknown[], close: vi.fn(), checkpoints: vi.fn() }));
vi.mock('viem', async importOriginal => ({
  ...await importOriginal<typeof import('viem')>(),
  createPublicClient: () => ({
    getChainId: async () => 11155111,
    getBlockNumber: async () => 1n,
    getBlock: async () => ({ timestamp: 1n, gasLimit: 30_000_000n }),
  }),
}));
vi.mock('../../src/state', () => ({ StateStore: class {
  load() { return {}; }
  save = observed.checkpoints;
  close = observed.close;
} }));
vi.mock('../../src/log', () => ({ makeLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../../src/run', () => ({ runTick: async (port: ChainPort) => {
  try {
    observed.results.push(await port.gasConstraints?.({ job: 'collect', key: 'startup',
      to: '0x0000000000000000000000000000000000000080', fn: 'collect', args: [], version: 2 }, 100_000n));
  } catch (error) { observed.results.push(error); }
  process.emit('SIGTERM');
  return { state: {}, report: { sent: [], skipped: [], block: 1n } };
} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  observed.results.length = 0;
});

describe('KEEPER-WIRE actual CLI composition', () => {
  it.each(['osaka', 'amsterdam'])('passes the explicit %s policy to its chain adapter', async fork => {
    vi.resetModules();
    vi.stubEnv('SH_KEEPER_RPC_URL', 'http://fake.invalid');
    vi.stubEnv('SH_KEEPER_DESTINATION_FORK', fork);
    vi.stubEnv('SH_KEEPER_TRANSACTION_GAS_CAP', '1000000');
    vi.stubEnv('SH_KEEPER_POLL_MS', '0');
    vi.stubEnv('SH_KEEPER_DRY_RUN', '1');
    const oldTerm = process.listeners('SIGTERM'), oldInt = process.listeners('SIGINT');
    try {
      await import('../../src/main');
      await vi.waitFor(() => expect(observed.close).toHaveBeenCalledOnce());
      expect(observed.checkpoints).not.toHaveBeenCalled();
      expect(observed.results).toHaveLength(1);
      if (fork === 'amsterdam') expect(observed.results[0]).toEqual(expect.objectContaining({ message: expect.stringContaining('state gas') }));
      else expect(observed.results[0]).toEqual({ fork, transactionCap: 1_000_000n, blockGasLimit: 30_000_000n });
    } finally {
      for (const listener of process.listeners('SIGTERM')) if (!oldTerm.includes(listener)) process.off('SIGTERM', listener);
      for (const listener of process.listeners('SIGINT')) if (!oldInt.includes(listener)) process.off('SIGINT', listener);
    }
  });
});
