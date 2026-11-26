/**
 * Square Hole Terms of Use (F19; rewritten to the core v2 model of F23–F30 for Fable review item S1): the single source
 * of the entry gate's copy and the full Terms on `/about/terms`.
 *
 * DRAFT pending legal review (docs/legal/README.md has the counsel checklist and the founder decisions). The page tells
 * users it is a draft that may change; it does not call itself "not in force", because the gate asks them to accept
 * it. Text is plain English with two inline marks, rendered by TermsText.tsx:
 *   `**bold**` for emphasis, and `[COUNSEL: …]`, `[FOUNDER: …]`, `[ENGINEERING: …]` (also `[FOUNDER + COUNSEL …]`)
 *   for placeholders that must be filled before the Terms can be final.
 *
 * Wording rule (SEC Division of Corporation Finance staff FAQ, 25 Sept 2026, Q2.5; F23 "use safe wording everywhere"):
 * burns, buybacks, the per-Misfit stream and fee shares are described as mechanics only, never as yield, return,
 * profit, price support or growth. terms.test.ts runs the check in wording.ts over every string here. The vault action
 * that hands a Misfit back is called "give back" here, because the Terms check flags the word "return" everywhere.
 *
 * Section 5 separates what this build does today (5.1 to 5.3, the test boxes; draft-7) from the planned design
 * (5.4 to 5.16): ADR-0014 and the founder answers F23–F30 (lock/release vault with flat burned fees, FIT issued once,
 * the collection in the vault before launch, withdrawals after graduation, placeholders revealed later, the per-Misfit
 * stream, no FIT-holder payouts, the sniper fee). None of it is deployed.
 *
 * Changing the text in a way that matters to users means a new TERMS_VERSION: everyone is asked to accept again. Set
 * the same version in apps/web/e2e/terms-state.ts.
 *
 * The production build (`SH_BUILD=production`) shows terms-production.ts instead (SH-V2-FE7): every export below picks
 * one text at build time, so the development text, its sample-data sentences included, is not in the production bundle and
 * the production text is not in this one. The Sepolia test build (`SH_TARGET=sepolia`, SH-TA-02) shows the test network
 * notice (test-network.ts) in the production text's place.
 */
import { PRODUCTION_TERMS } from './terms-production';
import { TEST_NETWORK_NOTICE } from './test-network';
import { PRIVACY_PATH, deepFreeze, eligibilityBullet, items, restrictedCountryClause, termsTextOf, type TermsClause, type TermsDocumentCopy, type TermsGateCopy, type TermsSection } from './terms-common';

export {
  GATE_FREE_PATHS,
  PRIVACY_PATH,
  RESTRICTED_COUNTRIES,
  TERMS_PATH,
  deepFreeze,
  eligibilityBullet,
  joinOr,
  restrictedCountryClause,
  type RestrictedCountry,
  type TermsClause,
  type TermsDocumentCopy,
  type TermsGateCopy,
  type TermsItem,
  type TermsSection,
} from './terms-common';

// The Demo in this build: false on the production site, where the development text below folds away and
// terms-production.ts (a DRAFT FOR COUNSEL with no Demo, SH-V2-FE7) takes its place (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
// The Sepolia test site (SH-TA-02, `SH_BUILD=production SH_TARGET=sepolia`, apps/web/build-target.ts): the test network
// notice (test-network.ts) takes the production text's place, so neither draft ships there. False in every other build.
const TEST_NETWORK_BUILD = !DEMO_BUILD && import.meta.env?.SH_TEST_NETWORK === true;

/** Stored with each acceptance; a different stored version shows the gate again. */
// draft-6 (SH-V2-FE8, F130): draft-5's text with the sample data named for what it is, never "Demo" or "labelled Demo".
// draft-7 (SH-V2-FE11): 5.2(c) says what F135's silent reconnect does; 5.3(f), 5.13(f), 11.2 and the gate describe the
// test boxes this build shows, not the first handoff's test pairs, which no page shows since F134 R46B.
export const TERMS_VERSION: string = DEMO_BUILD ? '2026-10-11-draft-7' : TEST_NETWORK_BUILD ? TEST_NETWORK_NOTICE.version : PRODUCTION_TERMS.version;
/** Date of this version (ISO) and as shown. */
export const TERMS_DATE: string = DEMO_BUILD ? '2026-10-11' : TEST_NETWORK_BUILD ? TEST_NETWORK_NOTICE.date : PRODUCTION_TERMS.date;
export const TERMS_DATE_TEXT: string = DEMO_BUILD ? '11 October 2026' : TEST_NETWORK_BUILD ? TEST_NETWORK_NOTICE.dateText : PRODUCTION_TERMS.dateText;

/** The entry gate's copy (short on purpose; the full Terms apply). */
export const TERMS_GATE: TermsGateCopy = DEMO_BUILD ? deepFreeze({
  title: 'Before you enter Square Hole',
  /** Shown under the title: the draft status in words, not only the "Draft" chip. */
  status: 'Draft Terms, not yet reviewed by a lawyer.',
  intro: 'Here are the essentials of the Square Hole Terms of Use. The full Terms apply.',
  bullets: [
    'Nothing here is an offer, a recommendation or advice.',
    'Square Hole is not registered or licensed by any financial regulator.',
    eligibilityBullet(),
    'You can lose everything. Most launches never complete, and there are no refunds.',
    'Trades pay a fee: part is burned, part goes to Square Hole and, on today’s test boxes, part can be credited to holders. Holding FIT pays you nothing. Burns are not a promise, and no one owes you anything because of them.',
    'Right now this is a test build: sample data or test chains only, nothing on mainnet. Test tokens have no value and give no right to any future token.',
    'Your wallet, your decisions, your taxes. Transactions cannot be undone.',
  ] as readonly string[],
  fullTermsLink: 'Read the full Terms of Use',
  /** The self-declaration (F30 Q8: eligibility is declared by the visitor; there is no IP blocking). */
  checkbox: 'I have read and agree to the Square Hole Terms of Use, and I confirm that I am at least 18 and not a Restricted User.',
  decline: 'Decline',
  accept: 'Accept',
  declined: 'You need to accept the Terms of Use to use Square Hole. You can close this page, or go back and read them again.',
  reviewAgain: 'Review the terms again',
}) : TEST_NETWORK_BUILD ? TEST_NETWORK_NOTICE.gate : PRODUCTION_TERMS.gate;

