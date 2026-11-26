# Combined core v2 release deployment

`../DeployCoreV2.s.sol:DeployCoreV2` deploys the actual CQ11 contracts. It simulates by default.
`release-manifest.local.json` is the **local test fixture's output**, with Safe, WETH and box-0 read doubles.
It predates the M1-63 proxy attestation fix and must not supply runtime pins for a new deployment.
Its Sepolia chain id selects the deployment rules; none of its addresses proves a live Sepolia deployment.
No network request or broadcast was made by SH-V2-CQ11-W.

Before any release CREATE, the script verifies the existing v1 registry's box 0, manager, FIT, executor,
receiver, unchanged platform destination and pinned Drand source. It checks two distinct Safe addresses,
the reviewed proxy runtime hash before its views, then owner sets, thresholds, exact versions, singleton addresses
and code hashes, disabled modules, and the reviewed guard and fallback-handler addresses. Nonzero guards and handlers must have code; their code hashes
are recorded. Safe versions 1.4.1 and 1.5.0 are supported. Platform uses independent pins: F44 records its
existing mainnet Safe as 1.5.0; deploying v2 must not replace or upgrade it.

## Inputs

All addresses and code hashes are public release configuration. Set them from the reviewed chain setup,
never from this local example. In particular, do not derive an expected proxy hash from the candidate Safe
without verifying that runtime against the reviewed SafeProxy release for the pinned singleton/version.
The script does not read keys or choose a signer.

| Variables | Meaning |
| --- | --- |
| `CORE_V2_DEPLOYER` | Explicit deployment sender; its nonce determines the future factory |
| `CORE_V2_POOL_MANAGER`, `CORE_V2_WETH` | Target-chain contracts |
| `CORE_V2_COMPOSABLE_COW`, `CORE_V2_COW_SETTLEMENT` | Reviewed CoW deployments; mainnet/Sepolia: `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74`, `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` |
| `CORE_V2_ROYALTY_MINIMUM_LOT` | Raw WETH minimum lot of every inbox, a positive decimal (`DeployCoreV2` reads no other lot input) |
| `CORE_V2_V1_REGISTRY`, `CORE_V2_BOX0` | Existing v1 registry and its exact box-0 coordinator |
| `CORE_V2_FIT_SAFE`, `CORE_V2_PLATFORM_SAFE` | Two immutable receiver destinations |
| `CORE_V2_PINNED_FIT_SAFE`, `CORE_V2_PINNED_PLATFORM_SAFE` | Independently reviewed expected addresses; mismatch refuses |
| `CORE_V2_BOT`, `CORE_V2_FOUNDER`, `CORE_V2_BACKUP` | Three distinct FIT owners, threshold 2; platform founder alone, threshold 1 (on chain 1 the platform is 2-of-3: the founder plus `CORE_V2_PLATFORM_SECOND_OWNER` and `CORE_V2_PLATFORM_THIRD_OWNER`, never the bot; SH-188) |
| `CORE_V2_SAFE_PROXY_CODEHASH` | Independently reviewed SafeProxy runtime hash for the FIT singleton and version |
| `CORE_V2_SAFE_VERSION`, `CORE_V2_SAFE_SINGLETON`, `CORE_V2_SAFE_SINGLETON_CODEHASH` | FIT deployment pins |
| `CORE_V2_SAFE_GUARD`, `CORE_V2_SAFE_HANDLER` | FIT reviewed setup; explicitly use zero where absent |
| `CORE_V2_PLATFORM_SAFE_PROXY_CODEHASH` | Existing platform SafeProxy runtime hash from its independent review |
| `CORE_V2_PLATFORM_SAFE_VERSION`, `CORE_V2_PLATFORM_SAFE_SINGLETON`, `CORE_V2_PLATFORM_SAFE_SINGLETON_CODEHASH` | Existing platform's independent pins |
| `CORE_V2_PLATFORM_SAFE_GUARD`, `CORE_V2_PLATFORM_SAFE_HANDLER` | Existing platform's reviewed setup |
| `CORE_V2_WRITE_MANIFEST` | Default false; true writes `deployments/core-v2-<chain>-<factory>.json` |
| `CORE_V2_BROADCAST` | Default false; requires the explicitly selected Foundry sender when true |

## Rehearsal and release

The integrator runs a target-chain fork simulation before requesting the founder's release approval.
Use Amsterdam after the Sepolia activation; the gas-rule probe refuses the wrong EVM for the chain's time.
Mainnet additionally compares its RPC's code-byte estimate. Each step checks EIP-7825 execution headroom,
110% total gas against the smaller of the actual block and 54.5M, leaving 5M room. The script adds transaction
and deployment-calldata gas to its CREATE measurements. Broadcast with the matching 110% estimate multiplier.
Do not use `--resume`: it bypasses the script's checks. Re-simulate after a nonce or Safe setup change.

