/**
 * F166 (SH-ALPHA-ONBOARDING): what "Set me up" shows, on the app's pages (AlphaWelcome.tsx) and at the top of the Claim
 * card (ClaimCard.tsx): while no run is shown, the one choice ("Set me up", or "Finish setup" after a setup left midway,
 * and the small "I'll do it myself"); then the run as four ticks (wallet, claim, coins, tETH) and one line; its end as
 * numbers first (SepETH, tETH), or the line where it stopped with "Try again" and "Close". What the press does, and the
 * run's address and transactions, wait behind a closed Details button. The run itself is setup-run.ts; this presses it.
 *
 * Af1: its presses are armed only `ARM_MS` after the panel appeared (a tap meant for what was there before never lands
 * on them), and greyed while a wallet's own window is asking (XR-ALPHA-SITE af3: its answer comes first). A lapsed
 * sign-in makes the sign-in the one primary action.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { TESTNET, testnetExplorerHref } from '../data-source/testnet';
import type { AlphaApi } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS, SETUP_DETAILS, SETUP_WORDS } from '../alpha-sepolia/alpha-words';
import { JOIN_THEN_EXPORT, type PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { privyAppIdOf } from '../alpha-sepolia/privy-config';
import { BUILD_CORE } from '../core/useCore';
import { sourceV2 } from '../core/v2/indexer-v2';
import { NO_FIGURE, pAmountV2 } from '../core/v2/stats-v2';
import { useDataSource } from '../data-source';
import { Details } from '../fit-pair/InfoTip';
import { shortAddress, useWallet } from '../wallet';
import { coinTargetOf, type CoinTargetRead } from './coin-target';
import { madeWalletBridge } from './made-wallet';
import { loadPrivyBridge } from './privy-load';
import { SETUP_STEPS, runSetup, useSetupState, useSetupWallet, type SetupState, type SetupStep, type SetupTiming } from './setup-run';
import './setup.css';

const SEPOLIA = TESTNET.chainId;
/** How long the panel's presses wait after it appears before they act (af1 F2). */
export const ARM_MS = 400;

export interface SetupPanelProps {
  /** Which press the choice offers: "Set me up", or "Finish setup" after a setup this device left midway. */
  readonly offer: 'start' | 'finish';
  /** One line above the choice (the Claim card's line for a claim the sender's dry run freed), or none. */
  readonly note?: string | null;
  /**
   * "I'll do it myself" (today's Claim card and faucet), or null where it is not offered: a button on the Claim card,
   * a link that says it opens the test-coin page on the app's pages (`href`).
   */
  readonly onManual: (() => void) | null;
  readonly manualHref?: string | null;
  /** "Not now" (the app's pages: the step put away for this visit), or none. */
  readonly onNotNow?: (() => void) | null;
  /** The run's end, or its stop, put away ("Close"). */
  readonly onClose: () => void;
  /** A link to the test-coin page at the run's end (the app's pages). */
  readonly coinsLink?: boolean;
  /** Test seam: our server (the page's own otherwise). */
  readonly api: AlphaApi;
  /** Test seam: Privy (privy-load.ts otherwise). */
  readonly loadPrivy?: (appId: string) => Promise<PrivyBridge>;
  /** Test seam: the Privy app ID (privy-config.ts otherwise; null while it is the placeholder). */
  readonly appId?: string | null;
  /** Test seam: where the coins are, read on the press (the data source's own otherwise, as the test-coin page reads it). */
  readonly target?: () => CoinTargetRead;
  /** Test seam: the run's waits and clock. */
  readonly timing?: Partial<SetupTiming>;
}

type Mark = 'done' | 'active' | 'failed' | 'test' | 'todo';

const STEP_NAMES: Readonly<Record<SetupStep, string>> = Object.freeze({ wallet: SETUP_WORDS.stepWallet, claim: SETUP_WORDS.stepClaim, coins: SETUP_WORDS.stepCoins, teth: SETUP_WORDS.stepTeth });
const MARK_WORDS: Readonly<Record<Mark, string>> = Object.freeze({ done: SETUP_WORDS.markDone, active: SETUP_WORDS.markActive, failed: SETUP_WORDS.markFailed, test: SETUP_WORDS.testMode, todo: SETUP_WORDS.markTodo });

