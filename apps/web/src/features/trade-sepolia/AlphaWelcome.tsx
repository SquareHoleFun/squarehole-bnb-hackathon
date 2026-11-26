/**
 * F166 (SH-ALPHA-ONBOARDING): the alpha's welcome step on the app's pages. The shell's mount (shell/AlphaWelcomeMount.tsx,
 * the trade folders' fourth door) opens it lazily in Sepolia trade builds once the test network notice is accepted. For
 * an approved tester who has not started setup it shows ONE choice: "Set me up" (setup-run.ts: the wallet, the claim,
 * the coins and the first tETH, in one press) or the small "I'll do it myself on Test coins" (the test-coin page's Claim
 * card and faucet, as today: the app's other pages cannot show them, so it says where it goes), and "Not now" (put away
 * for this visit; a later visit offers it again until the setup is done or today's steps were chosen). Nobody who
 * finished, chose or used today's steps, or claimed another way is asked again (welcome-gate.ts `welcomeOffer`); the
 * test-coin page shows the same choice in its Claim card instead, so this sheet stays off that page.
 *
 * Af2 (the founder, 2026-11-01: "Users don't have so much patience"): the press runs the setup in the BACKGROUND. The
 * sheet goes at once, and the run's chip in the top bar (SetupChip.tsx) shows its four ticks on every page while the
 * person browses; its details hold the line, Try again and Close. The end is said once in a short toast with the
 * numbers. After a setup this device left midway (a reload mid-run, the sender's dry run), the chip offers "Finish setup"
 * in its details (one press; a run never resumes by itself).
 *
 * Af1: the sheet is fixed at the bottom of the window, over the page, so its late arrival (our server's answer, then the
 * trade chunk) moves nothing under a finger, and its presses are armed only a moment after it appears (SetupPanel.tsx
 * `ARM_MS`). The page keeps room below its end for the sheet, so nothing stays hidden under it.
 *
 * Before any press it knows our server's answer (`GET /alpha/me`, which the shell's gate asked once,
 * alpha-sepolia/welcome-gate.ts, or this step asks when given none) and this device's hint (alpha-sepolia/setup-hint.ts);
 * a signed-in visitor's remembered made wallet can resume without a press.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { alphaApi, type AlphaApi, type AlphaMe } from '../alpha-sepolia/alpha-api';
import { SETUP_WORDS } from '../alpha-sepolia/alpha-words';
import type { PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { privyAppIdOf } from '../alpha-sepolia/privy-config';
import { readSetupHint, writeSetupHint } from '../alpha-sepolia/setup-hint';
import { welcomeOffer } from '../alpha-sepolia/welcome-gate';
import { PAGE_TITLE_ID } from '../../pages/page-parts';
import { setupChipSlot, subscribeSetupChipSlot } from '../../shell/setup-chip-slot';
import { useWallet } from '../wallet';
import type { CoinTargetRead } from './coin-target';
import { useMadeWalletResume } from './made-wallet';
import { SetupChip, SetupToast, toastWords } from './SetupChip';
import { SetupPanel } from './SetupPanel';
import { chooseManual, closeSetup, useSetupState, useSetupWallet, type SetupTiming } from './setup-run';

/** The test-coin page: its Claim card holds the same choice, so the welcome sheet stays off it. */
export const SETUP_PAGE = '/test-coins';
/** The custom property the page's room below its end reads (setup.css), as tall as the sheet. */
const ROOM = '--sh-welcome-room';

export interface AlphaWelcomeProps {
  /** Our server's answer as the shell's gate read it (null: none it could read); asked here when not given. */
  readonly me?: AlphaMe | null;
  /** Test seam: our server (same-origin requests otherwise). */
  readonly api?: AlphaApi;
  /** Test seams: Privy, its app ID, the coins and the run's waits (SetupPanel's own otherwise). */
  readonly loadPrivy?: (appId: string) => Promise<PrivyBridge>;
  readonly appId?: string | null;
  readonly target?: () => CoinTargetRead;
  readonly timing?: Partial<SetupTiming>;
}

/** Where the keyboard goes when the sheet or the chip is put away: the page's own heading, else the page itself. */
function focusPage(): void {
  const heading = document.getElementById(PAGE_TITLE_ID) ?? document.getElementById('main');
  heading?.focus({ preventScroll: true });
}


