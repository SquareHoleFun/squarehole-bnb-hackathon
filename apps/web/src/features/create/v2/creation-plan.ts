import type { Hex } from 'viem';
import { CREATE_CHUNK_MAX_V2, chunkChainV2, tokenUriTextsV2 } from '../../../../../../packages/chain/src/core/v2';
import { NATIVE_TOKEN, bootstrapFor, type SiteListing } from './listings';
import { BoxTypeV2, ChunkPart, encodeBoxSpecV2, type BoxSpecV2 } from './spec-types';

export const CREATE_GAS_LIMIT_MAX = 49_500_000n;
const GAS_MARGIN_MIN = 150_000n;

/** BoxCoordinatorV2.CHUNK_MAX at the release (TA-21); a real build checks the release's coordinator answers it before sending. */
export const CREATE_CHUNK_MAX = CREATE_CHUNK_MAX_V2;
/** The Demo's estimate of `createBox` (ADR-0017 § 6: a plain box near 6.6-8.8M) plus the spec's calldata [I]; a real build estimates on chain. */
export const demoCreateGas = (spec: BoxSpecV2): bigint => 7_000_000n + 16n * BigInt((encodeBoxSpecV2(spec).length - 2) / 2);

/**
 * The limit to send with: the estimate plus 20% or 150k, whichever is more; null when that passes 49.5M, never a
 * capped limit below its margin (ADR-0017 § 6 puts the heaviest valid spec near 39.1M, so such an estimate is wrong).
 */
export function createGasLimit(estimate: bigint): bigint | null {
  const margin = estimate / 5n > GAS_MARGIN_MIN ? estimate / 5n : GAS_MARGIN_MIN;
  return estimate + margin > CREATE_GAS_LIMIT_MAX ? null : estimate + margin;
}

export interface PlanStep {
  /**
   * `approveSeed` and `loadSeed` are a pile's seed (M3): an exact ERC-20 approval of the pile, then its pull. A shop's
   * seed (M2) is `approveShopSeed` (an exact approval of the shop on T), `fundSeed` (the shop pulls it) and `complete`
   * (the starter set's loader sees the seed and its items and opens the box). A shop's starter items (SH-SHOP-CREATE)
   * come before its seed: `approveStarter` (one item approved to the shop, `index` in the set) for each item of a
   * loader page, then `loadStarter` (the page, `index`; at most STARTER_PAGE items).
   */
  readonly call: 'approve' | 'createBox' | 'loadChunk' | 'approveSeed' | 'loadSeed' | 'approveStarter' | 'loadStarter' | 'approveShopSeed' | 'fundSeed' | 'complete';
  readonly args?: readonly unknown[];
  /** ETH sent with the call. */
  readonly value?: bigint;
  /** An approval's exact amount, in the pricing token's raw units (the seed coin's for `approveSeed`, T's for a shop's seed). */
  readonly amount?: bigint;
  readonly gasLimit?: bigint;
  readonly part?: number;
  readonly index?: number;
  readonly data?: Hex;
  readonly nextHash?: Hex;
}

/** Why there is no plan: the estimate does not fit, the listing changed, or a chain figure is not read. */
export type PlanBlock = 'too-heavy' | 'listing-changed' | 'unread';

export interface CreationPlan {
  readonly steps: readonly PlanStep[];
  /** Null when Create can send the steps. */
  readonly blocked: PlanBlock | null;
  /** True while the box waits for chunks after `createBox`. */
  readonly waits: boolean;
  /** The Demo's createBox estimate and limit; null on a real build (estimated on chain at send time). */
  readonly estimate: bigint | null;
  readonly gasLimit: bigint | null;
}

export interface PlanOptions {
  /** The Demo's createBox estimate; null on a real build, which estimates each step on chain as it sends it. */
  readonly estimate: ((spec: BoxSpecV2) => bigint) | null;
  /** A pile's seed coin and exact raw seed; its steps follow `createBox`, never inside the creation payment (S5). */
  readonly seed?: { readonly listing: SiteListing; readonly amount: bigint } | null;
  /** A shop's seed in raw T (IShopVaultV2 `fundSeed`): pulled from the creator after `createBox`, before the box opens. */
  readonly shopSeedT?: bigint | null;
  /** A shop's starter items: how many (add-on 8's count), each approved and then loaded a page at a time after `createBox`. */
  readonly starters?: number;
}

