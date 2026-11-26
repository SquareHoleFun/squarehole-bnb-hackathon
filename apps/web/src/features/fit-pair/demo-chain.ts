/**
 * The Demo market (D07: mock data stays labelled "Demo"): an invented but exact life of the FIT curve, block by block.
 * Every trade is one swap step of the ported Uniswap v4 math (`computeSwapStepExactIn`) on the Misfits curve's single
 * position, launch-window buys pay the router's real tax table, and each block's JSON is built with the indexer's own
 * view builders (`stateView`, `tradeView`, `windowView`, `curveView`). So a Demo frame has exactly the shape and the
 * arithmetic of a frame from the live service; only the trades are invented (a seeded generator, the same every time).
 *
 * The same simulator writes the e2e fixtures for the local-chain target (fit-fixtures.test.ts), so the browser tests
 * exercise the real parser, reducer and fallback ladder against frames the indexer would serve.
 */
import {
  computeSwapStepExactIn,
  curvePoint,
  curveView,
  headView,
  PIPS,
  positionFeeFromSwap,
  scoreOf,
  SNAPSHOT_SCHEMA,
  stateView,
  taxPipsAt,
  tickAtSqrtPrice,
  tradeView,
  windowView,
  type BlockEvent,
  type BlockHeader,
  type LiveSnapshot,
  type PoolState,
  type ReorgEvent,
  type Trade,
} from '@squarehole/indexer/client';
import type { FitMarketTarget } from './fit-target';

type Hex = `0x${string}`;
type Address = `0x${string}`;

export const DEMO_SLOT_SECONDS = 12n;
/** Unix time of the Demo target's deploy block (2026-09-30 00:00:00 UTC). */
export const DEMO_GENESIS_TIME = 1_790_726_400n;
/** The genesis bootstrap buy (ADR-0013's launch shape): 0.0015 ETH, its FIT burned. */
export const BOOTSTRAP_WEI = 1_500_000_000_000_000n;
const LP_FEE_PIPS = 10_000n;
const CONFIRMATIONS = 2;
const SNAPSHOT_TRADES = 25;
const KEEP_BLOCKS = 256;
const ETHER = 10n ** 18n;

export type DemoScenario = 'before_open' | 'window' | 'curve' | 'completed' | 'migrated' | 'stale' | 'unverified' | 'reorg';
export const DEMO_SCENARIOS: readonly DemoScenario[] = Object.freeze(['before_open', 'window', 'curve', 'completed', 'migrated', 'stale', 'unverified', 'reorg']);
export const isDemoScenario = (value: unknown): value is DemoScenario => typeof value === 'string' && (DEMO_SCENARIOS as readonly string[]).includes(value);

interface TradeSpec {
  readonly side: 'buy' | 'sell';
  /** Buy: ETH the buyer sends (tax included in the window). Sell: FIT in. */
  readonly amount: bigint;
  readonly trader: Address;
}

interface MinedBlock {
  readonly header: BlockHeader;
  readonly state: PoolState;
  readonly trades: readonly Trade[];
}

/** Seeded 64-bit LCG (Knuth's MMIX constants): the same invented trades on every run. */
function rng(seed: bigint): () => bigint {
  let x = (seed * 0x9e3779b97f4a7c15n + 0x632be59bd9b4e019n) & ((1n << 64n) - 1n);
  return () => {
    x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return x >> 16n;
  };
}

const hex64 = (value: bigint): string => value.toString(16).padStart(16, '0');
export const demoBlockHash = (number: bigint, branch = 0): Hex => `0x${'d'.repeat(46)}${branch.toString(16).padStart(2, '0')}${hex64(number)}` as Hex;
const txHash = (number: bigint, index: number, branch: number): Hex => `0x${'7'.repeat(44)}${branch.toString(16).padStart(2, '0')}${hex64(number)}${index.toString(16).padStart(2, '0')}` as Hex;
const DEMO_FALLBACK_TRADER = `0x${'0'.repeat(36)}de01` as Address;
/** Launch-window buys, in milli-ETH (tax included). */
const WINDOW_BUYS_MILLI: readonly bigint[] = [10n, 20n, 50n, 100n];
const TRADERS: readonly Address[] = Array.from({ length: 12 }, (_, i) => `0x${'0'.repeat(36)}d${(0xe01 + i).toString(16)}` as Address);

