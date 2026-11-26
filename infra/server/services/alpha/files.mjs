import { constants, openSync, fstatSync, readFileSync, closeSync, writeFileSync, renameSync, fsyncSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { need } from './auth.mjs';

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function boundedFile(path, maximum) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = fstatSync(fd); need(stat.isFile() && stat.size <= maximum, 503, 'file refused'); return readFileSync(fd, 'utf8'); }
  finally { closeSync(fd); }
}
const syncDirectory = path => { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } };
/** Caller holds the SQLite write transaction, including at startup. Never replace an existing claim. */
export function publishClaim(directory, payload) {
  const claim = JSON.parse(payload); need(uuid.test(claim.id), 503);
  const final = join(directory, `${claim.id}.json`);
  try {
    lstatSync(final);
    need(boundedFile(final, 16384) === `${payload}\n`, 503, 'queue conflict');
    syncDirectory(directory); return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.${claim.id}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o640);
  try { writeFileSync(fd, `${payload}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, final); syncDirectory(directory);
}
export function receipt(directory, id) {
  return readStatus(directory, id, false);
}
/** Mutable progress is separate from final receipts. It never releases a reservation. */
export function claimProgress(directory, id) {
  const final = receipt(directory, id);
  if (final) return final;
  const progress = readStatus(directory, id, true);
  return progress ?? { id, status: 'queued' };
}
function readStatus(directory, id, progress) {
  need(uuid.test(id), 404);
  let raw;
  try { raw = boundedFile(join(directory, `${id}${progress ? '.progress' : ''}.json`), 8192); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const r = JSON.parse(raw);
  need(r && Object.keys(r).filter(k => !(progress && k === 'floatPausedMs')).sort().join(',') === 'admitTx,at,id,reason,sendTx,status,v' && r.v === 1 && r.id === id
    && (progress ? ['queued', 'waiting', 'sending'] : ['sent', 'skipped', 'refused', 'failed']).includes(r.status), 503, 'receipt refused');
  if (progress && Object.hasOwn(r, 'floatPausedMs')) need(Number.isSafeInteger(r.floatPausedMs) && r.floatPausedMs >= 0, 503, 'progress refused');
  if (progress) need(r.admitTx === null && r.sendTx === null
    && r.reason === (r.status === 'waiting' ? 'insufficient float for starter and gas' : null), 503, 'progress refused');
  for (const field of ['admitTx', 'sendTx']) need(r[field] === null || (typeof r[field] === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r[field])), 503, 'receipt refused');
  need(r.reason === null || (typeof r.reason === 'string' && r.reason.length <= 2048), 503, 'receipt refused');
  need(typeof r.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.]\d{1,9})?Z$/.test(r.at)
    && Number.isFinite(Date.parse(r.at)) && new Date(r.at).toISOString().slice(0, 19) === r.at.slice(0, 19), 503, 'receipt refused');
  return r;
}
