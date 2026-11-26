/**
 * DRAFT FOR COUNSEL (SH-V2-FE7, founder 2026-10-10: "a production version" of the Terms, with no Demo). The Terms of
 * Use the production build (`SH_BUILD=production`) shows. The development build keeps its own text (terms.ts,
 * draft-7 since SH-V2-FE11); terms.ts picks one at build time.
 *
 * Source: the Terms draft-6 of the counsel pack (docs/legal/counsel-pack-2026-10.md, Part 3, 7 October 2026: box 0 as
 * built and the general core), with (1) every Demo and test-build sentence replaced, and (2) the founder decisions since
 * draft-6 applied: F112/F118 (price steps), F119 (one fee choice per side, no creator caps, the failure claim), F120 to
 * F123 (fees in the pricing token, the three Safes, listings), F126, F127 (claim-only payouts; its one-year sweep is gone, F136),
 * F128 (Claim all) and F129 (the edition size). docs/evidence/SH-V2-FE7.md has the side-by-side table: every old
 * sentence, its new one and why. Nothing here is reviewed by counsel.
 *
 * SH-V2-FE9 filled the facts the founder gave in desk round 45 (F131, 2026-10-11): Ethereum mainnet only, with Sepolia
 * on a separate test site; the official web addresses; the transactions the app offers at launch; no give-back-and-sell
 * route today; the policy for Square Hole's own boxes; the Misfit licence; the official channels. Each placeholder those
 * answers do not settle stays, and the policy and the licence keep a counsel check (docs/evidence/SH-V2-FE9.md).
 *
 * SH-V2-FE10 applied F133 and desk round 46 (F134, 2026-10-11): Square Hole's own boxes are never marked, but listed by
 * contract address on About & risks and on X (5.4(f)); the policy covers Square Hole itself, and counsel decides whether
 * the team needs a rule; the app's transactions include the coin-pile hand-in (5.1); the 69 Icons carry the Misfit
 * licence (8.4), with a counsel check of their wording; and (F135) a browser wallet connected on this device reconnects
 * without opening when the visitor comes back (5.2(c)) (docs/evidence/SH-V2-FE10.md).
 *
 * SH-V21-RC5-INT applied F136 (founder, 2026-10-15: no users' money may reach a wallet Square Hole controls; RC5-A and
 * RC5-B) as production draft-4: 5.19(c) to (e) take the text SH-RC5-A-FAILED-BOX suggested for counsel, adapted to the
 * wording rule (no "grow", "increase" or "earned"), and 6.1(c), 6.1(cc), 11.3, the gate and "Read this first" lose the
 * one-year sweep: claims never close, nothing is swept to FIT, and the share nobody claims stays locked for good.
 * DRAFT FOR COUNSEL: counsel has not seen these clauses (counsel pack, Question 43; docs/evidence/SH-V21-RC5-INT.md).
 * The rc5 fix round, still draft-4 (never deployed; only local test builds showed its first text), made 5.17(f),
 * 5.19(e) and 6.1(cc) match the contracts: a failed box sends nothing more to the conversion wallet, so royalties
 * in another token stay locked in it, and the capped closing payment is the one payment from the pot other than a
 * claim, possibly to our keeper. DRAFT FOR COUNSEL: counsel has not seen these sentences either.
 * The rc6 integration (SH-V21-RC6-INT, F137, 2026-10-16), still draft-4 (never deployed), made 5.19(d) match
 * SH-RC6-CLAIM-COLLECT: every claim on a failed box first moves the money held in the box's fee contract into the pot,
 * so no claim waits for someone's separate collect. DRAFT FOR COUNSEL: counsel has not seen this sentence.
 * The rc6 integration's part 2 (SH-V21-RC6-INT, F137 and F138, 2026-10-17), still draft-4 (never deployed): 5.4(b) names
 * two wallets (no conversion wallet); 5.17(a), (e) and 11.2 take the plain hook's sale fee in the box's token, burned
 * until graduation and in a failed box, sold by the box in its own pool after graduation; 5.17(f), 5.19(c) to (e) and
 * 6.1(v), (aa) and (cc) describe each box's inbox (pricing tokens split like buyers' fees, listed tokens offered on the
 * CoW Protocol, the 30-day in-kind exit to the creator's payout address, a failed box's tokens in kind at once, the
 * creator's remainder plus later inbox pricing tokens); 11.8 names the CoW Protocol's part of each sale.
 * DRAFT FOR COUNSEL: counsel has not seen these sentences (counsel pack, Question 44).
 * The part 2 fix round (SH-V21-RC6-INT, 2026-10-18), still draft-4 (never deployed), made 5.4(b) and 5.17(f) match the
 * contracts: the pricing tokens reaching the inbox pay FIT's 2/15 and Square Hole's 1/15 to the two wallets as fee
 * shares (the receiver's split), an inbox offer is open only once someone posts it to the CoW Protocol's order book
 * (our keepers post only when CoW quotes at a fee of about 5% or less), and when the 30 days start. DRAFT FOR COUNSEL:
 * counsel has not seen these sentences either (Question 44).
 * SH-TERMS-ACCURACY (sh-146, 2026-10-29), still draft-4 (never deployed: the Sepolia test site shows the test network
 * notice in its place, terms.ts), made the sentences a fact check found wrong match the code and the decision log.
 * 5.11(b) and 6.1(e): box 0 has F143's RANDAO backup (BoxBackedSource: anyone may start it from 5 days after a drand
 * round's time while the round is unposted, until 5 days 18 hours; the block 256 later gives the number; one start per
 * round), and no other box has one (core v2's factory admits only the pinned DrandSource). 5.17(c): the platform
 * wallet needs two of three signatures on mainnet (F151 R68-SAFE, the latest word on F95 R19L's and F121's single
 * signer; Sepolia's stays 1-of-1), with a founder placeholder for its three signers, which F151 does not name.
 * 5.17(b): the third policy for items still in the vault, the box's own pool (`ItemsInsidePolicy.Depth`,
 * RecipeTypes.sol; core v2.1 step 5, docs/design/core-v21-step5-items-pool.md), next to keep and burn. DRAFT FOR
 * COUNSEL: counsel has not seen these sentences (docs/evidence/SH-TERMS-ACCURACY.md).
 * SH-245 (F213, 2026-11-22), still draft-4 (never deployed): the cap policy on other boxes leaves the draft. 5.17(d)
 * says Square Hole keeps its whole 1/15; risk (v), the fees summary and the gate's fee bullet drop their cap clauses.
 * Box 0's own code cap (5.15) is not changed here. DRAFT FOR COUNSEL: counsel has not seen these sentences.
 *
 * Placeholders (`[COUNSEL: …]`, `[FOUNDER: …]`, `[ENGINEERING: …]`) mark every fact this text does not have. They are
 * highlighted on the pages; `pnpm build:production` refuses to finish while any of them is in its output
 * (placeholder-guard.ts) and `pnpm check:production` lists them, so this text cannot be uploaded until the founder and
 * counsel have filled or struck each one. It invents no entity, jurisdiction, network or promise.
 *
 * The wording rules of terms.ts apply (wording.ts, SEC staff FAQ Q2.5): mechanics only, never yield, return, profit,
 * price support or growth; "give back" for the vault action; and the founder's rule for a failed box (F99, F100): its
 * holders claim from a pot (F136: their share of the live pot, without expiry), and no word for money paid back names
 * that payment.
 */
import {
  BOX_0_ADDRESSES,
  PRIVACY_PATH,
  deepFreeze,
  eligibilityBullet,
  items,
  restrictedCountryClause,
  type TermsClause,
  type TermsDocumentCopy,
  type TermsGateCopy,
  type TermsSection,
} from './terms-common';

export interface ProductionTerms {
  /** Stored with each acceptance; a different stored version shows the gate again. */
  readonly version: string;
  /** Date of this version (ISO) and as shown. */
  readonly date: string;
  readonly dateText: string;
  readonly gate: TermsGateCopy;
  readonly document: TermsDocumentCopy;
}

/** The status lines stay true until counsel has approved the text; then they go, with a new version (Question 1). */
const COUNSEL_SIGN_OFF = '[FOUNDER + COUNSEL: delete this line once counsel has approved the final text (counsel pack, Question 1).]';
/** F131 R45A, said the same way wherever the network is named: true on the main site and on the separate test site. */
const MAINNET_ONLY = 'At squarehole.fun, Square Hole runs on Ethereum mainnet only.';
const TEST_SITE = 'The Sepolia test network has a separate test site.';

