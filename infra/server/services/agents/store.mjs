import { constants, openSync, closeSync, fstatSync, fsyncSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { raw, requireThat } from './policy.mjs';

export function readBounded(file, limit = 1024 * 1024) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd); requireThat(s.isFile() && s.size > 0 && s.size <= limit, 'file refused');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
export function writeAtomic(file, value) {
  const fd = openSync(`${file}.new`, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(`${file}.new`, file);
  const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function openStore(root, identity) {
  const lock = join(root, 'state/agents.lock'), file = join(root, 'state/journal.json');
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw new Error('agents lock held'); }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
  let closed = false, failed = false;
  const close = () => { if (!closed) { renameSync(lock, `${lock}.${randomUUID()}.released`); closed = true; } };
  const validate = s => {
    requireThat(s?.version === 1 && s.identity === identity && s.days && typeof s.days === 'object' && !Array.isArray(s.days)
      && Array.isArray(s.calls) && Array.isArray(s.actions) && Array.isArray(s.sends), 'journal refused');
    for (const [day, d] of Object.entries(s.days)) requireThat(/^\d{4}-\d{2}-\d{2}$/.test(day)
      && typeof d.halted === 'boolean' && ['cost', 'inputTokens', 'outputTokens'].every(k => raw(d[k])), 'journal refused');
    requireThat(new Set(s.actions.map(a => a.key)).size === s.actions.length, 'journal refused');
    for (const a of s.actions) requireThat(typeof a.key === 'string' && /^(dry-run|live):[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(a.key)
      && ['dry-run', 'live'].includes(a.mode) && a.key.startsWith(`${a.mode}:`) && /^[a-f0-9]{64}$/.test(a.jobHash)
      && ['model-pending', 'decision-accepted', 'refused', 'model-unknown', 'dry-run', 'complete', 'allowance-low', 'payment-pending', 'payment-failed'].includes(a.status), 'journal refused');
    for (const s1 of s.sends) requireThat(typeof s1.raw === 'string' && /^0x[0-9a-f]+$/.test(s1.raw)
      && /^0x[0-9a-f]{64}$/.test(s1.hash) && Number.isSafeInteger(s1.nonce) && s1.nonce >= 0
      && ['broadcast-unknown', 'submitted', 'confirmed', 'reverted'].includes(s1.status)
      && s.actions.some(a => a.key === s1.key && a.decision?.action === 'pay'), 'journal refused');
    const totals = {};
    requireThat(s.calls.length === s.actions.length && new Set(s.calls.map(c => c.actionKey)).size === s.calls.length
      && new Set(s.sends.map(tx => tx.key)).size === s.sends.length, 'journal refused');
    for (const c of s.calls) {
      requireThat(s.actions.some(a => a.key === c.actionKey) && Object.hasOwn(s.days, c.day)
        && /^[a-f0-9]{64}$/.test(c.promptHash) && raw(c.cost) && ['manager', 'bookkeeper'].includes(c.role)
        && ['reserved', 'unknown', 'answered', 'refused', 'usage-exceeded'].includes(c.status)
        && ((c.inputTokens === null && c.outputTokens === null) || (raw(c.inputTokens) && raw(c.outputTokens))), 'journal refused');
      const sum = totals[c.day] ??= { cost: 0n, inputTokens: 0n, outputTokens: 0n };
      for (const key of ['cost', 'inputTokens', 'outputTokens']) sum[key] += BigInt(c[key] ?? '0');
    }
    for (const a of s.actions.filter(a => a.status === 'decision-accepted')) {
      const call = s.calls.find(c => c.actionKey === a.key);
      requireThat(call.status === 'answered' && ['pay', 'reply', 'statement'].includes(a.decision?.action)
        && isDeepStrictEqual(call.decision, a.decision) && !s.sends.some(tx => tx.key === a.key), 'journal refused');
    }
    for (const [day, d] of Object.entries(s.days)) for (const key of ['cost', 'inputTokens', 'outputTokens']) {
      requireThat(BigInt(d[key]) === (totals[day]?.[key] ?? 0n), 'journal refused');
    }
    return s;
  };
  try {
    let state;
    try { state = validate(JSON.parse(readBounded(file, 32 * 1024 * 1024))); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('journal refused', { cause: e }); state = { version: 1, identity, days: {}, calls: [], actions: [], sends: [] }; }
    return { state, close, assertUsable() { requireThat(!closed && !failed, 'journal unavailable'); }, save() {
      this.assertUsable();
      try {
        validate(state); requireThat(Buffer.byteLength(JSON.stringify(state)) <= 32 * 1024 * 1024, 'journal capacity reached');
        writeAtomic(file, state);
      } catch { failed = true; throw new Error('journal write failed'); }
    } };
  } catch (e) { close(); throw e; }
}
