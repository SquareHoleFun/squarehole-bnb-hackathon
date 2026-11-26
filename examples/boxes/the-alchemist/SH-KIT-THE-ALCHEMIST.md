# The Alchemist setup

The founder's 2026-10-23 example is LEAD as the box token, PEPE as its price coin,
and gold, with XAUT named as a candidate, as its pile. The name describes the
picture: **fees buy the gold coin**. LEAD itself does not turn into metal, and
this box promises neither a fixed gold value nor a return.

## Recipe

| Setting | Choice and reason |
| --- | --- |
| Name / box token | The Alchemist / LEAD |
| Starting template | Coin pile, the generic recipe; The Alchemist is a fee choice |
| Price coin | PEPE concept; Test PEPE on Sepolia |
| Pile coin | Gold concept; Test Gold on Sepolia. A mainnet gold coin such as XAUT needs separate admission |
| Buyers | The Alchemist: destination 9, choice 10, one directory row, no split |
| Sellers | Burn: use this side's fee share to buy LEAD in its own pool and burn it after graduation |
| Seed | zero seed; raw amount `0`. Only successful conversions build this example's initial pile |
| Leave-behind | 5% (`500` basis points), fixed at creation; a share leaves something for remaining holders |
| Contents | A pile of one fixed coin; no collection, item count `0`, pick fee `0`, no item art |
| Royalties | Off (`0`); the box has no collection |
| Deadline | 30 days from opening, the ordinary example default |
| Raise | Listing-fixed. Unresolved here: JSON `null`, never a zero raise or an invented PEPE quote |
| Launch status | Pending `ALCHEMIST-REGISTRATION`; no box deployed by this kit |

Burn on sellers follows the existing Alchemist design and the Dragon's Hoard
pattern. It gives sales a different role: fewer LEAD remain after a successful
burn, while buyers' fee share buys the pile coin. Burn does not pay sellers gold
or guarantee a higher LEAD price. A creator making another recipe can choose a
different permitted sellers' action and review the resulting economics.

## What actually moves

The usual fee accounting remains: of fifteen parts, ten follow the selected
side's choice, two support pool depth, and three go to Square Hole's platform
and buy-back. Collection incentives and integer carry still apply. The Alchemist
receives only the buyers' selected share, not the whole trade or every fee.

Money reaching the inbox is booked as buyers' fees. Once inbox proceeds reach
price-coin fee accounting, the buyers' Alchemist choice receives its share too.
An unrelated coin sent to an inbox does not bypass that inbox's conversion rules.
Before graduation, fees wait. After graduation, the fixed trigger can execute a
conversion. Anyone can start one after that side has waited seven days without
a successful conversion; each success restarts that wait for remaining fees.

The module buys along one fixed route and deposits the output into this box's
pile. The input coin, output coin, route pools, route limits, cap, dust bound and
trigger are fixed when the module is deployed. A box pins the selected module
and code hash. No later holder vote or operator switches this route.

The route idea is **PEPE -> WETH -> gold**. On Sepolia this means
**Test PEPE -> WETH -> Test Gold**, using TA-30 stand-ins at both ends. WETH is
only an intermediate asset. The exact pools, supported venue kinds, fees and
tick spacings need review before deployment. Do not substitute another route
when these pools cannot be used. A different gold coin needs its own compatible
module and reviewed directory row.

Conversions happen in bounded clips. A refusal leaves the fee share pending for
retry; a qualifying tiny rounding remainder goes to this box's pool depth, not
to its gold pile. Waiting PEPE and depth claims are not gold and do not count as
gold already in the pile. A per-hop price limit constrains movement during that
step, not the fairness of the starting market price. Thin pools and manipulated
prices remain risks.

## Taking a share

After graduation a holder hands in LEAD, which is burned, for a proportional
share of the gold actually held by the pile. The denominator is the whole LEAD
supply, including LEAD held by the pool. The contract rounds the gross share
down in raw gold units and applies the fixed 5% leave-behind with integer
rounding. It is not a price peg. Pending fees are excluded until converted.

