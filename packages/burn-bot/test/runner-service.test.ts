import { describe, expect, it } from 'vitest';
import { FakeSafeService, SafeTransactionService, nextSafeNonce } from '../src/service';
import { servicePayload, safeTransaction } from '../src/safe';
import { buildAction } from '../src/builders';
import { CommandDigestSigner } from '../src/signer';
import { addr, hash, lot, manifest, snapshot } from './fixtures';

const payload = () => servicePayload(manifest, 'fit', safeTransaction(manifest, snapshot(), buildAction(manifest, snapshot(),
  lot('fit', '0x0000000000000000000000000000000000000000'), { kind: 'fund', lotId: 'lot-1', amount: 100n })), null);
describe('Safe service boundary', () => {
  it('uses idempotent hashes and same-nonce cancellation without deleting the original', async () => {
    const service = new FakeSafeService(); const original = payload();
    await service.propose(original); await service.propose(original);
    expect(await service.listPending(original.safe)).toHaveLength(1);
    const replacement = { ...original, to: original.safe, value: '0', data: '0x' as const, operation: 0 as const, contractTransactionHash: hash(98n) };
    await service.cancel(original, replacement);
    expect(await service.listPending(original.safe)).toHaveLength(2);
    await expect(service.cancel(original, { ...replacement, nonce: '1' })).rejects.toThrow(/same nonce/);
    expect(nextSafeNonce(0n, await service.listPending(original.safe))).toBe(1n);
    expect(nextSafeNonce(5n, [])).toBe(5n);
  });
  it('paginates pending records, strips executable signatures and refuses foreign pagination', async () => {
    const seen: string[] = [];
    const service = new SafeTransactionService(11155111n, 'https://safe.invalid', async url => {
      seen.push(String(url));
      return new Response(JSON.stringify({ next: seen.length === 1 ? 'https://safe.invalid/api/v1/page2/' : null,
        results: [{ safe: addr(1n), safeTxHash: hash(BigInt(seen.length)), nonce: 0, isExecuted: false,
          confirmations: [{ owner: addr(4n), signature: 'FAKE_SIGNATURE_DO_NOT_PERSIST' }] }] }));
    });
    expect(await service.listPending(addr(1n))).toEqual([
      { safe: addr(1n), hash: hash(1n), nonce: 0n, confirmations: [addr(4n)] },
      { safe: addr(1n), hash: hash(2n), nonce: 0n, confirmations: [addr(4n)] },
    ]);
    const hostile = new SafeTransactionService(11155111n, 'https://safe.invalid', async () => new Response(JSON.stringify({ results: [], next: 'https://elsewhere.invalid/' })));
    await expect(hostile.listPending(addr(1n))).rejects.toThrow(/pagination/);
    expect(() => new SafeTransactionService(1n, 'https://safe.invalid')).toThrow(/mainnet/);
  });
  it('does not echo external signer errors or accept a malformed result', async () => {
    const signer = new CommandDigestSigner('fake-signer', async () => { throw new Error('FAKE_PRIVATE_RESPONSE'); });
    await expect(signer.signDigest(hash(1n))).rejects.toThrow('managed signer unavailable');
    const malformed = new CommandDigestSigner('fake-signer', async () => 'FAKE_NOT_A_SIGNATURE');
    await expect(malformed.signDigest(hash(1n))).rejects.toThrow('invalid managed signer response');
  });
});
