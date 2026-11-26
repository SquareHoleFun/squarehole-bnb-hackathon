import { CastCharacter } from '@squarehole/design';
import { canonicalPairId, type Address } from '@squarehole/domain';
import { useMemo, useRef } from 'react';
import { Link } from 'react-router';
import {
  AccountBar,
  LoadingPanel,
  isZeroRaw,
  UnavailablePanel,
  WrongNetworkNotice,
  useAccountClaims,
  useAccountPositions,
  usePairRecords,
  useRecoverFocus,
  type AccountScenario,
} from '../accounts';
import { useFeedContext } from '../feed/feed-context';
import { PositionCard } from './PositionCard';

const HEADING_ID = 'portfolio-list-title';

/** The connected account's current economic balances (positive balances only; SH-014). */
export function PositionsView({ account, scenario }: { account: Address; scenario: AccountScenario }) {
  const positions = useAccountPositions(account, scenario);
  const claims = useAccountClaims(account, scenario);
  const { links } = useFeedContext();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useRecoverFocus(headingRef, positions.status);
  const list = useMemo(() => positions.data?.positions ?? [], [positions.data]);
  const pairs = usePairRecords(useMemo(() => list.map((position) => position.pairId), [list]));

  if (positions.isPending) return <LoadingPanel label="Reading your balances…" />;
  if (positions.isError) {
    return (
      <UnavailablePanel title="Balances unavailable" onRetry={() => void positions.refetch()}>
        <p>The account data could not be read. This is a failed read, not an empty portfolio.</p>
      </UnavailablePanel>
    );
  }
  const earlierRewards = claims.data?.claims.some((claim) => !isZeroRaw(claim.claimableQRaw)) ?? false;

  return (
    <section className="sh-portfolio__list" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID} ref={headingRef} className="sh-section-title" tabIndex={-1}>
        Your balances
      </h2>
      <AccountBar account={account} asOfBlock={positions.data.asOfBlock} asOf={positions.data.provenance.asOf} />
      <WrongNetworkNotice />
      {list.length === 0 ? (
        <div className="sh-panel sh-empty-state" data-testid="portfolio-empty">
          <CastCharacter id="sorter" size={88} caption={false} />
          <div>
            <p className="sh-empty-state__title">No current balances</p>
            <p>This account holds none of the listed pairs right now.</p>
            {earlierRewards ? (
              <p>
                Amounts credited while it held pairs can still be claimed. <Link to="/rewards">See your claims</Link>
              </p>
            ) : (
              <p>
                <Link to="/">Browse the feed</Link>
              </p>
            )}
          </div>
        </div>
      ) : (
        <ul className="sh-positions">
          {list.map((position) => {
            const pair = pairs.byId.get(canonicalPairId(position.pairId));
            return (
              <li key={`${account.toLowerCase()}:${canonicalPairId(position.pairId)}`}>
                {pair ? (
                  <PositionCard position={position} pair={pair} links={links} />
                ) : (
                  <p className="sh-panel sh-position sh-position--missing">
                    {pairs.pending ? 'Reading pair details…' : `Pair details for ${position.pairId} are unavailable.`}
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