Build: `DeployCoreV2` deploys the default (`mainnet`) build only. Its first check refuses any build whose
`sh-box-build/` constants are not the release's (`NotReleaseBuild(profile, raise, releaseRaise)`; a leftover
`FOUNDRY_PROFILE=rehearsal` from core v1's steps gives the 1/10 raise 420698008500000000), and after the simulated
CREATEs it reads the listing registry's `RAISE_ETH` and native row 0 back (`NotReleaseListing`) before Foundry may send.
`VerifyCoreV2` refuses a deployed registry whose `RAISE_ETH` is not 4206980085000000000. Run both with
`FOUNDRY_PROFILE=default` (SH-SEP-DEPLOY-GUARD).

The M2/M3 deployment recipe has 30 direct CREATE steps. Its checked runtime inventory has 42 entries,
including linked libraries, constructor-created views and the single stateless CoW royalty handler.
VerifyCoreV2 separately checks the shop implementation's ShopTBurnerV2 child against a local reference deployment.
The 15 implementation slots include the holder ledger, ledger token, starter loader, shop, item ledger and pile.
Every inventory entry must have code, be distinct and fit 22,118 bytes. The four stateless views must also match
the compiled artifact exactly. The checks contract validates immutable-bearing implementation runtimes.

The manifest records the two Safe configurations, all 15 role implementations and code hashes, all 42 runtimes and code hashes, factory,
planner, verifier, registries, source, box-0 seams and version commitment. Numeric counters use decimal strings.
A broadcast simulation still says `broadcast-plan-awaiting-receipts`, with `publicReleaseReady: false`.
Attach actual deployment receipts, owner-signed control transfers from each Safe, `payFit`, `payPlatform`,
per-box royalty in-kind claims, CoW registration/settlement and P sweeps before promoting the release.
Run `FOUNDRY_PROFILE=sepolia-rehearsal forge test --match-path test/box-v2/rc6-cow/ForkCow.t.sol`
with `SH_FORK_RPC_URL` set; unset it for offline runs (the gate skips). The handler address/code hash and
CoW release inputs are recorded in the manifest. No offline run certifies a live fill. The live seven-day
hatch and keeper proof remain phase-5 work; simulation does not satisfy that elapsed-time requirement.

V2.1 choices (Eat the price coin, Holders in T, Items in T and fees into the pile) become selectable **one day
(86,400 seconds) after the fee-module directory is deployed**. Read the receiver implementation's
`receiverCode()` to locate that directory, then its `DELAY()` and `record(0)` through `record(3)`.
Save every address, codehash and `readyAt`; confirm `resolve(id)` succeeds at a canonical block whose timestamp
is at or after that row's `readyAt` before offering these choices. Each later module registration has its own
one-day notice. Existing boxes keep their pinned actions; this wait does not change the seven-day graduation
hatch or the shop's collection delay. Local time warps are rehearsal evidence only; the live chain must elapse.

## Commands without signing

From `packages/contracts`, use the `sepolia-rehearsal` profile for the aggregate offline lives. It inherits the default compiler settings and only raises the aggregate test/script gas limit to 10B. No command below needs an RPC or key.
The deployment fixtures set process-wide public environment values. Use one Forge process per test file;
`--threads 1` alone can still mix Safe pins between suites. The abstract deployment fixture has no runnable tests.

```sh
for test_file in test/box-v2/m1-64/*.t.sol test/box-v2/sepolia-all/*.t.sol; do
  FOUNDRY_PROFILE=sepolia-rehearsal FOUNDRY_FUZZ_RUNS=256 forge test --threads 1 --match-path "$test_file" || exit 1
  FOUNDRY_PROFILE=sepolia-rehearsal FOUNDRY_FUZZ_RUNS=256 forge test --threads 1 --hardfork amsterdam --match-path "$test_file" || exit 1
done
FOUNDRY_PROFILE=sepolia-rehearsal forge script script/sepolia-v2/DryRunCoreV2.s.sol:DryRunCoreV2
FOUNDRY_PROFILE=sepolia-rehearsal forge script script/sepolia-v2/DryRunCoreV2.s.sol:DryRunCoreV2 --hardfork amsterdam
FOUNDRY_PROFILE=sepolia-rehearsal forge script script/sepolia-v2/DryRunExtended.s.sol:DryRunExtended --sig 'runItems(uint8)' 6
FOUNDRY_PROFILE=sepolia-rehearsal forge script script/sepolia-v2/DryRunExtended.s.sol:DryRunExtended --sig 'runPile(uint8)' 6
FOUNDRY_PROFILE=sepolia-rehearsal forge script script/sepolia-v2/DryRunExtended.s.sol:DryRunExtended --sig 'runRoyalties()'
```

Repeat the two decimal commands with 8 and 18 and all three extended commands with `FOUNDRY_PROFILE=sepolia-rehearsal` and `--hardfork amsterdam`.
These scripts deploy regular local fixture contracts because Foundry prohibits relying on an ephemeral script's
address. Test helpers exceed the production size budget; the deployed release inventory is checked separately.
Time warps, mock randomness, Safe read endpoints and synthetic donations are local evidence only.
No listener is required. The earlier live localhost stack is recorded in `docs/evidence/SH-V2-E2E-LOCAL-C.md`.

