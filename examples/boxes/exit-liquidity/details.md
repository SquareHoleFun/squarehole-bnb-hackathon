# What is in the Exit Liquidity box

A token called EXIT, priced in USDC, and a new collection of 404 signs. Every fee is paid in USDC. The buyers'
share of each fee goes into the box's own pool. The sellers' share goes to the signs. The site calls the signs
"items", and the fee choice for them "To items".

## The settings in plain words

These are the settings in [exit-liquidity.json](../../../packages/box-spec/examples/v2/exit-liquidity.json),
explained with the [registry notes](../../../packages/box-spec/examples/v2/README.md). Nobody can change
them after the box is created. This page explains them. It quotes no market amounts.

| Setting | In the file | In plain words |
| --- | --- | --- |
| Name and ticker | `Exit Liquidity`, `EXIT` | A fixture choice. The name and ticker are not cleared, and other tokens may use EXIT. |
| Status | `ready` | The local test life runs on today's code. Nothing is deployed. |
| Starting template | `liquidity` | The creator began from the Liquidity token template, where both sides grow the pool. Then the box got 404 signs and the sellers' share went to them. |
| Price coin | `USDC`, 6 decimals | Fees, claims and the raise are all in USDC. |
| Contents | a collection of `404` signs | 404 new NFTs with ids 1 to 404. |
| Art | `open`, `2d` model policy | Every sign's picture is public from the start. `assign.mjs` builds 404 distinct pictures with all six traits, verified against `unique/manifest.json`. No item carries a model. |
| Seed | none | Nothing else goes into the box when it is created. |
| Pick fee | `100` basis points | Taking out a sign you choose costs 1% more EXIT. That extra EXIT is burned. |
| Raise | `listing-fixed` | Square Hole's USDC listing sets how much the raise is. The creator does not pick it. A listing can change its amount for future boxes, so this kit repeats no number. |
| Deadline | `30` days | The raise has 30 days to fill. |
| Royalties | `0`, none | Selling a sign on a marketplace pays no creator royalty. |
| Buyers' fees | `grow` | The site calls this Grow the pool. The buyers' share makes the box's own pool deeper. |
| Sellers' fees | `items`, inside `burn` | The sellers' share is split equally across all 404 signs. A sign outside the box keeps its part for its owner. The part of every sign inside the box buys EXIT and burns it. |
| Creator buy | zero | The creator buys nothing at launch (registry notes). |
| Life | `graduate` | The local test expects the raise to fill and the box to graduate. |
| Checks | seven properties | The test proves that no fee goes missing, the page shows the right state with the box's own pictures, the box graduates, the pool grows, sign owners can claim, and burns make the supply smaller. |

## Where each fee goes

Every trade pays a 1% fee in USDC. A buy pays it on the USDC going in. A sale pays it on the USDC coming out.

The fee is split into 15 equal parts.

- **10 parts** follow the box's choice for that side.
- **2 parts** always go into the box's own pool.
- **3 parts** go to Square Hole (its platform and its buy-back). This part is the same for every box.

Leftover dust from rounding goes to the pool while the box is live.

**Buyers' side.** The 10 parts join the 2 pool parts, so 12 of every 15 parts end up in the pool. After the box
graduates, anyone can run the step that adds them. About half of the USDC buys EXIT in the pool, and then the
USDC and the EXIT go in together as liquidity the box owns. The pool refuses every attempt to take liquidity
out, so this depth stays for good. Each step is small and there is at most one per block, so the pool grows in
steps. Small amounts wait until there is enough for a step. Whatever buyers paid during the raise goes in after
graduation.

**Sellers' side.** The 10 parts are split equally across all 404 signs. Each sign outside the box gets its
equal part as USDC credit. The equal parts of the signs inside the box buy EXIT, and that EXIT is burned.
During the raise every sign is still inside the box, so the whole sellers' share from that time buys and burns
EXIT once the box graduates.

**What a burn does.** Burned EXIT is gone for good, so the supply gets smaller. A burn sets no price and protects
no value.

**When nothing happens.** Fees only come from trades. There is no schedule and no minimum.

## What each owner gets

**An EXIT holder** holds the box token. Holding EXIT gives no share of the sellers' fees, because those go to the
signs. After graduation, EXIT is how a sign leaves the box.

- One sign costs the EXIT outside the box divided by the signs still inside, rounded up. You also pay the 1%
  pick fee, and that part is burned. The rest stays in the box, held for that sign.
- Putting a sign back pays you that sign's share at that moment, rounded down, minus a 5% fee that is burned.
  This can be more or less EXIT than you put in.
