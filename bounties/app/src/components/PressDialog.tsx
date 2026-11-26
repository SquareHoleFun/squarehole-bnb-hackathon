import { useEffect, useRef } from 'react';
import { useApp, type PressStep } from '../lib/app-context';
import { shortAddress, txUrl } from '../lib/chain';
import { useWallet } from '../lib/wallet';

const STATE_WORDS: Record<PressStep['state'], string> = {
  waiting: 'waiting',
  wallet: 'in your wallet',
  sent: 'sent',
  confirmed: 'confirmed',
  notSent: 'not sent',
  unknown: 'no answer from your wallet',
  pending: 'pending',
  failed: 'failed',
};

/**
 * The press of a write button, in a native modal dialog (the browser makes the rest of the page inert and keeps the
 * focus inside). Its title is the steps in order; each step has its own line. Cancel (and Escape) only until the
 * press's first wallet request; then "Stop waiting" while a step waits on the wallet; "Check again" and "Leave it
 * pending" once a sent step has waited 180 s; Close once the press has its last line. It never closes by itself.
 */
export function PressDialog() {
  const { lock, config } = useApp();
  const wallet = useWallet();
  const ref = useRef<HTMLDialogElement>(null);
  const v = lock.current;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (v && !d.open) d.showModal();
    if (!v && d.open) d.close();
  }, [v]);
  const open = Boolean(v && v.final === undefined);
  const cur = v?.steps.find((s) => s.state !== 'confirmed');
  // Cancel until the press's first wallet request; after it, Stop waiting while any step waits on the wallet (its
  // request, or the account and chain asked before it); a sent step without a receipt has Check again and Leave it pending.
  const canCancel = Boolean(open && !v!.walletAsked);
  const canStop = Boolean(open && v!.walletAsked && cur && cur.state !== 'sent');
  const sentSlow = Boolean(open && v!.slow && cur?.state === 'sent');
  // The outcome is shown only to the account that pressed.
  const mine = Boolean(v && wallet.account?.toLowerCase() === v.owner);
  const title = v ? (v.steps.length > 1 ? v.steps.map((s, i) => `${i + 1} ${s.label}`).join(' · ') : v.steps[0]!.label) : '';
  const link = (hash: string) => (
    <a href={txUrl(config, hash)} target="_blank" rel="noreferrer" className="mono">
      {shortAddress(hash)}
    </a>
  );
  return (
    <dialog
      ref={ref}
      className="press-dialog sh-panel"
      aria-labelledby="press-title"
      data-testid="press"
      onCancel={(e) => {
        // Escape: Cancel before the first wallet request; nothing after it.
        e.preventDefault();
        if (canCancel) lock.cancel();
      }}
    >
      {v ? (
        <>
          <h2 id="press-title" data-testid="press-title">
            {title}
          </h2>
          {!mine ? (
            <p className="muted small" data-testid="press-owner">
              This press was made by {shortAddress(v.owner)}.
            </p>
          ) : null}
          <ol className="press-steps" hidden={!mine}>
            {v.steps.map((s, i) => (
              <li key={i} data-testid="press-step" data-state={s.state}>
                {v.steps.length > 1 ? `${i + 1} ` : ''}
                {s.label}: {STATE_WORDS[s.state]}
                {s.reason ? ` (${s.reason})` : ''} {s.hash ? link(s.hash) : null}
              </li>
            ))}
          </ol>
          {v.readFailing && open ? (
            <p className="muted small" data-testid="press-read-failing">
              The receipt could not be read just now.
            </p>
          ) : null}
          {sentSlow ? (
            <p className="review" data-testid="press-slow">
              Still not confirmed. {(() => {
                const h = v.steps.find((s) => s.state === 'sent')?.hash;
                return h ? link(h) : null;
              })()}
            </p>
          ) : null}
          {v.final !== undefined && mine ? (
            <p className="review" role="status" data-testid="press-final">
              {v.final}
            </p>
          ) : null}
          <div className="actions">
            {canCancel ? (
              <button type="button" className="btn" onClick={() => lock.cancel()} data-testid="press-cancel">
                Cancel
              </button>
            ) : null}
            {canStop ? (
              <button type="button" className="btn" onClick={() => lock.stopWaiting()} data-testid="press-stop">
                Stop waiting
              </button>
            ) : null}
            {sentSlow ? (
              <>
                <button type="button" className="btn" onClick={() => lock.checkAgain()} data-testid="press-check">
                  Check again
                </button>
                <button type="button" className="btn" onClick={() => lock.leavePending()} data-testid="press-leave">
                  Leave it pending
                </button>
              </>
            ) : null}
            {v.final !== undefined ? (
              <button type="button" className="btn btn-primary" onClick={() => lock.close()} data-testid="press-close" autoFocus>
                Close
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
