# The format 2 draft (`squarehole.boxspec-draft/2`)

Start with [gm-coin.json](examples/gm-coin.json) or a [preset](presets). Write every field, including zero fields.
For a prepared example, [start from a kit](kits/README.md): select its app settings file in **Load settings**,
then choose the listing for its verified Sepolia price coin. This assistant draft is not that settings download.
Amounts are decimal strings in raw coin units, or `{ "decimal": "800" }` in whole coin units. Never round raw amounts
through a floating-point number. `FROM_LAUNCH_FLOW` stands in for art fingerprints and the connected wallet.

Payouts are claim-only: each owner claims its own funds. Owner claims have no minimum or tip.
Wallets, contracts and EIP-7702 owners use the same owner claim entry. The FIT and platform Safes claim their
own fee shares. Collection and protocol-step tips are separate from owner payouts.

- `network`: `demo` or `sepolia`. A saved listing snapshot refreshes the dated offline copy; live reads use the explicit integration seam below.
- `pricing`: a listed coin's symbol, address, `{ "listingId": 7 }`, or `{ "boxToken": "MUG" }` for a manually
  listed graduated box coin. There is one permanent listing per coin; no automatic box-token listing.
- `raise`: `LISTING` selects the listing's current raise. Every coin uses this rule. Each box stores its creation
  raise. When the lister changes it before Create, refresh the draft, quote, coordinator salt and hook salt.
- `gradLayout`: `FULL_RANGE`.
- `buyers` and `sellers`: both receive the pricing coin. Each uses `NoSplit`, one branch `a`, empty parameters except the holders or items setting below,
  and an omitted or entirely zero branch `b`. Choose independently on each side:

| Choice | `leg` | `dest` |
|---|---|---|
| Keep | `AsPaid` | `Creator` |
| Burn | `BuyT` | `Eat` |
| Eat the price coin (checked burn or permanent lock) | `AsPaid` | `Eat` |
| Grow | `AsPaid` | `Depth` |
| To holders in the box token | `BuyT` | `Holders` |
| To items in the box token | `BuyT` | `Items` |
| To holders in the price coin | `AsPaid` | `Holders` |
| To every own-collection item | `AsPaid` | `Items` |

