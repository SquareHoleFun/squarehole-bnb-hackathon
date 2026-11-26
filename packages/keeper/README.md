# @squarehole/keeper

Permissionless maintenance for core v2, plus the existing Box 0 cadence. The keeper runs dry by default. It never
signs Safe transactions, converts outside assets, claims holder T, or calls coordinator-only receiver/hook entries.
The separately co-signed burn bot owns the FIT Safe's sales, funding and burns; it has no platform role and applies
no platform cap (F164 D2, F160).

The same process posts due drand quicknet rounds, recovers ticket assignment words, settles bounded draw queues,
and withdraws its own posting bounties. See [Drand poster operations](../../docs/ops/drand-poster.md) for relay
validation, discovery, silence warnings and startup. Mainnet requires `SH_KEEPER_ALLOW_MAINNET=1`, including dry runs.

## Jobs

V2 discovers registry roles 0/2/5/6/8 afresh at a pinned block. It schedules `fail()` at an unfilled curve's deadline
or exactly seven days after `hook.closedAt()` for a filled ungraduated curve. `failClosed()` is the distinct
unopened-gate exit at `openAt + 14 days`. Before hatch eligibility it attempts `graduate()`; it claims only
`rewardOf(keeper)` through `claimReward(keeper)`.

While a v2 box is live, `collect(keeper)` books fees once its simulated raw-P batch reaches the coin's collect minimum.
It recovers refused graduation settlement even with no new fees, regardless of the minimum.
After graduation, `buyBack(keeper)` and `deepen(keeper)` alternate, one proposed step per pool per block. The hook's
shared block mark and fresh simulation decide eligibility; no hourly v2 cooldown, price timing or listing-price
read is used. A skip or zero-work result backs off, and another ready step can take the next block. `burnPending`
retries refused T burns. Pending buys remain in their box; a warning reports the block at which a positive
`buyBackP` balance was first observed. This age survives restarts; it is an observation bound, not reconstructed
historical accrual time.

F127 keeps user payouts claim-only: the keeper schedules no holder/item claims. Under F130 it triggers
`payFit` and `payPlatform` for each positive debt, independently, in every phase, to their immutable Safes.
There is no payout minimum or caller tip. Box 0 keeps its reviewed payout policy. The keeper also claims
its own recorded graduation reward.
`sweep` retries launch tax after graduation or failure, to the hook or holder pot respectively.
RC5-A removes the coordinator pot sweep and its gas floor. Under R53-E (2026-10-15), our keeper no longer
plans `collect` or `forwardRoyalty` for failed v2 boxes. Both remain public on-chain calls.
Late receiver P (including holder-ledger residue and donations) reaches the pot through the public
`collect(tipTo)`, which pays no tip after failure, and, since RC6 (F137), at the start of every holder claim:
a claim settles the hook, attempts the router sweep and attempts the receiver's `collect` before it pays, so
no claim waits for our keeper. Earlier claimants receive no retroactive share. P royalties funded through `fundRoyalty`
after failure already move to the pot. Claims never expire. Unpresented shares and money after the last claim stay
locked forever; neither FIT nor the platform receives them. The creator's no-buyer remainder
stays fixed at failure and claimable without expiry. No keeper job closes claims or pays holders.

Role 8 is each box's income inbox (RC5-C, RC6-COW-INBOX). The keeper reads its actual ETH, WETH and P balances
at the snapshot block; empty-calldata ETH receipts emit no log, so scheduling never relies on receipt events. For a
box that has not failed, positive ETH/WETH schedules `royaltyFlush` (it wraps ETH for sale in a box priced in another
coin, or delivers native or WETH P to the receiver) and positive ERC-20 P schedules `royaltySweep(P)`. WETH that is
itself P is swept, never unwrapped into a payee exit. These jobs have no tip, retain the failure reserve and back off
after refusal. Under R53-E our keeper schedules neither for a failed box: failure and every claim attempt the inbox's
P sweep themselves, and both calls stay public. Non-P coins leave only through CoW orders or the current payee's own
`claimInKind`; the keeper never submits that owner-only claim. No conversion Safe, event scan or swap worker is involved.

RC6 adds `royaltyRefresh`: for a live box the keeper reads the inbox's frozen sellable list (`listingRegistry`,
`listVersion`, `sellableCount`/`sellableToken`, at most 32 rows) and each coin's `lotSize`, balance, VaultRelayer
allowance, recorded approval, `oldestUnsoldAt` and `orderRegistered` at the snapshot block. It calls `refreshOrder(coin)` at most once per clock hour per coin,
from the hour's start, only when whole lots wait above the approval (capped at the inbox's 20 lots an hour) or the order is not registered.
Approvals already covering their whole lots need no refresh. `royaltyObserve` calls public `observe(coin)` whenever a
coin's allowance is below the recorded approval (a sale nobody has recorded yet), at any balance, so the inbox charges
the sale to the hour it happened in; and for positive below-lot custody whose clock is zero, including WETH without
ETH. A block that refreshes a coin does not also observe it. Either job, sent or attempted, is next due at the next
clock hour's start (second release review, RC6RR2-COW-1: before, a sale was recorded only at the next refresh, 300
blocks later, in the next hour, and a backlog sold 20 lots every other hour). Failed boxes get neither job. Posting the
orders to CoW (quote first, skip an hour above about 5% fee) is the separate keyless poster in `packages/cow-poster`
([runbook](../../docs/ops/cow-poster.md)), not part of this package.

