/**
 * F161 (4), SH-ALPHA-SITE, work package E: the Claim card, at the top of the test-coin page (TestCoinPage.tsx). An
 * approved tester claims starter SepETH and the tETH faucet for one wallet (docs/design/alpha-access-privy.md § 2,
 * § 6):
 * 1. a wallet: "Use my wallet" (a browser wallet, EIP-6963, as everywhere in the app) or "Make me a wallet" (the wallet
 *    Privy makes, made-wallet.ts; offered, never forced);
 * 2. "Claim" asks our server for the exact claim text for that address (`GET /alpha/claim/message?address=`) and
 *    shows it, word for word;
 * 3. "Sign and claim" is the one press that signs exactly that text (claim-sign.ts): a browser wallet shows its own
 *    window; the made wallet signs on the press, with no window of Privy's (the card says "Signing…");
 * 4. the signed text goes to our server (`POST /alpha/claim`), and the card follows the claim
 *    (`GET /alpha/claim/<id>`) until the sender's receipt says what happened.
 * One claim per X account and per address; our server and the sender both hold to that. Only the sender's exact
 * dry-run receipt frees a fresh claim (`claimReleased`). The made wallet's export is on the card while that wallet is
 * in use or remembered here, and every signed-in card links the join page ("Sign-in and wallet": sign-out and the
 * export, which asks Privy on the press), whatever wallet is chosen, remembered or let go, and after a claim
 * (XR-ALPHA-SITE af1). Minimal text: the status line, the address, the text to sign; nothing else.
 *
 * F166 (SH-ALPHA-ONBOARDING): until the tester is set up, the card leads with the automated path, "Set me up"
 * (SetupPanel.tsx, setup-run.ts: the wallet Privy makes, this claim signed by it, the coins and the first tETH, in one
 * press), with the steps above behind the small "I'll do it myself", unchanged. What it offers is the app pages' own rule
 * (welcome-gate.ts `welcomeOffer`, af1): the choice while no claim stands (or only one the sender's dry run freed) and no
 * wallet of the tester's own is connected; "Finish setup" (one press; it never resumes by itself) for a setup this device
 * left midway, for its own claim only; a run of this visit until its end is closed. A browser wallet connected, today's
 * steps chosen on this device (the hint) or a claim made on them (recorded so) get today's steps at once. A standing
 * claim with no wallet connected (another device) offers the wallet Privy made, connected on the press (af1).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TESTNET, testnetExplorerHref } from '../data-source/testnet';
import { alphaApi, type AlphaApi, type AlphaMe, type ClaimChallenge, type ClaimState } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS, JOIN_WORDS, SETUP_WORDS, claimLine, claimReleased, refusalLine } from '../alpha-sepolia/alpha-words';
import { JOIN_THEN_EXPORT, type PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { privyAppIdOf } from '../alpha-sepolia/privy-config';
import { readSetupHint, writeSetupHint } from '../alpha-sepolia/setup-hint';
import { welcomeOffer } from '../alpha-sepolia/welcome-gate';
import { BrowserWalletDialog, shortAddress, useWallet } from '../wallet';
import { signClaimText } from './claim-sign';
import type { CoinTargetRead } from './coin-target';
import { MADE_WALLET_ID, MADE_WALLET_NAME, madeWalletBridge, rememberedMadeWallet } from './made-wallet';
import { loadPrivyBridge } from './privy-load';
import { SetupPanel } from './SetupPanel';
import { chooseManual, closeSetup, manualChosen, setupState, subscribeSetup, useSetupState, type SetupTiming } from './setup-run';

/** How often a queued claim is read again, and for how long before the card stops and offers "Check again". */
export const CLAIM_POLL_MS = 5_000;
export const CLAIM_POLL_LIMIT_MS = 15 * 60_000;
const SEPOLIA = TESTNET.chainId;

