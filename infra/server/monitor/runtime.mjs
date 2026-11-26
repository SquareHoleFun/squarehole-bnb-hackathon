import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, collect } from './collect.mjs';
import { evaluate } from './policy.mjs';
import { dispatch, validateState } from './delivery.mjs';
import { notifiers, pingHeartbeat } from './notify.mjs';
export class StateStore {
  constructor(dir) { this.dir = dir; this.path = join(dir, 'state.json'); }
  async load() {
    try { const s = validateState(await readJson(this.path)); return { version: s.version, channels: s.channels }; }
    catch (e) { if (e.code === 'ENOENT') return { version: 1, channels: {} }; }
    throw new Error('monitor state unavailable');
  }
  async save(state) {
    validateState(state);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `state.${randomUUID()}.pending`);
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(tmp, this.path);
    const dir = await open(this.dir, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
}
export async function runOnce(c, env, ports = {}) {
  const now = ports.now ?? BigInt(Math.floor(Date.now() / 1000));
  const store = ports.store ?? new StateStore(c.stateDir);
  const state = await store.load();
  const report = evaluate(await (ports.collect ?? collect)(c, env, now, ports), c, now);
  const failedChannels = await dispatch(report, state, ports.senders ?? notifiers(env, c.stateDir, c.channels), now, c, s => store.save(s));
  let code = failedChannels.length ? 2 : report.some(x => x.status !== 'ok') ? 1 : 0;
  const heartbeat = code === 2 ? 'skipped' : await pingHeartbeat(env, ports.request);
  if (heartbeat === 'failed') code = 2;
  return { code, report, failedChannels, heartbeat };
}
