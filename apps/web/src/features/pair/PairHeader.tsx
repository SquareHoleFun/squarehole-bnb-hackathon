import { ART, AssetMonogram, SquareHoleGlyph } from '@squarehole/design';
import type { ArtworkRef, PairDetail, PairRecord } from '@squarehole/domain';
import { useState, type ReactNode } from 'react';
import { PageHeading } from '../../pages/page-parts';
import { FeeShareIcon } from '../feed/feed-icons';
import { formatAsOf, type PairView } from '../feed/format';
import { TypeBadge } from '../feed/pair-parts';
import { AmountText } from './AmountText';
import { CopyButton } from './CopyButton';
import { useDataSource } from '../data-source';
import { canonicalStatusText, formatAssetAmount, networkLabel, payoutText } from './pair-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const ART_REASONS: Readonly<Record<Extract<ArtworkRef, { state: 'unavailable' }>['reason'], string>> = {
  not_uploaded: 'Artwork not uploaded',
  failed_validation: 'Artwork failed validation',
  not_loaded: 'Artwork not loaded',
};

/** Pair artwork from a reviewed local asset, or an explicit unavailable state (02-DESIGN "unavailable artwork"). */
function Artwork({ artwork }: { artwork: ArtworkRef }) {
  const art = artwork.state === 'ok' ? (ART.get(artwork.artId) ?? null) : null;
  const [failed, setFailed] = useState(false);
  if (art && !failed) {
    return (
      <span className="sh-pair-art" data-art-state="available">
        <img src={art.src} width={art.width} height={art.height} alt={art.alt} decoding="async" draggable={false} onError={() => setFailed(true)} />
      </span>
    );
  }
  const reason = artwork.state === 'unavailable' ? ART_REASONS[artwork.reason] : 'Artwork unavailable';
  return (
    <span className="sh-pair-art sh-pair-art--unavailable" role="img" aria-label={reason} data-art-state="unavailable">
      <SquareHoleGlyph className="sh-pair-art__glyph" />
      <span className="sh-pair-art__text" aria-hidden="true">
        {reason}
      </span>
    </span>
  );
}

/**
 * Decoration for wide screens (approved detail reference: the hero's right-hand scene). The platform's square-hole box
 * says nothing about the pair, so it is hidden from assistive technology and shown only where the header has room.
 */
