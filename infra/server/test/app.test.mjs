import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { configOf, policyOf, renderSites } from '../app/config.mjs';

const root = process.cwd();
const read = (path) => readFileSync(path, 'utf8');
const commit = 'a'.repeat(40);
const id = 'b'.repeat(64);

describe('app host configuration and policy', () => {
  it('defaults to distinct main and Sepolia hosts; refuses mainnet even in a dry run', () => {
    expect(configOf('', 'sepolia')).toEqual({ mainHost: 'app.squarehole.fun', testHost: 'test-app.squarehole.fun', chain: '11155111' });
    expect(() => configOf('', 'mainnet')).toThrow(/G08/);
    expect(() => configOf('', '1')).toThrow(/G08/);
  });
  it('accepts only DNS names and two known public settings, without echoing bad values', () => {
    expect(configOf('SH_APP_MAIN_HOST=app.example.org\nSH_APP_TEST_HOST=test.example.org\n', 'sepolia').testHost).toBe('test.example.org');
    for (const input of ['SH_APP_TEST_HOST=api.squarehole.fun', 'SH_APP_TEST_HOST=app.squarehole.fun', 'SH_APP_MAIN_HOST=squarehole.fun', 'SH_APP_TEST_HOST=*.example.org', 'SH_APP_TEST_HOST=https://test.example.org', 'SH_APP_TEST_HOST=x.example.org { evil }', 'SH_APP_TEST_HOST=127.0.0.1', 'SH_APP_TEST_HOST=test.example.org\nSH_APP_TEST_HOST=other.example.org', 'UNKNOWN=obviously-fake-sensitive-value']) {
      expect(() => configOf(input, 'sepolia')).toThrow();
      try { configOf(input, 'sepolia'); } catch (error) { expect(error.message).not.toContain('obviously-fake-sensitive-value'); }
    }
  });
  it('uses the actual site RPC hosts and exactly the landing security headers except the app CSP', async () => {
    const policy = await policyOf(root);
    expect(policy['Content-Security-Policy']).toContain("connect-src https://api.squarehole.fun https://ethereum-sepolia-rpc.publicnode.com https://sepolia.gateway.tenderly.co https://upload.ardrive.io https://turbo-gateway.com https://arweave.net https://goldsky.arweave.net;");
    // SH-ARWEAVE-PICTURES-WEB: the pictures' four hosts are connections only; img-src is unchanged.
    expect(policy['Content-Security-Policy']).toContain("img-src 'self' data: blob: https://api.squarehole.fun;");
    expect(policy['Content-Security-Policy']).toContain("default-src 'none'");
    expect(policy['Content-Security-Policy']).not.toMatch(/unsafe-eval|https:;|connect-src 'self'/);
    const landing = read('infra/server/Caddyfile').split('(landing_headers) {')[1].split('\n}')[0];
    for (const [name, value] of Object.entries(policy)) if (name !== 'Content-Security-Policy') expect(landing).toContain(`${name} "${value}"`);
  });
  it('renders a gated main host, read-only SPA, exact CORS, immutable existing hashes and uncached fallbacks', async () => {
    const files = renderSites({ ...configOf('', 'sepolia'), commit, id, headers: await policyOf(root) });
    expect(files.site).toContain('http://app.squarehole.fun, https://app.squarehole.fun');
    expect(files.site).toContain('respond "Mainnet app unavailable (G08)" 503');
    expect(files.site).toContain('http://test-app.squarehole.fun, https://test-app.squarehole.fun');
    expect(files.site).toContain(`root * /srv/app/releases/${id}/public`);
    expect(files.site).toContain('try_files {path} /index.html');
    expect(files.site).toContain('public, max-age=31536000, immutable');
    expect(files.site).toContain('no-store');
    expect(files.site).toContain('not method GET HEAD');
    expect(files.site).toContain('handle_errors 404');
    expect(files.cors).toContain('header Origin https://test-app.squarehole.fun');
    expect(files.cors).not.toContain('https://app.squarehole.fun');
    expect(read('infra/server/Caddyfile')).toContain('import /srv/app/current/*.site.caddy');
    expect(read('infra/server/Caddyfile')).toContain('import /srv/app/current/*.cors.caddy');
    expect(read('infra/server/compose.yaml')).toContain('/srv/squarehole/app:/srv/app:ro');
  });
});
