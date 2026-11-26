/**
 * v2 T06 differential trace harness, Python oracle side (acceptance VLT-06, VLT-08, SIM-01; schema v2 since the
 * placeholder tickets, stage 1: the adapter replays a take as a withdrawal of the reserved IDs plus a burn of the fee).
 *
 * Runs `scripts/vault-trace-oracle-diff.py`, which copies the preserved oracle (square-hole-core-v2/reference/v0_1/
 * model.py) into a fresh temp directory, checks the copy against MANIFEST.sha256, replays each trace there and
 * compares every outcome and raw integer. Needs `python3` (standard library only), as `pnpm check:reference` does.
 */
import { existsSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { REPO_ROOT } from './test-support/handoff';
import { manifestHash, runPython, V2_ROOT } from './test-support/vault-oracle';
import { CANONICAL_DIR, committedCorpus, extendedCorpus } from './test-support/vault-trace/corpus';
import { serializeVaultTrace, type VaultTrace } from './test-support/vault-trace/format';

const SCRIPT = `${REPO_ROOT}scripts/vault-trace-oracle-diff.py`;

interface OracleReport {
  readonly oracle: { readonly file: string; readonly sha256: string; readonly scratchCopy: string; readonly scratchRemoved: boolean };
  readonly traces: number;
  readonly steps: number;
  readonly policies: Record<string, number>;
  readonly fees: Record<string, number>;
  readonly outcomes: Record<string, number>;
  readonly mismatchCount: number;
  readonly mismatches: readonly { trace: string; path: string; expected: unknown; actual: unknown }[];
}

function runOracle(args: readonly string[], input?: string): { status: number | null; report: OracleReport; stderr: string } {
  const run = runPython([SCRIPT, '--json', ...args], { input, cwd: REPO_ROOT });
  if (run.stdout.trim() === '') throw new Error(`oracle script printed nothing (status ${run.status}): ${run.stderr}`);
  return { status: run.status, report: JSON.parse(run.stdout) as OracleReport, stderr: run.stderr };
}

const stdinOf = (traces: readonly VaultTrace[]): string => JSON.stringify({ traces: traces.map((t) => JSON.parse(serializeVaultTrace(t)) as unknown) });

function expectScratchHygiene(report: OracleReport): void {
  expect(report.oracle.file).toBe('reference/v0_1/model.py');
  expect(report.oracle.sha256).toBe(manifestHash('reference/v0_1/model.py'));
  expect(relative(V2_ROOT, report.oracle.scratchCopy).startsWith('..')).toBe(true);
  expect(report.oracle.scratchRemoved).toBe(true);
  expect(existsSync(report.oracle.scratchCopy)).toBe(false);
}

describe('Python oracle replay of the trace corpora', () => {
  it('the committed canonical traces agree with the oracle on every outcome and raw integer', () => {
    const { status, report, stderr } = runOracle([`${REPO_ROOT}${CANONICAL_DIR}`]);
    expect(report.mismatches, stderr).toEqual([]);
    expect(status).toBe(0);
    expect(report.traces).toBe(committedCorpus().length);
    expect(report.steps).toBe(1472);
    expect(report.policies).toEqual({ 'quote-neutral': 47, 'raw-balance': 8 });
    expect(report.fees).toEqual({ 'flat-f23': 27, none: 28 });
    for (const key of ['take:ok', 'take:no_hidden', 'take:dust_guard', 'release:ok', 'deliver:ok', 'deliver:gate_closed', 'withdraw:ok', 'withdraw:hidden_misfit', 'return:ok', 'return:not_revealed', 'transferTicket:ok', 'waiveHandBackFee:ok', 'waiveHandBackFee:fee_already_waived', 'waiveHandBackFee:gate_already_open']) {
      expect(report.outcomes[key] ?? 0, key).toBeGreaterThan(0);
    }
    expectScratchHygiene(report);
  }, shLimit(120_000));

  it('the extended in-memory corpus (758 traces) agrees with the oracle too', () => {
    const traces = extendedCorpus();
    const { status, report, stderr } = runOracle(['-'], stdinOf(traces));
    expect(report.mismatches, stderr).toEqual([]);
    expect(status).toBe(0);
    expect(report.traces).toBe(758);
    expect(report.steps).toBe(26_814);
    expect(report.outcomes['sendMisfitToVault:unsolicited_misfit'] ?? 0).toBeGreaterThan(100);
    expect(report.outcomes['sendFitToVault:dust_guard'] ?? 0).toBeGreaterThan(0);
    expectScratchHygiene(report);
  }, shLimit(180_000));

  it('a one-raw-unit change in a trace is reported as a disagreement (exit 1, with its path)', () => {
    const [trace] = committedCorpus().filter((t) => t.id === 'ex02');
    if (!trace) throw new Error('ex02 missing');
    const step = trace.steps[1];
    if (!step) throw new Error('ex02 step 1 missing');
    const tampered: VaultTrace = {
      ...trace,
      steps: trace.steps.map((s, i) => (i === 1 ? { ...step, state: { ...step.state, burned: (BigInt(step.state.burned) + 1n).toString() } } : s)),
    };
    const { status, report } = runOracle(['-'], stdinOf([tampered]));
    expect(status).toBe(1);
    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0]).toMatchObject({ trace: 'ex02', path: 'steps.1.state.burned' });
  }, shLimit(60_000));

  it('refuses to load the oracle from inside square-hole-core-v2/ and leaves no bytecode there', () => {
    const run = runPython([SCRIPT, '--oracle', `${V2_ROOT}reference/v0_1/model.py`, `${REPO_ROOT}${CANONICAL_DIR}/ex01.json`], { cwd: REPO_ROOT });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('refusing to load the oracle from inside square-hole-core-v2/');
    const caches = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? (entry.name === '__pycache__' ? [`${dir}/${entry.name}`] : caches(`${dir}/${entry.name}`)) : [],
      );
    expect(caches(`${V2_ROOT}reference`)).toEqual([]);
    expect(existsSync(`${REPO_ROOT}scripts/__pycache__`)).toBe(false);
  });
});
