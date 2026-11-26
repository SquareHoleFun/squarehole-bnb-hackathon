import { DRAFT_FEE_TERMS, type ExternalLinkProvider, type PairDetail, type PairRecord } from '@squarehole/domain';
import type { PairView } from '../feed/format';
import { Gallery } from './Gallery';
import { ActivityCard, AboutCard, RewardsCard, SupplyCard } from './PairCards';
import { MetricsStrip } from './PairHeader';
import { PriceChart } from './PriceChart';
import { TradeExternally } from './TradeExternally';

interface PairDetailBodyProps {
  pair: PairRecord;
  /** Null when the source has the record but no detail: identity, metrics and routes still render. */
  detail: PairDetail | null;
  view: PairView;
  links: ExternalLinkProvider;
}

/**
 * Read-only pair detail below the header (SH-012). DOM order is the reading and tab order at every width: price,
 * external routes and rewards, then supply, gallery, activity and context. Wide containers place the routes column
 * beside the others; narrow ones stack them in the same order (no CSS reordering).
 */
export function PairDetailBody({ pair, detail, view, links }: PairDetailBodyProps) {
  const asOf = pair.provenance.asOf;
  return (
    <>
      <MetricsStrip pair={pair} detail={detail} view={view} />
      {detail ? (
        <div className="sh-pair-grid">
          <div className="sh-pair-grid__lead">
            <PriceChart pair={pair} history={detail.priceHistory} asOf={asOf} />
          </div>
          <div className="sh-pair-grid__side">
            <TradeExternally pair={pair} links={links} feeTerms={detail.feeTerms} nftNotice={pair.type === 'nft_collection'} />
            <RewardsCard pair={pair} detail={detail} />
          </div>
          <div className="sh-pair-grid__main">
            <SupplyCard pair={pair} detail={detail} />
            {detail.nft ? <Gallery nft={detail.nft} collection={pair.name} /> : null}
            <ActivityCard detail={detail} />
            <AboutCard pair={pair} detail={detail} />
          </div>
        </div>
      ) : (
        <div className="sh-pair-grid">
          <div className="sh-pair-grid__lead">
            <div className="sh-alert sh-panel" role="note">
              <div className="sh-alert__body">
                <h2 className="sh-alert__title">Detail unavailable</h2>
                <p>This data source has no supply, history, fee-share or activity detail for this pair. Nothing is shown as zero in its place.</p>
              </div>
            </div>
          </div>
          <div className="sh-pair-grid__side">
            <TradeExternally pair={pair} links={links} feeTerms={DRAFT_FEE_TERMS} nftNotice={pair.type === 'nft_collection'} />
          </div>
        </div>
      )}
    </>
  );
}
