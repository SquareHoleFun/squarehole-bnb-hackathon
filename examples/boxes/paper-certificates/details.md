# What is in the Paper Certificates box

A token called SCRIP and a new collection of 1,929 joke share certificates, sealed until drawn. The first edition,
Gold Certificates, uses Test Gold (tGOLD) in the test app, a test stand-in with no gold backing. The later edition, Paper Certificates, is
priced in the index coin, a token that follows a fund of a big stock index. Every fee is paid in the price coin, and
the two sides go to different places. The buyers' share of each fee buys SCRIP in the box's own pool and burns it.
The sellers' share buys SCRIP too, and that SCRIP is shared equally by all 1,929 certificates. A certificate out of the
box keeps its part for its owner to claim. The part of a certificate still inside the box is burned. No fee ever burns
the gold coin or the index coin. The site calls the certificates "items", the place where they wait "the vault", the
buyers' choice "Burn", the sellers' choice "To items" paid in the box token, and the rule for certificates in the vault
"Burn".

The idea comes from Square Hole's research on stock coins and memes
([round 2b](../../../docs/research/round2b-stonks-rwa-memes-defi.md)). It brought back the paper share certificate as
1,929 joke certificates priced in the token that replaced it, with a gold edition as the stand-in. The founder answered
"Not sure we want to burn stocks" (F89), and the check that followed kept the stock coin out of every burn. The buyers'
coins buy SCRIP and burn it, and the certificates get their part in SCRIP
([F89 check](../../../docs/research/core-v2-m1-inputs/f89-check.json)). His answer R25C (F109) let that stand. A later
simplification of the core took item payouts out ([Occam check](../../../docs/reviews/OCCAM-CHECK-2026-10-08.md)), and
step 2 of v2.1 brings them back in the box token. The founder's notes for this kit asked for creative certificates,
the gold edition first, and no stock ever burned. This kit follows them.

## The settings in plain words

