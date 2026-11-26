/** Types for check-spec-v2.mjs (the format 2 checker, M1-11). Loose where the shapes come from the frozen files at run time. */
export const DRAFT_FORMAT_V2: 'squarehole.boxspec-draft/2';
export const EXIT: { readonly VALID: 0; readonly REFUSED: 1; readonly USAGE: 2; readonly NOT_READABLE: 3; readonly SECRET: 4 };
/** The networks with a format 2 menu (an offline copy); only these names reach a path. */
export const MENU_NETWORKS_V2: readonly string[];

export interface ShapeField { name: string; type: string; doc: string }
export interface Shapes {
  enums: Map<string, { name: string; doc: string; members: { name: string; value: number; doc: string }[] }>;
  structs: Map<string, ShapeField[]>;
}
export type Wire = Record<string, unknown>;
export type Doc = Record<string, unknown>;
/** M1-10's twin as M1-11 calls it: `validateBoxSpecV2(wire, ctx)` and the reason names by code. */
export interface Twin {
  REASON_NAMES?: Record<number, string>;
  validateBoxSpecV2: (wire: Wire, ctx: Record<string, unknown>) => { reason: number; field: number };
}
export interface MenuListing {
  id: number;
  symbol: string;
  label: string;
  address: string;
  decimals: number;
  class: string;
  kind: string;
  retired?: boolean;
  raise: bigint;
  powers: string[];
}
export interface Release { name: string; buildProfile: string; offered: { legs: string[]; dests: string[]; targetSlot: boolean; addOns: number[]; gradLayouts: number[] } }
export interface Menu {
  network: string;
  label: string;
  source: 'copy' | 'indexer';
  writtenAt: string;
  release: Release;
  listings: MenuListing[];
  newest: Map<string, MenuListing>;
  /** Tokens Square Hole listed (kind LISTED), by lower-case symbol: what a bare symbol names. */
  offered: Map<string, MenuListing>;
  ambiguous: Set<string>;
  /** Manually listed box tokens (kind BOX_TOKEN), by lower-case symbol: what { "boxToken": "MUG" } names. */
  boxTokens: Map<string, MenuListing>;
  ambiguousBoxTokens: Set<string>;
}
export interface ModelV2 { network: string; label: string; shapes: Shapes; menu: Menu; plain: Record<string, unknown> }
export interface Problem { path: string; message: string; fix: string }
export interface CheckResultV2 {
  ok: boolean;
  format: 1 | 2;
  stage: 'input' | 'check' | 'secret';
  network?: string;
  format1?: boolean;
  box0?: boolean;
  pending?: 'twin' | 'catalog';
  problems?: Problem[];
  preset?: { id: string; version: number };
  pricing?: MenuListing;
  raiseFrom?: 'listing' | 'draft';
  wire: Wire;
  specHash?: string;
  ctx?: { listing: Record<string, unknown> } & Record<string, unknown>;
  verdict?: { reason: number; field: number; reasonName: string };
  explanation?: { reason: string; reasonCode?: number; field: string; fieldId?: number; sentence: string; fix: string };
  overview?: [string, string][];
  warnings?: string[];
  notes?: string[];
}
export interface NumbersV2 {
  ok: boolean;
  problems?: string[];
  decimals: number;
  raise: bigint;
  raiseFrom: 'listing';
  first: bigint;
  graduation: bigint;
}
export interface ModelOptions { network?: string; sources?: Record<string, unknown>; twin?: Twin | null; curve?: Record<string, unknown>; indexer?: unknown; dir?: string }

export function modelForV2(options: ModelOptions): ModelV2;
export function readShapes(dir?: string): Shapes;
export function abiOf(shapes: Shapes, type: string, name?: string): { type: string; name?: string; components?: unknown[] };
export function encodeSpecV2(shapes: Shapes, wire: Wire): `0x${string}`;
export function specHashV2(shapes: Shapes, wire: Wire): `0x${string}`;
export function encodeParamsV2(shapes: Shapes, struct: string, values: Record<string, unknown>): `0x${string}`;
export function decodeParamsV2(shapes: Shapes, struct: string, hex: string): Record<string, unknown> | null;
export function readMenu(network: string, options?: { dir?: string; indexer?: unknown; shapes?: Shapes }): Menu & { byRule: unknown[] };
/** https, or http on this computer only. */
export function indexerUrlOk(url: string): boolean;
/** The indexer's answer by one GET: no redirect followed, at most `maxBytes` (1 MB) read. */
export function fetchIndexerAnswer(url: string, options?: { fetch?: (url: string, init: RequestInit) => Promise<Response>; maxBytes?: number; timeoutMs?: number }): Promise<unknown>;
export function checkSpecV2(model: ModelV2, doc: Doc): CheckResultV2;
export function exitCodeOfV2(result: CheckResultV2): number;
export function renderTextV2(result: CheckResultV2, file?: string): string;
export function renderMenuV2(model: ModelV2): string;
export function numbersOfV2(model: ModelV2, options?: { pricing?: string; boxToken?: string; items?: string; buy?: string; share?: string }): NumbersV2;
export function renderNumbersV2(result: NumbersV2): string;
export function fromPreset(preset: Doc & { id: string; version: number }, fill?: Record<string, unknown>): Doc;
export function holderOfferProblemsV2(release: Release): string[];
export function holderNoteV2(release: Release): string | null;
/** M1-10's twin once the checkout has it (src/generated/box-spec.v2.ts), else null. */
export function loadTwinV2(path?: string): Promise<Twin | null>;