The existing whole-supply exit takes the whole pile without a leave-behind; a
wallet cannot do that while another holder or the pool still owns LEAD. With
zero seed the pile may be empty. Before graduation or after failure, there is
no Alchemist conversion or normal pile exit. Failed-box price-coin claims follow
the core's failure rules; nothing here changes them or gives this kit a rescue
power.

## Sepolia and mainnet

The Sepolia stand-ins are **Test PEPE** and **Test Gold**, from the requested
TA-30 work. They are test coins, not real PEPE, gold backing or issuer assets.
`TEST_PEPE` and `TEST_GOLD` in the registry are logical binding keys, not claims
about their eventual on-chain symbols. Test contracts must keep distinct test
names and symbols. The price coin's `18` decimals are the intended recipe setting
and must be checked against TA-30 before activation.

TA-30 is absent from this pinned repository base. No address, listing ID, gold
decimals, pool address or raise is invented here. Use TA-30's reviewed public
deployment evidence when it becomes available; confirm balances and decimals.

The supplied Sepolia snapshot says the listing registry
`0x84Dc1E9Cd7da248f85133E5e03EF3A303a51072D` lists only ETH. Its lister is the
platform Safe `0x9432380a67745b453886698F9539aC035DF80B34`. The fee-module
directory `0xF856948cEc46e79249Ba4E3Fdb9796CB5f182c93` has four rows and no
Alchemist row. Core v2.1 being deployed does not make this recipe selectable.
No live chain reads were made for this kit.

For mainnet, PEPE and the chosen gold coin are **not listed by this kit** and
must each obtain the needed listings. Verify the exact gold coin rather than
silently substituting one issuer's coin for another. Issuer freeze, redemption,
custody and transfer powers require review, as do the route's liquidity and
starting prices. Sepolia test coins cannot stand in for mainnet addresses.

## Pending step: ALCHEMIST-REGISTRATION

1. Complete TA-30 and record its distinct test coins, verified deployment
   addresses and decimals. Admit the required coins with reviewed raw raises.
   The existing `packages/chain/scripts/sepolia-listing-batch.mjs` (TA-20)
   prepares unsigned Safe calls only; the founder reviews and signs every batch.
2. Review and fund compatible Test PEPE / WETH and WETH / Test Gold pools.
   Fix the route, release implementations, cap, small dust bound and trigger.
   Require `2 * dustMax < inputCap` and review the dust scale for that route.
3. Have the founder execute the reviewed module deployment and directory
   registration. Record its actual ID, module/helper code hashes, immutable
   settings and `readyAt`; wait until it is selectable. Choice 10 and
   destination 9 are enum meanings, not a guessed directory row ID. Encode
   the actual row ID as canonical `abi.encode(uint32 directoryId)`.
4. Add the example's contract and browser lives and compatible unsigned
   creation wiring. Verify pending fees, inbox receipts, gold conversion,
   refused conversion retry, sellers' burn and the holder's leave-behind.
   Only a reviewed follow-up may relax the registry's pending gate.

All chain transactions belong to the founder. The kit's art scripts write
pictures only; the kit checker and tests run offline. The generic example
creation writer cannot yet encode this Alchemist recipe. Registering a row
alone is insufficient to mark its example life ready.

## Make another one

Copy the Coin pile recipe and choose a new box name and ticker. Choose the price
coin and a different pile coin, choose seed and leave-behind, then pick the
buyers' and sellers' fee actions. Review listings and a module whose immutable
coins and route match. Keep pending status until those checks and the example
lives are complete. Redraw the original workshop shapes for your own story and
check the applicable license before publication.

Sources: [Alchemist design](../../../docs/design/core-v21-module-alchemist.md),
[module](../../../packages/contracts/src/box-v2/modules/AlchemistFeeModuleV21.sol),
[deployment](../../../docs/evidence/SH-SEPOLIA-CORE-V2-DEPLOY.md),
[manifest evidence](../../../docs/evidence/SH-TA-10.md),
[Safe batch writer](../../../docs/evidence/SH-TA-20.md).
