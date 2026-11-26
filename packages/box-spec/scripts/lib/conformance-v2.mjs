/**
 * Core v2's conformance cases and their coverage map (ticket M1-01, core-v2-m1-tickets.md § 2 and § 3 on sh-core-v2-m1).
 * Used by packages/box-spec/scripts/conformance.mjs (`pnpm check:conformance`) and src/conformance-v2.test.ts.
 *
 * The cases live in the one case file (docs/design/launch-pipeline/conformance-cases.json): v2 cases are marked
 * `core: "v2"` and numbered BC-144 to BC-238 (Link Marines' BC-NEW-1 to -38, the Junkyard's 25 cases, M1's N01-N29,
 * then the cases later founder decisions added through the plan's change queue, tickets § 9: F101 R22A, F104, F106);
 * a v1 case restated for v2 keeps its v1 text and carries the v2 statement in `v2` (ADR-0017's doc fixes). Each v2 row
 * (a v2 case or a restated v1 case) is tied to one ticket of its milestone (`ticket`; M2's parts are named `M2:…`
 * until M2-00 numbers them, tickets § 6). M3-01 adds its reserved BC-253 to BC-270; the intervening M2 ids
 * remain reserved to their owner, not silently allocated or retired here.
 *
 * The loader rules (`checkCasesV2`): every id in V2_RANGES is a v2 case, once, and no v1 case sits in that
 * range; a v2 case has every field (or, withdrawn, the decision that withdrew it); its layer, gate, milestone (`slice`)
 * and ticket are known and agree; `appliesTo` names v2 boxes, never "all" or box 0 (T0); factory-built N is at least
 * the spec's minimum; a plan case Nk is BC-(206+k), N01-N29 each once; a case after them (BC-236 on) names the
 * decision that added it (`decision`, an F-number its `source` cites), and no earlier case does; a mapped spin-off
 * case follows its project's map (coverage.v2.json `spinoffs`), each spin-off id once; every newer spin-off case is
 * recorded in `dispositions`, mapped into a case that cites it or withdrawn by a decision (F-number).
 *
 * The coverage rules (`checkCoverageV2`): every live M1 or M3 row maps to at least one test id: a Foundry test
 * (`test_BCnnn_*`, `testFuzz_BCnnn_*`, `testInvariant_BCnnn_*`) in a `.t.sol` file under packages/contracts/test/box-v2,
 * or a vitest or Playwright test whose title starts with its case (`BC-nnn …`, a restated v1 case `BC-nnn v2…`) in a
 * TypeScript test file outside packages/contracts/test. A listed test is `planned` until it is written in its file,
 * then `written`; one written in another file than the map says fails, and so does any written v2 test the map does not
 * list (every Foundry file under box-v2; the TypeScript files the map names and the v1 map's TypeScript sources).
 * An existing non-BC Foundry test may be explicitly marked implementation:true; its function must exist in
 * the named file. Such references can never be planned and cannot bypass a BC-prefixed test's case-id check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATES,
  LAYERS,
  PATHS,
  V2_FIRST_ID,
  isV2Case,
  nValues,
  repoDir,
  scriptFiles,
  solidityFiles,
  stripSolidityComments,
  within,
} from './conformance.mjs';

export const V2_PATHS = {
  coverage: 'packages/box-spec/conformance/coverage.v2.json',
  testDir: PATHS.v2TestDir,
  report: 'docs/evidence/SH-V2-conformance-coverage.md',
};
export const V2_FIRST = V2_FIRST_ID;
export const V2_LAST = 270;
/** Allocated case ranges. BC-239..252 and BC-271 remain reserved to M2's case handoff. */
export const V2_RANGES = [[V2_FIRST, 238], [253, V2_LAST]];
const rangeText = V2_RANGES.map(([first, last]) => `BC-${first} to BC-${last}`).join('; ');
/** M1's own cases: Nk is BC-(PLAN_BASE + k), N01-N29 (core-v2-m1-tickets.md § 3). */
export const PLAN_BASE = 206;
export const PLAN_COUNT = 29;
/**
 * Cases a later founder decision added through the plan's change queue (tickets § 9) are numbered after the plan's,
 * from BC-(DECISION_BASE + 1): BC-236 (F101 R22A), BC-237 (F104), BC-238 (F106). Each names its decision in `decision`.
 */
