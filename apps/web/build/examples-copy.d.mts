/** See examples-copy.mjs (SH-252): the explainer's output as the app serves it at /examples/, made and checked. */
export const ROOT: string;
export const TARGET: string;
export const MANIFEST: string;
export const SOURCE_FOLDER: string;
export const PREFIX: string;
export const PREFIXED: readonly string[];
export const COMMENTED: RegExp;
export const KEPT_COMMENT: RegExp;
export const LEFT: readonly string[];
export const ADDRESS: RegExp;
export const WAY_BACK_ANCHOR: string;
export const WAY_BACK: string;
export const WHAT: string;
export const GENERATOR: string;

export interface ExamplesFileEntry {
  readonly sha256: string;
  /** A changed file's source, byte for byte before the changes. */
  readonly source?: string;
  /** How many comments were taken out. */
  readonly comments?: number;
  /** How many licence or copyright comments stayed. */
  readonly keptComments?: number;
  /** How many addresses gained the prefix. */
  readonly addresses?: number;
}
export interface ExamplesManifest {
  readonly format: 'squarehole.examples/2';
  readonly what: string;
  readonly source: { readonly ref: string; readonly commit: string; readonly folder: string; readonly generator: string };
  readonly target: string;
  readonly prefix: string;
  readonly left: readonly string[];
  readonly files: Readonly<Record<string, ExamplesFileEntry>>;
}

export function sha256(bytes: string | Uint8Array): string;
export function commentRanges(name: string, text: string): { start: number; end: number }[];
export function stripComments(name: string, text: string): { text: string; comments: number; kept: number };
export function scriptShape(text: string): string[];
export function sameScript(a: string, b: string): boolean;
export function styleShape(text: string): string[];
export function sameStyle(a: string, b: string): boolean;
export function rewrite(name: string, text: string): { text: string; addresses: number };
export function restore(name: string, text: string): string;
export function transform(name: string, bytes: Buffer): { bytes: Buffer; entry: ExamplesFileEntry };
export function filesUnder(folder: string, prefix?: string): string[];
export function sourceAt(commit: string): Map<string, Buffer>;
export function copyOf(source: ReadonlyMap<string, Buffer>, origin: { ref: string; commit: string }): { files: Map<string, Buffer>; manifest: ExamplesManifest };
export function manifestText(manifest: ExamplesManifest): string;
export function changedPictures(before: ExamplesManifest | null, after: ExamplesManifest): string[];
export function check(root?: string): string[];
export function write(commit: string, ref: string, root?: string): { manifest: ExamplesManifest; changed: string[] };
