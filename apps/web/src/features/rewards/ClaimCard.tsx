import { PairAvatar } from '@squarehole/design';
import { pairRoute, type ClaimView, type PairRecord, type TxState } from '@squarehole/domain';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { formatAmount, useRefreshAccountData } from '../accounts';
import { useChainWriteTarget, useDataSource } from '../data-source';
import { displaySymbol } from '../feed/format';
import { TxStatusPanel, chainClaimAsQFallbackSpec, chainClaimAsTSpec, chainClaimSpec, type ChainTxSpec, type ChainWriteTarget } from '../tx';
import { useClaimFlow, useQuoteExpiry } from './claim-flow-context';
import { ClaimFigures, ClaimHistory, ConversionEstimate, EmergencySettlement, ExactFigures, HoldingLine, NeedsQuote, NeedsReread, type Holding } from './ClaimParts';
import {
  claimActionOf,
  claimButtonLabel,
  claimDeadline,
  claimRequestLabel,
  isStartable,
  settledClaimOf,
  withoutQuote,
  type ClaimAction,
  type StartedClaim,
} from './claim-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface ClaimCardProps {
  readonly claim: ClaimView;
  readonly pair: PairRecord;
  /** The account's current position in this pair (see `Holding`). */
  readonly position: Holding;
  /** Preselected through `?pair=`. */
  readonly selected: boolean;
  /**
   * False when nothing new may start here: the claim belongs to an account that is not the connected one (a sent claim
   * still being tracked), or the page is re-reading its data. A running request is shown either way.
   */
  readonly canStart: boolean;
  /** Why nothing can start while `canStart` is false (default: the wallet is not connected to this account). */
  readonly waitHint?: string;
  /**
   * `list` (default) is a card in the `/rewards` list, with the pair's avatar, name, fee-share rule and detail link. `pair`
   * is the same claim embedded in that pair's detail page: the surrounding section names it (`labelledBy`), so the
   * card leaves out the pair identity and the link back to the page it is on.
   */
  readonly variant?: 'list' | 'pair';
  /** `pair` variant: id of the heading that names this card. */
  readonly labelledBy?: string;
}

/**
 * After these, the earlier transaction may still be included (or was replaced by the wallet): the claims are re-read
 * before a second request can start, so a claim that was settled after all is never offered again.
 */
const AWAITING_RESULT: ReadonlySet<TxState['status']> = new Set(['timed_out', 'unknown', 'replaced']);

/**
 * One pair's claims for one account: what is claimable, claimed, credited and pending (separately, per asset), the
 * read-only conversion estimate or the labelled emergency settlement, and the claim request with its honest status.
 * A claim always settles the whole claimable entitlement; there is no amount field. The request itself lives in the
 * app-level claim store, so a signed claim survives this card (persona switch, scenario change, navigation).
 */
