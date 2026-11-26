# What our keeper runs at its own cost

Generated from `src/jobs.ts` by `pnpm --filter @squarehole/keeper ours:write`; do not edit by hand (F95 R19S;
ADR-0017 § 11). The ordinary fee ceiling is 3 gwei. R62-FEE allows drandPostRound, drandRequestWord,
backupStart and backupFix below 72 hours to their deadline to use up to 50 gwei and their own 0.05 ETH daily rescue cap
when the ordinary fee or daily limits refuse. Requested words must still be within their deadline; an unrequested
assignment can be rescued after it. A timely word never expires: acceptance keeps ordinary limits and protected reserve.
Ordinary drand sends have no second allowance. Fixed daily limits are 0.102 ETH ours,
0.012 ETH Box 0 pokes and 0.114 ETH total, including 0.051 ETH protected for recovery.
F111 also caps v2 collect/buyBack/deepen/shopFees/sellFees/eatPriceCoin/moveToPile/executeModule by
each box’s confirmed platform share and one quarter of confirmed platform income over the rolling 24 hours, each
send counted at its whole signed gas limit times its maximum fee. Received valued tips repay
that income budget; no tip increases a fixed daily limit. Unvalued tokens create no wei room.
Sepolia reviewed price-coin pins scale raw receipts by decimals and a fixed rate approved in F182; tETH remains 1:1.
F182: only after an income-cap refusal, a live registered v2 collect or positive fee sale may start on its own
pending simulation’s paid tip. Its separate approved valuation must cover the whole signed cost, at most 0.05 ETH,
with zero call value. That tip helps only this candidate in both income caps; it is not received income.
Every start is charged as ours inside the ordinary daily limits. Before broadcast, its full cost, unpaid lock and hash
are saved in the starts file before the ordinary journal. Other ordinary work waits; reserved recovery remains available.
Only its final canonical transaction’s authenticated tip covering that cost releases the lock. Otherwise the debt
survives midnight, 24 hours and restarts. Later same-box income may repay it once under both caps; its debit then
stays charged for another 24 hours. Unknown hashes never clear automatically (only starts from before SH-249 lack one). Finality is final: paid records then drop.
Proofs are read only inside the rolling window. The pending block must match before simulation and after estimation.
Rollback leaves the separate starts file and its required marker intact; returning restores unpaid locks.
The old keeper can run but does not enforce start locks. Preserve all books. Dry starts settle only in the dry books.
The fixed daily limits reserve each send at its whole signed gas limit times its maximum fee plus any bounty value before broadcast,
then count what it paid (gas used times the effective gas price, retaining bounty value) once its receipt is final and canonical;
a send without such a receipt, failed or ambiguous, stays charged in full for the day.
The same caps apply to the routine T calls of three recovery jobs: a purchased-T holder tranche (`holderSettle`)
and T residue burns of at least 0.01 T (`holderResidue`, `itemResidue`). No claim waits on them and they never
use the protected reserve; a T batch with no purchased T is never settled.
Unblocking work instead spends no F111 credit: royaltyRefresh, royaltyObserve, a simulated sellFees page that sells
for zero P or for less than a hundredth of the step minimum, and a collect below its batching floor sent while
closed sources wait out of a collect's reach. It takes a per-box UTC daily allowance of signed gas
(SH_KEEPER_UNBLOCKING_GAS_PER_BOX_PER_DAY, default 816,000,000: 24 of each job at its published floor) and two
wei ceilings: all boxes together never reserve more than SH_KEEPER_UNBLOCKING_WEI_PER_DAY (default half the
ordinary ours room, 0.0255 ETH), and a box waits once it has spent SH_KEEPER_UNBLOCKING_WEI_PER_BOX_PER_DAY (default
a quarter of that), so its last send can cross its share by that send alone. Each can be set to zero. The fixed
daily wei ceilings and the 3 gwei ceiling still apply; this work cannot use the protected recovery reserve.
Positive-P sales above a hundredth of the step minimum remain F111 work.
Recovery jobs keep their reserve and are exempt from income caps. The jobs below that say
"always" pay none, or a tip this keeper cannot value yet, and stay ours; the others become ours only while their
tip does not cover their gas. Gas per run is an operating allowance; pending estimates with headroom may
require more. V2 uses FINAL2-GAS floors, with graduation raised by FINAL3-G01 to 13.5M
for both burns, both pokes and ledger-token history; failure/failClosed take 15M for their five optional calls
(both burns, the router sweep, the inbox sweep and the tip). 15M admits the worst a price coin can cause, which spends
the sweeps and the tip (at most 12,815,029 submitted gas on Amsterdam at rc7). It does not admit all five spent on
Amsterdam (up to 15,292,746 submitted); both burns call our own token, which nobody else can make spend its allowance.
sellFees signs at no less than 8.2M before Amsterdam, 16M on it and 3.5M for a simulated zero-P page; the table shows the largest.
collect signs at no less than 5M before Amsterdam and 8M on it; the table shows the largest.
V2.1 eating and pile moves use a 3.5M floor covering EAT_GAS / PILE_MOVE_GAS 2.8M, admission and the 200k continuation reserve;
it shares ordinary income/daily budgets and cannot consume the protected recovery reserve.
Shop burn/return floors remain 5M/2M. Safe payments use pending estimates; their 12M allowance
covers four parts. Every published allowance fits the 16,777,216 Osaka cap; headroom above a floor is clipped at
the destination ceiling, so a 15M failure is signed at no more than that cap.
The table uses v2 allowances for shared job names; Box 0 values are listed separately below.

