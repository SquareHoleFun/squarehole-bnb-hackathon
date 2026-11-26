import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { parseCoreManifest, readCoreBox, type DeployedCoreManifest } from '@squarehole/chain';
import { boxCollectionAbi, boxHookAbi, boxItemStreamAbi, boxTicketsAbi, boxTokenAbi } from '@squarehole/chain/abi';
import { createPublicClient, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, http, keccak256, type Abi, type Hex } from 'viem';
import { LIFE_STAGES, head, rpc, runLife, type CoreChainDescription, type LifeStage } from '../../../../packages/chain/scripts/local-core-chain.mjs';
import { CoreChainIndexer, type HistoryMessage } from '../../../../packages/indexer/src/core/chain-indexer';
import { CoreGateway } from '../../../../packages/indexer/src/core/core-gateway';
import { RpcCoreReader } from '../../../../packages/indexer/src/core/core-reader';
import { coreGatewaySource } from '../../../../packages/indexer/src/core/core-service';
import { CONTRACT_PHASE, phaseAt } from '../../../../packages/indexer/src/core/derive-core';
import { directBoxView } from '../../../../packages/indexer/src/core/direct-view';
import { feeSummary } from '../../../../packages/indexer/src/core/core-fees';
import { HeadFeed } from '../../../../packages/indexer/src/heads';
import { PgHistory } from '../../../../packages/indexer/src/history/pg-history';
import type { HistoryDump } from '../../../../packages/indexer/src/history/types';
import { HistoryWriter } from '../../../../packages/indexer/src/history/writer';
import { startTempPostgres, type TempPostgres } from '../../../../packages/indexer/test/history/pg-cluster';
import { boxHeader, installUntouchableWallet, noTradingControls, overflow, walletTouches } from '../box-helpers';
import { ethDecimal, formatBps, shiftDecimal, significant } from '../../src/features/fit-pair/fit-format';

// The live core v1 suite (S10a § 7.3): box 0's life on a local twin chain (anvil, core-chain-server.mjs), stage by stage.
// The core service runs here, in the test process (its pipeline, gateway and head feed, hot state in memory), so the
// suite sees the pipeline's phase after EVERY block it applies and compares it with the hook's `phase()` at that block
// (BC-081); its history writer feeds a throwaway Postgres on a Unix socket (no TCP port), which is wiped and rebuilt
// from the chain at the end and compared row for row (BC-078). At each stage the app (built against this chain's core
// manifest) shows box 0 in that phase, from the service's answers. At every stage the Fees card's figures from the
// indexer equal those from a direct read of the receiver's and the stream's own totals at the same block (across
// graduation; S10a review), and the deepen stage adds paired depth. With the gateway stopped, the site reads box 0 from
// the chain (C19). Local only; no key.

const GATEWAY_PORT = Number(process.env.SH_E2E_CORE_GATEWAY_PORT ?? 5398);
const OUT = fileURLToPath(new URL('../.core-chain/', import.meta.url));

const LABEL: Readonly<Record<string, string>> = { upcoming: 'Upcoming', window: 'Launch window', bonding: 'Bonding', graduating: 'Graduating', graduated: 'Graduated' };
const EXPECTED_PHASE: Readonly<Record<LifeStage, string>> = {
  upcoming: 'upcoming',
  window: 'window',
  bonding: 'bonding',
  closed: 'graduating',
  graduated: 'graduated',
  word: 'graduated',
  draw: 'graduated',
  busy: 'graduated',
  deepen: 'graduated',
  stream: 'graduated',
};

interface Live {
  readonly reader: RpcCoreReader;
  readonly description: CoreChainDescription;
  readonly chain: Parameters<typeof runLife>[0];
  readonly manifest: DeployedCoreManifest;
  readonly token: string;
  readonly indexer: CoreChainIndexer;
  gateway: CoreGateway;
  readonly source: ReturnType<typeof coreGatewaySource>['source'];
  readonly feed: HeadFeed;
  readonly pg: TempPostgres;
  readonly store: PgHistory;
  readonly writer: HistoryWriter;
  /** Box 0's state in the pipeline right after each block it applied (its phase there, and what decides later phases). */
  readonly applied: Map<bigint, Applied>;
  checkedTo: bigint;
}
interface Applied {
  readonly phase: string | undefined;
  readonly closedAtBlock: bigint | null;
  readonly migratedAtBlock: bigint | null;
}
let live: Live | null = null;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

function need(): Live {
  if (!live) throw new Error('the live chain did not start');
  return live;
}

/** The hook's own phase() at block n (an eth_call at that block). */
async function contractPhase(l: Live, n: bigint): Promise<string> {
  const data = encodeFunctionData({ abi: boxHookAbi as Abi, functionName: 'phase' });
  const raw = (await rpc(l.description.rpcUrl, 'eth_call', [{ to: l.description.hook, data }, `0x${n.toString(16)}`])) as Hex;
  const value = decodeFunctionResult({ abi: boxHookAbi as Abi, functionName: 'phase', data: raw });
  return CONTRACT_PHASE[Number(value)] ?? `unknown ${String(value)}`;
}

/** Block n's timestamp (box 0 opens and its window ends at clock times). */
async function blockTime(l: Live, n: bigint): Promise<bigint> {
  const block = (await rpc(l.description.rpcUrl, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false])) as { timestamp: Hex };
  return BigInt(block.timestamp);
}

