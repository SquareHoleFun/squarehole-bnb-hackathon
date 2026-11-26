import { constants, openSync, fstatSync, readFileSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

const names = ['keeper', 'burn-bot', 'reveal'];
export const HEALTH_FILE = '/tmp/service-health.json';
export const HEALTH_AGE_MS = 300_000;
export const CYCLE_TIMEOUT_MS = 240_000;
export const STOP_BUDGET_MS = 45_000;
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const bit = (value = '0') => { requireThat(['0', '1'].includes(value), 'invalid operator flag'); return value === '1'; };

export function settings(service, env) {
  requireThat(names.includes(service), 'unknown service');
  const enabled = bit(env.SH_SERVICE_ENABLED);
  const mode = env.SH_SERVICE_MODE ?? 'dry-run';
  requireThat(['dry-run', 'live'].includes(mode), 'invalid service mode');
  const allowMainnet = bit(env.SH_SERVICE_ALLOW_MAINNET);
  // The service has one authority for live mode and mainnet; package CLI flags cannot override it.
  for (const key of ['SH_KEEPER_PRIVATE_KEY', 'SH_KEEPER_PRIVATE_SEND_KEY', 'SH_KEEPER_DRY_RUN', 'SH_KEEPER_ALLOW_MAINNET']) {
    requireThat(env[key] === undefined, 'legacy keeper secret or mode setting refused');
  }
  const chain = service === 'keeper' ? env.SH_KEEPER_CHAIN_ID : service === 'reveal' ? env.SH_REVEAL_CHAIN_ID : undefined;
  if (chain !== undefined) {
    requireThat(/^[1-9][0-9]*$/.test(chain), 'invalid chain id');
    requireThat(BigInt(chain) !== 1n || allowMainnet, 'explicit mainnet operator flag required');
  }
  const poll = env.SH_KEEPER_POLL_MS ?? '4000';
  if (service === 'keeper') requireThat(/^[1-9][0-9]*$/.test(poll) && Number.isSafeInteger(Number(poll))
    && Number(poll) <= 2_147_483_647, 'invalid keeper poll interval');
  return { service, enabled, mode, allowMainnet, interval: service === 'keeper' ? Number(poll) : service === 'burn-bot' ? 60_000 : 12_000 };
}

/**
 * No symlinks, bounded regular file, owned by this process's user, no group or other permission bit at all (SH-259
 * review: a group-readable key passed the former 0o027 mask). Error text never contains a path/value.
 */
export function readKeyFile(path, expectedUid = process.getuid?.()) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    requireThat(stat.isFile() && stat.size <= 67 && (stat.mode & 0o077) === 0, 'refused');
    requireThat(expectedUid === undefined || stat.uid === expectedUid, 'refused');
    // Exactly the 66 key characters, then at most one line end (SH-259 re-read point 13: no padding of any kind).
    const raw = readFileSync(fd, 'utf8');
    requireThat(/^0x[0-9a-fA-F]{64}\n?$/.test(raw), 'refused');
    return raw.slice(0, 66);
  } catch { throw new Error('key file refused'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function mounted(path) {
  requireThat(typeof path === 'string' && /^\/run\/service-config\/[a-zA-Z0-9._/-]+$/.test(path)
    && !path.split('/').includes('..'), 'mounted configuration path required');
  return path;
}

export function keeperEnvironment(env, cfg, readKey = readKeyFile) {
  const out = { ...env, SH_KEEPER_DRY_RUN: cfg.mode === 'live' ? '0' : '1',
    SH_KEEPER_ALLOW_MAINNET: cfg.allowMainnet ? '1' : '0', SH_KEEPER_STATE_FILE: '/state/keeper.json',
    SH_KEEPER_MONITOR_FILE: '/state/monitor.json' };
  if (cfg.mode === 'live') {
    out.SH_KEEPER_PRIVATE_KEY = readKey(mounted(env.SH_KEEPER_KEY_FILE));
    if (env.SH_KEEPER_PRIVATE_SEND_KEY_FILE) out.SH_KEEPER_PRIVATE_SEND_KEY = readKey(mounted(env.SH_KEEPER_PRIVATE_SEND_KEY_FILE));
  }
  return out;
}

export function botArguments(env, cfg) {
  const args = ['--config', mounted(env.SH_BOT_CONFIG ?? '/run/service-config/runner.json')];
  if (cfg.mode === 'live') args.push('--propose', '--signer-command', mounted(env.SH_BOT_SIGNER_COMMAND));
  else args.push('--dry-run');
  if (cfg.allowMainnet) args.push('--allow-mainnet');
  return args;
}

export function revealEnvironment(env, cfg) {
  const out = { ...env, SH_REVEAL_FEED: cfg.mode === 'live' ? '/state/feed.json' : '/state/feed.dry.json',
    SH_REVEAL_STATE: '/state/pins.json', SH_REVEAL_RENDER_DIR: '/art',
    SH_REVEAL_PUBLIC: '/run/service-config/commitment.json' };
  if (cfg.mode !== 'live') { delete out.SH_REVEAL_PINATA_JWT; delete out.SH_REVEAL_KUBO_TOKEN; }
  return out;
}

export function healthy(record, cfg, now = Date.now()) {
  return !!record && record.service === cfg.service && record.mode === cfg.mode
    && record.status === (cfg.enabled ? 'ok' : 'disabled') && Number.isSafeInteger(record.at)
    && record.at <= now && now - record.at <= HEALTH_AGE_MS;
}

export function publishHealth(record) {
  writeFileSync(`${HEALTH_FILE}.new`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(`${HEALTH_FILE}.new`, HEALTH_FILE);
}

/** Sequential cycles; only successful work refreshes health. A hung cycle exits via the process watchdog. */
export async function runLoop(cfg, driver, { stopped, sleep = wait, publish = publishHealth,
  now = Date.now, random = Math.random, log = (message) => process.stdout.write(`${cfg.service}: ${message}\n`) }) {
  let failures = 0;
  try {
    while (!stopped()) {
      try {
        const completed = !cfg.enabled || await driver.cycle();
        failures = 0;
        // A driver's notes (SH-259: the keeper's hanging nonce on a chain whose base fee is 0) ride along, fixed keys only.
        const notes = cfg.enabled && typeof driver.notes === 'function' ? driver.notes() : {};
        if (completed) publish({ service: cfg.service, mode: cfg.mode, status: cfg.enabled ? 'ok' : 'disabled', at: now(),
          ...(typeof notes?.hanging === 'string' ? { hanging: notes.hanging } : {}) });
      } catch { failures++; log('cycle failed; details suppressed; retrying'); }
      const backoff = failures ? Math.min(300_000, cfg.interval * 2 ** Math.min(failures - 1, 8)) : 0;
      if (!stopped()) await sleep(Math.max(cfg.interval, Math.ceil(backoff * (1 + random() / 4))));
    }
  } finally { await driver.close?.(); }
}
