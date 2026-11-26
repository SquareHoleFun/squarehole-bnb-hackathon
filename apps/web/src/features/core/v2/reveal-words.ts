/**
 * SH-203: every text the creator's "Reveal items" view and the hidden-draw opener show, in one place. The founder
 * approved this wording on 16 November 2026 (desk round 95: ten lines changed, the rest as built; desk round 96: the
 * two lines of af6). A new or changed sentence is his to approve. docs/evidence/SH-203.md lists each text,
 * where it shows and when. Numbers first, words short; the reason codes of the reveal session (reveal-session.ts) map to
 * one plain line each, and a code without a line falls back to `REASON_FALLBACK` with the code behind Details.
 */
import { formatToken } from '../../fit-pair/fit-format';
import { NATIVE_SYMBOL } from '../../data-source/native-coin';

export const REVEAL_WORDS = {
  /** The box page's entry, for the creator while items are left. */
  entry: 'Reveal items',
  title: 'Reveal items',
  back: 'Back to the box',
  revealed: 'Revealed',
  left: 'Left',
  final: 'Final',
  inFlight: 'In flight',
  inFlightHelp: 'Includes sends waiting for confirmation.',
  /** In flight when it cannot be known: another tab holds the run, or a batch is out without its items. */
  unknown: 'Unknown',
  transactions: 'Transactions',
  mostCost: 'Most it can cost',
  spent: 'Earlier sends, at most',
  reserved: 'This run so far, at most',
  prepare: 'Prepare',
  start: 'Start',
  stop: 'Stop',
  tryAgain: 'Try again',
  chooseFile: 'Choose box file',
  otherFile: 'Use another box file',
  fileLabel: 'Box file',
  exportRecord: 'Download run record',
  details: 'Details',
  connect: 'Connect the wallet that made this box, on this box’s network.',
  loading: 'Reading this box…',
  needsFile: 'No box file found in this browser. Choose the one you saved.',
  busy: 'Working…',
  ready: 'Ready. Prepare shows the cost first.',
  planReady: 'Check the cost, then Start.',
  allDone: 'All items revealed.',
  allLatest: 'All revealed. Waiting for the chain to make it final.',
  cancelled: 'Stopped. Nothing more is sent.',
  phase: {
    running: 'Revealing…',
    wallet: 'Confirm in your wallet.',
    receipt: 'Sent. Checking for inclusion.',
    confirmation: 'In a block. Confirming.',
    finality: 'In a block. Waiting for it to be final.',
  },
  /** The two reason owners, each on its own line when both are set. */
  pollOwner: 'Reading',
  actionOwner: 'Last action',
  /** The sends this browser is still checking. */
  attempts: 'Sends to check',
  attemptItems: (count: number) => (count === 1 ? '1 item' : `${count} items`),
  attemptHash: (hash: string) => `Sent · ${hash.slice(0, 10)}…`,
  attemptNotSaved: 'Not saved in this browser yet. Download the run record.',
  /**
   * SH-203 af6 (C-L1), the founder's words (desk round 96, 16 November 2026): a send with an id that the last read did
   * not find (the transaction read and the receipt read each answered nothing).
   */
  attemptGone: 'Not found on the network at the last check.',
  attemptNoHash: 'No transaction id. It may still go out.',
  release: 'Release',
  releaseWait: (minutes: number) => `At the last check: ${minutes} more ${minutes === 1 ? 'minute' : 'minutes'} with this tab open before release. Press Release to check again. A reload starts the wait again.`,
  releaseFacts: 'This send may still go out. Release only if your wallet shows nothing pending. If both go out, both can cost up to their limit.',
  /**
   * SH-203 af6 (C-L1), the founder's words (desk round 96, 16 November 2026): the release facts for a wallet that signs
   * on the press and keeps no pending list (`confirmsInPage`).
   */
  releaseFactsInPage: 'The old send may still go through. If both go through, you pay gas for both.',
  releaseCost: 'Its limit',
  releaseConfirm: 'Release it',
  releaseDone: 'Released. You can send again.',
  /** Pictures, sent to our server when picture hosting is on. */
  pictures: 'Pictures',
  sendPictures: 'Send pictures',
  picturesReady: (ready: bigint, total: bigint) => `${ready}/${total} items with pictures ready`,
  picturesProgress: (done: bigint, total: bigint) => `${done}/${total} items checked`,
  picturesNoTransport: 'This site cannot send pictures. Pictures already hosted can still be checked.',
  picturesOff: 'The picture upload was not confirmed. Revealing does not need it.',
  picturesLater: 'Some pictures are still waiting. Send again later.',
  picturesFailed: (count: number) => (count === 1 ? '1 picture could not be sent.' : `${count} pictures could not be sent.`),
  picturesNeedFile: 'Choose the full box file to send missing pictures.',
  picturesNotInFile: (count: number) => (count === 1 ? '1 picture is not in this file. Choose the full box file.' : `${count} pictures are not in this file. Choose the full box file.`),
} as const;

