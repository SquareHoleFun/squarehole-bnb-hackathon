# Card Shop

A shop for trading cards in four rarity tiers. The coin is CARD. Built for the BNB Chain test network (chain id 97).

![Three trading cards fanned out: green, gold and blue frames.](art/logo.png)

The creator loads sixteen test cards, four of each tier, and seeds the shop.
After graduation anyone picks a card for twice the sell-back price. Sell-backs open seven days after the box was
created: then any holder of a listed card can sell one back for its tier's price, within weekly limits. The list is
fixed: no curator, no new collections. The last card stays.
Fees fill the shop up to a ceiling, then go to holders.

| Setting | Value |
|---|---|
| Collections | four test card collections, one per tier: Common (tier 0), Uncommon (1), Rare (2), Legendary (3); ids 1 to 4 each |
| Sell-back (give) | Common 1,000,000 CARD; Uncommon 2,000,000; Rare 4,000,000; Legendary 8,000,000 |
| Pick | 2x the tier's sell-back |
| Seed | 180,000,000 CARD |
| Sell-backs a week | 10% of the week's budget in all, 5% per collection, and never less than one cheapest sell-back. At the starting seed (180,000,000) one sell-back of each tier fits a week; a second Rare that week does not |
| Starts taking sell-backs | 7 days after Create, and after graduation; picks work from graduation |
| Curator | none |
| Buyers' fees | to holders |
| Sellers' fees | into the shop up to twice the seed, then to holders |
| Price coin | the test dollar (tUSDC) |
| Creator | a Safe in the kit's policy; on the test network the deploy wallet |

Both fee choices are built into the release (holders, Into the shop): they work the moment the release stands. Neither
needs a fee-module directory entry.

This is a test network setup. It is not a live shop or a promise of payment.

## What it shows, and what it does not

A shop as built has four prices, fixed at Create, one per tier; every card of a collection has its tier's price. So
this shop prices by rarity, not per card. Real graded cards would need a price source per card and a new shop module,
which is not built.

## The cards

[test-cards/](test-cards/) holds the sixteen pictures (500 x 700 PNG, own vector drawings with stroke lettering, no fonts),
their [catalog](test-cards/catalog.json) with each raw-block CID and SHA-256, and one
[contact sheet](test-cards/contact-sheet.png) of all sixteen. The collection contract is
`packages/contracts/src/test-coins/TestTradingCards.sol` (one deployment per tier, owner-minted, no seizure, metadata
setter, burn or upgrade; chain ids 97, Sepolia and the local chain only); its digests are generated into
`TestTradingCardsCatalog.sol`. A card's `tokenURI` embeds its JSON; `imageURI` is `ipfs://<raw picture CID>`. Token
id n shows picture (n - 1) mod 4 + 1: ids 1 to 4 are the four cards of a tier, ids 5 to 8 their second editions.

On the BNB Chain test network the stock step (`packages/contracts/script/bnb/CardShopStock.s.sol`) is run once; its
addresses are then read from the deployment file `packages/contracts/deployments/bnb-testnet/97-cards.json`, never
looked for again. Its recovery after a stop looks back over the deploy wallet's last 256 creations only.

From the repository root, Node 24.22.1:

```sh
node examples/boxes/card-shop/test-cards/build-art.mjs --check   # without --check it rebuilds the pictures, sheet, logo and catalog
node examples/boxes/card-shop/test-cards/export-car.mjs .cache/card-cars
node scripts/kits/settings.mjs card-shop
node --test examples/boxes/card-shop/test-cards/art.test.mjs
```

`settings/card-shop-boxspec-v2.json` is the Create download of the unbound kit (owner, price coin and the four
collections are binding slots). The registry row is `packages/box-spec/examples/v2/card-shop.json`.