The combined chronology accepts an ungraduated box-0 read double and retains FIT payouts in the Safe.
It also lists a graduated plain box's real coin as another box's P, runs five wallets through native,
STOCK-class 18-decimal and 8-decimal holder payouts before/after graduation, and recovers all ten starters
from a failed shop. Holder claims plus residue reconcile to each batch's funding. The stock coin is a
labelled mintable test asset, not a real issuer integration. Pile checks pin zero floor, the full-supply
quote, exact partial redemption and minimum-output rollback. The founder runbook makes these rows mandatory.

Run the runbook regressions separately from the repository root (contracts are excluded from root Vitest):

```sh
pnpm exec vitest run --maxWorkers 4 --config packages/contracts/test/box-v2/sepolia-all/vitest.config.mjs packages/contracts/test/box-v2/sepolia-all/runbook.test.ts
```

If old Foundry output reports duplicate library artifacts, preserve that output under `.cache/` and
rebuild with a fresh cache. Scripts read artifacts from `packages/contracts/out`, as permitted by the
repository's Foundry configuration; a custom test output directory also needs matching script read permission.

`VerifyCoreV2.s.sol:VerifyCoreV2` reads `CORE_V2_MANIFEST`, authenticates the 41 deterministic saved hashes,
then checks roles, children, version commitment and two immutable Safe destinations. For directory part 29,
it reproduces the compiled runtime locally at `record(0).readyAt - DELAY` with the release's constructor inputs
and checks the original four module records. Its `DirectoryCodeVerified` event allows the writer to reconcile
simulation hashes only when the event's address and hash match the chain. New format-2 plans annotate that
simulation hash with `timeDependentCodeHash`; old format-2 plans remain readable. The local clock is restored.
The burner reference takes no arguments and has no immutables; `ShopBurnSinkVerified` records its address and hash.
No reference CREATE is broadcast. Keep the reviewed pre-send manifest and receipts together.
It does not replace Safe control proofs, receipt checks or source verification on an explorer.

`PrepareCoreV2Box.s.sol:PrepareCoreV2Box` writes unsigned public input to `CORE_V2_BOX_FILE` under `deployments/`
when `CORE_V2_WRITE_MANIFEST=true`. Inputs: `CORE_V2_FACTORY`, `CORE_V2_CREATOR`, `CORE_V2_KIND` (0 plain,
1 holders, 2 shop, 3 hatch/failure, 4 every item, 5 pile), `CORE_V2_LISTING` (default 0), and optional
`CORE_V2_SALT_START` (default 0). Shop needs `CORE_V2_SHOP_COLLECTION`. Pile needs `CORE_V2_SEED_RAW` and
`CORE_V2_SEED_ASSET` (default native). Items accept `CORE_V2_INSIDE_POLICY` (1 Keep, 2 BuyBackBurn) and
`CORE_V2_HIDDEN` (default false). Plain boxes also accept `CORE_V2_BURN=true` for own-token buyback/burn. The 10 synthetic reveal proofs, exact chunk calls and curve buy/sell limits travel in the JSON.
The creator must equal the eventual sender, including when that sender is a Safe. A repeat specimen gets fresh
salts by checking code at predicted addresses. The live listing supplies its current raise; no balance uses float.

`DeploySepoliaV2TestSet.s.sol:DeploySepoliaV2TestSet` prepares optional 6/8/18-decimal owner-mintable test assets.
Its `runHelpers()` prepares owner-mintable shop stock and the research `PriceLimitSwapper`. The swapper has no
independent minimum output or deadline: use only bounded test amounts, explicit price limits and exact allowances.
The helper events record addresses and code hashes. Neither entry lists a coin. Both simulate unless the named
founder sender explicitly enables recording. `CoreV2StandIns.sol` and the old local manifest are historical;
no current release or rehearsal selects their deferred contracts.

For size review, build `src/box-v2 --sizes --skip test --skip script` into a fresh output/cache under `.cache/`.
Shared test output also contains oversized `v4-upstream` variants; production uses the default-profile artifacts.
The release inventory independently enforces 22,118 bytes on each actually deployed runtime.

The founder's transaction sequence and real waits are in `docs/runbooks/sepolia-core-v2.md`.

SH-V2-SEPOLIA-AMS: prepared JSON includes a creation `gasLimit` of 16.5M plus conservative intrinsic gas, with the total checked below 16777216. The founder sources
`send-core-v2.sh` and supplies the reviewed envelope for every preview and send. Every send also carries an
explicit EIP-1559 maximum fee and tip (`SEND_MAX_FEE`, default 10gwei; `SEND_PRIORITY_FEE`, default 2gwei; v1's values),
never the RPC's 1-wei suggestion, and refuses any chain other than Sepolia (SH-SEP-DEPLOY-GUARD). The runbook lists
13.5M graduation, 15M failure (the keeper's floor; the offline rehearsal's `SepoliaV2Gas.FAIL` too) and the smaller operation/page envelopes. Failed starters return one
index per 2M transaction. Optional asset/helper CREATEs now measure and check every transaction.
The scoped rehearsal profile changes aggregate gas only; it does not weaken production admission.
