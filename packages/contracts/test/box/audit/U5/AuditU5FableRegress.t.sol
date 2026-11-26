// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxItemStreamDifferentialTest} from "../../s8/BoxItemStreamDifferential.t.sol";
import {BoxItemStreamLifeTest} from "../../s8/BoxItemStreamLife.t.sol";

/// @title AuditU5FableDifferentialTest
/// @notice SH-AUDIT-B0-U5-F: the tree's S8 differential (BC-065; `test/box/s8/BoxItemStreamDifferential.t.sol`, the
/// stream's checkpoints against a naive per-swap allocation on the S8 stand-in world, 70 random operations a run) run
/// through this contract at the default profile's 1,000 runs per edition size (the unit brief asks for it in the
/// unit's own files; the tree runs the same contract at the same 1,000). Composition, not a copy: the tree's test
/// contract is deployed and its fuzz entry called per run, so a failure there fails here.
/// forge-config: default.evm_version = "osaka"
contract AuditU5FableDifferentialTest is Test {
    function testFuzz_AUDIT_U5_differentialN4269(uint256 seed) public {
        BoxItemStreamDifferentialTest d = new BoxItemStreamDifferentialTest();
        d.testFuzz_BC065_checkpointsEqualPerSwapAllocation_N4269(seed);
    }

    function testFuzz_AUDIT_U5_differentialN69(uint256 seed) public {
        BoxItemStreamDifferentialTest d = new BoxItemStreamDifferentialTest();
        d.testFuzz_BC065_checkpointsEqualPerSwapAllocation_N69(seed);
    }
}

/// @title AuditU5FableLifeTest
/// @notice SH-AUDIT-B0-U5-F: the tree's S8 life fuzz on the factory's box 0 (`test/box/s8/BoxItemStreamLife.t.sol`:
/// placeholders, graduation on the vector round, a draw, 30 days of trading, openings, a pair-and-lock add, returns,
/// claims, against the per-swap allocation by StateLibrary), which the tree runs at 6 cases, here at 256.
/// forge-config: default.evm_version = "osaka"
/// forge-config: default.fuzz.runs = 256
contract AuditU5FableLifeTest is Test {
    function testFuzz_AUDIT_U5_lifeAgainstPerSwapAllocation(uint256 seed) public {
        BoxItemStreamLifeTest life = new BoxItemStreamLifeTest();
        life.setUp();
        life.testFuzz_BC065_lifeAgainstPerSwapAllocation(seed);
    }
}
