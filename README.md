# Square Hole on BNB Chain

Square Hole is a rule layer for tokens: a **box** is a token whose rules nobody can change after it is created
(where its trading fees go, what it holds, when it moves to a pool that cannot be drained). A box launches on its
own pool. On Flap and on Four.meme it adds the box dimension to their launchpads: a token launched there stays a
token of theirs, on their rails, and carries rules of ours, such as a pile its holders can redeem. This entry runs
the whole platform on **BNB Chain's test network (chain id 97)** as one site: create a box, or launch a token on
Flap or on Four.meme's OpenFour with our rules, trade, and watch holders get paid, with prices from Atlas.

**Live site: https://138-197-196-174.sslip.io** (test network only; everything can be looked at without a wallet).

Two ways to try it:

- **With an X account, no wallet and no faucet.** Press **Sign in with X** in the top bar, tick the notice on the
  join page and sign in; approval is automatic. **Set me up** then makes a wallet for you, sends it 0.015 test BNB
  from the site's own sender and takes your first drip of 1 tETH. One starter per X account and per wallet, at most
  100 a day and 300 sign-ups in all.
- **With your own browser wallet** on BNB Chain testnet. Test BNB for gas comes from BNB Chain's faucet
  (https://www.bnbchain.org/en/testnet-faucet): 0.3 test BNB once every 24 hours; its page says 0.002 BNB on the
  main network is needed for that.

Either way, **Test coins** gives 1 tETH a day and swaps it into the coin a box is priced in (tUSDC or tNVDA).

**What a visit costs.** On 26 November a fresh wallet holding 0.01 test BNB walked the live site through its own
controls (`hackathon/scripts/judge-walk.mjs`): the tETH drip; two swaps on Test coins (0.05 tETH gave 4.98 tNVDA,
0.1 tETH gave 9.97 tUSDC); a buy and a sell in GPU Poor; a buy in Rent Free; a buy in the card shop and the pick of
a Common card for 2,000,000 CARD; a box launched from the Visual form ("Judge Walk 14293", which is why that box is
on the list); a reconnect. Thirteen transactions, all confirmed, for 0.00053 test BNB of gas in all; the launch
alone used 2,350,566 gas and sent 661,245,908,466 wei with it. **Set me up** now sends 0.015 test BNB, about 28 times
that walk's gas.

Marked **(to come)**: a piece not yet live or measured when this page was written.

| What a judge can look at | Where in the site | Where in the code | Track |
|---|---|---|---|
| Create a box on its own pool (the Visual launch form); the same row leads to a launch on Flap or Four.meme | **Create** ("Launch on: Flap, Four.meme, Own pool") | `apps/web/src/features/create/`, `packages/contracts/src/box-v2/` | Main |
| A box priced in a tokenized stock that pays its holders in it | demo box **GPU Poor** (test NVIDIA stock, tNVDA) | `packages/box-spec/examples/v2/bnb/gpu-poor.json`, `packages/chain/scripts/bnb-boxes/` | Main |
| A box of real-world items | demo box **Rent Free** (500 houses) | `packages/box-spec/examples/v2/bnb/rent-free.json` | Main |
| A box whose fees buy a stock into a pile: **The Alchemist** (LEAD). On 26 November its buyers' fees, 0.01169 tUSDC, were converted into 0.0116 tNVDA in the pile; its sellers' fees bought back and burned 124,389 LEAD; a holder redeemed 161.4 million LEAD for 0.00179 tNVDA | demo box **The Alchemist**: its box page, on **Boxes** | `packages/box-spec/examples/v2/bnb/the-alchemist.json`, `packages/contracts/src/box-v2/modules/AlchemistFeeModuleV21.sol`; its record: `hackathon/real-97-demo-boxes.json` | Main |
| The card shop: four card collections sold from a box; Pick and Give are one press each, and the shop shows its cards and the visitor's own cards to select | its box page | `examples/boxes/card-shop/`, `packages/contracts/script/bnb/card-shop*.mjs`, `packages/contracts/script/bnb/CardShopStock.s.sol` | Main |
| A second release of the platform's contracts, whose card shop takes a wait of ten minutes, and the box **Quick Deck** (QDECK) on it. Its gives opened on 26 November at 15:07:36 +07 (08:07:36 UTC), ten minutes after the box was created, as the shop reads on chain 97 for all four card collections; a give was refused 13 seconds before that and, just after, paid exactly 1,000,000 QDECK. A judge can give a card of the four test collections for 1,000,000, 2,000,000, 4,000,000 or 8,000,000 QDECK by tier, or pick one for twice that, one press each. The Boxes list shows the boxes of both releases, and its New order puts them in the order they were created; a shop's wait reads in words ("10 minutes", "7 days") | its box page, on **Boxes** | the second release's source: `packages/contracts/script/bnb/*ShortWait*`, `packages/contracts/script/bnb/short-wait.mjs`, `hackathon/short-wait/` (with the replay of the real run); the box: `hackathon/quick-deck/` | Main |
| **My Box**: what a wallet holds across the boxes (coins with their worth, cards, payouts to claim); any wallet's view at `/wallet/<address>`, read only | **My Box** in the navigation | `apps/web/src/features/core/v2/HoldingsV2.tsx`, `apps/web/src/pages/WalletBoxPage.tsx` | Main |
| The demo boxes side by side; trade any box on its curve, then on its pool | **Boxes**; a box page | `apps/web/src/features/examples/`, `apps/web/src/features/trade-sepolia/` | Main |
| The Examples: Basics, How it works and ten example boxes, each a few pictures whose parts explain themselves; the BNB version of the platform's explainer (its coins say BNB) | **Launch** → "Examples" | `apps/web/public/examples/`, `apps/web/build/examples-bnb/` | Main |
| Prices from Atlas: the amount a new box raises is set on chain to one US dollar's worth of its price coin from Atlas's feeds (the price contracts and their raises are under "See it live"), dollar values on box pages, shown only while Atlas's price is fresh (for a few minutes after a site update, the pages show coin amounts only), upkeep only when income pays at Atlas prices | Create (the raise); box pages ("about $X") | `packages/contracts/script/bnb/AtlasRaise.sol`, `packages/chain/src/atlas/`, `packages/indexer/src/core/atlas-prices.ts`, `packages/keeper/src/atlas-*.ts`; the feeds and addresses on one page: [`hackathon/public/ATLAS.md`](hackathon/public/ATLAS.md) | CoinMarketCap x Atlas |
| Launches on Flap: a curve sale that graduates into a Flap pool. Five launches done: two with a pile every holder can redeem, one in BNB and one in Flap's freely mintable test USDT (so a judge needs only a little test BNB for gas), and three with the creator's rules (below), all on our first factories. For all four of our launcher factories Flap's minimum is set to zero with Flap's own test-network helper (read on chain on 26 November at 16:17), so a small sale launches; at its full minimum Flap's Portal asked for a target of about 2.3 BNB, or about 1,610 test dollars. The launch page shows the minimum that applies | **Boxes** → "On Flap" (the launch pages, `/launches/`); on Flap's own site once Flap hosts our template page (built, sent to Flap on 26 November) | `bounties/flap/`, `bounties/core/`; the template page: `bounties/flap/ui/` | Flap |
| Their token, our rules: on a token launched on Flap or Four.meme, the creator chooses how its income is shared: paid to an address (on Flap: the creator, a stake that pays holders, or a card shop; on the OpenFour copy: the creator), into a pile its holders can redeem, or into buying the token back and burning it; fixed before the sale on Flap and at the token's creation on Four.meme. Four launches carry rules: **Sweet Jar** (SWEET), **Pay Packet** (PACKET) and **Swap Deck** (SDECK) on Flap, **Snip** (SNIP) on Four.meme (what each did: below) | the rule fields and "What happens" (where the money of 100 trades goes) on **Create** → "Launch on: Flap" or "Four.meme"; each launch's page: the form's picture with its real numbers, then the rules and their share-out | `bounties/core/src/RuleSplitter.sol`, `bounties/flap/src/RulesVault.sol`, `bounties/flap/src/RulesVaultFactory.sol`, `bounties/openfour/contracts/RulesTaxVault.sol` | Flap; Four.meme / OpenFour |
| Holders paid by staking a token of Flap or Four.meme: a rule pays the stake on Flap (on the Four.meme copy, fed by hand); its income streams evenly per token and per second, over about a period (new income lengthens it by its weight; with nobody staked it pauses); take the stake out at any time. **Pay Packet** pays 40% of its income this way | the holders panel on a launch's page | `bounties/core/src/RailStake.sol`, `bounties/core/src/RailStakeFactory.sol` | Flap; Four.meme / OpenFour |
| A card shop for a token of Flap or Four.meme: hand in a card and be paid its price in the token, or pay the token for a card; fed by the token's rules (on the Four.meme copy, by hand). **Swap Deck** feeds one with 40% of its income | the shop page, linked from the launch's page | `bounties/core/src/RailShop.sol`, `bounties/core/README-rail-shop.md` | Flap; Four.meme / OpenFour |
| Launches on Flap and Four.meme as cards among the boxes, each with its picture (added in the launch form, stored on Arweave, shown from its link) and its rules as read from the chain, for example "creator 10 · pile 30 · card shop 40 · burn 20" on Swap Deck and "pile 100" on a plain launch; a payee the page cannot prove reads "paid out", and a card whose rules cannot be read shows no rule line | **Boxes** | `apps/web/src/features/launch-cards/` (the rule line: `launch-rules.ts`), `bounties/app/src/lib/pictures/` | Flap; Four.meme / OpenFour |
| A box priced in PILE, the token of our BNB sale on Flap: **Pile Party** (PARTY); its life on 26 November paid 3,791.671326200403056554 PILE to holders in 7 claims | its box page, on **Boxes** | its sheet: `hackathon/rail-coin/pile-party-boxspec-v2.json`; the listing of PILE: `hackathon/rail-coin/commands.txt`; its record: `hackathon/real-97-demo-boxes.json` | Main; Flap |
| A box priced in PILE whose fees send PILE to the dead address: **Pile Furnace** (FURN); its life on 26 November sent 3,925.72 PILE to the dead address in two rounds | its box page, on **Boxes** | its sheet: `hackathon/rail-coin/pile-furnace-boxspec-v2.json`; its record: `hackathon/real-97-demo-boxes.json` | Main; Flap |
| Three launches on OpenFour: a preset and a tax-vault template whose fees fill the holders' pile, and **Snip** (SNIP), whose tax follows the creator's rules | **Boxes** → "On Four.meme" | `bounties/openfour/`, `bounties/core/` | Four.meme / OpenFour |

## The two launchpad tracks

### Flap: how the launch works, and what is different

A creator opens a sale on a price curve through our Launcher Factory. For the corrected set's two rules launcher
factories we also built a create form and a sale page from Flap's own launcher UI template (its
`launcher-config-preview/v1`, three files per quote coin, passed by Flap's own source checker; `bounties/flap/ui/`),
sent to Flap on 26 November: Flap hosts such a page on its own site once it has published it and mapped our factory to it.
There a visitor can create a sale, buy the rest of a sale in BNB (which launches the token), claim, and take a deposit
back; buying and selling any amount, and the creator's rules, stay on our own page. Buyers buy, and can sell back,
before anything launches. The buy that reaches the target launches the tax token straight into the pool through Flap's
Portal, at the curve's last price. If the target is not reached by the deadline, every buyer takes their net deposit
back (less a shortfall, only after a profitable sell-back). With our rules launcher factories the creator sets the
rules for the token's income before the sale, and nobody can change them after: a share for the creator, a pile every
holder can redeem, a buy-back and burn, payouts to holders who stake, and a card shop. The sale's own fee and the
vault's share of the trading tax (Flap's protocol fee takes its own part) then follow those rules on chain. Our
launchers, vaults, stake and shop have no owner.

### Flap's pre-audit, and the corrected contracts

Flap's team reviewed the first contracts on 26 November and asked for six corrections; all six were made the same
evening.

