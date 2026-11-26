/**
 * The stack's smoke check of the poster: infra/server/smoke-services.sh runs it inside the poster's container, where the
 * other workers run `run.mjs --healthcheck`. Healthy means the health file is current and in the mode the worker flags
 * select, and an enabled poster has completed a cycle. It reads only the flags and the health file: no manifest, RPC
 * or CoW request, and it prints no setting but the mode.
 *
 *   node --experimental-transform-types --import ../chain/scripts/register-ts.mjs src/healthcheck.ts [disabled|dry-run|live]
 *
 * Exit 0: healthy (in the expected mode when one is named); 1: not healthy yet; 2: a bad argument.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPaths, loadService, type Service } from './config';

export type Expected = 'disabled' | 'dry-run' | 'live';
const EXPECTED: readonly string[] = ['disabled', 'dry-run', 'live'];
/** The Dockerfile HEALTHCHECK's bound: a record older than two cycles and a minute is stale. */
export const staleAfterMs = (cycleMs: number): number => 2 * cycleMs + 60_000;

/** One health record against the flags: current, in their mode, and after a completed cycle when enabled. */
export function posterHealthy(record: unknown, service: Pick<Service, 'enabled' | 'mode'>, now: number, cycleMs: number, expected?: Expected): boolean {
  if (expected !== undefined && expected !== (service.enabled ? service.mode : 'disabled')) return false;
  if (record === null || typeof record !== 'object') return false;
  const { phase, mode, updatedAt, completedAt } = record as Record<string, unknown>;
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt > now || now - updatedAt > staleAfterMs(cycleMs)) return false;
  if (!service.enabled) return phase === 'disabled';
  // A cycle that failed on an RPC read ends idle without completedAt; a cycle still running has none yet.
  return phase === 'idle' && mode === service.mode && typeof completedAt === 'number' && Number.isSafeInteger(completedAt) && completedAt <= updatedAt;
}

export function healthcheck(argv: readonly string[], env: Record<string, string | undefined>, now: number): { code: 0 | 1 | 2; line: string } {
  const [expected, ...extra] = argv;
  if (extra.length > 0 || (expected !== undefined && !EXPECTED.includes(expected))) return { code: 2, line: 'cow-poster: usage: healthcheck.ts [disabled|dry-run|live]\n' };
  let service: Service;
  try { service = loadService(env); } catch { return { code: 1, line: 'cow-poster: invalid worker flags\n' }; }
  const cycleMs = Number(env.SH_COW_CYCLE_MS ?? '600000');
  if (!Number.isSafeInteger(cycleMs) || cycleMs <= 0) return { code: 1, line: 'cow-poster: invalid cycle\n' };
  let record: unknown;
  try { record = JSON.parse(readFileSync(loadPaths(env).healthFile, 'utf8')) as unknown; } catch { return { code: 1, line: 'cow-poster: no health record yet\n' }; }
  const state = service.enabled ? service.mode : 'disabled';
  return posterHealthy(record, service, now, cycleMs, expected as Expected | undefined)
    ? { code: 0, line: `cow-poster: ${state}; health current\n` }
    : { code: 1, line: `cow-poster: not healthy in ${expected ?? state}\n` };
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly(): boolean {
  try { const started = process.argv[1]; return started !== undefined && import.meta.url === pathToFileURL(realpathSync(started)).href; }
  catch { return false; }
}
if (startedDirectly()) {
  const { code, line } = healthcheck(process.argv.slice(2), process.env, Date.now());
  (code === 0 ? process.stdout : process.stderr).write(line);
  process.exitCode = code;
}