function services(): TermsClause[] {
  return [
    {
      text: 'Sections 5.1 to 5.3 describe the Services and their status. Sections 5.4 to 5.15 describe how boxes work, starting with box 0: The Misfits and FIT. Sections 5.16 to 5.21 describe every other box, which anyone can create. [ENGINEERING: check Sections 5.4 to 5.21 against the contracts deployed for launch.]',
    },
    {
      n: '5.1',
      text: '**What you can do.** You can browse boxes, NFT collections and their data; read risk information; copy contract addresses; and follow links to third-party venues and block explorers. Where the app offers it, you can also connect your own wallet and sign specific transactions: creating a box; claiming amounts a contract holds for your address (5.18), one by one or with "Claim all", and bringing a box’s item ledger up to date before an item claim (5.18(c)); closing a box that can be closed (5.19(b)) and, in a failed box, handing in your box tokens for your share of its pot (5.19(d)); after graduation, handing in box tokens to a box’s coin pile, which burns them, for your share of the pile, and, if the box fails, returning the pile’s seed to its creator (5.21(b)); drawing a box’s NFTs from its vault and handing them back (5.10); and the token approvals some of these need first. The app offers no buying or selling (5.2(a)).',
    },
    {
      n: '5.2',
      text: '**What we do not do.**',
      items: items(
        '(a) **No trading in the app.** The Services have no trade form, order book or swap screen. Pool trading happens only on third-party venues. Vault actions (5.10) are contract calls with a box’s vault that lock or release tokens against an NFT; they are not pool trades. A combined route that gives an NFT back and sells the released tokens in one step is not offered today; it may come in a later version (3.5).',
        '(b) **No custody.** We never hold your tokens, NFTs, funds or keys. We cannot move, freeze, recover or reverse anything in your wallet.',
        '(c) **No accounts.** You do not sign up. Browsing never opens your wallet or asks you to approve anything. If you connected a browser wallet on this device, the app remembers it here and, when you come back, asks that wallet, without opening it, whether it still shares your address; Disconnect makes it forget. A wallet request that needs your approval only happens after you choose to connect and start an action.',
        '(d) We do not act for you, trade for you, or guarantee any token, NFT or transaction.',
      ),
    },
    {
      n: '5.3',
      text: '**Status at the date of these Terms.**',
      items: items(
        `(a) ${MAINNET_ONLY} Each page of the Services names the network a box runs on and its contract addresses. ${BOX_0_ADDRESSES} ${TEST_SITE}`,
        '(b) Where the Services show a test network (labelled "Testnet"), its tokens, test ETH and test NFTs have no value. We do not exchange them for anything of value.',
        '(c) The smart contracts have not been audited by an outside firm. Our own reviews are not audits.',
        '(d) Nothing in the Services promises any launch, release or date.',
        '(e) Using the Services, a test network or a test token gives you no right to any future token, NFT, allocation or airdrop. Nothing you do on a test network carries over to a production network.',
      ),
    },
    {
      n: '5.4',
      text: '**Boxes.**',
      items: [
        {
          text: '(a) A box is one launch. It links one new token to one pricing token (the coin buyers pay with) and one pool, and it may hold an NFT collection in a vault, a shop or a coin pile (5.21). Box 0 is the first: The Misfits collection and its token FIT, priced in ETH. Square Hole creates box 0. Box 0 runs on contracts of its own; every other box runs on one shared set of contracts (5.16).',
        },
        {
          text: '(b) No box contract (a box’s token, its pool’s hook, its vault, its fee receiver, its launch router, its inbox for royalties and other tokens, its payout ledgers, and FIT’s buy-and-burn) has an owner, admin, pause, upgrade or rescue function, and none can create tokens except by its public rules. Nobody, including Square Hole, can change a box’s settings, fees or splits, stop it, or move tokens out of it except by its public rules. Some public functions, which anyone may call, move a box’s waiting money onward, but only where that box’s rules send it. Square Hole keeps only these roles:',
          bullets: [
            'the one-time right to create box 0, used when box 0 is created;',
            'the "owner" field of the Misfits collection, which no contract function reads and which marketplaces use only to let us edit the collection’s page there (5.6(d));',
            'the lister role of the listing registry, which can add pricing tokens, change a listed token’s raise for boxes created afterwards, and hand over or give up that role, but can never remove a listing or change an existing box (5.20(a));',
            'the two wallets that receive money from every box other than box 0: the FIT buy-back wallet and the platform wallet. The contracts pay them only FIT’s and Square Hole’s fee shares; what happens to that money then depends on us, not on code (5.17(c)). Those shares include 2/15 and 1/15 of the pricing tokens that reach a box’s inbox, from royalties, gifts or its sales; no other token sent to a box reaches a Square Hole wallet (5.17(f)).',
          ],
        },
        {
          text: '(c) Anyone can call the public functions that keep a box running, such as collecting fees, graduation, adding to the pool, buy-backs, draws, claims and closing a box. Some of them pay the caller a small amount (5.15(e), 5.17(e)). We run automated callers ("keepers") for some of them, and we may stop.',
        },
        {
          text: '(d) We may publish a later version of the contracts next to an earlier one. A later version never changes an existing box. Box 0 never changes.',
        },
        {
          text: '(e) **Code governs.** For any deployed contract, its code and published settings decide what happens, not the Services or these Terms.',
        },
        {
          text: '(f) **Square Hole’s own boxes and holdings.** Square Hole, the founder and anyone working with them may create boxes, and may hold and trade FIT, Misfits and other box tokens, like anyone else, except that Square Hole itself follows the policy below. No badge or label in the feed or on a box’s page says that a box is Square Hole’s own; the feed shows box 0 first, marked "Featured", which is its place in the feed, not an approval. Instead, the About & risks page lists them with their contract addresses, box 0 first, and we post the same addresses on X (18.1). The list discloses which boxes are Square Hole’s own and lets you check a box’s real contract address against copies (6.1(n)); it is not an approval of any box. Our policy, which covers Square Hole itself: it does not trade the tokens of its own boxes, and FIT in its wallets moves only through our published daily bot (5.17(c)). [COUNSEL: check this policy, and whether the founder and the people working with Square Hole need a rule too (Question 23).]',
        },
      ],
    },
    {
      n: '5.5',
      text: '**FIT.**',
      items: items(
        '(a) FIT is box 0’s token. It is also the Square Hole platform token: part of every other box’s fees is used to buy FIT and burn it (5.17(c)).',
        '(b) FIT is created once, when box 0 is created: 1,000,000,000 FIT. The FIT contract has no function to create more, so the supply can never go above that number. None of it is set aside for Square Hole, a team or a creator, and box 0 has no creator buy.',
        '(c) Anyone may burn their own FIT. A burn cannot be undone, and it lowers the supply. A burn is refused if it would take the supply below the FIT locked in the vault (plus a tiny technical amount). FIT sent to a "dead" address such as 0x…dEaD is not burned: it still counts in the supply.',
        '(d) FIT’s only link to the vault is the vault’s rules (5.10): FIT can be locked to take a Misfit out, and a Misfit can be given back for FIT released from the vault. Holding FIT gives you no ownership of, and no claim on, any Misfit, the vault, Square Hole or its funds, and no vote, no dividend and no claim against anyone.',
        '(e) **FIT holders receive no payouts.** No fee, burn or other mechanism pays or credits anything to anyone because they hold FIT.',
      ),
    },
    {
      n: '5.6',
      text: '**The Misfits and the vault, before launch.**',
      items: items(
        '(a) The Misfits collection has [FOUNDER: the final number of Misfits, which the founder’s curation sets (F129)] NFTs, each called a "Misfit" and numbered from 1. All of them are created straight into the vault when box 0 is created. The vault is a smart contract that holds them. Nobody, including Square Hole, can create or destroy a Misfit afterwards, or take one out except by the vault’s rules, and no Misfit can leave the vault before graduation (5.8).',
        '(b) The art of every Misfit (its pictures, its traits and its 3D model) is made before launch and fixed on chain by its fingerprint (a hash), so it cannot be changed afterwards. All traits are stored on chain. Which art belongs to which number is fixed before launch and stays hidden until each reveal (5.11). How many Misfits there are of each rarity is published before trading opens.',
        '(c) The collection’s name, description and pictures, the placeholder’s name and text, and every trait name are written on chain when box 0 is created. Nobody can change them afterwards.',
        '(d) The collection’s "owner" field names Square Hole’s wallet. It gives no power on chain. Marketplaces use it only to let us edit the collection’s page there.',
        '(e) **The Icons.** 69 Misfits, the "Icons", are playful homages to well-known stocks, assets, tokens and NFT collections. They are caricatures drawn by Square Hole. No company or project they bring to mind made, approved or endorsed them, and owning one gives no right in any brand. [COUNSEL: this wording (the founder reports that counsel cleared the Icons, F115).]',
        '(f) Teaser art is for illustration. It does not tell you what any Misfit will be.',
      ),
    },
    {
      n: '5.7',
      text: '**Opening, the launch window and the curve.**',
      items: items(
        '(a) **Opening.** Creating box 0 includes an opening buy of 0.0015 ETH, made before trading opens and without the launch-window tax. The FIT it buys is burned at once. Trading opens at a time fixed when box 0 is created: the next block, or a set time up to 14 days later. Before then nobody can trade.',
        '(b) **The curve.** 798,137,969.32 FIT (about 79.81% of the supply) are sold on a price curve against ETH until exactly 4.206980085 ETH is raised. Each buy moves the price up. Each sell moves it down. From the first FIT sold to the last, the price goes up about 14.7 times. Filling the curve takes about 4.25 ETH from buyers, because of the 1% fee (5.15), plus any launch-window tax.',
        '(c) **Selling back.** Until the curve closes, anyone can sell FIT back into the curve at its price at that moment, less the fee. The price never goes below the curve’s starting price. People who buy early and sell are paid with ETH that others put in. Late buyers, and people who never sell, usually lose the most.',
        '(d) **The launch window.** For 6.4 minutes after trading opens (32 steps of 12 seconds), buys go only through Square Hole’s launch contract, and each buy pays a launch-window tax on top of the fee. The tax is a share of the ETH sent: 93.1974% in the first step, falling by a published table to 8.0565% in the last step, and nothing after the window. Other apps and routers cannot buy during the window. Sells work as normal. For example, a buy that puts about 2.3 ETH into the curve in the first step pays about 32 ETH of tax.',
        '(e) **Bots.** Automated traders ("bots" or "snipers") often buy first. The launch-window tax is meant to make the first minutes expensive for them. It cannot stop them.',
        '(f) **Where the tax goes.** The launch-window tax never goes to Square Hole or to FIT. It is held in the launch contract until graduation. After graduation anyone can move it into box 0’s pool budget, where it is added to the pool’s permanent liquidity in small hourly steps (5.9(c)). That can take weeks or months. Part of each step buys FIT in the pool.',
        '(g) **No deadline for box 0.** Box 0 has no deadline, no closing process and no claim pot. A curve that never reaches its target keeps running: people can still sell back into it, and the Misfits never leave the vault.',
        '(h) Most bonding-curve launches never reach their target. Across launchpads, only a few in every hundred do. If box 0’s curve never completes, some ETH and FIT stay locked for good where nobody, including Square Hole, can move them: the launch-window tax, the shares of buyers’ fees held for graduation (5.15(c)), the pool’s share of sellers’ fees, and the payment reserved for whoever triggers graduation.',
        '(i) **Launch announcement.** Box 0’s pool may exist, and its address may be visible on chain, before we announce it. We plan to announce the end of the launch window as the launch time. [COUNSEL: whether and how this must be disclosed in advance.]',
      ),
    },
    {
      n: '5.8',
      text: '**Graduation.**',
      items: items(
        '(a) The buy that brings the curve to its target closes it at once. If that buy sends more ETH than the curve needs, the unused ETH, and its tax, go back to the buyer in the same transaction. After the close, every trade is refused until someone triggers graduation. Anyone can trigger it, in one transaction. It runs once.',
        '(b) Whoever triggers graduation receives a small payment of at most 0.1% of the raise (0.0042069 ETH). It is paid only from fees the curve collected, never from the raise. We may trigger graduation ourselves.',
        '(c) At graduation the curve ends and no ETH leaves the Square Hole pool. The pool is laid out across all prices. The rest of the FIT supply (201,862,030.68 FIT, about 20.19%, plus any FIT the curve still holds) is placed at prices from the graduation price up to the highest price the pool supports. The ETH is placed at prices from the graduation price down to the lowest, part of it below the curve’s starting price. FIT that these positions cannot take is burned. From then on FIT trades in that pool against ETH, with the 1% fee of 5.15.',
        '(d) From graduation on, Misfits can be taken out of the vault (5.10).',
        '(e) Graduation cannot be undone.',
      ),
    },
    {
      n: '5.9',
      text: '**The closed pool.**',
      items: items(
        '(a) Box 0’s pool is closed to outside liquidity for good. The contract refuses every add or removal of liquidity by anyone else, and every donation. Nobody can add their own liquidity to it or share in its fees.',
        '(b) The box’s own liquidity is held by its pool contract. Nobody can remove or move it, including Square Hole.',
        '(c) **Pool budget.** Box 0’s pool share of fees (5.15(a)), the launch-window tax, Square Hole’s share above its cap (5.15(b)) and gifts go into a budget for the pool. Anyone can add this budget to the pool’s permanent liquidity, at most once an hour, in limited amounts, and only while the price is close to its average over the last hour. ETH with no FIT to pair with is partly used to buy FIT in small steps first. What is added can never be removed.',
        '(d) The Uniswap app, DEX Screener and similar sites may show warnings about this pool, for example that its liquidity is locked or that it uses custom code. [COUNSEL: this wording.]',
      ),
    },
    {
      n: '5.10',
      text: '**The vault.**',
      items: items(
        '(a) **The quote.** One quote applies to every vault action: the FIT that exists and is not locked in the vault, divided by the number of Misfits in the vault. Every Misfit counts the same, whatever its art, rarity or number. The quote can change between when you see it and when your transaction runs.',
        '(b) **Placeholders during the curve.** From the opening until graduation, you can lock FIT equal to the quote in the vault and pay a fee of 1% of the quote, which is burned, to receive a "Misfit placeholder": an NFT that becomes one Misfit after graduation (5.11). All placeholders look the same. Before graduation you can hand a placeholder back and receive the quote, less a fee of 5% of the quote, which is burned.',
        '(c) **Draw.** After graduation, you lock FIT equal to the quote in the vault and pay a draw fee of 1% of the quote, which is burned, plus a small ETH payment for the random number (5.11(c)). You receive one Misfit that has not been revealed yet. You cannot choose which one.',
        '(d) **Named pick.** You can take a specific Misfit that has already been revealed and was given back to the vault. You lock the quote in the vault and pay a premium of 25% of the quote, which is burned. Outside terminal mode (5.11(f)), a Misfit that has not been revealed can never be picked by name. Picks are first come, first served, and automated traders are often first.',
        '(e) **Give back.** You can give a Misfit back to the vault. The vault takes it from your wallet, with your approval, and releases FIT equal to the quote to you, less a give-back fee of 5% of the quote, which is burned. A Misfit that left the vault unrevealed can be given back only after its reveal, or 30 days after it left.',
        '(f) **Locked FIT is not a deposit.** FIT you lock does not stay yours and is not kept for you. It stays in the vault and is released only to someone who gives a Misfit or a placeholder back, or, in terminal mode (5.11(f)), to a drawer whose pending draw is cancelled. Nobody, including Square Hole, can take FIT out of the vault in any other way.',
        '(g) **Flat fees.** Vault fees are a fixed share of the quote. They do not change with rarity, with a Misfit’s number, or with how many Misfits have been given back.',
        '(h) **The last Misfit** can never leave the vault.',
        '(i) **What moves the quote.** Every burn of FIT, by anyone, lowers the quote. This includes the vault fees, the burns of 5.12 and the buy-and-burn of 5.15. You have no right to any particular quote or Misfit, or to the vault holding any Misfit at all.',
        '(j) **After you take it out**, a Misfit is an ordinary NFT. Its only remaining links to the vault are the give-back action and the stream of 5.12. Marketplaces may show it late or incorrectly. Moving a Misfit needs about 514,000 gas available (gas not used is not charged), so a wallet, marketplace or tool that sends a fixed lower amount may fail to move it.',
      ),
    },
    {
      n: '5.11',
      text: '**Placeholders, random numbers and reveals.**',
      items: items(
        '(a) Until it is revealed, a Misfit shows the same placeholder as every other unrevealed Misfit: the same picture and no traits. Everyone who draws one receives one alike.',
        '(b) **Random numbers.** A public random number from drand, a randomness network run by independent organisations, decides which Misfit each placeholder or draw receives. At graduation, placeholders cannot be transferred until the graduation number arrives; it decides which Misfit each placeholder becomes, and each holder can then open theirs. After graduation, each draw uses its own drand round, usually ready about 12 seconds after the request. Box 0 has one backup, fixed in its contracts: if a drand round it asked for is still not posted on chain 5 days after the round was due, anyone can start the backup for that round, until 5 days 18 hours after it was due. Until someone does, anyone can still post the drand round, and whichever comes first counts. The backup is Ethereum’s own random number (RANDAO) of the block 256 blocks after the start, about 51 minutes later (the backup block). It becomes the round’s number once anyone posts the backup block’s data, which is possible for about 27 hours after that block. A round’s backup can start only once, and a round on its backup never uses drand’s number, even if drand’s is posted later. The validator that proposes the block just before the backup block can still choose between two numbers, by publishing its own block or not; one that proposes several blocks in a row there has more choices. If nobody posts the backup block’s data in time, the safety net of 5.11(f) applies. Every other box uses drand alone, with no backup.',
        '(c) The first draw in a drand round pays whoever posts that round on chain (600,000 times the network’s base fee; about 0.0003 ETH at a base fee of 0.5 gwei). Later draws in the same round get back what they sent for it.',
        '(d) **Reveals.** Showing a Misfit’s art needs secret reveal data. Square Hole prepares the art and holds that data on its own systems. Anyone who has the data can publish a reveal. The design aims that nobody, including Square Hole, can choose or predict which Misfit a placeholder or a draw receives.',
        '(e) Our policy bars everyone who holds or can see the reveal data from drawing, or taking Misfits by number. This cannot be fully enforced on chain.',
        '(f) **Safety net.** If no usable random number arrives within 7 days of a request, anyone can switch the vault into a safe mode ("terminal mode"). For the graduation number the limit is 7 days after someone asks for it, or, if nobody has asked for it, 30 days after graduation. Terminal mode is permanent: random draws and the graduation number stop for good. Pending draws can then be cancelled, and the drawer receives the quote with no fee. Placeholders still waiting for the graduation number can be handed back with no fee. From 3 days after terminal mode starts, anyone can take a specific unrevealed Misfit by its number for the quote plus 1%. A Misfit delivered without its reveal can be opened without it after 30 days, and given back unrevealed 30 days after it left (about 60 days in all). If the reveal data were lost, the hidden art of some Misfits might never be shown.',
        '(g) Once revealed, a Misfit’s art, traits and 3D model are public and cannot be changed.',
      ),
    },
    {
      n: '5.12',
      text: '**The per-Misfit FIT stream.**',
      items: items(
        '(a) Every trade in the Square Hole pool pays the fee in the coin paid in: ETH on a buy, FIT on a sell (5.15). 13/15 of the FIT part is split into equal shares, one for each Misfit in the collection. The other 2/15 goes into the pool budget (5.9(c)).',
        '(b) Before graduation every Misfit is inside the vault, so the 13/15 is burned in full. After graduation, the share of each Misfit inside the vault is burned, and the share of each Misfit outside the vault is credited to the address that owns that Misfit when the fees are booked, including a contract.',
        '(c) You can claim what the contract holds for your address. Anyone can start a claim for you, and it pays only you. Credited amounts do not expire, and they stay claimable after you sell or give back the Misfit.',
        '(d) This is a mechanism written into the contracts. It is not income, interest, a dividend or a return on anything, and it gives nobody a right to any amount. Square Hole pays nothing: only the contract does, and it can fail. It depends on trading in the Square Hole pool, which may not happen, and an amount can be smaller than the network fee to claim it.',
        '(e) FIT holders receive nothing from the stream (5.5(e)).',
      ),
    },
    {
      n: '5.13',
      text: '**Direct sends are refused.**',
      items: items(
        '(a) The FIT contract refuses FIT sent to the vault, other than by the vault’s own actions, and FIT sent to the FIT contract itself. The Misfits contract refuses a Misfit sent to the vault other than by the give-back action, and refuses Misfits sent to the collection contract or the FIT contract. A refused send fails, and you lose only the network fee.',
        '(b) Other sends may not be refused, for example tokens of other contracts sent to a Square Hole contract, NFTs of other collections sent with a plain transfer, or Misfits sent to other Square Hole contracts. What such a send delivers can be lost for good. Nobody, including Square Hole, can recover it.',
      ),
    },
    {
      n: '5.14',
      text: '**Pools on other venues.** FIT, Misfits and every box token are ordinary tokens. Anyone can create a pool or market for them elsewhere. Trades there pay no Square Hole fees and fund no burns, no pool budget, no payouts and no stream, and their prices can differ from ours. Trading apps may route your trade through such a pool. We do not control, check or endorse them.',
    },
    {
      n: '5.15',
      text: '**Box 0’s fees: burns, buy-and-burn, the pool and Square Hole’s share.**',
      items: [
        {
          text: '(a) **The fee.** Every trade in box 0’s pool pays a fixed fee of 1%, in the coin paid in. Fees are collected in batches (of at least 0.005 ETH) by anyone, and the code splits each batch in fifteenths:',
          bullets: [
            'buyers’ fees (in ETH): 11/15 buy FIT in the pool and burn it; 2/15 go into the pool budget (5.9(c)); 2/15 go to Square Hole;',
            'sellers’ fees (in FIT): 13/15 are burned, or after graduation go to the per-Misfit stream (5.12); 2/15 go into the pool budget. Sells pay Square Hole nothing.',
          ],
        },
        {
          text: '(b) **Square Hole’s share is capped.** Square Hole keeps at most 32 ETH from box 0 in each 30-day period, counted from graduation, with no carry-over. Anything above goes into the pool budget. Square Hole receives nothing from the launch-window tax, from sellers’ fees or from vault fees.',
        },
        {
          text: '(c) **Before graduation.** Until box 0 graduates, every ETH share is held: nothing reaches Square Hole, the buy-and-burn or the pool. If box 0 never graduates, these shares stay locked for good.',
        },
        {
          text: '(d) **The buy-and-burn.** A separate contract with no owner buys FIT in the pool and burns everything it buys. It runs only after graduation, and anyone can trigger it. It buys in small amounts, at most once per block, each moving the price only a little, and only while the price is close to its average over the last hour. Its budget and schedule are public, so others can trade ahead of it (6.1(r)). Whoever triggers it is paid nothing. Part of other boxes’ fees reaches it through our FIT buy-back wallet (5.17(c)).',
        },
        {
          text: '(e) **Small payments to callers.** Some public functions pay whoever calls them a small amount from what they move, to cover the network fee: for example collecting fees (10% of the batch, at most 0.0005 ETH) and adding to the pool (5% of what is spent, at most 0.0005 ETH). Anyone can call them. Our own keepers receive these payments when they call.',
        },
        {
          text: '(f) **Written into the contracts.** These mechanisms are fixed in the contracts, with no admin, pause, upgrade or mint power. They are paid for by fees, not by our own money, and anyone can trigger them. We may run automated callers for them, and we may stop doing so.',
        },
        {
          text: '(g) **What nobody promises.** A burn only lowers the number of tokens that exist. It pays nobody and gives nobody a right to anything. Nobody promises that burns will happen, how large or how frequent they will be, or that they will bring profit, yield, return, income, a price rise or price support. Market prices can fall to zero however many tokens are burned. Burns depend on trading, which may not happen or may move to outside pools (5.14), and on code, which can fail, be exploited or behave differently from this description. Nothing grows because someone calls these mechanisms a "flywheel": the word only names how fees move. The same applies to the buy-backs and burns of every other box (5.17).',
        },
        {
          text: '(h) **Pool budget.** Adding to the pool, and buying FIT for it, are done by fixed code from fees, the launch-window tax and Square Hole’s share above its cap. They are not price support, and nobody promises any particular price or liquidity. [COUNSEL: this wording.]',
        },
        {
          text: '(i) **Royalties.** The Misfits declare a royalty of 2.5% of each sale under a common standard (ERC-2981). Marketplaces decide whether to pay it, and many do not. Royalties paid in ETH or wrapped ETH are split like buyers’ fees (11/15, 2/15 and 2/15), and Square Hole’s part counts within its 32 ETH cap. Royalties paid in any other token can never be moved by anyone.',
        },
      ],
    },
    {
      n: '5.16',
      text: '**Other boxes.** Every box other than box 0 runs on one shared set of contracts, the same for every box of a release.',
      items: items(
        '(a) **Who creates.** Anyone can create a box, through the Services or by calling the contracts directly. The person who creates a box is its "creator". Square Hole does not create, run, check or endorse other people’s boxes, and is not a party to anything a creator promises. Square Hole may also create boxes itself (5.4(f)).',
        '(b) **Settings are fixed.** The creator chooses the box’s settings at creation: its name, ticker and logo; its pricing token; what it holds (a new NFT collection, a shop, a coin pile, or just its token); one fee choice for each side (5.17(b)); its deadline; its royalty; and its add-ons. Every setting is fixed at creation and cannot change afterwards. Only the address that receives the creator’s payouts can change, and only by its current holder; and in a shop, its curator can add collections (5.21(a)). Each box’s page shows its settings.',
        '(c) **Pricing tokens.** A box can be priced in ETH or in a token on Square Hole’s list (5.20), which can include FIT and the tokens of graduated boxes. Each box raises the amount the list names for its pricing token when the box is created (for ETH, 4.206980085 ETH at the date of these Terms), and keeps that raise.',
        '(d) **Opening and the creator buy.** Creating a box costs network fees and a small opening buy. Square Hole charges no creation fee. A creator may buy some of its own token at creation, before trading opens, at the curve’s lowest prices and without the launch-window tax; the box page shows it. Large collections are loaded in later transactions, and a box opens only once all of it is in. The opening, the launch window and the curve otherwise work as for box 0 (5.7), but the launch-window tax goes into the box itself: its pool after graduation, or its claim pot if it fails (5.19).',
        '(e) **Graduation.** When the curve fills, anyone can trigger graduation. The curve then becomes one position across all prices, held by the box’s pool contract, and the pool is closed to outside liquidity, as box 0’s is (5.9(a)-(b)). Whoever triggers graduation receives at most 0.1% of the raise, paid only from fees the curve collected. If graduation has not succeeded 7 days after the curve filled, the box can be closed (5.19(b)).',
        '(f) **Vaults and draws.** A box with a new NFT collection has a vault with the actions of 5.10, the placeholders, random numbers and safety net of 5.11, and the refused sends of 5.13, with these differences: the named-pick premium is 1%, 5% or 25%, as the creator chose; the per-Misfit stream of 5.12 belongs to box 0 only; and the creator chooses whether the art is shown at once or hidden until drawn. If it is hidden, the creator, not Square Hole, holds the reveal data, and so knows which numbers hold which art. The creator is then an insider, and 9(k) applies to it.',
        '(g) **Our role.** Square Hole provides the contracts and the Services. It does not choose any creator’s settings, does not hold any box’s tokens on the box’s behalf, and cannot change, stop or close a box except by the public rules every user has. [COUNSEL: Square Hole’s role and liability for boxes others create, and whether creators need separate creator terms.]',
      ),
    },
    {
      n: '5.17',
      text: '**Fees of other boxes.**',
      items: items(
        '(a) **The fee.** Every trade in a box’s own pool pays a fixed fee of 1%: a buy pays it in the pricing token, on what is sent; a sale pays it in the box’s token, on the tokens sold. Until graduation, and in a box that fails, the sale fees are burned. After graduation, the box sells its sale fees for the pricing token in its own pool, through a public step anyone may call (5.17(e)), and that pricing token counts as the sellers’ fees. The code splits each side’s fees in fifteenths: 10/15 as the creator chose for that side (5.17(b)); 2/15 for FIT; 1/15 for Square Hole; and 2/15 for the box’s own pool, held until graduation and then added as liquidity that can never be removed (if the box fails first, it joins the claim pot, 5.19(c)). The fee is charged on every trade, including in a box that later fails.',
        '(b) **The creator’s choice.** For each side, the creator picks one destination for its 10/15: keep (the creator’s payout address claims it after graduation); burn (after graduation, the code buys the box’s token in its pool and burns it); add it to the box’s own pool; to holders (5.18(b)); or to items (5.18(c)). A side cannot be split between choices, and no cap applies to it. For items still in the vault, the creator also chose whether their shares wait for the item’s next owner, buy the box’s token and burn it, or are added to the box’s own pool.',
        '(c) **FIT’s and Square Hole’s parts.** The code pays FIT’s 2/15 to a fixed wallet, the FIT buy-back wallet, and Square Hole’s 1/15 to another, the platform wallet, both in the pricing token. What happens next is done by us, not by code. Our bot proposes each step. The FIT buy-back wallet needs two of three signatures (the bot, the founder and a backup key): it sells the tokens it receives for ETH and, once box 0 has graduated, sends the ETH to box 0’s buy-and-burn (5.15(d)); FIT it receives is burned. Until box 0 graduates, that money waits. The platform wallet also needs two of three signatures [FOUNDER: who its three signers are on mainnet (F151 R68-SAFE set two of three and named none)]. We publish every sale, burn and transfer.',
        '(d) **Square Hole’s part.** The platform wallet receives Square Hole’s whole 1/15 of every other box’s fees (5.17(c)), and Square Hole keeps it.',
        '(e) **Buy-backs, fee sales and adds to the pool.** After graduation, a box’s buy-backs, the sales of its sale fees and its adds to the pool trade at the current pool price, at most one such step per block, each moving the price at most 49 ticks (about 0.5%). A buy-back pays the 1% fee like any buy, and a fee sale pays it like any sale. Most public steps pay their caller a small capped amount from what they move. Anyone can see these steps coming and trade around them (6.1(r)).',
        '(f) **Royalties and other tokens sent to a box.** A creator may declare a royalty on sales of the box’s NFTs. Marketplaces decide whether to pay it. Every box other than box 0 has an inbox contract that receives its royalties and any token anyone sends it. Pricing tokens that reach the inbox, including what it gets for its sales, go into the box: they are held until graduation and from then on split like buyers’ fees, so FIT’s 2/15 and Square Hole’s 1/15 of them are paid to the FIT buy-back wallet and the platform wallet as fee shares (5.17(c)); if the box fails first, the held ones join the claim pot. Each token on the box’s sale list, fixed when the box was created, is offered for the pricing token on the CoW Protocol in whole lots of a fixed size, at most 20 lots an hour, at whatever price its solvers find: there is no minimum price, and nobody has to buy. An offer is open only once someone posts it to the CoW Protocol’s order book. Anyone may renew and post these offers; our keepers may do so, posting only when the CoW Protocol quotes the sale at a fee of about 5% of it or less, and we may stop (5.4(c)). A token on the sale list that sells nothing for 30 days, and any other token (the box’s own token and other boxes’ tokens included), can be taken as it is by the creator’s payout address, and by nobody else. The 30 days start when a public call sees the token in the inbox after it held none, and start again when one sees a sale that leaves at least one whole lot, or sees the balance pass one lot other than by a sale that leaves less than a lot; until a public call sees the token, its 30 days have not started, so the wait can be longer. Once a box has failed, its inbox offers nothing for sale: its tokens other than the pricing token can be taken at once by the creator’s payout address, and its pricing tokens join the claim pot (5.19). No other part of this money, and no token other than the pricing token, reaches a Square Hole wallet.',
      ),
    },
    {
      n: '5.18',
      text: '**Payouts are claimed, never sent.**',
      items: items(
        '(a) In every box other than box 0, nothing is sent to you automatically. Each amount the contracts hold for you waits until you claim it yourself, in a transaction you sign and pay the network fee for. Nobody, including Square Hole, claims it for you or pushes it to you. Box 0’s stream works as 5.12(c) says. The app’s "Claim all" lists the claims your wallet has; each transaction still needs your signature.',
        '(b) **To holders.** Where a side’s choice is "to holders", its fees are credited to the box token’s holders batch by batch, under the rule in the box’s contracts, and paid in the pricing token. Credits do not expire, and they stay claimable after you sell your tokens or the box fails.',
        '(c) **To items.** Where a side’s choice is "to items", every NFT of the box’s collection gets an equal share, paid in the pricing token. Whoever owns the NFT when claiming can claim it. Shares wait until graduation. Unclaimed amounts stay with the NFT and do not expire. If the box fails before graduation, the shares held for items join its claim pot (5.19).',
        '(d) These are mechanisms written into the contracts. They are not income, interest, a dividend or a return on anything, and they give nobody a right to any amount. Square Hole pays nothing under any of them: only the contracts do, and they can fail. They depend on trading, which may not happen, and an amount can be smaller than the network fee to claim it.',
      ),
    },
    {
      n: '5.19',
      text: '**Deadlines, closing a box and the claim.** This Section does not apply to box 0 (5.7(g)).',
      items: items(
        '(a) Every other box has a deadline of 30, 60, 90 or 180 days from when trading opens, chosen by its creator.',
        '(b) A box fails when its deadline passes before its curve fills; when it has not opened 14 days after its planned opening; or when its curve filled but graduation has not succeeded 7 days later. Anyone can then close it, through the Services or by calling its contracts, and receives a small capped payment from its pot. A box can be closed only once. Once it can be closed, every trade in its pool is refused, sells included, and after it closes its holders leave only through the claim.',
        '(c) **The pot.** The pricing tokens a failed box holds for its holders join its claim pot: what the curve raised, the launch-window tax, the pool’s share of fees, the creator’s held fees, the money held for buy-backs, for adding to the pool and for items, the remainders left over when fees are split, its held royalties, pricing tokens waiting in its inbox, and money that reaches the box later. FIT’s 2/15 and Square Hole’s 1/15 of the fees charged before the failure, including the split of the graduation reserve, are still paid to the FIT buy-back wallet and the platform wallet as their fee shares (5.17(c)). Holder payouts already credited stay claimable on their own (5.18(b)); what is left over in their ledger joins the pot when it is collected.',
        '(d) **The claim.** Each holder claims by handing in their own counted box tokens and receives, in the pricing token, the current pot multiplied by the tokens handed in and divided by the tokens still counted, rounded down. The count is fixed when the box fails and falls only as tokens are handed in. Money that reaches the pot later is shared by the claims made after it arrives; earlier claims get no share of it. Each holder’s claim first moves the pricing tokens waiting in the box’s inbox and the money held in the box’s fee contract into the pot, so that claim shares them; anyone can also move them with those contracts’ public functions. If a move fails, the claim pays from the pot alone, except that the last tokens still counted cannot be claimed while pricing tokens wait in the inbox. A claim can be far below what you paid, because early sellers were paid from the curve and fees were taken. If nobody bought, the creator can claim the remainder fixed at the failure, after the closing payment, without expiry; pricing tokens that later reach the pot from the box’s inbox are added to it and can be claimed too, and nobody else can claim them.',
        '(e) **No expiry; money locked for good.** Claims never close. Nothing in the pot is moved to the FIT buy-back wallet or to any other Square Hole wallet; the only payment from it other than a claim is the capped closing payment in (b), to whoever closes the box, which can be one of our keepers (5.4(c)). Tokens other than the pricing token in a failed box’s inbox go only to the creator’s payout address (5.17(f)). The share of tokens nobody hands in stays locked in the box forever. Money that arrives after the last holder’s claim stays locked forever too, and so does money other than inbox pricing tokens that arrives after the creator’s claim. Nobody can withdraw it, including Square Hole: it is economically like burning that money, and it benefits nobody. You can claim through a block explorer even if the Services are unavailable.',
        '(f) The creator’s unused NFTs go back to the creator. For 14 days after a box with a collection fails, a placeholder can be handed back to its vault with no fee, for box tokens at the quote fixed at the failure, and those tokens can then be claimed [ENGINEERING: confirm this hand-back rule (F114 R28B)]. Holder payouts already credited stay claimable (5.18(b)).',
        '(g) The issuer of a pricing token can pause or block it, and so stop the claims and payments made in it (5.20(b)).',
      ),
    },
    {
      n: '5.20',
      text: '**Listed pricing tokens and their issuers.**',
      items: items(
        '(a) Square Hole decides which tokens can price boxes, by adding them to an on-chain list. Each token is listed once, for good, with its raise. We may change that raise later; the new raise applies only to boxes created afterwards, and every box keeps the raise it was created with. Tokens of graduated boxes can be listed the same way. Square Hole can hand this role over or give it up. Listing a token is not an endorsement of it or advice about it.',
        '(b) Listed tokens may include stablecoins, wrapped bitcoin, gold, tokenised stocks, memecoins and other tokens. Their issuers can have powers over them, for example to pause all transfers, block or freeze addresses (a pool’s included), burn tokens from an address, or change the token’s rules. Where we know of them, the Services name an issuer’s powers. If an issuer uses them, a box priced in that token, its pool, its payouts and its claim may stop working, possibly for good.',
        '(c) We may stop offering a listed token in the Services. A box can still be created with it by calling the contracts directly.',
        '(d) Tokens with their own limits, such as tokenised stocks, are covered by Section 4.5.',
      ),
    },
    {
      n: '5.21',
      text: '**Shops and coin piles.**',
      items: items(
        '(a) **Shops.** A box can hold a shop: a vault that takes in and gives out NFTs of the collections on its list, at fixed price levels in the box token, from a budget with weekly limits. A curator chosen by the creator may only add collections to the list. [ENGINEERING: confirm the shop rules of the release.]',
        '(b) **Coin piles.** A box can hold a pile of one token, seeded once by its creator. After graduation, anyone can hand in box tokens, which are burned, and receive exactly the pile multiplied by the tokens handed in and divided by the supply. Tokens sent to a pile by mistake cannot be recovered. If the box fails, only the recorded seed goes back to the creator.',
        '(c) These are mechanisms written into the contracts. They are not income, interest, a dividend or a return on anything. Square Hole pays nothing under them.',
      ),
    },
    {
      n: '5.22',
      text: '**The cast.** The Sorter, The Coin, The Collector and The Stonk are storytelling characters. Owning one changes no fee and gives no extra rights.',
    },
    {
      n: '5.23',
      text: '**Changes to features.** We may change, add or remove features of the Services at any time. We may not be able to change a deployed contract, and some cannot be changed by anyone.',
    },
  ];
}

