// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxVaultV2} from "../interfaces/IBoxVaultV2.sol";

/// @title BoxVaultV2LaterStubs (core v2 M1, ticket M1-00; integrator, review fixes)
/// @notice Reserved earned-token hand-off (add-on 9) remains deferred under F122. M3 supplies itemTimes.
abstract contract BoxVaultV2LaterStubs is IBoxVaultV2 {
    /// @inheritdoc IBoxVaultV2
    function itemTimes(uint256) external view virtual returns (uint64, uint64);

    /// @inheritdoc IBoxVaultV2
    function forwardEarned(address) external virtual returns (uint256) {
        revert NOT_OFFERED();
    }
}
