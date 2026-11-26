import { rewardWalletCandidatesV21, holderWalletQuoteV21, itemPCandidatesV21, itemWalletQuoteV21 } from './pay-in-t-claims-v21';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { claimsAsOfSchemaV2, walletClaimsPageSchemaV2, type ClaimsAsOfV2, type WalletClaimV2, type WalletClaimsPageV2 } from '../../../../chain/src/core/v2/claims-types';
import type { BoxEntryV2, CoreChainIndexer } from '../chain-indexer';
import type { BoxRowV2 } from '../core-row';
import type { LiveStateV2 } from './views-v2';
import { CLAIMS_RECENT_BLOCKS, type ClaimPaymentV2 } from './claims-events-v2';
import { readHolderClaimV2 } from './m2-reads-v2';
import { readItemClaimV2 } from './m3-reads-v2';
import { readCreatorClaimV2, readFailureClaimV2, type ClaimsReaderV2 } from './claims-reads-v2';

type Entry = Pick<BoxEntryV2, 'row' | 'states' | 'verified' | 'repairing'>;
export interface ClaimsIndexSourceV2 extends Pick<CoreChainIndexer, 'chainId' | 'head' | 'hashAt'> {
  readonly boxesV2: ReadonlyMap<string, Entry>;
}
export class ClaimsIndexErrorV2 extends Error {
  constructor(readonly status: 400 | 409 | 503, message: string) { super(message); }
}
const lower = (s: string) => s.toLowerCase() as Address;
const cursorSchema = z.object({ chainId: z.number().int(), wallet: z.string(), asOf: claimsAsOfSchemaV2, inventory: z.string().regex(/^0x[0-9a-f]{64}$/), after: z.string().min(1).max(512) }).strict();
interface Candidate { readonly key: string; readonly row: BoxRowV2; readonly kind: WalletClaimV2['kind']; readonly id?: bigint; readonly paid?: ClaimPaymentV2; readonly inT?: boolean }
const prefix = (row: BoxRowV2) => `${lower(row.registry)}:${row.boxId}:${lower(row.contracts.token as Address)}`;
function at(entry: Entry, block: bigint): LiveStateV2 | undefined {
  for (let i = entry.states.length - 1; i >= 0; --i) { const state = entry.states[i]; if (state && state.block <= block) return state; }
  return undefined;
}

/** Shared pipeline state supplies discovery and receipts; live contract reads supply wallet amounts. No fixed scan cap. */
export class WalletClaimsIndexV2 {
  constructor(private readonly source: ClaimsIndexSourceV2, private readonly reader: ClaimsReaderV2) {}

  private snapshot(wallet: Address, block: bigint) {
    const candidates: Candidate[] = []; const states = new Map<Entry, LiveStateV2>();
    for (const entry of this.source.boxesV2.values()) {
      const row = entry.row;
      if (row.creationBlock > block) continue;
      if (entry.repairing || entry.verified === false) throw new ClaimsIndexErrorV2(503, 'claims unavailable during repair or failed audit');
      const state = at(entry, block);
      if (!state) throw new ClaimsIndexErrorV2(409, 'claims snapshot expired; restart pagination');
      states.set(entry, state);
      const base = prefix(row);
      const add = (kind: Candidate['kind'], id?: bigint, inT = false) => candidates.push({ row, kind, inT, ...(id === undefined ? {} : { id }), key: `${base}:${kind}:${id ?? wallet}${inT ? ':t' : ''}` });
      // The ledger has no per-wallet credit event: every settled, unpaid batch is a candidate, regardless of age.
      if (row.contracts.holderLedger) for (const [id, batch] of Object.entries(state.view.m2?.batches ?? {})) {
        if (batch.complete && !batch.payments[wallet]) add('holder', BigInt(id));
      }
      // Collection Transfer/ConsecutiveTransfer history supplies ownership, including ids beyond browser scan limits.
      // Only a box with a P Items side can credit an item in P; T item rows come from the reward candidates below.
      if (row.contracts.itemLedger && itemPCandidatesV21(row)) for (const [id, owner] of Object.entries(state.view.m3?.items?.owners ?? {})) {
        if (owner === wallet) add('item', BigInt(id));
      }
      for (const reward of rewardWalletCandidatesV21(row, state, wallet)) add(reward.kind, reward.id, true);
      add('creator'); add('failure');
      if (lower(row.creator) === wallet) add('no_buyer');
      for (const paid of state.claimPayments ?? []) if (paid.wallet === wallet && paid.block <= block && paid.block > block - CLAIMS_RECENT_BLOCKS) {
        candidates.push({ row, kind: paid.kind, paid, key: `${base}:paid:${paid.hash}:${paid.logIndex}` });
      }
    }
    candidates.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return { candidates, states, inventory: keccak256(toBytes(candidates.map(c => c.key).join('\n'))) };
  }

