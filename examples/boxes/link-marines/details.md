# What is in the Link Marines box

A token, ticker MARINE, priced in LINK, and a new collection of 420 marines. Every fee is paid in LINK. On both
sides, buying and selling, the box's share of each fee is eaten. Eaten LINK waits in the box until the box graduates.
Then anyone can run one step that sends it to an address nobody has a key for. It is out of circulation for good. The
marines can be taken out of the box and put back, and no LINK ever goes to them. The site calls the marines "items",
the place where they wait "the vault", and this fee choice "Eat the price coin".

The founder's idea is a new collection priced in LINK that takes LINK out of circulation through its fees. In his
words, "the marines can be taken out, but there is no $LINK streaming to them". LINK has no burn that a box can use,
so the box locks the coins, as Square Hole's notes on the idea ask
([the idea](../../../scripts/builder-kit/content/projects/link-marines.md)).

## The settings in plain words

These are the settings in [link-marines.json](../../../packages/box-spec/examples/v2/link-marines.json), explained
with the [registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change them after the box is
created. This page explains them. It quotes no market amounts.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `Link Marines`, `MARINE` | The founder reports that counsel cleared the name (F82 LM5). The founder chose the ticker MARINE. It has not been checked against other names and marks. |
| Status | `ready` | The local test life runs with Eat on both sides (step 1 of v2.1, `V21-01-EAT`). Nothing is deployed. |
| Template | `collection` (`Collection`) | The creator starts from the Collection template and picks Eat on both sides, which the create page offers. |
| Price coin | `LINK`, `18` decimals | A community coin. The fees, the raise and any failure claim are all paid in it. |
| Contents | `collection` of `420` `Marines` | 420 new NFTs with ids 1 to 420. The founder chose 420 (F82 LM5). |
| Art | `open` | Every marine's picture is public from the start. There are no draws. Anyone can pick any marine still in the vault by its number. This kit draws 12 pictures, and `assign.mjs` decides which marine shows which. |
| Seed | none | Nothing else goes into the box when it is created. |
| Pick fee | `100` basis points | Taking out a marine costs 1% more MARINE. That extra MARINE is burned. |
| Raise | `listing-fixed` | Square Hole's LINK listing sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `90` days | The raise has 90 days to fill. The founder chose 90 days (F82 LM5). |
| Royalties | `0`, `none` | Selling a marine on a marketplace pays no royalty. The founder's idea had royalties feeding back to the box. See "What still waits". |
| Buyers' fees | `eat` | The buyers' share is eaten. |
| Sellers' fees | `eat` | The same as the buyers' side. The founder wants both sides handled the same way (F82 LM2). |
| Creator buy | zero | The creator buys nothing at launch (registry notes, and the founder in F82 LM5). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | `fee-conservation`, `page-state`, `own-pictures`, `graduation`, `price-coin-eaten` | The test proves that no fee goes missing, the page shows the right state with the box's own pictures, the box graduates and its LINK is eaten. |

## Where each fee goes

Every trade pays a 1% fee in LINK. A buy pays it on the LINK going in. A sale pays it on the LINK coming out.

The fee is split into 15 equal parts.

- **10 parts** follow the box's choice for that side. Both sides choose Eat, so these parts wait in the
  box to be eaten.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding goes to the pool while the box is live.

**Before graduation.** Nothing is eaten during the raise. The eaten share waits in the box.

**The eat step.** After the box graduates, anyone can run it. It takes the LINK that waits and sends it to the dead
address, a well-known address that nobody has a key for. Whoever runs the step gets no tip, and nobody can choose
where the LINK goes. Square Hole's keeper is built to run the step whenever LINK is waiting. If the transfer fails
for any reason, the LINK stays waiting and anyone can run the step again.

**Burned or locked.** When Square Hole lists a coin, it can check that the coin has a real burn. A box priced in a
checked coin burns its eaten coins. LINK has no such burn, so this box locks them at the dead address instead. Locked
LINK still counts in LINK's total supply, because nothing can destroy it. It can never be spent again. The box page
shows the total eaten so far.

**The collect step.** Fees reach the box in batches. Anyone can run the step that collects a batch, and Square Hole's
keeper is built to run it once a batch is big enough. Whoever runs it may keep a tip from a buyers' batch, at most 5%
of it and never more than a cap set for each box. The tip comes off before the batch is split.

**The pool's 2 parts.** After graduation, anyone can run the step that adds them, and its runner may keep a tip of at
most 5% of what the step moves. About half of the LINK buys MARINE in the pool, and then the LINK and the MARINE go in
together as liquidity the box owns. The pool refuses every attempt to add outside liquidity or to take liquidity out.

**When nothing happens.** Fees only come from trades. There is no schedule. No trades means nothing to eat.

**The launch window.** For the first 6.4 minutes after the box opens, every buy goes through the launch router and
pays a launch tax on top of the fee. The tax starts at about 93% and drops every 12 seconds, down to about 8% in the
last step, and then ends. It goes into the box's own pool after graduation, or into the failure claim if the box
fails.

## What each owner gets

**An MARINE holder** holds the box token. The fees are eaten, so holding MARINE gives no share of them. After
graduation, MARINE is how a marine leaves the vault.

- One marine costs the MARINE outside the vault divided by the marines still inside, rounded up. You also pay the 1%
  pick fee, and that part is burned. The rest stays in the vault, held for that marine.
- Putting a marine back pays you one marine's share of MARINE at that moment, rounded down, minus a 5% fee that is
  burned. This can be more or less MARINE than you paid. Only the marine's owner can put it back.
- The last marine always stays in the vault.
- Quotes move between the moment you look and the moment you sign. Every take-out has a limit you set and a deadline,
  and so does every put-back.

**A marine owner** owns the NFT and its picture, and nothing else. A marine collects no fees and has nothing to claim.
Selling or giving a marine away moves only the NFT.

- Twelve pictures repeat across 420 marines. Two marines with the same picture are still two separate NFTs, and a
  picture changes nothing about fees or the box.
- Every run of 12 ids is one squad with one marine of each kind. Squads are a rule for pictures only. Nothing in the
  box reads them.

## Risks in plain words

- MARINE and the marines can lose all their value. There may be no buyer when you want to sell.
- Eating LINK gives nothing back to MARINE holders, marine owners or anyone who holds LINK.
- Eaten LINK is gone for good. Nobody can undo the lock, Square Hole included.
- LINK is a community coin that Square Hole does not run. Its value can fall too, and the raise and any failure claim
  are paid in it. The box page shows any powers over the coin that it can read from the coin's contract.
- The eat step needs LINK's own transfer to work. If LINK ever refused it, the waiting LINK would stay in the box
  until the step succeeds.
- The raise can miss its 90 days, and then the box fails. If the raise fills but the box has not graduated 7 days
  later, anyone can fail it too. After a failure nothing is eaten. The LINK waiting to be eaten joins the closing
  pool, and the marines in the vault go back to the creator. Holders hand in MARINE to claim their part of what is
  left. That is no promise to get everything back. Failure claims close a year after the failure, and what is left
  after that goes to Square Hole's buy-back.
- Taking a marine out ties up MARINE in the vault, and putting it back costs 5% of the marine's share.
- These contracts have internal reviews and tests. They have had no outside audit so far.
- Anyone can copy the name, the ticker and these pictures. Check the chain and the full contract address every time.

## What still waits

**For counsel**

- The joke. Counsel cleared the name only, as the founder reports it ([counsel pack](../../../docs/legal/counsel-pack-2026-10.md),
  part 6.2). The joke borrows a community's nickname, and the coin belongs to a brand. Counsel should confirm that the
  caricature, the art and the "not affiliated" line read as satire and imply no endorsement.
- The price coin. The box is priced in a community coin that Square Hole lists. Question 31 asks whether listing a
  coin creates responsibility for it.
- The ticker. MARINE has not been checked against other names and marks.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For a v2.1 step**

Nothing. This box uses step 1 of v2.1, eat the price coin, which this line has.

- The contract code is on this line. The receiver books the eaten share at every collect, runs the eat step after
  graduation, locks a coin with no checked burn at the dead address, and sends the waiting share to the closing pool
  if the box fails ([step 1 design](../../../docs/design/core-v21-step1-eat.md),
  [step 1 record](../../../docs/evidence/SH-V21-01-EAT.md)). The keeper runs the eat step.
- The registry row is `ready`, with Eat on both sides. Its local life locks the LINK after graduation and the page
  shows the eaten total. `check.mjs` also accepts the older pending form of the row and fails on any other.
- The create page offers the Eat choice and the box page shows the eaten total. The box page labels the choice "Eat
  the price coin". Step 1 also gives the site a label from the listing, `Burn <coin>` or
  `Lock <coin>`, and for LINK it is `Lock LINK`.
- An earlier founder answer (F95 R19N) had Link Marines send its LINK into its own pool. Step 1 locks it at the dead
  address instead, and this kit follows step 1 as the later decision.

**For the launch**

- The registry row uses this kit's logo, and still uses a shared local test picture for the collection cover and the
  items. Using this art needs the metadata and hosting step, and the
  deployed collection must use ids 1 to 420.
- A test network has no real LINK. The local test life uses a stand-in coin with the same symbol and decimals, and a
  public test run needs one too, with a pool to trade it in.
- Every live page shows the chain and the full contract address, and the "not affiliated" line. When Square Hole
  launches the box itself, the address also goes on its list of own boxes (F133). Until then the line reads
  "Contract: not deployed".
- Royalties. The founder's idea had royalties on the marines feeding back to the box (F82 LM5, F83 C3), with royalty
  LINK following the recipe (F94 R18G). The test row keeps royalties off. A creator can turn them on at creation with
  the destination `fees`, and then they go through the same recipe and get eaten too. Marketplaces choose whether to
  pay royalties at all. Like every setting, this cannot change after creation.
- Marines for other coins. The founder wants this box for every coin with a strong community. A copy is the same
  settings on another listed coin. The coins in the pictures carry no name, so the same art fits a copy, and only the
  name lettering needs a change.

## Sources

- [link-marines.json](../../../packages/box-spec/examples/v2/link-marines.json) and the
  [registry notes](../../../packages/box-spec/examples/v2/README.md): the settings, the creator buy and the test life.
- [The idea and Square Hole's notes](../../../scripts/builder-kit/content/projects/link-marines.md): the founder's
  words, "locked" or "eaten" and never "burned", and the "not affiliated" line.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F82 LM1 to LM5, the box's own answers; F83 C3 and F94 R18G,
  royalties; F95 R19N, LINK into the pool; F106, Square Hole's share; F120, fees in the price coin; F122, the 7-day
  escape and the failure claim; F123, listing raises; F127, claim-only payouts; F133, own boxes listed by address.
- [Core v2 plan](../../../docs/design/core-v2-plan.md), sections 2 and 5: Link Marines as a configuration, and the
  ticker question.
- [Step 1 design](../../../docs/design/core-v21-step1-eat.md) and [record](../../../docs/evidence/SH-V21-01-EAT.md):
  eating the price coin, burned or locked.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol) and
  [receiver](../../../packages/contracts/src/box-v2/BoxReceiverV2.sol): 10, 2 and 3 parts of 15, the eaten share, the
  eat step, the dead address and the failure route.
- [Vault](../../../packages/contracts/src/box-v2/BoxVaultV2.sol) and
  [quotes](../../../packages/contracts/src/box-v2/libraries/VaultViews.sol): taking marines out and putting them back,
  the 1% pick fee, the 5% fee and the last marine.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [launch router](../../../packages/contracts/src/box-v2/BoxLaunchRouterV2.sol): the 1% fee on both sides, the
  locked liquidity, the 6.4-minute window and its tax table.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): failing a box, handing in MARINE and the
  year-long claim.
- [Keeper plan](../../../packages/keeper/src/plan.ts): the keeper runs the eat step whenever LINK is waiting.
