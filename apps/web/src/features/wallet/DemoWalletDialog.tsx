import { CastCharacter } from '@squarehole/design';
import { DEMO_CHAIN_ID } from '@squarehole/domain';
import { useContext, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { MyBoxLink } from './MyBoxLink';
import { personaCopy, PickerPersonasContext } from './personas';
import { DEMO_WRONG_CHAIN_ID, chainLabel, personaForAccount, shortAddress } from './wallet-adapter';
import { useWallet } from './wallet-context';

export interface DemoWalletDialogProps {
  open: boolean;
  onClose: () => void;
  /** Where focus goes on close (default: whatever was focused on open). Safari does not focus clicked buttons. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Stage C: offers the browser-wallet window instead (a separate choice; the demo wallet never touches it). */
  onChooseBrowserWallet?: () => void;
}

export const DEMO_WALLET_TITLE = 'Sample wallet';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The demo wallet's own window: pick a synthetic persona, optionally make the wallet report the wrong network, connect,
 * switch or disconnect. It never touches a browser wallet. Modal: focus moves in, Tab stays in, the page behind is
 * inert, Escape closes, and focus returns to whatever opened it. Rendered only while open, so browsing never finds a dialog in the page.
 */
export function DemoWalletDialog({ open, onClose, returnFocus, onChooseBrowserWallet }: DemoWalletDialogProps) {
  if (!open) return null;
  return createPortal(<DialogBody onClose={onClose} returnFocus={returnFocus} onChooseBrowserWallet={onChooseBrowserWallet} />, document.body);
}

function DialogBody({ onClose, returnFocus, onChooseBrowserWallet }: Omit<DemoWalletDialogProps, 'open'>) {
  const wallet = useWallet();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const connected = wallet.status === 'connected' && wallet.kind === 'demo';
  const current = personaForAccount(wallet.account);
  const offered = useContext(PickerPersonasContext);
  const [personaId, setPersonaId] = useState<string>(() => (current && offered.some((persona) => persona.id === current.id) ? current.id : offered[0]?.id ?? ''));
  const [wrongNetwork, setWrongNetwork] = useState(() => connected && wallet.chainId !== DEMO_CHAIN_ID);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus the selected persona on open; give focus back to the opener on close. While open, everything else on the
  // page is inert (aria-modal made real: no pointer, focus or screen reader access behind the window).
  useEffect(() => {
    const opener = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    const layer = dialog?.parentElement ?? null;
    const behind = Array.from(document.body.children).filter((element) => element !== layer && !element.hasAttribute('inert'));
    behind.forEach((element) => element.setAttribute('inert', ''));
    const first = dialog?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? dialog?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
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
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (item) => !(item instanceof HTMLInputElement && item.type === 'radio' && !item.checked),
    );
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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await wallet.connect(personaId, { chainId: wrongNetwork ? DEMO_WRONG_CHAIN_ID : DEMO_CHAIN_ID });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The sample wallet could not connect');
      setBusy(false);
    }
  }

  function onDisconnect() {
    wallet.disconnect();
    onClose();
  }

  return (
    <div
      className="sh-wallet-dialog__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="sh-wallet-dialog sh-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onKeyDown}
      >
        <div className="sh-wallet-dialog__header">
          <CastCharacter id="sorter" size={56} caption={false} className="sh-wallet-dialog__cast" />
          <div>
            <h2 id={titleId} className="sh-wallet-dialog__title">
              {DEMO_WALLET_TITLE}
            </h2>
          </div>
        </div>
        <p id={descriptionId} className="sh-wallet-dialog__lede">
          Signs nothing and never opens a browser wallet. Pick an account to see the app as that account.
        </p>

        {connected && wallet.account ? (
          <p className="sh-wallet-dialog__current">
            Connected as <strong>{current ? personaCopy(current).title : 'an unknown account'}</strong> ·{' '}
            <span className="sh-numeric">{shortAddress(wallet.account)}</span> on{' '}
            {wallet.chainId === null ? 'an unknown network' : chainLabel(wallet.chainId)} <MyBoxLink onOpen={onClose} />
          </p>
        ) : null}

        <form className="sh-wallet-dialog__form" onSubmit={onSubmit}>
          <fieldset className="sh-wallet-dialog__personas">
            <legend>Account</legend>
            {offered.map((persona) => {
              const copy = personaCopy(persona);
              const nameId = `${titleId}-${persona.id}-name`;
              const hintId = `${titleId}-${persona.id}-hint`;
              return (
                <label key={persona.id} className="sh-wallet-persona">
                  <input
                    type="radio"
                    name="demo-persona"
                    value={persona.id}
                    checked={personaId === persona.id}
                    onChange={() => setPersonaId(persona.id)}
                    aria-labelledby={nameId}
                    aria-describedby={hintId}
                  />
                  <span className="sh-wallet-persona__body">
                    <span id={nameId} className="sh-wallet-persona__title">
                      {copy.title}
                    </span>
                    <span id={hintId} className="sh-wallet-persona__hint">
                      {copy.description} <span className="sh-numeric">{shortAddress(persona.address)}</span>
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <label className="sh-wallet-dialog__check">
            <input
              type="checkbox"
              checked={wrongNetwork}
              onChange={(event) => setWrongNetwork(event.currentTarget.checked)}
              aria-labelledby={`${titleId}-network-name`}
              aria-describedby={`${titleId}-network`}
            />
            <span>
              <span id={`${titleId}-network-name`} className="sh-wallet-persona__title">
                Simulate wrong network
              </span>
              <span id={`${titleId}-network`} className="sh-wallet-persona__hint">
                The wallet reports {chainLabel(DEMO_WRONG_CHAIN_ID)} instead of {chainLabel(DEMO_CHAIN_ID)}, so you can try
                the switch-network step.
              </span>
            </span>
          </label>

          {error ? (
            <p className="sh-wallet-dialog__error" role="alert">
              {error}
            </p>
          ) : null}

          {onChooseBrowserWallet ? (
            <p className="sh-wallet-dialog__alt">
              Sending real testnet transactions needs a browser wallet.{' '}
              <button type="button" className="sh-button" onClick={onChooseBrowserWallet} disabled={busy}>
                Use a browser wallet instead
              </button>
            </p>
          ) : null}

          <div className="sh-wallet-dialog__actions">
            <button type="submit" className="sh-button sh-button--primary" disabled={busy} aria-busy={busy || undefined}>
              {busy ? 'Connecting…' : connected ? 'Update sample wallet' : 'Connect sample wallet'}
            </button>
            {connected ? (
              <button type="button" className="sh-button" onClick={onDisconnect}>
                Disconnect
              </button>
            ) : null}
            <button type="button" className="sh-button sh-wallet-dialog__cancel" onClick={onClose}>
              {connected ? 'Close' : 'Cancel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
