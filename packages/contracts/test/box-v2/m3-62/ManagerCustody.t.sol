// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {M340Base} from "../m3-40/Fixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract M362ManagerCustody is M340Base {
    function test_unrelatedManagerClaimsRemainInTheFixedCount() public {
        _start(_pile(address(0), 0));
        _buy(box.raise() / 5);
        uint256 held = token.balanceOf(address(buyer));
        uint256 otherClaims = held / 7;
        address otherHolder = address(0xA11CE);
        buyer.mintClaims(Currency.wrap(address(token)), otherHolder, otherClaims);
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, held, "outside PM claims are backed holder T, not closed pool inventory");
        uint256 liquid = token.balanceOf(address(buyer));
        vm.startPrank(address(buyer));
        token.approve(address(box), liquid);
        uint256 paid = box.claim(liquid, address(buyer));
        vm.stopPrank();
        (uint256 remaining, uint256 counted) = box.claimState();
        assertEq(counted, otherClaims);
        assertEq(pot, paid + remaining);
        assertEq(pm.balanceOf(otherHolder, uint160(address(token))), otherClaims);
        // R40A freezes this count even if another holder never redeems its PM claims.
        vm.warp(box.failedAt() + 365 days);
        NoFailureSweep.check(address(box));
    }
}
