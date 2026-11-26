/**
 * F161 (4), SH-ALPHA-SITE: the alpha-access suite's edge (playwright.alpha-access.config.ts). It serves a development
 * build of the site with the trade opt-in and the Privy stand-in (`SH_SEPOLIA_TRADE=1 SH_ALPHA_STANDIN=1`) the way the
 * test host serves a release with the alpha switch on: the site block of infra/server/app/config.mjs `renderSites`
 * (`alphaAccess`), its `(alpha_access)` snippet from infra/server/Caddyfile, and the release's own security headers
 * (`policyOf`: the test host's CSP with Privy's origins). Behind it runs the real alpha-api
 * (infra/server/services/alpha-api.mjs), one per test on a throwaway state folder (a test names its own with the
 * `edge_tenant` cookie), and the edge plays the outside parties the suite never reaches:
 * - Cloudflare Access on /desk: every /desk request gets a `Cf-Access-Jwt-Assertion` signed with a test team's key,
 *   whose certs URL alpha-api asks this edge for (never the network); the `edge_access=off` cookie plays a founder
 *   without an Access sign-in;
 * - X and Privy's token service for the stand-in (privy-standin.ts): `/__standin/privy/authorize` signs in the X
 *   account a test names in its `standin_x` cookie and comes back with Privy's three query parameters, and
 *   `/__standin/privy/token` gives identity tokens in Privy's shape (ES256, a throwaway key alpha-api is set up with);
 * - alpha-sender: `POST /__edge/receipt` writes the receipt a test asks for, in the sender's own format, and
 *   `GET /__edge/claims` reads the queue the sender would read. Both answer the test runner only (no browser request);
 *   so does `POST /__edge/identity-token`, the identity token Privy's service would give (privy-sdk.spec.mjs answers
 *   Privy's real SDK with it, on the probe page at /__probe/, which this edge serves with the release's headers).
 * The browser's own origin (http://127.0.0.1:<port>) stands for the test host's https one: a same-origin request
 * reaches alpha-api with the test host's Origin, as on the site, and the CSP names this origin where the site names
 * itself. Caddy's rate limits are not played. No key here is real, nothing leaves the machine, and the state folder
 * goes when the edge stops.
 */
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = resolve(WEB, '../..');
const PORT = Number(process.env.EDGE_PORT ?? 5546);
const DIST = resolve(WEB, process.env.EDGE_DIST ?? '.cache/alpha-access/dist');
/** The Privy probe (probe/vite.config.ts): the join page with Privy's real SDK, served at /__probe/ when built. */
const PROBE = resolve(WEB, process.env.EDGE_PROBE ?? '.cache/alpha-access/probe');
const EDGE_ORIGIN = `http://127.0.0.1:${PORT}`;
/** The test host alpha-api serves (alpha-api.env.example `SH_ALPHA_ORIGIN`); the claim text names it. */
const SITE_HOST = 'test-app.squarehole.fun';
const SITE_ORIGIN = `https://${SITE_HOST}`;
/** privy-config.ts `STANDIN_APP_ID`: the audience of the stand-in's identity tokens. */
const APP_ID = 'standinappid0000000000000';
const ACCESS_TEAM = 'https://edge-fixture.cloudflareaccess.com';
const ACCESS_AUDIENCE = 'edge-fixture-desk';
/** The Access identity the desk's decisions record (its `sub`). */
const FOUNDER = 'founder-edge-fixture';

const { createAlphaApi } = await import(pathToFileURL(join(ROOT, 'infra/server/services/alpha-api.mjs')).href);
const { EXAMPLES_ART_CACHE, policyOf } = await import(pathToFileURL(join(ROOT, 'infra/server/app/config.mjs')).href);

if (!existsSync(join(DIST, 'index.html')) || !existsSync(join(DIST, 'join/index.html')) || !existsSync(join(DIST, 'desk/index.html'))) {
  throw new Error(`the edge serves a build with the join and desk pages: none at ${DIST}`);
}

