import { AssetMonogram } from '@squarehole/design';
import type { RouteState } from '@squarehole/domain';
import { FeeShareIcon, RouteReadyIcon, UnverifiedIcon } from './feed-icons';
import type { PairView } from './format';
import { SHOWCASE_NOTE } from './showcase';

/**
 * A metric value, or a visible "—" that assistive technology reads as "Not available" (FEED-06: unavailable is never
 * shown as $0). The dash is decorative text, not an image, so it is hidden from the accessibility tree and the words
 * are visually hidden rather than attached to a `role="img"`.
 */
export function Metric({ value }: { value: string | null }) {
  if (value === null) {
    return (
      <span className="sh-na" data-metric="unavailable">
        <span aria-hidden="true">—</span>
        <span className="sh-visually-hidden">Not available</span>
      </span>
    );
  }
  return <span className="sh-numeric">{value}</span>;
}

/**
 * A market figure: the USD value when a disclosed USD source provides one, otherwise the chain's quote-denominated
 * value labelled with its quote asset ("0.264784 WETH", SH-C), otherwise "Not available". Never $0 for missing data.
 */
export function MarketFigure({ usd, q }: { usd: string | null; q: string | null | undefined }) {
  if (usd !== null || q === null || q === undefined) return <Metric value={usd} />;
  // "0.264784 WETH": the unit goes on its own line, so a long quote symbol never runs into the next column.
  const cut = q.lastIndexOf(' ');
  const amount = cut > 0 ? q.slice(0, cut) : q;
  const unit = cut > 0 ? q.slice(cut + 1) : '';
  return (
    <span className="sh-q-figure" data-metric="quote">
      <span className="sh-numeric">{amount}</span> <span className="sh-q-figure__unit">{unit}</span>
      <span className="sh-visually-hidden"> (in the quote asset; no USD source on this test chain)</span>
    </span>
  );
}

/** Chain data sources: the pool mid price in Q per T (not an execution quote). */
export function ChainPriceLine({ view }: { view: PairView }) {
  if (view.chain === null || view.chain.price === null) return null;
  return (
    <span className="sh-chain-price" data-metric="mid-price">
      Price <span className="sh-numeric">{view.chain.price}</span>
    </span>
  );
}

export function Age({ view }: { view: PairView }) {
  if (view.age === null) return <Metric value={null} />;
  return (
    <time className="sh-numeric" dateTime={view.launchedAt}>
      {view.age}
    </time>
  );
}

const ROUTE_TEXT: Readonly<Record<RouteState, string>> = {
  unverified: 'Route unverified',
  unavailable: 'Route unavailable',
  available: 'Route verified',
};

/** Non-interactive route readiness (EXT-08): demo routes are never executable. */
export function RouteStatus({ route }: { route: RouteState }) {
  return (
    <span className="sh-route" data-route={route}>
      {route === 'available' ? <RouteReadyIcon /> : <UnverifiedIcon />}
      {ROUTE_TEXT[route]}
    </span>
  );
}

export function TypeBadge({ view }: { view: PairView }) {
  return (
    <span className="sh-type-badge" data-type={view.type}>
      {view.typeLabel}
    </span>
  );
}

export function ShowcaseNote() {
  return <span className="sh-showcase">{SHOWCASE_NOTE}</span>;
}

/** Pairing asset, then who earns what (C10: the payout asset changes, the eligible owners do not). */
export function PairingLine({ view }: { view: PairView }) {
  return (
    <span className="sh-pairing">
      <AssetMonogram symbol={view.quoteSymbol} decorative className="sh-pairing__mono" />
      <span className="sh-pairing__symbol">
        <span className="sh-visually-hidden">Paired with </span>
        {view.quoteSymbol}
      </span>
    </span>
  );
}

/** "Fee share in <asset>" (the holders' fee share, F23); the symbol never breaks at its hyphen ("USDC-/DEMO"). */
export function RewardLine({ view }: { view: PairView }) {
  const lead = view.rewardText.slice(0, view.rewardText.length - view.rewardSymbol.length);
  return (
    <span className="sh-reward" data-reward-side={view.rewardSide}>
      <FeeShareIcon />
      <span className="sh-reward__text">
        {lead}
        <span className="sh-nowrap">{view.rewardSymbol}</span>
      </span>
    </span>
  );
}

/** Why a row matched an address search (FEED-04). Nothing is shown for a name or ticker match. */
export function MatchTag({ view }: { view: PairView }) {
  if (view.matchLabel === null) return null;
  return (
    <span className="sh-match-tag" data-match={view.matchKind ?? undefined}>
      <span className="sh-visually-hidden">Matched by </span>
      {view.matchLabel}
    </span>
  );
}
