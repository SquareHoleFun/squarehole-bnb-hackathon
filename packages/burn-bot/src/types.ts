import type { z } from 'zod';
import type { Address, Hex } from 'viem';
import type { actionSchema, lotSchema, quarantineSchema, quarantineReasonSchema, manifestSchema, quoteSchema, snapshotSchema } from './schema';

export type Manifest = z.output<typeof manifestSchema>;
export type Snapshot = z.output<typeof snapshotSchema>;
export type ReceiptLot = z.output<typeof lotSchema>;
export type QuarantinedReceipt = {
  lot: z.output<typeof quarantineSchema>; reason: z.output<typeof quarantineReasonSchema>;
  /** Unsupported royalties skip token-log proof; absent on historical rows, never an admission credential. */
  transferEvidence?: 'unverified';
};
export type Quote = z.output<typeof quoteSchema>;
export type Action = z.output<typeof actionSchema>;
export type Role = ReceiptLot['role'];
export interface SafeCall { to: Address; value: bigint; data: Hex; operation: 0 }
export interface Draft {
  role: Role; safe: Address; calls: SafeCall[]; source: ReceiptLot; request: Action;
  inputAsset: Address; outputAsset: Address; amountIn: bigint; minimumOut: bigint;
}
/** Trusted adapter: pinned, finalized reads and full execution simulation, never caller-supplied RPC calldata. */
export interface ChainReader {
  snapshot(role: Role): Promise<Snapshot>;
  simulate(safe: Address, transaction: SafeTransaction, block: Snapshot['block'], gasLimit: bigint): Promise<boolean>;
}
export interface SafeTransaction {
  to: Address; value: bigint; data: Hex; operation: 0 | 1; safeTxGas: bigint; baseGas: bigint;
  gasPrice: bigint; gasToken: Address; refundReceiver: Address; nonce: bigint;
}
/** Must produce an EIP-712 digest signature (r,s,v with v=27/28), not personal_sign. No raw keys cross this boundary. */
export interface DigestSigner { signDigest(digest: Hex): Promise<Hex> }
export interface SafeServicePayload {
  safe: Address; to: Address; value: string; data: Hex; operation: 0 | 1;
  safeTxGas: string; baseGas: string; gasPrice: string; gasToken: Address; refundReceiver: Address;
  nonce: string; contractTransactionHash: Hex; sender: Address; signature: Hex | null; origin: string;
}
export interface SafeProposer { propose(payload: SafeServicePayload): Promise<void> }
