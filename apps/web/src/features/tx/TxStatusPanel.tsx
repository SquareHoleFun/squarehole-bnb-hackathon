import type { TxState } from '@squarehole/domain';
import { MOCK_TX_SCRIPT_NAMES } from '@squarehole/providers';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { formatAsOf } from '../feed/format';
import { Loader } from '../brand';
import { chainLabel, shortAddress } from '../wallet';
import { DEMO_SCENARIO_LABELS, isMockTxScriptName, setDemoTxScenario, useDemoTxScenario } from './demo-scenario';
import { explainReason, txCopy, type TxTone } from './tx-copy';
import type { ChainFlowControls, TxFlowControls } from './tx-flow-controller';
import { networkFeeText, txExplorerHref } from './tx-format';
import { txControlsFor } from './tx-registry';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface TxStatusPanelProps {
  state: TxState;
  /**
   * "Start again" after a finished, timed-out or unknown request (default: the producing flow's own restart). `null`
   * offers no restart (e.g. the page knows the request can no longer be made as it was).
   */
  onRetry?: (() => void) | null;
  /** The wrong-network switch (default: the producing flow's `switchChain`). A rejection is shown in the panel. */
  onSwitchChain?: () => Promise<void> | void;
  /** Shown only in `finalized`, the one success state. */
  successContent?: ReactNode;
  /** Level of the panel heading (default 2). */
  headingLevel?: 2 | 3 | 4;
  /**
   * Show the tester "Demo scenario" picker in the panel (default true in demo mode). A page that offers one shared
   * `DemoScenarioPicker` for all its requests passes false so the choice appears once.
   */
  scenarioPicker?: boolean;
  /**
   * Chain claims: after the converter reported conversion to T impossible (the pool is sold out), the page may offer
   * the emergency payout in Q as a SEPARATE, labelled request. The panel shows the button only then, and only this
   * click starts it; it is never chosen automatically.
   */
  onRequestQFallback?: () => void;
}

const RETRYABLE: ReadonlySet<TxState['status']> = new Set([
  'simulation_failed',
  'rejected',
  'invalidated',
  'replaced',
  'reverted',
  'timed_out',
  'unknown',
]);

const KIND_LABEL = { claim: 'Claim', create_launch: 'Launch' } as const;

function titleFor(state: TxState, controls: TxFlowControls | null): string {
  if (controls) return controls.label;
  return 'ctx' in state ? `${KIND_LABEL[state.ctx.kind]} transaction` : 'Transaction';
}

/**
 * Renders any transaction state with honest copy (UI-08): a hash is not success, only `finalized` shows the success
 * content, and nothing animates towards "done". Demo-labelled throughout, with the tester's "Demo scenario" picker.
 */
