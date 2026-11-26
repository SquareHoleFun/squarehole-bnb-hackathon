/**
 * Honest status copy for every transaction state (06-ARCHITECTURE; UI-08). Rules: a hash is never called success; only
 * `finalized` is "done"; before signing the copy says nothing was signed; after signing it never guesses an outcome
 * the chain has not reported; a reverted claim is still intact (ECO-07).
 */
import type { TxState } from '@squarehole/domain';
import { chainLabel } from '../wallet';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type TxTone = 'neutral' | 'waiting' | 'warning' | 'error' | 'success';

/** Demo flows (mock executor, demo wallet) or chain flows (real executor, browser wallet). */
export type TxCopyMode = 'demo' | 'chain';

export interface TxCopy {
  readonly tone: TxTone;
  readonly title: string;
  readonly body: string;
}

const REVERT_REASONS: Readonly<Record<string, string>> = Object.freeze({
  min_payout_not_met: 'The payout would have been below the signed minimum.',
});

/**
 * A known contract reason in words, followed by the original code; unknown reasons are shown as given. Reasons come
 * from the wallet/RPC (untrusted), so only the table's own keys count: "toString" or "__proto__" never resolve to an
 * inherited member.
 */
export function explainReason(reason: string): string {
  const known = Object.hasOwn(REVERT_REASONS, reason) ? REVERT_REASONS[reason] : undefined;
  return known ? `${known} (${reason})` : reason;
}

export function txCopy(state: TxState, mode: TxCopyMode = DEMO_BUILD ? 'demo' : 'chain'): TxCopy {
  switch (state.status) {
    case 'idle':
      return { tone: 'neutral', title: 'Not started', body: 'Nothing has been prepared or signed.' };
    case 'preparing':
      return { tone: 'waiting', title: 'Preparing', body: 'Building and simulating the request. Nothing has been signed.' };
    case 'simulation_failed':
      return {
        tone: 'error',
        title: 'Simulation failed',
        body: 'The request would fail, so it was not sent to the wallet. Nothing was signed.',
      };
    case 'wrong_chain':
      return {
        tone: 'warning',
        title: 'Wrong network',
        body: `The wallet is on ${chainLabel(state.walletChainId)}, but this request is for ${chainLabel(state.ctx.chainId)}. Switch networks to continue. Nothing is sent on another network.`,
      };
    case 'awaiting_signature':
      return !DEMO_BUILD || mode === 'chain'
        ? {
            tone: 'waiting',
            title: 'Ready to confirm',
            body: 'The simulation succeeded. Check the details and the network fee below, then confirm in your wallet. Nothing has been sent.',
          }
        : { tone: 'waiting', title: 'Waiting for your signature', body: 'Review the request in the wallet. Nothing has been sent.' };
    case 'rejected':
      return { tone: 'neutral', title: 'Signature declined', body: 'The request was declined in the wallet. Nothing was signed or sent.' };
    case 'invalidated':
      if (state.cause === 'deadline_passed') {
        return {
          tone: 'warning',
          title: 'Quote expired',
          // The claim card shows "No current quote" with its "Refresh the estimate" button above this panel.
          body: 'The quote deadline passed before signing, so nothing was signed. Refresh the estimate above, then claim again.',
        };
      }
      return {
        tone: 'warning',
        title: 'Request cancelled',
        body:
          state.cause === 'account_changed'
            ? 'The wallet account changed before signing, so this request no longer matches it. Nothing was signed. Start again for the current account.'
            : `The wallet changed networks before signing. Nothing was signed. Start again on ${chainLabel(state.ctx.chainId)}.`,
      };
    case 'submitted':
      return {
        tone: 'waiting',
        title: 'Submitted, not confirmed',
        body: 'The wallet returned a transaction hash. A hash is not a confirmation: the transaction is not in a block yet.',
      };
    case 'pending':
      return { tone: 'waiting', title: 'Pending', body: 'Waiting for the transaction to be included in a block. Not confirmed yet.' };
    case 'replaced':
      return {
        tone: 'warning',
        title: 'Replaced',
        body: 'The wallet replaced this transaction with another one, which can be a speed-up or a cancellation. Check the replacement before trying again; this page does not assume either outcome.',
      };
    case 'confirmed_unfinalized':
      return {
        tone: 'waiting',
        title: 'Included, not final',
        body: `Included in block ${state.block}. It is not final yet and could still be reorganised out, so it does not count as done.`,
      };
    case 'finalized':
      return {
        tone: 'success',
        title: 'Finalized',
        body:
          mode === 'chain'
            ? `Finalized in block ${state.block}, and the result was checked against the chain.`
            : `Finalized in block ${state.block}.`,
      };
    case 'reverted':
      return {
        tone: 'error',
        title: 'Reverted',
        body:
          state.ctx.kind === 'claim'
            ? 'The transaction was included but reverted, so nothing changed. Your claim is still intact.'
            : 'The transaction was included but reverted, so nothing was created.',
      };
    case 'timed_out':
      return {
        tone: 'warning',
        title: 'No confirmation yet',
        body: 'Stopped waiting for a receipt. The transaction may still be included later; check its hash before trying again.',
      };
    case 'unknown':
      return {
        tone: 'warning',
        title: 'Status unknown',
        body: 'The transaction’s status could not be read. It may or may not be included; check its hash before trying again.',
      };
  }
}
