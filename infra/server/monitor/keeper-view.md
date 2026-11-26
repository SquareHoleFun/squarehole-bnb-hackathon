# Keeper monitoring view v1

This is the read-only handoff between the keeper and the monitor, requested in SH-MN-09-MONITORING. Since
SH-KEEPER-MONITOR the keeper publishes it (`packages/keeper/src/monitor.ts`, section *Producer* below). Missing,
partial, stale or wrong-identity views are `unknown` and prevent all-clear. Do not manufacture an empty view to
enable the timer. The monitor does not scrape log lines: drand warnings are throttled, and their absence does not
prove requests are healthy.
The drand timing ladder comes from the monitor's own finalized reads in `drand.mjs`, not from this view.
Box 0 must name `drandBackedSource` and that source's finalized `DRAND()` must equal `drandSource`;
version 2 must name `drandSource` directly. The monitor reads `backupOf` once per unsettled box 0 round,
including fixed words until acceptance/settlement. Stages batch across tickets under the 40 s budget
from collect's run start. Terminal/idle tickets skip gate and key reads; only live, unrequested graduation
with slots reads its gate. Every owner of a failed batch becomes unknown; completed tickets keep their rows.
Due and closing use the finalized block. Closed uses the
latest block (one extra serial read per run while any box 0 backup is started and unfixed) and the round's
earliest live deadline; a failed or inconsistent latest read makes the affected tickets unknown.