/**
 * Section 5: today's build (5.1 to 5.3), then the planned v2 design (5.4 to 5.16). A function, so the production
 * bundle, which never calls it, keeps none of it.
 */
const servicesClauses = (): TermsClause[] => [
  { text: 'Sections 5.1 to 5.3 describe the Services as they are today. Sections 5.4 to 5.16 describe a planned design that is not deployed (Section 3.5).' },
  {
    n: '5.1',
    text: '**What you can do.** You can browse launches, pairs and NFT collections; read data and risk information; copy contract addresses; and follow links to third-party venues and block explorers. Where the app offers it, you can also connect your own wallet and sign specific transactions. Today these are creating a launch and claiming amounts a contract holds for your address (5.3(f)). [FOUNDER: whether vault actions (5.8) will be offered in the app.]',
  },
  {
    n: '5.2',
    text: '**What we do not do.**',
    items: items(
      '(a) **No trading in the app.** The Services have no trade form, order book or swap feature for pool trades. Pool trading happens only on third-party venues. If vault actions (5.8) are ever offered in the app, each is a contract call with the vault that locks or releases FIT against a Misfit, not a pool trade. [FOUNDER: whether a combined give-back-and-sell route will ever be offered in the app.]',
      '(b) **No custody.** We never hold your tokens, NFTs, funds or keys. We cannot move, freeze, recover or reverse anything in your wallet.',
      '(c) **No accounts.** You do not sign up. Browsing never opens your wallet or asks you to approve anything. If you connected a browser wallet on this device, the app remembers it here and, when you come back, asks that wallet, without opening it, whether it still shares your address; Disconnect makes it forget. A wallet request that needs your approval only happens after you choose to connect and start an action.',
      '(d) We do not act for you, trade for you, or guarantee any token, NFT or transaction.',
    ),
  },
  {
    n: '5.3',
    text: '**Test status.** At the date of these Terms:',
    items: items(
      '(a) Square Hole runs only on a local development chain and, where deployed, the Sepolia test network. No Square Hole contract is deployed on Ethereum mainnet or any other production network, and no such deployment is authorised.',
      '(b) Test tokens, test ETH and test NFTs have no value. We do not exchange them for anything of value.',
      '(c) The sample data (a data source in Settings) is invented data at a fixed time. It shows no real launches, prices or balances.',
      '(d) The smart contracts have not been audited or independently reviewed.',
      '(e) Whether and when any production launch will happen is not decided. Nothing in the Services promises one.',
      '(f) The boxes this build shows on a local chain or on Sepolia are test deployments of the current box contracts, not the planned design in 5.4 to 5.16. Each box’s page shows its fees and who can claim what. As a box’s fee choices say, a contract can credit part of its fees to the box’s creator, to the addresses that hold its token or to the owners of its items; they can claim what the contract holds for them (5.13(f)).',
      '(g) Using the Services, the sample data, a test network or a test token gives you no right to any future token, NFT, allocation or airdrop. Nothing you do on a test network carries over to a production network.',
    ),
  },
  {
    text: '**Planned design (not deployed).** Sections 5.4 to 5.16 describe how Square Hole’s launches ("Binds") are designed to work, starting with The Misfits and FIT. Parts of it exist as candidate code and parts are not built at all. None of it is deployed or audited, and values marked "currently" or "currently proposed" are drafts. It may change, or never be built (Section 3.5).',
  },
  {
    n: '5.4',
    text: '**Binds and FIT.**',
    items: items(
      '(a) A Bind is one launch. It links one NFT collection to one token, one base coin and one pool. The first Bind links The Misfits collection to FIT, with ETH as the base coin. FIT is also the Square Hole platform token.',
      '(b) FIT is created once, at launch: 1,000,000,000 FIT. The FIT contract has no function to create more, so the supply can never go above that number. None of it is set aside for Square Hole, a team or a creator.',
      '(c) Anyone may burn their own FIT. A burn cannot be undone, and it lowers the supply. FIT sent to a "dead" address such as 0x…dEaD is not burned: it still counts in the supply.',
      '(d) FIT’s only link to the vault is the vault’s rules (5.8): FIT can be locked to take a Misfit out, and a Misfit can be given back for FIT released from the escrow. Holding FIT gives you no ownership of, and no claim on, any Misfit, the vault, the escrow, Square Hole or its treasury, and no vote, no dividend and no claim against anyone.',
      '(e) **FIT holders receive no payouts.** No fee, burn or other mechanism pays or credits anything to anyone because they hold FIT.',
    ),
  },
  {
    n: '5.5',
    text: '**The Misfits and the vault, before launch.**',
    items: items(
      '(a) The Misfits collection (currently planned: 4,200 NFTs, each called a "Misfit") is created before the pre-market opens, and every Misfit is placed in the vault at once. The vault is a smart contract that holds them. Nobody, including Square Hole, can take a Misfit out except by the vault’s rules, and no Misfit can leave the vault before graduation (5.7).',
      '(b) The art of every Misfit (its pictures, its traits and its 3D model) is made before launch and committed on chain by its hash, so it cannot be changed afterwards. It stays hidden until each Misfit is revealed (5.9). How many Misfits there are of each rarity is published before the pre-market opens.',
      '(c) Teaser art is for illustration. It does not tell you what any Misfit will be.',
    ),
  },
  {
    n: '5.6',
    text: '**The pre-market (bonding curve).**',
    items: items(
      '(a) Part of the FIT supply (currently proposed: 798,137,969.32 FIT, just under 80%) is sold on a price curve against ETH until a set amount is raised (currently proposed: exactly 4.206980085 ETH). Each buy moves the price up. Each sell moves it down.',
      '(b) Anyone can sell FIT back into the curve at any time. The curve pays its price at that moment, less fees. People who buy early and sell are paid with ETH that others put in. Late buyers, and people who never sell, usually lose the most.',
      '(c) There is no deadline, no refund and no closing process. A curve that never reaches its target keeps running.',
      '(d) Most bonding-curve launches never reach their target. Across launchpads, only a few in every hundred do. If the pre-market never completes, there is no graduation: the Misfits stay in the vault and can never be taken out. [FOUNDER: confirm this failure rule (Fable review R-33).]',
      '(e) Some ETH can stay in a curve that never completes, where nobody can withdraw it, including us. Under the current proposal, the treasury part of the ETH fees paid during a pre-market goes to Square Hole as usual, and the buy-and-burn part is used only after graduation, so without a graduation it stays locked for good. [FOUNDER: confirm (ADR-0014, D9).]',
      '(f) **Completion.** The curve counts as complete when a block ends with the price at, or past, the target, that is, with all of the curve’s FIT sold. A buy past the target gets nothing, because the curve has nothing left to sell, and sells stay open. If a later block ends with the price more than about 4% of the raise back inside the curve (currently proposed: 600 ticks, about 0.168 ETH), the curve reopens: it is no longer complete, and it must complete again before graduation can follow. Smaller sells, and sells that others buy back within the same block, do not reopen it. A completed curve is not sold out for good. [FOUNDER + ENGINEERING: the reopening margin and the waiting period of 5.7(a) (security review of 30 September 2026; Fable review R-16).]',
      '(g) Automated traders ("bots" or "snipers") often buy in the first blocks. The sniper fee (5.13(b)) is meant to make those blocks more expensive. It cannot stop them.',
    ),
  },
  {
    n: '5.7',
    text: '**Graduation.**',
    items: items(
      '(a) From 32 blocks (about 6.4 minutes) after the block that completed the curve, if it has not reopened, anyone can trigger graduation in a single transaction, in any block in which the price is within about 0.1% of the target. The same transaction may first buy the price back to the target. Nobody has to trigger graduation, so it can come later.',
      '(b) At graduation the pre-market curve ends, and no ETH leaves the Square Hole pool. 99% of the ETH the curve holds is placed as a price range between the target price and the curve’s start price, where it pays people who sell FIT, and the rest below the start price, down to the lowest price the pool supports. The rest of the FIT supply (currently proposed: 201,862,030.68 FIT, just over 20%) is placed at prices from the target price up to the highest price the pool supports, together with any FIT that sellers put back into the curve after it completed. If holders sold between completion and graduation, the ETH placed can be up to about 0.07% less than the target. From then on FIT trades in that pool against ETH, with the pool fee of 11.2.',
      '(c) From graduation on, Misfits can be taken out of the vault (5.8).',
      '(d) Graduation cannot be undone.',
      '(e) **Outside liquidity.** From 32 blocks after graduation, anyone can add their own liquidity to the Square Hole pool. Each such position cannot be changed, withdrawn or collected from for 32 blocks after it was last added to; after that its owner can always withdraw it in full. A position that one contract holds for many people (for example a shared liquidity service) starts its 32 blocks again whenever anyone adds to it. Square Hole’s own positions can never be withdrawn or moved. People who add liquidity keep the fees their liquidity collects. The pool fee is shared between all liquidity in range, so the part that funds the buy-and-burn, the treasury and the per-Misfit stream is only the part collected by Square Hole’s own positions, and it is smaller when others add liquidity. The Uniswap app may warn that funds in this pool can be locked: for outside positions that means only these 32 blocks. [COUNSEL: this wording (F40 L3: the reduced fee share stated plainly).]',
    ),
  },
  {
    n: '5.8',
    text: '**The vault after graduation.**',
    items: items(
      '(a) **The quote.** One quote applies to every vault action: the FIT that exists and is not locked in the escrow, divided by the number of Misfits in the vault. Every Misfit counts the same, whatever its art, rarity or number. The quote can change between when you see it and when your transaction runs.',
      '(b) **Draw.** You lock FIT equal to the quote in the escrow and pay a draw fee (currently 1% of the quote), which is burned. You receive one Misfit that has not been revealed yet, as a placeholder (5.9). You cannot choose which one. [ENGINEERING: whether a draw also pays a fee for random numbers, which depends on the reveal mechanism of 5.9.]',
      '(c) **Named pick.** You can take a specific Misfit that has already been revealed and was given back to the vault. You lock the quote in the escrow and pay a premium (currently 25% of the quote), which is burned. A Misfit that has not been revealed can never be picked by name. Picks are first come, first served, and automated traders are often first.',
      '(d) **Give back.** You can give a Misfit back to the vault. The vault takes it from your wallet, with your approval, and releases FIT equal to the quote from the escrow to you, less a give-back fee (currently 5% of the quote), which is burned. [ENGINEERING: whether a Misfit can be given back, transferred or picked before its reveal (Fable review R-14).]',
      '(e) **Locked FIT is not a deposit.** FIT you lock does not stay yours and is not kept for you. It stays in the escrow and is released only when someone gives a Misfit back, to that person. Nobody, including Square Hole, can take FIT out of the escrow in any other way.',
      '(f) **Flat fees.** Vault fees are a fixed share of the quote. They do not change with rarity, with a Misfit’s number, or with how many Misfits have been given back.',
      '(g) **The last Misfit** can never leave the vault.',
      '(h) **What moves the quote.** Every burn of FIT, by anyone, lowers the quote. This includes the vault fees, the pool-fee burns of 5.10 and the buy-and-burn of 5.13. You have no right to any particular quote or Misfit, or to the vault holding any Misfit at all.',
      '(i) **After you take it out**, a Misfit is an ordinary NFT. Its only remaining links to the vault are the give-back action and the stream of 5.10. Marketplaces may show it late or incorrectly.',
    ),
  },
  {
    n: '5.9',
    text: '**Placeholders and reveals.**',
    items: items(
      '(a) Until it is revealed, a Misfit shows the same placeholder as every other unrevealed Misfit: the same picture and no traits. Everyone who draws one receives one alike.',
      '(b) Reveals happen later, in batches. For each batch, a random number decides which of the committed art (5.5(b)) each placeholder in it receives. The design aims that nobody, including Square Hole, can tell in advance which art an unrevealed Misfit will receive. [FOUNDER + ENGINEERING: the final reveal mechanism, the source of the random numbers, batch size and timing (F30 Q4, design pending).]',
      '(c) Square Hole, or a party it names, prepares the art and holds the files and secret values that reveals need. Our policy bars the people who hold them from drawing. This cannot be fully enforced on chain.',
      '(d) Reveals can be late, and they depend on those files and values being published. [FOUNDER: reveal deadline, and who publishes the files and values if Square Hole stops (Fable review R-13).]',
      '(e) Once revealed, a Misfit’s art, traits and 3D model are public and cannot be changed.',
    ),
  },
  {
    n: '5.10',
    text: '**The per-Misfit FIT stream.**',
    items: items(
      '(a) Every trade in the Square Hole pool pays the pool fee in the coin paid in: ETH on a buy, FIT on a sell (11.2). The FIT part of the fees collected by Square Hole’s own positions (all of the pool fee until 32 blocks after graduation; less after that if others add liquidity, 5.7(e)) is split into equal shares, one for each Misfit in the collection.',
      '(b) The share of each Misfit inside the vault is burned. The share of each Misfit outside the vault is credited to the address that owns that Misfit when the trade happens. Before graduation every Misfit is inside, so the FIT part is burned in full.',
      '(c) You can claim what the contract holds for your address. Anyone can start a claim for you, and it pays only you. Credited amounts do not expire, and they stay claimable after you sell or give back the Misfit.',
      '(d) This is a mechanism written into the contracts. It is not income, interest, a dividend or a return on anything, and it gives nobody a right to any amount. Square Hole pays nothing: only the contract does, and it can fail. It depends on trading in the Square Hole pool, which may not happen, and an amount can be smaller than the network fee to claim it.',
      '(e) FIT holders receive nothing from the stream (5.4(e)).',
    ),
  },
  {
    n: '5.11',
    text: '**Direct sends are refused.**',
    items: items(
      '(a) The Misfits contract refuses a Misfit sent to the vault other than by the give-back action, and refuses Misfits sent to the collection contract itself. The FIT contract is designed to refuse FIT sent to the vault or to the FIT contract itself. [ENGINEERING: the FIT refusal is not built yet; it must be in place before FIT is created.] A refused send fails, and you lose only the network fee.',
      '(b) Other sends may not be refused, for example tokens of other contracts sent to a Square Hole contract, NFTs of other collections sent with a plain transfer, or Misfits sent to other Square Hole contracts. What such a send delivers can be lost for good. Nobody, including Square Hole, can recover it.',
    ),
  },
  {
    n: '5.12',
    text: '**Pools on other venues.** FIT and Misfits are ordinary tokens. Anyone can create a pool or market for them elsewhere. Trades there pay no Square Hole fees and fund no burns and no stream, and their prices can differ from ours. We do not control, check or endorse them.',
  },
  {
    n: '5.13',
    text: '**Platform mechanisms: burns, buy-and-burn, the sniper fee and the treasury.**',
    items: [
      {
        text: '(a) **What they are.** The contracts burn FIT from the vault fees (5.8), from the shares of Misfits inside the vault in the FIT part of pool fees (5.10), from the opening buy (11.1), and from the purchases of the buy-and-burn executor. The ETH part of the pool fee collected by Square Hole’s own positions (5.7(e)) is split: 2/15 (about 13%) goes to the Square Hole treasury, and 13/15 funds the buy-and-burn of FIT (11.2).',
      },
      {
        text: '(b) **The sniper fee.** For a short time after trading opens, the pool fee is planned to start higher and fall block by block to the normal pool fee. The extra part goes to the Square Hole treasury, not to the burn. It is meant to make buying in the first blocks more expensive. It cannot stop anyone from doing so. [FOUNDER + ENGINEERING: starting rate, number of blocks, and whether it also applies at graduation (F30 Q6, design pending).]',
      },
      {
        text: '(c) **The buy-and-burn executor.** It runs only after graduation, and anyone can call it. It buys FIT in the pool in small amounts, at most once per block, and only while the pool price is inside a narrow band around a time-weighted average price. It burns everything it buys. Outside the band, it waits. Its budget and schedule are public, so others can trade ahead of it (6.1(r)). [FOUNDER + ENGINEERING: whether callers receive anything towards gas.]',
      },
      {
        text: '(d) **Written into the contracts.** These mechanisms are designed to be fixed in the contracts at launch, with no admin, pause, upgrade or mint power. They are paid for by fees, not by our own money, and anyone can trigger them. We may run automated callers for them, and we may stop doing so. [ENGINEERING: confirm before any deployment that no admin key can change rates or splits.]',
      },
      {
        text: '(e) **What nobody promises.** A burn only lowers the number of tokens that exist. It pays nobody and gives nobody a right to anything. Nobody promises that burns will happen, how large or how frequent they will be, or that they will bring profit, yield, return, income, a price rise or price support. Market prices can fall to zero however many tokens are burned. Burns depend on trading, which may not happen or may move to outside pools (5.12), and on code, which can fail, be exploited or behave differently from this description. Nothing grows because someone calls these mechanisms a "flywheel": the word only names how fees move.',
      },
      {
        text: '(f) **Fee credits on today’s test boxes.** On the test boxes of 5.3(f), a contract credits part of each fee as the box’s fee choices say. You can claim what it holds for your address. Square Hole does not pay these amounts: only the contract does, and it can fail. They are not interest, a dividend or a return on anything, and they depend on trading that may not happen. The planned design has no such credits for FIT holders (5.4(e)).',
      },
      {
        text: '(g) **Code governs.** For any deployed contract, its code and published settings decide what happens, not the Services or these Terms.',
      },
    ],
  },
  {
    n: '5.14',
    text: '**Other collections.** Later Binds may follow the same pattern, each with its own token, collection and vault, or be set up differently. Their fee splits, including whether any part buys and burns FIT, who may open one, and any share for creators, are not decided. Each Bind’s rules are published before its first fee. [FOUNDER: rules for later Binds.]',
  },
  {
    n: '5.15',
    text: '**The cast.** The Sorter, The Coin, The Collector and The Stonk are storytelling characters. Owning one changes no fee and gives no extra rights.',
  },
  {
    n: '5.16',
    text: '**Changes to features.** We may change, add or remove features of the Services at any time. We may not be able to change a deployed contract, and some cannot be changed by anyone.',
  },
];

