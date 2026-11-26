/**
 * The words of About & risks (SH-V2-FE7, founder: minimal text; numbers, visuals, icons and 1-3 word labels first; at
 * most one short sentence visible per section; details behind disclosures). Every card's details point to the clause
 * of the Terms that says it in full. The same words in the development and the production build: core v2 boxes, box 0
 * and the Misfits, FIT, claim-only payouts, failure and its claim without end (RC5-A, F136), listed coins. No first-handoff
 * pair. One exception (F156, SH-ALPHA-NOTICE): a build with the Sepolia alpha's trade code shows its own trading card and
 * status line (`TRADING_CARD`, `IN_APP_TRADING`).
 */
import { REVIEWED_PROVIDERS } from '@squarehole/links';
import { BOX_0_ADDRESSES } from '../features/legal/terms-common';
import { ABOUT_FACTS, V2_SPLIT, type FeePart } from './about-facts';
import { NATIVE_SYMBOL } from '../features/data-source/native-coin';
import { TESTNET } from '../features/data-source/testnet';
import { ALPHA_ON } from '../features/alpha-sepolia/alpha-on';

// SH-258: what this build's test network has. BNB Chain testnet has no box 0, FIT or Misfits (`switches.box0`), the
// Privy sign-in only with its own Privy app (SH-275, alpha-on.ts), and its own raise per listing (the mainnet build's
// ETH raise is not its figure).
// Where a sentence would be untrue there it is hidden, never reworded; the cards below keep their Sepolia words.
// SH-258 round 3: every use writes the switch out with the BNB build literal (`SH_BNB`), so a BNB build folds box 0's
// words away (a shared constant would keep them).
const PRIVY = ALPHA_ON;
const ETH_RAISE = TESTNET.name === 'sepolia';
/** Box 0's own card and the list of Square Hole's own boxes (box 0 only): shown where box 0 exists. */
export const MISFITS_SHOWN = (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0);
/**
 * The fee split the About page draws for other boxes. Without box 0 (BNB Chain testnet) the release's FIT share goes to
 * the first of two holding contracts the deploy wallet owns, so it is drawn with Square Hole's share, not as a FIT burn.
 */
