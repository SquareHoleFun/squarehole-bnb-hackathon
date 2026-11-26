// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11AProtocolTest} from "../cq11-a/Protocol.t.sol";

/// Inherits five real M1 router/buyback/deepen/conservation regressions, without rewriting their expectations.
contract PlainM1Test is CQ11AProtocolTest {
    function test_plainM1StillHasNoOptionalRolesOrLedgerWrites() public {
        assertEq(box.roleAddress(17), address(0));
        assertEq(box.roleAddress(19), address(0));
        assertEq(box.roleAddress(3), address(0));
        assertFalse(box.starterSetPending());
        assertEq(hook.holderLedger(), address(0));
        assertEq(t.ledger(), address(0));
        assertEq(receiver.holderLedger(), address(0));
        _graduate();
        receiver.collect(address(0));
        assertEq(hook.tradeBatch(1).netP, 0);
        assertFalse(receiver.holderBatchClosed(1));
        assertGt(receiver.creatorP(), 0);
        uint256 reward = box.rewardOf(address(this));
        uint256 before = p.balanceOf(address(this));
        box.claimReward(address(this));
        assertEq(p.balanceOf(address(this)) - before, reward);
        (uint256 b, uint256 s, uint256 reserve) = receiver.harvestedFees();
        assertEq(b + s + reserve, 0);
    }
    function test_plainReleasePartsKeepThe22118ByteGate() public view {
        assertLe(ci.code.length, 22118, "coordinator size");
        assertLe(hi.code.length, 22118, "hook size");
        assertLe(ri.code.length, 22118, "receiver size");
        assertLe(li.code.length, 22118, "router size");
        assertLe(ti.code.length, 22118, "plain token size");
    }
}