/** Market mood per scenario: how busy blocks are and how large buys run (in thousandths of an ETH). */
interface Pace {
  /** Chance in 100 that a block after the window has a trade. */
  readonly tradeChance: bigint;
  /** Buy sizes after the window, in milli-ETH. */
  readonly buySizes: readonly bigint[];
  /** Chance in 100 that a trade after the window is a sell. */
  readonly sellChance: bigint;
}

const CALM: Pace = { tradeChance: 45n, buySizes: [4n, 8n, 15n, 25n, 40n, 60n], sellChance: 30n };
const RUSH: Pace = { tradeChance: 90n, buySizes: [40n, 80n, 120n, 200n, 300n], sellChance: 10n };

/**
 * The Demo chain: mines one block at a time from the genesis, with the trades a seeded generator invents for it. It
 * keeps the recent blocks so it can answer "the state N blocks ago" and roll back (the reorg scenario).
 */
export class DemoChain {
  readonly target: FitMarketTarget;
  private readonly pace: Pace;
  private readonly blocks: MinedBlock[] = [];
  private readonly allTrades: Trade[] = [];
  private branch = 0;

  constructor(target: FitMarketTarget, pace: 'calm' | 'rush' = 'calm') {
    this.target = target;
    this.pace = pace === 'rush' ? RUSH : CALM;
    this.mineGenesis();
  }

  get head(): MinedBlock {
    const head = this.blocks.at(-1);
    if (!head) throw new Error('the sample chain has no blocks');
    return head;
  }