F137's plain hook sells its own T fees: `sellFees` joins `buyBack`, `deepen` and `shopFees` in the pool's one
protocol step per block, with hourly probes while idle and the next rotation turn after every sent conversion; a press that would consume no T
leaves the block's step to the next job. A step refused by a check of its own (budget, F111 income cap, gas
admission, unblocking allowance) keeps its retry eligibility but passes its turn: the next tick proposes the step after
it, so one blocked step never starves the others (SH-KEEPER-V2-STEPS). A fee pause or the per-block send limit holds
every step alike and keeps the turn. A press sells a value-sized page of at most 32 sale-fee sources,
ending when their T is worth the step minimum at spot (SH-RC7-HOOK-PAGE; no four-valued-source stop). A press that
consumes T for zero P (a page of 32 raw-wei sources, which no tip pays anyone else to press) is sent too, and the step is due again on its next turn, so a
dust head never holds later conversions; buyer sources allocate independently of seller tails (`docs/ops/keeper.md`).
Such a press, and one whose page sells for less than a hundredth of the hook's step minimum (read once from the hook
clone's arguments; a griefer can size dust to a few raw P a source), are unblocking work (below). Its `FeesSold` tip
counts as our income only when the event names us.

Every rc7 collect allocates at most two sources of 15 raw P or more a side, plus up to five sub-unit sources;
any further sub-unit sources consume the two quota places. Failure settlement keeps two sources a side with no passes.
Every press and collect closes another buyer/seller pair. The keeper reads `allocationCursors()` once at the snapshot
for both allocation cursors and both open source ids, then checks up to three closed sellers. The unchanged rule
counts every closed source: two closed buyers or three closed sellers send a collect even below its batching floor,
as unblocking work, again on the next block regardless of an earlier retry wait. Sub-unit passes can reach further
than this conservative rule assumes; any sent press makes the next collect due on the next block too.
Deploy this keeper only with rc7 receivers. An rc6 receiver has no cursor view, and this keeper reads no lag for it;
an rc6 deployment, if one is ever made, keeps a keeper built from `core-v21-rc6`.

Box 0 keeps hourly deepen, two-hour collect, graduation, payouts and FIT executor pokes (large spot moves and
515-second checkpoint top-ups). After confirmed graduation, the executor job checks the coordinator's executor
and its `launchPhase()` back-reference, reads `budget()`, `batchThreshold()` and `twap()`, then simulates
`execute(maxChunks)` against pending state. It sends only if the simulation spends ETH or burns FIT. Missing reads,
an unready TWAP or a budget below the batch threshold leave funding in the executor. No executor funding is sent
by the keeper; the co-signed bot calls `fundBudget()` first. `SH_KEEPER_EXECUTOR_MAX_CHUNKS` defaults to 1 and
accepts 1–32; the unchanged contract enforces its own stricter per-block allowance. Execution uses our daily gas
budget, preserves the failure/graduation reserve, and shares `SH_KEEPER_RETRY_BLOCKS` for durable retry pacing.
Its call shapes stay separate from v2's changed collect/deepen return tuples.
[OURS.md](OURS.md) lists every job and its operating allowance, with Box 0 values separately.

## M2 holder and shop exits

The keeper reads roles 1/17 for holder jobs and role 3 only for failed shops. Holder wiring must agree with
both the receiver and hook. Shop identity uses the frozen coordinator clone's optional SHOP byte at argument
234, so share and pile vaults receive no shop calls. Every read uses the same canonical block as the box.
The supplemental ABI list lives in `src/abi.ts`, pinned to the Solidity interfaces by the artifact test;
M2-52 owns regeneration of the shared v2 ABI.

Closed batches with final receiver funding (including zero) run `settleBatch(id,16)` before residue
flushes. A `false` return is a successful partial page. Owners claim their settled P themselves, without
minimum, tip or expiry, including after failure (F127). The keeper neither enumerates holders nor reads
claimable credits. Proved residue uses `flushResidue(id)` to the immutable live depth or failed-receiver
FIT path, independently of a paused P payout.

V2.1 HoldersT sides (fee choice 7) pay T and settle in purchased tranches. The keeper reads both side choices
and requires the ledger's `payoutAsset` to be the box token for each T side; a mismatch proposes no holder work.
A T batch is settled only while `holderBatchPaid` (its cumulative bought T) is positive and `batchState` is
incomplete. Allocated batches before any purchase, which covers every batch before graduation and after
failure, get no pass: it would move nothing. Earlier tranches stay claimable while a later one settles, so no
claim waits on this work. T passes and T residue burns (only from 0.01 T) are therefore ordinary F111 work:
the box's income caps apply and they never use the protected reserve. P batches keep the one-time, reserved
settlement above, because their claims wait for it.

