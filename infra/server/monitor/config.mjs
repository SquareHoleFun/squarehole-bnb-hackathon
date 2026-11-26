import { CONTRACT } from './drand.mjs';
import { normalize } from 'node:path';
// No secret-bearing value is included in errors or returned diagnostic text.
export function requireValue(ok) { if (!ok) throw new Error('invalid monitor input'); }
export function uint(value) {
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value));
  return BigInt(value);
}
/** Raw wei as a decimal of 10^digits, bigint only, trailing zeros dropped. */
export function decimal(wei, digits, places) {
  const unit = 10n ** BigInt(digits), whole = wei / unit;
  const frac = (wei % unit).toString().padStart(digits, '0').slice(0, places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
export function httpsUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('invalid monitor input'); }
  requireValue(u.protocol === 'https:' && !u.username && !u.password && !u.hash);
  return u;
}
export const DEFAULTS = Object.freeze({
  landingUrl: 'https://squarehole.fun/', apiUrl: 'https://api.squarehole.fun/healthz',
  feedUrl: 'https://api.squarehole.fun/v1/feed', origin: 'https://squarehole.fun',
  keeperIdentity: '', keeperAddress: '',
  // The keeper container's journal and view in the Compose volume `squarehole_keeper_state` (mounted at /state).
  keeperFile: '/var/lib/docker/volumes/squarehole_keeper_state/_data/keeper.json',
  keeperViewFile: '/var/lib/docker/volumes/squarehole_keeper_state/_data/monitor.json',
  alphaApiEnabled: false, alphaApiUrl: 'https://test-app.squarehole.fun/alpha/health',
  alphaApiFile: '/srv/squarehole/alpha/state/monitor.json', alphaQueueAgeSeconds: '1800', alphaFailureCount: '3',
  alphaSenderEnabled: false,
  alphaSenderFile: '/var/lib/docker/volumes/squarehole_alpha_sender_state/_data/monitor.json',
  keeperSetEnabled: false, keeperSetAddress: '', keeperSetIdentity: '',
  keeperSetFile: '/var/lib/docker/volumes/squarehole_keeper_set_state/_data/keeper.json',
  keeperSetViewFile: '/var/lib/docker/volumes/squarehole_keeper_set_state/_data/monitor.json',
  keeperSetOursWeiPerDay: '102000000000000000', keeperSetPokesWeiPerDay: '12000000000000000',
  keeperSetTotalWeiPerDay: '114000000000000000', keeperSetReserveWeiPerDay: '51000000000000000',
  keeperSetMaxFeePerGasWei: '3000000000',
  journalFile: '/var/lib/squarehole/burn-bot/journal.sqlite', backupDir: '/var/backups/squarehole', diskPath: '/var/lib/docker',
  stateDir: '/var/lib/squarehole-monitor', channels: 'mailer',
  maxLagBlocks: '64', maxAheadBlocks: '256', maxHeadAgeSeconds: '300', maxFinalizedAgeSeconds: '1800', maxSnapshotAgeSeconds: '300',
  queueAgeBlocks: '300', queueCount: '100', maxBackupAgeSeconds: '108000',
  diskUsedPercent: '85', memoryUsedPercent: '90', spendWarnPercent: '80', repeatSeconds: '21600',
  drandSource: '0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6', drandLagSeconds: '900',
  drandBackedSource: '0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb', drandBackupStartLadder: '43200,21600,7200',
  drandBackupFixGraceBlocks: '300', drandBackupFixClosingBlocks: '8000',
  drandLadder: '21600,86400,259200,432000,518400', drandLadderLevels: 'alert,critical,critical,emergency,emergency',
  drandUnrequestedLadder: '3600,86400,604800,1728000,2332800,2505600',
  drandUnrequestedLevels: 'alert,critical,critical,critical,emergency,emergency',
  drandMaxKeys: '64', rpcBatchSize: '50', wordOfGasAlert: '25000',
  criticalRepeatSeconds: '3600', emergencyRepeatSeconds: '900',
  oursWeiPerDay: '102000000000000000', pokesWeiPerDay: '12000000000000000',
  totalWeiPerDay: '114000000000000000', reserveWeiPerDay: '51000000000000000', maxFeePerGasWei: '3000000000',
  // R62-FEE, equal to the keeper's SH_KEEPER_DRAND_RESCUE_{MAX_FEE_WEI,WINDOW_SECONDS,WEI_PER_DAY}: its random-number jobs
  // may pay up to this fee inside the window before a deadline, from their own daily counter. A window or cap of 0 is off.
  drandRescueMaxFeeWei: '50000000000', drandRescueWindowSeconds: '259200', drandRescueWeiPerDay: '50000000000000000',
});
// The keeper accepts 0 for these two (R62 off), so the monitor does too.
const MAY_BE_ZERO = new Set(['drandRescueWindowSeconds', 'drandRescueWeiPerDay']);
export function configure(input, env) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input));
  requireValue(Object.keys(input).every(k => Object.hasOwn(DEFAULTS, k)));
  const c = { ...DEFAULTS, ...input, chainId: env.SH_MONITOR_CHAIN_ID ?? '11155111' };
  channelNames(c.channels);
  requireValue(c.chainId === '11155111' || (c.chainId === '1' && env.SH_MONITOR_ALLOW_MAINNET === '1'));
  for (const k of ['landingUrl', 'apiUrl', 'feedUrl', 'origin', 'alphaApiUrl']) {
    const u = httpsUrl(c[k]); requireValue(!u.search);
  }
  requireValue(new URL(c.apiUrl).origin === new URL(c.feedUrl).origin);
  requireValue(/^0x[0-9a-fA-F]{40}$/.test(c.keeperAddress));
  const parts = c.keeperIdentity.split(':');
  requireValue(parts.length === 4 && parts[0] === c.chainId && parts[1] === c.keeperAddress.toLowerCase()
    && parts.slice(2).every(p => p === '' || /^0x[0-9a-f]{40}$/.test(p)));
  for (const k of ['keeperFile', 'keeperViewFile', 'keeperSetFile', 'keeperSetViewFile', 'alphaSenderFile', 'alphaApiFile', 'journalFile', 'backupDir', 'diskPath', 'stateDir']) {
    requireValue(typeof c[k] === 'string' && c[k].startsWith('/') && !/[\r\n\0]/.test(c[k]));
  }
  for (const k of Object.keys(DEFAULTS).filter(k => /Blocks$|Seconds$|Percent$|Wei|queueCount/.test(k))) requireValue(uint(c[k]) > 0n || MAY_BE_ZERO.has(k));
  for (const k of ['diskUsedPercent', 'memoryUsedPercent', 'spendWarnPercent']) requireValue(uint(c[k]) <= 100n);
  requireValue(uint(c.drandBackupFixGraceBlocks) < uint(c.drandBackupFixClosingBlocks)
    && uint(c.drandBackupFixClosingBlocks) < CONTRACT.historyWindow - CONTRACT.recentBlocks);
  requireValue(uint(c.maxFeePerGasWei) <= 3000000000n);
  requireValue(uint(c.drandRescueMaxFeeWei) >= uint(c.maxFeePerGasWei));
  requireValue(uint(c.reserveWeiPerDay) <= uint(c.oursWeiPerDay) && uint(c.reserveWeiPerDay) <= uint(c.totalWeiPerDay));
  requireValue(typeof c.keeperSetEnabled === 'boolean');
  requireValue(typeof c.alphaApiEnabled === 'boolean' && (!c.alphaApiEnabled || c.chainId === '11155111'));
  requireValue(uint(c.alphaFailureCount) > 0n);
  requireValue(typeof c.alphaSenderEnabled === 'boolean' && (!c.alphaSenderEnabled || c.chainId === '11155111'));
  requireValue(uint(c.keeperSetMaxFeePerGasWei) <= 3000000000n);
  requireValue(uint(c.keeperSetReserveWeiPerDay) <= uint(c.keeperSetOursWeiPerDay)
    && uint(c.keeperSetReserveWeiPerDay) <= uint(c.keeperSetTotalWeiPerDay));
  if (c.keeperSetEnabled) {
    requireValue(typeof c.keeperSetAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.keeperSetAddress)
      && c.keeperSetAddress.toLowerCase() !== c.keeperAddress.toLowerCase());
    const setParts = typeof c.keeperSetIdentity === 'string' ? c.keeperSetIdentity.split(':') : [];
    requireValue(setParts.length === 4 && setParts[0] === c.chainId && setParts[1] === c.keeperSetAddress.toLowerCase()
      && /^0x[0-9a-f]{40}$/.test(setParts[2]) && setParts[2] !== parts[2] && setParts[3] === '');
    const paths = [c.keeperFile, c.keeperViewFile, c.keeperSetFile, c.keeperSetViewFile].map(normalize);
    // Include lock refusal paths: configuring a view as a journal's lock file is not isolation.
    requireValue(new Set([...paths, ...paths.map(p => `${p}.lock-refused.json`)]).size === 8);
  }
  for (const key of ['drandSource', 'drandBackedSource']) requireValue(typeof c[key] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c[key]));
  requireValue(typeof c.drandBackupStartLadder === 'string');
  const backupSteps = c.drandBackupStartLadder.split(',').map(uint);
  requireValue(backupSteps.every((r, i) => r > 0n && r < (backupSteps[i - 1] ?? CONTRACT.latestStart - CONTRACT.backupAfter)));
  for (const [key, max] of [['drandMaxKeys', 1000n], ['rpcBatchSize', 100n], ['wordOfGasAlert', 49999n]]) {
    requireValue(uint(c[key]) > 0n && uint(c[key]) <= max);
  }
  for (const [key, levels, end] of [
    ['drandLadder', 'drandLadderLevels', CONTRACT.silence], ['drandUnrequestedLadder', 'drandUnrequestedLevels', CONTRACT.unrequested],
  ]) {
    requireValue(typeof c[key] === 'string' && typeof c[levels] === 'string');
    const rungs = c[key].split(',').map(uint), ranks = c[levels].split(',').map(l => ['warn', 'alert', 'critical', 'emergency'].indexOf(l));
    requireValue(rungs.length === ranks.length);
    requireValue(rungs.every((r, i) => r > (rungs[i - 1] ?? 0n) && r < end
      && ranks[i] >= 0 && ranks[i] >= (ranks[i - 1] ?? 0)));
  }
  return c;
}
// Secret stays in the environment; callers receive only flags, including for malformed URLs.
export function heartbeatConfig(env) {
  const configured = env.SH_MONITOR_HEARTBEAT_URL !== undefined && env.SH_MONITOR_HEARTBEAT_URL !== '';
  let valid = false;
  try {
    const value = env.SH_MONITOR_HEARTBEAT_URL;
    const u = httpsUrl(value);
    valid = typeof value === 'string' && !/[?#]/.test(value) && !u.search;
  } catch { /* An invalid heartbeat is an alert, not a configuration exception. */ }
  return { configured, valid };
}

export function channelNames(value) {
  requireValue(typeof value === 'string');
  const names = value.split(',');
  requireValue(new Set(names).size === names.length && names.every(n => ['mailer', 'smtp'].includes(n)));
  return names;
}
