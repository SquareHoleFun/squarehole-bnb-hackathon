import { canonicalPairId, type Address, type PairRecord, type Position } from '@squarehole/domain';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  AccountBar,
  LoadingPanel,
  UnavailablePanel,
  WrongNetworkNotice,
  useAccountClaim,
  useAccountPositions,
  useAccountScenario,
  useRecoverFocus,
  type AccountScenario,
} from '../accounts';
import { useDataSource } from '../data-source';
import { ArrowRightIcon } from '../feed/feed-icons';
import { displaySymbol } from '../feed/format';
import { claimHref } from '../pair/pair-model';
import { DemoScenarioPicker } from '../tx';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../wallet';
import { useSignedClaims } from './claim-flow-context';
import type { ClaimFlowEntry } from './claim-flows';
import { ClaimCard } from './ClaimCard';
import type { Holding } from './ClaimParts';
import { TrackedClaim } from './TrackedClaims';
import { useClaimAccount } from './useClaimAccount';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * The claim entry of a pair's fee-share card (SH-012 × SH-014/015). Without a wallet it says what claiming needs,
 * offers an explicit "Connect wallet" button and links to Claims; nothing connects, probes or prompts on its own
 * (UI-09). With a demo wallet it shows that account's claim on this pair through the same `ClaimCard` and app-level
 * claim store as `/rewards` (same demo settlement ledger, so a claim finalized here is consumed there too, and a
 * request started on one page is the same request on the other), and keeps the Claims link as the fallback. A claim on
 * this pair that was signed by an account that is no longer connected (a disconnect or a persona switch) stays on the
 * card, still tracked, until its result is in and the person hides it.
 */
export function PairClaim({ pair }: { pair: PairRecord }) {
  const { account: connected, tracked } = useClaimAccount(canonicalPairId(pair.pairId));
  const [scenario] = useAccountScenario();
  const href = claimHref(pair.pairId);
  if (connected === null && tracked.length === 0) {
    return (
      <div className="sh-pair-claim" data-account-state="disconnected">
        <p className="sh-muted">
          To claim what this pair credited to you here, connect a wallet, or claim on the Claims page. This page never asks
          for a wallet by itself.
        </p>
        <p className="sh-pair-claim__actions">
          <ConnectButton />
          <Link to={href} className="sh-button">
            Claim on the Claims page
            <ArrowRightIcon />
          </Link>
        </p>
      </div>
    );
  }
  return (
    <>
      {connected !== null ? <AccountClaim key={connected.toLowerCase()} pair={pair} account={connected} scenario={scenario} href={href} /> : null}
      {tracked.map((entry) => (
        <TrackedPairClaim key={entry.key} entry={entry} pair={pair} scenario={scenario} disconnected={connected === null} href={href} />
      ))}
    </>
  );
}

/** Opens the wallet window of the data source (demo wallet or browser wallets) on click, and only then (UI-09). */
function ConnectButton() {
  const wallet = useWallet();
  const source = useDataSource();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const connecting = wallet.status === 'connecting';
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="sh-button sh-button--primary"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={connecting}
        aria-busy={connecting || undefined}
        onClick={() => setOpen(true)}
      >
        {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
      {DEMO_BUILD && source.isDemo ? (
        <DemoWalletDialog open={open} onClose={() => setOpen(false)} returnFocus={buttonRef} />
      ) : (
        <BrowserWalletDialog open={open} onClose={() => setOpen(false)} returnFocus={buttonRef} />
      )}
    </>
  );
}

interface AccountClaimProps {
  readonly pair: PairRecord;
  readonly account: Address;
  readonly scenario: AccountScenario;
  readonly href: string;
}

