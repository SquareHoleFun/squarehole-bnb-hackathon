import { CastCharacter } from '@squarehole/design';
import { AccountQueryError, canonicalPairId, type Address, type Position } from '@squarehole/domain';
import { useMemo, useRef } from 'react';
import { Link } from 'react-router';
import {
  AccountBar,
  LoadingPanel,
  UnavailablePanel,
  WrongNetworkNotice,
  useAccountClaim,
  useAccountClaims,
  useAccountPositions,
  usePairRecords,
  useRecoverFocus,
  type AccountScenario,
  type SelectedPair,
} from '../accounts';
import { useSignedClaims } from './claim-flow-context';
import { ClaimCard } from './ClaimCard';
import type { Holding } from './ClaimParts';
import { countClaims } from './claim-model';
import { TrackedClaimsSection } from './TrackedClaims';


export interface ClaimsViewProps {
  /** The connected account. */
  readonly account: Address;
  readonly scenario: AccountScenario;
  readonly selected: SelectedPair;
}

const HEADING_ID = 'rewards-list-title';
const READING_HINT = 'Wait for the new data to finish loading.';

/**
 * The connected account's claims across pairs (SH-014): one card per pair with any claimable, claimed, pending-harvest
 * or historical reward, including pairs the account no longer holds (ECO-05). `?pair=` puts that pair first and marks
 * it, reading its claim directly when the account has no activity there.
 *
 * Changing the account-data scenario keeps the cards on screen (flagged as being re-read, nothing can start) so a
 * request in progress stays visible; while the list cannot be shown at all, the account's sent claims are listed on
 * their own. Each card re-reads its quote at the quote deadline (`useQuoteExpiry`).
 */
export function ClaimsView({ account, scenario, selected }: ClaimsViewProps) {
  const claims = useAccountClaims(account, scenario, { keepPrevious: true });
  const positions = useAccountPositions(account, scenario, { keepPrevious: true });
  const own = useSignedClaims({ account });
  const headingRef = useRef<HTMLHeadingElement>(null);
  useRecoverFocus(headingRef, claims.status);

  const selectedId = selected.kind === 'pair' ? selected.pairId : null;
  const listed = useMemo(() => claims.data?.claims ?? [], [claims.data]);
  const inList = selectedId !== null && listed.some((claim) => canonicalPairId(claim.pairId) === selectedId);
  const single = useAccountClaim(claims.isSuccess && selectedId !== null && !inList ? selectedId : null, account, scenario, { keepPrevious: true });

  const shown = useMemo(() => {
    const extra = single.data && !inList ? [single.data] : [];
    const all = [...extra, ...listed];
    return selectedId === null ? all : [...all.filter((c) => canonicalPairId(c.pairId) === selectedId), ...all.filter((c) => canonicalPairId(c.pairId) !== selectedId)];
  }, [single.data, inList, listed, selectedId]);
  const pairs = usePairRecords(useMemo(() => shown.map((claim) => claim.pairId), [shown]));

  if (claims.isPending || claims.isError) {
    return (
      <>
        {claims.isPending ? (
          <LoadingPanel label="Reading your claims…" />
        ) : (
          <UnavailablePanel title="Claims unavailable" onRetry={() => void claims.refetch()}>
            <p>
              The account data could not be read. Nothing is lost: credited amounts are kept by the fee-credit ledger, not by
              this page, and a failed read is never shown as zero.
            </p>
          </UnavailablePanel>
        )}
        {own.length > 0 ? <TrackedClaimsSection entries={own} scenario={scenario} reason="unreadable" /> : null}
      </>
    );
  }

  // Placeholder data: the previous scenario's figures, shown while the new ones are read. Nothing can start from them.
  const reading = claims.isPlaceholderData;
  const holdingFor = (pairId: string): Holding => {
    if (positions.isPending) return 'pending';
    if (positions.isError) return 'unavailable';
    return positions.data.positions.find((position: Position) => canonicalPairId(position.pairId) === canonicalPairId(pairId)) ?? null;
  };
  const counts = countClaims(listed);
  const unknownPair = single.error instanceof AccountQueryError && single.error.code === 'unknown_pair';

  return (
    <section className="sh-rewards-page__list" aria-labelledby={HEADING_ID} aria-busy={reading || undefined} data-reading={reading || undefined}>
      <h2 id={HEADING_ID} ref={headingRef} className="sh-section-title" tabIndex={-1}>
        Your claims
      </h2>
      <AccountBar account={account} asOfBlock={claims.data.asOfBlock} asOf={claims.data.provenance.asOf} />
      {reading ? <LoadingPanel label="Reading your claims… The figures below are the previous read." /> : null}
      <WrongNetworkNotice />
      {selected.kind === 'invalid' ? (
        <p className="sh-account-notice" data-tone="warning">
          <span className="sh-account-notice__mark" aria-hidden="true" />
          <span>The pair in this link is not a valid pair id, so nothing is preselected. Showing all your claims.</span>
        </p>
      ) : null}
      {unknownPair ? (
        <p className="sh-account-notice" data-tone="warning">
          <span className="sh-account-notice__mark" aria-hidden="true" />
          <span>The pair in this link is not in this data source. Showing all your claims.</span>
        </p>
      ) : null}
      <ul className="sh-claims-summary" aria-label="Summary">
        <li>
          <strong className="sh-numeric">{counts.claimable}</strong> {counts.claimable === 1 ? 'pair' : 'pairs'} with amounts
          to claim
        </li>
        <li>
          <strong className="sh-numeric">{counts.pendingHarvest}</strong> with pending harvest (not claimable yet)
        </li>
        <li>
          <strong className="sh-numeric">{counts.claimedBefore}</strong> claimed before
        </li>
        <li className="sh-claims-summary__note">Each figure stays in its own asset; different assets are never added up.</li>
      </ul>
      {shown.length === 0 ? (
        <EmptyClaims />
      ) : (
        <ul className="sh-claims">
          {shown.map((claim) => {
            const pair = pairs.byId.get(canonicalPairId(claim.pairId));
            const key = `${account.toLowerCase()}:${canonicalPairId(claim.pairId)}`;
            return (
              <li key={key}>
                {pair ? (
                  <ClaimCard
                    claim={claim}
                    pair={pair}
                    position={holdingFor(claim.pairId)}
                    selected={selectedId !== null && canonicalPairId(claim.pairId) === selectedId}
                    canStart={!reading}
                    waitHint={reading ? READING_HINT : undefined}
                  />
                ) : (
                  <p className="sh-panel sh-claim sh-claim--missing">
                    {pairs.pending ? 'Reading pair details…' : `Pair details for ${claim.pairId} are unavailable, so its amounts cannot be shown safely.`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function EmptyClaims() {
  return (
    <div className="sh-panel sh-empty-state" data-testid="rewards-empty">
      <CastCharacter id="sorter" size={88} caption={false} />
      <div>
        <p className="sh-empty-state__title">No claims on this account</p>
        <p>
          Nothing credited, claimed or pending on any pair. A contract credits part of a pair’s fees to the addresses that
          hold it when each fee is paid, and amounts credited to you stay claimable after you stop holding.
        </p>
        <p>
          <Link to="/">Browse the feed</Link>
        </p>
      </div>
    </div>
  );
}