export function AlphaWelcome({ me: known, api: given, loadPrivy, appId: givenAppId, target, timing }: AlphaWelcomeProps = {}) {
  const [api] = useState<AlphaApi>(() => given ?? alphaApi());
  const appId = givenAppId === undefined ? privyAppIdOf() : givenAppId;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const wallet = useWallet();
  // The run reads the wallet context through the pages that show the setup; this step is mounted on every page.
  useSetupWallet();
  const setup = useSetupState();
  const titleId = useId();
  const sheet = useRef<HTMLElement>(null);
  // The top bar's place for the chip (TopBar.tsx renders it in Sepolia trade builds).
  const slot = useSyncExternalStore(subscribeSetupChipSlot, setupChipSlot, () => null);
  const onSetupPage = pathname.replace(/\/+$/, '') === SETUP_PAGE;
  const [me, setMe] = useState<AlphaMe | null | 'loading'>(known === undefined ? 'loading' : known);
  // Put away for the rest of the visit: "Not now", "I'll do it myself", or the run's end closed.
  const [put, setPut] = useState(false);
  // The run whose end the toast has said (one toast per run).
  const [told, setTold] = useState(0);

  // Our server, once per visit, when the step is first on a page that shows it.
  const asked = !onSetupPage || me !== 'loading';
  useEffect(() => {
    if (!asked || me !== 'loading') return undefined;
    let live = true;
    void api.me().then((answer) => {
      if (live) setMe(answer.ok ? answer.value : null);
    });
    return () => { live = false; };
  }, [api, asked, me]);

  const handle = me !== 'loading' && me !== null ? me.handle : null;
  useMadeWalletResume(loadPrivy, handle === null ? null : appId);
  const ownWallet = wallet.status !== 'disconnected' && wallet.signer?.confirmsInPage !== true;
  const offer = me === 'loading' || me === null ? null : welcomeOffer(me, readSetupHint(me.handle), ownWallet);
  const usable = appId !== null && wallet.resumeProvidedWallet !== null;
  // The sheet: the first offer only, before any run of this visit.
  const sheetShown = usable && !onSetupPage && !put && setup.phase === 'idle' && offer === 'start';
  // The chip: a run of this visit (wherever it started) until its end is closed, or "Finish setup" off the test-coin page.
  const chipOffer = usable && !onSetupPage && !put && setup.phase === 'idle' && offer === 'finish' ? 'finish' : null;
  const chipShown = usable && (setup.phase !== 'idle' || chipOffer !== null);
  const toast = told === setup.run ? null : toastWords(setup);

  // The page keeps room below its end as tall as the sheet, so its last lines can scroll above it.
  useEffect(() => {
    const root = document.documentElement;
    const node = sheet.current;
    if (!sheetShown || node === null) {
      root.style.removeProperty(ROOM);
      return undefined;
    }
    const measure = () => root.style.setProperty(ROOM, `${Math.ceil(node.getBoundingClientRect().height)}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(ROOM);
    };
  }, [sheetShown]);

  const putAway = () => {
    setPut(true);
    focusPage();
  };
  const manual = handle === null ? null : () => {
    // Today's steps live on the test-coin page: it goes there, on purpose; this device asks no more here.
    writeSetupHint({ handle, state: 'manual' });
    chooseManual();
    closeSetup();
    setPut(true);
    navigate(SETUP_PAGE);
  };
  const seams = { api, appId, ...(loadPrivy ? { loadPrivy } : {}), ...(target ? { target } : {}), ...(timing ? { timing } : {}) };
  return (
    <>
      {sheetShown ? (
        <section ref={sheet} className="sh-panel sh-welcome" aria-labelledby={titleId} data-setup={offer ?? 'start'}>
          <p id={titleId} className="sh-welcome__title">{SETUP_WORDS.title}</p>
          <p className="sh-welcome__lead">{SETUP_WORDS.lead}</p>
          <SetupPanel offer="start" {...seams} coinsLink manualHref={SETUP_PAGE} onManual={manual} onNotNow={putAway}
            onClose={() => { closeSetup(); putAway(); }} />
        </section>
      ) : null}
      {chipShown && slot !== null
        ? createPortal(
          <SetupChip offer={chipOffer} {...seams} manualHref={SETUP_PAGE} onManual={manual} onNotNow={putAway}
            onClose={() => { closeSetup(); putAway(); }} />,
          slot)
        : null}
      {/* The end, said once (a live region that is there before it). */}
      <div className="sh-setup-toasts" role="status">
        {toast !== null ? <SetupToast text={toast} onDone={() => setTold(setup.run)} /> : null}
      </div>
    </>
  );
}