| Flap's finding | What the corrected contracts do |
|---|---|
| R1: no name and symbol screening at creation | every launcher factory takes Flap's anti-scam module and refuses a listed name or symbol |
| R2: two swaps anyone can trigger (the rules' buy and burn, the shop's refill) with a minimum of zero | both buy at most 0.05% of the pool's coin side as read in that call, with a minimum output computed from the pool's reserves (Flap's fix as written) |
| R3: the vault factories did not check the calling launcher, and a direct creation path | each vault factory is paired with one launcher factory and serves only launchers that factory made; the direct path is removed |
| R4: no upgrade path through Flap's Guardian | every vault is a beacon proxy; only Flap's Guardian can replace the code a factory's vaults run |
| R5: no tests on a fork of BNB Chain's main network | 14 such tests, 14 of 14 passing at block 135830000 (creation is paused there; the tests act as the role that could enable a factory) |
| N4: a fixed gas allowance for the creator's payment | a creator part that could not be paid within it can be claimed (`payOwedCreator`) |

The corrected source is in `hackathon/flap-corrected/` (commit 3272b398), built and tested from inside that folder as
its `README.txt` says. Its counts: the shared contracts 150 passed and 1 skipped; the Flap units 67 passed (the eight
fork suites skip without an endpoint), and eight more random seeds of both unit suites passed; the test-network fork
tests 29 passed and 0 failed on a fork pinned at block 144964306; the main-network fork tests 14 of 14 at block
135830000.

**The swap guard** (`hackathon/flap-corrected/bounties/core/src/PairPriceGuard.sol`, Flap's suggested fix). A buy of
the token by a share-out or a shop refill is at most 0.05% of the pool's coin side as read in that call, with a
minimum output computed from the pool's reserves (room for a 10% buy tax, the pool's fee and 1% slippage); each buyer,
a rules contract or a shop, buys at most once a minute, counted from its last buy. In a share-out, what is not bought
stays owed for a later one and the other parts are paid at once; a shop's coin that is not bought waits in the shop
for a later refill. Its limit: a trade placed earlier in the same transaction, or by the block's producer just before,
moves the reserves that the cap and the minimum are read from, so against such a trade the cap and the minimum protect
nothing. Measured (`hackathon/flap-corrected/bounties/core/proof`): against a buy whose size was fixed before the
trade, up to 0.25% of the reserve, no sandwich size tried gains anything on a pool with a 0.25% fee; with the cap read
after an earlier trade a thousand times the pool, such a trade takes about 99% of a buy. A reference such a trade
cannot move, the pool's own time-weighted price, is the next step: built and kept for the next version, not in this
one.

**The corrected set on the test network.** On 26 November, 19:51 to 20:15 +07, the corrected contracts (commit
3272b398) were deployed on chain 97 beside the first set: four launcher and vault factory pairs (rules and plain, each
in BNB and in Flap's test USDT; the rules pairs with their two beacons each), a card shop factory with the guarded
refill and a stake factory. Flap's Portal reads all four new launcher factories as switched on
(`launcherFactoryMultiplier` true 0). The proof sale **Proof Jar** (PJAR; rules creator 10%, pile 60%, buy and burn
30%) ran end to end: created through the Portal; a name on Flap's list ("USDT") refused at creation in a dry call;
buys, a sell-back, the completing buy that launched it, three claims, three pool trades. The first share-out paid the
creator and the pile and bought exactly 0.05% of the pool's WBNB side (53,959,611,232,972 wei of
107,919,222,465,945,965), the rest of the burn part staying owed; 79 seconds later the second share-out bought the
next slice; a redemption of 1,000,000 PJAR paid 615,417,375,548 wei from the pile. Three small launches, one on each
other pair, were bought whole and launched: Proof Pile (PPILE), Proof Pile Dollar (PPUSD) and Proof Jar Dollar
(PJUSD).

The site reads only the first set, so these four sales are not on the launch pages: their addresses are under "See it
live" ("The corrected Flap set"), and the explorer shows them.

**Launch and vault pages on Flap's own templates** (`bounties/flap/ui/`):

| Package | What it shows and does |
|---|---|
| Launch UI, BNB (`rules-bnb/`) | a create form for the corrected set's BNB rules launcher factory; a sale page with its state, buy the rest (which launches the token), claim, take a deposit back |
| Launch UI, test dollar (`rules-usdt/`) | the same for the corrected set's test-dollar rules launcher factory, without buy the rest |
| Vault UI, the pile (`square-hole-pile/`) | for the corrected set's two pile vault factories: the pile, what one token redeems for, your tokens; hand in tokens and redeem in one press |
| Vault UI, the rules (`square-hole-rules/`) | for the corrected set's two rules vault factories: what arrived and is not shared yet, each rule with its part, what it was sent and what waits; share out; pay a creator part that waits; redeem from the rules' pile, found through the vault itself |

Flap's own checks pass on all four (`launcher:check-source` on the launch UIs, `vault:check` on the vault UIs, no
blocking finding). Flap publishes a UI and maps it to a factory itself, so none of them is live on Flap's site by our
own hand.

### Four.meme / OpenFour: the problem, who it is for, and what is different

On a tax token the tax lands in a wallet, and holders have to trust whoever holds it. Before buying, nobody can check
where the money will go. This is for creators who want to make a promise they cannot take back, and for buyers who
want to check that promise on chain before they buy. Two of OpenFour's own extension points are filled: a trade
module, where a fee on every curve trade goes into a pile and any holder can hand in tokens and take their share; and
a tax vault template with the creator's rules: a share for the creator, a share for the pile, a share that buys back
and burns. The rules are inside the signed creation, so nobody can change them later. A visitor creates such a token
with their own wallet on our page.

## The launches with rules, on chain (26 November)

- **Sweet Jar** (SWEET), on Flap in BNB. Rules: creator 10%, pile 60%, buy and burn 30%. The rules' first income,
  0.00112 BNB (the sale's 1% fee, about 0.001 BNB, and about 0.000119 BNB of pool tax from the first pool buy), was
  shared: creator 0.000112, pile 0.000671, buy and burn 0.000336 (1.60 million SWEET burned).
- **Pay Packet** (PACKET), on Flap in the test dollar. Rules: creator 10%, pile 30%, holders 40%, buy and burn 20%.
  The rules' first income, 17.00 test dollars (the sale's 1% fee on the 1,700 test dollars raised; pool tax arrives
  later, once a pool sell has turned it into test dollars), was shared: creator 1.70, pile 5.10, the holders' stake
  6.80, buy and burn 3.40 (936,175 PACKET burned). A holder staked 145.3 million PACKET; the 6.80 test dollars stream
  to the stakers over one day; a first claim paid 0.00022 test dollars. A second holder staked and took all of it out
  again.
