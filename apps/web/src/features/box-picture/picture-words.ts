import { TESTNET } from '@squarehole/chain/write/wallet';
/**
 * SH-251: every word the visual Create shows or names a control with, in ONE place, so a wording change is a one-file
 * edit. Each string comes from the site (file and line in docs/evidence/SH-251.md, the words table), from the list the
 * founder approved on 23 November 2026 (the prototype's new words, and on his desk at 13:47 "Someone buys", "Someone
 * sells", "Steps", "Picture", "Examples"; on 24 November "Visual" in place of "Picture", and on his desk, round 125,
 * the four (?) names "About the token", "About what’s in the box", "About the creator" and "About holders"), or verbatim
 * from the explainer (the landing branch's storyboards and follow.js, and the examples' player in
 * apps/web/public/examples/follow.js). Nothing here waits for an approval. The fee choices' own names are the site's
 * (recipes.ts `choiceLabel`), passed in by the Create page.
 * Rules (CLAUDE.md, F23): no wallet mechanics, no limit of the platform's share, no checked or trusted labels, no Demo
 * label, nothing framed as earning.
 */

export const PICTURE_WORDS = Object.freeze({
  // The page: the steps' own heading (same page, another way in) and the site's own words.
  title: 'Launch a box',
  pictureName: 'Your box',
  hint: 'Tap a part to change it.',
  templates: 'Start from a template',
  overview: 'Overview',
  close: 'Close',
  // The three ways in (the desk, 23 November 13:47; "Visual" in place of "Picture": the founder, 24 November 2026).
  visual: 'Visual',
  steps: 'Steps',
  examples: 'Examples',
  /** The switch's name: the site's own nav word for Create (shell/nav-items.ts). */
  ways: 'Launch',
  // The picture's labels (explainer key words and the site's).
  buys: 'Buys',
  sells: 'Sells',
  fee: '1%',
  creator: 'Creator',
  holders: 'Holders',
  pool: 'Pool',
  raise: 'Raise',
  deadline: 'Deadline',
  days: 'days',
  squareHole: 'Square Hole',
  token: 'Token',
  contents: 'What’s in the box',
  pricedIn: 'Priced in',
  buyersFees: 'Buyers’ fees',
  sellersFees: 'Sellers’ fees',
  kindToken: 'Token',
  kindCollection: 'New collection',
  kindShop: 'Shop',
  kindPile: 'Coin pile',
  /** The box's token before it has a ticker (the steps' own words, v2/FeesStep.tsx). */
  boxCoin: 'the box coin',
  /** A side with no choice the box can take yet (recipes.ts `recipeIssues`). */
  noChoice: 'Choose a fee destination.',
  // The split, as the tray shows it (approved 23 November 2026).
  pickParts: '10 · your pick',
  poolParts: '2 · pool',
  markParts: '3 · Square Hole',
  // What happens (approved 23 November 2026; the two play buttons as the founder named them on his desk, 13:47).
  whatHappens: 'What happens',
  afterGraduation: 'After graduation',
  someoneBuys: 'Someone buys',
  someoneSells: 'Someone sells',
  hundred: '100 trades',
  everyTrade: '1% of every trade',
  clear: 'Clear the numbers',
});

/** The words with a value in them, each joining words that are already visible or the site's own patterns. */
export const pictureWords = Object.freeze({
  /** A fee side's control: its visible lane word, then the side's own name ("Buys · Buyers’ fees"). */
  sideName: (side: 'buyers' | 'sellers'): string => (side === 'buyers' ? `${PICTURE_WORDS.buys} · ${PICTURE_WORDS.buyersFees}` : `${PICTURE_WORDS.sells} · ${PICTURE_WORDS.sellersFees}`),
  tokenName: (ticker: string): string => `${PICTURE_WORDS.token} ${ticker}`,
  contentsName: (kind: string): string => `${PICTURE_WORDS.contents}: ${kind}`,
  pricedIn: (symbol: string): string => `${PICTURE_WORDS.pricedIn} ${symbol}`,
  raiseName: (raise: string, symbol: string, days: number): string => `${PICTURE_WORDS.raise} ${raise} ${symbol} · ${PICTURE_WORDS.deadline} ${days} ${PICTURE_WORDS.days}`,
  amount: (amount: string, symbol: string): string => `${amount} ${symbol}`,
  traded: (traded: string, fee: string, symbol: string): string => `${traded} ${symbol} traded · fee ${fee} ${symbol}`,
  /** The steps' summary title (CreateV2Flow `Summary`). */
  toFix: (count: number): string => (count === 1 ? 'One thing to fix' : `${count} things to fix`),
  /** The steps' back link ("Back to Opening"), here to the picture. */
  backTo: (label: string): string => `Back to ${label}`,
  /** The site's own sentence on sellers' fees (core/v2/V2BoxPage.tsx, the box page's Fee details). */
  saleFees: (ticker: string, coin: string): string => `Sale fees in ${ticker} are burned until graduation. After it the box sells them for ${coin} in its own pool and splits that ${coin} like the other fees.`,
});

