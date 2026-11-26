// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IListingChecksProbe, IBoxTokenProofProbe} from "./M1_20cProbes.sol";
import {BoxTokenProofProbe, ListingChecksProbe} from "./M1_20cHarness.sol";

/// @title M1_20cDeployHook
/// @notice TEST ONLY. The one file of M1-20-c's red tests its implementer edits: each body deploys a probe written in
/// this folder (`M1_20cHarness.sol`), whose entries call `src/box-v2/libraries/ListingChecks.sol` and
/// `BoxTokenProof.sol` and nothing else. Until the implementer filled it, each reverted `NotBuilt()`.
abstract contract M1_20cDeployHook {
    /// @param poolManager the kit's PoolManager, through which the probe moves its test amount [P]
    function _deployListingChecksProbe(address poolManager) internal virtual returns (IListingChecksProbe) {
        return new ListingChecksProbe(poolManager);
    }

    /// @param boxRegistry this release's box registry (the kit's registry v2, its directory holding FIT's registry)
    function _deployBoxTokenProofProbe(address boxRegistry) internal virtual returns (IBoxTokenProofProbe) {
        return new BoxTokenProofProbe(boxRegistry);
    }
}
