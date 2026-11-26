/** Receipt and replacement proof for one transaction, only inside the run that sent it. */
import type { Address, Hex, ReplacementReturnType } from 'viem';
import type { HolderReceiptV2 } from './actions-v2';
import { reasonText } from './reveal-words';

/** Only an unproved move survives its run, until the vault can no longer execute it. Decimal strings on disk. */
export interface PendingVaultMoveV2 {
  readonly chain: string; readonly vault: Address; readonly account: Address;
  readonly kind: 'take' | 'return'; readonly id: string; readonly deadline: string; readonly hash?: Hex;
}
export const PENDING_VAULT_MOVES_KEY = 'sh:v2:pending-vault-moves';
let pendingMoves: PendingVaultMoveV2[] = [];
let storageAvailable = true;
export function resetPendingVaultMovesForTests(): void { pendingMoves = []; storageAvailable = true; }
const moveKey = (r: PendingVaultMoveV2) => [r.chain, r.vault, r.account, r.kind, r.id, r.deadline].join(':');
function storedMove(value: unknown): PendingVaultMoveV2 | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 2n ** 256n;
  const address = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v);
  if (!decimal(r.chain) || r.chain === '0' || !address(r.vault) || !address(r.account) || (r.kind !== 'take' && r.kind !== 'return')
    || !decimal(r.id) || !decimal(r.deadline) || (r.hash !== undefined && (typeof r.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(r.hash)))) return null;
  return { chain: r.chain, vault: r.vault.toLowerCase() as Address, account: r.account.toLowerCase() as Address,
    kind: r.kind, id: r.id, deadline: r.deadline, ...(r.hash === undefined ? {} : { hash: r.hash as Hex }) };
}
/** Every access can fail. Only a time read on this chain can expire this chain's records (BoxVaultV2:852). */
function editPendingMoves(chain: string, now: bigint, edit: (moves: PendingVaultMoveV2[]) => PendingVaultMoveV2[]): PendingVaultMoveV2[] {
  let stored: PendingVaultMoveV2[] = [];
  try {
    const raw = storageAvailable ? localStorage.getItem(PENDING_VAULT_MOVES_KEY) : null;
    let value: unknown;
    try { value = JSON.parse(raw ?? '[]'); } catch { /* Malformed JSON is dropped, not a storage refusal. */ }
    if (Array.isArray(value)) stored = value.map(storedMove).filter((r): r is PendingVaultMoveV2 => r !== null);
  } catch { storageAvailable = false; /* Missing or refused storage leaves the visit's memory available. */ }
  const merged = new Map<string, PendingVaultMoveV2>();
  for (const r of [...pendingMoves, ...stored]) merged.set(moveKey(r), { ...merged.get(moveKey(r)), ...r });
  pendingMoves = edit([...merged.values()]).filter((r) => r.chain !== chain || !(now > BigInt(r.deadline)));
  try { if (storageAvailable) localStorage.setItem(PENDING_VAULT_MOVES_KEY, JSON.stringify(pendingMoves)); } catch { storageAvailable = false; /* Visit memory still holds. */ }
  return pendingMoves;
}
export function rememberVaultMove(record: PendingVaultMoveV2, now: bigint, remove = false): void {
  record = { ...record, vault: record.vault.toLowerCase() as Address, account: record.account.toLowerCase() as Address };
  editPendingMoves(record.chain, now, (moves) => {
    if (record.hash && !moves.some((r) => moveKey(r) === moveKey(record))) return moves;
    return [...moves.filter((r) => moveKey(r) !== moveKey(record)), ...(remove ? [] : [record])];
  });
}
/** Item placement cannot prove that a recorded transaction ended. Only chain time prunes these reads. */
export function expireVaultMoves(chain: number, now: bigint): PendingVaultMoveV2[] {
  return editPendingMoves(String(chain), now, (moves) => moves);
}
export function pendingVaultMoves(chain: number, vault: Address, account: Address, kind: PendingVaultMoveV2['kind'], id: bigint, now: bigint): PendingVaultMoveV2[] {
  return expireVaultMoves(chain, now).filter((r) => r.chain === String(chain) && r.vault === vault.toLowerCase()
    && r.account === account.toLowerCase() && r.kind === kind && r.id === id.toString());
}
export function pendingVaultMoveLine(chain: number, vault: Address, account: Address, kind: PendingVaultMoveV2['kind'], id: bigint, now: bigint): string | null {
  const held = pendingVaultMoves(chain, vault, account, kind, id, now);
  return held.length === 0 ? null : held.some((r) => !r.hash) ? reasonText('unknown-send') : 'Sent, but not confirmed. Check your wallet before trying again.';
}

export type VaultReplacementV2 = ReplacementReturnType;
export interface VaultOperationV2 {
  readonly account: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly hash: Hex;
  replacement?: VaultReplacementV2;
  receipt?: HolderReceiptV2;
  outcome: 'unknown' | 'success' | 'reverted' | 'cancelled' | 'replaced';
}
export type VaultReceiptReaderV2 = (hash: Hex, onReplaced?: (replacement: VaultReplacementV2) => void) => Promise<HolderReceiptV2>;
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
const runs = new WeakMap<object, Set<string>>();
/** Cards sharing a QueryClient share this synchronous run lock. The lock does not cross tabs. */
export function claimVaultRun(visit: object, scope: string): (() => void) | null {
  const active = runs.get(visit) ?? new Set<string>();
  if (active.has(scope)) return null;
  runs.set(visit, active); active.add(scope);
  return () => { active.delete(scope); };
}

/** Only the sending run follows receipts; its caller manages the pending move. */
export async function waitVaultOperation(op: VaultOperationV2, read: VaultReceiptReaderV2): Promise<void> {
  try {
    const receipt = await read(op.hash, (replacement) => { op.replacement = replacement; }).catch((error: unknown) => {
      if (op.replacement) return op.replacement.transactionReceipt;
      throw error;
    });
    const replacement = op.replacement;
    let sameCall = same(receipt.transactionHash, op.hash);
    if (!sameCall) {
      if (!replacement) return;
      const original = replacement.replacedTransaction; const tx = replacement.transaction;
      if (!same(original.hash, op.hash) || !same(original.from, op.account) || !same(tx.from, op.account)
        || tx.nonce !== original.nonce || !same(receipt.transactionHash, tx.hash)
        || !same(original.to, op.to) || !same(original.input, op.data) || original.value !== 0n) return;
      sameCall = same(tx.to, op.to) && same(tx.input, op.data) && tx.value === 0n;
      if (!sameCall) op.outcome = same(tx.to, op.account) && tx.value === 0n && tx.input === '0x' ? 'cancelled' : 'replaced';
    }
    if (sameCall) op.outcome = receipt.status === 'success' ? 'success' : 'reverted';
    op.receipt = receipt;
  } catch { /* No receipt proof: the caller retains its pending move until a look can end it. */ }
}

/** Existing site sentences, used only for their literal outcomes. */
export function vaultOperationError(op: VaultOperationV2): string | null {
  if (op.outcome === 'unknown') return 'Sent, but not confirmed. Check your wallet before trying again.';
  if (op.outcome === 'reverted') return 'The vault refused it. Refresh and try again.';
  // TxStatusPanel.tsx and trade-words.ts already use these wallet replacement sentences.
  if (op.outcome === 'cancelled') return 'Cancelled in the wallet: an empty transaction took its place.';
  if (op.outcome === 'replaced') return 'Replaced or cancelled in your wallet.';
  return null;
}
