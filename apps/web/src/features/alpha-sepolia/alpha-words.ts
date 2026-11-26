/**
 * F161 (4), SH-ALPHA-SITE: the lines of the alpha's join page, its Claim card and the founder's desk. Minimal text
 * (the founder's rule): what happened, in a few words; the reason codes themselves are never shown. Draft words: the
 * founder edits them (the session's alpha-notice/draft.md lists each one, old and new).
 *
 * No trade marker of production-check.ts belongs here, and no host name of Privy's: the join page loads this module at
 * first paint, where the Sepolia check refuses both.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';
import type { AlphaResult, ClaimState } from './alpha-api';
import { DRY_RUN_REASON } from './alpha-api';

/**
 * SH-275: the same sentences on another test network (BNB Chain testnet), the network's coin names swapped in from its
 * profile ("test BNB", the starter in tBNB). Its tETH faucet is open to every wallet (no admission step: the sender
 * sends the starter only), so the words that say the claim opens the faucet are cut to the starter there.
 * Sepolia's words stay the literal strings they were.
 */
const SEPOLIA = TESTNET.name === 'sepolia';
const NATIVE = TESTNET.coin.symbol;
const STARTER = TESTNET.coin.walletSymbol;
/**
 * SH-284: the starter the alpha's sender sends on BNB Chain testnet, as the founder asked it be said ("then the judges
 * understand that they get gas sent to them now"). The site does not read it: it is the service's chain table
 * (infra/server/services/alpha/chains.mjs, chain 97: 15,000,000,000,000,000 wei since SH-284b), which a test pins to this
 * figure.
 */
export const BNB_STARTER_AMOUNT = '0.015';

export const JOIN_WORDS = Object.freeze({
  title: 'Square Hole alpha',
  signIn: 'Sign in with X',
  // SH-220: under each "Sign in with X", on phones only (join.css): the founder's approved words, 15 November 2026.
  phoneLogin: 'On a phone, X asks you to log in once. That’s X, not us.',
  signingIn: 'Signing in…',
  checking: 'Checking your sign-in…',
  pending: 'You’re on the list.',
  pendingHint: 'We let you in once we approve your X account.',
  approved: 'You’re in.',
  openApp: 'Open the app',
  claim: SEPOLIA ? 'Claim test ETH' : `Claim test ${NATIVE}`,
  removed: 'Your access has ended.',
  removedHint: 'A wallet Privy made for you stays yours: export its key below.',
  signOut: 'Sign out',
  signedOut: 'Signed out.',
  // XR-ALPHA-SITE af2: our sign-out went through, Privy's (in this browser) did not happen.
  signedOutHere: 'Signed out here; Privy’s own sign-in in this browser may still be on.',
  exportWallet: 'Export wallet key',
  noMadeWallet: 'Privy made no wallet for this X account.',
  // XR-ALPHA-SITE af2: our sign-in is still on, Privy's in this browser has lapsed; the member view offers the sign-in.
  exportSignIn: 'Sign in with X again first, then export.',
  // XR-ALPHA-SITE af3: Privy's export window did not open (its code, readiness or wallet frame failed); both pages.
  exportFailed: 'Export did not open. Try again.',
  closed: 'New sign-ups are closed.',
  intakeUnknown: 'Sign-up availability could not be checked. Try again.',
  notSetUp: 'Sign-in is not set up yet.',
  agreeFirst: 'Tick the box above first.',
  thirdParty: 'Third-party notices',
});

