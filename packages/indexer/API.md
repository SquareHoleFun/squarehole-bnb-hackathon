# Core v2 participation API

These public, read-only routes are served by `src/core/core-gateway.ts`. Other core API routes remain documented in
that file's header. Addresses are lowercase. Raw token amounts, counts and block times are decimal strings; `chainId`
and `logIndex` are JSON numbers, as is each candle’s `trades` count. No floating point conversion is used for money.

## Chain reads and publication

`src/core/core-reader.ts` tries the configured HTTP endpoints in order for each read. A node reporting pruned
history (4444), a missing trie node, or an unavailable header is skipped for reads at or below that block for
60 seconds. Ranges use their first block as the conservative cutoff; missing anchors use the anchor's own block.
An unknown hash gets a bounded, hash-specific cooldown until a number is known. Newer reads retain configured
order. HTTP 429/403 cool the endpoint for 1, 2, 4, 8, 16, then at most 30 seconds; successful reads reset this backoff.
If all eligible endpoints are cooling, the read fails for the existing indexer retry path. Range log reads still
check every R2 anchor on the serving endpoint both before and after each `eth_getLogs`.

MoneyV2 (including its auxiliary helpers), v1 display/audit views and set state views use canonical Multicall3
`aggregate3` at `0xcA11bde05977b3631167028862bE2a173976CA11`, pinned to the requested block hash. Staged box folds
run concurrently. Each contributes its independent money and auxiliary views to the shared queue at that hash;
only reads needing a preceding answer wait for it. Publication and history order remain unchanged.
Each aggregate has at most 128 calls and 48 KiB of calldata. Oversized individual calls stay single. The existing
ABI decoders consume each result; a failed sub-call retains its revert bytes and execution-refusal classification.
An unavailable block hash remains a read failure. Sender simulations and state overrides remain single calls.

Each reader belongs to one chain and probes Multicall3 code once at the first view hash, caching absence for local
anvil/e2e chains too. A failed probe is retried, not cached as absence. No code means single calls. If a later read
predates deployment and the aggregate returns empty bytes, that read also uses single calls. Identical successful
views share results only inside one read operation; neither values nor failures are cached across blocks or audits.

Audits stage all boxes' reads concurrently at the audit hash, then share one canonical-header check after all
reads finish. Verdicts and repairs retain box order. A repair performs fresh reads and a fresh header check; neither
the block fold's money nor a previous audit's header is reused. One reverted sub-call keeps its box's existing
failure policy, while other boxes can still complete. A transport failure retains the existing retry behavior.

V2 money is still read at every committed block, including catch-up. Intermediate heads are published and can be
served during a running service's long gap; rollback also retains their snapshots. Silent donations can change
money without a box event. Skipping those reads would change served values. V1 display reads retain their existing
event-block/backfill-end schedule, and audits retain their 32-block cadence. The offline request-count and
publication-equivalence harness is `test/core/rpc-load.test.ts`; ticket evidence records before/after counts.

## Collection vault inventory (SH-235)

`GET /v2/feed` cards and `GET /v2/boxes/<chain>/<token>` may include `vaultItems`,
beside `m3`. The same field is included in box stream snapshots. Its wire shape is:

```ts
vaultItems?: {
  firstId: string; // unsigned decimal collection start ID
  n: string; // positive decimal collection size; IDs are [firstId, firstId + n)
  known: Array<{ id: string; inside: boolean; sequence: string }>;
  owners: Record<string, string | null>; // decimal ID -> lowercase address, or null for burned
}
```

An absent field means **this server does not publish inventory for this box**. It
does not mean the vault is empty or no items have moved. An eligible untouched vault
has a present record with `known: []` and `owners: {}`. There are no payout fields,
ledger cursors, balances or independent timestamps in this record.

Eligibility matches the page's `vaultRolesOf`: the spec's `boxType` is neither 4
(shop) nor 5 (pile), `n` is a positive safe integer, and roles 3 (vault) and 4
(collection) are present and nonzero. Fee choices do not affect eligibility. Draw
vaults qualify too. The field remains present after failure or closure.

