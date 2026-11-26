import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const reserved = new Set(['squarehole.fun', 'www.squarehole.fun', 'squarehole.xyz', 'www.squarehole.xyz', 'squarehole.fit', 'www.squarehole.fit', 'api.squarehole.fun', 'alpha.squarehole.fun']);
const dns = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Parse data, never source a shell file. Diagnostics deliberately do not repeat supplied values.
export function configOf(text, target) {
  if (target !== 'sepolia') throw new Error('G08: only the separate Sepolia app may ship; mainnet remains refused');
  const values = { SH_APP_MAIN_HOST: 'app.squarehole.fun', SH_APP_TEST_HOST: 'test-app.squarehole.fun' };
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(SH_APP_MAIN_HOST|SH_APP_TEST_HOST|SH_APP_ALPHA_ACCESS)=([^\s]+)$/.exec(line);
    if (!match || seen.has(match[1]) || (match[1] === 'SH_APP_ALPHA_ACCESS' ? !['0', '1'].includes(match[2]) : !dns.test(match[2]) || reserved.has(match[2]))) throw new Error('Invalid or duplicate public app host setting');
    seen.add(match[1]);
    values[match[1]] = match[2];
  }
  if (values.SH_APP_MAIN_HOST === values.SH_APP_TEST_HOST) throw new Error('Main and test app hosts must differ');
  return { mainHost: values.SH_APP_MAIN_HOST, testHost: values.SH_APP_TEST_HOST, chain: '11155111', ...(values.SH_APP_ALPHA_ACCESS === '1' ? { alphaAccess: true } : {}) };
}