- The last sign always stays in the box.
- Quotes move between the moment you look and the moment you sign. Every take-out has a limit you set and a
  deadline.

**A sign owner** owns the NFT and can claim the USDC credit of a sign that is out of the box.

- Only the current owner can claim, one sign per claim. There is no minimum, no tip and no time limit. The
  owner pays the gas.
- The credit stays with the sign. Sell or give the sign away, and the unclaimed credit goes with it.
- Put the sign back in the box, and its unclaimed credit stays on the sign for whoever takes it out next. So
  claim first.
- While a sign is inside the box, its new parts buy and burn EXIT. It collects nothing for anyone.
- Sometimes a claim has to wait for the fee records to catch up. Anyone can run that catch-up, and no credit
  is lost while it waits.

The picture on a sign changes nothing about fees or claims. All 404 pictures are distinct, using twelve base
sign families plus housing, route, repair, equipment and conduit traits. Review GLBs do not become NFT models.

## Risks in plain words

- EXIT and the signs can lose all their value. There may be no buyer when you want to sell.
- A deep pool means a trade moves the price less. It does not mean the price is good, or that it will stay.
- USDC can lose its link to the dollar, and its issuer can freeze addresses.
- No trades means no new credit. Each sellers' fee is split 404 ways, so one sign's part of a single fee is
  very small, and the gas to claim can be larger than the credit.
- The raise can miss its 30 days, and then the box fails. If the raise fills but the box has not graduated 7
  days later, anyone can fail it too. After a failure, holders claim their part of what is left. That is not a
  promise to get everything back. Failure claims close a year after the failure, and what is left after
  that goes to Square Hole's buy-back.
- Taking a sign out ties up EXIT in the box, and putting it back costs 5% of the sign's share.
- These contracts have internal reviews and tests. They have had no outside audit so far.
- Anyone can copy the name, the ticker and these pictures. Check the chain and the full contract address
  every time.

## What still waits

**For counsel**

- The name. "Exit liquidity" is slang about people left holding a token. Counsel should confirm that the name
  and the joke read as satire and do not mislead buyers.
- The sign share. A sign carries a claim on part of the sellers' fees, and the sign can be sold. Counsel should
  review how that is described and promoted.
- The ticker. EXIT has not been checked against other names and marks.
- The license. The open-source license for this kit's code, text and art is not chosen yet.

**For a v2.1 step**

Nothing. This box pays sign owners in USDC, the price coin, which today's contracts already do. The v2.1 steps
in the registry are paying signs in the box token, sending fees into a pile, and eating the price coin. This box
uses none of them.

**For the launch**

- The registry still points at local test pictures. Using this art needs the metadata and hosting step, and
  the deployed collection must use ids 1 to 404.
- Every live page shows the chain and the full contract address. When Square Hole launches the box itself, the
  address also goes on its list of own boxes (F133). Until then the line reads "Contract: not deployed".

## Sources

- [exit-liquidity.json](../../../packages/box-spec/examples/v2/exit-liquidity.json) and the
  [registry notes](../../../packages/box-spec/examples/v2/README.md): the settings, creator buy and test lives.
- [Decision log](../../../docs/decisions/DECISION-LOG.md): F86 (F), depth as the creator's own choice; F89 and
  F109, Exit Liquidity as an example box; F118 to F120, fees in the price coin and one choice per side; F122,
  the 7-day escape and the failure claim; F123, listing raises; F127, claim-only payouts; F133, own boxes listed
  by address.
- [Fee split](../../../packages/contracts/src/box-v2/BoxReceiverV2Base.sol): `_splitSource` gives 10, 2 and 3
  parts of 15, books the sellers' sign share, and keeps it until graduation.
- [Hook](../../../packages/contracts/src/box-v2/BoxHookV2.sol) and
  [deepen step](../../../packages/contracts/src/box-v2/BoxHookV2Extension.sol): the 1% fee on both sides,
  liquidity that cannot be removed, and the half-buy depth step.
- [Vault](../../../packages/contracts/src/box-v2/BoxVaultV2.sol) and
  [quotes](../../../packages/contracts/src/box-v2/libraries/VaultViews.sol): taking signs out and putting them
  back, the 1% pick fee, the 5% fee and the last sign.
- [Item ledger](../../../packages/contracts/src/box-v2/ItemLedgerV2.sol): owner-only claims, one sign per claim,
  and credit that stays with the sign.
- [Coordinator](../../../packages/contracts/src/box-v2/BoxCoordinatorV2.sol): the year-long failure claim.
