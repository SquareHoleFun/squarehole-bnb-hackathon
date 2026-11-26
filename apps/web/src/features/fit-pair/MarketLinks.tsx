import { fitMarketDestinations, renderableHref, type FitDestination } from '@squarehole/links';
import { ExternalIcon } from '../pair/pair-icons';
import { formatBlock } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { InfoButton, InfoPanel, useInfoTip } from './InfoTip';
import type { Freshness } from './live-controller';
import type { LiveData } from './live-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const kindLabel = (kind: FitDestination['kind'], symbol: string): string =>
  kind === 'execution' ? 'Pool on Uniswap, native ETH in' : kind === 'discovery' ? 'Market information' : `${symbol} on a block explorer`;

/**
 * `closed`: the launch window keeps Uniswap shut (known from the chain); `unknown`: the page cannot confirm the window
 * has ended (no data, nothing readable, or data nobody could check); `unchecked`: no recorded route test yet.
 */
export type LinkState = 'available' | 'closed' | 'unknown' | 'unchecked' | 'unavailable';

/** The small state beside a destination that is not a link (a link shows its host instead). */
export const STATE_WORD: Readonly<Record<Exclude<LinkState, 'available'>, string>> = {
  closed: 'not live yet',
  unknown: 'can’t confirm yet',
  unchecked: 'not checked',
  unavailable: 'no link',
};

/** Whether the launch window's state is unknown to the page: then the Uniswap gate stays shut, for a different reason. */
function windowUnknown(data: LiveData | null, freshness: Freshness): boolean {
  return data === null || freshness === 'unverified' || freshness === 'unavailable' || freshness === 'connecting';
}

/**
 * Why the execution link is closed right now, from the launch window (docs/v2/route-proof.md item 4: during the
 * 32-block window only the launch router can buy, so the app shows no buy route then). Null when it may open.
 *
 * An unknown window counts as closed: no data yet, nothing readable, or data nobody could check (unverified). Stale data
 * still decides, because a head already past the window stays past it; a stale head before it keeps the gate closed.
 */
export function executionGate(data: LiveData | null, target: FitMarketTarget, freshness: Freshness): string | null {
  if (windowUnknown(data, freshness) || data === null) {
    return `Closed until the page can confirm the launch window has ended (block ${formatBlock(target.closeBlock - 1n)}). Uniswap routes open at block ${formatBlock(target.closeBlock)}.`;
  }
  const status = data.window.status;
  if (status === 'before_open') return `Closed: no route can buy before block ${formatBlock(target.openBlock)}. Uniswap routes open at block ${formatBlock(target.closeBlock)}, after the launch window.`;
  if (status === 'router_window') return `Closed during the launch window: until block ${formatBlock(target.closeBlock - 1n)} buys go only through the launch router, at the launch tax. Uniswap routes open at block ${formatBlock(target.closeBlock)}.`;
  return null;
}

export interface ResolvedDestination {
  readonly destination: FitDestination;
  readonly state: LinkState;
  readonly vetted: { readonly href: string; readonly host: string } | null;
  /**
   * Why it is not a link (the info panel says it; the item shows only the state word), followed by the destination's
   * own warning when it has one (the Sepolia Uniswap caveat), so a warning is said exactly once: here when the
   * destination is not a link, under the links when it is one.
   */
  readonly why: string | null;
}

/** Requirement ids ("(EXT-05)", "(B-DISC-01)") belong in the docs, not in front of a reader. */
const withoutIds = (text: string) => text.replace(/\s*\([A-Z]+(?:-[A-Z0-9]+)+\)/g, '');

/** A reason, then the destination's warning if it has one. */
const withWarning = (why: string, destination: FitDestination) => (destination.warning ? `${why} ${destination.warning}` : why);

export function resolveDestination(destination: FitDestination, target: FitMarketTarget, data: LiveData | null, freshness: Freshness): ResolvedDestination {
  // Render boundary (EXT-02/03/08): a link only for an available, allowlisted destination of this exact token.
  const symbol = target.names.tokenSymbol;
  const identity = { chainId: target.chainId, token: { chainId: target.chainId, address: target.token, symbol, decimals: 18, issuerStatus: DEMO_BUILD && target.kind === 'demo' ? ('mock' as const) : ('unverified' as const) } };
  const gate = destination.kind === 'execution' ? executionGate(data, target, freshness) : null;
  const vetted = gate === null ? renderableHref(destination, identity) : null;
  if (vetted) return { destination, state: 'available', vetted: { href: vetted.href, host: vetted.host }, why: null };
  if (gate !== null) return { destination, state: windowUnknown(data, freshness) ? 'unknown' : 'closed', vetted: null, why: withWarning(gate, destination) };
  return {
    destination,
    state: destination.state === 'unavailable' ? 'unavailable' : 'unchecked',
    vetted: null,
    why: withWarning(withoutIds(destination.reason ?? 'Not checked.'), destination),
  };
}

