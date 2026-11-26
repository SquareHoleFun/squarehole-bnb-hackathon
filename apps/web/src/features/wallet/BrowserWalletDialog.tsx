import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { BROWSER_WALLET_ID, type BrowserWalletOption } from './injected-adapter';
import { MyBoxLink } from './MyBoxLink';
import { liveChainLabel as chainLabel, shortAddress } from './wallet-adapter';
import { useWallet } from './wallet-context';
import { ALPHA_ON } from '../alpha-sepolia/alpha-on';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
// F156 (2), SH-ALPHA-SITE: the Sepolia alpha's builds ask the wallet for more kinds (the trade literal, build-target.ts).
const SEPOLIA_TRADE_BUILD = import.meta.env?.SH_SEPOLIA_TRADE === true;
/**
 * SH-258: the alpha's claim exists where the test network has the alpha; SH-275: on BNB Chain testnet only with its own
 * Privy app (alpha-on.ts). Behind the trade literal, so a mainnet build folds the switch and its module away.
 */
const ALPHA_CLAIM = SEPOLIA_TRADE_BUILD && ALPHA_ON;

export interface BrowserWalletDialogProps {
  open: boolean;
  onClose: () => void;
  /** Opens the demo wallet instead (a separate, labelled choice). */
  onChooseDemo?: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}

export const BROWSER_WALLET_TITLE = 'Connect a browser wallet';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The browser-wallet window (Stage C; UI-09). Opening it is the only thing that starts EIP-6963 discovery; connecting
 * is a click on one listed wallet. `window.ethereum` is used only when the person picks "Other browser wallet". The
 * demo wallet stays a separate, labelled choice. Modal like the demo wallet: focus trapped, page behind inert,
 * Escape closes, focus returns to the opener.
 */
export function BrowserWalletDialog({ open, onClose, onChooseDemo, returnFocus }: BrowserWalletDialogProps) {
  if (!open) return null;
  return createPortal(<DialogBody onClose={onClose} onChooseDemo={onChooseDemo} returnFocus={returnFocus} />, document.body);
}

