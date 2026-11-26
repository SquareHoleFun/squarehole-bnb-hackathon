// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxItemStreamLifeTest} from "../../s8/BoxItemStreamLife.t.sol";

/// @title AuditU5ClaudeStreamLifeTest
/// @notice SH-AUDIT-B0 U5 (Claude): the tree's own life fuzz of the stream against a per-swap reference
/// (`test/box/s8/BoxItemStreamLife.t.sol`, BC-065, on the factory's box 0 at N 4,269: curve placeholders, graduation,
/// a draw, 30 days of trading, openings, transfers to a contract, claims, two pair-and-lock adds, a return), imported
/// read-only and run here at the default profile's 1,000 fuzz runs instead of its 6 (map § 6 item 5: "the life fuzz
/// runs 6 cases"). Its tests keep their names (`testFuzz_BC065_lifeAgainstPerSwapAllocation`, `test_BC139_...`)
/// under this contract.
/// forge-config: default.evm_version = "osaka"
/// forge-config: default.fuzz.runs = 1000
contract AuditU5ClaudeStreamLifeTest is BoxItemStreamLifeTest {}