export const TERMS_SECTIONS: readonly TermsSection[] = DEMO_BUILD ? deepFreeze([
  {
    id: 'terms-1',
    n: '1',
    title: 'Introduction',
    clauses: [
      {
        n: '1.1',
        text: 'These Terms of Use (the "Terms") are an agreement between you and [COUNSEL: legal entity name, legal form, registered address and company number; no entity is formed yet] ("Square Hole", "we", "us", "our").',
      },
      {
        n: '1.2',
        text: 'They apply to the websites at squarehole.xyz, squarehole.fit and squarehole.fun, and to the test site at squarehole-7ua.pages.dev [FOUNDER: confirm the official addresses once they serve the site], and to every page, app view, data view and feature we offer through them (together, the "Services").',
      },
      {
        n: '1.3',
        text: 'You accept these Terms when you tick the box and select Accept. If you do not accept them, you may not use the Services, except to read these Terms, the About & risks page and the privacy notice. [COUNSEL: whether using the Services without that step should also count as acceptance.]',
      },
      {
        n: '1.4',
        text: '"You" means the person using the Services. If you use them for an organisation, "you" includes that organisation, and you confirm you have authority to bind it.',
      },
    ],
  },
  {
    id: 'terms-2',
    n: '2',
    title: 'Changes to these Terms',
    clauses: [
      { n: '2.1', text: 'We may update these Terms. Every version has a version number and a date.' },
      {
        n: '2.2',
        text: 'When we make a material change, we will show the new version when you next enter and ask you to accept it before you continue. [COUNSEL: confirm this notice approach.]',
      },
      { n: '2.3', text: 'A new version applies from when we publish it, to your use of the Services after that time.' },
      { n: '2.4', text: 'Changing these Terms does not change the code of any deployed smart contract.' },
      { n: '2.5', text: 'If you do not accept a new version, stop using the Services.' },
    ],
  },
  {
    id: 'terms-3',
    n: '3',
    title: 'No offer or advice; regulatory status',
    clauses: [
      {
        n: '3.1',
        text: '**What the Services are.** The Services describe Square Hole: its launches and their tokens, pools and NFTs, and its planned design for launches called "Binds", in which an NFT collection is held in a vault (Section 5). They show data read from blockchains, or sample data. Where offered, they also let you sign specific transactions with your own wallet (5.1).',
      },
      {
        n: '3.2',
        text: '**No offer and no advice.** Nothing in the Services is, or should be relied on as:',
        items: items(
          '(a) an offer to sell, or a request for an offer to buy, any security, investment contract, derivative, collective investment or other financial product or instrument, in any country;',
          '(b) a recommendation or encouragement to buy, sell, hold, burn, draw, pick, give back or launch anything, or to follow any strategy;',
          '(c) investment, financial, legal, tax, accounting or other professional advice; or',
          '(d) a promise that you can use any product or feature, now or later, or from where you are.',
        ),
      },
      {
        n: '3.3',
        text: '**Regulatory status.** Square Hole is not registered, licensed or authorised by the U.S. Securities and Exchange Commission, the U.S. Commodity Futures Trading Commission, the UK Financial Conduct Authority, or any other financial regulator anywhere. We make no statement that any registration, licence or authorisation will be sought or granted. [COUNSEL: confirm.]',
      },
      {
        n: '3.4',
        text: '**Guidance is not approval.** Statements by any regulator or its staff, including staff guidance on token buybacks or burns, do not approve Square Hole, its tokens or its mechanisms, and we do not claim that they do.',
      },
      {
        n: '3.5',
        text: '**Plans can change.** Anything the Services say about plans, designs or future launches is a current intention only. It may change or never happen. Designs in the Services and in our public documents are proposals until they are deployed.',
      },
      {
        n: '3.6',
        text: '**Your own judgement.** You alone decide whether to use any token, NFT, smart contract or third-party service. Get your own professional advice first.',
      },
    ],
  },
  {
    id: 'terms-4',
    n: '4',
    title: 'Eligibility',
    clauses: [
      { n: '4.1', text: 'You must be at least 18 years old, and old enough to make a binding contract where you live.' },
      {
        n: '4.2',
        text: 'You must not be a Restricted User. A "Restricted User" is any person or organisation that:',
        items: items(
          restrictedCountryClause(),
          '(b) is located in, resident in, organised in, or controlled from a country or region under comprehensive sanctions or embargo by the United Nations, the United States, the United Kingdom or the European Union [COUNSEL: list the countries and regions];',
          '(c) is named on a sanctions or restricted-party list kept by any of those authorities, such as the U.S. OFAC Specially Designated Nationals list, or is owned or controlled by someone who is [COUNSEL: confirm lists];',
          '(d) acts for, or on behalf of, anyone described in (a) to (c); or',
          '(e) is anywhere that using the Services, or any token, NFT or random draw connected with them, is against the law.',
        ),
      },
      { n: '4.3', text: 'You must not use a VPN, proxy or other tool to hide your location in order to get around this Section.' },
      {
        n: '4.4',
        text: '**You declare it yourself.** We do not block access by IP address or location. When you accept these Terms, you confirm that you are at least 18 and not a Restricted User, and you are responsible for that statement. We may still block access from any place or by any person where the law requires it or these Terms are broken.',
      },
    ],
  },
  {
    id: 'terms-5',
    n: '5',
    title: 'The Services and how Square Hole works',
    clauses: servicesClauses(),
  },
  {
    id: 'terms-6',
    n: '6',
    title: 'Acknowledgements and risks',
    clauses: [
      {
        n: '6.1',
        text: 'By accepting these Terms, you confirm that you understand and accept the risks below. The list is not complete.',
        items: items(
          '(a) **Total loss.** Any token or NFT connected with Square Hole can lose all of its value. You may get nothing back.',
          '(b) **Curve order and bots.** What you pay and receive on a curve depends on when you act compared with others. Bots and snipers often buy first, and a sniper fee does not stop them. Your transactions can be front-run, reordered or sandwiched.',
          '(c) **Failed launches.** Most launches never complete. A launch that never completes has no graduation and no closing process, and its Misfits never leave the vault.',
          '(d) **Smart contracts.** Contracts can contain bugs, be exploited or fail. They are not audited. Many cannot be upgraded or paused, so a bug may never be fixed.',
          '(e) **Randomness and oracles.** Reveals depend on random numbers from outside services, and the buy-and-burn executor on price averages. These can be late, fail, be switched off or be attacked.',
          '(f) **Placeholders and reveals.** Until its reveal, a Misfit is a placeholder, and nobody can tell what it will become. Reveals depend on Square Hole, or a party it names, publishing files and secret values. If those leak, are lost or are published early, a reveal can fail or favour people who learn them first. Reveals can be late, or never happen.',
          '(g) **The quote and the fees.** The quote can fall, for example after burns. A draw costs the quote plus 1%, a named pick the quote plus 25%, and a give-back releases the quote less 5%, each with network fees on top. Giving a Misfit back and drawing again costs about 6% of the quote each time, plus network fees, and people who repeat it to look for rare art can take the rarest Misfits out of the vault.',
          '(h) **Liquidity leaving our pools.** Trading can move to outside pools that pay no fees and fund no burns and no stream.',
          '(i) **Price impact.** Large trades, thin pools and busy blocks move prices against you. Network fees can be larger than a small trade, draw or claim is worth.',
          '(j) **Irreversible transactions.** Blockchain transactions cannot be undone. A wrong address, amount or network is usually permanent. Tokens sent to a contract address can be lost for good (5.11).',
          '(k) **Wallets and keys.** If your keys or recovery phrase are lost or stolen, your assets are gone. We cannot recover them.',
          '(l) **Regulatory change.** Laws, and how they are applied, change. A token, NFT, random draw or feature could become restricted or illegal where you are. We may then have to limit or close the Services.',
          '(m) **Tax.** You alone are responsible for your taxes. Buying, selling, burning, drawing, picking, giving back and claiming can each have tax effects.',
          '(n) **Fakes.** Copycat tokens and NFTs exist. A name, ticker or picture proves nothing. Check the exact chain and contract address.',
          '(o) **Test networks.** Test networks can reset, stall or change. Nothing on them carries over to any production network.',
          '(p) **Random draws.** What a drawn Misfit becomes is random, with odds from the published rarity counts. Most Misfits are common, and the Misfit you receive can be worth much less than the FIT you locked and the fee you paid.',
          '(q) **What the vault holds.** People tend to give back the most common Misfits, so the Misfits given back to the vault are often the most common ones. The vault can accept a Misfit that was reported stolen elsewhere.',
          '(r) **Timing games.** Bundled or front-running trades can be used to force or delay a graduation, or to trade ahead of the buy-and-burn executor, whose budget and schedule are public.',
          '(s) **The stream.** Amounts from the per-Misfit stream (5.10) are usually very small, depend on trading and can stop. Claiming them costs network fees.',
          '(t) **Outside liquidity.** After graduation, the part of the pool fee that funds the buy-and-burn, the treasury and the stream falls when others add liquidity to the pool (5.7(e)). Outside positions are locked for 32 blocks after each add.',
        ),
      },
      {
        n: '6.2',
        text: 'You confirm that you know enough about blockchains, wallets and tokens to judge these risks, and that you use the Services at your own risk.',
      },
      {
        n: '6.3',
        text: '**Your submissions.** When you create a launch or send us content (for example a name, ticker, image, description, links, a rarity table or NFT art), you confirm that:',
        items: items(
          '(a) it is accurate and not misleading;',
          '(b) you hold every right needed to use it, and it infringes nobody’s rights; and',
          '(c) it is lawful and contains no harmful code.',
        ),
      },
      { n: '6.4', text: 'Content written to a blockchain or to public storage is permanent and public. We cannot change or delete it.' },
      {
        n: '6.5',
        text: 'You give us a free, worldwide, non-exclusive licence to use, copy, display and process your content to run, show and improve the Services and to meet our legal duties [COUNSEL: scope and duration]. Sending content creates no confidential, fiduciary or other special relationship.',
      },
    ],
  },
  {
    id: 'terms-7',
    n: '7',
    title: 'Third-party services',
    clauses: [
      {
        n: '7.1',
        text: 'The Services rely on others, including blockchains and their validators, Uniswap and other protocols, randomness services (for example Chainlink VRF or drand), wallets, RPC and data providers, hosting (Cloudflare), storage for NFT art, indexers, NFT marketplaces, block explorers and trading venues.',
      },
      { n: '7.2', text: 'Their own terms and privacy policies apply to them. We do not control them.' },
      { n: '7.3', text: 'We show a link to a trading venue only after a recorded test of that route. A link is not an endorsement or a recommendation.' },
      {
        n: '7.4',
        text: 'Others see some of your data when you use the Services: our host receives your IP address with each page request, the RPC providers behind chain views receive the addresses those views look up, your wallet sees every transaction you sign, and sites you open from a link see your visit. Wallet extensions run their own code in your browser. The privacy notice has the details (17.6).',
      },
      {
        n: '7.5',
        text: 'We are not responsible for any third-party service, including its availability, accuracy or security, or for what you do there [COUNSEL: release wording].',
      },
    ],
  },
  {
    id: 'terms-8',
    n: '8',
    title: 'Intellectual property',
    clauses: [
      {
        n: '8.1',
        text: '**Our materials.** The text, design, graphics, logos, characters, artwork, documentation and software of the Services ("Square Hole Materials") belong to us or our licensors. Some software is open source under its own licence.',
      },
      {
        n: '8.2',
        text: '**Your permission.** While you follow these Terms, you may view and use the Services for your own personal, non-commercial purposes. This permission is limited, non-exclusive and non-transferable, and we may withdraw it.',
      },
      {
        n: '8.3',
        text: '**Limits.** Without our written permission, you may not copy, republish, sell, modify or build on Square Hole Materials, except where the law or an open-source licence allows it. We keep all rights we do not expressly grant.',
      },
      {
        n: '8.4',
        text: '**NFTs.** Owning an NFT gives you the token. It does not give you the copyright in its art. [FOUNDER + COUNSEL: licence for NFT holders, e.g. personal display, commercial use, limits.]',
      },
      {
        n: '8.5',
        text: '**Names and logos.** Square Hole uses the names "Square Hole", "The Misfits" and "FIT", the cast names and its logos. Do not use them in a way that suggests you are us or that we endorse you. [COUNSEL: who owns these names and logos and whether they can be registered; check "The Stonk" against StonkFun’s STONK.]',
      },
      {
        n: '8.6',
        text: '**Complaints.** To report content you believe infringes your rights, contact [COUNSEL: IP notice channel]. Tell us what the content is, where it is, who you are, and why you believe it infringes.',
      },
    ],
  },
  {
    id: 'terms-9',
    n: '9',
    title: 'Prohibited uses',
    clauses: [
      {
        text: 'You must not, and must not try to:',
        items: items(
          '(a) break any law or regulation, or use the Services for fraud or any unlawful purpose;',
          '(b) use the Services while you are a Restricted User, or hide your location to get around Section 4;',
          '(c) launder money, finance terrorism or evade sanctions;',
          '(d) manipulate markets, for example by wash trading or by coordinated schemes that mislead others about demand or price;',
          '(e) mislead others about a launch, a collection, its rarity counts or its art, or pretend to be someone else;',
          '(f) launch a collection using content you have no right to use;',
          '(g) upload malware, or attack, overload or disrupt the Services or the systems behind them;',
          '(h) get around any security measure or access control;',
          '(i) scrape the Services with bots or other automated tools, except through an interface we publish for that purpose;',
          '(j) use the Services to send spam or unsolicited promotion; or',
          '(k) if you prepare the art, hold reveal files or secret values, or are named to publish them, draw from a vault or help anyone else use that knowledge.',
        ),
      },
    ],
  },
  {
    id: 'terms-10',
    n: '10',
    title: 'Changes, suspension and termination',
    clauses: [
      {
        n: '10.1',
        text: 'We may change, pause or stop all or part of the Services at any time, including the website, data views and off-chain services, subject to any duty written into a deployed contract (such as a reveal deadline).',
      },
      { n: '10.2', text: 'We may block or end anyone’s access if we believe they broke these Terms, created legal risk or harmed others.' },
      { n: '10.3', text: 'Deployed smart contracts keep running whether or not the Services are available. We may not be able to change or stop them.' },
      { n: '10.4', text: 'To the extent the law allows, we are not liable to you for any change, pause, block or end described in this Section.' },
      { n: '10.5', text: 'Sections 3, 5.13, 6, 8 and 12 to 17 continue after your use ends.' },
    ],
  },
  {
    id: 'terms-11',
    n: '11',
    title: 'Charges and fees',
    clauses: [
      {
        n: '11.1',
        text: '**Launch.** No launch fee is currently proposed, other than network fees. In the planned design, creating a launch includes a small opening buy whose FIT is burned in the same transaction (currently proposed: 0.0015 ETH).',
      },
      {
        n: '11.2',
        text: '**Pool fee.** In the planned design, the Square Hole pool charges a fee on every trade (currently 1%), in the coin paid in. From 32 blocks after graduation, others can add liquidity to the pool and keep the part of the fee their liquidity collects (5.7(e)); what follows applies to the part collected by Square Hole’s own positions. The FIT part goes to the per-Misfit stream (5.10): shares of Misfits inside the vault are burned, and shares of Misfits outside are credited to their owners. Of the ETH part, 2/15 (about 13%) goes to the Square Hole treasury, and 13/15 buys FIT in the pool and burns it (5.13). In the first blocks after trading opens, a higher sniper fee applies, and its extra part goes to the treasury (5.13(b)). Every split is published before the first fee and fixed in the contracts. Today’s test boxes charge 1% of every buy and every sale, split as each box’s page shows (5.3(f)).',
      },
      {
        n: '11.3',
        text: '**Vault fees.** The draw fee (currently 1% of the quote), the named-pick premium (currently 25% of the quote) and the give-back fee (currently 5% of the quote) are paid in FIT and burned. They are flat: they do not change with rarity, with a Misfit’s number, or with how many Misfits have been given back.',
      },
      {
        n: '11.4',
        text: '**Rates.** The rates above are draft values [FOUNDER: final rates and the sniper-fee schedule]. The rates that apply are those shown in the app and fixed in the contracts before trading opens. If the Services and the contracts differ, the contracts apply.',
      },
      { n: '11.5', text: '**When charged.** Fees are taken by the contracts when your transaction executes. They are not refundable.' },
      {
        n: '11.6',
        text: '**Other costs.** You pay network (gas) fees and any fees of third-party venues, wallets and services. Network fees can make small actions, such as a single draw or a small claim, uneconomic.',
      },
      { n: '11.7', text: '**Future launches.** We may set different fees for future launches. We cannot change fees fixed in deployed contracts.' },
    ],
  },
  {
    id: 'terms-12',
    n: '12',
    title: 'No warranties',
    clauses: [
      { n: '12.1', text: 'The Services are provided "as is" and "as available". You use them at your own risk.' },
      {
        n: '12.2',
        text: 'To the fullest extent the law allows, we give no warranty of any kind, whether express, implied or statutory. This includes any warranty of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, availability or security.',
      },
      {
        n: '12.3',
        text: 'In particular, we do not warrant that:',
        items: items(
          '(a) the Services will be available, timely, secure or free of errors or harmful code;',
          '(b) any data, price, figure or chart shown is accurate, complete or current;',
          '(c) the smart contracts, randomness or reveals will work as described; or',
          '(d) the Services will meet your needs or expectations.',
        ),
      },
      {
        n: '12.4',
        text: 'Research, simulations and model figures published by Square Hole are model results under stated assumptions. They are not forecasts or promises.',
      },
      { n: '12.5', text: 'Nothing we say, in documents, on social media or in private messages, creates a warranty.' },
      {
        n: '12.6',
        text: 'Some laws do not allow certain warranties to be excluded. Where such a law applies, this Section applies only as far as that law allows. [COUNSEL: formatting needed for these clauses to be conspicuous.]',
      },
    ],
  },
  {
    id: 'terms-13',
    n: '13',
    title: 'Limitation of liability',
    clauses: [
      {
        n: '13.1',
        text: 'To the fullest extent the law allows, Square Hole, its affiliates, and their officers, employees, contractors, agents and licensors are not liable for any indirect, incidental, special, consequential, exemplary or punitive loss, or for any loss of profits, revenue, data, goodwill or opportunity, arising from or connected with the Services, however caused, even if it was foreseeable.',
      },
      {
        n: '13.2',
        text: 'This includes loss caused by smart-contract bugs, failures or exploits; blockchain, oracle or randomness failures; late, wrong or leaked reveals; front-running, sniping, fraud or other acts of third parties; third-party services and pools; lost or stolen keys; hacks, malware or denial-of-service attacks; and changes in law.',
      },
      {
        n: '13.3',
        text: 'Our total liability to you for all claims together is limited to the greater of [COUNSEL: amount] and the fees you paid directly to Square Hole in the [COUNSEL: period] before the claim arose.',
      },
      { n: '13.4', text: 'Nothing in these Terms limits any liability that the law does not allow to be limited [COUNSEL: carve-outs].' },
    ],
  },
  {
    id: 'terms-14',
    n: '14',
    title: 'Indemnity',
    clauses: [
      {
        n: '14.1',
        text: 'You will defend, indemnify and hold harmless Square Hole, its affiliates, and their officers, employees, contractors, agents and licensors against claims, losses, damages, costs and reasonable legal fees that arise from:',
        items: items(
          '(a) your breach of these Terms or of any law;',
          '(b) your use of the Services;',
          '(c) any content you submit or any launch you create; or',
          '(d) your use of any third-party service.',
        ),
      },
      { text: '[COUNSEL: consumer-law limits.]' },
    ],
  },
  {
    id: 'terms-15',
    n: '15',
    title: 'Disputes; class-action waiver; arbitration',
    clauses: [
      { text: '**[COUNSEL: this whole Section is a placeholder. Nothing in it is agreed or in force.]**' },
      {
        n: '15.1',
        text: '**Contact us first.** Before starting any claim, contact us at [COUNSEL: dispute contact channel] with a description of the dispute, your wallet address and any transaction concerned. We will try to resolve it within [COUNSEL: period].',
      },
      {
        n: '15.2',
        text: '**Arbitration.** [COUNSEL: whether disputes go to binding arbitration; institution and rules; seat; language; number of arbitrators; remote hearings; costs; any mediation step; any opt-out right; small-claims and urgent-relief carve-outs; mass-claim procedure.]',
      },
      {
        n: '15.3',
        text: '**Class-action and jury-trial waiver.** [COUNSEL: whether to include a waiver of class, collective and representative proceedings and of jury trial, and what happens where it is unenforceable.]',
      },
      { n: '15.4', text: '**Time limit.** [COUNSEL: time limit for bringing a claim, where lawful.]' },
      { n: '15.5', text: '**Confidentiality.** [COUNSEL: whether proceedings are confidential.]' },
      { n: '15.6', text: '**Changes to this Section.** [COUNSEL: how changes to this Section apply to existing disputes.]' },
    ],
  },
  {
    id: 'terms-16',
    n: '16',
    title: 'Governing law',
    clauses: [{ text: '[COUNSEL: governing law, seat of any arbitration, and courts with jurisdiction.] This draft names none.' }],
  },
  {
    id: 'terms-17',
    n: '17',
    title: 'General',
    clauses: [
      {
        n: '17.1',
        text: '**Transfer.** You may not transfer your rights or duties under these Terms without our written consent. We may transfer ours, for example to an affiliate or a successor.',
      },
      { n: '17.2', text: '**No waiver.** If we do not enforce a right, or delay enforcing it, we have not given it up.' },
      {
        n: '17.3',
        text: '**Severability.** If any part of these Terms is found invalid, it is limited or removed only as far as needed. The rest stays in force.',
      },
      {
        n: '17.4',
        text: '**Events outside our control.** We are not liable for delay or failure caused by events beyond our reasonable control, such as network or blockchain outages, attacks, failures of outside services, natural disasters, war, unrest, sanctions or changes in law.',
      },
      {
        n: '17.5',
        text: '**Notices.** We give notices by posting them in the Services. You agree to receive notices, agreements and disclosures electronically.',
      },
      {
        n: '17.6',
        text: `**Privacy.** Our privacy notice, on the page "Privacy notice" (${PRIVACY_PATH}), says what the Services keep on your device and who sees which data, including IP addresses and wallet addresses. [COUNSEL: a full privacy policy before any public launch, including the GDPR if people in the EU may use the Services.]`,
      },
      { n: '17.7', text: '**No third-party rights.** Only you and we can enforce these Terms [COUNSEL: exception for indemnified persons].' },
      {
        n: '17.8',
        text: '**No special relationship.** These Terms create no partnership, joint venture, agency, employment or fiduciary relationship.',
      },
      {
        n: '17.9',
        text: '**Whole agreement.** These Terms, and any document they refer to, are the whole agreement between you and us about the Services. They replace earlier versions.',
      },
      { n: '17.10', text: '**Language.** If a translation differs from the English text, the English text applies.' },
    ],
  },
  {
    id: 'terms-18',
    n: '18',
    title: 'Contact',
    clauses: [
      {
        n: '18.1',
        text: 'Questions about these Terms or the Services: [FOUNDER + COUNSEL: official contact channels, e.g. an email address and verified social accounts].',
      },
      {
        n: '18.2',
        text: 'Legal notices: [COUNSEL: postal address of the legal entity once it exists, or how to ask for it; StonkFun gives its legal name only on request].',
      },
      { n: '18.3', text: 'We will never ask for your recovery phrase or private keys. Anyone who does is not us.' },
    ],
  },
]) : TEST_NETWORK_BUILD ? TEST_NETWORK_NOTICE.document.sections : PRODUCTION_TERMS.document.sections;