Each read visits at most eight closed batch ids. Separate cursors for the ledger's batches and the shop's
starters advance by visited pages, regardless of skipped blocks, retries or budget deferrals. The existing
journal saves them at every reservation and tick end; restarts resume them without resetting budgets or
retries. Old holder-scan offsets are inert. For a fixed readable backlog of B batches, every batch is
visited within ceil(B/8) read ticks, independent of block strides.

Cursors are read offsets, never completion records. Every visit checks current canonical wiring, counts,
closure, funding and settlement, followed by pending simulation before a send. Counts are read anew;
shrinking lists normalize offsets into range, empty lists reset their cursor, and appended pages join the scan.
Individual read failures affect only their jobs and are revisited on later cycles. Reorgs need no completion
rollback: restored residue and starter NFTs remain discoverable. A crash before a checkpoint may repeat a page;
one after a reservation resumes the saved scan and revisits deferred jobs when it wraps. Growth and budget
deferrals extend service latency; this is bounded read work, not a throughput guarantee for growing histories.

Failed shops run `burnFailedT()` for quarantined liquid/claims T and one `returnStarter([index])` per NFT.
Failure excludes graduation, so the shop's cumulative `collectionSize()` equals its loaded starter count;
returns do not renumber it. Eight indexes rotate per read tick, capped by the frozen 10,000-item set limit.
A failing T read cannot suppress NFT returns. Pending simulation rejects already-returned/seized/unavailable
items and zero burns; each item has its own retry key. No recipient, seed refund, T approval or rescue is added.

All four jobs use the existing durable attempt keys, retry interval, fair ordering and fixed daily budgets.
Tipless settlement, residue and shop work remains on [OURS.md](OURS.md). `src/m2-gas.ts` supplies transaction
floors: settlement 3,000,000, residue 350,000, burn 5,000,000, single NFT return 2,000,000.
These preserve M2-30/32's named optional-call caps/reserves; pending estimates with headroom can exceed them.
M2-31's transfer/notice activation measurements are not payout estimates. Real ledger/shop probes pass both
EVMs at these floors; [M2-51 evidence](../../docs/evidence/SH-V2-M2-51.md) records measurements and fixture limits.
M2-60 still measures full integrated worst cases and twice-strict-case cap headroom.

## M3 item and pile maintenance

Role 16 must match the receiver's immutable item ledger. The keeper reads both the receiver's funding count
and role 3's lifecycle count, compares them with the ledger's processed cursors, and proposes `sync(32)` when
either journal is behind. This includes lifecycle-only progress before graduation and after failure. Each
transaction processes at most 32 receipts AND 32 operations. Both cursors are checked again against
pending state because `sync` has no return value; an already caught-up call is not sent. New canonical work
is rediscovered after reorg or restart without a local completion flag. No NFT IDs, owners or credits are scanned.

`flushResidue()` is simulated independently, even during backlog. Only a positive proved residue transfer
is sent; the ledger retains unsynced funding, hidden/base stashes and ticket/item credits. The destination is
fixed hook depth. For T item sides, `flushResidueT()` burns T residue only when the pending simulation burns at
least 0.01 T, as ordinary F111 work outside the protected reserve. Item sync stays reserved: every item claim,
in P or T, waits until both journals are replayed. Owners, including contracts, call `claim(ids,to)` themselves. F127 provides no keeper claim,
minimum, tip or recipient substitution. No cap, pairing, held-NFT earnings or pile redemption job exists.

Pile discovery requires the registry and coordinator to name the same factory and its frozen
`isPileVault(role3)` predicate to return true. A missing/reverting predicate suppresses only pile jobs; zero
item count or a loader alias is never treated as identity. **At the M3-51 reference the predicate is declared
but not implemented by the factory. M3-32 must supply it before production pile discovery can run.**

For v2.1 fee choice 9, `moveToPile()` moves positive `pilePendingP` after graduation, never after failure.
Its recipient is the immutable same-P pile. Each call moves at most `int128.max`; a refused transfer restores
pending and returns zero. There is no tip, approval, value, redemption or pool swap slot. The 3.5M transaction
floor covers `PILE_MOVE_GAS` (2.8M), EIP-150 admission and its 200k continuation reserve. This ordinary F111 job
uses the box's platform share, the rolling income quarter, daily limits and 3 gwei ceiling; it cannot spend
the protected recovery reserve. Successful portions may continue next block; zero/revert retries back off.
Legacy choices skip the additive pending view, and an unavailable view suppresses only this job.

Before opening, a nonzero pending ERC-20 seed with role 19 equal to the authenticated pile schedules
`loadSeed()`. The pile pulls the exact previously approved amount from its seeder and completes the starter
gate atomically. The keeper supplies no seed asset, approval or native value. Native seeds require the seeder
to call directly. After failure, `returnSeed()` retries the recorded seed to that same fixed seeder, for native
or ERC-20 assets. Zero/unloaded/already-returned seeds produce no paid retry. A paused seed never blocks ledger
maintenance, router sweeps or holder claims. The assigned no-rescue rule leaves failed unsolicited surplus
and unrelated assets stranded; this keeper does not add an exit for them.

