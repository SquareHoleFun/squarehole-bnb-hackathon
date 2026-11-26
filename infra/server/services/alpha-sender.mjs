import { readFileSync, openSync, fstatSync, fchmodSync, closeSync, constants, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { healthy, publishHealth, HEALTH_FILE, runLoop, CYCLE_TIMEOUT_MS, STOP_BUDGET_MS, readKeyFile } from './runtime.mjs';
import { createChain, getAddress, privateKeyToAccount, SEPOLIA } from './alpha/sender/chain.mjs';
import { createSender } from './alpha/sender/engine.mjs';

// SH-275: chain 97 (BNB Chain Testnet, the hackathon build) beside Sepolia, with its own row (alpha/chains.mjs).
const BNB_TESTNET = 97;
export function senderSettings(env) {
  const enabled = env.SH_SERVICE_ENABLED ?? '0', mode = env.SH_SERVICE_MODE ?? 'dry-run';
  const chainId = env.SH_ALPHA_CHAIN_ID ?? String(SEPOLIA);
  if (!['0', '1'].includes(enabled) || !['dry-run', 'live'].includes(mode)
    || ![String(SEPOLIA), String(BNB_TESTNET)].includes(chainId)
    || (env.SH_SERVICE_ALLOW_MAINNET ?? '0') !== '0'
    || ['SH_KEEPER_PRIVATE_KEY', 'SH_KEEPER_PRIVATE_SEND_KEY', 'SH_ALPHA_PRIVATE_KEY', 'SH_KEEPER_DRY_RUN', 'SH_KEEPER_ALLOW_MAINNET'].some(k => env[k] !== undefined)) throw new Error('sender settings refused');
  return { service: 'alpha-sender', enabled: enabled === '1', mode, interval: 12000, chainId: Number(chainId) };
}
export function readDeskKey(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600 || stat.size > 67) throw new Error('desk key refused');
    const key = readFileSync(fd, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('desk key refused');
    return key;
  } finally { closeSync(fd); }
}
export function withChainHealth(sender, chain) {
  let lastHead = -1n;
  return { ...sender, async cycle(options) {
    const head = await chain.head();
    await sender.cycle(options);
    const advanced = head > lastHead;
    lastHead = head;
    return advanced;
  } };
}
export async function createDriver(env, cfg = senderSettings(env)) {
  const address = getAddress(env.SH_ALPHA_DESK_ADDRESS), teth = getAddress(env.SH_ALPHA_TETH);
  const url = new URL(env.SH_KEEPER_RPC_URL);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('RPC refused');
  // Check chain before opening the key, even in live mode. Dry-run never reads the mounted key.
  const chainId = cfg.chainId ?? SEPOLIA, sepolia = chainId === SEPOLIA;
  const base = sepolia ? { rpcUrl: url.href, address, teth } : { rpcUrl: url.href, address, teth, chainId };
  if (await createChain(base).chainId() !== chainId) throw new Error(sepolia ? 'Sepolia required' : 'chain 97 required');
  // Chain 97's stack runs the sender as the image's own user, as its keeper: the key file is that user's, read by the
  // keeper's reader (runtime.mjs readKeyFile). Sepolia keeps its root-only desk key.
  const readKey = sepolia ? readDeskKey : readKeyFile;
  const account = cfg.mode === 'live' ? privateKeyToAccount(readKey('/run/service-config/desk.key')) : undefined;
  if (account && account.address !== address) throw new Error('desk address mismatch');
  const chain = createChain({ ...base, account });
  // Retain the SAME named volume through mode changes, releases and rollbacks. No state migration or reset.
  // Docker creates this nocopy volume root-owned. Tighten its directory without changing any journal bytes.
  const stateFd = openSync('/state', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const stat = fstatSync(stateFd);
    if (!stat.isDirectory() || stat.uid !== (sepolia ? 0 : process.getuid())) throw new Error('root-owned sender state required');
    fchmodSync(stateFd, 0o700);
  } finally { closeSync(stateFd); }
  const sender = await createSender({ queue: '/queue', receipts: '/receipts', state: '/state', address, teth, mode: cfg.mode,
    chainId, chain, log: message => process.stdout.write(`alpha-sender: ${message}\n`) });
  return withChainHealth(sender, chain);
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const [action, expected, ...extra] = args;
  const cfg = senderSettings(env);
  if (extra.length || ![undefined, '--dry-run', '--healthcheck'].includes(action)
    || (expected !== undefined && (action !== '--healthcheck' || !['disabled', 'dry-run', 'live'].includes(expected)))) throw new Error('arguments refused');
  if (action === '--dry-run') {
    process.stdout.write('alpha-sender: offline plan; no queue, credentials, RPC, signer or state accessed\n'); return;
  }
  if (action === '--healthcheck') {
    if (!healthy(JSON.parse(readFileSync(HEALTH_FILE, 'utf8')), cfg)
      || (expected && expected !== (cfg.enabled ? cfg.mode : 'disabled'))) throw new Error('unhealthy');
    process.stdout.write(`alpha-sender: ${cfg.enabled ? cfg.mode : 'disabled'}; health current\n`); return;
  }
  process.umask(0o027); // Published receipts must remain group-readable; journals explicitly use 0600.
  publishHealth({ service: cfg.service, mode: cfg.mode, status: 'starting', at: Date.now() });
  const controller = new AbortController();
  let driver, stopTimer;
  const stop = () => {
    controller.abort();
    stopTimer ??= setTimeout(() => { driver?.close(); process.exit(0); }, STOP_BUDGET_MS);
  };
  const timed = async fn => {
    const timer = setTimeout(() => { process.stderr.write('alpha-sender: cycle timed out\n'); driver?.close(); process.exit(1); }, CYCLE_TIMEOUT_MS);
    try { return await fn(); } finally { clearTimeout(timer); }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    driver = cfg.enabled ? await timed(() => createDriver(env, cfg)) : {};
    process.stdout.write(`alpha-sender: ${cfg.enabled ? cfg.mode : 'disabled'}\n`);
    await runLoop(cfg, { cycle: () => timed(() => driver.cycle({ signal: controller.signal })), close: () => driver.close?.() }, {
      stopped: () => controller.signal.aborted,
      sleep: async ms => { try { await wait(ms, undefined, { signal: controller.signal }); } catch { /* stopping */ } },
    });
  } finally { clearTimeout(stopTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  main().catch(() => { process.stderr.write('alpha-sender refused; check settings, mounts and chain; details suppressed\n'); process.exitCode = 1; });
}
