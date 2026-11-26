# What is in the One Dollar is all you need box

A token called 1, priced in USDC, with exactly one USDC inside the box as its coin pile. That one USDC is the dollar,
and the pictures show it as a cartoon bill, framed under glass. Every fee is paid in USDC. On both sides, the fee's
main share buys the token in the box's own pool and burns it. No part of any fee goes into the coin pile, so fees never add
to the dollar. After graduation, anyone who holds the token can burn it to take its slice of the dollar. The site's words for
these are the Coin pile, the fee choice Burn, and Redeem.

## The settings in plain words

These are the settings in [one-dollar.json](../../../packages/box-spec/examples/v2/one-dollar.json), explained with the
[registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change them after the box is created.
This page explains them. It quotes no market amounts.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `One Dollar is all you need`, `1` | The founder's choice. The name takes 26 of the contract's 32 bytes and the ticker 1 of its 11. Neither is cleared. |
| Status | `ready` | The local contract test of this box passes. Its browser test has not run yet, because the test machine refused the local port it needed. Nothing is deployed. |
| Template | `pile` | The creator starts from the Coin pile template, "Token · Coin pile" on the create page. That template burns on both sides, which is exactly this box. |
| Price coin | `USDC`, `6` decimals | The fees, the raise, the dollar in the box and any failure claim are all in USDC. |
| Contents | `pile`, size `0` | A coin pile. It holds one coin, USDC, and no items. |
| Seed | `USDC`, `1000000` | The creator puts exactly one USDC of their own into the box before trading opens. The file writes it in USDC's smallest unit, with 6 decimals, so `1000000` is one USDC. Trading cannot open until it is in. |
| Leave-behind | not set | Nothing stays behind when someone takes a slice. A slice is the exact share, rounded down. |
| Pick fee | `0` | There are no items, so there is nothing to pick. |
| Raise | `listing-fixed` | Square Hole's USDC listing sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `30` days | The raise has 30 days to fill, counted from when trading opens. |
| Royalties | `0`, none | There is no collection, so there are no royalties. |
| Buyers' fees | `burn` | The buyers' share buys the token in the box's own pool and burns it. |
| Sellers' fees | `burn` | The sellers' share does the same. |
| Creator buy | zero | The creator buys nothing at launch (registry notes). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | six properties | The test proves that no fee goes missing (`fee-conservation`), the page shows the right state (`page-state`) with the box's own pictures (`own-pictures`), the box graduates (`graduation`), burns make the supply smaller (`supply-burn`), and a slice pays exactly its part of the dollar (`pile-pro-rata`). |

## The ticker 1

The founder chose the ticker 1, knowing its trade-offs.

- On X a cashtag must start with a letter, so the ticker 1 cannot be a cashtag.
- Wallets show amounts as `500,000 1`.
- Chart sites may put a dollar sign in front of the ticker, where it reads as a price.
- A bare 1 in a post can read as a number, so every post says what the token 1 is.

## Where each fee goes

Every trade pays a 1% fee in USDC. A buy pays it on the USDC going in. A sale pays it on the USDC coming out.

The fee is split into 15 equal parts.

- **10 parts** follow the box's choice for that side. Both sides of this box burn, so these parts buy the token and burn it.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding waits and joins the next fee on the same side.

**The collect step.** Fees reach the box in batches. Anyone can run the step that collects a batch, and Square Hole's
keeper is built to run it once a batch is big enough. Whoever runs it may keep a tip from the buyers' fees in the
batch, at most 5% of them and never more than a cap set for each box. The tip comes off before the split.

**The 10 parts buy the token and burn it.** They wait in the box while the raise fills. After graduation, anyone can run the
burn step. One step buys tokens with waiting USDC in the box's own pool and burns every token it bought. The USDC it
spends stays in the pool. Each step is small. It stops once it has moved the pool's price by about half a percent, and
at most one such step runs in a block, shared with the step that deepens the pool. A step also waits until enough USDC
is waiting. Whoever runs a step may keep a tip of up to 5% of what the step spends, under a cap set for each box. If a
burn is refused, the bought tokens wait, and anyone can run the burn again.

**The pool's 2 parts.** After graduation, anyone can run the step that adds them, and its runner may keep a tip of at
most 5% of what the step moves. About half of the USDC buys tokens in the pool, and then the USDC and the tokens go in
together as liquidity the box owns. The pool refuses every attempt to add outside liquidity or to take liquidity out.

**Nothing reaches the dollar.** Neither side's choice sends anything to the coin pile. The box holds only what the
creator put in, unless someone sends USDC to it on purpose, as the next section says.

**When nothing happens.** Fees only come from trades. There is no schedule.

**The launch window.** For the first 6.4 minutes after the box opens, every buy goes through the launch router and
pays a launch tax on top of the fee. The tax starts at about 93% and drops every 12 seconds, down to about 8% in the
last step, and then ends. It goes into the box's own pool after graduation, or into the failure claim if the box
fails.

## The dollar in the box

- The creator is the seeder, and nobody else can be. The creator lets the pile take exactly one USDC from their own
  wallet. Then anyone can run the step that pulls it in, and Square Hole's keeper is built to run it. The keeper never
  pays the seed itself.
- Trading cannot open until the dollar is in. If it never comes, anyone can fail the box 14 days after its planned
  opening.
- While the box lives, nobody can take USDC out of the pile except by burning the token for a slice after graduation. The
  pile has no owner, no rescue and no way to withdraw.
- Anyone can send USDC straight to the pile. It cannot be taken back, and it becomes part of the dollar for every
  slice. Any other coin sent to the pile is lost for good.
- If the box fails, the creator gets the one USDC seed back, in a separate step anyone can run and retry. Anything else
  sent to the pile stays there for good.
- The bill in the pictures is a drawing of that one USDC. There is no paper note anywhere in the box.

## Taking a slice of the dollar

After graduation, anyone who holds the token can burn some or all of it at the pile and take its slice of the dollar.

- A slice is the dollar times the tokens you burn, divided by all the tokens there are. In the founder's words
  (F109), a holder can "burn a percentage of T to get the same percentage of P", where T is the token 1 and P is USDC.
- All the tokens there are include the tokens in the box's own pool and in every wallet, counted at the moment you
  burn. There are one billion tokens at the start, and burns make that number smaller.
- Nothing stays behind (F110). You receive the whole slice, rounded down to USDC's smallest unit, a millionth of a
  dollar. Any rounding stays in the pile.
- At the start, it takes a thousand tokens to make one millionth of a dollar. A burn smaller than that pays nothing,
  and the tokens are still gone. You set the least USDC you will accept, and the burn is refused if the slice would be
  less. Square Hole's page sets that least amount to the quoted slice and will not send a burn whose slice is zero.
- On Square Hole's page, taking a slice takes two transactions. The first lets the pile take the tokens, and the
  second burns them.
- One rule covers the very end. If one burn takes every token that exists, that burn takes the whole dollar. While the
  box's own pool holds tokens, nobody holds all of them.
- The USDC goes to the address you choose. A burn is final.
- There is no deadline. A slice can be taken at any time after graduation.
- Before graduation, the page can show what a slice would be, but nobody can take one.

## What a holder gets

**A holder of the token** holds the box token.

- After graduation, The token can be burned for its slice of the dollar. While the box lives, that is the only way USDC
  leaves the pile.
- No holder is paid fees. On both sides, ten of every 15 fee parts buy the token and burn it.
- When the fees burn tokens, the same dollar is shared by fewer tokens. When someone takes a slice, their tokens are
  burned and the dollar gets smaller by the same share, so every other token's slice stays the same, apart from
  rounding that stays in the pile. None of this says anything about the price of the token in the pool.
- The price of the token in the pool and its slice of the dollar are two different numbers. Nothing keeps them close.
- If the box fails, nobody can take a slice. The seed goes back to the creator, and holders claim their part of the
  closing pot. See the risks below.

**An item owner.** This box has no items.

## Risks in plain words

- The token is 1. It is not a dollar and not a stable coin. It can lose all its value, and there may be no buyer when
  you want to sell.
- The dollar does not hold up the price of the token. At the start, each token's slice is a billionth of a dollar.
- USDC can lose its link to the dollar, and its issuer can freeze addresses, the pool and the pile included. The fees,
  the raise, the dollar and any failure claim are all in USDC.
- The whole pile is one dollar, so every slice is small. Taking one costs gas, and the gas can cost more than the
  slice.
- A burn too small for USDC's smallest unit pays nothing, and the tokens are gone anyway, unless the least amount is
  set above zero.
- No fee goes into the coin pile, so fees never add to the dollar. It only gets smaller as slices are taken, unless
  someone sends USDC to it.
- Burn steps are small and wait for a minimum, so burns can lag behind fees. Whoever runs a burn step or the collect
  step may keep a small tip.
- Trading opens only once the creator puts the dollar in. If it never comes, anyone can fail the box 14 days after its
  planned opening.
- Before graduation nobody can take a slice. The raise can miss its 30 days, and then the box fails. If the raise fills
  but the box has not graduated 7 days later, anyone can fail it too. After a failure, the seed goes back to the
  creator, and the waiting burn money, the pool's waiting parts and the launch tax join the closing pot. Holders claim
  their part of what is left. That is not a promise to get everything back. Failure claims close a year after the
  failure, and what is left after that goes to Square Hole's buy-back.
- These contracts have internal reviews and tests. They have had no outside audit.
- Anyone can copy the name, the ticker and these pictures, and other tokens may use 1 too. Check the chain and
  the full contract address every time.

## What still waits

**For counsel**

- The pile. Burning a token for an exact share of a pile of coins may read as a fund share. The core plan flags the
  coin pile this way, and the counsel pack asks about it in question 34
  ([counsel pack](../../../docs/legal/counsel-pack-2026-10.md)).
- The name. "One Dollar is all you need" names a real currency, and the box is priced in a dollar stable coin. Counsel
  should confirm that the name and the joke read as satire and do not suggest that the token is a dollar or follows a
  dollar's price.
- The ticker. It is the digit 1, so it can read as a number, or as a price where a site puts a dollar sign in front. It has not been checked against other names
  and marks.
- The bill. The pictures show a cartoon one-dollar bill. It follows the bill rules in the brand book's homage and IP
  section, and counsel should confirm that the cartoon is fine to publish and to use on X.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For a v2.1 step**

Nothing. This box only burns, and its pile holds only the seed, which today's coin pile already does. The v2.1 steps in
the registry are eating the price coin, paying items in the box token, and sending fees into a pile. This box uses none
of them.

**For the site**

- The create page's Coin pile template already matches this box. It burns on both sides, and the creator picks USDC
  as the seed coin and a seed of exactly one.
- The create page checks the ticker only against the spec's rule, 1 to 11 bytes of plain characters, so it takes 1.
- The box page writes the ticker as it is. Its coin pile panel reads `Per 1`, `1 out` and `1 to redeem`, and its
  amounts end in a bare 1. A site step could name the token in words there, as "the token 1".
- That panel's Per figure is the pile times one token divided by the supply, rounded down to USDC's smallest unit.
  For this box it reads zero at the start, because one token's slice is smaller than that unit. A site step could
  show "less than a millionth of a USDC" instead.

**For the launch**

- The registry still points at local test pictures. Using this art needs the metadata and hosting step.
- On Sepolia the intended price coin is tUSDC, an unbacked test stand-in. The settings pile follows the selected price coin and seeds exactly one unit in its decimals. Bind the tUSDC listing before launch; the unbound template uses one ETH solely to preserve that follow-price relationship through Load settings.
- The creator lets the pile take the seed in their own transaction. Square Hole's keeper never pays it for them.
- Every live page shows the chain and the full contract address. When Square Hole launches the box itself, the address
  also goes on its list of own boxes (F133). Until then the line reads "Contract: not deployed".

## Sources

- [one-dollar.json](../../../packages/box-spec/examples/v2/one-dollar.json) and the
  [registry notes](../../../packages/box-spec/examples/v2/README.md): the settings, the exact one-USDC seed, creator
  buy and test lives.
- [Box spec](../../../packages/contracts/src/box-v2/BoxSpecV2.sol): a name of 1 to 32 bytes and a ticker of 1 to 11
  bytes, each byte a printable character other than a double quote or a backslash.
- [Examples test record](../../../docs/evidence/SH-V21-EXAMPLES-E2E.md): the One Dollar contract life passes (exact
  USDC seed, graduation, the slice rule, supply burns), and the browser lives were blocked by the local port.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F109 and F110, the slice rule and no leave-behind; F118 to
  F120, fees in the price coin and one choice per side; F122, the 7-day escape and the failure claim; F123, listing
  raises; F127, no rescue on a coin pile and the creator as its seeder; F133, own boxes listed by address.
- [Core v2 plan](../../../docs/design/core-v2-plan.md), section 2 and the scale test in section 5: the coin pile
  block, the one-dollar box as a USDC pile, and the coin pile flagged for counsel.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol): `_splitSource` gives 10, 2 and 3 parts of
  15, books Burn as buy-back money, and carries the rounding dust.
