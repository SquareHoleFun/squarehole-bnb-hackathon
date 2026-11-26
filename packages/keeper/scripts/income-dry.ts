/**
 * SH-247: a keyless, read-only dry run of this keeper's income reading against one endpoint, by hand. It reads its
 * settings only from the process environment (never a file), refuses to start with a key there, never signs or sends,
 * contacts no drand relay and writes no journal, monitor view or other file. Endpoint text is never printed.
 *
 *   SH_KEEPER_RPC_URL=... SH_KEEPER_ADDRESS=0x... SH_KEEPER_BOX_REGISTRY=0x... SH_KEEPER_FROM_BLOCK=... \
 *   SH_KEEPER_DESTINATION_FORK=amsterdam SH_KEEPER_TRANSACTION_GAS_CAP=16777216 \
 *   pnpm --filter @squarehole/keeper income:dry [rounds, default 1, at most 20] [--income]
 *
 * With `--income` it needs no keeper state and plans nothing: each round reads the boxes, then the income alone, and
 * prints one JSON line with the round's wall time, the RPC calls by method, every refusal's own text (code and the
 * node's words), and per box the income (share and tips in wei, or its failure code) and, where the reader keeps them,
 * its rows, reads and receipt rows against their limits. It uses only entry points the line before SH-247 also has, so
 * the same file runs on a checkout of that line for a side-by-side comparison. Without `--income` it runs the keeper's
 * runner in dry mode and also prints the jobs it would send or defers, with codes. Rounds after the first wait
 * SH_KEEPER_POLL_MS (default 30,000 ms, the server's cadence), so each sees a new head.
 */
import { createPublicClient, defineChain, type Address, type PublicClient } from 'viem';
import { ViemChain, checkChainId } from '../src/chain';
import { destinationGasAdapters, loadConfig, secretsOf } from '../src/config';
import { IncomeCache, readIncome } from '../src/income-read';
import { makeLogger, type Logger } from '../src/log';
import { cryptoRng } from '../src/rng';
import { keeperTransport } from '../src/rpc';
import { runTick, type KeeperState } from '../src/run';
import { keeperContracts, keeperMulticall } from '../src/tick-reads';

const KEYS = ['SH_KEEPER_PRIVATE_KEY', 'SH_KEEPER_PRIVATE_SEND_KEY'] as const;
// Only the one endpoint: no fallback, no private gateway, no files written.
const DROPPED = [...KEYS, 'SH_KEEPER_PRIVATE_RPC_URL', 'SH_KEEPER_RPC_FALLBACK_URL', 'SH_KEEPER_MONITOR_FILE', 'SH_KEEPER_STATE_FILE'];
type Box = { id: bigint; version: number; receiver: Address; coordinator: Address; hook: Address };
type BoxReads = { rows: number; rowsLimit: number; reads: number; readsLimit: number; receiptRows: number; receiptRowsLimit: number };
type Reads = { discoveryQueries: number; queries: number; rows: number; boxes: Record<string, BoxReads> } | null | undefined;

/** The node's own words of a refusal (JSON-RPC code, name, its message), never a URL or a request body. */
function refusal(error: unknown, url: string): string {
  const parts: string[] = [];
  for (let e = error as { name?: unknown; code?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown } | undefined, depth = 0;
    e && depth < 8; e = e.cause as typeof e, depth++) {
    const words = typeof e.details === 'string' ? e.details : typeof e.shortMessage === 'string' ? e.shortMessage : '';
    parts.push([typeof e.name === 'string' ? e.name : '', typeof e.code === 'number' ? `code ${e.code}` : '', words].filter(Boolean).join(' '));
  }
  return parts.filter(Boolean).join(' / ').split(url).join('<endpoint>').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 400);
}

/** Counts every client call by method this round and keeps the distinct refusals. */
function counting(pub: PublicClient, url: string) {
  const calls = new Map<string, number>();
  const refusals = new Set<string>();
  const client = new Proxy(pub, { get: (target, method, receiver) => {
    const value = Reflect.get(target, method, receiver) as unknown;
    if (typeof value !== 'function' || !/^(get|read|call|estimate)/.test(String(method))) return value;
    return async (...args: unknown[]) => {
      calls.set(String(method), (calls.get(String(method)) ?? 0) + 1);
      try { return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args); }
      catch (error) { if (refusals.size < 8) refusals.add(`${String(method)}: ${refusal(error, url)}`); throw error; }
    };
  } });
  return { client, calls, refusals, reset() { calls.clear(); refusals.clear(); } };
}

