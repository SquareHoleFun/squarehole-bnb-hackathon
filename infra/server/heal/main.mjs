import { constants, realpathSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const STATE = '/var/lib/squarehole-indexer-heal/state.json';
const DAY = 86400, COOLDOWN = 900, START_PERIOD = 1800, MAX_RPC_AGE = 300;
const requireValue = value => { if (!value) throw new Error('invalid data'); };
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
const seconds = value => Number.isSafeInteger(value) && value >= 0;
const hex = value => {
  requireValue(typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value));
  return BigInt(value).toString();
};

// The host sends only selected inspect fields and the public manifest chain ID. Nothing from stdin is logged.
export async function readInspection(input = process.stdin) {
  const chunks = []; let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk); requireValue(size <= 65536); chunks.push(Buffer.from(chunk));
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireValue(typeof data.id === 'string' && /^[0-9a-f]{64}$/.test(data.id));
  requireValue(Array.isArray(data.inspection) && data.inspection.length === 5);
  const [id, start, project, service, slot] = data.inspection;
  requireValue(id === data.id && project === 'squarehole' && service === 'indexer');
  requireValue(typeof start === 'string');
  const startedAt = Math.floor(Date.parse(start) / 1000); requireValue(seconds(startedAt));
  requireValue(typeof slot === 'string' && slot.startsWith('SH_CORE_HTTP_URLS='));
  const urls = slot.slice('SH_CORE_HTTP_URLS='.length).split(',').map(value => value.trim()).filter(Boolean);
  requireValue(urls.length > 0 && urls.length <= 8);
  for (const value of urls) { const url = new URL(value); requireValue(['http:', 'https:'].includes(url.protocol) && !url.hash); }
  const chainId = String(data.chainId); requireValue(decimal(chainId) && BigInt(chainId) > 0n);
  return { identity: `${id}:${start}`, startedAt, urls, chainId };
}

async function requestJson(url, init, fetcher, signal) {
  const response = await fetcher(url, { ...init, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  const reader = response.body?.getReader(); requireValue(reader);
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; requireValue(size <= 65536); chunks.push(Buffer.from(value));
    }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function probeGateway(fetcher = fetch) {
  const { status, body } = await requestJson('http://127.0.0.1:5394/healthz', { headers: { 'Cache-Control': 'no-cache' } }, fetcher);
  requireValue((status === 200 || status === 503) && typeof body.ok === 'boolean' && typeof body.following === 'boolean');
  const head = body.asOf === null ? null : body.asOf?.block;
  requireValue(head === null || decimal(head));
  // A responsive 503 can mean history replay or a database outage. Neither is gateway silence.
  return { head };
}
export async function probeRpc(container, fetcher = fetch) {
  const signal = AbortSignal.timeout(15000);
  for (const url of container.urls) {
    if (signal.aborted) break;
    try {
      let id = 0;
      const call = async (method, params) => {
        const callId = ++id;
        const { status, body } = await requestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) }, fetcher, signal);
        requireValue(status === 200 && body.jsonrpc === '2.0' && body.id === callId && !body.error);
        return body.result;
      };
      const chainId = hex(await call('eth_chainId', [])); requireValue(chainId === container.chainId);
      const block = await call('eth_getBlockByNumber', ['latest', false]);
      return { chainId, head: hex(block.number), timestamp: hex(block.timestamp) };
    } catch { /* Same ordered fallback list as the indexer; no raw URL or exception reaches the journal. */ }
  }
  throw new Error('rpc unavailable');
}

const fresh = now => ({ version: 1, checkedAt: now, identity: null, gatewayFailures: 0, stuckRuns: 0,
  lastIndexer: null, lastChain: null, restartTimes: [], holdUntil: 0 });
