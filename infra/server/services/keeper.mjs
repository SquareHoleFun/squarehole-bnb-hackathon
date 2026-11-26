import { formatDeferral } from '../../../packages/keeper/src/skips.ts';
import { keeperContracts, keeperMulticall } from '../../../packages/keeper/src/tick-reads.ts';
import { keeperTransport } from '../../../packages/keeper/src/rpc.ts';
// The package's own viem: read-failure.ts recognizes only its error classes (SH-109; a CommonJS require loads a second copy).
import { createPublicClient, defineChain, http, privateKeyToAccount } from '../../../packages/keeper/src/viem.ts';
import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { keeperEnvironment } from './runtime.mjs';
import { loadConfig, destinationGasAdapters, privateSendsReady } from '../../../packages/keeper/src/config.ts';
import { setKeeperConfig } from '../../../packages/keeper/src/set.ts';
import { ViemChain, checkChainId } from '../../../packages/keeper/src/chain.ts';
import { runTick } from '../../../packages/keeper/src/run.ts';
import { StateStore } from '../../../packages/keeper/src/state.ts';
import { SentBook } from '../../../packages/keeper/src/sent.ts';
import { cryptoRng } from '../../../packages/keeper/src/rng.ts';
import { publishMonitorView, buildMonitorView, encodeMonitorView, writeMonitorView } from '../../../packages/keeper/src/monitor.ts';
import { startAtlasService } from '../../../packages/keeper/src/atlas-service.ts';

// Messages only from this fixed list; upstream error objects, endpoint strings and account data never reach logs.
const warnings = new Set([
  'box 0 round on its backup', 'box 0 backup past its latest start', 'box 0 backup fix window closed',
  'backup header mismatch', 'backup start window closed', 'backup header self-check failed',
  'drand request nearing silence', 'drand request silent', 'drand read failed', 'keeper monitor view not published',
  'drand deadline fee in use', 'drand rescue allowance spent', 'drand rescue allowance half used',
  'drand rescue allowance mostly used', 'drand waits on the daily budget',
  'rpc on another chain', 'rpc fallback refused', 'rpc fallback in use',
  'keeper state lock held', 'keeper state store closed', 'keeper lock invalid', 'keeper lock command refused',
  'nonce count ahead of the record', 'saved transactions not followed', 'replacement waits', 'gas price unread',
]);
const skipped = data => process.stderr.write(`${formatDeferral(data)}\n`);
// SH-249: a saved transaction's broadcast names its nonce and hash (public chain data), checked before printing.
const saved = new Set(['saved transaction broadcast again', 'saved transaction broadcast refused', 'saved transaction replaced',
  'saved transaction hangs at its fee ceiling', 'saved transaction released: another transaction used its nonce', 'saved transaction taken over',
  'saved transaction hangs; the keeper waits']);
const hex32 = h => typeof h === 'string' && /^0x[0-9a-f]{64}$/.test(h);
const savedLine = (message, data) => `keeper: ${message}`
  + (typeof data?.nonce === 'bigint' && hex32(data?.hash) ? ` nonce=${data.nonce} hash=${data.hash}${hex32(data?.over) ? ` over=${data.over}` : ''}` : '')
  // SH-259: a hanging send on a chain whose base fee is 0: since which block, its price, what the chain asks now.
  + (typeof data?.since === 'bigint' && typeof data?.price === 'bigint'
    ? ` since=${data.since} price=${data.price} asks=${typeof data?.asks === 'bigint' ? data.asks : 'unread'}` : '') + '\n';
// SH-266: the Atlas parts' own lines (prices, ages, feeds, the relay's sends): public chain data, bounded and checked
// value by value; anything else in them (an error object, an endpoint) is left out.
const atlasSafe = (v, depth = 0) => typeof v === 'bigint' ? v.toString() : typeof v === 'number' || typeof v === 'boolean' ? v
  : typeof v === 'string' ? (/^[0-9A-Za-z ./:,_()%-]{0,120}$/.test(v) ? v : '[omitted]')
  : depth > 3 || v === null || typeof v !== 'object' ? null
  : Array.isArray(v) ? v.slice(0, 8).map(x => atlasSafe(x, depth + 1))
  : Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'error').slice(0, 16).map(([k, x]) => [k, atlasSafe(x, depth + 1)]));
