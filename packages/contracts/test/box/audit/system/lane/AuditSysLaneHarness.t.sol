// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AuditSysLaneHandler, LaneWorld} from "./AuditSysLaneHandler.sol";

contract AuditSysLaneHarnessTest is Test, LaneWorld {
    uint256 private observed;

    function laneStep(uint256 choice, uint256 seed) external {
        observed = choice ^ seed;
    }

    /// @notice Property: the fuzz target forwards both inputs and counts exactly one checked transition.
    function test_laneForwardingCountsCheckedTransitions() public {
        AuditSysLaneHandler h = new AuditSysLaneHandler(this);
        h.step(17, 91);
        assertEq(observed, 17 ^ 91);
        assertEq(h.calls(), 1);
    }
}
