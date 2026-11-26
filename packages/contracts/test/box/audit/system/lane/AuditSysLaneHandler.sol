// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface LaneWorld {
    function laneStep(uint256 choice, uint256 seed) external;
}

/// @notice Property: every selected transition is checked in the same transaction that changes the world.
contract AuditSysLaneHandler {
    LaneWorld public immutable world;
    uint256 public calls;

    constructor(LaneWorld world_) {
        world = world_;
    }

    function step(uint256 choice, uint256 seed) external {
        world.laneStep(choice, seed);
        ++calls;
    }
}
