import { join } from 'node:path';
import { atomicWrite } from './store.mjs';
import { claimProgress } from '../files.mjs';
import { FLOAT_REASON } from './settings.mjs';

// Persist transition time and completed float pauses, including across restart. Old SH-196 progress remains valid.
export function writeProgress(directory, id, status, now) {
  const prior = claimProgress(directory, id);
  if (prior.status === status && prior.at) return;
  const floatPausedMs = (prior.floatPausedMs ?? 0)
    + (prior.status === 'waiting' ? Math.max(0, now - Date.parse(prior.at)) : 0);
  atomicWrite(join(directory, `${id}.progress.json`), { v: 1, id, status,
    admitTx: null, sendTx: null, reason: status === 'waiting' ? FLOAT_REASON : null,
    at: new Date(now).toISOString(), floatPausedMs }, 0o640);
}