These are the settings in [paper-certificates.json](../../../packages/box-spec/examples/v2/paper-certificates.json),
explained with the [registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change them after the
box is created. This page explains them. It quotes no market amounts.

The row uses Test Gold (`TEST_GOLD`, symbol tGOLD), the TA-30 test stand-in. Its offline contract life
proves creation, the curve, graduation, a hidden draw and reveal, item payouts and custody. Nothing
in the kit deploys a box or claims that a live listing or browser launch has passed.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `Gold Certificates`, `SCRIP` | The first edition's name. Scrip is the old word for a share certificate. SCRIP is not cleared, and other tokens may use it. |
| Status | `ready` | The offline contract life passes. Nothing is deployed by this kit. |
| Template | `collection-burn` (`Collection that burns`) | The creator starts from "NFTs · To items · Burn" on the create page and changes the buyers' side to Burn. |
| Price coin | `TEST_GOLD`, `18` decimals | Test Gold (tGOLD), a test stand-in without gold backing. The later index edition needs its own listing. |
| Contents | `collection` of `1929` `Certificates` | 1,929 new NFTs with ids 1 to 1,929, in twelve pictures: nine companies of 213 certificates and three blue chips of 4. |
| Art | `hidden` | Every certificate stays sealed until it is drawn. Its picture shows once its entry from the creator's reveal file is posted. |
| Seed | none | Nothing else goes into the box when it is created. |
| Pick fee | `100` basis points | Taking a certificate you choose by its number costs 1% more SCRIP, and that extra SCRIP is burned. Only certificates that came back to the box after their reveal can be picked by number. |
| Raise | `listing-fixed` | The price coin's listing sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `30` days | The raise has 30 days to fill. |
| Royalties | `0`, `none` | Selling a certificate on a marketplace pays no royalty. |
| Buyers' fees | `burn` | The buyers' share buys SCRIP in the box's own pool and burns it. This runs on today's contracts. |
| Sellers' fees | `items-t`, inside `burn` | The sellers' share buys SCRIP in the box's pool, and the certificates get SCRIP. The share of certificates still inside is burned. |
| Creator buy | zero | The creator buys nothing at launch (registry notes). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | `fee-conservation`, `page-state`, `own-pictures`, `graduation`, `supply-burn`, `item-claim` | Once its lives exist, they prove that no fee goes missing, the page shows the right state with the box's own pictures, the box graduates, burns make the supply smaller, and a certificate's owner can claim its exact part. |

The box never picks the fee choice `eat`, so it needs no listing with a checked burn. The gold coin and the index coin
only change hands.

## Where each fee goes

Every trade pays a 1% fee in the price coin. A buy pays it on the coins going in. A sale pays it on the coins coming
out.

The fee is split into 15 equal parts.

- **10 parts** follow the box's choice for that side. Buyers' parts buy SCRIP to burn, and sellers' parts buy SCRIP for
  the certificates.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding goes to the pool while the box is live.

**The buyers' 10 parts, SCRIP to burn.** They wait in the box until it graduates. Then anyone can run the buy step.
It spends waiting price coin on SCRIP in the box's own pool and burns all the SCRIP it bought. The price coin stays in
the pool, where the next person who sells SCRIP may get it. If a burn is refused, the SCRIP waits, and anyone can run
the burn again.

**The sellers' 10 parts, SCRIP for the certificates.** They also wait in the price coin until the box graduates. Then
the same buy step spends them on SCRIP, taking turns with the buyers' share. The SCRIP from each step is split into
1,929 equal parts, one for each certificate, counted at that moment. The parts of certificates out of the box go to
them. The parts of certificates still inside are burned, and so are the leftovers from rounding.

- Whoever runs a buy step may keep a tip of at most 5% of what it spends, under a cap set for each box.
- A step waits until enough coins have gathered, takes at most one step in a block, shared with the step that deepens
  the pool, and moves the pool's price by at most about half a percent. A big heap of coins is bought in several steps.
- Square Hole's keeper is built to run the buy steps, the burns that follow them and the burn of rounding leftovers.

**A certificate on its way out.** A certificate counts as out of the box from the moment its ticket is taken or its
draw is asked for. Its part waits on the ticket and moves to the certificate when the ticket opens. A ticket handed
back gives up its part, and that part is burned.

**The collect step.** Fees reach the box in batches. Anyone can run the step that collects a batch, and Square Hole's
keeper is built to run it once a batch is big enough. Whoever runs it may keep a tip from a buyers' batch, at most 5%
of it and never more than a cap set for each box. The tip comes off before the batch is split.

**The pool's 2 parts.** After graduation, anyone can run the step that adds them, and its runner may keep a tip of at
most 5% of what the step moves. About half of the price coin buys SCRIP in the pool, and then the price coin and the
SCRIP go in together as liquidity the box owns. The pool refuses every attempt to add outside liquidity or to take
liquidity out.

**When nothing happens.** Fees only come from trades. There is no schedule. No trades means nothing to burn and no
SCRIP for the certificates.

**The launch window.** For the first 6.4 minutes after the box opens, every buy goes through the launch router and
pays a launch tax on top of the fee. The tax starts at about 93% and drops every 12 seconds, down to about 8% in the
last step, and then ends. It goes into the box's own pool after graduation, or into the failure claim if the box
fails.

## What each owner gets

**A SCRIP holder** holds the box token. The fees go to the burn and the certificates, so holding SCRIP gives no share of
them. SCRIP is how a certificate leaves the box.

- **A ticket during the raise.** Anyone can take a ticket for a certificate with SCRIP while the raise fills. When the
  box graduates, one public random number decides which certificate every ticket gets, and the ticket opens into it. A
  ticket can be handed back during the raise for one certificate's share of SCRIP at that moment, rounded down, less a
  5% fee that is burned.
- **A draw after graduation.** A draw takes one certificate still sealed in the box. A public random number picks it,
  after the draw is asked for. A draw also sends a little ETH to pay for posting that random number, and the first draw
  in each round pays it for the others.
- **A pick by number.** Certificates that came back to the box after their reveal wait on a shelf in the vault, and
  anyone can pick one of them by its number.
- **The price.** A ticket, a draw or a pick costs the SCRIP outside the vault divided by the certificates still inside,
  rounded up, plus a 1% fee. The fee is burned, and the price stays in the vault, held for that certificate.
- **Putting a certificate back.** Its owner gets one certificate's share of SCRIP at that moment, rounded down, minus a
  5% fee that is burned. This can be more or less SCRIP than was paid. A certificate can come back once it is
  revealed, or 30 days after it left the box unrevealed.
- The last certificate always stays in the vault.
- Quotes move between the moment you look and the moment you sign. Every ticket, draw, pick and put-back has a limit
  you set and a deadline.

**Opening a certificate.** A certificate opens with its entry from the creator's reveal file. That entry proves its
picture was fixed before the box was created. The creator keeps the file and has to post the entries, by hand or with
a bot. If no entry is posted, the owner can open the certificate without its picture after 30 days, and the picture
shows whenever its entry is posted.

**A certificate owner** owns the NFT and its picture, with its own number, and can claim the SCRIP the certificate
collected while it was out of the box.

- Only the current owner can claim, one certificate per claim, and only while it is out of the box. There is no
  minimum, no tip and no time limit. The owner pays the gas.
- The SCRIP stays with the certificate. Sell or give the certificate away, and the unclaimed SCRIP goes with it.
- Put the certificate back in the box, and its unclaimed SCRIP stays with it for whoever takes it out next. So claim
  first.
- Sometimes a claim has to wait for the fee records to catch up. Anyone can run that catch-up, and nothing is lost
  while it waits.
- Every certificate gets the same part, blue chip or not. Twelve pictures repeat across 1,929 certificates, and a
  picture changes nothing about the fees or the box.
- A certificate is a picture. It is no share in any company and no claim on gold, a stock or a fund. On the real box
  a certificate is paid only in SCRIP, never in the gold coin or the index coin.

## Risks in plain words

- SCRIP and the certificates can lose all their value. There may be no buyer when you want to sell.
- A draw is random, and so is the certificate a ticket opens into. Most certificates are one of the nine companies, and
  12 of the 1,929 are blue chips. The certificate you get can sell for much less than the SCRIP and the fee you paid,
  or not sell at all.
- A burn makes the supply of SCRIP smaller. It sets no price and protects no value, and it gives nothing back to anyone
  who holds the gold coin or the index coin.
- The price coin is a token its issuer runs. The gold coin's issuer can pause it, freeze an address, wipe a frozen
  balance and change its contract. The index coin's issuer can pause all its coins at once, block addresses, change
  its compliance rules and change its contract. One such action can stop this box, and trades, steps and claims then
  wait until it ends. The box page shows the powers it can read from the coin's contract.
- The index coin may not be offered to US persons, and its issuer limits who may hold it in other places too.
- The price coin's value can fall too, and the raise and any failure claim are paid in it.
- Each fee's certificate share is split 1,929 ways, so one certificate's part of a single fee is very small, and the gas
  to claim can be larger than the part.
- A certificate inside the box gets nothing. Its part is burned.
- The pictures depend on the creator's reveal file. If it were lost, certificates could still be opened and put back
  after 30 days, but their pictures could never show.
- The raise can miss its 30 days, and then the box fails. If the raise fills but the box has not graduated 7 days
  later, anyone can fail it too. After a failure nothing is swapped and nothing is burned. The coins waiting on both
  sides join the closing pool, and the certificates in the box that no ticket holds go back to the creator. Tickets can
  be handed back for SCRIP at the price fixed at the failure, with no fee, for 14 days. Holders hand in SCRIP to claim
  their part of what is left. That is no promise to get everything back. Failure claims close a year after the
  failure, and what is left after that goes to Square Hole's buy-back.
- Taking a certificate out ties up SCRIP in the vault, and putting it back costs 5% of the certificate's share.
- The name Gold Certificates is a joke. A certificate can never be traded in for gold.
- These contracts have internal reviews and tests. They have had no outside audit so far.
- Anyone can copy the name, the ticker and these pictures. Check the chain and the full contract address every time.

## What still waits

**For counsel**

- The certificates as joke shares. Each one looks like an old share certificate and says THIS CERTIFIES NOTHING.
  Counsel should confirm that the pictures, the "not a share" line and the invented companies read as a joke and
  suggest no real share or security.
- The names. Gold certificate was once the name of real paper money, and the box promises no exchange for gold.
  Counsel should confirm the names Gold Certificates and Paper Certificates. The twelve company names and SCRIP have not
  been checked against other names and marks.
- The word coupon. In finance a coupon can mean a payment. The kit uses the word only for the picture of SCRIP, always
  with SCRIP next to it. Counsel may prefer another word, such as slip.
- Paid random draws. A ticket or a draw costs SCRIP and a fee, a public random number decides the certificate, and 12
  of the 1,929 are blue chips. Question 8 of the [counsel pack](../../../docs/legal/counsel-pack-2026-10.md) asks how
  paid random draws are treated, which places to restrict and whether the answer differs for boxes others create.
- The certificates' part of the fees. A certificate out of the box collects SCRIP, and it can be sold with its
  unclaimed SCRIP. Question 34 asks whether item payouts are a tradable revenue right.
- The price coins. The box is priced in tokens that Square Hole would list. Question 31 asks whether listing a coin
  creates responsibility for it, question 32 asks about tokenized stocks as price coins, and question 33 about the
  disclosure of issuers' powers.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For v2.1 and the listings**

This box uses step 2 of v2.1, which this line has. It does not need step 1. It still needs its local lives, and the
later edition needs a listing for the index coin.

- Step 2, pay in the box token. The contract code is on this line. The buy step buys SCRIP for the certificates,
  credits the certificates out of the box and burns the share of those inside
  ([step 2 design](../../../docs/design/core-v21-step2-pay-in-t.md)).
- The site. The create page offers "To items" paid in the box token.
- The registry. The row is `ready` with Test Gold, buyers Burn and sellers paid in SCRIP. The local contract
  life passes; browser execution and the live listing remain integration checks.

- The listings. Square Hole lists the gold coin on the local test stack, with its route to ETH. The index coin needs its own listing and
  a pool deep enough to carry a raise, which is why the gold edition comes first. A test network has neither coin, so a public
  test run needs a stand-in coin with a pool to trade it in.

**For the launch**

- Hidden art. Load the template and its plan file, then the twelve specimen-0 variant pictures and `plan.csv`, as the
  [README](README.md) shows. Create deals fresh numbers and salts. Save its reveal file privately and decide who posts the reveals.
- The create page's texts. Add the special series "Blue chip" with the count 12. For the ticket, the line could read
  "A ticket for one sealed certificate. It opens once its number is drawn." For a sealed certificate, "Still sealed.
  This certificate shows once it is drawn." The collection page can show up to four teasers. This kit suggests the
  certificates 01 Bagholder & Sons, 06 Sideways Crab Shipping Co., 08 Dip Buyers Fondue Co. and 10 Blue Chip Chip Shop.
- The hidden picture. The template carries `art/hidden.svg` as one line. Create keeps it, and the new box commits it
  in the placeholders add-on.
- The registry still points at local test pictures. Using this art needs the metadata and hosting step, and the
  deployed collection must use ids 1 to 1,929.
- Two editions. Each edition is its own box. If Gold Certificates is live when Paper Certificates launches, two boxes
  named SCRIP would confuse people, so the second one takes its own ticker.
- Every live page shows the chain, the full contract address, the "not affiliated" line and the "not a share" line.
  When Square Hole launches the box itself, the address also goes on its list of own boxes (F133). Until then the line
  reads "Contract: not deployed".

## Sources

- [paper-certificates.json](../../../packages/box-spec/examples/v2/paper-certificates.json) and the
  [registry notes](../../../packages/box-spec/examples/v2/README.md): the settings, the creator buy and the test life.
- [Round 2b research](../../../docs/research/round2b-stonks-rwa-memes-defi.md), the Paper Certificates entry: the idea,
  1,929 certificates, joke companies, the blue chips, sealed envelopes and the gold stand-in.
- [F89 check](../../../docs/research/core-v2-m1-inputs/f89-check.json): no stock burned, the buyers' coins buy SCRIP and
  burn it, the certificates paid in SCRIP from the sellers' side.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F88, stock coins as price coins; F89, the founder's notes on
  the example boxes; F109 R25C, his answers stand; F122, the 7-day escape and the failure claim; F127, claim-only
  payouts; F133, own boxes listed by address.
- [Step 2 design](../../../docs/design/core-v21-step2-pay-in-t.md): items paid in the box token.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol) and
  [receiver](../../../packages/contracts/src/box-v2/BoxReceiverV2.sol): 10, 2 and 3 parts of 15, the buy step, the burn,
  the certificates' part, the inside share burned, tips and the failure route.
- [Item ledger](../../../packages/contracts/src/box-v2/ItemLedgerV2.sol): equal parts, tickets on the way out,
  owner-only claims of one certificate, SCRIP that stays with the certificate, and the burned leftovers.
- [Vault](../../../packages/contracts/src/box-v2/BoxVaultV2.sol),
  [quotes](../../../packages/contracts/src/box-v2/libraries/VaultViews.sol) and
  [tickets](../../../packages/contracts/src/box-v2/BoxTicketsV2.sol): tickets, draws, picks from the shelf, the 1% and
  5% fees, the last certificate, reveals and the 30-day fallbacks.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [launch router](../../../packages/contracts/src/box-v2/BoxLaunchRouterV2.sol): the 1% fee on both sides, the
  6.4-minute window and its tax table.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): failing a box and the year-long claim.
- [Keeper plan](../../../packages/keeper/src/plan.ts): the buy steps, the burns and the leftover burn.
- [Counsel pack](../../../docs/legal/counsel-pack-2026-10.md): questions 8, 31, 32, 33 and 34.
