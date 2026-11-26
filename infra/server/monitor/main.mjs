import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { configure, heartbeatConfig, requireValue } from './config.mjs';
import { notifiers, pingHeartbeat } from './notify.mjs';
import { runOnce } from './runtime.mjs';
import { readRpc } from './collect.mjs';
import { ladder, readDrand } from './drand.mjs';
import { realpathSync } from 'node:fs';
export async function main(args = process.argv.slice(2), env = process.env, ports = {}) {
  let mode, config;
  const write = ports.write ?? (s => process.stdout.write(s)), error = ports.error ?? (s => process.stderr.write(s));
  const senders = () => ports.senders ?? notifiers(env, config?.stateDir, config?.channels);
  try {
    requireValue(['--dry-run', '--run', '--notify-test', '--drand'].includes(args[0])); mode = args[0];
    requireValue(args.length === 1 || (args.length === 3 && args[1] === '--config'));
    const file = args[2] ?? env.SH_MONITOR_CONFIG ?? '/etc/squarehole/monitor.json';
    config = configure(await (ports.readConfig ?? (async file => JSON.parse(await readFile(file, 'utf8'))))(file), env);
    if (mode === '--dry-run') {
      write(`monitor dry-run: configuration valid; ${(config.keeperSetEnabled ? 25 : 18) + (config.alphaSenderEnabled ? 1 : 0) + (config.alphaApiEnabled ? 5 : 0)} checks; no probes, notifications or state writes\n`);
      write(heartbeatConfig(env).configured ? 'heartbeat configured\n' : 'heartbeat not configured\n'); return 0;
    }
    if (mode === '--drand') {
      const now = ports.now ?? BigInt(Math.floor(Date.now() / 1000));
      const rpc = await readRpc(config, env, ports.request, false);
      const drand = await readDrand(config, env, rpc, ports);
      const rows = [...ladder(drand, config, now), { id: 'drand-canary', ...drand.canary }];
      for (const r of rows) write(`${r.id}: ${r.status} (${r.reason})${r.detail ? '; ' + r.detail : ''}\n`);
      return rows.some(r => r.status === 'unknown') ? 2 : rows.some(r => r.status !== 'ok') ? 1 : 0;
    }
    if (mode === '--notify-test') {
      const results = await Promise.allSettled(Object.values(senders()).map(send => send('Square Hole monitor: DELIVERY TEST\nConfirm receipt with the founder. No health claim.')));
      const ok = results.every(r => r.status === 'fulfilled');
      write(ok ? 'notification test accepted by all channels\n' : 'notification test failed\n');
      const heartbeat = await pingHeartbeat(env, ports.request);
      write(`heartbeat ${heartbeat}\n`); return ok && heartbeat !== 'failed' ? 0 : 2;
    }
    const result = await runOnce(config, env, ports);
    write(JSON.stringify(result) + '\n'); return result.code;
  } catch {
    // A broken config/state file must not silently kill alerting. Repeats until repaired; no all-clear state is advanced.
    if (mode === '--run') {
      try { await Promise.allSettled(Object.values(senders()).map(send => send('Square Hole monitor: INTERNAL FAILURE\nCheck configuration, state storage and service journal. Health is unknown.'))); }
      catch { /* Missing notification configuration remains a service failure. */ }
    }
    error('monitor failed: check configuration, storage and channel settings; details suppressed\n'); return 2;
  }
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) process.exitCode = await main();