/** Why a call to our server did not go through, as one short line (the status and reason come from alpha-api.mjs). */
export function refusalLine(result: Extract<AlphaResult<unknown>, { ok: false }>): string {
  if (result.status === 0) return 'No answer from our server. Try again.';
  if (result.status === -1) return 'Our server sent an answer this page cannot read.';
  if (result.status === 401) return result.error === 'expired identity' ? 'Your X sign-in expired. Sign in again.' : 'Sign in with X again.';
  if (result.status === 403) return result.error === 'approval required' ? 'Your X account is not approved for this.' : 'This page must be opened at its own address.';
  if (result.status === 409) return 'This X account or wallet has claimed already.';
  if (result.status === 429 && ['new signups closed', 'signup cap reached'].includes(result.error)) return JOIN_WORDS.closed;
  if (result.status === 429) return 'Today’s claims are used up. Try again tomorrow.';
  if (result.status === 404) return 'Not found.';
  if (result.status === 400 && result.error === 'invalid signature') return 'The signature did not match this wallet.';
  if (result.status === 400 && result.error === 'claim message mismatch') return 'That claim text expired. Get a new one.';
  if (result.status >= 500) return 'The alpha service is not available. Try again later.';
  return 'Request refused.';
}

export const CLAIM_WORDS = Object.freeze({
  title: 'Claim',
  lead: SEPOLIA ? 'Starter SepETH and the tETH faucet, for one wallet.' : `Starter ${STARTER}, for one wallet.`,
  useMine: 'Use my wallet',
  makeOne: 'Make me a wallet',
  making: 'Making your wallet…',
  getText: 'Claim',
  gettingText: 'Getting the claim text…',
  youSign: 'You sign',
  sign: 'Sign and claim',
  signBrowser: 'Confirm in your wallet…',
  signMade: 'Signing…',
  sending: 'Sending the claim…',
  cancel: 'Cancel',
  exportKey: 'Export key',
  signInAgain: 'Sign in with X again to make a wallet.',
  joinPage: 'Open the sign-in page',
  // XR-ALPHA-SITE af1: the join page (sign-out and the made wallet's export), from every signed-in card.
  walletPage: 'Sign-in and wallet',
  notSignedIn: 'Sign in with X to claim.',
  notApproved: 'Your X account is not approved yet.',
  declined: 'You declined the signature. Nothing was sent.',
  walletFailed: 'The wallet did not sign. Nothing was sent.',
  madeWalletFailed: 'Privy could not make a wallet. Try again.',
  // XR-ALPHA-SITE af3: Privy made the wallet, but the person chose or let go of a wallet meanwhile, so it waits.
  madeWalletWaits: 'Your wallet is made. Press Make me a wallet to use it.',
  wallet: 'Wallet',
});

/** A claim's state, as one short line. */
export function claimLine(claim: ClaimState): string {
  switch (claim.status) {
    case 'queued': return claim.position === undefined ? 'Claim queued.' : `Claim queued: position ${claim.position}.`;
    case 'sending': return 'Sending your starter coins.';
    case 'waiting': return 'Waiting: the faucet is being refilled.';
    case 'sent': return SEPOLIA ? 'Sent: your starter SepETH and tETH faucet access.' : `Sent: your starter ${STARTER}.`;
    case 'skipped': return claim.reason === DRY_RUN_REASON ? 'Not sent: a dry run. Claim again later.' : 'Not sent.';
    case 'refused': return 'Refused. Nothing was sent.';
    case 'failed': return 'It did not go through. We look into it.';
  }
}

/** Whether a claim leaves room for a fresh one: only the sender's exact dry-run receipt does (alpha-api.mjs `releaseDry`). */
export const claimReleased = (claim: ClaimState | null): boolean => claim === null
  || (claim.status === 'skipped' && claim.reason === DRY_RUN_REASON && claim.admitTx === null && claim.sendTx === null);

/**
 * F166 (SH-ALPHA-ONBOARDING): "Set me up", the automated onboarding (trade-sepolia/setup-run.ts), on the app's pages
 * (trade-sepolia/AlphaWelcome.tsx) and at the top of the Claim card. Numbers first, a word per step; what the press does
 * waits behind a closed Details button. Draft words: the founder edits them.
 */