function Destination({ row, symbol }: { row: ResolvedDestination; symbol: string }) {
  const { destination, vetted, state } = row;
  return (
    <li className="sh-fit-link" data-kind={destination.kind} data-route={state}>
      {vetted ? (
        <a href={vetted.href} target="_blank" rel="noopener noreferrer" className="sh-fit-link__body">
          <ExternalIcon />
          <span className="sh-fit-link__name">{destination.provider}</span>
          <span className="sh-fit-link__state">{vetted.host}</span>
          <span className="sh-visually-hidden"> ({kindLabel(destination.kind, symbol)}, opens in a new tab)</span>
        </a>
      ) : (
        // Not a link: plain text, no frame and no arrow, so it never looks tappable.
        <span className="sh-fit-link__off">
          {destination.provider}
          <span className="sh-visually-hidden">:</span> <span className="sh-fit-link__state">{STATE_WORD[state === 'available' ? 'unchecked' : state]}</span>
        </span>
      )}
    </li>
  );
}

/** The one line shown when no destination is a link yet. */
function noLinksLine(target: FitMarketTarget, rows: readonly ResolvedDestination[]): string {
  // The sample data: the two words (its (i) says why); no Demo word since F130.
  if (DEMO_BUILD && target.kind === 'demo') return 'No links';
  if (target.chainId === 31_337) return 'No links on a local chain';
  return `${rows.map((row) => row.destination.provider).join(' · ')}: links once checked`;
}

/** The info panel's reasons, one line per distinct reason ("Uniswap, DEX Screener: …"). */
function reasonLines(rows: readonly ResolvedDestination[]): { readonly who: string; readonly why: string }[] {
  const byWhy = new Map<string, string[]>();
  for (const row of rows) {
    const why = row.why ?? `opens ${row.vetted?.host ?? ''} in a new tab.`;
    byWhy.set(why, [...(byWhy.get(why) ?? []), row.destination.provider]);
  }
  return [...byWhy].map(([why, who]) => ({ who: who.join(', '), why }));
}

/**
 * Links out (F37 (2), F38 (1)), under "Open on": Uniswap with native ETH in, DEX Screener by the v4 pool id, Etherscan
 * for the exact token address. Only a live link gets a tile (frame and arrow); a destination that is not a link is
 * plain text with a small state, and when none is a link the three collapse into one muted line. Why is in the info
 * panel. No amount field, no swap, no wallet request (C09, UI-05, EXT-04).
 */
export function MarketLinks({ data, target, freshness }: { data: LiveData | null; target: FitMarketTarget; freshness: Freshness }) {
  const tip = useInfoTip();
  // No route-evidence record is loaded here yet (none exists): turning a link on needs an evidence loader first.
  const destinations = fitMarketDestinations({ chainId: target.chainId, token: target.token, poolId: target.poolId, demo: DEMO_BUILD && target.kind === 'demo' });
  const rows = destinations.map((destination) => resolveDestination(destination, target, data, freshness));
  const symbol = target.names.tokenSymbol;
  const anyLink = rows.some((row) => row.vetted !== null);
  // A live link's warning is shown under the links; a destination that is not a link says it in the info panel (`why`).
  const warnings = rows.filter((row) => row.vetted !== null && row.destination.warning).map((row) => row.destination.warning);
  return (
    <section className="sh-fit-links" aria-labelledby="fit-links-title">
      <div className="sh-fit-label-row">
        <h2 id="fit-links-title" className="sh-fit-label">
          Open on
        </h2>
        <InfoButton tip={tip} label="About the links" />
      </div>
      <InfoPanel tip={tip}>
        {DEMO_BUILD && target.kind === 'demo' ? (
          <p>{`No links on a local chain. On a public chain each site gets a link only after it is tested with this exact ${symbol}.`}</p>
        ) : (
          <ul className="sh-info-panel__list">
            {reasonLines(rows).map((line) => (
              <li key={line.why}>
                <strong>{line.who}</strong>: {line.why}
              </li>
            ))}
          </ul>
        )}
        <p>{`${target.names.kind === 'neutral' ? 'This app' : 'Square Hole'} has no trade form. Links open in a new tab; this page never asks your wallet.`}</p>
      </InfoPanel>
      {anyLink ? (
        <ul className="sh-fit-links__list" aria-label="External destinations">
          {rows.map((row) => (
            <Destination key={row.destination.kind} row={row} symbol={symbol} />
          ))}
        </ul>
      ) : (
        <p className="sh-fit-links__none">{noLinksLine(target, rows)}</p>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="sh-fit-links__warning" data-disclosure="">
          {warning}
        </p>
      ))}
    </section>
  );
}
