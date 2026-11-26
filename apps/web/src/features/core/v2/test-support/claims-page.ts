/**
 * Synthetic answers of the wallet claims index (SH-V2-CLAIMS-INDEX, `sh.core-claims.v2`) for tests: built as the
 * endpoint's JSON, decimal strings only, and checked by the chain reader's own schema, so a fixture the real reader
 * would refuse never reaches a test. Never a deployed box or a real wallet's claims.
 */
import type { Address, Hex } from 'viem';
import { rolesOfV2 } from '../../../../../../../packages/chain/src/core/v2';
import { walletClaimsPageSchemaV2, type WalletClaimsPageV2 } from '../../../../../../../packages/chain/src/core/v2/claims-types';

/** The box a row belongs to: its registry, id, coin, price coin and record (for its roles). */
export interface ClaimsBox { readonly registry: string; readonly boxId: string | bigint; readonly token: string; readonly q: string; readonly record: unknown }
/** A mined payment of the row's claim: block, transaction and log. */
export interface Paid { readonly block: bigint; readonly tx: Hex; readonly logIndex?: number }
export type ClaimRow =
  | { readonly kind: 'holder'; readonly batch: bigint; readonly amount: bigint | null; readonly payout?: 'available' | 'unavailable' | 'unverified'; readonly paid?: Paid }
  | { readonly kind: 'item'; readonly id: bigint; readonly amount: bigint | null; readonly stash?: bigint; readonly payout?: 'available' | 'unavailable' | 'unverified'; readonly paid?: Paid }
  | { readonly kind: 'creator'; readonly amount: bigint; readonly payout?: 'available' | 'unavailable'; readonly paid?: Paid }
  /** `inboxP` (RC6-RR-INBOX): the inbox P this creator's quote includes, which the claim first moves into the pot. */
  | { readonly kind: 'no_buyer'; readonly amount: bigint; readonly paid?: Paid; readonly inboxP?: bigint }
  /**
   * `inboxP` (RC6-RR-INBOX): a priced final share whose quote `amount` includes that inbox P; its pot is the rest. No
   * unpriced collect-first row: the chain schema refuses it since SH-RC7 item 29 (claims-types.ts).
   */
  | { readonly kind: 'failure'; readonly coins: bigint; readonly amount: bigint; readonly allowance?: bigint; readonly paid?: Paid; readonly inboxP?: bigint };

const low = (value: string) => value.toLowerCase();
const hex64 = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

/** The box identity from a published body (`row.registry`, `row.record`) or a parsed snapshot. */
export function claimsBoxOf(body: { readonly token: string; readonly row: { readonly registry: string; readonly record: { readonly boxId: string | bigint; readonly q: string } } }): ClaimsBox {
  return { registry: body.row.registry, boxId: body.row.record.boxId, token: body.token, q: body.row.record.q, record: body.row.record };
}

