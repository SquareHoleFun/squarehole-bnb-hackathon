/** Types for box0-pin.mjs (box 0's pin, ticket M1-02; ADR-0017 § 10; BC-222). */

/** One contract's code in one build: sha256 of the lower-case hex text (scripts/bytecode-hashes.py's format). */
export interface CodePin {
  artifact: string;
  creation: string;
  runtime: string;
  runtimeBytes: number;
}

export interface Box0Pin {
  format: string;
  /** The reviewed candidate; `pinDigest` seals `sources`, `absent` and `compiler` (box0-pin.mjs `pinDigest`). */
  candidate: { pinDigest?: string } & Record<string, unknown>;
  /** One row per file, sorted by file (a list, not a map: a file name holding `Token` or `Key` beside a hash trips
   * gitleaks' generic-api-key rule). */
  sources: { file: string; sha256: string }[];
  absent: string[];
  compiler: { file: string; profiles: Record<string, Record<string, string>> };
  code: { default: CodePin[]; rehearsal: CodePin[] };
  versionCodeHash: { default: string; rehearsal: string; factory: string } & Record<string, unknown>;
}

export const repoDir: string;
export const MANIFEST: string;
export const CONTRACTS: string;
export const FOUNDRY_TOML: string;
export const SOURCE_ROOTS: string[];
export const SPEC_SOURCES: string[];
export const ABSENT: string[];
export const PROFILES: Record<'default' | 'rehearsal', { table: string; out: string }>;
export const PINNED_KEYS: string[];
export const INERT_KEYS: string[];
export const INERT_SUBTABLES: string[];
export const STANDALONE_SECTIONS: string[];

export function sha256(data: string | Uint8Array): string;
export function parseToml(text: string): Record<string, Record<string, string>>;
export function compilerSettings(text: string): { settings: Record<string, Record<string, string>>; problems: string[] };
export function listFiles(root: string, dir: string): string[];
export function boxArtifacts(outDir: string): (CodePin & { sources: string[] })[];
export function checkCode(pinned: CodePin[], outDir: string, build: string): string[];
export function pinDigest(manifest: Box0Pin): string;
export function checkTree(manifest: Box0Pin, root?: string): string[];
export function buildManifest(previous: Box0Pin, root?: string): Box0Pin;