export interface ClaimCardProps {
  /** Test seam: our server (same-origin requests otherwise). */
  readonly api?: AlphaApi;
  /** Test seam: Privy (privy-load.ts otherwise). */
  readonly loadPrivy?: (appId: string) => Promise<PrivyBridge>;
  /** Test seam: the Privy app ID (privy-config.ts otherwise; null while it is the placeholder). */
  readonly appId?: string | null;
  /** Test seam: how often a queued claim is read again. */
  readonly pollMs?: number;
  /** Test seams for "Set me up" (F166): where the coins are, and the run's waits (SetupPanel's own otherwise). */
  readonly target?: () => CoinTargetRead;
  readonly timing?: Partial<SetupTiming>;
  /** F166 af2: the claim as the card last read it, for the faucet card below (its button waits for the claim's coins). */
  readonly onClaim?: (claim: ClaimState | null) => void;
}

type Session = { readonly kind: 'loading' } | { readonly kind: 'none'; readonly line: string | null } | { readonly kind: 'member'; readonly me: AlphaMe };
type Busy = 'make' | 'use' | 'text' | 'sign' | 'send' | 'export' | null;

const explorerOf = (hash: string): string | null => testnetExplorerHref({ chainId: SEPOLIA, txHash: hash });

export function ClaimCard({ api: given, loadPrivy = loadPrivyBridge, appId: givenAppId, pollMs = CLAIM_POLL_MS, target, timing, onClaim }: ClaimCardProps = {}) {
  const [api] = useState<AlphaApi>(() => given ?? alphaApi());
  const appId = givenAppId === undefined ? privyAppIdOf() : givenAppId;
  const wallet = useWallet();
  const [session, setSession] = useState<Session>({ kind: 'loading' });
  const [claim, setClaim] = useState<ClaimState | null>(null);
  const [challenge, setChallenge] = useState<ClaimChallenge | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [line, setLine] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [pollRound, setPollRound] = useState(0);
  const opener = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // F166: the visit's "Set me up" run, and whether the tester chose today's steps instead (here, or on another page).
  const setup = useSetupState();
  const [manual, setManual] = useState(manualChosen);

  const account = wallet.status === 'connected' && wallet.kind === 'injected' && wallet.signer && wallet.account ? wallet.account : null;
  const madeInUse = wallet.signer?.confirmsInPage === true;
  const madeHere = madeInUse || rememberedMadeWallet() !== null;

  // Where this browser's sign-in stands, once.
  useEffect(() => {
    let live = true;
    void api.me().then((me) => {
      if (!live) return;
      if (me.ok) { setSession({ kind: 'member', me: me.value }); setClaim(me.value.claim); }
      else setSession({ kind: 'none', line: me.status === 401 ? null : refusalLine(me) });
    });
    return () => { live = false; };
  }, [api]);

  // F166 af2: the faucet card below learns of each claim the card reads.
  useEffect(() => { onClaim?.(claim); }, [claim, onClaim]);

  // F166: a run's claim, once it has ended, is the card's (so a closed end shows where the claim stands, as today).
  useEffect(() => subscribeSetup(() => {
    const now = setupState();
    if (now.phase !== 'running' && now.phase !== 'idle' && now.claim !== null) setClaim(now.claim);
  }), []);

  // A queued claim is read again until the sender's receipt says what happened (or for a quarter of an hour).
  const queuedId = claim?.status === 'queued' || claim?.status === 'waiting' || claim?.status === 'sending' ? claim.id : null;
  useEffect(() => {
    if (queuedId === null) return undefined;
    let live = true;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      const next = await api.claimState(queuedId);
      if (!live) return;
      if (next.ok) {
        setClaim(next.value);
        if (next.value.status !== 'queued' && next.value.status !== 'waiting' && next.value.status !== 'sending') return;
      }
      if (Date.now() - started >= CLAIM_POLL_LIMIT_MS) { setStalled(true); return; }
      timer = setTimeout(() => void look(), pollMs);
    };
    timer = setTimeout(() => void look(), pollMs);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [api, queuedId, pollMs, pollRound]);

  // A claim text stands only for the address it was issued for: another account or wallet drops it.
  const shown = challenge && account !== null && account.toLowerCase() === challenge.address.toLowerCase() ? challenge : null;

  async function makeWallet() {
    const pending = madeWalletBridge(loadPrivy, appId);
    // The wallet context's ticket, taken on the press before any wait for Privy (XR-ALPHA-SITE af2): a wallet the person
    // connects meanwhile (the top bar, the faucet or swap card) ends it, and that wallet then stays as it is.
    const ticket = wallet.resumeProvidedWallet?.() ?? null;
    if (pending === null || ticket === null) { setLine(CLAIM_WORDS.madeWalletFailed); return; }
    setBusy('make');
    setLine(null);
    try {
      const privy = await pending;
      await privy.ready();
      if (!privy.authenticated()) { setLine(CLAIM_WORDS.signInAgain); return; }
      const made = await privy.makeWallet();
      // A wallet chosen or let go meanwhile ended the ticket (XR-ALPHA-SITE af3): the made wallet waits for the next press.
      if (!(await ticket.connect({ id: MADE_WALLET_ID, name: MADE_WALLET_NAME, provider: made.provider }))) setLine(CLAIM_WORDS.madeWalletWaits);
    } catch {
      setLine(CLAIM_WORDS.madeWalletFailed);
    } finally {
      setBusy(null);
    }
  }

  /**
   * F166 af1: a tester set up on another device reaches the wallet Privy made: asked of Privy on the press (never made
   * here: `madeWallet`, never "no wallet" when Privy could not say), connected through the ticket taken on the press.
   */
  async function connectMadeWallet() {
    const pending = madeWalletBridge(loadPrivy, appId);
    const ticket = wallet.resumeProvidedWallet?.() ?? null;
    if (pending === null || ticket === null) { setLine(CLAIM_WORDS.madeWalletFailed); return; }
    setBusy('use');
    setLine(null);
    try {
      const privy = await pending;
      await privy.ready();
      if (!privy.authenticated()) { setLine(CLAIM_WORDS.signInAgain); return; }
      const made = await privy.madeWallet();
      if (made === null) { setLine(JOIN_WORDS.noMadeWallet); return; }
      if (!(await ticket.connect({ id: MADE_WALLET_ID, name: MADE_WALLET_NAME, provider: made.provider }))) setLine(CLAIM_WORDS.madeWalletWaits);
    } catch {
      setLine(SETUP_WORDS.privyNotReady);
    } finally {
      setBusy(null);
    }
  }

  async function exportKey() {
    const pending = madeWalletBridge(loadPrivy, appId);
    if (pending === null) return;
    setBusy('export');
    setLine(null);
    try {
      const privy = await pending;
      await privy.ready();
      // Whether Privy made a wallet for this X account is asked on the press, not read from this device's memory.
      if (!privy.authenticated()) setLine(JOIN_WORDS.exportSignIn);
      else if ((await privy.madeWallet()) === null) setLine(JOIN_WORDS.noMadeWallet);
      else await privy.exportWallet();
    } catch {
      setLine(JOIN_WORDS.exportFailed);
    } finally {
      setBusy(null);
    }
  }

  async function getText() {
    if (account === null) return;
    setBusy('text');
    setLine(null);
    const result = await api.claimMessage(account);
    setBusy(null);
    if (result.ok) setChallenge(result.value);
    else setLine(refusalLine(result));
  }

  async function signAndClaim() {
    const signer = wallet.signer;
    const challenge = shown;
    if (!challenge || account === null || !signer) return;
    setBusy('sign');
    setLine(null);
    const signed = await signClaimText(signer.request, account, challenge.message);
    if (!signed.ok) {
      setBusy(null);
      setLine(signed.reason === 'declined' ? CLAIM_WORDS.declined : CLAIM_WORDS.walletFailed);
      return;
    }
    setBusy('send');
    const sent = await api.claim({ address: challenge.address, message: challenge.message, signature: signed.signature });
    setBusy(null);
    setChallenge(null);
    if (sent.ok) {
      setClaim(sent.value);
      // F166 af1: a claim made on today's steps is the manual path, so no page offers "Set me up" for it.
      if (session.kind === 'member') writeSetupHint({ handle: session.me.handle, state: 'manual' });
    } else setLine(refusalLine(sent));
  }

  // "Your wallet is made" points at "Make me a wallet", which the card offers only while no wallet is in use
  // (XR-ALPHA-SITE af4): the line waits meanwhile, and shows again beside the button after a Disconnect.
  const lineUi = line && !(line === CLAIM_WORDS.madeWalletWaits && account !== null) ? <p className="sh-coins__line" role="status">{line}</p> : null;
  // While the card asks for Privy's sign-in again, its link opens the join page with "Sign in with X" offered at once
  // (XR-ALPHA-SITE af3).
  const asksSignIn = line === JOIN_WORDS.exportSignIn || line === CLAIM_WORDS.signInAgain;
  const shell = (children: ReactNode) => (
    <section className="sh-panel sh-trade-box sh-coins__card sh-claim" aria-label={CLAIM_WORDS.title} data-claim={claim?.status ?? (session.kind === 'member' ? session.me.status : session.kind)}>
      <h2 ref={heading} className="sh-coins__title" tabIndex={-1}>{CLAIM_WORDS.title}</h2>
      <p className="sh-claim__lead">{CLAIM_WORDS.lead}</p>
      {children}
      {(madeHere && appId !== null) || session.kind === 'member' ? (
        <div className="sh-trade-box__actions">
          {madeHere && appId !== null ? (
            <button type="button" className="sh-button" disabled={busy !== null} aria-busy={busy === 'export' || undefined} onClick={() => void exportKey()}>{CLAIM_WORDS.exportKey}</button>
          ) : null}
          {session.kind === 'member' ? <a className="sh-button" href={asksSignIn ? JOIN_THEN_EXPORT : '/join'}>{CLAIM_WORDS.walletPage}</a> : null}
        </div>
      ) : null}
      {lineUi}
      <BrowserWalletDialog open={dialog} onClose={() => setDialog(false)} returnFocus={opener} />
    </section>
  );

  if (session.kind === 'loading') return shell(<p className="sh-coins__line" aria-busy="true">Reading your sign-in…</p>);
  if (session.kind === 'none') {
    return shell(
      <>
        <p className="sh-coins__line" role="status">{session.line ?? CLAIM_WORDS.notSignedIn}</p>
        <div className="sh-trade-box__actions"><a className="sh-button" href="/join">{CLAIM_WORDS.joinPage}</a></div>
      </>,
    );
  }
  // A removed account reads the join page's own line (XR-ALPHA-SITE af2), not "not approved yet".
  if (session.me.status !== 'approved') return shell(<p className="sh-coins__line" role="status">{session.me.status === 'removed' ? JOIN_WORDS.removed : CLAIM_WORDS.notApproved}</p>);

  // F166: "Set me up" first, until the tester is set up; today's steps below, behind "I'll do it myself". The app pages'
  // own rule decides (af1), with the card's own claim (it follows the claim as it changes) and its wallet: a browser
  // wallet connected is today's steps; one still asking greys the presses (SetupPanel.tsx) rather than hide them.
  const handle = session.me.handle;
  const open = claim === null || claimReleased(claim);
  const offer = manual || appId === null || wallet.resumeProvidedWallet === null ? null
    : welcomeOffer({ ...session.me, claim }, readSetupHint(handle), account !== null && !madeInUse);
  const toHeading = () => heading.current?.focus({ preventScroll: true });
  if (setup.phase !== 'idle' || offer !== null) {
    return shell(
      <SetupPanel offer={offer ?? 'start'} note={claim !== null && open ? claimLine(claim) : null} api={api} loadPrivy={loadPrivy} appId={appId}
        {...(target ? { target } : {})} {...(timing ? { timing } : {})}
        onManual={() => {
          // Today's steps, here; the app's other pages ask no more on this device (a stopped run is put away with it).
          writeSetupHint({ handle, state: 'manual' });
          chooseManual();
          closeSetup();
          setManual(true);
          toHeading();
        }}
        onClose={() => { closeSetup(); toHeading(); }} />,
    );
  }

  if (claim !== null && !claimReleased(claim)) {
    const links = [claim.admitTx, claim.sendTx].filter((hash): hash is `0x${string}` => hash !== null);
    const reachMade = account === null && !madeInUse && wallet.status !== 'connected' && wallet.resumeProvidedWallet !== null && appId !== null;
    return shell(
      <>
        <p className="sh-coins__line" role="status">{claimLine(claim)}</p>
        {links.length > 0 ? (
          <ul className="sh-claim__links">
            {links.map((hash) => {
              const href = explorerOf(hash);
              return <li key={hash}>{href ? <a href={href} target="_blank" rel="noopener noreferrer" title={hash}><code>{shortAddress(hash)}</code><span className="sh-visually-hidden"> (opens the explorer in a new tab)</span></a> : <code title={hash}>{shortAddress(hash)}</code>}</li>;
            })}
          </ul>
        ) : null}
        {stalled || reachMade ? (
          <div className="sh-trade-box__actions">
            {stalled ? <button type="button" className="sh-button" onClick={() => { setStalled(false); setPollRound((round) => round + 1); }}>Check again</button> : null}
            {/* F166 af1: a claim stands and no wallet is in use here (another device): the wallet Privy made, on a press. */}
            {reachMade ? (
              <button type="button" className="sh-button" disabled={busy !== null || wallet.status === 'connecting'} aria-busy={busy === 'use' || undefined} onClick={() => void connectMadeWallet()}>
                {SETUP_WORDS.useMade}
              </button>
            ) : null}
          </div>
        ) : null}
      </>,
    );
  }

  // Approved, and no claim yet (or a dry run freed one): a wallet, then the text, then the one press.
  const released = claim !== null ? <p className="sh-coins__line" role="status">{claimLine(claim)}</p> : null;
  if (account === null) {
    return shell(
      <>
        {released}
        <div className="sh-trade-box__actions">
          <button ref={opener} type="button" className="sh-button sh-button--primary" disabled={busy !== null} onClick={() => setDialog(true)}>{CLAIM_WORDS.useMine}</button>
          {/* Not while a browser wallet's own window is open (XR-ALPHA-SITE af3): its answer comes first. */}
          {wallet.resumeProvidedWallet !== null && appId !== null ? (
            <button type="button" className="sh-button" disabled={busy !== null || wallet.status === 'connecting'} aria-busy={busy === 'make' || undefined} onClick={() => void makeWallet()}>{busy === 'make' ? CLAIM_WORDS.making : CLAIM_WORDS.makeOne}</button>
          ) : null}
        </div>
      </>,
    );
  }
  return shell(
    <>
      {released}
      <dl className="sh-trade-box__figures">
        <div><dt>{CLAIM_WORDS.wallet}</dt><dd><code title={account}>{shortAddress(account)}</code>{wallet.walletName ? <span className="sh-claim__wallet"> {wallet.walletName}</span> : null}</dd></div>
      </dl>
      {shown ? (
        <>
          <p className="sh-claim__label">{CLAIM_WORDS.youSign}</p>
          <pre className="sh-claim__text" data-claim-text>{shown.message}</pre>
          <div className="sh-trade-box__actions">
            <button type="button" className="sh-button sh-button--primary sh-trade-box__go" disabled={busy !== null} aria-busy={busy === 'sign' || busy === 'send' || undefined} onClick={() => void signAndClaim()}>
              {busy === 'sign' ? (madeInUse ? CLAIM_WORDS.signMade : CLAIM_WORDS.signBrowser) : busy === 'send' ? CLAIM_WORDS.sending : CLAIM_WORDS.sign}
            </button>
            <button type="button" className="sh-button" disabled={busy !== null} onClick={() => setChallenge(null)}>{CLAIM_WORDS.cancel}</button>
          </div>
        </>
      ) : (
        <div className="sh-trade-box__actions">
          <button type="button" className="sh-button sh-button--primary sh-trade-box__go" disabled={busy !== null} aria-busy={busy === 'text' || undefined} onClick={() => void getText()}>{busy === 'text' ? CLAIM_WORDS.gettingText : CLAIM_WORDS.getText}</button>
        </div>
      )}
    </>,
  );
}
