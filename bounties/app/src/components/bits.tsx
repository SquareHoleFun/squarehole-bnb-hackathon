import { useEffect, useId, useState, type ReactNode } from 'react';
import { useApp, type TxStep } from '../lib/app-context';
import { addressUrl, shortAddress, txUrl } from '../lib/chain';
import { formatAmount, toDecimalString } from '../lib/amounts';

/** An amount on screen: short form, the exact value on hover. */
export function Amount({ value, decimals, symbol }: { value: bigint; decimals: number; symbol?: string }) {
  return (
    <span className="sh-numeric amount" title={toDecimalString(value, decimals) + (symbol ? ' ' + symbol : '')}>
      {formatAmount(value, decimals)}
      {symbol ? <span className="unit"> {symbol}</span> : null}
    </span>
  );
}

export function AddressLink({ address }: { address: string }) {
  const { config } = useApp();
  return (
    <a className="mono" href={addressUrl(config, address)} target="_blank" rel="noreferrer">
      {shortAddress(address)}
    </a>
  );
}

/** Details behind a (?), closed by default. */
export function Help({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="help">
      <button
        type="button"
        className="help-btn"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open ? (
        <span id={id} className="help-body" role="note">
          {children}
        </span>
      ) : null}
    </span>
  );
}

export function Stat({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="stat" data-testid={testId}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
    </div>
  );
}

const LEG_WORDS: Record<string, string> = { confirmed: 'confirmed', sent: 'sent', pending: 'pending', failed: 'failed', unknown: 'no answer' };

/** The life of one write: prompt, sent with its link, done or refused with the decoded error. */
export function TxStatus({ step }: { step: TxStep }) {
  const { config } = useApp();
  if (step.kind === 'idle') return null;
  const link =
    'hash' in step && step.hash ? (
      <a href={txUrl(config, step.hash)} target="_blank" rel="noreferrer" className="mono">
        {shortAddress(step.hash)}
      </a>
    ) : null;
  const legs = step.legs?.length ? (
    <div className="tx tx-done tx-legs" data-testid="tx-legs">
      {step.legs.map((l) => (
        <span key={l.hash}>
          {l.label}: {LEG_WORDS[l.state] ?? l.state}{' '}
          <a href={txUrl(config, l.hash)} target="_blank" rel="noreferrer" className="mono">
            {shortAddress(l.hash)}
          </a>{' '}
        </span>
      ))}
    </div>
  ) : null;
  return (
    <>
    {legs}
    <div className={`tx tx-${step.kind}`} role="status" data-testid="tx-status" data-state={step.kind}>
      {step.kind === 'checking' && <span>{step.label}: checking…</span>}
      {step.kind === 'wallet' && <span>{step.label}: confirm in your wallet</span>}
      {step.kind === 'sent' && (
        <span>
          {step.label}: sent {link}
        </span>
      )}
      {step.kind === 'done' && (
        <span>
          ✓ {step.label}: done {link}
          {step.note ? <span data-testid="tx-note"> {step.note}</span> : null}
        </span>
      )}
      {step.kind === 'failed' && (
        <span>
          {step.error.name === 'pending' || step.error.name === 'unknown' ? '…' : '✕'} {step.label}: <code data-testid="tx-error-name">{step.error.name}</code> {step.error.sentence}{' '}
          {link}
        </span>
      )}
    </div>
    </>
  );
}

/** For a read that has failed since its numbers were read: how old they are. */
export function Age({ at, stale }: { at: number; stale: boolean }) {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!stale) return;
    const id = window.setInterval(() => setNow((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [stale]);
  if (!stale) return null;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return (
    <span className="pill stale small" data-testid="age">
      Numbers from {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`} ago
    </span>
  );
}

/** A read that failed on every endpoint: said, with a button that reads again now (polling also retries). */
export function ReadError({ text, testId }: { text: string; testId: string }) {
  const { bump } = useApp();
  return (
    <p className="refusal" role="alert" data-testid={testId}>
      {text}{' '}
      <button type="button" className="link-btn" onClick={bump} data-testid={`${testId}-retry`}>
        Try again
      </button>
    </p>
  );
}