/** Where a step stands in the run, as its tick shows it. */
export function markOf(step: SetupStep, setup: Pick<SetupState, 'phase' | 'step' | 'done'>): Mark {
  if (setup.done.includes(step)) return 'done';
  if (setup.step !== step) return 'todo';
  if (setup.phase === 'running') return 'active';
  if (setup.phase === 'stopped') return 'failed';
  return setup.phase === 'test' ? 'test' : 'todo';
}

/** A tick: done, under way (a turning arc), stopped, test mode (a dash) or next (an empty ring). */
function MarkIcon({ mark }: { readonly mark: Mark }) {
  return (
    <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="13" className="sh-setup__ring" />
      {mark === 'done' ? <path d="M10 16.5l4 4 8-9" className="sh-setup__glyph" /> : null}
      {mark === 'active' ? <path d="M16 3a13 13 0 0 1 13 13" className="sh-setup__arc" /> : null}
      {mark === 'failed' ? <path d="M11.5 11.5l9 9M20.5 11.5l-9 9" className="sh-setup__glyph" /> : null}
      {mark === 'test' ? <path d="M10.5 16h11" className="sh-setup__glyph" /> : null}
    </svg>
  );
}

/** A transaction: its explorer page on Sepolia, its short hash elsewhere (the local alpha chain has no explorer). */
function TxLink({ hash, chainId }: { readonly hash: `0x${string}`; readonly chainId: number | null }) {
  const href = chainId === null || chainId === SEPOLIA ? testnetExplorerHref({ chainId: SEPOLIA, txHash: hash }) : null;
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" title={hash}><code>{shortAddress(hash)}</code><span className="sh-visually-hidden"> (opens the explorer in a new tab)</span></a>
    : <code title={hash}>{shortAddress(hash)}</code>;
}

