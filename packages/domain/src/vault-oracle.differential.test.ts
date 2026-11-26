/**
 * v2 T05 differential test: the TypeScript vault ledger against the preserved Python integer oracle
 * (square-hole-core-v2/reference/v0_1/model.py, policy block_last). Python runs only on a scratch copy in the OS temp
 * directory with PYTHONDONTWRITEBYTECODE=1 and -B; nothing is written inside square-hole-core-v2/.
 *
 * Needs `python3` on PATH (standard library only), the same as `pnpm check:reference` in `pnpm verify`.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { conversionRate, ledgerTotals, sendFitToVault, withdrawMisfits } from './index';
import { createPrng } from './test-support/prng';
import { buildReferenceResults, freshVault, raw } from './test-support/vault-examples';
import {
  makeOracleCopy,
  manifestHash,
  ORACLE_DRIVER,
  ORACLE_FILES,
  readV2Text,
  runPython,
  sha256File,
  V2_ROOT,
  type OracleCopy,
} from './test-support/vault-oracle';
import { generateTrace, type Trace, type TraceStep } from './test-support/vault-traces';

const SEED = 0x7005_d1ff;
const SMALL_TRACES = 400;
const SMALL_OPS = 40;
const LARGE_TRACES = 3;
const LARGE_OPS = 12;

let copy: OracleCopy | undefined;
const oracle = (): OracleCopy => {
  if (!copy) throw new Error('oracle copy missing');
  return copy;
};

beforeAll(() => {
  copy = makeOracleCopy();
});
afterAll(() => copy?.cleanup());

describe('v2 oracle on a scratch copy', () => {
  it('the copy lives outside the handoff and every file matches MANIFEST.sha256', () => {
    const { root } = oracle();
    expect(relative(V2_ROOT, root).startsWith('..')).toBe(true);
    for (const file of ORACLE_FILES) expect(sha256File(join(root, file))).toBe(manifestHash(file));
  });

  it('check_examples.py rewrites reference-results.json byte for byte, and the TypeScript re-run equals it', () => {
    const { root } = oracle();
    const run = runPython([join(root, 'reference/check_examples.py')], { cwd: root });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('EX01–EX08: selected reference checks passed');
    const rewritten = readFileSync(join(root, 'examples/reference-results.json'), 'utf8');
    expect(rewritten).toBe(readV2Text('examples/reference-results.json'));
    expect(buildReferenceResults()).toEqual(JSON.parse(rewritten));
  });

  it(
    'random traces: every outcome, quote and state matches the oracle raw unit for raw unit',
    () => {
      const prng = createPrng(SEED);
      const generated = [
        ...Array.from({ length: SMALL_TRACES }, () => generateTrace(prng, { collectionSize: 1 + prng.int(40), ops: SMALL_OPS })),
        ...Array.from({ length: LARGE_TRACES }, () => generateTrace(prng, { collectionSize: 10_000, ops: LARGE_OPS })),
      ];
      const traces: Trace[] = generated.map((g) => g.trace);
      const run = runPython([ORACLE_DRIVER, oracle().modelPath], { input: JSON.stringify({ traces }) });
      expect(run.status, run.stderr).toBe(0);
      const result = JSON.parse(run.stdout) as { traces: { steps: TraceStep[] }[] };
      expect(result.traces).toHaveLength(traces.length);

      const seen = new Map<string, number>();
      generated.forEach(({ trace, steps }, t) => {
        const pySteps = result.traces[t]?.steps ?? [];
        expect(pySteps).toHaveLength(steps.length);
        steps.forEach((step, s) => {
          const py = pySteps[s];
          if (!isDeepStrictEqual(step, py)) {
            expect(step, `trace ${t} step ${s} op ${JSON.stringify(trace.ops[s])}`).toEqual(py);
          }
          const op = trace.ops[s]?.op ?? '?';
          const key = 'error' in step.outcome ? `${op}:${step.outcome.error}` : `${op}:ok`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        });
      });

      // Coverage: every operation succeeds somewhere, and every reachable refusal is exercised.
      for (const op of ['withdraw', 'return', 'transferMisfit', 'transferFit', 'sendFitToVault', 'burn', 'accrue', 'claim']) {
        expect(seen.get(`${op}:ok`) ?? 0, op).toBeGreaterThan(10);
      }
      for (const key of [
        'withdraw:invalid_quantity',
        'withdraw:last_misfit',
        'withdraw:max_fit_exceeded',
        'withdraw:insufficient_fit',
        'withdraw:ineligible_ids',
        'return:invalid_id_list',
        'return:not_owner',
        'return:min_fit_not_met',
        'transferMisfit:not_owner',
        'burn:insufficient_fit',
        'burn:dust_guard',
        'accrue:stream_not_funded',
        'accrue:dust_guard',
      ]) {
        expect(seen.get(key) ?? 0, key).toBeGreaterThan(0);
      }
    },
    shLimit(180_000),
  );

  it('F23 departs from the oracle literal raw-balance donation on purpose: the oracle lowers r, the ledger does not', () => {
    const script = [
      'import importlib.util, json, sys',
      "spec = importlib.util.spec_from_file_location('sh_v2_oracle_model', sys.argv[1])",
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      "v = m.Vault({'alice': m.raw(900_000_000), 'fees': m.raw(100_000_000)}, empty_policy='block_last')",
      "v.withdraw('alice', 5000)",
      "v.donate_fit_to_escrow('fees', m.raw(10_000_000))",
      "print(json.dumps({'num': str(v.rate.numerator), 'den': str(v.rate.denominator), 'escrow': str(v.escrow)}))",
    ].join('\n');
    const run = runPython(['-c', script, oracle().modelPath]);
    expect(run.status, run.stderr).toBe(0);
    const literal = JSON.parse(run.stdout) as { num: string; den: string; escrow: string };
    expect(literal).toEqual({ num: raw(98_000n).toString(), den: '1', escrow: raw(510_000_000n).toString() });

    let v = withdrawMisfits(freshVault(), { owner: 'alice', count: 5000 }).ledger;
    v = sendFitToVault(v, 'fees', raw(10_000_000n));
    expect(conversionRate(ledgerTotals(v))).toEqual({ num: raw(100_000n), den: 1n });
    expect(v.escrow + v.unsolicited).toBe(raw(510_000_000n));
  });
});