/** One page of the endpoint's JSON at block `block`, every row of `wallet` on `boxes`. */
export function claimsPageJson(input: { readonly chainId: number; readonly wallet: Address; readonly block: bigint; readonly hash?: Hex; readonly rows: readonly { readonly box: ClaimsBox; readonly row: ClaimRow }[] }) {
  const asOf = { block: String(input.block), hash: input.hash ?? hex64(input.block), timestamp: String(1_000n + input.block), tier: 'head' as const };
  const wallet = low(input.wallet);
  const items = input.rows.map(({ box, row }) => {
    const roles = rolesOfV2(box.record as never).contracts;
    const role = row.kind === 'holder' ? roles.holderLedger : row.kind === 'item' ? roles.itemLedger : row.kind === 'creator' ? roles.receiver : roles.coordinator;
    if (!role) throw new Error(`No ${row.kind} role on this box`);
    const ref = { registry: low(box.registry), boxId: String(box.boxId), token: low(box.token) };
    const id = row.kind === 'holder' ? row.batch : row.kind === 'item' ? row.id : null;
    const key = `${ref.registry}:${ref.boxId}:${ref.token}`;
    const common = { wallet, box: ref, roleAddress: low(role), asset: low(box.q), asOf };
    if (row.paid) {
      const payment = { block: String(row.paid.block), hash: hex64(row.paid.block), txHash: row.paid.tx, logIndex: row.paid.logIndex ?? 0, to: wallet, grossP: String(row.amount ?? 0n), tipP: '0' };
      const paid = { ...common, id: `${key}:paid:${payment.hash}:${payment.logIndex}`, status: 'claimed', amountP: String(row.amount ?? 0n), payout: 'paid', payment };
      switch (row.kind) {
        case 'holder': return { ...paid, kind: 'holder', batchId: String(row.batch) };
        case 'item': return { ...paid, kind: 'item', itemId: String(row.id), outsideP: null, stashP: null };
        case 'creator': return { ...paid, kind: 'creator' };
        case 'no_buyer': return { ...paid, kind: 'no_buyer', coinsT: '0', pot: null };
        case 'failure': return { ...paid, kind: 'failure', coinsT: String(row.coins), allowanceT: null, pot: null, tLeft: null };
      }
    }
    // A row in the box token (v2.1 step 2: `q` given as the box's own token) gets the endpoint's `:t` key suffix.
    const open = { ...common, id: `${key}:${row.kind}:${id ?? wallet}${low(box.q) === low(box.token) ? ':t' : ''}`, payment: null };
    switch (row.kind) {
      case 'holder': return { ...open, kind: 'holder', batchId: String(row.batch), status: row.amount === null ? 'pending' : 'claimable', amountP: row.amount === null ? null : String(row.amount), payout: row.amount === null ? 'not_ready' : row.payout ?? 'available' };
      case 'item': return { ...open, kind: 'item', itemId: String(row.id), status: row.amount === null ? 'pending' : 'claimable', amountP: row.amount === null ? null : String(row.amount),
        outsideP: row.amount === null ? null : String(row.amount - (row.stash ?? 0n)), stashP: row.amount === null ? null : String(row.stash ?? 0n), payout: row.amount === null ? 'not_ready' : row.payout ?? 'available' };
      case 'creator': return { ...open, kind: 'creator', status: 'claimable', amountP: String(row.amount), payout: row.payout ?? 'available' };
      case 'no_buyer': return { ...open, kind: 'no_buyer', status: 'claimable', amountP: String(row.amount), payout: 'unverified', coinsT: '0', pot: String(row.amount),
        ...(row.inboxP !== undefined ? { collectFirst: { pendingP: String(row.inboxP), message: "the claim moves the inbox's P into the pot first" } } : {}) };
      case 'failure': return { ...open, kind: 'failure', status: 'claimable', amountP: String(row.amount), payout: 'unverified', coinsT: String(row.coins), allowanceT: String(row.allowance ?? 0n),
        pot: String(row.amount - (row.inboxP ?? 0n)), tLeft: String(row.coins),
        ...(row.inboxP !== undefined ? { collectFirst: { pendingP: String(row.inboxP), message: "the claim moves the inbox's P into the pot first" } } : {}) };
    }
  });
  const page = { schema: 'sh.core-claims.v2', chainId: input.chainId, wallet, asOf, recentFromBlock: String(input.block > 7_199n ? input.block - 7_199n : 0n), items, next: null };
  walletClaimsPageSchemaV2.parse(page);
  return page;
}

/** The same page as the chain reader returns it (validated). */
export const claimsPage = (input: Parameters<typeof claimsPageJson>[0]): WalletClaimsPageV2 => walletClaimsPageSchemaV2.parse(claimsPageJson(input));

/** The box identity of a parsed snapshot. */
export const claimsBoxOfView = (view: { readonly token: string; readonly release: { readonly registry: { readonly address: string } }; readonly record: { readonly boxId: bigint; readonly q: string } }): ClaimsBox =>
  ({ registry: view.release.registry.address, boxId: view.record.boxId, token: view.token, q: view.record.q, record: view.record });