function sections(): TermsSection[] {
  return [
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
          text: 'They apply to the website at squarehole.fun, to squarehole.xyz and squarehole.fit, which redirect to it, and to every page, app view, data view and feature we offer through them (together, the "Services"). These are our official web addresses.',
        },
        {
          n: '1.3',
          text: 'You accept these Terms when you tick the box and select Accept. If you do not accept them, you may not use the Services, except to read these Terms, the About & risks page and the privacy notice. [COUNSEL: whether using the Services without that step should also count as acceptance.]',
        },
        {
          n: '1.4',
          text: '"You" means the person using the Services. If you use them for an organisation, "you" includes that organisation, and you confirm you have authority to bind it.',
        },
        {
          n: '1.5',
          text: '**Words used.** A "block" is one batch of transactions added to a blockchain, about every 12 seconds on Ethereum. "Gas" is the network fee for a transaction; a "gwei" is a billionth of an ETH, and the "base fee" is the network’s current minimum price per unit of gas. An "RPC provider" is a service that lets an app read a blockchain and send transactions to it. "Front-running" means placing a transaction just before someone else’s to take advantage of it; "sandwiching" means placing one just before and one just after. An "oracle" is a source of outside data, such as prices or random numbers, that a contract uses. A "position" is an amount of liquidity placed in a pool between two prices. A "tick" is the pool’s smallest price step, about 0.01%.',
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
          text: 'When we make a material change, we will show the new version when you next enter and ask you to accept it before you continue. [COUNSEL: confirm this notice approach, and whether one-sided changes can be enforced under consumer law, such as the EU and UK rules on unfair terms, if those users are allowed.]',
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
          text: '**What the Services are.** The Services describe Square Hole’s launches, called "boxes" (Section 5): their tokens, pools, NFT collections and vaults. They show data read from blockchains. Where offered, they also let you sign specific transactions with your own wallet (5.1).',
        },
        {
          n: '3.2',
          text: '**No offer and no advice.** Nothing in the Services is, or should be relied on as:',
          items: items(
            '(a) an offer to sell, or a request for an offer to buy, any security, investment contract, derivative, collective investment or other financial product or instrument, in any country;',
            '(b) a recommendation or encouragement to buy, sell, hold, burn, draw, pick, give back, create, close or launch anything, or to follow any strategy;',
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
          text: '**Plans can change.** Anything the Services say about plans, designs or future releases is a current intention only. It may change or never happen. Designs in the Services and in our public documents are proposals until they are deployed.',
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
          text: '**You declare it yourself.** We do not block access by IP address or location, except where sanctions law requires it [COUNSEL: whether places under comprehensive sanctions must be blocked by IP address (Question 9)]. When you accept these Terms, you confirm that you are at least 18 and not a Restricted User, and you are responsible for that statement. We may still block access from any place or by any person where the law requires it or these Terms are broken.',
        },
        {
          n: '4.5',
          text: '**Tokens with their own limits.** Some tokens that can price or fill a box have their own rules on who may hold them. For example, tokenised stocks may not be offered to US persons, and their issuers allow only professional or qualified investors in some countries. You must not use such a token, or a box priced in it, where its issuer’s rules or the law do not allow you to. Tokenised stocks and other listed tokens are issued by third parties under their own terms. Neither they nor any box priced in them or paying out in them gives you shares, votes or any right in the company or asset they track. [COUNSEL: this clause, and whether boxes priced in such tokens need further limits.]',
        },
      ],
    },
    {
      id: 'terms-5',
      n: '5',
      title: 'The Services and how Square Hole works',
      clauses: services(),
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
            '(b) **Curve order and bots.** What you pay and receive on a curve depends on when you act compared with others. Bots and snipers often buy first, and the launch-window tax does not stop them. Your transactions can be front-run, reordered or sandwiched.',
            '(c) **Failed launches.** Most launches never complete. Box 0 has no deadline: if its curve never completes, there is no graduation, its Misfits never leave the vault, and some ETH stays locked for good (5.7(h)). Another box that misses its deadline closes, and its holders can claim a share of its pot, which can be far below what they paid. Claims never close, but the share of tokens nobody hands in stays locked for good (5.19).',
            '(d) **Smart contracts.** Contracts can contain bugs, be exploited or fail. They have not been audited by an outside firm. They cannot be upgraded or paused, so a bug may never be fixed. Many boxes share the same code, so one bug can reach every box of a release.',
            '(e) **Randomness and prices.** Draws depend on random numbers from drand. Only box 0 has a backup, and only after 5 days: someone must start it and post the backup block’s data, and a validator can influence its number (5.11(b)). Box 0’s buy-and-burn and pool adds depend on price averages, and other boxes’ buy-backs and pool adds on the current price. These can be late, fail or be attacked.',
            '(f) **Placeholders and reveals.** Until its reveal, a Misfit is a placeholder, and nobody outside Square Hole can tell what it will become. Reveals depend on Square Hole’s systems holding the secret reveal data. If it leaks, is lost or is published early, a reveal can fail or favour people who learn it first. Reveals can be late, or never happen. If they stop, the safety net of 5.11(f) lets you open or give back unrevealed Misfits only after about 30 to 60 days, and hidden art may never be shown.',
            '(g) **The quote and the fees.** The quote can fall, for example after burns. A draw costs the quote plus 1%, a named pick the quote plus 25%, and a give-back releases the quote less 5%, each with network fees on top. A placeholder handed back before graduation also loses 5%. Giving a Misfit back and drawing again costs about 6% of the quote each time, plus network fees, and people who repeat it to look for rare art can take the rarest Misfits out of the vault.',
            '(h) **Trading elsewhere.** Trading can move to outside pools, which pay no Square Hole fees and fund no burns, pool budget, payouts or stream. Trading apps may route trades there.',
            '(i) **Price impact.** Large trades, thin pools and busy blocks move prices against you. Network fees can be larger than a small trade, draw or claim is worth.',
            '(j) **Irreversible transactions.** Blockchain transactions cannot be undone. A wrong address, amount or network is usually permanent. Tokens sent to a contract address can be lost for good (5.13).',
            '(k) **Wallets and keys.** If your keys or recovery phrase are lost or stolen, your assets are gone. We cannot recover them.',
            '(l) **Regulatory change.** Laws, and how they are applied, change. A token, NFT, random draw or feature could become restricted or illegal where you are. We may then have to limit or close the Services.',
            '(m) **Tax.** You alone are responsible for your taxes. Buying, selling, burning, drawing, picking, giving back, claiming and receiving a closing price can each have tax effects.',
            '(n) **Fakes.** Copycat tokens, NFTs and boxes exist, including boxes made by others that copy a known name or picture. A name, ticker or picture proves nothing. Check the exact chain and contract address; About & risks lists the addresses of Square Hole’s own boxes (5.4(f)).',
            '(o) **Test networks.** Test networks can reset, stall or change. Nothing on them carries over to any production network.',
            '(p) **Random draws.** What a drawn Misfit becomes is random, with odds from the published rarity counts. Most Misfits are common, and the Misfit you receive can be worth much less than the FIT you locked and the fee you paid.',
            '(q) **What the vault holds.** People tend to give back the most common Misfits, so the Misfits given back to the vault are often the most common ones. The vault can accept a Misfit that was reported stolen elsewhere.',
            '(r) **Timing games.** Bundled or front-running trades can be used to force or delay a graduation or the closing of a box, or to trade ahead of the buy-and-burn, the buy-backs or the pool adds, whose budgets and schedules are public.',
            '(s) **The stream and other payouts.** Amounts from the per-Misfit stream (5.12) and other payouts (5.18) are usually very small, depend on trading and can stop. Claiming them costs network fees.',
            '(t) **The closed pool.** Nobody can add their own liquidity to a box’s pool. The liquidity its pool contract holds can never be removed, including by Square Hole. What is added to it stays there for good.',
            '(u) **Issuers’ powers.** The issuer of a listed token can pause it, block addresses or change its rules (5.20(b)). A box priced in such a token can then stop working, possibly for good.',
            '(v) **Our wallets and our bot.** FIT’s and Square Hole’s parts of other boxes’ fees are handled by our bot and our signers (5.17(c)). Selling them can be slow, can stop if a market dies or a token’s issuer blocks one of our wallets, and can sell at a lower price.',
            '(w) **Creators.** Boxes are created by people Square Hole does not know or check. A creator may take a large share of fees, buy its own tokens cheaply before opening and sell them, abandon its box, or say untrue things.',
            '(x) **Scanners and warnings.** Token scanners may flag box tokens, for example as a "proxy contract", although each is a fixed copy of one program that cannot be upgraded. Sites may also warn about locked liquidity or custom code.',
            '(y) **Reliance on our systems.** Reveals depend on Square Hole’s reveal system. Graduation, buy-backs, fee sales, the buy-and-burn, pool adds, inbox offers and price updates may in practice depend on our keepers, although anyone can run them. If our systems stop, these can be late.',
            '(z) **Moving NFTs.** Moving a Misfit needs about 514,000 gas available. Some wallets, marketplaces and tools may fail to move it (5.10(j)).',
            '(aa) **Royalties.** Marketplaces may not pay royalties. Box 0’s royalties paid in tokens other than ETH or wrapped ETH stay stuck for good (5.15(i)). In other boxes, tokens in the inbox may never sell on the CoW Protocol, can sell at a poor price, and can wait 30 days or longer before the creator’s payout address can take them as they are. The CoW Protocol can pause or stop, and a token’s issuer can block the inbox (5.17(f)).',
            '(bb) **Art files.** The pictures and 3D models of NFTs are stored off chain, on a shared file network. They can become impossible to view if nobody keeps a copy online. The on-chain fingerprint proves which art belongs to an NFT, but it does not store the art.',
            '(cc) **Locked money.** The claim of a failed box never closes, but the share of tokens nobody hands in and money that arrives after its last claim stay locked in the box forever. Nobody can take them out, including Square Hole (5.19(e)).',
          ),
        },
        {
          n: '6.2',
          text: 'You confirm that you know enough about blockchains, wallets and tokens to judge these risks, and that you use the Services at your own risk.',
        },
        {
          n: '6.3',
          text: '**Your submissions.** When you create a box or send us content (for example a name, ticker, image, description, links, a rarity table, NFT art or NFTs to put into a box), you confirm that:',
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
        {
          n: '6.6',
          text: '**If you create a box.** You alone are responsible for your box: its content, its settings, what you say about it, and the laws that apply to you as its creator. You must not promise or suggest profits or payouts that the box’s code does not make, or mislead anyone about its rarities, art or contents. You must hold the rights to all content and NFTs you put into it. [COUNSEL: separate creator terms; creator eligibility; tax.]',
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
          text: 'The Services rely on others, including blockchains and their validators, Uniswap and other protocols, the randomness network drand, wallets and the Safe wallet software that holds our wallets, RPC and data providers, hosting (Cloudflare) and server hosting (DigitalOcean) [ENGINEERING: and the providers of the reveal servers], storage for NFT art, indexers, NFT marketplaces, block explorers, trading venues, token scanners, and the issuers of listed tokens.',
        },
        { n: '7.2', text: 'Their own terms and privacy policies apply to them. We do not control them.' },
        { n: '7.3', text: 'We show a link to a trading venue only after a recorded test of that route. A link is not an endorsement or a recommendation.' },
        {
          n: '7.4',
          text: 'Others see some of your data when you use the Services: our host receives your IP address with each page request, our server receives the wallet addresses whose boxes and claims the app shows, the RPC providers behind chain views receive the addresses those views look up, your wallet sees every transaction you sign, and sites you open from a link see your visit. When a box link is shared, the preview picture is loaded from our server, which sees the IP address of whoever loads it. Wallet extensions run their own code in your browser. The privacy notice has the details (17.6).',
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
          text: '**NFTs.** Owning an NFT gives you the token. It does not give you the copyright in its art. While you own a Misfit, you may use that Misfit, its picture and its 3D model, for personal and commercial purposes, including creating a box around it; the Square Hole name and logo stay Square Hole’s (8.5). [COUNSEL: check this licence.] The 69 Icons (5.6(e)) are Misfits like any other and carry the same licence. It covers their art, not any brand they bring to mind. [COUNSEL: check the Icons wording.] The NFTs of other boxes come with whatever licence their creator gives, if any.',
        },
        {
          n: '8.5',
          text: '**Names and logos.** Square Hole uses the names "Square Hole", "The Misfits" and "FIT", the cast names and its logos. Do not use them in a way that suggests you are us or that we endorse you. The Icons (5.6(e)) refer to other brands only as homage. [COUNSEL: who owns these names and logos and whether they can be registered; check "The Stonk" against StonkFun’s STONK, and "FIT" against other tickers.]',
        },
        {
          n: '8.6',
          text: '**Complaints.** To report content you believe infringes your rights, contact [COUNSEL: IP notice channel; a registered DMCA agent if US users are ever allowed]. Tell us what the content is, where it is, who you are, and why you believe it infringes.',
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
            '(e) mislead others about a box, a collection, its rarity counts, its art or its contents, or pretend to be someone else;',
            '(f) create a box using content or NFTs you have no right to use, or NFTs that are stolen;',
            '(g) upload malware, or attack, overload or disrupt the Services or the systems behind them;',
            '(h) get around any security measure or access control;',
            '(i) scrape the Services with bots or other automated tools, except through an interface we publish for that purpose;',
            '(j) use the Services to send spam or unsolicited promotion;',
            '(k) if you prepare the art of a box, hold or can see its reveal data (for example as a provider of a server that holds it), or are named to publish it, draw from that box’s vault, take its NFTs by number, or help anyone else use that knowledge; or',
            '(l) trade in your own box to collect its fees, or make promises about payouts that the box’s code does not make.',
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
          text: 'We may change, pause or stop all or part of the Services at any time, including the website, data views and off-chain services such as our keepers, our bot and our reveal system. We cannot pause or stop the smart contracts. We may stop showing a box, collection or token in the Services, for example to protect users or meet the law; this does not change the box on chain.',
        },
        { n: '10.2', text: 'We may block or end anyone’s access if we believe they broke these Terms, created legal risk or harmed others.' },
        { n: '10.3', text: 'Deployed smart contracts keep running whether or not the Services are available. We may not be able to change or stop them.' },
        { n: '10.4', text: 'To the extent the law allows, we are not liable to you for any change, pause, block or end described in this Section.' },
        {
          n: '10.5',
          text: 'Sections 3, 5.4(e), 5.12(d), 5.15, 5.16(g), 5.18(d), 5.21(c), 6, 8 and 12 to 17 continue after your use ends. [COUNSEL: confirm this list.]',
        },
      ],
    },
    {
      id: 'terms-11',
      n: '11',
      title: 'Charges and fees',
      clauses: [
        {
          n: '11.1',
          text: '**Creating a box.** Square Hole charges no creation fee. Creating a box includes a small opening buy whose tokens are burned (box 0: 0.0015 ETH) [ENGINEERING: the opening buy of other boxes], and network fees.',
        },
        {
          n: '11.2',
          text: '**Pool fee.** Every trade in a box’s own pool pays a fixed fee of 1%: in box 0, in the coin paid in; in other boxes, in the pricing token on buys and in the box’s token on sales. The code splits it as 5.15(a) says for box 0 and 5.17(a) for other boxes.',
        },
        {
          n: '11.3',
          text: '**Launch-window tax.** For 6.4 minutes after a box opens, each buy pays a tax on top of the pool fee, falling from 93.1974% to 8.0565% of what is sent (5.7(d)). The same table applies to every box. The tax goes into the box itself, never to Square Hole; in a box that fails, it joins the claim pot, and the share nobody claims stays locked for good (5.19(c) and (e)).',
        },
        {
          n: '11.4',
          text: '**Vault fees.** The fee for a draw or a placeholder (1% of the quote), the named-pick premium (box 0: 25% of the quote; other boxes: 1%, 5% or 25%, as their creator chose) and the fee for giving back or handing back (5% of the quote) are paid in the box token and burned. They are flat: they do not change with rarity, with an NFT’s number, or with how many NFTs have been given back.',
        },
        {
          n: '11.5',
          text: '**Random numbers.** The first draw in each drand round pays a small amount in ETH to whoever posts that round (5.11(c)).',
        },
        {
          n: '11.6',
          text: '**Rates.** The rates are fixed in each box’s contracts before trading opens and shown on its page. If the Services and the contracts differ, the contracts apply.',
        },
        {
          n: '11.7',
          text: '**When charged.** Fees are taken by the contracts when your transaction executes. Once taken, a fee or tax cannot be reversed, and nobody, including Square Hole, pays it back.',
        },
        {
          n: '11.8',
          text: '**Other amounts the contracts take or pay.** Besides the pool fee, the launch-window tax and the vault fees: royalties declared on NFT sales (box 0: 2.5%, 5.15(i)); the small payments to whoever calls a public function, taken from what that function moves, such as a fee batch, a buy-back or a pool add (5.15(e), 5.17(e)); the payment to whoever triggers graduation, taken from fees the curve collected (5.8(b), 5.16(e)); and the payment to whoever closes a failed box, taken from its pot (5.19(b)). Outside parties may add their own charges: the CoW Protocol and its solvers keep part of each sale from a box’s inbox; Uniswap’s governance may switch on a protocol fee of up to about 0.1% of each trade in its pools, and a token’s issuer may add a transfer fee, as the issuer of PAXG can. [COUNSEL: whether this list is complete enough.]',
        },
        {
          n: '11.9',
          text: '**Other costs.** You pay network (gas) fees and any fees of third-party venues, wallets and services. Network fees can make small actions, such as a single draw or a small claim, uneconomic.',
        },
        {
          n: '11.10',
          text: '**Later versions.** A later version of the contracts may have different fees. Fees fixed in deployed contracts never change.',
        },
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
          text: 'This includes loss caused by smart-contract bugs, failures or exploits; blockchain, oracle or randomness failures; late, wrong or leaked reveals; front-running, sniping, fraud or other acts of third parties, including creators and token issuers; third-party services and pools; lost or stolen keys; hacks, malware or denial-of-service attacks; and changes in law.',
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
            '(c) any content you submit or any box you create; or',
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
          text: `**Privacy.** Our privacy notice, on the page "Privacy notice" (${PRIVACY_PATH}), says what the Services keep on your device, what our server and others see, including IP addresses and wallet addresses, and how to reach us. [COUNSEL: a full privacy policy before any public launch, including the GDPR if the operator is established in the EU or people in the EU may use the Services.]`,
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
          text: 'Questions about these Terms or the Services: hello@squarehole.fun. Our official channels: Telegram (https://t.me/+uB8u32UmcEBkOTA0) and X (https://x.com/squarehole_).',
        },
        {
          n: '18.2',
          text: 'Legal notices: [COUNSEL: postal address of the legal entity once it exists, or how to ask for it; StonkFun gives its legal name only on request].',
        },
        { n: '18.3', text: 'We will never ask for your recovery phrase or private keys. Anyone who does is not us.' },
      ],
    },
  ];
}

