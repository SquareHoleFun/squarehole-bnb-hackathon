import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configOf, renderSites, requireAlphaEntries } from './config.mjs';
import { publicFiles, sha256 } from './build.mjs';
import { requireTools } from './tools.mjs';

function artifactOf(directory) {
  try {
    const release = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
    const { id, ...content } = release;
    const config = configOf(`SH_APP_MAIN_HOST=${release.mainHost}\nSH_APP_TEST_HOST=${release.testHost}`, 'sepolia');
    if (release.chain !== config.chain || release.format !== 'squarehole.app-release/1' || !/^[a-f0-9]{40}$/.test(release.commit) || sha256(JSON.stringify(content)) !== id) throw new Error();
    const files = publicFiles(join(directory, 'public'));
    if (!files['index.html'] || Object.keys(files).length !== Object.keys(release.files).length || Object.entries(files).some(([name, hash]) => release.files[name] !== hash)) throw new Error();
    requireAlphaEntries(release, files);
    const sites = renderSites(release);
    if (readFileSync(join(directory, 'app.site.caddy'), 'utf8') !== sites.site || readFileSync(join(directory, 'app.cors.caddy'), 'utf8') !== sites.cors) throw new Error();
    return release;
  } catch { throw new Error('smoke-app: invalid or corrupted expected artifact'); }
}

