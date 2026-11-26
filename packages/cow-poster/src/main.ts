import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CowHttp } from './api';
import { rpcReader, RpcChain } from './chain';
import { loadConfig, loadManifest, loadPaths, loadService } from './config';
import { Poster, nextCycleDelay } from './poster';
import { FileReservations, jsonLog, writeHealth } from './state';

/** A disabled poster rewrites its health this often, well inside the container check's staleness bound. */
const DISABLED_HEALTH_MS = 30_000;
const log = jsonLog();
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
const sleep = async (ms: number) => { await delay(ms, undefined, { signal: stop.signal }); };
let healthFile: string | undefined;
let stage = 'config';
try {
  const service = loadService(process.env);
  healthFile = loadPaths(process.env).healthFile;
  if (!service.enabled) {
    // The stack's worker rule: without its private env file the poster is disabled. It reads no other setting,
    // no manifest and no RPC, and stays healthy so the hosting stack can ship before its inputs exist.
    stage = 'disabled';
    log('disabled', { mode: service.mode });
    while (!stop.signal.aborted) {
      await writeHealth(healthFile, { phase: 'disabled', mode: service.mode, updatedAt: Date.now() });
      await sleep(DISABLED_HEALTH_MS);
    }
  } else {
    const config = loadConfig(process.env);
    healthFile = config.healthFile;
    stage = 'manifest';
    const manifest = loadManifest(JSON.parse(await readFile(config.manifestPath, 'utf8')) as unknown, config.chainId);
    stage = 'rpc_chain';
    const chain = new RpcChain(rpcReader(config.rpcUrl), manifest);
    if (await chain.chainId() !== config.chainId) throw new Error('RPC chain mismatch');
    const api = new CowHttp(config.apiBase, { now: Date.now, sleep, random: Math.random }, log, fetch, stop.signal);
    const poster = new Poster({ chain, api, store: new FileReservations(config.stateDir, config.chainId),
      chainId: config.chainId, feeBps: config.feeBps, mode: config.mode, now: Date.now, log, signal: stop.signal,
      cycleMs: config.cycleMs, health: health => writeHealth(config.healthFile, health) });
    log('started', { chainId: config.chainId, cycleMs: config.cycleMs, feeBps: config.feeBps.toString(), mode: config.mode });
    while (!stop.signal.aborted) {
      stage = 'cycle';
      const start = Date.now();
      await poster.cycle();
      await sleep(nextCycleDelay(config.cycleMs, Date.now() - start, Date.now()));
    }
  }
} catch {
  // A supervisor restarts on startup and storage failures and on a third failed cycle in a row (a failed RPC read
  // otherwise only ends its cycle, Poster.rpc); reserved UIDs survive every restart.
  if (!stop.signal.aborted) { log('fatal', { stage }); process.exitCode = 1; }
} finally {
  if (healthFile) {
    try { await writeHealth(healthFile, { phase: stop.signal.aborted ? 'stopped' : 'fatal', stage, updatedAt: Date.now() }); }
    catch { log('health_write_failed'); process.exitCode = 1; }
  }
}