`known` has one entry per item that has left the vault at least once, including
items later returned. `inside` is its last place recorded by an ordinary vault
movement. Entries sort by `sequence` descending, then numeric ID ascending for
items moved by the same log. Transfers between owners do not change this order.
`sequence` is the decimal encoding of `(blockNumber << 64) | (transactionIndex << 32)
| logIndex`, with unsigned 32-bit transaction and log indices. It is an order key,
**not** an item-ledger sequence or a count of movements. IDs and this key parse to
bigint. The entry shape matches the web's parsed `ItemsHistory.known`; the old M3
wire's placement map is actually named `m3.items.items`. Its parser's `raw(id)`,
boolean and `raw(sequence)` rules can be reused. The `owners` map uses exactly the
existing `m3.items.owners` encoding and owner parser.

`owners` contains only currently outside, ever-moved items. A burned item has an
explicit null value. Returned and never-moved items are absent. Owners come from
collection `Transfer` and `ConsecutiveTransfer` logs, including transfers made by
receiving contracts before a withdrawal finishes. Withdrawal recipients never
override those transfers. Range mints do not expand untouched IDs into the feed.

Placement folds vault `Withdrawn.ids`, `Returned.ids`, `TicketDelivered.id`, and
`ReleasedToCreator.ids`. Existing block/hash checks, canonical ordering and log
deduplication apply; item-ledger lifecycle logs are not folded a second time.
The record is complete from creation through the enclosing box/feed `asOf` block
and hash. Reorg rollback replaces it with the rest of the snapshot. It has no
second clock. M3 keeps its existing gate, schema and values; an items-side vault
publishes both records. Their placement and outside owners agree, while their
sequence keys have different meanings.

Example after item 2 returned and item 1 was passed to another wallet:

```json
{"vaultItems":{"firstId":"1","n":"500","known":[{"id":"2","inside":true,"sequence":"1900014639592083816449"},{"id":"1","inside":false,"sequence":"1863121151444664713217"}],"owners":{"1":"0x2222222222222222222222222222222222222222"}}}
```

Every normal indexer restart discovers boxes and replays chain logs from creation;
the view is not restored from a persisted cursor. Existing boxes acquire this field
without a manual backfill. Size grows with distinct moved IDs, not collection size
or the number of repeated movements. The offline published fixture for the web
ticket is `src/core/v2/vault-inventory-fixture.test-support.ts`, exported as
`publishedVaultInventory()` (returns `{ view, manifest }`): burn/burn, 500 IDs from 1,
three taken out, one returned, and one passed to a second wallet.

## Candles

`GET /v1/boxes/<chain>/<token>/candles?interval=<step>&limit=<1-1000>`

The same route is available under `/v2/boxes`. `interval` accepts `12s`, `1m`, `10m`, `1h`, `10h`, or `1d`, defaulting
to `1h`. `limit` is a decimal integer from 1 to 1000, default 1000. Invalid intervals or limits return 400; the
interval error lists all six steps. The newest `limit` nonempty buckets are returned in ascending start order.
The answer keeps `{ asOf, candles, interval }`. Each candle keeps `start`, `openSqrtPriceX96`, `highSqrtPriceX96`,
`lowSqrtPriceX96`, `closeSqrtPriceX96`, `volumeQ` (decimal strings), and `trades` (a JSON number).

Buckets align to the Unix epoch at 12, 60, 600, 3600, 36000 and 86400 seconds. Stored `1m`, `1h`, and `1d` candles
retain their existing values. `12s` folds stored trades in block/log order using the existing OHLC and volume rule;
Postgres finds the newest window by backward block/log keyset reads through `trades_by_token`, inside one read-only
REPEATABLE READ transaction. It includes the complete oldest requested bucket even when it spans blocks or query
pages. On post-merge Ethereum and Sepolia a 12-second bucket represents one slot; missed/empty slots stay absent.
`10m` and `10h` aggregate stored `1m` and `1h` candles on read: first open, last close, highest high, lowest low,
summed volume and trade count. Aggregation uses bigint; it does not round prices or amounts. No new interval is
stored, and no migration or backfill is required. Memory history and the no-history recent window use the same
trade-folding rule for all six steps.

## Response caching

Box candles and activity (`v1` and `v2`) reuse serialized data in the gateway
process, keyed by route, chain, lowercase token and normalized query. Concurrent identical requests share one build.
One store generation advances after every committed write transaction, including undo/reorg, wipe and replay. A
read captures its generation before starting; if a write commits during it, the gateway retries at the new
generation before sending. Without a history store the applied head hash supplies the version. Failed/missing reads
are not cached. A process using history must write through that same store instance; external database writers do
not update its local generation.

