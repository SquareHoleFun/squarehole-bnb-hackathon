# A card shop for a token launched on Flap or Four.meme (`RailShop`)

A box dimension for their launchpads: a token launched there gets a shop of trading cards that trades in THAT token.
Hand in a card and receive its give price in the token; pick a card and pay its pick price in the token. The shop's
budget is fed by the token's own trading tax (on Flap, through the token's rules) or by hand.

- [`src/RailShop.sol`](src/RailShop.sol), [`src/IRailShop.sol`](src/IRailShop.sol): the shop. A token can have
  any number of shops, created by anyone.
- [`src/RailShopFactory.sol`](src/RailShopFactory.sol): creates shops and lists them per token (`shopOf`, an open list
  anyone can lengthen) and per token and creator (`shopOfBy`). A page shows only shops it made, and of those the shop a
  launch's rule names, otherwise only one whose `creator()` is the launch's creator as read from the rail's own
  contracts.
- ABIs: [`abi/RailShop.json`](abi/RailShop.json), [`abi/RailShopFactory.json`](abi/RailShopFactory.json)
  (`script/export-abi.sh`).
- Tests: [`test/RailShop.t.sol`](test/RailShop.t.sol) (unit), [`../flap/test/RailShop.fork.t.sol`](../flap/test/RailShop.fork.t.sol)
  (Flap, on a fork), [`test/RailShopOpenFour.fork.t.sol`](test/RailShopOpenFour.fork.t.sol) (our OpenFour copy, on a fork).

## What it does

- **Fixed at creation, no owner.** One token; one asset its income arrives in (the native coin or one ERC-20); one
  router (a PancakeSwap V2 router) to buy the token with that income; up to four card collections, each with a give
  price in the token; one pick surcharge for all (a pick costs the give price plus that part, rounded up; the part is
  at most 50,000 bps, so a pick price is at most six times the give price); one cap on gives (at most 2^128 - 1). Nothing changes afterwards: no setter, no sweep, no upgrade.
- **Give**: the holder of a card of a listed collection hands it in and is paid its give price from the shop's budget.
  Refused when the budget or the cap cannot pay it in full.
- **Pick**: anyone pays a card's pick price and receives the card. What was paid stays as budget. The last listed
  card stays (counted across all collections; a card moved out by its collection counts until it is dropped).
- **Stock**: anyone hands in cards of a listed collection for nothing (the starter cards). `Stocked.from` is the
  caller who listed the card, not necessarily who sent it.
- **Refill**: anyone turns an amount of the asset that has arrived into the token on the router; the tokens stay in
  the shop, the rest of the asset keeps waiting. No minimum output. `Refilled` reports the measured debit of the asset
  (what `waiting()` fell by), which is less than the amount asked when the router draws less.
