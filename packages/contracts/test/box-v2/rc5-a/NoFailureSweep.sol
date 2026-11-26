// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

/// @dev Shared regression assertion for the removed entry. Uses real call dispatch, never a test substitute.
library NoFailureSweep {
    function check(address target) internal {
        (uint256 pot, uint256 left) = IBoxCoordinatorV2(target).claimState();
        (bool ok,) = target.call(abi.encodeWithSignature("sweepAfterLastClaim()"));
        require(!ok, "RC5: sweep selector must refuse");
        (uint256 afterPot, uint256 afterLeft) = IBoxCoordinatorV2(target).claimState();
        require(pot == afterPot && left == afterLeft, "RC5: pot and claim rights unchanged");
    }
}
