/**
 * The box conformance case file's loader and checks (launch pipeline v1 § 5, slice S2), and the coverage report of the
 * Foundry checks named after the cases. Used by packages/box-spec/scripts/conformance.mjs (`pnpm check:conformance`,
 * in `pnpm verify`) and by src/conformance.test.ts.
 *
 * The loader check fails when (plan § 5): a T0-only case is below G0; a G0 case for T0 sits in a slice off the Misfits
 * line; a case lacks a slice; a factory-built case uses N below 10 (an N at any depth of its params, in any letter
 * case; a non-integer N is refused); or a box-factory BP row other than the dropped BP-22 and BP-32 has no case. It
 * also refuses a malformed case (id, layer, gate, templates).
 *
 * The coverage check (SH-core-wave-2 spec change 13): the map (packages/box-spec/conformance/coverage.v1.json) names
 * its sources, each a set of folders or files under packages/contracts/test (the S2 harness, the core v1 harness in
 * its subfolder, the lanes' folders). Every case-named check (`test_BCnnn_*`, `testFuzz_BCnnn_*`) anywhere in
 * packages/contracts/test must sit in a named source and be listed under its case and source; every listed check must
 * exist there; a template-0-only source maps only cases for T0; every provider contract exists in a source it runs.
 *
 * TypeScript sources (S10a: `kind: "typescript"`, the indexer's and the site's vitest tests and the Playwright suites)
 * name folders or files outside packages/contracts/test. Their case-named checks are the `it(…)` and `test(…)` calls
 * (at the start of a line) whose title starts with `BC-nnn`; the check's name is its title as written (a template
 * literal's `${…}` kept), and it checks every case its title names (`BC-084: … (BC-090) …` checks both). Each must be
 * listed under every case it names, in its source; every listed one must exist there and name that case. Only the
 * TypeScript sources' own files are read: a title elsewhere is not a check of the map.
 *
 * Core v2 (M1-01): the case file also holds the v2 cases (`core: "v2"`, BC-144 to BC-238) and v1 cases restated for v2
 * (a `v2` object beside the v1 text). `loadInputs` returns the v1 cases as `cases` (the rules and the map here are v1's)
 * and every case as `allCases` for conformance-v2.mjs. Foundry tests under packages/contracts/test/box-v2 and
 * TypeScript titles for a v2 case (BC-144 or above, or `BC-nnn v2…` for a restated v1 case) belong to coverage.v2.json,
 * so this map neither needs nor may list them, and no v1 source may lie inside the v2 test folder.
 *
 * The Misfits gate's verdict (review of the Misfits line, finding 3): every case for T0 is green (checked, or done in
 * S1) or open (partial, or pending). A partial case for T0 must say what box 0 itself still waits for (`waitsT0`); a
 * case whose box-0 part waits for nothing is checked by the definitions (only matrix values version 1 cannot build may
 * wait), so `waitsT0` appears on no other entry. `t0Gate` counts the green G0 cases for T0, the gate's number.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const pkgDir = resolve(here, '../..');
export const repoDir = resolve(pkgDir, '../..');

export const PATHS = {
  cases: 'docs/design/launch-pipeline/conformance-cases.json',
  boxFactory: 'docs/design/box-factory.md',
  boxSpec: 'packages/box-spec/box-spec.v1.json',
  coverage: 'packages/box-spec/conformance/coverage.v1.json',
  /** The Foundry harness: S2's BoxConformance on today's v2 contracts, and core v1's in its subfolder `core/`. */
  harnessDir: 'packages/contracts/test/box/conformance',
  /** Every Foundry test: a case-named check anywhere under it must sit in a source the coverage map names. */
  testDir: 'packages/contracts/test',
  report: 'docs/evidence/SH-S2-conformance-coverage.md',
  /** Core v2's Foundry tests: their case-named checks belong to coverage.v2.json, never to this map. */
  v2TestDir: 'packages/contracts/test/box-v2',
};

/** The first v2 case id (core-v2-m1-tickets.md § 3: Link Marines' BC-NEW-1 is BC-144). */
export const V2_FIRST_ID = 144;
/** A TypeScript title that checks a v1 case restated for v2 (`BC-036 v2: …`): coverage.v2.json's, not this map's. */
const V2_RESTATED_TITLE = /^BC-\d{3} v2\b/;
/** True for a case of the v2 cases (core v2), false for a v1 case. */
export const isV2Case = (c) => c?.core === 'v2';

