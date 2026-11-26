/** Types for check-spec.mjs (the BoxSpec checker behind `pnpm box-spec:check`, F73 launch skill). */
export const MARKER: 'FROM_LAUNCH_FLOW';
export const DRAFT_FORMAT: 'squarehole.boxspec-draft/1';
export const FILE_FORMAT: 'squarehole.boxspec/1';
export const SECRET_MESSAGE: string;
/** Exit codes of the command line. */
export const EXIT: { readonly VALID: 0; readonly REFUSED: 1; readonly USAGE: 2; readonly NOT_READABLE: 3; readonly SECRET: 4 };
/** F74 U1: where a spec is meant to run; mainnet (the default) is the strictest, Demo offers holder payouts early. */
export type NetworkName = 'demo' | 'sepolia' | 'mainnet';
export const NETWORK_NAMES: readonly NetworkName[];
export const DEFAULT_NETWORK: 'mainnet';

/** The generated library (or `@squarehole/box-spec`'s index): contexts, validator, encoders, curve helpers. */
export type BoxSpecLibrary = Record<string, unknown>;

export interface Sources {
  spec: Record<string, unknown>;
  catalog: Record<string, unknown>;
  plain: Record<string, unknown>;
}

export interface Model {
  sources: Sources;
  lib: BoxSpecLibrary;
  plain: Record<string, unknown> & { steps: { id: string; title: string; fields: string[] }[] };
  fields: { id: number; name: string; type: string; enum?: string; chosenBy: string; check: Record<string, unknown> }[];
  contexts: { name: string; version: number; json: Record<string, unknown> }[];
}

/** A spec in wire form (enum values and add-on ids as numbers, amounts as bigint or numbers). */
export type Wire = Record<string, unknown> & { addOns: { id: number; params: string }[] };

export interface Built {
  wire: Wire;
  placeholders: string[];
  launchFlow: string[];
  dust: { path: string; value: bigint; text: string }[];
  problems: InputProblem[];
}

export interface SoonFinding {
  kind: 'stale' | 'unregistered';
  at: string;
  entry?: string;
  text: string;
}

export interface InputProblem {
  path: string;
  message: string;
  fix: string;
}

export interface Explanation {
  reason: string;
  reasonCode: number;
  field: string;
  fieldId: number;
  sentence: string;
  fix: string;
  rule?: string;
}

export interface CheckResult {
  ok: boolean;
  stage: 'input' | 'file' | 'check' | 'secret';
  /** stage 'secret': where something looks like a private key or recovery phrase (never the value). */
  secret?: boolean;
  paths?: string[];
  message?: string;
  /** false when the launch flow cannot enter all of a valid spec (its "cannot enter" lines lead the warnings). */
  enterable?: boolean;
  kind?: 'draft' | 'download' | 'bare';
  context?: string;
  /** The network the check ran for (F74 U1). */
  network?: NetworkName;
  /** Where it came from: --network, the Download BoxSpec file's `network` key, or the strictest by default. */
  networkFrom?: 'option' | 'file' | 'default';
  problems: InputProblem[];
  specHash?: `0x${string}`;
  draft?: boolean;
  placeholders?: string[];
  verdict?: { reason: number; field: number; reasonName: string; fieldName: string };
  explanation?: Explanation;
  overview?: [string, string][];
  /** What to fix or confirm first: settings the launch flow cannot enter, a "$" ticker, a bad link, raw dust. */
  warnings?: string[];
  notes?: string[];
  /** Add-on settings written as "FROM_LAUNCH_FLOW" that took the launch flow's own value (exact, not a stand-in). */
  launchFlow?: string[];
}

export interface FieldResult {
  ok: boolean;
  unknown?: boolean;
  field: string;
  label?: string;
  text?: string;
  bytes?: number;
  chars?: number;
  max?: number;
  secret?: boolean;
  bad?: { char: string; shown: string; replacement?: string }[];
  problems: string[];
  fix?: string;
  suggestion?: string;
  warnings: string[];
}

export interface NumbersRow {
  raise: bigint;
  first: bigint;
  graduation: bigint;
  item?: { n: bigint; tokens: bigint; first: bigint; graduation: bigint };
  buy?: { amount: bigint; bps?: bigint; tooLarge?: boolean };
  forShare?: { bps: bigint; amount: bigint | null };
}