| Job | What it does | Ours | Gas per run | ETH per run at 1 gwei |
|---|---|---|---|---|
| `backupStart` | Starts box 0's RANDAO backup for a requested round drand has left unposted, only between 5 days and 5 days 18 hours after the round's time (F143, R63-LATEST) | always | 300000 | 0.0003 |
| `backupFix` | Fixes a started backup with its target block's header once that block is final, inside the proof window and before the consumers' deadline (F143) | always | 300000 | 0.0003 |
| `drandPostRound` | Posts a due quicknet round shared by known consumers; its bounty is a separate pull credit, never assumed gas income | always | 600000 | 0.0006 |
| `drandRequestWord` | Retries a missing ticket assignment-word request after graduation or the v2 failure window, with zero bounty value | always | 200000 | 0.0002 |
| `drandAcceptWord` | Accepts a timely posted graduation/assignment word on v1 or v2 tickets | always | 200000 | 0.0002 |
| `drandSettle` | Settles at most eight queued draws with timely words; owners open and claim their own items | always | 1000000 | 0.001 |
| `drandGraduationBounty` | Optionally tops up box 0’s unposted graduation round to the configured bounty; ordinary ours gas plus value, no protected reserve | always | 100000 | 0.0001 |
| `drandWithdrawBounty` | Withdraws only this keeper address's credited drand bounties to itself; ordinary daily budget | always | 100000 | 0.0001 |
| `itemSync` | Replays up to 32 item receipts and 32 lifecycle records; owners claim their own P | always | 3000000 | 0.003 |
| `itemResidue` | Flushes only proved item P rounding/cancellation residue to fixed hook depth; burns item T residue of at least 0.01 T as ordinary F111 work | always | 350000 | 0.00035 |
| `pileLoadSeed` | Retries a pending exact ERC-20 seed pull from the recorded seeder; native seed is loaded by its owner | always | 1000000 | 0.001 |
| `pileReturnSeed` | Retries a failed pile seed return only to its recorded seeder; never redeems holder T | always | 500000 | 0.0005 |
| `holderSettle` | Advances sixteen closed, funded notice/holder pairs: a P batch completes before claims or residue; a purchased T tranche is ordinary F111 work, never sent before a purchase | always | 3000000 | 0.003 |
| `holderResidue` | Flushes only proved P residue to depth while live or to the failed receiver, whose next collect adds it to the claim pot; burns holder T residue of at least 0.01 T as ordinary F111 work | always | 350000 | 0.00035 |
| `shopBurn` | Retries burns of quarantined failed-shop liquid and claims-backed T; never returns seed | always | 5000000 | 0.005 |
| `shopReturn` | Retries one failed-shop starter NFT only to its fixed creator | always | 2000000 | 0.002 |
| `fail` | CQ11-E: closes an expired box or uses the seven-day graduation hatch; the closer tip is real P, paid last | always | 15000000 | 0.015 |
| `failClosed` | Closes a box whose open gate still holds 14 days after its open; the same tip, so the same | always | 15000000 | 0.015 |
| `graduate` | Graduates a box whose curve filled; it credits its caller the D6 reserve as a reward in P (v1's `graduate()`), claimed by this keeper through claimReward(to) only when rewardOf(keeper) is positive | always | 13500000 | 0.0135 |
| `claimReward` | Claims only this keeper graduator's recorded D6 reward to itself | always | 200000 | 0.0002 |
| `buyBack` | Buys T in the box pool, burns or leaves it pending, tips on actual P spent; takes the pool step in turn with deepen and shopFees | when its tip does not cover its gas | 8000000 | 0.008 |
| `shopFees` | Sellers core shop purchase or holder refund; shared pool step, ordinary F111 income limits | always | 3500000 | 0.0035 |
| `sellFees` | F137: after graduation, presses the plain hook's public step that sells waiting T fees for P in the box pool (49 ticks, minimum output, FIFO page ends at the step minimum or 32 sources); our keeper probes hourly when idle and presses again on its next rotation turn after any conversion of T; a zero-P page, or one worth less than a hundredth of the step minimum, uses the daily unblocking allowance; signed at no less than 8.2M before Amsterdam and 16M on it, 3.5M for a zero-P page; tips 5% of the step's own P, capped | when its tip does not cover its gas | 16000000 | 0.016 |
| `executeModule` | After graduation, converts one fixed module side through private submission; no tip and ordinary F111 income limits | always | 3500000 | 0.0035 |
| `moveToPile` | After graduation, moves pending P into the fixed pile, in bounded portions; no tip and ordinary F111 income limits | always | 3500000 | 0.0035 |
| `eatPriceCoin` | After graduation, burns checked P or locks unchecked P at the fixed dead address; only while pending, never after failure, under F111 with no tip | always | 3500000 | 0.0035 |
| `burnPending` | Retries a refused T burn; never sells T | always | 1500000 | 0.0015 |
| `routerSweep` | Sweeps launch tax after graduation or failure; the contract fixes its destination | always | 2000000 | 0.002 |
| `royaltyFlush` | Flushes the income inbox's ETH/WETH: wraps it for sale in a box priced in another coin, or delivers it as P to the receiver; our keeper does not call it for failed boxes | always | 8000000 | 0.008 |
| `royaltySweep` | Sweeps the income inbox's price coin into phase accounting; our keeper does not call it for failed boxes | always | 8000000 | 0.008 |
| `royaltyRefresh` | Registers or refreshes an income inbox coin's CoW standing order, at most once per clock hour per coin from the hour's start, when whole lots wait above its approval; never for failed boxes; uses the daily unblocking allowance; anyone may call it | always | 5000000 | 0.005 |
| `royaltyObserve` | Records a frozen-list coin's unobserved sale in its own clock hour at any balance, or starts a below-lot coin's zero clock, at most once per clock hour per coin; never for failed boxes; uses the daily unblocking allowance | always | 5000000 | 0.005 |
| `poke` | Pokes Box 0's FIT executor each block while spot is more than 1% from its latest sample (F96 R19G) | always | 62000 | 0.000062 |
| `deepen` | V2 deepen alternates with buyBack each block; Box 0 retains its hourly cadence | when its tip does not cover its gas | 8000000 | 0.008 |
| `collect` | Public V2 P fee collection and lazy escrow settlement; signed floor 5M before Amsterdam, 8M on it, sized for an ordinary price coin; allocates up to two quota sources plus five passes for sources below 15 raw P per side; below its batching floor at a lag of two closed buyers or three closed sellers, counting every source, as unblocking work on consecutive blocks; our keeper does not call it for failed boxes; Box 0 retains its two-hour cadence | when its tip does not cover its gas | 8000000 | 0.008 |
| `receiverPayFit` | Pays positive raw P debt only to the immutable FIT Safe in any v2 phase (F130); Box 0 keeps its payout policy | always | 12000000 | 0.012 |
| `receiverPayPlatform` | Pays positive raw P debt only to the immutable platform Safe in any v2 phase (F130); independent of FIT, with no caller tip | always | 12000000 | 0.012 |
| `executorTopUp` | Pokes Box 0's FIT executor once its newest checkpoint is 515 seconds old | always | 62000 | 0.000062 |
| `executorExecute` | Executes Box 0's funded FIT budget with bounded maxChunks after graduation and TWAP readiness; simulation must buy or burn FIT | always | 500000 | 0.0005 |

## Box 0 operating allowances

Box 0 keeps its estimate/headroom policy and 3.5M failure floor; v2 floors do not apply.

| Job | Gas per run | ETH per run at 1 gwei |
|---|---|---|
| `fail` | 3500000 | 0.0035 |
| `failClosed` | 3500000 | 0.0035 |
| `graduate` | 6150000 | 0.00615 |
| `claimReward` | 200000 | 0.0002 |
| `deepen` | 400000 | 0.0004 |
| `collect` | 300000 | 0.0003 |
| `receiverPayFit` | 80000 | 0.00008 |
| `receiverPayPlatform` | 80000 | 0.00008 |
| `poke` | 62000 | 0.000062 |
| `executorTopUp` | 62000 | 0.000062 |
| `executorExecute` | 500000 | 0.0005 |