/** IShopVaultV2 `ShopLimitsV2.MAX_STARTER_BATCH`: the starter loader takes at most this many items per page. */
export const STARTER_PAGE = 32;
/** The starter loader's pages for `count` items. */
export const starterPages = (count: number): number => Math.ceil(count / STARTER_PAGE);
/** A starter item's approval to the shop, and a page of the starter loader, as the plan names them: numbers first. */
export const starterApproveLabel = (index: number, count: number): string => `Approve starter ${index + 1}/${count}`;
export const starterPageLabel = (page: number, pages: number): string => `Load starter items ${page + 1}/${pages}`;

export function creationPlan(spec: BoxSpecV2, listing: SiteListing, { estimate, seed = null, shopSeedT = null, starters = 0 }: PlanOptions): CreationPlan {
  const gas = estimate ? estimate(spec) : null;
  const gasLimit = gas === null ? null : createGasLimit(gas);
  const none = (blocked: PlanBlock): CreationPlan => ({ steps: [], blocked, waits: false, estimate: gas, gasLimit });
  if (gas !== null && gasLimit === null) return none('too-heavy');
  if (spec.pricing.listingId !== listing.id || spec.pricing.token.toLowerCase() !== listing.token.toLowerCase() || spec.raise !== listing.raise) return none('listing-changed');
  const bootstrap = bootstrapFor(listing, spec.raise);
  if (bootstrap === null) return none('unread');
  const steps: PlanStep[] = [];
  const pay = bootstrap + spec.creatorBuy;
  const native = listing.token.toLowerCase() === NATIVE_TOKEN;
  if (!native) steps.push({ call: 'approve', amount: pay });
  steps.push({ call: 'createBox', value: native ? pay : 0n, ...(gasLimit === null ? {} : { gasLimit }) });
  for (const [part, data] of [
    [ChunkPart.Table, spec.metadataTable],
    [ChunkPart.Texts, tokenUriTextsV2(spec)],
  ] as const) {
    chunkChainV2(data).chunks.forEach((chunk, index) => steps.push({ call: 'loadChunk', part, index, data: chunk.data, nextHash: chunk.nextHash }));
  }
  // A nonzero seed holds the opening gate until the pile pulls it: ERC-20 by an exact approval, native by exact value.
  if (spec.boxType === BoxTypeV2.PILE && seed && seed.amount > 0n) {
    const nativeSeed = seed.listing.token.toLowerCase() === NATIVE_TOKEN;
    if (!nativeSeed) steps.push({ call: 'approveSeed', amount: seed.amount });
    steps.push({ call: 'loadSeed', value: nativeSeed ? seed.amount : 0n, amount: seed.amount });
  }
  // A shop's seed holds its opening gate until the shop pulls it from the creator's T and the loader completes. Its
  // starter items come first: each page's items approved to the shop one by one, then the page loaded.
  if (spec.boxType === BoxTypeV2.SHOP && shopSeedT !== null && shopSeedT > 0n) {
    for (let page = 0; page < starterPages(starters); page += 1) {
      for (let index = page * STARTER_PAGE; index < Math.min(starters, (page + 1) * STARTER_PAGE); index += 1) steps.push({ call: 'approveStarter', index });
      steps.push({ call: 'loadStarter', index: page });
    }
    steps.push({ call: 'approveShopSeed', amount: shopSeedT }, { call: 'fundSeed', amount: shopSeedT }, { call: 'complete' });
  }
  return { steps, blocked: null, waits: steps.some((step) => step.call === 'loadChunk' || step.call === 'loadSeed' || step.call === 'complete'), estimate: gas, gasLimit };
}

export type BoxStatus =
  | { readonly state: 'sending'; readonly done: number; readonly total: number }
  | { readonly state: 'waiting'; readonly loaded: number; readonly chunks: number; readonly waitsFor: 'table' | 'seed' }
  | { readonly state: 'open' };

/** Where the box stands once `sent` steps are in: sending, waiting for its chunks, or open; a list-first plan ends listed. */
export function boxStatus(plan: CreationPlan, sent: number): BoxStatus {
  const createAt = plan.steps.findIndex((step) => step.call === 'createBox');
  if (sent <= createAt) return { state: 'sending', done: sent, total: plan.steps.length };
  const chunks = plan.steps.length - createAt - 1;
  const loaded = sent - createAt - 1;
  const waitsFor = plan.steps.some((step) => step.call === 'loadChunk') ? 'table' : 'seed';
  return loaded < chunks ? { state: 'waiting', loaded, chunks, waitsFor } : { state: 'open' };
}
