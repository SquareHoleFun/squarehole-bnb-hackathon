/**
 * SH-V21-FE14: a synthetic publication of a shop whose sellers chose Into the shop (v2.1 step 7, ShopT), on the M2-52
 * double (`publishedM2`), never a deployed box. The spec's sellers' side is `BuyT / BudgetOrPile` with the canonical
 * ceiling word (the record's spec hash follows it); `money.shopFees` is the receiver and shop reads
 * (`readShopFeeStateV21`) and the top-level `shopFees` the indexer's projection (`projectShopFeesV21`), as the indexer
 * publishes them (decimal strings, `jsonV2`).
 */
import { encodeAbiParameters, keccak256, toHex } from 'viem';
import { encodeBoxSpecV2 } from '../../../../../../../packages/chain/src/core/v2';
import { jsonV2 } from '../../../../../../../packages/indexer/src/core/core-row';
import type { ShopFeeStateV21 } from '../../../../../../../packages/chain/src/core/v2/shop-fees-v21';
import { publishedM2 } from './m2-published';
import { required } from './required';

export const E18 = 10n ** 18n;
/** publishedM2's seed: 1000 T. */
export const SEED_T = 1000n * E18;

export interface ShopFeesOptions {
  readonly preset?: 2 | 4 | 8;
  /** The receiver and shop reads at the snapshot hash; null: not published. */
  readonly money?: Partial<ShopFeeStateV21> | null;
  /** The indexer's projection; null: not published. Defaults agree with the default reads. */
  readonly history?: { readonly fundedP?: bigint; readonly consumedP?: bigint; readonly toHoldersP?: bigint; readonly spentP?: bigint; readonly boughtT?: bigint } | null;
  /** M2 holder batches by id (even: sellers' trade batches, odd: buyers'), as the M2 history publishes them. */
  readonly batches?: Readonly<Record<string, { readonly fundingP: bigint | null }>>;
  /** The buyers' side, AsPaid / Holders(P) by default (the fixture's). */
  readonly buyers?: { readonly leg: number; readonly dest: number; readonly destParams: `0x${string}` };
}

export async function publishedShopFees(options: ShopFeesOptions = {}) {
  const m2 = await publishedM2(false);
  const preset = options.preset ?? 2;
  const sellers = { a: { leg: 2, dest: 7, legParams: '0x' as const, destParams: toHex(BigInt(preset), { size: 32 }) }, b: { leg: 0, dest: 0, legParams: '0x' as const, destParams: '0x' as const }, split: 1, splitParams: '0x' as const };
  const buyers = options.buyers ? { ...m2.row.spec.buyers, a: { ...m2.row.spec.buyers.a, ...options.buyers, legParams: '0x' as const } } : m2.row.spec.buyers;
  const spec = { ...m2.row.spec, buyers, sellers };
  const encodedSpec = encodeBoxSpecV2(spec);
  const record = { ...m2.row.record, specHash: keccak256(encodedSpec) };
  const row = { ...m2.row, record, specHash: record.specHash, spec, encodedSpec };
  const money: ShopFeeStateV21 = { pendingP: 500_000n, budgetT: SEED_T, ceilingT: SEED_T * BigInt(preset), feesT: 12n * E18, feesWanted: true, ...options.money };
  const history = options.history === null ? null : {
    fundedP: options.history?.fundedP ?? 4_500_000n, consumedP: options.history?.consumedP ?? 4_000_000n, spentP: options.history?.spentP ?? 3_000_000n,
    boughtT: options.history?.boughtT ?? 12n * E18,
  };
  // The projection also publishes the resolved P it sent to holders under the indexer's own name; the page takes that
  // amount from the holder batches instead, in its own words (v2-wording.test.ts).
  const held = history ? { ...history, refundedP: options.history?.toHoldersP ?? 1_000_000n, points: [], batches: {} } : null;
  const batches = Object.fromEntries(Object.entries(options.batches ?? { '1': { fundingP: 100000000n }, '2': { fundingP: 700_000n }, '4': { fundingP: 300_000n }, '6': { fundingP: null } }).map(([id, b]) => [id,
    b.fundingP === null ? { fundingP: null, complete: false, holderP: null, residueP: null, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {} }
      : { fundingP: b.fundingP, complete: true, holderP: b.fundingP, residueP: 0n, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {} }]));
  const body = {
    ...m2.body, row: jsonV2(row), ...(held ? { shopFees: jsonV2(held) } : {}),
    m2: { ...m2.body.m2, batches: jsonV2(batches), shop: { ...required(m2.body.m2.shop as Record<string, unknown> | undefined), feesT: String(money.feesT) } },
    money: { ...required(m2.body.money), ...(options.money === null ? {} : { shopFees: jsonV2(money) }) },
  };
  return { ...m2, body, row, money, history, preset };
}

/** abi.encode(uint8) for a destination word other than the canonical presets (a refused publication). */
export const word = (n: number) => encodeAbiParameters([{ type: 'uint8' }], [n]);
