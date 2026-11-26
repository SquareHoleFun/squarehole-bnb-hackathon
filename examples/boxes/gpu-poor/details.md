# What is in the GPU Poor box

A token called VRAM, priced in $NVDA, Nvidia's stock, with nothing else inside. Every fee is paid in $NVDA. On both
sides, ten of every 15 fee parts buy VRAM in the box's own pool, and that VRAM is burned. The site calls this the
Burn template, with the fee choice Burn for buyers and for sellers.

The exact price coin is NVDAon, Ondo's tokenized Nvidia stock. Nvidia and Ondo did not make, approve or endorse this
box.

## The settings in plain words

These are the settings in [gpu-poor.json](../../../packages/box-spec/examples/v2/gpu-poor.json), explained with the
[registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change them after the box is created.
This page explains them. It quotes no market amounts.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `GPU Poor`, `VRAM` | VRAM is the ticker of the original idea, because the token is the VRAM the box burns. Neither name nor ticker is cleared, and other tokens may use them. |
| Status | `ready` | The local test life runs on today's contracts. Nothing is deployed. |
| Template | `burn` | The creator starts from the Burn template, a token with both fee sides set to Burn, and keeps it as it is. |
| Price coin | `NVDAon`, `18` decimals | $NVDA, Nvidia's stock. NVDAon is Ondo's tokenized Nvidia stock, a token that follows Nvidia's shares. The fees, the raise and any failure claim are all paid in it. |
| Contents | `token`, size `0` | The token, with nothing else inside. No collection, no shop, no pile, and no item pictures. |
| Art | `none` | No item pictures. The logo in the registry is still a local test picture. |
| Seed and pick fee | none, `0` | Nothing else goes into the box, and with no items there is nothing to pick. |
| Raise | `listing-fixed` | Square Hole's listing for NVDAon sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `30` days | The raise has 30 days to fill. |
| Royalties | `0`, none | There is no collection, so there are no royalties. |
| Buyers' fees | `burn` | On buys, ten of every 15 fee parts buy VRAM in the box's own pool and burn it. |
| Sellers' fees | `burn` | On sales, the ten parts do exactly the same. |
| Creator buy | zero | The creator buys nothing at launch (registry notes). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | five properties | The test proves that no fee goes missing (`fee-conservation`), the page shows the right state (`page-state`) with the box's own pictures (`own-pictures`), the box graduates (`graduation`), and burns make the supply smaller (`supply-burn`). |

## Where each fee goes

Every trade pays a 1% fee in $NVDA. A buy pays it on the $NVDA going in. A sale pays it on the $NVDA coming
out.

The fee is split into 15 equal parts.

- **10 parts** follow the box's choice for that side. Here both sides choose Burn.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding waits and joins the next fee on the same side.

**The burn.** The 10 parts wait in the box until it graduates. After that, anyone can run the burn step. One step
sells waiting $NVDA in the box's own pool for VRAM and burns all the VRAM it bought. The $NVDA goes into the pool.
Each step is small. It stops once it has moved the pool's price by about half a percent, and at most one such step
runs in a block, shared with the step that deepens the pool. A step also waits until enough $NVDA has piled up.
Whoever runs a step may keep a tip of up to 5% of what the step spends, under a cap set for each box. Square Hole's
keeper is built to run these steps, and anyone else can too. If a burn is refused, the bought VRAM waits, and anyone
can run the burn again.

**The pool's 2 parts.** After graduation, anyone can run the step that adds them. About half of the $NVDA buys VRAM
in the pool, and then the $NVDA and the VRAM go in together as liquidity the box owns. The pool refuses every attempt
to add outside liquidity or to take liquidity out.

**What a burn does.** Burned VRAM is gone for good, so the supply gets smaller. A burn sets no price and protects
no value. The $NVDA itself is never burned. It goes into the pool, where the next person who sells VRAM may get it.

**When nothing happens.** Fees only come from trades. There is no schedule.

**The launch window.** For the first 6.4 minutes after the box opens, every buy goes through the launch router and
pays a launch tax on top of the fee. The tax starts at about 93% and drops every 12 seconds, down to about 8% in
the last step, and then ends. It goes into the box's own pool after graduation, or into the failure claim if the box
fails.

## What a holder gets

**A VRAM holder** holds the box token. Ten of every 15 fee parts go to the burn, two go into the box's own pool and
three go to Square Hole (its platform and its buy-back). Holding VRAM gives no share of them and no claim while the box
lives.

- Each burn leaves less VRAM in the world, so the VRAM you hold is a larger part of all the VRAM left. That says
  nothing about its price.
- VRAM is a memecoin. It is no share in Nvidia and no claim on one.
- There is no collection, so there is nothing to take out of a vault and nothing to claim.
- If the box fails, holders claim their part of what is left. See the risks below.

**An item owner.** This box has no items. The later GPUs would come in a separate box, described under What still
waits.

## Risks in plain words

- VRAM can lose all its value. There may be no buyer when you want to sell.
- $NVDA here is NVDAon, a token that follows Nvidia's stock. It is no share in Nvidia, and its value can fall too.
  The fees, the raise and any failure claim are all paid in it.
- Ondo can pause the stock coin. Then this box waits too. As the issuer, Ondo can pause all its stock coins at once,
  block addresses, swap its compliance rules with no waiting time, rename the coin, and upgrade the coin's contract
  after a two-hour wait. A role that can burn the coin from any address can also be granted. One such action can stop
  this box. Trades, burn steps and claims then wait until it ends.
- Not everyone may hold NVDAon. The stock coin may not be offered to US persons. Ondo bars some other countries, and
  in others it limits who may hold it.
- The kit names Nvidia and Ondo because the box is priced in Ondo's token of Nvidia's stock. Nvidia and Ondo did
  not make, approve or endorse this box.
- A burn makes the supply smaller. It sets no price and protects no value. The headline's "prop up" describes where
  the fee goes, and it makes no promise about price.
- Burn steps are small and wait for a minimum, so burns can lag behind fees. Whoever runs a step may keep a small tip
  from it.
- Before graduation nothing burns. The raise can miss its 30 days, and then the box fails. If the raise fills but
  the box has not graduated 7 days later, anyone can fail it too. After a failure, holders claim their part of what is
  left, and the burn money that was waiting joins that claim. That is not a promise to get everything back. Failure
  claims close a year after the failure, and what is left after that goes to Square Hole's buy-back.
- These contracts have internal reviews and tests. They have had no outside audit.
- Anyone can copy the name, the ticker and these pictures. Check the chain and the full contract address every time.

## What still waits

**For counsel**

- The headline. "Sell a stock to prop up a memecoin" is the founder's line. Counsel should confirm that, with the
  literal line next to it, it reads as a description of where the fee goes and promises nothing about price.
- The stock coin. The box is priced in $NVDA as NVDAon, and every fee sells a little of it in the box's pool. The
  counsel pack asks about stock coins as price coins in question 32 and about the issuers' powers in question 33
  ([counsel pack](../../../docs/legal/counsel-pack-2026-10.md)).
- The names. Version 2 names Nvidia and Ondo in text and letters $NVDA in the pictures, as the founder decided. Question
  32 already lists trademarks of stock names in box names. Counsel should confirm that naming the stock this way,
  with the not-affiliated line and no logo, is allowed, and whether Ondo's terms allow a box priced in its token to
  name it.
- The name and ticker. "GPU poor" is common slang and VRAM a common computing word. Neither has been checked against
  other names and marks.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For a v2.1 step**

This box needs none. Burn on both sides runs on today's contracts.

The GPUs needed one. The registry has a separate row, `gpu-poor-miners`
([gpu-poor-miners.json](../../../packages/box-spec/examples/v2/gpu-poor-miners.json)). It is a separate box called GPU
Poor Miners, ticker `MINERS`, priced in the same stock coin, with a collection of `100` GPUs in the test fixture. On both
sides its fees go to the GPUs, paid in that box's own token, and a GPU still inside the box keeps its share for
whoever takes it out. Paying items in the box token is step 2 of v2.1, `V21-02`, and this line has it, so the row is
`ready` and its local life runs.

The first research idea differs in two ways. It had 1,024 GPUs, and they were paid in VRAM itself. A box pays its
items in its own token or in its price coin, and this box can never get items, so GPUs paid in VRAM need a
different design. One way is a GPU box priced in VRAM, if Square Hole lists VRAM as a price coin, with its fees
going to the GPUs in that coin. Which way to go is for the founder. The kit's GPU parts work for either count, as
[art-notes.md](art-notes.md) shows.

**For the launch**

- The registry still points at local test pictures. Using this art needs the metadata and hosting step.
- A test network has no real stock coin. The local test life uses a stand-in coin with the same symbol and
  decimals, and a public test run needs one too. That stand-in is not Ondo's NVDAon and follows no stock, so a test
  page that shows this art says so.
- Every live page shows the chain, the full contract address, the US persons line, the issuer's powers and the
  not-affiliated line. When
  Square Hole launches the box itself, the address also goes on its list of own boxes (F133). Until then the line
  reads "Contract: not deployed".

## Sources

- [gpu-poor.json](../../../packages/box-spec/examples/v2/gpu-poor.json), the
  [registry notes](../../../packages/box-spec/examples/v2/README.md) and
  [gpu-poor-miners.json](../../../packages/box-spec/examples/v2/gpu-poor-miners.json): the settings, creator buy,
  test lives and the GPU row.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F88, stock coins as price coins with the issuer's pause
  named on the page; F89, the founder's line for GPU Poor, and stock boxes that sell the stock and never burn it;
  F119 and F120, one fee choice per side and fees in the price coin; F122, the 7-day escape and the failure claim;
  F123, listing raises; F133, own boxes listed by address.
- [Round 2b research](../../../docs/research/round2b-stonks-rwa-memes-defi.md): the GPU Poor idea, NVDAon and
  Ondo's powers as its issuer.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol): `_splitSource` gives 10, 2 and 3 parts
  of 15 and carries the rounding dust.
- [Receiver](../../../packages/contracts/src/box-v2/BoxReceiverV2.sol) and
  [its buy step](../../../packages/contracts/src/box-v2/BoxReceiverV2Extension.sol): `buyBack` after graduation, one
  step per block, the minimum, the tip, the burn and its retry, and where waiting money goes on failure.
- [Release constants](../../../packages/contracts/src/box-v2/interfaces/ReleaseConstantsV2.sol): the 49-tick step
  limit, the 5% tip, the half-buy depth step and the 7-day escape.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [launch router](../../../packages/contracts/src/box-v2/BoxLaunchRouterV2.sol): the 1% fee on both sides, the
  locked liquidity, the 6.4-minute window and its tax table.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): failing a box and the year-long claim.
- The founder's decision for version 2, quoted in [SH-KIT-GPU-POOR.md](SH-KIT-GPU-POOR.md): name the stock as $NVDA
  and Nvidia, and never use the logo.
