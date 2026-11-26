import { DEMO_CHAIN_ID } from '@squarehole/domain';
import { useRef, useState } from 'react';
import { BrowserWalletDialog } from './BrowserWalletDialog';
import { DemoWalletDialog } from './DemoWalletDialog';
import { shortAddress } from './wallet-adapter';
import { useWallet } from './wallet-context';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const WalletIcon = () => (
  <svg
    className="sh-icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
    <rect x="4" y="8" width="16" height="11" rx="2" />
    <path d="M16 13.5h.01" />
  </svg>
);

/**
 * Top-bar wallet entry (UI-09): nothing happens until it is clicked, and a click only opens a wallet window: the demo
 * wallet (the default while the app shows demo data) or, on a chain data source or once a browser wallet is connected,
 * the browser-wallet window. The app offers the demo wallet only with the demo fixtures and browser wallets only on a
 * chain data source (`walletKinds`); isolated tests may offer both, each as a separate choice. Disconnected it reads
 * "Connect wallet"; connected it shows "Wallet" for the sample wallet (no Demo word, F130) or the browser wallet's name, and the short account, plus "Wrong network"
 * when the wallet is not on the chain the app expects. At ≤1024px it is a 44px icon button (a dot marks "connected", amber for a wrong network);
 * its accessible name keeps the full wording.
 */
export function ConnectWalletButton() {
  const wallet = useWallet();
  const [open, setOpen] = useState<'demo' | 'browser' | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const connected = wallet.status === 'connected' && wallet.account !== null;
  const browser = connected && wallet.kind === 'injected';
  const wrongNetwork = connected && wallet.chainId !== (browser ? wallet.targetChainId : DEMO_CHAIN_ID);
  const short = wallet.account ? shortAddress(wallet.account) : '';
  // The production site has browser wallets only: no sample wallet to name.
  const name = !DEMO_BUILD || browser ? (wallet.walletName ?? 'Browser wallet') : 'Wallet';
  const which: 'demo' | 'browser' = !DEMO_BUILD ? 'browser' : connected ? (browser ? 'browser' : 'demo') : wallet.defaultDialog;
  const offersDemo = DEMO_BUILD && wallet.walletKinds !== 'browser';
  const offersBrowser = wallet.walletKinds !== 'demo';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="sh-wallet-button"
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        data-wallet-status={wallet.status}
        data-wrong-network={wrongNetwork || undefined}
        aria-label={connected ? `${name} ${short}${wrongNetwork ? ', wrong network' : ''}` : undefined}
        onClick={() => setOpen(which)}
      >
        {connected ? (
          <>
            {/* Icon rail and phones: the icon with a status dot; the name carries "Wallet" and the account. */}
            <span className="sh-wallet-button__compact">
              <WalletIcon />
              <span className="sh-wallet-button__dot" />
            </span>
            <span className="sh-wallet-button__name">{name}</span>
            <span className="sh-wallet-button__account sh-numeric">{short}</span>
            {wrongNetwork ? <span className="sh-wallet-button__warning">Wrong network</span> : null}
          </>
        ) : (
          <>
            <WalletIcon />
            <span className="sh-wallet-button__text">Connect wallet</span>
          </>
        )}
      </button>
      {DEMO_BUILD ? (
        <DemoWalletDialog
          open={open === 'demo'}
          onClose={() => setOpen(null)}
          returnFocus={buttonRef}
          onChooseBrowserWallet={offersBrowser ? () => setOpen('browser') : undefined}
        />
      ) : null}
      <BrowserWalletDialog open={open === 'browser'} onClose={() => setOpen(null)} returnFocus={buttonRef} onChooseDemo={offersDemo ? () => setOpen('demo') : undefined} />
    </>
  );
}
