import { execFileSync } from './local-command.mjs';
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { configOf, policyOf, renderSites } from '../app/config.mjs';
import { sha256 } from '../app/build.mjs';
import { curlRequest, smoke } from '../app/smoke.mjs';
import { gatewayFixture } from './gateway-fixture.mjs';

async function fixture() {
  mkdirSync('.cache/tmp', { recursive: true });
  const artifact = mkdtempSync(resolve('.cache/tmp/app-smoke-'));
  mkdirSync(join(artifact, 'public/assets'), { recursive: true });
  const bytes = { 'index.html': '<html>offline app</html>', 'assets/app-abcdefgh.js': 'offline script', 'assets/app-ijklmnop.css': 'offline css' };
  for (const [file, body] of Object.entries(bytes)) writeFileSync(join(artifact, 'public', file), body);
  const content = { format: 'squarehole.app-release/1', ...configOf('', 'sepolia'), commit: 'a'.repeat(40), headers: await policyOf(process.cwd()), files: Object.fromEntries(Object.entries(bytes).map(([name, body]) => [name, sha256(body)])) };
  const release = { ...content, id: sha256(JSON.stringify(content)) };
  writeFileSync(join(artifact, 'release.json'), JSON.stringify(release));
  const sites = renderSites(release);
  writeFileSync(join(artifact, 'app.site.caddy'), sites.site);
  writeFileSync(join(artifact, 'app.cors.caddy'), sites.cors);
  const calls = [];
  const upstream = gatewayFixture();
  const request = async (url, origin, access = false) => {
    calls.push({ url, origin, access });
    const parsed = new URL(url);
    if (parsed.hostname === 'api.squarehole.fun') {
      const response = await upstream.request(`${parsed.pathname}${parsed.search}`);
      const { 'access-control-allow-origin': ignored, ...headers } = response.headers;
      expect(ignored).toBe('*');
      return { ...response, headers: { ...headers, vary: 'Origin', ...(origin === `https://${release.testHost}` ? { 'access-control-allow-origin': origin } : {}) } };
    }
    const path = parsed.pathname;
    const found = bytes[path.slice(1)];
    const missing = path.includes('missing') || path === '/_headers' || path.endsWith('.map');
    return { status: missing ? 404 : 200, headers: { ...Object.fromEntries(Object.entries(release.headers).map(([k, v]) => [k.toLowerCase(), v])), 'x-sh-app-release': release.id, 'cache-control': found && path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' }, body: Buffer.from(missing ? '' : found ?? bytes['index.html']) };
  };
  return { artifact, release, request, calls };
}

describe('external app smoke with response doubles', () => {
  it('checks the exact release, route fallback, assets, security headers, missing files and API CORS', async () => {
    const f = await fixture();
    await smoke(f.artifact, { request: f.request });
    expect(f.calls.some((c) => new URL(c.url).pathname === '/create')).toBe(true);
    expect(f.calls.some((c) => new URL(c.url).pathname === '/assets/__missing.js')).toBe(true);
    expect(f.calls.some((c) => c.origin === 'https://unapproved.invalid')).toBe(true);
    expect(f.calls.every((c) => c.url.startsWith('https://'))).toBe(true);
  });
  it('asks for the Access token only on the test host, never on the API', async () => {
    const f = await fixture();
    await smoke(f.artifact, { request: f.request });
    for (const call of f.calls) expect(call.access, call.url).toBe(new URL(call.url).hostname === f.release.testHost);
  });
  it('names Cloudflare Access when its login redirect answers', async () => {
    const f = await fixture();
    const login = { status: 302, headers: { location: 'https://example-team.cloudflareaccess.com/cdn-cgi/access/login/test-app' }, body: Buffer.alloc(0) };
    await expect(smoke(f.artifact, { request: async (url, origin, access) => (new URL(url).hostname === f.release.testHost ? login : f.request(url, origin, access)) })).rejects.toThrow(/Cloudflare Access answered; set SH_ACCESS_HEADERS/);
  });
  it('curlRequest gives curl the token file by path, only when asked, never its contents', () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const bin = mkdtempSync(resolve('.cache/tmp/app-smoke-curl-'));
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env node
import { appendFileSync, writeFileSync, writeSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.CURL_TRACE, JSON.stringify(args) + '\\n');
writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/2 200\\r\\nx-test: yes\\r\\n\\r\\n');
writeFileSync(args[args.indexOf('--output') + 1], 'reflected fixture-secret-not-real');
if (process.env.CURL_FAIL) process.exit(7);
writeSync(1, '200');
`, { mode: 0o755 });
    const token = join(bin, 'token');
    writeFileSync(token, 'CF-Access-Client-Id: fixture-id.access\nCF-Access-Client-Secret: fixture-secret-not-real\n', { mode: 0o600 });
    const saved = { PATH: process.env.PATH, CURL_TRACE: process.env.CURL_TRACE, SH_ACCESS_HEADERS: process.env.SH_ACCESS_HEADERS };
    Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, CURL_TRACE: join(bin, 'trace'), SH_ACCESS_HEADERS: token });
    try {
      expect(curlRequest('https://test-app.squarehole.fun/', undefined, true)).toMatchObject({ status: 200, headers: { 'x-test': 'yes' } });
      curlRequest('https://api.squarehole.fun/healthz', 'https://test-app.squarehole.fun');
      process.env.CURL_FAIL = '1';
      expect(() => curlRequest('https://test-app.squarehole.fun/', undefined, true)).toThrow();
      delete process.env.CURL_FAIL;
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    }
    const [app, api, failed] = readFileSync(join(bin, 'trace'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    // XR-SH-ACCESS-SMOKE F1: -q first, so no ~/.curlrc applies. F2: the response files are gone on success and failure.
    for (const args of [app, api, failed]) {
      expect(args[0]).toBe('-q');
      expect(existsSync(args[args.indexOf('--dump-header') + 1])).toBe(false);
      expect(existsSync(args[args.indexOf('--output') + 1])).toBe(false);
    }
    expect(app.slice(app.indexOf(`@${token}`) - 1, app.indexOf(`@${token}`) + 1)).toEqual(['--header', `@${token}`]);
    expect(api.some((arg) => arg.startsWith('@'))).toBe(false);
    expect(JSON.stringify([app, api])).not.toContain('fixture-secret-not-real');
  });
  it('checks a real v2 feed response for the release chain with both allowed and unapproved origins', async () => {
    const f = await fixture();
    await smoke(f.artifact, { request: f.request });
    const calls = f.calls.filter((c) => new URL(c.url).pathname === '/v2/feed');
    expect(calls.map((c) => c.origin)).toEqual([`https://${f.release.testHost}`, 'https://unapproved.invalid']);
    expect(calls.every((c) => new URL(c.url).searchParams.get('chain') === f.release.chain)).toBe(true);
    expect(calls.every((c) => new URL(c.url).searchParams.has('sh-app-check'))).toBe(true);
  });
  it.each(['404', '503', 'html', 'invalid-json', 'wrong-schema', 'wrong-chain', 'missing-cards', 'cors', 'vary'])('refuses v2 %s even when health is green', async (fault) => {
    const f = await fixture();
    await expect(smoke(f.artifact, { request: async (url, origin) => {
      const response = await f.request(url, origin);
      if (new URL(url).pathname !== '/v2/feed') return response;
      if (fault === '404') response.status = 404;
      if (fault === '503') response.status = 503;
      if (fault === 'html') {
        response.headers['content-type'] = 'text/html';
        response.body = Buffer.from('<html>obviously-fake-response</html>');
      }
      if (fault === 'invalid-json') response.body = Buffer.from('obviously-fake-response');
      if (['wrong-schema', 'wrong-chain', 'missing-cards'].includes(fault)) {
        const feed = JSON.parse(response.body);
        if (fault === 'wrong-schema') feed.schema = 'sh.core-feed.v1';
        if (fault === 'wrong-chain') feed.chainId = 1;
        if (fault === 'missing-cards') feed.cards = null;
        response.body = Buffer.from(JSON.stringify(feed));
      }
      if (fault === 'cors') response.headers['access-control-allow-origin'] = '*';
      if (fault === 'vary') response.headers.vary = 'Accept-Encoding';
      return response;
    } })).rejects.toThrow(/^smoke-app: v2 feed/);
  });
  it.each(['status', 'body', 'csp', 'cache', 'release', 'cors', 'connection'])('refuses %s fault without printing response content', async (fault) => {
    const f = await fixture();
    await expect(smoke(f.artifact, { request: async (url, origin) => {
      if (fault === 'connection') throw new Error('obviously-fake-sensitive-response');
      const response = await f.request(url, origin);
      if (fault === 'status') response.status = 302;
      if (fault === 'body') response.body = Buffer.from('wrong build');
      if (fault === 'csp') response.headers['content-security-policy'] = "default-src *";
      if (fault === 'cache') response.headers['cache-control'] = 'public, max-age=14400';
      if (fault === 'release') response.headers['x-sh-app-release'] = 'wrong release';
      if (fault === 'cors') response.headers['access-control-allow-origin'] = '*';
      return response;
    } })).rejects.toThrow(/smoke-app:/);
  });
  it('dry run verifies the local release without making requests', async () => {
    const f = await fixture();
    await smoke(f.artifact, { request: f.request, dryRun: true });
    expect(f.calls).toHaveLength(0);
    expect(execFileSync('bash', ['infra/server/smoke-app.sh', f.artifact, '--dry-run'], { encoding: 'utf8' })).toContain('dry run');
    expect(execFileSync('bash', ['infra/server/app/validate.sh', f.artifact, '--dry-run'], { encoding: 'utf8' })).toContain('dry run');
    writeFileSync(join(f.artifact, 'public/index.html'), 'corrupt');
    await expect(smoke(f.artifact, { request: f.request, dryRun: true })).rejects.toThrow(/artifact/);
  });
});
