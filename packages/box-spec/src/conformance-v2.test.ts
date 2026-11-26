/**
 * Core v2 M1-01: the v2 conformance cases (BC-144 to BC-237 and the v1 cases restated for v2) and their coverage map,
 * packages/box-spec/conformance/coverage.v2.json (core-v2-m1-tickets.md § 2 M1-01 and § 3 on sh-core-v2-m1). Each rule
 * is shown to pass on the committed files and to fail on a copy that breaks it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConformanceCase, SolidityFile } from '../scripts/lib/conformance.mjs';
import { PATHS, checkCoverage, loadInputs, repoDir, solidityFiles, sourceScripts } from '../scripts/lib/conformance.mjs';
import type { CoverageV2 } from '../scripts/lib/conformance-v2.mjs';
import {
  DECISION_BASE,
  PLAN_BASE,
  PLAN_COUNT,
  V2_FIRST,
  V2_LAST,
  V2_PATHS,
  checkCasesV2,
  checkCoverageV2,
  coverageRowsV2,
  renderReportV2,
  v2Rows,
  v2Scripts,
  v2TestFiles,
  writtenV2Checks,
} from '../scripts/lib/conformance-v2.mjs';

const { cases, allCases, minN } = loadInputs();
const coverage = JSON.parse(readFileSync(join(repoDir, V2_PATHS.coverage), 'utf8')) as CoverageV2;
const files = v2TestFiles();
const scripts = v2Scripts(coverage);
const copyCases = () => structuredClone(allCases) as ConformanceCase[];
const copyMap = () => structuredClone(coverage);
const byId = (c: ConformanceCase[], id: string) => {
  const x = c.find((k) => k.id === id);
  if (!x) throw new Error(`no ${id}`);
  return x;
};
const rules = (c: ConformanceCase[], m: CoverageV2 = coverage) => checkCasesV2(c, m, { minN });
const tagged = (errors: string[], rule: string, id: string) => errors.some((e) => e.startsWith(`[${rule}] ${id}`));
const num = (id: string) => Number(id.slice(3));

it.each(['BC-203', 'BC-257'])('F127: %s promises owner claims without pushed payouts', (id) => {
  const c = byId(allCases, id);
  expect(c.then).toContain('claimFor is removed');
  expect(c.then).toContain('no minimum or tip');
  expect(c.then).toContain('preserves credit for retry');
  expect(c.restated).toContain('F127');
});

describe('v2 case file: the loader rules (M1-01)', () => {
  it('the committed case file passes every v2 rule', () => {
    expect(rules(allCases)).toEqual([]);
  });

  it('keeps the original range and the allocated M3 range beside 143 unchanged v1 cases', () => {
    const v2 = allCases.filter((c) => c.core === 'v2');
    expect(cases).toHaveLength(143);
    expect(V2_LAST).toBe(270);
    expect(v2.map((c) => num(c.id))).toEqual([
      ...Array.from({ length: 238 - V2_FIRST + 1 }, (_, i) => V2_FIRST + i),
      ...Array.from({ length: 18 }, (_, i) => 253 + i),
    ]);
    expect(v2.filter((c) => c.withdrawn).map((c) => c.id)).toEqual(['BC-178', 'BC-179', 'BC-180', 'BC-181', 'BC-204', 'BC-205', 'BC-209', 'BC-210', 'BC-211', 'BC-212', 'BC-217', 'BC-224', 'BC-258', 'BC-260', 'BC-265', 'BC-269']);
    const restated = cases.filter((c) => c.v2).map((c) => c.id);
    expect(restated).toEqual(['BC-036', 'BC-040', 'BC-045', 'BC-046', 'BC-055', 'BC-100', 'BC-109', 'BC-110', 'BC-111', 'BC-115', 'BC-125', 'BC-126', 'BC-128', 'BC-129', 'BC-130', 'BC-131', 'BC-133']);
    const rows = v2Rows(allCases);
    expect(rows).toHaveLength(95 + 17 + 18);
    // M1: 34 Link Marines cases, BC-206, 23 of N01-N29, the 3 cases later decisions added and the 17 restated;
    // M2: 4 + 24 + 5 (N03-N06, N11).
    expect(rows.filter((r) => r.slice === 'M1' && !r.withdrawn)).toHaveLength(34 + 1 + 23 + 3 + 17);
    expect(rows.filter((r) => r.slice === 'M2')).toHaveLength(4 + 24 + 5);
  });

  it('maps the spin-off ids by § 3: Link Marines BC-NEW-n to BC-(143+n), the Junkyard in its listed order from BC-182', () => {
    for (let n = 1; n <= 38; n += 1) {
      const c = byId(allCases, `BC-${143 + n}`);
      expect(c.spinoff, c.id).toMatchObject({ project: 'link-marines', id: `BC-NEW-${n}` });
    }
    const jy = [18, 21, ...Array.from({ length: 23 }, (_, i) => 30 + i)];
    jy.forEach((n, i) => expect(byId(allCases, `BC-${182 + i}`).spinoff).toMatchObject({ project: 'junkyard', id: `BC-NEW-${n}` }));
    // Every Junkyard case is M2's but BC-206 (ETH into PAXG, the v2-pair hop, F90 R16D).
    for (let i = 182; i <= 206; i += 1) expect(byId(allCases, `BC-${i}`).slice, `BC-${i}`).toBe(i === 206 ? 'M1' : 'M2');
    const c = copyCases();
    byId(c, 'BC-150').spinoff = { project: 'link-marines', id: 'BC-NEW-8', file: 'x' };
    expect(tagged(rules(c), 'v2-spinoff', 'BC-150')).toBe(true);
  });

  it("restates Link Marines' lock and royalty cases in recipe terms, each change in `restated` (§ 3; M1-40, M1-44)", () => {
    // ICR-LM-002 (the lock) and ICR-LM-006 (royalties): LM's processor, lock and ethFunded fields have no v2 meaning.
    const lm = allCases.filter((c) => c.spinoff?.project === 'link-marines' && ['ICR-LM-002', 'ICR-LM-006'].includes(c.spinoff.icr ?? ''));
    const ids = [...Array.from({ length: 11 }, (_, i) => `BC-${144 + i}`), 'BC-163', 'BC-173', 'BC-174', 'BC-177'];
    expect(lm.map((c) => c.id)).toEqual(ids);
    for (const c of lm) {
      expect(c.restated ?? '', c.id).toMatch(/\bF\d+\b|ADR-0017|SH-RC5-C-ROYALTY-COW/);
      // F136's retained money is locked; it is not LM's removed lock/processor accounting.
      const prose = [c.title, c.given, c.when, c.then].join(' ')
        .replace(/money after the last holder claim stays locked/g, '');
      expect(prose, c.id).not.toMatch(/\b(lock\w*|totalLocked|royaltyEthFunded|ethFunded|Q-share)\b/i);
    }
  });

  it('numbers the plan cases N01 to N29 as BC-207 to BC-235, N18 withdrawn by F90 R16J', () => {
    for (let k = 1; k <= 29; k += 1) expect(byId(allCases, `BC-${206 + k}`).plan).toBe(`N${String(k).padStart(2, '0')}`);
    expect(byId(allCases, 'BC-224').withdrawn).toMatch(/F90 R16J/);
    const c = copyCases();
    byId(c, 'BC-210').plan = 'N05';
    const errors = rules(c);
    expect(tagged(errors, 'v2-plan', 'BC-210')).toBe(true);
  });

  it('numbers the cases later decisions add from BC-236, each naming the decision its source cites (tickets § 9)', () => {
    expect(DECISION_BASE).toBe(PLAN_BASE + PLAN_COUNT);
    expect(byId(allCases, 'BC-236').decision).toBe('F101 R22A');
    expect(byId(allCases, 'BC-237').decision).toBe('F104');
    expect(byId(allCases, 'BC-238').decision).toBe('F106');
    for (const id of ['BC-236', 'BC-237', 'BC-238']) {
      const c = byId(allCases, id);
      expect(c.plan, id).toBeUndefined();
      expect(c.spinoff, id).toBeUndefined();
      expect(c.source, id).toContain(String(c.decision));
    }
    let c = copyCases();
    delete byId(c, 'BC-236').decision;
    expect(tagged(rules(c), 'v2-decision', 'BC-236')).toBe(true);
    c = copyCases();
    byId(c, 'BC-237').decision = 'F999';
    expect(tagged(rules(c), 'v2-decision', 'BC-237')).toBe(true);
    c = copyCases();
    byId(c, 'BC-237').decision = 'the founder said so';
    expect(tagged(rules(c), 'v2-decision', 'BC-237')).toBe(true);
    c = copyCases();
    byId(c, 'BC-215').decision = 'F96 R20B';
    expect(tagged(rules(c), 'v2-decision', 'BC-215')).toBe(true);
    c = copyCases();
    byId(c, 'BC-237').plan = 'N30';
    expect(tagged(rules(c), 'v2-plan', 'BC-237')).toBe(true);
  });

  it('ties each case to one ticket of its milestone (M2 cases to M2 parts, § 6)', () => {
    let c = copyCases();
    byId(c, 'BC-215').ticket = 'M1-99';
    expect(tagged(rules(c), 'v2-ticket', 'BC-215')).toBe(true);
    c = copyCases();
    byId(c, 'BC-215').ticket = 'M2:dead-routes';
    expect(tagged(rules(c), 'v2-ticket', 'BC-215')).toBe(true);
    c = copyCases();
    const restated = byId(c, 'BC-129').v2;
    if (!restated) throw new Error('BC-129 is restated');
    restated.ticket = '';
    expect(tagged(rules(c), 'v2-shape', 'BC-129')).toBe(true);
    // The removed M2 routes remain historical cases, never replacement meanings.
    const m2: [string, string][] = [['BC-209', 'M2:gifts'], ['BC-210', 'M2:leg-target'], ['BC-211', 'M2:leg-target'], ['BC-212', 'M2:leg-target'], ['BC-217', 'M2:dead-routes']];
    for (const [id] of m2) {
      expect(byId(allCases, id).ticket, id).toBeUndefined();
      expect(byId(allCases, id).withdrawn, id).toMatch(/F119|F120/);
    }
  });

  it('refuses malformed v2 cases: box 0 or "all" as appliesTo, a missing then, an id gap, a v1 case in the v2 range', () => {
    let c = copyCases();
    byId(c, 'BC-207').appliesTo = 'all';
    byId(c, 'BC-208').appliesTo = ['T0'];
    delete (byId(c, 'BC-199') as Partial<ConformanceCase>).then;
    const errors = rules(c);
    expect(tagged(errors, 'v2-shape', 'BC-207')).toBe(true);
    expect(tagged(errors, 'v2-shape', 'BC-208')).toBe(true);
    expect(tagged(errors, 'v2-shape', 'BC-199')).toBe(true);
    c = copyCases().filter((x) => x.id !== 'BC-230');
    expect(rules(c).some((e) => e.startsWith('[v2-ids] BC-230'))).toBe(true);
    c = copyCases();
    delete byId(c, 'BC-150').core;
    expect(rules(c).some((e) => e.startsWith('[v2-ids] BC-150'))).toBe(true);
    c = copyCases();
    (byId(c, 'BC-218').params as Record<string, unknown>).N = [9];
    expect(tagged(rules(c), 'factory-n', 'BC-218')).toBe(true);
  });

  it('records every newer spin-off case as mapped into a case that cites it, or withdrawn by a decision', () => {
    const ids = coverage.dispositions.map((d) => `${d.project} ${d.id}`);
    for (const id of ['junkyard BC-NEW-53', 'junkyard BC-NEW-54', 'junkyard BC-NEW-55', 'link-marines LM004-RETURN-1', 'link-marines LM004-RETURN-2', 'link-marines LM004-SIZE-1', 'link-marines LM004-CAP-1', 'link-marines LM004-DRIFT-1', 'link-marines LM004-REFILL-1', 'link-marines LM004-REBUY-1']) {
      expect(ids).toContain(id);
    }
    let m = copyMap();
    const drift = m.dispositions.find((d) => d.id === 'LM004-DRIFT-1');
    if (!drift) throw new Error('DRIFT-1');
    drift.withdrawn = 'because';
    expect(rules(allCases, m).some((e) => e.startsWith('[v2-disposition] link-marines LM004-DRIFT-1'))).toBe(true);
    m = copyMap();
    const cap = m.dispositions.find((d) => d.id === 'LM004-CAP-1');
    if (!cap) throw new Error('CAP-1');
    cap.into = 'BC-208';
    expect(rules(allCases, m).some((e) => e.startsWith('[v2-disposition] link-marines LM004-CAP-1'))).toBe(true);
  });
});

describe('the case texts follow ADR-0017 as accepted (F96; tickets § 2 M1-01, before its merge)', () => {
  const words = (r: { title: string; given: string; when: string; then: string }) => [r.title, r.given, r.when, r.then].join(' ');
  const text = (id: string) => {
    const c = byId(allCases, id);
    const row = c.core === 'v2' ? c : c.v2;
    if (!row) throw new Error(`${id} has no v2 text`);
    return words(row);
  };
  // § 8's one clock rule: 30 days from the first failed attempt after max(the direction's last success, the ledger's
  // or branch's own last success, its empty-to-funded time); never from silence, never from funding alone.
  const SILENCE =
    /no (successful )?(step|success|run) for 30 days|30 days with no (successful )?(step|success|run)|30 days (pass )?after (the branch was )?fund(ed|ing)|funded from empty starts its own clock|\+ 30 days|reset neither clock|30 more days pass with no|inactivity/i;

  it("§ 8's clock: the 30 days run from a failed attempt, never from silence or from funding", () => {
    for (const id of ['BC-175', 'BC-178', 'BC-205', 'BC-210', 'BC-212', 'BC-215', 'BC-217']) {
      expect(text(id), id).not.toMatch(SILENCE);
      expect(text(id), id).toMatch(/failed (attempt|run)/);
    }
    for (const row of v2Rows(allCases)) expect(words(row), row.id).not.toMatch(SILENCE);
    expect(text('BC-175')).toMatch(/empty-to-funded time/);
    expect(text('BC-175')).toMatch(/deadSince\(direction\)/);
    expect(text('BC-215')).toMatch(/deadSince/);
    expect(text('BC-217')).toMatch(/returnStalled\(box, purpose, origin, branch\)/);
    expect(text('BC-177')).not.toMatch(/clocks are unchanged/);
  });

  it("§ 8's sale: the quote is max(S, A) × decay, and it fills only while A counts from hops that passed their depth floor", () => {
    expect(text('BC-179')).toMatch(/max\(S, A\) × decay/);
    expect(text('BC-179')).not.toMatch(/starts at 4x shared anchor/);
    expect(text('BC-180')).not.toMatch(/pool-health gate/);
    expect(text('BC-180')).toMatch(/floor at start-of-block liquidity/);
  });

  it("F136 supersedes § 5's old Depth-to-FIT failure row with the P claim pot", () => {
    for (const id of ['BC-046', 'BC-226']) {
      expect(text(id), id).toMatch(/DEPTH_BRANCH[^.]*go to CLOSING_POOL/);
      expect(text(id), id).toMatch(/coordinator's (P claim pot|claim pot in P)/);
      expect(text(id), id).not.toMatch(/held for Depth[^;]* to FIT/);
    }
  });
});

describe("change queue 1 and M1-00's second review (sh-v2-cq-1 676e21d7, sh-v2-m1-00 56e6e18c; before M1-01's merge)", () => {
  const words = (r: { title: string; given: string; when: string; then: string }) => [r.title, r.given, r.when, r.then].join(' ');
  const rowOf = (id: string) => {
    const c = byId(allCases, id);
    const row = c.core === 'v2' ? c : c.v2;
    if (!row) throw new Error(`${id} has no v2 text`);
    return row;
  };
  const text = (id: string) => words(rowOf(id));
  const all = (id: string) => JSON.stringify(rowOf(id));
  const rows = v2Rows(allCases);

  it('F99, F100: no v2 case, ticket title or report prose says "refund"; a failed box pays the closing price from its closing pool', () => {
    // Every field of every v2 row (titles, texts, params, sources, notes); v1's own texts keep v1's words (box 0 is pinned).
    for (const row of rows) expect(JSON.stringify(row), row.id).not.toMatch(/refund/i);
    for (const [id, t] of Object.entries(coverage.tickets)) expect(t.title, id).not.toMatch(/refund/i);
    // This exact test identifier describes unused live shop fees returned to original trade holders.
    // It is not failure-claim terminology. Keep every case, title and all other report text under F99/F100.
    const report = readFileSync(join(repoDir, V2_PATHS.report), 'utf8');
    expect(report.replaceAll('`testFuzz_SF08_partialPurchasesRefundEveryBatchWithoutRoundingLoss`', '')).not.toMatch(/refund/i);
    expect(coverage.tickets['M1-31']?.title).toBe('Deadline, fail() and the closing pool');
    for (const id of ['BC-046', 'BC-110', 'BC-226']) {
      expect(text(id), id).toMatch(/closing pool/);
      expect(text(id), id).toMatch(/closing price/);
    }
    // The closing pool pays in P, never converted to ETH (F99).
    expect(text('BC-226')).toMatch(/in P[^;]*never (converted to )?ETH|never ETH/);
    expect(text('BC-218')).toMatch(/given back/);
    // v1's case keeps v1's words.
    expect(byId(allCases, 'BC-046').then).toMatch(/refund range/);
  });

  it("56e6e18c's names: no v2 case names a v2 entry M1-00 renamed or one its gas floors replaced", () => {
    const gone = ['enterRefund', 'refundRange', 'RefundRangeEntered', 'RefundAlreadyEntered', 'REFUND_RANGE', 'CREATOR_HELD_TO_REFUNDS', 'qRefunded', 'ethRefunded', 'RefundFailed', 'StreamGasTooLow'];
    for (const row of rows) {
      for (const name of gone) expect(words(row), `${row.id} ${name}`).not.toContain(name);
      // One gas floor everywhere: cap + cap/63 + overhead (change queue 1, finding F21; IConverter.sol, IBoxSwapModuleV2.sol).
      expect(words(row), row.id).not.toMatch(/a 64th|\/ ?64\b/);
    }
    expect(text('BC-175')).toMatch(/StepGasTooLow/);
    expect(text('BC-175')).toMatch(/cap \+ cap\/63 \+ (its )?overhead/);
    expect(text('BC-212')).toMatch(/RunGasTooLow/);
    expect(text('BC-212')).toMatch(/cap \+ cap\/63 \+ (its )?overhead/);
    expect(text('BC-218')).toMatch(/qReturned/);
    // The held-T wording stays for the M1 restatement; F136 now separates earned Safe shares from the P claim pot.
    for (const id of ['BC-046', 'BC-163', 'BC-171', 'BC-226']) expect(text(id), id).toMatch(/redeemHeldT\(\)/);
    for (const id of ['BC-046', 'BC-226']) {
      expect(text(id), id).toMatch(/FIT_SHARE/);
      expect(text(id), id).toMatch(/fees earned before failure/);
      expect(text(id), id).toMatch(/two Safes/);
    }
    expect((rowOf('BC-226').params as { row: string[] }).row).toContain('fit_share');
    expect(text('BC-226')).toMatch(/FIT's 2\/15 and the platform's 1\/15/);
    expect(text('BC-226')).toMatch(/claim pot in P/);
    expect(text('BC-174')).toMatch(/current creator payee/);
  });

  it("F101: the M1-Q16, M1-Q17 and M1-Q18 defaults cite the founder's answers R22A, R22B and R22C", () => {
    for (const row of rows) {
      expect(JSON.stringify(row), row.id).not.toMatch(/M1-Q1[678]'s default/);
      for (const [q, r] of [['M1-Q16', 'R22A'], ['M1-Q17', 'R22B'], ['M1-Q18', 'R22C']] as const) {
        if (JSON.stringify(row).includes(q)) expect(JSON.stringify(row), `${row.id} ${q}`).toContain(`F101 ${r}`);
      }
    }
    for (const id of ['BC-046', 'BC-111', 'BC-125', 'BC-126', 'BC-226']) expect(all(id), id).toMatch(/F101 R22A/);
    for (const id of ['BC-178', 'BC-180']) expect(all(id), id).toMatch(/F101 R22B/);
    expect(all('BC-215')).toMatch(/F101 R22C/);
  });

  it("F101 R22A: a case pins a failed box's held creator fees in its closing pool (BC-236, M1-31)", () => {
    const c = byId(allCases, 'BC-236');
    expect(c).toMatchObject({ core: 'v2', ticket: 'M1-31', slice: 'M1', gate: 'G0', decision: 'F101 R22A' });
    expect(text('BC-236')).toMatch(/Creator/);
    expect(text('BC-236')).toMatch(/closing pool/);
    expect(text('BC-236')).toMatch(/held T is burned/);
    expect(text('BC-236')).toMatch(/closing price/);
    expect(text('BC-236')).toMatch(/ROYALTIES row/);
    expect(coverage.cases['BC-236']?.tests.length).toBeGreaterThan(0);
  });

  it("F104: a case pins the closer's tip, at most tipMaxQ in P from the closing pool, for fail() and failClosed() (BC-237, M1-31)", () => {
    const c = byId(allCases, 'BC-237');
    expect(c).toMatchObject({ core: 'v2', ticket: 'M1-31', slice: 'M1', gate: 'G0', decision: 'F104' });
    for (const re of [/fail\(\)/, /failClosed\(\)/, /tipMaxQ/, /msg\.sender/, /ERC-6909 claims of P/, /ClosingTipPaid/, /enterClosing\(tExcluded, msg\.sender\)/, /refuses ETH/, /paused/, /tipMaxQ ÷ the T still held/, /AlreadyFailed/]) {
      expect(text('BC-237'), String(re)).toMatch(re);
    }
    expect(coverage.cases['BC-237']?.tests.length).toBeGreaterThan(0);
    // The failure cases name the tip; the gate's cap closes a still-closed box with the same tip.
    for (const id of ['BC-046', 'BC-220']) expect(text(id), id).toMatch(/closer's tip \(BC-237\)/);
  });

  it("F102, F103: BC-055 is restated for v2: T a non-upgradeable EIP-1167 clone with arguments, the access probe allowing only T's implementation", () => {
    const v2 = byId(allCases, 'BC-055').v2;
    expect(v2).toMatchObject({ ticket: 'M1-30', slice: 'M1', gate: 'G0' });
    for (const re of [/EIP-1167/, /BoxTokenV2Args/, /182 bytes/, /implementation\(ROLE_TOKEN\)/, /no EIP-1967 slot, beacon, admin, setter or upgrade entry/, /inert alone/, /initialize\(\)/, /no account but T's implementation/, /full amount/, /standard event/, /no pause, blocklist or transfer fee/, /only sends to the vault and to T itself are refused/]) {
      expect(text('BC-055'), String(re)).toMatch(re);
    }
    expect(text('BC-055')).not.toMatch(/full contract, not a proxy/);
    expect(v2?.source).toMatch(/F102/);
    expect(v2?.source).toMatch(/F103/);
    // v1's T stays a full contract: v1's text is unchanged.
    expect(byId(allCases, 'BC-055').then).toMatch(/T is a full contract, not a proxy/);
    expect(coverage.cases['BC-055']?.tests.length).toBeGreaterThan(0);
  });

  it("CQ2-1: every box gets a swap module, which sells FIT's 3/15 of the sellers' fees (BC-131 restated; BC-130 v2)", () => {
    const v2 = byId(allCases, 'BC-131').v2;
    expect(v2).toMatchObject({ ticket: 'M1-41', slice: 'M1', gate: 'G0' });
    for (const re of [/pullForModule\(BranchId\.NONE\)/, /fitWaitingT/, /moduleProceeds\(BranchId\.NONE/, /noteModuleFees\(BranchId\.NONE/, /payFit\(\)/, /AsPaid-only box/, /every v2 box has a swap module/i]) {
      expect(text('BC-131'), String(re)).toMatch(re);
    }
    for (const row of rows) expect(words(row), row.id).not.toMatch(/gets no (swap )?module/);
    expect(text('BC-130')).toMatch(/every v2 box gets a swap module/i);
    expect(coverage.cases['BC-131']?.tests.length).toBeGreaterThan(0);
  });
});

describe("wave 0's integrated review: change queue 3 (F106, F107), M1-Q21's default, BC-167 in v2 terms (sh-v2-wave0)", () => {
  const words = (r: { title: string; given: string; when: string; then: string }) => [r.title, r.given, r.when, r.then].join(' ');
  const rowOf = (id: string) => {
    const c = byId(allCases, id);
    const row = c.core === 'v2' ? c : c.v2;
    if (!row) throw new Error(`${id} has no v2 text`);
    return row;
  };
  const text = (id: string) => words(rowOf(id));
  const rows = v2Rows(allCases);

  it("F106: no v2 case gives FIT the whole fixed 3/15 any more; it is FIT's 2/15 and the platform's 1/15", () => {
    const whole = /3\/15[^.;()]{0,24}\bFIT\b|\bFIT('s)?( fixed)? 3\/15|3\/15 protocol/;
    for (const row of rows) expect(words(row), row.id).not.toMatch(whole);
    for (const id of ['BC-207', 'BC-111', 'BC-146', 'BC-226', 'BC-131', 'BC-115', 'BC-225']) {
      expect(text(id), id).toMatch(/2\/15/);
      expect(text(id), id).toMatch(/1\/15/);
      expect(text(id), id).toMatch(/platform/);
    }
    expect(text('BC-146')).toMatch(/180\)? (goes )?to FIT/);
    expect(text('BC-146')).toMatch(/90\)? (goes )?to the platform/);
    expect(text('BC-131')).toMatch(/split 2:1/);
    expect(text('BC-226')).toMatch(/PLATFORM_SHARE/);
    expect(text('BC-226')).toMatch(/PLATFORM_SHARE to PLATFORM/);
    expect(text('BC-226')).toMatch(/fees earned before failure stay owed to the two Safes/);
    // BC-109 v2 no longer says v2 boxes never pay the platform: they pay only through the one cap contract.
    expect(rowOf('BC-109').title).not.toMatch(/never pay the platform/);
    expect(text('BC-109')).toMatch(/platform cap/);
    expect(text('BC-109')).toMatch(/1\/15/);
    expect(JSON.stringify(rowOf('BC-109'))).toMatch(/F106/);
  });

  it('F106: a case pins the platform cap shared with box 0 (BC-238, M1-32)', () => {
    const c = byId(allCases, 'BC-238');
    expect(c).toMatchObject({ core: 'v2', ticket: 'M1-32', slice: 'M1', gate: 'G0', decision: 'F106' });
    for (const re of [/1\/15/, /32 ETH/, /platformEpoch\(\)/, /fund\(\)/, /payPlatform\(\)/, /fundBudget\(\)/, /PLATFORM_OWED/, /failed/, /box 0/]) {
      expect(text('BC-238'), String(re)).toMatch(re);
    }
    expect(c.source).toMatch(/F107/);
    expect(coverage.cases['BC-238']?.tests.length).toBeGreaterThan(0);
  });

  it("F136/F138: held and later royalty P joins the pot; non-P royalties stay claimable in kind", () => {
    expect(text('BC-115')).toMatch(/held and later royalties in P join the coordinator's claim pot/);
    expect(text('BC-115')).toMatch(/non-P royalties are immediately claimable in kind by the current creator payee/);
    expect(text('BC-115')).not.toMatch(/arriving after the failure go to FIT/);
    expect(text('BC-226')).toMatch(/ROYALTIES in P goes to CLOSING_POOL/);
    expect(text('BC-226')).toMatch(/non-P royalties stay in the inbox for the creator's current payee to claim in kind at once/);
    for (const id of ['BC-115', 'BC-226']) {
      expect(text(id), id).toMatch(/Claims never close/);
      expect(text(id), id).toMatch(/money after the last holder claim stay(?:s)? locked/);
    }
  });

  it("BC-167 restated in v2's terms: the tip is CONVERTER_TIP_MAX_ETH × min(amountIn, maxIn) / maxIn, no caller cap", () => {
    const t = text('BC-167');
    expect(t).toMatch(/CONVERTER_TIP_MAX_ETH × min\(amountIn, maxIn\) \/ maxIn/);
    expect(t).toMatch(/tipTo/);
    expect(t).toMatch(/address\(0\)/);
    expect(t).toMatch(/bounds\(direction\)/);
    expect(t).not.toMatch(/grossETH\/100/);
    expect(t).not.toMatch(/the caller's cap/);
    expect(t).not.toMatch(/first\.maxIn/);
    expect(byId(allCases, 'BC-167').restated).toMatch(/IConverter/);
  });

  it('F136/F138: BC-046 v2, BC-174 and BC-177 follow the frozen failure path', () => {
    expect(text('BC-046')).toMatch(/the closing-pool T step 2 burns/);
    expect(text('BC-046')).not.toMatch(/supply falls by exactly their sum/);
    expect(text('BC-174')).not.toMatch(/A graduated box cannot call the failed-box flush/);
    expect(text('BC-174')).toMatch(/after the last holder claim/);
    expect(text('BC-177')).not.toMatch(/goes directly to fundBudget\(\)/);
    expect(text('BC-174')).toMatch(/failed box signs no order/);
    expect(text('BC-174')).toMatch(/30 days with no observed sale/);
    expect(text('BC-174')).toMatch(/at most 20 lots an hour/);
    expect(text('BC-177')).toMatch(/royalty P joins the coordinator's claim pot/);
    expect(text('BC-177')).toMatch(/non-P inbox coins are immediately claimable in kind by the current creator payee/);
    expect(text('BC-177')).not.toMatch(/fitOwed/);
  });
});

describe("wave 0's final check: BC-238's order case (sh-v2-wave0); BC-215's store superseded by CQ8-F3", () => {
  const words = (r: { title: string; given: string; when: string; then: string }) => [r.title, r.given, r.when, r.then].join(' ');
  const text = (id: string) => words(byId(allCases, id));
  const testsOf = (id: string) => (coverage.cases[id]?.tests ?? []).map((t) => ('name' in t ? t.name : t.title));

  it("BC-238: the order case, where the cap keeps first and box 0 then keeps its whole cap (M1-Q23, F108 R23G, M1-32)", () => {
    const t = text('BC-238');
    expect(t).toMatch(/M1-Q23/);
    // F108 R23G (option B) replaced the default's "twice the cap (64 ETH)" by the 16 ETH v2 ceiling: at most 48 ETH.
    expect(t).not.toMatch(/twice the cap/);
    expect(t).toMatch(/box 0's cap plus the ceiling \(48 ETH\)/);
    expect(t).toMatch(/the cap keeps first/);
    expect(byId(allCases, 'BC-238').params?.order).toEqual(['box0_first', 'cap_first']);
    expect(testsOf('BC-238')).toContain('test_BC238_capKeepsFirstThenBox0KeepsItsWholeCap');
  });
});

describe('F108 (R23C, R23F, R23G): M1-Q21, M1-Q22 and M1-Q23 answered (sh-v2-wave0)', () => {
  const words = (r: { title: string; given: string; when: string; then: string }) => [r.title, r.given, r.when, r.then].join(' ');
  const rowOf = (id: string) => {
    const c = byId(allCases, id);
    const row = c.core === 'v2' ? c : c.v2;
    if (!row) throw new Error(`${id} has no v2 text`);
    return row;
  };
  const text = (id: string) => words(rowOf(id));
  const rows = v2Rows(allCases);
  const testsOf = (id: string) => (coverage.cases[id]?.tests ?? []).map((t) => ('name' in t ? t.name : t.title));
  const doc = (path: string) => readFileSync(join(repoDir, path), 'utf8');
  const tickets = doc('docs/design/core-v2-m1-tickets.md');
  const adr = doc('docs/decisions/0017-general-core.md');
  const section = (md: string, from: string, to: string) => md.slice(md.indexOf(from), md.indexOf(to));
  const asDefault = /M1-Q2[123]('s)? default|M1-Q2[123][^.;|\n]{0,24}\b(still )?open\b|\bopen founder question\b/i;

  it("F136/F138 supersede R23C's foreign royalty route and preserve only inbox growth of the no-buyer remainder", () => {
    for (const id of ['BC-115', 'BC-226']) {
      expect(rowOf(id).source, id).toMatch(/F108 R23C/);
      expect(rowOf(id).source, id).toMatch(/F136 and F138/);
      expect(text(id), id).toMatch(/with no buyers only (later )?inbox P adds to the creator's remainder/i);
      expect(text(id), id).toMatch(/CREATOR_PAYEE/);
      expect(text(id), id).toMatch(/collect with no tip/);
    }
  });

  it("R23F: royalties booked as fees give the platform its 1/15 of FIT's 3/15, no longer a proposal (BC-115 v2)", () => {
    expect(rowOf('BC-115').source).toMatch(/F108 R23F/);
    expect(rowOf('BC-115').source).not.toMatch(/3\/15 \[P\]/);
    expect(text('BC-115')).toMatch(/0\.1 ETH to the platform cap/);
  });

  it('R23G: BC-238 keeps at most the 16 ETH v2 ceiling an epoch, never more than what box 0 left, at most 48 ETH in total', () => {
    const c = rowOf('BC-238');
    const t = text('BC-238');
    expect(c.title).toMatch(/16 ETH/);
    for (const re of [/16 ETH/, /48 ETH/, /32 ETH/, /PLATFORM_V2_CEILING_WEI/, /min\(/, /clipped at 0/, /1\.6 ETH/, /F108 R23G/]) {
      expect(t, String(re)).toMatch(re);
    }
    expect(t).not.toMatch(/64 ETH/);
    expect(c.source).toMatch(/F108/);
    expect(byId(allCases, 'BC-238').params?.v2Kept).toEqual(['none', 'part', 'ceiling']);
    expect(testsOf('BC-238')).toContain('test_BC238_v2KeepsAtMostTheCeilingPerEpoch');
  });

  it('no v2 case calls M1-Q21, M1-Q22 or M1-Q23 a default or open, or lets the platform take 64 ETH an epoch', () => {
    for (const row of rows) {
      const all = JSON.stringify(row);
      expect(all, row.id).not.toMatch(asDefault);
      expect(all, row.id).not.toMatch(/64 ETH/);
    }
  });

  it("the plan: tickets § 7 has no open M1-Q21 to M1-Q23, § 9 records F108's three rows, ADR-0017 § 5 states the ceiling", () => {
    const s7 = section(tickets, '## 7. Founder questions', '## 8. Defaults');
    expect(s7).not.toMatch(/^- \*\*M1-Q2[123]\*\*/m);
    expect(s7).toMatch(/M1-Q21, M1-Q22 and M1-Q23 by F108/);
    const s9 = tickets.slice(tickets.indexOf('## 9. Change queue'));
    for (const r of ['R23C', 'R23F', 'R23G']) expect(s9, r).toMatch(new RegExp(`^\\| F108 ${r}`, 'm'));
    expect(tickets).not.toMatch(asDefault);
    const s5 = section(adr, '### 5. Fee recipes', '### 6. ');
    for (const re of [/F108 R23G/, /16 ETH/, /48 ETH/, /PLATFORM_V2_CEILING_WEI/, /F108 R23C/, /F108 R23F/]) {
      expect(s5, String(re)).toMatch(re);
    }
    expect(adr).not.toMatch(asDefault);
    expect(adr).not.toMatch(/\[I; M1-Q23\]/);
  });

  it('CQ11 frozen interfaces replace the retired on-chain platform cap with two receiver Safes', () => {
    const src = solidityFiles('packages/contracts/src/box-v2');
    expect(src.some((f) => f.path.endsWith('/IPlatformCapV2.sol'))).toBe(false);
    const receiver = src.find((f) => f.path.endsWith('/IBoxReceiverV2.sol'))?.source ?? '';
    for (const safe of ['FIT_SAFE', 'PLATFORM_SAFE']) expect(receiver).toContain(`function ${safe}()`);
    for (const f of src) expect(f.source, f.path).not.toMatch(asDefault);
  });
});

