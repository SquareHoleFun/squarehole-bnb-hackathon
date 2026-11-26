/**
 * F166 (SH-ALPHA-ONBOARDING): "Set me up", the Sepolia alpha's automated onboarding (the founder, 2026-11-01: "In
 * automated all these steps are taken for the user"). ONE press runs, in order, each step skipped when already done:
 * 1. wallet: the wallet Privy made for this X account, or a new one (`makeWallet`), connected as the app's wallet through
 *    the wallet context's ticket taken on the press, as the Claim card's "Make me a wallet" connects it. Never over a
 *    wallet of the tester's own: one connected stops the run before Privy is asked, and one still asking (its window
 *    open) is waited for, as XR-ALPHA-SITE af3 has its answer come first; the made wallet's own reconnect on load
 *    (made-wallet.ts) counts as ours (af1 F7);
 * 2. claim: while our server holds no claim for the account (or only the sender's dry run, which frees it), the exact
 *    claim text for that wallet's address, signed by it (no window: Privy's are off, so the press is the confirmation)
 *    and queued, as the Claim card's "Sign and claim" does. A claim this device's setup did not make (by hand, or on
 *    another device) is never taken for its own (af1 F6);
 * 3. coins, read from the CHAIN as they land (af2, the founder: "handle that long time frame"): done as soon as the
 *    faucet admits the wallet AND it holds SepETH for the drip's gas, at the latest block, in either order and however
 *    far apart (faucet-due.ts `coinsReady`); the chain and the claim are read again every 5 s, for at most a quarter of
 *    an hour. The sender's receipt meanwhile decides a refusal, a failure and the dry run (test mode, nothing sent; the
 *    next visit offers "Finish setup"), and records the send; a sign-out or a removal ends the wait with its own line;
 * 4. tETH: the faucet's FIRST drip from that wallet (the test-coin page's "Get 1 tETH"), as soon as step 3 is done,
 *    through the guarded coin sender in the account's one slot (trade-inflight.ts), held while anything of the account's
 *    is still pending, as the faucet card holds; a wallet that dripped before is done here, and any later drip needs its
 *    own press (af1);
 * 5. done: the wallet's SepETH and tETH, read at one block.
 * The run goes on in the background while the visitor uses the app (af2): its chip in the top bar (SetupChip.tsx) shows
 * the ticks on every page, and its end a short toast.
 * Nothing runs on load or on navigation: only `runSetup`, from a press ("Set me up", "Finish setup", "Try again"), and
 * only these steps. A step that cannot go on stops the run there with one line and, where another press can help, "Try
 * again", which runs the same steps again from where our server, the chain and Privy stand (never "no wallet" when Privy
 * could not say: XR-ALPHA-SITE af2). The run lives in this module, one at a time for the whole visit, so the app's pages
 * (AlphaWelcome.tsx) and the Claim card show the same run while the visitor moves between them. This device's hint
 * (alpha-sepolia/setup-hint.ts) records how far it got and the claim it made.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { prepareFaucetSepolia, readCoinStateSepolia, submitCoinWriteSepolia, TradeRefusedError, type CoinState } from '@squarehole/chain/trade-sepolia';
import { createChainReader, type Eip1193Request } from '@squarehole/chain/write';
import { zeroAddress, type Address, type Hex } from 'viem';
import type { AlphaApi, ClaimState } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS, JOIN_WORDS, SETUP_WORDS, claimLine, claimReleased, refusalLine } from '../alpha-sepolia/alpha-words';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { readSetupHint, writeSetupHint } from '../alpha-sepolia/setup-hint';
import { noteSetupRun } from '../alpha-sepolia/setup-signal';
import { useWallet, type ProvidedResume, type WalletContextValue } from '../wallet';
import { signClaimText } from './claim-sign';
import type { CoinTarget, CoinTargetRead } from './coin-target';
import { DRIP, coinsReady, dripGasNeed, dripWaitReason, gasPriceOf } from './faucet-due';
import { MADE_WALLET_ID, MADE_WALLET_NAME } from './made-wallet';
import { beginInFlight, endInFlight, inFlightOf, sendKey, updateInFlight, type SentStep } from './trade-inflight';
import { balanceOf, noncesOf, readTwice, revertReasonOf, sendFailure, settleSend, type SendTrack } from './trade-run';
import { tradeLine } from './trade-words';

export type SetupStep = 'wallet' | 'claim' | 'coins' | 'teth';
export const SETUP_STEPS: readonly SetupStep[] = Object.freeze(['wallet', 'claim', 'coins', 'teth']);

/**
 * Where the visit's run stands: `idle` (none, or its end was closed), `running`, `stopped` (a step could not go on),
 * `test` (the sender's dry run: nothing was sent) or `done`.
 */
