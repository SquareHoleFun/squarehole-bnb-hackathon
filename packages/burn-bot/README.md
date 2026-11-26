# CQ11 burn bot

Private operations library for M1-54 / SH-V2-CQ11-E2. Policy authority:
[burn-bot runbook](../../docs/ops/burn-bot.md), ADR-0017 Amendment 3 C12, F120-F123, and F160 and F164 D2, which
remove its platform role: it builds transactions for the FIT Safe only and applies no platform cap.
SH-MN-03 adds an explicit RPC/Safe-service runner and an external managed-signer interface. It has no key loader,
relayer or automatic execution.
Node 24 provides the SQLite journal; viem and zod are the existing pinned workspace dependencies.

## Runner entry point

One bounded daily cycle: finalized reads, quotes, Safe proposals, reconciliation and an append-only journal.
No transaction broadcaster or key loader. Run with the repository's Node 24 and installed lockfile dependencies:

```sh
node --experimental-transform-types packages/burn-bot/run.mjs --config bot-public.json --dry-run
```

The operator supplies the reviewed public configuration and endpoint environment variables. Dry run is the
default, writes only `<journal>.dry`, and never signs or posts. Chain 1 requires `--allow-mainnet` even in dry run.
Proposal mode additionally requires `--propose --signer-command managed-bot-sign`. The external command consumes
a digest on stdin; the repository never holds its signing material.

