/**
 * F161 (4), SH-ALPHA-SITE: the page lock and the public join files at the HTTP level, on the suite's edge (the test
 * host's routes with the alpha switch on): a stranger gets the join page and its own files and nothing of the app;
 * only the canonical join paths are public; the release's headers stand on every answer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { alphaContext } from './helpers.mjs';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../../.cache/alpha-access/dist');
const scriptsOf = (html) => [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((match) => match[1]);

test('the page lock: a stranger gets the join page and its own files, nothing of the app; only canonical join paths; the release’s headers', async ({ page }, testInfo) => {
  const { baseURL } = await alphaContext(page, testInfo);
  const origin = new URL(baseURL).origin;
  const get = (path) => page.request.get(path, { maxRedirects: 0 });
  const appFiles = scriptsOf(readFileSync(join(DIST, 'index.html'), 'utf8'));
  const joinFiles = scriptsOf(readFileSync(join(DIST, 'join/index.html'), 'utf8'));
  expect(appFiles.length).toBeGreaterThan(0);
  // The join page's own graph: every file it names is under /join/assets/.
  expect(joinFiles.length).toBeGreaterThan(0);
  expect(joinFiles.filter((path) => !path.startsWith('/join/assets/'))).toEqual([]);

  for (const path of ['/', '/test-coins', '/about/risks', '/index.html', ...appFiles, '/favicon.svg', '/join/missing.js', '/join/assets/../../index.html', '/join/%61ssets/x.js', '/joinx', '/desk-not']) {
    const response = await get(path);
    expect(response.status(), path).toBe(303);
    expect(response.headers().location, path).toBe('/join');
    expect(response.headers()['cache-control'], path).toBe('no-store');
  }
  for (const path of ['/join', '/join/', '/join/index.html', ...joinFiles]) {
    const response = await get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['cache-control'], path).toBe('no-store');
  }
  expect((await get('/join/assets/no-such-file.js')).status()).toBe(404);
  expect((await page.request.post('/join', { maxRedirects: 0, headers: { origin } })).status()).toBe(405);
  expect((await page.request.post('/', { maxRedirects: 0, headers: { origin } })).status()).toBe(303);

  // Our server without a session, and a POST from another origin.
  const me = await get('/alpha/me');
  expect([me.status(), await me.json()]).toEqual([401, { error: 'sign in required' }]);
  const foreign = await page.request.post('/alpha/session', { headers: { origin: 'https://elsewhere.example', 'privy-id-token': 'x.y.z' } });
  expect([foreign.status(), await foreign.json()]).toEqual([403, { error: 'same origin required' }]);

  // The release's headers (infra/server/app/config.mjs `policyOf`, alpha switch on), this origin standing for the test host.
  const headers = (await get('/join/')).headers();
  const csp = headers['content-security-policy'];
  expect(csp).toContain("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';");
  expect(csp).toContain(`connect-src ${origin} https://auth.privy.io https://*.rpc.privy.systems https://api.squarehole.fun `);
  expect(csp).toContain("form-action 'none'; frame-ancestors 'none'; frame-src https://auth.privy.io; child-src https://auth.privy.io");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['x-content-type-options']).toBe('nosniff');
});