  /** The newest block's state at or below `number`. */
  stateAt(number: bigint): PoolState {
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const block = this.blocks[i];
      if (block && block.header.number <= number) return block.state;
    }
    return this.blocks[0]?.state ?? this.head.state;
  }

  headerOf(number: bigint): BlockHeader {
    const block = this.blocks.find((candidate) => candidate.header.number === number);
    if (!block) throw new Error(`block ${number} is not kept`);
    return block.header;
  }

  /** Mines blocks up to `number` (each with its invented trades). */
  mineTo(number: bigint): void {
    while (this.head.header.number < number) this.mineNext();
  }

  /** Mines until the curve completes (a block ends at the completion price), at most `limit` blocks. */
  mineUntilCompleted(limit = 20_000): void {
    for (let i = 0; i < limit && this.head.state.phase === 'curve'; i += 1) this.mineNext();
    if (this.head.state.phase === 'curve') throw new Error('the sample curve did not complete');
  }

  /** The graduation: migrates at `number` (FitPoolHook.Migrated); the curve figures stop meaning anything. */
  migrateAt(number: bigint): void {
    this.mineTo(number - 1n);
    const previous = this.head.state;
    if (previous.phase !== 'completed' || previous.completedBlock === null || number < previous.completedBlock + 32n) throw new Error('migration needs a completed curve and the 32-block latch');
    this.pushBlock(this.nextHeader(), { ...previous, phase: 'migrated', migratedBlock: number }, []);
  }

  mineNext(): MinedBlock {
    const header = this.nextHeader();
    const random = rng(header.number * 131n + BigInt(this.branch));
    const specs = this.specsFor(header.number, random);
    let state: PoolState = { ...this.head.state, block: header.number, blockHash: header.hash, timestamp: header.timestamp };
    const trades: Trade[] = [];
    specs.forEach((spec, index) => {
      if (state.phase !== 'curve') return;
      const result = this.swap(state, header, spec, index);
      if (result === null) return;
      state = result.state;
      trades.push(result.trade);
    });
    if (state.phase === 'curve' && state.sqrtPriceX96 <= this.target.curve.sqrtPriceLowerX96) state = { ...state, phase: 'completed', completedBlock: header.number };
    return this.pushBlock(header, state, trades);
  }

  /** Drops the newest `depth` blocks (a reorg) and mines their heights again on another branch. */
  rollback(depth: number): { readonly from: MinedBlock; readonly ancestor: MinedBlock; readonly dropped: readonly Trade[] } {
    const from = this.head;
    const removed = this.blocks.splice(this.blocks.length - depth, depth);
    const droppedIds = new Set(removed.flatMap((block) => block.trades.map((trade) => trade.id)));
    const dropped = this.allTrades.filter((trade) => droppedIds.has(trade.id));
    this.allTrades.splice(0, this.allTrades.length, ...this.allTrades.filter((trade) => !droppedIds.has(trade.id)));
    this.branch += 1;
    return { from, ancestor: this.head, dropped };
  }

  trades(): readonly Trade[] {
    return this.allTrades;
  }

  // ------------------------------------------------------------------------------------------------ JSON frames

  snapshot(nowMs: number): LiveSnapshot {
    const { header, state } = this.head;
    const confirmed = this.confirmedFor(header.number);
    return {
      schema: SNAPSHOT_SCHEMA,
      chainId: this.target.chainId,
      poolId: this.target.poolId,
      label: this.target.label,
      tokenSymbol: 'FIT',
      source: 'indexer',
      head: headView(header, 'fixture', Number(header.timestamp) * 1000),
      confirmations: CONFIRMATIONS,
      finality: this.finality(header.number),
      state: stateView(state, this.target.curve),
      confirmed: confirmed ? stateView(confirmed, this.target.curve) : null,
      window: windowView(header, this.target),
      curve: curveView(this.target.curve),
      trades: this.allTrades.slice(-SNAPSHOT_TRADES).reverse().map(tradeView),
      activity: [],
      builtAtMs: nowMs,
    };
  }

  blockEvent(seq: number, block: MinedBlock): BlockEvent {
    const { header, state, trades } = block;
    const confirmed = this.confirmedFor(header.number);
    return {
      id: `${seq}-${header.number}:${header.hash.slice(2, 10)}`,
      head: headView(header, 'fixture', Number(header.timestamp) * 1000),
      finality: this.finality(header.number),
      state: stateView(state, this.target.curve),
      confirmed: confirmed && !sameCurve(confirmed, state) ? stateView(confirmed, this.target.curve) : null,
      window: windowView(header, this.target),
      trades: trades.map(tradeView),
      activity: [],
      timing: { blockTs: header.timestamp.toString(), seenAtMs: Number(header.timestamp) * 1000, committedAtMs: Number(header.timestamp) * 1000, rpcCalls: 0 },
    };
  }

  reorgEvent(seq: number, rolled: ReturnType<DemoChain['rollback']>): ReorgEvent {
    const { header, state } = rolled.ancestor;
    const confirmed = this.confirmedFor(header.number);
    return {
      id: `${seq}-${header.number}:${header.hash.slice(2, 10)}`,
      fromBlock: rolled.from.header.number.toString(),
      toBlock: header.number.toString(),
      depth: Number(rolled.from.header.number - header.number),
      droppedTradeIds: rolled.dropped.map((trade) => trade.id),
      droppedActivityIds: [],
      head: headView(header, 'fixture', Number(header.timestamp) * 1000),
      finality: this.finality(header.number),
      state: stateView(state, this.target.curve),
      confirmed: confirmed && !sameCurve(confirmed, state) ? stateView(confirmed, this.target.curve) : null,
      window: windowView(header, this.target),
    };
  }

  // ------------------------------------------------------------------------------------------------ internals

  private finality(head: bigint) {
    return {
      confirmedBlock: (head - BigInt(CONFIRMATIONS) + 1n).toString(),
      safeBlock: (head - 32n).toString(),
      finalizedBlock: (head - 64n).toString(),
    };
  }

  private confirmedFor(head: bigint): PoolState | null {
    const number = head - BigInt(CONFIRMATIONS) + 1n;
    return number < (this.blocks[0]?.header.number ?? 0n) ? null : this.stateAt(number);
  }

  private nextHeader(): BlockHeader {
    const parent = this.blocks.at(-1)?.header;
    const number = parent ? parent.number + 1n : this.target.deployBlock;
    return {
      number,
      hash: demoBlockHash(number, this.branch),
      parentHash: parent?.hash ?? (`0x${'0'.repeat(64)}` as Hex),
      timestamp: DEMO_GENESIS_TIME + (number - this.target.deployBlock) * DEMO_SLOT_SECONDS,
    };
  }

  private pushBlock(header: BlockHeader, state: PoolState, trades: readonly Trade[]): MinedBlock {
    const block: MinedBlock = Object.freeze({ header, state: { ...state, block: header.number, blockHash: header.hash, timestamp: header.timestamp }, trades: Object.freeze([...trades]) });
    this.blocks.push(block);
    if (this.blocks.length > KEEP_BLOCKS) this.blocks.splice(0, this.blocks.length - KEEP_BLOCKS);
    this.allTrades.push(...trades);
    if (this.allTrades.length > 400) this.allTrades.splice(0, this.allTrades.length - 400);
    return block;
  }

  private mineGenesis(): void {
    const header = this.nextHeader();
    const curve = this.target.curve;
    const base: PoolState = {
      block: header.number,
      blockHash: header.hash,
      timestamp: header.timestamp,
      sqrtPriceX96: curve.sqrtPriceUpperX96,
      tick: curve.tickUpper,
      liquidity: curve.liquidity,
      swapCount: 0,
      buyCount: 0,
      sellCount: 0,
      volumeWei: 0n,
      feesWei: 0n,
      feesTokenRaw: 0n,
      taxWei: 0n,
      burnedRaw: 0n,
      lastTradeBlock: null,
      anomalies: 0,
      phase: 'curve',
      completedBlock: null,
      migratedBlock: null,
    };
    // The genesis bootstrap buy (untaxed, before the open): its FIT is burned.
    const result = this.swap(base, header, { side: 'buy', amount: BOOTSTRAP_WEI, trader: this.target.hook }, 0, 'bootstrap');
    if (result === null) throw new Error('the bootstrap buy failed');
    this.pushBlock(header, { ...result.state, burnedRaw: result.trade.tokenRaw }, [result.trade]);
  }

  private specsFor(number: bigint, random: () => bigint): TradeSpec[] {
    const { openBlock, closeBlock } = this.target;
    const state = this.head.state;
    if (number < openBlock || state.phase !== 'curve') return [];
    const trader = (): Address => TRADERS[Number(random() % BigInt(TRADERS.length))] ?? DEMO_FALLBACK_TRADER;
    if (number < closeBlock) {
      // The launch window: a few router buys a block, smaller as the tax is high.
      const count = Number(random() % 3n);
      return Array.from({ length: count }, () => ({ side: 'buy' as const, amount: (WINDOW_BUYS_MILLI[Number(random() % 4n)] ?? 10n) * (ETHER / 1_000n), trader: trader() }));
    }
    if (random() % 100n >= this.pace.tradeChance) return [];
    const sells = random() % 100n < this.pace.sellChance;
    if (sells) {
      // A holder sells part of what the last buys took out (never more than the curve sold).
      const sold = curvePoint(state.sqrtPriceX96, this.target.curve).soldRaw;
      const amount = (sold * (1n + (random() % 3n))) / 100n;
      return amount > 0n ? [{ side: 'sell', amount, trader: trader() }] : [];
    }
    const size = this.pace.buySizes[Number(random() % BigInt(this.pace.buySizes.length))] ?? 10n;
    return [{ side: 'buy', amount: size * (ETHER / 1_000n), trader: trader() }];
  }

  private swap(state: PoolState, header: BlockHeader, spec: TradeSpec, index: number, route?: Trade['route']): { state: PoolState; trade: Trade } | null {
    const curve = this.target.curve;
    const buy = spec.side === 'buy';
    const inWindow = header.number >= this.target.openBlock && header.number < this.target.closeBlock;
    const tradeRoute: Trade['route'] = route ?? (buy && inWindow ? 'launch_router' : 'other');
    const taxRaw = tradeRoute === 'launch_router' ? (spec.amount * BigInt(taxPipsAt(header.number - this.target.openBlock))) / BigInt(PIPS) : 0n;
    const amountIn = spec.amount - taxRaw;
    if (amountIn <= 0n) return null;
    const limit = buy ? curve.sqrtPriceLowerX96 : curve.sqrtPriceUpperX96;
    if (state.sqrtPriceX96 === limit) return null;
    const step = computeSwapStepExactIn(state.sqrtPriceX96, limit, curve.liquidity, amountIn, LP_FEE_PIPS);
    const fee = positionFeeFromSwap(step.feeAmount, curve.liquidity);
    const sqrtAfter = step.sqrtPriceNextX96;
    const point = curvePoint(sqrtAfter, curve);
    const ethRaw = buy ? step.amountIn + step.feeAmount : step.amountOut;
    const tokenRaw = buy ? step.amountOut : step.amountIn + step.feeAmount;
    const logIndex = index * 4;
    const trade: Trade = {
      id: `${header.hash}:${logIndex}`,
      score: scoreOf(header.number, logIndex),
      block: header.number,
      blockHash: header.hash,
      timestamp: header.timestamp,
      txHash: txHash(header.number, index, this.branch),
      logIndex,
      side: spec.side,
      route: tradeRoute,
      ethRaw,
      tokenRaw,
      feeEthRaw: buy ? fee : 0n,
      feeTokenRaw: buy ? 0n : fee,
      taxRaw,
      trader: spec.trader,
      recipient: spec.trader,
      sqrtPriceX96After: sqrtAfter,
      tickAfter: tickAtSqrtPrice(sqrtAfter),
      retainedAfterWei: point.retainedWei,
      fillBpsAfter: point.fillBps,
    };
    const next: PoolState = {
      ...state,
      sqrtPriceX96: sqrtAfter,
      tick: trade.tickAfter,
      swapCount: state.swapCount + 1,
      buyCount: state.buyCount + (buy ? 1 : 0),
      sellCount: state.sellCount + (buy ? 0 : 1),
      volumeWei: state.volumeWei + ethRaw,
      feesWei: state.feesWei + (buy ? fee : 0n),
      feesTokenRaw: state.feesTokenRaw + (buy ? 0n : fee),
      taxWei: state.taxWei + taxRaw,
      lastTradeBlock: header.number,
    };
    return { state: next, trade };
  }
}