- [Receiver](../../../packages/contracts/src/box-v2/BoxReceiverV2.sol): the collect tip, `buyBack` with its minimum,
  tip and burn, the retry, and where waiting money goes on failure.
- [Pile](../../../packages/contracts/src/box-v2/PileVaultV2.sol): the creator as seeder, the exact seed pulled before
  opening, the slice formula on the live balance, the last holder, the least amount, and the seed going back after a
  failure.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [launch router](../../../packages/contracts/src/box-v2/BoxLaunchRouterV2.sol): the 1% fee on both sides, the locked
  liquidity, the 6.4-minute window and its tax table.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): the opening gate that waits for the seed,
  failing a box, graduation moving the box's tokens into the pool, and the year-long claim.
- [Coin pile panel](../../../apps/web/src/features/core/v2/CoinPileV2.tsx) and
  [its actions](../../../apps/web/src/features/core/v2/m3-actions.ts): the Per figure, the labels that show the
  ticker, Redeem with the exact quote as its least amount, and the two transactions.
- [Create page templates](../../../apps/web/src/features/create/v2/templates.ts),
  [the basics step](../../../apps/web/src/features/create/BasicsStep.tsx) and
  [its checks](../../../apps/web/src/features/create/reason-copy.ts): the Coin pile template that burns on both sides,
  and a ticker field that checks only the spec's 1 to 11 bytes and its characters.
