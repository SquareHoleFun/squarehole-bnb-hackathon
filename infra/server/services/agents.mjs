import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { publishHealth, HEALTH_FILE, runLoop, CYCLE_TIMEOUT_MS, STOP_BUDGET_MS } from './runtime.mjs';
import { requireThat, usd, validateConfig, SEPOLIA } from './agents/policy.mjs';
import { readBounded, writeAtomic } from './agents/store.mjs';
import { createAgents } from './agents/engine.mjs';
import { createChain, privateKeyToAccount } from './agents/chain.mjs';
import { messagesClient } from './agents/model.mjs';

export function agentSettings(env) {
  const enabled = env.SH_SERVICE_ENABLED ?? '0', mode = env.SH_SERVICE_MODE ?? 'dry-run';
  const dailyBudgetUsd = env.SH_AGENTS_DAILY_BUDGET_USD ?? '2';
  requireThat(['0', '1'].includes(enabled) && ['dry-run', 'live'].includes(mode)
    && (env.SH_AGENTS_CHAIN_ID ?? '11155111') === '11155111' && (env.SH_SERVICE_ALLOW_MAINNET ?? '0') === '0'
    && ['ANTHROPIC_API_KEY', 'SH_AGENTS_PRIVATE_KEY', 'SH_KEEPER_PRIVATE_KEY', 'SH_KEEPER_PRIVATE_SEND_KEY'].every(k => env[k] === undefined)
    && usd(dailyBudgetUsd) > 0n, 'agents settings refused');
  return { service: 'agents', enabled: enabled === '1', mode, dailyBudgetUsd, interval: 3600000 };
}
export function readSecret(file, kind) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = fstatSync(fd);
    requireThat(s.isFile() && s.uid === 0 && s.gid === 0 && (s.mode & 0o777) === 0o600 && s.size > 0 && s.size <= 1024);
    const value = readFileSync(fd, 'utf8').trim();
    requireThat(kind === 'key' ? /^0x[0-9a-fA-F]{64}$/.test(value) : /^[A-Za-z0-9_-]{10,1000}$/.test(value));
    return value;
  } catch { throw new Error('agents secret file refused'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function mounted(file) {
  requireThat(typeof file === 'string' && /^\/run\/service-config\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(file), 'mounted file required');
  return file;
}
export async function createDriver(env, cfg = agentSettings(env)) {
  // The reusable engine can use offline fixtures anywhere. This real driver only runs on the root Linux server container.
  requireThat(process.platform === 'linux' && process.getuid() === 0 && env.SH_AGENTS_SERVER === '1', 'server container required');
  const c = validateConfig(JSON.parse(readBounded(mounted(env.SH_AGENTS_ROLES_FILE ?? '/run/service-config/lake-house.json'))));
  const url = new URL(env.SH_AGENTS_RPC_URL); requireThat(['http:', 'https:'].includes(url.protocol));
  const chain = createChain({ config: c, rpcUrl: url.href,
    signer: () => { requireThat(cfg.mode === 'live'); return privateKeyToAccount(readSecret('/run/service-config/manager.key', 'key')); } });
  requireThat(await chain.chainId() === SEPOLIA, 'Sepolia required');
  const root = '/srv/squarehole/agents';
  for (const dir of [root, ...['replies', 'statements', 'proposals', 'state'].map(d => `${root}/${d}`)]) {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { const s = fstatSync(fd); requireThat(s.uid === 0 && s.gid === 0 && (s.mode & 0o777) === 0o700, 'private agents folders required'); }
    finally { closeSync(fd); }
  }
  const prompts = Object.fromEntries(['manager', 'bookkeeper'].map(name => [name,
    readBounded(new URL(`./agents/prompts/lake-house/${name}.md`, import.meta.url), 16384)]));
  const model = messagesClient(readSecret(mounted(env.SH_AGENTS_API_KEY_FILE), 'api'));
  const feed = mounted(env.SH_AGENTS_FEED_FILE ?? '/run/service-config/feed.json');
  return createAgents({ root, config: c, prompts, mode: cfg.mode, chain, model,
    jobs: () => JSON.parse(readBounded(feed)), dailyBudgetUsd: cfg.dailyBudgetUsd });
}
export function agentHealthy(record, cfg, now = Date.now()) {
  return !!record && record.service === 'agents' && record.mode === cfg.mode && record.status === (cfg.enabled ? 'ok' : 'disabled')
    && Number.isSafeInteger(record.at) && record.at <= now && now - record.at <= cfg.interval + CYCLE_TIMEOUT_MS + 60000;
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const [action, expected, ...extra] = args, cfg = agentSettings(env);
  requireThat(!extra.length && [undefined, '--dry-run', '--healthcheck'].includes(action)
    && (expected === undefined || (action === '--healthcheck' && ['disabled', 'dry-run', 'live'].includes(expected))));
  if (action === '--dry-run') { process.stdout.write('agents: offline plan; no credentials, model, RPC or state accessed\n'); return; }
  if (action === '--healthcheck') {
    requireThat(agentHealthy(JSON.parse(readBounded(HEALTH_FILE)), cfg) && (!expected || expected === (cfg.enabled ? cfg.mode : 'disabled')));
    process.stdout.write(`agents: ${cfg.enabled ? cfg.mode : 'disabled'}; health current\n`); return;
  }
  process.umask(0o077);
  publishHealth({ service: 'agents', mode: cfg.mode, status: 'starting', at: Date.now() });
  const controller = new AbortController(); let driver, stopTimer;
  const stop = () => {
    controller.abort(); stopTimer ??= setTimeout(() => { driver?.close(); process.exit(0); }, STOP_BUDGET_MS);
  };
  const timed = async fn => {
    const timer = setTimeout(() => { process.stderr.write('agents: cycle timed out\n'); driver?.close(); process.exit(1); }, CYCLE_TIMEOUT_MS);
    try { return await fn(); } finally { clearTimeout(timer); }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    driver = cfg.enabled ? await timed(() => createDriver(env, cfg)) : {};
    process.stdout.write(`agents: ${cfg.enabled ? cfg.mode : 'disabled'}\n`);
    await runLoop(cfg, { cycle: () => timed(() => driver.cycle({ signal: controller.signal })), close: () => driver.close?.() }, {
      stopped: () => controller.signal.aborted,
      publish: record => {
        const full = { ...record, ...driver.health?.() };
        if (cfg.enabled) writeAtomic('/srv/squarehole/agents/state/health.json', full);
        publishHealth(full);
      },
      sleep: async ms => { try { await wait(ms, undefined, { signal: controller.signal }); } catch { /* stopping */ } },
    });
  } finally { clearTimeout(stopTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  main().catch(() => { process.stderr.write('agents refused; check settings, mounts and chain; details suppressed\n'); process.exitCode = 1; });
}
