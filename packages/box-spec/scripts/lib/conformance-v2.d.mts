/** Types for conformance-v2.mjs (core v2's conformance cases and coverage map, ticket M1-01). */
import type { ConformanceCase, SolidityFile } from './conformance.mjs';

/** A Foundry test (`name`) or a vitest/Playwright test (`title`); `ticket` when another ticket writes it. */
export type TestIdV2 = { file: string; name: string; ticket?: string; implementation?: true } | { file: string; title: string; ticket?: string };

export interface CoverageEntryV2 {
  tests: TestIdV2[];
}

export interface TicketV2 {
  milestone: 'M1' | 'M2' | 'M3';
  title: string;
  from?: string;
}

export interface SpinoffV2 {
  repo: string;
  branch: string;
  commit: string;
  map: { ids: string[]; first: string };
  notMapped?: { ids: string[]; why: string };
}

export interface DispositionV2 {
  project: string;
  id: string;
  into?: string;
  withdrawn?: string;
  by: string;
}

export interface CoverageV2 {
  name: string;
  about: string[];
  plan: string;
  tickets: Record<string, TicketV2>;
  spinoffs: Record<string, SpinoffV2>;
  dispositions: DispositionV2[];
  cases: Record<string, CoverageEntryV2>;
}

/** A v2 case, or a v1 case's v2 statement with its v1 id and layer. */
export type RowV2 = ConformanceCase & { origin: 'v2' | 'restated' };
export type CoverageRowV2 = RowV2 & { tests: (TestIdV2 & { state: 'planned' | 'written' })[] };
export interface WrittenCheckV2 {
  kind: 'foundry' | 'typescript';
  file: string;
  name: string;
  id: string;
}

export const V2_PATHS: { coverage: string; testDir: string; report: string };
export const V2_FIRST: number;
export const V2_LAST: number;
export const V2_RANGES: number[][];
export const PLAN_BASE: number;
export const PLAN_COUNT: number;
/** Cases later decisions added are numbered from BC-(DECISION_BASE + 1). */
export const DECISION_BASE: number;
export const MILESTONES: string[];

export function v2Rows(allCases: ConformanceCase[]): RowV2[];
export function checkCasesV2(allCases: ConformanceCase[], coverage: CoverageV2, opts: { minN: number }): string[];
export function v2TestFiles(root?: string): SolidityFile[];
export function v2Scripts(coverage: CoverageV2, root?: string): SolidityFile[];
export function writtenV2Checks(files: SolidityFile[], scripts: SolidityFile[]): WrittenCheckV2[];
export function checkCoverageV2(allCases: ConformanceCase[], coverage: CoverageV2, opts: { files: SolidityFile[]; scripts: SolidityFile[] }): string[];
export function coverageRowsV2(allCases: ConformanceCase[], coverage: CoverageV2, opts: { files: SolidityFile[]; scripts: SolidityFile[] }): CoverageRowV2[];
export function renderReportV2(allCases: ConformanceCase[], coverage: CoverageV2, opts: { files: SolidityFile[]; scripts: SolidityFile[] }): string;
