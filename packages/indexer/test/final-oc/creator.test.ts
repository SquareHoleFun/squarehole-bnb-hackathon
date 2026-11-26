import { describe, expect, it } from 'vitest';
import { encodeErrorResult, encodeFunctionResult, parseAbi, parseAbiItem, type Hex } from 'viem';
import * as chain from '../../../chain/src/core/v2';
import { walletFixture, A, B, H } from '../../../chain/src/core/v2/final/wallet-fixture';
import { readCreatorClaimV2 as indexedRead } from '../../src/core/v2/claims-reads-v2';
import { logM2 } from '../../src/core/v2/m2-fixture.test-support';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';
import { WalletClaimsIndexV2 } from '../../src/core/v2/claims-index-v2';

const CAP = 4n * ((1n << 127n) - 1n);
// The browser must consume the same quote as the indexer, without importing server code.
function sharedRead(): typeof indexedRead {
  const read = (chain as unknown as { readCreatorClaimV2?: typeof indexedRead }).readCreatorClaimV2;
  expect(read, 'canonical creator reader exported for frontend adoption').toBeTypeOf('function');
  if (!read) throw new Error('missing shared creator reader');
  expect(read).toBe(indexedRead);
  return read;
}

describe('FINAL-OC01: shared next-payment reader', () => {
  it.each([
    ['lazy graduation with zero stored fees', 0n, 1234n],
    ['four-part payment with a remaining tail', CAP + 7n, CAP],
    ['one raw unit with no minimum', 1n, 1n],
  ] as const)('%s', async (_name, stored, next) => {
    const f = walletFixture(0, 0);
    f.set(f.holder.at(5), 'creatorPayee', A);
    // A decodable but stale view must never decide the quote.
    f.set(f.holder.at(5), 'creatorOwed', [stored, 0n]); f.creatorNext(next);
    const read = sharedRead();
    expect(await read(f.reader, f.holder.row, A, H(100))).toEqual({ amountP: next, payout: 'available' });
    expect(f.simulations).toEqual([{ from: A, to: f.holder.at(5), fn: 'claimCreator', args: [f.holder.row.q, A] }]);
    const page = await f.index.page(A, { limit: 100 });
    expect(page.items.filter(row => row.kind === 'creator')).toEqual([
      expect.objectContaining({ amountP: next.toString(), status: 'claimable', payout: 'available', asOf: { block: '100', hash: H(100), timestamp: f.block.timestamp.toString(), tier: 'head' } }),
    ]);
  });

  it('rereads the unpaid tail after the actual receipt and never consumes it while quoting', async () => {
    const f = walletFixture(0, 0); f.set(f.holder.at(5), 'creatorPayee', A);
    const read = sharedRead(); f.creatorNext(CAP);
    expect(await read(f.reader, f.holder.row, A, H(100))).toEqual({ amountP: CAP, payout: 'available' });
    const nextHash = H(101);
    const reader = { ...f.reader,
      callAt: async (to: Parameters<typeof f.reader.callAt>[0], data: Hex, hash: Hex) => {
        expect(hash).toBe(nextHash); return f.reader.callAt(to, data, H(100));
      },
      callFromAt: async (_from: unknown, _to: unknown, _data: unknown, hash: Hex) => {
        expect(hash).toBe(nextHash);
        return encodeFunctionResult({ abi: chain.receiverV2Abi, functionName: 'claimCreator', result: 7n });
      },
    };
    expect(await read(reader, f.holder.row, A, nextHash)).toEqual({ amountP: 7n, payout: 'available' });
    expect(await read(reader, f.holder.row, A, nextHash)).toEqual({ amountP: 7n, payout: 'available' });
    const header = { ...f.block, number: 101n, hash: nextHash, parentHash: H(100) };
    const receipt = logM2(parseAbiItem('event CreatorClaimed(address indexed payee,address indexed token,address to,uint256 amount)'),
      f.holder.at(5), { payee: A, token: f.holder.row.q, to: A, amount: CAP }, 0, header.number, header.hash);
    const parent = f.entries.get('holder')?.states[0];
    if (!parent) throw new Error('missing parent fixture');
    const state = applyV2Block(parent, header, decodeV2Logs([receipt], routeV2(f.holder.release, f.holder.manifest, [], [f.holder.record])), f.holder.row).state;
    const index = new WalletClaimsIndexV2({ chainId: f.source.chainId, head: () => header, hashAt: () => nextHash,
      boxesV2: new Map([['holder', { row: f.holder.row, states: [state], verified: true, repairing: false }]]),
    }, { ...reader, headerByNumber: async () => header });
    const creators = (await index.page(A, { limit: 100 })).items.filter(row => row.kind === 'creator');
    expect(creators).toHaveLength(2);
    expect(creators).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'claimed', amountP: CAP.toString(), payment: expect.objectContaining({ grossP: CAP.toString(), tipP: '0', txHash: receipt.transactionHash }) }),
      expect.objectContaining({ status: 'claimable', amountP: '7', payout: 'available', payment: null }),
    ]));
    f.creatorNext(0n);
    expect(await read(f.reader, f.holder.row, A, H(100))).toBeNull();
  });

  it.each(['wrong_payee', 'failed', 'ungraduated'] as const)('does not simulate for %s', async state => {
    const f = walletFixture(0, 0); f.set(f.holder.at(5), 'creatorPayee', state === 'wrong_payee' ? B : A);
    if (state === 'failed') f.set(f.holder.at(0), 'failed', true);
    if (state === 'ungraduated') f.set(f.holder.at(0), 'graduated', false);
    expect(await sharedRead()(f.reader, f.holder.row, A, H(100))).toBeNull();
    expect(f.simulations).toEqual([]);
  });

  it('preserves a refused payment quote and propagates unknown or noncanonical reads', async () => {
    const f = walletFixture(0, 0); f.set(f.holder.at(5), 'creatorPayee', A);
    const read = sharedRead();
    const refusal = Object.assign(new Error('not exact'), { data: encodeErrorResult({
      abi: parseAbi(['error TransferNotExact(uint256 expected,uint256 received)']), errorName: 'TransferNotExact', args: [1234n, 0n],
    }) });
    const reader = { ...f.reader, callFromAt: async (): Promise<Hex> => { throw refusal; },
      creatorEntitlementAt: async (wallet: unknown, receiver: unknown, asset: unknown, hash: Hex) => {
        expect([wallet, receiver, asset, hash]).toEqual([A, f.holder.at(5), f.holder.row.q, H(100)]); return 1234n;
      },
    };
    expect(await read(reader, f.holder.row, A, H(100))).toEqual({ amountP: 1234n, payout: 'unavailable' });
    const unknown = new Error('RPC unavailable');
    await expect(read({ ...reader, callFromAt: async () => { throw unknown; } }, f.holder.row, A, H(100))).rejects.toBe(unknown);
    await expect(read({ ...reader, creatorEntitlementAt: async () => { throw unknown; } }, f.holder.row, A, H(100))).rejects.toBe(unknown);
    await expect(read({ callAt: f.reader.callAt }, f.holder.row, A, H(100))).rejects.toThrow('sender-aware');
  });
});
