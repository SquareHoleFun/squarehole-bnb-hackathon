import { canonicalPairId, type Address, type PairId, type Position } from '@squarehole/domain';
import { useId, useRef, useSyncExternalStore } from 'react';
import { Loader } from '../brand';
import { AccountBar, useAccountClaim, useAccountClaims, useAccountPositions, useRecoverFocus, type AccountScenario } from '../accounts';
import { TxStatusPanel, isTxBusy } from '../tx';
import { useClaimFlowStore } from './claim-flow-context';
import type { ClaimFlowEntry } from './claim-flows';
import { ClaimCard } from './ClaimCard';
import type { Holding } from './ClaimParts';


/** Why these signed claims are listed apart from the connected account's own list. */
export type TrackedReason = 'disconnected' | 'switched' | 'unreadable';

const LEDE: Readonly<Record<TrackedReason, string>> = Object.freeze({
  disconnected: 'Sent before the wallet disconnected. Each result appears here; nothing new can start until you connect again.',
  switched: 'Sent from another account before you switched. Each result appears here; switch back to that account to claim anything else on it.',
  unreadable: 'Your claims cannot be read right now, but the claims you already sent are still tracked here.',
});

const WAIT_HINT: Readonly<Record<TrackedReason, string | undefined>> = Object.freeze({
  disconnected: undefined,
  switched: 'Switch back to this account to claim on it.',
  unreadable: 'Wait until your claims can be read again.',
});

/**
 * `/rewards` section for signed claims that are not in the connected account's list (06-ARCHITECTURE, UI-08): a
 * previous account's after a persona switch, every account's after a disconnect, or the account's own while its list
 * cannot be read. A signed request never silently disappears; each card shows its live status and figures.
 */
export function TrackedClaimsSection({ entries, scenario, reason }: { entries: readonly ClaimFlowEntry[]; scenario: AccountScenario; reason: TrackedReason }) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useRecoverFocus(headingRef, entries.length);
  const accounts = [...new Set(entries.map((entry) => entry.account.toLowerCase()))];
  return (
    <section className="sh-rewards-page__list sh-tracked-claims" aria-labelledby={headingId} data-testid="tracked-claims" data-tracked-reason={reason}>
      <h2 id={headingId} ref={headingRef} className="sh-section-title" tabIndex={-1}>
        Claims still being tracked
      </h2>
      <p className="sh-tracked-claims__lede">{LEDE[reason]}</p>
      {accounts.map((lower) => {
        const group = entries.filter((entry) => entry.account.toLowerCase() === lower);
        const account = group[0]?.account;
        return account ? <TrackedAccount key={lower} account={account} entries={group} scenario={scenario} reason={reason} /> : null;
      })}
    </section>
  );
}

function TrackedAccount({ account, entries, scenario, reason }: { account: Address; entries: readonly ClaimFlowEntry[]; scenario: AccountScenario; reason: TrackedReason }) {
  const claims = useAccountClaims(reason === 'unreadable' ? null : account, scenario);
  return (
    <div className="sh-tracked-claims__account" data-account={account.toLowerCase()}>
      {reason === 'unreadable' ? null : (
        <AccountBar
          account={account}
          asOfBlock={claims.data?.asOfBlock ?? null}
          asOf={claims.data?.provenance.asOf ?? null}
          tracking={reason === 'disconnected' ? 'disconnected' : 'switched'}
        />
      )}
      <ul className="sh-claims">
        {entries.map((entry) => (
          <li key={entry.key}>
            <TrackedClaim entry={entry} scenario={scenario} waitHint={WAIT_HINT[reason]} />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface TrackedClaimProps {
  readonly entry: ClaimFlowEntry;
  readonly scenario: AccountScenario;
  readonly waitHint?: string;
  readonly variant?: 'list' | 'pair';
  readonly labelledBy?: string;
}

/**
 * One signed claim of an account that cannot start anything here: the same `ClaimCard` (re-attached to the stored
 * request, nothing can start), or, when that account's figures cannot be read, the request's status on its own.
 * Once the request is over, the person can hide it.
 */
export function TrackedClaim({ entry, scenario, waitHint, variant = 'list', labelledBy }: TrackedClaimProps) {
  const store = useClaimFlowStore();
  const snapshot = useSyncExternalStore(entry.controller.subscribe, entry.controller.getSnapshot, entry.controller.getSnapshot);
  const claim = useAccountClaim(entry.pairId as PairId, entry.account, scenario);
  const positions = useAccountPositions(entry.account, scenario);
  const pair = entry.started?.pair ?? null;
  const holding: Holding = positions.isPending
    ? 'pending'
    : positions.isError
      ? 'unavailable'
      : (positions.data.positions.find((position: Position) => canonicalPairId(position.pairId) === entry.pairId) ?? null);
  const name = pair?.name ?? entry.pairId;

  return (
    <>
      {claim.data && pair ? (
        <ClaimCard
          claim={claim.data}
          pair={pair}
          position={holding}
          selected={false}
          canStart={false}
          waitHint={waitHint}
          variant={variant}
          labelledBy={labelledBy}
        />
      ) : (
        <div className="sh-panel sh-claim sh-claim--status-only" data-pair-id={entry.pairId} data-claim-variant="status-only">
          <p className={claim.isPending ? 'sh-claim__holding sh-loader-line' : 'sh-claim__holding'}>
            {claim.isPending ? <Loader size="inline" decorative /> : null}
            {claim.isPending ? `Reading the figures for ${name}…` : `The figures for ${name} cannot be read right now. The request below is still tracked.`}
          </p>
          <TxStatusPanel state={snapshot.state} headingLevel={variant === 'pair' ? 4 : 3} scenarioPicker={false} onRetry={null} />
        </div>
      )}
      {isTxBusy(snapshot) ? null : (
        <p className="sh-tracked-claims__hide">
          <button type="button" className="sh-button" onClick={() => store.hide(entry.key)}>
            Hide the {name} claim from this list
          </button>
        </p>
      )}
    </>
  );
}
