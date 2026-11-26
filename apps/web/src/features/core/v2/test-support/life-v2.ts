/**
 * SH-BOX-LIFE-VIEW fixtures. GPU Poor (VRAM, priced in tNVDA) and Dragon's Hoard (HOARD, priced in Sepolia's native
 * coin) as api.squarehole.fun answered them on 2026-10-27 (apps/web/e2e/fixtures/box-life/, real reads: the box
 * snapshot and its whole activity; each snapshot less its row's role-keyed copy of the code hashes, `row.codeHashes`,
 * which `row.record.codeHashes` holds as well and nothing reads, and whose `token` key would read as a secret to the
 * secret scan), and, from GPU Poor's own history, every earlier moment of a box's life: scheduled,
 * the launch window (a taxed buy), raising (one buy to a chosen share of the raise), the raise full and graduating (the
 * real filling buy, before the real graduation), and closed at its deadline with a claim. Each moment is the snapshot
 * and the activity the indexer would publish then: the real curve (its ticks and liquidity from `PoolLaunched`), every
 * amount from the exact v4 math, the holders and the supply from the transfers. Public chain data only.
 */
import { getAddress, type Hex } from 'viem';
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick } from '@squarehole/indexer/client';
import gpuBox from '../../../../../e2e/fixtures/box-life/gpu-poor-box.json' with { type: 'json' };
import gpuActivity from '../../../../../e2e/fixtures/box-life/gpu-poor-activity.json' with { type: 'json' };
import hoardBox from '../../../../../e2e/fixtures/box-life/dragons-hoard-box.json' with { type: 'json' };
import hoardActivity from '../../../../../e2e/fixtures/box-life/dragons-hoard-activity.json' with { type: 'json' };
import sepolia from '../../../../../../../packages/contracts/deployments/core-v1/11155111.json' with { type: 'json' };
import { parseCoreManifestV2, type DeployedCoreManifestV2 } from '../../../../../../../packages/chain/src/core/v2';
import type { V2Source } from '../indexer-v2';
import type { LifeStageV2 } from '../life-state';

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);

/** The source the recorded answers belong to: the committed Sepolia deployment and the public API. */
export function sepoliaLifeSourceV2(): V2Source {
  return { network: 'sepolia', manifest: parseCoreManifestV2(sepolia), origin: 'https://api.squarehole.fun', rpc: 'http://127.0.0.1:8599', art: [] };
}

/** The recorded answers, as read. */
export const recordedLifeV2 = {
  gpuPoor: { body: gpuBox as Json, activity: gpuActivity as Json },
  dragonsHoard: { body: hoardBox as Json, activity: hoardActivity as Json },
} as const;

// GPU Poor's own facts, from its recorded history (e2e/fixtures/box-life/gpu-poor-activity.json).
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543';
const COORDINATOR = '0x3c5924a06cE9Bb1A5864cc896e58bCD3C2a003f8';
const VRAM = '0x6eAF89C9895dbAF9fD07c78Bb3fAe7cabf0A0FDf';
const DEPLOYER = '0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE';
/** A second buyer for the moments before the real fill (no such address exists on Sepolia's GPU Poor). */
export const LIFE_BUYER = getAddress('0xb0b0000000000000000000000000000000000b0b');
export const LIFE_SNIPER = getAddress('0x5e1f000000000000000000000000000000005e1f');
/** GPU Poor's creator (its record's `creator`): a buy by the creator, and the creator among the holders. */
export const LIFE_CREATOR = getAddress('0x5583f846B0dDC80f49ea0E89C51520bA341c6658');
/** The earlier buyers of a long history (`buys`), one address each (no such addresses exist on Sepolia's GPU Poor). */
export const lifeCrowdV2 = (i: number) => getAddress(`0xc0de${i.toString(16).padStart(36, '0')}`);
const OPEN = 1793082229n;
const DEADLINE = 1795674229n;
const CREATED = 12003304n;
const CREATED_AT = 1793082228n;
const FILL_BLOCK = 12003353n;
const FILLED_AT = 1793082816n;
const TICK_LOWER = 145500;
const TICK_UPPER = 172380;
const LIQUIDITY = 195246362726789906940504n;
const RAISE = 100n * 10n ** 18n;
const MINTED = 10n ** 27n;
const BOOTSTRAP_T = 1079731410673673875460333n;
const BOOTSTRAP_P = 35655029729003341n;
const BOOTSTRAP_SQRT = 437967948656401676914121815728247n;
const Q192 = 1n << 192n;
const SQRT_A = getSqrtPriceAtTick(TICK_LOWER);
const SQRT_B = getSqrtPriceAtTick(TICK_UPPER);