- **Swap Deck** (SDECK), on Flap in the test dollar. Rules: creator 10%, pile 30%, card shop 40%, buy and burn 20%.
  Its shop pays 1,000, 2,000, 4,000 and 8,000 SDECK for a Common, Uncommon, Rare and Legendary card; a pick costs
  twice that; gives are capped at 100,000 SDECK per seven days, net of picks. After three rounds of pool trades (two
  wallets, each buying for 100 test dollars and selling 10,000,000 SDECK, three times) the rules held 38.88 test
  dollars (the sale's 1% fee of 17 and 21.88 of pool tax) and shared them: creator 3.89, pile 11.67, the shop 15.55,
  buy and burn 7.78 (1.62 million SDECK burned). Sixteen cards were stocked, four of each tier; a refill, which anyone
  may call, turned the shop's 15.55 test dollars into SDECK for its budget. One wallet picked a Common for exactly
  2,000 SDECK; another handed in a Common and was paid exactly 1,000 SDECK. Afterwards the shop's budget was about 3.2
  million SDECK. Unlike the platform's own Card Shop, this shop has no wait before gives: giving and picking worked
  within half an hour of the launch.
- **Snip** (SNIP), on our OpenFour copy in WBNB. Rules: creator 20%, pile 50%, buy and burn 30%. Its trading tax (3%
  on buys and on sells, as the token reads) came to 0.00313 WBNB over two share-outs: creator 0.000627, pile
  0.00157, buy and burn 0.00094, which burned 2.03 million SNIP once the token had moved to PancakeSwap. A holder
  handed in 10,000,000 SNIP to the pile and was paid from it.

## See it live

Every address below was written into this page by a script, from the deployment and state files of this
repository named in each heading; nobody typed one. Each links to the test network's explorer. Open a heading to
see its list.

<!-- live:begin (written by hackathon/public/live.mjs; do not edit by hand) -->

<details><summary><b>The platform: the two releases on chain 97 (the second one's card shop takes a ten-minute wait)</b> (46 entries, from <code>packages/contracts/deployments/core-v1/97.json</code>)</summary>

| What | On the explorer |
|---|---|
| chain / poolManager | [`0xb0fd2d66040d310ed6bffbf8dba9ffcef39f52a4`](https://testnet.bscscan.com/address/0xb0fd2d66040d310ed6bffbf8dba9ffcef39f52a4) |
| chain / weth | [`0xae13d989dac2f0debff460ac112a837c89baa7cd`](https://testnet.bscscan.com/address/0xae13d989dac2f0debff460ac112a837c89baa7cd) |
| chain / randomness | [`0x4d1fdc8838ddb913779b9c5e79e2b2a82c58a264`](https://testnet.bscscan.com/address/0x4d1fdc8838ddb913779b9c5e79e2b2a82c58a264) |
| chain / platformSafe | [`0x974d108cf896fb4b0981a13df759349d44296d27`](https://testnet.bscscan.com/address/0x974d108cf896fb4b0981a13df759349d44296d27) |
| releases / 1 / factory | [`0xb954a0db33a6351e76e519b4830489531c39d4f0`](https://testnet.bscscan.com/address/0xb954a0db33a6351e76e519b4830489531c39d4f0) |
| releases / 1 / registry | [`0xf77ef448bbc61d559ee8f657ce3a0b59f1af0daf`](https://testnet.bscscan.com/address/0xf77ef448bbc61d559ee8f657ce3a0b59f1af0daf) |
| releases / 1 / listingRegistry | [`0xccf0b8cc9257db834d77f29ea9eb8e5554ba0170`](https://testnet.bscscan.com/address/0xccf0b8cc9257db834d77f29ea9eb8e5554ba0170) |
| releases / 1 / feeModuleDirectory | [`0xc4cf337484488ca377d111ea1e81d77eec57f62c`](https://testnet.bscscan.com/address/0xc4cf337484488ca377d111ea1e81d77eec57f62c) |
| releases / 1 / safes / Safe 1.4.1 singleton | [`0x9573d4ae9fe9b779d0ba05848d70af641c415b1d`](https://testnet.bscscan.com/address/0x9573d4ae9fe9b779d0ba05848d70af641c415b1d) |
| releases / 1 / safes / owner | [`0x2ef9a78074bbf674bea16f21154a30c821a3c576`](https://testnet.bscscan.com/address/0x2ef9a78074bbf674bea16f21154a30c821a3c576) |
| releases / 1 / implementations / coordinator | [`0x112dbc9947e426a4c763eb54d72b977465d23417`](https://testnet.bscscan.com/address/0x112dbc9947e426a4c763eb54d72b977465d23417) |
| releases / 1 / implementations / token | [`0xb5030440ed22431ef369408f023ba45b1c344076`](https://testnet.bscscan.com/address/0xb5030440ed22431ef369408f023ba45b1c344076) |
| releases / 1 / implementations / hook | [`0x223feb9c89191eae39f10df6def18e073a89d1f6`](https://testnet.bscscan.com/address/0x223feb9c89191eae39f10df6def18e073a89d1f6) |
| releases / 1 / implementations / vault | [`0xf0ec5d528449f0e140888bb4450c77bad95bf5a3`](https://testnet.bscscan.com/address/0xf0ec5d528449f0e140888bb4450c77bad95bf5a3) |
| releases / 1 / implementations / collection | [`0x6f247907c9bd67747e32f934c80ab61b73073f2b`](https://testnet.bscscan.com/address/0x6f247907c9bd67747e32f934c80ab61b73073f2b) |
| releases / 1 / implementations / receiver | [`0x7bb1ea95ee1282229224bed7a08f0f77d03e6f8a`](https://testnet.bscscan.com/address/0x7bb1ea95ee1282229224bed7a08f0f77d03e6f8a) |
| releases / 1 / implementations / launchRouter | [`0xaf09eeff38c5580a7982616f61c02331d2e4d33a`](https://testnet.bscscan.com/address/0xaf09eeff38c5580a7982616f61c02331d2e4d33a) |
| releases / 1 / implementations / tickets | [`0x5660ea9527b80c1012e020d5aff676e70d6cb5f3`](https://testnet.bscscan.com/address/0x5660ea9527b80c1012e020d5aff676e70d6cb5f3) |
| releases / 1 / implementations / royaltyRouter | [`0xf66639cd605f7e51d128c7f17f9b934ae14c4f6a`](https://testnet.bscscan.com/address/0xf66639cd605f7e51d128c7f17f9b934ae14c4f6a) |
| releases / 1 / implementations / itemLedger | [`0xb6e67c79ca478b193b4812e2c320a1b9de72081a`](https://testnet.bscscan.com/address/0xb6e67c79ca478b193b4812e2c320a1b9de72081a) |
| releases / 1 / implementations / holderLedger | [`0x1e1f385ca0b9942acd59591c2d3941820d17a58b`](https://testnet.bscscan.com/address/0x1e1f385ca0b9942acd59591c2d3941820d17a58b) |
| releases / 1 / implementations / starterSetLoader | [`0x3b0812afe653a8e5091459410c74c99ab1e08760`](https://testnet.bscscan.com/address/0x3b0812afe653a8e5091459410c74c99ab1e08760) |
| releases / 1 / implementations / tokenLedger | [`0x2688213d36da0ed31b246a7f6a2f07fc7fedc45c`](https://testnet.bscscan.com/address/0x2688213d36da0ed31b246a7f6a2f07fc7fedc45c) |
| releases / 1 / implementations / shopVault | [`0x73ae6e7f1c94541e27ab530d1f3ec335008453d8`](https://testnet.bscscan.com/address/0x73ae6e7f1c94541e27ab530d1f3ec335008453d8) |
| releases / 1 / implementations / pileVault | [`0x2fd72f6c36f9f943af93e025c1f9d17632fb403a`](https://testnet.bscscan.com/address/0x2fd72f6c36f9f943af93e025c1f9d17632fb403a) |
| releases / 1 / implementations / hookExtension | [`0xff77287e3ec064e22d4847bc803f2feb949e322b`](https://testnet.bscscan.com/address/0xff77287e3ec064e22d4847bc803f2feb949e322b) |
| releases / 2 / factory | [`0xd1546a4d9c248c88d98ab0c8a309d59dd13c1f50`](https://testnet.bscscan.com/address/0xd1546a4d9c248c88d98ab0c8a309d59dd13c1f50) |
| releases / 2 / registry | [`0x0205cbe1c16e8d3d3d8368fba9df0a8be1beae91`](https://testnet.bscscan.com/address/0x0205cbe1c16e8d3d3d8368fba9df0a8be1beae91) |
| releases / 2 / listingRegistry | [`0x540d5475c65a8a11e01c24de2729b59c82ac76c1`](https://testnet.bscscan.com/address/0x540d5475c65a8a11e01c24de2729b59c82ac76c1) |
| releases / 2 / feeModuleDirectory | [`0x404a0d052dd4cc6eb46bdb93ad9e8990db398fdb`](https://testnet.bscscan.com/address/0x404a0d052dd4cc6eb46bdb93ad9e8990db398fdb) |
| releases / 2 / implementations / coordinator | [`0x78b51f623e875bc5f258aaa91822fd63911ae1ca`](https://testnet.bscscan.com/address/0x78b51f623e875bc5f258aaa91822fd63911ae1ca) |
| releases / 2 / implementations / token | [`0x8a2b7aafdd0ca2ce0d1d2e1ca26bc7c36f042588`](https://testnet.bscscan.com/address/0x8a2b7aafdd0ca2ce0d1d2e1ca26bc7c36f042588) |
| releases / 2 / implementations / hook | [`0x91d00353da470d306824f5ea9835eb7490b8fbc7`](https://testnet.bscscan.com/address/0x91d00353da470d306824f5ea9835eb7490b8fbc7) |
| releases / 2 / implementations / vault | [`0xdc88d46b0e5f9ba504375afa1e8fbb5d2747b179`](https://testnet.bscscan.com/address/0xdc88d46b0e5f9ba504375afa1e8fbb5d2747b179) |
| releases / 2 / implementations / collection | [`0x8168ed97361ce9fbd81895a56873d1716778a39f`](https://testnet.bscscan.com/address/0x8168ed97361ce9fbd81895a56873d1716778a39f) |
| releases / 2 / implementations / receiver | [`0xe7263faa56e93f167bec2c2b189bebab232e94e4`](https://testnet.bscscan.com/address/0xe7263faa56e93f167bec2c2b189bebab232e94e4) |
| releases / 2 / implementations / launchRouter | [`0xd167df8c2160aeeefe42fc8562aea44e95be783e`](https://testnet.bscscan.com/address/0xd167df8c2160aeeefe42fc8562aea44e95be783e) |
| releases / 2 / implementations / tickets | [`0xd855e5a8d3ea40ff2b7f70672cd539b456c45008`](https://testnet.bscscan.com/address/0xd855e5a8d3ea40ff2b7f70672cd539b456c45008) |
| releases / 2 / implementations / royaltyRouter | [`0xb61cff246ea69631057b4cdebaaa565a14df891c`](https://testnet.bscscan.com/address/0xb61cff246ea69631057b4cdebaaa565a14df891c) |
| releases / 2 / implementations / itemLedger | [`0xdffde0be52f19aa14923775998d1fad2e9b1d5d3`](https://testnet.bscscan.com/address/0xdffde0be52f19aa14923775998d1fad2e9b1d5d3) |
| releases / 2 / implementations / holderLedger | [`0xc66520d4897412766f8fb120d351a7e39ca48d7c`](https://testnet.bscscan.com/address/0xc66520d4897412766f8fb120d351a7e39ca48d7c) |
| releases / 2 / implementations / starterSetLoader | [`0x9e87f3ce23f4ab07f3222998a5517201e0932cdb`](https://testnet.bscscan.com/address/0x9e87f3ce23f4ab07f3222998a5517201e0932cdb) |
| releases / 2 / implementations / tokenLedger | [`0xd3d257869b58600fda1e17d0ceb55b793a45de3e`](https://testnet.bscscan.com/address/0xd3d257869b58600fda1e17d0ceb55b793a45de3e) |
| releases / 2 / implementations / shopVault | [`0x8a62e5dfd0f10a4a9bf4fecf0fabcf39b6930137`](https://testnet.bscscan.com/address/0x8a62e5dfd0f10a4a9bf4fecf0fabcf39b6930137) |
| releases / 2 / implementations / pileVault | [`0x364c06e0715110a3888af1e3661a1e24648a4160`](https://testnet.bscscan.com/address/0x364c06e0715110a3888af1e3661a1e24648a4160) |
| releases / 2 / implementations / hookExtension | [`0xfa46531b8f6a4ded2a163ae9e6e79f73c1957694`](https://testnet.bscscan.com/address/0xfa46531b8f6a4ded2a163ae9e6e79f73c1957694) |

</details>

<details><summary><b>Test coins, price listings, pools, converter routes and the faucet</b> (28 entries, from <code>packages/contracts/deployments/bnb-testnet/97-extras.json</code>)</summary>

| What | On the explorer |
|---|---|
| deployer | [`0x2ef9a78074bbf674bea16f21154a30c821a3c576`](https://testnet.bscscan.com/address/0x2ef9a78074bbf674bea16f21154a30c821a3c576) |
| feeModuleDirectory | [`0xc4cf337484488ca377d111ea1e81d77eec57f62c`](https://testnet.bscscan.com/address/0xc4cf337484488ca377d111ea1e81d77eec57f62c) |
| feeModuleDirectory / modules / 1 / module | [`0x47e26d022b631673a270c7db34a2b627cb49d50a`](https://testnet.bscscan.com/address/0x47e26d022b631673a270c7db34a2b627cb49d50a) |
| feeModuleDirectory / modules / 2 / module | [`0x30fe81114f79187b44b611015128a4e7e49be1d3`](https://testnet.bscscan.com/address/0x30fe81114f79187b44b611015128a4e7e49be1d3) |
| feeModuleDirectory / modules / 3 / module | [`0x314b1be4bdf0c8bc07ed3317c0b144bf6cd4b9d8`](https://testnet.bscscan.com/address/0x314b1be4bdf0c8bc07ed3317c0b144bf6cd4b9d8) |
| feeModuleDirectory / modules / 4 / module | [`0x36f7ffedaf5e9b7492eb179999c214dd2443fa40`](https://testnet.bscscan.com/address/0x36f7ffedaf5e9b7492eb179999c214dd2443fa40) |
| feeModuleDirectory / modules / 5 / module | [`0x11597fdc64a5761557f5c9ac648c710b59e30e93`](https://testnet.bscscan.com/address/0x11597fdc64a5761557f5c9ac648c710b59e30e93) |
| feeModuleDirectory / modules / 5 / pileCoin | [`0x2f8029a6447663e0881b0e21f5e4ad0f1717627e`](https://testnet.bscscan.com/address/0x2f8029a6447663e0881b0e21f5e4ad0f1717627e) |
| feeModuleDirectory / modules / 5 / trigger | [`0x920b1439bc0bf2f30f9e01b9bb94d90a9ba35189`](https://testnet.bscscan.com/address/0x920b1439bc0bf2f30f9e01b9bb94d90a9ba35189) |
| feeModuleDirectory / modules / 6 / module | [`0xf7179bbb5cb34c702dbb39ce356b177920c05a2c`](https://testnet.bscscan.com/address/0xf7179bbb5cb34c702dbb39ce356b177920c05a2c) |
| feeModuleDirectory / modules / 6 / pileCoin | [`0x4ba04db6044a6f442bdb29b032cb019f663ab164`](https://testnet.bscscan.com/address/0x4ba04db6044a6f442bdb29b032cb019f663ab164) |
| feeModuleDirectory / modules / 7 / module | [`0x13b5cfb0215743c9205dfcdb9d10bd024c3201cc`](https://testnet.bscscan.com/address/0x13b5cfb0215743c9205dfcdb9d10bd024c3201cc) |
| feeModuleDirectory / modules / 7 / priceCoin | [`0x25c5789b269d8f76309ce961759d643dce291347`](https://testnet.bscscan.com/address/0x25c5789b269d8f76309ce961759d643dce291347) |
| listings / 5 / token | [`0xf4f59ecf2221c9c07ca8fcf47a2652008fea2ed8`](https://testnet.bscscan.com/address/0xf4f59ecf2221c9c07ca8fcf47a2652008fea2ed8) |
| listings / 6 / token | [`0x860822580d4eb2529de0c74c3e2b1d6d7c183302`](https://testnet.bscscan.com/address/0x860822580d4eb2529de0c74c3e2b1d6d7c183302) |
| nativePoolHelper | [`0xf5373e33f6900e608950c9031e345f060af671ab`](https://testnet.bscscan.com/address/0xf5373e33f6900e608950c9031e345f060af671ab) |
| trade / poolManager | [`0xb0fd2d66040d310ed6bffbf8dba9ffcef39f52a4`](https://testnet.bscscan.com/address/0xb0fd2d66040d310ed6bffbf8dba9ffcef39f52a4) |
| trade / poolSwapTest | [`0x95c8aa9ad318a897259e1910a9f1ad31bec40c35`](https://testnet.bscscan.com/address/0x95c8aa9ad318a897259e1910a9f1ad31bec40c35) |
| trade / swapper | [`0xd0a5872737d4dec8c7e33dff205ab74bd43b4a3e`](https://testnet.bscscan.com/address/0xd0a5872737d4dec8c7e33dff205ab74bd43b4a3e) |
| secondRelease / factory | [`0xd1546a4d9c248c88d98ab0c8a309d59dd13c1f50`](https://testnet.bscscan.com/address/0xd1546a4d9c248c88d98ab0c8a309d59dd13c1f50) |
| secondRelease / registry | [`0x0205cbe1c16e8d3d3d8368fba9df0a8be1beae91`](https://testnet.bscscan.com/address/0x0205cbe1c16e8d3d3d8368fba9df0a8be1beae91) |
| secondRelease / listingRegistry | [`0x540d5475c65a8a11e01c24de2729b59c82ac76c1`](https://testnet.bscscan.com/address/0x540d5475c65a8a11e01c24de2729b59c82ac76c1) |
| secondRelease / feeModuleDirectory | [`0x404a0d052dd4cc6eb46bdb93ad9e8990db398fdb`](https://testnet.bscscan.com/address/0x404a0d052dd4cc6eb46bdb93ad9e8990db398fdb) |
| secondRelease / feeModuleDirectory / modules / 1 / module | [`0x7fad2a6f8474cb52b5b15a23d21f5fe1ce5edc75`](https://testnet.bscscan.com/address/0x7fad2a6f8474cb52b5b15a23d21f5fe1ce5edc75) |
| secondRelease / feeModuleDirectory / modules / 2 / module | [`0xa20b8b42b7463cc33c131d171491a0a1d59e071c`](https://testnet.bscscan.com/address/0xa20b8b42b7463cc33c131d171491a0a1d59e071c) |
| secondRelease / feeModuleDirectory / modules / 3 / module | [`0x1b90d32f4c6ecf5bc687553cfb6afd5caf59d3c1`](https://testnet.bscscan.com/address/0x1b90d32f4c6ecf5bc687553cfb6afd5caf59d3c1) |
| secondRelease / feeModuleDirectory / modules / 4 / module | [`0xa3fe8c163647a22708669ada77b913245f39ac8c`](https://testnet.bscscan.com/address/0xa3fe8c163647a22708669ada77b913245f39ac8c) |
| secondRelease / shop / implementation | [`0x8a62e5dfd0f10a4a9bf4fecf0fabcf39b6930137`](https://testnet.bscscan.com/address/0x8a62e5dfd0f10a4a9bf4fecf0fabcf39b6930137) |

</details>

<details><summary><b>The demo boxes</b> (6 entries, from <code>apps/web/src/features/examples/demo-boxes-97.json</code>)</summary>

| What | On the explorer |
|---|---|
| boxes / 1 / token | [`0x734C884B480159B3c993f2A95a45e81A36a13a27`](https://testnet.bscscan.com/address/0x734C884B480159B3c993f2A95a45e81A36a13a27) |
| boxes / 1 / coordinator | [`0x3F420c889923964B703012c095571fED11F524FC`](https://testnet.bscscan.com/address/0x3F420c889923964B703012c095571fED11F524FC) |
| boxes / 1 / createTx | [`0xe2d8bb2b5e8fd1c559355f09c3cb4a9bae3ced15221db892270cf52164c04716`](https://testnet.bscscan.com/tx/0xe2d8bb2b5e8fd1c559355f09c3cb4a9bae3ced15221db892270cf52164c04716) |
| boxes / 2 / token | [`0x5539280794dd81763afE9dCAf326EF6c52327863`](https://testnet.bscscan.com/address/0x5539280794dd81763afE9dCAf326EF6c52327863) |
| boxes / 2 / coordinator | [`0x216262834df5811ae0B4B7d7942F8bcC82c2641B`](https://testnet.bscscan.com/address/0x216262834df5811ae0B4B7d7942F8bcC82c2641B) |
| boxes / 2 / createTx | [`0x84f925e46b0fe3244f6685f0e4ae5939ec869413f4b9650e808117fe9a1694b1`](https://testnet.bscscan.com/tx/0x84f925e46b0fe3244f6685f0e4ae5939ec869413f4b9650e808117fe9a1694b1) |

</details>

<details><summary><b>The Alchemist, Pile Party and Pile Furnace: the boxes and the transactions of their lives, from the record of the real runs</b> (13 entries, from <code>hackathon/real-97-demo-boxes.json</code>)</summary>

| What | On the explorer |
|---|---|
| The Alchemist (LEAD) / coordinator | [`0x3ce857cab35CCE08AE8cdDA23824C2a9Ca000dcC`](https://testnet.bscscan.com/address/0x3ce857cab35CCE08AE8cdDA23824C2a9Ca000dcC) |
| The Alchemist (LEAD) / token | [`0x750a40A83A37d473211a270d0CC8Fc400Ed758bb`](https://testnet.bscscan.com/address/0x750a40A83A37d473211a270d0CC8Fc400Ed758bb) |
| The Alchemist (LEAD) / created | [`0xa2512da758b6a356cfa66f71e22c69a45a20c5453b0ae4965f116b8bb1f6003f`](https://testnet.bscscan.com/tx/0xa2512da758b6a356cfa66f71e22c69a45a20c5453b0ae4965f116b8bb1f6003f) |
| The Alchemist / the buyers' fees converted into tNVDA for the pile | [`0xfc97394046709938742720e176e3c4a4192fcba257e58c2a82410008c45f0c1b`](https://testnet.bscscan.com/tx/0xfc97394046709938742720e176e3c4a4192fcba257e58c2a82410008c45f0c1b) |
| The Alchemist / the sellers' fees bought back and burned LEAD | [`0x6ae5da06591eba9675e0337c5098f89fa8ce9fa62cbce23cb2cc781e59ab7042`](https://testnet.bscscan.com/tx/0x6ae5da06591eba9675e0337c5098f89fa8ce9fa62cbce23cb2cc781e59ab7042) |
| Pile Party (PARTY) / coordinator | [`0xE687F50Da7F26D59baDC40b7500a959f82b5E617`](https://testnet.bscscan.com/address/0xE687F50Da7F26D59baDC40b7500a959f82b5E617) |
| Pile Party (PARTY) / token | [`0xBebc586C0c03e9e52875d21fa8d25808B15ad2D9`](https://testnet.bscscan.com/address/0xBebc586C0c03e9e52875d21fa8d25808B15ad2D9) |
| Pile Party (PARTY) / created | [`0x33621406768233dbd671b7cf480cf6222ba7a0effb64224beb0d9bd4eebdc785`](https://testnet.bscscan.com/tx/0x33621406768233dbd671b7cf480cf6222ba7a0effb64224beb0d9bd4eebdc785) |
| Pile Furnace (FURN) / coordinator | [`0x8bEA8Ca943e9Bc2BEb940e43b3B06E8A46384864`](https://testnet.bscscan.com/address/0x8bEA8Ca943e9Bc2BEb940e43b3B06E8A46384864) |
| Pile Furnace (FURN) / token | [`0x8E9dF2A6b9Fb8EC7772A9afD2E59b7E6A5B6614E`](https://testnet.bscscan.com/address/0x8E9dF2A6b9Fb8EC7772A9afD2E59b7E6A5B6614E) |
| Pile Furnace (FURN) / created | [`0x289a6a9cf9ee0f27a9efe97cd4c0cc8b7eb1da3e13cd4fb8b09c83df7810540b`](https://testnet.bscscan.com/tx/0x289a6a9cf9ee0f27a9efe97cd4c0cc8b7eb1da3e13cd4fb8b09c83df7810540b) |
| Pile Furnace / PILE sent to the dead address, round 1 | [`0xe7b5b21fd630d85d210e971644a990ebf67e065ee6766cdebbe56c55465aad55`](https://testnet.bscscan.com/tx/0xe7b5b21fd630d85d210e971644a990ebf67e065ee6766cdebbe56c55465aad55) |
| Pile Furnace / PILE sent to the dead address, round 2 | [`0xebb764cf072b7166de76d99db2fab734a4348453c1ff954b06f920fc10501694`](https://testnet.bscscan.com/tx/0xebb764cf072b7166de76d99db2fab734a4348453c1ff954b06f920fc10501694) |

</details>

<details><summary><b>The card shop: four card collections and the box that sells them</b> (12 entries, from <code>packages/contracts/deployments/bnb-testnet/97-cards.json</code>)</summary>

| What | On the explorer |
|---|---|
| collections / common | [`0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174`](https://testnet.bscscan.com/address/0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174) |
| collections / uncommon | [`0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577`](https://testnet.bscscan.com/address/0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577) |
| collections / rare | [`0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC`](https://testnet.bscscan.com/address/0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC) |
| collections / legendary | [`0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143`](https://testnet.bscscan.com/address/0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143) |
| starterHolder | [`0x2EF9A78074bbf674bEA16f21154a30c821A3C576`](https://testnet.bscscan.com/address/0x2EF9A78074bbf674bEA16f21154a30c821A3C576) |
| testerHolder | [`0xc979F6Cb8902f56f76b926358dC451cBF8f310F0`](https://testnet.bscscan.com/address/0xc979F6Cb8902f56f76b926358dC451cBF8f310F0) |
| box / coordinator | [`0x513019E1A60a1F8D9D8DfaFa85F0d62344382CC0`](https://testnet.bscscan.com/address/0x513019E1A60a1F8D9D8DfaFa85F0d62344382CC0) |
| box / boxToken | [`0x445A859675d9521167878FEe302dC83c6A5DDEb8`](https://testnet.bscscan.com/address/0x445A859675d9521167878FEe302dC83c6A5DDEb8) |
| box / vault | [`0x1c7Ec0EC2a959186176b616ab2825708fd4cE5fA`](https://testnet.bscscan.com/address/0x1c7Ec0EC2a959186176b616ab2825708fd4cE5fA) |
| box / starterLoader | [`0xeFEe29D6BE48E3C7a6592dD4f9F96b4a850611f7`](https://testnet.bscscan.com/address/0xeFEe29D6BE48E3C7a6592dD4f9F96b4a850611f7) |
| box / hook | [`0x773D144856d46CDfc5E217a5f5a3EDFeD083aae0`](https://testnet.bscscan.com/address/0x773D144856d46CDfc5E217a5f5a3EDFeD083aae0) |
| box / priceCoin | [`0x25C5789b269D8f76309CE961759d643dce291347`](https://testnet.bscscan.com/address/0x25C5789b269D8f76309CE961759d643dce291347) |

</details>

<details><summary><b>The price data: Atlas's feeds, the source, the copy and the raise setter, and the setter's first three raises</b> (18 entries, from <code>packages/contracts/deployments/bnb-testnet/97-atlas.json</code>)</summary>

| What | On the explorer |
|---|---|
| deployer | [`0x2EF9A78074bbf674bEA16f21154a30c821A3C576`](https://testnet.bscscan.com/address/0x2EF9A78074bbf674bEA16f21154a30c821A3C576) |
| mirror | [`0xE1F83eE5a2ba0f5Bf4Ff7737D9C879f716d2e912`](https://testnet.bscscan.com/address/0xE1F83eE5a2ba0f5Bf4Ff7737D9C879f716d2e912) |
| source | [`0x08857eEd51dEA7813c834d20eA6bA2fF06BcD7Eb`](https://testnet.bscscan.com/address/0x08857eEd51dEA7813c834d20eA6bA2fF06BcD7Eb) |
| setter | [`0x34A364Bd2E4129E92e1102245e582fe22aa266A8`](https://testnet.bscscan.com/address/0x34A364Bd2E4129E92e1102245e582fe22aa266A8) |
| mirrorWriter | [`0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189`](https://testnet.bscscan.com/address/0x920B1439BC0BF2f30f9E01B9Bb94d90A9ba35189) |
| feeds / 1 / feed | [`0x3957d289ee9C38272377786787ea34F9dd29788D`](https://testnet.bscscan.com/address/0x3957d289ee9C38272377786787ea34F9dd29788D) |
| feeds / 2 / feed | [`0x3eF39d6361EfA1E8Ca066751f438077dA81082A6`](https://testnet.bscscan.com/address/0x3eF39d6361EfA1E8Ca066751f438077dA81082A6) |
| feeds / 3 / feed | [`0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764`](https://testnet.bscscan.com/address/0xB3C87F255CE00b2692dc0eaf3e5985fBe2489764) |
| feeds / 4 / feed | [`0x35369dEcD8c662954B3D24acc2A862C708A34fD2`](https://testnet.bscscan.com/address/0x35369dEcD8c662954B3D24acc2A862C708A34fD2) |
| listingRegistry | [`0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170`](https://testnet.bscscan.com/address/0xcCf0B8CC9257DB834d77F29EA9eB8e5554ba0170) |
| holdingContract | [`0x974d108cf896fb4b0981a13df759349d44296d27`](https://testnet.bscscan.com/address/0x974d108cf896fb4b0981a13df759349d44296d27) |
| firstPokes / rows / 1 / hash | [`0x73dcdd573f275f47e7b5f56186d526f145ff5c6e7d0fd00823e96e87146cb844`](https://testnet.bscscan.com/tx/0x73dcdd573f275f47e7b5f56186d526f145ff5c6e7d0fd00823e96e87146cb844) |
| firstPokes / rows / 2 / hash | [`0x467cd12c432735071f92e9678f7599fba9a9f5fa22a27ef9d9ceab67d81b387c`](https://testnet.bscscan.com/tx/0x467cd12c432735071f92e9678f7599fba9a9f5fa22a27ef9d9ceab67d81b387c) |
| firstPokes / rows / 3 / hash | [`0x9475936e7c85e09f69baebba3ccd6b0e8270a52a9265e1914665f4c784760b11`](https://testnet.bscscan.com/tx/0x9475936e7c85e09f69baebba3ccd6b0e8270a52a9265e1914665f4c784760b11) |
| retired / source | [`0x44B187F89Ad9aa2f0526a553eBD36425490Bb01D`](https://testnet.bscscan.com/address/0x44B187F89Ad9aa2f0526a553eBD36425490Bb01D) |
| retired / setters / 1 | [`0xC3A0C62981fb5dEF1CDC546fdE67153727aB0479`](https://testnet.bscscan.com/address/0xC3A0C62981fb5dEF1CDC546fdE67153727aB0479) |
| retired / setters / 2 | [`0x2d7BE91672aa149F897064BabF8FfdeEBbf9B079`](https://testnet.bscscan.com/address/0x2d7BE91672aa149F897064BabF8FfdeEBbf9B079) |
| retired / bnbUsdFeed | [`0xb3d1614Bf894E68ADd1EA50CA250C152BAd5256F`](https://testnet.bscscan.com/address/0xb3d1614Bf894E68ADd1EA50CA250C152BAd5256F) |

</details>

<details><summary><b>The launch on Flap: the Launcher Factory and the pile's vault factory</b> (5 entries, from <code>bounties/flap/deployments/97.json</code>)</summary>

| What | On the explorer |
|---|---|
| curveLauncherFactory | [`0x151e43d81b3Ac5DBf566A1d01B5674cc2C4c7594`](https://testnet.bscscan.com/address/0x151e43d81b3Ac5DBf566A1d01B5674cc2C4c7594) |
| curveLauncherImplementation | [`0xEF3db45d399DA742410f7651E43264bBadA393Aa`](https://testnet.bscscan.com/address/0xEF3db45d399DA742410f7651E43264bBadA393Aa) |
| pileVaultFactory | [`0xdF5078057836CAd4e733C591645c3a221786E869`](https://testnet.bscscan.com/address/0xdF5078057836CAd4e733C591645c3a221786E869) |
| portal | [`0x000042108465206185A077Edc3F3fd2b49060000`](https://testnet.bscscan.com/address/0x000042108465206185A077Edc3F3fd2b49060000) |
| tokenImpl | [`0x7777c57ff7dc441c1715b2e36fa581c48B782222`](https://testnet.bscscan.com/address/0x7777c57ff7dc441c1715b2e36fa581c48B782222) |

</details>

<details><summary><b>The launch on Flap: the sale made through Flap's Portal</b> (2 entries, from <code>bounties/flap/deployments/97-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0x4938E88Ecf39A4549a38B858a4D02D2326D91D8d`](https://testnet.bscscan.com/address/0x4938E88Ecf39A4549a38B858a4D02D2326D91D8d) |
| token | [`0x7Eb53F6D508a9c24A3d0594DB3C41f04FcC37777`](https://testnet.bscscan.com/address/0x7Eb53F6D508a9c24A3d0594DB3C41f04FcC37777) |

</details>

<details><summary><b>The launch on Flap with a token as the quote: the two factories for Flap's test USDT</b> (6 entries, from <code>bounties/flap/deployments/97-usdt.json</code>)</summary>

| What | On the explorer |
|---|---|
| portal | [`0x000042108465206185A077Edc3F3fd2b49060000`](https://testnet.bscscan.com/address/0x000042108465206185A077Edc3F3fd2b49060000) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| tokenCurveLauncherFactory | [`0x51034cf27e4234820bCC7152583Ab8e8d95DbE77`](https://testnet.bscscan.com/address/0x51034cf27e4234820bCC7152583Ab8e8d95DbE77) |
| tokenCurveLauncherImplementation | [`0xad118f9B80a70c0d2fa185339d196A300ECA9683`](https://testnet.bscscan.com/address/0xad118f9B80a70c0d2fa185339d196A300ECA9683) |
| tokenImpl | [`0x7777c57ff7dc441c1715b2e36fa581c48B782222`](https://testnet.bscscan.com/address/0x7777c57ff7dc441c1715b2e36fa581c48B782222) |
| tokenPileVaultFactory | [`0x148746f148a3Cea4A48BA7F94fa8F2b1C08BBB00`](https://testnet.bscscan.com/address/0x148746f148a3Cea4A48BA7F94fa8F2b1C08BBB00) |

</details>

<details><summary><b>The launch on Flap with a token as the quote: the sale made through Flap's Portal</b> (3 entries, from <code>bounties/flap/deployments/97-usdt-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0xEc913d94Cb34df026Ee724E7084275196fE83493`](https://testnet.bscscan.com/address/0xEc913d94Cb34df026Ee724E7084275196fE83493) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| token | [`0x115c374C655e503af579C9F426B8FA30d8d67777`](https://testnet.bscscan.com/address/0x115c374C655e503af579C9F426B8FA30d8d67777) |

</details>

<details><summary><b>Their token, our rules, on Flap in BNB: the launcher factory and the rules vault factory</b> (6 entries, from <code>bounties/flap/deployments/97-rules-native.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcherFactory | [`0x45A2BCDc29E379585e3D424FbA0c8a290FDe2560`](https://testnet.bscscan.com/address/0x45A2BCDc29E379585e3D424FbA0c8a290FDe2560) |
| pileDeployer | [`0x6E4c921ca563fdf57d5ed64E9d87681994F03F1D`](https://testnet.bscscan.com/address/0x6E4c921ca563fdf57d5ed64E9d87681994F03F1D) |
| portal | [`0x000042108465206185A077Edc3F3fd2b49060000`](https://testnet.bscscan.com/address/0x000042108465206185A077Edc3F3fd2b49060000) |
| router | [`0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3`](https://testnet.bscscan.com/address/0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3) |
| rulesVaultDeployer | [`0x8B4eeFAeD20A49b9139881963aA1d4b0825dF5d3`](https://testnet.bscscan.com/address/0x8B4eeFAeD20A49b9139881963aA1d4b0825dF5d3) |
| rulesVaultFactory | [`0x114Fa92D802dF51701E1A8888c37628949504391`](https://testnet.bscscan.com/address/0x114Fa92D802dF51701E1A8888c37628949504391) |

</details>

<details><summary><b>Sweet Jar (SWEET): the launch on Flap in BNB with the creator's rules</b> (3 entries, from <code>bounties/flap/deployments/97-rules-native-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0x04Ed9202ffb8eb40971D6e07ca3F94F2db659A62`](https://testnet.bscscan.com/address/0x04Ed9202ffb8eb40971D6e07ca3F94F2db659A62) |
| rulesVaultFactory | [`0x114Fa92D802dF51701E1A8888c37628949504391`](https://testnet.bscscan.com/address/0x114Fa92D802dF51701E1A8888c37628949504391) |
| token | [`0xd739bF40DDD9870b8097171bf79Fb5c36fCa7777`](https://testnet.bscscan.com/address/0xd739bF40DDD9870b8097171bf79Fb5c36fCa7777) |

</details>

<details><summary><b>Their token, our rules, on Flap in the test dollar: the launcher factory and the rules vault factory</b> (7 entries, from <code>bounties/flap/deployments/97-rules-usdt.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcherFactory | [`0xD09d3D40EB9FC16B347D2778df918F33523A4C78`](https://testnet.bscscan.com/address/0xD09d3D40EB9FC16B347D2778df918F33523A4C78) |
| pileDeployer | [`0xc6CD26717665E4f5e132C674000E3dE551f0E343`](https://testnet.bscscan.com/address/0xc6CD26717665E4f5e132C674000E3dE551f0E343) |
| portal | [`0x000042108465206185A077Edc3F3fd2b49060000`](https://testnet.bscscan.com/address/0x000042108465206185A077Edc3F3fd2b49060000) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| router | [`0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3`](https://testnet.bscscan.com/address/0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3) |
| rulesVaultDeployer | [`0x5eC71a513Cf8c7AD0DFB9FAaf3651839781d4FdA`](https://testnet.bscscan.com/address/0x5eC71a513Cf8c7AD0DFB9FAaf3651839781d4FdA) |
| rulesVaultFactory | [`0x0dbcdB88eF74bF55037e50Fa156fFDFfc3dAEd60`](https://testnet.bscscan.com/address/0x0dbcdB88eF74bF55037e50Fa156fFDFfc3dAEd60) |

</details>

<details><summary><b>Holders paid by staking: the stake factory</b> (1 entry, from <code>bounties/flap/deployments/97-stake.json</code>)</summary>

| What | On the explorer |
|---|---|
| factory | [`0x653A6686565dc1d55A7816EAe783cD98a5723af1`](https://testnet.bscscan.com/address/0x653A6686565dc1d55A7816EAe783cD98a5723af1) |

</details>

<details><summary><b>Pay Packet (PACKET): the launch on Flap in the test dollar with the creator's rules and the holders' stake</b> (6 entries, from <code>bounties/flap/deployments/97-rules-usdt-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0x7592b6a20254C0f6EB4919b02dA18f47C3E16689`](https://testnet.bscscan.com/address/0x7592b6a20254C0f6EB4919b02dA18f47C3E16689) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| rulesVaultFactory | [`0x0dbcdB88eF74bF55037e50Fa156fFDFfc3dAEd60`](https://testnet.bscscan.com/address/0x0dbcdB88eF74bF55037e50Fa156fFDFfc3dAEd60) |
| stake | [`0x8d8050617BC6cBb1E0E38D4bcc01026B81A53585`](https://testnet.bscscan.com/address/0x8d8050617BC6cBb1E0E38D4bcc01026B81A53585) |
| stakeFactory | [`0x653A6686565dc1d55A7816EAe783cD98a5723af1`](https://testnet.bscscan.com/address/0x653A6686565dc1d55A7816EAe783cD98a5723af1) |
| token | [`0xF5082302Eb06c59d01a8c083a77a08dEAc027777`](https://testnet.bscscan.com/address/0xF5082302Eb06c59d01a8c083a77a08dEAc027777) |

</details>

<details><summary><b>A card shop for a token of Flap or Four.meme: the shop factory, the two routers and the four card collections it accepts</b> (7 entries, from <code>bounties/core/deployments/97-rail-shop.json</code>)</summary>

| What | On the explorer |
|---|---|
| collections / 1 | [`0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174`](https://testnet.bscscan.com/address/0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174) |
| collections / 2 | [`0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577`](https://testnet.bscscan.com/address/0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577) |
| collections / 3 | [`0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC`](https://testnet.bscscan.com/address/0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC) |
| collections / 4 | [`0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143`](https://testnet.bscscan.com/address/0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143) |
| factory | [`0x8332C91c9F1d8a9058B4e499dd7e4b44a6a6ADC2`](https://testnet.bscscan.com/address/0x8332C91c9F1d8a9058B4e499dd7e4b44a6a6ADC2) |
| routers / 1 (Flap's DEX router) | [`0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3`](https://testnet.bscscan.com/address/0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3) |
| routers / 2 (PancakeSwap's router) | [`0xD99D1c33F9fC3444f8101754aBC46c52416550D1`](https://testnet.bscscan.com/address/0xD99D1c33F9fC3444f8101754aBC46c52416550D1) |

</details>

<details><summary><b>Swap Deck (SDECK): the launch on Flap whose rules feed a card shop</b> (5 entries, from <code>bounties/flap/deployments/97-shop-rules-usdt-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0x915A7aC8180B80153070eCD589d9020af05C1f82`](https://testnet.bscscan.com/address/0x915A7aC8180B80153070eCD589d9020af05C1f82) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| railShopFactory | [`0x8332C91c9F1d8a9058B4e499dd7e4b44a6a6ADC2`](https://testnet.bscscan.com/address/0x8332C91c9F1d8a9058B4e499dd7e4b44a6a6ADC2) |
| shop | [`0x3Fdf028DDE2597B706fBf4F01B6C0E96aEB92857`](https://testnet.bscscan.com/address/0x3Fdf028DDE2597B706fBf4F01B6C0E96aEB92857) |
| token | [`0xCcBD31047F8CC637fA029deCF3E9da9080557777`](https://testnet.bscscan.com/address/0xCcBD31047F8CC637fA029deCF3E9da9080557777) |

</details>

<details><summary><b>The launches with rules on Flap, working: the rules contracts, the piles, the launches, the share-outs, the stake's first claim, the shop's refill, pick and give</b> (15 entries, from <code>hackathon/real-97-flap-rules.json</code>)</summary>

| What | On the explorer |
|---|---|
| Sweet Jar / the rules contract | [`0x23c40c21b93a1fd36414566c9b8afbf6ed5314b5`](https://testnet.bscscan.com/address/0x23c40c21b93a1fd36414566c9b8afbf6ed5314b5) |
| Sweet Jar / the pile | [`0x7D0b8C5a71c29Fb7956Ba5883C9794D2bdc7666f`](https://testnet.bscscan.com/address/0x7D0b8C5a71c29Fb7956Ba5883C9794D2bdc7666f) |
| Sweet Jar / the share-out among the rules | [`0x12dd100730fbb81165ccb821de0e1c01a5197237f8ed8a33ddf4fd9367f183ec`](https://testnet.bscscan.com/tx/0x12dd100730fbb81165ccb821de0e1c01a5197237f8ed8a33ddf4fd9367f183ec) |
| Sweet Jar / the completing buy: the launch into the pool | [`0xbb1cb2ca1261c1294a5d1591cb6493d248be289bb6232355ed0e41c3eae68726`](https://testnet.bscscan.com/tx/0xbb1cb2ca1261c1294a5d1591cb6493d248be289bb6232355ed0e41c3eae68726) |
| Pay Packet / the rules contract | [`0x29d4d8a77e75215b3abf68b8537e800a8094b5d8`](https://testnet.bscscan.com/address/0x29d4d8a77e75215b3abf68b8537e800a8094b5d8) |
| Pay Packet / the pile | [`0x3C581087DF5a16476d2faCa4AF4A2e02e765F886`](https://testnet.bscscan.com/address/0x3C581087DF5a16476d2faCa4AF4A2e02e765F886) |
| Pay Packet / the share-out among the rules | [`0xe299179fa23bdacfdebd056912523096e276c669806285bbd47954f9de030517`](https://testnet.bscscan.com/tx/0xe299179fa23bdacfdebd056912523096e276c669806285bbd47954f9de030517) |
| Pay Packet / the first claim from the holders' stake | [`0x56be5cf11a12d441292413e873f5aca447d691de295aafe937a6261f0fea6daa`](https://testnet.bscscan.com/tx/0x56be5cf11a12d441292413e873f5aca447d691de295aafe937a6261f0fea6daa) |
| Pay Packet / the completing buy: the launch into the pool | [`0xbf73cd17cf67e7c493a1b0ce59583c6a26f78321a5b841975f87d797bd55852f`](https://testnet.bscscan.com/tx/0xbf73cd17cf67e7c493a1b0ce59583c6a26f78321a5b841975f87d797bd55852f) |
| Swap Deck / the rules contract | [`0x4a190d10E6A593b0E742F0032a346e63a1E5CcF2`](https://testnet.bscscan.com/address/0x4a190d10E6A593b0E742F0032a346e63a1E5CcF2) |
| Swap Deck / the share-out among the rules | [`0xfd6f2e0a201e8a87638ff946cfeb42d1929895ff92068096f6ca5a81c264ca7f`](https://testnet.bscscan.com/tx/0xfd6f2e0a201e8a87638ff946cfeb42d1929895ff92068096f6ca5a81c264ca7f) |
| Swap Deck / the refill: the shop's part bought SDECK | [`0x319300339aa2a8f5839c5f74f61afbab717ccef9d15ae807694ccf7f34296a22`](https://testnet.bscscan.com/tx/0x319300339aa2a8f5839c5f74f61afbab717ccef9d15ae807694ccf7f34296a22) |
| Swap Deck / the pick: a Common card for 2,000 SDECK | [`0x2033e54bf171b150c6a5a1c2f156e548182f71edab47c0f5efb64f8d0df21fef`](https://testnet.bscscan.com/tx/0x2033e54bf171b150c6a5a1c2f156e548182f71edab47c0f5efb64f8d0df21fef) |
| Swap Deck / the give: a Common card paid 1,000 SDECK | [`0x3db592f39ea7965f2ae2c1e8468a01609553d0cc0c3900af000f8e6568018ab1`](https://testnet.bscscan.com/tx/0x3db592f39ea7965f2ae2c1e8468a01609553d0cc0c3900af000f8e6568018ab1) |
| Swap Deck / the completing buy: the launch into the pool | [`0xa0b01026f9584b02f02189ec768bea28a799f1797a0691a9ce0c22c182ff78d2`](https://testnet.bscscan.com/tx/0xa0b01026f9584b02f02189ec768bea28a799f1797a0691a9ce0c22c182ff78d2) |

</details>

<details><summary><b>The corrected Flap set: the rules factories in BNB, with their two beacons</b> (6 entries, from <code>bounties/flap/deployments/97-v2-rules-native.json</code>)</summary>

| What | On the explorer |
|---|---|
| beacon | [`0x744A0F81Ff3e9e866B05B80Da74AE168512dD88F`](https://testnet.bscscan.com/address/0x744A0F81Ff3e9e866B05B80Da74AE168512dD88F) |
| launcherFactory | [`0xa0c6D7be020eD3699508745A4dbAC1A8a1B415C2`](https://testnet.bscscan.com/address/0xa0c6D7be020eD3699508745A4dbAC1A8a1B415C2) |
| pileBeacon | [`0xfE118ff8ca2B43dDDa3aE9dfce1a529DCD5796eB`](https://testnet.bscscan.com/address/0xfE118ff8ca2B43dDDa3aE9dfce1a529DCD5796eB) |
| portal | [`0x000042108465206185A077Edc3F3fd2b49060000`](https://testnet.bscscan.com/address/0x000042108465206185A077Edc3F3fd2b49060000) |
| router | [`0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3`](https://testnet.bscscan.com/address/0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3) |
| rulesVaultFactory | [`0x8C130C16A099e19B809FE726Cd0590CDD4B9F0D1`](https://testnet.bscscan.com/address/0x8C130C16A099e19B809FE726Cd0590CDD4B9F0D1) |

</details>

<details><summary><b>The corrected Flap set: the rules factories in Flap's test USDT, with their two beacons</b> (7 entries, from <code>bounties/flap/deployments/97-v2-rules-usdt.json</code>)</summary>

| What | On the explorer |
|---|---|
| beacon | [`0x9b7c9ac2eDffed18Cf5204DfdE8285A70efD28f4`](https://testnet.bscscan.com/address/0x9b7c9ac2eDffed18Cf5204DfdE8285A70efD28f4) |
| launcherFactory | [`0x61873aD21f3E471910C976ef7993ED40b399eeC0`](https://testnet.bscscan.com/address/0x61873aD21f3E471910C976ef7993ED40b399eeC0) |
| pileBeacon | [`0xEC1f793Da1FdFAB58D67f045a04B252e5Af1bBE8`](https://testnet.bscscan.com/address/0xEC1f793Da1FdFAB58D67f045a04B252e5Af1bBE8) |
| portal | [`0x000042108465206185A077Edc3F3fd2b49060000`](https://testnet.bscscan.com/address/0x000042108465206185A077Edc3F3fd2b49060000) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| router | [`0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3`](https://testnet.bscscan.com/address/0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3) |
| rulesVaultFactory | [`0x73aBa498C5415bb587E8f249314c619a5C3a55a2`](https://testnet.bscscan.com/address/0x73aBa498C5415bb587E8f249314c619a5C3a55a2) |

</details>

<details><summary><b>The corrected Flap set: the plain launcher factory and pile vault factory in BNB</b> (5 entries, from <code>bounties/flap/deployments/97-v2.json</code>)</summary>

| What | On the explorer |
|---|---|
| curveLauncherFactory | [`0xB577CDf809B68f22Ea87437C84e2415B5cCE1BC7`](https://testnet.bscscan.com/address/0xB577CDf809B68f22Ea87437C84e2415B5cCE1BC7) |
| curveLauncherImplementation | [`0x4AE2503C9745602182C0EC69457BcA4D98EA83AE`](https://testnet.bscscan.com/address/0x4AE2503C9745602182C0EC69457BcA4D98EA83AE) |
| pileVaultFactory | [`0x06871dC0A75bA96282A59021e66D894A6637FeF3`](https://testnet.bscscan.com/address/0x06871dC0A75bA96282A59021e66D894A6637FeF3) |
| portal | [`0x000042108465206185A077Edc3F3fd2b49060000`](https://testnet.bscscan.com/address/0x000042108465206185A077Edc3F3fd2b49060000) |
| tokenImpl | [`0x7777c57ff7dc441c1715b2e36fa581c48B782222`](https://testnet.bscscan.com/address/0x7777c57ff7dc441c1715b2e36fa581c48B782222) |

</details>

<details><summary><b>The corrected Flap set: the plain factories for Flap's test USDT</b> (6 entries, from <code>bounties/flap/deployments/97-v2-usdt.json</code>)</summary>

| What | On the explorer |
|---|---|
| portal | [`0x000042108465206185A077Edc3F3fd2b49060000`](https://testnet.bscscan.com/address/0x000042108465206185A077Edc3F3fd2b49060000) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| tokenCurveLauncherFactory | [`0x83c86a911FdE0b0daF9b331d9358b7Dc326DD3dD`](https://testnet.bscscan.com/address/0x83c86a911FdE0b0daF9b331d9358b7Dc326DD3dD) |
| tokenCurveLauncherImplementation | [`0x83265c9B376d90f3A4a658D02Db036afdC3D1aB3`](https://testnet.bscscan.com/address/0x83265c9B376d90f3A4a658D02Db036afdC3D1aB3) |
| tokenImpl | [`0x7777c57ff7dc441c1715b2e36fa581c48B782222`](https://testnet.bscscan.com/address/0x7777c57ff7dc441c1715b2e36fa581c48B782222) |
| tokenPileVaultFactory | [`0xE76819C5761ceFE8c7C90e6401b77E9066f59d34`](https://testnet.bscscan.com/address/0xE76819C5761ceFE8c7C90e6401b77E9066f59d34) |

</details>

<details><summary><b>The corrected Flap set: the stake factory</b> (1 entry, from <code>bounties/flap/deployments/97-v2-stake.json</code>)</summary>

| What | On the explorer |
|---|---|
| factory | [`0xDeC6ca89374bf47A5Fe6b347bfD1ab48d54e7450`](https://testnet.bscscan.com/address/0xDeC6ca89374bf47A5Fe6b347bfD1ab48d54e7450) |

</details>

<details><summary><b>The corrected Flap set: the card shop factory with the guarded refill, its two routers and the four card collections it accepts</b> (7 entries, from <code>bounties/core/deployments/97-v2-rail-shop.json</code>)</summary>

| What | On the explorer |
|---|---|
| collections / 1 | [`0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174`](https://testnet.bscscan.com/address/0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174) |
| collections / 2 | [`0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577`](https://testnet.bscscan.com/address/0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577) |
| collections / 3 | [`0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC`](https://testnet.bscscan.com/address/0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC) |
| collections / 4 | [`0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143`](https://testnet.bscscan.com/address/0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143) |
| factory | [`0xe49fD8d811C6e8779b94C8c58bE2bB1e60c51cd2`](https://testnet.bscscan.com/address/0xe49fD8d811C6e8779b94C8c58bE2bB1e60c51cd2) |
| routers / 1 (Flap's DEX router) | [`0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3`](https://testnet.bscscan.com/address/0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3) |
| routers / 2 (PancakeSwap's router) | [`0xD99D1c33F9fC3444f8101754aBC46c52416550D1`](https://testnet.bscscan.com/address/0xD99D1c33F9fC3444f8101754aBC46c52416550D1) |

</details>

<details><summary><b>The corrected Flap set: Proof Jar (PJAR), the proof sale on the BNB rules factories</b> (3 entries, from <code>bounties/flap/deployments/97-v2-rules-native-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0xeB9e112AA8e46fC1332Bc79c0F52EA2c5B1480eF`](https://testnet.bscscan.com/address/0xeB9e112AA8e46fC1332Bc79c0F52EA2c5B1480eF) |
| rulesVaultFactory | [`0x8C130C16A099e19B809FE726Cd0590CDD4B9F0D1`](https://testnet.bscscan.com/address/0x8C130C16A099e19B809FE726Cd0590CDD4B9F0D1) |
| token | [`0x6c3cf0DB5a825425cB13fDB0D35566dc75e37777`](https://testnet.bscscan.com/address/0x6c3cf0DB5a825425cB13fDB0D35566dc75e37777) |

</details>

<details><summary><b>The corrected Flap set: Proof Pile (PPILE), on the plain BNB factories</b> (2 entries, from <code>bounties/flap/deployments/97-v2-pile-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0xe1c1312A4e27722EA8ecab1a8C858Ff634DbeaD5`](https://testnet.bscscan.com/address/0xe1c1312A4e27722EA8ecab1a8C858Ff634DbeaD5) |
| token | [`0xd70b90722e39a073C6DFC927bDaa8BC7b1967777`](https://testnet.bscscan.com/address/0xd70b90722e39a073C6DFC927bDaa8BC7b1967777) |

</details>

<details><summary><b>The corrected Flap set: Proof Pile Dollar (PPUSD), on the plain test-USDT factories</b> (3 entries, from <code>bounties/flap/deployments/97-v2-usdt-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0x68f14EA7b1D2A23BD3B721C76Cc24A907Ea80D19`](https://testnet.bscscan.com/address/0x68f14EA7b1D2A23BD3B721C76Cc24A907Ea80D19) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| token | [`0x671C0ceA24b9C4dEC0E8FE6e9Cce5a91a0157777`](https://testnet.bscscan.com/address/0x671C0ceA24b9C4dEC0E8FE6e9Cce5a91a0157777) |

</details>

<details><summary><b>The corrected Flap set: Proof Jar Dollar (PJUSD), on the test-USDT rules factories</b> (4 entries, from <code>bounties/flap/deployments/97-v2-rules-usdt-sale.json</code>)</summary>

| What | On the explorer |
|---|---|
| launcher | [`0xFCd915957bef993fD7a7BFe180f502b98FEC58Ed`](https://testnet.bscscan.com/address/0xFCd915957bef993fD7a7BFe180f502b98FEC58Ed) |
| quote | [`0x190C989D5665a0e404B444b53CAE9AbCfb600157`](https://testnet.bscscan.com/address/0x190C989D5665a0e404B444b53CAE9AbCfb600157) |
| rulesVaultFactory | [`0x73aBa498C5415bb587E8f249314c619a5C3a55a2`](https://testnet.bscscan.com/address/0x73aBa498C5415bb587E8f249314c619a5C3a55a2) |
| token | [`0x9b98CA3e3a119Ab17E86f041c9a791AAf1d57777`](https://testnet.bscscan.com/address/0x9b98CA3e3a119Ab17E86f041c9a791AAf1d57777) |

</details>

<details><summary><b>The launches on OpenFour: the developer-owned copy, the pile's preset, the two templates, and three launches (the third, Snip, with the creator's rules)</b> (29 entries, from <code>bounties/openfour/deployments/97.json</code>)</summary>

| What | On the explorer |
|---|---|
| runWallet | [`0xd5D5633737f2fFd8E79E0AAf008795aB43215530`](https://testnet.bscscan.com/address/0xd5D5633737f2fFd8E79E0AAf008795aB43215530) |
| registry | [`0xB9820Ee9F400E3beD21495cf10aF6D39da1480c2`](https://testnet.bscscan.com/address/0xB9820Ee9F400E3beD21495cf10aF6D39da1480c2) |
| core | [`0xC7A76fEcec11e1F2290Eb60B0E14671e2FEb2f82`](https://testnet.bscscan.com/address/0xC7A76fEcec11e1F2290Eb60B0E14671e2FEb2f82) |
| tools | [`0xB96E1091A99a9b9AD35E570c0761438cBC4236eD`](https://testnet.bscscan.com/address/0xB96E1091A99a9b9AD35E570c0761438cBC4236eD) |
| feeRouter | [`0x3C659B8e331f6e800313B640F56d7857ca7D7F99`](https://testnet.bscscan.com/address/0x3C659B8e331f6e800313B640F56d7857ca7D7F99) |
| wbnb | [`0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd`](https://testnet.bscscan.com/address/0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd) |
| taxTemplate | [`0x9A665580052C37A235Fb3Bf914319BCD4C386036`](https://testnet.bscscan.com/address/0x9A665580052C37A235Fb3Bf914319BCD4C386036) |
| rulesTemplate | [`0x0B41E31f8D98796fE1DB09fB8d3c4B26aCe4502A`](https://testnet.bscscan.com/address/0x0B41E31f8D98796fE1DB09fB8d3c4B26aCe4502A) |
| tradeModuleImplementation | [`0xB2e3C6C68b76B1cBc39311eF03433abC33558fBA`](https://testnet.bscscan.com/address/0xB2e3C6C68b76B1cBc39311eF03433abC33558fBA) |
| presetValidator | [`0x45522cEf5F67c2eFA8FE295C348fE2626FAf0B9e`](https://testnet.bscscan.com/address/0x45522cEf5F67c2eFA8FE295C348fE2626FAf0B9e) |
| quotes / 2 | [`0x860822580d4EB2529DE0C74c3E2B1D6D7C183302`](https://testnet.bscscan.com/address/0x860822580d4EB2529DE0C74c3E2B1D6D7C183302) |
| tokens / 1 / token | [`0x64019AEA4e0322Dc6cd4e314315Cf08385C23AfC`](https://testnet.bscscan.com/address/0x64019AEA4e0322Dc6cd4e314315Cf08385C23AfC) |
| tokens / 1 / pile | [`0x4586b51076B99e0480bB8144B28087571358aDe0`](https://testnet.bscscan.com/address/0x4586b51076B99e0480bB8144B28087571358aDe0) |
| tokens / 1 / tradeModule | [`0xEa589785d6db4F1b278BDB5fd5e08a01Cbe43694`](https://testnet.bscscan.com/address/0xEa589785d6db4F1b278BDB5fd5e08a01Cbe43694) |
| tokens / 1 / vault | [`0xB84e222cC3f82Ee60e40F2b721b2637BE0Ceda7B`](https://testnet.bscscan.com/address/0xB84e222cC3f82Ee60e40F2b721b2637BE0Ceda7B) |
| tokens / 1 / createTx | [`0x88ea4f8fa43b5fc2681b1f6b631000a88cc430acc5bfe1de6ab8e3a2a0378b68`](https://testnet.bscscan.com/tx/0x88ea4f8fa43b5fc2681b1f6b631000a88cc430acc5bfe1de6ab8e3a2a0378b68) |
| tokens / 2 / token | [`0x00C80DFaC0465F10E9a8D3eFB9cEf8750a733835`](https://testnet.bscscan.com/address/0x00C80DFaC0465F10E9a8D3eFB9cEf8750a733835) |
| tokens / 2 / pile | [`0x80E4A7FDD8bd8ADf02F41aB458f41806dB67DD73`](https://testnet.bscscan.com/address/0x80E4A7FDD8bd8ADf02F41aB458f41806dB67DD73) |
| tokens / 2 / taxVaultClone | [`0x492C16Bf3Ee5092647811f2EC4aD4c494116Bfb7`](https://testnet.bscscan.com/address/0x492C16Bf3Ee5092647811f2EC4aD4c494116Bfb7) |
| tokens / 2 / forwardVault | [`0x257A9613Ac2BAF4dE3471341B5EFa6066D492Cf0`](https://testnet.bscscan.com/address/0x257A9613Ac2BAF4dE3471341B5EFa6066D492Cf0) |
| tokens / 2 / vault | [`0x084c71E87f7334ECdd91AfA58eE3B4c2e4e84f09`](https://testnet.bscscan.com/address/0x084c71E87f7334ECdd91AfA58eE3B4c2e4e84f09) |
| tokens / 2 / createTx | [`0xb8dd0aac82cc749b32e3cecb2cde4bc9beaa4892ea675bca60d94c7018565a6f`](https://testnet.bscscan.com/tx/0xb8dd0aac82cc749b32e3cecb2cde4bc9beaa4892ea675bca60d94c7018565a6f) |
| tokens / 3 / token | [`0xdc787179a96bC8A826F5D5b618B6361c90e4215A`](https://testnet.bscscan.com/address/0xdc787179a96bC8A826F5D5b618B6361c90e4215A) |
| tokens / 3 / splitter | [`0x422805D2135A99302728D3201a2c33b2303f79F1`](https://testnet.bscscan.com/address/0x422805D2135A99302728D3201a2c33b2303f79F1) |
| tokens / 3 / pile | [`0x7d167fba8b90f4823097CBcF3d65A56922B39B01`](https://testnet.bscscan.com/address/0x7d167fba8b90f4823097CBcF3d65A56922B39B01) |
| tokens / 3 / taxVaultClone | [`0x2dEBd754FDE1Eab70EB8447377BaC058e795d074`](https://testnet.bscscan.com/address/0x2dEBd754FDE1Eab70EB8447377BaC058e795d074) |
| tokens / 3 / forwardVault | [`0x61C2cA08910a3F14ef59B40960aeF27D2aE01cA3`](https://testnet.bscscan.com/address/0x61C2cA08910a3F14ef59B40960aeF27D2aE01cA3) |
| tokens / 3 / vault | [`0xF99DC4Da8F806F58431CB6218f662772F30172c3`](https://testnet.bscscan.com/address/0xF99DC4Da8F806F58431CB6218f662772F30172c3) |
| tokens / 3 / createTx | [`0x2620e1b10308d01fe4a30c44766fa598ef98549bdbfea420367ef493f1a43680`](https://testnet.bscscan.com/tx/0x2620e1b10308d01fe4a30c44766fa598ef98549bdbfea420367ef493f1a43680) |

</details>

<!-- live:end -->

## Run it yourself

Four levels; each says what it needs, how long it took on a 32-core Linux machine with 62 GB of memory, and the line
that shows it worked. Commands run from the top folder of this repository unless a step says otherwise.

What every level needs: Linux or macOS, git, **Node 24.22.1** and **pnpm 10.29.1** (`corepack enable` then
`corepack prepare pnpm@10.29.1 --activate`, or `npm install --global pnpm@10.29.1`). Levels 2 to 4 also need
**Foundry 1.8.3** (`forge`, `anvil`, `cast`; https://getfoundry.sh), `jq` and `curl`.

Once, before any level (about 2 minutes; about 1 GB of packages and 210 MB of libraries):

```sh
pnpm install --frozen-lockfile
bash hackathon/public/fetch-libraries.sh   # the pinned contract libraries, from their public homes
```

`fetch-libraries.sh` ends with `fetch-libraries: all libraries at their pinned commits`.

### Level 1: the site on your computer, against the live test network (about 10 minutes)

Needs: the packages above; any browser.

```sh
bash hackathon/public/site.sh              # builds the test site (about 5 s), then serves http://127.0.0.1:5391/
```

It worked when the terminal says `site: built; serving http://127.0.0.1:5391/` and the page opens with **"Before
you enter the test site"** and, after you accept, the boxes of chain 97. The site you built reads the test network
through the live site's index (`SH_SITE_INDEXER=<https origin>` points it at another one). Stop it with Ctrl-C.

### Level 2: everything on your computer (about 6 minutes)

Needs: Foundry, `jq`, `curl`; 4 GB of free memory; about 1 GB of disk besides the packages. Nothing is sent to any
network; the chains are local.

```sh
bash hackathon/public/up.sh
```

What it does, step by step (each prints its result and the script stops at the first failure):

1. compiles only the contracts the deployment driver needs (about 40 s; not the full contract build);
2. runs the deployment driver on a local chain with chain id 97 (`anvil`, port 8573): the release, the test coins,
   the price listings, the pools, the converter routes and the faucet, step by step, each receipt read back
   (`packages/contracts/script/bnb/bnb-testnet.mjs`, the same driver that deployed the live contracts; about 1.5
   minutes);
3. creates the three demo boxes from their settings through the site's own launch code, each on a local chain
   started from that deployment (port 8575), reads each back field by field and lives it to its payouts
   (`packages/chain/scripts/bnb-boxes/local.mjs`). Rent Free first builds its 500 houses (about 2.5 minutes,
   3.2 GB of memory); the three boxes together take about 3.5 minutes.

It worked when it ends with `up: GREEN: the platform deployed on a local chain 97, three demo boxes created and
lived` (5.6 minutes on our machine, at most 3.2 GB of memory). Each box's line reads `life GREEN: ...` with the
amounts paid, to the last unit.

The services (the index with its database, the keeper, and the site in front of them) run as one stack in Docker,
exactly as on the live server, following the live test network: `hackathon/stack/` and its runbook **(to come)**.
The keeper there runs dry (it names what it would send); a keeper started alone, outside the stack, stops at its
start check, because it needs the approved release files the stack gives it.

### Level 3: the two launch rails on a fork of the test network, and the launch page (about 12 minutes)

Needs: Foundry; Node and npm (these three folders have their own lockfiles). The forks read the public test network
endpoint and send nothing to it.

```sh
cd bounties/flap
forge test --no-match-path "test/*.fork.t.sol"   # both launchers (BNB and token quote), no chain
(cd ../core && forge test)                       # what both rails share: the pile, the rules, the card shop, the stake
bash script/fork-test.sh                         # on a fork (anvil, port 8578), against Flap's real Portal
bash script/rehearse.sh                          # the BNB launch's whole real path on a fork, gas of every transaction
bash script/rehearse-usdt.sh                     # the same for the launch in Flap's test USDT

cd ../openfour
npm install                                      # also fetches the OpenFour kit at its pinned commit
npx hardhat compile
bash scripts/test-local.sh                       # on a fork (anvil, port 8580)
npm run test:signer                              # the creation signer, no chain
bash scripts/rehearse-local.sh                   # the real run's steps on a fork (port 8579), signed by a throwaway key

cd ../app                                        # the launch page
npm ci
npm test                                         # the launch page's unit tests
PILE_BASE=/launches/ npm run build               # dist/: the page the site serves at /launches/
```

It worked when each `forge test` ends with `0 failed`; `fork-test.sh` prints `done exit=0`; both Flap rehearsals end
with a `TOTAL gas:` line (the USDT one also with the test USDT it spent); `test-local.sh` ends with `passing` and
no `failing` line; `test:signer` ends with `fail 0`; `rehearse-local.sh` ends with `== rehearsal done`. The launch page's browser
tests on forks are in `bounties/app/README.md` (`bounties/app/scripts/flap-fork.sh`, `bounties/app/scripts/four-fork.sh`).

### Level 4: the tests

| Suite | Command | Time on our machine | Memory |
|---|---|---|---|
| The site, the services and the packages (vitest: 922 files, 17,516 tests; 65 files fail without the full contract build, 15 of them pass once it exists; each is listed with its reason) | `SH_TEST_TIMEOUT=60000 VITEST_MAX_WORKERS=10 pnpm test` | 8 minutes | 3.6 GB |
| The launch rails and their shared pile (Foundry, mocha, vitest) | level 3 above | 12 minutes | under 1 GB |
| The chain-97 deployment and the demo boxes | level 2 above (`up.sh`) | 6 minutes | 3.2 GB |
| The full contract build, then the chain-97 contract tests (ends with `0 failed`) | `cd packages/contracts && forge build && forge test --match-path "test/bnb/*"` | the build: 34 to 36 minutes; the tests: 3 s | the build: 28 to 31 GB |
| All release contract tests | `cd packages/contracts && forge test` (after the build) | not measured here | |

**The full contract build** compiles about 1,150 to 1,400 contract files (with their tests) and needs 28 to 31 GB
of memory; on a computer with 16 GB it does not finish. Levels 1 to 3 do not need it: level 2 compiles only the
contracts the deployment needs (about 40 s), and the launch rails are small projects of their own.

**What fails, and why.** Without the full build, `pnpm test` ends with 65 failed files whose reasons are outside
the code: 44 read the platform's internal notes, which are not in this repository, 15 compare generated files
with the compiled contracts of the full build and pass once it exists, and 6 measure pictures that this copy holds
as grey placeholders. Each is listed with its reason in
[`hackathon/public/known-failures.md`](hackathon/public/known-failures.md). `SH_TEST_TIMEOUT=60000` gives long
tests 60 seconds: with the default of 5 seconds six more timed out on our machine (measured on 27 November 2026).

**`pnpm check:production`** checks the platform's main-network build, not this entry's test site (that is level
1). It ends with `check:production: FAILED, 60 findings … (placeholder 56, demo 4)`: the main network's legal texts
still hold their placeholders for counsel, and the word "demo" appears in the identifiers of this network's demo
box list (`apps/web/src/features/examples/`), which the main-network build also carries.

#### Not part of this copy's tests

Pictures of an earlier collection of the platform are not public yet. In this copy they are grey pictures of the
same name, format and size, and that collection's own sources and tools are left out. A few kept files still carry
the real pictures' digests, so the checks that compare them with the pictures cannot pass here and are not part of
this copy's tests. They are listed in [`hackathon/public/not-tested.md`](hackathon/public/not-tested.md), with the
six test files that measure the pictures themselves and fail on the placeholders.

## What was built at the event

The platform itself existed before the event, on Ethereum's Sepolia test network. Everything below was built during
the event:

- the BNB Chain build of the site (one setting switches the whole app and its services to chain 97);
- the deployment on chain 97: the release, five test coins, six price listings, seven pools, three converter routes
  and a faucet coin, sent in eight restartable steps and read back from the chain;
- eight boxes on chain 97, as the Boxes list shows them: the five demo boxes (GPU Poor, Rent Free, The Alchemist, Pile
  Party, Pile Furnace), created through the site's own launch code and lived to their payouts; the Card Shop; Quick
  Deck on the second release; and Judge Walk 14293, the box our walk check launched from the Visual form on 26
  November at 01:35 +07 from a fresh wallet (0xF323…6e13): priced in BNB, a raise of 0.00185 BNB, a deadline of 26
  December, not graduated;
- the card shop: four card collections and the box that sells them;
- the two launch rails with their contracts (`bounties/flap`, `bounties/openfour`, the shared pile in
  `bounties/core`): two launches through Flap's Portal (one in BNB, one in Flap's test USDT, from its own pair of
  factories), two on OpenFour, the creation signer that lets a visitor create an OpenFour launch with their own
  wallet (`bounties/openfour/sign/`), and the launch page served inside the site at `/launches/`;
- the creator's rules on a token of Flap or Four.meme: one splitter both rails share (`bounties/core`), Flap's rules
  vault factory with two launcher factories (BNB and the test dollar), the OpenFour copy's rules tax vault; three
  launches with rules on Flap, one on OpenFour;
- holders paid by staking a token of Flap or Four.meme: the stake factory, and the holders panel on a launch's page;
- a card shop for a token of Flap or Four.meme: the shop factory, a launch whose rules feed a shop, and the shop page;
- launches on Flap and Four.meme as cards among the boxes, with a picture added in the launch form and stored on
  Arweave;
- My Box: what a wallet holds across the boxes;
- "What happens" on the Flap and Four.meme launch forms (where the money of 100 trades goes) and the form's picture
  with its real numbers on every launched token's page (`bounties/app/src/picture/`);
- the Examples page in a BNB version: three slides re-lettered, the words changed, laid over the page at build time;
- the price data from Atlas (dollar values, the one-dollar raise, the keeper's rule).

## Limits, plainly

- **Known gaps on the live site:**
  - on a network many people share, the public endpoint can refuse a read; the site tries such a read again by
    itself (three more times within about three seconds); if it is still refused, a press ends with "The chain
    could not be read. Try again." and a second press works;
  - the public endpoint the pages read first keeps only recent events: since 26 November it answers an older block
    range with an empty list. The lists therefore name the launches made so far in a file
    (`bounties/app/public/addresses.json`), and the launch pages, a box's card shop and a wallet's cards read their
    events from BNB Chain's own endpoint, 5,000 blocks per request. When that endpoint does not answer, a launch
    page shows what the public endpoint still returns, until it is opened again;
  - the box list shows "0 items" for the card shop: it counts a box's own collection, and the shop's cards are
    existing ones;
  - the card shop's sell-backs open on 2 December; picks work now;
  - a launch's picture shows on this site only: Flap's own site reads only metadata uploaded through Flap's own
    service; the first two launches on Flap and the first two on OpenFour have no picture.
- **Test network only.** Nothing here holds money of value; no main network is used.
- **No token.** Square Hole has no token of its own. Every coin on the site is a test coin of a box or of a launch.
- **No external audit.** The code was reviewed by AI models only.
- **The site runs the first Flap deployment.** The five Flap launches on the launch pages were made on our first
  factories, which Flap's pre-audit read; the findings above are corrected only in the second set. On the first
  deployment nobody can change a sale's parts. On the corrected factories, once the sale exists, only Flap's Guardian
  can change its vault code; the creator and we cannot.
- **Where the corrected Flap contracts are.** The contracts at the top of this repository (`bounties/flap`,
  `bounties/core`) are the first deployment's, which the live pages read. The corrected ones are in
  `hackathon/flap-corrected/`: the archive for Flap's re-review, with its cover (`README.txt`: what changed by
  finding, how to build and test, the corrected set's addresses and the four sales), built and tested from inside that
  folder as `README.txt` says (150 passed and 1 skipped; 67 passed; 29 passed on the test-network fork; 14 of 14 on
  the main-network fork).
- **Our OpenFour copy.** Four.meme's official test Registry is written by Four.meme only, so the OpenFour launches
  run on a copy brought up with their kit: we own its Registry and hold its creation signer. The kit's own contracts
  were not reviewed by us. At migration the copy burns the pool's tokens (1,000 units to the zero address, the rest
  to the dead address); the Registry's owner (on this copy, our own run wallet) can change that only for migrations still to come, which includes tokens already created but not yet migrated.
  Only a key of ours can sign a creation on this copy (the site's signing service), and the Registry's owner can
  upgrade OpenFour's module contracts, which could change a module's code for tokens already created; it
  cannot change a pile, a rules splitter or a rules tax vault, which are plain contracts without an owner.
- **The creator's rules** (Flap and Four.meme). The parts are fixed before the sale on Flap and at the token's
  creation on the OpenFour copy, and never change; nothing shares the income by itself: anyone can call the
  share-out, and a part that cannot be paid stays owed. The buy and burn comes last, needs the token's pool (Flap's
  DEX on Flap, PancakeSwap on the OpenFour copy) and has no minimum output (on a main network a sandwich could take
  from it); on the OpenFour copy it waits for the token's move to PancakeSwap, for good if it never moves.
- **The card shop on their token.** Anyone can open shops for any token, so a page shows only the shop a launch's
  rule names or one whose creator is the launch's creator. In each seven days, gives net of picks never pay out more
  than the cap (the seven days count from the shop's creation; the last card stays); our four test card collections
  belong to our own deploy wallet, which can mint without limit and so draw on any shop's budget up to the cap, net
  of picks. A refill has no minimum output; a token that taxes plain transfers stops gives and picks.
- **Staking.** A lone first staker after a pause collects the waiting stream per second while alone, never at once;
  the token itself can freeze stakes; a stake counts only when it is the one the launch's rule names. A token that
  taxes plain transfers is supported (credited by what arrives, it delivers less on the way out); a token or income
  coin that takes more than a transfer names, or reports success without moving anything, can leave the last
  unstakers or claims short; a remainder below one increment can wait until the next income.
- **Flap's minimum.** Flap's test-network helper lets anyone set how much of Flap's minimum applies to the sales a
  launcher factory creates through Flap's Portal; for all four of our launcher factories it is zero today. Anyone can
  put it back: a small sale then cannot launch while the minimum stays above it, launches once it is lowered again,
  and unwinds only if its deadline passes first.
- **Not built:** a pile of a stock on a token of Flap or Four.meme; their piles hold the coin the launch was sold in.
- **Fetched, not ours** (each keeps its own licence):
  - the OpenFour kit and its closed core: fetched by `npm install` in `bounties/openfour` from Four.meme's public
    repository at a pinned commit; nothing of it is in this repository;
  - Flap's Portal: Flap's contract on the test network; its interfaces come from
    https://github.com/flap-sh/FlapPoolLaunchVaultExample;
  - PancakeSwap's router: PancakeSwap's contract on the test network;
  - Uniswap v4's core and periphery: https://github.com/Uniswap/v4-core, https://github.com/Uniswap/v4-periphery;
  - OpenZeppelin's contracts: inside Uniswap v4's own libraries;
  - forge-std: https://github.com/foundry-rs/forge-std; DN404: https://github.com/Vectorized/dn404.
  The pinned commits are in `hackathon/public/libraries.txt`; `bash hackathon/public/fetch-libraries.sh` fetches
  them. Each page of the site serves the notices of the third-party code it ships, in `third-party-notices.txt` at
  its own root.

## Rights

(c) 2026 Square Hole. All rights reserved. Published for the judging of the hackathon.