export function SetupPanel({ offer, note = null, onManual, manualHref = null, onNotNow = null, onClose, coinsLink = false, api, loadPrivy = loadPrivyBridge,
  appId: givenAppId, target: givenTarget, timing }: SetupPanelProps) {
  const appId = givenAppId === undefined ? privyAppIdOf() : givenAppId;
  const wallet = useWallet();
  const data = useDataSource();
  useSetupWallet();
  const setup = useSetupState();
  // Armed a moment after the panel appears: a tap that was meant for what stood there before does not land on a press.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(timer);
  }, []);
  // A wallet's own window is open (a browser wallet asking, or the made wallet coming back): its answer comes first.
  const asking = wallet.status === 'connecting';
  const ready = armed && !asking;
  const run = useRef<HTMLDivElement>(null);
  const shownRun = useRef(setup.run);
  // A press replaces the buttons with the run: the focus moves to the run, not to the page's top.
  useEffect(() => {
    if (setup.run === shownRun.current) return;
    shownRun.current = setup.run;
    run.current?.focus({ preventScroll: true });
  }, [setup.run]);

  /** The press: the wallet context's ticket is taken here, before any wait (as "Make me a wallet" takes it). */
  const press = () => {
    if (!ready) return;
    const ticket = wallet.resumeProvidedWallet?.() ?? null;
    const target = givenTarget ? givenTarget() : (() => {
      try { return coinTargetOf(sourceV2(data.id, BUILD_CORE)); } catch { return { ok: false as const, reason: 'source_unavailable' }; }
    })();
    void runSetup({ api, privy: madeWalletBridge(loadPrivy, appId), ticket, target, ...(timing ? { timing } : {}) });
  };
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    // A plain click goes through the app's router (the welcome step's own navigate); a modified one opens a tab as usual.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (armed) onManual?.();
  };
  const manual = !onManual ? null : manualHref
    ? <a className="sh-setup__manual" href={manualHref} aria-disabled={!armed || undefined} onClick={follow}>{SETUP_WORDS.manualThere}</a>
    : <button type="button" className="sh-setup__manual" disabled={!armed} onClick={onManual}>{SETUP_WORDS.manual}</button>;
  const notNow = onNotNow ? <button type="button" className="sh-setup__manual" disabled={!armed} onClick={onNotNow}>{SETUP_WORDS.notNow}</button> : null;

  if (setup.phase === 'idle') {
    return (
      <div className="sh-setup" data-view="offer">
        {note ? <p className="sh-setup__note" role="status">{note}</p> : null}
        <div className="sh-setup__actions">
          <button type="button" className="sh-button sh-button--primary sh-setup__go" disabled={!ready} aria-busy={(armed && asking) || undefined} onClick={press}>
            {offer === 'finish' ? SETUP_WORDS.finish : SETUP_WORDS.start}
          </button>
          {manual}
          {notNow}
        </div>
        <Details name={SETUP_WORDS.whatHappens}>
          <ul className="sh-setup__what">
            {SETUP_DETAILS.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </Details>
      </div>
    );
  }

  const claim = setup.claim;
  // A lapsed sign-in: the sign-in is the one action that helps, so it is the primary one and Try again waits for it.
  const signIn = setup.phase === 'stopped' && setup.signIn !== null;
  const sent = claim ? [claim.admitTx, claim.sendTx].filter((hash): hash is `0x${string}` => hash !== null) : [];
  return (
    <div ref={run} className="sh-setup" data-view="run" tabIndex={-1} data-phase={setup.phase} aria-busy={setup.phase === 'running' || undefined}>
      {setup.phase === 'done' ? (
        <dl className="sh-setup__figures">
          <div><dt>{SETUP_WORDS.sepEth}</dt><dd>{setup.figures ? pAmountV2(setup.figures.sepEth, 18) : NO_FIGURE}</dd></div>
          <div><dt>{SETUP_WORDS.teth}</dt><dd>{setup.figures ? pAmountV2(setup.figures.teth, 18) : NO_FIGURE}</dd></div>
        </dl>
      ) : null}
      <ol className="sh-setup__steps" aria-label={SETUP_WORDS.stepsLabel}>
        {SETUP_STEPS.map((step) => {
          const mark = markOf(step, setup);
          return (
            <li key={step} className="sh-setup__step" data-mark={mark} aria-current={mark === 'active' ? 'step' : undefined}>
              <span className="sh-setup__dot"><MarkIcon mark={mark} /></span>
              <span className="sh-setup__name">{STEP_NAMES[step]}</span>
              <span className="sh-visually-hidden">{`: ${MARK_WORDS[mark]}`}</span>
            </li>
          );
        })}
      </ol>
      {setup.line ? <p className="sh-setup__line" role="status">{setup.line}</p> : null}
      {setup.phase !== 'running' ? (
        <div className="sh-setup__actions">
          {signIn ? <a className="sh-button sh-button--primary sh-setup__go" href={setup.signIn === 'privy' ? JOIN_THEN_EXPORT : '/join'}>{CLAIM_WORDS.joinPage}</a> : null}
          {setup.phase === 'stopped' && setup.retry && !signIn ? (
            <button type="button" className="sh-button sh-button--primary sh-setup__go" disabled={!ready} aria-busy={(armed && asking) || undefined} onClick={press}>{SETUP_WORDS.tryAgain}</button>
          ) : null}
          {/* The app's pages only (inside their router): the test-coin page, for later drips and swaps (af1 F4). */}
          {coinsLink && (setup.phase === 'done' || setup.phase === 'test') ? <Link className="sh-button" to="/test-coins">{SETUP_WORDS.coinsPage}</Link> : null}
          <button type="button" className="sh-button" disabled={!armed} onClick={onClose}>{SETUP_WORDS.close}</button>
          {setup.phase === 'stopped' ? manual : null}
        </div>
      ) : null}
      {setup.address || sent.length > 0 || setup.drip ? (
        <Details name={SETUP_WORDS.facts}>
          <dl className="sh-setup__facts">
            {setup.address ? <div><dt>{SETUP_WORDS.stepWallet}</dt><dd><code title={setup.address}>{shortAddress(setup.address)}</code></dd></div> : null}
            {sent.length > 0 ? <div><dt>{SETUP_WORDS.stepCoins}</dt><dd>{sent.map((hash) => <TxLink key={hash} hash={hash} chainId={setup.chainId} />)}</dd></div> : null}
            {setup.drip ? <div><dt>{SETUP_WORDS.stepTeth}</dt><dd><TxLink hash={setup.drip} chainId={setup.chainId} /></dd></div> : null}
          </dl>
        </Details>
      ) : null}
    </div>
  );
}