/** The production Terms, built once (a pure call: a build that reads none of it, the development one, drops it). */
function buildProductionTerms(): ProductionTerms {
  const version = '2026-10-15-production-draft-4';
  const dateText = '15 October 2026';
  return deepFreeze({
    version,
    date: '2026-10-15',
    dateText,
    gate: {
      title: 'Before you enter Square Hole',
      status: `Draft Terms, not yet reviewed by a lawyer. ${COUNSEL_SIGN_OFF}`,
      intro: 'Here are the essentials of the Square Hole Terms of Use. The full Terms apply.',
      bullets: [
        'Nothing here is an offer, a recommendation or advice.',
        'Square Hole is not registered or licensed by any financial regulator.',
        eligibilityBullet(),
        'You can lose everything. Most launches never complete. A box that misses its deadline closes, and its holders can claim what is left, with no time limit; it is often far below what they paid, and the share nobody claims stays locked for good.',
        'Every trade pays a 1% fee. Code splits it: parts are burned, part goes into the box’s own pool, part may go to the box’s creator or be credited to holders (for box 0, owners of Misfits outside the vault), who claim it, part buys FIT and burns it, and part goes to Square Hole. For boxes other than box 0, buying FIT is done by us, not by code. Holding FIT pays you nothing. Burns are not a promise, and no one owes you anything because of them.',
        'For 6.4 minutes after a box opens, buys pay an extra launch-window tax of up to 93.2% of what is sent, falling every 12 seconds. It stays in the box and never goes to Square Hole. If the box fails, it joins the holders’ claim, and the share nobody claims stays locked for good.',
        `${MAINNET_ONLY} ${BOX_0_ADDRESSES} ${TEST_SITE} On a test network, tokens have no value and give no right to any future token.`,
        'Your wallet, your decisions, your taxes. Transactions cannot be undone, and fees and the launch-window tax cannot be reversed or recovered.',
      ],
      fullTermsLink: 'Read the full Terms of Use',
      checkbox: 'I have read and agree to the Square Hole Terms of Use, and I confirm that I am at least 18 and not a Restricted User.',
      decline: 'Decline',
      accept: 'Accept',
      declined: 'You need to accept the Terms of Use to use Square Hole. You can close this page, or go back and read them again.',
      reviewAgain: 'Review the terms again',
    },
    document: {
      title: 'Square Hole Terms of Use',
      status: `DRAFT pending legal review. It may change, and you will be asked to accept the final version. ${COUNSEL_SIGN_OFF}`,
      versionLine: `Version ${version} · Draft of ${dateText}`,
      disputeNotice:
        '**[COUNSEL: dispute notice. If the final Terms include mandatory arbitration and a class-action or jury-trial waiver, say so here in bold and point the reader to Section 15. If not, delete this line.]**',
      readFirst: {
        title: 'Read this first',
        bullets: [
          'Nothing in the Services is an offer or a request to buy or sell any security, derivative or other financial product, anywhere. Nothing in them is investment, legal, tax or other advice (Section 3).',
          'Square Hole is not registered, licensed or authorised by any financial regulator in any country (Section 3).',
          `${MAINNET_ONLY} Its smart contracts have not been audited by an outside firm (Section 5.3). ${BOX_0_ADDRESSES} ${TEST_SITE} On a test network, tokens have no value, and using them gives no right to any future token or allocation.`,
          'No box contract has an admin, pause or upgrade. Once deployed, nobody, including us, can change a box, stop it, or move anyone’s tokens out of it except by its public rules. The few roles we keep are listed in Section 5.4(b).',
          'For 6.4 minutes after a box opens, buys pay an extra launch-window tax of up to 93.2% of what is sent, falling every 12 seconds. It stays in the box and never goes to us; if the box fails, it joins the holders’ claim, and the share nobody claims stays locked for good (Sections 5.7 and 5.19).',
          'FIT is created once and never again, and FIT holders receive no payouts (Section 5.5).',
          'Anyone may create a box. Its creator, not Square Hole, chooses its settings and is responsible for it (Section 5.16).',
          'Outside box 0, nothing is sent to you: every payout waits until you claim it. The claim of a failed box never closes, but the share nobody claims stays locked for good (Sections 5.18 and 5.19).',
          'You can lose everything you put into any token, NFT or transaction connected with Square Hole (Section 6).',
          'Burns and other mechanisms written into the smart contracts are not promises. Nobody owes you anything because of them (Section 5.15).',
        ],
      },
      sections: sections(),
      closing: `DRAFT pending legal review. It may change before it is final. ${COUNSEL_SIGN_OFF}`,
    },
  });
}

export const PRODUCTION_TERMS: ProductionTerms = /* @__PURE__ */ buildProductionTerms();
