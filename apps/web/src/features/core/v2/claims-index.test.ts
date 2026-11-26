/** SH-V2-FE5: the wallet claims index as Claim all reads it (claims-index.ts): rows to the claim-state rule's reads. */
import { describe, expect, it } from 'vitest';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { NOTHING_LEFT_BATCH, indexedBoxOf, receiptsOf, restartable, viewAt } from './claims-index';
import { parseSnapshotV2 } from './indexer-v2';
import { publishedM2, A, B, H } from './test-support/m2-published';
import { ETH, publishedItems } from './test-support/m3-published';
import { claimsBoxOfView, claimsPage, claimsPageJson } from './test-support/claims-page';
import { required } from './test-support/required';
import { walletClaimsPageSchemaV2 } from '../../../../../../packages/chain/src/core/v2/claims-types';

async function boxes() {
  const m2 = await publishedM2(true); const items = await publishedItems();
  return { holders: parseSnapshotV2(m2.body, m2.source), items: parseSnapshotV2(items.body, items.source) };
}

describe('SH-V2-FE5 the wallet claims index', () => {
  it('one box’s rows become reads at the index block: batches, items with their stash, the hand-in; other boxes left out', async () => {
    const { holders, items } = await boxes();
    const h = claimsBoxOfView(holders); const i = claimsBoxOfView(items);
    const page = claimsPage({ chainId: 31337, wallet: A, block: 500n, rows: [
      { box: h, row: { kind: 'holder', batch: 1n, amount: 7n } },
      { box: h, row: { kind: 'holder', batch: 2n, amount: null } },
      { box: h, row: { kind: 'holder', batch: 3n, amount: 9n, payout: 'unavailable' } },
      { box: h, row: { kind: 'failure', coins: 3n * ETH, amount: 3333333n, allowance: ETH } },
      { box: i, row: { kind: 'item', id: 1n, amount: ETH, stash: ETH / 4n } },
      { box: i, row: { kind: 'creator', amount: 11n } },
    ] });
    const ix = indexedBoxOf(page, holders);
    expect(ix.at).toEqual({ block: 500n, hash: page.asOf.hash });
    expect(Object.fromEntries(ix.holder)).toEqual({
      '1': { status: 'settled', claimableP: 7n, payout: 'available' },
      '2': { status: 'settling', claimableP: null, payout: 'not_ready' },
      '3': { status: 'settled', claimableP: 9n, payout: 'unavailable' },
    });
    expect(ix.handIn).toEqual({ coins: 3n * ETH, pOut: 3333333n, approved: ETH, collectFirstP: null });
    expect(ix.items.size).toBe(0); expect(ix.creator).toBe(0n); expect(ix.remainder).toBe(0n);
    const it2 = indexedBoxOf(page, items);
    expect(it2.items.get('1')).toMatchObject({ owner: A.toLowerCase(), status: 'synced', claimableP: ETH, stashP: ETH / 4n, payout: 'available' });
    expect(it2.creator).toBe(11n);
    expect(it2.holder.size).toBe(0);
  });

  it('SH-RC7 item 29: the chain schema refuses an unpriced collect-first row and a pending failure row is left out: the site lists no hand-in without its quote', async () => {
    // The merged coordinator quotes the final share with the inbox's readable P, so an index row without a price is
    // nothing to claim at its block, as any other pending row (the RC6 R1-3 reading is gone). An index page that still
    // carries the old unpriced collect-first row is refused whole by the chain reader's schema (claims-reader.ts).
    const { holders } = await boxes();
    const h = claimsBoxOfView(holders);
    const final = claimsPageJson({ chainId: 31337, wallet: A, block: 501n, rows: [
      { box: h, row: { kind: 'failure', coins: 3n * ETH, amount: 10000001n, allowance: ETH, inboxP: 1n } },
    ] });
    const finalRow = required(final.items[0]);
    expect(walletClaimsPageSchemaV2.safeParse(final).success).toBe(true);
    const unpriced = { ...finalRow, status: 'pending', amountP: null, payout: 'not_ready', collectFirst: { ...required((finalRow as { collectFirst?: object }).collectFirst), pendingP: '900719925474099312345' } };
    expect(walletClaimsPageSchemaV2.safeParse({ ...final, items: [unpriced] }).success).toBe(false);
    const plain = claimsPageJson({ chainId: 31337, wallet: A, block: 502n, rows: [{ box: h, row: { kind: 'failure', coins: ETH, amount: 5n } }] });
    const pendingRow = { ...required(plain.items[0]), status: 'pending', amountP: null, payout: 'not_ready' };
    expect(indexedBoxOf(walletClaimsPageSchemaV2.parse({ ...plain, items: [pendingRow] }), holders).handIn).toBeNull();
  });

  it('RC6-RR-INBOX: a priced final share and a no-buyer creator carry the inbox P their claim first moves, beside the quote', async () => {
    const { holders } = await boxes();
    const h = claimsBoxOfView(holders);
    const ix = indexedBoxOf(claimsPage({ chainId: 31337, wallet: A, block: 503n, rows: [
      { box: h, row: { kind: 'failure', coins: 3n * ETH, amount: 12_000_001n, allowance: ETH, inboxP: 2_000_000n } },
    ] }), holders);
    expect(ix.handIn).toEqual({ coins: 3n * ETH, pOut: 12_000_001n, approved: ETH, collectFirstP: 2_000_000n });
    // RC6RR-FC-3: the creator's late inbox P after a paid claim at an earlier block is a claim again, with its note.
    const late = indexedBoxOf(claimsPage({ chainId: 31337, wallet: A, block: 504n, rows: [
      { box: h, row: { kind: 'no_buyer', amount: 77_000_000n, inboxP: 77_000_000n } },
      { box: h, row: { kind: 'no_buyer', amount: 997_000n, paid: { block: 400n, tx: H(5) } } },
    ] }), holders);
    expect(late.remainder).toBe(77_000_000n);
    expect(late.remainderInboxP).toBe(77_000_000n);
    expect(late.receipts).toEqual([expect.objectContaining({ kind: 'remainder', paidP: 997_000n, block: 400n })]);
    const plain = indexedBoxOf(claimsPage({ chainId: 31337, wallet: A, block: 505n, rows: [{ box: h, row: { kind: 'no_buyer', amount: 5n } }] }), holders);
    expect([plain.remainder, plain.remainderInboxP]).toEqual([5n, null]);
  });

  it('a creator payout the payee itself would refuse is not claimable here; a row in another coin is ignored', async () => {
    const { items } = await boxes();
    const box = claimsBoxOfView(items);
    const refused = indexedBoxOf(claimsPage({ chainId: 31337, wallet: A, block: 9n, rows: [{ box, row: { kind: 'creator', amount: 5n, payout: 'unavailable' } }] }), items);
    expect(refused.creator).toBe(0n);
    // FINAL-OC01: unavailable, never "nothing" (the panel says Unavailable and offers Retry).
    expect(refused.creatorRefused).toBe(true);
    expect(indexedBoxOf(claimsPage({ chainId: 31337, wallet: A, block: 9n, rows: [{ box, row: { kind: 'creator', amount: 5n } }] }), items).creatorRefused).toBe(false);
    const other = { ...box, q: B };
    expect(indexedBoxOf(claimsPage({ chainId: 31337, wallet: A, block: 9n, rows: [{ box: other, row: { kind: 'creator', amount: 5n } }] }), items).creator).toBe(0n);
  });

  it('payments become mined claims, the newest per claim, with the role that paid', async () => {
    const { holders } = await boxes();
    const h = claimsBoxOfView(holders); const roles = rolesOfV2(holders.record).contracts;
    const page = claimsPage({ chainId: 31337, wallet: A, block: 600n, rows: [
      { box: h, row: { kind: 'holder', batch: 1n, amount: 7n, paid: { block: 400n, tx: H(1) } } },
      { box: h, row: { kind: 'holder', batch: 1n, amount: 7n, paid: { block: 450n, tx: H(2) } } },
      { box: h, row: { kind: 'failure', coins: ETH, amount: 5n, paid: { block: 420n, tx: H(3), logIndex: 2 } } },
    ] });
    expect(receiptsOf(page)).toEqual([
      { kind: 'holder', role: roles.holderLedger?.toLowerCase(), id: 1n, tx: H(2), block: 450n, logIndex: 0, paidP: 7n, inT: false, coinsT: null },
      { kind: 'hand-in', role: roles.coordinator?.toLowerCase(), id: null, tx: H(3), block: 420n, logIndex: 2, paidP: 5n, inT: false, coinsT: ETH },
    ]);
    // A paid batch the index lists as nothing left: no read of its own is invented.
    expect(indexedBoxOf(page, holders).holder.size).toBe(0);
    expect(NOTHING_LEFT_BATCH).toEqual({ status: 'settled', claimableP: 0n, payout: 'empty' });
  });

  it('sends re-check at the index block: the same box with only its block and hash replaced', async () => {
    const { holders } = await boxes();
    const at = viewAt(holders, { block: 777n, hash: H(77) });
    expect(at).toEqual({ ...holders, block: 777n, blockHash: H(77) });
  });

  it('only a restart the endpoint asks for is retried; any other failure means the scan', () => {
    expect(restartable(new Error('wallet claims HTTP 409: restart pagination at the canonical head'))).toBe(true);
    expect(restartable(new Error('claims snapshot changed between pages'))).toBe(true);
    for (const message of ['wallet claims HTTP 503', 'wallet claims HTTP 404', 'Failed to fetch']) expect(restartable(new Error(message))).toBe(false);
  });
});