`creatorFeeRecipient` is required exactly when a side keeps or royalties are on (the inbox's payee); otherwise it is zero.
For T holders, set `a.destParams` to `{ "currency": "T" }` with `BuyT`; for T items use `BuyT` and the same explicit inside policy. The 10/15 share waits as pending P until graduation, then capped own-pool buys credit T. Keep retains inside T, BuyBackBurn burns it, and owners claim T. With Depth, all held P goes to the pool at graduation. Live inside P goes to the pool before conversion; only outside P buys T. If all items return, unspent outside P also goes to the pool. Each purchase credits the then-outside items equally. T residue burns. Pending P joins the failure pot.

For P holders, set `a.destParams` to `{ "currency": "P" }`. Both sides pay the listed price coin; a stock-priced box pays that stock, with no conversion. Earned net batch credits never expire and remain separate from the failure claim. There is no creator cap. Reserved enum ids, conversions and plug-ins are refused.

Add-ons 1, 3, 4, 6, 7 and 8 are available where their box type allows them. Add-on 4's royalties use `FEE_HANDLING`
only: they reach the box's inbox and are booked like the buyers' fees. Add-on 10 is retired. `pickFeeBps` is 100, 500 or 2500 for a
collection and zero for token-only boxes, shops and piles. `preset` is off-chain provenance and does not change the spec hash.

Run `node scripts/check.mjs <file> --format 2`. The checker reports refusals and a draft hash; the launch flow fills
its placeholders and checks current on-chain listings before creation. Format 1 belongs to the genesis box and is
not a format 2 creation option.

## Shop draft

Use `boxType: "SHOP"`, zero collection/art fields, `n`, `firstId` and `pickFeeBps`, plus the empty-settings
`collection-list` add-on (7). `contentsParams` accepts the named `ShopConfigV2` object from
[junkyard-shop.json](examples/junkyard-shop.json), or its canonical ABI bytes. The checker reads the frozen
interface to encode the tuple, then calls the generated `validateBoxSpecV2` entry; it has no independent shop rules.
It reads the inline `ShopDestParams` struct, so the Junkyard sellers' recipe checks with the registry's fees as
they are; never change fees to make a draft pass. These drafts are for the skill; the app's Load settings files
use a separate reader.

- `seedT` and the four `givePricesT` are decimal strings in raw T (18 decimals), never P or JSON numbers.
- `pickBps`: 12500, 15000, 20000 or 30000 (1.25x, 1.5x, 2x or 3x, rounded up).
- `weeklyBps`: 500 or 1000; `collectionBps`: 100, 250 or 500. These are shop spending limits.
- `listDelay`: 604800, 1209600 or 2592000 seconds. `curator` is a public address or zero for a fixed list.
- `collections` and `tiers` are matching lists of unique collection addresses and tiers 0..3.

The Junkyard example retains 1000/250/604800, 2x picks, a 180 million TRASH seed and give tiers of
1/2/4/8 million TRASH. Buyers pay holders in P; sellers use BuyT/BudgetOrPile with a 2x ceiling.
Its five demo collection addresses stand in for the registry's five Test Junk collections, ids 1–2 each; the
[Sepolia kit](kits/junkyard.md) binds the real ones. A creator Safe supplies all ten starters and the seed.
Nonzero seed requires `starter-set` (8), even with `{ "setHash": "0x0", "count": 0 }`. For 10..10000 NFTs,
commit the ordered chain `h[i] = keccak256(abi.encode(collection, id, uint8(tier), h[i+1]))`, ending at zero.
Creation pulls no NFTs. The creator approves the shop and loads pages of 1..32; seed and the full set must be
ready before anyone completes. Chunks must also be ready. Failed-shop T stays quarantined for burn retries;
starter NFTs return only to the creator. No budget withdrawal is available. Sellers' Into the shop fees fill
the shop to its fixed ceiling, with excess paid to holders.

## Every-item draft

Use `NEW_COLLECTION`, `AsPaid -> Items`, `NoSplit` and
`a.destParams: { "insidePolicy": "Keep" }` (the explicit authoring default) or
`{ "insidePolicy": "BuyBackBurn" }` or `{ "insidePolicy": "Depth" }` (wire value 3). Choose each side separately. Missing settings, `None`, legacy mode/id
lists, outside collections, currency fields and holder filters fail; the parser never silently supplies a policy.
The canonical wire is one uint8 ABI word (1, 2 or 3), checked by the generated twin.

[Bag Holders](examples/bag-holders.json) uses Keep on both sides. Every own-collection item has weight one.
Money waits before graduation: Depth sends all held P to the box’s own pool; Keep creates equal base stashes; BuyBackBurn spends all that side’s held
money buying and burning the box coin. Failure before graduation sends the held money of every policy (Keep, BuyBackBurn and Depth) to the pot.
Live outside items and pending draws share net price-coin receipts. Inside shares become stashes under Keep or
buy-backs under BuyBackBurn, or pool depth under Depth. Depth uses the same pool bucket and action as Grow. Residue goes to depth. Transfers and returns preserve each item’s unclaimed credit;
only its current owner claims it, to a nonzero recipient other than the box's own vault. Item credits never expire;
a refused or paused payout preserves them for retry. Cancellation sends outside draw earnings to residue and restores the retained stash.
The pick-before-collect timing gap remains. These payouts carry no yield, APY or income promise.

## Coin pile draft

Use `PILE` with all TOKEN_ONLY collection/art fields zero/empty and no collection/shop add-ons.
`contentsParams: { "asset": "0x…", "seedAmount": "1000000000" }` encodes exactly
`PileParams(address asset,uint256 seedAmount)` is the unchanged 64-byte default. Add `leaveBehindBps` (0 or 500) to author the 96-byte `PileParamsV21` tuple. To the pile is AsPaid/BudgetOrPile, only when asset equals P; its pending fees move after graduation and join the closing pot on failure. The last T redeemer takes the remaining pile.
Copy the asset’s full public address from the menu; zero address means native ETH. It must be a currently
listed coin other than the predicted own box coin, even with zero seed. The seed is an unsigned decimal string
in that coin’s raw units, never a JSON number or `{ "decimal": ... }`. Its decimals and raise do not change the
box’s price coin or creation raise. [Dragon’s Hoard](kits/dragons-hoard.md) illustrates a 1 ETH seed,
priced in ETH, with buyers feeding the pile after graduation and sellers burning HOARD. Redemptions leave 5%
for the remaining holders; the last redeemer takes the balance.

The creator is the seeder; no separate seeder setting exists. Seed is not part of the creation payment.
Anyone may trigger the exact ERC-20 pull from that creator’s approval; native loading requires the creator and
exact value. Nonzero seed completes the existing loader gate once, with rollback if completion fails;
zero seed needs no loader. Required chunks and seed completion both hold opening.
Only after graduation, redemption pays `floor(live fixed-asset balance * tIn / pre-burn supply)`;
the caller supplies/burns its own coins with minOut and atomic payout rollback, applying the selected 0% or 5%
leave-behind (except that the last redeemer takes the balance).
On failure only recorded seed returns to the creator, retryably; paused seed cannot block holders’ price-coin
claims. Fixed-asset gifts join live redemption. Failed unsolicited surplus and unrelated assets remain stranded
under the no-rescue default. Never auto-migrate a saved recipe into different economics.

[Exit Liquidity](kits/exit-liquidity.md) is a collection of 404 open signs priced in tUSDC on Sepolia:
buyers Grow; sellers pay items in the price coin, with BuyBackBurn inside. It has no preset id.

## Freshness seam

`packages/box-spec/scripts/lib/spec-launch-v2.mjs` exports `refreshLaunchV2(model, draft, readers)`.
Supply `readListings({network, release, listingId, token, pileAsset?})` returning a matching `squarehole.listings/1`
snapshot containing fresh rows for the price coin and, for piles, the requested seed coin, and `prepareLaunch({network, release, wire, specHash})` returning
`{specHash, quote, coordinatorSalt, hookSalt, predictedT?}` for that exact wire. For piles, `predictedT` is required: the nonzero address computed from that exact plan and its new salts. It must differ from the seed asset. A missing/retired seed row fails before preparation, including zero-seed piles; the offline listing merge cannot substitute for it. Read failures have no offline fallback.
The result contains a new draft and preparation; stale quote/salt fields are discarded. The caller must replace
the old preparation as a whole and recheck before signing. The factory still rejects a raise changed at inclusion.
The test double demonstrates refresh only; M2-52/M3-52 supplies canonical live registry reads (including `newestListingOf(asset)` for the seed) and the launch integration supplies
real quoting/mining. The skill command checks saved files and sends no transaction.