All M3 work is untipped and uses the existing fixed daily budget, durable pre-send reservation, fair ordering
and retry backoff. Pending simulation suppresses zero work; reverted or ambiguous sends retain their full
reservation. Races after simulation remain possible and are bounded by that budget. Stable keys include the
job and immutable target; duplicate events cannot duplicate candidates. `src/m3-gas.ts` sets operating floors:
sync 3,000,000; residue 350,000; seed load 1,000,000; seed return 500,000 gas (RC5-A removed the failure sweep).
Pending estimates plus normal headroom may exceed them. [M3-51 evidence](../../docs/evidence/SH-V2-M3-51.md)
records real-part probes on both EVMs and their journal/nonce-alias doubles. M3-60 retains full production
gas calibration; these probes do not establish worst-case issuer costs or callback headroom.

## Run and durable state

```sh
SH_KEEPER_DESTINATION_FORK=amsterdam SH_KEEPER_TRANSACTION_GAS_CAP=16777216 \
SH_KEEPER_RPC_URL=… SH_KEEPER_BOX_REGISTRY=… SH_KEEPER_FROM_BLOCK=… pnpm --filter @squarehole/keeper start
```

`SH_KEEPER_DRY_RUN=0` and `SH_KEEPER_PRIVATE_KEY` enable live sends. Keys come only from the environment. Logs
redact keys and RPC credentials; startup checks chain identity. Only native-P tips have a wei value; ERC-20-P tips
are unvalued: they create no income room. Recovery still uses its protected budget. Raw amounts are bigint internally and decimal strings on disk/logs.

Select `SH_KEEPER_DESTINATION_FORK` (`cancun`, `osaka`, `amsterdam`) and
`SH_KEEPER_TRANSACTION_GAS_CAP` explicitly; no default or chain-id inference is used. The cap is a positive
decimal gas amount (`none` is allowed only for Cancun). Osaka/Amsterdam cap execution at at most 16,777,216;
on Osaka this bounds the whole transaction. The latest pending block limit also bounds every submitted total.

Sepolia uses `amsterdam` (activationTime 1791294816, 2026-10-06); select the actual destination fork elsewhere.
Both keeper entry points, including drand jobs, and the reveal poster CLI use `destinationGasAdapters`.
On Amsterdam its `noReservoirEstimator` makes one `eth_estimateGas` call with the exact sender, calldata,
value and fee fields against `pending`, returning a frozen `{ gas, stateGas: 0n }`. The node's single estimate
covers execution and state work together. Here `stateGas` means only state gas funded by the reservoir above
the transaction cap. EIP-8037 defines that reservoir as `evm_gas - min(2^24 - intrinsic, evm_gas)`, exactly zero
when the signed limit is at most 2^24. Admission bounds every limit by the configured cap (at most 16,777,216)
and the pending block limit, so the reviewed zero is exact; it does not claim there is no state work.
Startup prints `state gas: no reservoir (limit <= cap)` on Amsterdam. Cancun/Osaka retain their existing path.

`PendingGasEstimator` returns the pair together; the chain binds it to one candidate simulation, consumes it
once, checks the matching gas estimate, and discards it on the next simulation. Missing state gas still defers
without charge or signing. No separate trace, guessed split, floor, fee, budget or nonce change is involved.
The integrator's manual, read-only probe is `node scripts/keeper/amsterdam-estimate-smoke.mjs` from the repository
root with `SH_KEEPER_RPC_URL` set. It uses no key, never sends, and spaces RPC calls by at least 2.1 seconds.
It funds a random sender through a state override; if unsupported, set `SH_KEEPER_SMOKE_SENDER` to a funded public
address. It checks Sepolia's fork/header, transfer estimate and local over-cap refusal. It is not a live gate.

