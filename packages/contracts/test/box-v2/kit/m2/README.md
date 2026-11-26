# M2 shared test kit

Frozen against `a592d29f356ccc9b57de94ff5d8b37189d1887d9`, M2-00 and CQ11-M2SEAM/AF1.
Everything here is **test-only**. The fixture doubles exercise real ERC-20/ERC-721 custody and backed
PoolManager claims; they do not admit M2 recipes or replace the production implementation tickets.
Shared `HostileToken` and `PoolDriver` are imported unchanged from the CQ11 kit.

| Consumer ticket | Use |
|---|---|
| M2-30 | `HolderKit`, `BatchDriver`, `NetFundingMock`, unchanged `HolderModel` and `SourceModel` oracles: per-holder credits, final funding, D6/tips/source dust, debt isolation, P payouts and residue exits. |
| M2-31 | `LedgerTokenMock` implements `IHolderTokenHistoryV2`; `HostileLedger` supplies revert, full-stipend sink and large revert data. `HolderEdges.t.sol` covers transferFrom, mint/burn, 7702, historical-read failure and skipped notices. |
| M2-32 | `ShopKit`, `HostileCollection`, seed approval/pull, liquid/claims T custody and retryable burns. Collection switches cover refusal, extra mint, seizure, reentry and gas exhaustion. Give/pick allowances and curator rules belong to the production shop suite. |
| M2-33 | `StarterLoaderDouble` implements `IStarterSetLoaderV2`; `ShopGateDouble` combines chunks/completion and the opening timestamp. `suffix` supplies ordered commitments for creator-approved pages. |
| M2-34 | Reuse actors, assets and source drivers around the real factory; these fixture constructors are not clone-wiring/provenance proof. |
| M2-44 | Holder P survives failure; shop T stays excluded and burns; partial starter returns go only to creator. No R40A denominator model is substituted. |
| M2-60/61/62 | Reuse the actors, adversaries and step assertions for real-part gas/menu/mutation suites. These test deployment gas totals do not measure production admission or cap headroom. |

Inherit `HolderKit` and call `_holderBox(6)`, `(8)` or `(18)`. `_move`, `_trade`, `_receipt`, `_fund`,
`_settle` and `_claim` drive the fixture and its frozen oracles. `_assertCredits` checks each named holder
and residue, including after individual claims; `_assertSources` checks every allocation bucket and actual
receiver custody. `HolderModel` has one excluded source account, `SYSTEM`; the token fixture additionally
excludes itself, zero, the PoolManager, hook, receiver and ledger. Supply starts at `type(uint128).max`
in `SYSTEM`. Raw amounts are integers; decimals never change allocation arithmetic.

Instantiate `BatchDriver`/`NetFundingMock` around a production ledger as needed: each owner's `wire` runs
once, and its scripted receipts are separate from notice units. Odd/even ids close together; funding is
ascending, final even at zero, and backed through the shared `PoolDriver`. The caller-supplied tip request
is bounded and actually redeemed to the fixture owner under `TIP_GAS`; a failed tip remains in that source.
`royalty(amount, false)` represents already released royalties booked as fees; pre-graduation royalty holding
and conversion are outside this double. After failure, `collectLate` books only excess over all named
liabilities and reserved source backing. Safe/debt exits redeem real P; depth/pot exits transfer claims.

`HolderLedgerDouble` implements the frozen ledger interface independently of the oracles. Its constructor
wiring replaces immutable clone arguments only in tests. F127 removes pushed payouts; owners claim their whole credit without a minimum or tip.
The token's optional hint is never required for historical recovery. All fault switches in `LedgerTokenMock`
and authenticated receipt inputs are fixture-owner-only; the shared hostile assets and `HostileLedger` have
public switches deliberately. `M2OptionalCall.PAYOUT_RESERVE_GAS = 200000` is a local fixture continuation
reserve, not a proposed release-constant change. Production caps still require M2-60 measurement.

Inherit `ShopKit`, then `_shopBox(count, seedT)`, `_seed()` and `_page(start, length)` (1–32 items).
Counts are zero for seed-only or 10–10000 for a set. The helper creates sequential ids at tier zero and creator
approvals; it pulls nothing at creation. For arbitrary collections/tiers, instantiate the loader directly.
`ShopModel` hardcodes collection `0x721`; `modelSuffix` therefore mirrors the same ids/tiers with that
canonical address, while `suffix` commits the real deployed collection. The oracle is imported unchanged.
`ShopDouble` deliberately exposes only seed/loader/failure custody, not a pretend complete `IShopVaultV2`.
No collection-list validation or give/pick/curator economics is claimed. `ShopGateDouble` has owner-only
lifecycle controls; it models neither curve deadlines nor the coordinator's outstanding-supply calculation.

Run from `packages/contracts` (offline, no fork):

```sh
FOUNDRY_OFFLINE=true FOUNDRY_FUZZ_RUNS=256 forge test --match-path 'test/box-v2/kit/m2/*.t.sol'
FOUNDRY_OFFLINE=true FOUNDRY_FUZZ_RUNS=256 forge test --match-path 'test/box-v2/kit/m2/*.t.sol' --hardfork amsterdam
```

Evidence and remaining integration limits: `docs/evidence/SH-V2-M2-03.md` at repository root.
