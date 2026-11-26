/** Types for outputs-v2.mjs (BoxSpec format 2's sources and generated outputs, ticket M1-10-b). */

/** Source, twin and vector paths relative to the repository root. */
export interface PathsV2 {
  readonly sol: string;
  readonly ts: string;
  /** The vectors file the tests read; M1-10-a's encoder writes it. */
  readonly vectors: string;
  readonly spec: string;
  readonly addOns: string;
}

export declare const V2_PATHS: PathsV2;
/** M1-00's frozen interface files the generator reads. */
export declare const FROZEN_FILES: readonly string[];
/** The reason codes runtime.ts's string checks return (the model refuses a source that numbers them otherwise). */
export declare const RUNTIME_REASON_CODES: Readonly<Record<string, number>>;

export interface SourceFieldV2 {
  id: number;
  name: string;
  type?: string;
  check: Record<string, unknown>;
}

export interface SourceEnumV2 {
  name: string;
  members: { name: string; value: number }[];
}

/** The JSON sources as read (mutable copies: tests change them to check the generator's refusals). */
export interface SourcesV2 {
  mode: 'real';
  root: string;
  paths: PathsV2;
  spec: { fields: SourceFieldV2[]; enums: SourceEnumV2[]; [key: string]: unknown };
  addOns: Record<string, unknown>;
  cases: Record<string, unknown> | null;
  frozen: Record<string, string>;
  labels: { spec: string; addOns: string };
}

/** The checked model the emitters read; opaque to callers. */
export type ModelV2 = { readonly __modelV2: unique symbol };

export declare function readSourcesV2(root?: string): SourcesV2;
export declare function loadModelV2(sources: SourcesV2): ModelV2;
/** [absolute path, content] for every generated file. */
export declare function outputsV2(model: ModelV2): [string, string][];