// The release's headers, with this origin where the test host's CSP names the test host.
const released = await policyOf(ROOT, { alphaAccess: true, testHost: SITE_HOST });
const SECURITY = Object.freeze({ ...released, 'Content-Security-Policy': released['Content-Security-Policy'].replaceAll(SITE_ORIGIN, EDGE_ORIGIN) });

// Throwaway keys for this run only: Privy's (the stand-in's identity tokens) and an Access team's (the desk).
const privy = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const access = generateKeyPairSync('rsa', { modulusLength: 2048 });
const accessKey = { ...access.publicKey.export({ format: 'jwk' }), kid: 'edge', alg: 'RS256', use: 'sig' };
const jwt = (header, payload, key) => {
  const input = [header, payload].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
const seconds = () => Math.floor(Date.now() / 1000);
const accessToken = () => jwt({ alg: 'RS256', kid: 'edge' }, { iss: ACCESS_TEAM, aud: [ACCESS_AUDIENCE], sub: FOUNDER, email: 'founder@example.org', type: 'app', iat: seconds(), exp: seconds() + 3600 }, access.privateKey);
/** An identity token as Privy shapes it (alpha/auth.mjs `privyVerifier`): one X account in `linked_accounts`. */
const identityToken = (account) => jwt({ alg: 'ES256', typ: 'JWT' }, {
  iss: 'privy.io', aud: APP_ID, sub: `did:privy:edge${createHash('sha256').update(account.xId).digest('hex').slice(0, 21)}`, sid: randomBytes(8).toString('hex'),
  iat: seconds(), exp: seconds() + 3600,
  linked_accounts: JSON.stringify([{ type: 'twitter_oauth', subject: account.xId, username: account.handle, name: account.name, profilePictureUrl: account.picture ?? null }]),
}, privy.privateKey);
// alpha-api reads the Access team's keys from its certs URL: this edge answers that one URL and refuses any other.
const accessFetch = async (url) => {
  if (String(url) !== `${ACCESS_TEAM}/cdn-cgi/access/certs`) throw new Error('the edge answers the Access team certs only');
  return new Response(JSON.stringify({ keys: [accessKey] }), { headers: { 'content-type': 'application/json' } });
};

mkdirSync(join(WEB, '.cache/alpha-access'), { recursive: true });
const STATE = mkdtempSync(join(WEB, '.cache/alpha-access/state-'));
const tenants = new Map();
function tenantOf(name) {
  let tenant = tenants.get(name);
  if (tenant) return tenant;
  const root = join(STATE, name);
  for (const part of ['state', 'queue', 'receipts']) mkdirSync(join(root, part), { recursive: true });
  const folders = { dbPath: join(root, 'state/alpha.sqlite'), queueDir: join(root, 'queue'), receiptsDir: join(root, 'receipts') };
  const api = createAlphaApi({
    origin: SITE_ORIGIN, privyAppId: APP_ID, privyPublicKey: privy.publicKey.export({ type: 'spki', format: 'pem' }), cookieKey: randomBytes(32),
    accessIssuer: ACCESS_TEAM, accessAudience: ACCESS_AUDIENCE, ...folders,
  }, { fetch: accessFetch });
  tenant = { name, api, ...folders };
  tenants.set(name, tenant);
  return tenant;
}

// The stand-in's X sign-ins: a one-time code per trip, and the accounts signed in (for a renewed token).
const codes = new Map();
const signedIn = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.webmanifest': 'application/manifest+json',
  '.xml': 'text/xml; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ktx2': 'image/ktx2',
};

const cookiesOf = (header = '') => {
  const found = {};
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) found[part.slice(0, at).trim()] ??= part.slice(at + 1).trim();
  }
  return found;
};
const TENANT = /^[a-z0-9-]{1,40}$/;

function respond(outgoing, status, headers = {}, body = '') {
  outgoing.writeHead(status, { ...SECURITY, ...headers });
  outgoing.end(body);
}
const json = (outgoing, status, value) => respond(outgoing, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(value));
const notFound = (outgoing) => respond(outgoing, 404, { 'cache-control': 'no-store' });

