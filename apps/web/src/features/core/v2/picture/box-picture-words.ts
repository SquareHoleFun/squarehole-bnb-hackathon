/**
 * SH-255: every word the box page's picture shows or names a control with, in ONE place, so a wording change is a
 * one-line edit. Site words are imported from where the site keeps them, or copied verbatim with their file; the
 * strings marked NEW are the box-page prototype's new words (scratchpad box-page/NOTES.md § 3, built as written for the
 * founder's truth check before anything ships). The words table in docs/evidence/SH-255.md lists each one: its text,
 * where it shows, its source or NEW, and the states in which it shows.
 * Rules (CLAUDE.md, F23): no wallet mechanics, no limit of the platform's share, no checked or trusted labels, no Demo
 * label, nothing framed as earning, no control named after a trade.
 */
import { STATE_LABELS } from '../../../boxes/box-model';
import { PICTURE_WORDS } from '../../../box-picture/picture-words';
import { CLOSE_BOX, CLOSED, closableFigure } from '../v2-words';

export const BOX_PICTURE_WORDS = Object.freeze({
  // ── Site words ──────────────────────────────────────────────────────────────────────────────────────────────
  /** The explainer's hint (apps/landing/public/follow.js, approved). */
  hint: 'Tap a part to see what it does.',
  raise: PICTURE_WORDS.raise,
  deadline: PICTURE_WORDS.deadline,
  days: PICTURE_WORDS.days,
  /** LifeViewV2.tsx, the raise bar's label. */
  raised: 'Raised',
  graduated: STATE_LABELS.graduated,
  graduating: STATE_LABELS.graduating,
  upcoming: STATE_LABELS.upcoming,
  closed: CLOSED,
  /** InboxV2.tsx, its summary. */
  inbox: 'Inbox',
  /** V2BoxPage.tsx headerStatsV2, the tile. */
  burned: 'Burned',
  holders: PICTURE_WORDS.holders,
  /** V2BoxPage.tsx, the Buy-back progress card's rows. */
  spent: 'Spent',
  waitingToBurn: 'Waiting to burn',
  budget: 'Budget',
  buyBack: 'Buy-back progress',
  /** CoinPileV2.tsx, its figures. */
  seed: 'Seed',
  feesMovedIn: 'Fees moved in',
  addedByConversion: 'Added by conversion',
  leaveBehind: 'Leave behind',
  converted: (coin: string): string => `${coin} converted`,
  /** HeaderSide.tsx, a token box's peek strip. */
  noNfts: 'No NFTs · no vault',
  /** CreateV2 PickFee field and HeaderSide's own row: Put it back. */
  pickFee: 'Pick fee',
  putBack: 'Put it back',
  /** CoinPileV2 'After graduation'; HolderEarningsV2. */
  afterGraduation: PICTURE_WORDS.afterGraduation,
  /** V2BoxPage CreatorClaimV2. */
  creatorsClaim: 'Creator’s claim',
  /** V2BoxPage Fee details, word for word. */
  recordedRaise: (raise: string): string => `Recorded raise: ${raise}. Later listing changes apply only to new boxes.`,
  /** InboxV2, its first line ("Royalties in tNVDA in the box: 0 tNVDA"), and its line when unread. */
  royaltiesIn: (coin: string): string => `Royalties in ${coin} in the box`,
  balancesUnavailable: 'Current balances unavailable.',
  /** V2BoxPage, the Fees card's line. */
  everyTrade: (coin: string, ticker: string): string => `1% of every trade: in ${coin} on buys, in ${ticker} on sales`,
  /** V2BoxPage, the Graduation hatch card's two lines. */
  hatchOpen: 'Seven days since fill. Anyone may close this box.',
  hatchIn: (hours: string): string => `Anyone may close in ${hours} hours: seven days from the first fill.`,
  inboxWhy: 'Royalties and gifts in other coins arrive here.',
  /** The explainer's "Opens at graduation with tokens and price coins." (picture-words PART_WHY.pool). */
  poolOpens: 'Opens at graduation with tokens and price coins.',
  /** The explainer's slide title (examples.json `slides.fees`). */
  whereFeesGo: 'Where the fees go',
  closeBox: CLOSE_BOX,
  /** v2-words closableFigure('deadline'): a raise past its deadline, not full, not closed yet. */
  deadlinePassed: closableFigure('deadline'),
  /** EatenV2.tsx, its title, and its row of the P still waiting. */
  eaten: 'Eaten',
  waiting: 'Waiting',
  /** CoinPileV2.tsx, its title (PICTURE_WORDS.kindPile), and its row of the fees waiting for the pile. */
  coinPile: PICTURE_WORDS.kindPile,
  feesWaiting: 'Fees waiting',
  /** ShopV2.tsx, the Fees into the shop part: its title and its rows. */
  feesIntoShop: 'Fees into the shop',
  shopBudget: 'Budget',
  shopFromFees: 'From fees',
  toHolders: 'To holders',
  /**
   * SafesV2.tsx, the Safe payouts title and its two row words. A BNB Chain testnet build has no Safes and no FIT (the
   * page leaves the Safes panel out there, SH-258): the words fold away at build time and the sheet shows no block.
   */
  safePayouts: import.meta.env?.SH_BNB !== true ? 'Safe payouts' : '',
  paidToFit: import.meta.env?.SH_BNB !== true ? 'Paid to FIT Safe' : '',
  paidToPlatform: import.meta.env?.SH_BNB !== true ? 'Paid to platform Safe' : '',
  /** The site's word for a figure it could not read (the Buy-back progress card, the Inbox). */
  unavailable: 'Unavailable',
  /** InboxV2.tsx, its lines when its balances are unread or a coin could not be read. */
  inboxUnavailable: 'Inbox balances unavailable.',
  someCoinsUnread: 'Some coins could not be read.',
  /** ClaimAllV2's button word. */
  claim: 'Claim',

  // ── NEW (prototype § 3) ─────────────────────────────────────────────────────────────────────────────────────
  /** NEW: the picture's key, top left (every fee figure on the picture is in the price coin; the burned total is not a fee). */
  feesIn: (coin: string): string => `Fees in ${coin}`,
  /** NEW: under the raised share on the box's front. */
  ofRaise: (raise: string, coin: string): string => `of ${raise} ${coin}`,
  /** NEW (split from the site's "Ends in 8 d if the curve does not fill"): the front's right column. */
  endsIn: 'Ends in',
  /** NEW: the unit under a last day's count. */
  hours: 'hours',
  /** NEW: the phase pill while the raise fills (the site's state word is "Bonding"). */
  raising: 'Raising',
  /** NEW (the site's sentence on two lines in the empty pool). */
  opensAt: 'Opens at',
  graduation: 'graduation',
  /** NEW: a collection's items out of the vault. */
  out: (count: string): string => `${count} out`,
  /** NEW: the card of entries. */
  whatYouCanDo: 'What you can do here',
  /** NEW (from the explainer's "can be handed in for a share of the pile"). */
  handIn: (ticker: string): string => `Hand in ${ticker} for a share of the pile`,
  /** NEW: the fees line over Where the fees go. */
  feesLine: (fees: string, coin: string, trades: string): string => `${fees} ${coin} in fees · ${trades} trades`,
  /** NEW (from the approved "10 · your pick"): a side's three parts in its sheet. */
  partRow: (parts: string, label: string): string => `${parts} · ${label}`,
  /** NEW: the share of every fee the pool and Square Hole take, in their sheets ("2 of 15", "3 of 15"). */
  ofFifteen: 'of 15',
  /** NEW: sheet rows. */
  outRow: 'Out',
  fullRow: 'Full',
  inThePool: 'In the pool',
  fromFees: 'From fees',
  paid: 'Paid',
  atStart: 'At start',
  otherCoins: 'Other coins',
  /** NEW: the inbox sheet's (?) name, in the pattern of the approved "About the pool". */
  aboutInbox: 'About the inbox',
});

/** The sheet titles: the Create picture's own (picture-words.ts), the inbox's own word. */
export const SHEET_TITLES = Object.freeze({
  token: PICTURE_WORDS.token, contents: PICTURE_WORDS.contents, price: PICTURE_WORDS.pricedIn, raise: PICTURE_WORDS.raise, creator: PICTURE_WORDS.creator,
  holders: PICTURE_WORDS.holders, buyers: PICTURE_WORDS.buyersFees, sellers: PICTURE_WORDS.sellersFees, pool: PICTURE_WORDS.pool, mark: PICTURE_WORDS.squareHole,
  inbox: BOX_PICTURE_WORDS.inbox,
});