`/v1/feed` and `/v2/feed` share the same bounded response cache, with one serialized data build for concurrent
requests to a route/chain. Their version includes both the history generation and applied head (including its
timestamp and hash), plus liveness, row/verdict and immutable state/display/audit identities, mutable verification
and repair flags, and visible creator links/picture copies. This catches enrichment updates and stale/recovered
cards even without a history write or a new head. Block time drives phase and rolling statistics; wall time only
changes the liveness boolean. Checking these dependencies walks small references/enrichment records, not the full
feed projections. Rolled-back state identities are weakly held. Sources without `feedVersion()` and `asOf()` keep
uncached feeds rather than guessing their dependencies.

Every feed response attaches the current top-level `asOf`; nested card envelopes refresh with the head. Feeds send
`Cache-Control: public, max-age=1` and never send an ETag or return 304, even with `If-None-Match: *`: a tab needs
the current envelope to judge staleness. A dependency change during a build retries before sending.

Legacy gateway sources without `dataVersion()` are read on every request; the gateway does not call the feed to
guess a version. Without `asOf()`, the existing box admission view supplies the envelope without another box read.
`/v2/sets/<chain>/<token>/activity` stays uncached with `Cache-Control: no-store`, returning the source's complete
body unchanged (including a 200 with `null`). A history-store generation cannot certify every change in the
in-memory set pipeline during rollback, replay and rebuild.

The cache retains at most 2000 entries (including pending builds) and 64 MiB of serialized bodies. It evicts the
least recently used completed entries first. When all entries are building, additional distinct requests wait for
capacity. Oversized responses can be served but are not retained. Constants live in `src/core/response-cache.ts`.
Every successful page attaches the current `asOf` at send time; the cached data excludes it. These 200 responses
send `Cache-Control: public, max-age=1`.

Candles also send a weak `ETag` derived only from their data, so empty blocks leave the validator unchanged.
`If-None-Match` accepts a matching strong or weak entry in a list, or `*`; a match returns 304 with no body and the
same ETag, CORS and Cache-Control headers. Candle responses expose `ETag` via `Access-Control-Expose-Headers`;
CORS already allows `If-None-Match`. Activity has no ETag because clients compare its live `asOf`. Errors remain
`no-store`. The stream, holders, items, art, links, pictures, health, stats, listings and box snapshots keep
their existing behavior. No Cloudflare rule is configured here; the founder may separately enable edge caching
that honors Cache-Control. Browser/edge copies can remain fresh for one second across an origin write.

## Activity

`GET /v2/boxes/<chain>/<token>/activity?kind=<kind>&before=<block>-<logIndex>&limit=<1-200>`

`limit` defaults to 50. Omit `kind` for the mixed page, or use `trade` or `v2_event`. The existing response is
`{ asOf, items, next }`, newest block/log first. `next` is the exclusive `before` cursor, or null. All existing fields
are retained:

- Each trade has `kind: "trade"`, `id`, `block`, `blockHash`, `txHash`, `logIndex`, `timestamp`, `side`, `route`, `qRaw`,
  `tRaw`, `feeQ`, `feeT`, `taxQ`, `trader`, `sqrtPriceX96After`, `tickAfter`.
- Each other item has the same identity/time fields, `kind: "v2_event"`, and `data` with `source`, `event`, `emitter`
  and the decoded event arguments.
- `trader` is a lowercase address or null. A taxed launch-router buy retains `TaxedBuy.buyer`. Otherwise sum this
  box token's transfers for the **whole transaction**, including transfers after a swap and router hand-offs.
  Exclude zero, the PoolManager and every contract in the box record. A buy selects the largest positive net T
  change; a sale selects the largest negative. Equal changes resolve by address ascending. No eligible movement
  gives null. Multiple trades of the same direction in one transaction can therefore name the same account; an
  aggregator retaining T can be that account. This is token movement attribution, not proof of the transaction sender.
- New trades persist that attribution. Old stored null traders are filled at read time using the stored T transfers
  for the page's transactions, independent of the returned page's event boundary or `kind` filter. No database
  migration or history rebuild is required. An incomplete stored transfer history cannot identify its missing mover.

PostgreSQL reads a page's trades, events and any legacy-attribution transfers inside one read-only REPEATABLE READ
transaction. A writer rollback/replacement between SELECTs cannot mix branches in that page. This does not pin
successive HTTP pages to the same branch. `asOf` remains the live indexer's head; the history writer can lag it.
Without a history store, activity is limited to the existing recent window (500 trades and 500 other items).

