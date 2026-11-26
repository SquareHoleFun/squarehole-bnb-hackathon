// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditSysLaneWorld} from "./AuditSysLaneWorld.sol";

abstract contract AuditSysLaneInvariantsBase is AuditSysLaneWorld {
    /// @notice Property X01-X21: every target call completes its full in-transaction property check before it returns.
    function invariant_laneWholeLifeAccounting() public view {
        assertEq(checked, driver.calls(), "X01-X21 every handler call was checked");
    }
}

/// @notice Property X01-X21: box 0 conserves its ledgers from creation, through taxed buys and graduation, to closure.
/// forge-config: default.evm_version = "osaka"
/// forge-config: deep.evm_version = "osaka"
contract AuditSysLaneCreationInvariants is AuditSysLaneInvariantsBase {
    function setUp() public override {
        _laneSetup(0);
    }
}

/// @notice Property X01-X21: trading, drawing, returning and streaming preserve accounting after graduation.
/// forge-config: default.evm_version = "osaka"
/// forge-config: deep.evm_version = "osaka"
contract AuditSysLaneGraduatedInvariants is AuditSysLaneInvariantsBase {
    function setUp() public override {
        _laneSetup(1);
    }
}

/// @notice Property X01-X21: silent drand still permits the bounded backup and terminal exits without losing funds.
/// forge-config: default.evm_version = "osaka"
/// forge-config: deep.evm_version = "osaka"
contract AuditSysLaneSilentInvariants is AuditSysLaneInvariantsBase {
    function setUp() public override {
        _laneSetup(2);
    }
}