/** The file a path names under the build (a folder path ending in `/` names its index.html), or null. */
function fileAt(path, root = DIST) {
  if (path.includes('\0')) return null;
  const file = resolve(root, `.${path}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) return null;
  try {
    const stat = statSync(file);
    if (stat.isFile()) return file;
    if (stat.isDirectory() && path.endsWith('/') && statSync(join(file, 'index.html')).isFile()) return join(file, 'index.html');
  } catch { /* missing */ }
  return null;
}
function serveFile(incoming, outgoing, file, cache = 'no-store') {
  const body = readFileSync(file);
  respond(outgoing, 200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': String(body.length), 'cache-control': cache },
    incoming.method === 'HEAD' ? '' : body);
}

/** The request as alpha-api sees it behind Caddy: the test host's URL, and its Origin where the browser named this edge. */
function apiRequest(incoming, path, { method = incoming.method, body, desk = false, cookies } = {}) {
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
  if (headers.get('origin') === EDGE_ORIGIN) headers.set('origin', SITE_ORIGIN);
  headers.delete('cf-access-jwt-assertion');
  if (desk && cookies.edge_access !== 'off') headers.set('cf-access-jwt-assertion', accessToken());
  return new Request(`${SITE_ORIGIN}${path}`, { method, headers, ...(body !== undefined && !['GET', 'HEAD'].includes(method) ? { body } : {}) });
}
async function relay(outgoing, response, extra = {}) {
  const headers = { ...extra };
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  respond(outgoing, response.status, headers, Buffer.from(await response.arrayBuffer()));
}

async function bodyOf(incoming) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > 16384) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const accountOf = (value) => {
  try {
    const account = JSON.parse(Buffer.from(value ?? '', 'base64url').toString('utf8'));
    return typeof account?.xId === 'string' && typeof account.handle === 'string' && typeof account.name === 'string' ? account : null;
  } catch { return null; }
};

/** Privy and X for the stand-in (privy-standin.ts). */
async function standin(incoming, outgoing, url, cookies, body) {
  if (url.pathname === '/__standin/privy/config' && incoming.method === 'GET') return json(outgoing, 200, { chainId: 11155111 });
  if (url.pathname === '/__standin/privy/authorize' && incoming.method === 'GET') {
    let back;
    try { back = new URL(url.searchParams.get('return') ?? ''); } catch { return json(outgoing, 400, { error: 'return address required' }); }
    if (back.origin !== EDGE_ORIGIN) return json(outgoing, 400, { error: 'return to this site only' });
    const account = accountOf(cookies.standin_x);
    if (!account) return json(outgoing, 400, { error: 'name the X account in the standin_x cookie' });
    const code = randomBytes(16).toString('hex');
    codes.set(code, account);
    back.searchParams.set('privy_oauth_code', code);
    back.searchParams.set('privy_oauth_state', randomBytes(8).toString('hex'));
    back.searchParams.set('privy_oauth_provider', 'twitter');
    return respond(outgoing, 302, { location: back.href, 'cache-control': 'no-store' });
  }
  if (url.pathname === '/__standin/privy/token' && incoming.method === 'POST') {
    let input;
    try { input = JSON.parse(body?.toString('utf8') || '{}'); } catch { return json(outgoing, 400, { error: 'JSON required' }); }
    let account = null;
    if (typeof input.code === 'string') { account = codes.get(input.code) ?? null; codes.delete(input.code); }
    else if (typeof input.account === 'string') account = signedIn.get(input.account) ?? null;
    if (!account) return json(outgoing, 401, { error: 'not signed in' });
    signedIn.set(account.xId, account);
    return json(outgoing, 200, { token: identityToken(account), account: account.xId });
  }
  return json(outgoing, 404, { error: 'not found' });
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = () => `0x${randomBytes(32).toString('hex')}`;
/** The test runner's controls: the sender's receipts and queue, and a sign-up made the way the join page makes one. */
async function control(incoming, outgoing, url, tenant, body) {
  if (incoming.headers['sec-fetch-site'] !== undefined || incoming.headers.origin !== undefined) return json(outgoing, 403, { error: 'the test runner only' });
  let input;
  try { input = JSON.parse(body?.toString('utf8') || '{}'); } catch { return json(outgoing, 400, { error: 'JSON required' }); }
  if (url.pathname === '/__edge/claims' && incoming.method === 'GET') {
    const claims = readdirSync(tenant.queueDir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(tenant.queueDir, name), 'utf8')));
    return json(outgoing, 200, { claims });
  }
  if (url.pathname === '/__edge/receipt' && incoming.method === 'POST') {
    const { id, status } = input;
    if (typeof id !== 'string' || !UUID.test(id) || !existsSync(join(tenant.queueDir, `${id}.json`))) return json(outgoing, 404, { error: 'no such queued claim' });
    const receipts = {
      sent: { admitTx: hash(), sendTx: hash(), reason: null },
      'dry-run': { admitTx: null, sendTx: null, reason: 'dry run; no transactions', status: 'skipped' },
      refused: { admitTx: null, sendTx: null, reason: 'not eligible' },
      failed: { admitTx: hash(), sendTx: null, reason: 'send failed' },
    };
    const outcome = receipts[status];
    if (!outcome) return json(outgoing, 400, { error: 'status: sent, dry-run, refused or failed' });
    const receipt = { v: 1, id, status: outcome.status ?? status, admitTx: outcome.admitTx, sendTx: outcome.sendTx, reason: outcome.reason, at: new Date().toISOString() };
    const temporary = join(tenant.receiptsDir, `.${id}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`);
    renameSync(temporary, join(tenant.receiptsDir, `${id}.json`));
    return json(outgoing, 200, receipt);
  }
  if (url.pathname === '/__edge/identity-token' && incoming.method === 'POST') {
    const account = { xId: input.xId, handle: input.handle, name: input.name, picture: input.picture ?? null };
    if (typeof account.xId !== 'string' || typeof account.handle !== 'string' || typeof account.name !== 'string') return json(outgoing, 400, { error: 'xId, handle and name' });
    return json(outgoing, 200, { token: identityToken(account) });
  }
  if (url.pathname === '/__edge/signup' && incoming.method === 'POST') {
    const account = { xId: input.xId, handle: input.handle, name: input.name, picture: input.picture ?? null };
    const response = await tenant.api.handle(new Request(`${SITE_ORIGIN}/alpha/session`, { method: 'POST', headers: { origin: SITE_ORIGIN, 'privy-id-token': identityToken(account) } }));
    return json(outgoing, response.status, await response.json());
  }
  return json(outgoing, 404, { error: 'not found' });
}

const JOIN_CANONICAL = /^\/join(\/?|\/index[.]html|\/assets\/[A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*)([?].*)?$/;
const PRIVATE = /(^|\/)\.[^/]*|\.map$|^\/_(headers|redirects|routes\.json)$/;
const HASHED = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const EXTENSION = /\.[^/]+$|^\/assets(\/|$)/;
/** SH-252: the examples' pictures (renderSites `@examples_art`). */
const EXAMPLES_ART = /^\/examples\/art\/[A-Za-z0-9_.-]+$/;

async function handle(incoming, outgoing) {
  const raw = incoming.url ?? '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return respond(outgoing, 400);
  const url = new URL(raw, EDGE_ORIGIN);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return respond(outgoing, 400); }
  const cookies = cookiesOf(incoming.headers.cookie);
  const tenant = tenantOf(TENANT.test(cookies.edge_tenant ?? '') ? cookies.edge_tenant : 'default');
  const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : await bodyOf(incoming);
  if (body === null) return respond(outgoing, 413);

  if (path.startsWith('/__edge/')) return control(incoming, outgoing, url, tenant, body);
  if (path.startsWith('/__standin/privy/')) return standin(incoming, outgoing, url, cookies, body);
  if (path === '/__probe' || path.startsWith('/__probe/')) {
    if (!['GET', 'HEAD'].includes(incoming.method)) return respond(outgoing, 405, { 'cache-control': 'no-store' }, 'read-only');
    const inner = path.slice('/__probe'.length) || '/';
    const file = fileAt(inner, PROBE) ?? (EXTENSION.test(inner) ? null : fileAt('/index.html', PROBE));
    return file ? serveFile(incoming, outgoing, file) : notFound(outgoing);
  }

  // (alpha_access): the API, the desk's API, the desk behind Access, the public join files, then the page lock.
  if (path === '/alpha' || path.startsWith('/alpha/')) return relay(outgoing, await tenant.api.handle(apiRequest(incoming, raw, { body })), { 'cache-control': 'no-store' });
  if (path.startsWith('/desk/api/')) return relay(outgoing, await tenant.api.handle(apiRequest(incoming, raw, { body, desk: true, cookies })), { 'cache-control': 'no-store' });
  if (path === '/desk' || path.startsWith('/desk/')) {
    const check = await tenant.api.handle(apiRequest(incoming, '/desk/api/check', { method: 'GET', desk: true, cookies }));
    if (!check.ok) return relay(outgoing, check, { 'cache-control': 'no-store' });
    if (!['GET', 'HEAD'].includes(incoming.method)) return respond(outgoing, 405, { 'cache-control': 'no-store' }, 'read-only');
    const file = fileAt(path) ?? fileAt('/desk/index.html');
    return file ? serveFile(incoming, outgoing, file) : notFound(outgoing);
  }
  if ((['/join', '/join/', '/join/index.html'].includes(path) || path.startsWith('/join/assets/')) && JOIN_CANONICAL.test(raw)) {
    if (!['GET', 'HEAD'].includes(incoming.method)) return respond(outgoing, 405, { 'cache-control': 'no-store' }, 'read-only');
    const file = fileAt(path === '/join' || path === '/join/' ? '/join/index.html' : path);
    return file ? serveFile(incoming, outgoing, file) : notFound(outgoing);
  }
  const check = await tenant.api.handle(apiRequest(incoming, '/alpha/check', { method: 'GET' }));
  if (check.status === 401) return respond(outgoing, 303, { location: '/join', 'cache-control': 'no-store' });
  if (!check.ok) return relay(outgoing, check);

  // The release's site block (config.mjs `renderSites`), behind the lock.
  if (!['GET', 'HEAD'].includes(incoming.method)) return respond(outgoing, 405, { 'cache-control': 'no-store' }, 'read-only');
  if (PRIVATE.test(path)) return notFound(outgoing);
  if (HASHED.test(path) && fileAt(path)) return serveFile(incoming, outgoing, fileAt(path), 'private, no-store');
  if (EXAMPLES_ART.test(path) && fileAt(path)) return serveFile(incoming, outgoing, fileAt(path), EXAMPLES_ART_CACHE.locked);
  if (EXTENSION.test(path)) {
    const file = fileAt(path);
    return file ? serveFile(incoming, outgoing, file) : notFound(outgoing);
  }
  const file = fileAt(path) ?? fileAt('/index.html');
  return file ? serveFile(incoming, outgoing, file) : notFound(outgoing);
}

const server = createServer((incoming, outgoing) => {
  handle(incoming, outgoing).catch((error) => {
    process.stderr.write(`edge: ${error instanceof Error ? error.message : String(error)}\n`);
    if (!outgoing.headersSent) respond(outgoing, 500, { 'cache-control': 'no-store' });
    else outgoing.end();
  });
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`alpha-access edge on ${EDGE_ORIGIN} (alpha-api as ${SITE_ORIGIN}; build ${DIST})\n`));

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  for (const tenant of tenants.values()) tenant.api.close();
  rmSync(STATE, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