## Holders

`GET /v2/boxes/<chain>/<token>/holders?limit=<1-200>&after=<cursor>`

`limit` defaults to 50. Omit `after` for the first page. The response is:

```ts
{
  schema: "sh.core-holders.v2",
  chainId: number,
  token: string,
  asOf: { block: string, hash: string, timestamp: string, tier: "head" | "confirmed" | "finalized" },
  totalSupplyT: string,
  holderCount: string,
  holders: Array<{ address: string, balanceT: string, role: string | null }>,
  next: string | null
}
```

The live balances and supply come from `LiveStateV2`, independent of activity retention and history-writer lag.
`asOf` equals the box snapshot's `asOf` at the same head, including hash, timestamp and tier. Only positive balances
are listed; zero is excluded. `holderCount` counts the entire list, including contracts. Sorting uses exact balance
descending, then lowercase address ascending. `role` is `pool` for the PoolManager; otherwise the named contract role
from the record (`coordinator`, `token`, `hook`, `vault`, `collection`, `receiver`, `launchRouter`, `tickets`,
`royaltyRouter`, and any other named role), or null. A creator's ordinary address has a null role.

Pass `next` unchanged as the URL-encoded `after` parameter. It includes a version, chain, token, snapshot hash and
exclusive balance/address position. Treat it as opaque. Null means the last page, including an empty holder list.
A cursor for a different box is 400; any new head or same-height replacement hash is 409 with
`{ "error": "holder snapshot changed; restart without after" }`. On 409 discard the incomplete run and start again.
Historical holder snapshots are not retained for paging. Each page sorts all current positive balances; the response
is bounded to 200 holders, and no holder limit or aggregate count is inferred from activity history.

## Transport and stream

These routes use the core gateway's CORS (`Access-Control-Allow-Origin: *`) and JSON content type. Successful
activity/candle pages follow the caching policy above; holders and errors keep `Cache-Control: no-store`. Invalid addresses or page parameters return 400; another chain or unknown/unshown box
returns 404; unsupported methods return 405; OPTIONS returns 204. Unexpected failures use the existing sanitized
500 error. The box snapshot itself keeps its existing `public, max-age=1` cache policy.

`GET /v2/boxes/<chain>/<token>/stream` still sends only `event: snapshot` plus heartbeat comments, with the existing
stream limits. The optional `activity` and `removed` events are deferred. Clients should continue polling activity
and reconciling reorgs by item id and block hash.

## Withheld pictures (F157 (3), SH-WITHHELD-PICTURES)

`GET /v2/withheld` returns exactly `{ "version": 1, "hashes": [...] }`. Each entry is the lowercase,
64-character SHA-256 hex digest of the UTF-8 string `sh-withheld-v1:` followed by the complete picture ID:
`ipfs:<canonical raw CIDv1 sha2-256>` or `ar:<43-character transaction ID>`. IDs are case-sensitive; do not
strip the prefix, lowercase an Arweave ID, decode the CID or hash the picture bytes for this comparison.
Hashes are unique and sorted in ascending ASCII order. No raw IDs, reasons, dates or notice information appear
in this response. Hashing avoids publishing a browseable list; it does not hide membership from someone who
already knows an ID. Other chain/metadata routes retain their existing records.

The response has `Cache-Control: max-age=60` and the other v2 reads' CORS headers (`Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Headers: If-None-Match`); Caddy narrows origins as usual. OPTIONS is supported; other
methods return 405. The exact path is required, without a trailing slash or query. There is no chain parameter,
`asOf`, ETag or chain-health dependency. The endpoint is available while the indexer catches up.

Each process checks the private file's change time on demand at most once per 10 seconds. Missing means empty;
an invalid or unreadable file retains the process's last good list and logs one warning until recovery. A cold
process has an empty last-good list. HTTP caches may add 60 seconds to this refresh interval. No raw list is served.

Before fetching or displaying **every** picture, including an already cached picture, the site must hash its full
ID with this domain prefix and compare against the current list. A match shows a neutral **Picture withheld** tile.
This site integration is a separate job; it must also invalidate previously displayed pictures on refresh.
Our gateway returns 451/no-store for a listed CID, and cards use the generic JPEG/no-store. The older v1 item
image/avatar byte route also refuses a listed CID with 451/no-store; chain facts and item metadata remain intact.
See [the operator runbook](../../docs/runbooks/withheld-pictures.md) for cache purges and withdrawal.