export const V2_SPLIT_SHOWN: readonly FeePart[] = (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? V2_SPLIT : Object.freeze([
  ...V2_SPLIT.filter((part) => part.key !== 'fit' && part.key !== 'platform' && part.key !== 'pool'),
  { key: 'platform', label: 'Square Hole', fifteenths: V2_SPLIT.filter((part) => part.key === 'fit' || part.key === 'platform').reduce((sum, part) => sum + part.fifteenths, 0n) },
  ...V2_SPLIT.filter((part) => part.key === 'pool'),
]);
export const OURS_SHOWN = (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0);
const only = <T,>(on: boolean, value: T): readonly T[] => (on ? [value] : []);
/**
 * SH-258 (re-read finding 9): the reviewed sites a box page of this build can link to, as About names them. Sepolia's
 * builds name the list they named before BNB Chain testnet's explorer joined it; a BNB build names its explorer and
 * none of Sepolia's.
 */
export const SHOWN_PROVIDERS = Object.freeze(REVIEWED_PROVIDERS.filter((provider) => (TESTNET.name === 'bnb'
  ? !/sepolia/.test(provider.id)
  : provider.id !== 'bscscan-testnet')));

// The Sepolia test site (SH-TA-02, apps/web/build-target.ts): the test network notice is its one legal text, and box 0's
// mainnet address, an open item of the production Terms, does not ship there.
const TEST_NETWORK_BUILD = !!import.meta.env?.SH_PRODUCTION && import.meta.env?.SH_TEST_NETWORK === true;
// F156 (SH-ALPHA-BUILD-SWITCH, build-target.ts `sepoliaTradeOf`): this build carries the Sepolia alpha's trade code (the
// Sepolia production build, or a development opt-in). Read here, in the module, so the build folds the trading card's
// choice below and ships one card only (SH-ALPHA-NOTICE). Missing in vitest: the tests see the main site's card.
const SEPOLIA_TRADE_BUILD = import.meta.env?.SH_SEPOLIA_TRADE === true;

/** A figure: its value first (large), then a 1-3 word label. */
export interface AboutFigure {
  readonly value: string;
  readonly label: string;
}

/**
 * The sections of the Terms a card points to. Sections, not clauses: the page is the same in both builds, and only the
 * eighteen sections are shared by the development draft and the production text (review FE7).
 */
export type TermsPointer = readonly string[];

/** "Terms, Section 5", "Terms, Sections 5 and 11", "Terms, Sections 4, 5 and 6". */
export const termsLabel = (sections: TermsPointer): string =>
  sections.length === 1 ? `Terms, Section ${sections[0] ?? ''}` : `Terms, Sections ${sections.slice(0, -1).join(', ')} and ${sections.at(-1) ?? ''}`;

export interface AboutCardCopy {
  readonly id: string;
  readonly title: string;
  readonly figures: readonly AboutFigure[];
  /** The one visible sentence. */
  readonly lead: string;
  readonly details: readonly string[];
  readonly terms: TermsPointer;
}

const f = ABOUT_FACTS;
const andOr = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`);

export const BOX_CARD: AboutCardCopy = Object.freeze({
  id: 'risks-box',
  title: 'What’s a box',
  figures: [
    { value: '1', label: 'New token' },
    { value: '1', label: 'Own pool' },
    { value: f.items, label: 'NFTs, optional' },
    { value: '0', label: 'Admin keys' },
  ],
  lead: 'A box is one new token with its own pool, sometimes with NFTs in a vault.',
  details: [
    (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? 'It is priced in one coin: ETH, or a coin on Square Hole’s list, such as a stablecoin, gold, a tokenised stock, FIT or a graduated box’s token.'
      : `It is priced in one coin: ${NATIVE_SYMBOL}, or a coin on Square Hole’s list, such as a stablecoin, gold, a tokenised stock or a graduated box’s token.`,
    'Anyone can create one. Its settings are fixed at creation, and its creator, not Square Hole, is responsible for it.',
    'No box contract has an owner, admin, pause or upgrade. Nobody, Square Hole included, can change or rescue a box, so a bug may never be fixed.',
    ...((import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? ['Box 0, The Misfits and FIT, runs on contracts of its own; every other box shares one set.'] : []),
    ...((import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? ['Square Hole keeps a few roles: listing price coins, three wallets that receive part of other boxes’ fees, and the Misfits’ marketplace page.'] : []),
  ],
  terms: ['5'],
});

export const CURVE_CARD: AboutCardCopy = Object.freeze({
  id: 'risks-curve',
  title: 'Curve & graduation',
  figures: [
    { value: f.window, label: 'Launch window' },
    { value: f.deadlineRange, label: 'Deadline' },
    ...only(ETH_RAISE, { value: f.raise, label: 'ETH raise' }),
    { value: `${f.taxFirst} → ${f.taxLast}`, label: 'Window tax' },
  ],
  lead: 'Buys move the price up the curve; a full curve graduates into the box’s own pool.',
  details: [
    ETH_RAISE ? `Each box raises the amount its price coin’s listing names when the box is created: ${f.raise} for ETH today.` : 'Each box raises the amount its price coin’s listing names when the box is created.',
    'Until the curve fills, anyone can sell back into it at its current price. Early sellers are paid with what later buyers put in.',
    `For the first ${f.window}, buys go only through Square Hole’s launch contract and pay a tax, ${f.taxFirst} falling to ${f.taxLast} in ${f.windowSteps} steps of ${f.stepSeconds}. The tax stays in the box and never goes to Square Hole; if the box fails, it joins the holders’ claim. Bots still buy first.`,
    'Anyone can trigger graduation, once. The pool is then closed to outside liquidity for good, and its liquidity can never be removed.',
    'Most launches never fill their curve.',
  ],
  terms: ['5'],
});

export const FEES_CARD: AboutCardCopy = Object.freeze({
  id: 'risks-fees',
  title: 'Fees & payouts',
  figures: [
    { value: f.fee, label: 'Every trade' },
    ...((import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? [{ value: '0', label: 'To FIT holders' }] : []),
    { value: 'Claim only', label: 'Payouts' },
  ],
  lead: `Every trade pays ${f.fee}, split by code in fifteenths; payouts wait until you claim them.`,
  details: [
    'Other boxes: the creator picks one use per side for its 10/15: keep, burn, add to the pool, to holders or to items.',
    ...((import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? ['FIT’s 2/15 goes to a fixed wallet that needs two of three signatures: our bot sells it, buys FIT and burns it, and publishes every step. Square Hole’s 1/15 goes to its platform wallet, which the founder signs for. Both parts are done by us, not by code.'] : []),
    (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? `Vault fees are burned: draw ${f.draw}, give back ${f.giveBack}, named pick ${f.pick} (box 0) or ${andOr(f.picks)} (other boxes).` : `Vault fees are burned: draw ${f.draw}, give back ${f.giveBack}, named pick ${andOr(f.picks)}.`,
    'Holder and item payouts are never sent: each waits until you claim it, one signed transaction each, and they do not expire. Claim all lists every claim your wallet has.',
    (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? 'Holding FIT pays you nothing. Burns and payouts are not promises, and not interest or a dividend.' : 'Burns and payouts are not promises, and not interest or a dividend.',
  ],
  terms: ['5', '11'],
});

export const FAILURE_CARD: AboutCardCopy = Object.freeze({
  id: 'risks-failure',
  title: 'Failure & claim',
  figures: [
    { value: f.deadlineRange, label: 'Deadline' },
    { value: f.hatch, label: 'Not graduated' },
    { value: f.notOpen, label: 'Not opened' },
    { value: f.claims, label: 'To claim' },
  ],
  lead: 'A box that misses its deadline closes, and holders claim from its pot with no time limit.',
  details: [
    `A box fails when its deadline passes before the curve fills, when it has not opened ${f.notOpen.replace(' d', ' days')} after its planned start, or when it filled but has not graduated after ${f.hatch.replace(' d', ' days')}.`,
    'Once a box can be closed, its pool takes no trades. Anyone can press Close box and gets a small tip from the pot.',
    'To claim, hand in your coins: you get the pot times your coins, divided by the coins not yet handed in, in the box’s price coin. Often far below what you paid.',
    'Claims never close. Money that reaches the box later goes to the claims made after it.',
    'The share of coins nobody hands in stays locked for good, and so does money arriving after the last claim. Nobody can take it out, Square Hole included.',
    ...((import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? ['Box 0 has no deadline. If its curve never fills, the Misfits stay in the vault and some ETH stays locked for good.'] : []),
  ],
  terms: ['5', '6'],
});

export const COINS_CARD: AboutCardCopy = Object.freeze({
  id: 'risks-coins',
  title: 'Coins, stocks & gold',
  figures: [
    { value: 'Stocks', label: 'No shareholder rights' },
    { value: 'Gold', label: 'Can freeze, pause' },
    { value: 'Stablecoins', label: 'Can block addresses' },
  ],
  lead: 'A listed coin stays under its issuer, who can freeze it or change its rules.',
  details: [
    'Tokenised stocks, such as Ondo’s, give no shares, dividends or votes. They may not be offered to US persons, and some countries allow only professional investors.',
    'Gold coins, such as PAXG: the issuer can freeze, wipe, burn or pause them, and could add a transfer fee.',
    'Stablecoins, such as USDC: the issuer can block addresses, a pool’s included.',
    'One issuer action can stop every box priced in its coin: trades, payouts and claims.',
    'Listing a coin is not an endorsement. Each box keeps the raise it was created with.',
  ],
  terms: ['4', '5', '6'],
});

/** A BNB build's stand-in: the card is never listed there (ABOUT_CARDS). */
const NO_CARD: AboutCardCopy = Object.freeze({ id: 'risks-none', title: '', figures: [], lead: '', details: [], terms: [] });

export const MISFITS_CARD: AboutCardCopy = !(import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? NO_CARD : Object.freeze({
  id: 'risks-misfits',
  title: 'Box 0 · The Misfits',
  figures: [
    { value: f.draw, label: 'Draw' },
    { value: f.pick, label: 'Named pick' },
    { value: f.giveBack, label: 'Give back' },
    { value: '0', label: 'Team FIT' },
    { value: f.fitSupply, label: 'FIT, created once' },
  ],
  lead: 'Box 0 is The Misfits and their token FIT; every Misfit starts in the vault.',
  details: [
    'FIT is created once, and no more can ever be made. Anyone can burn their own. Holding FIT gives no claim on any Misfit.',
    'One quote for every Misfit: the FIT not locked in the vault, divided by the Misfits inside. Draws, picks and give-backs lock or release it; their fees are burned.',
    'Before graduation you get a placeholder; after it, a draw gives a random unrevealed Misfit (drand). Only revealed Misfits can be picked by name.',
    // F142 (desk R61-STOP "hide"): no hint at stopped draws or their safety mode; the Terms (5.11) keep the mechanism.
    'Square Hole holds the secret reveal data, and those who hold it may not draw. Reveals can be late.',
    'Owners of Misfits outside the vault are credited part of sellers’ fees, which they claim; for Misfits inside, it is burned.',
    'No deadline.',
  ],
  terms: ['5'],
});

/** One of Square Hole's own boxes, as About & risks lists it (F133). */
export interface OurBox {
  readonly name: string;
  readonly token: string;
  /** "Box 0": the boxes in the order Square Hole created them. */
  readonly label: string;
  /** Its token contract on Ethereum mainnet (what its box page and the feed search use), or an open item until then. */
  readonly address: string;
}

/**
 * Square Hole's own boxes (F133, founder 2026-10-11: "Listed by address only"; nothing that reads as an approval sign).
 * Never badged or marked in the feed or on a box page: listed here by contract address instead, box 0 first, and the
 * same addresses posted on X (Terms 5.4(f)). The list discloses which boxes are Square Hole's own and lets anyone check
 * a box's real address against copies. Box 0's mainnet address is not known before its deployment, so the Terms' open
 * item stands in for it, in both builds; the production build refuses to finish while it ships (placeholder-guard.ts).
 * Replace it with box 0's token address (FIT) once box 0 is deployed on mainnet. The Sepolia test site says only that
 * box 0 is not on mainnet yet (SH-TA-02).
 */
export const OUR_BOXES: readonly OurBox[] = !(import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? Object.freeze([]) : Object.freeze([Object.freeze({ name: 'The Misfits', token: 'FIT', label: 'Box 0', address: TEST_NETWORK_BUILD ? 'Not on mainnet yet' : BOX_0_ADDRESSES })]);

export const OURS_CARD: AboutCardCopy = import.meta.env?.SH_BNB === true ? NO_CARD : Object.freeze({
  id: 'risks-ours',
  title: 'Our boxes',
  figures: [
    { value: String(OUR_BOXES.length), label: 'Our boxes' },
    { value: '0', label: 'Ownership labels' },
  ],
  lead: 'The boxes Square Hole created, by contract address.',
  details: [
    'No badge or label in the feed or on a box’s page says a box is ours. Box 0 is shown first as Featured: a place in the feed, not an approval.',
    'This list says which boxes are Square Hole’s own. The same addresses are posted on X.',
    'Check a box’s chain and contract address against it: a name or picture proves nothing.',
    'Being on this list is not an approval of any box.',
    'Square Hole itself does not trade the tokens of its own boxes; FIT in its wallets moves only through the published daily bot.',
  ],
  terms: ['5'],
});

/** The other risks: a 1-3 word label each, one sentence behind it. */
export const MORE_RISKS: readonly { readonly label: string; readonly text: string }[] = Object.freeze([
  { label: 'No audit', text: 'No outside firm has audited the contracts.' },
  { label: 'No pause', text: 'Nothing can be paused or upgraded, so a bug may never be fixed.' },
  { label: 'Bots', text: 'Bots often buy first and can front-run or sandwich your trades.' },
  { label: 'Trading elsewhere', text: 'Outside pools pay no Square Hole fees and fund no burns or payouts.' },
  { label: 'Fakes', text: 'Copycat boxes exist. Check the chain and the contract address.' },
  { label: 'No undo', text: 'Transactions cannot be undone, and tokens sent to a contract can be lost.' },
  { label: 'Your keys', text: 'Lost or stolen keys mean lost tokens. We cannot recover them.' },
  { label: 'Our systems', text: (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? 'Reveals, keepers and other boxes’ FIT burns depend on our servers and signers.' : 'Keepers depend on our servers and signers.' },
  { label: 'Scanners', text: 'Token scanners may flag a box token as a proxy; it is a fixed copy that cannot be upgraded.' },
  { label: 'Art files', text: 'NFT pictures live on a shared file network and can go offline.' },
  { label: 'Tax & law', text: 'Your taxes are yours, and laws can change where you are.' },
  { label: 'Test networks', text: 'Test tokens have no value, and nothing carries over.' },
]);

export const MORE_LEAD = 'Twelve more, one line each; the Terms list them all.';

/** The main site's card (F131 R45C, R45D: no buying or selling in the app), word for word as since SH-V2-FE7. */
function noTradingCard(): AboutCardCopy {
  return Object.freeze({
    id: 'risks-trading',
    title: 'No trading here',
    figures: [
      { value: '0', label: 'Trade forms' },
      { value: '0', label: 'Wallet pop-ups' },
    ],
    lead: 'Trades happen on outside venues; browsing never opens your wallet.',
    details: [
      `Box pages link only to reviewed sites (${SHOWN_PROVIDERS.map((provider) => provider.name).join(', ')}), with the exact chain and contract address. A name or picture proves nothing.`,
      'A wallet asks for your approval only after you connect and start an action: creating a box, a vault action, a claim or closing a box.',
      'A browser wallet you connected here reconnects when you come back, without opening; Disconnect stops that.',
      'Square Hole never holds your tokens or keys.',
    ],
    terms: ['5'],
  });
}

/**
 * The Sepolia alpha's card (F156 (2), F157 (1); SH-ALPHA-NOTICE): the same shape, for the buy and sell box the Sepolia
 * builds put on box pages. Draft words for the founder. Window buys go through the box's launch router (its tax); the
 * hook refuses any other buy in the window (BoxHookV2.sol `BuyThroughLaunchRouter`), and every other trade goes through
 * Uniswap's PoolSwapTest, which has a price limit but no minimum and no deadline, so it can fill in part
 * (docs/design/sepolia-alpha-v1.md, "Chain facts"). Never the trade markers of production-check.ts in these words: this
 * module ships outside the lazy trade chunk.
 */
function testTradingCard(): AboutCardCopy {
  return Object.freeze({
    id: 'risks-trading',
    title: 'Test trades only',
    figures: [
      { value: '0', label: 'Real money' },
      { value: 'Exact', label: 'Wallet amounts' },
    ],
    lead: 'Box pages buy and sell test tokens only; browsing never opens your wallet.',
    // Its own sentences, none of the main site's card: a build scan can then tell the two cards apart line by line.
    details: [
      // The review's fix F1 (the wallet sentence scoped to trades) and F161 (4)'s made wallet (no window of its own).
      PRIVY ? 'Trades open your wallet only when you press Buy or Sell, for the exact amount; a wallet Privy made signs on that press, with no window of its own.' : 'Trades open your wallet only when you press Buy or Sell, for the exact amount.',
      `In a box’s first ${f.window}, buys go through the box’s launch router and pay its tax.`,
      'Other trades go through Uniswap’s test swap contract, with a price limit but no deadline; they can fill in part.',
      'Square Hole never holds your test tokens or your keys.',
    ],
    terms: ['5'],
  });
}

/** Both cards, for the tests. Pure calls: a build keeps only the one TRADING_CARD shows and drops the other, words and all. */
export const NO_TRADING_CARD: AboutCardCopy = /* @__PURE__ */ noTradingCard();
export const TEST_TRADING_CARD: AboutCardCopy = /* @__PURE__ */ testTradingCard();

/** The trading card this build shows: the Sepolia alpha's where its trade code is in the build, the main site's elsewhere. */
export const TRADING_CARD: AboutCardCopy = SEPOLIA_TRADE_BUILD ? TEST_TRADING_CARD : NO_TRADING_CARD;

/**
 * The status strip's in-app trading line, chosen with the card: F131 R45D's words on the main site, the alpha's test
 * trades where the build carries its trade code (F156; SH-ALPHA-NOTICE).
 */
// The review's fix F3: "Test tokens only" is the footer's own fact already; the strip says what the box pages do.
export const IN_APP_TRADING: string = SEPOLIA_TRADE_BUILD ? 'Test trades only' : 'None today';

export const LEGAL_LEAD: string = TEST_NETWORK_BUILD ? 'Using this test site means accepting its test network notice.' : 'Using Square Hole means accepting its Terms of Use.';

/** Every card with details, in page order (More risks and the legal card are built apart). */
export const ABOUT_CARDS: readonly AboutCardCopy[] = Object.freeze([BOX_CARD, CURVE_CARD, FEES_CARD, FAILURE_CARD, COINS_CARD, ...((import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? [MISFITS_CARD, OURS_CARD] : []), TRADING_CARD]);