export const DECISION_BASE = PLAN_BASE + PLAN_COUNT;
export const MILESTONES = ['M1', 'M2', 'M3'];
const CASE_ID = /^BC-(\d{3})$/;
const REQUIRED = ['id', 'core', 'layer', 'title', 'given', 'when', 'then', 'params', 'appliesTo', 'source', 'gate', 'slice', 'ticket'];
const REQUIRED_RESTATED = ['ticket', 'slice', 'gate', 'title', 'given', 'when', 'then', 'params', 'appliesTo', 'source'];
const REQUIRED_WITHDRAWN = ['id', 'core', 'title', 'withdrawn', 'source', 'slice'];
const DECISION = /\bF\d{2,3}\b/;
const FOUNDRY_NAME = /^test(?:Fuzz|Invariant)?_BC(\d{3})_\w+$/;
const SCRIPT_TEST = /\.(?:test|spec)\.tsx?$/;

const idNum = (id) => Number(CASE_ID.exec(id ?? '')?.[1] ?? NaN);
const empty = (v) => v === undefined || v === null || v === '';

/**
 * The v2 rows: every v2 case, and every v1 case restated for v2 (its `v2` statement with the v1 id and layer), in id
 * order. `origin` is `v2` or `restated`.
 */
export function v2Rows(allCases) {
  const rows = [];
  for (const c of allCases ?? []) {
    if (isV2Case(c)) rows.push({ ...c, origin: 'v2' });
    else if (c?.v2 && typeof c.v2 === 'object') rows.push({ ...c.v2, id: c.id, layer: c.layer, origin: 'restated' });
  }
  return rows.sort((a, b) => idNum(a.id) - idNum(b.id));
}

const appliesOk = (a) => {
  const list = typeof a === 'string' ? [a] : Array.isArray(a) ? a : null;
  if (!list || !list.length || list.some((x) => typeof x !== 'string' || !x.trim())) return false;
  return !list.some((x) => x === 'all' || /^T0$/.test(x));
};

/**
 * The loader rules for v2. One message per violation, tagged: [v2-shape] [v2-ids] [v2-ticket] [v2-plan]
 * [v2-decision] [v2-spinoff] [v2-disposition] [factory-n].
 */
