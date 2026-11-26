import { describe, expect, it } from 'vitest';
import { encodeFunctionResult, parseAbi, toHex, type PublicClient } from 'viem';
import { CLAIM_SIMULATION_GAS, claimsRpcReaderV2, readCreatorClaimV2 } from '../../../../../indexer/src/core/v2/claims-reads-v2';
import { creatorQuoteCodeV2 } from '../../../../../indexer/src/core/v2/claims-quote-code';
import { A, H, HUGE, walletFixture } from './wallet-fixture';

describe('FINAL-RPC: canonical sender-aware quotes cannot send money or rewrite custody', () => {
  it('pins both ordinary and simulated reads to the same canonical block; only the quote caller code is overridden', async () => {
    const calls: unknown[] = [];
    const abi = parseAbi(['function quote(address receiver,address asset) returns (uint256)']);
    const client = {
      request: async (request: unknown) => { calls.push(request); return encodeFunctionResult({ abi, functionName: 'quote', result: HUGE }); },
      getBlock: async () => ({ number: 100n, hash: H(100), parentHash: H(99), timestamp: 123n }),
    } as unknown as Pick<PublicClient, 'request' | 'getBlock'>;
    const reader = claimsRpcReaderV2(client), f = walletFixture(0, 0);
    await reader.callAt(f.holder.at(5), '0x12345678', H(100));
    await reader.callFromAt?.(A, f.holder.at(5), '0x12345678', H(100));
    expect(await reader.creatorEntitlementAt?.(A, f.holder.at(5), f.holder.row.q, H(100))).toBe(HUGE);
    const canonical = { blockHash: H(100), requireCanonical: true };
    expect(calls).toEqual([
      { method: 'eth_call', params: [{ to: f.holder.at(5), data: '0x12345678' }, canonical] },
      { method: 'eth_call', params: [{ to: f.holder.at(5), data: '0x12345678', from: A, gas: toHex(CLAIM_SIMULATION_GAS) }, canonical] },
      { method: 'eth_call', params: [expect.objectContaining({ from: A, to: A, gas: toHex(CLAIM_SIMULATION_GAS) }), canonical, { [A]: { code: creatorQuoteCodeV2 } }] },
    ]);
    expect(await reader.headerByNumber(100n)).toEqual({ number: 100n, hash: H(100), parentHash: H(99), timestamp: 123n });
  });

  it('a generic revert or failed override never guesses a creator entitlement from stored money', async () => {
    const f = walletFixture(0, 0); f.set(f.holder.at(5), 'creatorPayee', A);
    let overrides = 0;
    const r = { ...f.reader, callFromAt: async (): Promise<never> => { throw Object.assign(new Error('RPC revert'), { code: 3 }); },
      creatorEntitlementAt: async () => { overrides++; return HUGE; } };
    await expect(readCreatorClaimV2(r, f.holder.row, A, H(100))).rejects.toThrow('RPC revert');
    expect(overrides).toBe(0);
    const canonicalFailure = claimsRpcReaderV2({ request: async () => { throw new Error('noncanonical block'); } } as unknown as PublicClient);
    await expect(canonicalFailure.creatorEntitlementAt?.(A, f.holder.at(5), f.holder.row.q, H(100))).rejects.toThrow('noncanonical');
  });
});
