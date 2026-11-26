import { describe, expect, it } from 'vitest';
import { ROLE_V2 } from '../../chain/src/core/roles';
import { ROLES, interpret, poolStateSlot, tickOfSlot0 } from '../src/chain';
import { seededRng } from '../src/rng';
import { runTick, type ChainPort, type RunConfig } from '../src/run';
import type { Candidate, Sim } from '../src/types';
import type { World } from '../src/world';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const world: World = {
  block: { number: 10n, timestamp: 1_791_302_405n, baseFeePerGas: 10n ** 9n }, fitGraduated: true,

  boxes: [{ id: 0n, version: 1, coordinator: addr(1), hook: addr(2), receiver: addr(3),
    priceSource: null, graduated: true, failed: false, curveClosed: true, gateOpen: true, openAt: 0n, deadline: 0n,
    spotTick: null, sampleTick: null, checkpointTime: 0n, fitOwed: 0n, platformOwed: 0n,
    qPerEthX18: 10n ** 18n }],
};
const cfg: RunConfig = {
  keeper: addr(0xbeef), dryRun: false, privateEndpoint: false, priorityFeeWei: 10n ** 8n,
  limits: { oursWeiPerDay: 10n ** 17n, pokesWeiPerDay: 10n ** 17n, reserveWeiPerDay: 0n, totalWeiPerDay: 10n ** 18n, maxTxPerBlock: 4 },
  payoutMinWei: 1n,
  rng: seededRng(1),
};
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function port(sim: (c: Candidate) => Sim) {
  const sent: { c: Candidate; gas: bigint }[] = [];
  const p: ChainPort = { read: async () => world, simulate: async (c) => sim(c), send: async (c, gas) => (sent.push({ c, gas }), '0x01') };
  return { p, sent };
}

describe('the runner (M1-51, further tests)', () => {
  it('sends nothing in a dry run, and survives a simulation that throws', async () => {
    const dry = port(() => ({ ok: true, tipWei: 10n ** 16n, estimate: 300_000n }));
    expect((await runTick(dry.p, {}, { ...cfg, dryRun: true }, quiet)).report.sent).toHaveLength(1);
    expect(dry.sent).toHaveLength(0);
    const broken = port(() => {
      throw new Error('rpc down');
    });
    const { report } = await runTick(broken.p, {}, cfg, quiet);
    // Review round 1, M4: a node that could not answer is a simulation error, logged apart from nothing to do.
    expect(report.skipped.map((s) => s.why)).toEqual(['simulation error']);
  });
});

describe('the chain adapter\'s helpers', () => {
  it('reads registry v2\'s roles as the frozen ROLE_V2 numbers them', () => {
    expect(ROLES).toEqual({ coordinator: ROLE_V2.coordinator, hook: ROLE_V2.hook, receiver: ROLE_V2.receiver });
  });

  it('decodes a slot0 tick, negative ones included, and finds the pool\'s state slot', () => {
    const word = (tick: number) => `0x${((BigInt(tick) & 0xffffffn) << 160n | 123n).toString(16).padStart(64, '0')}` as const;
    expect(tickOfSlot0(word(-202_622))).toBe(-202_622);
    expect(tickOfSlot0(word(35_146))).toBe(35_146);
    expect(poolStateSlot(`0x${'11'.repeat(32)}`)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reads each job\'s simulated result: outcomes, skips, and P tips valued at P\'s average', () => {
    const c = (job: Candidate['job']): Candidate => ({ job, key: job, to: addr(1), fn: 'x', args: [] });
    expect(interpret(c('deepen'), [1, 0, 1n, 1n, 2n * 10n ** 18n], 4n * 10n ** 18n)).toMatchObject({ ok: true, tipWei: 5n * 10n ** 17n });
    expect(interpret(c('deepen'), [0, 2, 0n, 0n, 0n], 10n ** 18n).ok).toBe(false);
    expect(interpret(c('collect'), { q: 1n, t: 0n, qToReserve: 0n, tip: 3n }, 10n ** 18n).tipWei).toBe(3n);
    expect(interpret(c('receiverPayFit'), 0n, null).ok).toBe(false);
  });
});
