#!/usr/bin/env node
/**
 * Box conformance: the case-file loader check and the harness coverage report (launch pipeline v1 § 5, slice S2).
 *
 * 1. Loads docs/design/launch-pipeline/conformance-cases.json and fails when a T0-only case is below G0, a G0 case for
 *    T0 sits in a slice off the Misfits line, a case lacks a slice, a factory-built case uses N below 10, or a
 *    box-factory BP row other than BP-22 and BP-32 has no case (scripts/lib/conformance.mjs, `checkCases`).
 * 2. Checks packages/box-spec/conformance/coverage.v1.json against the case file and the Foundry tests
 *    (packages/contracts/test, subfolders included): every case-named check (`test_BCnnn_*`, `testFuzz_BCnnn_*`) sits in
 *    a source the map names (the S2 harness, core v1's harness in its `core/` subfolder, the lanes' folders) and is
 *    listed under its case and source; every check the map lists exists there; every provider contract exists. The
 *    TypeScript sources (S10a: the indexer's and the site's vitest tests, the Playwright suites): every test whose title
 *    starts with `BC-nnn` in their files is listed under every case its title names (lib/conformance.mjs).
 * 3. Writes (or, with --check, compares) the generated report docs/evidence/SH-S2-conformance-coverage.md.
 * 4. Prints the Misfits gate's count: the G0 cases for T0 that are green (checked or done in S1) and open.
 * 5. Core v2 (M1-01/M3-01, scripts/lib/conformance-v2.mjs): checks the allocated v2 ranges and the v1 cases restated
 *    for v2) against their loader rules, and packages/box-spec/conformance/coverage.v2.json against them and the v2
 *    tests: every live M1 and M3 case maps to at least one test id. Writes (or, with --check, compares) the report
 *    docs/evidence/SH-V2-conformance-coverage.md.
 *
 * Usage (from the repository root):
 *   node packages/box-spec/scripts/conformance.mjs           write the report
 *   node packages/box-spec/scripts/conformance.mjs --check   exit 1 on a rule violation or a stale report
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PATHS,
  checkCases,
  checkCoverage,
  loadInputs,
  renderReport,
  repoDir,
  solidityFiles,
  sourceScripts,
  summarise,
  t0Gate,
} from './lib/conformance.mjs';
import { V2_PATHS, checkCasesV2, checkCoverageV2, coverageRowsV2, renderReportV2, v2Scripts, v2TestFiles } from './lib/conformance-v2.mjs';

const check = process.argv.includes('--check');
const out = (line) => process.stdout.write(`${line}\n`);

const { cases, allCases, bpRows, minN } = loadInputs();
const caseErrors = checkCases(cases, { bpRows, minN });
const coverage = JSON.parse(readFileSync(join(repoDir, PATHS.coverage), 'utf8'));
const files = solidityFiles(PATHS.testDir);
const scripts = sourceScripts(coverage);
const coverageErrors = checkCoverage(cases, coverage, { files, scripts });

let failed = false;
if (caseErrors.length) {
  failed = true;
  console.error(`check:conformance: ${PATHS.cases} breaks the loader rules (plan § 5):\n  ${caseErrors.join('\n  ')}`);
}
if (coverageErrors.length) {
  failed = true;
  console.error(`check:conformance: ${PATHS.coverage} and the tests disagree:\n  ${coverageErrors.join('\n  ')}`);
}

// Core v2 (M1-01).
const coverageV2 = JSON.parse(readFileSync(join(repoDir, V2_PATHS.coverage), 'utf8'));
const v2Opts = { files: v2TestFiles(), scripts: v2Scripts(coverageV2) };
const v2CaseErrors = checkCasesV2(allCases, coverageV2, { minN });
const v2CoverageErrors = checkCoverageV2(allCases, coverageV2, v2Opts);
if (v2CaseErrors.length) {
  failed = true;
  console.error(`check:conformance: the v2 cases in ${PATHS.cases} break their loader rules (M1-01):\n  ${v2CaseErrors.join('\n  ')}`);
}
if (v2CoverageErrors.length) {
  failed = true;
  console.error(`check:conformance: ${V2_PATHS.coverage}, the v2 cases and the v2 tests disagree:\n  ${v2CoverageErrors.join('\n  ')}`);
}

const reports = [
  [PATHS.report, () => renderReport(cases, coverage)],
  [V2_PATHS.report, () => renderReportV2(allCases, coverageV2, v2Opts)],
];
for (const [rel, render] of reports) {
  const report = render();
  const reportPath = join(repoDir, rel);
  const current = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  if (current === report) continue;
  if (check) {
    failed = true;
    console.error(`check:conformance: ${rel} is stale (run \`pnpm conformance:write\`)`);
  } else if (!failed) {
    writeFileSync(reportPath, report);
    out(`wrote ${rel}`);
  }
}
if (failed) process.exit(1);
const s = summarise(cases);
const gate = t0Gate(cases, coverage);
out(
  `check:conformance: ${s.total} cases pass the loader rules (${s.g0ForT0} G0 cases for T0, ${bpRows.length} BP rows); coverage map and report ${check ? 'are up to date' : 'written'}`,
);
out(
  `check:conformance: the Misfits gate: ${gate.green} of ${gate.g0ForT0} G0 cases for T0 green (checked ${gate.byStatus.checked}, done in S1 ${gate.byStatus['done-s1']}); open ${gate.open} (partial ${gate.byStatus.partial}, pending ${gate.byStatus.pending})`,
);
const v2Rows = coverageRowsV2(allCases, coverageV2, v2Opts).filter((r) => r.withdrawn === undefined);
const m1 = v2Rows.filter((r) => r.slice === 'M1');
const m1Tests = m1.flatMap((r) => r.tests);
const m3 = v2Rows.filter((r) => r.slice === 'M3');
const m3Tests = m3.flatMap((r) => r.tests);
out(
  `check:conformance: core v2: ${m1.length} M1 cases map to ${m1Tests.length} test ids (${m1Tests.filter((t) => t.state === 'written').length} written); ${v2Rows.filter((r) => r.slice === 'M2').length} M2 cases tied to M2's parts; ${m3.length} M3 cases map to ${m3Tests.length} test ids (${m3Tests.filter((t) => t.state === 'written').length} written; discovery only, not execution)`,
);
