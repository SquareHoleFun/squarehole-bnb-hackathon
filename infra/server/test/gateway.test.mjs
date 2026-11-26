import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configOf, renderSites } from '../app/config.mjs';
import { gatewayFixture } from './gateway-fixture.mjs';

const caddy = readFileSync('infra/server/Caddyfile', 'utf8');
// Inspect the actual gateway block and its matcher values. This is not a Caddy runtime substitute.
const gateway = caddy.split('(gateway) {')[1].split('\n}')[0];
const apiPaths = gateway.match(/^\s*@api path (.+)$/m)[1].trim().split(/\s+/);
const forwards = (url) => {
  const path = new URL(url, 'https://api.squarehole.fun').pathname;
  return apiPaths.some((pattern) => pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern);
};

describe('Caddy v2 gateway regression', () => {
  it('LINKS-SRV admits the bounded links POST before the general write refusal', () => {
    const matcher = gateway.match(/@links_post \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
    expect(matcher).toMatch(/method POST/);
    const path = matcher.match(/path_regexp (.+)/)?.[1]?.trim();
    expect(path).toBe('^/v2/boxes/[0-9]{1,10}/0x[0-9a-fA-F]{40}/links$');
    const pattern = new RegExp(path);
    expect(pattern.test(`/v2/boxes/11155111/0x${'a'.repeat(40)}/links`)).toBe(true);
    expect(pattern.test('/v2/feed')).toBe(false);
    const handle = gateway.match(/handle @links_post \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
    expect(gateway.indexOf('handle @links_post')).toBeGreaterThan(0);
    expect(gateway.indexOf('handle @links_post')).toBeLessThan(gateway.indexOf('handle @write'));
    expect(handle).toMatch(/request_body \{\s*max_size 4KiB\s*\}/);
    expect(handle).toContain('reverse_proxy indexer:5394');
    expect(handle).toContain('header_up X-Forwarded-For {client_ip}');
    expect(handle).toContain('header_down -Access-Control-Allow-Origin');
    expect(handle).toContain('header_down -Access-Control-Allow-Headers');
    const zone = gateway.match(/zone links \{([\s\S]*?)\n\t\t\}/)?.[1] ?? '';
    expect(zone).toMatch(/match \{\s*method POST\s*path_regexp \^\/v2\/boxes\/\[\^\/\]\+\/\[\^\/\]\+\/links\/\?\$/);
    expect(zone).toMatch(/key \{client_ip\}\s+events 10\s+window 1m\s+ipv6_prefix 64/);
    // The origin allowlist stays unchanged for simple text/plain POSTs.
    expect(gateway).toContain('@site_origin header_regexp Origin ^(https://squarehole\\.fun|http://127\\.0\\.0\\.1(:[0-9]{1,5})?)$');
    expect(gateway).toMatch(/header @site_origin \{\s*Access-Control-Allow-Origin \{http.request.header.Origin\}\s*Access-Control-Allow-Headers If-None-Match\s*Access-Control-Max-Age 600\s*\}/);
  });

  it.each(['feed', 'claims', 'activity'])('forwards the working v2 %s route to the existing indexer', async (route) => {
    const f = gatewayFixture();
    const paths = {
      feed: `/v2/feed?chain=${f.chainId}`,
      claims: `/v2/wallets/${f.chainId}/${f.wallet}/claims`,
      activity: `/v2/boxes/${f.chainId}/${f.token}/activity?limit=1`,
    };
    const response = await f.request(paths[route]);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(f[route]);
    expect(forwards(paths[route]), `Caddy must forward the working upstream ${route}`).toBe(true);
    expect(gateway).toMatch(/handle @api \{\s*reverse_proxy indexer:5394 \{/);
  });

  it('admits both API roots and keeps health/v1, without admitting other namespaces', () => {
    for (const path of ['/healthz', '/v1', '/v1/feed?chain=11155111', '/v2', '/v2/']) expect(forwards(path), path).toBe(true);
    for (const path of ['/admin', '/v20/feed', '/v2evil', '/v3/feed', '/healthz/extra']) expect(forwards(path), path).toBe(false);
  });

  it.each(['v1', 'v2'])('applies the shared 20/minute stream zone to %s streams, including trailing slash', (version) => {
    const zone = gateway.match(/zone streams \{([\s\S]*?)\n\t\t\}/)[1];
    const matcher = new RegExp(zone.match(/path_regexp (.+)/)[1].trim());
    const path = `/${version}/boxes/11155111/0x${'2'.repeat(40)}/stream`;
    expect(matcher.test(path)).toBe(true);
    expect(matcher.test(`${path}/`)).toBe(true);
    for (const other of [path.replace('/stream', '/activity'), `${path}/extra`, path.replace(version, 'v20')]) expect(matcher.test(other)).toBe(false);
    expect(zone).toMatch(/key \{client_ip\}\s+events 20\s+window 1m\s+ipv6_prefix 64/);
  });

  it('keeps the shared read-only, trusted-client, CORS and general rate protections for both versions', async () => {
    expect(gateway).toMatch(/@write not method GET HEAD OPTIONS\s+handle @write \{\s*respond "read-only" 405/);
    expect(gateway.indexOf('handle @write')).toBeLessThan(gateway.indexOf('handle @api'));
    expect(gateway).toMatch(/zone per_client \{\s+key \{client_ip\}\s+events 600\s+window 1m\s+ipv6_prefix 64/);
    expect(gateway).toContain('header_up X-Forwarded-For {client_ip}');
    expect(gateway).toContain('header_down -Access-Control-Allow-Origin');
    expect(gateway).toContain('header_down -Access-Control-Allow-Headers');
    // CV-1: append the CORS dimension without replacing the encoder's Accept-Encoding dimension.
    expect(gateway).not.toMatch(/^\s*Vary[ \t]+/im);
    expect(gateway).toMatch(/^\s*\+Vary[ \t]+Origin[ \t]*$/m);
    expect(gateway).toContain('import /srv/app/current/*.cors.caddy');
    const { cors } = renderSites({ ...configOf('', 'sepolia'), id: 'a'.repeat(64), headers: {} });
    expect(cors).toContain('@app_origin header Origin https://test-app.squarehole.fun');
    expect(cors).toContain('Access-Control-Allow-Origin {http.request.header.Origin}');
    expect(cors).not.toContain('Access-Control-Allow-Origin *');
    const f = gatewayFixture();
    for (const path of ['/v2/feed', `/v2/wallets/${f.chainId}/${f.wallet}/claims`, `/v2/boxes/${f.chainId}/${f.token}/activity`]) {
      expect((await f.request(path, 'POST')).status).toBe(405);
      expect((await f.request(path, 'OPTIONS')).status).toBe(204);
    }
  });
});


it('LINKS-SRV links POST responses expose Retry-After only when an allowed site origin received CORS', () => {
  // A deferred response matcher also covers the active app origin imported above, without copying its deployment hostname.
  const exposure = gateway.match(/header @links_post \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  expect(exposure).toMatch(/Access-Control-Expose-Headers Retry-After/);
  expect(exposure).toMatch(/match \{\s*header Access-Control-Allow-Origin \*\s*\}/);
  expect(gateway.indexOf('header @links_post')).toBeLessThan(gateway.indexOf('rate_limit {'));
  const handle = gateway.match(/handle @links_post \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  expect(handle).toContain('header_down -Access-Control-Expose-Headers');
  const sitePattern = new RegExp(gateway.match(/@site_origin header_regexp Origin (.+)/)[1]);
  const { cors } = renderSites({ ...configOf('', 'sepolia'), id: 'a'.repeat(64), headers: {} });
  const appOrigin = cors.match(/@app_origin header Origin (.+)/)[1];
  for (const origin of ['https://squarehole.fun', 'http://127.0.0.1:5391', appOrigin]) expect(sitePattern.test(origin) || origin === appOrigin).toBe(true);
  for (const origin of ['', 'null', 'https://evil.invalid', 'https://squarehole.fun.evil.invalid']) expect(sitePattern.test(origin) || origin === appOrigin).toBe(false);
  // Caddy errors leave the normal response-writer chain: install the same policy in the error route.
  const errors = gateway.match(/handle_errors \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  expect(errors).toMatch(/header @links_post \{/);
  expect(errors).toMatch(/Access-Control-Expose-Headers Retry-After/);
  expect(errors).toMatch(/match \{\s*header Access-Control-Allow-Origin \*\s*\}/);
  // Broadening error handling must keep the card fallback limited to its original upstream failures.
  expect(errors).toMatch(/@card_down \{\s*path \/card\/\*\s*expression `\{err.status_code\} in \[502, 503, 504\]`/);
  expect(errors).toContain('respond "" {err.status_code}');
  expect(gateway.match(/Access-Control-Expose-Headers Retry-After/g)).toHaveLength(4);
});


it('SH-ARWEAVE-HINT admits the exact JSON POST, limits clients and exposes CORS only to allowed origins', () => {
  const matcher = gateway.match(/@picture_hint_post \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  expect(matcher).toContain('method POST');
  expect(matcher).toContain('path /v2/pictures/hint');
  expect(matcher).toContain("{http.request.orig_uri} == '/v2/pictures/hint'");
  const handle = gateway.match(/handle @picture_hint_post \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  expect(gateway.indexOf('handle @picture_hint_post')).toBeGreaterThan(0);
  expect(gateway.indexOf('handle @picture_hint_post')).toBeLessThan(gateway.indexOf('handle @write'));
  expect(handle).toMatch(/request_body \{\s*max_size 1KiB\s*\}/);
  expect(handle).toContain('reverse_proxy indexer:5394');
  expect(handle).toContain('header_up X-Forwarded-For {client_ip}');
  for (const header of ['Origin', 'Headers']) expect(handle).toContain(`header_down -Access-Control-Allow-${header}`);
  expect(handle).toContain('header_down -Access-Control-Expose-Headers');
  const zone = gateway.match(/zone picture_hints \{([\s\S]*?)\n\t\t\}/)?.[1] ?? '';
  expect(zone).toMatch(/match \{\s*method POST\s*path \/v2\/pictures\/hint\s*\}/);
  expect(zone).toMatch(/key \{client_ip\}\s+events 10\s+window 1m\s+ipv6_prefix 64/);
  const preflight = gateway.match(/header @picture_hint_preflight \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  expect(preflight).toContain('Access-Control-Allow-Headers Content-Type');
  expect(preflight).toContain('Access-Control-Allow-Methods "POST, OPTIONS"');
  expect(preflight).toMatch(/match \{\s*header Access-Control-Allow-Origin \*\s*\}/);
  const expose = gateway.match(/header @picture_hint_post \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  expect(expose).toContain('Access-Control-Expose-Headers Retry-After');
  expect(expose).toMatch(/match \{\s*header Access-Control-Allow-Origin \*\s*\}/);
  expect(gateway.indexOf('header @picture_hint_post')).toBeLessThan(gateway.indexOf('rate_limit {'));
  const errors = gateway.match(/handle_errors \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
  expect(errors).toContain('header @picture_hint_post');
});
