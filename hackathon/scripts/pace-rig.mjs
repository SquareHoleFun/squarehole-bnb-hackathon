#!/usr/bin/env node
/**
 * A rig for measuring the indexer and the keeper against a LOCAL chain (SH-259): a JSON-RPC proxy on 127.0.0.1 that
 * adds a fixed delay to every HTTP request (a public endpoint's round trip) and counts requests and calls by method,
 * and, optionally, a miner that mines one block every `--mine-ms` milliseconds on the local chain (anvil's own
 * `--block-time` takes whole seconds; BNB Chain testnet makes a block every 450 ms). Loopback only, both ways: it
 * refuses any target that is not on 127.0.0.1 or localhost, so it can never send anything to a real network.
 *
 *   node hackathon/scripts/pace-rig.mjs --target http://127.0.0.1:8572 --listen 8581 [--latency-ms 150] [--mine-ms 450]
 *     [--report <file>]
 *
 * Every 10 s, and at SIGINT or SIGTERM, it writes one JSON line: seconds since start, HTTP requests, JSON-RPC calls,
 * calls by method, blocks mined, and the requests and calls a second. --report also writes the last line to a file.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const target = new URL(option('target', ''));
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.protocol !== 'http:') {
  process.stderr.write('pace-rig: the target must be a local http://127.0.0.1:<port> chain\n');
  process.exit(2);
}
const listen = Number(option('listen', '0'));
const latency = Number(option('latency-ms', '0'));
const mineMs = Number(option('mine-ms', '0'));
const report = option('report', '');
if (!Number.isInteger(listen) || listen < 1024 || !Number.isFinite(latency) || latency < 0 || !Number.isFinite(mineMs) || mineMs < 0) {
  process.stderr.write('pace-rig: --listen <port above 1023>, --latency-ms and --mine-ms are non-negative numbers\n');
  process.exit(2);
}

let started = performance.now();
const counts = { requests: 0, calls: 0, mined: 0, mineErrors: 0, byMethod: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (method, params = []) => {
  const response = await fetch(target, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await response.json()).result;
};

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    counts.requests += 1;
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        counts.calls += 1;
        const method = typeof item?.method === 'string' ? item.method : 'unknown';
        counts.byMethod[method] = (counts.byMethod[method] ?? 0) + 1;
      }
    } catch { counts.byMethod.unparsed = (counts.byMethod.unparsed ?? 0) + 1; }
    if (latency > 0) await sleep(latency);
    try {
      const upstream = await fetch(target, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"local chain unavailable"}}');
    }
  });
});
server.listen(listen, '127.0.0.1');

let mining = mineMs > 0;
async function mine() {
  // One block every mineMs on the wall clock; a block that is late is not made up twice.
  let next = performance.now();
  while (mining) {
    next += mineMs;
    try { await call('evm_mine'); counts.mined += 1; } catch { counts.mineErrors += 1; }
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait); else next = performance.now();
  }
}
if (mining) void mine();

function line() {
  const seconds = (performance.now() - started) / 1000;
  return JSON.stringify({ seconds: Number(seconds.toFixed(1)), requests: counts.requests, calls: counts.calls,
    requestsPerSecond: Number((counts.requests / seconds).toFixed(2)), callsPerSecond: Number((counts.calls / seconds).toFixed(2)),
    mined: counts.mined, mineErrors: counts.mineErrors, latencyMs: latency, mineMs, byMethod: counts.byMethod });
}
const timer = setInterval(() => {
  const text = line();
  process.stdout.write(`${text}\n`);
  if (report) writeFileSync(report, `${text}\n`);
}, 10_000);
const stop = () => {
  mining = false;
  clearInterval(timer);
  const text = line();
  process.stdout.write(`${text}\n`);
  if (report) writeFileSync(report, `${text}\n`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// For a measurement of a while from now: reset the counters (requests and calls) without restarting.
process.on('SIGUSR1', () => { started = performance.now(); counts.requests = 0; counts.calls = 0; counts.byMethod = {}; });