/** Plan § 4: S0-S10a are the Misfits line; its gate row (slice `GATE`, after S10a) is on it too. */
export const MISFITS_LINE = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10a', 'GATE'];
/** Plan § 4: S10b-S15 never block the Misfits. */
export const OFF_LINE = ['S10b', 'S11', 'S12', 'S13', 'S14', 'S15'];
export const SLICES = [...MISFITS_LINE, ...OFF_LINE];
export const GATES = ['G0', 'G1', 'G2', 'EV'];
export const LAYERS = ['contract', 'indexer', 'web'];
const TEMPLATE = /^T(?:\d+|3a)$/;
const CASE_ID = /^BC-\d{3}$/;
const REQUIRED = ['id', 'layer', 'title', 'given', 'when', 'then', 'params', 'appliesTo', 'source', 'gate', 'slice'];

/** Plan § 5: the box-factory rows dropped on purpose: BP-22 (several depositors, phase 3), BP-32 (existing collections). */
export const DROPPED_BP = [22, 32];
/**
 * N values below the minimum that are refusal inputs, not boxes that get built: per case, the one params key (its path)
 * and the exact values exempted; the case expects the refusal. Each must still say so in its `then` and still list
 * one of those values under that key, or the exception is stale. Any other low N in the same case still fails.
 */
export const REFUSAL_INPUTS = {
  'BC-001': { key: 'N', values: [1, 9], why: 'spec vectors: validate() must refuse N 1 and 9' },
  'BC-008': { key: 'N', values: [1, 2, 9], why: 'createBox must revert for N below 10' },
};
/** Params keys naming a directly built BoxVault (vault-unit tests), where N 1 and 2 are allowed (plan § 5). */
export const VAULT_UNIT_KEYS = ['N_vault_unit'];

export const appliesToT0 = (c) => c.appliesTo === 'all' || (Array.isArray(c.appliesTo) && c.appliesTo.includes('T0'));
export const isT0Only = (c) => Array.isArray(c.appliesTo) && c.appliesTo.length === 1 && c.appliesTo[0] === 'T0';

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

/**
 * The case file, the box-factory BP row ids and the spec's minimum N: `cases` are the v1 cases (every case not marked
 * `core: "v2"`, restated ones included with their v1 text), `allCases` the whole file.
 */
export function loadInputs(root = repoDir) {
  const allCases = JSON.parse(read(root, PATHS.cases));
  const cases = Array.isArray(allCases) ? allCases.filter((c) => !isV2Case(c)) : allCases;
  const bpRows = [...read(root, PATHS.boxFactory).matchAll(/^\| BP-(\d+) \|/gm)].map((m) => Number(m[1]));
  const minN = JSON.parse(read(root, PATHS.boxSpec)).constants.find((c) => c.name === 'MIN_N');
  if (!minN) throw new Error(`${PATHS.boxSpec} has no MIN_N`);
  return { cases, allCases, bpRows, minN: Number(minN.value) };
}

/** A params key naming an edition size: N, N_factory, N_vault_unit, ... in any case (n, n_factory). */
const N_KEY = /^n(?:_|$)/i;

/**
 * Every N value a case's params name, at any depth (`matrix.N`, `runs[0].N`): `{ path, key, n }` with `key` the last
 * key and `path` the dotted path. A value that is not an integer is returned with `n` undefined and `raw` set, so the
 * loader can refuse it instead of skipping it.
 */
export function nValues(c) {
  const out = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const at = path ? `${path}.${key}` : key;
      if (N_KEY.test(key)) {
        for (const raw of Array.isArray(value) ? value : [value]) {
          out.push(Number.isInteger(raw) ? { path: at, key, n: raw } : { path: at, key, n: undefined, raw });
        }
      } else {
        walk(value, at);
      }
    }
  };
  walk(c.params ?? {}, '');
  return out;
}

/**
 * The loader rules. Returns one message per violation, each tagged with its rule:
 * [shape] [slice] [t0-gate] [misfits-line] [factory-n] [bp-coverage].
 */
