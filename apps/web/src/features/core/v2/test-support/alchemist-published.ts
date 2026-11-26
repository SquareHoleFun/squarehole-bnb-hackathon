/**
 * SH-V21-FE14: a synthetic publication of a coin pile whose buyers' fees a directory action converts (v2.1 step 8, The
 * Alchemist's shape: AsPaid / Module with the row's uint32 id, a pile in another coin than the price coin), on the M3
 * double (`publishedPile`), never a deployed box. `money.modules` is the receiver's per-side module snapshot and P waiting
 * (`readFeeModulesV21`), and the top-level `alchemist` the indexer's conversion totals (`alchemistGrowthV21`), as the
 * indexer publishes them (decimal strings).
 */
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { encodeBoxSpecV2 } from '../../../../../../../packages/chain/src/core/v2';
import { jsonV2 } from '../../../../../../../packages/indexer/src/core/core-row';
import { ETH, publishedPile, type PileOptions } from './m3-published';
import { required } from './required';

export const MODULE = '0x0000000000000000000000000000000000000051' as Address;
export const MODULE_HASH = keccak256('0x01') as Hex;
/** RC5-B: a step's raw P too small for any pool to pay out, kept as claims for the box's pool depth (a few raw units, as on chain). */
export const DUST_P = 10n;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

export interface AlchemistOptions extends PileOptions {
  readonly id?: number;
  /** The P waiting for the buyers' module side; null: the money read is unpublished. */
  readonly pendingP?: bigint | null;
  /**
   * The conversion totals; null: unpublished. `dustToDepthP` (RC5-B: P of too-small steps moved to the box's pool depth)
   * absent: an older publication. `dustP` (the pre-RC5 FIT Safe figure) may be set to prove it is never read.
   */
  readonly totals?: { readonly inputP: bigint; readonly receivedAsset: bigint; readonly dustToDepthP?: bigint; readonly dustP?: bigint } | null;
}

export async function publishedAlchemistPile(options: AlchemistOptions = {}) {
  const pile = await publishedPile({ asset: '0x00000000000000000000000000000000000000e3', seed: 0n, leaveBehindBps: 500, balance: 25n * ETH / 10n, ...options });
  const row = pile.row as unknown as { spec: Record<string, unknown>; record: Record<string, unknown> };
  const buyers = { a: { leg: 1, dest: 9, legParams: '0x' as const, destParams: toHex(BigInt(options.id ?? 4), { size: 32 }) }, b: { leg: 0, dest: 0, legParams: '0x' as const, destParams: '0x' as const }, split: 1, splitParams: '0x' as const };
  const spec = { ...row.spec, buyers };
  const encodedSpec = encodeBoxSpecV2(spec as never);
  const record = { ...row.record, specHash: keccak256(encodedSpec) };
  const nextRow = { ...pile.row, record, specHash: record.specHash, spec, encodedSpec };
  const side = (module: Address, pendingP: bigint) => ({ module, codeHash: module === ZERO ? `0x${'0'.repeat(64)}` : MODULE_HASH, pendingP });
  const modules = options.pendingP === null ? null : { buyers: side(MODULE, options.pendingP ?? 3n * ETH / 10n), sellers: side(ZERO, 0n) };
  const totals = options.totals === undefined ? { inputP: ETH, receivedAsset: 5n * ETH / 10n, dustToDepthP: DUST_P } : options.totals;
  const body = {
    ...pile.body, row: jsonV2(nextRow), ...(totals ? { alchemist: jsonV2(totals) } : {}),
    money: { ...required(pile.body.money), ...(modules ? { modules: jsonV2(modules) } : {}) },
  };
  return { ...pile, body, row: nextRow, modules, totals };
}
