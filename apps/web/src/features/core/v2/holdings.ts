/**
 * SH-291: what one wallet holds across this source's current-generation (v2) boxes, for My Box. Three parts:
 * - the box tokens it holds (`balanceOf` on every v2 box token in the feed), each valued in its box's price coin at the
 *   box's own last price from the index's statistics (`pricePPerTX18`), where the box page shows that price too;
 * - its items: a box's own items the index places with this wallet (the items history or the vault inventory, as the
 *   box page's Items card reads them), each checked with `ownerOf`; and a shop's cards the wallet holds, by the shop
 *   page's own read (card-reads.ts: the listed collections' transfers to the wallet, each checked with `ownerOf`), so
 *   My Box and the shop show the same cards;
 * - (the claims come from the wallet claims index, WalletClaimsV2.tsx; nothing here).
 * Pure reads through one `read` per source (the page's read client folds them into Multicall3 calls on the public
 * endpoints). A read that fails is counted, never taken for "none": the page then says what it could not read.
 */
import type { Abi, Address } from 'viem';
import { BaseError, ContractFunctionRevertedError, erc20Abi } from 'viem';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { cardRangeV2, readOwnCardsV2, shopCollectionsV2, type CardReaderV2 } from './card-reads';
import type { BoxRecord } from '../../boxes/box-model';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { ERC721_ABI } from './shop-actions';
import { inventoryOf, mineCandidates, vaultRolesOf } from './vault-items';

/** One view call; the page's read client (or a test's) answers it. */
export type HoldingsRead = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => Promise<unknown>;


/** A v2 box as the feed gives it. */
export interface HoldingsBoxV2 { readonly record: BoxRecord; readonly view: V2Snapshot; readonly source: V2Source }

export interface HeldTokenV2 {
  readonly record: BoxRecord;
  readonly view: V2Snapshot;
  readonly balanceT: bigint;
  /** In the box's price coin (raw), at the box's last price; null where the box shows no price. */
  readonly valueP: bigint | null;
}

export interface HeldItemV2 {
  readonly record: BoxRecord;
  readonly source: V2Source;
  readonly collection: Address;
  readonly id: bigint;
  /** A shop's card (an outside collection the shop lists), or the box's own item. */
  readonly kind: 'card' | 'item';
}

export interface HoldingsV2 {
  readonly tokens: readonly HeldTokenV2[];
  readonly items: readonly HeldItemV2[];
  /** Reads that failed (a refused request, no answer): the parts they belong to are not complete. */
  readonly failed: number;
  /** More candidates than were read (at most ITEMS_PER_BOX per box or shop): some may be missing here. */
  readonly more: boolean;
}

/** A box's own items checked per box, at most (each costs one `ownerOf`). */
export const ITEMS_PER_BOX = 48;