  private async canonical(asOf: ClaimsAsOfV2) {
    const block = BigInt(asOf.block);
    if (this.source.hashAt(block)?.toLowerCase() !== asOf.hash) throw new ClaimsIndexErrorV2(409, 'claims cursor is no longer canonical or retained');
    const header = await this.reader.headerByNumber(block);
    if (header?.hash.toLowerCase() !== asOf.hash || header.number !== block || String(header.timestamp) !== asOf.timestamp) throw new ClaimsIndexErrorV2(409, 'claims snapshot reorged; restart pagination');
  }

  /** Limit bounds candidates examined, not nonzero results. Follow next even on an empty page. */
  async page(address: string, options: { readonly after?: string | null; readonly limit?: number } = {}): Promise<WalletClaimsPageV2> {
    const limit = options.limit ?? 50; const wallet = lower(address);
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || /^0x0{40}$/.test(wallet)) throw new ClaimsIndexErrorV2(400, 'invalid claims wallet');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ClaimsIndexErrorV2(400, 'claims limit is 1-100');
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (options.after) {
      try {
        if (options.after.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(options.after)) throw new Error('bad encoding');
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(options.after, 'base64url').toString('utf8')));
        if (cursor.chainId !== this.source.chainId || cursor.wallet !== wallet) throw new Error('wrong wallet/chain');
      } catch { throw new ClaimsIndexErrorV2(400, 'invalid claims cursor'); }
    }
    const head = this.source.head();
    if (!head) throw new ClaimsIndexErrorV2(503, 'claims index unavailable');
    const asOf: ClaimsAsOfV2 = cursor?.asOf ?? { block: String(head.number), hash: head.hash.toLowerCase() as Hex, timestamp: String(head.timestamp), tier: 'head' };
    const block = BigInt(asOf.block);
    await this.canonical(asOf);
    const snapshot = this.snapshot(wallet, block);
    if (cursor && snapshot.inventory !== cursor.inventory) throw new ClaimsIndexErrorV2(409, 'claims inventory changed; restart pagination');
    const last = cursor ? snapshot.candidates.findIndex(c => c.key === cursor.after) : -1;
    if (cursor && last === -1) throw new ClaimsIndexErrorV2(400, 'unknown claims cursor');
    const selected = snapshot.candidates.slice(last + 1, last + 1 + limit);
    // Share only this page's hash-pinned reads; never cache a wallet balance across blocks.
    const calls = new Map<string, Promise<Hex>>();
    const simulate = this.reader.callFromAt?.bind(this.reader);
    const creatorEntitlement = this.reader.creatorEntitlementAt?.bind(this.reader);
    const reader: ClaimsReaderV2 = { headerByNumber: n => this.reader.headerByNumber(n),
      callAt: (to, data, hash) => {
        const key = `${lower(to)}:${data}`;
        let result = calls.get(key);
        if (!result) { result = this.reader.callAt(to, data, hash); calls.set(key, result); }
        return result;
      }, ...(simulate ? { callFromAt: simulate } : {}),
      ...(creatorEntitlement ? { creatorEntitlementAt: creatorEntitlement } : {}),
    };
    const items: WalletClaimV2[] = [];
    for (const candidate of selected) {
      const value = await this.read(candidate, wallet, asOf, reader);
      if (value) items.push(value);
    }
    await this.canonical(asOf);
    const current = this.snapshot(wallet, block);
    if (current.inventory !== snapshot.inventory || [...snapshot.states].some(([entry, state]) => current.states.get(entry) !== state)) throw new ClaimsIndexErrorV2(409, 'claims snapshot changed during reads');
    const tail = selected.at(-1);
    const next = tail && last + 1 + selected.length < snapshot.candidates.length
      ? Buffer.from(JSON.stringify({ chainId: this.source.chainId, wallet, asOf, inventory: snapshot.inventory, after: tail.key })).toString('base64url') : null;
    return walletClaimsPageSchemaV2.parse({ schema: 'sh.core-claims.v2', chainId: this.source.chainId, wallet, asOf,
      recentFromBlock: String(block >= CLAIMS_RECENT_BLOCKS ? block - CLAIMS_RECENT_BLOCKS + 1n : 0n), items, next });
  }

  private async read(c: Candidate, wallet: Address, asOf: ClaimsAsOfV2, reader: ClaimsReaderV2): Promise<WalletClaimV2 | null> {
    const { row, kind, paid } = c;
    const roleAddress = paid?.roleAddress ?? (kind === 'holder' ? row.contracts.holderLedger : kind === 'item' ? row.contracts.itemLedger : kind === 'creator' ? row.contracts.receiver : row.contracts.coordinator);
    if (!roleAddress || !row.contracts.token) throw new Error('missing claim role');
    const common = { id: c.key, wallet, box: { registry: lower(row.registry), boxId: String(row.boxId), token: lower(row.contracts.token) },
      roleAddress: lower(roleAddress), asset: lower(paid?.asset ?? (c.inT ? row.contracts.token : row.q)), asOf };
    if (paid) {
      const receipt = { ...common, status: 'claimed' as const, amountP: String(paid.amountP), payout: 'paid' as const,
        payment: { block: String(paid.block), hash: paid.hash, txHash: paid.txHash, logIndex: paid.logIndex, to: paid.to, grossP: String(paid.grossP), tipP: String(paid.tipP) } };
      if (kind === 'holder') return { ...receipt, kind, batchId: String(paid.batchId) };
      if (kind === 'item') return { ...receipt, kind, itemId: String(paid.itemId), outsideP: null, stashP: null };
      if (kind === 'failure') return { ...receipt, kind, coinsT: String(paid.coinsT), allowanceT: null, pot: null, tLeft: null };
      if (kind === 'no_buyer') return { ...receipt, kind, coinsT: '0', pot: null };
      return { ...receipt, kind };
    }
    const unpaid = { ...common, status: 'claimable' as const, payment: null, payout: 'unverified' as const };
    if (kind === 'holder') {
      if (c.id === undefined) throw new Error('missing holder batch');
      const value = holderWalletQuoteV21(await readHolderClaimV2(reader, row, { batchId: c.id, holder: wallet }, asOf.hash), c.inT);
      if (value.claimableP === 0n) return null;
      return { ...unpaid, kind, batchId: String(c.id), status: value.claimableP === null ? 'pending' : 'claimable', amountP: value.claimableP === null ? null : String(value.claimableP), payout: value.claimableP === null ? 'not_ready' : value.payout === 'available' || value.payout === 'unavailable' ? value.payout : 'unverified' };
    }
    if (kind === 'item') {
      if (c.id === undefined) throw new Error('missing item id');
      const value = itemWalletQuoteV21(await readItemClaimV2(reader, row, { id: c.id }, asOf.hash), c.inT);
      if (lower(value.owner) !== wallet) throw new Error('indexed item owner differs from canonical read');
      if (value.claimableP === 0n) return null;
      return { ...unpaid, kind, itemId: String(c.id), status: value.claimableP === null ? 'pending' : 'claimable', amountP: value.claimableP === null ? null : String(value.claimableP),
        outsideP: value.outsideP === null ? null : String(value.outsideP), stashP: value.stashP === null ? null : String(value.stashP),
        payout: value.claimableP === null ? 'not_ready' : value.payout === 'available' || value.payout === 'unavailable' ? value.payout : 'unverified' };
    }
    if (kind === 'creator') {
      const value = await readCreatorClaimV2(reader, row, wallet, asOf.hash);
      return value ? { ...unpaid, kind, amountP: String(value.amountP), payout: value.payout } : null;
    }
    const value = await readFailureClaimV2(reader, row, wallet, asOf.hash, kind === 'no_buyer');
    if (!value) return null;
    // RC6-RR-INBOX: a priced row also names the inbox P its claim first moves into the pot (collectFirst).
    const note = value.collectFirst ? { collectFirst: { ...value.collectFirst, pendingP: String(value.collectFirst.pendingP) } } : {};
    if (kind === 'no_buyer') return { ...unpaid, kind, amountP: String(value.amountP), coinsT: '0', pot: String(value.pot), ...note };
    return { ...unpaid, kind, amountP: String(value.amountP), ...note,
      coinsT: String(value.coinsT), allowanceT: String(value.allowanceT), pot: String(value.pot), tLeft: String(value.tLeft) };
  }
}