// SH_ACCESS_HEADERS names a private header file: Access service-token headers while Access guards the host;
// after the alpha switch, an approved __Host-alpha_session Cookie header. Curl reads it; never print the contents.
export function curlRequest(url, origin, access = false) {
  requireTools('curl');
  mkdirSync('.cache/tmp', { recursive: true });
  const work = mkdtempSync(resolve('.cache/tmp/app-response-'));
  // -q first: no ~/.curlrc, so no ambient redirect following (custom headers cross hosts on a redirect) or tracing.
  const args = ['-q', '--silent', '--show-error', '--path-as-is', '--proto', '=https', '--max-time', '20', '--retry', '2', '--header', 'Cache-Control: no-cache', '--dump-header', join(work, 'headers'), '--output', join(work, 'body'), '--write-out', '%{http_code}'];
  if (origin) args.push('--header', `Origin: ${origin}`);
  if (access && process.env.SH_ACCESS_HEADERS) args.push('--header', `@${process.env.SH_ACCESS_HEADERS}`);
  args.push(url);
  // The response is read into memory and its files removed on every path: a response could reflect the token.
  try {
    const status = execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let headers = {};
    for (const line of readFileSync(join(work, 'headers'), 'utf8').split(/\r?\n/)) {
      if (line.startsWith('HTTP/')) headers = {};
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { status: Number(status), headers, body: readFileSync(join(work, 'body')) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function smoke(directory, { request = curlRequest, dryRun = false } = {}) {
  const release = artifactOf(directory);
  if (dryRun) return release;
  const origin = `https://${release.testHost}`;
  const nonce = `${Date.now()}-${process.pid}`;
  const fetch = async (url, requestOrigin, access = false) => {
    const target = new URL(url);
    target.searchParams.set('sh-app-check', nonce);
    try { return await request(target.href, requestOrigin, access); }
    catch { throw new Error('smoke-app: request failed'); }
  };
  const check = async (path, file, status, cache, authenticated = true) => {
    const response = await fetch(`${origin}${path}`, undefined, authenticated);
    if (/\.cloudflareaccess\.com\//.test(response.headers.location ?? '')) throw new Error('smoke-app: Cloudflare Access answered; set SH_ACCESS_HEADERS to the service token header file');
    if (response.status !== status) throw new Error(`smoke-app: unexpected status for ${path}`);
    for (const [name, value] of Object.entries({ ...release.headers, 'X-Sh-App-Release': release.id, 'Cache-Control': cache })) {
      if (response.headers[name.toLowerCase()] !== value) throw new Error(`smoke-app: incorrect ${name} for ${path}`);
    }
    const bytes = file ? readFileSync(join(directory, 'public', file)) : Buffer.alloc(0);
    if (!bytes.equals(response.body)) throw new Error(`smoke-app: release bytes differ for ${path}`);
  };
  if (release.alphaAccess === true) {
    for (const path of ['/', '/index.html', '/create', '/assets/__anonymous.js']) {
      const response = await fetch(`${origin}${path}`);
      if (response.status !== 303 || response.headers.location !== '/join' || response.headers['cache-control'] !== 'no-store') throw new Error('smoke-app: anonymous page gate failed');
    }
    for (const authenticated of [false, true]) {
      const response = await fetch(`${origin}/alpha/check`, undefined, authenticated);
      if (response.status !== (authenticated ? 200 : 401) || response.headers['cache-control'] !== 'no-store') throw new Error('smoke-app: alpha session check failed; provide an approved cookie in SH_ACCESS_HEADERS');
    }
    await check('/join', 'join/index.html', 200, 'no-store', false);
    for (const file of Object.keys(release.files).filter(name => name.startsWith('join/assets/'))) await check(`/${file}`, file, 200, 'no-store', false);
  }
  for (const path of ['/', '/index.html', '/create', '/__app_route_check']) await check(path, 'index.html', 200, 'no-store');
  for (const extension of ['js', 'css']) {
    const file = Object.keys(release.files).find((name) => new RegExp(`^assets/[^/]+-[A-Za-z0-9_-]{8,}\\.${extension}$`).test(name));
    if (!file) throw new Error('smoke-app: release lacks fingerprinted JS/CSS');
    await check(`/${file}`, file, 200, release.alphaAccess === true ? 'private, no-store' : 'public, max-age=31536000, immutable');
  }
  for (const path of ['/assets/__missing.js', '/_headers', '/assets/__missing.js.map']) await check(path, null, 404, 'no-store');
  for (const supplied of [origin, 'https://unapproved.invalid']) {
    const response = await fetch('https://api.squarehole.fun/healthz', supplied);
    const expected = supplied === origin ? origin : undefined;
    if (response.status !== 200 || response.headers['access-control-allow-origin'] !== expected || !response.headers.vary?.toLowerCase().split(/,\s*/).includes('origin')) throw new Error('smoke-app: API health/CORS failed');
    // Health can be green with the API route missing (or an undeployed placeholder). Require the app's v2 API.
    const v2 = await fetch(`https://api.squarehole.fun/v2/feed?chain=${release.chain}`, supplied);
    if (v2.status !== 200 || v2.headers['access-control-allow-origin'] !== expected || !v2.headers.vary?.toLowerCase().split(/,\s*/).includes('origin')) throw new Error('smoke-app: v2 feed status/CORS failed');
    try {
      const feed = JSON.parse(v2.body.toString('utf8'));
      if (!/^application\/json(?:\s*;|$)/i.test(v2.headers['content-type'] ?? '') || feed?.schema !== 'sh.core-feed.v2' || feed.chainId !== Number(release.chain) || !Array.isArray(feed.cards)) throw new Error();
    } catch { throw new Error('smoke-app: v2 feed must be JSON for the release chain'); }
  }
  return release;
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  try {
    requireTools('curl');
    const [directory, mode] = process.argv.slice(2);
    if (!directory || (mode && mode !== '--dry-run') || process.argv.length > 4) throw new Error('smoke-app: usage <expected artifact directory> [--dry-run]');
    const result = await smoke(directory, { dryRun: mode === '--dry-run' });
    process.stdout.write(`smoke-app: ${mode ? 'dry run; local artifact verified' : 'release, routes, assets, headers, v2 feed and CORS passed'}; ${result.commit}\n`);
  } catch (error) {
    const message = error.message.startsWith('missing tool:') ? `smoke-app: ${error.message}` : error.message;
    process.stderr.write(`${message.startsWith('smoke-app:') ? message : 'smoke-app: check failed'}\n`);
    process.exitCode = 1;
  }
}
