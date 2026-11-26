import { encodeFunctionData, encodePacked, hashTypedData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { buildAction, validateSnapshot } from './builders';
import { canonicalJson } from './journal';
import { requireThat } from './schema';
import type { Draft, Manifest, Role, SafeCall, SafeServicePayload, SafeTransaction, Snapshot } from './types';

export const safeTypes = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
  { name: 'nonce', type: 'uint256' },
] } as const;
export function safeDigest(chainId: bigint, safe: Address, transaction: SafeTransaction): Hex {
  return hashTypedData({ domain: { chainId, verifyingContract: safe }, types: safeTypes, primaryType: 'SafeTx', message: transaction });
}
/** Internal envelope; callers build through an action or a same-nonce cancellation, never pass arbitrary calls to the signer. */
export function envelope(m: Manifest, s: Snapshot, calls: readonly SafeCall[]): SafeTransaction {
  requireThat(calls.length > 0 && calls.every(c => c.operation === 0), 'CALL-only batch required');
  const first = calls[0]; requireThat(first, 'empty calls');
  const target = calls.length === 1 ? first.to : m.multiSend.address;
  const data = calls.length === 1 ? first.data : encodeFunctionData({
    abi: parseAbi(['function multiSend(bytes transactions) payable']), functionName: 'multiSend', args: [
      `0x${calls.map(c => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, c.to, c.value, BigInt((c.data.length - 2) / 2), c.data]).slice(2)).join('')}`,
    ],
  });
  // MultiSend delegatecall uses the Safe's balance; outer msg.value is zero. Every inner operation is CALL.
  return { to: target, value: calls.length === 1 ? first.value : 0n, data, operation: calls.length === 1 ? 0 : 1,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: s.nonce };
}
export function safeTransaction(m: Manifest, s: Snapshot, draft: Draft): SafeTransaction {
  validateSnapshot(m, s, draft.role);
  const rebuilt = buildAction(m, s, draft.source, draft.request);
  requireThat(canonicalJson(rebuilt) === canonicalJson(draft), 'mutated draft');
  return envelope(m, s, rebuilt.calls);
}
export function servicePayload(m: Manifest, role: Role, tx: SafeTransaction, signature: Hex | null): SafeServicePayload {
  return { safe: m.safes[role], to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(), baseGas: tx.baseGas.toString(), gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.nonce.toString(),
    contractTransactionHash: safeDigest(m.chainId, m.safes[role], tx), sender: m.owners.bot, signature,
    origin: `Square Hole ${m.policyVersion}` };
}
