/** Types for conformance.mjs (the box conformance case loader and harness coverage, slice S2). */
export interface ConformanceCase {
  id: string;
  layer: string;
  title: string;
  given: string;
  when: string;
  then: string;
  params: Record<string, unknown>;
  appliesTo: 'all' | string | string[];
  source: string;
  gate: string;
  slice?: string;
  /** Core v2 (M1-01): marks a v2 case (BC-144 to BC-238); conformance-v2.mjs checks it. */
  core?: 'v2';
  /** The one ticket (M1-nn) or M2 part (M2:…) that builds a v2 case. */
  ticket?: string;
  /** M1's own case number (N01-N29), BC-(206+k). */
  plan?: string;
  /** A case a later decision added through the plan's change queue (BC-236 on): the decision (an F-row). */
  decision?: string;
  /** The spin-off case a v2 case maps (core-v2-m1-tickets.md § 3). */
  spinoff?: { project: string; id: string; icr?: string; file: string };
  /** A withdrawn v2 case: the decision that withdrew it. */
  withdrawn?: string;
  /** What a mapped case's text changed against its spin-off case, and the decision or ADR section that changed it. */
  restated?: string;
  /** What M2-00 must settle in an M2 case kept as written. */
  m2Notes?: string;
  /** A v1 case restated for v2: the v2 statement beside the v1 text (the v1 text stays v1's). */
  v2?: RestatedV2;
}

/** A v1 case's v2 statement (ADR-0017's doc fixes). */
export interface RestatedV2 {
  ticket: string;
  slice: string;
  gate: string;
  title: string;
  given: string;
  when: string;
  then: string;
  params: Record<string, unknown>;
  appliesTo: string | string[];
  source: string;
}

export interface CoverageEntry {
  status: 'checked' | 'partial' | 'done-s1' | 'pending';
  /** Check names per source id (`coverage.sources[].id`). */
  checks?: Record<string, string[]>;
  covered?: string;
  waits?: string;
  where?: string;
  why?: string;
  /** What box 0 itself still waits for: required on a partial case for T0, absent on every other entry. */
  waitsT0?: string;
}

/**
 * Where case-named checks live (the closest path wins): Foundry folders or files under packages/contracts/test, or
 * (`kind: 'typescript'`) folders or files of vitest and Playwright tests elsewhere.
 */
export interface CoverageSource {
  id: string;
  kind?: 'foundry' | 'typescript';
  paths: string[];
  about: string;
  /** Its checks run on template 0 only, so they may map only cases that apply to T0. */
  templateZeroOnly?: boolean;
}

export interface CoverageProvider {
  id: string;
  about: string;
  /** The sources whose instance checks it runs; its contracts are declared in their files. */
  runs?: string[];
  contracts: string[];
}

export interface Coverage {
  sources?: CoverageSource[];
  providers?: CoverageProvider[];
  cases: Record<string, CoverageEntry>;
}

/** A Solidity file: its repository-relative path and its source. */
export interface SolidityFile {
  path: string;
  source: string;
}

export interface CoverageRow {
  id: string;
  layer: string;
  gate: string;
  slice: string;
  t0: boolean;
  /** The Misfits gate's verdict for a case for T0 (undefined for other cases). */
  t0Verdict: 'green' | 'open' | undefined;
  status: string;
  detail: string;
  checks: number;
}

export const pkgDir: string;
export const repoDir: string;
export const PATHS: {
  cases: string;
  boxFactory: string;
  boxSpec: string;
  coverage: string;
  harnessDir: string;
  testDir: string;
  report: string;
  v2TestDir: string;
};
export const V2_FIRST_ID: number;
export function isV2Case(c: ConformanceCase | undefined): boolean;
/** True when `path` is `p` or lies under the folder `p`. */
export function within(path: string, p: string): boolean;
export const MISFITS_LINE: string[];
export const OFF_LINE: string[];
export const SLICES: string[];
export const GATES: string[];
export const LAYERS: string[];
export const DROPPED_BP: number[];
export const REFUSAL_INPUTS: Record<string, { key: string; values: number[]; why: string }>;
export const VAULT_UNIT_KEYS: string[];
export const STATUSES: Record<string, string>;

export function nValues(c: ConformanceCase): { path: string; key: string; n: number | undefined; raw?: unknown }[];
export function stripSolidityComments(source: string): string;
export function appliesToT0(c: ConformanceCase): boolean;
export function isT0Only(c: ConformanceCase): boolean;
/** `cases`: the v1 cases (restated ones with their v1 text); `allCases`: the whole case file, v2 cases included. */
export function loadInputs(root?: string): { cases: ConformanceCase[]; allCases: ConformanceCase[]; bpRows: number[]; minN: number };
export function checkCases(cases: ConformanceCase[], opts: { bpRows: number[]; minN: number }): string[];
export function summarise(cases: ConformanceCase[]): {
  total: number;
  bySlice: Record<string, number>;
  byGate: Record<string, number>;
  byLayer: Record<string, number>;
  g0ForT0: number;
};
export function solidityFiles(dir?: string, root?: string): SolidityFile[];
export function harnessSources(root?: string): SolidityFile[];
export function harnessChecks(source: string): { checks: Map<string, string>; harness: string[] };
export function sourceOf(path: string, sources: CoverageSource[] | undefined): string | undefined;
export function scanChecks(
  files: SolidityFile[],
  sources: CoverageSource[] | undefined,
): { bySource: Map<string, Map<string, string>>; outside: { path: string; check: string; id: string }[] };
export function entryChecks(entry: CoverageEntry | undefined, sources: CoverageSource[] | undefined): [string, string[]][];
export function t0Verdict(c: ConformanceCase, entry: CoverageEntry | undefined): 'green' | 'open' | undefined;
export function t0Gate(
  cases: ConformanceCase[],
  coverage: Coverage,
): { g0ForT0: number; green: number; open: number; byStatus: Record<'checked' | 'done-s1' | 'partial' | 'pending', number> };
export function checkCoverage(cases: ConformanceCase[], coverage: Coverage, opts: { files: SolidityFile[]; scripts?: SolidityFile[] }): string[];
export function sourceKind(source: CoverageSource | undefined): 'foundry' | 'typescript';
/** TypeScript test files (`*.test.ts(x)`, `*.spec.ts(x)`) under the given repository-relative paths. */
export function scriptFiles(paths: string[], root?: string): SolidityFile[];
/** The TypeScript test files of the map's TypeScript sources. */
export function sourceScripts(coverage: Coverage, root?: string): SolidityFile[];
/** Case-named checks of one TypeScript test file: title → the case ids it names. */
export function scriptChecks(source: string): Map<string, string[]>;
export function scanScriptChecks(scripts: SolidityFile[], sources: CoverageSource[] | undefined): Map<string, Map<string, string[]>>;
export function sourceCounts(coverage: Coverage): Map<string, { checks: number; cases: number }>;
export function coverageRows(cases: ConformanceCase[], coverage: Coverage): CoverageRow[];
export function renderReport(cases: ConformanceCase[], coverage: Coverage): string;