/** The pipeline's phase of box 0 at block n: as applied there, else from the newest applied state below n. */
async function indexedPhase(l: Live, n: bigint): Promise<string | undefined> {
  const exact = l.applied.get(n);
  if (exact) return exact.phase;
  let below: bigint | null = null;
  for (const block of l.applied.keys()) if (block < n && (below === null || block > below)) below = block;
  const state = below === null ? undefined : l.applied.get(below);
  const entry = l.indexer.boxes.get(l.token);
  if (!state || !entry) return undefined;
  return phaseAt({ number: n, timestamp: await blockTime(l, n) }, entry.row.openAt, entry.row.windowEndsAt, state.closedAtBlock, state.migratedAtBlock);
}

/** Waits until the pipeline has applied the chain's head and is idle. */
async function caughtUp(l: Live): Promise<bigint> {
  const target = await head(l.description.rpcUrl);
  for (let i = 0; i < 1_200 && (l.indexer.head()?.number ?? 0n) < target; i += 1) await sleep(50);
  await l.indexer.idle();
  expect(l.indexer.head()?.number, 'the pipeline reached the head').toBe(target);
  return target;
}

/** Chooses the local chain as the data source before the app starts (the build embeds only the twin's core manifest). */
async function onLocal(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' })));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  if (!(await portFree(GATEWAY_PORT))) throw new Error(`port ${GATEWAY_PORT} is in use; set SH_E2E_CORE_GATEWAY_PORT`);
  const description = JSON.parse(readFileSync(`${OUT}local-core-chain.json`, 'utf8')) as CoreChainDescription;
  const chain = { ...description, stages: { ...description.stages }, creationBlock: BigInt(description.creationBlock), openAt: BigInt(description.openAt), windowEndsAt: BigInt(description.windowEndsAt), out: OUT };
  const manifest = parseCoreManifest(JSON.parse(readFileSync(description.manifest, 'utf8'))) as DeployedCoreManifest;
  const pg = startTempPostgres('squarehole_history_e2e');
  if (!pg) throw new Error('no PostgreSQL binaries (SH_PG_BIN, Homebrew postgresql@17 or pg_config)');
  const store = new PgHistory({ host: pg.host, port: pg.port, database: pg.database, user: pg.user });
  await store.init();
  const writer = new HistoryWriter(store);
  const token = description.token.toLowerCase();
  const applied = new Map<bigint, Applied>();
  const reader = new RpcCoreReader({ urls: [description.rpcUrl] });
  let updated: () => void = () => undefined;
  const indexer: CoreChainIndexer = new CoreChainIndexer({
    reader,
    manifest,
    auditEvery: 32,
    onUpdate: () => updated(),
    // Called right after each block is applied (the head is that block): the phase the gateway would serve then.
    onHistory: async (message: HistoryMessage) => {
      if (message.type === 'block') {
        const entry = indexer.boxes.get(token);
        const state = entry ? indexer.stateAt(entry, message.result.block) : null;
        applied.set(message.result.block.number, { phase: indexer.boxView(token)?.phase, closedAtBlock: state?.closedAtBlock ?? null, migratedAtBlock: state?.migratedAtBlock ?? null });
      }
      await writer.accept(message);
    },
  });
  const feed = new HeadFeed({ wsUrls: [], reader, pollMs: 150, silenceMs: 30_000, onHead: (header) => indexer.onHead(header) });
  // Stale follows the head feed (the chain heard from, the index at its head) and the history writer's health.
  const wired = coreGatewaySource(indexer, reader, { get version() { return store.version; }, activityPage: (c, t, o) => store.activityPage(c, t, o), candles: (c, t, i, l) => store.candles(c, t, i, l) }, 60_000, Date.now, { liveness: feed, historyHealth: () => writer.health() });
  updated = wired.updated;
  const gateway = new CoreGateway({ source: wired.source, port: GATEWAY_PORT, host: '127.0.0.1' });
  await indexer.start();
  await indexer.idle();
  updated();
  await gateway.start();
  feed.start();
  live = { reader, description, chain, manifest, token, indexer, gateway, source: wired.source, feed, pg, store, writer, applied, checkedTo: chain.creationBlock - 1n };
});

test.afterAll(async () => {
  if (!live) return;
  live.feed.stop();
  live.indexer.stop();
  await live.gateway.stop();
  await live.writer.flush();
  await live.store.close();
  live.pg.stop();
});

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await onLocal(page);
});