The monitor's `rescueWork` mirrors SH-RC8-BACKUP-JOBS: no box 0 post after a backup starts; `backupStart`
from strictly after round time +432,000 through latest start −96 seconds (latest start is round time +496,800);
`backupFix` only for a started, unfixed target at or behind the finalized block, no more than 8,183 blocks behind latest,
and with at least 96 seconds to the earliest live request's seven-day deadline on that round. Work must be
strictly inside `drandRescueWindowSeconds`, nearest deadline first, with the existing source, failed-read,
silent-head and terminal exclusions. Posts and missing graduation requests retain R62. A usable,
unaccepted graduation word does not: an accept waits at the ordinary fee ceiling because a timely word
never expires (integrator decision, 2026-10-21, F145 correction to F144). `keeper-fee` then names start/fix as
`drand-rescue-fee` when the R62 fee and daily allowance permit it. The 72 h, 50 gwei and 0.05 ETH/day defaults
are unchanged. This reads no new keeper journal/view field and still cannot see the next send's cost
(rc8 open item 67). See [Box 0 backup](../../../docs/runbooks/monitoring.md#box-0-backup) for the alert actions.

On the server the keeper container writes `/state/monitor.json` (`.dry` in dry runs), which the host sees as
`/var/lib/docker/volumes/squarehole_keeper_state/_data/monitor.json`, the monitor's default `keeperViewFile`.
Publish atomically: a new file
on the same filesystem, mode 0600, fsync, rename, fsync parent. One publisher per running keeper. Never include
RPC URLs, configuration dumps, keys, transaction signatures, relay responses or exception strings. Root/keeper
must control the parent; the monitor opens files without following final symlinks. Maximum JSON size: 4 MiB.

All integer and raw amount fields are **canonical unsigned decimal strings**, not JSON numbers. The keeper's
existing journal is consumed separately with its existing `version: 1` and `identity` fields. This view is
bound to that exact identity: `chainId:lowercaseKeeper:lowercaseRegistryOrEmpty:lowercaseBox0CoordinatorOrEmpty`.
Use the live journal in production, never its `.dry` sibling.

| Field | Meaning and required producer behavior |
|---|---|
| `schema` | Exactly `squarehole.monitor-keeper.v1` |
| `chainId`, `identity` | Same chain and signer/deployments as the keeper journal and monitor configuration |
| `observedAt`, `block` | Timestamp and height of the canonical snapshot block used for reads (currently `ViemChain.snapshotBlock`), not the proposed pending block. The publisher must read that block timestamp: the current `World.block` describes pending execution and can be in the future. Never refresh the timestamp on an old or failed read |
| `complete` | True only when discovery and all configured box/queue/income reads succeeded; false on omissions, read failures or incomplete scans |
| `failedReads` | Informational, not checked: how many guarded reads fell back this tick (decimal string) |
| `maxFeePerGasWei` | Actual proposed maximum fee (twice pending base fee plus configured priority), not just base fee |
| `queue.count` | Number of distinct outstanding keeper work keys, including jobs deferred by gas, daily budgets, income caps, backoff or per-block eligibility. Count protocol maintenance/recovery, **not** v2 holder/item claims |
| `queue.oldestBlock` | First canonical block at which the oldest still-outstanding work was observed; null iff count is zero. Preserve across restarts, rewind on reorg, remove only after a complete canonical read confirms completion. Do not count just this tick's eligible/sent jobs |
| `income.platformWei` | Current rolling 86,400-second platform income from the existing `readIncome` result |
| `income.unattributedWei` | Sum of active maximum-cost liabilities with `UNKNOWN_INCOME_BOX`; nonzero always requires operator reconciliation |
| `income.boxes[]` | One row per lowercase box address in the union of income credits and active attributed liabilities: `{box, shareWei, tipsWei, spentWei}`. `shareWei` is the already calculated box **1/15**, not gross volume/income; `tipsWei` is already received tips. `spentWei` sums `activeIncomeSpend` maximum-cost reservations for ordinary F111-capped jobs. Missing credits are zero; omit no liabilities. No USD, token-price guesses, forecast tips or protected recovery costs |
| `deferrals[]` | SH-236 additive latest-tick rows: `{boxId, job, code, observedAt, block}`. Decimal box id, known job and finite reason code from `skips.ts`; timestamps match this view. Includes quiet skips. Shared jobs without a box id are omitted and counted, never assigned an invented id. No addresses or raw reasons in these rows |
| `valuationFailures[]` | Latest income read's zero-valued token boxes: `{boxId, code, observedAt, block}`. Codes: `PIN_INVALID`, `VALUATION_UNAVAILABLE`, `INCOME_CAPACITY`, `OTHER` |
| `deferralsComplete` | False if a diagnostic lacks a valid box id or size truncation drops rows; independent of the old `complete` reading flag. Optional to old readers. Rows replace each successful tick, so recovered reasons expire without changing queue age |
| `deferralsOmitted` | Decimal-string count of omitted rows across `deferrals` and `valuationFailures`, including missing/invalid box ids and size truncation. Optional to old readers |
| `drand.complete` | True only when all configured consumers/current heads and the historical request scan are current, canonical and successfully read. False on any failed read, unwound scan or unfinished historical backfill |
| `drand.requests[]` | Each observed requested round: `{requestedAt, deadline, usable, silent}`; deadline is requestedAt + 604800. Booleans `usable` and `silent` come from the merged poster's canonical request/word/silence logic. Include silent requests/current heads even when their consumer is excluded from posting. Timely posted words remain usable after their deadline. Empty is healthy only after a complete scan |

The producer must use the existing poster's `wordOf`/`requestOf`/`isSilent` interpretation. A posted word with
`readyAt > deadline` is not usable. At exactly the deadline an unavailable word is nearing silence; after the
deadline it is silent. The monitor rechecks these time bounds at each run, including between keeper ticks.

The monitor's daily budget check reads the existing durable keeper journal (including conservative failed or
ambiguous reservations), resetting its *observation* to zero for a previous UTC day; it never writes that
journal. Its R62 rescue spend check reads the same journal's optional `budget.drandRescueWei` (zero when absent),
and its lock check the keeper's `<journal>.lock-refused.json` beside it (absent when healthy). Rolling income liabilities follow the keeper's finalized-receipt logic and must not reset at midnight.
Never drop hashless or unmined reservations because they are old. Snapshot and journal publication may straddle
one tick; each is independently freshness checked, not asserted to be an atomic accounting transaction.

`test/support.mjs` provides an explicitly fake complete view used by offline tests; `test/keeper-view.test.mjs`
feeds the keeper's real publisher through the monitor's reader and checks. This interface does not claim a
deployed publisher, or that missing readings are zero.

## Producer (SH-KEEPER-MONITOR)