function sameCurve(a: PoolState, b: PoolState): boolean {
  return a.sqrtPriceX96 === b.sqrtPriceX96 && a.swapCount === b.swapCount && a.burnedRaw === b.burnedRaw && a.feesWei === b.feesWei;
}

/** Where each Demo scenario starts. Mining is deterministic, so the same scenario always shows the same numbers. */
export function demoChainFor(target: FitMarketTarget, scenario: DemoScenario): DemoChain {
  switch (scenario) {
    case 'before_open': {
      const chain = new DemoChain(target);
      chain.mineTo(target.openBlock - 13n);
      return chain;
    }
    case 'window': {
      const chain = new DemoChain(target);
      chain.mineTo(target.openBlock + 9n);
      return chain;
    }
    case 'completed': {
      const chain = new DemoChain(target, 'rush');
      chain.mineUntilCompleted();
      chain.mineTo(chain.head.header.number + 12n);
      return chain;
    }
    case 'migrated': {
      const chain = new DemoChain(target, 'rush');
      chain.mineUntilCompleted();
      const completed = chain.head.state.completedBlock ?? chain.head.header.number;
      chain.migrateAt(completed + 40n);
      chain.mineTo(completed + 50n);
      return chain;
    }
    case 'curve':
    case 'stale':
    case 'unverified':
    case 'reorg': {
      const chain = new DemoChain(target);
      chain.mineTo(target.openBlock + 660n);
      return chain;
    }
  }
}