- **Drop**: anyone removes a listed card the shop no longer owns (it left by its collection's own doing), only on a
  definite answer: `ownerOf` succeeds with one word naming another, nonzero owner. A card whose `ownerOf` reverts
  stays listed.
- **The cap**: each seven-day period counted from the shop's creation has a room that starts at the cap. A give needs
  its price within the room and takes it; a pick adds the card's give price, in either order. So in every period the
  give prices of gives minus the give prices of picks never exceed the cap, and as a pick costs at least its give
  price, the tokens that leave through gives, net of what picks bring in, never exceed it either. `capLeft()` is the
  room; it can exceed the cap after picks.
- **The factory** puts a shop at an address that commits to every creation parameter, so a launch's rules can name a
  shop before the token exists and that address fixes what the shop will be. It accepts only the routers and card
  collections it was constructed with: on chain 97, Flap's DEX router, PancakeSwap's router and our four test card
  collections. A shop's creator cannot bring a router or a collection of its own; someone who wants others deploys
  another factory, and the site shows only ours.

## What is not in it, on purpose

Tiers, a curator, collections added later, a per-collection budget, any check of a card's worth. The creator chooses
the collections from those the factory accepts; a shop is only as good as that choice.

## Stated limits

- A shop is as honest as its token AND its collections: the token's own balance answers settle every trade, and the
  collections' own `ownerOf` answers decide which cards the shop holds. The budget and the room are shared, so a
  collection that lied about its owners could draw gives from everyone's budget up to the period's room. Our factory
  accepts only our four test collections, and their owner is our deploy wallet, which can mint without limit: that
  wallet can draw on every shop's budget up to its room each period.
- A token that taxes or blocks plain transfers stops gives and picks while it prevents exact settlement: there is no
  other exit for the cards and tokens inside. (Flap's tax token and both tokens of our OpenFour copy move plain
  transfers untaxed: measured on the forks.)
- The refill has no minimum output: whoever calls it chooses the moment and the amount, so the price. On a main
  network a caller could sandwich a refill. Without a pool of asset and token a refill reverts and the asset waits.
- No stock and no refill before the token has code (payments that arrive wait).
- A receiver of a pick must be able to hold cards (a plain transfer, no hook). A safe transfer of a card straight to
  the shop reverts; a safe transfer to the shop's address BEFORE the shop exists succeeds, and a plain transfer at any
  time pays nothing: such a card waits for anyone's `stock`. Cards of unlisted collections and coins other than the
  token and the asset sent to the shop have no way out. A pick or a drop reorders the list.
- Prices are not checked against the token's supply on chain (the token may not exist yet): the scripts refuse a give
  price, a pick price or a cap above the supply, as a shop priced above the supply takes stock nobody can ever pick.
- Views are not guarded during a call. `budget()` and `waiting()` call the token and the asset, so a bad token or
  asset can use up a view call's gas; no view calls a collection.

## On the two rails

**Flap.** A token's address is known before its sale (from the sale's salt), so the shop is created first and the
rules name it as a second CREATOR rule (for example creator 10%, pile 30%, the shop 40%, buy and burn 20%). Flap's
rules factory takes at most four rules, at most one pile and one buy and burn, and the buy and burn only as the LAST
rule. So these fit: creator, pile, shop, buy and burn; creator, shop, buy and burn; pile, shop, buy and burn; and,
with lane f's holders rule (a CREATOR rule paying the holders' stake), creator or pile, then shop, holders, buy and
burn. A shop together with creator, pile, holders AND buy and burn would be five rules and does not fit. The rules
vault pays the shop its part of the tax as a plain payment of the test dollar; anyone refills. Proven on a fork of the
BNB test network on lane f's stand: the share-out paid the shop exactly 10.272351363161514152 (its 40%, rounded down; the buy and burn, last, takes the remainder) of 25.680878407903785381
test dollars; the refill bought 2,477,157 tokens; the holder of our real test cards gave a Legendary for exactly 800
tokens; a buyer from the sale picked a Common for exactly 200.

**Four.meme (our OpenFour copy).** The tax rules there pay the creator's part to the requester, so a shop is fed by
hand: a holder transfers tokens to it. Proven on a fork for both tokens of the copy (PTAX and PILE): the budget is
exactly what was sent, a give and a pick each move exactly their price.

*To feed a shop from the tax there* the rules need a second payee: lane g's `RulesTaxVault` takes
`(creator, creatorBps, pileBps, burnBps)` and the signing service fills `creator` with the requester. A template that
takes `(creator, creatorBps, pileBps, burnBps, shop, shopBps)` would hand the splitter a fourth rule (it takes four).
That needs a new template deployed and registered on the copy (its descriptors change), the service's `tax-rules`
request to carry `shop` and `shopBps`, and the service to sign only a shop of our factory made for that token. The
token's address must be known before the creation for the shop to exist then: the create arguments carry a
`tokenSalt`; whether the copy's Core deploys the token at an address it fixes is not checked here.

## The real run (commands; nothing here sends: the orchestrator signs)

Gas measured on forks of the BNB test network (`script/rehearse-shop.sh` in bounties/flap, which also proves the two
supply refusals, and the gas report of `test/RailShop.fork.t.sol`); cost at 0.1 gwei. Every `forge script` is a dry run without `--broadcast`; every
`cast send` has its dry run as `cast call` with `--from <wallet>`. `R=https://bsc-testnet-rpc.publicnode.com`.

