import { describe, expect, it } from 'vitest';
import { transactionGas } from '../../src/gas';
import { JOBS } from '../../src/jobs';
import { runTick, type KeeperState } from '../../src/run';
import { box, world, options, quiet, v2, addr } from '../support/v2';

const CAP = 16_777_216n;

describe('FINAL2-OC02: keeper headroom respects the destination transaction rules', () => {
  it('all published operating allowances plus headroom fit the Osaka cap', () => {
    for (const job of JOBS) expect(transactionGas(job.name, job.gasPerRun), job.name).toBeLessThanOrEqual(CAP);
    expect(transactionGas('shopReturn', 30_000n)).toBe(2_000_000n);
    expect(transactionGas('shopBurn', 30_000n)).toBe(5_000_000n);
  });

  // Osaka applies EIP-7825 to the entire limit. Amsterdam separates state gas;
  // this test does NOT demand clipping that reservoir. The current port/config
  // has no fork or block-room input to distinguish the two chains.
  it.each([13_981_014n, 14_000_000n])('never broadcasts an Osaka-invalid limit for valid estimate %s', async estimate => {
    const w = world(box({ failed: true, graduated: false, v2: { ...v2, pot: 0n, m2: [
      { job: 'shopReturn', to: addr(70), fn: 'returnStarter', args: [[0n]], key: 'round2-return' },
    ] } }));
    const broadcasts: bigint[] = [];
    const saved: KeeperState[] = [];
    const cfg = options();
    const out = await runTick({
      read: async () => w,
      simulate: async c => ({ ok: c.job === 'shopReturn', estimate, tipWei: 0n }),
      send: async (_c, gas) => {
        broadcasts.push(gas);
        if (gas > CAP) throw new Error('Osaka node: transaction gas limit exceeds cap');
        return 'local-double';
      },
    }, {}, { ...cfg, dryRun: false, priorityFeeWei: 1n,
      limits: { ...cfg.limits, totalWeiPerDay: 1_000_000_000n, oursWeiPerDay: 1_000_000_000n, reserveWeiPerDay: 0n },
      checkpoint: async state => { saved.push(state); },
    }, quiet);
    expect(saved.length).toBeGreaterThan(0);
    expect(out.report.skipped.filter(s => s.job === 'shopReturn' && s.why === 'send error'),
      'locally predictable cap rejection must be handled before signing and durable spend reservation').toEqual([]);
    expect(broadcasts.every(gas => gas <= CAP)).toBe(true);
  });
});
