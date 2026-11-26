/**
 * TEST ONLY: a throwaway Postgres cluster on a Unix socket (S10a § 4): `initdb` in a temp folder, the server with
 * `listen_addresses=''` (no TCP port at all, so nothing can collide), a socket in that folder, trust auth for the local
 * user, `fsync=off`. Stopped and retained under .cache/trash by `stop()`. Finds the binaries from SH_PG_BIN, Homebrew's postgresql@17 or
 * `pg_config --bindir`; returns null when there are none.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TempPostgres {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly version: string;
  stop(): void;
}

function binDir(): string | null {
  const candidates = [process.env.SH_PG_BIN, '/opt/homebrew/opt/postgresql@17/bin'];
  const fromConfig = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (fromConfig.status === 0) candidates.push(fromConfig.stdout.trim());
  return candidates.find((dir): dir is string => typeof dir === 'string' && existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'))) ?? null;
}

export function startTempPostgres(database = 'squarehole_history_test'): TempPostgres | null {
  const bin = binDir();
  if (!bin) return null;
  // Keep scratch in the checkout. The socket path must fit the platform's 104-byte limit on macOS.
  const scratch = fileURLToPath(new URL('../../../../.cache/tmp/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'shpg-'));
  const data = join(dir, 'data');
  const retain = () => {
    const trash = fileURLToPath(new URL('../../../../.cache/trash/', import.meta.url));
    mkdirSync(trash, { recursive: true }); renameSync(dir, join(trash, basename(dir)));
  };
  const port = 5433; // only the socket's file name (.s.PGSQL.5433): no TCP listener exists
  const run = (tool: string, args: string[]) => execFileSync(join(bin, tool), args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--no-sync', '--no-clean', '-E', 'UTF8', '--locale=C']);
    run('pg_ctl', ['-D', data, '-l', join(dir, 'server.log'), '-w', '-o', `-k ${dir} -c listen_addresses= -p ${port} -c fsync=off -c synchronous_commit=off`, 'start']);
    run('createdb', ['-h', dir, '-p', String(port), '-U', 'postgres', database]);
  } catch (error) {
    spawnSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    retain();
    throw error;
  }
  const version = run('postgres', ['--version']).trim();
  return {
    host: dir,
    port,
    database,
    user: 'postgres',
    version,
    stop() {
      spawnSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
      retain();
    },
  };
}
