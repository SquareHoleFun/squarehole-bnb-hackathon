// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";
import {ReleaseConstantsV2} from "../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {IListingRegistry, ListingClass, ListingKind, ListingRecord} from "../../src/box-v2/interfaces/IListingRegistry.sol";

/// @notice SH-SEP-DEPLOY-GUARD: core v2 is released from the default (`mainnet`) build profile only. The constants core
/// v2 takes from `sh-box-build/` (the native raise RAISE_ETH, ReleaseConstantsV2.sol:13, and the four ETH amounts the
/// listing registry and planner scale by it) must be the release's, on Sepolia as on mainnet. FOUNDRY_PROFILE=rehearsal
/// (core v1's F78 1/10 build) maps `sh-box-build/` to src/box/build/rehearsal/ and would otherwise build a
/// ListingRegistry whose native row lists 0.4206980085 ETH: not rc7's reviewed bytes. Script-only; no release byte here.
abstract contract CoreV2ReleaseBuild {
    /// @notice The release's native raise: 4.206980085 ETH (packages/box-spec/build-profiles.v1.json, profile `mainnet`).
    uint256 internal constant RELEASE_RAISE_ETH = 4_206_980_085_000_000_000;
    /// @notice The release's BoxSpecV1.BOOTSTRAP_ETH, FEE_BATCH_MIN_ETH, FEE_BATCH_TIP_MAX_ETH and SWAP_STEP_MIN_Q.
    uint256 internal constant RELEASE_BOOTSTRAP_ETH = 1_500_000_000_000_000;
    uint256 internal constant RELEASE_FEE_BATCH_MIN_ETH = 5_000_000_000_000_000;
    uint256 internal constant RELEASE_FEE_BATCH_TIP_MAX_ETH = 500_000_000_000_000;
    uint256 internal constant RELEASE_SWAP_STEP_MIN_Q = 5_000_000_000_000_000;

    /// @notice The build-profile values this compilation carries (raw wei, decimal in any record).
    struct BuildConstants {
        string profile;
        bool rehearsal;
        uint256 raiseEth;
        uint256 bootstrapEth;
        uint256 feeBatchMinEth;
        uint256 feeBatchTipMaxEth;
        uint256 swapStepMinQ;
    }

    /// @notice This build is not the release's: unset FOUNDRY_PROFILE (or set it to `default`) and simulate again.
    /// (`sepolia-rehearsal` shares the release build but is for the offline chronology only, never a signed deploy.)
    error NotReleaseBuild(string profile, uint256 raiseEth, uint256 releaseRaiseEth);
    /// @notice The deployed listing registry's native row is not the release's (an artifact from another build).
    error NotReleaseListing(address registry, uint256 raiseEth, uint256 releaseRaiseEth);

    /// @dev The values compiled into this script, from the same remapping every release artifact used.
    function _compiledBuild() internal pure returns (BuildConstants memory b) {
        b = BuildConstants(
            BoxBuildV1.PROFILE,
            BoxBuildV1.REHEARSAL,
            ReleaseConstantsV2.RAISE_ETH,
            BoxSpecV1.BOOTSTRAP_ETH,
            BoxSpecV1.FEE_BATCH_MIN_ETH,
            BoxSpecV1.FEE_BATCH_TIP_MAX_ETH,
            BoxSpecV1.SWAP_STEP_MIN_Q
        );
    }

    /// @dev Refuses any value other than the release's; the profile must be the generated `mainnet` one.
    function _requireReleaseBuild(BuildConstants memory b) internal pure {
        if (
            keccak256(bytes(b.profile)) != keccak256("mainnet") || b.rehearsal || b.raiseEth != RELEASE_RAISE_ETH
                || b.bootstrapEth != RELEASE_BOOTSTRAP_ETH || b.feeBatchMinEth != RELEASE_FEE_BATCH_MIN_ETH
                || b.feeBatchTipMaxEth != RELEASE_FEE_BATCH_TIP_MAX_ETH || b.swapStepMinQ != RELEASE_SWAP_STEP_MIN_Q
        ) revert NotReleaseBuild(b.profile, b.raiseEth, RELEASE_RAISE_ETH);
    }

    /// @dev A deployed registry's own constant (code, not state): the native row's raise may later be lowered by the
    /// lister (`updateRaise`, runbook decision), but RAISE_ETH is the build's and must be the release's.
    function _requireReleaseRaiseConstant(address registry) internal view {
        uint256 constantRaise = IListingRegistry(registry).RAISE_ETH();
        if (constantRaise != RELEASE_RAISE_ETH) revert NotReleaseListing(registry, constantRaise, RELEASE_RAISE_ETH);
    }

    /// @dev Reads the simulated registry back: its constant and its native row 0 must be the release's raise and
    /// thresholds (at the release raise each threshold is its ETH amount exactly: mulDivRoundingUp(R, X, R) = X).
    /// Runs before Foundry sends anything: a script revert aborts the whole broadcast.
    function _requireReleaseListing(address registry) internal view {
        IListingRegistry lr = IListingRegistry(registry);
        uint256 constantRaise = lr.RAISE_ETH();
        ListingRecord memory row = lr.listing(0);
        if (
            constantRaise != RELEASE_RAISE_ETH || row.raise != RELEASE_RAISE_ETH || row.id != 0
                || row.token != address(0) || row.decimals != 18 || row.class != ListingClass.NATIVE
                || row.kind != ListingKind.LISTED || row.q.bootstrapQ != RELEASE_BOOTSTRAP_ETH
                || row.q.batchMinQ != RELEASE_FEE_BATCH_MIN_ETH || row.q.tipMaxQ != RELEASE_FEE_BATCH_TIP_MAX_ETH
                || row.q.swapStepMinQ != RELEASE_SWAP_STEP_MIN_Q
        ) revert NotReleaseListing(registry, constantRaise != RELEASE_RAISE_ETH ? constantRaise : row.raise, RELEASE_RAISE_ETH);
    }
}