/**
 * Each sheet's (?) by name: the site's names where one fits without repeating a name inside the same sheet, and the
 * four the founder approved on his desk (round 125, 24 November 2026) where none did. (He chose no line on the
 * collection tip for What happens, same round: the picture stays as simple as it is.)
 */
const ABOUT = Object.freeze({
  picture: 'About the picture',
  price: 'About the price coin',
  raise: 'About the target',
  buyers: 'About buyers’ fees',
  sellers: 'About sellers’ fees',
  pool: 'About the pool',
  mark: 'About the fee split',
  happens: 'About the fees',
  token: 'About the token',
  contents: 'About what’s in the box',
  creator: 'About the creator',
  holders: 'About holders',
} as const);
export type AboutId = keyof typeof ABOUT;
/** A (?)'s name. */
export const aboutOf = (id: AboutId): string => ABOUT[id];

/**
 * What each part is and does, behind its (?) (closed by default; the page is clear without them). Each line verbatim
 * from the explainer (storyboards/basics.md and introduction.md, apps/landing/public/follow.js and index.html on the
 * landing branch; placeholders filled with the explainer's own numbers), the site, or the approved list; the sources
 * line by line are in the evidence's words table.
 */
export const PART_WHY = Object.freeze({
  picture: ['10 parts go where the box says.', '10 of 15 parts, 0.667 of every 100. One pick for each side.', 'Set once. Never changed.'],
  token: ['Token. The box’s own. You get it for price coins.', 'One box, one token.'],
  contents: ['Every box has its token. Some also hold a coin pile, a collection or a shop.', 'After graduation, tokens can be exchanged for an item or a slice of the pile.'],
  price: ['Price coin. Picked once, from the coins Square Hole lists.'],
  raise: ['Raise. Fills with price coins. Full, the box graduates.'],
  creator: ['Creator. Makes the box and sets its rules, once.', 'Set once. Never changed.'],
  holders: ['Holder. Anyone who keeps the token. Some boxes share fees with them.'],
  buyers: ['Buys lane. A price coin goes in, a token comes out.', '10 of 15 parts, 0.667 of every 100. One pick for each side.'],
  sellers: ['Sells lane. A token goes in, a price coin comes out.', '10 of 15 parts, 0.667 of every 100. One pick for each side.'],
  pool: ['Pool. 2 of 15 parts, 0.133 of every 100, go into it.', 'Pool. Opens at graduation with tokens and price coins.'],
  // SH-258: without box 0 (BNB Chain testnet) the release's FIT share goes to the first of the deploy wallet's two
  // holding contracts: the FIT Safe line is left out there.
  mark: (import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) ? ['Square Hole. Gets 3 of 15 parts, 0.200 of every 100, from every box.', '2/15 to the FIT Safe · 1/15 to the platform Safe · 2/15 to the pool.'] as const
    : ['Square Hole. Gets 3 of 15 parts, 0.200 of every 100, from every box.'] as const,
} as const);
/**
 * The approved line under the holders' (?), true only where a side's choice is To holders (in the price coin or the box
 * coin): picture.ts `whyOf` adds it there and nowhere else.
 */
export const HOLDERS_SHARE = 'The token’s holders share these.';

/**
 * The guided walk (SH-254): the examples' own player, word for word (apps/web/public/examples/follow.js: the Play
 * button's three names, the row "Steps", each step "Step 2 of 8, <what>", "Next step", and the line "2/8 <what>").
 * What each step names is a part's own name, or the Overview.
 */
export const WALK_WORDS = Object.freeze({
  play: 'Play',
  pause: 'Pause',
  replay: 'Play again',
  steps: 'Steps',
  next: 'Next step',
});
export const walkWords = Object.freeze({
  step: (index: number, count: number, what: string): string => `Step ${index + 1} of ${count}, ${what}`,
  count: (index: number, count: number): string => `${index + 1}/${count}`,
});
