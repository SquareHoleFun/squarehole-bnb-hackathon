import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { settings, HEALTH_FILE, healthy, publishHealth, runLoop, CYCLE_TIMEOUT_MS, STOP_BUDGET_MS } from './runtime.mjs';

try {
  const [service, action, expected, ...extra] = process.argv.slice(2);
  if (extra.length || ![undefined, '--dry-run', '--healthcheck'].includes(action)
      || (expected && (action !== '--healthcheck' || !['disabled', 'dry-run', 'live'].includes(expected)))) throw new Error();
  const cfg = settings(service, process.env);
  if (action === '--dry-run') {
    process.stdout.write(`${service}: offline plan; no files, credentials, RPC, signer or state accessed\n`);
  } else if (action === '--healthcheck') {
    const record = JSON.parse(readFileSync(HEALTH_FILE, 'utf8'));
    if (!healthy(record, cfg) || (expected && expected !== (cfg.enabled ? cfg.mode : 'disabled'))) throw new Error();
    process.stdout.write(`${service}: ${cfg.enabled ? cfg.mode : 'disabled'}; health current\n`);
  } else {
    publishHealth({ service, mode: cfg.mode, status: 'starting', at: Date.now() });
    const controller = new AbortController();
    let driver;
    let stopTimer;
    const armStop = () => {
      if (driver?.release && stopTimer === undefined) stopTimer = setTimeout(() => {
        try { driver.release(); } finally { process.exit(0); }
      }, STOP_BUDGET_MS);
    };
    const stop = () => { controller.abort(); armStop(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    // An unresolved RPC or signer must not be retried concurrently. Termination preserves durable reservations.
    const timed = async (fn, cooperative = false) => {
      // Reveal cancels requests at three minutes and has one minute to unwind its checkpoint locks.
      const deadline = new AbortController();
      const cancel = cooperative ? setTimeout(() => deadline.abort(), CYCLE_TIMEOUT_MS * 0.75) : undefined;
      const timer = setTimeout(() => { process.stderr.write(`${service}: cycle timed out\n`); try { driver?.release?.(); } finally { process.exit(1); } }, CYCLE_TIMEOUT_MS);
      try { return await fn(AbortSignal.any([controller.signal, deadline.signal])); }
      finally { clearTimeout(cancel); clearTimeout(timer); }
    };
    driver = cfg.enabled ? await timed(async () => {
      const { createDriver } = await import(`./${service}.mjs`);
      return createDriver(process.env, cfg);
    }) : {};
    if (controller.signal.aborted) armStop();
    const cycle = () => timed(signal => driver.cycle({ signal }), service === 'reveal');
    process.stdout.write(`${service}: ${cfg.enabled ? cfg.mode : 'disabled'}\n`);
    try {
      await runLoop(cfg, { cycle, close: () => driver.close?.(), notes: () => driver.notes?.() ?? {} }, {
        stopped: () => controller.signal.aborted,
        sleep: async (ms) => { try { await wait(ms, undefined, { signal: controller.signal }); } catch { /* stop */ } },
      });
    } finally { clearTimeout(stopTimer); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
} catch {
  process.stderr.write('service refused; check operator settings, mounted files and availability; details suppressed\n');
  process.exitCode = 1;
}
