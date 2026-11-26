/**
 * Records box 0's life on a local core v1 chain (S10a § 7.3) into two committed fixtures, from ONE live run:
 *
 * 1. packages/indexer/test/fixtures/core-local-life.json: every header, every log of the chain, every `eth_getCode` and
 *    `eth_call` the core service made (its code checks and audits, recorded through a recording reader), the hook's
 *    `phase()` at every block from the creation block on (BC-081), and `registry.recordOf(0)` at the head (the row from
 *    the logs must equal it). The indexer tests replay it (test/core-life.test.ts) with nothing running.
 * 2. apps/web/e2e/fixtures/core-local/life.json: the gateway's answers (feed, box, activity, candles, wallets) after
 *    every stage of the life, and the local core manifest the app is built with; the hermetic `pnpm e2e` answers the
 *    app's requests from it (no chain, no service).
 *
 * Starts its own anvil (port SH_RECORD_CHAIN_PORT, default 8559) and gateway (SH_RECORD_GATEWAY_PORT, default 5398),
 * both checked free first; stops both at the end. Local only; no key (anvil's unlocked accounts sign).
 *
 *   pnpm --filter @squarehole/indexer record:core-fixture
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoreManifest, type DeployedCoreManifest } from '@squarehole/chain';
import { boxHookAbi, boxRegistryAbi } from '@squarehole/chain/abi';
import { encodeFunctionData, decodeFunctionResult, type Abi, type Address, type Hex } from 'viem';
import { startLocalCoreChain, type LifeStage } from '../../chain/scripts/local-core-chain.mjs';
import { fromRpcLog } from '../src/chain-reader';
import { RpcCoreReader, type BlockAnchor, type CoreReader, type LogFilter } from '../src/core/core-reader';
import { startCoreService } from '../src/core/core-service';
import { CONTRACT_PHASE } from '../src/core/derive-core';
import type { RawLog } from '../src/events';
import { MemoryHistory } from '../src/history/memory-history';
import { HistoryWriter } from '../src/history/writer';
import type { BlockHeader } from '../src/model';
import { toJson } from '../src/model';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const INDEXER_FIXTURE = join(REPO, 'packages/indexer/test/fixtures/core-local-life.json');
const WEB_FIXTURE_DIR = join(REPO, 'apps/web/e2e/fixtures/core-local');

/** Records every code and call answer the service gets, keyed for the scripted replay. */
class RecordingReader implements CoreReader {
  readonly codes = new Map<string, Hex>();
  readonly calls = new Map<string, Hex>();
  constructor(private readonly inner: CoreReader) {}
  chainId(): Promise<number> {
    return this.inner.chainId();
  }
  observeHead(header: BlockHeader): void { this.inner.observeHead?.(header); }
  latestHeader(): Promise<BlockHeader> {
    return this.inner.latestHeader();
  }
  headerByNumber(n: bigint): Promise<BlockHeader | null> {
    return this.inner.headerByNumber(n);
  }
  headerByHash(h: Hex): Promise<BlockHeader | null> {
    return this.inner.headerByHash(h);
  }
  logsByHash(h: Hex, f: LogFilter): Promise<readonly RawLog[]> {
    return this.inner.logsByHash(h, f);
  }
  rangeLogs(a: bigint, b: bigint, f: LogFilter, anchors?: readonly BlockAnchor[]): Promise<readonly RawLog[]> {
    return this.inner.rangeLogs(a, b, f, anchors);
  }
  async codeAt(address: Address, blockHash: Hex): Promise<Hex> {
    const code = await this.inner.codeAt(address, blockHash);
    this.codes.set(`${address.toLowerCase()}@${blockHash.toLowerCase()}`, code);
    return code;
  }
  async callAt(to: Address, data: Hex, blockHash: Hex): Promise<Hex> {
    const result = await this.inner.callAt(to, data, blockHash);
    this.calls.set(`${to.toLowerCase()}|${data.toLowerCase()}|${blockHash.toLowerCase()}`, result);
    return result;
  }
  finality() {
    return this.inner.finality();
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const chainPort = Number(process.env.SH_RECORD_CHAIN_PORT ?? 8559);
const gatewayPort = Number(process.env.SH_RECORD_GATEWAY_PORT ?? 5398);
if (!(await portFree(gatewayPort))) throw new Error(`port ${gatewayPort} is in use; set SH_RECORD_GATEWAY_PORT`);
const out = join(REPO, '.local/core-record');
mkdirSync(out, { recursive: true });

const chain = await startLocalCoreChain({ port: chainPort, outDir: out, log: (l: string) => console.warn(l.length > 200 ? `${l.slice(0, 200)}…` : l) });
const manifest = parseCoreManifest(JSON.parse(readFileSync(chain.manifest, 'utf8'))) as DeployedCoreManifest;
const reader = new RecordingReader(new RpcCoreReader({ urls: [chain.rpcUrl] }));
const history = new MemoryHistory();
const writer = new HistoryWriter(history);
const service = await startCoreService({ manifest, reader, port: gatewayPort, host: '127.0.0.1', pollMs: 150, auditEvery: 32, onHistory: writer.accept, history: { get version() { return history.version; }, activityPage: (c, t, o) => history.activityPage(c, t, o), candles: (c, t, i, l) => history.candles(c, t, i, l) } });
const gateway = `http://127.0.0.1:${gatewayPort}`;
const token = chain.token.toLowerCase();
const get = async (path: string): Promise<unknown> => {
  const response = await fetch(`${gateway}${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const caughtUp = async (): Promise<void> => {
  const target = BigInt((await rpc(chain.rpcUrl, 'eth_blockNumber')) as string);
  for (let i = 0; i < 400; i += 1) {
    if ((service.indexer.head()?.number ?? 0n) >= target) break;
    await sleep(50);
  }
  await service.indexer.idle();
  if ((service.indexer.head()?.number ?? 0n) < target) throw new Error(`the indexer did not reach block ${target}`);
};

const stages: Record<string, unknown> = {};
try {
  await chain.life({
    until: 'stream',
    onStage: async (name: LifeStage) => {
      await caughtUp();
      await service.indexer.audit();
      await writer.flush();
      const answers = {
        block: service.indexer.head()?.number.toString(),
        feed: await get(`/v1/feed?chain=${chain.chainId}`),
        box: await get(`/v1/boxes/${chain.chainId}/${token}`),
        activity: await get(`/v1/boxes/${chain.chainId}/${token}/activity?limit=50`),
        candles: await get(`/v1/boxes/${chain.chainId}/${token}/candles?interval=1h`),
        wallets: Object.fromEntries(await Promise.all((['alice', 'bob', 'carol'] as const).map(async (who) => [who, await get(`/v1/wallets/${chain.chainId}/${chain.accounts[who]}`)] as const))),
      };
      const box = answers.box as { phase: string; verified: boolean | null; audit: { mismatches: string[] } | null };
      console.warn(`recorded ${name}: block ${answers.block}, phase ${box.phase}, verified ${String(box.verified)}${box.audit?.mismatches.length ? ` (${box.audit.mismatches.join('; ')})` : ''}`);
      stages[name] = answers;
    },
  });
  await caughtUp();
  const head = BigInt((await rpc(chain.rpcUrl, 'eth_blockNumber')) as string);

  // Every header and every log of the chain.
  const headers: unknown[] = [];
  for (let n = 0n; n <= head; n += 1n) {
    const b = (await rpc(chain.rpcUrl, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false])) as { number: Hex; hash: Hex; parentHash: Hex; timestamp: Hex };
    headers.push({ number: BigInt(b.number).toString(), hash: b.hash, parentHash: b.parentHash, timestamp: BigInt(b.timestamp).toString() });
  }
  const rawLogs = (await rpc(chain.rpcUrl, 'eth_getLogs', [{ fromBlock: '0x0', toBlock: `0x${head.toString(16)}` }])) as Parameters<typeof fromRpcLog>[0][];
  const logs = rawLogs.map(fromRpcLog).map((l) => ({ ...l, blockNumber: l.blockNumber.toString() }));

  // BC-081: the contract's phase at every block from the creation block (the hook's own view).
  const phases: Record<string, string> = {};
  const phaseData = encodeFunctionData({ abi: boxHookAbi as Abi, functionName: 'phase' } as never);
  for (let n = chain.creationBlock; n <= head; n += 1n) {
    const raw = (await rpc(chain.rpcUrl, 'eth_call', [{ to: chain.hook, data: phaseData }, `0x${n.toString(16)}`])) as Hex;
    phases[n.toString()] = CONTRACT_PHASE[Number(decodeFunctionResult({ abi: boxHookAbi as Abi, functionName: 'phase', data: raw } as never))] ?? 'unknown';
  }
  const recordOf0 = (await rpc(chain.rpcUrl, 'eth_call', [{ to: chain.registry, data: encodeFunctionData({ abi: boxRegistryAbi as Abi, functionName: 'recordOf', args: [0n] } as never) }, 'latest'])) as Hex;

  const fixture = {
    schema: 'sh.core-local-life/v1',
    about: 'Recorded by packages/indexer/scripts/record-core-fixture.ts from box 0 on a local core v1 chain (anvil, Sepolia twin); replayed by test/core-life.test.ts',
    chainId: chain.chainId,
    manifest,
    accounts: chain.accounts,
    contracts: { registry: chain.registry, token: chain.token, hook: chain.hook, coordinator: chain.coordinator, tickets: chain.tickets },
    creationBlock: chain.creationBlock.toString(),
    openAt: chain.openAt.toString(),
    windowEndsAt: chain.windowEndsAt.toString(),
    stages: chain.stages,
    head: head.toString(),
    headers,
    logs,
    codes: Object.fromEntries(reader.codes),
    calls: Object.fromEntries(reader.calls),
    phases,
    recordOf0,
  };
  mkdirSync(dirname(INDEXER_FIXTURE), { recursive: true });
  writeFileSync(INDEXER_FIXTURE, `${toJson(fixture)}\n`);
  mkdirSync(WEB_FIXTURE_DIR, { recursive: true });
  writeFileSync(join(WEB_FIXTURE_DIR, 'manifest-11155111.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(WEB_FIXTURE_DIR, 'life.json'), `${toJson({ schema: 'sh.core-web-life/v1', chainId: chain.chainId, token, accounts: chain.accounts, stages })}\n`);
  console.warn(`wrote ${INDEXER_FIXTURE} (${headers.length} headers, ${logs.length} logs, ${reader.calls.size} calls, ${reader.codes.size} codes) and ${WEB_FIXTURE_DIR}`);
} finally {
  await service.stop();
  await chain.stop();
}
process.exit(0);
