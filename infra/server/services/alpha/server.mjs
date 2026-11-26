import { constants, openSync, fstatSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { need } from './auth.mjs';

const BASE = '/srv/squarehole/alpha';
const HEALTH = '/tmp/alpha-health.json';
const unfinishedForget = 'a forget run is unfinished: run it again';
function dropPrivileges() {
  need(process.getuid() === 0, 500);
  process.setgroups([2103]); process.setgid(2101); process.setuid(2101);
}
export function cookieFileAllowed(stat) { return stat.isFile() && stat.uid === 0 && (stat.mode & 0o777) === 0o600 && stat.size >= 64 && stat.size <= 65; }
export function readCookieKey(path, allowed = cookieFileAllowed) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    need(allowed(fstatSync(fd)), 500); const value = readFileSync(fd, 'utf8');
    need(/^[0-9a-fA-F]{64}\n?$/.test(value), 500); return Buffer.from(value.trim(), 'hex');
  } finally { closeSync(fd); }
}
export function loadConfig(env) {
  need(['0', '1'].includes(env.SH_ALPHA_ENABLED ?? '0'), 500);
  if (env.SH_ALPHA_ENABLED !== '1') return { enabled: false };
  const origin = env.SH_ALPHA_ORIGIN;
  need(typeof origin === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(origin) && new URL(origin).origin === origin, 500);
  need(typeof env.SH_ALPHA_PRIVY_APP_ID === 'string' && env.SH_ALPHA_PRIVY_APP_ID.length > 0, 500);
  // Every key of the Privy app's JWKS, PEMs on one line; createAlphaApi refuses an empty or bad set (auth.mjs privyKeys).
  need(typeof env.SH_ALPHA_PRIVY_VERIFICATION_KEY === 'string', 500);
  need(env.SH_ALPHA_COOKIE_KEY_FILE === '/run/alpha-config/cookie.key', 500);
  // SH-275: SH_ALPHA_AUTO_APPROVE=1 (a new sign-up approved at once, no desk) only together with chain 97; that
  // deployment has no Access team. Without both settings: Sepolia and its desk, as before.
  const chainId = env.SH_ALPHA_CHAIN_ID ?? '11155111', autoApprove = env.SH_ALPHA_AUTO_APPROVE ?? '0';
  need(['11155111', '97'].includes(chainId) && ['0', '1'].includes(autoApprove) && (autoApprove === '0' || chainId === '97'), 500);
  if (autoApprove === '0') need(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.SH_ALPHA_ACCESS_TEAM) && typeof env.SH_ALPHA_ACCESS_AUD === 'string' && env.SH_ALPHA_ACCESS_AUD.length > 0, 500);
  const signupCap = env.SH_ALPHA_SIGNUP_CAP ?? '100';
  need(/^[1-9][0-9]{0,8}$/.test(signupCap) && ['0', '1'].includes(env.SH_ALPHA_SIGNUPS_CLOSED ?? '0'), 500);
  return { enabled: true, chainId: Number(chainId), autoApprove: autoApprove === '1', signupCap: Number(signupCap), signupsClosed: env.SH_ALPHA_SIGNUPS_CLOSED === '1', origin, privyAppId: env.SH_ALPHA_PRIVY_APP_ID,
    privyPublicKey: env.SH_ALPHA_PRIVY_VERIFICATION_KEY.replaceAll('\\n', '\n'), cookieKeyFile: env.SH_ALPHA_COOKIE_KEY_FILE,
    accessIssuer: env.SH_ALPHA_ACCESS_TEAM, accessAudience: env.SH_ALPHA_ACCESS_AUD,
    dbPath: `${BASE}/state/alpha.sqlite`, queueDir: `${BASE}/queue`, receiptsDir: `${BASE}/receipts` };
}
export function httpHandler(api, origin) {
  return async (incoming, outgoing) => {
    try {
      need(incoming.url.startsWith('/') && !incoming.url.startsWith('//'), 400);
      need(!incoming.headers['content-length'] || (/^[0-9]+$/.test(incoming.headers['content-length']) && BigInt(incoming.headers['content-length']) <= 16384n), 413);
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const request = new Request(`${origin}${incoming.url}`, { method: incoming.method, headers,
        ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      const response = await api.handle(request);
      const responseHeaders = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 1) responseHeaders['set-cookie'] = cookies;
      outgoing.writeHead(response.status, responseHeaders); outgoing.end(await response.text());
    } catch (error) {
      outgoing.writeHead(error.status ?? 503, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
      outgoing.end('{"error":"request refused"}');
    }
  };
}
export async function start(createApi) {
  let api, server, timer;
  try {
    const [action, expected, ...extra] = process.argv.slice(2);
    need(!extra.length && [undefined, '--healthcheck', '--dry-run'].includes(action)
      && (expected === undefined || (action === '--healthcheck' && ['ready', 'disabled'].includes(expected))), 500);
    if (action === '--dry-run') { process.stdout.write('alpha-api: offline plan; no files, credentials, state or network accessed\n'); return; }
    const config = loadConfig(process.env);
    if (action === '--healthcheck') {
      // Compose probes start as root without DAC override; read as the heartbeat's owner.
      dropPrivileges();
      const health = JSON.parse(readFileSync(HEALTH, 'utf8'));
      need(health.enabled === config.enabled && health.at <= Date.now() && Date.now() - health.at < 90000
        && (!expected || expected === (config.enabled ? 'ready' : 'disabled')), 500);
      process.stdout.write(`alpha-api: ${config.enabled ? 'ready' : 'disabled'}\n`); return;
    }
    process.umask(0o027);
    if (config.enabled) config.cookieKey = readCookieKey(config.cookieKeyFile);
    // The entrypoint reads just the root-only HMAC file, then permanently drops root before opening state/listening.
    dropPrivileges();
    if (config.enabled) {
      api = createApi(config);
      server = createServer({ maxHeaderSize: 24576, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, httpHandler(api, config.origin));
      server.maxRequestsPerSocket = 100;
      server.setTimeout(15000, socket => socket.destroy());
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5396, '0.0.0.0', resolve); });
    }
    const heartbeat = () => {
      if (api) {
        // A failed read stops publication; the central monitor sees the last snapshot go stale.
        try {
          const path = `${BASE}/state/monitor.json`;
          writeFileSync(`${path}.new`, JSON.stringify(api.monitor()), { mode: 0o640 }); renameSync(`${path}.new`, path);
        } catch { /* never publish a false healthy snapshot */ }
      }
      writeFileSync(`${HEALTH}.new`, JSON.stringify({ enabled: config.enabled, at: Date.now() }), { mode: 0o600 }); renameSync(`${HEALTH}.new`, HEALTH); };
    heartbeat(); timer = setInterval(heartbeat, 30000);
    const stop = () => {
      clearInterval(timer);
      if (server) { server.close(() => { api.close(); process.exit(0); }); setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref(); }
      else process.exit(0);
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    process.stdout.write(`alpha-api: ${config.enabled ? 'ready' : 'disabled'}\n`);
  } catch (error) {
    clearInterval(timer); server?.close(); api?.close();
    if (error.message === unfinishedForget) process.stderr.write(`${unfinishedForget}\n`);
    process.stderr.write('alpha-api refused; check operator settings and mounted files; details suppressed\n'); process.exitCode = 1;
  }
}
