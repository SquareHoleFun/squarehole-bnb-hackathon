// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU4ClaudeHandler} from "./AuditU4ClaudeHandler.sol";
import {AuditU4ClaudeCampaign} from "./AuditU4ClaudeInvariants.t.sol";

/// @title AuditU4ClaudeReachTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). The invariant handler catches every refusal (`fail_on_revert`), so the
/// runner's own table shows no reverts whatever happens. This test drives the same handler in each invariant world
/// with a fixed pseudo-random sequence of `CALLS` actions (keccak of the world's name and the step), logs how many of
/// each action succeeded (or, for the refusing tip recipient, was refused as it must be), and requires the ones the
/// world allows to succeed at least once: the campaign reaches every path it claims to test (plan § 3.2's "every
/// action must succeed", applied to U4's handler). The handler itself never reverts.
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeReachTest is AuditU4ClaudeCampaign {
    uint256 internal constant CALLS = 1_200;

    function testProperty_AUDIT_U4_handlerReachGraduated() public {
        _toGraduated();
        uint256[23] memory c = _reach(false, "graduated");
        _requireCommon(c);
        assertEq(c[16], 0, "no explicit onGraduation succeeds (settled inside graduate())");
        assertEq(c[17], 0, "no settlement in the campaign");
        assertGt(c[18], 0, "FIT's executor bought (REV-16 notes)");
    }

    function testProperty_AUDIT_U4_handlerReachLate() public {
        _toLateWorld(0);
        uint256[23] memory c = _reach(false, "late");
        _requireCommon(c);
        assertEq(c[17], 1, "the late settlement, once");
    }

    function testProperty_AUDIT_U4_handlerReachLateEpoch() public {
        _toLateWorld(45 days);
        uint256[23] memory c = _reach(false, "late-epoch");
        _requireCommon(c);
        assertEq(c[17], 1, "the late settlement, once");
    }

    function testProperty_AUDIT_U4_handlerReachBonding() public {
        _toBonding();
        uint256[23] memory c = _reach(true, "bonding");
        _requireCommon(c);
        assertGt(c[9], 0, "coordinator gifts before graduation");
        assertEq(c[20], 1, "graduate() once");
        assertEq(c[17], 1, "the settlement, once (inside graduate())");
    }

    function _requireCommon(uint256[23] memory c) internal pure {
        assertGt(
            c[0], CALLS * 8 / 10, "the handler counted its steps (giftCoordinator and closeAndGraduate skip when moot)"
        );
        string[14] memory names = [
            "buy",
            "sell",
            "collect",
            "collectSmall",
            "collectBadTip",
            "fundFees",
            "fundDepth",
            "gift",
            "giftCoordinator",
            "force",
            "royalty",
            "royaltyStipend",
            "flush",
            "payFit"
        ];
        uint256[13] memory need = [uint256(1), 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
        for (uint256 i; i < need.length; ++i) {
            uint256 k = need[i];
            assertGt(c[k], 0, k <= 14 ? names[k - 1] : "payPlatform");
        }
        assertGt(c[21], 0, "warp");
    }

    function _reach(bool canGraduate, string memory world) internal returns (uint256[23] memory c) {
        AuditU4ClaudeHandler h = new AuditU4ClaudeHandler(_handlerWorld(), canGraduate);
        bytes4[] memory sel = _selectors();
        for (uint256 i; i < CALLS; ++i) {
            uint256 r = uint256(keccak256(abi.encode(world, i)));
            (bool ok,) = address(h).call(abi.encodeWithSelector(sel[r % sel.length], r >> 8, r >> 136));
            assertTrue(ok, "the handler never reverts");
        }
        c = h.coverage();
        string[23] memory names = [
            "calls",
            "buy",
            "sell",
            "collect",
            "collect refused (minimum)",
            "collect refused (bad tip)",
            "fundFees",
            "fundDepth",
            "gift",
            "gift to the coordinator",
            "forced ETH",
            "royalty",
            "royalty by stipend",
            "flush or sweep",
            "payFit",
            "payPlatform",
            "onGraduation",
            "settlements",
            "execute (bought)",
            "deepen (added)",
            "graduate",
            "warp",
            "epoch edges"
        ];
        emit log_string(string.concat("world: ", world));
        for (uint256 i; i < 23; ++i) {
            emit log_named_uint(names[i], c[i]);
        }
        (uint256 epoch,,) = receiver.platformEpoch();
        emit log_named_uint("epoch reached", epoch);
    }
}