export const SETUP_WORDS = Object.freeze({
  title: 'Get set up',
  // SH-284: on BNB Chain testnet the lead names the gas the starter is (the founder's ask, 26 November 2026).
  lead: SEPOLIA ? 'A wallet, test ETH and your first tETH. One press.' : `A wallet, ${BNB_STARTER_AMOUNT} ${STARTER} for gas and 1 tETH to play with. One press.`,
  start: 'Set me up',
  finish: 'Finish setup',
  manual: 'I’ll do it myself',
  // The welcome step's own way to today's steps, which live on the test-coin page: it says it goes there (af1 F3).
  manualThere: 'I’ll do it myself on Test coins',
  notNow: 'Not now',
  coinsPage: 'Test coins',
  // A second device, a tester set up elsewhere: the wallet Privy made, connected on the press (af1 F5).
  useMade: 'Use the wallet Privy made',
  stepsLabel: 'Setup steps',
  stepWallet: 'Wallet',
  stepClaim: 'Claim',
  stepCoins: SEPOLIA ? 'Coins' : STARTER,
  stepTeth: 'tETH',
  markDone: 'done',
  markActive: 'under way',
  markTodo: 'next',
  markFailed: 'stopped here',
  reading: 'Reading your sign-in…',
  making: 'Making your wallet…',
  signing: 'Signing your claim…',
  waiting: 'Claim queued.',
  arriving: SEPOLIA ? 'Coins sent. Waiting for the chain…' : `${STARTER} sent. Waiting for the chain…`,
  dripping: 'Getting 1 tETH…',
  done: 'You’re set up.',
  testMode: 'Test mode: nothing was sent.',
  tryAgain: 'Try again',
  close: 'Close',
  walletTaken: 'Another wallet is in use. Disconnect it, then try again.',
  walletNone: 'No wallet is connected now. Try again.',
  walletAsking: 'A wallet is still asking you. Answer it first.',
  onItsWay: SEPOLIA ? 'On the list. Your starter SepETH is on its way.' : `On the list. Your starter ${STARTER} is on its way.`,
  privyNotReady: 'Privy did not answer. Try again.',
  claimedAlready: 'This X account has claimed already.',
  coinsLate: 'The coins have not shown up yet. Check again.',
  otherWallet: 'This X account claimed for another wallet.',
  stillQueued: 'Claim queued. Check again.',
  sepEth: SEPOLIA ? 'SepETH' : STARTER,
  teth: 'tETH',
  // The run's chip in the top bar (af2): a name, a few words for where it stands, the steps done.
  chipName: 'Setup',
  chipRunning: 'Setting up',
  chipStopped: 'Setup stopped',
  chipTest: 'Test mode',
  chipDone: 'You’re set',
  ofFour: 'of 4 steps done',
  dismiss: 'Dismiss',
  // What each Details button opens (its accessible name: "Details: <name>").
  whatHappens: 'What happens',
  facts: 'Wallet and transactions',
});

/** What "Set me up" does, behind its Details button (never open by default). */
export const SETUP_DETAILS: readonly string[] = Object.freeze([
  'Privy makes a wallet for you, or uses the one it made.',
  'It signs the claim that links your X account to that wallet.',
  SEPOLIA ? 'Our server sends it starter SepETH and opens the tETH faucet for it.' : `Our server sends it starter ${STARTER}.`,
  'Then it takes 1 tETH from the faucet.',
  'It runs in the background: browse the boxes meanwhile.',
  'No window opens: this press is your one confirmation.',
  'Every later trade or drip needs its own press.',
]);

export const DESK_WORDS = Object.freeze({
  title: 'Alpha desk',
  approve: 'Approve',
  remove: 'Remove',
  reset: 'Reset',
  confirm: 'Confirm',
  cancel: 'Cancel',
  refresh: 'Refresh',
  empty: 'No sign-ups yet.',
  loading: 'Reading the sign-ups…',
  accessExpired: 'No answer. Your Access sign-in may have expired: reload the page.',
});

/** What a decision does, as its confirmation question. */
export function decisionQuestion(decision: 'approve' | 'remove' | 'reset', handle: string): string {
  if (decision === 'approve') return `Let @${handle} in?`;
  if (decision === 'remove') return `End @${handle}’s access?`;
  return `Put @${handle} back on the list?`;
}