Every admitted send reserves **gas limit × maxFeePerGas before broadcast**, adding the larger of 20% or 150,000
gas headroom while respecting destination limits. Only padding may shrink; an estimate or floor that cannot
fit defers. V2 floors measured by FINAL2-GAS and FINAL3-G01 are: failure/failClosed 15M (since RC6-RR-INBOX's inbox
sweep, failure's fifth optional call; SH-V21-RC6-INT part 5),
graduation 13.5M (both burns, both pokes and ledger-token history), collect 5M before Amsterdam / 8M on Amsterdam (rc7 part 3 review),
buyBack/deepen 8M, sellFees 8.2M before Amsterdam and 16M on it (SH-RC7-HOOK-PAGE: up to 32 FIFO sources a
press, twice the integrator's cold exhausted-tip measurements of 4,001,971 and 7,668,544 gas; RC6RR2-HP-2; after
uncollected trades a press needs up to 4,160,008 and 8,345,458, which the floors admit with 1.97 and 1.92 times, P4R-1) and 3.5M for a simulated zero-P page
(no tip, so no tip stipend: more than twice the cold 32-dust page's 1,581,472 on Amsterdam; a page that turns positive
by inclusion runs as at the positive-P floor or reverts whole, never in part, `test/box-v2/rc6rr2/ZeroPageFloor.t.sol`), pending burn 1.5M, royalty forward 3M and router sweep 2M. Shop floors stay 5M/2M.
The rc7 collect floor covers 1.2 × (cold least successful transaction gas + 107,920), allowing one fresh slot.
The second buyer tip's admission check binds; total gas used understates the allowance needed, already at rc6 on
Amsterdam. Both tips and both allocated amounts must equal the unrestricted call. See the
[af2 measurements](../../docs/evidence/SH-RC7-RECEIVER-QUOTA.md#af2--2026-10-19-fork-aware-collect-floor) for all ten menus and both tip states.
Safe payouts retain estimate-driven limits with a 12M four-part operating allowance. Higher pending estimates
still win. Box 0 keeps its 3.5M failure floor and existing estimate policy. Reverted,
zero-work-at-inclusion and ambiguous sends remain fully reserved. Tips never replenish the daily ceiling. Limits
are UTC submission-day reservations, not a forecast of eventual inclusion time or net operating profit. Backward
block time cannot reopen yesterday's budget. Once a send's receipt is in a finalized, canonical block and from this
keeper, its daily reservation is settled to what it paid (gas used times the effective gas price) on every daily
counter it was charged to (RC6RR2-HP-2, an integrator decision: a 16M press reserved at 2.05 gwei took a third of the
ordinary day for good while it paid a tenth of that); a send without such a receipt stays charged in full for its day.
F111's rolling income spend still counts the whole signed maximum. V2 reserved daily capacity is shared by failure, graduation,
the keeper's own `claimReward`, fixed-Safe payments, burn and royalty retries, router sweeps,
P holder settlement/residue, item sync, P item residue, shop burn/return and pile seed load/return retries.
Purchased-T holder settlement and T residue burns are ordinary work and cannot use it.
Failure/close, reward claims and direct holder self-claims never wait for a batching minimum.
Box 0 retains its failure/graduation/reward-claim reserve policy.
FINAL2-GAS and FINAL3-G01 supply the measured contract envelopes on both hardforks; arbitrary issuer code and live-node estimation remain outside those measurements.

The CLI atomically saves state with file and directory fsync, uses an exclusive lock, and refuses malformed state
or a different chain/signer/registry identity. Dry runs append `.dry` to the state filename. Use one process and one
state file per gas wallet; keep the state across restarts and releases. A crash leaves its lock in place with pid, start time and UUID. Startup writes a safe refusal record.
After confirming the previous process stopped, use `pnpm --filter @squarehole/keeper lock show <state file>`
and `lock adopt <state file> <id>`; see [Leftover lock](../../docs/ops/drand-poster.md#leftover-lock). Never
start with a blank state to bypass a spent budget. Normal shutdown archives the released lock next to the state.
Live mode saves each signed transaction in `<state file>.sent` before broadcasting it and numbers sends from that
record (SH-249); `pnpm --filter @squarehole/keeper sent <copy of the state file>` with `SH_KEEPER_RPC_URL` reports it
read-only. See [saved transactions](../../docs/ops/keeper.md#saved-transactions-sh-249).

| Variable | Default | Meaning |
|---|---|---|
| `SH_KEEPER_RPC_URL` | required | Public RPC |
| `SH_KEEPER_RPC_FALLBACK_URL` | none | Optional second public RPC, chain-checked before use; wrong chains stay refused until restart; a primary that gives no answer rests five minutes while the fallback serves |
| `SH_KEEPER_PRIVATE_KEY` | none | Gas-wallet key, live mode only |
| `SH_KEEPER_DRY_RUN` | `1` | `0` enables sends |
| `SH_KEEPER_CHAIN_ID` | `11155111` | Chain identity only |
| `SH_KEEPER_ALLOW_MAINNET` | `0` | Explicit opt-in required for chain 1, even in dry-run mode |
| `SH_KEEPER_ADDRESS` | none | Public keeper address for keyless dry runs; must match the signer when a key is present |
| `SH_KEEPER_DESTINATION_FORK` | required | Explicit `cancun`, `osaka` or `amsterdam` rules |
| `SH_KEEPER_TRANSACTION_GAS_CAP` | required | Positive decimal gas cap; `none` only for Cancun |
| `SH_KEEPER_BOX_REGISTRY` | none | V2 registry |
| `SH_KEEPER_FROM_BLOCK` | `0` | Earliest deployment block across watched releases, for royalty and drand request backfill |
| `SH_KEEPER_BOX0` | none | `coordinator,hook,receiver,executor` |
| `SH_KEEPER_STATE_FILE` | `.cache/keeper-state.json` | Durable state, relative to process working directory |
| `SH_KEEPER_MONITOR_FILE` | none | Monitor view rewritten after each tick, `.dry` added in dry runs ([contract](../../infra/server/monitor/keeper-view.md)); unset: no view, no extra reads |
| `SH_KEEPER_OURS_WEI_PER_DAY` | `102000000000000000` | Our daily maximum-cost reservations |
| `SH_KEEPER_POKES_WEI_PER_DAY` | `12000000000000000` | Separate poke budget |
| `SH_KEEPER_RESERVE_WEI_PER_DAY` | `51000000000000000` | Shared protected capacity for exits, v2 Safe payments and recovery retries |
| `SH_KEEPER_TOTAL_WEI_PER_DAY` | `114000000000000000` | Ordinary ceiling including tipped jobs; R62 rescue has its own cap |
| `SH_KEEPER_DRAND_RESCUE_MAX_FEE_WEI` | `50000000000` | R62-FEE ceiling; positive and at least the configured ordinary fee |
| `SH_KEEPER_DRAND_RESCUE_WINDOW_SECONDS` | `259200` | Strictly less than 72 hours to deadline; zero disables rescue |
| `SH_KEEPER_DRAND_RESCUE_WEI_PER_DAY` | `50000000000000000` | The only separate drand allowance, 0.05 ETH; zero disables rescue |
| `SH_KEEPER_GRADUATION_BOUNTY_WEI` | `0` | Optional box 0 graduation pot; at most 0.05 ETH and ordinary ours room; gas plus value use ordinary limits |
| `SH_KEEPER_MAX_FEE_WEI` | `3000000000` | Fee ceiling, including priority fee |
| `SH_KEEPER_MAX_TX_PER_BLOCK` | `4` | Submission rate limit |
| `SH_KEEPER_PRIORITY_FEE_WEI` | `50000000` | Priority fee |
| `SH_KEEPER_PAYOUT_MIN_WEI` | `10000000000000000` | Box 0 payout threshold only; never compared to raw ERC-20 P |
| `SH_KEEPER_COIN_MINIMUMS` | `{}` | V2 per-coin `collectRaw` overrides; JSON address map with positive uint256 decimal strings |
| `SH_KEEPER_RETRY_BLOCKS` | `25` | V2 maintenance and FIT execution retry cadence |
| `SH_KEEPER_EXECUTOR_MAX_CHUNKS` | `1` | Positive chunk request, at most 32; on-chain limits still apply |
| `SH_KEEPER_BUYBACK_ALERT_BLOCKS` | `300` | Alert after this many blocks with a buy budget one `buyBack` can buy in a graduated box (the buy-back P or one reward kind at or above the hook's `STEP_MIN_Q`); a buy restarts the count; a leftover below the minimum, or any budget before graduation, never alerts |
| `SH_KEEPER_UNBLOCKING_GAS_PER_BOX_PER_DAY` | `816000000` | Signed gas a box's unblocking work may reserve a UTC day |
| `SH_KEEPER_UNBLOCKING_WEI_PER_DAY` | half of ours less reserve | Wei all boxes' unblocking work may reserve a UTC day, never exceeded |
| `SH_KEEPER_UNBLOCKING_WEI_PER_BOX_PER_DAY` | a quarter of the above | A box's unblocking work waits once it has spent this |
| `SH_KEEPER_POLL_MS` | `4000` | Poll interval |

At the default 3 gwei fee ceiling, a 13.5M graduation estimate pads to 16.2M and reserves **0.0486 ETH**,
with 577,216 gas below the Osaka transaction cap. A failure/failClosed estimate below 12.5M is raised to the 15M
floor and reserves 0.045 ETH; a larger one pads up to the 16,777,216 cap and reserves at most 0.0503 ETH, inside
the protected 0.051 ETH. A low estimate raised to graduation's floor alone reserves 0.0405 ETH; a floor itself is
not automatically padded.
The 0.102 ETH ours budget leaves **0.051 ETH for ordinary work** and **0.051 ETH protected** for the
recovery jobs listed above. Pokes have 0.012 ETH, and ordinary sends share the 0.114 ETH ceiling. R62 drand rescue has its own cap.
A 12M Safe-payout estimate reserves 0.0432 ETH after padding at 3 gwei; each published recovery
allowance fits individually even when only the protected capacity remains. Safe payouts remain
estimate-driven. Collect, buy-back, deepen and Box 0 executor maintenance cannot consume the reserve,
even with a covering tip. Recovery jobs share it: a payment or retry reduces what remains for a later
graduation or failure. Larger estimates or spent capacity can defer any job; these limits do not promise
every job across every box can send in one day.
The keeper waits when its proposed max fee (twice the pending base fee plus priority fee) exceeds
3 gwei, without charging the budget, except the three drand jobs under the R62 deadline rule below.
Ordinary work retries when fees fall. These are daily ceilings, not costs;
actual spending is gas used at the actual fee, tips repay most jobs, and the wallet balance is the hard limit.
Persisted spend is retained when these defaults change; custom budgets may cause explicit deferrals.

Unblocking work (LIM-4 and the second release review: `royaltyRefresh`, `royaltyObserve`, a simulated zero-P or
below-a-hundredth-of-the-step-minimum press, a below-floor collect for the cursors) spends no F111 credit. It takes a
per-box daily gas allowance, `SH_KEEPER_UNBLOCKING_GAS_PER_BOX_PER_DAY`, default `816000000` (24 of each job at its
published floor: 5M refresh, 5M observe, 16M press, 8M collect), and two wei ceilings, so it can never take the room
other boxes' income-funded work needs:
`SH_KEEPER_UNBLOCKING_WEI_PER_DAY` for all boxes together, never exceeded, default half the ordinary ours room
(0.0255 ETH), and `SH_KEEPER_UNBLOCKING_WEI_PER_BOX_PER_DAY`, a box's share, default a quarter of that (0.006375 ETH):
a box waits once it has spent its share, so its last send can cross it by that send alone. Each is zero to disable.
Full signed gas is reserved before broadcast, including ambiguous sends; fixed daily wei ceilings and the recovery
reserve still bind. See [the operations note](../../docs/ops/keeper.md#lim-4-unblocking-allowance).

F111 also limits ordinary v2 work: collection at or above its floor, buy-back, deepen, positive-P sale steps, eating,
pile moves, purchased-T holder settlement and T residue burns. The window is the **rolling 24 hours**
ending at the pending block time, separate from the fixed daily limits above. For each box, gas reserved
minus received tips may use at most that box's own platform share. Across the keeper, it may use at most
one quarter of platform income received in the window. The 1/15 is the platform's part of the 3/15
protocol share: FIT gets the other 2/15. It is measured after the contract's reserve, tip and rounding;
it is never computed from trading volume or a displayed price.

The keeper range-reads finalized logs of registered boxes only; every proof, such as the fixed platform Safe's
receipt, comes from the receipt of the transaction that emitted the box's own event (SH-247). Native income
requires matching `PlatformPaid` and `SafeReceived` records. Each box reads within its own budget a tick; a box that
cannot be read counts zero for that tick and no other box changes
([income reads](../../docs/ops/keeper.md#what-counts-as-income)). Owed money, reverted payments, unrelated
Safe deposits and removed logs create no room. Native collect tips must name this keeper; buy-back and
deepen tips must also have a directly decoded call naming it. A registered native-P coordinator's
`PotFixed` receipt credits its paid closer tip only when `closer` names this keeper, within the same
window. This repays both the box's spending and the keeper's total spending allowance once.
Tips reported as unpaid count as zero.
A simulated tip creates no credit. Neither a received tip nor income increases the fixed daily ceilings.
All amounts remain integer wei. ERC-20 receipts, including WETH, have no assumed ETH price: until a
reviewed sale/unwrap attribution adapter proves their actual native proceeds, they create no wei room.
The receipt-source interface and local funded doubles are covered by the F111 tests; they are not a live
conversion adapter. See [F111 evidence](../../docs/evidence/SH-V2-KEEPER-F111.md) for the integrator handoff.

A new box with no received share or tips waits for another permissionless caller to establish those
receipts. The keeper does not bootstrap ordinary work from another box's income. It logs exhausted or
unavailable income and tries again when room exists. Recovery jobs, fixed-Safe payments and retries are
not income-capped, but still share the protected daily reserve and ordinary 3 gwei ceiling.
The three R62 drand jobs can instead use their deadline rescue cap. FIT's executor
keeps its existing sample trigger, cadence and fixed budgets, without the v2 income caps.

The existing batching rules still apply: collections wait for their raw-coin minimum, buy-back and
deepen require waiting money and a useful pending simulation, alternate at most once per pool per
block, and the keeper submits at most four jobs per block by default. Empty or below-minimum work
spends no gas. These are bounded submissions and accumulated batches, not an atomic multicall.
A pending live transaction reserves its full signed maximum cost before broadcast. Its rolling charge ages
from its confirmed inclusion time, not its submission time. Missing hashes (only in journals from before SH-249), ambiguous sends and receipts
that cannot be proved finalized keep their reservations. Restarting or crossing midnight cannot reset
them. If old state lacks attribution, its recorded spend is conservatively charged against every box
until the operator reconciles it. Preserve the journal and reconcile transaction hashes; never clear it
merely to restore budget. Use one keeper journal for this gas wallet and registry. Income/tip expiry can
remove room; each new admission checks the current window and waits if existing charges already exceed it.

Dry runs use the separate `.dry` journal and never broadcast. They model each admitted job as included
at its saved pending-block timestamp. Its simulated cost expires exactly 24 hours later, including
across restarts and for older hashless dry entries. Before then it still consumes income room.
This expiry never creates receipt credit or replenishes fixed daily ceilings; fresh verified income
and remaining daily capacity are still required. Live reservations retain the receipt rules above.

V2 defaults the collect minimum to **0.01 P**: `10000` raw units at 6 decimals, `1000000` at 8, and
`10000000000000000` at 18. Other admitted decimals (6–18) scale the same way. Native ETH uses 18;
ERC-20 decimals are read at the same canonical block as the box. This is a batching floor, not a price or a
guarantee that the amount covers gas; operators can tune each coin independently. For example:

```json
{"0x0000000000000000000000000000000000000000":{"collectRaw":"20000000000000000"}}
```

Set that JSON as `SH_KEEPER_COIN_MINIMUMS` for a 0.02 ETH collect minimum. Remove the obsolete `payoutRaw` field when updating old configuration (F127).
Keys are coin addresses on `SH_KEEPER_CHAIN_ID`, case-insensitive; the zero address is native ETH. `collectRaw`
is required per override. Numeric JSON amounts, zero/negative/fractional/overflowing strings, unknown fields and
duplicate addresses with different casing are rejected. Unlisted coins retain their decimals-based defaults.
If decimals cannot be read or are outside 6–18, only collect batching waits; an explicit raw override can
still serve that coin. Metadata failure never cancels a failure/close or claim job, or graduation settlement.

For live boxes, collect remains periodically simulated so unharvested LP fees, sale fees and donations can accumulate to the
minimum. The comparison sums the returned buyers' fees (already net of the tip), sellers' fees, D6 reserve and
successfully paid tip once each. Amounts below the minimum spend no transaction budget and
retain the existing retry cadence; they stay in their on-chain ledgers until the minimum is met or anyone calls
the permissionless entries directly. No contract minimum or withdrawal restriction is added.

Removed converter/module/cap/sampler/oracle settings schedule nothing. Private endpoint/key options remain for
compatibility with the adapter's separate nonces; none of these permissionless jobs requires private delivery.

## Local verification

The fake RPC tests cover decoding, dry runs, refusal isolation, discovery, reorg removal, hatch boundaries,
step alternation, budgets and restart state. The keeper-owned Solidity smoke test uses the merged coordinator,
real PoolManager and CQ11-C's other-part fixtures; it does not certify the unmerged hook or factory.

From `packages/contracts`, run on each EVM:

```sh
FOUNDRY_TEST=../keeper/test/solidity FOUNDRY_FUZZ_RUNS=256 forge test --offline --match-path '**/{KeeperCalls,M2Calls}.t.sol'
FOUNDRY_TEST=../keeper/test/solidity FOUNDRY_FUZZ_RUNS=256 forge test --offline --hardfork amsterdam --match-path '**/{KeeperCalls,M2Calls}.t.sol'
```

`pnpm --filter @squarehole/keeper ours:write` regenerates the cost table. The retained `poke-history` script reads
public histories when explicitly invoked; it is not a scheduled v2 job. No deployment, live RPC soak, Safe signing,
production gas calibration or fork release verification is established by these local tests.


## Drand never-stuck safeguards (F142, R62-FEE)

`drandPostRound`, `drandRequestWord`, `backupStart` and `backupFix` first use the unchanged reserved ours path.
Inside the configured deadline window, an ordinary fee/daily refusal can use up to 50 gwei from the separate
0.05 ETH UTC rescue cap. Posts and backups require a pending time no later than their deadline;
a missing graduation request can still save the box after its thirty-day deadline. An unreadable assignment
vault uses ordinary limits. The exported `DRAND_RESCUE_JOBS` is the sole eligibility list.
A timely posted word never expires, so `drandAcceptWord` keeps the ordinary fee and daily limits and its
protected reserve; it never uses `drandRescueWei` (integrator decision, 2026-10-21).
`drandRescueWei` is outside ours, pokes and total; its reservations settle only that counter. No ordinary-fee
allowance outside the fixed daily ceilings exists. Bounties remain pull credits, never tips. The optional
box 0 top-up reserves gas plus value as ordinary ours work, retains value on settlement, and never uses rescue
or protected capacity. V2 boxes get no automatic bounty.

Four pinned quicknet relays race with JSON Accept and `curl/8 (squarehole keeper)` User-Agent headers.
The reader independently checks up to 64 keys per consumer from the head, including queued draws during
`AwaitingWord`, while keeping log scans as hints and retaining the monitor’s completeness definition.
SIGTERM stops before the next candidate and checkpoints; the server releases its lock before forced timeout
exit and after a 45-second stop budget. The ordinary above-3-gwei monitor pause remains until the monitor’s
separate ticket lands. See [drand operations](../../docs/ops/drand-poster.md) for exact clocks, warnings,
configuration and recovery commands.

Box 0's backup starts strictly after day 5 and with 96 seconds left before day 5 and 18 hours.
It fixes only a finalized target at most 8,183 blocks old, with 96 seconds left before the earliest live request's
seven-day deadline. Proven RLP headers bind both calls to their block hashes; unknown formats defer with
`backup header mismatch`. The start and fix are paid by our keeper. The next read accepts the timely word.
With box 0 configured, a background header self-check starts on the first read and every 86,400 seconds of
pending-block time, using latest minus one. It signs nothing and does not hold up candidates or sends.
Success logs `backup header self-check ok` with block and path (`raw` or `fields`); failure logs the fixed
`backup header self-check failed` with only the block and leaves drand read completeness unchanged.
The monitor view's optional `backupHeader` holds the last completed result: decimal-string `checkedAt`
and `block`, boolean `ok`, and `path` (`raw`, `fields`, or null). It is absent before completion and resets
on restart. The monitor needs a later ticket to alert on failure or a result older than about 26 hours.
A successful post by this process defers that round's backup start until the post's retry block (N+2),
with informational `round post pending` and unchanged queue state. Restart forgets this guard.
These properties are pinned in `test/backup-jobs.test.ts` and `test/backup-header.test.ts`; live provider and
finality checks are recorded in `docs/evidence/SH-RC8-BACKUP-JOBS.md` at the repository root. Self-check and
pending-post properties are pinned in `test/backup-self-check.test.ts` and `test/backup-pending-post.test.ts`.