export interface NumbersResult {
  ok: boolean;
  problems?: string[];
  unit?: string;
  priceCents?: bigint;
  rows?: NumbersRow[];
  usd?: { cents: bigint; wei: bigint };
}

export interface NumbersOptions {
  raise?: string;
  items?: string;
  buy?: string;
  share?: string;
  ethUsd?: string;
  usd?: string;
}

export function loadSources(dir?: string): Sources;
export function createModel(sources: Sources, lib: BoxSpecLibrary): Model;
export function modelFor(lib: BoxSpecLibrary, dir?: string): Model;
/**
 * `nowMs` (milliseconds, `Date.now()`'s unit) is the clock an opening time (field 15 openAt, F80) is warned against: a
 * time already passed or more than 14 days ahead. Without it there is no such warning (the command line passes its own
 * clock), so a library check of the same draft gives the same result on every day.
 */
export function checkSpec(model: Model, doc: unknown, options?: { network?: NetworkName; nowMs?: number }): CheckResult;
export function renderText(result: CheckResult, file?: string): string;
export function renderMenu(model: Model, contextName?: string): string;
export function missingPlainWords(model: Model): string[];
export function plannedItems(model: Model): { kind: 'member' | 'addOn'; enumName?: string; name?: string; key?: string }[];
/** "about 12 seconds", "about 5 minutes", … from a number of **seconds** (F80: the open is a clock time). */
export function durationText(seconds: number): string;
/** A clock time (Unix seconds) as "2026-10-06 18:00 UTC" (":ss" only when not 0). */
export function utcText(seconds: bigint | number | string): string;
/** The opening-time warnings against `nowMs` (none without a clock). */
export function openAtWarningsOf(model: Model, wire: Record<string, unknown>, nowMs?: number): string[];
export function decimalText(raw: bigint | string, decimals: number, options?: { grouped?: boolean }): string;
export function percentText(bps: bigint): string;
export function allowedText(model: Model, field: Model['fields'][number], context: unknown): string;
export function paramText(model: Model, param: Record<string, unknown>, context?: Model['contexts'][number]): string;
export function checkField(model: Model, name: string, value: string): FieldResult;
export function renderField(result: FieldResult): string;
export function textFieldNames(model: Model): string[];
export function numbersOf(model: Model, options?: NumbersOptions): NumbersResult;
export function renderNumbers(result: NumbersResult): string;
export function approxText(raw: bigint | string, decimals?: number): string;
export function usdText(wei: bigint, priceCents: bigint): string;
export function exitCodeOf(result: CheckResult): number;
export function readDocument(doc: unknown, model: Model): { spec?: Record<string, unknown>; context?: Model['contexts'][number]; problems: InputProblem[] };
export function buildWire(model: Model, input: Record<string, unknown>, context: Model['contexts'][number]): Built;
/** A verdict in plain words: the failing check's sentence and what to write instead (`network`: whose lists, F74 U1). */
export function explainVerdict(model: Model, verdict: { reason: number; field: number }, wire: Wire, context: Model['contexts'][number], network?: NetworkName): Explanation;
export function notesOf(model: Model, wire: Wire, context: Model['contexts'][number], built: Built, site?: unknown): string[];
export function warningsOf(model: Model, wire: Wire, context: Model['contexts'][number], built: Built, site?: unknown): string[];
export function enterGapsOf(model: Model, wire: Wire, context: Model['contexts'][number], built: Built): string[];
/** A draft's raw trait table and fingerprints written as 64 hex characters ("Check first" lines); none for other kinds. */
export function draftWarningsOf(model: Model, read: { kind?: 'draft' | 'download' | 'bare'; spec?: Record<string, unknown> }, wire: Wire): string[];
export function launchFlowGaps(model: Model, wire: Wire): string[];
export function secretKind(text: unknown): 'key' | 'phrase' | null;
export function secretPaths(model: Model, doc: unknown, specAt?: string[]): string[];
export function soonEntries(model: Model): { id: string; words: string[]; names: string[]; available: boolean }[];
export function soonFindings(model: Model, files: ({ path: string; text: string } | { path: string; units: { line: number | string; text: string }[] })[]): SoonFinding[];
export function proseUnits(text: string): { line: number; text: string }[];
export function plainWordUnits(model: Model): { line: string; text: string }[];
