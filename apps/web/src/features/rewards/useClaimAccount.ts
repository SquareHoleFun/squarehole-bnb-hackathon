import type { Address } from '@squarehole/domain';
import { useWallet } from '../wallet';
import { useSignedClaims } from './claim-flow-context';
import type { ClaimFlowEntry } from './claim-flows';

export interface ClaimAccount {
  /** The connected account, whose own claims the surface lists and can start; null while disconnected. */
  readonly account: Address | null;
  /**
   * Signed claims of every other account (all accounts while disconnected), still tracked in the app-level claim store:
   * a persona switch or a disconnect never makes a sent transaction silently disappear (06-ARCHITECTURE, UI-08).
   */
  readonly tracked: readonly ClaimFlowEntry[];
}

/**
 * Which account a claim surface (`/rewards`, the pair detail fee-share card) shows, and which sent claims it keeps showing
 * apart from it. One hook for both pages; `pairId` (canonical) narrows the tracked claims to one pair.
 */
export function useClaimAccount(pairId?: string): ClaimAccount {
  const wallet = useWallet();
  const account = wallet.status === 'connected' ? wallet.account : null;
  const tracked = useSignedClaims({ exceptAccount: account, pairId });
  return { account, tracked };
}