/** The hidden-draw opener (HiddenDrawsV2.tsx), on the reveal session's two presses. */
export const HIDDEN_OPEN_WORDS = {
  open: 'Open',
  ask: (item: bigint) => `Open item ${item}?`,
  cost: 'Most it can cost',
  spentBefore: 'Earlier sends for this item, at most',
  together: 'Together at most',
  confirm: 'Confirm open',
  waiting: 'Waiting for confirmation…',
  sent: (item: bigint) => `Sent · item ${item}.`,
  /** An approval the session withdrew (its journal changed) before the second press. */
  withdrawn: 'This approval no longer holds. Press Open again.',
  preparing: 'Working out the cost…',
  readingFile: 'Reading the reveal file…',
} as const;

/**
 * SH-203 on the line: the Items card's line on a tile whose item is not revealed yet (VaultItemsV2.tsx), tied to its
 * disabled button. The founder's words (desk round 95, 16 November 2026: "Not revealed yet" as built).
 */
export const ITEM_NOT_REVEALED = 'Not revealed yet';

export const REASON_FALLBACK = 'Something went wrong. Nothing more is sent.';

/** One plain line per reason code the session, its engines and its storage report. */
export const REASON_WORDS: Readonly<Record<string, string>> = Object.freeze({
  // The run (reveal-items.ts RevealReason).
  'wrong-chain': 'This box is on another network.',
  'wrong-registry': 'The registry does not match this box.',
  'wrong-token': 'The token does not match this box.',
  'wrong-creator': 'Only the wallet that made this box can reveal its items.',
  'wrong-spec': 'The box settings do not match.',
  'wrong-code': 'This box’s contracts do not match. Nothing more was sent.',
  'read-chain-changed': 'The network changed. Nothing more was sent. Prepare again.',
  'wrong-commitment': 'This box file does not match the items on chain.',
  'wrong-mode': 'This box does not support this reveal action.',
  'invalid-source': 'Could not read this box file or the chain. Try again, or choose another file.',
  'invalid-plan': 'The plan changed. Prepare again.',
  'plan-changed': 'Something changed since Prepare. Prepare again.',
  'estimate-failed': 'The cost could not be worked out. Try again.',
  'simulation-failed': 'A test run of the next batch failed. Nothing more was sent.',
  'gas-cap': 'One item does not fit in a transaction.',
  // SH-258 round 3: the chain's price (BNB Chain testnet), said as itself; the approved spending ceiling stays.
  'gas-price-unread': 'The network gave no usable gas price; nothing was sent. Try again.',
  'gas-price-high': 'The network asks more for gas than this site offers; nothing was sent.',
  'gas-price-rose': 'The network’s gas price rose; nothing was sent. Prepare again to see the new cost.',
  'read-failed': 'Could not read the chain. Try again.',
  'store-failed': 'Something could not be saved or read. Download the run record, then try again.',
  'progress-invalid': 'The run saved in this browser could not be read. Try again later.',
  'unknown-send': 'A send may or may not have gone out. Check your wallet.',
  'receipt-pending': 'Not confirmed yet at the last check.',
  reorg: 'The chain changed its last blocks. Try again.',
  'wallet-refused': 'The wallet said no. Nothing more was sent.',
  'account-changed': 'The wallet account changed. Nothing more is sent.',
  'chain-changed': 'The wallet network changed. Nothing more is sent.',
  cancelled: 'Stopped. Nothing more is sent.',
  'running-elsewhere': 'Another tab was working on this box at the last check.',
  'pictures-running-elsewhere': 'Another tab was checking pictures at that press. Try again.',
  'lock-unavailable': 'This browser cannot keep tabs apart. No further send can start.',
  'revert-limit': 'Too many batches failed on chain. Stopped.',
  'inner-failure-limit': 'Too many items failed. Stopped.',
  'awaiting-finality': 'Not final yet at the last check.',
  'release-too-soon': 'Release was too soon at the last check. Press Release to check again.',
  'release-not-allowed': 'This send cannot be released.',
  // Hidden openings (reveal-hidden.ts HiddenWait).
  randomness: 'No random number yet when you pressed.',
  settlement: 'The draw had not settled when you pressed.',
  finality: 'Not final yet when you pressed.',
  grace: 'When you pressed, only the wallet that drew it could open this item.',
  closed: 'This draw is closed.',
  'missing-proof': 'The reveal file does not hold this item.',
  'invalid-caller': 'This wallet cannot open this draw.',
  changed: 'The draw changed. Open again.',
  'send-refused': 'The opening was refused. Nothing was sent.',
  // The session itself (reveal-session.ts).
  'user-press-required': 'Press the button again.',
  'action-unavailable': 'Busy. Try again in a moment.',
  'wrong-identity': 'Connect the wallet that made this box, on its network.',
  // Storage (reveal-indexeddb.ts).
  'storage-unavailable': 'The run could not be read or saved here. No further send can start.',
  'storage-full': 'This browser is out of space for the run.',
  'storage-conflict': 'Another tab saved first. Try again.',
  'storage-invalid': 'The run saved in this browser could not be read. Try again later.',
});