const atlasLine = (message, data) => process.stderr.write(`keeper: ${atlasSafe(message)} ${JSON.stringify(atlasSafe(data ?? {}))}\n`);
const log = { info(message, data) { if (typeof message === 'string' && message.startsWith('atlas')) { atlasLine(message, data); return; } if (message === 'skipped') skipped(data); },
  error() { process.stderr.write('keeper: operation failed; details suppressed\n'); },
  warn(message, data) {
    if (typeof message === 'string' && message.startsWith('atlas')) { atlasLine(message, data); return; }
    if (message === 'skipped') { skipped(data); return; }
    if (saved.has(message)) { process.stderr.write(savedLine(message, data)); return; }
    process.stderr.write(`keeper: ${warnings.has(message) ? message : 'work deferred; inspect chain and policy'}\n`);
  } };

// Public, bounded JSON only. Resolve symlinks as well as lexical paths within the read-only mount.
export function readPublicManifest(path, root = '/run/service-config') {
  let fd;
  try {
    if (!realpathSync(path).startsWith(`${realpathSync(root)}/`)) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > 1048576) throw new Error();
    return readFileSync(fd, 'utf8');
  } catch { throw new Error('set keeper configuration refused'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadServiceConfig(env, service, read = readPublicManifest) {
  const core = env.SH_KEEPER_CORE_MANIFEST, set = env.SH_KEEPER_SET_MANIFEST;
  if (core === undefined && set === undefined) return loadConfig(keeperEnvironment(env, service));
  try {
    for (const path of [core, set]) {
      if (typeof path !== 'string' || !/^\/run\/service-config\/[a-zA-Z0-9._/-]+$/.test(path)
        || path.split('/').includes('..')) throw new Error();
    }
    const cfg = loadConfig(keeperEnvironment(env, service));
    return setKeeperConfig(cfg, JSON.parse(read(core)), JSON.parse(read(set)));
  } catch { throw new Error('set keeper configuration refused'); }
}

// Capture the already verified discovery snapshot, without another RPC read or changes to planning/signing.
class SetMonitoredChain extends ViemChain {
  async read(...args) {
    this.setWorld = undefined;
    const world = await super.read(...args);
    this.setWorld = world;
    return world;
  }
}

export function buildSetMonitorView(chainId, identity, out, world) {
  const o = out.observed;
  if (!world || !o?.readings) return null;
  const view = buildMonitorView({ chainId, identity, readings: o.readings, maxFeePerGas: o.maxFeePerGas,
    queue: out.state.monitorQueue ?? {}, income: o.income, incomeSpend: o.incomeSpend, deferrals: o.deferrals });
  if (!view) return null;
  return { ...view, schema: 'squarehole.monitor-keeper-set.v1',
    // Set jobs use the reserved allowance; optional income does not govern their liveness.
    complete: o.readings.complete,
    sets: world.boxes.map(b => ({ id: String(b.id), coordinator: b.coordinator.toLowerCase(),
      closed: b.curveClosed, closedAt: String(b.setLifecycle.closedAt), graduated: b.graduated, failed: b.failed })) };
}

/** The package owns all planning, drand, nonce and money logic. This adapter owns only process lifecycle. */
export async function createDriver(env, service) {
  const cfg = loadServiceConfig(env, service);
  if (!cfg.box0 && !cfg.boxRegistry) throw new Error('keeper needs a watched deployment');
  if (!cfg.keeperAddress) throw new Error('explicit public keeper address required');
  const chain = defineChain({ id: cfg.chainId, contracts: keeperContracts(cfg.chainId), name: 'operator chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: keeperTransport(cfg, { batch: { batchSize: 32, wait: 8 }, retryCount: 1, timeout: 15_000 }, message => log.warn(message)), batch: keeperMulticall(cfg.chainId) });
  await checkChainId(pub, cfg.chainId, cfg.allowMainnet);
  const privatePub = cfg.privateRpcUrl ? createPublicClient({ chain, transport: http(cfg.privateRpcUrl, { retryCount: 1, timeout: 15_000 }) }) : null;
  const account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : null;
  const privateAccount = cfg.privateSendKey ? privateKeyToAccount(cfg.privateSendKey) : null;
  if (account && account.address.toLowerCase() !== cfg.keeperAddress.toLowerCase()) throw new Error('signer mismatch');
  const keeper = cfg.keeperAddress;
  const g = destinationGasAdapters(cfg.destinationGas, pub);
  const Chain = cfg.setRelease ? SetMonitoredChain : ViemChain;
  const port = new Chain(cfg, pub, keeper, { public: account, private: privateAccount }, privatePub, log, g.reader, g.estimator);
  const identity = [cfg.chainId, keeper.toLowerCase(), cfg.boxRegistry?.toLowerCase() ?? '', cfg.box0?.coordinator.toLowerCase() ?? ''].join(':');
  let store;
  try { store = new StateStore(cfg.stateFile + (cfg.dryRun ? '.dry' : ''), identity); }
  catch (error) {
    if (error?.code === 'SH_KEEPER_LOCK_HELD') process.stderr.write('keeper: state lock held; see docs/ops/drand-poster.md, Leftover lock\n');
    throw error;
  }
  let state;
  try {
    state = store.load();
    // SH-249: live sends save each signed transaction beside the journal before broadcasting it. Dry runs sign nothing.
    if (!cfg.dryRun) port.track(new SentBook(store.loadSent(state), entries => store.saveSent(entries)));
  } catch (error) { store.close(); throw error; }
  // SH-266: the same Atlas parts as the standalone keeper (atlas-service.ts): prices for the income rule and the relay.
  let atlas;
  try { atlas = startAtlasService({ env, cfg, log }); }
  catch (error) { store.close(); throw error; }
  // The host monitor reads this file from the keeper_state volume (docs/runbooks/monitoring.md).
  const monitorFile = cfg.monitorFile ? cfg.monitorFile + (cfg.dryRun ? '.dry' : '') : null;
  let lastBlock = -1n;
  return {
    async cycle({ signal } = {}) {
      // Cache-free: health stops advancing when the endpoint stalls on a head.
      const head = await pub.getBlockNumber({ cacheTime: 0 });
      if (head === lastBlock) return false;
      // SH-266: Atlas prices for the income rule, read before the tick (the keeper sends nothing for Atlas).
      if (atlas) await atlas.beforeTick();
      const checkpoint = async (next, now) => { store.save(next, now); state = next; };
      const out = await runTick(port, state, { ...cfg, keeper, privateEndpoint: privateSendsReady(cfg), rng: cryptoRng, checkpoint, signal }, log);
      state = out.state;
      if (monitorFile) {
        try {
          if (cfg.setRelease) {
            const view = buildSetMonitorView(cfg.chainId, identity, out, port.setWorld);
            if (view) {
              let body = encodeMonitorView(view);
              // Keep the set extension bounded too; an incomplete view must never hide a missing set.
              if (Buffer.byteLength(body) > 4 * 1024 * 1024) body = encodeMonitorView({ ...view, complete: false, sets: [] });
              writeMonitorView(monitorFile, body);
            }
          } else publishMonitorView(monitorFile, cfg.chainId, identity, out);
        }
        catch { log.warn('keeper monitor view not published'); }
      }
      lastBlock = head;
      return true;
    },
    release() { store.close(); },
    close() { store.close(); },
    // SH-259: the lowest nonce that hangs on a chain whose base fee is 0 (the keeper waits; nothing replaces it).
    notes() { const hanging = port.hangingNote?.(); return hanging ? { hanging } : {}; },
  };
}