function AccountClaim({ pair, account, scenario, href }: AccountClaimProps) {
  const headingId = useId();
  const demoId = useId();
  const source = useDataSource();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pairId = canonicalPairId(pair.pairId);
  const claim = useAccountClaim(pairId, account, scenario, { keepPrevious: true });
  const positions = useAccountPositions(account, scenario, { keepPrevious: true });
  const own = useSignedClaims({ account, pairId });
  // The in-card connect button is replaced by this view; if focus was lost with it, it lands on this heading.
  useRecoverFocus(headingRef);

  const holding: Holding = positions.isPending
    ? 'pending'
    : positions.isError
      ? 'unavailable'
      : (positions.data.positions.find((position: Position) => canonicalPairId(position.pairId) === pairId) ?? null);
  const reading = claim.isPlaceholderData;

  return (
    <section className="sh-pair-claim" aria-labelledby={headingId} data-account-state="connected" aria-busy={reading || undefined}>
      <h3 id={headingId} ref={headingRef} className="sh-detail-card__subtitle" tabIndex={-1}>
        Your claims on {pair.name}
      </h3>
      {claim.data ? <AccountBar account={account} asOfBlock={claim.data.asOfBlock} asOf={claim.data.provenance.asOf} /> : null}
      <WrongNetworkNotice />
      {claim.isPending || claim.isError ? (
        <>
          {claim.isPending ? (
            <LoadingPanel label={`Reading your claims on ${pair.name}…`} />
          ) : (
            <UnavailablePanel title="Your claims on this pair are unavailable" onRetry={() => void claim.refetch()}>
              <p>The account data could not be read. Credited amounts are kept by the fee-credit ledger, and a failed read is never shown as zero.</p>
            </UnavailablePanel>
          )}
          {own.map((entry) => (
            <TrackedClaim key={entry.key} entry={entry} scenario={scenario} variant="pair" labelledBy={headingId} />
          ))}
        </>
      ) : (
        <ClaimCard
          claim={claim.data}
          pair={pair}
          position={holding}
          selected={false}
          canStart={!reading}
          waitHint={reading ? 'Wait for the new data to finish loading.' : undefined}
          variant="pair"
          labelledBy={headingId}
        />
      )}
      {DEMO_BUILD && source.isDemo ? (
        // Fenced off like the /rewards demo controls: a tester control, not part of the product card.
        <div className="sh-demo-controls sh-pair-claim__demo" role="group" aria-labelledby={demoId}>
          <p id={demoId} className="sh-demo-controls__title">
            Scenarios
          </p>
          <DemoScenarioPicker className="sh-demo-controls__field" />
        </div>
      ) : null}
      <p className="sh-pair-claim__actions">
        <Link to={href} className="sh-button">
          Open in Claims
          <ArrowRightIcon />
        </Link>
      </p>
    </section>
  );
}

interface TrackedPairClaimProps {
  readonly entry: ClaimFlowEntry;
  readonly pair: PairRecord;
  readonly scenario: AccountScenario;
  /** No wallet is connected (otherwise the claim was signed by another demo account before a switch). */
  readonly disconnected: boolean;
  readonly href: string;
}

/** A claim on this pair signed by an account that is not connected any more, still tracked to its result. */
function TrackedPairClaim({ entry, pair, scenario, disconnected, href }: TrackedPairClaimProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const claim = useAccountClaim(canonicalPairId(pair.pairId), entry.account, scenario);
  useRecoverFocus(headingRef);
  const symbol = displaySymbol(pair.symbol);
  return (
    <section className="sh-pair-claim" aria-labelledby={headingId} data-account-state="tracking">
      <h3 id={headingId} ref={headingRef} className="sh-detail-card__subtitle" tabIndex={-1}>
        {disconnected ? `Your ${symbol} claim, still being tracked` : `${symbol} claim from another account, still being tracked`}
      </h3>
      <AccountBar
        account={entry.account}
        asOfBlock={claim.data?.asOfBlock ?? null}
        asOf={claim.data?.provenance.asOf ?? null}
        tracking={disconnected ? 'disconnected' : 'switched'}
      />
      <p className="sh-account-notice" data-tone="warning">
        <span className="sh-account-notice__mark" aria-hidden="true" />
        <span>
          {disconnected
            ? 'Wallet disconnected. The claim you already sent is still tracked here; connect again to claim anything else.'
            : 'Sent from this account before you switched accounts. Its result appears here; switch back to that account to claim anything else with it.'}
        </span>
      </p>
      <TrackedClaim
        entry={entry}
        scenario={scenario}
        variant="pair"
        labelledBy={headingId}
        waitHint={disconnected ? undefined : 'Switch back to this account to claim on it.'}
      />
      {disconnected ? (
        <p className="sh-pair-claim__actions">
          <Link to={href} className="sh-button">
            Open in Claims
            <ArrowRightIcon />
          </Link>
        </p>
      ) : null}
    </section>
  );
}
