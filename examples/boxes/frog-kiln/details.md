# What is in the Frog Kiln box

A token called KILN, priced in the frog coin, and a new collection of 420 clay toads, hidden until drawn. Every fee is
paid in the frog coin, and the two sides go to different places. The buyers' share of each fee is eaten. After the box
graduates, it is burned with the frog coin's own burn, so those coins are gone for good. The sellers' share buys KILN
in the box's own pool, and the KILN is shared equally by all 420 toads. A toad out of the box keeps its part for its
owner to claim. The part of a toad still inside the box is burned. The site calls the toads "items", the place where
they wait "the vault", the buyers' choice "Eat the price coin", the sellers' choice "To items in the box token", and
the rule for toads in the vault "Burn".

The idea comes from Square Hole's research on meme coins
([round 2b](../../../docs/research/round2b-stonks-rwa-memes-defi.md)). It is a box that fires the frog coin in a kiln on
every trade and holds 420 clay toads with a few cracked specials. After the founder's notes on that round (F89), his answer
R25C (F109) gave the toads a part of the fees in the box token, with the share of toads still inside burned. A later
simplification of the core took out both eating the price coin and paying items in the box token
([Occam check](../../../docs/reviews/OCCAM-CHECK-2026-10-08.md)). Steps 1 and 2 of v2.1 bring both back, and this kit
follows them.

## The settings in plain words

