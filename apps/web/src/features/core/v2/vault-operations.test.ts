import { describe, expect, it, vi } from 'vitest';
import { waitVaultOperation, vaultOperationError, PENDING_VAULT_MOVES_KEY, resetPendingVaultMovesForTests, pendingVaultMoveLine, expireVaultMoves, rememberVaultMove, type VaultOperationV2, type VaultReplacementV2 } from './vault-operations';
import { A, B, H } from './test-support/m3-published';

const operation = (): VaultOperationV2 => ({ account: A, to: B, data: '0x1234', hash: H(1), outcome: 'unknown' });
function replacement(op: VaultOperationV2, cancel = false): VaultReplacementV2 {
  const original = { hash: op.hash, from: A, to: B, input: op.data, nonce: 7, value: 0n };
  return { reason: cancel ? 'cancelled' : 'repriced', replacedTransaction: original,
    transaction: { ...original, hash: H(2), ...(cancel ? { to: A, input: '0x' } : {}) },
    transactionReceipt: { transactionHash: H(2), blockNumber: 21n, blockHash: H(21), status: 'success' },
  } as VaultReplacementV2;
}

describe('SH-235 submitted operation reconciliation', () => {
  it('a timeout ends this run unknown, with the not-confirmed sentence', async () => {
    const op = operation();
    await waitVaultOperation(op, async () => { throw new Error('timeout'); });
    expect(op.hash).toBe(H(1)); expect(op.outcome).toBe('unknown');
    expect(vaultOperationError(op)).toBe('Sent, but not confirmed. Check your wallet before trying again.');
  });
  it('accepts a verified same-call speed-up and keeps its actual hash and receipt', async () => {
    const op = operation(); const r = replacement(op);
    await waitVaultOperation(op, async (_hash, onReplaced) => { onReplaced?.(r); return r.transactionReceipt; });
    expect(op.outcome).toBe('success'); expect(op.receipt?.transactionHash).toBe(H(2));
    expect(vaultOperationError(op)).toBeNull();
  });
  it('a cancelling replacement uses the existing cancellation sentence', async () => {
    const op = operation(); const r = replacement(op, true);
    await waitVaultOperation(op, async (_hash, onReplaced) => { onReplaced?.(r); return r.transactionReceipt; });
    expect(op.outcome).toBe('cancelled');
    expect(vaultOperationError(op)).toBe('Cancelled in the wallet: an empty transaction took its place.');
  });
  it.each(['nonce', 'from', 'hash', 'input'] as const)('does not accept replacement evidence with wrong original %s', async (field) => {
    const op = operation(); const r = replacement(op);
    const bad = { ...r, replacedTransaction: { ...r.replacedTransaction, [field]: field === 'nonce' ? 8 : field === 'from' ? B : field === 'hash' ? H(3) : '0x5678' } } as VaultReplacementV2;
    await waitVaultOperation(op, async (_hash, onReplaced) => { onReplaced?.(bad); return bad.transactionReceipt; });
    expect(op.outcome).toBe('unknown'); expect(op.receipt).toBeUndefined();
  });
  it('a different receipt hash alone proves nothing', async () => {
    const op = operation();
    await waitVaultOperation(op, async () => replacement(op).transactionReceipt);
    expect(op.outcome).toBe('unknown'); expect(op.receipt).toBeUndefined();
  });
  it('remembers replacement evidence even when its waiter then fails', async () => {
    const op = operation(); const r = replacement(op);
    await waitVaultOperation(op, async (_hash, onReplaced) => { onReplaced?.(r); throw new Error('timeout'); });
    expect(op.outcome).toBe('success'); expect(op.receipt?.transactionHash).toBe(H(2));
  });
  it('a reverted receipt says refused', async () => {
    const op = operation(); let release = () => {}; let reads = 0;
    const wait = new Promise<void>((done) => { release = done; });
    const read = async () => { reads++; await wait; return { ...replacement(op).transactionReceipt, transactionHash: op.hash, status: 'reverted' as const }; };
    const first = waitVaultOperation(op, read);
    release(); await first;
    expect(reads).toBe(1); expect(op.outcome).toBe('reverted');
    expect(vaultOperationError(op)).toBe('The vault refused it. Refresh and try again.');
  });
});

describe('SH-235 pending move data', () => {
  const record = { chain: '31337', vault: B, account: A, kind: 'take' as const, id: '1', deadline: '1200', hash: H(1) };
  it.each([
    ['chain', 31337], ['chain', '0'], ['vault', 'oops'], ['account', null], ['kind', 'approve'],
    ['id', 1], ['id', '-1'], ['id', '01'], ['deadline', 'later'], ['deadline', (2n ** 256n).toString()], ['hash', '0x1'],
  ])('drops a malformed %s field and keeps the valid sibling', (field, value) => {
    resetPendingVaultMovesForTests(); localStorage.clear();
    localStorage.setItem(PENDING_VAULT_MOVES_KEY, JSON.stringify([{ ...record, [field as string]: value }, record]));
    expect(pendingVaultMoveLine(31337, B, A, 'take', 1n, 1000n)).toBe('Sent, but not confirmed. Check your wallet before trying again.');
    expect(JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY) ?? '[]')).toEqual([{ ...record, account: A.toLowerCase(), vault: B.toLowerCase() }]);
  });
  it('every write prunes expired same-chain records but never uses one chain clock for another', () => {
    resetPendingVaultMovesForTests(); localStorage.clear();
    rememberVaultMove({ ...record, hash: undefined }, 1000n);
    rememberVaultMove(record, 1000n);
    rememberVaultMove({ ...record, hash: undefined, chain: '1' }, 1000n);
    rememberVaultMove({ ...record, chain: '1' }, 1000n);
    rememberVaultMove({ ...record, hash: undefined, id: '2', deadline: '2400' }, 1201n);
    rememberVaultMove({ ...record, id: '2', deadline: '2400' }, 1201n);
    const saved = JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY) ?? '[]') as { chain: string; id: string }[];
    expect(saved.map((r) => [r.chain, r.id])).toEqual([['1', '1'], ['31337', '2']]);
  });
  it('a refused write switches to visit memory, so old disk data cannot restore a removed move', () => {
    resetPendingVaultMovesForTests(); localStorage.clear();
    rememberVaultMove({ ...record, hash: undefined }, 1000n);
    rememberVaultMove(record, 1000n);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      rememberVaultMove(record, 1000n, true);
      expect(pendingVaultMoveLine(31337, B, A, 'take', 1n, 1000n)).toBeNull();
    } finally { write.mockRestore(); }
  });
  it('attaches a hash only to an existing move and never restores an expired record', () => {
    resetPendingVaultMovesForTests(); localStorage.clear();
    const stored = () => JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY) ?? '[]') as unknown;
    rememberVaultMove(record, 1000n);
    expect(stored()).toEqual([]);
    expect(expireVaultMoves(31337, 1000n)).toEqual([]);
    rememberVaultMove({ ...record, hash: undefined }, 1000n);
    rememberVaultMove(record, 1000n);
    const expected = [{ ...record, account: A.toLowerCase(), vault: B.toLowerCase() }];
    expect(stored()).toEqual(expected);
    expect(expireVaultMoves(31337, 1000n)).toEqual(expected);
    expect(expireVaultMoves(31337, 1201n)).toEqual([]);
    rememberVaultMove(record, 1000n);
    expect(stored()).toEqual([]);
    expect(expireVaultMoves(31337, 1000n)).toEqual([]);
  });

});
