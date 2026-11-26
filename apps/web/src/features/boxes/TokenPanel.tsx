/**
 * The Token tab. A launch box reuses the FIT pair page's cards as they are (the curve, the launch window, the trades,
 * the contract address with the links out, the fees), fed by the page's one live curve (`useLivePool`, passed down as in
 * FitPairView). The vault card is not used here: its counts are in the header and in "What's in the box?". A Demo box
 * has no curve stream: it shows its Demo figures, its invented address and "No links in Demo".
 */
import { CurvePanel } from '../fit-pair/CurvePanel';
import { ContractAddress } from '../fit-pair/ContractAddress';
import { FeeDisclosure } from '../fit-pair/FeeDisclosure';
import type { FitMarketTarget } from '../fit-pair/fit-target';
import { LaunchWindow } from '../fit-pair/LaunchWindow';
import type { LiveView } from '../fit-pair/live-controller';
import { MarketLinks } from '../fit-pair/MarketLinks';
import { PoolCard } from '../fit-pair/PoolCard';
import { TradeTape } from '../fit-pair/TradeTape';
import { CloneLine } from '../core/v2/CloneLine';
import { PRICE_STEP_LINE } from '../core/v2/v2-words';
import { CopyButton } from '../pair/CopyButton';
import { demoSummary } from './box-figure';
import type { BoxRecord } from './box-model';

export function LaunchTokenPanel({ target, view }: { target: FitMarketTarget; view: LiveView }) {
  const data = view.data;
  return (
    <div className="sh-box-token sh-fit" data-freshness={view.freshness}>
      <h2 className="sh-visually-hidden">Token</h2>
      <div className="sh-fit-grid">
        <div className="sh-fit-grid__main">
          <CurvePanel view={view} target={target} />
          <LaunchWindow data={data} target={target} />
          <TradeTape data={data} target={target} direct={view.source === 'direct'} />
        </div>
        <div className="sh-fit-grid__side">
          <section className="sh-detail-card sh-box-token__ca" aria-label="Contract address">
            <ContractAddress target={target} />
            <MarketLinks data={data} target={target} freshness={view.freshness} />
          </section>
          <FeeDisclosure data={data} names={target.names} deployment={target.kind} />
          <PoolCard data={data} target={target} />
        </div>
      </div>
    </div>
  );
}

export function DemoTokenPanel({ record }: { record: BoxRecord }) {
  const summary = demoSummary(record);
  return (
    <div className="sh-box-token">
      <h2 className="sh-visually-hidden">Token</h2>
      <section className="sh-detail-card" aria-labelledby="box-token-curve">
        <div className="sh-detail-card__head">
          <h3 id="box-token-curve" className="sh-detail-card__title">
            Bonding curve
          </h3>
        </div>
        <p className="sh-box-token__figure">{summary.figure.text}</p>
        <p className="sh-muted">{`Paired with ${record.pairAsset}.`}</p>
      </section>
      <section className="sh-detail-card" aria-labelledby="box-token-ca">
        <div className="sh-fit-label-row">
          <h3 id="box-token-ca" className="sh-detail-card__title">
            Contract address
          </h3>
        </div>
        <div className="sh-fit-ca__row">
          <code className="sh-fit-ca__address">{record.token}</code>
          <CopyButton value={record.token} label={`Copy the ${record.ticker} contract address`} />
        </div>
        {/* A v2 box's token is a clone of the release's T implementation (F103): said here, with that implementation. */}
        {record.v2 ? <CloneLine facts={record.v2} /> : <p className="sh-muted">No links on a local chain</p>}
      </section>
      <section className="sh-detail-card" aria-labelledby="box-token-fees">
        <h3 id="box-token-fees" className="sh-detail-card__title">
          Fees
        </h3>
        <p className="sh-fit-fees__line">
          <strong>1% pool fee</strong>
        </p>
        {record.v2 ? <p className="sh-muted">{PRICE_STEP_LINE}</p> : null}
      </section>
    </div>
  );
}