/**
 * SH-203 af2: the lines that depend on who reports the code. The session's reads retry by themselves, and so does a first
 * read of the box that failed on the chain (the page makes the session again); an action does not.
 */
const RETRYING_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'read-failed': 'Could not read the chain. Trying again.',
  reorg: 'The chain changed its last blocks. Checking again.',
  'storage-conflict': 'Another tab saved first. Checking again.',
});
/** Codes of a failed first read that the page retries by itself (a passing chain or storage hiccup, not a wrong file). */
export const RETRIED_SOURCE_CODES: ReadonlySet<string> = new Set(['read-failed', 'reorg', 'storage-conflict']);
/** Who reports a code: the session's own reads (`poll`), a press (`action`), or the first read of the box (`source`). */
export type ReasonOwner = 'poll' | 'action' | 'source';

/** The line for a reason code and its owner: its own, or the fallback (the code then shows behind Details). */
export const reasonText = (code: string, owner: ReasonOwner = 'action'): string =>
  (owner === 'poll' || (owner === 'source' && RETRIED_SOURCE_CODES.has(code)) ? RETRYING_WORDS[code] : undefined) ?? REASON_WORDS[code] ?? REASON_FALLBACK;

/** ETH rounded UP at 6 decimals: a cost is never shown below what may be spent. */
export const ethUp = (wei: bigint): string => formatToken(((wei + 10n ** 12n - 1n) / 10n ** 12n) * 10n ** 12n, NATIVE_SYMBOL, { digits: 6 });
