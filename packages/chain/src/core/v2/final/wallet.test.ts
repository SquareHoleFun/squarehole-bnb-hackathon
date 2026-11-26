import { describe, expect, it } from 'vitest';
import { encodeErrorResult, parseAbi, type Hex } from 'viem';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CoreGatewayOptions } from '../../../../../indexer/src/core/core-gateway';
import { ClaimsGatewayV2 } from '../../../../../indexer/src/core/v2/claims-gateway-v2';
import { readCreatorClaimV2, readFailureClaimV2 } from '../../../../../indexer/src/core/v2/claims-reads-v2';
import { readItemClaimV2 } from '../../../../../indexer/src/core/v2/m3-reads-v2';
import { readHolderClaimV2 } from '../../../../../indexer/src/core/v2/m2-reads-v2';
import { readAllWalletClaimsV2, readWalletClaimsPageV2 } from '../claims-reader';
import { walletClaimsPageSchemaV2 } from '../claims-types';
import { A, B, H, HUGE, ITEM_CAP, walletFixture } from './wallet-fixture';

function transport(f: ReturnType<typeof walletFixture>) {
  const options = { source: { chainId: f.source.chainId, health: () => ({ following: true }) } } as unknown as CoreGatewayOptions;
  const gateway = new ClaimsGatewayV2(options, f.index);
  const statuses: number[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    const response = { status: 0, body: '', writeHead(n: number) { this.status = n; }, end(body = '') { this.body = body; } };
    await gateway.route({ url: url.pathname + url.search, method: 'GET' } as IncomingMessage, response as unknown as ServerResponse);
    statuses.push(response.status);
    return new Response(response.body, { status: response.status });
  };
  return { statuses, request: { baseUrl: 'https://claims.invalid', chainId: f.source.chainId, wallet: A, limit: 5, fetch: fetcher } };
}

describe('FINAL-LIST: complete, exact, canonical wallet traversal', () => {
  it('follows every empty/nonempty page across 17 batches and 70 items, using the real gateway without a listener', async () => {
    const f = walletFixture(); const t = transport(f);
    const page = await readAllWalletClaimsV2(t.request);
    expect(page.items.filter(r => r.kind === 'holder')).toHaveLength(17);
    expect(page.items.filter(r => r.kind === 'item')).toHaveLength(70);
    expect(page.items.find(r => r.kind === 'item' && r.itemId === '70')).toMatchObject({ amountP: String(ITEM_CAP), outsideP: String(ITEM_CAP), stashP: '7' });
    expect(page.items.find(r => r.kind === 'holder' && r.batchId === '1')).toMatchObject({ amountP: String(HUGE) });
    expect(page.next).toBeNull(); expect(t.statuses.length).toBeGreaterThan(17);
    expect(t.statuses.every(s => s === 200)).toBe(true);
    expect(f.simulations).toHaveLength(87);
    expect(f.simulations.every(s => String(s.args.at(-1)).toLowerCase() === A.toLowerCase())).toBe(true);
  });

  it('an empty page retains a cursor and a later positive item remains reachable', async () => {
    const f = walletFixture(17, 1); f.set(f.holder.at(17), 'claimable', 0n);
    const t = transport(f);
    expect(await readWalletClaimsPageV2({ ...t.request, limit: 1 })).toMatchObject({ items: [], next: expect.any(String) });
    expect((await readAllWalletClaimsV2(t.request)).items).toHaveLength(1);
  });

  it('a reorg or foreign-wallet cursor cannot return a partially complete result', async () => {
    const f = walletFixture(2, 1); const first = await f.index.page(A, { limit: 1 });
    await expect(f.index.page(B, { after: first.next })).rejects.toThrow(/cursor/);
    f.reorg(H(999));
    await expect(f.index.page(A, { after: first.next })).rejects.toThrow(/canonical/);
  });

  it('repair and RPC failure remain unavailable, never an empty wallet', async () => {
    const f = walletFixture(1, 1); const t = transport(f);
    f.set(f.holder.at(17), 'claimable', new Error('RPC unavailable'));
    await expect(readAllWalletClaimsV2(t.request)).rejects.toThrow(/503/);
    const entry = f.entries.get('holder'); if (!entry) throw new Error('missing fixture');
    entry.repairing = true;
    await expect(readAllWalletClaimsV2(t.request)).rejects.toThrow(/503/);
  });

  it('numeric money, wrong wallet, mixed hashes, duplicate rows and looping cursors fail closed', async () => {
    const f = walletFixture(1, 1), page = await f.index.page(A, { limit: 100 });
    const row = page.items[0]; if (!row) throw new Error('missing fixture claim');
    for (const items of [[{ ...row, amountP: 123 }], [{ ...row, wallet: B }], [{ ...row, asOf: { ...row.asOf, hash: H(99) } }], [row, row]]) {
      expect(walletClaimsPageSchemaV2.safeParse({ ...page, items }).success).toBe(false);
    }
    const request = { ...transport(f).request, fetch: async () => new Response(JSON.stringify({ ...page, items: [], next: 'loop' })) };
    await expect(readAllWalletClaimsV2(request)).rejects.toThrow(/repeated claims cursor/);
  });
});

