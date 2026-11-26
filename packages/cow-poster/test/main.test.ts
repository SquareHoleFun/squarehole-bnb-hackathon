import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const entry = ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--import', '../chain/scripts/register-ts.mjs', 'src/main.ts'];
const scratch = async (name: string) => {
  const root = fileURLToPath(new URL('../../../.cache/lane/cow-poster', import.meta.url)); await mkdir(root, { recursive: true });
  return mkdtemp(`${root}/${name}-`);
};
async function fails(flags: Record<string, string>) {
  const dir = await scratch('fatal');
  const env = { SH_COW_STATE_DIR: dir, ...flags };
  let output = '';
  let status: unknown;
  try {
    execFileSync(process.execPath, entry, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const result = error as { status: unknown; stdout: string; stderr: string };
    status = result.status; output = result.stdout + result.stderr;
  }
  const health = await readFile(`${dir}/health.json`, 'utf8').then(text => JSON.parse(text) as unknown, () => null);
  return { status, output, health };
}

describe('Node 24 entry point', () => {
  it('loads real workspace imports, exits on invalid configuration and logs no secret', async () => {
    const { status, output, health } = await fails({ SH_SERVICE_ENABLED: '1', SH_COW_CHAIN_ID: '11155111', SH_COW_RPC_URL: 'secret-rpc-token', SH_COW_MANIFEST: 'unused.json' });
    expect(status).toBe(1);
    expect(output).not.toContain('secret-rpc-token');
    expect(JSON.parse(output)).toMatchObject({ event: 'fatal', stage: 'config' });
    expect(health).toMatchObject({ phase: 'fatal', stage: 'config' });
  });
  it('refuses a misspelled operator flag before reading anything else', async () => {
    const { status, output, health } = await fails({ SH_SERVICE_ENABLED: 'yes', SH_COW_RPC_URL: 'secret-rpc-token' });
    expect(status).toBe(1);
    expect(output).not.toContain('secret-rpc-token');
    expect(JSON.parse(output)).toMatchObject({ event: 'fatal', stage: 'config' });
    expect(health).toBeNull();
  });
  it('without its private env file stays disabled: healthy, reads no configuration or RPC, and stops cleanly', async () => {
    const dir = await scratch('disabled');
    const child = spawn(process.execPath, entry, { cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { SH_COW_STATE_DIR: dir, SH_COW_RPC_URL: 'secret-rpc-token' } });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    try {
      await once(child.stdout, 'data');
      let health: { phase?: string; mode?: string; updatedAt?: number } = {};
      for (let i = 0; i < 100 && health.phase !== 'disabled'; i++) {
        try { health = JSON.parse(await readFile(`${dir}/health.json`, 'utf8')) as typeof health; }
        catch { await new Promise(done => setTimeout(done, 20)); }
      }
      expect(health).toMatchObject({ phase: 'disabled', mode: 'dry-run' });
      expect(Number.isSafeInteger(health.updatedAt)).toBe(true);
    } finally { child.kill('SIGTERM'); await exited; }
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(await readFile(`${dir}/health.json`, 'utf8'))).toMatchObject({ phase: 'stopped' });
    expect(JSON.parse(output.split('\n')[0] ?? '')).toMatchObject({ event: 'disabled', mode: 'dry-run' });
    expect(output).not.toContain('secret-rpc-token');
  });
});

describe('the container health check', () => {
  // The exact command from the Dockerfile's HEALTHCHECK line, run against health snapshots.
  const command = async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const line = dockerfile.match(/^\s*CMD (\["node", "-e", .*\])$/m)?.[1];
    if (!line) throw new Error('HEALTHCHECK command missing');
    return JSON.parse(line) as string[];
  };
  it.each([
    [{ phase: 'disabled', mode: 'dry-run' }, 0, 0], [{ phase: 'idle', mode: 'live' }, 0, 0], [{ phase: 'running', mode: 'dry-run' }, 0, 0],
    [{ phase: 'disabled', mode: 'dry-run' }, 1_260_001, 1], [{ phase: 'fatal', stage: 'cycle' }, 0, 1], [{ phase: 'stopped' }, 0, 1],
  ])('%j aged %i ms exits %i', async (snapshot, age, code) => {
    const [node, ...args] = await command();
    const file = `${await scratch('health')}/health.json`;
    await writeFile(file, JSON.stringify({ ...snapshot, updatedAt: Date.now() - age }));
    const run = spawnSync(node === 'node' ? process.execPath : String(node), args, { env: { SH_COW_HEALTH_FILE: file } });
    expect(run.status).toBe(code);
  });
});