export function checkCases(cases, { bpRows, minN }) {
  const errors = [];
  const err = (rule, message) => errors.push(`[${rule}] ${message}`);
  if (!Array.isArray(cases) || cases.length === 0) return ['[shape] the case file holds no cases'];
  const ids = new Set();
  for (const c of cases) {
    const id = c?.id ?? '(no id)';
    for (const key of REQUIRED) {
      if (key === 'slice') continue;
      if (c[key] === undefined || c[key] === '') err('shape', `${id}: missing ${key}`);
    }
    if (!CASE_ID.test(id)) err('shape', `${id}: id is not BC-nnn`);
    if (ids.has(id)) err('shape', `${id}: id twice`);
    ids.add(id);
    if (!LAYERS.includes(c.layer)) err('shape', `${id}: layer ${c.layer}`);
    if (!GATES.includes(c.gate)) err('shape', `${id}: gate ${c.gate}`);
    const templates = c.appliesTo;
    if (templates !== 'all' && !(Array.isArray(templates) && templates.length && templates.every((t) => TEMPLATE.test(t)))) {
      err('shape', `${id}: appliesTo ${JSON.stringify(templates)}`);
    }
    // A case lacks a slice.
    if (typeof c.slice !== 'string' || c.slice === '') err('slice', `${id}: lacks a slice`);
    else if (!SLICES.includes(c.slice)) err('slice', `${id}: unknown slice ${c.slice}`);
    // A T0-only case below G0.
    if (isT0Only(c) && c.gate !== 'G0') err('t0-gate', `${id}: T0-only case at ${c.gate}, below G0`);
    // A G0 case for T0 off the Misfits line.
    if (c.gate === 'G0' && appliesToT0(c) && typeof c.slice === 'string' && !MISFITS_LINE.includes(c.slice)) {
      err('misfits-line', `${id}: G0 case for T0 in ${c.slice}, off the Misfits line (${MISFITS_LINE.join(', ')})`);
    }
    // An N that is not an integer cannot be checked against the minimum: refused, not skipped.
    for (const { path, raw } of nValues(c).filter((v) => v.n === undefined)) {
      err('factory-n', `${id}: ${path} ${JSON.stringify(raw)} is not an integer N`);
    }
    // A factory-built case with N below the minimum (a refusal input is exempt only at its own key and values).
    const exempt = REFUSAL_INPUTS[id];
    const low = nValues(c).filter(
      ({ path, key, n }) =>
        n !== undefined &&
        n < minN &&
        !VAULT_UNIT_KEYS.includes(key) &&
        !(exempt && exempt.key === path && exempt.values.includes(n)),
    );
    if (low.length) {
      err('factory-n', `${id}: ${low.map(({ path, n }) => `${path} ${n}`).join(', ')} below ${minN} (only a directly built BoxVault may go lower: ${VAULT_UNIT_KEYS.join(', ')})`);
    }
  }
  // Refusal exceptions must stay true: the case exists, still lists one of its exempt N values at its key, and still
  // expects the refusal.
  for (const [id, { key, values, why }] of Object.entries(REFUSAL_INPUTS)) {
    const c = cases.find((x) => x.id === id);
    if (!c) err('factory-n', `refusal exception ${id} (${why}) names no case`);
    else if (!nValues(c).some(({ path, n }) => path === key && values.includes(n) && n < minN)) {
      err('factory-n', `refusal exception ${id}: ${key} lists none of ${values.join(', ')} below ${minN} any more (stale)`);
    } else if (!/revert|refus/i.test(c.then)) err('factory-n', `refusal exception ${id}: its then no longer expects a refusal`);
  }
  // A box-factory BP row other than the dropped ones has no case.
  const cited = new Set();
  for (const c of cases) for (const m of String(c.source ?? '').matchAll(/BP-(\d+)/g)) cited.add(Number(m[1]));
  if (!bpRows.length) err('bp-coverage', 'no BP rows found in box-factory.md');
  for (const row of bpRows) {
    if (!DROPPED_BP.includes(row) && !cited.has(row)) err('bp-coverage', `BP-${String(row).padStart(2, '0')} has no case`);
  }
  for (const bp of cited) if (!bpRows.includes(bp)) err('bp-coverage', `a case cites BP-${bp}, which box-factory.md does not have`);
  return errors;
}

/** Case counts: the total, the G0 cases for T0 (the Misfits gate) and the slices' case counts. */
export function summarise(cases) {
  const count = (key) => cases.reduce((m, c) => ({ ...m, [c[key]]: (m[c[key]] ?? 0) + 1 }), {});
  return {
    total: cases.length,
    bySlice: count('slice'),
    byGate: count('gate'),
    byLayer: count('layer'),
    g0ForT0: cases.filter((c) => c.gate === 'G0' && appliesToT0(c)).length,
  };
}


// ---------------------------------------------------------------------------------------------------------------
// Coverage of the Foundry checks
// ---------------------------------------------------------------------------------------------------------------