for (const stage of LIFE_STAGES) {
  test(`BC-081 live, ${stage}: the indexer's phase equals phase() at every block; box 0's page shows it (BC-084, BC-086, BC-092)`, async ({ page }) => {
    const l = need();
    await runLife(l.chain, { until: stage, log: (line) => console.warn(line.length > 160 ? `${line.slice(0, 160)}…` : line) });
    const target = await caughtUp(l);

    // BC-081: every block since the last stage against phase() there. A block the pipeline applied as its head: the
    // phase it served then. A block a range backfill passed over (no event of the box in it, e.g. the 310 blocks of
    // the deepen cooldown mined at once): the pipeline's phase at that block from its newest state below it, as
    // `stateAt` gives it (phase is re-evaluated per block on read).
    const wrong: string[] = [];
    let derived = 0;
    for (let n = l.checkedTo + 1n; n <= target; n += 1n) {
      const indexed = await indexedPhase(l, n);
      if (!l.applied.has(n)) derived += 1;
      const contract = await contractPhase(l, n);
      if (indexed !== contract) wrong.push(`${n}: ${String(indexed)} ≠ ${contract}`);
    }
    expect(wrong).toEqual([]);
    console.warn(`BC-081 ${stage}: blocks ${l.checkedTo + 1n}-${target}, ${Number(target - l.checkedTo) - derived} applied as the head, ${derived} passed over by a range backfill`);
    l.checkedTo = target;
    expect(await contractPhase(l, target)).toBe(EXPECTED_PHASE[stage]);

    // BC-080: the audit at the head agrees with the chain's reads (the fee ledgers included).
    const audits = await l.indexer.audit();
    expect(audits.map(({ result }) => result.mismatches)).toEqual([[]]);
    const view = l.indexer.boxView(l.token);
    expect(view?.verified).toBe(true);
    expect(view?.phase).toBe(EXPECTED_PHASE[stage]);
    if (!view) throw new Error('no view');
    // The Fees card from the indexer equals the one from a direct read at the same block (S10a review: the platform's
    // held share, its part above the cap and the stream's 13/15 were missing from the indexer's figures).
    const entry = l.indexer.boxes.get(l.token);
    if (!entry) throw new Error('no box');
    const client = createPublicClient({ transport: http(l.description.rpcUrl) });
    const direct = directBoxView(entry.row, await readCoreBox(client, entry.row, target));
    expect(direct.asOf.block).toBe(target.toString());
    const [fromIndex, fromChain] = [feeSummary(view), feeSummary(direct)];
    expect(fromIndex, `${stage}: the Fees card from the indexer and from the chain at block ${target}`).toEqual(fromChain);
    // The display reads (the pool's waiting budget, the stream's index) hold at the head.
    expect(view.readsCurrent).toBe(true);
    if (stage === 'deepen' || stage === 'stream') {
      // The deepen stage pairs depth (S10a review: it used to be skipped, reason 4, with nothing added).
      expect(view.pool.adds).toBeGreaterThanOrEqual(1);
      expect(BigInt(view.pool.pairedLiquidity)).toBeGreaterThan(0n);
      expect(view.pool.lastAddBlock).not.toBeNull();
    }

    // The page: box 0 from its row, in that phase, from the service's answers; no notice, no trading, no wallet.
    await page.goto(`/box/${l.manifest.chainId}/${l.token}`);
    const header = boxHeader(page);
    await expect(header.locator('.sh-box-band__label')).toHaveText(LABEL[EXPECTED_PHASE[stage]] ?? '');
    await expect(page.locator('.sh-box-notice')).toHaveCount(0);
    await expect(header).toContainText('Genesis box');
    await expect(header).not.toContainText(/deadline|Ends \d+ d/i);
    await noTradingControls(page);
    expect(await walletTouches(page)).toEqual([]);
    if (stage === 'bonding' || stage === 'graduated') await liveCurve(page, view, stage);
  });
}

/**
 * Box 0's curve straight from the chain at block n (review of SH-BOX0-LIVE-CURVE): slot0 of its pool through
 * `PoolManager.extsload(keccak256(poolId, 6))` (Uniswap v4 StateLibrary), ETH per FIT = 2^192 / √P² (ETH is currency0,
 * both 18 decimals), ETH in the curve = L × 2^96 × (√Pu − √P) / (√Pu × √P), rounded down, 0 above √Pu, the raise at or
 * below √Pl. No site or indexer code in the arithmetic.
 */
async function chainCurve(n: bigint): Promise<{ sqrtPriceX96: bigint; qPerT: string; retainedQ: bigint; raise: bigint; fillBps: number }> {
  const l = need();
  const entry = l.indexer.boxes.get(l.token);
  if (!entry) throw new Error('no box');
  const { row } = entry;
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [row.poolId as Hex, 6n]));
  const data = encodeFunctionData({ abi: [{ type: 'function', name: 'extsload', stateMutability: 'view', inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ name: '', type: 'bytes32' }] }], functionName: 'extsload', args: [slot] });
  const word = (await rpc(l.description.rpcUrl, 'eth_call', [{ to: row.poolManager, data }, `0x${n.toString(16)}`])) as Hex;
  const sqrt = BigInt(word) & ((1n << 160n) - 1n);
  if (sqrt === 0n) throw new Error('the pool has no price');
  const scaled = ((1n << 192n) * 10n ** 18n) / (sqrt * sqrt);
  const fraction = (scaled % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  const qPerT = fraction ? `${scaled / 10n ** 18n}.${fraction}` : `${scaled / 10n ** 18n}`;
  const { sqrtPriceLowerX96: lo, sqrtPriceUpperX96: hi, liquidity } = row.curve;
  const retainedQ = sqrt >= hi ? 0n : sqrt <= lo ? row.raise : ((liquidity << 96n) * (hi - sqrt)) / hi / sqrt;
  const bps = (retainedQ * 10_000n) / row.raise;
  return { sqrtPriceX96: sqrt, qPerT, retainedQ, raise: row.raise, fillBps: Number(bps > 10_000n ? 10_000n : bps) };
}