export type SetupPhase = 'idle' | 'running' | 'stopped' | 'test' | 'done';

export interface SetupState {
  readonly phase: SetupPhase;
  /** The step under way, or the one the run stopped (or ended in test mode) at; null when idle or done. */
  readonly step: SetupStep | null;
  /** The steps done, or found done, in this run. */
  readonly done: readonly SetupStep[];
  /** One short line: what is under way, or why the run stopped. */
  readonly line: string | null;
  /** Whether another press can help: not after the sender refused or failed, nor for a claim made another way. */
  readonly retry: boolean;
  /**
   * Stopped because a sign-in lapsed: Privy's in this browser (the panel links the join page's own "Sign in with X",
   * `JOIN_THEN_EXPORT`), or ours (the join page). The sign-in is then the panel's one primary action.
   */
  readonly signIn: 'privy' | 'ours' | null;
  /** The made wallet's address, once Privy gave it. */
  readonly address: Address | null;
  /** The claim as our server last showed it (queued, or the sender's receipt). */
  readonly claim: ClaimState | null;
  /** The chain the coins and the drip are on (the explorer's links name it). */
  readonly chainId: number | null;
  /** The drip's transaction, once the wallet gave its hash. */
  readonly drip: Hex | null;
  /** The made wallet's SepETH and tETH at one block, once done (null when that read failed: never shown as zero). */
  readonly figures: { readonly sepEth: bigint; readonly teth: bigint } | null;
  /** Counts the presses of this visit. */
  readonly run: number;
}

const IDLE: SetupState = Object.freeze({ phase: 'idle', step: null, done: Object.freeze([]), line: null, retry: true, signIn: null, address: null, claim: null, chainId: null, drip: null, figures: null, run: 0 });

/** The wallet context as the run reads it (the setup's pages note it on every render, `useSetupWallet`). */
export type SetupWallet = Pick<WalletContextValue, 'status' | 'account' | 'chainId' | 'signer' | 'switchChain'>;

