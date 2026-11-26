import { ART, PairAvatar } from '@squarehole/design';
import type { ExternalLinkProvider, PairRecord } from '@squarehole/domain';
import { useId, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { ShapeSorterAccent } from '../scene';
import { ArrowRightIcon, ChevronIcon, PinIcon } from './feed-icons';
import type { PinKind } from './feed-state';
import type { ChainMarketView } from './chain-markets';
import { toPairView, type PairView } from './format';
import { Age, ChainPriceLine, MarketFigure, Metric, PairingLine, RewardLine, RouteStatus, TypeBadge } from './pair-parts';
import { readPinCollapsed, writePinCollapsed } from './pin-preference';
import { useFitsWidth } from './useFitsWidth';

/** Below this pin width (phones, icon-rail tablets) the space belongs to the pin's text, so the accent is not mounted. */
const ACCENT_MIN_PIN_WIDTH = 721;
const PLATFORM_NAME = 'Square Hole';
const TAGLINE = 'Different shapes. Same hole.';
const platformTile = ART.get('platform-tile');

interface PlatformPinProps {
  kind: PinKind;
  platform: PairRecord | null;
  /** `FeedSnapshot.platformMatchesQuery`. */
  matchesQuery: boolean;
  /** Snapshot time for the age. */
  asOf: string | null;
  links: ExternalLinkProvider;
  /** Chain data sources: quote-denominated figures by canonical pair id. */
  markets?: ReadonlyMap<string, ChainMarketView>;
}

/** Metric label: the full name, plus a short form that phones show after the value ("$50K cap"). */
function MetricLabel({ full, short }: { full: string; short: string }) {
  return (
    <dt>
      <span className="sh-pin__dt-full">{full}</span>
      <span className="sh-pin__dt-short" aria-hidden="true">
        {short}
      </span>
    </dt>
  );
}

function Stats({ view }: { view: PairView }) {
  return (
    <div className="sh-pin__stats">
      <dl className="sh-pin__metrics">
        <div>
          <MetricLabel full="Market cap" short="cap" />
          <dd>
            <MarketFigure usd={view.marketCap} q={view.chain?.marketCap} />
          </dd>
        </div>
        <div>
          <MetricLabel full="24h turnover" short="24h" />
          <dd>
            <MarketFigure usd={view.turnover24h} q={view.chain?.turnover} />
          </dd>
        </div>
        <div className="sh-pin__holders">
          <MetricLabel full="Holders" short="holders" />
          <dd>
            <Metric value={view.holders} />
          </dd>
        </div>
        <div>
          <MetricLabel full="Age" short="old" />
          <dd>
            <Age view={view} />
          </dd>
        </div>
      </dl>
      {/* On phones the View link stretches over the whole pin (like the organic cards). */}
      <div className="sh-action">
        <Link to={view.href} className="sh-view-link sh-pin__link" aria-label={`View ${view.name} details`}>
          View
          <ArrowRightIcon />
        </Link>
        <RouteStatus route={view.route} />
      </div>
    </div>
  );
}

function Avatar({ view }: { view: PairView | null }) {
  if (view) return <PairAvatar pairId={view.pairId} size={88} decorative className="sh-pin__avatar" />;
  return platformTile ? (
    <span className="sh-avatar sh-pin__avatar" style={{ '--sh-avatar-size': '88px' } as CSSProperties}>
      <img className="sh-avatar__img" src={platformTile.src} width={88} height={88} alt="" decoding="async" />
    </span>
  ) : null;
}

/**
 * Compact platform pin (SH-005, FEED-01, UI-05). Outside the results list and never counted or ranked: its label is
 * "Platform", never a rank or crown. A non-matching pin stays visible and says so. An unlaunched root
 * (`platform === null`) shows "Coming soon" with no market figures and no trading call to action.
 */
export function PlatformPin({ kind, platform, matchesQuery, asOf, links, markets }: PlatformPinProps) {
  const [collapsed, setCollapsed] = useState(readPinCollapsed);
  const [pinRef, roomForAccent] = useFitsWidth(ACCENT_MIN_PIN_WIDTH, false);
  const bodyId = useId();
  const view = kind === 'launched' && platform && asOf ? toPairView(platform, { asOf, links, markets }) : null;
  const name = view?.name ?? PLATFORM_NAME;

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    writePinCollapsed(next);
  }

  return (
    <section
      ref={pinRef}
      className="sh-pin sh-panel"
      aria-label="Platform pin"
      aria-busy={kind === 'loading'}
      data-collapsed={collapsed}
      data-kind={kind}
    >
      <div className="sh-pin__content">
        {collapsed ? null : <Avatar view={view} />}
        <div className="sh-pin__title">
          <p className="sh-pin__eyebrow">
            <span className="sh-pin__label">
              <PinIcon />
              Platform
            </span>
            <span className="sh-pin__placement">Pinned separately · not part of the results</span>
            {view && !matchesQuery ? <span className="sh-pin__nomatch">Not a search match</span> : null}
          </p>
          <div className="sh-pin__nameline">
            <h2 className="sh-pin__name">{name}</h2>
            {view ? (
              <span className="sh-pin__ticker" data-unset={view.symbolUnset ? 'true' : undefined}>
                {view.symbol}
              </span>
            ) : null}
            {view ? <TypeBadge view={view} /> : null}
            {kind === 'unlaunched' ? <span className="sh-pin__soon">Coming soon</span> : null}
          </div>
        </div>
        <button
          type="button"
          className="sh-pin__toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? 'Show platform pin' : 'Hide platform pin'}
          onClick={toggle}
        >
          <ChevronIcon up={!collapsed} />
          <span aria-hidden="true">{collapsed ? 'Show' : 'Hide'}</span>
        </button>
        <div id={bodyId} className="sh-pin__detail" hidden={collapsed}>
          {collapsed ? null : <PinDetail kind={kind} view={view} />}
        </div>
        {!collapsed && view ? <Stats view={view} /> : null}
      </div>
      {/* Decorative only; not mounted in a narrow pin (phones, tablets), where the space belongs to the text and rows. */}
      {collapsed || !roomForAccent ? null : (
        <div className="sh-pin__accent">
          <ShapeSorterAccent variant="pin" />
        </div>
      )}
    </section>
  );
}

function PinDetail({ kind, view }: { kind: PinKind; view: PairView | null }) {
  if (view) {
    return (
      <>
        <p className="sh-pin__tagline">{TAGLINE}</p>
        <p className="sh-pin__chips">
          <PairingLine view={view} />
          <RewardLine view={view} />
          <ChainPriceLine view={view} />
        </p>
      </>
    );
  }
  if (kind === 'unlaunched') {
    return (
      <>
        <p className="sh-pin__tagline">{TAGLINE}</p>
        <p className="sh-pin__note">The platform token has not launched. There is no market yet, so no figures are shown.</p>
      </>
    );
  }
  if (kind === 'unavailable') {
    return <p className="sh-pin__note">Platform data is unavailable right now.</p>;
  }
  return (
    <div className="sh-pin__loading" aria-hidden="true">
      <span className="sh-skeleton sh-skeleton--text" />
      <span className="sh-skeleton sh-skeleton--wide" />
    </div>
  );
}
