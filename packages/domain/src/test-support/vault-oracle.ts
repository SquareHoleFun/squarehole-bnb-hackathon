/**
 * Test-only access to the core v2 handoff (read-only) and to its preserved Python oracle, which only ever runs on a
 * scratch copy in the OS temp directory (never inside square-hole-core-v2/: its check_examples.py rewrites a file).
 * Never imported by runtime code.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './handoff';

export const V2_ROOT = `${REPO_ROOT}square-hole-core-v2/`;
export const ORACLE_DRIVER = fileURLToPath(new URL('./vault_oracle_driver.py', import.meta.url));

/** The oracle files a scratch copy needs, relative to the v2 handoff root. */
export const ORACLE_FILES = ['reference/v0_1/model.py', 'reference/check_examples.py', 'examples/reference-results.json'] as const;

export function readV2Text(relativePath: string): string {
  return readFileSync(`${V2_ROOT}${relativePath}`, 'utf8');
}

export function readV2Json(relativePath: string): unknown {
  return JSON.parse(readV2Text(relativePath)) as unknown;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The sha256 that square-hole-core-v2/MANIFEST.sha256 records for `relativePath`. */
export function manifestHash(relativePath: string): string {
  for (const line of readV2Text('MANIFEST.sha256').split('\n')) {
    const [hash, path] = line.trim().split(/\s+/);
    if (path === relativePath && hash) return hash;
  }
  throw new Error(`${relativePath} is not in the v2 manifest`);
}

export interface OracleCopy {
  /** Scratch root laid out like square-hole-core-v2/ (only ORACLE_FILES). */
  readonly root: string;
  readonly modelPath: string;
  cleanup(): void;
}

/** Copy the oracle files into a fresh temp directory and check each copy against the handoff manifest. */
export function makeOracleCopy(): OracleCopy {
  const root = mkdtempSync(join(tmpdir(), 'sh-v2-oracle-'));
  for (const relativePath of ORACLE_FILES) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(`${V2_ROOT}${relativePath}`, target);
    if (sha256File(target) !== manifestHash(relativePath)) throw new Error(`scratch copy of ${relativePath} fails the manifest`);
  }
  return {
    root,
    modelPath: join(root, 'reference/v0_1/model.py'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface PythonRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `python3 -B <args>` with PYTHONDONTWRITEBYTECODE=1, so no bytecode is written next to any source. stdin gets the given
 * input or is closed, and a run past timeoutMs (default 5 minutes, above the oracle tests' own limits of up to 3
 * minutes under load) is killed and throws, so a stalled oracle fails the test instead of holding `pnpm verify` open.
 */
export function runPython(
  args: readonly string[],
  options: { readonly input?: string; readonly cwd?: string; readonly timeoutMs?: number } = {},
): PythonRun {
  const result = spawnSync('python3', ['-B', ...args], {
    input: options.input ?? '',
    cwd: options.cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: options.timeoutMs ?? 300_000,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw new Error(`python3 could not run: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
