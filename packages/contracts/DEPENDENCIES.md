# packages/contracts: dependencies and toolchain

Every third-party input is pinned to an exact commit. Nothing is vendored by copy; dependencies are git submodules
under `lib/`, fetched with plain `git`. No install or post-install script of any dependency is run. Square Hole's
own code (`src/`, `test/`, `script/`, `scripts/`, `script-py/`) is MIT.

## Solidity dependencies (git submodules)

| Path | Repository | Commit (tag) | Licence | Used for |
|---|---|---|---|---|
| `lib/dn404` | https://github.com/Vectorized/dn404 | `3397cb11558ac853912ee87871422b6a29c9d346` (v0.0.25, 2025-02-19) | MIT, `LICENSE.txt` "Copyright (c) 2023 Pop Punk LLC" | `src/DN404.sol`, `src/DN404Mirror.sol` only: the base of `SquareHoleToken` and its mirror (production code) |
| `lib/forge-std` | https://github.com/foundry-rs/forge-std | `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` (v1.16.2, the latest release tag on 2026-09-25) | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`; SPDX in each file) | tests only |
| `lib/v4-core` | https://github.com/Uniswap/v4-core | `46c6834698c48bc4a463a86d8420f4eb1d7f3b75` (2026-04-02; `git describe`: v4.0.0-21-g46c68346; the SH-018 pin) | per file: MIT (interfaces, types, most libraries, `licenses/MIT_LICENSE`), BUSL-1.1 (`PoolManager.sol`, `Pool.sol`, `Position.sol`, `CurrencyDelta.sol`, `CurrencyReserves.sol`, `Lock.sol`, `NonzeroDeltaCount.sol`; `licenses/BUSL_LICENSE`), UNLICENSED (`src/test/*` harnesses) | **src/** imports MIT files only: `IPoolManager`, `IHooks`, `IUnlockCallback`, `Hooks`, `TickMath`, `FullMath`, `BalanceDelta`, `BeforeSwapDelta`, `Currency`, `PoolId`, `PoolKey`, `PoolOperation`; their whole import closure (46 files since SH-B2 Build B added `src/testnet/MockTetherUSD.sol`, which imports nothing; dn404 and periphery included) is MIT (checked by parsing every import). The converter's sold-out check reads `slot0` with `extsload` itself, because `StateLibrary` (MIT) imports the BUSL-1.1 `Position.sol`. **Tests only:** `PoolManager` (deployed from source in local tests, non-production use as the BUSL grants), `Pool.sol` (BUSL-1.1, test-only import to check that `LaunchMath.maxLiquidityPerTick` equals `Pool.tickSpacingToMaxLiquidityPerTick`; non-production use), `PoolSwapTest`/`PoolTestBase` (UNLICENSED Uniswap test harness), `StateLibrary`, `TransientStateLibrary`, `SqrtPriceMath`, `LPFeeLibrary`, `CustomRevert` (MIT). **Scripts (never deployed to a public network):** `script/Deploy.s.sol` deploys the `PoolManager` from its artifact on chain 31337 only; `script/LocalE2EReport.s.sol` reads pool state with `StateLibrary`/`SqrtPriceMath` (MIT) |
| `lib/v4-core/lib/solmate` (nested, v4-core's own pin) | https://github.com/transmissions11/solmate | `4b47a19038b798b4a33d9749d25e570443520647` | AGPL-3.0-only | tests only: `auth/Owned.sol`, imported by the BUSL `PoolManager` (`ProtocolFees`) |
| `lib/v4-periphery` | https://github.com/Uniswap/v4-periphery | `9969eec44cfdf07e24b41de47f40276a58401976` (2026-09-19, `main`; no release tag) | MIT (`LICENSE`, every file under `src/`) | **src/**: `libraries/LiquidityAmounts.sol` (launch liquidity). **Tests only:** `V4Router` + `Actions` + `IV4Router` + `PathKey` (the Universal Router's V4_SWAP action engine, driven by `test/utils/v4/Routers.sol`; multi-hop paths; the fork suites encode real Universal Router commands with `Actions`/`IV4Router`). **Local chain only:** `script/harness/ExternalSwapHarness.sol` (V4Router; the local external-trading harness deployed by `scripts/local-e2e.sh` on anvil) |

Initialise non-recursively (v4-periphery's own nested submodules are not needed; v4-core needs only solmate):
```sh
git submodule update --init packages/contracts/lib/dn404 packages/contracts/lib/forge-std \
  packages/contracts/lib/v4-core packages/contracts/lib/v4-periphery
git -C packages/contracts/lib/v4-core submodule update --init lib/solmate
```

File hashes (sha256) checked when the submodules were added:

| File | sha256 |
|---|---|
| `lib/dn404/src/DN404.sol` | `0ea144e185b5684cf41484e9feee1517094891ab3aab536072682004c910ec52` (SH-018 W-02) |
| `lib/dn404/src/DN404Mirror.sol` | `9ae89682e585ae5f1f1ea86d777874a7659635212a7c464cd234d9e056da372d` (W-02) |
| `lib/dn404/LICENSE.txt` | `c87b527ed43389316666030cf4e032fa69911bf69d17b24820afff29c196203a` (W-02) |
| `lib/forge-std/LICENSE-MIT` | `6d185dfe089d4de346d391fc5997fbd4739bad1d6556010413c10f420d704ecc` |
| `lib/forge-std/LICENSE-APACHE` | `50b6bf8bdb63265ce14953b480b7aaa0271e78f56843b99c184abd3ae5048cd7` |
| `lib/v4-core/src/PoolManager.sol` | `3b6ab111dadf613e3cfd617e4b1c6ab75b5445cd15cbe52d7c6207fc02449717` |
| `lib/v4-core/src/libraries/Pool.sol` | `59c493035ad25d56f24a457e8b40d9d1e3784504b8ff13d171db1eb25c6f128e` |
| `lib/v4-core/src/libraries/Hooks.sol` | `297d577998cdede64d48b47b12f15e4f442eea032fbb9676bb3c2f89da89b83c` |
| `lib/v4-core/src/libraries/TickMath.sol` | `272d4f6d3ff9ae33596ebcdb84a71a3c2d4542ae8fb5c88ddf1aca8043f5d06b` |
| `lib/v4-core/src/libraries/FullMath.sol` | `a9607255a6fd604d9c92f6b7416811c38b9d86e5dfdb0c345a494ebd35f7a4a3` |
| `lib/v4-core/src/interfaces/IPoolManager.sol` | `a98405333567e4ab344489728014795721cf0071c151536377d2fcc986e0600c` |
| `lib/v4-core/src/interfaces/IHooks.sol` | `6eb35c9c598eb932e963219f1ff180748bc4c30ac6a02d924893b3c29abb1d73` |
| `lib/v4-core/src/test/PoolSwapTest.sol` | `1bfd112087ec3abc30ea92cef6e39c9fd502502c9f28dac3d4df9fee7155e6d2` |
| `lib/v4-core/licenses/MIT_LICENSE` | `b7b0c4379346af0701f5e4df9c861295d4a3af91dc3b15eb4356ebc571303df9` |
| `lib/v4-core/licenses/BUSL_LICENSE` | `cd5241d8e1afe7098fa0f21059f7153348fdd25dbae5a8383a5f1dd2eb590321` |
| `lib/v4-core/lib/solmate/src/auth/Owned.sol` | `8ac2f2dc41ab8012e93adb3791326ffa1e4059a20c306a777109dd81816b9125` |
| `lib/v4-core/lib/solmate/LICENSE` | `20b067f86de375aae6db0f283ab2e65de24d537733b89bd58432c101259d84cf` |
| `lib/v4-periphery/src/libraries/LiquidityAmounts.sol` | `02d6eaaa62d45ac8170b3668e92a31808d2003b0f8eb821581cb4a028b175b45` |
| `lib/v4-periphery/src/V4Router.sol` | `2a5046ad7dbc39e12e89b4cfa6536cb7ca79da4116b2fe9bc54a0638ea1bf93a` |
| `lib/v4-periphery/LICENSE` | `66eb4bd7506d0a33cc953ed77c1fee2fe6a34d8c0ac40d4e852e6bfbf754f80e` |

Notes:
- `DN404.sol` and `DN404Mirror.sol` have no imports. dn404's own nested submodule `lib/dn404/lib/solady` (used only by
  dn404's examples and tests) is **not** initialised and not needed.
- The third-party files keep their licence headers; nothing from them is copied into `src/`. `SquareHoleToken`
  changes DN404 behaviour only through overrides (listed in `docs/decisions/0010-contracts-core-design.md` and
  `0011-v4-hook-launcher-converter.md`).
- dn404 HEAD is not the Guardian-audited revision (11 post-audit commits; W-02). Nothing here is audited.
- **v4-core pin vs the deployed PoolManager.** Between tag v4.0.0 (`e50237c4`) and the pin, `src/` changed only by
  moving `ModifyLiquidityParams`/`SwapParams` out of `IPoolManager` into `types/PoolOperation.sol` (same ABI); `Pool.sol`
  is identical. v4-periphery's own v4-core pin (`59d3ecf5`, "bump to 1.0.2") has an identical `src/`. The opt-in fork
  tests show the pinned `PoolManager`, compiled as below, is byte-identical (immutables masked) to the canonical
  PoolManager on Sepolia (`0xE03A…3543`) and on mainnet (`0x0000…8A90`).

## Toolchain

| Tool | Pin | Evidence |
|---|---|---|
| Foundry (forge/cast) | 1.8.3, commit `cae51ad458f6abb64852b7709eb784352429825d` | `forge --version` |
| solc | 0.8.26 (`0.8.26+commit.8a97fa7a`), installed by forge's svm; binary sha256 `0ff016aef2396b12d1fc65429d8ea6cf53c2ee4b041bb8925644615ee1c30ab9` (darwin) | `foundry.toml` `solc`, `auto_detect_solc = false` |
| EVM target | `cancun` | `foundry.toml` `evm_version` |
| Optimizer | enabled, 1,000 runs, legacy pipeline (`via_ir = false`), `bytecode_hash = "none"` | `foundry.toml` |
| Optimizer, test-only PoolManager | via-IR, 44,444,444 runs (upstream `lib/v4-core/foundry.toml`), through `additional_compiler_profiles` + `compilation_restrictions` on `lib/v4-core/src/PoolManager.sol` | `foundry.toml`; runtime 24,009 bytes, equal to the canonical deployments |
| Python (vector generator only) | 3.11 (stdlib only) | `script-py/gen_vectors.py` |

### Why solc 0.8.26
- DN404 at the pin declares `pragma solidity ^0.8.4` (its own CI config also compiles with 0.8.26).
- Uniswap v4-core at the pin declares `pragma solidity 0.8.26` exactly in `src/PoolManager.sol`, and its
  `foundry.toml` pins `solc = "0.8.26"`, `evm_version = "cancun"`; v4-periphery's `foundry.toml` pins the same. One
  project-wide compiler must accept that exact pragma: 0.8.26 is the newest (and only) version that compiles DN404, all
  of v4-core and the periphery files we use.
- Known bugs listed for 0.8.26 in solidity's `docs/bugs_by_version.json` (fetched 2026-09-25):
  `MisorderedNamedParametersInRequireWithCustomErrors`, `SpillSlotCollisionAcrossMutualRecursion`,
  `UnsoundSpillInMutualRecursion` (all three via-IR only; our code compiles without via-IR, and only the test-only
  PoolManager uses via-IR, exactly as upstream deploys it), `MemoryByteArrayElementDeleteClearsWholeWord` (needs
  `delete` on one element of a memory `bytes`; none in `src/` or DN404), `LostStorageArrayWriteOnSlotOverflow`
  (Solidity arrays straddling the end of storage; DN404 uses custom assembly slots, our storage arrays are short strings
  and the registry's `bytes32[]` in low slots). None applies to this code. The high-severity
  `TransientStorageClearingHelperCollision` affects 0.8.28–0.8.33 only (and needs via-IR).

### Why `cancun`
- It is the newest EVM target solc 0.8.26 accepts (`solc --help`: "homestead … shanghai or cancun").
- Transient storage (EIP-1153: the reentrancy lock and the ledger's pool-outflow counter) needs Cancun.
- Activation on both target networks, from the Final meta-EIPs in ethereum/EIPs at `0b8184b1d6ed9fba836222684fd082b32782d4ef`:
  - Dencun (EIP-7569): Sepolia timestamp 1706655072 (2024-01-30 22:51 UTC), mainnet 1710338135 (2024-03-13 13:55 UTC).
  - Pectra (EIP-7600): Sepolia 1741159776 (2025-03-05), mainnet 1746612311 (2025-05-07).
  - Fusaka (EIP-7607): Sepolia 1760427360 (2025-10-14), mainnet 1764798551 (2025-12-03).
  Later forks keep executing Cancun-targeted bytecode; the only newer opcode (CLZ, EIP-7939, Osaka) is simply not used.
- The canonical v4 PoolManager is built with the same compiler/target pair (v4-core `foundry.toml`).

## Test-time settings
- `ffi = false`; `fs_permissions`: read-only on `./test/vectors` (the committed differential vectors) and `./out`
  (tests deploy the PoolManager from its artifact with `deployCode`; the fork tests read its immutable references).
- **Never import `PoolManager.sol` into a test file.** `scripts/test/forge-unit.test.mjs` (in `test:scripts`) guards
  the import graph so only the artifact-only markers `test/utils/v4/PoolManagerBuild.sol` and
  `test/box-v2/rc6-cow/ForkCowArtifacts.sol` reach it, keeping project contracts out of the slow via-IR unit. After a tool that runs
  `forge clean` or builds without tests (Slither, `forge build --skip test`), run `forge clean && forge build` before
  `forge test`, or the artifact is missing (`vm.getCode: no matching artifact found`).
- Fuzz and invariant seed `0x5348423130` (`[fuzz] seed`), fuzz runs 1,000, invariant runs 256 × depth 128,
  `fail_on_revert = true`; the v4 campaigns set 64 × 64 inline (`forge-config`). `FOUNDRY_PROFILE=deep` raises this to
  10,000 fuzz runs, 1,024 × 256 (B1-level campaigns) and 512 × 128 (v4 campaigns).
- No `[rpc_endpoints]`, no keys, no scripts that broadcast. Fork tests are opt-in (`SH_FORK_SEPOLIA=true`,
  `SH_FORK_MAINNET=true`), read keyless public RPCs at pinned blocks and use Foundry's RPC cache.