function DialogBody({ onClose, onChooseDemo, returnFocus }: Omit<BrowserWalletDialogProps, 'open'>) {
  const wallet = useWallet();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [wallets, setWallets] = useState<readonly BrowserWalletOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = wallet.status === 'connected' && wallet.kind === 'injected' && wallet.account !== null;
  const wrongNetwork = connected && wallet.chainId !== wallet.targetChainId;
  const { discoverBrowserWallets } = wallet;

  // Discovery runs only while this window is open (the person opened it).
  useEffect(() => discoverBrowserWallets(setWallets), [discoverBrowserWallets]);

  useEffect(() => {
    const opener = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    const layer = dialog?.parentElement ?? null;
    const behind = Array.from(document.body.children).filter((element) => element !== layer && !element.hasAttribute('inert'));
    behind.forEach((element) => element.setAttribute('inert', ''));
    dialog?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      behind.forEach((element) => element.removeAttribute('inert'));
      if (opener?.isConnected) opener.focus();
    };
  }, [returnFocus]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function connect(walletId: string) {
    setBusy(walletId);
    setError(null);
    try {
      await wallet.connectBrowserWallet(walletId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The wallet could not connect');
      setBusy(null);
    }
  }

  async function switchNetwork() {
    setBusy('switch');
    setError(null);
    try {
      await wallet.switchChain(wallet.targetChainId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The wallet did not switch networks');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="sh-wallet-dialog__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="sh-wallet-dialog sh-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="sh-wallet-dialog__title">
          {BROWSER_WALLET_TITLE}
        </h2>
        {SEPOLIA_TRADE_BUILD ? (
          <p id={descriptionId} className="sh-wallet-dialog__lede">
            Connecting shares your address with this page. Nothing is signed or sent until you confirm it in your wallet. On this test site
            Square Hole asks for test trades and their exact approvals, faucet drips, {ALPHA_CLAIM ? 'your alpha claim, ' : ''}launches and fee claims, on{' '}
            {chainLabel(wallet.targetChainId)}. Test networks and unaudited contracts: use test funds only.
          </p>
        ) : (
          <p id={descriptionId} className="sh-wallet-dialog__lede">
            Connecting shares your address with this page. Nothing is signed or sent until you confirm a transaction in your wallet, and
            Square Hole only ever asks for two kinds: creating a launch and claiming credited fees, on {chainLabel(wallet.targetChainId)}. Test
            networks and unaudited contracts: use test funds only.
          </p>
        )}

        {connected && wallet.account ? (
          <p className="sh-wallet-dialog__current">
            Connected: <strong>{wallet.walletName ?? 'Browser wallet'}</strong> · <span className="sh-numeric">{shortAddress(wallet.account)}</span> on{' '}
            {wallet.chainId === null ? 'an unknown network' : chainLabel(wallet.chainId)} <MyBoxLink onOpen={onClose} />
          </p>
        ) : null}
        {wrongNetwork ? (
          <div className="sh-wallet-dialog__actions">
            <p className="sh-wallet-dialog__error">This page uses {chainLabel(wallet.targetChainId)}.</p>
            <button type="button" className="sh-button sh-button--primary" onClick={switchNetwork} disabled={busy !== null} aria-busy={busy === 'switch' || undefined}>
              {busy === 'switch' ? 'Switching…' : `Switch to ${chainLabel(wallet.targetChainId)}`}
            </button>
          </div>
        ) : null}

        <section className="sh-wallet-dialog__personas" aria-label="Wallets found in this browser">
          <p className="sh-wallet-persona__title">Wallets found in this browser</p>
          {wallets.length === 0 ? <p className="sh-wallet-persona__hint">No wallet has announced itself (EIP-6963) yet.</p> : null}
          {wallets.map((option) => (
            <button key={option.id} type="button" className="sh-wallet-persona sh-wallet-option" onClick={() => connect(option.id)} disabled={busy !== null} aria-busy={busy === option.id || undefined}>
              {option.icon ? <img src={option.icon} alt="" width={24} height={24} className="sh-wallet-option__icon" onError={(event) => (event.currentTarget.hidden = true)} /> : null}
              <span className="sh-wallet-persona__body">
                <span className="sh-wallet-persona__title">{busy === option.id ? `Connecting ${option.name}…` : option.name}</span>
                <span className="sh-wallet-persona__hint">
                  {option.rdns}
                  {option.lastUsed ? ' · last used here' : ''}
                </span>
              </span>
            </button>
          ))}
          <button type="button" className="sh-wallet-persona sh-wallet-option" onClick={() => connect(BROWSER_WALLET_ID)} disabled={busy !== null} aria-busy={busy === BROWSER_WALLET_ID || undefined}>
            <span className="sh-wallet-persona__body">
              <span className="sh-wallet-persona__title">{busy === BROWSER_WALLET_ID ? 'Connecting…' : 'Other browser wallet'}</span>
              <span className="sh-wallet-persona__hint">The wallet your browser injects (window.ethereum). Used only if you pick it.</span>
            </span>
          </button>
        </section>

        {error ? (
          <p className="sh-wallet-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="sh-wallet-dialog__actions">
          {DEMO_BUILD && onChooseDemo ? (
            <button type="button" className="sh-button" onClick={onChooseDemo} disabled={busy !== null}>
              Sample wallet (nothing is signed)
            </button>
          ) : null}
          {connected ? (
            <button
              type="button"
              className="sh-button"
              onClick={() => {
                wallet.disconnect();
                onClose();
              }}
            >
              Disconnect
            </button>
          ) : null}
          <button type="button" className="sh-button sh-wallet-dialog__cancel" onClick={onClose}>
            {connected ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