function validState(s) {
  return s?.version === 1 && seconds(s.checkedAt) && seconds(s.holdUntil)
    && (s.identity === null || (typeof s.identity === 'string' && s.identity.length <= 256))
    && [s.gatewayFailures, s.stuckRuns].every(n => Number.isInteger(n) && n >= 0 && n <= 3)
    && [s.lastIndexer, s.lastChain].every(n => n === null || decimal(n))
    && (s.lastRestart === undefined || (seconds(s.lastRestart?.at) && s.lastRestart.at <= s.checkedAt
      && ['reserved', 'restart-failed'].includes(s.lastRestart.outcome)))
    && Array.isArray(s.restartTimes) && s.restartTimes.length <= 4
    && s.restartTimes.every((at, i) => seconds(at) && at <= s.checkedAt && (i === 0 || at >= s.restartTimes[i - 1]));
}
async function loadState(path, now) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return fresh(now); throw error; }
  try {
    const st = await file.stat(); requireValue(st.isFile());
    if (st.size <= 16384) {
      try { const s = JSON.parse(await file.readFile('utf8')); if (validState(s)) return s; }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    // Lost/corrupt history cannot authorize more restarts. Recover a baseline, retaining a full day's hold.
    return { ...fresh(now), holdUntil: now + DAY };
  } finally { await file.close(); }
}
async function saveState(path, state) {
  const file = await open(path + '.new', constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(path + '.new', path);
  const dir = await open(dirname(path), constants.O_RDONLY);
  try { await dir.sync(); } finally { await dir.close(); }
}

function reportDecision(state, decision, code = 0, write = line => process.stdout.write(line)) {
  write(JSON.stringify({ decision, gatewayFailures: state?.gatewayFailures ?? 0, stuckRuns: state?.stuckRuns ?? 0,
    restarts24h: state?.restartTimes.length ?? 0 }) + '\n');
  return { decision, code };
}

/** Called by the locked host wrapper after a failed Compose restart; never probes or refunds an attempt. */
export async function recordRestartFailure(ports = {}) {
  let state;
  try {
    const path = ports.stateFile ?? STATE, now = ports.now ?? Math.floor(Date.now() / 1000);
    state = await loadState(path, now);
    requireValue(state.lastRestart?.at === state.restartTimes.at(-1)
      && state.lastRestart?.outcome === 'reserved');
    state.lastRestart.outcome = 'restart-failed';
    await (ports.save ?? saveState)(path, state);
    return reportDecision(state, 'restart-failed', 1, ports.write);
  } catch { return reportDecision(state, 'internal-error', 1, ports.write); }
}

/** One locked timer invocation. Inspection and probes are replaceable in offline tests; Docker stays on the host. */
export async function runOnce(ports = {}) {
  const now = ports.now ?? Math.floor(Date.now() / 1000), path = ports.stateFile ?? STATE;
  const save = ports.save ?? saveState, write = ports.write ?? (line => process.stdout.write(line));
  let state;
  const report = (decision, code = 0) => reportDecision(state, decision, code, write);
  const finish = async decision => { await save(path, state); return report(decision); };
  try {
    requireValue(seconds(now));
    state = await loadState(path, now);
    if (now < state.checkedAt) return report('clock-rollback');
    state.checkedAt = now;
    state.restartTimes = state.restartTimes.filter(at => now - at < DAY);
    let container;
    try { container = await (ports.inspect ?? readInspection)(); }
    catch { state.gatewayFailures = state.stuckRuns = 0; return await finish('container-unavailable'); }
    if (state.identity !== container.identity) {
      state.identity = container.identity;
      state.gatewayFailures = state.stuckRuns = 0;
      state.lastIndexer = state.lastChain = null;
    }
    if (now < container.startedAt || now - container.startedAt < START_PERIOD) {
      state.gatewayFailures = state.stuckRuns = 0;
      return await finish('startup-grace');
    }
    const [gatewayResult, rpcResult] = await Promise.allSettled([
      (ports.gateway ?? probeGateway)(), (ports.rpc ?? probeRpc)(container),
    ]);
    const gateway = gatewayResult.status === 'fulfilled' ? gatewayResult.value : null;
    const rpc = rpcResult.status === 'fulfilled' ? rpcResult.value : null;
    const head = gateway?.head ?? null, previousIndexer = state.lastIndexer, previousChain = state.lastChain;
    requireValue(head === null || decimal(head));
    if (head !== null) state.lastIndexer = head;
    const veto = async reason => { state.gatewayFailures = state.stuckRuns = 0; return finish(reason); };
    if (!rpc || !decimal(rpc.head) || !decimal(rpc.timestamp) || rpc.chainId !== container.chainId) return await veto('rpc-unavailable');
    if (BigInt(rpc.timestamp) > BigInt(now) || BigInt(now) - BigInt(rpc.timestamp) > BigInt(MAX_RPC_AGE)
      || [head, previousIndexer, previousChain].some(n => n !== null && BigInt(rpc.head) < BigInt(n))) return await veto('rpc-behind');
    state.lastChain = rpc.head;
    state.gatewayFailures = gateway === null ? Math.min(3, state.gatewayFailures + 1) : 0;
    state.stuckRuns = head !== null && previousIndexer !== null && previousChain !== null
      && BigInt(head) <= BigInt(previousIndexer) && BigInt(rpc.head) > BigInt(previousChain)
      ? Math.min(3, state.stuckRuns + 1) : 0;
    const reason = state.gatewayFailures === 3 ? 'gateway' : state.stuckRuns === 3 ? 'stalled' : null;
    if (state.holdUntil > now) return await finish('state-recovery-hold');
    if (!reason) return await finish(gateway === null || state.stuckRuns > 0 ? 'observing' : 'no-action');
    if (state.restartTimes.length >= 4) return await finish('daily-cap');
    if (state.restartTimes.length && now - state.restartTimes.at(-1) < COOLDOWN) return await finish('cooldown');
    // Reserve the attempt durably BEFORE Docker. Failure/timeout/crash after this point still consumes the budget.
    state.restartTimes.push(now); state.gatewayFailures = state.stuckRuns = 0;
    state.lastRestart = { at: now, outcome: 'reserved' };
    await save(path, state);
    return report(`restart-${reason}`);
  } catch { return report('internal-error', 1); }
}

function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (startedDirectly()) {
  if (process.argv.length === 2) process.exitCode = (await runOnce()).code;
  else if (process.argv.length === 3 && process.argv[2] === '--restart-failed') process.exitCode = (await recordRestartFailure()).code;
  else process.exitCode = reportDecision(undefined, 'internal-error', 1).code;
}
