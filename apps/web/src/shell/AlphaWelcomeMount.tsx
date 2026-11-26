import { Suspense, lazy, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { AlphaMe } from '../features/alpha-sepolia/alpha-api';
import { ALPHA_ON, ALPHA_OPEN } from '../features/alpha-sepolia/alpha-on';
import { useTermsAccess } from '../features/legal';
import { useWallet } from '../features/wallet';
import { SignInIcon } from './icons';
import { PartBoundary, PartFailed } from './PartFailed';
import { setupChipSlot, subscribeSetupChipSlot } from './setup-chip-slot';

/**
 * F166 (SH-ALPHA-ONBOARDING): the trade folders' fourth door, the Sepolia alpha's welcome step on the app's pages
 * (features/trade-sepolia/AlphaWelcome.tsx: "Set me up" or "I'll do it myself" for an approved tester not set up yet).
 * `import.meta.env.SH_SEPOLIA_TRADE` is a build literal (build-target.ts `sepoliaTradeOf`): `false` in the mainnet
 * build, so both branches below and their dynamic imports fold away and nothing of the alpha enters the bundle; `true`
 * in the Sepolia build (and a dev opt-in). Behind the notice's gate like the wallet button: nothing loads before the
 * notice is accepted. Then two lazy steps, so the trade code loads only for a tester the step is for:
 * 1. the gate (features/alpha-sepolia/welcome-gate.ts, a small chunk of the alpha's own): our server's `GET /alpha/me`
 *    once per visit and this device's hint;
 * 2. when the signed-in visitor has a remembered wallet, the gate finds an offer, or a run shows (the gate's run
 *    signal, alpha-sepolia/setup-signal.ts), the slot's module through this door (the same module as the box page's slot
 *    and the test-coin route, so the trade code stays one lazily loaded chunk). The step then keeps the run's chip in
 *    the top bar on every page (af2).
 * build-target.test.ts pins this door.
 *
 * SH-275: on an open site (BNB Chain testnet with its own Privy app, alpha-on.ts `ALPHA_OPEN`: no page lock in front),
 * a visitor our server knows no sign-in for gets one entry in the top bar's setup place (setup-chip-slot.ts), a link to
 * the join page in the join page's own button text ("Sign in with X"). The site stays open to look at either way, and a
 * browser wallet keeps working without any sign-in.
 */
const AlphaWelcome = import.meta.env?.SH_SEPOLIA_TRADE === true ? lazy(() => import('../features/trade-sepolia/TradeSlot').then((module) => ({ default: module.AlphaWelcome }))) : null;
const LOAD_GATE = import.meta.env?.SH_SEPOLIA_TRADE === true ? () => import('../features/alpha-sepolia/welcome-gate') : null;

type Gate = { readonly module: typeof import('../features/alpha-sepolia/welcome-gate'); readonly me: AlphaMe | null; readonly stranger: boolean };

const noRun = () => () => undefined;
const notLive = () => false;
const noSlot = () => null;

/**
 * SH-246 (finding 11.3): the line when the step's chunk fails to load or the step fails while drawing (before, the step
 * simply did not appear). Behind the same build literal as the door, so the mainnet build carries neither the step nor
 * these words.
 */
const WELCOME_FAILED = import.meta.env?.SH_SEPOLIA_TRADE === true ? 'The setup step hit a problem.' : null;

/**
 * SH-258: the welcome step is the alpha's; a test network without the alpha never asks for it. SH-275: the switch is
 * alpha-on.ts's (BNB Chain testnet only with its own Privy app), behind the trade literal like the doors above.
 */
const ALPHA_GATE = import.meta.env?.SH_SEPOLIA_TRADE === true && ALPHA_ON;
/** SH-275: the open site's entry to the join page (no page lock in front of the pages). */
const OPEN_SITE = import.meta.env?.SH_SEPOLIA_TRADE === true && ALPHA_OPEN;

/** The shell's mount for the welcome step: nothing at all unless this build carries the trade code. */
export function AlphaWelcomeMount() {
  const accepted = useTermsAccess();
  const wallet = useWallet();
  const [gate, setGate] = useState<Gate | null>(null);
  // Once the step had something for this tester in this visit, it stays mounted (its run, its end, its Close).
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (LOAD_GATE === null || !ALPHA_GATE || !accepted || gate !== null) return undefined;
    let live = true;
    void LOAD_GATE().then(async (module) => {
      const visitor = await module.welcomeVisitor();
      if (live) setGate({ module, me: visitor === 'stranger' ? null : visitor, stranger: visitor === 'stranger' });
    }, () => undefined);
    return () => { live = false; };
  }, [accepted, gate]);

  // The hint is read again on every render (each navigation renders the shell), and a run of this visit, wherever it
  // started, opens the step at once: its chip shows in the top bar on the next page too.
  const live = useSyncExternalStore(gate?.module.subscribeSetupRun ?? noRun, gate?.module.setupRunLive ?? notLive, notLive);
  const ownWallet = wallet.status !== 'disconnected' && wallet.signer?.confirmsInPage !== true;
  const offer = gate?.me ? gate.module.welcomeOffer(gate.me, gate.module.readSetupHint(gate.me.handle), ownWallet) : null;
  if ((offer !== null || live) && !opened) setOpened(true);
  // SH-275: the open site's entry, in the top bar's setup place, for a visitor without a sign-in (and no run of this visit).
  const slot = useSyncExternalStore(subscribeSetupChipSlot, setupChipSlot, noSlot);
  const entry = OPEN_SITE && accepted && gate?.stranger === true && !live && slot !== null
    ? createPortal((
      // SH-277: on a phone the bar shows the icon alone; the words stay in the link as its accessible name.
      <a className="sh-topbar__join" href={gate.module.JOIN_PATH}>
        <span className="sh-topbar__join-icon" aria-hidden="true"><SignInIcon /></span>
        <span className="sh-topbar__join-text">{gate.module.JOIN_ENTRY}</span>
      </a>
    ), slot)
    : null;
  const resume = gate?.me != null && gate.module.rememberedMadeWallet() !== null;
  if (AlphaWelcome === null || WELCOME_FAILED === null || !accepted || gate === null || !(opened || offer !== null || live || resume)) return entry;
  // While the step's chunk loads nothing shows (as before); a step that failed says so, with Reload (SH-246).
  return <PartBoundary fallback={<PartFailed line={WELCOME_FAILED} />}><Suspense fallback={null}><AlphaWelcome me={gate.me} /></Suspense></PartBoundary>;
}