These are the settings in [frog-kiln.json](../../../packages/box-spec/examples/v2/frog-kiln.json), explained with the
[registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change them after the box is created.
This page explains them. It quotes no market amounts.

The row uses Test Frog (`TEST_FROG`, symbol tFROG), the TA-30 test stand-in. Its offline contract life
proves creation, the curve, graduation, a hidden draw and reveal, custody and the checked supply burn.
This is local execution evidence; Sepolia listing and browser launch still need integration.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `Frog Kiln`, `KILN` | The name and the ticker leave out the frog coin's own name on purpose. KILN is not cleared, and other tokens may use it. |
| Status | `ready` | The offline contract life passes. Nothing is deployed by this kit. |
| Template | `collection-burn` (`Collection that burns`) | The creator starts from "NFTs · To items · Burn" on the create page and changes the buyers' side. |
| Price coin | `TEST_FROG`, `18` decimals | Test Frog (tFROG), a test stand-in with a checked burn. The listing supplies the live raise. |
| Contents | `collection` of `420` `Toads` | 420 new NFTs with ids 1 to 420, in twelve pictures, nine glazes of 44 toads and three cracked toads of 8. |
| Art | `hidden` | Every toad stays wrapped until it is drawn. Its picture shows once its entry from the creator's reveal file is posted. |
| Seed | none | Nothing else goes into the box when it is created. |
| Pick fee | `100` basis points | Taking a toad you choose by its number costs 1% more KILN, and that extra KILN is burned. Only toads that came back to the box after their reveal can be picked by number. |
| Raise | `listing-fixed` | The price coin's listing sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `30` days | The raise has 30 days to fill. |
| Royalties | `0`, `none` | Selling a toad on a marketplace pays no royalty. |
| Buyers' fees | `eat` | The buyers' share burns Test Frog through the listing's checked burn. Both its balance and total supply decrease by the exact amount. |
| Sellers' fees | `items-t`, inside `burn` | The sellers' share buys KILN in the box's pool, and the toads get KILN. The share of toads still inside is burned. |
| Creator buy | zero | The creator buys nothing at launch (registry notes). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | `fee-conservation`, `page-state`, `own-pictures`, `graduation`, `supply-burn`, `item-claim`, `price-coin-eaten` | Once its lives exist, they prove that no fee goes missing, the page shows the right state with the box's own pictures, the box graduates, burns make the supply smaller, a toad's owner can claim its exact part, and the price coin is eaten. |

## Where each fee goes

Every trade pays a 1% fee in the frog coin. A buy pays it on the coins going in. A sale pays it on the coins coming
out.

The fee is split into 15 equal parts.

- **10 parts** follow the box's choice for that side. Buyers' parts go to the kiln, and sellers' parts go to the toads.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding goes to the pool while the box is live.

**The buyers' 10 parts, into the kiln.** They wait in the box until it graduates. Then anyone can run the eat step.
It takes the waiting frog coins and burns them with the frog coin's own burn, and it checks that the coin's total
supply fell by exactly that much. Whoever runs the step gets no tip, and nobody can send the coins anywhere else.
Square Hole's keeper is built to run the step whenever coins are waiting. If the burn fails for any reason, the coins
stay waiting and anyone can run the step again. The box page shows the total eaten so far,
marked Burned. That total is the box's "frog coin fired" counter.

**Burned or locked.** The eat step burns a coin only when Square Hole listed it with its burn checked. To check it,
Square Hole's lister sends 10,000 of the coin's smallest units through a test burn, checks that the balance and the
total supply both fall by exactly that much, and then undoes the test. A coin listed the ordinary way is locked at the
dead address instead, an address nobody has a key for, where it can never be spent. So the frog coin's listing must
record its burn. Otherwise this box would lock its coins.

**The sellers' 10 parts, KILN for the toads.** They also wait in the frog coin until the box graduates. Then anyone
can run the buy step. It spends the waiting coins on KILN in the box's own pool. The KILN is split into 420 equal
parts, one for each toad. The parts of toads out of the box go to them. The parts of toads still inside are burned,
and so are the leftovers from rounding.

- Whoever runs the buy step may keep a tip of at most 5% of what it spends.
- The step waits until enough coins have gathered, takes at most one step in a block, and moves the pool's price by
  at most about half a percent, so a big heap of coins is bought in several steps.
- Square Hole's keeper is built to run the buy step and the burns that follow it.

**A toad on its way out.** A toad counts as out of the box from the moment its ticket is taken or its draw is asked
for. Its part waits on the ticket and moves to the toad when the ticket opens. A ticket handed back gives up its part,
and that part is burned.

**The collect step.** Fees reach the box in batches. Anyone can run the step that collects a batch, and Square Hole's
keeper is built to run it once a batch is big enough. Whoever runs it may keep a tip from a buyers' batch, at most 5%
of it and never more than a cap set for each box. The tip comes off before the batch is split.

**The pool's 2 parts.** After graduation, anyone can run the step that adds them, and its runner may keep a tip of at
most 5% of what the step moves. About half of the frog coins buy KILN in the pool, and then the frog coins and the
KILN go in together as liquidity the box owns. The pool refuses every attempt to add outside liquidity or to take
liquidity out.

**When nothing happens.** Fees only come from trades. There is no schedule. No trades means nothing to fire and no
KILN for the toads.

**The launch window.** For the first 6.4 minutes after the box opens, every buy goes through the launch router and
pays a launch tax on top of the fee. The tax starts at about 93% and drops every 12 seconds, down to about 8% in the
last step, and then ends. It goes into the box's own pool after graduation, or into the failure claim if the box
fails.

## What each owner gets

**A KILN holder** holds the box token. The fees go to the kiln and the toads, so holding KILN gives no share of them.
KILN is how a toad leaves the box.

- **A ticket during the raise.** Anyone can take a ticket for a toad with KILN while the raise fills. When the box
  graduates, one public random number decides which toad every ticket gets, and the ticket opens into it. A ticket
  can be handed back during the raise for one toad's share of KILN at that moment, rounded down, less a 5% fee that is
  burned.
- **A draw after graduation.** A draw takes one toad still wrapped in the box. A public random number picks it, after
  the draw is asked for. A draw also sends a little ETH to pay for posting that random number, and the first draw in
  each round pays it for the others.
- **A pick by number.** Toads that came back to the box after their reveal stand on a shelf in the vault, and anyone
  can pick one of them by its number.
- **The price.** A ticket, a draw or a pick costs the KILN outside the vault divided by the toads still inside,
  rounded up, plus a 1% fee. The fee is burned, and the price stays in the vault, held for that toad.
- **Putting a toad back.** Its owner gets one toad's share of KILN at that moment, rounded down, minus a 5% fee that
  is burned. This can be more or less KILN than was paid. A toad can come back once it is revealed, or 30 days after
  it left the box unrevealed.
- The last toad always stays in the vault.
- Quotes move between the moment you look and the moment you sign. Every ticket, draw, pick and put-back has a limit
  you set and a deadline.

**Opening a toad.** A toad opens with its entry from the creator's reveal file. That entry proves its picture was
fixed before the box was created. The creator keeps the file and has to post the entries, by hand or with a bot. If
no entry is posted, the owner can open the toad without its picture after 30 days, and the picture shows whenever its
entry is posted.

**A toad owner** owns the NFT and its picture, and can claim the KILN the toad collected while it was out of the box.

- Only the current owner can claim, one toad per claim, and only while the toad is out of the box. There is no
  minimum, no tip and no time limit. The owner pays the gas.
- The KILN stays with the toad. Sell or give the toad away, and the unclaimed KILN goes with it.
- Put the toad back in the box, and its unclaimed KILN stays with it for whoever takes it out next. So claim first.
- Sometimes a claim has to wait for the fee records to catch up. Anyone can run that catch-up, and nothing is lost
  while it waits.
- Every toad gets the same part, cracked or not. Twelve pictures repeat across 420 toads, and a picture changes nothing
  about the fees or the box.

## Risks in plain words

- KILN and the toads can lose all their value. There may be no buyer when you want to sell.
- A draw is random, and so is the toad a ticket opens into. Most toads are one of the nine glazes, and 24 of the 420
  are cracked. The toad you get can sell for much less than the KILN and the fee you paid, or not sell at all.
- Burning the frog coin gives nothing back to KILN holders, toad owners or anyone who holds the frog coin. A burn makes
  the frog coin's supply smaller. It sets no price.
- The frog coin is a meme coin that Square Hole does not run. Its value can fall too, and the raise and any failure
  claim are paid in it. The box page shows any powers over the coin that it can read from the coin's contract.
- The eat step needs the frog coin's own burn to work. If the coin ever refused it, the coins would wait in the box
  until the step succeeds. They have no other way out.
- Each fee's toad share is split 420 ways, so one toad's part of a single fee is very small, and the gas to claim can
  be larger than the part.
- A toad inside the box gets nothing. Its part is burned.
- The pictures depend on the creator's reveal file. If it were lost, toads could still be opened and put back after
  30 days, but their pictures could never show.
- The raise can miss its 30 days, and then the box fails. If the raise fills but the box has not graduated 7 days later,
  anyone can fail it too. After a failure nothing is fired and no KILN is bought. The coins waiting on both sides join
  the closing pool, and the toads in the box that no ticket holds go back to the creator. Tickets can be handed back for
  KILN at the price fixed at the failure, with no fee, for 14 days. Holders hand in KILN to claim their part of what is
  left. That is no promise to get everything back. Failure claims close a year after the failure, and what is left after
  that goes to Square Hole's buy-back.
- Taking a toad out ties up KILN in the vault, and putting it back costs 5% of the toad's share.
- These contracts have internal reviews and tests. They have had no outside audit so far.
- Anyone can copy the name, the ticker and these pictures. Check the chain and the full contract address every time.

## What still waits

**For counsel**

- The homage. The box is a nod to the frog coin's crowd, and the best-known frog in meme culture belongs to an artist
  who enforces his copyright, as Square Hole's own art rules note. Counsel should confirm that the name, the toads,
  the "not affiliated" line and the use of the coin read as homage by idea, suggest no official product, and stay
  clear of any known frog character.
- Paid random draws. A ticket or a draw costs KILN and a fee, a public random number decides the toad, and 24 of the
  420 are cracked. Question 8 of the [counsel pack](../../../docs/legal/counsel-pack-2026-10.md) asks how paid random
  draws are treated, which places to restrict and whether the answer differs for boxes others create.
- The toads' part of the fees. A toad out of the box collects KILN, and it can be sold with its unclaimed KILN.
  Question 34 asks whether item payouts are a tradable revenue right.
- The price coin. The box is priced in a meme coin that Square Hole would list. Question 31 asks whether listing a coin
  creates responsibility for it.
- The ticker. KILN has not been checked against other names and marks.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For v2.1 and a listing**

This box uses steps 1 and 2 of v2.1, which this line has. It still needs its local lives and a listing for the frog
coin.

- Step 1, eat the price coin. The contract code is on this line. The receiver books the buyers' share, runs the eat
  step after graduation, burns a coin listed with its burn checked, and sends the waiting share to the closing pool if
  the box fails ([step 1 design](../../../docs/design/core-v21-step1-eat.md)).
- Step 2, pay in the box token. The contract code is on this line. The buy step buys KILN for the toads, credits the
  toads out of the box and burns the share of the toads inside
  ([step 2 design](../../../docs/design/core-v21-step2-pay-in-t.md)).
- The site. The create page offers both choices, and the box page shows the eaten total and claims in the box token.
- The registry. The row is `ready` with Test Frog, buyers Eat and sellers paid in KILN. The local contract
  life passes; browser execution and the live listing remain integration checks.

- The listing. Square Hole lists the frog coin with its burn checked, which needs the lister to hold and approve
  10,000 of the coin's smallest units for the test burn. A coin listed the ordinary way would be locked at the dead
  address instead of burned. A test network has no frog coin, so a public test run needs a stand-in coin with a real
  burn and a pool to trade it in.

**For the launch**

- Hidden art. Load the template and its plan file, then the twelve variant pictures and `plan.csv`, as the
  [README](README.md) shows. Create deals fresh numbers and salts. Save its reveal file privately and decide who posts the reveals.
- The create page's texts. Add the special series "Cracked" with the count 24. For the ticket, the line could read
  "A ticket for one clay toad from the kiln. It opens once its number is drawn." For a hidden toad, "Still wrapped.
  This toad shows once it is drawn." The collection page can show up to four teasers. This kit suggests the toads 02
  Celadon, 07 Cobalt, 08 Honey and 10 Gold seam.
- The hidden picture. The template carries `art/hidden.svg` as one line. Create keeps it, and the new box commits it
  in the placeholders add-on.
- The registry still points at local test pictures. Using this art needs the metadata and hosting step, and the
  deployed collection must use ids 1 to 420.
- Every live page shows the chain, the full contract address and the "not affiliated" line. When Square Hole launches
  the box itself, the address also goes on its list of own boxes (F133). Until then the line reads "Contract: not
  deployed".

## Sources

- [frog-kiln.json](../../../packages/box-spec/examples/v2/frog-kiln.json) and the
  [registry notes](../../../packages/box-spec/examples/v2/README.md): the settings, the creator buy and the test life.
- [Round 2b research](../../../docs/research/round2b-stonks-rwa-memes-defi.md), the Frog Kiln entry: the idea, the
  kiln, the 420 clay toads, the cracked specials and the counter.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F89, the founder's notes on the example boxes; F109 R25C,
  the toads' part in the box token; F118 to F120, the simpler core; F122, the 7-day escape and the failure claim;
  F123, listing raises; F127, claim-only payouts; F133, own boxes listed by address.
- [Step 1 design](../../../docs/design/core-v21-step1-eat.md) and
  [step 2 design](../../../docs/design/core-v21-step2-pay-in-t.md): eating the price coin, burned or locked, and items
  paid in the box token.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol),
  [receiver](../../../packages/contracts/src/box-v2/BoxReceiverV2.sol) and
  [its callback part](../../../packages/contracts/src/box-v2/BoxReceiverV2Extension.sol): 10, 2 and 3 parts of 15, the
  eat step and its checked burn, the buy step for the toads, the inside share burned, tips and the failure route.
- [Listings](../../../packages/contracts/src/box-v2/ListingRegistry.sol): the checked-burn listing and its test burn.
- [Item ledger](../../../packages/contracts/src/box-v2/ItemLedgerV2.sol): equal parts, tickets on the way out,
  owner-only claims of one toad, KILN that stays with the toad, and the burned leftovers.
- [Vault](../../../packages/contracts/src/box-v2/BoxVaultV2.sol),
  [quotes](../../../packages/contracts/src/box-v2/libraries/VaultViews.sol) and
  [tickets](../../../packages/contracts/src/box-v2/BoxTicketsV2.sol): tickets, draws, picks from the shelf, the 1% and
  5% fees, the last toad, reveals and the 30-day fallbacks.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [launch router](../../../packages/contracts/src/box-v2/BoxLaunchRouterV2.sol): the 1% fee on both sides, the
  locked liquidity, the 6.4-minute window and its tax table.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): failing a box and the year-long claim.
- [Keeper plan](../../../packages/keeper/src/plan.ts): the eat step, the buy step and the burns.
- [Counsel pack](../../../docs/legal/counsel-pack-2026-10.md): questions 8, 31 and 34.