export const STATUSES = {
  checked:
    'every condition of the case is checked locally on the core v1 contracts (the core harness on box 0 as factory v1 created it, in six states; the lanes\' and S7\'s tests on their built boxes; Foundry, `pnpm test:contracts`, in `pnpm verify:all`; `pnpm check:conformance` checks the names), or, for an indexer or web case, by the vitest and Playwright tests named after it on box 0\'s recorded and live local life and on synthetic boxes (`pnpm test`, `pnpm e2e`, the live `pnpm e2e:core-chain`); only matrix values version 1 cannot build wait (another Q: S12; another template, several boxes, a failure or version 2\'s menu: factory v2, S11, S14), so for box 0 nothing waits',
  partial:
    'the conditions named are checked as for "checked"; the rest waits for what is named: factory v2 (S11), a later slice\'s build, a check still to write, or a run on a fork or on Sepolia; for a case that applies to T0, `waitsT0` names what box 0 itself still waits for',
  'done-s1': 'covered in S1 (shared vectors, layout library); the harness adds the instance check where listed',
  pending: 'not checked yet: waits for the slice, layer or template named',
};

/** The Misfits gate's verdict on a case for T0: `green` (checked or done in S1) or `open`; undefined for other cases. */
export function t0Verdict(c, entry) {
  if (!appliesToT0(c)) return undefined;
  const status = entry?.status ?? 'pending';
  return status === 'checked' || status === 'done-s1' ? 'green' : 'open';
}

/**
 * The Misfits gate (plan § 4: every G0 case for T0 green): how many G0 cases for T0 there are, how many are green and
 * open, and their statuses.
 */
export function t0Gate(cases, coverage) {
  const g0 = cases.filter((c) => c.gate === 'G0' && appliesToT0(c));
  const byStatus = { checked: 0, 'done-s1': 0, partial: 0, pending: 0 };
  let green = 0;
  for (const c of g0) {
    const entry = coverage.cases?.[c.id];
    const status = entry?.status ?? 'pending';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (t0Verdict(c, entry) === 'green') green += 1;
  }
  return { g0ForT0: g0.length, green, open: g0.length - green, byStatus };
}

const SLICE_WORK = {
  S0: 'spikes (mined clone hook, createBox prototype, stream checkpoint)',
  S1: 'BoxSpec and layout library',
  S2: 'conformance harness',
  S3: 'runtime names and N as data (BoxToken, BoxVault, BoxCollection, BoxTickets), ERC-2981 royalties',
  S4: 'BoxHook and router (D1 close on fill, D3 closed pool, graduated layout, pair and lock for every box, creator pre-open buy)',
  S5: "batch fees (D2), BoxReceiver with box 0's platform cap, REV-16, P8 batches, depth budget, royalty router",
  S6: 'coordinator (unblockable graduate(), D6 reward)',
  S7: 'factory v1, registry, box 0 equivalence, randomness pin',
  S8: 'per-Misfit stream',
  S9: 'randomness per F61 R4 (drand only, no Chainlink backup)',
  S10a: 'box 0 off chain (indexer target, history, feed, link-outs)',
  S10b: 'indexer and site for many boxes',
  S11: "factory v2 (deadlines, failure, open art, other boxes' fee, tax and royalty routing)",
  S12: 'curated ERC-20 Q',
  S13: 'creation page',
  S14: 'holder payouts (counsel)',
  S15: 'existing collections',
  GATE: 'the Misfits gate (Sepolia life run per template)',
};

/**
 * Solidity source without its comments (`//` to the end of the line, `/* … *\/`), string literals kept, so a
 * commented-out check or contract is not counted. Newlines inside block comments are kept.
 */
export function stripSolidityComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** stripSolidityComments by source text, kept for the process (the check and its tests read the same files again). */
const STRIPPED = new Map();
function strippedCode(source) {
  let code = STRIPPED.get(source);
  if (code === undefined) {
    code = stripSolidityComments(source);
    STRIPPED.set(source, code);
  }
  return code;
}

/** A repository-relative path with forward slashes. */
const posix = (p) => p.split(sep).join('/');

/**
 * Every Solidity file under `dir` (repository-relative), subfolders included, in path order: `{ path, source }` with
 * `path` repository-relative. A missing folder gives none.
 */
