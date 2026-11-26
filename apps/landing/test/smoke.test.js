import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PUBLIC = join(ROOT, 'apps/landing/public');

function run(fault = '') {
  const scratch = join(ROOT, '.cache/tmp');
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, 'landing-smoke-test-'));
  writeFileSync(join(work, 'curl'), readFileSync(new URL('./fixtures/curl.mjs', import.meta.url)), { mode: 0o755 });
  const result = spawnSync('bash', ['infra/server/smoke-landing.sh', PUBLIC], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${work}:${process.env.PATH}`, TMPDIR: work, LANDING_FIXTURE_PUBLIC: PUBLIC, LANDING_FIXTURE_FAULT: fault, LANDING_FIXTURE_TRACE: join(work, 'requests') },
  });
  return { ...result, work };
}

describe('external landing smoke check (curl fixture, no network or listener)', () => {
  it('checks all six HTTPS hosts, redirect paths/queries, real assets and missing pages', () => {
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status, result.stdout).toBe(0);
    const requests = readFileSync(join(result.work, 'requests'), 'utf8').trim().split('\n').map((line) => new URL(line));
    expect([...new Set(requests.map((url) => url.hostname))].sort()).toEqual([
      'squarehole.fun', 'www.squarehole.fun', 'squarehole.xyz', 'www.squarehole.xyz', 'squarehole.fit', 'www.squarehole.fit',
    ].sort());
    expect(requests.every((url) => url.protocol === 'https:')).toBe(true);
    for (const host of new Set(requests.map((url) => url.hostname).filter((host) => host !== 'squarehole.fun'))) {
      expect(requests.some((url) => url.hostname === host && url.pathname.includes('%2F') && url.search.includes('&'))).toBe(true);
    }
    for (const path of ['/', '/index.html', '/styles.css', '/art/card-1200x630.jpg', '/brand/mark.svg', '/fonts/plus-jakarta-sans-latin-wght-normal.woff2', '/_headers', '/_routes.json', '/nft/the-misfits/1.json']) {
      expect(requests.some((url) => url.hostname === 'squarehole.fun' && url.pathname === path), path).toBe(true);
    }
  });

  it.each([
    ['redirect', 'Location was'], ['security', 'X-Frame-Options was'], ['cache', 'Cache-Control was'],
    ['body', 'body differs'], ['nft', 'NFT rejection must have an empty body'], ['status', 'status 200, expected 404'],
    ['network', 'request failed'],
  ])('fails on %s drift', (fault, message) => {
    const result = run(fault);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke-landing:');
    expect(result.stderr).toContain(message);
  });
});