export function ClaimCard({ claim, pair, position, selected, canStart, waitHint, variant = 'list', labelledBy }: ClaimCardProps) {
  const titleId = useId();
  const hintId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const claimRef = useRef<HTMLButtonElement>(null);
  const lastFocused = useRef<Element | null>(null);
  const refresh = useRefreshAccountData();
  const expired = useQuoteExpiry(claim);
  const read = claimActionOf(claim);
  const offered = expired ? withoutQuote(read) : read;
  const source = useDataSource();
  const target = useChainWriteTarget();
  const chain = useMemo(() => claimChainSpec(target, offered.kind, pair), [target, offered.kind, pair]);
  const { entry, flow, start } = useClaimFlow(claim.owner, claim.pairId, {
    kind: 'claim',
    label: claimRequestLabel(offered, pair),
    requiredChainId: source.chainId,
    deadline: claimDeadline(offered),
    ...(chain ? { chain } : {}),
  });
  const { state } = flow;
  // A request that saw the quote deadline pass (the clock, or the "quote deadline passes" demo scenario) makes the
  // quote stale for this card too: it shows "No current quote" until the estimate is refreshed, never the old one.
  const quoteLapsed = state.status === 'invalidated' && state.cause === 'deadline_passed';
  const action = quoteLapsed ? withoutQuote(offered) : offered;
  const [rereadFor, setRereadFor] = useState<TxState | null>(null);
  const needsReread = AWAITING_RESULT.has(state.status) && rereadFor !== state;
  const [claimFocused, setClaimFocused] = useState(false);

  // Preselected from a link: bring the card into view once (no focus move: the page heading keeps focus).
  useEffect(() => {
    if (selected) cardRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  // A control that was used can disappear as the claim moves on ("Refresh the estimate", "Re-read my claims"). Keep
  // keyboard and screen reader users in the card instead of dropping focus to the page body. (The status panel keeps
  // focus for its own controls; the claim button never loses it, see below.)
  useLayoutEffect(() => {
    const last = lastFocused.current;
    const active = document.activeElement;
    if (last === null || last.isConnected || (active !== null && active !== document.body)) return;
    const button = claimRef.current;
    const target = button && !button.disabled ? button : cardRef.current?.querySelector<HTMLElement>('[data-tx-status-heading]');
    target?.focus();
  });

  const allowed = canStart && isStartable(action) && !needsReread;
  const inactive = !allowed || flow.isBusy;

  function startClaim() {
    if (inactive) return;
    const started: StartedClaim = { claim, action, pair };
    start(started);
  }

  async function refreshQuote() {
    await refresh();
    // The lapsed request had not been signed; clearing it lets the re-read quote show (or "No current quote" stay).
    if (quoteLapsed) flow.reset();
  }

  async function rereadResult() {
    const seen = state;
    await refresh();
    setRereadFor(seen);
  }

  const payoutSymbol = displaySymbol(pair.token.symbol);
  const embedded = variant === 'pair';
  const quoteCause = read.kind === 'needs_quote' || expired ? 'expired' : 'lapsed';

  return (
    <article
      ref={cardRef}
      className={embedded ? 'sh-claim sh-claim--embedded' : 'sh-claim sh-panel'}
      aria-labelledby={embedded ? labelledBy : titleId}
      data-pair-id={claim.pairId}
      data-selected={selected || undefined}
      data-claim-action={action.kind}
      data-claim-variant={variant}
      onFocus={(event) => {
        lastFocused.current = event.target;
      }}
    >
      {embedded ? null : (
        <div className="sh-claim__header">
          <PairAvatar pairId={pair.pairId} size={48} decorative />
          <div className="sh-claim__identity">
            <h3 id={titleId} className="sh-claim__title">
              {pair.name} <span className="sh-claim__symbol">{displaySymbol(pair.symbol)}</span>
            </h3>
            <p className="sh-claim__rule">
              <span className="sh-type-badge" data-type={pair.type}>
                {pair.type === 'nft_collection' ? 'NFT collection' : 'Token'}
              </span>
              <FeeShareRule pair={pair} />
              {selected ? <span className="sh-chip">Selected from your link</span> : null}
            </p>
          </div>
          <Link to={pairRoute(pair)} className="sh-view-link sh-claim__detail-link" aria-label={`Pair detail: ${pair.name}`}>
            Pair detail
          </Link>
        </div>
      )}

      <HoldingLine pair={pair} position={position} />
      <ClaimFigures claim={claim} pair={pair} />

      {action.kind === 'claim_t' ? <ConversionEstimate estimate={action.estimate} pair={pair} /> : null}
      {action.kind === 'needs_quote' ? <NeedsQuote cause={quoteCause} onRefresh={() => void refreshQuote()} /> : null}
      {action.kind === 'fallback' ? <EmergencySettlement fallback={action.fallback} pair={pair} /> : null}
      {action.kind === 'blocked' ? (
        <p className="sh-account-notice" data-tone="warning">
          <span className="sh-account-notice__mark" aria-hidden="true" />
          <span>
            The conversion to {payoutSymbol} is unavailable and no emergency settlement is published right now. Your claim
            stays intact; try again later.
          </span>
        </p>
      ) : null}
      {needsReread && canStart && isStartable(action) ? <NeedsReread onReread={() => void rereadResult()} /> : null}

      <div className="sh-claim__actions">
        {/*
          The claim button is the one way to start (and to try again after a revert, rejection or cancellation), so the
          status panel offers no second "Start again". While a request is open it stays focusable (aria-disabled) so
          focus never falls to the page body when it is pressed (WCAG 2.4.3); clicks are ignored in startClaim.
        */}
        <button
          ref={claimRef}
          type="button"
          className="sh-button sh-button--primary sh-claim__button"
          disabled={inactive && !claimFocused}
          aria-disabled={inactive || undefined}
          aria-describedby={hintId}
          onClick={startClaim}
          onFocus={() => setClaimFocused(true)}
          onBlur={() => setClaimFocused(false)}
          data-testid="claim-button"
        >
          {flow.isBusy ? 'Claim in progress…' : claimButtonLabel(action, pair)}
        </button>
        <p id={hintId} className="sh-claim__hint">
          {actionHint(action, pair, { canStart, waitHint, needsReread })}
        </p>
      </div>

      {state.status !== 'idle' ? (
        <TxStatusPanel
          state={state}
          headingLevel={4}
          scenarioPicker={false}
          onRetry={null}
          successContent={entry.started ? DEMO_BUILD && source.isDemo ? <SettledNote started={entry.started} /> : <ChainSettledNote started={entry.started} label={source.dataLabel} /> : null}
        />
      ) : null}

      <ClaimHistory claim={claim} pair={pair} />
      <ExactFigures claim={claim} pair={pair} estimate={action.kind === 'claim_t' ? action.estimate : null} />
    </article>
  );
}

/**
 * The chain request for a claim action (SH-C): R = Q `claim`, R = T `claimAsT` with an eth_call-quoted minimum, or the
 * labelled emergency payout in Q, which exists only as its own action (the card's "Claim … directly" button when the
 * converter reports the pool sold out) and is never chosen for the person. Null for the demo fixtures.
 */
function claimChainSpec(target: ChainWriteTarget | null, kind: ClaimAction['kind'], pair: PairRecord): ChainTxSpec | null {
  if (target === null) return null;
  const token = pair.token.address;
  if (kind === 'claim_t' || kind === 'needs_quote' || kind === 'too_small') return chainClaimAsTSpec(target, token);
  if (kind === 'fallback') return chainClaimAsQFallbackSpec(target, token);
  return chainClaimSpec(target, token);
}

/** Chain claims: the chain settled it; the figures below re-read from the ledger show the result. */
function ChainSettledNote({ started, label }: { started: StartedClaim; label: string }) {
  const settled = settledClaimOf(started.claim, started.action);
  if (settled === null) return null;
  return (
    <p>
      Finalized on {label}: the fee-credit ledger consumed {formatAmount(settled.qConsumedRaw, started.pair.quote)} of credited fees
      {settled.paysPairToken
        ? `, paid as at least the signed minimum of ${started.pair.token.symbol === '' ? 'T' : displaySymbol(started.pair.token.symbol)}`
        : `, paid as ${formatAmount(settled.payoutRaw, settled.payoutAsset)}`}
      . The figures above are re-read from the chain.
    </p>
  );
}

function FeeShareRule({ pair }: { pair: PairRecord }) {
  const quote = displaySymbol(pair.quote.symbol);
  const token = displaySymbol(pair.token.symbol);
  return (
    <span className="sh-claim__reward" data-reward-side={pair.rewardSide}>
      {pair.rewardSide === 'Q' ? `Holder fee share paid in ${quote}, the paired asset` : `Holder fee share credited in ${quote}, paid in ${token} when claimed`}
    </span>
  );
}

interface HintContext {
  readonly canStart: boolean;
  readonly waitHint: string | undefined;
  readonly needsReread: boolean;
}

function actionHint(action: ClaimAction, pair: PairRecord, { canStart, waitHint, needsReread }: HintContext): string {
  if (!canStart && action.kind !== 'nothing') return waitHint ?? 'Connect your wallet again to claim.';
  if (needsReread && isStartable(action)) return 'Re-read your claims first: the earlier request may still be included.';
  const token = displaySymbol(pair.token.symbol);
  const quote = displaySymbol(pair.quote.symbol);
  switch (action.kind) {
    case 'nothing':
      return 'Everything credited on this pair so far has been claimed. Pending harvest is not claimable until it is recognised.';
    case 'claim_q':
      return 'Claims your whole claimable balance. There is nothing to choose or type.';
    case 'claim_t':
      return `Settles your whole claimable ${quote} as ${token}, paying at least the minimum before the deadline, or nothing changes.`;
    case 'needs_quote':
      return 'A claim in this asset needs a current quote for its minimum and deadline.';
    case 'too_small':
      return `Your claimable ${quote} converts to less than the smallest unit of ${token}, so a claim would pay nothing. It stays yours.`;
    case 'fallback':
      return `Emergency settlement: pays your credited ${quote} directly instead of ${token}.`;
    case 'blocked':
      return 'Your claim stays intact until the conversion is available again.';
  }
}

function SettledNote({ started }: { started: StartedClaim }): ReactNode {
  const settled = settledClaimOf(started.claim, started.action);
  if (settled === null) return null;
  return (
    <p>
      Settled {formatAmount(settled.qConsumedRaw, started.pair.quote)} of credited fees
      {settled.paysPairToken
        ? `, paid as ${formatAmount(settled.payoutRaw, settled.payoutAsset)} at the snapshot quote (a claim on a chain pays at least the signed minimum)`
        : `, paid as ${formatAmount(settled.payoutRaw, settled.payoutAsset)}`}
      . Recorded in this browser tab only.
    </p>
  );
}