export function checkCasesV2(allCases, coverage, { minN }) {
  const errors = [];
  const err = (rule, message) => errors.push(`[${rule}] ${message}`);
  if (!Array.isArray(allCases)) return ['[v2-shape] the case file is not a list'];
  const tickets = coverage?.tickets ?? {};
  const seen = new Map();
  for (const c of allCases) seen.set(c?.id, (seen.get(c?.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) err('v2-ids', `${id}: id twice`);
  // Preserve the original no-gap rule and apply it to every separately allocated milestone range.
  const byId = new Map(allCases.map((c) => [c?.id, c]));
  for (const [first, last] of V2_RANGES) for (let n = first; n <= last; n += 1) {
    const id = `BC-${String(n).padStart(3, '0')}`;
    const c = byId.get(id);
    if (!c) err('v2-ids', `${id}: missing (allocated range BC-${first} to BC-${last} has no gap)`);
    else if (!isV2Case(c)) err('v2-ids', `${id}: a v1 case in the v2 range (mark it core "v2" or renumber it)`);
  }
  for (const c of allCases) {
    if (isV2Case(c) && !V2_RANGES.some(([first, last]) => idNum(c.id) >= first && idNum(c.id) <= last)) err('v2-ids', `${c.id}: a v2 case outside ${rangeText}`);
  }

  const checkRow = (row, required) => {
    const id = row.id;
    for (const key of required) if (empty(row[key])) err('v2-shape', `${id}: missing ${key}${row.origin === 'restated' ? ' (in v2)' : ''}`);
    if (!MILESTONES.includes(row.slice)) err('v2-shape', `${id}: milestone (slice) ${row.slice}, not one of ${MILESTONES.join(', ')}`);
    if (row.withdrawn !== undefined) return;
    if (!LAYERS.includes(row.layer)) err('v2-shape', `${id}: layer ${row.layer}`);
    if (!GATES.includes(row.gate)) err('v2-shape', `${id}: gate ${row.gate}`);
    if (!appliesOk(row.appliesTo)) err('v2-shape', `${id}: appliesTo ${JSON.stringify(row.appliesTo)} (name the v2 boxes; never "all" or box 0)`);
    if (row.params !== undefined && (row.params === null || typeof row.params !== 'object' || Array.isArray(row.params))) err('v2-shape', `${id}: params is not an object`);
    if (!empty(row.ticket)) {
      const t = tickets[row.ticket];
      if (!t) err('v2-ticket', `${id}: ticket ${row.ticket} is not one coverage.v2.json names`);
      else if (t.milestone !== row.slice) err('v2-ticket', `${id}: ticket ${row.ticket} is ${t.milestone}'s, the case is ${row.slice}'s`);
    }
    for (const { path, raw } of nValues(row).filter((v) => v.n === undefined)) err('factory-n', `${id}: ${path} ${JSON.stringify(raw)} is not an integer N`);
    const low = nValues(row).filter(({ n }) => n !== undefined && n < minN);
    if (low.length) err('factory-n', `${id}: ${low.map(({ path, n }) => `${path} ${n}`).join(', ')} below ${minN}`);
  };

  const plans = new Map();
  const spinoffIds = new Map();
  for (const row of v2Rows(allCases)) {
    if (row.origin === 'restated') {
      checkRow(row, REQUIRED_RESTATED);
      continue;
    }
    if (row.withdrawn !== undefined) {
      checkRow(row, REQUIRED_WITHDRAWN);
      if (!DECISION.test(String(row.withdrawn))) err('v2-shape', `${row.id}: withdrawn without the decision that withdrew it`);
      if (!empty(row.ticket)) err('v2-shape', `${row.id}: a withdrawn case has no ticket`);
    } else checkRow(row, REQUIRED);
    // Plan cases: Nk is BC-(206+k).
    if (row.plan !== undefined) {
      const k = /^N(\d{2})$/.exec(String(row.plan))?.[1];
      if (!k || Number(k) < 1 || Number(k) > PLAN_COUNT) err('v2-plan', `${row.id}: plan ${row.plan} is not N01-N${PLAN_COUNT}`);
      else if (idNum(row.id) !== PLAN_BASE + Number(k)) err('v2-plan', `${row.id}: plan ${row.plan} is BC-${PLAN_BASE + Number(k)}`);
      if (plans.has(row.plan)) err('v2-plan', `${row.id}: plan ${row.plan} also on ${plans.get(row.plan)}`);
      plans.set(row.plan, row.id);
    } else if (idNum(row.id) > DECISION_BASE) {
      // A case a later decision added: the decision is an F-number, and the case's source cites it.
      const d = String(row.decision ?? '');
      if (empty(row.decision) || !DECISION.test(d)) err('v2-decision', `${row.id}: after the plan's cases (BC-${DECISION_BASE + 1} on) but names no decision (F-number) that added it`);
      else if (!String(row.source ?? '').includes(d)) err('v2-decision', `${row.id}: its source does not cite its decision ${d}`);
      if (row.spinoff !== undefined) err('v2-decision', `${row.id}: a case a decision added maps no spin-off case`);
    } else if (idNum(row.id) > PLAN_BASE) err('v2-plan', `${row.id}: in the plan's range (BC-${PLAN_BASE + 1} to BC-${DECISION_BASE}) but names no plan case`);
    else if (row.spinoff === undefined) err('v2-spinoff', `${row.id}: in the spin-offs' range (BC-${V2_FIRST} to BC-${PLAN_BASE}) but names no spin-off case`);
    if (row.decision !== undefined && !(idNum(row.id) > DECISION_BASE)) err('v2-decision', `${row.id}: only a case after the plan's (BC-${DECISION_BASE + 1} on) names the decision that added it`);
    // Spin-off cases follow their project's map.
    if (row.spinoff !== undefined) {
      const s = row.spinoff;
      const project = coverage?.spinoffs?.[s?.project];
      if (!project) err('v2-spinoff', `${row.id}: spin-off project ${s?.project} is not one coverage.v2.json names`);
      else {
        const at = (project.map?.ids ?? []).indexOf(s.id);
        const first = idNum(project.map?.first);
        if (at === -1) err('v2-spinoff', `${row.id}: ${s.project} ${s.id} is not in its project's map`);
        else if (idNum(row.id) !== first + at) err('v2-spinoff', `${row.id}: ${s.project} ${s.id} maps to BC-${first + at}`);
        if (empty(s.file)) err('v2-spinoff', `${row.id}: say which file of ${s.project} holds ${s.id}`);
      }
      const key = `${s?.project} ${s?.id}`;
      if (spinoffIds.has(key)) err('v2-spinoff', `${row.id}: ${key} also mapped to ${spinoffIds.get(key)}`);
      spinoffIds.set(key, row.id);
    }
  }
  for (let k = 1; k <= PLAN_COUNT; k += 1) {
    const p = `N${String(k).padStart(2, '0')}`;
    if (!plans.has(p)) err('v2-plan', `BC-${PLAN_BASE + k}: plan case ${p} has no case`);
  }
  for (const [name, project] of Object.entries(coverage?.spinoffs ?? {})) {
    for (const sid of project.map?.ids ?? []) if (!spinoffIds.has(`${name} ${sid}`)) err('v2-spinoff', `${name} ${sid}: in the map but no case maps it`);
  }
  // Dispositions: each newer spin-off case mapped into a case that cites it, or withdrawn by a decision.
  for (const d of coverage?.dispositions ?? []) {
    const tag = `${d.project} ${d.id}`;
    if (!coverage?.spinoffs?.[d.project]) err('v2-disposition', `${tag}: project not named in spinoffs`);
    if (spinoffIds.has(tag)) err('v2-disposition', `${tag}: also mapped to ${spinoffIds.get(tag)}`);
    if (empty(d.into) === empty(d.withdrawn)) err('v2-disposition', `${tag}: say either into (a case) or withdrawn (a decision)`);
    if (empty(d.by) || !DECISION.test(String(d.by))) err('v2-disposition', `${tag}: by names no decision (F-number)`);
    if (!empty(d.withdrawn) && !DECISION.test(String(d.withdrawn))) err('v2-disposition', `${tag}: withdrawn without a decision (F-number)`);
    if (!empty(d.into)) {
      const target = byId.get(d.into);
      if (!target || !isV2Case(target)) err('v2-disposition', `${tag}: into ${d.into}, which is no v2 case`);
      else if (!String(target.source ?? '').includes(d.id)) err('v2-disposition', `${tag}: into ${d.into}, whose source does not cite ${d.id}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------------------------

/** Every Solidity file under packages/contracts/test/box-v2 (none before M1's first contract ticket). */
export function v2TestFiles(root = repoDir) {
  return solidityFiles(V2_PATHS.testDir, root);
}

/** The TypeScript test files to scan: those the map names (that exist) and the v1 map's TypeScript sources. */
export function v2Scripts(coverage, root = repoDir) {
  const named = Object.values(coverage?.cases ?? {})
    .flatMap((e) => e?.tests ?? [])
    .filter((t) => 'title' in t)
    .map((t) => t.file);
  const v1 = JSON.parse(readFileSync(join(root, PATHS.coverage), 'utf8'));
  const v1Sources = (v1.sources ?? []).filter((s) => s.kind === 'typescript').flatMap((s) => s.paths ?? []);
  return scriptFiles([...new Set([...named, ...v1Sources])], root);
}

/** Foundry check names in a source (comments ignored): Map<name, case id>. */
function foundryChecks(source) {
  const code = stripSolidityComments(source);
  const out = new Map();
  for (const m of code.matchAll(/function (test(?:Fuzz|Invariant)?_BC(\d{3})_\w+)\s*\(/g)) out.set(m[1], `BC-${m[2]}`);
  return out;
}

const TITLE_CALL = /^[ \t]*(?:it|test)\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/gm;

/** v2 TypeScript checks of a file: titles starting `BC-nnn` (nnn ≥ 144) or `BC-nnn v2` → the case id. */
function scriptV2Checks(source) {
  const out = new Map();
  for (const m of source.matchAll(TITLE_CALL)) {
    const title = m[2].replace(/\\(.)/g, '$1');
    const head = /^BC-(\d{3})( v2\b)?/.exec(title);
    if (!head) continue;
    if (Number(head[1]) >= V2_FIRST || head[2]) out.set(title, `BC-${head[1]}`);
  }
  return out;
}

/** Every written v2 check: [{ kind, file, name, id }] (Foundry under box-v2; TypeScript in `scripts`). */
export function writtenV2Checks(files, scripts) {
  const out = [];
  for (const f of files ?? []) {
    if (!within(f.path, V2_PATHS.testDir)) continue;
    for (const [name, id] of foundryChecks(f.source)) out.push({ kind: 'foundry', file: f.path, name, id });
  }
  for (const f of scripts ?? []) for (const [name, id] of scriptV2Checks(f.source)) out.push({ kind: 'typescript', file: f.path, name, id });
  return out;
}

const testName = (t) => ('name' in t ? t.name : t.title);
const IMPLEMENTATION_NAME = /^test(?:Fuzz|Invariant)?_(?!BC\d{3}_)\w+$/;
const hasImplementation = (t, files) => (files ?? []).some((f) =>
  f.path === t.file && [...stripSolidityComments(f.source).matchAll(/\bfunction\s+(\w+)\s*\(/g)].some((m) => m[1] === t.name),
);

/** Is the test id well formed for case `id` (restated: a v1 id)? Returns an error message or undefined. */
function testIdProblem(t, row, tickets, files) {
  const name = testName(t);
  if (!t || typeof t !== 'object' || empty(t.file) || empty(name)) return `${JSON.stringify(t)}: a test needs file and name (Foundry) or title (TypeScript)`;
  if ('name' in t && 'title' in t) return `${name}: name or title, not both`;
  if (!empty(t.ticket) && !tickets[t.ticket]) return `${name}: ticket ${t.ticket} is not one coverage.v2.json names`;
  if (t.implementation !== undefined && (t.implementation !== true || !('name' in t))) return `${name}: implementation must be true on a Foundry test`;
  if ('name' in t) {
    if (!within(t.file, V2_PATHS.testDir) || !t.file.endsWith('.t.sol')) return `${t.file}: a Foundry test of v2 lives in a .t.sol file under ${V2_PATHS.testDir}`;
    if (t.implementation === true) {
      if (!IMPLEMENTATION_NAME.test(t.name)) return `${t.name}: implementation references require a non-BC Foundry test name`;
      if (!hasImplementation(t, files)) return `${t.name}: implementation test is missing from ${t.file}`;
      return undefined;
    }
    const m = FOUNDRY_NAME.exec(t.name);
    if (!m) return `${t.name}: not test_BCnnn_*, testFuzz_BCnnn_* or testInvariant_BCnnn_*`;
    if (`BC-${m[1]}` !== row.id) return `${t.name}: names BC-${m[1]}, not ${row.id}`;
    return undefined;
  }
  const want = row.origin === 'restated' ? `${row.id} v2` : row.id;
  if (!t.title.startsWith(want) || /^\w/.test(t.title.slice(want.length))) return `${t.title}: a TypeScript title starts with "${want}"`;
  if (!SCRIPT_TEST.test(t.file) || within(t.file, PATHS.testDir)) return `${t.file}: a TypeScript test of v2 is a *.test.ts(x) or *.spec.ts(x) file outside ${PATHS.testDir}`;
  return undefined;
}

/**
 * The coverage rules for v2. One message per problem, tagged: [unmapped] [v2-test] [v2-unlisted] [v2-map].
 */
export function checkCoverageV2(allCases, coverage, { files, scripts }) {
  const errors = [];
  const rows = v2Rows(allCases);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const tickets = coverage?.tickets ?? {};
  const written = writtenV2Checks(files, scripts);
  const listed = new Set();
  for (const [id, entry] of Object.entries(coverage?.cases ?? {})) {
    const row = rowById.get(id);
    if (!row) {
      errors.push(`[v2-map] ${id}: no v2 case or restated v1 case has this id`);
      continue;
    }
    if (row.withdrawn !== undefined) errors.push(`[v2-map] ${id}: withdrawn (${row.withdrawn}), so it maps no test`);
    if (!Array.isArray(entry?.tests)) {
      errors.push(`[v2-map] ${id}: tests must be a list`);
      continue;
    }
    const names = new Set();
    for (const t of entry.tests) {
      const problem = testIdProblem(t, row, tickets, files);
      if (problem) {
        errors.push(`[v2-test] ${id}: ${problem}`);
        continue;
      }
      const name = testName(t);
      if (names.has(name)) errors.push(`[v2-test] ${id}: ${name} listed twice`);
      names.add(name);
      listed.add(`${t.file}\u0000${name}`);
      const elsewhere = written.filter((w) => w.name === name && w.file !== t.file && w.kind === ('name' in t ? 'foundry' : 'typescript'));
      if (elsewhere.length) errors.push(`[v2-test] ${id}: ${name} is written in ${elsewhere.map((w) => w.file).join(', ')}, not in ${t.file}`);
    }
  }
  for (const row of rows) {
    if (!['M1', 'M3'].includes(row.slice) || row.withdrawn !== undefined) continue;
    const entry = coverage?.cases?.[row.id];
    if (!entry || !Array.isArray(entry.tests) || entry.tests.length === 0) errors.push(`[unmapped] ${row.id} (${row.ticket}): maps to no test id`);
  }
  for (const w of written) {
    if (listed.has(`${w.file}\u0000${w.name}`)) continue;
    const row = rowById.get(w.id);
    const known = row ? '' : ` (${w.id} has no v2 statement)`;
    if (!written.some((x) => x !== w && x.name === w.name && listed.has(`${x.file}\u0000${x.name}`))) {
      errors.push(`[v2-unlisted] ${w.name} (${w.id}) in ${w.file} is in the tests but not in coverage.v2.json${known}`);
    }
  }
  return errors;
}

/** One row per v2 row for the report: its tests with their state (`written` in its file, else `planned`). */
export function coverageRowsV2(allCases, coverage, { files, scripts }) {
  const written = new Set(writtenV2Checks(files, scripts).map((w) => `${w.file}\u0000${w.name}`));
  return v2Rows(allCases).map((row) => {
    const tests = (coverage?.cases?.[row.id]?.tests ?? []).map((t) => ({
      ...t,
      state: (t.implementation === true ? hasImplementation(t, files) : written.has(`${t.file}\u0000${testName(t)}`)) ? 'written' : 'planned',
    }));
    return { ...row, tests };
  });
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const origin = (r) => {
  if (r.origin === 'restated') return 'v1, restated';
  if (r.plan) return r.plan;
  if (r.decision) return r.decision;
  if (r.spinoff) return `${r.spinoff.project === 'link-marines' ? 'LM' : r.spinoff.project === 'junkyard' ? 'JY' : r.spinoff.project} ${r.spinoff.id}`;
  return '';
};

/** The generated v2 report (docs/evidence/SH-V2-conformance-coverage.md). */
export function renderReportV2(allCases, coverage, opts) {
  const rows = coverageRowsV2(allCases, coverage, opts);
  const live = rows.filter((r) => r.withdrawn === undefined);
  const m1 = live.filter((r) => r.slice === 'M1');
  const tests = m1.flatMap((r) => r.tests);
  const m3 = live.filter((r) => r.slice === 'M3');
  const m3Tests = m3.flatMap((r) => r.tests);
  const L = [];
  L.push('# SH-V2 · Core v2 conformance coverage (generated)');
  L.push('');
  L.push(
    '<!-- GENERATED by `node packages/box-spec/scripts/conformance.mjs` from docs/design/launch-pipeline/conformance-cases.json, packages/box-spec/conformance/coverage.v2.json and the v2 tests. Do not edit: `pnpm check:conformance` (in `pnpm verify`) fails when it is stale. -->',
  );
  L.push('');
  L.push(
    `Core v2's cases: ${rows.filter((r) => r.origin === 'v2').length} v2 cases, ${rangeText} (${rows.filter((r) => r.withdrawn !== undefined).length} withdrawn), and ${rows.filter((r) => r.origin === 'restated').length} v1 cases restated for v2. Plan: ${coverage?.plan ?? '(not named)'}. Every live M1 and M3 case maps to at least one test id; a test is *planned* until it is written in its file. Written means discovered, not executed or passing. M1: ${m1.length} cases, ${tests.length} test ids, ${tests.filter((t) => t.state === 'written').length} written. M2: ${live.filter((r) => r.slice === 'M2').length} cases, tied to M2's parts until M2-00 numbers its tickets. M3: ${m3.length} cases, ${m3Tests.length} test ids, ${m3Tests.filter((t) => t.state === 'written').length} written.`,
  );
  L.push('');
  L.push('Gates: G0 blocks the milestone for every box the case applies to; G1 blocks listing third-party tokens or boxes; G2 blocks one menu item; EV is evidence.');
  L.push('');
  const ticketOrder = Object.keys(coverage?.tickets ?? {});
  for (const ms of MILESTONES) {
    const inMs = live.filter((r) => r.slice === ms);
    if (!inMs.length) continue;
    L.push(`## ${ms}`);
    L.push('');
    for (const t of ticketOrder.filter((x) => coverage.tickets[x].milestone === ms)) {
      const rs = inMs.filter((r) => r.ticket === t);
      if (!rs.length) continue;
      L.push(`### ${t} · ${coverage.tickets[t].title}`);
      L.push('');
      L.push('| Case | From | Gate | Title | Tests |');
      L.push('|---|---|---|---|---|');
      for (const r of rs) {
        const ts = r.tests.length
          ? r.tests.map((x) => `${x.state}: \`${x.file.split('/').slice(-2).join('/')}\` \`${testName(x)}\`${x.ticket && x.ticket !== r.ticket ? ` (${x.ticket})` : ''}`).join('; ')
          : 'none yet (M2-00)';
        L.push(`| ${r.id} | ${cell(origin(r))} | ${r.gate} | ${cell(r.title)} | ${cell(ts)} |`);
      }
      L.push('');
    }
  }
  L.push('## Spin-off ids');
  L.push('');
  for (const [name, p] of Object.entries(coverage?.spinoffs ?? {})) {
    const ids = p.map?.ids ?? [];
    L.push(`- **${name}** (\`${p.branch}\` \`${String(p.commit).slice(0, 12)}\`): ${ids[0]} … ${ids[ids.length - 1]} (${ids.length}) → ${p.map?.first} … BC-${idNum(p.map?.first) + ids.length - 1}, in order.`);
  }
  L.push('');
  L.push('| Spin-off case | Disposition | Decision |');
  L.push('|---|---|---|');
  for (const d of coverage?.dispositions ?? []) {
    L.push(`| ${d.project} ${d.id} | ${d.into ? `into ${d.into}` : `withdrawn: ${cell(d.withdrawn)}`} | ${cell(d.by)} |`);
  }
  L.push('');
  const gone = rows.filter((r) => r.withdrawn !== undefined);
  if (gone.length) {
    L.push('## Withdrawn');
    L.push('');
    for (const r of gone) L.push(`- ${r.id} (${origin(r)}): ${r.title}. ${r.withdrawn}`);
    L.push('');
  }
  return L.join('\n');
}
