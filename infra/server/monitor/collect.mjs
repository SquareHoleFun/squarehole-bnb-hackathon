import { constants } from 'node:fs';
import { open, readdir, readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { heartbeatConfig, httpsUrl, requireValue } from './config.mjs';
import { readDrand } from './drand.mjs';
const MAX_BYTES = 1048576;
export async function boundedRequest(url, init = {}, fetcher = fetch) {
  let reader;
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
    reader = response.body?.getReader();
    if (!reader) return { status: response.status, headers: Object.fromEntries(response.headers), body: '' };
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; requireValue(size <= MAX_BYTES); chunks.push(Buffer.from(value));
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks).toString('utf8') };
  } catch { throw new Error('read failed'); }
  finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
}
async function withFile(path, fn) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const st = await file.stat({ bigint: true }); requireValue(st.isFile()); return await fn(file, st); }
  finally { await file.close(); }
}
export async function readJson(path) {
  return withFile(path, async (file, st) => {
    requireValue(st.size > 0n && st.size <= 4194304n);
    const buffer = Buffer.alloc(Number(st.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireValue(bytesRead === buffer.length);
    const data = JSON.parse(buffer.toString('utf8'));
    return { ...data, modifiedAt: String(st.mtimeNs / 1000000000n) };
  });
}
/**
 * The keeper's lock refusal record beside its journal (`<state>.lock-refused.json`, packages/keeper/src/state.ts): no
 * file is the healthy state, since a start that takes the lock renames it aside; any other failure stays unknown.
 */
export async function keeperLock(path, json = readJson) {
  try { return { record: await json(path) }; }
  catch (e) { if (e?.code === 'ENOENT') return { absent: true }; throw e; }
}
function journalRecord(line) {
  requireValue(typeof line === 'string' && Buffer.byteLength(line) <= 65536);
  const entry = JSON.parse(line);
  requireValue(typeof entry.sequence === 'string' && /^[1-9][0-9]*$/.test(entry.sequence)
    && /^0x[0-9a-f]{64}$/.test(entry.entryHash) && /^0x[0-9a-f]{64}$/.test(entry.previousHash));
  return { recordedUtc: entry.record.recordedUtc, chainId: entry.record.chainId };
}
export async function readJournal(path) {
  return withFile(path, async (file, st) => {
    requireValue(st.size > 0n);
    const magic = Buffer.alloc(16); await file.read(magic, 0, 16, 0);
    if (magic.toString() === 'SQLite format 3\0') {
      const { DatabaseSync } = await import('node:sqlite');
      // The unit permits sidecar creation, but mounts this database read-only.
      // Never use immutable=1: it could miss committed entries in an active WAL.
      const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      let line;
      try {
        db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 3000;');
        line = db.prepare('SELECT substr(line, 1, 65537) AS line FROM journal ORDER BY sequence DESC LIMIT 1').get()?.line;
      } finally { db.close(); }
      let modified = st.mtimeNs;
      // An empty WAL created by our read is not a fresh burn-bot journal append.
      try { const wal = await withFile(path + '-wal', async (_f, w) => w.size > 0n ? w.mtimeNs : 0n); if (wal > modified) modified = wal; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      requireValue(typeof line === 'string' && line.endsWith('\n'));
      return { modifiedAt: String(modified / 1000000000n), record: journalRecord(line) };
    }
    const size = Number(st.size < 65536n ? st.size : 65536n);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, st.size - BigInt(size));
    requireValue(bytesRead === size && buffer.at(-1) === 10);
    const lines = buffer.toString('utf8').split('\n'); const line = lines.at(-2);
    requireValue(line && (lines.length > 2 || st.size <= 65536n));
    return { modifiedAt: String(st.mtimeNs / 1000000000n), record: journalRecord(line) };
  });
}
export async function latestBackup(dir) {
  const names = await readdir(dir); requireValue(names.length <= 10000);
  let newest = null;
  for (const name of names.filter(n => /^history-\d{8}T\d{6}Z\.dump$/.test(n))) {
    const at = await withFile(join(dir, name), async (file, st) => {
      requireValue(st.size > 5n);
      const magic = Buffer.alloc(5); await file.read(magic, 0, 5, 0);
      requireValue(magic.toString() === 'PGDMP'); return st.mtimeNs / 1000000000n;
    });
    if (newest === null || at > newest) newest = at;
  }
  requireValue(newest !== null); return { modifiedAt: String(newest) };
}
export async function latestAlphaBackup(dir) {
  const names = await readdir(dir); requireValue(names.length <= 10000);
  const completed = names.filter(n => /^alpha-\d{8}T\d{6}Z$/.test(n)).sort();
  requireValue(completed.length > 0);
  const manifest = await readJson(join(dir, completed.at(-1), 'manifest.json'));
  requireValue(manifest.v === 1 && manifest.sqlite === true && Array.isArray(manifest.files)
    && manifest.files.some(f => f.path === 'state/alpha.sqlite' && /^[a-f0-9]{64}$/.test(f.sha256)));
  const at = Date.parse(manifest.at); requireValue(Number.isSafeInteger(at));
  return { modifiedAt: String(BigInt(at) / 1000n) };
}
export const files = {
  json: readJson, alphaBackup: latestAlphaBackup, journal: readJournal, backup: latestBackup,
  disk: async path => { const s = await statfs(path, { bigint: true }); return { total: String(s.blocks * s.bsize), available: String(s.bavail * s.bsize) }; },
  memory: async () => {
    const text = await readFile('/proc/meminfo', 'utf8');
    const total = /^MemTotal:\s+(\d+) kB$/m.exec(text), available = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
    requireValue(total && available); return { total: String(BigInt(total[1]) * 1024n), available: String(BigInt(available[1]) * 1024n) };
  },
};
const hex = s => { requireValue(typeof s === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(s)); return BigInt(s).toString(); };
export async function readRpc(c, env, request = boundedRequest, balance = true) {
  requireValue(c.chainId === '11155111' || (c.chainId === '1' && env.SH_MONITOR_ALLOW_MAINNET === '1'));
  const url = httpsUrl(env.SH_MONITOR_RPC_URL).href;
  let id = 0;
  const rpc = async (method, params) => {
    const callId = ++id;
    const r = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) });
    requireValue(r.status === 200); const j = JSON.parse(r.body);
    requireValue(j.jsonrpc === '2.0' && j.id === callId && !j.error); return j.result;
  };
  const chainId = hex(await rpc('eth_chainId', [])); requireValue(chainId === c.chainId);
  const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
  const result = { chainId, block: hex(block.number), timestamp: hex(block.timestamp) };
  if (balance) result.balanceWei = hex(await rpc('eth_getBalance', [c.keeperAddress, 'finalized']));
  return result;
}
export async function collect(c, env, now, ports = {}) {
  const started = (ports.clock ?? Date.now)();
  requireValue(c.chainId === '11155111' || (c.chainId === '1' && env.SH_MONITOR_ALLOW_MAINNET === '1'));
  const request = ports.request ?? boundedRequest, f = ports.files ?? files;
  const o = { heartbeat: heartbeatConfig(env) };
  const read = async (id, fn) => { try { o[id] = await fn(); } catch { /* Missing means unknown; exceptions never leave this boundary. */ } };
  const probe = async (url, json) => {
    const u = new URL(url); u.searchParams.set('sh_monitor', String(now));
    if (url === c.feedUrl) u.searchParams.set('chain', c.chainId);
    const r = await request(u.href, { method: 'GET', headers: { Origin: c.origin, 'Cache-Control': 'no-cache' } });
    return json ? { ...r, body: JSON.parse(r.body) } : r;
  };
  const primary = Promise.all([
    read('landing', () => probe(c.landingUrl, false)), read('api', () => probe(c.apiUrl, true)), read('feed', () => probe(c.feedUrl, true)),
    read('rpc', () => readRpc(c, env, request)),
    read('keeper', () => f.json(c.keeperFile)), read('view', () => f.json(c.keeperViewFile)),
    read('keeperLock', () => keeperLock(`${c.keeperFile}.lock-refused.json`, f.json)),
    read('journal', () => f.journal(c.journalFile)), read('disk', () => f.disk(c.diskPath)),
    read('memory', () => f.memory()), read('backup', () => f.backup(c.backupDir)),
    ...(c.alphaApiEnabled ? [read('alphaApiHealth', () => probe(c.alphaApiUrl, true)), read('alphaApi', () => f.json(c.alphaApiFile)), read('alphaBackup', () => f.alphaBackup(c.backupDir))] : []),
    ...(c.alphaSenderEnabled ? [read('alphaSender', () => f.json(c.alphaSenderFile))] : []),
  ]);
  const setReads = c.keeperSetEnabled ? Promise.all([
    read('keeperSet', () => f.json(c.keeperSetFile)), read('keeperSetView', () => f.json(c.keeperSetViewFile)),
    read('keeperSetLock', () => keeperLock(`${c.keeperSetFile}.lock-refused.json`, f.json)),
    read('keeperSetRpc', () => readRpc({ ...c, keeperAddress: c.keeperSetAddress }, env, request)),
  ]) : Promise.resolve();
  // The new instance must not spend the original drand collector's elapsed-time budget waiting on set I/O.
  await primary;
  if (o.rpc) await read('drand', () => readDrand(c, env, o.rpc, { request, clock: ports.clock, started }));
  await setReads;
  return o;
}
