import { decodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import * as money from './money-v2';
import { poolManagerAbi } from '@squarehole/chain/abi';
import { coordinatorV2Abi, holderLedgerV2Abi, hookV2Abi, receiverV2Abi, shopVaultV2Abi, starterSetLoaderV2Abi } from './chain-v2';
import { A, B, H, m2Fixture } from './m2-fixture.test-support';

// Access the future export through the existing module so red runs fail on the absent behavior.
const readClaim = (...args: unknown[]) => {
  const fn = (money as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).readHolderClaimV2;
  expect(fn, 'block-pinned holder claim reader').toBeTypeOf('function');
  return fn?.(...args);
};
const readShop = (...args: unknown[]) => {
  const fn = (money as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).readM2MoneyV2;
  expect(fn, 'block-pinned M2 money reader').toBeTypeOf('function');
  return fn?.(...args);
};

function rig() {
  const f = m2Fixture(); const seen: Hex[] = [];
  const state: Record<string, unknown> = { tradeBatch: { tradeUnits: 100n, protocolUnits: 5n, netP: 150n, closed: true }, holderBatchPaid: 100n,
    holderBatchClosed: true, batchState: [true, 3n, 0n, 20n], claimable: 60n, failed: true, budgetT: 0n, failedT: 1000n,
    seedReady: true, inside: 9n, collectionSize: 10n, curator: A, pendingCurator: B, nextAdditionAt: 700000n, progress: [10, H(0), true], balanceOf: 100n };
  const abiAt = (a: Address): Abi => a === f.row.poolManager ? poolManagerAbi : a === f.at(17) ? holderLedgerV2Abi : a === f.at(5) ? receiverV2Abi : a === f.at(2) ? hookV2Abi : a === f.at(3) ? shopVaultV2Abi : a === f.at(19) ? starterSetLoaderV2Abi : coordinatorV2Abi;
  const reader = { callAt: async (to: Address, data: Hex, hash: Hex) => {
    seen.push(hash); const abi = abiAt(to); const decoded = decodeFunctionData({ abi, data });
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result: state[decoded.functionName] });
  } };
  return { f, state, reader, seen };
}

describe('M252-READS: credit, payout availability and current shop custody', () => {
  it('uses canonical hash-pinned eth_call for ordinary reads and holder simulation', async () => {
    const calls: unknown[] = [];
    const client = { request: async (call: unknown) => { calls.push(call); return '0x'; } } as Pick<PublicClient, 'request'>;
    const reader = money.m2RpcReaderV2(client);
    await reader.callAt(B, '0x1234', H(101));
    await reader.callFromAt?.(A, B, '0x5678', H(101));
    expect(calls).toEqual([
      { method: 'eth_call', params: [{ to: B, data: '0x1234' }, { blockHash: H(101), requireCanonical: true }] },
      { method: 'eth_call', params: [{ from: A, to: B, data: '0x5678' }, { blockHash: H(101), requireCanonical: true }] },
    ]);
  });
  it('preserves earned credit on failure and paused payouts; successful retry never mutates the read credit', async () => {
    const { f, reader, seen } = rig();
    const request = { batchId: 1n, holder: A };
    const unavailable = { ...reader, callFromAt: async () => { throw Object.assign(new Error('paused P'), { code: 3 }); } };
    expect(await readClaim(unavailable, f.row, request, H(101))).toMatchObject({ fundingP: 100n, claimableP: 60n, failedBox: true, payout: 'unavailable' });
    const available = { ...reader, callFromAt: async (from: Address, to: Address, data: Hex, hash: Hex) => {
      expect([from, to, hash]).toEqual([A, f.at(17), H(102)]);
      expect(decodeFunctionData({ abi: holderLedgerV2Abi, data })).toMatchObject({ functionName: 'claim', args: [1n, A] });
      return encodeFunctionResult({ abi: holderLedgerV2Abi, functionName: 'claim', result: 60n });
    } };
    expect(await readClaim(available, f.row, request, H(102))).toMatchObject({ claimableP: 60n, payout: 'available' });
    expect(new Set(seen)).toEqual(new Set([H(101), H(102)]));
  });
  it('distinguishes unallocated, settling, zero-funded and claimed batches; RPC failure never guesses zero', async () => {
    const { f, reader, state } = rig(); const request = { batchId: 2n, holder: A };
    state.holderBatchClosed = false; state.batchState = [false, 0n, 0n, 0n]; state.claimable = 0n; state.holderBatchPaid = 0n;
    expect(await readClaim(reader, f.row, request, H(101))).toMatchObject({ status: 'awaiting_funding', fundingP: null, claimableP: null });
    state.holderBatchClosed = true;
    // SH-279: closed with a final funding of zero: nothing can ever be credited, so settled and empty before the ledger's step.
    expect(await readClaim(reader, f.row, request, H(101))).toMatchObject({ status: 'settled', fundingP: 0n, claimableP: 0n, payout: 'empty', complete: false });
    state.holderBatchPaid = 40n;
    expect(await readClaim(reader, f.row, request, H(101))).toMatchObject({ status: 'settling', fundingP: 40n, claimableP: null, payout: 'not_ready' });
    state.holderBatchPaid = 0n;
    state.batchState = [true, 0n, 0n, 0n];
    expect(await readClaim(reader, f.row, request, H(101))).toMatchObject({ status: 'settled', fundingP: 0n, claimableP: 0n, payout: 'empty' });
    await expect(readClaim({ callAt: async () => { throw new Error('RPC offline'); } }, f.row, request, H(101))).rejects.toThrow('RPC offline');
  });
  it('does not label an RPC outage a paused coin, and does not infer historical credit from present balances', async () => {
    const { f, reader } = rig();
    expect(await readClaim({ ...reader, callFromAt: async () => { throw new Error('timeout'); } }, f.row, { batchId: 1n, holder: B }, H(101))).toMatchObject({ claimableP: 60n, payout: 'unverified' });
  });
  it('reads spendable budget separately from excluded failed T and starter progress at the same hash', async () => {
    const { f, reader, seen } = rig();
    expect(await readShop(reader, f.row, H(101))).toMatchObject({ hash: H(101), shop: { budgetT: 0n, failedT: 1000n, inside: 9n, collectionSize: 10n, seedReady: true }, starter: { loaded: 10, remainingHash: H(0), notified: true } });
    expect(seen.every(h => h === H(101))).toBe(true);
    expect(seen.length).toBeLessThanOrEqual(10);
  });
});
