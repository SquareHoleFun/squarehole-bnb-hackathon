# What is in the Link Marines box, version 2

A token, MARINE, priced in LINK, and a new collection of 420 marines. Every fee is taken in LINK. On both sides,
buying and selling, ten of every fifteen parts of each fee are the marines' rations: split into 420 equal shares,
one for each marine, whatever its rank. A marine that someone owns keeps its ration until its owner claims it in LINK.
A marine still in the box sends its ration into the box's own pool and makes it deeper. Royalties on the marines feed
back into the box and are shared out like the fees. The site calls the marines "items", the place where they wait
"the vault", and this fee choice "To items".

The founder chose this recipe, "Rations for the marines", and changed one part of it: a marine still in the box feeds
the box's own pool, where version 1 locks its LINK away. Version 1 of this kit stays the version that eats the fees
([version 1](../link-marines/README.md)).

## The settings in plain words

These are the settings in [link-marines-v2.json](../../../packages/box-spec/examples/v2/link-marines-v2.json),
explained with the [registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change them after the
box is created. This page explains them. It quotes no market amounts.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `Link Marines`, `MARINE` | The name counsel cleared, as the founder reports it. MARINE is the ticker the founder chose. |
| Status | `ready` | The local contract and browser example lives pass. Nothing is deployed. |
| Template | `collection` (`Collection`) | The creator starts from the Collection template, then selects Depth for the inside shares on both fee sides. |
| Price coin | `LINK`, `18` decimals | A community coin. The fees, the raise, every ration and any failure claim are all in LINK. |
| Contents | `collection` of `420` `Marines` | 420 new NFTs with ids 1 to 420, in twelve ranks from Private to General. |
| Art | `open` | Every marine's picture is public from the start. There are no draws. Anyone can pick any marine still in the vault by its number. This kit uses 420 unique portraits. `assign.mjs` records each picture hash and all nine traits from the reviewed edition. The model policy is `2d`; no item has a model. |
| Seed | none | Nothing else goes into the box when it is created. |
| Pick fee | `100` basis points | Taking out a marine costs 1% more of the box token MARINE. That extra MARINE is burned. |
| Raise | `listing-fixed` | Square Hole's LINK listing sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `90` days | The raise has 90 days to fill. |
| Royalties | `250` basis points, to `fees` | Selling a marine on a marketplace asks a 2.5% royalty, and it goes into the box's fee handling. |
| Buyers' fees | `items`, inside `depth` | Outside owners claim the buyers' share; inside shares go to the box's own pool. |
| Sellers' fees | `items`, inside `depth` | The same as the buyers' side. Both sides are handled the same way, as the founder asked. |
| Creator buy | zero | The creator buys nothing at launch (registry notes). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | six properties | The test proves that no fee goes missing (`fee-conservation`), the page shows the right state (`page-state`), the box graduates (`graduation`), a marine's owner can claim its exact share (`item-claim`), the kit shows its own art (`own-pictures`), and inside shares deepen the pool (`pool-growth`). |

## Where each fee goes

Every trade pays a 1% fee in LINK. A buy pays it on the LINK going in. A sale pays it on the LINK coming out.

The fee is split into 15 equal parts.

- **10 parts** are the marines' rations, on both sides.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding goes to the pool while the box is live.

**The marines' 10 parts.** They are split into 420 equal shares, one for each marine. Rank is only the picture: a
Private's share and a General's share are the same. What is left over after dividing by 420 goes to the pool.

- **A marine that someone owns** is outside the vault. Its share waits on the marine as LINK until its owner claims
  it.
- **A marine still in the box** sends its share into the box's own pool, which makes the pool deeper. It keeps no
  new inside stash. This is the Depth policy.

**Before graduation.** During the raise every marine is still in the vault, and the marines' parts wait in the box.
When the box graduates, all those held parts go into the pool, including the remainder from dividing them.

**The collect step.** Fees reach the box in batches. Anyone can run the step that collects a batch, and Square Hole's
keeper is built to run it once a batch is big enough. Whoever runs it may keep a tip from a buyers' batch, at most 5%
of it and never more than a cap set for each box. The tip comes off before the batch is split.

**The pool's 2 parts.** After graduation, anyone can run the step that adds them, and its runner may keep a tip of at
most 5% of what the step moves. About half of the LINK buys MARINE in the pool, and then the LINK and the MARINE go in
together as liquidity the box owns. The pool refuses every attempt to add outside liquidity or to take liquidity out.

**Royalties.** A marketplace that pays the marines' royalty pays it to the box. Royalty LINK is split like a buyers'
fee: 10 parts to the marines, 2 to the pool and 3 to Square Hole (its platform and its buy-back). Royalty LINK that
arrives before graduation waits in the box until then. Royalties in another coin, usually ETH, go to Square Hole's
conversion Safe first. Its bot sells them for LINK and pays that back into the box as royalty LINK. Marketplaces choose
whether to pay royalties at all.

**When nothing happens.** Fees only come from trades. There is no schedule. No trades means no rations.

**The launch window.** For the first 6.4 minutes after the box opens, every buy goes through the launch router and
pays a launch tax on top of the fee. The tax starts at about 93% and drops every 12 seconds, down to about 8% in the
last step, and then ends. It goes into the box's own pool after graduation, or into the failure claim if the box
fails.

## What each owner gets

**A MARINE holder** holds the box token. The rations go to the marines, the NFTs, so holding MARINE gives no ration.
After graduation, MARINE is how a marine leaves the vault.

- One marine costs the amount of MARINE outside the vault divided by the number of marines still inside, rounded up.
  You also pay the 1% pick fee, and that part is burned. The rest stays in the vault, held for that marine.
- Putting a marine back gives you one marine's share of MARINE at that moment, rounded down, minus a 5% fee that is
  burned. This can be more or less MARINE than you put in. Only the marine's owner can put it back.
- The last marine always stays in the vault.
- Quotes move between the moment you look and the moment you sign. Every take-out has a limit you set and a deadline,
  and so does every put-back.

**A marine owner** owns the NFT and claims its rations in LINK.

- Only the current owner can claim, one marine per claim, and only while the marine is out of the vault. There is no
  minimum, no tip and no time limit. The owner pays the gas. Nobody can pause or block a claim.
- The rations stay with the marine. Sell or give the marine away, and the unclaimed rations go with it.
- Put the marine back in the vault, and its unclaimed outside rations stay with it for whoever takes it out next. New inside
  shares go to the pool. Claim before putting it back if you want to keep the rations it received outside.
- Sometimes a claim has to wait for the fee records to catch up. Anyone can run that catch-up, and no ration is lost
  while it waits.

Rank is only the picture. Twelve ranks repeat across 420 marines, 35 of each. Two marines with the same rank are
separate NFTs with distinct portraits, and a rank changes nothing about rations, fees or the box. Every run of 12 ids is one squad
with one marine of each rank. Nothing in the box reads squads. Face, Eyes, Grooming, Collar, Mouth, Prop and Wall
complete each portrait alongside Rank and Squad; [the trait table](unique/traits.md) gives every value and count.

## Risks in plain words

- The token MARINE and the marines can lose all their value. There may be no buyer when you want to sell.
- A ration is a share of fees, and fees only come from trades. Each fee's marine share is split 420 ways, so one
  marine's part of a single fee is very small, and the gas to claim can be larger than the ration.
- LINK is a community coin that Square Hole does not run. Its value can fall too, and the fees, the raise, every
  ration and any failure claim are counted in it. The box page shows any powers over the coin that it can read from
  the coin's contract.
- Royalties in another coin depend on Square Hole's conversion Safe and its bot. If they stop, those royalties wait.
- A claim needs LINK's own transfer to work. If LINK ever refused it, the ration would stay with the marine until a
  claim succeeds.
- The raise can miss its 90 days, and then the box fails. If the raise fills but the box has not graduated 7 days
  later, anyone can fail it too. After a failure, no ration is served. The rations waiting in the box join the
  closing pool, and the marines in the vault go back to the creator. Holders hand in MARINE to claim their part of
  what is left. That is no promise to get everything back. Failure claims close a year after the failure, and what is
  left after that goes to Square Hole's buy-back. Royalties that still arrive after a failure also go to Square Hole's
  buy-back.
- Taking a marine out ties up MARINE in the vault, and putting it back costs 5% of the marine's share.
- These contracts have internal reviews and tests. They have had no outside audit so far.
- Anyone can copy the name, the ticker and these pictures. Check the chain and the full contract address every time.

## What still waits

**For counsel**

- The joke and the look. Counsel cleared the name only, as the founder reports it
  ([counsel pack](../../../docs/legal/counsel-pack-2026-10.md), part 6.2). Dress navy with white caps, next to the word
  marines, points toward a real service's dress uniform. Counsel should see the cover, one marine and the "not
  affiliated" line before any public use.
- The rations. A marine carries a claim on part of the fees, the marine can be sold, and unclaimed outside rations stay
  with a marine when it goes back into the vault. New inside shares go to the pool. Question 34 asks whether item payouts are a tradable revenue right.
- The price coin. The box is priced in a community coin that Square Hole lists. Question 31 asks whether listing a
  coin creates responsibility for it.
- The ticker. MARINE is the founder's choice, and it has not been checked against names and marks. The brand book's
  ticker section says why every live page and post shows the chain and the full contract address.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For the example lives**

Step 5 of v2.1 supplies Depth. The integrator's contract and browser lives pass: both sides' rations, an owner's claim
in LINK, the royalty, the inside shares going to the pool, and every marine revealed from the created box's own
download. The row is `ready`. This recorded evidence predates the unique portrait commitments; it does not verify
the current art in a browser or a deployed box.

**For the launch**

- The registry names this kit's own logo and cover. The kit tooling builds the public settings, all 420 numbered
  pictures, traits and reveals. Hosting still needs public bindings, and the deployed collection must use ids 1 to 420.
- A test network has no real LINK. The local test life uses a stand-in coin with the same symbol and decimals, and a
  public test run needs one too, with a pool to trade it in.
- Every live page shows the chain and the full contract address, and the "not affiliated" line. When Square Hole
  launches the box itself, the address also goes on its list of own boxes (F133). Until then the line reads
  "Contract: not deployed".
- Choose Depth for both inside policies on Create, then verify the exact recipe and tLINK listing before signing.
- The integrator ran the local and browser lives and the full checks before the row became ready (SH-EX-LMV2).

## Sources

- [link-marines-v2.json](../../../packages/box-spec/examples/v2/link-marines-v2.json) and the
  [registry notes](../../../packages/box-spec/examples/v2/README.md): the settings, the creator buy and the test life.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F82 LM2 and LM5, the box's own answers; F83 C3, royalties
  feeding the box; F118 to F120, fees in the price coin and one choice per side; F122 and F123, the failure claim and
  royalties in other coins; F127, claim-only payouts; F133, own boxes listed by address.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol): 10, 2 and 3 parts of 15, the marines'
  parts held until graduation and then shared out, the inside rule, royalties split like a buyers' fee, the collect
  tip.
- [Receiver](../../../packages/contracts/src/box-v2/BoxReceiverV2.sol): royalties in LINK and in other coins.
- [Item ledger](../../../packages/contracts/src/box-v2/ItemLedgerV2.sol): equal shares for every marine, the stash of a
  marine in the vault, owner-only claims of one marine, rations that follow the marine, and the catch-up step.
- [Failure table](../../../packages/contracts/src/box-v2/interfaces/FailureTableV2.sol): waiting rations and royalty
  LINK join the closing pool.
- [Vault](../../../packages/contracts/src/box-v2/BoxVaultV2.sol) and
  [quotes](../../../packages/contracts/src/box-v2/libraries/VaultViews.sol): taking marines out and putting them back,
  the 1% pick fee, the 5% fee and the last marine.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [launch router](../../../packages/contracts/src/box-v2/BoxLaunchRouterV2.sol): the 1% fee on both sides, the
  locked liquidity, the 6.4-minute window and its tax table.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): failing a box and the year-long claim.