/** The full Terms: front matter, sections and the closing line (rendered on `/about/terms`). */
export const TERMS_DOCUMENT: TermsDocumentCopy = DEMO_BUILD ? deepFreeze({
  title: 'Square Hole Terms of Use',
  status: 'DRAFT pending legal review. It may change, and you will be asked to accept the final version.',
  versionLine: `Version ${TERMS_VERSION} · Draft of ${TERMS_DATE_TEXT}`,
  disputeNotice:
    '**[COUNSEL: dispute notice. If the final Terms include mandatory arbitration and a class-action or jury-trial waiver, say so here in bold and point the reader to Section 15. If not, delete this line.]**',
  readFirst: {
    title: 'Read this first',
    bullets: [
      'Nothing in the Services is an offer or a request to buy or sell any security, derivative or other financial product, anywhere. Nothing in them is investment, legal, tax or other advice (Section 3).',
      'Square Hole is not registered, licensed or authorised by any financial regulator in any country (Section 3).',
      'Square Hole currently runs only on test chains, or with sample data. Test tokens have no value, and using them gives no right to any future token or allocation. No mainnet deployment exists, and none is authorised (Section 5.3).',
      'Sections 5.4 to 5.16 describe a planned design that is not deployed: FIT is created once and never again, the Misfits wait in a vault until graduation and come out as placeholders that are revealed later, and FIT holders receive no payouts. What this build does today is in Sections 5.1 to 5.3.',
      'You can lose everything you put into any token, NFT or transaction connected with Square Hole (Section 6).',
      'Burns and other mechanisms written into the smart contracts are not promises. Nobody owes you anything because of them (Section 5.13).',
    ] as readonly string[],
  },
  sections: TERMS_SECTIONS,
  closing: 'DRAFT pending legal review. It may change before it is final.',
}) : TEST_NETWORK_BUILD ? TEST_NETWORK_NOTICE.document : PRODUCTION_TERMS.document;

/**
 * The label of every legal link on the Sepolia test site, which all point to the test network notice (SH-TA-02); null
 * in every other build, where the links name the Terms of Use, their sections and the privacy notice.
 */
export const TEST_NETWORK_LINK: string | null = TEST_NETWORK_BUILD ? TEST_NETWORK_NOTICE.link : null;

/** Every sentence-bearing string of this build's gate and Terms, in reading order (for audits and tests). */
export function allTermsText(): string[] {
  return termsTextOf(TERMS_GATE, TERMS_DOCUMENT);
}
