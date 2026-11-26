import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
import { configOf, policyOf, renderSites } from '../app/config.mjs';
const fixture = { id: 'b'.repeat(64), headers: {} };
test('Caddy switch absent or zero preserves the previous site byte for byte', () => {
  const expected = readFileSync('infra/server/test/fixtures/alpha/access-off.site.caddy', 'utf8');
  for (const input of ['', 'SH_APP_ALPHA_ACCESS=0']) {
    const config = configOf(input, 'sepolia');
    assert.equal(renderSites({ ...fixture, ...config }).site, expected);
  }
});
test('Caddy switch validates strictly and adds ordered routes before the page check', async () => {
  for (const input of ['SH_APP_ALPHA_ACCESS=true', 'SH_APP_ALPHA_ACCESS=1\nSH_APP_ALPHA_ACCESS=0']) assert.throws(() => configOf(input, 'sepolia'));
  const config = configOf('SH_APP_ALPHA_ACCESS=1', 'sepolia'); assert.equal(config.alphaAccess, true);
  const { site } = renderSites({ ...fixture, ...config });
  assert.match(site, /route \{\n\s*import alpha_access/);
  assert.ok(site.indexOf('import alpha_access') < site.indexOf('@write not method'));
  assert.ok(!site.includes('public, max-age=31536000, immutable'));
  assert.match(site, /Mainnet app unavailable \(G08\)/);
  const caddy = readFileSync('infra/server/Caddyfile', 'utf8').split('(alpha_access) {')[1].split('\n# Checked app releases')[0];
  assert.ok(caddy.indexOf('handle @alpha_api') < caddy.indexOf('uri /alpha/check'));
  assert.ok(caddy.indexOf('handle @alpha_desk') < caddy.indexOf('uri /alpha/check'));
  assert.match(caddy, /uri \/desk\/api\/check/);
  assert.match(caddy, /path \/join \/join\/ \/join\/index\.html \/join\/assets\/\*/);
  assert.match(caddy, /zone alpha_api/); assert.match(caddy, /events 60/);
  assert.match(caddy, /request_body \{\n\s*max_size 16KiB/);
  assert.match(caddy, /\n\t\t\tredir \* \/join 303\n/); // `*` first: a leading /join is Caddy's path matcher (caddy-lint.test.mjs)
  assert.ok(!caddy.includes('path /assets/*'));
  const policy = await policyOf(process.cwd(), config);
  assert.match(policy['Content-Security-Policy'], /connect-src https:\/\/test-app\.squarehole\.fun /);
  assert.match(policy['Content-Security-Policy'], /frame-src https:\/\/auth\.privy\.io/);
  assert.match(policy['Content-Security-Policy'], /child-src https:\/\/auth\.privy\.io/);
  assert.match(policy['Content-Security-Policy'], /https:\/\/\*\.rpc\.privy\.systems/);
  assert.ok(!policy['Content-Security-Policy'].includes('challenges.cloudflare.com'));
});

test('enabled artifacts require separate join and desk entries and assets', async () => {
  const { requireAlphaEntries } = await import('../app/config.mjs');
  const files = { 'index.html': 'hash', 'assets/app-abcdefgh.js': 'hash' };
  assert.throws(() => requireAlphaEntries({ alphaAccess: true }, files));
  requireAlphaEntries({}, files);
  requireAlphaEntries({ alphaAccess: true }, { ...files, 'join/index.html': 'hash', 'join/assets/entry-abcdefgh.js': 'hash', 'desk/index.html': 'hash', 'desk/assets/entry-abcdefgh.js': 'hash' });
});

test('enabled release smoke proves public join, anonymous denial and approved-cookie page access', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { directories } = await import('./fixtures/alpha/helpers.mjs');
  const { sha256 } = await import('../app/build.mjs');
  const { smoke } = await import('../app/smoke.mjs');
  const artifact = directories().root;
  const bytes = { 'index.html': 'private app', 'assets/app-abcdefgh.js': 'private JS', 'assets/app-abcdefgh.css': 'private CSS', 'join/index.html': 'public join', 'join/assets/entry-abcdefgh.js': 'join JS', 'desk/index.html': 'founder desk', 'desk/assets/entry-abcdefgh.js': 'desk JS' };
  for (const [file, body] of Object.entries(bytes)) { mkdirSync(join(artifact, 'public', file, '..'), { recursive: true }); writeFileSync(join(artifact, 'public', file), body); }
  const config = configOf('SH_APP_ALPHA_ACCESS=1', 'sepolia');
  const content = { format: 'squarehole.app-release/1', ...config, chain: '11155111', commit: 'a'.repeat(40), headers: await policyOf(process.cwd(), config), files: Object.fromEntries(Object.entries(bytes).map(([file, body]) => [file, sha256(body)])) };
  const release = { ...content, id: sha256(JSON.stringify(content)) }, rendered = renderSites(release);
  writeFileSync(join(artifact, 'release.json'), JSON.stringify(release));
  writeFileSync(join(artifact, 'app.site.caddy'), rendered.site); writeFileSync(join(artifact, 'app.cors.caddy'), rendered.cors);
  const calls = [];
  const request = async (url, suppliedOrigin, authenticated) => {
    const { pathname, hostname } = new URL(url); calls.push({ pathname, authenticated });
    if (hostname === 'api.squarehole.fun') return { status: 200, headers: { 'content-type': 'application/json', vary: 'Origin', ...(suppliedOrigin === `https://${release.testHost}` ? { 'access-control-allow-origin': suppliedOrigin } : {}) }, body: Buffer.from(JSON.stringify({ schema: 'sh.core-feed.v2', chainId: 11155111, cards: [] })) };
    if (pathname === '/alpha/check') return { status: authenticated ? 200 : 401, headers: { 'cache-control': 'no-store' }, body: Buffer.from('{}') };
    if (!authenticated && !pathname.startsWith('/join')) return { status: 303, headers: { location: '/join', 'cache-control': 'no-store' }, body: Buffer.alloc(0) };
    const file = pathname === '/join' ? 'join/index.html' : pathname.slice(1), missing = pathname.includes('__missing') || pathname === '/_headers';
    return { status: missing ? 404 : 200, headers: { ...Object.fromEntries(Object.entries(release.headers).map(([k,v]) => [k.toLowerCase(), v])), 'x-sh-app-release': release.id, 'cache-control': !missing && pathname.startsWith('/assets/') ? 'private, no-store' : 'no-store' }, body: Buffer.from(missing ? '' : bytes[file] ?? bytes['index.html']) };
  };
  await smoke(artifact, { request });
  assert.ok(calls.some(c => c.pathname === '/join' && !c.authenticated));
  assert.ok(calls.some(c => c.pathname === '/' && !c.authenticated));
  assert.ok(calls.some(c => c.pathname === '/alpha/check' && c.authenticated));
  await assert.rejects(smoke(artifact, { request: async (...args) => {
    const response = await request(...args); if (!args[2] && new URL(args[0]).pathname === '/') response.status = 200; return response;
  } }), /anonymous/);
});

test('public join matcher excludes encoded and dot-segment aliases to private files', () => {
  const source = readFileSync('infra/server/Caddyfile', 'utf8');
  const matcher = source.split('@alpha_join {')[1]?.split('\n\t}')[0];
  const pattern = matcher?.match(/orig_uri\}\.matches\('([^']+)'\)/)?.[1];
  assert.ok(pattern, 'public join needs a canonical original-URI check');
  const accepted = new RegExp(pattern);
  for (const path of ['/join', '/join/', '/join/index.html', '/join/assets/entry-abcdefgh.js', '/join/assets/style.hash.css?v=1']) assert.ok(accepted.test(path), path);
  for (const path of ['/join/assets/../../index.html', '/join/assets/%2e%2e/%2e%2e/index.html', '/join/assets/..%2f..%2findex.html', '/join//assets/a.js', '/join/assets/../a.js', '/join/%69ndex.html', '/assets/app.js']) assert.ok(!accepted.test(path), path);
});

