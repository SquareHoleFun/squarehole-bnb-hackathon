/**
 * The key split gate (K5 / MF-16): which split may stand behind which escrow intent, shared by the CLI preflight, the
 * split hook and the public writer. F115 R30P selects trustees; F122 R37E builds their split on shamir-secret-sharing
 * (trustees.ts). Trustee escrow passes only with the genuine TrusteeKeySplit (made by its constructor: not a subclass,
 * a copy or an object that names its scheme) and its verified receipt for this archive. A no-op or any other splitter
 * claiming "shamir-2-of-3" is refused before it is handed the key. No label substitutes for recovery.
 */
import type { Hex32 } from '../hash';
import { assertEscrowMode, type ArchiveKeySplit, type EscrowMode, type KeySplitContext, type SplitReceipt } from './archive';
import { Refusal } from './safe-paths';
import { TRUSTEE_SCHEME, TrusteeKeySplit, isVerifiedTrusteeReceipt } from './trustees';

const TRUSTEE_ESCROW: EscrowMode = 'trustees-2-of-3';

/** Refuses an escrow intent that `splitter` cannot deliver: trustee escrow only through the genuine trustee splitter. */
export function assertEscrowAvailable(escrowIntent: EscrowMode, splitter?: ArchiveKeySplit): void {
  assertEscrowMode(escrowIntent);
  const genuine = TrusteeKeySplit.isGenuine(splitter);
  if (escrowIntent === TRUSTEE_ESCROW && !genuine) {
    throw new Error(
      'trustee escrow (F115 R30P) is made only by the 2-of-3 trustee splitter (TrusteeKeySplit, with three explicit trustee folders) and its verified recovery; no export was made',
    );
  }
  if (escrowIntent !== TRUSTEE_ESCROW && (genuine || splitter?.scheme === TRUSTEE_SCHEME)) {
    throw new Error(`a ${TRUSTEE_SCHEME} split goes only with trustee escrow (${TRUSTEE_ESCROW})`);
  }
}

function assertTrusteeReceipt(receipt: unknown, archive: { readonly keyId: Hex32; readonly archiveSha256: Hex32 }): void {
  if (!isVerifiedTrusteeReceipt(receipt)) {
    throw new Error(`a ${TRUSTEE_SCHEME} key split needs the receipt of a verified trustee split (TrusteeKeySplit); a label is not a split`);
  }
  if (receipt.keyId !== archive.keyId || receipt.archiveSha256 !== archive.archiveSha256) {
    throw new Error('the trustee split receipt is for another archive (its key id or archive sha256 differs)');
  }
}

/**
 * Runs `splitter` once on a copy of the key (zeroed afterwards) for the archive `context` names. A splitter's own
 * error may hold the key or a share, so it becomes a fixed message; only the genuine trustee splitter's refusals,
 * built from trustee numbers, folders and fields, pass through. A trustee receipt must be verified and name this
 * archive.
 */
export async function runKeySplit(splitter: ArchiveKeySplit, key: Uint8Array, context: KeySplitContext): Promise<SplitReceipt> {
  assertEscrowAvailable(context.escrowIntent, splitter);
  const genuine = TrusteeKeySplit.isGenuine(splitter);
  const copy = new Uint8Array(key);
  let receipt: SplitReceipt | undefined;
  try {
    receipt = await splitter.split(copy, context);
  } catch (error) {
    if (genuine && error instanceof Refusal) throw new Refusal(`the trustee split was refused: ${error.message}`, { cause: error });
    // eslint-disable-next-line preserve-caught-error -- a splitter's own error may hold the key or a share: it must not travel as a cause
    throw new Error('the archive key splitter failed');
  } finally {
    copy.fill(0);
  }
  if (typeof receipt !== 'object' || receipt === null || receipt.scheme !== splitter.scheme) throw new Error('the splitter reported a different scheme');
  if (genuine) assertTrusteeReceipt(receipt, context);
  return receipt;
}

/** What the public file says about the key split. */
export interface KeySplitClaim {
  readonly escrowIntent: EscrowMode;
  readonly keyId: Hex32;
  readonly archiveSha256: Hex32;
  /** The split's scheme. */
  readonly keySplit: string;
  /** The split's receipt: required for trustee escrow (and for the shamir-2-of-3 label). */
  readonly receipt?: SplitReceipt | undefined;
}

/** Trustee escrow says shamir-2-of-3, and shamir-2-of-3 stands only on a verified trustee receipt for this archive. */
export function assertKeySplitClaim(claim: KeySplitClaim): void {
  assertEscrowMode(claim.escrowIntent);
  const trustee = claim.escrowIntent === TRUSTEE_ESCROW;
  if (trustee && claim.keySplit !== TRUSTEE_SCHEME) throw new Error(`trustee escrow needs key split ${TRUSTEE_SCHEME} from the verified trustee splitter`);
  if (claim.keySplit !== TRUSTEE_SCHEME) return;
  if (!trustee) throw new Error(`a ${TRUSTEE_SCHEME} split goes only with trustee escrow (${TRUSTEE_ESCROW})`);
  assertTrusteeReceipt(claim.receipt, claim);
}