export async function policyOf(root, config = {}) {
  const { SITE_CSP_ORIGINS } = await import(pathToFileURL(resolve(root, 'apps/web/src/share/share-headers.ts')).href);
  const { SEPOLIA_PUBLIC_RPC_URLS } = await import(pathToFileURL(resolve(root, 'packages/chain/src/config/networks.ts')).href);
  const rpc = [...new Set(SEPOLIA_PUBLIC_RPC_URLS.map((value) => new URL(value).origin))];
  if (JSON.stringify(rpc) !== JSON.stringify(SITE_CSP_ORIGINS.rpc) || JSON.stringify(SITE_CSP_ORIGINS.api) !== '["https://api.squarehole.fun"]' || SITE_CSP_ORIGINS.art.length) {
    throw new Error('Site RPC/API policy changed: review app hosting before shipping');
  }
  // SH-ARWEAVE-PICTURES-WEB: Turbo's upload origin and the three Arweave gateways, for connections only (box pictures).
  const pictures = SITE_CSP_ORIGINS.pictures ?? [];
  if (JSON.stringify(pictures) !== '["https://upload.ardrive.io","https://turbo-gateway.com","https://arweave.net","https://goldsky.arweave.net"]') {
    throw new Error('Site picture origins changed: review app hosting before shipping');
  }
  for (const origin of rpc) if (new URL(origin).protocol !== 'https:' || !dns.test(new URL(origin).hostname)) throw new Error('Invalid site RPC origin');
  const landing = readFileSync(resolve(root, 'infra/server/Caddyfile'), 'utf8').split('(landing_headers) {')[1]?.split('\n}')[0];
  if (!landing) throw new Error('Landing security policy missing');
  const headers = Object.fromEntries([...landing.matchAll(/^\s*([\w-]+) "([^"\n]+)"$/gm)].map((match) => [match[1], match[2]]));
  if (Object.keys(headers).length !== 7) throw new Error('Landing security policy changed: review app hosting');
  headers['Content-Security-Policy'] = [
    "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://api.squarehole.fun", "font-src 'self' data:",
    `connect-src https://api.squarehole.fun ${rpc.join(' ')} ${pictures.join(' ')}`, "worker-src 'self' blob:",
    "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');
  if (config.alphaAccess === true) {
    if (!dns.test(config.testHost)) throw new Error('Invalid alpha origin');
    headers['Content-Security-Policy'] = headers['Content-Security-Policy']
      .replace('connect-src ', `connect-src https://${config.testHost} https://auth.privy.io https://*.rpc.privy.systems `)
      + '; frame-src https://auth.privy.io; child-src https://auth.privy.io';
  }
  return headers;
}

// Public join assets must not expose the authenticated app entry. Desk assets have their own Access path.
export function requireAlphaEntries(config, files) {
  if (config.alphaAccess !== true) return;
  for (const entry of ['join', 'desk']) {
    if (!files[`${entry}/index.html`] || !Object.keys(files).some(name => name.startsWith(`${entry}/assets/`) && name.endsWith('.js'))) {
      throw new Error('Alpha access requires separate join and desk entries with dedicated assets');
    }
  }
}

/**
 * SH-252: how long a browser keeps a picture of the examples (apps/web/public/examples/art, the explainer's art; a
 * release never changes one). Open site: any cache, as the landing keeps its own art. Behind the alpha lock: the
 * visitor's own browser only (`private`: never Cloudflare's or another shared cache, so every request that leaves the
 * browser still meets the lock); a tester whose access ends keeps the pictures already seen for at most a day. A day,
 * not longer: a later copy of the explainer may change a picture under the same name.
 */
export const EXAMPLES_ART_CACHE = Object.freeze({ open: 'public, max-age=86400', locked: 'private, max-age=86400' });

export function renderSites(release) {
  const { mainHost, testHost, id, headers } = release;
  const security = Object.entries(headers).map(([name, value]) => `\t\t${name} "${value}"`).join('\n');
  const site = `# Generated from the checked app release; contains public data only.
http://${mainHost}, https://${mainHost} {
\timport landing_headers
\theader Cache-Control no-store
\trespond "Mainnet app unavailable (G08)" 503
}

(app_security) {
\theader {
${security}
\t\tX-Sh-App-Release "${id}"
\t}
}

http://${testHost}, https://${testHost} {
\troot * /srv/app/releases/${id}/public
\timport app_security
\t@write not method GET HEAD
\thandle @write {
\t\theader Cache-Control no-store
\t\trespond "read-only" 405
\t}
\t@private path_regexp private (^|/)\\.[^/]*|\\.map$|^/_(headers|redirects|routes\\.json)$
\thandle @private {
\t\terror 404
\t}
\t# Only existing fingerprinted files receive an immutable response. Old hashes stay in the asset pool.
\t@immutable {
\t\tpath_regexp hashed ^/assets/[^/]+-[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9]+$
\t\tfile {
\t\t\troot /srv/app/immutable
\t\t\ttry_files {path}
\t\t}
\t}
\thandle @immutable {
\t\troot * /srv/app/immutable
\t\theader Cache-Control "public, max-age=31536000, immutable"
\t\tfile_server
\t}
\t# SH-252: the examples' pictures never change within a release: kept a day in the browser, not fetched on every visit.
\t@examples_art {
\t\tpath_regexp examples_art ^/examples/art/[A-Za-z0-9_.-]+$
\t\tfile
\t}
\thandle @examples_art {
\t\theader Cache-Control "${EXAMPLES_ART_CACHE.open}"
\t\tfile_server
\t}
\t# Missing scripts/images must not receive index.html or an immutable 404.
\t@file path_regexp extension \\.[^/]+$|^/assets(/|$)
\thandle @file {
\t\theader Cache-Control no-store
\t\tfile_server
\t}
\thandle {
\t\theader Cache-Control no-store
\t\ttry_files {path} /index.html
\t\tfile_server
\t}
\thandle_errors 404 {
\t\timport app_security
\t\theader Cache-Control no-store
\t\trespond "" 404
\t}
}
`;
  const cors = `# Exact active test origin only; no wildcard or mainnet permission.
@app_origin header Origin https://${testHost}
header @app_origin {
\tAccess-Control-Allow-Origin {http.request.header.Origin}
\tAccess-Control-Allow-Headers If-None-Match
\tAccess-Control-Max-Age 600
}
`;
  if (release.alphaAccess !== undefined && release.alphaAccess !== true) throw new Error('Invalid alpha release switch');
  if (release.alphaAccess === true) {
    // A route preserves this order: public join/API, Access desk, session check, then the existing static handlers.
    // Protected assets cannot escape a later removal through a shared/public cache.
    const guarded = site.replace('\t@write not method GET HEAD', '\troute {\n\timport alpha_access\n\t@write not method GET HEAD')
      .replace('\thandle_errors 404 {', '\t}\n\thandle_errors 404 {')
      .replace('public, max-age=31536000, immutable', 'private, no-store')
      .replace(`Cache-Control "${EXAMPLES_ART_CACHE.open}"`, `Cache-Control "${EXAMPLES_ART_CACHE.locked}"`);
    return { site: guarded, cors };
  }
  return { site, cors };
}
