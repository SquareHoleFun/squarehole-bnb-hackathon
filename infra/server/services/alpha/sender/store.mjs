import { constants, openSync, closeSync, fstatSync, fsyncSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, linkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertNoForget, unfinishedForget } from '../forget-maintenance.mjs';
import { keccak256 } from './chain.mjs';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const raw = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
export function readBounded(file, size) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > size) throw new Error('file refused');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
export function atomicWrite(file, value, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.pending`;
  const fd = openSync(temp, 'wx', mode);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function validateJournal(state, identity) {
  if (state?.v !== 1 || state.identity !== identity || !Array.isArray(state.entries)) throw new Error('journal refused');
  if (state.nonceFloor !== undefined && (!Number.isSafeInteger(state.nonceFloor) || state.nonceFloor < 0)) throw new Error('journal refused');
  const ids = new Set(), xs = new Set(), addresses = new Set();
  for (const e of state.entries) {
    if (!e || !uuid.test(e.id) || ids.has(e.id) || typeof e.reserved !== 'boolean') throw new Error('journal refused');
    ids.add(e.id);
    if (e.pausedReason !== undefined && (e.pausedReason !== 'insufficient float for starter and gas'
      || !e.reserved || e.admit || e.send || e.outcome)) throw new Error('journal refused');
    if (e.reserved) {
      if (!raw(e.xId) || !address(e.address) || xs.has(e.xId) || addresses.has(e.address.toLowerCase())
        || !Array.isArray(e.days) || !e.days.length || !e.days.every(day) || new Set(e.days).size !== e.days.length
        || typeof e.needsAdmit !== 'boolean' || !e.quote
        || !['admitGas', 'sendGas', 'maxFeePerGas', 'maxPriorityFeePerGas'].every(k => raw(e.quote[k]))) throw new Error('journal refused');
      xs.add(e.xId); addresses.add(e.address.toLowerCase());
      for (const kind of ['admit', 'send']) {
        const tx = e[kind];
        if (tx && (tx.kind !== kind || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0
          || typeof tx.raw !== 'string' || !/^0x[0-9a-f]+$/.test(tx.raw) || keccak256(tx.raw) !== tx.hash)) throw new Error('journal refused');
      }
    } else if (!e.outcome) throw new Error('journal refused');
    if (e.outcome && (e.outcome.v !== 1 || e.outcome.id !== e.id || !['sent', 'skipped', 'refused', 'failed'].includes(e.outcome.status)
      || !Number.isFinite(Date.parse(e.outcome.at)) || ![null, 'string'].includes(e.outcome.reason === null ? null : typeof e.outcome.reason)
      || !['admitTx', 'sendTx'].every(k => e.outcome[k] === null || /^0x[0-9a-f]{64}$/.test(e.outcome[k])))) throw new Error('journal refused');
  }
  return state;
}
/** Retain the signing floor without retaining any forgotten claim or transaction. */
export function journalNonceFloor(state) {
  return Math.max(state.nonceFloor ?? 0, ...state.entries.flatMap(e => [e.admit, e.send]).filter(Boolean).map(tx => tx.nonce + 1));
}
/** Operator maintenance takes the very same lifetime lock as both sender modes. */
export function acquireSenderLock(directory, { operation, recover = false } = {}) {
  // One lock for BOTH modes. A restart never guesses whether a former process is still alive.
  const lock = join(directory, 'sender.lock');
  if (operation) {
    if (!uuid.test(operation)) throw new Error('operation refused');
    // The caller holds the manifest's SQLite hold. Only that proves the old command exited.
    if (recover) {
      let prior;
      try { prior = JSON.parse(readBounded(lock, 4096)); } catch (error) { if (error.code !== 'ENOENT') throw new Error('sender lock held', { cause: error }); }
      if (prior) {
        if (prior.operation !== operation) throw new Error('sender lock held');
        unlinkSync(lock);
      }
    }
    const temporary = join(directory, 'forget-tester.lock-prepare');
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ operation })); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, lock); } catch { unlinkSync(temporary); throw new Error('sender lock held'); }
    unlinkSync(temporary);
    let closed = false;
    return { close() { if (!closed) { unlinkSync(lock); closed = true; } } };
  }
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw new Error('sender lock held'); }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, id: randomUUID(), at: new Date().toISOString() })); fsyncSync(fd); }
  finally { closeSync(fd); }
  let closed = false;
  const close = () => { if (!closed) { renameSync(lock, `${lock}.${randomUUID()}.released`); closed = true; } };
  return { close };
}
export function openStore(directory, identity, mode, receipts) {
  if (receipts) {
    try { assertNoForget(receipts); }
    catch (error) { if (error.message === unfinishedForget) process.stderr.write(`${unfinishedForget}\n`); throw error; }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = acquireSenderLock(directory);
  let closed = false, failed = false;
  const assertUsable = () => { if (closed || failed) throw new Error('journal unavailable; restart required'); };
  const close = () => { if (!closed) { lock.close(); closed = true; } };
  const file = join(directory, mode === 'live' ? 'journal.json' : 'journal.dry.json');
  let state;
  try {
    try { state = validateJournal(JSON.parse(readBounded(file, 32 * 1024 * 1024)), identity); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('journal refused', { cause: error });
      state = { v: 1, identity, entries: [] };
    }
    return { state, close, assertUsable, save() {
      assertUsable();
      try { atomicWrite(file, validateJournal(state, identity)); }
      catch (error) { failed = true; throw error; }
    } };
  } catch (error) { close(); throw error; }
}