/**
 * SH-BOX0-LIVE-CURVE: box 0's Token tab opens with the live curve card, its figures those of the service's answer at
 * this stage (price per 1M FIT, the fill, ETH in the curve of the raise), Live, with no control and no wallet request.
 * The section bar and the Token panel (no box art in the frame) at 1280 and 400 px:
 * docs/evidence/screenshots/sh-box0-live-curve/ with SH_BOX0_CURVE_SHOTS=1, else the test's output folder.
 */
async function liveCurve(page: Page, view: NonNullable<ReturnType<CoreChainIndexer['boxView']>>, stage: LifeStage) {
  await page.goto(`/box/${need().manifest.chainId}/${need().token}?tab=token`);
  const curve = page.getByRole('region', { name: 'Bonding curve' });
  // The card against the chain itself, not only against the service: the pool's √price read raw from the PoolManager
  // (extsload of slot0) at the view's block, and the price and ETH in the curve worked out here in plain bigint.
  const chain = await chainCurve(BigInt(view.asOf.block));
  expect(chain.sqrtPriceX96.toString(), `${stage}: the service's √price is the pool's at block ${view.asOf.block}`).toBe(view.price.sqrtPriceX96);
  await expect(curve.locator('.sh-fit-hero__price dd')).toHaveText(`${significant(shiftDecimal(chain.qPerT, 6), 5)} ETH per 1M FIT`);
  if (stage !== 'graduated') {
    await expect(curve.locator('.sh-fit-band__pct')).toHaveText(formatBps(chain.fillBps));
    await expect(curve.locator('.sh-fit-band__text')).toHaveText(`${ethDecimal(chain.retainedQ)} of ${ethDecimal(chain.raise, 18)} ETH`);
  }
  await expect(page.locator('.sh-box-token .sh-fit-grid__main > section').first()).toHaveAttribute('aria-labelledby', 'fit-curve-title');
  await expect(curve.locator('.sh-fit-chip')).toHaveText('Live');
  const qPerT = view.price.qPerT ?? '';
  await expect(curve.locator('.sh-fit-hero__price dd')).toHaveText(`${significant(shiftDecimal(qPerT, 6), 5)} ETH per 1M FIT`);
  const fill = view.curve.fillBps ?? -1;
  await expect(curve.locator('.sh-fit-band__pct')).toHaveText(formatBps(stage === 'graduated' ? 10_000 : fill));
  if (stage === 'graduated') await expect(curve.locator('.sh-fit-band__label')).toHaveText('Curve complete');
  else await expect(curve.locator('.sh-fit-band__text')).toHaveText(`${ethDecimal(BigInt(view.curve.retainedQ ?? '0'))} of ${ethDecimal(BigInt(view.curve.raise), 18)} ETH`);
  await expect(curve.locator('a, input, iframe')).toHaveCount(0);
  await noTradingControls(page);
  expect(await walletTouches(page)).toEqual([]);
  for (const width of [1280, 400]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const name = `box0-token-${stage}-${width}`;
    const file = process.env.SH_BOX0_CURVE_SHOTS === '1' ? fileURLToPath(new URL(`../../../../docs/evidence/screenshots/sh-box0-live-curve/${name}.png`, import.meta.url)) : test.info().outputPath(`${name}.png`);
    // From the section bar to the end of the Token panel, at the top of the page, so the sticky bar sits in its own
    // place and covers nothing (an element shot scrolls the panel under it); the header with the box art stays out.
    await page.evaluate(() => window.scrollTo(0, 0));
    const clip = await page.evaluate(() => {
      const bar = document.querySelector('.sh-box-sections')?.getBoundingClientRect();
      const panel = document.querySelector('.sh-box-token')?.getBoundingClientRect();
      if (!bar || !panel) return null;
      const x = Math.max(0, Math.min(bar.left, panel.left) - 8);
      const y = Math.max(0, bar.top + window.scrollY - 8);
      return { x, y, width: Math.min(document.documentElement.clientWidth - x, Math.max(bar.right, panel.right) - x + 8), height: panel.bottom + window.scrollY - y + 8 };
    });
    if (!clip) throw new Error('no section bar or Token panel');
    await page.screenshot({ path: file, fullPage: true, clip });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('BC-085, BC-089 live: the feed and Alice\'s wallet after the life, from the live service', async ({ page }) => {
  const l = need();
  await page.goto('/');
  const card = page.getByRole('list', { name: 'Boxes' }).locator('li', { has: page.locator(`a[href="/box/${l.manifest.chainId}/${l.token}"]`) });
  await expect(card).toContainText('Graduated');
  await expect(card).not.toContainText(/Stale|Unverified/);
  await page.goto(`/wallet/${l.description.accounts.alice}`);
  await expect(page.locator('section.sh-box-holding')).toHaveCount(1);
  const holding = page.locator('section.sh-box-holding');
  await expect(holding.locator(`a[href="/box/${l.manifest.chainId}/${l.token}"]`)).toBeVisible();
  await expect(holding).toContainText(/[\d.]+[KMB]? FIT/);
  await expect(holding).toContainText(/1 Misfits/);
  await noTradingControls(page);
  expect(await walletTouches(page)).toEqual([]);
});

test('C19 live: with the gateway down, box 0, the feed and a wallet are read from the chain; /fit-pair opens box 0 by its row', async ({ page }) => {
  const l = need();
  await caughtUp(l);
  const head = l.indexer.head()?.number ?? 0n;
  const box0 = `/box/${l.manifest.chainId}/${l.token}`;
  // /fit-pair on the core twin (no v2 market record in this build): box 0, never "No FIT market in this build".
  await page.goto('/fit-pair');
  await expect(page).toHaveURL(new RegExp(`${box0}$`));
  // The gateway refuses connections now.
  await l.gateway.stop();
  try {
    await page.goto(box0);
    const header = boxHeader(page);
    await expect(header.locator('.sh-box-band__label')).toHaveText('Graduated');
    await expect(page.locator('.sh-box-notice[data-freshness="direct"]')).toHaveText(new RegExp(`^Read from the chain at block ${Number(head).toLocaleString('en-US')} · activity needs the indexer$`));
    await expect(page.locator('main')).not.toContainText(/Not in Local chain|is not on .* in this build|Box not found/);
    await page.goto(`${box0}?tab=token`);
    await expect(page.locator('[data-card="core-fees"]')).toContainText(/Fees so far: [\d.]+ ETH · [\d.]+[KMB]? FIT/);
    // SH-BOX0-LIVE-CURVE: the curve card from the same direct read, saying so.
    await expect(page.getByRole('region', { name: 'Bonding curve' }).locator('.sh-fit-chip')).toHaveText('Direct chain read');
    await page.goto('/');
    const card = page.getByRole('list', { name: 'Boxes' }).locator('li', { has: page.locator(`a[href="${box0}"]`) });
    await expect(card).toContainText('Graduated');
    await page.goto(`/wallet/${l.description.accounts.alice}`);
    await expect(page.locator('section.sh-box-holding')).toHaveCount(1);
    await noTradingControls(page);
    expect(await walletTouches(page)).toEqual([]);
  } finally {
    // The gateway again on its port for what follows.
    l.gateway = new CoreGateway({ source: l.source, port: GATEWAY_PORT, host: '127.0.0.1' });
    await l.gateway.start();
  }
});

/**
 * SH-BOX0-ACTIONS: an EIP-6963 test wallet for one of anvil's unlocked accounts, announced only when the page asks (the
 * wallet window opens on a click). It sends only to box 0's token, tickets and stream, from that one account, and
 * waits for each receipt. `requests` records every wallet request the page made.
 */
async function box0Wallet(page: Page, l: Live, account: `0x${string}`, allowed: readonly string[]) {
  const requests: string[] = [];
  const sent: { to: string; data: Hex; value: bigint }[] = [];
  const targets = new Set(allowed.map((a) => a.toLowerCase()));
  await page.exposeFunction('box0LocalWalletRequest', async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return rpc(l.description.rpcUrl, 'eth_chainId');
    if (method !== 'eth_sendTransaction') throw new Error(`unsupported test wallet method ${method}`);
    const tx = params[0] as { from?: string; to?: string; data: Hex; value?: Hex };
    if (tx.from?.toLowerCase() !== account.toLowerCase() || !targets.has(tx.to?.toLowerCase() ?? '')) throw new Error('the test wallet sends only box 0 calls from its account');
    const hash = (await rpc(l.description.rpcUrl, 'eth_sendTransaction', [tx])) as Hex;
    sent.push({ to: (tx.to ?? '').toLowerCase(), data: tx.data, value: BigInt(tx.value ?? '0x0') });
    return hash;
  });
  await page.addInitScript(() => {
    const w = window as unknown as { box0LocalWalletRequest: (r: unknown) => Promise<unknown> };
    const provider = { request: (r: unknown) => w.box0LocalWalletRequest(r), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () =>
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '0b0c7c1e-3c2a-4f0e-9b8a-5a1d2c3b4a50', name: 'Local box 0 test wallet', rdns: 'org.example.box0-local', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider } })),
    );
  });
  return { requests, sent };
}

