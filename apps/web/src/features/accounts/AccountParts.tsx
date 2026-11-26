import { CastCharacter, type CastId } from '@squarehole/design';
import type { Address } from '@squarehole/domain';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Loader } from '../brand';
import { SourceChip, useDataSource } from '../data-source';
import { formatAsOf } from '../feed/format';
import { BrowserWalletDialog, DemoWalletDialog, chainLabel, liveChainLabel, personaCopy, personaForAccount, shortAddress, useWallet } from '../wallet';
import { formatInteger } from './amounts';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

interface ConnectPromptProps {
  readonly headingId: string;
  readonly title: string;
  readonly cast: CastId;
  readonly children: ReactNode;
}

/**
 * Honest disconnected state (02-DESIGN required state; UI-09): says what the page needs and offers an explicit button.
 * Nothing connects, probes or prompts until that button is clicked, and it only opens a wallet window: the demo wallet
 * with the demo fixtures, the browser-wallet window on a chain data source (SH-C).
 */
export function ConnectPrompt({ headingId, title, cast, children }: ConnectPromptProps) {
  const wallet = useWallet();
  const source = useDataSource();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const connecting = wallet.status === 'connecting';
  return (
    <section className="sh-panel sh-connect-prompt" aria-labelledby={headingId} data-account-state="disconnected">
      <CastCharacter id={cast} size={88} caption={false} className="sh-connect-prompt__cast" />
      <div className="sh-connect-prompt__body">
        <h2 id={headingId} className="sh-section-title" tabIndex={-1}>
          {title}
        </h2>
        {children}
        <p className="sh-connect-prompt__note">
          {(DEMO_BUILD && source.isDemo)
            ? 'Square Hole never connects a wallet by itself. The button opens the sample wallet: you pick an account and nothing is signed.'
            : `Square Hole never connects a wallet by itself. The button lists the browser wallets you have; reading needs no signature, and nothing is sent unless you confirm a claim or a launch in your wallet (${source.dataLabel}, test tokens only).`}
        </p>
        <p>
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
        </p>
      </div>
      {DEMO_BUILD && source.isDemo ? (
        <DemoWalletDialog open={open} onClose={() => setOpen(false)} returnFocus={buttonRef} />
      ) : (
        <BrowserWalletDialog open={open} onClose={() => setOpen(false)} returnFocus={buttonRef} />
      )}
    </section>
  );
}

interface AccountBarProps {
  readonly account: Address;
  readonly asOfBlock: string | null;
  readonly asOf: string | null;
  /**
   * The bar describes an account whose sent claims are still being tracked although it is not the connected one: the
   * wallet disconnected, or the person switched to another demo account.
   */
  readonly tracking?: 'disconnected' | 'switched';
}

const TRACKING_NOTE = Object.freeze({ disconnected: ' (disconnected)', switched: ' (not the connected account)' });

/** Who and when: demo persona, short account, read block and time, and the data label (D07, UI-04). */
export function AccountBar({ account, asOfBlock, asOf, tracking }: AccountBarProps) {
  const source = useDataSource();
  const persona = DEMO_BUILD && source.isDemo ? personaForAccount(account) : null;
  const read = asOf === null ? null : formatAsOf(asOf);
  return (
    <p className="sh-account-bar" data-testid="account-bar">
      <SourceChip />
      <span className="sh-account-bar__who">
        {persona ? <strong>{personaCopy(persona).title}</strong> : <strong>Account</strong>}{' '}
        <span className="sh-numeric" title={account}>
          {shortAddress(account)}
        </span>
        {tracking ? TRACKING_NOTE[tracking] : null}
      </span>
      {asOfBlock !== null ? (
        <span className="sh-account-bar__when">
          Read at block <span className="sh-numeric">{formatInteger(asOfBlock)}</span>
          {read ? ` · ${read}` : null}
        </span>
      ) : null}
    </p>
  );
}

/** A wallet on another network can still read; the claim request offers the switch (06-ARCHITECTURE). */
export function WrongNetworkNotice() {
  const wallet = useWallet();
  const source = useDataSource();
  const target = wallet.targetChainId;
  if (wallet.status !== 'connected' || wallet.chainId === null || wallet.chainId === target) return null;
  const label = DEMO_BUILD && source.isDemo ? chainLabel : liveChainLabel;
  return (
    <p className="sh-account-notice" data-tone="warning" data-testid="wrong-network-notice">
      <span className="sh-account-notice__mark" aria-hidden="true" />
      <span>
        <strong>Wrong network.</strong> Your wallet is on {label(wallet.chainId)}; these claims are on {label(target)}. You can
        still read them. A claim asks to switch networks first and is never sent on another network.
      </span>
    </p>
  );
}

/**
 * Focus lands on `ref` when this view appears, or `when` changes, while focus was lost (e.g. the connect button that
 * opened the demo wallet was replaced by the account view). It never steals focus from an element that still has it.
 */
export function useRecoverFocus(ref: RefObject<HTMLElement | null>, when: unknown = null): void {
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) ref.current?.focus();
  }, [ref, when]);
}

/** A read in progress: the logo loader and one line saying what is being read (a status, announced politely). */
export function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="sh-panel sh-account-loading">
      <Loader mode="waiting" size="card" label={label} />
    </div>
  );
}

interface UnavailablePanelProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onRetry: () => void;
}

/** A failed read is a failure, not a zero (06-ARCHITECTURE): explain, keep rights intact, offer a retry. */
export function UnavailablePanel({ title, children, onRetry }: UnavailablePanelProps) {
  return (
    <div className="sh-panel sh-account-unavailable" role="alert">
      <p className="sh-account-unavailable__title">{title}</p>
      {children}
      <p>
        <button type="button" className="sh-button" onClick={onRetry}>
          Try again
        </button>
      </p>
    </div>
  );
}