const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** A revert the chain gave (the call's own answer), as against a request that failed. */
export function revertedRead(error: unknown): boolean {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;
}

/**
 * The box token's value in its price coin: `balanceT × pricePPerTX18 / 10^36` (raw P per whole 18-decimal T, scaled by
 * 10^18; statistics-v2), rounded down. Null without a price, for a failed box, or where the box page withholds its
 * price (an audit that did not verify).
 */
export function valueInPV2(view: Pick<V2Snapshot, 'failed' | 'statistics' | 'audited' | 'verified'>, balanceT: bigint): bigint | null {
  const price = view.failed || (view.audited && !view.verified) ? null : view.statistics?.pricePPerTX18 ?? null;
  return price === null ? null : (balanceT * price) / 10n ** 36n;
}

/** A shop box's shop (role 3 of a SHOP box), or null. */
export const shopOfV2 = (view: V2Snapshot): Address | null => (view.spec.boxType === 4 ? rolesOfV2(view.record).contracts.vault ?? null : null);

/** The box's own items the index places with this wallet (newest first), at most ITEMS_PER_BOX; none without owners. */
export function itemCandidatesV2(view: V2Snapshot, account: Address): readonly bigint[] {
  const inventory = inventoryOf(view);
  // Without the index's owners every item outside would be a candidate: too many reads for this page.
  if (!inventory?.owners || !vaultRolesOf(view)) return [];
  return mineCandidates(inventory, account);
}

/**
 * Everything this wallet holds in `boxes`: the token balances, the box items' owners and each shop's cards this wallet
 * holds (card-reads.ts). `readOf` and `cardsOf` give each source's readers.
 */
export async function readHoldingsV2(boxes: readonly HoldingsBoxV2[], account: Address, readOf: (source: V2Source) => HoldingsRead, cardsOf: (source: V2Source) => CardReaderV2): Promise<HoldingsV2> {
  let failed = 0; let more = false;
  const settle = async <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reverted: boolean }> => {
    try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, reverted: revertedRead(error) }; }
  };
  const capped = <T>(list: readonly T[]): readonly T[] => { if (list.length > ITEMS_PER_BOX) more = true; return list.slice(0, ITEMS_PER_BOX); };
  const ownerOf = (box: HoldingsBoxV2, collection: Address, id: bigint) => settle(readOf(box.source)(collection, ERC721_ABI as Abi, 'ownerOf', [id]) as Promise<Address>);
  const [balances, owned, shopCards] = await Promise.all([
    Promise.all(boxes.map((box) => settle(readOf(box.source)(box.view.token, erc20Abi as Abi, 'balanceOf', [account]) as Promise<bigint>))),
    Promise.all(boxes.map((box) => {
      const collection = vaultRolesOf(box.view)?.collection ?? null;
      if (!collection) return Promise.resolve([]);
      return Promise.all(capped(itemCandidatesV2(box.view, account)).map(async (id) => ({ collection, id, owner: await ownerOf(box, collection, id) })));
    })),
    Promise.all(boxes.map((box) => {
      if (!shopOfV2(box.view)) return Promise.resolve(null);
      const [from, to] = cardRangeV2(box.view);
      return settle(readOwnCardsV2(cardsOf(box.source), shopCollectionsV2(box.view), account, from, to));
    })),
  ]);
  const tokens: HeldTokenV2[] = [];
  boxes.forEach((box, i) => {
    const b = balances[i];
    if (!b?.ok) { failed += 1; return; }
    if (typeof b.value !== 'bigint' || b.value <= 0n) return;
    tokens.push({ record: box.record, view: box.view, balanceT: b.value, valueP: valueInPV2(box.view, b.value) });
  });
  // The shop's cards this wallet holds (already checked with ownerOf by the read).
  const cards = boxes.map((_box, i) => {
    const p = shopCards[i];
    if (p === null || p === undefined) return [];
    if (!p.ok) { failed += 1; return []; }
    // Cards held but older than the read's walk (SH-297 notes) are said the same way: more than shown.
    if (p.value.more || p.value.unfound > 0n) more = true;
    return p.value.cards.map((c) => ({ ...c, owner: { ok: true as const, value: account } }));
  });
  const items: HeldItemV2[] = [];
  const take = (box: HoldingsBoxV2, kind: HeldItemV2['kind'], reads: readonly { collection: Address; id: bigint; owner: Awaited<ReturnType<typeof ownerOf>> }[]) => {
    for (const read of reads) {
      // A burned or unknown item is refused with a revert: not this wallet's. Any other failure is unknown.
      if (!read.owner.ok) { if (!read.owner.reverted) failed += 1; continue; }
      if (same(read.owner.value, account)) items.push({ record: box.record, source: box.source, collection: read.collection, id: read.id, kind });
    }
  };
  boxes.forEach((box, i) => { take(box, 'item', owned[i] ?? []); take(box, 'card', cards[i] ?? []); });
  return { tokens, items, failed, more };
}

/** Whether nothing at all is held, as a known fact: every read answered and none found anything. */
export const holdsNothingV2 = (h: HoldingsV2): boolean => h.failed === 0 && h.tokens.length === 0 && h.items.length === 0;
