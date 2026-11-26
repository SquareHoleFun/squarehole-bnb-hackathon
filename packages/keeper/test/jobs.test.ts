import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JOBS, jobSpec, oursList, renderOursList, type JobSpec } from '../src/jobs';
import { renderReleaseGas } from '../scripts/release-gas';

const OURS_MD = new URL('../OURS.md', import.meta.url);

describe('the job table and the ours list (ADR-0017 § 11; F95 R19F, R19S)', () => {
  it('lists every tipless job as always ours and every tipped job as ours once its tip stops paying', () => {
    const list = oursList(JOBS);
    expect(list).toHaveLength(JOBS.length);
    // Review round 1, L6: the closer's tip has no view (change request 2), so fail() and failClosed() always run as ours.
    const always = (j: JobSpec) => j.tip === 'none' || j.tip === 'closer';
    for (const job of JOBS) {
      const entry = list.find((e) => e.job === job.name);
      expect(entry, job.name).toBeDefined();
      expect(entry?.when, job.name).toBe(always(job) ? 'always' : 'when its tip does not cover its gas');
    }
    expect(list.find((e) => e.job === 'fail')?.when).toBe('always');
  });

  it('says graduate() pays its caller a reward, and that the keeper does not claim it yet (L1)', () => {
    expect(jobSpec('graduate').what).toMatch(/claimReward/);
    expect(jobSpec('graduate').what).not.toMatch(/pays no tip/);
  });

  it('is generated from the table, so a job added without a tip cannot be missing from it', () => {
    const extra = { ...JOBS[0], name: 'extraJob', tip: 'none' } as unknown as JobSpec;
    const entry = oursList([...JOBS, extra]).find((e) => e.job === 'extraJob');
    expect(entry?.when).toBe('always');
    expect(renderOursList([...JOBS, extra])).toContain('extraJob');
  });

  it('keeps the jobs that move no money tipless and every money step tipped (the ticket list)', () => {
    for (const name of ['poke', 'executorTopUp', 'graduate', 'holderSettle', 'holderResidue', 'shopBurn', 'shopReturn'] as const) {
      expect(jobSpec(name).tip, name).toBe('none');
    }
    for (const name of ['collect', 'deepen', 'fail', 'failClosed'] as const) {
      expect(jobSpec(name).tip, name).not.toBe('none');
    }
    expect(JOBS.filter((j) => j.privately).map(j => j.name)).toEqual(['executeModule']);
  });

  it('gives each job its cost per run, in gas and in ETH at 1 gwei', () => {
    for (const entry of oursList(JOBS)) {
      expect(entry.gasPerRun > 0n, entry.job).toBe(true);
      expect(entry.ethPerRunAt1Gwei).toMatch(/^0\.\d+$/);
    }
    expect(oursList(JOBS).find((e) => e.job === 'poke')?.ethPerRunAt1Gwei).toBe('0.000062');
  });

  it('matches the published OURS.md (pnpm --filter @squarehole/keeper ours:write)', () => {
    expect(readFileSync(OURS_MD, 'utf8')).toBe(renderOursList(JOBS));
  });

  it('keeps the Solidity release-envelope fixture tied to the published keeper floor', () => {
    expect(readFileSync(new URL('../../contracts/test/box-v2/final/round3/PublishedGas.sol', import.meta.url), 'utf8'))
      .toBe(renderReleaseGas());
  });
});

it('publishes R62 alongside the unchanged fixed daily limits', () => {
  const text = renderOursList();
  for (const name of ['drandPostRound', 'drandRequestWord', 'backupStart', 'backupFix', 'R62-FEE', '50 gwei', '0.05 ETH', '72 hours', '0.102 ETH', '0.114 ETH']) expect(text).toContain(name);
  expect(text).toContain('R62-FEE allows drandPostRound, drandRequestWord,\nbackupStart and backupFix');
  expect(jobSpec('drandAcceptWord', 1)).toMatchObject({ tip: 'none', priority: 2, gasPerRun: 200000n,
    budget: 'ours', reserved: true, privately: false });
});

it.each(['backupStart', 'backupFix'] as const)('publishes %s as reserved tipless ours work with a 300,000 gas allowance', name => {
  expect(jobSpec(name, 1)).toMatchObject({ tip: 'none', priority: name === 'backupStart' ? 2 : 1, gasPerRun: 300000n,
    budget: 'ours', reserved: true, privately: false });
  const intro = renderOursList().split('| Job |')[0];
  expect(intro).toContain(name);
});

it('documents backup windows, proven headers and all four rescue jobs while preserving the poster pointer', () => {
  const poster = readFileSync(new URL('../../../docs/ops/drand-poster.md', import.meta.url), 'utf8');
  expect(poster.split('\n\n')[2]).toBe('The independent hourly poster and founder Ledger fallback are in [Never stuck](../runbooks/never-stuck.md).');
  expect(poster).toContain('## Backup jobs'); expect(poster).not.toContain('jobs are not built yet');
  for (const rule of ['96 seconds', '8,183', 'debug_getRawHeader', 'backup header mismatch']) expect(poster).toContain(rule);
  for (const file of ['../../../docs/ops/keeper.md', '../README.md']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const name of ['backupStart', 'backupFix']) expect(text).toContain(`\`${name}\``);
  }
});

it('documents the manual finality-stall deadline without widening keeper policy', () => {
  const poster = readFileSync(new URL('../../../docs/ops/drand-poster.md', import.meta.url), 'utf8');
  for (const rule of ['If finality stalls after a start', 'latest exceeds target + 8,183', 'keeper sends no fix by design',
    '[never stuck](../runbooks/never-stuck.md#backup-box-0-f143)', "target’s header from the latest chain",
    'accepting the reorg risk', 'before latest reaches target + 8,191', '96 seconds before the round’s earliest live deadline']) {
    expect(poster).toContain(rule);
  }
});

it('publishes the narrow F182 start exception and durable debt without a new setting', () => {
  const intro = renderOursList().split('| Job |')[0] ?? '';
  for (const text of ['F182', 'positive fee sale', 'whole signed cost', 'at most 0.05 ETH', 'zero call value',
    'not received income', 'charged as ours', 'Before broadcast', '24 hours and restarts', 'Unknown hashes never clear']) {
    expect(intro).toContain(text);
  }
  expect(intro).not.toContain('rates await the founder');
});