/** The panel only (no box art in the frame): docs/evidence/screenshots/sh-box0-actions/ with SH_EVIDENCE_SCREENSHOTS=1. */
async function panelShot(page: Page, name: string, outputPath: (name: string) => string) {
  const file = process.env.SH_EVIDENCE_SCREENSHOTS === '1' ? fileURLToPath(new URL(`../../../../docs/evidence/screenshots/sh-box0-actions/${name}.png`, import.meta.url)) : outputPath(`${name}.png`);
  await page.locator('section.sh-box0-actions').screenshot({ path: file });
}

test('SH-BOX0-ACTIONS live: Carol opens her settled draw past its fallback, claims its share and draws again, each from the page after a click', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const l = need();
  await caughtUp(l);
  const entry = l.indexer.boxes.get(l.token);
  if (!entry) throw new Error('no box');
  const { tickets, itemStream: stream, collection, token } = entry.row.contracts;
  if (!tickets || !stream || !collection || !token) throw new Error('box 0 lacks a role');
  const client = createPublicClient({ transport: http(l.description.rpcUrl) });
  const carol = l.description.accounts.carol;
  const ticket = await client.readContract({ address: tickets, abi: boxTicketsAbi, functionName: 'drawTicket', args: [1n] });
  expect(ticket.drawer.toLowerCase()).toBe(carol.toLowerCase());
  expect(Number(ticket.status)).toBe(2); // settled in the draw stage, never opened
  const wallet = await box0Wallet(page, l, carol, [token, tickets, stream]);

  // Navigation: the panel shows the draw price; nothing asks the wallet anything.
  await page.goto(`/box/${l.manifest.chainId}/${l.token}`);
  const panel = page.locator('section.sh-box0-actions');
  const drawButton = panel.getByRole('button', { name: /^Draw one · [\d,.]+ FIT$/ });
  await expect(drawButton).toBeVisible();
  expect(wallet.requests).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
  await noTradingControls(page);
  await panelShot(page, 'box0-actions-1-visitor', (n) => testInfo.outputPath(n));

  // The first click opens the wallet window; Carol connects.
  await drawButton.click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Local box 0 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = panel.locator('li', { hasText: `Draw 1 · Misfit ${ticket.itemId}` });
  await expect(row).toBeVisible();
  await panelShot(page, 'box0-actions-2-connected', (n) => testInfo.outputPath(n));

  // Open without picture (the fixture carries no reveal records; 31 days have passed since the draw settled).
  await row.getByRole('button', { name: 'Open without picture' }).click();
  await panel.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Confirmed. Reading the box…');
  expect(Number((await client.readContract({ address: tickets, abi: boxTicketsAbi, functionName: 'drawTicket', args: [1n] })).status)).toBe(3);
  expect((await client.readContract({ address: collection, abi: boxCollectionAbi, functionName: 'ownerOf', args: [ticket.itemId] })).toLowerCase()).toBe(carol.toLowerCase());

  // Its share since the draw's request: claimable once the indexer lists the Misfit in Carol's wallet.
  const claimLine = panel.locator('p.sh-box0-actions__claim');
  await expect(claimLine).toContainText(/^Claimable · [\d,.]+ FIT/, { timeout: 60_000 });
  const before = await client.readContract({ address: token, abi: boxTokenAbi, functionName: 'balanceOf', args: [carol] });
  await panelShot(page, 'box0-actions-3-claimable', (n) => testInfo.outputPath(n));
  await claimLine.getByRole('button', { name: 'Claim' }).click();
  await panel.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Claimed');
  expect(await client.readContract({ address: token, abi: boxTokenAbi, functionName: 'balanceOf', args: [carol] })).toBeGreaterThan(before);

  // A new draw: Carol approved the tickets in the bonding stage, so one step; it waits for a round no one can post here.
  await drawButton.click();
  const confirm = panel.getByRole('group', { name: 'Confirm transaction' });
  await expect(confirm).toContainText(/Up to [\d,.]+ FIT/);
  await expect(confirm).toContainText('+ up to 0.0006 ETH for the random number, the unused part comes back if your wallet accepts ETH');
  await panelShot(page, 'box0-actions-4-confirm-draw', (n) => testInfo.outputPath(n));
  // SH-BOX0-DRAW-VALUE: the base fee rises from 0 to 1 wei after the page showed 0.0006 ETH, so the round now needs
  // 600,000 × (2 wei + 1 gwei), a little more. Confirm draw sends nothing and shows the new amount (0.0007 ETH, rounded
  // up to the four decimals shown); only the next Confirm draw sends, exactly that amount.
  await baseFeeFromNow(l, 1n);
  await confirm.getByRole('button', { name: 'Confirm draw' }).click();
  await expect(panel.getByRole('status')).toHaveText('The network fee rose. Check the new amount and confirm again.');
  await expect(confirm).toContainText('+ up to 0.0007 ETH for the random number, the unused part comes back if your wallet accepts ETH');
  expect(wallet.sent).toHaveLength(2);
  await panelShot(page, 'box0-actions-4b-fee-rose', (n) => testInfo.outputPath(n));
  await confirm.getByRole('button', { name: 'Confirm draw' }).click();
  await expect(panel.getByRole('status')).toHaveText('Drawn · waiting for its number');
  // Back to the twin's base fee of 0 for the rest of the suite.
  await baseFeeFromNow(l, 0n);
  await expect(panel.locator('li', { hasText: 'Draw 2 · waiting for its number' })).toBeVisible();
  const drawn = await client.readContract({ address: tickets, abi: boxTicketsAbi, functionName: 'drawTicket', args: [2n] });
  expect([drawn.drawer.toLowerCase(), Number(drawn.status)]).toEqual([carol.toLowerCase(), 1]);
  await panelShot(page, 'box0-actions-5-drawn', (n) => testInfo.outputPath(n));

  // Exactly three sends: openDraw and claim with no value, and the draw with the round payment its second confirmation
  // showed (0.0007 ETH: at a base fee of 1 wei the round needs 600,000 × (2 wei + 1 gwei), rounded up to 0.0001 ETH).
  expect(wallet.sent.map((tx) => [tx.to, decodeFunctionData({ abi: tx.to === stream.toLowerCase() ? boxItemStreamAbi : boxTicketsAbi, data: tx.data }).functionName, tx.value])).toEqual([
    [tickets.toLowerCase(), 'openDraw', 0n],
    [stream.toLowerCase(), 'claim', 0n],
    [tickets.toLowerCase(), 'draw', 700_000_000_000_000n],
  ]);
  expect(wallet.requests.filter((m) => m === 'eth_sendTransaction')).toHaveLength(3);
  await noTradingControls(page);
  // Phone width: the panel wraps, nothing scrolls sideways.
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(panel.locator('li', { hasText: 'Draw 2 · waiting for its number' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await panelShot(page, 'box0-actions-6-phone', (n) => testInfo.outputPath(n));
});

/** SH-BOX0-DRAW-VALUE: the twin's base fee from the latest block on (set for the next block, which is mined here). */
async function baseFeeFromNow(l: Live, wei: bigint) {
  await rpc(l.description.rpcUrl, 'anvil_setNextBlockBaseFeePerGas', [`0x${wei.toString(16)}`]);
  await rpc(l.description.rpcUrl, 'anvil_mine', ['0x1']);
  const latest = (await rpc(l.description.rpcUrl, 'eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas: Hex };
  expect(BigInt(latest.baseFeePerGas), 'the latest block’s base fee').toBe(wei);
}

/** Moves the twin chain's clock `days` days on, in one block. */
async function laterBy(l: Live, days: bigint) {
  await rpc(l.description.rpcUrl, 'evm_increaseTime', [`0x${(days * 86_400n).toString(16)}`]);
  await rpc(l.description.rpcUrl, 'anvil_mine', ['0x1']);
}

/** The panel only, for SH-BOX0-EXITS: docs/evidence/screenshots/sh-box0-exits/ with SH_EVIDENCE_SCREENSHOTS=1. */
async function exitShot(page: Page, name: string, outputPath: (name: string) => string) {
  const file = process.env.SH_EVIDENCE_SCREENSHOTS === '1' ? fileURLToPath(new URL(`../../../../docs/evidence/screenshots/sh-box0-exits/${name}.png`, import.meta.url)) : outputPath(`${name}.png`);
  await page.locator('section.sh-box0-actions').screenshot({ path: file });
}

/**
 * F142 (desk R61-STOP "hide"): the page never sends `enterTerminal`. The contract lets anyone call it, so the test does,
 * from another of anvil's unlocked accounts (not Carol's wallet), straight to the tickets contract.
 */
async function enterTerminalFrom(l: Live, from: `0x${string}`, tickets: `0x${string}`) {
  const data = encodeFunctionData({ abi: boxTicketsAbi, functionName: 'enterTerminal' });
  const hash = (await rpc(l.description.rpcUrl, 'eth_sendTransaction', [{ from, to: tickets, data, gas: `0x${(1_000_000n).toString(16)}` }])) as Hex;
  for (let i = 0; i < 300; i += 1) {
    const receipt = (await rpc(l.description.rpcUrl, 'eth_getTransactionReceipt', [hash])) as { status: Hex } | null;
    if (receipt) {
      expect(receipt.status, 'enterTerminal from the test account').toBe('0x1');
      return;
    }
    await sleep(25);
  }
  throw new Error(`enterTerminal ${hash} was not mined`);
}

test('SH-BOX0-EXITS live: draws stall and the page says nothing; once another account stops them, Carol gets her draw’s FIT back, and three days later takes one by its number, each after a click', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const l = need();
  await caughtUp(l);
  const entry = l.indexer.boxes.get(l.token);
  if (!entry) throw new Error('no box');
  const { tickets, itemStream: stream, collection, token } = entry.row.contracts;
  if (!tickets || !stream || !collection || !token) throw new Error('box 0 lacks a role');
  const client = createPublicClient({ transport: http(l.description.rpcUrl) });
  const carol = l.description.accounts.carol;
  // Carol's draw 2 (SH-BOX0-ACTIONS, just before) waits for a round nobody posts here.
  const waiting = await client.readContract({ address: tickets, abi: boxTicketsAbi, functionName: 'drawTicket', args: [2n] });
  expect([waiting.drawer.toLowerCase(), Number(waiting.status)]).toEqual([carol.toLowerCase(), 1]);

  // Eight days on: the head (draw 2) has had no usable word for more than SILENCE (7 days).
  await laterBy(l, 8n);
  await caughtUp(l);
  const wallet = await box0Wallet(page, l, carol, [token, tickets, stream]);
  await page.goto(`/box/${l.manifest.chainId}/${l.token}`);
  await expect(page.getByRole('main')).toBeVisible();
  expect(wallet.requests).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
  // A stalled box offers no draw (it would revert QueueDead).
  await expect(page.locator('section.sh-box0-actions').getByRole('button', { name: /^Draw one/ })).toHaveCount(0);

  // Carol connects from the header; her draw only waits: no stop, no word about a dead head, no way out yet (F142).
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Local box 0 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const panel = page.locator('section.sh-box0-actions');
  await expect(panel.locator('li', { hasText: 'Draw 2 · waiting for its number' })).toBeVisible();
  await expect(panel.getByRole('button')).toHaveCount(0);
  // The whole page, not just the panel ("Take one out" is the conversion card's own example, not an exit).
  await expect(page.getByRole('main')).not.toContainText(/stop draws|draws stopped|no numbers? came|stuck|terminal mode|safety mode|get back ·|take one ·/i);
  await exitShot(page, 'box0-exits-1-stalled', (n) => testInfo.outputPath(n));
  expect(wallet.sent).toEqual([]);

  // Someone else stops draws on chain (Bob, straight to the contract); the page shows the ways out only after that.
  await enterTerminalFrom(l, l.description.accounts.bob, tickets);
  expect(Number(await client.readContract({ address: tickets, abi: boxTicketsAbi, functionName: 'phase' }))).toBe(4);
  await caughtUp(l);

  // The draw's FIT back (fee-free after graduation): about the release quote, at least what the page showed rounded down.
  const drawLine = panel.locator('li', { hasText: 'Draw 2 · draws stopped' });
  const back = drawLine.getByRole('button', { name: /^Get back · [\d,.]+ FIT$/ });
  await expect(back).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText('Take one · in 3 d')).toBeVisible();
  await exitShot(page, 'box0-exits-3-stopped', (n) => testInfo.outputPath(n));
  const before = await client.readContract({ address: token, abi: boxTokenAbi, functionName: 'balanceOf', args: [carol] });
  await back.click();
  await expect(panel.getByRole('group', { name: 'Confirm transaction' })).toContainText(/^Cancel draw 2 and get about [\d,.]+ FIT back\?/);
  await panel.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Confirmed. Reading the box…');
  expect(Number((await client.readContract({ address: tickets, abi: boxTicketsAbi, functionName: 'drawTicket', args: [2n] })).status)).toBe(4);
  expect(await client.readContract({ address: token, abi: boxTokenAbi, functionName: 'balanceOf', args: [carol] })).toBeGreaterThan(before);
  await expect(panel.locator('li', { hasText: 'Draw 2' })).toHaveCount(0, { timeout: 60_000 });

  // Three days after the stop: one hidden item by its number, for the draw's price (no reveal records here: it comes
  // without its picture).
  await laterBy(l, 3n);
  await caughtUp(l);
  const takeButton = panel.getByRole('button', { name: /^Take one · [\d,.]+ FIT$/ });
  await expect(takeButton).toBeVisible({ timeout: 60_000 });
  await takeButton.click();
  const takeConfirm = panel.getByRole('group', { name: 'Confirm transaction' });
  await expect(takeConfirm).toContainText(/Up to [\d,.]+ FIT/);
  await expect(takeConfirm).toContainText(/Misfit \d+ · its picture comes later/);
  await exitShot(page, 'box0-exits-4-confirm-take', (n) => testInfo.outputPath(n));
  const approve = takeConfirm.getByRole('button', { name: 'Approve FIT' });
  if (await approve.isVisible()) {
    await approve.click();
    await expect(panel.getByRole('status')).toHaveText('FIT approved. Now confirm the take.');
  }
  await takeConfirm.getByRole('button', { name: 'Confirm take' }).click();
  await expect(panel.getByRole('status')).toHaveText(/^Taken · Misfit \d+$/);
  const taken = BigInt((/(\d+)$/.exec((await panel.getByRole('status').textContent()) ?? '') ?? [])[1] ?? '0');
  expect((await client.readContract({ address: collection, abi: boxCollectionAbi, functionName: 'ownerOf', args: [taken] })).toLowerCase()).toBe(carol.toLowerCase());
  await exitShot(page, 'box0-exits-5-taken', (n) => testInfo.outputPath(n));

  // Carol's sends, in order, none with value: cancelDraw, [the FIT approval,] takeByNumber; never enterTerminal.
  const named = wallet.sent.map((tx) => [tx.to, tx.to === token.toLowerCase() ? 'approve' : decodeFunctionData({ abi: boxTicketsAbi, data: tx.data }).functionName, tx.value]);
  expect(named.filter(([, fn]) => fn !== 'approve')).toEqual([
    [tickets.toLowerCase(), 'cancelDraw', 0n],
    [tickets.toLowerCase(), 'takeByNumber', 0n],
  ]);
  expect(named.every(([, , value]) => value === 0n)).toBe(true);
  await noTradingControls(page);
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(panel.getByRole('status')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await exitShot(page, 'box0-exits-6-phone', (n) => testInfo.outputPath(n));
});

test('BC-078 live: Postgres history written two deep, wiped and rebuilt from the chain, gives identical rows and candles', async () => {
  test.setTimeout(300_000);
  const l = need();
  await caughtUp(l);
  await l.writer.flush();
  const chainId = l.manifest.chainId;
  const written: HistoryDump = await l.store.dump(chainId);
  expect(l.writer.lastError).toBeNull();
  expect(written.trades.length).toBeGreaterThan(5);
  expect(written.batches.length).toBeGreaterThan(2);
  expect(written.items.length).toBeGreaterThan(4_000);
  // Stop the live pipeline, wipe the chain's history, rebuild it in one catch-up from the chain (the backfill path).
  l.feed.stop();
  l.indexer.stop();
  await l.store.wipe(chainId);
  expect((await l.store.dump(chainId)).trades).toEqual([]);
  const again = new HistoryWriter(l.store);
  const rebuild = new CoreChainIndexer({ reader: new RpcCoreReader({ urls: [l.description.rpcUrl] }), manifest: l.manifest, onHistory: again.accept });
  await rebuild.start();
  await rebuild.idle();
  await again.flush();
  rebuild.stop();
  expect(again.lastError).toBeNull();
  // Every event table row for row; chain_blocks: the live run wrote every block it applied as its head, the backfill
  // only blocks with logs (and its last 32 block by block), all of them among the live run's.
  const rebuilt = await l.store.dump(chainId);
  expect({ ...rebuilt, chainBlocks: [] }).toEqual({ ...written, chainBlocks: [] });
  expect(rebuilt.chainBlocks.filter((b) => !written.chainBlocks.includes(b))).toEqual([]);
  expect(rebuilt.chainBlocks.length).toBeGreaterThan(0);
});