function HeaderScene() {
  const box = ART.get('square-hole-box');
  if (!box) return null;
  return (
    <span className="sh-pair-head__scene" aria-hidden="true" data-decoration="">
      <span className="sh-pair-head__scene-note">Still fits.</span>
      <img src={box.src} width={box.width} height={box.height} alt="" decoding="async" draggable={false} />
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sh-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AddressFact({ label, address, copyLabel }: { label: string; address: string; copyLabel: string }) {
  return (
    <div className="sh-fact sh-fact--address">
      <dt>{label}</dt>
      <dd className="sh-identity__address">
        <code>{address}</code>
        <CopyButton value={address} label={copyLabel} />
      </dd>
    </div>
  );
}

interface HeaderProps {
  pair: PairRecord;
  detail: PairDetail | null;
  view: PairView;
}

/**
 * Header (01-PRODUCT "Pair detail"): artwork, identity, pairing, payout, network, canonical status, lifecycle and
 * addresses. With `pair` null it is the loading skeleton; the h1 keeps its place in the tree, so focus moved to it by
 * the shell on navigation survives the data arriving.
 */
export function PairHeader({ pair, detail, view }: { pair: PairRecord | null; detail: PairDetail | null; view: PairView | null }) {
  const artwork: ArtworkRef = detail?.artwork ?? { state: 'unavailable', reason: 'not_loaded' };
  const mirror = detail?.nft?.mirrorAddress ?? pair?.mirrorAddress;
  const ready = pair !== null && view !== null;
  const chainSource = !(useDataSource().isDemo && DEMO_BUILD);
  return (
    <header className="sh-detail-card sh-pair-head" data-ready={ready}>
      {ready ? <Artwork artwork={artwork} /> : <span className="sh-pair-art sh-skeleton" aria-hidden="true" />}
      <div className="sh-pair-head__main">
        <p className="sh-pair-head__chips">
          {ready ? (
            <>
              <TypeBadge view={view} />
              <span className="sh-status-chip" data-status={detail?.canonicalStatus ?? 'unknown'}>
                {detail ? canonicalStatusText(detail.canonicalStatus, chainSource) : 'Status unavailable'}
              </span>
              {detail?.showcase ? <span className="sh-status-chip sh-status-chip--showcase">Showcase concept</span> : null}
            </>
          ) : (
            <span className="sh-skeleton sh-skeleton--text" aria-hidden="true" />
          )}
        </p>
        <div className="sh-pair-head__nameline">
          <PageHeading>{ready ? pair.name : 'Loading pair'}</PageHeading>
          {ready ? (
            <span className="sh-pair-head__ticker" data-unset={view.symbolUnset}>
              {view.symbol}
            </span>
          ) : null}
        </div>
        {ready ? (
          <>
            <p className="sh-pair-head__pairing">
              <span className="sh-pairing">
                <AssetMonogram symbol={view.quoteSymbol} decorative className="sh-pairing__mono" />
                <span className="sh-pairing__symbol">Paired with {view.quoteSymbol}</span>
              </span>
              <span className="sh-reward" data-reward-side={pair.rewardSide}>
                <FeeShareIcon />
                <span className="sh-reward__text">{payoutText(pair)}</span>
              </span>
            </p>
            <dl className="sh-facts-grid">
              <Fact label="Network">{networkLabel(pair.chainId, chainSource)}</Fact>
              <Fact label="Lifecycle">{view.lifecycleLabel}</Fact>
              <AddressFact label="Token (T)" address={pair.token.address} copyLabel="Copy token address" />
              {mirror ? <AddressFact label="NFT mirror" address={mirror} copyLabel="Copy NFT mirror address" /> : null}
            </dl>
          </>
        ) : (
          <p className="sh-skeleton sh-skeleton--wide" aria-hidden="true" />
        )}
      </div>
      {ready ? <HeaderScene /> : null}
    </header>
  );
}

interface MetricProps {
  label: string;
  value: string | null;
  basis: string;
  id: string;
}

function MetricTile({ label, value, basis, id }: MetricProps) {
  return (
    <div className="sh-metric" data-metric={id}>
      <dt>{label}</dt>
      <dd className="sh-metric__value">
        <AmountText value={value} />
      </dd>
      <dd className="sh-metric__basis">{basis}</dd>
    </div>
  );
}

/** Compact metrics, each with its basis or window (01-PRODUCT). Unavailable is said in words, never $0 (FEED-06). */
export function MetricsStrip({ pair, detail, view }: HeaderProps) {
  const chainSource = !(useDataSource().isDemo && DEMO_BUILD);
  return (
    <section className="sh-detail-card sh-metrics" aria-labelledby="metrics-title">
      <h2 id="metrics-title" className="sh-visually-hidden">
        Key figures
      </h2>
      <dl className="sh-metrics__grid">
        <MetricTile id="market-cap" label="Market cap" value={view.marketCap} basis="USD price × circulating supply" />
        <MetricTile id="turnover" label="24h turnover" value={view.turnover24h} basis={chainSource ? 'Rolling 24h, canonical market (USD needs a price source)' : 'Rolling 24h, canonical market'} />
        <MetricTile id="holders" label="Holders" value={view.holders} basis="Economic owners with a positive balance" />
        <MetricTile
          id="burned"
          label="Fee-burned"
          value={formatAssetAmount(detail?.supply.feeBurnedRaw ?? pair.burnedRaw, pair.token)}
          basis="Native fee tokens removed from supply"
        />
        <MetricTile id="remaining" label="Supply remaining" value={null} basis="Unsold launch inventory is not in this snapshot" />
        <MetricTile id="age" label="Since launch" value={view.age} basis={`Launched ${formatAsOf(pair.launchedAt) ?? pair.launchedAt}`} />
      </dl>
    </section>
  );
}