test('SH-252: the examples’ pictures are kept a day, by any cache on an open site and only by the visitor’s browser behind the lock', async () => {
  const { EXAMPLES_ART_CACHE } = await import('../app/config.mjs');
  assert.deepEqual({ ...EXAMPLES_ART_CACHE }, { open: 'public, max-age=86400', locked: 'private, max-age=86400' });
  const open = renderSites({ ...fixture, ...configOf('', 'sepolia') }).site;
  const locked = renderSites({ ...fixture, ...configOf('SH_APP_ALPHA_ACCESS=1', 'sepolia') }).site;
  const block = (site) => site.slice(site.indexOf('\t@examples_art {'), site.indexOf('\t# Missing scripts/images'));
  assert.equal(block(open), '\t@examples_art {\n\t\tpath_regexp examples_art ^/examples/art/[A-Za-z0-9_.-]+$\n\t\tfile\n\t}\n'
    + '\thandle @examples_art {\n\t\theader Cache-Control "public, max-age=86400"\n\t\tfile_server\n\t}\n');
  assert.equal(block(locked), block(open).replace('public, max-age=86400', 'private, max-age=86400'));
  assert.ok(!locked.includes('public, max-age=86400'));
  // After the fingerprinted assets, before the no-store rule for every other file; behind the lock, inside its route.
  for (const site of [open, locked]) {
    assert.ok(site.indexOf('handle @immutable') < site.indexOf('handle @examples_art'));
    assert.ok(site.indexOf('handle @examples_art') < site.indexOf('handle @file'));
  }
  assert.ok(locked.indexOf('import alpha_access') < locked.indexOf('handle @examples_art'));
  // Only the copy's flat picture folder: every picture of the manifest, nothing else of the examples or the app.
  const pattern = new RegExp(/path_regexp examples_art (\S+)/.exec(open)[1]);
  const pictures = Object.keys(JSON.parse(readFileSync('apps/web/build/examples-manifest.json', 'utf8')).files).filter((name) => name.startsWith('art/'));
  assert.equal(pictures.length, 486);
  for (const name of pictures) assert.match(`/examples/${name}`, pattern);
  for (const path of ['/examples/index.html', '/examples/follow.js', '/examples/fonts/OFL.txt', '/examples/art/', '/examples/art/a/b.avif', '/art/stage-1600x400.avif', '/examples/artx.avif', '/assets/app-abcdefgh.js']) {
    assert.doesNotMatch(path, pattern, path);
  }
});
