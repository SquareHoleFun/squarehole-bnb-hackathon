# What is in the Dragon's Hoard box

A token called HOARD, priced in ETH, with a pile of ETH inside the box. Every fee is paid in ETH. The buyers' share
of each fee is kept for the pile and goes onto it after graduation. The sellers' share buys HOARD in the box's own
pool and burns it. After graduation, anyone who holds HOARD can burn it to take its share of the pile, and 5% of that
share stays on the pile. The site's words for these are the Coin pile, the fee choices To the pile and Burn, and the
Leave behind rule.

## The settings in plain words

These are the settings in [dragons-hoard.json](../../../packages/box-spec/examples/v2/dragons-hoard.json), explained
with the [registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change them after the box is
created. This page explains them. It quotes no market amounts.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `Dragon's Hoard`, `HOARD` | A fixture choice. Neither is cleared, and other tokens may use HOARD. |
| Status | `ready` | The local test life runs on the v2.1 contracts in this branch. Nothing is deployed. |
| Template | `pile` | The creator starts from the Coin pile template, "Token · Coin pile" on the create page. That template burns on both sides. This box changes the buyers' side to To the pile and picks the 5% leave-behind, two choices the create page does not offer yet. |
| Price coin | `ETH`, `18` decimals | Plain ETH. The fees, the raise, the pile and any failure claim are all in it. |
| Contents | `pile`, size `0` | A coin pile. It holds one coin, the price coin, and no items. |
| Seed | `ETH`, `1000000000000000000` | The creator puts one ETH of their own on the pile before trading opens. The file writes it in the coin's smallest unit, with 18 decimals. Trading cannot open until the seed is in. |
| Leave-behind | `500` basis points | Whoever burns HOARD for a share leaves 5% of that share on the pile. The only other choice at creation is `0`. |
| Pick fee | `0` | There are no items, so there is nothing to pick. |
| Raise | `listing-fixed` | Square Hole's ETH listing sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `30` days | The raise has 30 days to fill, counted from when trading opens. |
| Royalties | `0`, none | There is no collection, so there are no royalties. |
| Buyers' fees | `pile` | The buyers' share waits for the pile and goes onto it after graduation. |
| Sellers' fees | `burn` | The sellers' share buys HOARD in the box's own pool and burns it. |
| Creator buy | zero | The creator buys nothing at launch (registry notes). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | six properties | The test proves that no fee goes missing (`fee-conservation`), the page shows the right state (`page-state`) with the box's own pictures (`own-pictures`), the box graduates (`graduation`), burns make the supply smaller (`supply-burn`), and a share pays exactly its part of the pile less the 5% (`pile-pro-rata`). |

## Where each fee goes

Every trade pays a 1% fee in ETH. A buy pays it on the ETH going in. A sale pays it on the ETH coming out.

The fee is split into 15 equal parts.

- **10 parts** follow the box's choice for that side. The buyers' parts go to the pile, and the sellers' parts go to
  the burn.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding waits and joins the next fee on the same side.

**The collect step.** Fees reach the box in batches. Anyone can run the step that collects a batch, and Square Hole's
keeper is built to run it once a batch is big enough. Whoever runs it may keep a tip from the buyers' fees in the
batch, at most 5% of them and never more than a cap set for each box. The tip comes off before the split.

**The buyers' 10 parts go to the pile.** They wait in the box while the raise fills, like coins in a closed chest,
and they count for nobody's share yet. After graduation, anyone can run the step that moves them onto the pile, and
Square Hole's keeper is built to run it. That step has no tip. If a move is refused, the coins stay where they were,
and anyone can try again. Once coins are on the pile, they count for every share exactly like the seed.

**The sellers' 10 parts go to the burn.** They also wait until graduation. After that, anyone can run the burn step.
One step buys HOARD with waiting ETH in the box's own pool and burns all the HOARD it bought. The ETH it spends stays
in the pool, and none of it goes onto the pile. Each step is small. It stops once it has moved the pool's price by
about half a percent, and at most one such step runs in a block, shared with the step that deepens the pool. A step
also waits until enough ETH has piled up. Whoever runs a step may keep a tip of up to 5% of what the step spends,
under a cap set for each box. If a burn is refused, the bought HOARD waits, and anyone can run the burn again.

**The pool's 2 parts.** After graduation, anyone can run the step that adds them, and its runner may keep a tip of at
most 5% of what the step moves. About half of the ETH buys HOARD in the pool, and then the ETH and the HOARD go in
together as liquidity the box owns. The pool refuses every attempt to add outside liquidity or to take liquidity out.

**When nothing happens.** Fees only come from trades. There is no schedule.

**The launch window.** For the first 6.4 minutes after the box opens, every buy goes through the launch router and
pays a launch tax on top of the fee. The tax starts at about 93% and drops every 12 seconds, down to about 8% in the
last step, and then ends. It goes into the box's own pool after graduation, or into the failure claim if the box
fails.

## Taking a share of the pile

After graduation, anyone who holds HOARD can burn some or all of it at the pile and take its share.

- The share is the pile times the HOARD you burn, divided by all the HOARD there is. In the founder's words (F109),
  a holder can "burn a percentage of T to get the same percentage of P", where T is HOARD and P is ETH.
- All the HOARD there is includes the HOARD in the box's own pool and in every wallet, counted at the moment you burn.
- You receive 95% of that share. The other 5% stays on the pile for everyone still holding. Both numbers are rounded
  down, so any rounding stays on the pile too.
- The pile counts only the coins on it. Fees still waiting to be moved count for nobody until someone moves them.
  Before you burn HOARD, check that the page shows no fees waiting, or move them first. Anyone can.
- One rule covers the very end. If one burn takes every HOARD that exists, nothing stays behind and that burn takes
  the whole pile. While the box's own pool holds HOARD, nobody holds all of it.
- You set the least ETH you will accept, and the burn is refused if the share would be less. The ETH goes to the
  address you choose.
- A burn is final. The HOARD is gone for good.
- There is no deadline. A share can be taken at any time after graduation.
- Before graduation, the page can show what a share would be, but nobody can take one.

## What a holder gets

**A HOARD holder** holds the box token.

- After graduation, HOARD can be burned for its share of the pile, less the 5% that stays. That is the only way coins
  leave the pile.
- Nobody is paid fees directly. The buyers' share goes onto the pile, and the sellers' share burns HOARD.
- When the sellers' fees burn HOARD, the same pile is shared by fewer HOARD. When someone takes a share, their HOARD
  is burned too, and 5% of their part stays on the pile for the others. Neither says anything about HOARD's price in
  the pool.
- HOARD's price in the pool and its share of the pile are two different numbers. Nothing keeps them close.
- If the box fails, nobody can take a share. The seed goes back to the creator, and holders claim their part of the
  closing pot. See the risks below.

**An item owner.** This box has no items.

## Risks in plain words

- HOARD can lose all its value. There may be no buyer when you want to sell.
- ETH's value can fall too. The fees, the raise, the pile and any failure claim are all in ETH.
- A share of the pile is not a price. HOARD can trade in the pool for more or less than its share, and nothing keeps
  the two close.
- The pile gets smaller every time someone takes a share. New coins come only from buyers' fees, and only after
  graduation. With no buys, nothing new arrives.
- Fees that wait outside the pile count for nobody's share until someone moves them in.
- Taking a share leaves 5% of it behind and costs gas. For a small share, the gas can cost more than the share.
- Burn steps are small and wait for a minimum, so burns can lag behind fees. Whoever runs a burn step or the collect
  step may keep a small tip.
- Trading opens only once the creator puts the seed on the pile. If the seed never comes, anyone can fail the box 14
  days after its planned opening.
- Before graduation no fees go onto the pile and nobody can take a share. The raise can miss its 30 days, and then
  the box fails. If the raise fills but the box has not graduated 7 days later, anyone can fail it too. After a
  failure, the seed goes back to the creator, and the buyers' waiting fees and the waiting burn money join the closing
  pot. Holders claim their part of what is left. That is not a promise to get everything back. Failure claims close a
  year after the failure, and what is left after that goes to Square Hole's buy-back.
- These contracts have internal reviews and tests. They have had no outside audit. The step that lets fees reach a
  pile is new in v2.1.
- Anyone can copy the name, the ticker and these pictures. Check the chain and the full contract address every time.

## What still waits

**For counsel**

- The pile. Burning a token for an exact share of a pile of coins may read as a fund share. The core plan flags the
  coin pile this way, and the counsel pack asks about it in question 34
  ([counsel pack](../../../docs/legal/counsel-pack-2026-10.md)).
- The name and ticker. "Dragon's hoard" is a common phrase and HOARD a common word. Neither has been checked against
  other names and marks.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For a v2.1 step**

This box needs step 3 of v2.1, `V21-03`, fees into the pile. Before that step, a pile could hold only its seed. Its
contract code is merged into the v2.1 integration line, and the registry marks this row ready. The local test life
runs it. The fees wait, graduation leaves them waiting, a separate step moves them onto the pile, and a share pays
exactly 95% of its part. The step's own record still asks for a cross-review and a fresh security review before it
reaches the main line ([step 3 record](../../../docs/evidence/SH-V21-03-PILE-FEES.md),
[step 3 design](../../../docs/design/core-v21-step3-pile-fees.md)).

F110 first set every pile to pay its exact share with nothing left behind. Step 3 adds a choice fixed at creation,
0% or 5%, and this registry row picks 5%. The founder confirms the 5% for this box.

**For the site**

- On the create page, start from the Coin pile template, choose To the pile for the buyers' side and 5% at Leave
  behind (the fee menu and the pile step both offer them).
- The box page needs to show the pile, the fees still waiting, the 5% rule and a share quote in live text. That is
  part of the same site work.

**For the launch**

- The registry still points at local test pictures. Using this art needs the metadata and hosting step.
- On a test network the pile holds that network's test ETH, so no stand-in coin is needed.
- The creator sends the seed in their own transaction. Square Hole's keeper never sends it for them.
- Every live page shows the chain and the full contract address. When Square Hole launches the box itself, the
  address also goes on its list of own boxes (F133). Until then the line reads "Contract: not deployed".
- F89 records the founder's note that Dragon's Hoard "can also become a Template". The create page's Coin pile
  template burns on both sides; with To the pile for the buyers and the 5% leave-behind chosen on the create page,
  this recipe can become that template or a new one, and this kit can be its look. Naming it is the founder's choice.

## Sources

- [dragons-hoard.json](../../../packages/box-spec/examples/v2/dragons-hoard.json) and the
  [registry notes](../../../packages/box-spec/examples/v2/README.md): the settings, creator buy and test lives.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F89, Dragon's Hoard as a template; F109 and F110, the share
  rule and the first no-leave-behind default; F118 to F120, fees in the price coin and one choice per side; F122, the
  7-day escape and the failure claim; F123, listing raises; F127, claim-only payouts; F133, own boxes listed by address.
- [Core v2 plan](../../../docs/design/core-v2-plan.md), section 5: the early Dragon's Hoard plan, with buyers' fees as
  paid into the pile, sellers' fees burned, and the coin pile flagged for counsel.
- [Step 3 design](../../../docs/design/core-v21-step3-pile-fees.md) and
  [its record](../../../docs/evidence/SH-V21-03-PILE-FEES.md): fees into the pile, the 0 or 5% leave-behind, the last
  holder, failure routes and the keeper's move job.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol): `_splitSource` gives 10, 2 and 3 parts of
  15, books the buyers' parts for the pile and the sellers' parts for the burn, and carries the rounding dust.
- [Receiver](../../../packages/contracts/src/box-v2/BoxReceiverV2.sol): the collect tip, `moveToPile`, `buyBack` with
  its minimum, tip and burn, and where waiting money goes on failure.
- [Pile](../../../packages/contracts/src/box-v2/PileVaultV2.sol): the seed, the share formula, the 5% leave-behind, the
  last holder, the minimum, and the seed going back after a failure.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [launch router](../../../packages/contracts/src/box-v2/BoxLaunchRouterV2.sol): the 1% fee on both sides, the locked
  liquidity, the 6.4-minute window and its tax table.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): the opening gate that waits for the seed,
  failing a box, and the year-long claim.
- [Create page fee choices](../../../apps/web/src/features/create/v2/recipes.ts) and
  [templates](../../../apps/web/src/features/create/v2/templates.ts): the To the pile choice and the Coin pile
  template.