Read the [operator procedure](../../docs/ops/burn-bot.md#10-operator-runner-and-24-hour-sepolia-dry-run) for the
configuration schema, v4 hook routes, signer protocol, cancellation, restart and Sepolia gate.
The package exports interfaces for fakes and external adapters. Offline tests:

```sh
pnpm exec vitest run --maxWorkers 4 packages/burn-bot
```

## Actions and custody

| Safe | Source | Built transaction |
|---|---|---|
| FIT, 2-of-3 | Non-ETH/non-FIT fee lot | Exact-input sale to native ETH, with the FIT Safe receiving proceeds |
| FIT, 2-of-3 | Its own ETH | Exact `fundBudget()` value at the pinned box-0 executor, only after canonical `graduated()` |
| FIT, 2-of-3 | Its own FIT | FIT `burn(amount)`, graduation-gated; confirmation requires the supply reduction |
| Conversion, 2-of-3 | Attributed non-P royalty, including FIT | Sale to that recorded box's P, received by the conversion Safe |
| Conversion, 2-of-3 | Confirmed converted P | The recorded receiver's `fundRoyalty(P, amount)`; native value or exact approval/pull/revoke |

The manifest pins the chain, the FIT Safe, its owners and reviewed Safe configuration (a `platform` entry is refused,
F164 D2), box-0 identities, receiver/P identities,
MultiSendCallOnly address/code hash and each asset-pair route. Every numeric operational limit is explicit.
`assetDecimals` pins canonical decimal strings (6 through 18) by token address, including every route input/output,
box P, WETH and FIT. Confirm token metadata at the reviewed manifest block before enabling it; native ETH always
uses 18 decimals and WETH must also be 18. Missing or malformed metadata and mismatched receipt decimals are refused.
Confirmed sale lots take their output asset's decimals. Original input amounts/assets/decimals remain in the
separate receipt lot and sale draft; the output lot's proposal-based id links them to its execution. The source
event stays with the original receipt, including through restart.
Use `Bot.migrateManifest(next)` for owner-reviewed configuration changes before restarting with the new manifest.
It appends both revisions and replays historical rows under their original manifest, preserving all reservations,
consumed nonces and receipt identities. Each policy version is used once.
Boxes and token metadata may be added; existing box receiver/P identities and asset decimals cannot change or
disappear. Routes may be retired or revised with a fresh route version; deployment and custody identities stay
fixed. An unchanged route identity preserves its daily input accounting. This is a configuration migration, not
reorg recovery, ownership rotation or permission to reset a journal. Pending old-route proposals remain reserved
and can still execute with old signatures; reconcile them or propose a cancellation before reusing their inputs.
Migration refuses while any `propose` or `proposeCancellation` operation is in progress, from its
first read through signing, service submission and acknowledgement recording. Wait for all operations to settle
(including failures), then retry migration. Submission evidence and service origin use the validated revision.
`safeConfigs.fit` pins `version` (1.4.1 or 1.5.0), proxy `codeHash`, `singleton`, `singletonCodeHash`, `guard`,
`guardCodeHash`, `handler` and `handlerCodeHash` from reviewed deployment evidence. Zero guard/handler addresses have
zero hashes. A snapshot supplies `singleton`, the observed version/owners/threshold/modules/guard/fallback handler,
and code hashes for the Safe, singleton and any guard or handler at the same finalized block. Every identity must
match, with no modules, and the FIT Safe's 2-of-3 owner rule (bot, founder, backup) stays. The bot reads no other
Safe, so the platform Safe's version, owners and threshold (2-of-3 on mainnet, F151) never stop it.
A recognized version alone does not admit arbitrary code. Copy these fields from the verified `safes` deployment
attestations, never populate a pin from an unreviewed proposed address's self-reported values.

Manifests with only the old `safeVersion` and no runtime evidence are refused. Historical journals using that
shape need an owner-reviewed, separately implemented migration; this change neither guesses identity pins nor
resets their accounting. Preserve those journals and pending signatures for reconciliation.
The builder does not enforce policy on Safe owners themselves; co-signers remain a security boundary.

V3 routes use the original v3 SwapRouter `exactInput` ABI with a deadline. Native input wraps exact ETH to WETH
first; native output uses router custody only within `exactInput` plus `unwrapWETH9(minimum, Safe)`.
WETH-only redemption uses exact transfer to a pinned SwapRouter02 and its deadline-bearing multicall unwrap.
It never uses a bare, deadline-free WETH withdrawal. Paths and fees are fixed per pair; no aggregator calldata,
route discovery, arbitrary spender, route delegatecall or fallback route is accepted. MultiSendCallOnly is the
only outer delegatecall; all inner calls are CALL. Approvals are zero/exact/revoke inside the atomic batch.
Only standard exact-transfer assets proved on the eventual fork may be enabled; fakes do not certify issuer tokens.

Quotes bind chain, assets, route version, input, block number/hash/timestamp and deadline. Minimum output is
`quotedOut * (10000 - slippageBps) / 10000` in bigint, rounded down and strictly positive. Later signing snapshots
must include the original block in their verified `quoteBlocks`; expiry and identity checks still apply.
FIT funding and burns fail closed on unavailable/malformed graduation reads, wrong wiring or observed failure.
Before execution, the human co-signer must repeat these checks and simulation. No off-chain snapshot creates an
on-chain graduation guard in the unchanged box-0 executor.

## Daily planning and transport boundary

Use one journal for this chain and the FIT Safe, across every release.
At one finalized cutoff per UTC day, ingest and reconcile receipts, select FIFO clips, and call `Bot.plan` with
successive Safe nonces. Each clip has its own atomic Safe transaction so a refusing asset does not stall unrelated
assets. The batch id is chain/Safe/UTC-day; the full cutoff snapshot is recorded with every proposal.
Daily proposal count, reserved transaction gas and route input limits are checked. These are planning limits;
the execution operator must enforce the manifest's fee ceiling and gas budget when scheduling actual attempts.
Each action and cancellation retains the gas charge from the manifest active when it was planned. Replay
recovers that charge from the journal's historical manifest revisions, including for pending, failed and completed
attempts. A limit change never reprices earlier usage in the same Safe/UTC-day budget. Simulation uses the smaller
of the original reservation and the current transaction limit, recorded as `gasLimit` on the submission row;
service retries do not reserve or charge a second attempt. Operators must honor this bound at execution too.

`Bot.propose` re-reads the Safe, chain and box identities and simulates the complete transaction. Queued nonces
require every predecessor to be reserved in the journal. The injected simulator must support the queued Safe nonce
without inventing funds or effects, and co-signing/execution requires a fresh simulation. The digest signer signs
only the EIP-712 Safe digest; the recovered address must be the bot owner. It cannot execute a 2-of-3 Safe alone.

`servicePayload` returns the transaction-service fields as plain JSON, including decimal strings for amounts and
counters. Its `safe` field selects `/api/v1/safes/{safe}/multisig-transactions/`; the transport sends the remaining
fields as the POST body. Signature-bearing payloads go only to the private proposal transport, never the public
journal. Service version/delegate acceptance must be proved before enabling transport.
An API acknowledgement is never a second signature or execution proof.

Chain adapters are trusted evidence producers: they must verify finalized canonical blocks, Safe configuration and
code hashes, source events/actual receipt deltas, quote fees, exact balances/allowances, receiver identity and state,
simulation, execution events and supply effects. `canonical` and `effectsVerified` are assertions from that adapter,
not proofs obtained merely by parsing JSON. SH-MN-03 supplies a viem adapter; verified deployments and real
route/Safe proofs remain integration requirements. Its automatic reconciliation supports direct Safe executions;
the library can also accept independently proven nested-relayer effects through its existing interface.

`receive` accepts confirmed FIT Safe receipts only: external transfers and unrelated Safe income must not be
relabelled as v2 receipts, and a platform lot is refused. `quarantine`
publishes unattributed, unsupported, paused or not-yet-forwarded amounts without making them spendable.
Non-P M2 earnings are refused. Each conversion clip belongs to one box. A confirmed sale creates a separate P lot;
failed returns leave that P lot owed, without reselling the input. The receiver applies its own current phase,
including permanent failed-box claim-pot routing; the bot never substitutes a creator payment or donation.

## Confirmation, downtime and publication

Reservations are committed before signing/submission. Service failure or restart retains the reservation and retries
the same hash. `resolve` requires canonical consumed-nonce evidence and verified exact effects.
It requires `chainId`, `safe`, `txHash` and the Safe execution event's `logIndex`, bound to the expected nonce and
`safeTxHash`. Deduplication uses `(chainId, txHash, logIndex)` across actions and cancellations; a relayer may execute
several Safe transactions in one chain transaction. A proposal can resolve only once, even under a different log.
Adapters must supply the canonical `ExecutionSuccess`/`ExecutionFailure` log index (the replacement's execution
for cancellation), not the index of a transfer or another effect event. Old resolution rows without this identity
require owner-reviewed reconciliation from canonical receipts; no default index or automatic migration is used.
A transaction that reverts without consuming the Safe nonce remains pending, because its old signatures can still
execute. A cancelled proposal requires proof of a different transaction consuming that nonce. Deleting a service
proposal is insufficient. Failed/cancelled atomic batches cannot report a partial principal spend.

For a stale clip reverting `GS013` (`safeTxGas = 0`, no gas refund), call
`planCancellation(originalId, freshSnapshot)`, then `proposeCancellation(cancellationId, reader, service, signer)`.
This publishes a zero-value, empty-data CALL to the Safe itself at the **same nonce** and stops further bot
submission of the original. It needs a fresh Safe check/simulation and the normal second signature. Planning
counts toward the daily action/gas budget. Service
retries reuse the cancellation hash. Neither planning nor submitting releases inputs. After canonical
`ExecutionSuccess` and zero-effect verification, `resolveCancellation` consumes the nonce and releases the
original reservation exactly once. If the original wins the race, resolve it normally: its inputs are consumed,
its proceeds stay attributed, and its cancellation becomes unusable. A retired route or expired quote cannot
block this self-call. The adapter must not report an outer `GS013` revert as a nonce-consuming Safe failure.

Funding is confirmed by `BudgetFunded`, direct burns by a supply delta, and royalty returns by `RoyaltyFunded`.
`recordExecutorBurn` records canonical `TokensBurned(bought, unsolicited)` once per event and reconciles its sum
to the supply reduction. `Executed` summarizes the same burn and is not counted again. Shared executor burns are
aggregate records, never attributed exactly to a particular funding lot.

`SqliteAppendStore` commits compare-and-append under `BEGIN IMMEDIATE`, FULL synchronization and WAL; stale writers
fail. Journal rows have monotonic decimal sequence numbers, canonical hashes and previous hashes. SQLite triggers
refuse updates/deletes through ordinary database operations. `publish(newFilename)` creates an immutable JSONL
snapshot with exclusive creation. Publish the head in a separately signed checkpoint; `Journal(store, head)` detects
truncation against it. A hash chain alone does not stop a privileged operator replacing the whole database.

Bot records contain UTC time, schema/policy identity, chain/Safe/batch identity, attribution, raw decimal amounts,
decoded calls, hashes, quote/simulation context and proposal/confirmation state. Pending chain hashes are null.
No private key, credential or executable signature is logged. `reconcileAsset` verifies exact per-asset conservation;
funding and the subsequent FIT burn are separate asset movements.

A reorg/correction appends an orphan record and freezes new proposals/releases. Automatic correction and unfreezing
are deliberately unavailable: owners must reconcile canonical events, every live nonce and old signatures before
an explicitly reviewed recovery/migration. Original rows stay published. Owners can still co-sign manually while
the bot is stopped, and permissionless box operations/claims remain independent of this package.

## No platform cap

F160 removes the platform cap: no 32 ETH combined or 16 ETH v2 policy, no receipt epoch, no excess transfer to the
FIT Safe and no platform ledger. Journals with cap rows are refused, not replayed. See the
[runbook's section 5](../../docs/ops/burn-bot.md#5-no-platform-cap-f160).

## Verification and release boundary

The TypeScript suites and generated-calldata EVM suite use only fakes and deterministic local data. The existing EVM tests
exercise the v3 and unwrap route forms, rollback, positive minima, Safe output recipients and zero final approvals.
They do not prove real Safe threshold checks, actual router/issuer behaviour or receiver execution. Production
route manifests, deployments, finality/budget values, real Safe/fork tests, Sepolia transfers and G1's fresh Claude
security review are integration gates in the runbook. There are no live addresses or live-funds authorization here.
