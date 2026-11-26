import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadInputs, repoDir } from '../scripts/lib/conformance.mjs';
import type { CoverageV2, TestIdV2 } from '../scripts/lib/conformance-v2.mjs';
import {
  V2_PATHS, checkCasesV2, checkCoverageV2, coverageRowsV2, renderReportV2, v2Scripts, v2TestFiles,
} from '../scripts/lib/conformance-v2.mjs';

const { allCases, minN } = loadInputs();
const coverage = JSON.parse(readFileSync(join(repoDir, V2_PATHS.coverage), 'utf8')) as CoverageV2;
const opts = { files: v2TestFiles(), scripts: v2Scripts(coverage) };
const live = [253, 254, 255, 256, 257, 259, 261, 262, 263, 264, 266, 267, 268, 270];
const retired = [258, 260, 265, 269];
const row = (n: number) => allCases.find((c) => c.id === `BC-${n}`);
const requiredRow = (n: number) => {
  const c = row(n);
  if (!c) throw new Error(`missing BC-${n}`);
  return c;
};
const pileFile = `${V2_PATHS.testDir}/m3-30/PileVault.t.sol`;

describe('M3-01 fix round: allocated cases, decisions and implementation mappings', () => {
  it.each(live)('preserves the meaning and named implementation coverage of BC-%i', (n) => {
    const c = row(n);
    expect(c, `BC-${n}`).toMatchObject({ core: 'v2', slice: 'M3', gate: 'G0' });
    expect(c?.source).toContain('ADR-0017 Amendment 3');
    expect(c?.restated).toContain('F119');
    expect(c?.withdrawn).toBeUndefined();
    expect(coverage.tickets[c?.ticket ?? '']?.milestone).toBe('M3');
    const tests = coverage.cases[`BC-${n}`]?.tests ?? [];
    expect(tests.length).toBeGreaterThan(0);
    for (const t of tests) {
      if (n === 266 && t.ticket === 'SH-V21-02-PAY-IN-T') expect(t.file).toMatch(/packages\/contracts\/test\/box-v2\/pay-in-t\//);
      else if ([263, 264, 266].includes(n) && t.ticket === 'SH-V21-03-PILE-FEES') expect(t.file).toMatch(/packages\/contracts\/test\/box-v2\/pile-fees\//);
      else expect(t.file).toMatch(/packages\/contracts\/test\/box-v2\/m3-/);
    }
  });

  it.each(retired)('retains removed BC-%i with a decision, without assigning a replacement test', (n) => {
    expect(row(n)).toMatchObject({ core: 'v2', slice: 'M3' });
    expect(row(n)?.withdrawn).toMatch(/F119/);
    expect(row(n)?.ticket).toBeUndefined();
    expect(coverage.cases[`BC-${n}`]).toBeUndefined();
  });

  it('loads the allocated ranges and still rejects gaps, duplicates, v1 rows and unallocated ids', () => {
    expect(checkCasesV2(allCases, coverage, { minN })).toEqual([]);
    for (const n of [230, 253, 258, 270]) {
      const id = `BC-${n}`;
      const missing = allCases.filter((c) => c.id !== id);
      expect(checkCasesV2(missing, coverage, { minN }).some((e) => e.startsWith(`[v2-ids] ${id}: missing`))).toBe(true);
    }
    for (const id of ['BC-239', 'BC-252', 'BC-271', 'BC-999', 'BC-1000']) {
      const extra = [...allCases, { ...requiredRow(238), id }];
      expect(checkCasesV2(extra, coverage, { minN }).some((e) => e.startsWith(`[v2-ids] ${id}:`))).toBe(true);
    }
    expect(checkCasesV2([...allCases, { ...requiredRow(253) }], coverage, { minN })).toContain('[v2-ids] BC-253: id twice');
    const wrongCore = allCases.map((c) => c.id === 'BC-253' ? { ...c, core: undefined } : c);
    expect(checkCasesV2(wrongCore, coverage, { minN }).some((e) => e.includes('BC-253: a v1 case'))).toBe(true);
  });

  it('requires every surviving M3 case to map tests, including when only its mapping is removed', () => {
    expect(checkCoverageV2(allCases, coverage, opts)).toEqual([]);
    for (const n of live) {
      const broken = structuredClone(coverage);
      Reflect.deleteProperty(broken.cases, `BC-${n}`);
      expect(checkCoverageV2(allCases, broken, opts).some((e) => e.startsWith(`[unmapped] BC-${n} `))).toBe(true);
    }
  });

  it('maps existing non-BC implementation tests only when their exact function exists in the named file', () => {
    const mapped = structuredClone(coverage);
    mapped.cases['BC-238'] = { tests: [{ file: pileFile, name: 'test_R10_exactSeedOnceAndImmutableWiring', implementation: true } as TestIdV2] };
    expect(checkCoverageV2(allCases, mapped, opts)).toEqual([]);
    const result = coverageRowsV2(allCases, mapped, opts).find((r) => r.id === 'BC-238');
    expect(result?.tests[0]?.state).toBe('written');
    for (const test of [
      { file: pileFile, name: 'test_R10_typo', implementation: true },
      { file: `${V2_PATHS.testDir}/m3-30/Missing.t.sol`, name: 'test_R10_exactSeedOnceAndImmutableWiring', implementation: true },
      { file: pileFile, name: 'test_BC263_wrongCase', implementation: true },
    ]) {
      mapped.cases['BC-238'] = { tests: [test as TestIdV2] };
      expect(checkCoverageV2(allCases, mapped, opts).some((e) => e.startsWith('[v2-test] BC-238:'))).toBe(true);
    }
    mapped.cases['BC-238'] = { tests: [{ file: pileFile, name: 'test_R10_commentedOut', implementation: true } as TestIdV2] };
    const commented = opts.files.map((f) => f.path === pileFile ? { ...f, source: `${f.source}\n// function test_R10_commentedOut() public {}` } : f);
    expect(checkCoverageV2(allCases, mapped, { ...opts, files: commented }).some((e) => e.startsWith('[v2-test] BC-238:'))).toBe(true);
  });

  it('states exact tickets, P-only funding, current ownership, seed-only piles and the revised failure route', () => {
    const words = (n: number) => JSON.stringify(row(n));
    for (const n of [253, 254, 270]) expect(words(n)).toMatch(/ticket identity|exact ticket/);
    expect(words(255)).toMatch(/drawn items/);
    expect(words(256)).toMatch(/stash/);
    expect(words(257)).toMatch(/EIP-7702/);
    expect(words(257)).toMatch(/no ERC-6909.*fallback/);
    expect(words(259)).toMatch(/collectionSize/);
    expect(words(262)).toMatch(/40 P/);
    expect(words(263)).toMatch(/seed only/);
    expect(words(263)).toMatch(/pre-burn/);
    expect(words(264)).toMatch(/held item P.*pot/);
    expect(words(264)).toMatch(/F122 R36C/);
    expect(words(264)).toMatch(/F123/);
    expect(words(267)).toMatch(/role 19/);
    expect(words(268)).toMatch(/no ledger call/);
    for (const n of live) expect(words(n)).not.toMatch(/held item[^.;]*to FIT|burn P|onItemFunds/);
  });

  it('reports M3 and distinguishes planned item tests from written pile implementation tests', () => {
    const rows = coverageRowsV2(allCases, coverage, opts);
    expect(rows.find((r) => r.id === 'BC-253')?.tests.some((t) => t.state === 'planned')).toBe(true);
    expect(rows.find((r) => r.id === 'BC-263')?.tests.some((t) => t.state === 'written')).toBe(true);
    expect(renderReportV2(allCases, coverage, opts)).toMatch(/M3: 14 cases/);
    expect(renderReportV2(allCases, coverage, opts)).toContain('BC-253 to BC-270');
  });
});

interface M3Vectors {
  tickets: { caseId: string; starts: string[]; end: string; delivered: string[]; cancelled: string[]; credits: string[]; residue: string }[];
  stashes: { caseId: string; receipt: string; count: string; credits: string[]; residue: string }[];
  piles: { caseId: string; decimals: number; seed: string; supply: string; inputs: string[]; payouts: string[] }[];
}

describe('M3 independent raw-unit vectors', () => {
  const vectors = JSON.parse(readFileSync(join(repoDir, 'packages/box-spec/vectors/cases.v2.json'), 'utf8')) as { m3?: M3Vectors };
  const requiredVectors = () => {
    if (!vectors.m3) throw new Error('missing M3 vectors');
    return vectors.m3;
  };
  it('pins both same-second delivery orders and each cancellation without averaging ticket starts', () => {
    expect(vectors.m3?.tickets).toHaveLength(4);
    for (const v of requiredVectors().tickets) {
      expect(v.caseId).toBe('BC-270');
      expect(v.starts).toEqual(['10', '20']);
      expect(v.end).toBe('30');
      const credit = v.starts.map((s) => BigInt(v.end) - BigInt(s));
      expect(v.credits).toEqual(credit.map((c, i) => v.cancelled.includes(String(i)) ? '0' : c.toString()));
      expect(v.residue).toBe(credit.reduce((a, c, i) => a + (v.cancelled.includes(String(i)) ? c : 0n), 0n).toString());
      expect([...v.delivered, ...v.cancelled].sort()).toEqual(['0', '1']);
    }
  });
  it('splits retained graduation receipts across all items and sends rounding to residue', () => {
    expect(vectors.m3?.stashes).toHaveLength(1);
    for (const v of requiredVectors().stashes) {
      expect(v.caseId).toBe('BC-255');
      expect(BigInt(v.credits.length)).toBe(BigInt(v.count));
      for (const c of v.credits) expect(BigInt(c)).toBe(BigInt(v.receipt) / BigInt(v.count));
      expect(v.credits.reduce((sum, c) => sum + BigInt(c), BigInt(v.residue))).toBe(BigInt(v.receipt));
    }
  });
  it('redeems the pre-burn pile proportion with no leave-behind in 6/8/18 decimals and above safe integer range', () => {
    expect(vectors.m3?.piles.map((v) => v.decimals)).toEqual([6, 8, 18]);
    for (const v of requiredVectors().piles) {
      expect(v.caseId).toBe('BC-263');
      let pile = BigInt(v.seed), supply = BigInt(v.supply);
      v.inputs.forEach((s, i) => {
        const amount = BigInt(s), paid = pile * amount / supply;
        expect(paid.toString()).toBe(v.payouts[i]);
        pile -= paid; supply -= amount;
      });
      expect([pile, supply]).toEqual([0n, 0n]);
    }
  });
});