export function solidityFiles(dir = PATHS.testDir, root = repoDir) {
  const base = join(root, dir);
  if (!existsSync(base)) return [];
  const walk = (abs) =>
    readdirSync(abs)
      .sort()
      .flatMap((name) => {
        const p = join(abs, name);
        if (statSync(p).isDirectory()) return walk(p);
        return name.endsWith('.sol') ? [p] : [];
      });
  return walk(base)
    .map((abs) => ({ path: posix(relative(root, abs)), source: readFileSync(abs, 'utf8') }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The harness's files: packages/contracts/test/box/conformance and its subfolders (core v1's in `core/`). */
export function harnessSources(root = repoDir) {
  return solidityFiles(PATHS.harnessDir, root);
}

/**
 * Check names in a Solidity source (comments ignored): `test_BCnnn_*` and `testFuzz_BCnnn_*` (mapped to case BC-nnn),
 * and the harness's own `test_harness_*`.
 */
export function harnessChecks(source) {
  const code = strippedCode(source);
  const checks = new Map();
  for (const m of code.matchAll(/function (test(?:Fuzz)?_BC(\d{3})_\w+)\s*\(/g)) checks.set(m[1], `BC-${m[2]}`);
  const harness = [...code.matchAll(/function (test_harness_\w+)\s*\(/g)].map((m) => m[1]);
  return { checks, harness };
}

/** True when `path` is `p` or lies under the folder `p`. */
export const within = (path, p) => path === p || path.startsWith(`${p.replace(/\/$/, '')}/`);

/** The source a file belongs to: the one whose path matches it most closely (a file or a deeper folder wins). */
export function sourceOf(path, sources) {
  let best;
  let bestLength = -1;
  for (const s of sources ?? []) {
    for (const p of s.paths ?? []) {
      if (within(path, p) && p.length > bestLength) {
        best = s.id;
        bestLength = p.length;
      }
    }
  }
  return best;
}

/**
 * Every case-named check in `files`, by source: `{ bySource: Map<source, Map<check, case>>, outside: [{ path, check,
 * id }] }` (`outside`: checks in no source of the map).
 */
export function scanChecks(files, sources) {
  const bySource = new Map((sources ?? []).map((s) => [s.id, new Map()]));
  const outside = [];
  for (const { path, source } of files) {
    const { checks } = harnessChecks(source);
    if (!checks.size) continue;
    const id = sourceOf(path, sources);
    for (const [check, caseId] of checks) {
      if (id === undefined) outside.push({ path, check, id: caseId });
      else bySource.get(id).set(check, caseId);
    }
  }
  return { bySource, outside };
}

/** A source's kind: Foundry (the default) or TypeScript (vitest and Playwright). */
export const sourceKind = (s) => (s?.kind === 'typescript' ? 'typescript' : 'foundry');

const SCRIPT_TEST = /\.(?:test|spec)\.tsx?$/;

/**
 * Every TypeScript test file (`*.test.ts(x)`, `*.spec.ts(x)`) under `paths` (repository-relative folders or files), in
 * path order, without node_modules or dot-folders: `{ path, source }`.
 */
export function scriptFiles(paths, root = repoDir) {
  const out = new Map();
  const walk = (abs) => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        walk(join(abs, name));
      }
      return;
    }
    if (SCRIPT_TEST.test(abs)) out.set(posix(relative(root, abs)), readFileSync(abs, 'utf8'));
  };
  for (const p of paths ?? []) walk(join(root, p));
  return [...out.entries()].map(([path, source]) => ({ path, source })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The TypeScript test files of the map's TypeScript sources. */
export function sourceScripts(coverage, root = repoDir) {
  return scriptFiles((coverage.sources ?? []).filter((s) => sourceKind(s) === 'typescript').flatMap((s) => s.paths ?? []), root);
}

const TITLE_CALL = /^[ \t]*(?:it|test)\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/gm;
const unescapeTitle = (raw) => raw.replace(/\\(.)/g, '$1');

/**
 * The case-named checks of a TypeScript test file: every `it(` or `test(` call at the start of a line whose title (a
 * string or template literal on one line) starts with `BC-nnn`. Returns Map<title, case ids named in the title>.
 */
export function scriptChecks(source) {
  const checks = new Map();
  for (const m of source.matchAll(TITLE_CALL)) {
    const title = unescapeTitle(m[2]);
    if (!/^BC-\d{3}\b/.test(title) || V2_RESTATED_TITLE.test(title)) continue;
    const ids = [...new Set([...title.matchAll(/\bBC-(\d{3})\b/g)].map((x) => `BC-${x[1]}`))];
    checks.set(title, [...new Set([...(checks.get(title) ?? []), ...ids])]);
  }
  return checks;
}

/** The case-named checks of the TypeScript sources: Map<source id, Map<title, case ids>>. */
export function scanScriptChecks(scripts, sources) {
  const ts = (sources ?? []).filter((s) => sourceKind(s) === 'typescript');
  const bySource = new Map(ts.map((s) => [s.id, new Map()]));
  for (const { path, source } of scripts ?? []) {
    const id = sourceOf(path, ts);
    if (id === undefined) continue;
    const found = bySource.get(id);
    for (const [title, ids] of scriptChecks(source)) found.set(title, [...new Set([...(found.get(title) ?? []), ...ids])]);
  }
  return bySource;
}

/** A case entry's checks as `[source, names]` pairs, in the map's source order. */
export function entryChecks(entry, sources) {
  const listed = entry?.checks ?? {};
  const order = (sources ?? []).map((s) => s.id);
  return Object.entries(listed).sort(([a], [b]) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
}

const checkCount = (entry) => Object.values(entry?.checks ?? {}).reduce((n, names) => n + (Array.isArray(names) ? names.length : 0), 0);

/**
 * Coverage map consistency against the case file and the Foundry test files (`files`: `{ path, source }` for every
 * Solidity file under packages/contracts/test). Returns one message per problem.
 */
export function checkCoverage(cases, coverage, { files, scripts = [] }) {
  const errors = [];
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const sources = coverage.sources ?? [];
  const foundry = sources.filter((s) => sourceKind(s) === 'foundry');
  const sourceIds = new Set();
  if (!sources.length) errors.push('the map names no sources');
  for (const s of sources) {
    if (!s.id || sourceIds.has(s.id)) errors.push(`source ${s.id ?? '(no id)'}: id missing or twice`);
    sourceIds.add(s.id);
    if (!s.about) errors.push(`source ${s.id}: say what it is`);
    if (s.kind !== undefined && s.kind !== 'foundry' && s.kind !== 'typescript') errors.push(`source ${s.id}: unknown kind ${s.kind}`);
    if (!Array.isArray(s.paths) || !s.paths.length) errors.push(`source ${s.id}: no paths`);
    for (const p of s.paths ?? []) {
      if (sourceKind(s) === 'typescript') {
        if (within(p, PATHS.testDir)) errors.push(`source ${s.id}: ${p} is inside ${PATHS.testDir} (a Foundry folder)`);
        else if (!scripts.some((f) => within(f.path, p))) errors.push(`source ${s.id}: ${p} holds no TypeScript test file`);
      } else if (!within(p, PATHS.testDir)) errors.push(`source ${s.id}: ${p} is outside ${PATHS.testDir}`);
      else if (within(p, PATHS.v2TestDir)) errors.push(`source ${s.id}: ${p} is inside ${PATHS.v2TestDir} (coverage.v2.json's tests)`);
      else if (!files.some((f) => within(f.path, p))) errors.push(`source ${s.id}: ${p} holds no Solidity file`);
    }
  }
  // Core v2's Foundry tests are coverage.v2.json's (conformance-v2.mjs checks them).
  const v1Files = files.filter((f) => !within(f.path, PATHS.v2TestDir));
  const { bySource: solidity, outside } = scanChecks(v1Files, foundry);
  for (const { path, check, id } of outside) {
    errors.push(`${check} (${id}) in ${path} is outside every source the map names`);
  }
  // Per source, every case-named check and the cases it names (one for a Foundry check).
  const bySource = new Map([...solidity].map(([id, checks]) => [id, new Map([...checks].map(([name, caseId]) => [name, [caseId]]))]));
  // A TypeScript title whose cases are all v2 cases (BC-144 or above) is coverage.v2.json's.
  const isV2Title = (ids) => ids.every((x) => Number(x.slice(3)) >= V2_FIRST_ID);
  for (const [id, checks] of scanScriptChecks(scripts, sources)) {
    bySource.set(id, new Map([...checks].filter(([, ids]) => !isV2Title(ids))));
  }
  for (const s of sources) {
    if (sourceIds.has(s.id) && bySource.get(s.id)?.size === 0) errors.push(`source ${s.id} holds no ${sourceKind(s) === 'typescript' ? 'BC-nnn' : 'test_BCnnn_'} check`);
  }
  const listed = new Set();
  for (const [id, entry] of Object.entries(coverage.cases ?? {})) {
    const c = caseById.get(id);
    if (!c) errors.push(`coverage names ${id}, which the case file does not have`);
    if (!(entry.status in STATUSES)) errors.push(`${id}: unknown status ${entry.status}`);
    if (entry.checks !== undefined && (entry.checks === null || typeof entry.checks !== 'object' || Array.isArray(entry.checks))) {
      errors.push(`${id}: checks must map a source to its check names`);
      continue;
    }
    const n = checkCount(entry);
    if ((entry.status === 'checked' || entry.status === 'partial') && n === 0) errors.push(`${id}: status ${entry.status} needs at least one check`);
    if (entry.status === 'pending' && n) errors.push(`${id}: pending but lists checks`);
    if ((entry.status === 'checked' || entry.status === 'partial' || entry.status === 'done-s1') && !entry.covered) {
      errors.push(`${id}: say what is covered`);
    }
    if (entry.status === 'partial' && !entry.waits) errors.push(`${id}: partial needs what waits`);
    if (c && entry.waitsT0 !== undefined && !appliesToT0(c)) errors.push(`${id}: waitsT0, but ${id} does not apply to T0`);
    else if (entry.waitsT0 !== undefined && entry.status !== 'partial') {
      errors.push(`${id}: waitsT0 on a ${entry.status} case (only a partial case for T0 waits for box 0)`);
    } else if (c && entry.status === 'partial' && appliesToT0(c) && (typeof entry.waitsT0 !== 'string' || !entry.waitsT0.trim())) {
      errors.push(`${id}: partial for T0 needs waitsT0 (what box 0 still waits for); with nothing left for box 0 it is checked`);
    }
    if (entry.status === 'done-s1' && !entry.where) errors.push(`${id}: done-s1 needs where`);
    for (const [sourceId, names] of Object.entries(entry.checks ?? {})) {
      const source = sources.find((s) => s.id === sourceId);
      if (!source) {
        errors.push(`${id}: source ${sourceId} is not one the map names`);
        continue;
      }
      if (!Array.isArray(names) || !names.length) {
        errors.push(`${id}: source ${sourceId} lists no checks`);
        continue;
      }
      const found = bySource.get(sourceId);
      const seen = new Set();
      for (const name of names) {
        if (seen.has(name)) errors.push(`${id}: check ${name} listed twice under ${sourceId}`);
        seen.add(name);
        if (!found?.has(name)) errors.push(`${id}: check ${name} is not in source ${sourceId} (${source.paths.join(', ')})`);
        else if (!found.get(name).includes(id)) errors.push(`${id}: check ${name} belongs to ${found.get(name).join(', ')}`);
        listed.add(`${sourceId}\u0000${name}\u0000${id}`);
      }
      if (source.templateZeroOnly && c && !appliesToT0(c)) {
        errors.push(`${id}: source ${sourceId} runs on template 0 only, but ${id} does not apply to T0`);
      }
    }
  }
  for (const [sourceId, found] of bySource) {
    for (const [name, ids] of found) {
      for (const id of ids) {
        if (!listed.has(`${sourceId}\u0000${name}\u0000${id}`)) errors.push(`${name} (${id}, source ${sourceId}) is in the tests but not in the coverage map`);
      }
    }
  }
  const codeByFile = v1Files.map((f) => ({ path: f.path, code: strippedCode(f.source) }));
  for (const p of coverage.providers ?? []) {
    const runs = p.runs ?? [];
    for (const r of runs) if (!sourceIds.has(r)) errors.push(`provider ${p.id}: runs ${r}, which the map does not name`);
    if (p.contracts.length && !runs.length) errors.push(`provider ${p.id}: say which sources it runs`);
    const own = codeByFile.filter((f) => runs.includes(sourceOf(f.path, sources)));
    for (const contract of p.contracts) {
      const declared = new RegExp(`(?:^|[^\\w])contract ${contract}\\b`, 'm');
      if (!own.some((f) => declared.test(f.code.replace(/\babstract\s+contract\b/g, 'abstract_contract')))) {
        errors.push(`provider ${p.id}: contract ${contract} not found in its sources (${runs.join(', ') || 'none'})`);
      }
    }
  }
  return errors;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Why a case without a check waits. */
function pendingReason(c, entry) {
  const parts = [];
  if (!appliesToT0(c)) parts.push("not template 0 (today's contracts build box 0 and the lanes' stand-in boxes)");
  if (c.layer !== 'contract') parts.push(`${c.layer} layer`);
  parts.push(`waits for ${c.slice}: ${SLICE_WORK[c.slice] ?? c.slice}`);
  if (entry?.why) parts.push(entry.why);
  return parts.join('; ');
}

export function coverageRows(cases, coverage) {
  const sources = coverage.sources ?? [];
  return cases.map((c) => {
    const entry = coverage.cases?.[c.id];
    const status = entry?.status ?? 'pending';
    let detail;
    if (status === 'pending') detail = pendingReason(c, entry);
    else {
      const checks = entryChecks(entry, sources)
        .map(([source, names]) => `${source}: ${names.map((n) => `\`${n}\``).join(', ')}`)
        .join('; ');
      detail = [
        entry.where ? `S1: ${entry.where}` : '',
        checks ? `checks (${checks})` : '',
        `covered: ${entry.covered}`,
        entry.waitsT0 ? `waits for box 0: ${entry.waitsT0}` : '',
        entry.waits ? `waits: ${entry.waits}` : '',
      ]
        .filter(Boolean)
        .join('. ');
    }
    return {
      id: c.id,
      layer: c.layer,
      gate: c.gate,
      slice: c.slice,
      t0: appliesToT0(c),
      t0Verdict: t0Verdict(c, entry),
      status,
      detail,
      checks: checkCount(entry),
    };
  });
}

/** Per source: how many checks the map lists and for how many cases. */
export function sourceCounts(coverage) {
  const out = new Map((coverage.sources ?? []).map((s) => [s.id, { checks: 0, cases: 0 }]));
  for (const entry of Object.values(coverage.cases ?? {})) {
    for (const [source, names] of Object.entries(entry.checks ?? {})) {
      const n = out.get(source);
      if (!n || !Array.isArray(names)) continue;
      n.checks += names.length;
      n.cases += 1;
    }
  }
  return out;
}

export function renderReport(cases, coverage) {
  const rows = coverageRows(cases, coverage);
  const s = summarise(cases);
  const byStatus = (st) => rows.filter((r) => r.status === st);
  const counts = sourceCounts(coverage);
  const L = [];
  L.push('# SH-S2 · Box conformance coverage (generated)');
  L.push('');
  L.push(
    '<!-- GENERATED by `node packages/box-spec/scripts/conformance.mjs` from docs/design/launch-pipeline/conformance-cases.json, packages/box-spec/conformance/coverage.v1.json and the Foundry tests in packages/contracts/test. Do not edit: `pnpm check:conformance` (in `pnpm verify`) fails when it is stale. -->',
  );
  L.push('');
  L.push(
    `Every case of the [conformance case file](../design/launch-pipeline/conformance-cases.json) (${s.total} cases, ${s.g0ForT0} G0 cases for T0) with its layer, gate, slice and status against today's contracts. Evidence: [SH-S2-conformance](SH-S2-conformance.md), [SH-core-wave-2](SH-core-wave-2.md), [SH-F74-conformance](SH-F74-conformance.md), [SH-S10a](SH-S10a.md). Checks are Foundry functions named after their case (\`test_BCnnn_*\`, \`testFuzz_BCnnn_*\`); every one in \`packages/contracts/test\` sits in one of these sources and is listed under its case. In the TypeScript sources (since S10a) a check is a vitest or Playwright test whose title starts with its case (\`BC-nnn …\`), listed under every case its title names:`,
  );
  L.push('');
  for (const src of coverage.sources ?? []) {
    const n = counts.get(src.id) ?? { checks: 0, cases: 0 };
    const paths = src.paths.map((p) => `\`${p}\``).join(', ');
    const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
    L.push(`- **${src.id}** (${sourceKind(src) === 'typescript' ? 'TypeScript: ' : ''}${paths}${src.templateZeroOnly ? '; template 0 only' : ''}; ${plural(n.checks, 'check')}, ${plural(n.cases, 'case')}): ${src.about}`);
  }
  L.push('');
  L.push('Providers (the test contracts that run a source\'s instance checks on a box):');
  L.push('');
  for (const p of coverage.providers ?? []) {
    const contracts = p.contracts.length ? ` (${p.contracts.map((c) => `\`${c}\``).join(', ')})` : '';
    const runs = (p.runs ?? []).length ? ` Runs ${p.runs.map((r) => `**${r}**`).join(' and ')}.` : '';
    L.push(`- **${p.id}**: ${p.about}${contracts}.${runs}`);
  }
  L.push('');
  const gate = t0Gate(cases, coverage);
  L.push(
    `**The Misfits gate (every G0 case for T0 green): ${gate.green} of ${gate.g0ForT0} green** (checked ${gate.byStatus.checked}, done in S1 ${gate.byStatus['done-s1']}); open: partial ${gate.byStatus.partial} (each names what box 0 still waits for), pending ${gate.byStatus.pending}. The T0 column gives each case's verdict for box 0: green (checked or done in S1), open (partial or pending), or no (not template 0).`,
  );
  L.push('');
  L.push('| Status | Cases | G0 for T0 | Meaning |');
  L.push('|---|---:|---:|---|');
  for (const st of Object.keys(STATUSES)) {
    const r = byStatus(st);
    L.push(`| ${st} | ${r.length} | ${r.filter((x) => x.gate === 'G0' && x.t0).length} | ${cell(STATUSES[st])} |`);
  }
  L.push('');
  L.push('| Case | Layer | Gate | Slice | T0 | Status | Checks and what waits |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of rows) L.push(`| ${r.id} | ${r.layer} | ${r.gate} | ${r.slice} | ${r.t0Verdict ?? 'no'} | ${r.status} | ${cell(r.detail)} |`);
  L.push('');
  return `${L.join('\n')}`;
}
