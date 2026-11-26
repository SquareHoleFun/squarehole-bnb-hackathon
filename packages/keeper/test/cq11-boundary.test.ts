import { toHex, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { ABI_OF_JOB, ABI_SOURCES } from '../src/abi';
import { ViemChain } from '../src/chain';
import { loadConfig } from '../src/config';
import { JOBS } from '../src/jobs';
import { emptyMemory, plan } from '../src/plan';
import { seededRng } from '../src/rng';
import type { BoxState, World } from '../src/world';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const now = 1_791_302_400n;
const options = { keeper: addr(1), payoutMinWei: 1n, rng: seededRng(3) };
const box: BoxState = {
  id: 0n, version: 1, coordinator: addr(3), hook: addr(4), receiver: addr(5), priceSource: addr(6),
  graduated: true, failed: false, curveClosed: true, gateOpen: true, openAt: 0n, deadline: 0n,
  spotTick: 1101, sampleTick: 1000, checkpointTime: now, fitOwed: 0n, platformOwed: 0n,
  qPerEthX18: 10n ** 18n,
};
const world = (boxes: readonly BoxState[]): World => ({
  block: { number: 100n, timestamp: now, baseFeePerGas: 1n }, boxes, fitGraduated: true,

});
const obsolete = ['v2Snapshot', 'converterStep', 'failedAttempt', 'moduleStep', 'capPayPlatform', 'capPayFit', 'samplerTopUp', 'oracleGrowth', 'claimTip'];

describe('CQ11-0 keeper deletion boundary', () => {
  it('removes C14 jobs and their transaction ABIs', () => {
    for (const name of obsolete) {
      expect(JOBS.map((j) => j.name)).not.toContain(name);
      expect(ABI_OF_JOB).not.toHaveProperty(name);
    }
    for (const name of ['converter', 'module', 'sampler', 'platformCap', 'v3Pool']) expect(ABI_SOURCES.map((s) => s.name)).not.toContain(name);
  });
  it('refuses to plan an incomplete v2 read', () => {
    const candidates = plan(world([{ ...box, version: 2 }]), emptyMemory(), options).candidates;
    expect(candidates).toEqual([]);
  });
  it('keeps Box 0 executor pokes and calm-period top-ups', () => {
    expect(plan(world([box]), emptyMemory(), options).candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ job: 'poke', to: addr(6), fn: 'poke' }),
    ]));
    const calm = { ...box, spotTick: 1000, checkpointTime: now - 515n };
    expect(plan(world([calm]), emptyMemory(), options).candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ job: 'executorTopUp', to: addr(6), fn: 'poke' }),
    ]));
  });
  it('makes no removed registry, converter, cap or oracle reads from legacy settings', async () => {
    const calls: string[] = [];
    const client = {
      getChainId: async () => 11155111,
      request: async () => ({ number: '0x64', timestamp: toHex(now), baseFeePerGas: '0x1' }),
      getBlock: async () => world([]).block,
      readContract: async ({ functionName }: { functionName: string }) => { calls.push(functionName); throw new Error('removed read'); },
    } as unknown as PublicClient;
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_LISTING_REGISTRY: addr(2), SH_KEEPER_FROM_BLOCK: '1', SH_KEEPER_PLATFORM_CAP: addr(9), SH_KEEPER_V2_PAIRS: addr(10), SH_KEEPER_V3_POOLS: addr(11) });
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    await new ViemChain(cfg, client, addr(1), { public: null, private: null }, null, quiet).read();
    expect(calls).toEqual([]);
  });
});