/** How long the run waits, and the clock it reads (tests pass their own). */
export interface SetupTiming {
  /** How often a queued claim is read again (the Claim card's `CLAIM_POLL_MS`), and for how long at most. */
  readonly pollMs: number;
  readonly pollLimitMs: number;
  /** How often, and how long, the chain is read for the coins once the sender says it sent them (a node may lag). */
  readonly chainMs: number;
  readonly chainLimitMs: number;
  /** How often a sent drip is looked for, and how long its receipt is waited for (use-sends.ts's own figures). */
  readonly miningMs: number;
  readonly receiptMs: number;
  /** How long the wallet context may take to show a wallet connected, switched, or still asking, on the run's behalf. */
  readonly walletMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const SETUP_TIMING: SetupTiming = Object.freeze({
  pollMs: 5_000,
  pollLimitMs: 15 * 60_000,
  chainMs: 4_000,
  chainLimitMs: 2 * 60_000,
  miningMs: 1_500,
  receiptMs: 300_000,
  walletMs: 5_000,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

export interface SetupDeps {
  readonly api: AlphaApi;
  /** Privy's bridge for this page (made-wallet.ts `madeWalletBridge`), or null while the Privy app ID is the placeholder. */
  readonly privy: Promise<PrivyBridge> | null;
  /** The wallet context's ticket, taken on the press (null in a build without provided wallets). */
  readonly ticket: ProvidedResume | null;
  /** Where the coins are, or why there are none here (coin-target.ts), as the press found it. */
  readonly target: CoinTargetRead;
  /** The wallet context as it is now; the setup's pages keep it current (`useSetupWallet`). */
  readonly wallet?: () => SetupWallet | null;
  readonly timing?: Partial<SetupTiming>;
}

// --- the visit's one run --------------------------------------------------------------------------------------------

let state: SetupState = IDLE;
let running: Promise<void> | null = null;
let noted: SetupWallet | null = null;
/** The setup's pages mounted now, each noting the wallet context: the last one to go leaves the run no wallet view. */
let noters = 0;
/** "I'll do it myself" was pressed in this visit (the Claim card then opens on today's steps). */
let manual = false;
const listeners = new Set<() => void>();

function publish(next: Partial<SetupState>): void {
  state = Object.freeze({ ...state, ...next });
  for (const listener of [...listeners]) listener();
  noteSetupRun(state.phase !== 'idle');
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => state;

/** The visit's run, as the setup's pages show it. */
export function useSetupState(): SetupState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The same, outside React: the run as it stands now, and a listener for each change. */
export const setupState = snapshot;
export const subscribeSetup = subscribe;

/**
 * The wallet context as the run reads it, noted by every page that shows the setup. When none is mounted any more, the
 * run has no view of the wallet, and stops at its next wallet check rather than sign or send on a stale one (af1).
 */
export function useSetupWallet(): void {
  const wallet = useWallet();
  useEffect(() => {
    noters += 1;
    return () => {
      noters = Math.max(0, noters - 1);
      if (noters === 0) noted = null;
    };
  }, []);
  useEffect(() => {
    noted = wallet;
  }, [wallet]);
}

/** The run's end (done, test mode, a stop) put away: the pages go back to what they show without a run. */
export function closeSetup(): void {
  if (running === null && state.phase !== 'running') publish({ ...IDLE, run: state.run });
}

/** "I'll do it myself", pressed on any of the setup's pages in this visit. */
export const chooseManual = (): void => { manual = true; };
export const manualChosen = (): boolean => manual;

/** For the tests: a fresh visit. */
export function resetSetupForTests(): void {
  state = IDLE;
  running = null;
  noted = null;
  noters = 0;
  manual = false;
  listeners.clear();
  noteSetupRun(false);
}

/**
 * The press: runs the steps, from the first one not done, unless a run is under way already (then that one goes on).
 * Resolves when the run has ended, whichever way.
 */
export function runSetup(deps: SetupDeps): Promise<void> {
  if (running) return running;
  const timing: SetupTiming = { ...SETUP_TIMING, ...deps.timing };
  publish({ ...IDLE, phase: 'running', line: SETUP_WORDS.reading, run: state.run + 1 });
  running = (async () => {
    try {
      await steps(deps, timing, deps.wallet ?? (() => noted));
    } catch {
      // Nothing here should throw; if something does, the run says where it stopped and the press can try again.
      if (state.phase === 'running') publish({ phase: 'stopped', line: tradeLine('not_sent'), retry: true });
    } finally {
      running = null;
    }
  })();
  return running;
}

// --- the steps ------------------------------------------------------------------------------------------------------

const same = (a: string | null | undefined, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** The made wallet is the app's wallet now: connected, the page's own (no window), at its address. */
const holdsMade = (wallet: SetupWallet | null, made: MadeWallet): wallet is SetupWallet =>
  wallet !== null && wallet.status === 'connected' && wallet.signer?.confirmsInPage === true && same(wallet.account, made.address);

/** A wallet of the tester's own (a browser wallet) is the app's wallet now; a wallet the page holds itself is not one. */
const ownWallet = (wallet: SetupWallet | null): boolean => wallet !== null && wallet.status === 'connected' && wallet.signer?.confirmsInPage !== true;

/** Why the made wallet is not the app's wallet at a later step: another wallet took its place, or none is connected. */
const walletLine = (wallet: SetupWallet | null): string => (ownWallet(wallet) ? SETUP_WORDS.walletTaken : SETUP_WORDS.walletNone);

async function until(test: () => boolean, ms: number, timing: SetupTiming): Promise<boolean> {
  const end = timing.now() + ms;
  while (!test()) {
    if (timing.now() >= end) return false;
    await timing.sleep(50);
  }
  return true;
}

interface StopOptions {
  readonly retry?: boolean;
  readonly signIn?: SetupState['signIn'];
}
/** The run stops at `step`; one that no press can help ends this device's setup (its hint), so no page offers it again. */
function stop(step: SetupStep | null, line: string, options: StopOptions = {}, handle: string | null = null): void {
  const retry = options.retry ?? true;
  if (!retry && handle !== null) writeSetupHint({ handle, state: 'ended' });
  publish({ phase: 'stopped', step, line, retry, signIn: options.signIn ?? null });
}
function begin(step: SetupStep, line: string): void {
  publish({ step, line });
}
function finished(step: SetupStep): void {
  if (!state.done.includes(step)) publish({ done: Object.freeze([...state.done, step]) });
}

async function steps(deps: SetupDeps, timing: SetupTiming, wallet: () => SetupWallet | null): Promise<void> {
  // Where this X account stands with our server.
  const me = await deps.api.me();
  if (!me.ok) return stop(null, refusalLine(me), { signIn: me.status === 401 ? 'ours' : null });
  if (me.value.status !== 'approved') return stop(null, me.value.status === 'removed' ? JOIN_WORDS.removed : CLAIM_WORDS.notApproved, { retry: false });
  const handle = me.value.handle;
  const end = (step: SetupStep, line: string, options: StopOptions = {}) => stop(step, line, options, handle);
  let claim = me.value.claim;
  publish({ claim });
  // A claim this device's setup did not make (by hand on the Claim card, or on another device) is not its own: nothing is
  // made or asked for it (af1 F6). Only the sender's dry run frees a claim for a fresh one.
  const hint = readSetupHint(handle);
  const ours = hint !== null && (hint.state === 'started' || hint.state === 'done') && claim !== null && hint.claimId === claim.id;
  if (claim !== null && !claimReleased(claim) && !ours) return end('claim', SETUP_WORDS.claimedAlready, { retry: false });
  writeSetupHint({ handle, state: 'started', claimId: claim !== null && !claimReleased(claim) ? claim.id : null });

  // 1. The wallet Privy made (or makes now), as the app's wallet; never over a wallet of the tester's own.
  begin('wallet', SETUP_WORDS.making);
  if (!(await until(() => wallet()?.status !== 'connecting', timing.walletMs, timing))) return stop('wallet', SETUP_WORDS.walletAsking);
  if (ownWallet(wallet())) return stop('wallet', SETUP_WORDS.walletTaken);
  if (deps.privy === null) return stop('wallet', CLAIM_WORDS.madeWalletFailed, { retry: false });
  let made: MadeWallet;
  try {
    const privy = await deps.privy;
    await privy.ready();
    if (!privy.authenticated()) {
      // Not ready, or signed out: Privy's own record tells them apart (it throws when it did not load, and answers no
      // wallet when signed out). A Privy that never got ready is not a lapsed sign-in.
      try {
        await privy.madeWallet();
      } catch {
        return stop('wallet', SETUP_WORDS.privyNotReady);
      }
      if (!privy.authenticated()) return stop('wallet', CLAIM_WORDS.signInAgain, { signIn: 'privy' });
    }
    made = await privy.makeWallet();
  } catch {
    return stop('wallet', CLAIM_WORDS.madeWalletFailed);
  }
  publish({ address: made.address });
  if (!holdsMade(wallet(), made)) {
    // The ticket was taken on the press: a wallet the person connected or let go meanwhile ends it, and stays as it is.
    // The made wallet's own reconnect on load may be connecting it right now (made-wallet.ts): that one is ours.
    try {
      if (deps.ticket !== null) await deps.ticket.connect({ id: MADE_WALLET_ID, name: MADE_WALLET_NAME, provider: made.provider });
    } catch {
      return stop('wallet', CLAIM_WORDS.madeWalletFailed);
    }
    await until(() => holdsMade(wallet(), made) || ownWallet(wallet()), timing.walletMs, timing);
    if (!holdsMade(wallet(), made)) return stop('wallet', walletLine(wallet()));
  }
  finished('wallet');

  // 2. The claim, signed by that wallet, unless our server holds this setup's one already (only a dry run's frees it).
  if (claim === null || claimReleased(claim)) {
    begin('claim', SETUP_WORDS.signing);
    const text = await deps.api.claimMessage(made.address);
    if (!text.ok) return stop('claim', refusalLine(text), { signIn: text.status === 401 ? 'ours' : null });
    const now = wallet();
    if (!holdsMade(now, made) || now.signer === null) return stop('claim', walletLine(now));
    const signed = await signClaimText(now.signer.request, made.address, text.value.message);
    if (!signed.ok) return stop('claim', signed.reason === 'declined' ? CLAIM_WORDS.declined : CLAIM_WORDS.walletFailed);
    const sent = await deps.api.claim({ address: text.value.address, message: text.value.message, signature: signed.signature });
    if (!sent.ok) return stop('claim', refusalLine(sent), { signIn: sent.status === 401 ? 'ours' : null });
    claim = sent.value;
    writeSetupHint({ handle, state: 'started', claimId: claim.id });
    publish({ claim });
  }
  finished('claim');

  // 3. The coins, from the chain as they land: on the faucet's list AND SepETH for the drip's gas, at the latest block,
  // in either order; the sender's receipt meanwhile decides a refusal, a failure and the dry run, and records the send.
  // Without the coins' record on this site (coin-target.ts), the receipt alone decides; the drip needs the record.
  const target = deps.target.ok ? deps.target.target : null;
  const noTarget = deps.target.ok ? null : deps.target.reason;
  if (target !== null) publish({ chainId: target.chainId });
  begin('coins', claim.status === 'sent' ? SETUP_WORDS.arriving : claimLine(claim));
  const since = timing.now();
  let sentSince: number | null = null;
  let unread = 0;
  let coins: ChainState | null = null;
  while (coins === null) {
    if (claimReleased(claim)) {
      // The sender's dry run: nothing was sent, and the claim is free again; the next visit offers "Finish setup".
      writeSetupHint({ handle, state: 'started', claimId: claim.id });
      return publish({ phase: 'test', step: 'coins', line: SETUP_WORDS.testMode, retry: false });
    }
    if (claim.status !== 'queued' && claim.status !== 'waiting' && claim.status !== 'sending' && claim.status !== 'sent') return end('coins', claimLine(claim), { retry: false });
    if (claim.status !== 'sent' && state.line !== claimLine(claim)) publish({ line: claimLine(claim) });
    if (target === null || noTarget !== null) {
      if (claim.status === 'sent') return stop('coins', tradeLine(noTarget ?? 'source_unavailable'));
    } else if (claim.status === 'sent' && sentSince === null) {
      sentSince = timing.now();
      // The sender's send names the wallet the claim went to: a claim for another wallet brings no coins here.
      if (claim.sendTx !== null) {
        const send = await createChainReader(target.rpc).getTransaction(claim.sendTx).catch(() => null);
        if (send?.to && !same(send.to, made.address)) return end('coins', SETUP_WORDS.otherWallet, { retry: false });
      }
    }
    const read = target === null ? null : await chainState(target, made.address);
    if (read?.ok && target !== null) {
      unread = 0;
      const listed = read.state.faucet.admitted || read.state.faucet.open;
      // Ready for the drip, or past it already (a setup that dripped before this device lost track): no gas is needed.
      if (arrived(read) || (listed && firstDripTaken(read.state, target))) {
        coins = read;
        break;
      }
      // On the list, the SepETH still on its way (the sender confirms the admission first): said so.
      const line = claim.status === 'sent' ? SETUP_WORDS.arriving : claimLine(claim);
      if (state.line !== line) publish({ line });
    } else if (read !== null && !read.ok && (unread += 1) >= 3) {
      // Three reads in a row failed (each tried twice): said, never taken for zero.
      return stop('coins', tradeLine(read.reason));
    }
    // Sent by the receipt, yet a node behind the sender's does not show them: read again for a while, then said.
    if (sentSince !== null && timing.now() - sentSince >= timing.chainLimitMs) return stop('coins', SETUP_WORDS.coinsLate);
    if (timing.now() - since >= timing.pollLimitMs) return stop('coins', `${claimLine(claim)} Check again.`);
    await timing.sleep(timing.pollMs);
    if (claim.status !== 'queued' && claim.status !== 'waiting' && claim.status !== 'sending') continue;
    const next = await deps.api.claimState(claim.id);
    if (next.ok) {
      claim = next.value;
      publish({ claim });
    } else if (next.status === 401) {
      // Signed out meanwhile (here, or in another tab), or the session ran out: said now, not after the wait.
      return stop('coins', refusalLine(next), { signIn: 'ours' });
    } else if (next.status === 403 && next.error === 'approval required') {
      // Removed (or set back to pending) meanwhile: the join page's own line, said now. Not this device's end: an
      // approval later offers the setup again.
      const who = await deps.api.me();
      return stop('coins', who.ok && who.value.status === 'removed' ? JOIN_WORDS.removed : CLAIM_WORDS.notApproved, { retry: false });
    } else if (next.status >= 400 && next.status < 500) {
      // The claim gone, or another refusal: our server's own answer, said now.
      return stop('coins', refusalLine(next));
    }
    // No answer, one this page cannot read, or our server down for a moment: the next round asks again.
  }
  if (target === null) return stop('coins', tradeLine(noTarget ?? 'source_unavailable'));
  finished('coins');

  // 4. The FIRST tETH only: a wallet that dripped before (the faucet sets its next drip at the first one) or holds a
  // drip's worth already is done here; a later drip needs its own press.
  begin('teth', SETUP_WORDS.dripping);
  let atLeast = 0n;
  let attempts = 0;
  const heldSince = timing.now();
  while (!firstDripTaken(coins.state, target)) {
    const wait = dripWaitReason(coins.state);
    if (wait !== null) return stop('teth', tradeLine(wait));
    if (attempts >= 2) return stop('teth', tradeLine('earlier_send'));
    const now = wallet();
    if (!holdsMade(now, made)) return stop('teth', walletLine(now));
    if (now.chainId !== target.chainId) {
      try {
        await now.switchChain(target.chainId);
      } catch {
        return stop('teth', tradeLine('wallet_chain'));
      }
      if (!(await until(() => wallet()?.chainId === target.chainId, timing.walletMs, timing))) return stop('teth', tradeLine('wallet_chain'));
    }
    const outcome = await dripOnce(target, made.address, () => {
      const live = wallet();
      return holdsMade(live, made) ? live.signer : null;
    }, timing, (hash) => publish({ drip: hash }));
    if (outcome.kind === 'mined') {
      atLeast = outcome.block;
      break;
    }
    if (outcome.kind === 'pending') return stop('teth', tradeLine('receipt_timeout'));
    if (outcome.kind === 'refused' && outcome.reason === 'earlier_send') {
      // Something of the account's is still pending (a drip from another tab, or one sent before a reload): nothing new
      // is sent behind it, as the faucet card holds; the chain is read again until it settles (that drip may be the one).
      if (timing.now() - heldSince >= timing.receiptMs) return stop('teth', tradeLine('earlier_send'));
      await timing.sleep(timing.miningMs);
      const later = await chainState(target, made.address);
      if (!later.ok) return stop('teth', tradeLine(later.reason));
      coins = later;
      continue;
    }
    attempts += 1;
    if (outcome.kind === 'refused' && outcome.reason !== 'cooldown_active') return stop('teth', tradeLine(outcome.reason));
    if (outcome.kind === 'reverted' && outcome.reason !== 'cooldown_active') return stop('teth', tradeLine(outcome.reason));
    // The cooldown (a drip another tab or the faucet card took first), a replacement, an unclear answer, or a send of the
    // account's that settled first: the chain decides, at or after that send's block. Only the last case may send.
    const again = await chainState(target, made.address, outcome.kind === 'again' ? outcome.block : 0n);
    if (!again.ok) return stop('teth', tradeLine(again.reason));
    coins = again;
    if (outcome.kind !== 'again' && !firstDripTaken(coins.state, target)) {
      return stop('teth', tradeLine(outcome.kind === 'replaced' ? 'replaced' : outcome.kind === 'unclear' ? outcome.reason : 'cooldown_active'));
    }
  }
  finished('teth');

  // 5. Done: the figures, at one block (at or after the drip's own).
  const final = await chainState(target, made.address, atLeast);
  writeSetupHint({ handle, state: 'done', claimId: claim.id });
  const teth = final.ok ? tethOf(final.state, target) : null;
  publish({ phase: 'done', step: null, line: SETUP_WORDS.done, figures: final.ok && teth !== null ? Object.freeze({ sepEth: final.sepEth, teth }) : null });
}

// --- the chain ------------------------------------------------------------------------------------------------------

interface ChainState {
  readonly ok: true;
  readonly state: CoinState;
  readonly sepEth: bigint;
  /** What the drip's gas needs at the chain's gas price now (faucet-due.ts `dripGasNeed`). */
  readonly need: bigint;
}
type ChainRead = ChainState | { readonly ok: false; readonly reason: string };

/**
 * The made wallet's faucet facts, coin balances and SepETH at one mined block (at least `atLeast`), with the site's RPC,
 * and what the drip's gas needs at the gas price now; a failed read is tried once more a second later (`readTwice`),
 * then said, never taken for zero.
 */
async function chainState(target: CoinTarget, address: Address, atLeast = 0n): Promise<ChainRead> {
  try {
    return await readTwice(async () => {
      const block = await createChainReader(target.rpc).blockNumber();
      if (block < atLeast) throw new TradeRefusedError('block_unavailable');
      const coins = await readCoinStateSepolia({ rpc: target.rpc, chainId: target.chainId, from: address, blockNumber: block,
        ...(target.localDeployment ? { localDeployment: target.localDeployment } : {}) });
      const sepEth = await balanceOf(target.rpc, zeroAddress, address, block);
      return { ok: true as const, state: coins, sepEth, need: dripGasNeed(await gasPriceOf(target.rpc)) };
    });
  } catch (error) {
    return { ok: false, reason: error instanceof TradeRefusedError ? error.reason : 'rpc_failed' };
  }
}

/** The sender's coins are there: the faucet admits the wallet (or is open to all) and it holds SepETH for the drip's gas. */
const arrived = (read: ChainState): boolean => coinsReady(read.state.faucet, read.sepEth, read.need);

const tethOf = (coins: CoinState, target: CoinTarget): bigint | null => coins.balances.find((row) => same(row.coin, target.teth.address))?.balance ?? null;

/** The first drip is behind this wallet: the faucet set its next drip (it does at the first one), or it holds a drip's worth. */
function firstDripTaken(coins: CoinState, target: CoinTarget): boolean {
  const teth = tethOf(coins, target);
  return coins.faucet.nextDripAt > 0n || (teth !== null && teth >= DRIP);
}

type DripOutcome =
  | { readonly kind: 'mined'; readonly hash: Hex; readonly block: bigint }
  /** Nothing was sent: the plan or the guard refused, something of the account's is still pending, or the wallet declined. */
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'reverted'; readonly reason: string }
  | { readonly kind: 'replaced' }
  /** No receipt to follow: settled by the account's nonce (`sent_unseen`, or `not_sent`). */
  | { readonly kind: 'unclear'; readonly reason: string }
  /** Still under way when the wait ended: the account's slot stays held, and the next look follows it. */
  | { readonly kind: 'pending' }
  /** Another send of this account held the slot and has settled now (mined at `block`, 0 when not seen mined). */
  | { readonly kind: 'again'; readonly block: bigint };

/**
 * The faucet's drip from the made wallet: a fresh plan (`prepareFaucetSepolia`), the account's one slot taken before the
 * wallet is asked, held while anything of the account's is still pending (a reload or a second tab: the faucet card's own
 * hold), one request through the guarded coin sender (`submitCoinWriteSepolia`), then the chain's answer (`settleSend`),
 * as use-sends.ts sends the faucet card's drip. A send of the account already under way in this page (an earlier try's,
 * the faucet card's) is followed to its end first, and never doubled.
 */
async function dripOnce(target: CoinTarget, from: Address, signer: () => { readonly request: Eip1193Request } | null, timing: SetupTiming,
  onHash: (hash: Hex) => void): Promise<DripOutcome> {
  const slot = sendKey(target.chainId, from);
  const earlier = inFlightOf(slot);
  if (earlier) {
    if (earlier.asking) {
      await timing.sleep(timing.miningMs);
      return { kind: 'again', block: 0n };
    }
    const outcome = await follow(target, from, slot, earlier.id, earlier.sent, earlier.track, timing);
    return outcome.kind === 'pending' ? outcome : { kind: 'again', block: outcome.kind === 'mined' ? outcome.block : 0n };
  }
  const prepared = await prepareFaucetSepolia({ rpc: target.rpc, chainId: target.chainId, from, ...(target.localDeployment ? { localDeployment: target.localDeployment } : {}) });
  if (!prepared.ok) return { kind: 'refused', reason: prepared.reason };
  const { plan } = prepared;
  if (plan.call === null) return { kind: 'refused', reason: 'not_sent' };
  const sent: SentStep = { step: 'trade', plan, call: plan.call, gasLimit: plan.gasLimit };
  const blank: SendTrack = { nonceBefore: null, hash: null, quietReads: 0, quietSince: null };
  const id = beginInFlight(slot, { sent, asking: true, track: blank });
  if (id === null) return { kind: 'again', block: 0n };
  // The account's pending nonce before the wallet is asked: unread, nothing is asked (no later look could tell); one
  // ahead of the mined one, something of the account's is still pending, and nothing new is sent behind it.
  const nonces = await noncesOf(target.rpc, from).catch(() => null);
  const wallet = signer();
  if (nonces === null || wallet === null || nonces.pending > nonces.latest) {
    endInFlight(slot, id);
    return { kind: 'refused', reason: nonces === null ? 'rpc_failed' : wallet === null ? 'wallet_account' : 'earlier_send' };
  }
  const track: SendTrack = { ...blank, nonceBefore: nonces.pending };
  updateInFlight(slot, id, { track });
  let hash: Hex;
  try {
    hash = await submitCoinWriteSepolia({ wallet: wallet.request, rpc: target.rpc, chainId: target.chainId, call: plan.call, from, gasLimit: plan.gasLimit, plan });
  } catch (error) {
    const failure = sendFailure(error);
    if (failure.kind === 'not_sent') {
      endInFlight(slot, id);
      return { kind: 'refused', reason: failure.reason };
    }
    // An unclear answer: the wallet may have sent it. The slot stays, and the account's nonce decides.
    updateInFlight(slot, id, { asking: false });
    return follow(target, from, slot, id, sent, track, timing);
  }
  const hashed: SendTrack = { ...track, hash };
  updateInFlight(slot, id, { asking: false, track: hashed });
  onHash(hash);
  return follow(target, from, slot, id, sent, hashed, timing);
}

/** Follows a send in the account's slot until the chain mines, replaces or settles it, or the receipt wait ends. */
async function follow(target: CoinTarget, from: Address, slot: string, id: number, sent: SentStep, start: SendTrack, timing: SetupTiming): Promise<DripOutcome> {
  const end = timing.now() + timing.receiptMs;
  let track = start;
  for (;;) {
    try {
      const outcome = await settleSend(target.rpc, from, track, timing.now());
      if (outcome.kind !== 'waiting') {
        endInFlight(slot, id);
        if (outcome.kind === 'mined') {
          if (outcome.receipt.status === 'reverted') return { kind: 'reverted', reason: await revertReasonOf(target.rpc, from, sent.call, sent.gasLimit, outcome.receipt.blockNumber) };
          return { kind: 'mined', hash: outcome.receipt.transactionHash, block: outcome.receipt.blockNumber };
        }
        if (outcome.kind === 'replaced') return { kind: 'replaced' };
        return { kind: 'unclear', reason: outcome.sent ? 'sent_unseen' : 'not_sent' };
      }
      track = outcome.track;
      updateInFlight(slot, id, { track });
    } catch {
      // A failed read: look again.
    }
    if (timing.now() >= end) return { kind: 'pending' };
    await timing.sleep(timing.miningMs);
  }
}
