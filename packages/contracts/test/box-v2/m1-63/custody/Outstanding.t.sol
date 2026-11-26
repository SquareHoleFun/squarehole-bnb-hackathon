// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SweepFixture} from "../../r40a/SweepFixture.sol";

/// @notice M1-63-CUST-03 rechecks M1-61a's open custody issue without changing any production state.
/// Real coordinator, receiver, T and PoolManager; scripted hook/router/vault boundaries.
contract CustodyOutstandingTest is SweepFixture {
    function test_holderBurnLeavesFixedShareUntilPermanentClaims() public {
        _fail(100, 100);
        vm.prank(ALICE);
        t.burn(40);
        assertEq(_left(), 100);
        assertEq(_claim(ALICE, 60, ALICE), 60);
        assertEq(t.balanceOf(ALICE), 0);
        assertEq(_left(), 40, "burned T stays counted");
        _retainedAtYear(40);
        _assertClaimsOpen(ALICE, 1);
    }

    function test_postFailureReceiverGiftKeepsCountUntilPermanentClaims() public {
        _fail(100, 100);
        vm.prank(ALICE);
        t.transfer(address(fees), 40);
        assertEq(fees.tBurnPending(), 0, "a direct gift is not a buy-back burn obligation");
        assertEq(fees.burnPending(), 0);
        assertEq(_left(), 100);
        assertEq(_claim(ALICE, 60, ALICE), 60);
        assertEq(t.balanceOf(ALICE), 0);
        assertEq(_left(), 40, "system-held gift stays counted");
        _retainedAtYear(40);
        _assertClaimsOpen(ALICE, 1);
    }
}
