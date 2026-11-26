# What is in the Bag Holders box

A token called TOTE, priced in LINK, and a new collection of 420 bags. Every fee is paid in LINK. On both sides,
buying and selling, the box's share of each fee is split equally across all 420 bags. A bag outside the box keeps its
share for its owner to claim. A bag inside the box keeps its share in the bag, and whoever takes the bag out can
claim it. The site calls the bags "items", the place where they wait "the vault", the fee choice "To items", and the
rule for bags in the vault "Keep".

## The settings in plain words

These are the settings in [bag-holders.json](../../../packages/box-spec/examples/v2/bag-holders.json), explained
with the [registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change them after the box is
created. This page explains them. It quotes no market amounts.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `Bag Holders`, `TOTE` | A fixture choice. The name and ticker are not cleared, and other tokens may use TOTE. |
| Status | `ready` | The local test life runs on today's contracts. Nothing is deployed. |
| Template | `collection` | The creator starts from the Collection template, "NFTs · To items · Keep" on the create page, and keeps it as it is. |
| Price coin | `LINK`, `18` decimals | A community coin. The fees, the raise, every bag's share and any failure claim are all paid in it. |
| Contents | `collection` of `420` `Bags` | 420 new NFTs with ids 1 to 420. |
| Art | `open` | Every bag's picture is public from the start. `assign.mjs` selects all 420 unique pictures and their 3D models, with `kind`, `trim`, `repair`, `tag` and `stitch` traits. |
| Seed | none | Nothing else goes into the box when it is created. |
| Pick fee | `100` basis points | Taking out a bag you choose costs 1% more TOTE. That extra TOTE is burned. |
| Raise | `listing-fixed` | Square Hole's LINK listing sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `30` days | The raise has 30 days to fill. |
| Royalties | `0`, none | Selling a bag on a marketplace pays no creator royalty. |
| Buyers' fees | `items`, inside `keep` | The buyers' share is split equally across all 420 bags. A bag in the vault keeps its part in the bag. |
| Sellers' fees | `items`, inside `keep` | The sellers' share does exactly the same. |
| Creator buy | zero | The creator buys nothing at launch (registry notes). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | five properties | The test proves that no fee goes missing (`fee-conservation`), the page shows the right state (`page-state`) with the box's own pictures (`own-pictures`), the box graduates (`graduation`), and a bag's owner can claim its exact share (`item-claim`). |

## Where each fee goes

Every trade pays a 1% fee in LINK. A buy pays it on the LINK going in. A sale pays it on the LINK coming out.

The fee is split into 15 equal parts.

- **10 parts** follow the box's choice for that side. Here both sides choose To items, so these parts go to the bags.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding goes to the pool while the box is live.

**The bags' 10 parts.** They are split into 420 equal shares, one for each bag. It makes no difference whether a bag
is in the vault or out of it, and no difference which picture it shows. What is left over after dividing by 420 goes
to the pool.

- **A bag outside the vault** collects its share as LINK credit that waits on the bag until its owner claims it.
- **A bag inside the vault** collects the same share as a stash that stays in the bag. Nobody can claim it while the
  bag is inside. Whoever takes the bag out owns the stash with the bag and can claim it.

Because both sides keep the share of bags in the vault, a bag's share never depends on when it was taken out or put
back. The timing only decides who can claim it.

**Before graduation.** During the raise every bag is still in the vault, and the bags' parts wait in the box. When
the box graduates, all of it is shared out at once, the same part to every bag, as each bag's first stash.

**The collect step.** Fees reach the bags in batches. Anyone can run the step that collects a batch, and Square
Hole's keeper is built to run it once a batch is big enough. Whoever runs it may keep a tip from a buyers' batch, at
most 5% of it and never more than a cap set for each box. The tip comes off before the batch is split.

**The pool's 2 parts.** After graduation, anyone can run the step that adds them, and its runner may keep a tip of
at most 5% of what the step moves. About half of the LINK buys TOTE in the pool, and then the LINK and the TOTE go in
together as liquidity the box owns. The pool refuses every attempt to add outside liquidity or to take liquidity out.

**When nothing happens.** Fees only come from trades. There is no schedule.

**The launch window.** For the first 6.4 minutes after the box opens, every buy goes through the launch router and
pays a launch tax on top of the fee. The tax starts at about 93% and drops every 12 seconds, down to about 8% in
the last step, and then ends. It goes into the box's own pool after graduation, or into the failure claim if the box
fails.

## What each owner gets

**A TOTE holder** holds the box token. The fees go to the bags, so holding TOTE gives no share of them. After
graduation, TOTE is how a bag leaves the vault.

- One bag costs the TOTE outside the vault divided by the bags still inside, rounded up. You also pay the 1% pick
  fee, and that part is burned. The rest stays in the vault, held for that bag.
- Putting a bag back pays you that bag's share of TOTE at that moment, rounded down, minus a 5% fee that is
  burned. This can be more or less TOTE than you put in. Only the bag's owner can put it back.
- The last bag always stays in the vault.
- Quotes move between the moment you look and the moment you sign. Every take-out has a limit you set and a
  deadline, and so does every put-back.

**A bag owner** owns the NFT and can claim its LINK, the credit it collected outside and any stash it brought out of
the vault.

- Only the current owner can claim, one bag per claim, and only while the bag is out of the vault. There is no
  minimum, no tip and no time limit. The owner pays the gas.
- The credit stays with the bag. Sell or give the bag away, and the unclaimed credit goes with it.
- Put the bag back in the vault, and its unclaimed credit stays in the bag for whoever takes it out next. So claim
  first.
- Sometimes a claim has to wait for the fee records to catch up. Anyone can run that catch-up, and no credit is lost
  while it waits.

Each of the 420 bags has its own picture and 3D model. The twelve base kinds still have 35 bags each, with different
trim, repair, tag and stitch combinations. These traits change nothing about a bag's equal fee share or claims.

## Risks in plain words

- TOTE and the bags can lose all their value. There may be no buyer when you want to sell.
- LINK is a community coin that Square Hole does not run. Its value can fall too, and the fees, the raise, every
  bag's share and any failure claim are all paid in it. The box page shows any powers over the coin that it can read
  from the coin's contract.
- No trades means no new credit. Each fee's bag share is split 420 ways, so one bag's part of a single fee is very
  small, and the gas to claim can be larger than the credit.
- A stash in a bag in the vault can only be claimed after someone takes the bag out, and that costs TOTE and the
  1% pick fee.
- The raise can miss its 30 days, and then the box fails. If the raise fills but the box has not graduated 7 days
  later, anyone can fail it too. After a failure, no bag gets a share. The bags' waiting parts join what holders can
  claim, and the bags in the vault go back to the creator. Holders claim their part of what is left. That is not a
  promise to get everything back. Failure claims close a year after the failure, and what is left after that goes to
  Square Hole's buy-back.
- Taking a bag out ties up TOTE in the vault, and putting it back costs 5% of the bag's share.
- These contracts have internal reviews and tests. They have had no outside audit so far.
- Anyone can copy the name, the ticker and these pictures. Check the chain and the full contract address every time.

## What still waits

**For counsel**

- The name. "Bag holder" is slang for someone left with a token that fell. Counsel should confirm that the name and
  the joke read as satire and do not mislead buyers.
- The bag share. A bag carries a claim on part of the fees, the bag can be sold, and a bag in the vault keeps a
  stash for whoever takes it out. The counsel pack asks in question 34 whether item payouts are a tradable revenue
  right ([counsel pack](../../../docs/legal/counsel-pack-2026-10.md)).
- The price coin. The box is priced in a community coin that Square Hole lists. Question 31 asks whether listing a
  coin creates responsibility for it.
- The ticker. TOTE has not been checked against other names and marks.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For a v2.1 step**

Nothing. This box pays its bags in LINK, the price coin, and keeps the share of bags in the vault, which today's
contracts already do. An early plan had the share of bags in the vault eat the price coin instead. That would need
step 1 of v2.1, `V21-01-EAT`. The registry row chose Keep, so this box waits for no step.

**For the launch**

- The registry still points at local test pictures. Using this art needs the metadata and hosting step, and the
  deployed collection must use ids 1 to 420.
- The active assignment uses the reviewed unique edition and requires a model for every bag. Settings and CAR
  builds commit every model through Create's own model reader, and the settings file carries the models for Load
  settings. T05 owns publication of the final post-Create list and its proofs. See the
  [shared builder instructions](../../../scripts/kits/README.md).
- A test network has no real LINK. The local test life uses a stand-in coin with the same symbol and decimals, and a
  public test run needs one too.
- Every live page shows the chain and the full contract address. When Square Hole launches the box itself, the
  address also goes on its list of own boxes (F133). Until then the line reads "Contract: not deployed".
- F89 asks for Bag Holders as a ready-made template with fewer fields. The create page's Collection template is the
  same recipe today, so this kit can be that template's example look. Naming the template is the founder's choice.

## Sources

- [bag-holders.json](../../../packages/box-spec/examples/v2/bag-holders.json) and the
  [registry notes](../../../packages/box-spec/examples/v2/README.md): the settings, creator buy and test lives.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F89, Bag Holders as a template; F118 to F120, fees in the
  price coin and one choice per side; F122, the 7-day escape and the failure claim; F123, listing raises; F127,
  claim-only payouts; F133, own boxes listed by address.
- [Core v2 plan](../../../docs/design/core-v2-plan.md), section 5: the early Bag Holders plan, with bags in the vault
  eating the price coin and bags paying their owner at claim.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol): `_splitSource` gives 10, 2 and 3 parts
  of 15, holds the bags' parts until graduation and sends them to the bags, and the collect tip.
- [Item ledger](../../../packages/contracts/src/box-v2/ItemLedgerV2.sol) and
  [its interface](../../../packages/contracts/src/box-v2/interfaces/IItemLedgerV2.sol): equal shares for every bag,
  the stash of a bag in the vault, owner-only claims of one bag, credit that follows the bag, and the catch-up step.
- [Vault](../../../packages/contracts/src/box-v2/BoxVaultV2.sol) and
  [quotes](../../../packages/contracts/src/box-v2/libraries/VaultViews.sol): taking bags out and putting them back,
  the 1% pick fee, the 5% fee, the last bag, and bags going back to the creator after a failure.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [launch router](../../../packages/contracts/src/box-v2/BoxLaunchRouterV2.sol): the 1% fee on both sides, the
  locked liquidity, the 6.4-minute window and its tax table.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): failing a box and the year-long claim.
- [Create page templates](../../../apps/web/src/features/create/v2/templates.ts): the Collection template.
