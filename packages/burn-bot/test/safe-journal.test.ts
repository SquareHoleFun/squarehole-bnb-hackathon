import { describe, expect, it } from 'vitest';
import { decodeFunctionData, hashTypedData, parseAbi, zeroAddress } from 'viem';
import { buildAction, validateSnapshot } from '../src/builders';
import { safeTransaction, safeDigest, safeTypes, servicePayload } from '../src/safe';
import { Journal, MemoryAppendStore } from '../src/journal';
import { must, addr, hash, lot, manifest, quote, snapshot } from './fixtures';

describe('CQ11-E2 Safe envelopes and public journal', () => {
  it.each([1n, 11155111n])('FABLE item 15: accepts the standard Safe 1.4.1 handler on chain %s', chainId => {
    const handler = '0xfd0732dc9e303f09fcef3a7388ad10a83459ec99' as const;
    const m = { ...manifest, chainId, safeConfigs: { ...manifest.safeConfigs,
      fit: { ...manifest.safeConfigs.fit, handler, handlerCodeHash: hash(44n) } } };
    const s = { ...snapshot(), chainId, fallbackHandler: handler,
      codeHashes: { ...snapshot().codeHashes, [handler]: hash(44n) } };
    expect(() => validateSnapshot(m, s, 'fit')).not.toThrow();
    expect(() => validateSnapshot(m, { ...s, modules: [addr(99n)] }, 'fit')).toThrow(/Safe configuration/);
    expect(() => validateSnapshot(m, { ...s, guard: addr(99n) }, 'fit')).toThrow(/Safe configuration/);
    expect(() => validateSnapshot(m, { ...s, fallbackHandler: addr(99n) }, 'fit')).toThrow(/Safe configuration/);
    expect(() => validateSnapshot(m, { ...s, codeHashes: snapshot().codeHashes }, 'fit')).toThrow(/Safe configuration/);
  });
  it('encodes CALL-only MultiSend, disables reimbursements, and binds chain/Safe/nonce', () => {
    const s = snapshot();
    const draft = buildAction(manifest, s, lot(), { kind: 'sale', lotId: 'lot-1', routeId: 'coin-eth', amount: 100n, quote: quote() });
    const tx = safeTransaction(manifest, s, draft);
    expect(tx).toMatchObject({ to: manifest.multiSend.address, value: 0n, operation: 1, nonce: 0n, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress });
    const packed = decodeFunctionData({ abi: parseAbi(['function multiSend(bytes transactions) payable']), data: tx.data }).args[0];
    expect(packed.slice(2, 4)).toBe('00');
    const digest = safeDigest(1n, s.safe, tx);
    expect(digest).toBe(hashTypedData({ domain: { chainId: 1n, verifyingContract: s.safe }, types: safeTypes, primaryType: 'SafeTx', message: tx }));
    expect(safeDigest(2n, s.safe, tx)).not.toBe(digest);
    expect(safeDigest(1n, addr(99n), tx)).not.toBe(digest);
    expect(safeDigest(1n, s.safe, { ...tx, nonce: 1n })).not.toBe(digest);
    expect(servicePayload(manifest, 'fit', tx, null)).toMatchObject({ safe: s.safe, value: '0', nonce: '0', contractTransactionHash: digest, sender: manifest.owners.bot, signature: null });
  });
  it('requires reviewed Safe owners, no modules, and the pinned helper code', () => {
    const source = lot(); const request = { kind: 'sale', lotId: source.id, routeId: 'coin-eth', amount: 100n, quote: quote() };
    for (const patch of [{ threshold: 1n }, { owners: [addr(99n)] }, { modules: [addr(99n)] }, { guard: addr(99n) }, { codeHashes: {} }, { version: '1.3.0' }]) {
      expect(() => buildAction(manifest, { ...snapshot(), ...patch }, source, request)).toThrow();
    }
  });
  it('appends canonical hash-linked decimal records and detects edits/truncation against checkpoints', () => {
    const store = new MemoryAppendStore(); const journal = new Journal(store);
    const entry = journal.append({ kind: 'receipt', chainId: '1', safe: addr(1n), txHash: hash(2n), amountRaw: '9007199254740993123456' });
    journal.append({ kind: 'orphan', refersTo: entry.entryHash, txHash: hash(2n) });
    const restored = new Journal(store, journal.head);
    expect(restored.entries).toHaveLength(2);
    expect(must(restored.entries[1]).previousHash).toBe(entry.entryHash);
    expect(store.read()).not.toContain('9007199254740993123456n');
    const tampered = new MemoryAppendStore(store.read().replace('9007199254740993123456', '1'));
    expect(() => new Journal(tampered, journal.head)).toThrow();
    expect(() => new Journal(new MemoryAppendStore(store.read().split('\n').slice(0, 1).join('\n') + '\n'), journal.head)).toThrow();
  });
  it('rejects numeric amounts, noncanonical decimal strings, keys and pending signatures', () => {
    const journal = new Journal(new MemoryAppendStore());
    for (const payload of [{ amountRaw: 1 }, { amountRaw: '1e18' }, { amountRaw: '-1' }, { signature: '0xab' }, { privateKey: 'secret' }]) {
      expect(() => journal.append(payload)).toThrow();
    }
    expect(journal.entries).toHaveLength(0);
  });
  it('fails closed on stale writers', () => {
    const store = new MemoryAppendStore(); const a = new Journal(store); const b = new Journal(store);
    a.append({ kind: 'waiting', reason: 'not-graduated' });
    expect(() => b.append({ kind: 'waiting', reason: 'stale' })).toThrow();
  });
});