const hex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const items = (): Json[] => clone((gpuActivity as Json).items as Json[]);
const at = (item: Json) => BigInt(item.block as string);

/** √price (Q64.96) on the curve at `bps` of the way from its start (√b) to its end (√a): P raised is linear in 1/√price. */
export function curveSqrtAtV2(bps: bigint): bigint {
  return (10_000n * SQRT_A * SQRT_B) / ((10_000n - bps) * SQRT_A + bps * SQRT_B);
}
const priceOf = (sqrt: bigint) => (Q192 * 10n ** 36n) / (sqrt * sqrt);

interface Moment {
  /** The snapshot's block and time. */
  readonly block: bigint;
  readonly timestamp: bigint;
}
function base(moment: Moment): Json {
  const body = clone(gpuBox as Json);
  const hash = hex32(moment.block);
  body.asOf = { block: moment.block.toString(), hash, timestamp: moment.timestamp.toString(), tier: 'head' };
  const money = body.money as Json;
  body.money = { ...money, block: moment.block.toString(), hash };
  body.audit = { ...(body.audit as Json), block: moment.block.toString() };
  return body;
}

/** One buy of the curve from √`from` to √`to` (P in, T out of the pool), with the T transfer that names who it was for. */
function buyItems(block: bigint, timestamp: bigint, from: bigint, to: bigint, who: string, taxed: { readonly tax: bigint; readonly step: number } | null): { readonly items: Json[]; readonly p: bigint; readonly t: bigint } {
  const p = getAmount0Delta(to, from, LIQUIDITY, true);
  const t = getAmount1Delta(to, from, LIQUIDITY, false);
  const blockHash = hex32(block);
  const txHash = hex32(block * 1_000n + 7n);
  const ref = (logIndex: number) => ({ id: `${block}-${logIndex}`, block: block.toString(), blockHash, timestamp: timestamp.toString(), txHash, logIndex });
  const trade = { kind: 'trade', ...ref(10), side: 'buy', route: taxed ? 'launch_router' : 'other', qRaw: p.toString(), tRaw: t.toString(),
    feeQ: ((p * 10_000n + 999_999n) / 1_000_000n).toString(), feeT: '0', taxQ: (taxed?.tax ?? 0n).toString(), trader: taxed ? who : null, sqrtPriceX96After: to.toString(), tickAfter: 0 };
  const transfer = { kind: 'v2_event', ...ref(13), data: { source: 'token', event: 'Transfer', emitter: VRAM.toLowerCase(), from: POOL_MANAGER, to: who, amount: t.toString() } };
  const tax = taxed ? [{ kind: 'v2_event', ...ref(14), data: { source: 'launchRouter', event: 'TaxedBuy', emitter: '0x0000000000000000000000000000000000000001', buyer: who, recipient: who, step: taxed.step, qIn: (p + taxed.tax).toString(), tax: taxed.tax.toString(), tokensOut: t.toString(), refund: '0' } }] : [];
  return { items: [...tax, transfer, trade], p, t };
}

/** The statistics the indexer publishes for a curve at √`sqrt` with `supply`, `holders` and the trades so far. */
function curveStatistics(sqrt: bigint, supply: bigint, holders: number, volumeP: bigint, trades: number, candleStart: bigint, open: bigint): Json {
  const raised = getAmount0Delta(sqrt, SQRT_B, LIQUIDITY, false);
  const raisedP = raised > RAISE ? RAISE : raised;
  const price = priceOf(sqrt);
  return {
    pricePPerTX18: price.toString(), marketCapP: ((Q192 * supply) / (sqrt * sqrt)).toString(),
    raiseProgress: { raisedP: raisedP.toString(), raiseP: RAISE.toString(), progressBps: ((raisedP * 10_000n) / RAISE).toString() },
    totalSupplyT: supply.toString(), burnedT: (MINTED - supply).toString(), holderCount: String(holders), volume24hP: volumeP.toString(), tradeCount: String(trades),
    hourlyCandles: [{ start: candleStart.toString(), open: open.toString(), high: price.toString(), low: open.toString(), close: price.toString(), volumeP: volumeP.toString(), tradeCount: String(trades) }],
  };
}

export interface LifeFixtureV2 {
  readonly body: Json;
  readonly activity: Json;
}

/**
 * GPU Poor at one moment of its life. `bps`: how far the raise is for `window`, `raising` and `failed` (default 42.1%);
 * `buyer`: who bought (and, closed, claimed) then (default a second buyer; the sniper in the window); `buys` (raising
 * only): the raise reached in that many buys along the curve, one block apart, the last by `buyer` and each earlier one
 * by its own address (`lifeCrowdV2`), so the history is longer than one read (30 buys: 71 items, 32 holders).
 */