describe('CQ8-F3: Amendment 1 · Price steps (F112), PS1/PS3/PS5 defaults', () => {
  const row = (id: string) => byId(allCases, id);
  const text = (id: string) => {
    const c = row(id);
    return [c.title, c.given, c.when, c.then].join(' ');
  };
  const readings = /box pools?[^;]*1-hour average[^;]*outside hops?[^;]*start of block/;

  it.each([
    ['BC-211', 'A2', 'A7', 'A8'], ['BC-212', 'A2', 'A7', 'A8'],
    ['BC-215', 'A2', 'A5', 'A6', 'A7'], ['BC-223', 'A2', 'A3', 'A4'],
    ['BC-227', 'A5'], ['BC-231', 'A5'],
    ['BC-178', 'A5', 'A8'], ['BC-179', 'A5', 'A8'], ['BC-180', 'A5', 'A8'],
  ])('%s cites each amendment item that restates it', (id, ...items) => {
    expect(row(id).source).toContain('ADR-0017 Amendment 1');
    expect(row(id).source).toContain('F112');
    expect(row(id).source).toContain('CQ8-F3');
    for (const item of items) expect(row(id).source, `${id} ${item}`).toMatch(new RegExp(`\\b${item}\\b`));
  });

  it('N05/N06 use the remaining module room from spot, and an AtBand wait starts no failed-run clock', () => {
    for (const id of ['BC-211', 'BC-212']) {
      for (const re of [/spot/, /module's room/, /STEP_TICKS/, /AtBand/, /other direction's turn/, /no failed run/, /no clock/]) {
        expect(text(id), `${id} ${re}`).toMatch(re);
      }
      expect(text(id), id).not.toMatch(/at the band nothing|reference's band|lagging average/);
    }
    expect(text('BC-211')).toMatch(/25 blocks/);
    expect(text('BC-211')).toMatch(/one step per box per block/);
    expect(text('BC-211')).toMatch(/minOut/);
    expect(row('BC-211').params).toMatchObject({
      room: ['full', 'part_spent', 'exhausted'], turn: ['this_direction', 'other_direction'],
    });
    expect(text('BC-212')).toMatch(/the fee and the slack in minOut/);
    expect(text('BC-212')).toMatch(/RunGasTooLow/);
  });

  it('N09 historical wording is superseded by F123 permanent-listing test coverage', () => {
    const t = text('BC-215');
    for (const re of [/Only the lister adds/, /5%[^;]*start-of-block price/, /observe\(\[1, 0\]\)/,
      /buffer of at least 2/, /start-of-block liquidity/, /last 24 hours on a fork/, /privately/,
      /blockTimestampLast/, /sync\(\)/, /V2_SNAPSHOTS_MISSING/, /AT_BAND/, /starts no clock/,
      /deadSince\(direction\)/, /RELIST_TOO_EARLY/, /both listings stay valid/]) expect(t, String(re)).toMatch(re);
    expect(t).not.toMatch(/snapshotV2|hourly snapshots|covering the hour|hour's lowest|sqrt\(reserve/);
    expect(row('BC-215').withdrawn).toBeUndefined();
    expect(row('BC-215').restated).toMatch(/busy v2 pair/);
    expect(row('BC-215').params?.v2Snapshot).toBeUndefined();
    expect(row('BC-215').params?.v2Pair).toEqual(['untouched', 'swap_this_block', 'sync_this_block', 'next_block']);
    expect(coverage.cases['BC-215']?.tests).toContainEqual({
      file: `${V2_PATHS.testDir}/cq11-d/Listings.t.sol`, name: 'test_BC215_nativeRowAndPermanentId',
    });
    expect(JSON.stringify(coverage.cases['BC-215'])).not.toContain('flashAddedLiquidity');
  });

  it('N17 accounts for shared converter room, independent module room, dust, alternation and every FIT stacker', () => {
    const t = text('BC-223');
    for (const re of [/one word per box pool/, /all converters/, /each direction/, /25 blocks/,
      /dust step/, /POOL_SLOT_TAKEN/, /starts no clock/, /isConverter/, /addBoxToken/,
      /other direction's turn/, /147 ticks/, /196 ticks/, /FIT's executor/, /v1 module/,
      /deepen/, /two windows/, /M1-23/, /smaller constant/, /start-of-block price/]) expect(t, String(re)).toMatch(re);
    expect(row('BC-223').title).not.toMatch(/band/i);
    expect(row('BC-223').params).toMatchObject({ stepTicks: [49], gapBlocks: [25] });
    // CQ9-2 (tickets § 9, change queue 9): A2's one registry call becomes a read before planning and a spend after.
    expect(t).toMatch(/reads the room once before planning and spends the ticks it used once after the swap/);
    expect(t).toMatch(/each call covering every box-pool hop in its route \(CQ9-2\)/);
    expect(t).not.toMatch(/one registry call/);
    expect(row('BC-223').source).toMatch(/CQ9-2/);
    expect(coverage.cases['BC-223']?.tests).toContainEqual({
      file: `${V2_PATHS.testDir}/legs/StepBounds.t.sol`, name: 'test_BC223_sharedBoxPoolRoomAndFitStack',
    });
    // Keep the written pre-amendment mapping until its owning contract ticket rewrites the test.
    expect(coverage.cases['BC-223']?.tests).toContainEqual({
      file: `${V2_PATHS.testDir}/m1-41b/M141bConvertBounds.t.sol`, name: 'test_BC223_oneStepPerBoxPerBlockAndNeverPastTheBand',
    });
  });

  it('N21 values P and T without live spot, and holds then revalues a busy-pair collect', () => {
    const t = text('BC-227');
    for (const re of [/P[^;]*dearer of[^;]*latest sample[^;]*1-hour average/,
      /outside hops[^;]*start of block/, /never live spot/, /sync\(\)/, /later collect values/,
      /push[^;]*collect[^;]*unchanged/, /PRICE_HELD_MAX/, /30 days/, /rounded up/, /both sides share one counter/]) {
      expect(t, String(re)).toMatch(re);
    }
    expect(t).not.toMatch(/P at its route's 1-hour average/);
  });

  it('N25 keeps the box sampler for admission and anchor, and refuses a busy outside hop in the raise', () => {
    const t = text('BC-231');
    for (const re of [/ready average/, /floor at the average/, /lowest of spot, latest sample and 1-hour average/,
      /outside hops[^;]*lowest of spot and start of block/, /busy v2 hop refuses raiseCheck/,
      /never spot alone/, /price anchor/, /start-of-block price/, /T_TOO_HIGH/]) expect(t, String(re)).toMatch(re);
  });

  it("the sale's A keeps the box average but reads outside hops at start of block and waits on missing depth", () => {
    for (const id of ['BC-178', 'BC-179', 'BC-180']) {
      const t = JSON.stringify(row(id));
      expect(t, id).toMatch(readings);
      expect(t, id).toMatch(/floor at start-of-block liquidity/);
      expect(t, id).not.toMatch(/route's (live )?1-hour average|depth floor over (the|that) hour/);
    }
    expect(text('BC-179')).toMatch(/max\(S, A\) × decay/);
    for (const re of [/emptied v3 pool/, /drained v2 pair/, /box pool[^;]*no ready average/,
      /box pool[^;]*below its floor/, /busy v2 pair/, /waits/, /refill/]) expect(text('BC-180'), String(re)).toMatch(re);
  });

  it('N28 stays exactly as at the ticket base, including its existing simulation grid', () => {
    // CQ8-F3 explicitly leaves N28 unchanged at 6250a61103198d31027955b26e7cf813156c6372.
    expect(createHash('sha256').update(JSON.stringify(row('BC-234'))).digest('hex'))
      .toBe('5a99304e7959fc07b2f5f091b824d3d93ed8993335fb03cde138175ff8baf3a1');
  });

  it("N28's coverage row names its step test's file, where M1-41-a wrote it; only the mapping moves, not the case", () => {
    expect(coverage.cases['BC-234']?.tests).toContainEqual({
      file: `${V2_PATHS.testDir}/m1-41a/M141aBounds.t.sol`, name: 'test_BC234_thePriceGuardKeptAsBuilt_steps', ticket: 'M1-41',
    });
    expect(JSON.stringify(coverage.cases['BC-234'])).not.toContain('legs/Legs.t.sol');
  });
});

describe('coverage.v2.json: every M1 case maps to a test id', () => {
  const opts = { files, scripts };

  it('agrees with the case file and the tests', () => {
    expect(checkCoverageV2(allCases, coverage, opts)).toEqual([]);
  });

  it('fails an M1 case that maps to no test id (the red-first rule of M1-01)', () => {
    const m = copyMap();
    delete m.cases['BC-215'];
    expect(checkCoverageV2(allCases, m, opts)).toContain('[unmapped] BC-215 (M1-20): maps to no test id');
    const restated = copyMap();
    delete restated.cases['BC-036'];
    expect(checkCoverageV2(allCases, restated, opts)).toContain('[unmapped] BC-036 (M1-20): maps to no test id');
  });

  it('refuses a test id for another case, a Foundry file outside box-v2, a TS title without its case and an unknown ticket', () => {
    const m = copyMap();
    m.cases['BC-215'] = { tests: [{ file: `${V2_PATHS.testDir}/listings/ListingRegistry.t.sol`, name: 'test_BC216_wrongCase' }] };
    m.cases['BC-216'] = { tests: [{ file: 'packages/contracts/test/box/s7/X.t.sol', name: 'test_BC216_outside' }] };
    m.cases['BC-214'] = { tests: [{ file: 'packages/indexer/test/core/discovery-v2.test.ts', title: 'plug-in marked' }] };
    m.cases['BC-213'] = { tests: [{ file: `${V2_PATHS.testDir}/hostile/RuleSlot.t.sol`, name: 'test_BC213_x', ticket: 'M9-99' }] };
    const errors = checkCoverageV2(allCases, m, opts);
    expect(errors.some((e) => e.startsWith('[v2-test] BC-215: test_BC216_wrongCase'))).toBe(true);
    expect(errors.some((e) => e.startsWith('[v2-test] BC-216: packages/contracts/test/box/s7/X.t.sol'))).toBe(true);
    expect(errors.some((e) => e.startsWith('[v2-test] BC-214: plug-in marked'))).toBe(true);
    expect(errors.some((e) => e.startsWith('[v2-test] BC-213: test_BC213_x'))).toBe(true);
  });

  it('fails a written v2 test the map does not list, and one written in another file than the map says', () => {
    const extra: SolidityFile[] = [...files, { path: `${V2_PATHS.testDir}/listings/Extra.t.sol`, source: 'contract X { function test_BC215_unlisted() public {} }' }];
    expect(checkCoverageV2(allCases, coverage, { files: extra, scripts })).toContain(
      `[v2-unlisted] test_BC215_unlisted (BC-215) in ${V2_PATHS.testDir}/listings/Extra.t.sol is in the tests but not in coverage.v2.json`,
    );
    const listed = coverage.cases['BC-215']?.tests?.[0];
    if (!listed || !('name' in listed)) throw new Error('BC-215 lists a Foundry test');
    const moved: SolidityFile[] = [...files, { path: `${V2_PATHS.testDir}/elsewhere/Moved.t.sol`, source: `contract X { function ${listed.name}() public {} }` }];
    expect(checkCoverageV2(allCases, coverage, { files: moved, scripts }).some((e) => e.startsWith(`[v2-test] BC-215: ${listed.name} is written in`))).toBe(true);
    const outside: SolidityFile[] = [...files, { path: `${V2_PATHS.testDir}/x/Y.t.sol`, source: 'contract X { function test_BC077_v1Case() public {} }' }];
    expect(checkCoverageV2(allCases, coverage, { files: outside, scripts }).some((e) => e.startsWith('[v2-unlisted] test_BC077_v1Case (BC-077)'))).toBe(true);
  });

  it('marks a mapped test written once it exists in its file, planned before', () => {
    // The first M1 case whose tests are all still planned (BC-207 was the example until M1-40-b wrote its tests).
    const before = coverageRowsV2(allCases, coverage, opts).find(
      (r) => r.slice === 'M1' && r.withdrawn === undefined && r.tests.every((x) => x.state === 'planned') && r.tests[0] !== undefined && 'name' in r.tests[0],
    );
    if (!before) throw new Error('no M1 case lists only planned tests');
    const t = coverage.cases[before.id]?.tests?.[0];
    if (!t || !('name' in t)) throw new Error(`${before.id} lists a Foundry test first`);
    const written: SolidityFile[] = [...files, { path: t.file, source: `contract X { function ${t.name}() public {} }` }];
    expect(checkCoverageV2(allCases, coverage, { files: written, scripts })).toEqual([]);
    const after = coverageRowsV2(allCases, coverage, { files: written, scripts }).find((r) => r.id === before.id);
    expect(after?.tests[0]?.state).toBe('written');
  });

  it('names every written v2 Foundry test once, so the map can tell each from the other', () => {
    const where = new Map<string, string[]>();
    for (const w of writtenV2Checks(files, scripts)) if (w.kind === 'foundry') where.set(w.name, [...(where.get(w.name) ?? []), w.file]);
    expect([...where].filter(([, at]) => at.length > 1)).toEqual([]);
  });

  it('the committed v2 report is the rendered one', () => {
    expect(readFileSync(join(repoDir, V2_PATHS.report), 'utf8')).toBe(renderReportV2(allCases, coverage, opts));
  });

  it('R48: shop-fee ceiling and original-holder exits are discovered from maintained coverage inputs', () => {
    const rows = coverageRowsV2(allCases, coverage, opts);
    const expected = [
      ['BC-192', 'test_SF01_factoryPresetCoreChoiceAndJournalWithoutBuyersHolders'],
      ['BC-198', 'test_SF02_liveCeilingExactAllowanceAndHoldersExit'],
      ['BC-199', 'test_SF11_oneRawTokenRoomResolvesWithoutPriceMovement'],
      ['BC-199', 'test_SF12_positiveRoomCappedPurchaseBelowStepMinimumPaysHolders'],
      ['BC-202', 'test_SF04_failureNeverUsesBudgetOrPileRow9'],
    ];
    for (const [id, name] of expected) {
      expect(rows.find((r) => r.id === id)?.tests).toContainEqual(expect.objectContaining({
        name, ticket: 'SH-V21-07-SHOP-FEES', implementation: true, state: 'written',
      }));
      expect(renderReportV2(allCases, coverage, opts)).toContain(`\`${name}\``);
    }
    const missing = files.filter((f) => !f.path.endsWith('/shop-fees/ShopFees.t.sol'));
    expect(checkCoverageV2(allCases, coverage, { files: missing, scripts })).toContain(
      '[v2-test] BC-199: test_SF11_oneRawTokenRoomResolvesWithoutPriceMovement: implementation test is missing from packages/contracts/test/box-v2/shop-fees/ShopFees.t.sol',
    );
  });
});

describe('the v1 map leaves v2 tests to coverage.v2.json', () => {
  const v1Coverage = JSON.parse(readFileSync(join(repoDir, PATHS.coverage), 'utf8'));
  const v1Files = solidityFiles(PATHS.testDir);
  const v1Scripts = sourceScripts(v1Coverage);

  it('ignores Foundry tests under packages/contracts/test/box-v2 and TypeScript titles for v2 cases', () => {
    const withV2 = [...v1Files, { path: `${V2_PATHS.testDir}/recipes/RecipeEngine.t.sol`, source: 'contract X { function test_BC207_x() public {} function test_BC036_v2() public {} }' }];
    const titled = v1Scripts.map((f, i) => (i === 0 ? { ...f, source: `${f.source}\nit('BC-214 a plug-in is marked', () => {});\nit('BC-036 v2: only listed tokens', () => {});\n` } : f));
    expect(checkCoverage(cases, v1Coverage, { files: withV2, scripts: titled })).toEqual([]);
  });

  it('refuses a v1 source inside the v2 test folder', () => {
    const m = structuredClone(v1Coverage);
    m.sources.push({ id: 'boxv2', paths: [`${V2_PATHS.testDir}/x`], about: 'wrong map' });
    expect(checkCoverage(cases, m, { files: v1Files, scripts: v1Scripts })).toContain(
      `source boxv2: ${V2_PATHS.testDir}/x is inside ${V2_PATHS.testDir} (coverage.v2.json's tests)`,
    );
  });
});


type M2Entry = CoverageV2['cases'][string] & {
  status: 'covered' | 'open'; open?: { ticket: string; reason: string }[];
};
type M2Map = CoverageV2 & {
  cases: Record<string, M2Entry>;
  m2: {
    planReferences: { id: string; status: 'mapped' | 'withdrawn'; into?: string[]; by: string; reason: string }[];
    requirements: { id: string; cases: string[]; ticket: string; status: 'covered' | 'open'; reason: string }[];
  };
};
const m2Coverage = coverage as M2Map;
const m2Live = Array.from({ length: 22 }, (_, i) => `BC-${182 + i}`);
const m2Retired = [178, 179, 180, 181, 204, 205, 209, 210, 211, 212, 217].map((n) => `BC-${n}`);

// Local check for M2's owned manifest extension; promote to the shared checker at integration.
function m2Problems(map: M2Map): string[] {
  const errors: string[] = [];
  for (const id of m2Live) {
    const e = map.cases[id];
    if (!e || !e.tests.length || !['covered', 'open'].includes(e.status)) { errors.push(id); continue; }
    if (e.status === 'open' && !e.open?.length) errors.push(id);
    for (const pending of e.open ?? []) if (!map.tickets[pending.ticket] || !pending.reason) errors.push(id);
    for (const t of e.tests) {
      if (!('name' in t) || t.implementation !== true) { errors.push(id); continue; }
      const source = files.find((f) => f.path === t.file)?.source ?? '';
      if (!new RegExp(`function\\s+${t.name}\\s*\\(`).test(source)) errors.push(id);
      if (!map.tickets[t.ticket ?? '']) errors.push(id);
    }
  }
  return errors;
}

describe('M2-01 frozen case handoff', () => {
  it('keeps BC-188 open under M2-32 until the missing lifecycle boundaries are proved', () => {
    const entry = m2Coverage.cases['BC-188'];
    expect(entry?.status).toBe('open');
    expect(entry?.tests).toEqual(expect.arrayContaining([
      { file: `${V2_PATHS.testDir}/m2-32/Shop.t.sol`, name: 'test_noMovesBeforeGraduationOrAfterFailure', implementation: true, ticket: 'M2-32' },
      { file: `${V2_PATHS.testDir}/m2-32/Failure.t.sol`, name: 'test_fundedSeedAndUnauthorizedLifecycleLoaderRefused', implementation: true, ticket: 'M2-32' },
    ]));
    const reason = entry?.open?.find((pending) => pending.ticket === 'M2-32')?.reason ?? '';
    expect(reason).toMatch(/give and pick after failure/);
    expect(reason).toMatch(/fundSeed and loadStarter after a successful openGate/);
    expect(reason).toMatch(/second openGate after successful opening/);
  });

  it('maps every live case to real named checks and explicitly assigns unfinished work', () => {
    expect(m2Problems(m2Coverage)).toEqual([]);
    for (const id of m2Live) {
      const c = byId(allCases, id);
      expect(c.ticket).toMatch(/^M2-\d+$/);
      expect(c.source).toContain('M2-00');
      expect(c.restated).toMatch(/F119|F120|F111/);
      const broken = structuredClone(m2Coverage);
      Reflect.deleteProperty(broken.cases, id);
      expect(m2Problems(broken)).toContain(id);
    }
    const broken = structuredClone(m2Coverage);
    const starter = broken.cases['BC-182'];
    if (!starter) throw new Error('BC-182 must be mapped');
    broken.cases['BC-182'] = { ...starter, status: 'open', open: [] };
    expect(m2Problems(broken)).toContain('BC-182');
  });

  it('retires removed features without reusing their cases or retaining obsolete tests', () => {
    for (const id of m2Retired) {
      expect(byId(allCases, id).withdrawn, id).toMatch(/F119|F120|F122/);
      expect(byId(allCases, id).ticket, id).toBeUndefined();
      expect(coverage.cases[id], id).toBeUndefined();
    }
  });

  it('reconciles every unallocated old plan id without overwriting M3 or inventing an allocation', () => {
    const refs = m2Coverage.m2?.planReferences ?? [];
    expect(refs.map((r) => r.id)).toEqual([...Array.from({ length: 14 }, (_, i) => `BC-${239 + i}`), 'BC-271']);
    for (const r of refs) {
      expect(allCases.some((c) => c.id === r.id)).toBe(false);
      expect(r.by).toMatch(/F119|F120|F122|F111/);
      expect(r.reason.length).toBeGreaterThan(10);
      if (r.status === 'mapped') {
        expect(r.into?.length).toBeGreaterThan(0);
        for (const id of r.into ?? []) expect(byId(allCases, id).withdrawn).toBeUndefined();
      } else expect(r.into).toBeUndefined();
    }
    for (const id of ['BC-239', 'BC-242', 'BC-244', 'BC-245', 'BC-271']) {
      expect(refs.find((r) => r.id === id)?.status, id).toBe('withdrawn');
    }
  });

  it('covers all nine money rules, wiring and remaining release proofs with accountable owners', () => {
    const requirements = m2Coverage.m2?.requirements ?? [];
    expect(requirements.map((r) => r.id)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `money-${i + 1}`), 'wiring', 'spec', 'keeper', 'indexer', 'ui', 'gas', 'menu', 'mutation', 'review', 'sepolia',
    ]);
    for (const r of requirements) {
      expect(coverage.tickets[r.ticket]?.milestone, r.id).toBe('M2');
      expect(r.cases.length, r.id).toBeGreaterThan(0);
      expect(r.reason.length, r.id).toBeGreaterThan(10);
      for (const id of r.cases) expect(byId(allCases, id).withdrawn, r.id).toBeUndefined();
    }
  });

  it('pins the four M2-32 corrections and P batch semantics, not obsolete prototype promises', () => {
    const words = (id: string) => { const c = byId(allCases, id); return [c.title, c.given, c.when, c.then].join(' '); };
    expect(words('BC-185')).toContain('seed and pick receipts');
    expect(words('BC-192')).toContain('pulls neither seed nor NFTs');
    expect(words('BC-195')).toContain('first successful give or pick');
    expect(words('BC-198')).toContain('no debt or carry');
    for (const id of m2Live) expect(words(id)).not.toMatch(/whole T balance|continuously|1e18-scaled|achieved rate|closing pool|module|converter|44 weeks|ItemNotPulled|DeadlineExpired/);
    expect(words('BC-199')).toContain('U + V');
    expect(words('BC-200')).toContain('two floors');
    expect(words('BC-201')).toContain('before graduation');
    expect(words('BC-202')).toContain('outside the failure pot');
    expect(words('BC-203')).toContain('no ERC-6909 fallback');
  });
});

type M2Vectors = {
  batches: { name: string; decimals: number; funding: string; userUnits: string; protocolUnits: string;
    notices: { units: string; balances: string[]; supply: string }[]; credits: string[]; residue: string }[];
  sources: { name: string; receipt: string; d6: string; paidTip: string; split: string[]; dust: string }[];
  weeks: { snapshot: string; pickReceipts: string; spent: string; weeklyBps: string; collectionBps: string;
    totalLimit: string; collectionLimit: string; nextSnapshot: string }[];
};

describe('M2-01 independent raw-unit allocation vectors', () => {
  const data = JSON.parse(readFileSync(join(repoDir, 'packages/box-spec/vectors/cases.v2.json'), 'utf8')) as { m2?: M2Vectors };
  it('pins both floors, missed/protocol weight, final zero and full precision at 6/8/18 decimals', () => {
    const batches = data.m2?.batches ?? [];
    expect(batches.length).toBeGreaterThanOrEqual(8);
    expect(new Set(batches.map((v) => v.decimals))).toEqual(new Set([6, 8, 18]));
    for (const v of batches) {
      const raw = [v.funding, v.userUnits, v.protocolUnits, ...v.credits, v.residue,
        ...v.notices.flatMap((n) => [n.units, n.supply, ...n.balances])];
      for (const n of raw) expect(n).toMatch(/^(0|[1-9]\d*)$/);
      const denominator = BigInt(v.userUnits) + BigInt(v.protocolUnits);
      const credits = v.credits.map((_, i) => {
        const units = v.notices.reduce((sum, n) => {
          const balance = n.balances[i];
          if (balance === undefined) throw new Error(`${v.name}: missing balance ${i}`);
          return sum + (BigInt(n.supply) === 0n ? 0n : BigInt(n.units) * BigInt(balance) / BigInt(n.supply));
        }, 0n);
        return denominator === 0n ? 0n : BigInt(v.funding) * units / denominator;
      });
      expect(credits.map(String), v.name).toEqual(v.credits);
      expect((BigInt(v.funding) - credits.reduce((a, b) => a + b, 0n)).toString(), v.name).toBe(v.residue);
    }
    expect(batches.find((v) => v.name === 'missed-and-protocol')?.credits).toEqual(['1380', '720']);
    expect(batches.find((v) => v.name === 'two-floors')?.credits).toEqual(['2', '4']);
    expect(batches.find((v) => v.name === 'final-zero')?.credits).toEqual(['0', '0']);
  });
  it('keeps D6, actual tips and terminal source dust out of later allocations', () => {
    expect(data.m2?.sources.length).toBeGreaterThanOrEqual(4);
    for (const v of data.m2?.sources ?? []) {
      const net = BigInt(v.receipt) - BigInt(v.d6) - BigInt(v.paidTip), q = net / 15n;
      expect([2n*q, q, 2n*q, 10n*q].map(String), v.name).toEqual(v.split);
      expect((net % 15n).toString(), v.name).toBe(v.dust);
    }
    expect(data.m2?.sources.find((v) => v.name === 'one-unit-source')?.split).toEqual(['0', '0', '0', '0']);
  });
  it('fixes weekly limits before receipts with no debt or carry', () => {
    expect(data.m2?.weeks.length).toBeGreaterThanOrEqual(3);
    for (const v of data.m2?.weeks ?? []) {
      const snapshot = BigInt(v.snapshot);
      expect((snapshot * BigInt(v.weeklyBps) / 10000n).toString()).toBe(v.totalLimit);
      expect((snapshot * BigInt(v.collectionBps) / 10000n).toString()).toBe(v.collectionLimit);
      expect(BigInt(v.spent)).toBeLessThanOrEqual(BigInt(v.totalLimit));
      expect((snapshot - BigInt(v.spent) + BigInt(v.pickReceipts)).toString()).toBe(v.nextSnapshot);
    }
  });
});