describe('FINAL-READ: liabilities, next payments, current ownership and refusal remain separate', () => {
  it.each([0n, 1n, 4n * ITEM_CAP, 4n * ITEM_CAP + 7n])('quotes the real creator next payment for %s independently of creatorOwed', async amount => {
    const f = walletFixture(1, 1), cap = 4n * ITEM_CAP;
    f.set(f.holder.at(5), 'creatorPayee', A); f.creatorNext(amount > cap ? cap : amount);
    const value = await readCreatorClaimV2(f.reader, f.holder.row, A, H(100));
    expect(value).toEqual(amount === 0n ? null : { amountP: amount > cap ? cap : amount, payout: 'available' });
  });

  it('the fixed no-buyer return excludes late money and a paid creator claim is absent', async () => {
    const f = walletFixture(0, 0); const row = { ...f.holder.row, creator: A };
    f.set(f.holder.at(0), 'failed', true); f.set(f.holder.at(0), 'claimState', [HUGE + 9n, 0n]);
    f.set(f.holder.at(0), 'quoteClaim', HUGE);
    expect(await readFailureClaimV2(f.reader, row, A, H(100), true)).toMatchObject({ amountP: HUGE, pot: HUGE + 9n, coinsT: 0n });
    f.set(f.holder.at(0), 'quoteClaim', Object.assign(new Error('claimed'), {
      data: encodeErrorResult({ abi: parseAbi(['error InvalidClaim()']), errorName: 'InvalidClaim' }),
    }));
    expect(await readFailureClaimV2(f.reader, row, A, H(100), true)).toBeNull();
  });

  it('a holder credit survives failure, refuses inconsistent funding, and never uses gross logs as credit', async () => {
    const f = walletFixture(1, 0); f.set(f.holder.at(0), 'failed', true);
    const read = () => readHolderClaimV2(f.reader, f.holder.row, { holder: A, batchId: 1n }, H(100));
    expect(await read()).toMatchObject({ claimableP: HUGE, failedBox: true, payout: 'available' });
    f.set(f.holder.at(5), 'holderBatchPaid', HUGE - 1n);
    await expect(read()).rejects.toThrow(/inconsistent/);
  });

  it('items retain their unpaid tail, require full backing and both journal cursors', async () => {
    const f = walletFixture(0, 1);
    const read = () => readItemClaimV2(f.reader, f.itemRow, { id: 1n }, H(100));
    expect(await read()).toMatchObject({ claimableP: ITEM_CAP, stashP: 7n, payout: 'available' });
    f.set(f.item.row.poolManager, 'balanceOf', ITEM_CAP);
    await expect(read()).rejects.toThrow(/not backed/);
    f.set(f.item.row.poolManager, 'balanceOf', ITEM_CAP + 7n);
    f.set(f.item.at(16), 'lifecycleCursor', 0n);
    expect(await read()).toMatchObject({ claimableP: null, payout: 'not_ready' });
    f.set(f.item.at(16), 'lifecycleCursor', 1n); f.set(f.item.at(4), 'ownerOf', f.item.at(3));
    expect(await read()).toMatchObject({ claimableP: 0n, payout: 'not_owner_claimable' });
  });

  it('a refused item payment preserves exact credit; an RPC failure is unverified', async () => {
    const f = walletFixture(0, 1);
    const read = (error: Error) => readItemClaimV2({ ...f.reader, callFromAt: async (): Promise<Hex> => { throw error; } }, f.itemRow, { id: 1n }, H(100));
    expect(await read(Object.assign(new Error('paused'), { code: 3 }))).toMatchObject({ claimableP: ITEM_CAP, payout: 'unavailable' });
    expect(await read(new Error('offline'))).toMatchObject({ claimableP: ITEM_CAP, payout: 'unverified' });
  });
});
