/**
 * "Close box" (F99, F100, F104): on a v2 box anyone may close now (past its deadline with the curve open, or still
 * closed 14 days after its open), one button. Nothing touches a wallet until it is pressed (CLAUDE.md: no wallet
 * requests on navigation); pressing opens the wallet window when none is connected, then one confirmation names the
 * exact entry, `fail()` or `failClosed()`, on the box's coordinator, and the closer's tip cap.
 *
 * Sending: the Demo marks the box closed in this tab and sends nothing. A chain box has no sender in this build (the
 * chain write side allows only its listed calls; change request in SH-V2-M1-53B.md), so it shows no button rather
 * than one that cannot send.
 */
import { useEffect, useRef, useState } from 'react';
import { shortAddress } from '../../fit-pair/fit-format';
import type { BoxRecord } from '../../boxes/box-model';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { closeStateOf } from './box-v2';
import { closeDemoV2Box } from './demo-v2';
import { CLOSE_SIGNATURES, closeCallData, type CloseCall } from './v2-frozen';
import { CLOSE_BOX, CONFIRM_CLOSE } from './v2-words';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** One close call, as a sender gets it: the coordinator, the entry and its calldata (the selector alone), no value. */
export interface CloseRequest {
  readonly to: `0x${string}`;
  readonly call: CloseCall;
  readonly data: `0x${string}`;
}

export type CloseSender = (request: CloseRequest) => Promise<void>;

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

/** The Demo's sender (nothing is sent); null for a chain box until the write side allows the two close calls. */
export function closeSenderFor(record: BoxRecord): CloseSender | null {
  return DEMO_BUILD && record.demo ? async () => closeDemoV2Box(record.id, nowSec()) : null;
}

/** The clock in whole seconds, one tick a second, so the button appears when the deadline passes. */
function useNowSec(): bigint {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowSec()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

type Step = 'idle' | 'wallet' | 'confirm' | 'sending';

export function CloseBox({ record, sender = closeSenderFor(record) }: { record: BoxRecord; sender?: CloseSender | null }) {
  const wallet = useWallet();
  const now = useNowSec();
  const [step, setStep] = useState<Step>('idle');
  const [dialog, setDialog] = useState<'demo' | 'browser' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const connected = wallet.status === 'connected' && wallet.account !== null;
  // The wallet window this button opened has closed: connected, on to the confirmation; not, back to the button, so a
  // later connection elsewhere (the header's) never brings up a confirmation nobody asked for.
  if (step === 'wallet' && dialog === null) setStep(connected ? 'confirm' : 'idle');
  const facts = record.v2;
  const close = facts ? closeStateOf(facts, now) : null;
  if (!facts || close?.kind !== 'closable' || sender === null) return null;
  const call = close.call;

  const press = () => {
    setError(null);
    if (connected) setStep('confirm');
    else {
      setStep('wallet');
      setDialog(wallet.defaultDialog);
    }
  };
  const confirm = async () => {
    setStep('sending');
    try {
      await sender({ to: facts.coordinator, call, data: closeCallData(call) });
      setStep('idle');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The box was not closed.');
      setStep('confirm');
    }
  };
  const wrongNetwork = connected && wallet.chainId !== record.chainId;
  // A wallet connected from the window this button opened goes on to the confirmation; one that disconnects goes back.
  const confirming = connected && step !== 'idle';

  return (
    <div className="sh-v2-close">
      {confirming ? (
        <div className="sh-v2-close__confirm" role="group" aria-label={CLOSE_BOX}>
          <p>{`Calls ${CLOSE_SIGNATURES[call]} on ${shortAddress(facts.coordinator)}`}</p>
          {wrongNetwork ? <p className="sh-v2-close__error">Wrong network</p> : null}
          {error ? <p className="sh-v2-close__error" role="alert">{`Not closed · ${error}`}</p> : null}
          <p className="sh-v2-close__actions">
            <button type="button" className="sh-button sh-button--primary" disabled={wrongNetwork || step === 'sending'} onClick={() => void confirm()}>
              {CONFIRM_CLOSE}
            </button>
            <button type="button" className="sh-button" onClick={() => setStep('idle')}>
              Cancel
            </button>
          </p>
        </div>
      ) : (
        <button ref={buttonRef} type="button" className="sh-button sh-button--primary sh-v2-close__button" onClick={press}>
          {CLOSE_BOX}
        </button>
      )}
      {DEMO_BUILD ? <DemoWalletDialog open={dialog === 'demo'} onClose={() => setDialog(null)} returnFocus={buttonRef} /> : null}
      <BrowserWalletDialog open={dialog === 'browser'} onClose={() => setDialog(null)} returnFocus={buttonRef} />
    </div>
  );
}
