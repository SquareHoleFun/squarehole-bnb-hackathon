import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';

const images = [['keeper', 'packages/keeper/Dockerfile'], ['burn-bot', 'packages/burn-bot/Dockerfile'], ['reveal', 'infra/server/reveal.Dockerfile']];
const poster = 'packages/cow-poster/Dockerfile';
const sources = (file) => [...readFileSync(file, 'utf8').matchAll(/^COPY (.+)$/gm)]
  .flatMap(m => m[1].trim().split(/\s+/).slice(0, -1));

describe('reviewed service release packaging', () => {
  it('the real local git archive supplies every image COPY input and all worker entrypoints', () => {
    const paths = readFileSync('infra/server/ship.sh', 'utf8').match(/paths=\(([\s\S]*?)\n\)/)[1].trim().split(/\s+/);
    const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD', ...paths], { maxBuffer: 64 * 1024 * 1024 });
    const files = execFileSync('tar', ['-tf', '-'], { input: tar, encoding: 'utf8' }).split('\n');
    // The indexer too: box 0's logo and cover are COPY inputs outside its packages (SH-BOX0-ART-TEST-SITE).
    for (const dockerfile of [...images.map(([, file]) => file), poster, 'infra/server/indexer.Dockerfile']) {
      expect(files).toContain(dockerfile);
      for (const path of sources(dockerfile)) expect(files.some(f => f === path || f.startsWith(`${path}/`)), path).toBe(true);
    }
    for (const service of ['keeper', 'burn-bot', 'reveal']) expect(files).toContain(`infra/server/services/${service}.mjs`);
    expect(files).toContain('packages/cow-poster/src/main.ts');
    expect(files).not.toContain('scripts/arweave/upload.mjs'); // Separate unresolved Hosting integration, documented.
  });
  it.each(images)('%s loads using only its Docker COPY sources and already installed dependencies', (name, dockerfile) => {
    mkdirSync('.cache/tmp', { recursive: true });
    const app = mkdtempSync(resolve('.cache/tmp/service-image-'));
    const files = sources(dockerfile);
    for (const path of files) {
      const target = join(app, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target, { recursive: true });
      if (/^packages\/[^/]+\/package\.json$/.test(path)) {
        const modules = resolve(dirname(path), 'node_modules');
        if (existsSync(modules)) symlinkSync(modules, join(dirname(target), 'node_modules'));
      }
    }
    const program = `
      import assert from 'node:assert/strict';
      globalThis.fetch = () => { throw new Error('offline import attempted a request'); };
      const { createDriver } = await import('./infra/server/services/${name}.mjs');
      ${name === 'reveal' ? `
        for (const mode of ['dry-run', 'live']) {
          await assert.rejects(createDriver({ SH_REVEAL_COLLECTIONS: '[]', SH_REVEAL_CHAIN_ID: '11155111' },
            { enabled: true, mode, allowMainnet: false }), { message: 'v2 reveal refused; details suppressed' });
        }
      ` : ''}
    `;
    expect(() => execFileSync(process.execPath, ['--experimental-transform-types', '--no-warnings=ExperimentalWarning',
      '--import', './packages/keeper/scripts/register-ts.mjs', '--input-type=module', '-e', program],
    { cwd: app, env: { PATH: process.env.PATH }, stdio: 'pipe' })).not.toThrow();
  }, shLimit(60000));
  it('installs the v2 reveal imports through the locked keeper production dependencies', () => {
    const dockerfile = readFileSync('infra/server/reveal.Dockerfile', 'utf8');
    expect(sources('infra/server/reveal.Dockerfile')).toContain('packages/keeper/package.json');
    expect(dockerfile).toMatch(/RUN pnpm install --frozen-lockfile --prod .*--filter '@squarehole\/keeper\.\.\.'/);
  });
  it('the CoW order poster runs its image command from only its Docker COPY sources and installed dependencies', () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const app = mkdtempSync(resolve('.cache/tmp/service-image-'));
    for (const path of sources(poster)) {
      const target = join(app, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target, { recursive: true });
      if (/^packages\/[^/]+\/package\.json$/.test(path)) {
        const modules = resolve(dirname(path), 'node_modules');
        if (existsSync(modules)) symlinkSync(modules, join(dirname(target), 'node_modules'));
      }
    }
    const dockerfile = readFileSync(poster, 'utf8');
    const workdir = [...dockerfile.matchAll(/^WORKDIR \/app\/?(.*)$/gm)].at(-1)?.[1] ?? '';
    const [node, ...args] = JSON.parse([...dockerfile.matchAll(/^CMD (\[.*\])$/gm)].at(-1)?.[1] ?? '[]');
    expect(node).toBe('node');
    // A misspelled operator flag stops it after every import has loaded and before any setting, file or network.
    const run = spawnSync(process.execPath, args, { cwd: join(app, workdir), encoding: 'utf8',
      env: { PATH: process.env.PATH, SH_SERVICE_ENABLED: 'yes' } });
    expect(run.status, run.stderr).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ event: 'fatal', stage: 'config' });
  });
  it('the CoW order poster runs the smoke check of smoke-services.sh from only its Docker COPY sources, at its WORKDIR', () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const app = mkdtempSync(resolve('.cache/tmp/service-image-'));
    for (const path of sources(poster)) {
      const target = join(app, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target, { recursive: true });
      if (/^packages\/[^/]+\/package\.json$/.test(path)) {
        const modules = resolve(dirname(path), 'node_modules');
        if (existsSync(modules)) symlinkSync(modules, join(dirname(target), 'node_modules'));
      }
    }
    const workdir = [...readFileSync(poster, 'utf8').matchAll(/^WORKDIR \/app\/?(.*)$/gm)].at(-1)?.[1] ?? '';
    const check = readFileSync('infra/server/smoke-services.sh', 'utf8').match(/^poster_check=\((.*)\)$/m)?.[1].split(' ') ?? [];
    expect(check[0]).toBe('node');
    const health = join(app, 'health.json');
    const run = (record) => {
      if (record) writeFileSync(health, JSON.stringify(record));
      return spawnSync(process.execPath, check.slice(1), { cwd: join(app, workdir), encoding: 'utf8', env: { PATH: process.env.PATH, SH_COW_HEALTH_FILE: health } });
    };
    expect(run(null).status).toBe(1);
    const ok = run({ phase: 'disabled', mode: 'dry-run', updatedAt: Date.now() });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('cow-poster: disabled; health current\n');
    expect(run({ phase: 'fatal', stage: 'manifest', updatedAt: Date.now() }).status).toBe(1);
  });
});