export function TxStatusPanel({ state, onRetry, onSwitchChain, successContent, headingLevel = 2, scenarioPicker = true, onRequestQFallback }: TxStatusPanelProps) {
  const controls = txControlsFor(state);
  const chain = controls?.chain ?? null;
  const copy = txCopy(state, !DEMO_BUILD || chain ? 'chain' : 'demo');
  const headingId = useId();
  const Heading = headingLevel === 4 ? 'h4' : headingLevel === 3 ? 'h3' : 'h2';
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastFocused = useRef<Element | null>(null);
  // A state change can remove the focused control (e.g. the sample wallet's "Sign" once signed). Focus then returns to the
  // panel heading instead of falling back to the page body, so keyboard and screen reader users stay in the panel.
  useLayoutEffect(() => {
    const previous = lastFocused.current;
    const active = document.activeElement;
    if (previous !== null && !previous.isConnected && (active === null || active === document.body)) headingRef.current?.focus();
  }, [state]);
  // Keyed by the state object, so a new state clears them without an effect.
  const [switching, setSwitching] = useState<TxState | null>(null);
  const [switchError, setSwitchError] = useState<{ state: TxState; message: string } | null>(null);
  const retry = onRetry === null ? null : (onRetry ?? controls?.retry);
  const switchNetwork = onSwitchChain ?? controls?.switchChain;

  async function onSwitch() {
    if (!switchNetwork) return;
    setSwitching(state);
    setSwitchError(null);
    try {
      await switchNetwork();
    } catch (error) {
      setSwitchError({ state, message: error instanceof Error ? error.message : 'The wallet did not switch networks.' });
    } finally {
      setSwitching(null);
    }
  }

  return (
    <section
      className="sh-tx sh-panel"
      aria-labelledby={headingId}
      aria-busy={copy.tone === 'waiting' || undefined}
      data-tx-status={state.status}
      data-tone={copy.tone}
      onFocus={(event) => {
        lastFocused.current = event.target;
      }}
    >
      <div className="sh-tx__header">
        <Heading ref={headingRef} id={headingId} className="sh-tx__heading" tabIndex={-1} data-tx-status-heading="">
          {titleFor(state, controls)}
        </Heading>
        <span className="sh-chip sh-chip--pending">{chain ? `${chain.chainName} transaction` : 'Transaction'}</span>
      </div>

      <div className="sh-tx__status" role="status" aria-live="polite" aria-atomic="true">
        <p className="sh-tx__title">
          <ToneMark tone={copy.tone} />
          <span>{copy.title}</span>
        </p>
        <p className="sh-tx__body">{copy.body}</p>
      </div>

      <TxDetails state={state} chain={chain} />

      {chain?.info.notice ? (
        <p className="sh-tx__error" role="alert">
          {chain.info.notice}
        </p>
      ) : null}

      {state.status === 'wrong_chain' ? (
        <div className="sh-tx__actions">
          {switchNetwork ? (
            <button
              type="button"
              className="sh-button sh-button--primary"
              onClick={onSwitch}
              disabled={switching === state}
              aria-busy={switching === state || undefined}
            >
              {switching === state ? 'Switching…' : `Switch to ${chain ? `${chain.chainName} (${state.ctx.chainId})` : chainLabel(state.ctx.chainId)}`}
            </button>
          ) : null}
          {controls ? (
            <button type="button" className="sh-button" onClick={controls.cancel}>
              Cancel request
            </button>
          ) : null}
        </div>
      ) : null}
      {switchError?.state === state ? (
        <p className="sh-tx__error" role="alert">
          {switchError.message}
        </p>
      ) : null}

      {state.status === 'awaiting_signature' && controls?.interactive && chain ? <ChainSignatureRequest state={state} controls={controls} chain={chain} /> : null}
      {DEMO_BUILD && state.status === 'awaiting_signature' && controls?.interactive && !chain ? <DemoSignatureRequest state={state} controls={controls} /> : null}

      {chain && (state.status === 'timed_out' || state.status === 'unknown') ? (
        <div className="sh-tx__actions">
          <button
            type="button"
            className="sh-button sh-button--primary"
            onClick={chain.recheck}
            disabled={chain.info.rechecking}
            aria-busy={chain.info.rechecking || undefined}
          >
            {chain.info.rechecking ? 'Re-checking…' : 'Re-check by hash'}
          </button>
        </div>
      ) : null}

      {chain && state.status === 'simulation_failed' && chain.info.refusalFallback === 'claim_as_q_when_sold_out' && onRequestQFallback ? (
        <div className="sh-tx__fallback" data-testid="q-fallback-offer">
          <p>
            <strong>A different payout is available.</strong> The pool is sold out, so the conversion to T cannot fill. You can instead
            take this claim as the emergency payout in Q (the quote asset, not T). It is a separate request and is never chosen for you.
          </p>
          <div className="sh-tx__actions">
            <button type="button" className="sh-button" onClick={onRequestQFallback}>
              Request the emergency payout in Q instead
            </button>
          </div>
        </div>
      ) : null}

      {chain?.info.lateHash ? (
        <p className="sh-tx__error" role="alert">
          The wallet returned a transaction hash after this request was cancelled: <code className="sh-tx__hash">{chain.info.lateHash}</code>. It is not
          tracked here; check it before trying again.
        </p>
      ) : null}

      {RETRYABLE.has(state.status) && retry ? (
        <div className="sh-tx__actions">
          <button type="button" className="sh-button" onClick={retry}>
            Start again
          </button>
        </div>
      ) : null}

      {state.status === 'finalized' && successContent ? <div className="sh-tx__success">{successContent}</div> : null}

      {DEMO_BUILD && scenarioPicker && !controls?.scriptLocked && !chain ? <DemoScenarioPicker /> : null}
      <p className="sh-tx__footnote">
        {chain ? `${chain.chainName}: a real transaction on a test chain. The contracts are not audited; use test funds only.` : DEMO_BUILD ? 'Nothing is signed or sent.' : null}
      </p>
    </section>
  );
}