| # | Step | Command | Wallet | Gas (cost) | Check after |
|---|---|---|---|---|---|
| 1 | The shop factory | `cd bounties/core && forge script script/DeployRailShopFactory.s.sol --rpc-url $R --sender <wallet> --account hack-deployer --password-file <dir>/hack-deployer.pass --broadcast --legacy --with-gas-price 100000000` | hack-deployer | 3,302,710 (0.000330 tBNB) | `deployments/97-rail-shop.json`; `cast call <factory> "acceptedCollections()(address[])"` lists the four |
| 2 | Flap's rules pair (lane f's step, once) | `cd bounties/flap && forge script script/DeployRules.s.sol ...` (lane f's runbook) | hack-deployer | 13,840,726 (0.00138) | `deployments/97-rules-usdt.json` |
| 3 | A launch with a shop in its rules | `cd bounties/flap && RAIL_SHOP_FACTORY=<factory> forge script script/CreateShopRulesSale.s.sol --rpc-url $R --sender <creator> --account <creator> --password-file <dir>/<creator>.pass --broadcast --legacy --with-gas-price 100000000` (settings, in rule order: CREATOR_BPS, PILE_BPS, SHOP_BPS, BURN_BPS last; GIVE_COMMON to GIVE_LEGENDARY, PICK_BPS, CAP, NAME, SYMBOL; refuses a price or cap above the launch's fixed supply, with the reason) | the creator | 3,392,656 for its 3 transactions (0.000339) plus Flap's creation fee (the dry run reads it) | `deployments/97-shop-rules-usdt-sale.json`; `isShop(<shop>)` true; after the launch the rules vault's `rule(2)` is `(1, 4000, <shop>)` and `rule(3)` is the buy and burn (kind 3) |
| 4 | Buy, complete, claim (as lane f's sales) | `forge script script/TokenSale.s.sol` with `ACTION=buy`, `complete`, `claim` and `SALE_FILE=deployments/97-shop-rules-usdt-sale.json` | buyers | 289,759; 8,891,866; 183,198 | `launched()` true |
| 5 | A shop for an existing token (Four.meme, or any token) | `cd bounties/core && TOKEN=<token> forge script script/CreateRailShop.s.sol --rpc-url $R --sender <creator> --account <creator> --password-file <dir>/<creator>.pass --broadcast --legacy --with-gas-price 100000000` (settings: ASSET, ROUTER, GIVE_COMMON to GIVE_LEGENDARY, PICK_BPS, CAP; refuses a price or cap above the token's `totalSupply()`, with the reason) | the creator | 2,558,108 (0.000256) | `shopCountBy(<token>, <creator>)`, `shopOfBy(<token>, <creator>, i)`, `isShop` |
| 6 | Feed by hand (Four.meme) | `cast send <token> "transfer(address,uint256)" <shop> <amount> ...` | a token holder | one transfer | `cast call <shop> "budget()(uint256)"` grew by exactly the amount |
| 7 | Starter cards (after the token exists) | `cast send <collection> "setApprovalForAll(address,bool)" <shop> true ...`, then `cast send <shop> "stock(address,uint256[])" <collection> "[5,6]" ...` | the card holder 0xc979...f310F0 (holds ids 5 to 8; read on chain 97 for Common, and 5 and 7 of all four tiers on the forks) | 154,769 for one card, 256,222 for two | `cardCount()`, `holds(<collection>, <id>)` |
| 8 | Refill (anyone, after tax arrived) | `cast send <shop> "refill(uint256)" <amount at most waiting()> ...` | anyone | 253,498 | `budget()` grew, `waiting()` fell by the amount |
| 9 | Give and pick (the page, or `cast send`) | `give(<collection>, <id>, <minPaid>)` after approving the card; `pick(<collection>, <id>, <maxPrice>, <to>)` after approving the price | visitors | 337,111; 232,306 | balances moved by exactly the price |

**More test cards.** The four collections' owner, the deploy wallet (keystore hack-deployer), mints more:
`cast send <collection> "mint(address,uint256,uint8)" <to> <id> <picture>`, where the collection itself refuses any
picture but `(id - 1) mod 4 + 1`; ids 1 to 8 of every tier are taken, ids from 9 on are free. Nobody else can mint.
