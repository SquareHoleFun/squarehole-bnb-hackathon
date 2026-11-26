// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from packages/box-spec/build-profiles.v1.json
// (`pnpm box-spec:write`); `pnpm check:box-spec` (in `pnpm verify`) fails when stale.

/// @title BoxBuildV1 (build profile `mainnet`)
/// @notice The values core v1 takes from its build profile (F78): the raise and the fixed ETH amounts, read through
/// BoxSpecV1 (BoxSpecV1.BOOTSTRAP_ETH is BoxBuildV1.BOOTSTRAP_ETH, the raise preset is BoxBuildV1.RAISE). foundry.toml
/// maps `sh-box-build/` to src/box/build/mainnet/ by default and to src/box/build/rehearsal/ under
/// FOUNDRY_PROFILE=rehearsal; nothing else differs between the two builds.
/// The reviewed build: mainnet's box 0 and the full-size Sepolia rehearsal (the profile may still be deployed on Sepolia).
library BoxBuildV1 {
    /// @notice The profile this file belongs to.
    string internal constant PROFILE = "mainnet";
    /// @notice True for a profile whose values are not mainnet's (a rehearsal for testnets).
    bool internal constant REHEARSAL = false;
    /// @notice The chain id whose deployments this build refuses (0: none); BoxBuildGuard enforces it.
    uint256 internal constant REFUSED_CHAIN_ID = 0;
    /// @notice Every scaled value is mainnet's × SCALE_NUMERATOR / SCALE_DENOMINATOR, exactly.
    uint256 internal constant SCALE_NUMERATOR = 1;
    uint256 internal constant SCALE_DENOMINATOR = 1;
    /// @dev The raise R (Q raw units, native ETH): 4.206980085 ETH (mainnet 4.206980085). R: the curve holds exactly R, its ticks, liquidity and pool share are BoxLayoutV1.curve(R); the graduation reward (0.1% of R) and MIN_ADD (0.5% of R) follow it.
    uint256 internal constant RAISE = 4_206_980_085_000_000_000;
    /// @dev BoxSpecV1.BOOTSTRAP_ETH: 0.0015 ETH (mainnet 0.0015). The burned bootstrap buy createBox sends (msg.value).
    uint256 internal constant BOOTSTRAP_ETH = 1_500_000_000_000_000;
    /// @dev BoxSpecV1.FEE_BATCH_MIN_ETH: 0.005 ETH (mainnet 0.005). Collect() refuses smaller batches (D2).
    uint256 internal constant FEE_BATCH_MIN_ETH = 5_000_000_000_000_000;
    /// @dev BoxSpecV1.FEE_BATCH_TIP_MAX_ETH: 0.0005 ETH (mainnet 0.0005). The tip cap of collect(), deepen() and the swap module's steps.
    uint256 internal constant FEE_BATCH_TIP_MAX_ETH = 500_000_000_000_000;
    /// @dev BoxSpecV1.SWAP_STEP_MIN_Q: 0.005 ETH (mainnet 0.005). A swap-module step below it waits (BoxSwapModule; Standard boxes).
    uint256 internal constant SWAP_STEP_MIN_Q = 5_000_000_000_000_000;
    /// @dev BoxSpecV1.DEPTH_CONVERT_MIN_Q: 0.005 ETH (mainnet 0.005). A depth conversion alone waits below it (deepen's swap).
    uint256 internal constant DEPTH_CONVERT_MIN_Q = 5_000_000_000_000_000;
    /// @dev BoxSpecV1.PLATFORM_CAP_WEI: 32 ETH (mainnet 32). Box 0's platform share is capped at it per 30-day epoch.
    uint256 internal constant PLATFORM_CAP_WEI = 32_000_000_000_000_000_000;
    /// @dev Add-on creator-fee-cap, capPerEpoch allowed[0]: 1 ETH (mainnet 1). The creator-fee cap's first preset per 30 days (F75 U9; version 2 only: factory v1 cannot create it).
    uint256 internal constant CREATOR_FEE_CAP_PRESET_0 = 1_000_000_000_000_000_000;
    /// @dev Add-on creator-fee-cap, capPerEpoch allowed[1]: 4 ETH (mainnet 4). The creator-fee cap's second preset (version 2 only).
    uint256 internal constant CREATOR_FEE_CAP_PRESET_1 = 4_000_000_000_000_000_000;
    /// @dev Add-on creator-fee-cap, capPerEpoch allowed[2]: 8 ETH (mainnet 8). The creator-fee cap's third preset (version 2 only).
    uint256 internal constant CREATOR_FEE_CAP_PRESET_2 = 8_000_000_000_000_000_000;
    /// @dev Add-on creator-fee-cap, capPerEpoch allowed[3]: 16 ETH (mainnet 16). The creator-fee cap's fourth preset (version 2 only).
    uint256 internal constant CREATOR_FEE_CAP_PRESET_3 = 16_000_000_000_000_000_000;
    /// @dev Add-on creator-fee-cap, capPerEpoch allowed[4]: 32 ETH (mainnet 32). The creator-fee cap's fifth preset (version 2 only).
    uint256 internal constant CREATOR_FEE_CAP_PRESET_4 = 32_000_000_000_000_000_000;
}

/// @title BoxBuildGuard (build profile `mainnet`)
/// @notice Empty in this profile: it refuses no chain, adds no code and changes no bytecode. The factory, the planner
/// and every implementation inherit it so that a profile which refuses a chain (the rehearsal) can do so in their
/// constructors.
abstract contract BoxBuildGuard {}