async function main() {
  if (KEYS.some(k => process.env[k])) throw new Error('income-dry runs without any key: unset the key variables first');
  const env: Record<string, string | undefined> = { ...Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !DROPPED.includes(k))), SH_KEEPER_DRY_RUN: '1' };
  const cfg = { ...loadConfig(env), dryRun: true, monitorFile: null };
  const args = process.argv.slice(2);
  const incomeOnly = args.includes('--income');
  const rounds = Math.min(20, Math.max(1, Number.parseInt(args.find(a => /^\d+$/.test(a)) ?? '1', 10) || 1));
  const wait = Number.parseInt(env.SH_KEEPER_POLL_MS ?? '', 10) || 30_000;
  const redacting = makeLogger(secretsOf(cfg), line => process.stderr.write(`${line}\n`));
  const log: Logger = { info() {}, warn: (m, d) => redacting.warn(m, d), error: (m, d) => redacting.error(m, d) };
  const chain = defineChain({ id: cfg.chainId, contracts: keeperContracts(cfg.chainId), name: `chain ${cfg.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: keeperTransport(cfg, { batch: { batchSize: 32, wait: 8 }, retryCount: 1, timeout: 15_000 },
    message => log.warn(message)), batch: keeperMulticall(cfg.chainId) });
  await checkChainId(pub, cfg.chainId, cfg.allowMainnet);
  const keeper: Address = cfg.keeperAddress ?? '0x000000000000000000000000000000000000dEaD';
  const g = destinationGasAdapters(cfg.destinationGas, pub);
  const port = new ViemChain(cfg, pub, keeper, { public: null, private: null }, null, log, g.reader, g.estimator,
    async () => { throw new Error('income-dry contacts no drand relay'); });
  const rpc = counting(pub, cfg.rpcUrl);
  const ownCache = new IncomeCache();
  let state: KeeperState = {};
  const line = (value: unknown) => process.stdout.write(`${JSON.stringify(value, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v)}\n`);
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) await new Promise(resolve => setTimeout(resolve, wait));
    if (incomeOnly) {
      const world = await port.read();
      const boxes = world.boxes.filter(b => b.version === 2) as readonly Box[];
      rpc.reset();
      const started = Date.now();
      let income: Awaited<ReturnType<typeof readIncome>> | null = null, failure: string | null = null;
      try { income = await readIncome(rpc.client, world.boxes, keeper, world.block.timestamp, cfg.fromBlock, [], ownCache); }
      catch (error) { failure = refusal(error, cfg.rpcUrl); }
      const reads = (ownCache as unknown as { reads?: Reads }).reads;
      line({ mode: 'income', round, block: world.block.number, wallMs: Date.now() - started, incomeRead: income !== null, failure,
        rpc: Object.fromEntries(rpc.calls), refusals: [...rpc.refusals],
        tick: reads ? { discoveryQueries: reads.discoveryQueries, queries: reads.queries, rows: reads.rows } : null,
        boxes: boxes.map(b => {
          const r = reads?.boxes[b.receiver.toLowerCase()], credit = income?.boxes[b.receiver.toLowerCase()];
          return { id: b.id, receiver: b.receiver, shareWei: credit?.shareWei ?? null, tipsWei: credit?.tipsWei ?? null,
            failure: income?.valuationFailures?.find(v => v.boxId === b.id)?.code ?? null,
            rows: r ? `${r.rows}/${r.rowsLimit}` : null, reads: r ? `${r.reads}/${r.readsLimit}` : null,
            receiptRows: r ? `${r.receiptRows}/${r.receiptRowsLimit}` : null };
        }) });
      continue;
    }
    // The adapter's own income cache: the same reader and per-box allowances the keeper runs with.
    const cache = (port as unknown as { incomeCache: { reads?: Reads } }).incomeCache;
    const started = Date.now();
    const out = await runTick(port, state, { ...cfg, keeper, privateEndpoint: false, rng: cryptoRng }, log);
    state = out.state;
    const income = out.observed.income;
    const world = port as unknown as { last: { boxes: readonly Box[] } | null };
    const boxes = (world.last?.boxes ?? []).filter(b => b.version === 2);
    const owns = (key: string, b: Box) => {
      const parts = key.toLowerCase().split(':');
      return parts[2] === String(b.id) || [b.receiver, b.coordinator, b.hook].some(a => parts.includes(a.toLowerCase()));
    };
    const reads = cache.reads;
    line({
      mode: 'tick', round, block: out.report.block, wallMs: Date.now() - started, incomeRead: income !== null,
      tick: reads ? { discoveryQueries: reads.discoveryQueries, queries: reads.queries, rows: reads.rows } : null,
      boxes: boxes.map(b => {
        const r = reads?.boxes[b.receiver.toLowerCase()];
        const credit = income?.boxes[b.receiver.toLowerCase()];
        return {
          id: b.id, receiver: b.receiver,
          income: credit ? { shareWei: credit.shareWei, tipsWei: credit.tipsWei } : null,
          failure: income?.valuationFailures?.find(v => v.boxId === b.id)?.code ?? null,
          rows: r ? `${r.rows}/${r.rowsLimit}` : null, reads: r ? `${r.reads}/${r.readsLimit}` : null,
          receiptRows: r ? `${r.receiptRows}/${r.receiptRowsLimit}` : null,
          wouldSend: out.report.sent.filter(s => owns(s.key, b)).map(s => s.key),
          deferred: out.report.skipped.filter(s => s.boxId === b.id || owns(s.key, b)).map(s => `${s.key} ${s.code}`),
        };
      }),
      otherJobs: { wouldSend: out.report.sent.filter(s => !boxes.some(b => owns(s.key, b))).map(s => s.key),
        deferred: out.report.skipped.filter(s => s.boxId === undefined && !boxes.some(b => owns(s.key, b))).map(s => `${s.key} ${s.code}`) },
    });
  }
}

main().catch((error: unknown) => {
  // Node error text can carry the endpoint: a message is printed only when it holds no URL and is short.
  const text = error instanceof Error ? error.message : '';
  const safe = text.length < 200 && !/[a-z][a-z0-9+.-]*:\/\//i.test(text) && !(process.env.SH_KEEPER_RPC_URL && text.includes(process.env.SH_KEEPER_RPC_URL));
  process.stderr.write(`income-dry failed: ${error instanceof Error ? error.constructor.name : 'error'}${safe && text ? `: ${text}` : ''}\n`);
  process.exitCode = 1;
});