Set `SH_KEEPER_MONITOR_FILE` (the server's service wrapper sets `/state/monitor.json`). Unset, the keeper makes no
extra reads and writes no view or queue. After each tick's final journal checkpoint the keeper rewrites the view; a
failed write logs `keeper monitor view not published` and the tick stands. A tick that throws, or whose snapshot
header cannot be read, publishes nothing, so the old file ages into `unknown`.

- `observedAt`, `block`: the header of the snapshot block (`ViemChain.snapshotBlock`, the pending block's parent),
  read in the same `read()`; never the pending time or the wall clock.
- `complete`: false when any guarded read of `read()` fell back after a node error or a failed consistency check,
  or the income read failed. A revert or an empty return is the chain's answer (an older receiver without a view,
  no code) and does not count. Some fallbacks are permanent, e.g. a box whose price coin reports unsupported
  decimals; the view then stays incomplete until the operator looks.
- `maxFeePerGasWei`: the tick's `feesFor` result, `2 x pending base fee + priority fee`.
- `queue`: the journal's `monitorQueue` maps each outstanding work key to the snapshot block it was first seen
  waiting. Per tick, a proposed candidate whose pending simulation found work but was deferred (budget, income
  cap, gas admission, private endpoint, send error) or whose simulation errored is added; one whose simulation
  found nothing is removed; one skipped before simulating (fee pause, rate limit, taken pool slot) keeps its earlier
  state. So does a v2 pool step waiting for its turn: the plan proposes one of `buyBack`, `deepen`, `shopFees` and
  `sellFees` a block in rotation, a step refused by a check of its own passes its turn (SH-KEEPER-V2-STEPS), and the steps
  behind the proposed one (or all four, when the block's protocol step is already taken) are not simulated, so a
  deferred step keeps its first block while the others take their turns. Any other key that was not proposed stays
  while its retry backoff runs or the read was incomplete, and leaves otherwise. A send removes the key: sent work is this tick's served job, not backlog, and if work remains the next
  simulation that defers it adds it again at that block. `oldestBlock` is the oldest work that has waited without a
  send, and a send's retry backoff (an hour for inbox orders) never ages into a backlog alert. An entry above the
  current snapshot (reorg) rewinds to it. Mid-tick reservation checkpoints carry the previous queue.
- `income`: from the same tick's `readIncome` snapshot and the active F111 reservations after admission. `boxes` are
  receiver addresses; spends against `UNKNOWN_INCOME_BOX` (old hashless journals) form `unattributedWei`.
- `drand`: every request state the poster's `readRequest` read this tick, including the head of a consumer it
  blocks for silence. `complete` needs no failed guarded drand read and a `Requested` scan that reached the
  snapshot block on one fork; a restart rescans from `SH_KEEPER_FROM_BLOCK` and stays incomplete until caught up.
  Requests of terminal tickets are not listed.

Limits: work the keeper sends every retry window but whose transactions keep reverting never stays queued (repeated
reverts show in the daily spend instead); work first seen during a fee pause is not counted until it is simulated. An oversized view (over
4 MiB) first drops `deferrals` and `valuationFailures`, counts those rows in `deferralsOmitted`, and sets only `deferralsComplete: false`.
If the object still exceeds 4 MiB, omit all four diagnostic keys entirely. Only if the old readings alone still exceed 4 MiB does the old fallback empty `boxes` and `requests` and set `complete` and `drand.complete` false.
# Set instance

`keeper-view.mjs --set [--config file]` selects the independently configured `keeper-set` instance. Without `--set`
the original command and its checks are unchanged. `keeperSetEnabled` defaults to false; enabling it requires a
separate public address, four-part identity, journal and view paths. See `docs/runbooks/existing-nfts-release.md`
for the server activation procedure and separate budget fields.

The server adapter publishes `squarehole.monitor-keeper-set.v1` at the set volume's `monitor.json` (`.dry` in dry
mode). It retains the common block, timestamp, identity, queue and fee fields and adds `sets`: each row contains
decimal-string `id` and `closedAt`, lowercase public `coordinator`, and boolean `closed`, `graduated`, `failed`.
It uses the same verified discovery snapshot as the tick, with no extra chain reads. `complete` reflects discovery;
optional income and drand do not govern set lifecycle health. Incomplete discovery never certifies an empty list.

The monitor uses separate `keeper-set-*` incident IDs for health, spend, reserve, queue, fee, lock and filled sets.
Each unfinished filled set has its coordinator as alert subject, closure time, age and nonnegative remaining escape
seconds. Severity increases at one hour and seven days. No set spend is charged to the original keeper's monitor
allowance. The file-only command leaves wallet reserve checking to the full monitor's independent balance read.


F182 start deferrals use `START_UNPAID`, `START_TIP_TOO_SMALL` and `START_COST_CAP`. A simulated start tip
never appears in `income`. An unpaid start's full signed cost remains in its box's `spentWei` beyond the normal
window. A sufficient final transaction tip keeps the normal rolling debit; later repayment holds the debit for
24 more hours. A start settles once on a final receipt. Its record is dropped 24 hours after it was paid. No new monitor
field or environment setting is required. When diagnostics are omitted at the size boundary, their absence
means unavailable diagnostics; the old readings remain complete if the old publisher could fit them.