/** Waiting is the breathing logo (F51); every other tone keeps its plain mark. Text always carries the state. */
function ToneMark({ tone }: { tone: TxTone }) {
  if (tone === 'waiting') return <Loader size="button" decorative />;
  return <span className="sh-tx__mark" data-tone={tone} aria-hidden="true" />;
}

const REPLACEMENT_KIND = {
  repriced: 'Sped up: the same request with a new fee. Its outcome is on the replacement transaction.',
  cancelled: 'Cancelled in the wallet: an empty transaction took its place.',
  replaced: 'Another transaction from this account took its place.',
} as const;

function HashValue({ hash, chain }: { hash: string; chain: ChainFlowControls | null }) {
  const href = chain ? txExplorerHref(chain.explorerOrigin, hash) : null;
  return (
    <>
      <code className="sh-tx__hash">{hash}</code>
      {href ? (
        <>
          {' '}
          <a href={href} target="_blank" rel="noopener noreferrer">
            View on the explorer
          </a>
        </>
      ) : null}
    </>
  );
}

function TxDetails({ state, chain }: { state: TxState; chain: ChainFlowControls | null }) {
  const rows: [string, ReactNode][] = [];
  if ('hash' in state) rows.push(['Transaction hash', <HashValue hash={state.hash} chain={chain} />]);
  if (state.status === 'replaced') rows.push(['Replacement hash', <HashValue hash={state.newHash} chain={chain} />]);
  if (state.status === 'replaced' && chain?.info.replacement) rows.push(['Replacement', REPLACEMENT_KIND[chain.info.replacement.kind]]);
  if (state.status === 'confirmed_unfinalized' || state.status === 'finalized') rows.push(['Block', <span className="sh-numeric">{state.block}</span>]);
  if (state.status === 'simulation_failed' || state.status === 'reverted' || state.status === 'unknown') {
    rows.push(['Reason', explainReason(state.reason)]);
  }
  if (rows.length === 0) return null;
  return (
    <dl className="sh-tx__details">
      {rows.map(([term, value]) => (
        <div key={term} className="sh-tx__detail">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Chain flows: what was simulated and what it costs, then the one explicit "Confirm in wallet" click that opens the
 * wallet's own window (UI-09). Cancelling here sends nothing.
 */
function ChainSignatureRequest({
  state,
  controls,
  chain,
}: {
  state: Extract<TxState, { status: 'awaiting_signature' }>;
  controls: TxFlowControls;
  chain: ChainFlowControls;
}) {
  const titleId = useId();
  const { info } = chain;
  const deadline = state.ctx.deadline === null ? null : formatAsOf(state.ctx.deadline);
  return (
    <div className="sh-tx__wallet" role="group" aria-labelledby={titleId} data-testid="chain-signature-request">
      <p id={titleId} className="sh-tx__wallet-title">
        Review before your wallet opens
      </p>
      <dl className="sh-tx__details">
        {(info.details ?? []).map((detail) => (
          <div key={detail.label} className="sh-tx__detail">
            <dt>{detail.label}</dt>
            <dd>{detail.value}</dd>
          </div>
        ))}
        <div className="sh-tx__detail">
          <dt>Network fee</dt>
          <dd>{networkFeeText(info.simulation?.fee ?? null, chain.nativeSymbol)}</dd>
        </div>
        {info.simulation ? (
          <div className="sh-tx__detail">
            <dt>Gas</dt>
            <dd>
              <span className="sh-numeric">{info.simulation.gasEstimate.toString()}</span> estimated · limit{' '}
              <span className="sh-numeric">{info.simulation.gasLimit.toString()}</span> · simulated at block{' '}
              <span className="sh-numeric">{info.simulation.atBlock.toString()}</span>
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="sh-tx__wallet-meta">
        {controls.label} · from <span className="sh-numeric">{shortAddress(state.ctx.account)}</span> on {chain.chainName} ({state.ctx.chainId})
        {deadline ? ` · valid until ${deadline}` : ''}
      </p>
      {info.walletError ? (
        <p className="sh-tx__error" role="alert">
          {info.walletError}
        </p>
      ) : null}
      <div className="sh-tx__actions">
        <button
          type="button"
          className="sh-button sh-button--primary"
          onClick={controls.sign}
          disabled={info.walletPending}
          aria-busy={info.walletPending || undefined}
        >
          {info.walletPending ? 'Waiting for the wallet…' : 'Confirm in wallet'}
        </button>
        <button type="button" className="sh-button" onClick={controls.cancel} disabled={info.walletPending}>
          Cancel request
        </button>
      </div>
    </div>
  );
}

/** The demo wallet's signature request, shown inline where a real wallet would open its own window. */
function DemoSignatureRequest({ state, controls }: { state: Extract<TxState, { status: 'awaiting_signature' }>; controls: TxFlowControls }) {
  const titleId = useId();
  const deadline = state.ctx.deadline === null ? null : formatAsOf(state.ctx.deadline);
  return (
    <div className="sh-tx__wallet" role="group" aria-labelledby={titleId}>
      <p id={titleId} className="sh-tx__wallet-title">
        Wallet request
      </p>
      <p className="sh-tx__wallet-note">
        Signs nothing: signing here only moves the scenario forward.
      </p>
      <p className="sh-tx__wallet-meta">
        {controls.label} · from <span className="sh-numeric">{shortAddress(state.ctx.account)}</span> on {chainLabel(state.ctx.chainId)}
        {deadline ? ` · quote deadline ${deadline}` : ''}
      </p>
      <div className="sh-tx__actions">
        <button type="button" className="sh-button sh-button--primary" onClick={controls.sign}>
          Sign
        </button>
        <button type="button" className="sh-button" onClick={controls.reject}>
          Reject
        </button>
      </div>
    </div>
  );
}

/**
 * The tester "Demo scenario" choice (all mock executor scripts). Rendered inside `TxStatusPanel` by default; a page with
 * several requests can render it once and pass `scenarioPicker={false}` to its panels.
 */
export function DemoScenarioPicker({ className }: { className?: string } = {}) {
  const scenario = useDemoTxScenario();
  const id = useId();
  return (
    <div className={['sh-tx__scenario', className].filter(Boolean).join(' ')}>
      <label htmlFor={id}>Scenario</label>
      <select
        id={id}
        value={scenario}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (isMockTxScriptName(value)) setDemoTxScenario(value);
        }}
        aria-describedby={`${id}-hint`}
      >
        {MOCK_TX_SCRIPT_NAMES.map((name) => (
          <option key={name} value={name}>
            {DEMO_SCENARIO_LABELS[name]}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="sh-tx__scenario-hint">
        The outcome the next request follows. A running request keeps its scenario.
      </p>
    </div>
  );
}