export function gpuPoorLifeV2(stage: LifeStageV2, options: { readonly bps?: bigint; readonly buyer?: string; readonly buys?: number } = {}): LifeFixtureV2 {
  const creation = items().filter((item) => at(item) === CREATED);
  const bootstrapOpen = priceOf(BOOTSTRAP_SQRT);
  const hour = (OPEN / 3600n) * 3600n;
  const curve = { kind: 'curve', tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidity: LIQUIDITY.toString(), salt: '0' };
  const supplyAfterBootstrap = MINTED - BOOTSTRAP_T;
  const page = (list: Json[], body: Json) => ({ asOf: body.asOf, items: list.sort((a, b) => (at(a) === at(b) ? (b.logIndex as number) - (a.logIndex as number) : at(a) > at(b) ? -1 : 1)), next: null });
  if (stage === 'graduated') return { body: clone(gpuBox as Json), activity: clone(gpuActivity as Json) };
  if (stage === 'scheduled') {
    // Created a minute ago (the real creation block), set to open 2 h 14 min later.
    const timestamp = CREATED_AT + 60n;
    const openAt = timestamp + 8_040n;
    const body = base({ block: CREATED + 5n, timestamp });
    Object.assign(body, { graduated: false, closedAt: '0', position: curve, pool: { sqrtPriceX96: BOOTSTRAP_SQRT.toString(), tick: 172360 },
      gate: { ...(body.gate as Json), open: true, effectiveOpenAt: openAt.toString(), deadline: (openAt + 2_592_000n).toString() },
      statistics: curveStatistics(BOOTSTRAP_SQRT, supplyAfterBootstrap, 2, BOOTSTRAP_P, 1, hour, bootstrapOpen) });
    return { body, activity: page(creation, body) };
  }
  if (stage === 'graduating') {
    const timestamp = FILLED_AT + 40n;
    const body = base({ block: FILL_BLOCK + 3n, timestamp });
    const fill = items().filter((item) => at(item) === FILL_BLOCK);
    const sqrt = 114344156602762052670952517149140n;
    const fillP = 100974445980372006763n;
    Object.assign(body, { graduated: false, closedAt: FILLED_AT.toString(), position: curve, pool: { sqrtPriceX96: sqrt.toString(), tick: 145499 },
      statistics: { ...curveStatistics(sqrt, supplyAfterBootstrap, 3, BOOTSTRAP_P + fillP, 2, hour, bootstrapOpen), raiseProgress: { raisedP: RAISE.toString(), raiseP: RAISE.toString(), progressBps: '10000' } } });
    return { body, activity: page([...creation, ...fill], body) };
  }
  const bps = options.bps ?? 4_210n;
  const sqrt = curveSqrtAtV2(bps);
  const window = stage === 'window';
  const buyAt = window ? OPEN + 156n : OPEN + 1_812n;
  const block = CREATED + (buyAt - OPEN) / 12n;
  // The launch tax of step 13 (156 s after the open), BoxLaunchRouterV2.taxTable()[13].
  const taxPips = 797_278n;
  const buyer = options.buyer ?? (window ? LIFE_SNIPER : LIFE_BUYER);
  const buy = buyItems(block, buyAt, BOOTSTRAP_SQRT, sqrt, buyer, window ? { tax: 0n, step: 13 } : null);
  // A taxed buy pays its tax apart from the P into the pool (TaxedBuy.tax; the trade's taxQ).
  const tax = window ? (buy.p * taxPips) / (1_000_000n - taxPips) : 0n;
  if (window) {
    for (const item of buy.items) {
      if (item.kind === 'trade') item.taxQ = tax.toString();
      if ((item.data as Json | undefined)?.event === 'TaxedBuy') Object.assign(item.data as Json, { tax: tax.toString(), qIn: (buy.p + tax).toString() });
    }
  }
  const stats = curveStatistics(sqrt, supplyAfterBootstrap, 3, BOOTSTRAP_P + buy.p, 2, hour, bootstrapOpen);
  const buys = stage === 'raising' ? Math.max(1, Math.trunc(options.buys ?? 1)) : 1;
  if (buys > 1) {
    // The same raise in `buys` steps along the curve, block after block up to the single buy's own block.
    const crowd: Json[] = [];
    let from = BOOTSTRAP_SQRT;
    let volume = BOOTSTRAP_P;
    for (let k = 1; k <= buys; k += 1) {
      const to = k === buys ? sqrt : curveSqrtAtV2((bps * BigInt(k)) / BigInt(buys));
      const lag = BigInt(buys - k);
      const step = buyItems(block - lag, buyAt - 12n * lag, from, to, k === buys ? buyer : lifeCrowdV2(k), null);
      crowd.push(...step.items);
      volume += step.p;
      from = to;
    }
    const timestamp = buyAt + 1_380n;
    const body = base({ block: block + 1_380n / 12n, timestamp });
    Object.assign(body, { graduated: false, closedAt: '0', position: curve, pool: { sqrtPriceX96: sqrt.toString(), tick: 0 },
      statistics: curveStatistics(sqrt, supplyAfterBootstrap, buys + 2, volume, buys + 1, hour, bootstrapOpen) });
    return { body, activity: page([...creation, ...crowd], body) };
  }
  if (stage === 'window' || stage === 'raising') {
    const timestamp = window ? buyAt + 12n : buyAt + 1_380n;
    const body = base({ block: block + (timestamp - buyAt) / 12n, timestamp });
    Object.assign(body, { graduated: false, closedAt: '0', position: curve, pool: { sqrtPriceX96: sqrt.toString(), tick: 0 }, statistics: stats });
    return { body, activity: page([...creation, ...buy.items], body) };
  }
  // Closed at its deadline: the pot is what the curve raised, the coins counted are the buyer's; one claim so far.
  const failedAt = DEADLINE + 36n;
  const failBlock = 12_219_304n;
  const body = base({ block: failBlock + 40n, timestamp: failedAt + 480n });
  const pot = getAmount0Delta(sqrt, SQRT_B, LIQUIDITY, false);
  const claimedT = buy.t / 4n;
  const claimedP = (pot * claimedT) / buy.t;
  const ref = (blockNumber: bigint, logIndex: number, timestamp: bigint) => ({ id: `${blockNumber}-${logIndex}`, block: blockNumber.toString(), blockHash: hex32(blockNumber), timestamp: timestamp.toString(), txHash: hex32(blockNumber * 1_000n + 9n), logIndex });
  const closed = [
    { kind: 'v2_event', ...ref(failBlock, 5, failedAt), data: { source: 'coordinator', event: 'BoxFailed', emitter: COORDINATOR.toLowerCase(), caller: DEPLOYER, cause: 1, timestamp: failedAt.toString() } },
    { kind: 'v2_event', ...ref(failBlock, 6, failedAt), data: { source: 'coordinator', event: 'PotFixed', emitter: COORDINATOR.toLowerCase(), pot: pot.toString(), tLeft: buy.t.toString(), tip: '0', closer: DEPLOYER } },
    { kind: 'v2_event', ...ref(failBlock + 20n, 3, failedAt + 240n), data: { source: 'coordinator', event: 'Claimed', emitter: COORDINATOR.toLowerCase(), holder: buyer, to: buyer, t: claimedT.toString(), p: claimedP.toString() } },
  ];
  Object.assign(body, { graduated: false, closedAt: '0', position: null, pool: { sqrtPriceX96: sqrt.toString(), tick: 0 },
    failed: { cause: 'Deadline', caller: DEPLOYER, at: failedAt.toString() },
    closing: { token: (body.row as { record: { q: string } }).record.q, pot: (pot - claimedP).toString(), initialT: buy.t.toString(), tLeft: (buy.t - claimedT).toString(), creatorEntitlement: '0', inboxP: '0', pricePerTX18: '0', pricePerTDisplay: '0' },
    statistics: { ...stats, pricePPerTX18: null, marketCapP: null, raiseProgress: null } });
  return { body, activity: page([...creation, ...buy.items, ...closed], body) };
}

/**
 * The same answers for another deployment (the browser suite's local twin): the release registry and the PoolManager
 * swapped for that manifest's, everywhere they appear, so its source accepts them.
 */
export function onManifestV2(fixture: LifeFixtureV2, manifest: DeployedCoreManifestV2): LifeFixtureV2 {
  const release = manifest.releases[0];
  if (!release) throw new Error('No v2 release in the manifest');
  const swap = (text: string) => text
    .replace(new RegExp(POOL_MANAGER, 'gi'), manifest.chain.poolManager.address)
    .replace(new RegExp((sepolia.releases[0] as { registry: { address: string } }).registry.address, 'gi'), release.registry.address);
  return { body: JSON.parse(swap(JSON.stringify(fixture.body))) as Json, activity: JSON.parse(swap(JSON.stringify(fixture.activity))) as Json };
}
