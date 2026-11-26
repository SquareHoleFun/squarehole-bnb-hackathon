// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture} from "../cq11-b/ReceiverFixture.sol";
import {IBoxReceiverV2, FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract FableReceiverTest is ReceiverFixture {
    function test_item4_ownCoinRoyaltyRevertsWithoutMovingOrBookingT() public {
        t.mint(address(this), 150);
        t.approve(address(r), 150);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
        r.fundRoyalty(address(t), 150);
        assertEq(t.balanceOf(address(this)), 150);
        assertEq(t.allowance(address(this), address(r)), 150);
        assertEq(t.balanceOf(address(r)), 0);
        assertEq(t.balanceOf(CONVERSION), 0);
    }

    function test_item4_ownCoinRefusedInEveryPhaseIncludingZeroAmount() public {
        for (uint256 phase; phase < 3; ++phase) {
            if (phase == 1) coord.graduation(r);
            if (phase == 2) {
                // Separate failed box: graduation and failure are exclusive.
                setUp();
                coord.failure(r);
            }
            vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
            r.fundRoyalty(address(t), 0);
        }
    }

    function test_item6_deficitPreservesSafeDebtAndFailureDestinations() public {
        _fees(150, 150);
        r.collect(address(0));
        vm.prank(address(r));
        pm.transfer(address(0xBEEF), uint160(address(p)), 100);
        vm.expectEmit(true, false, false, true, address(r));
        emit IBoxReceiverV2.BookingClipped(address(p), 300, 200);
        FeeBatchV2 memory batch = r.collect(TIP);
        assertEq(batch.buyersP, 0);
        assertEq(batch.tip, 0);
        assertEq(r.fitOwed(), 40);
        assertEq(r.platformOwed(), 20);
        assertEq(r.booked(address(p)), 200);
        coord.failure(r);
        assertEq(r.fitOwed(), 40);
        assertEq(r.platformOwed(), 20);
        assertEq(_balance(address(coord)), 140);
        assertEq(r.payFit(), 40);
        assertEq(r.payPlatform(), 20);
        assertEq(_balance(address(r)), 0);
    }

    function test_item6_shortfallBelowSafeDebtStaysOwedAndCanBeRefilled() public {
        _fees(300, 0);
        r.collect(address(0));
        vm.prank(address(r));
        pm.transfer(address(0xBEEF), uint160(address(p)), 290);
        r.collect(TIP);
        assertEq(r.fitOwed(), 40);
        assertEq(r.platformOwed(), 20);
        assertEq(r.booked(address(p)), 60, "unbacked debt is not forgiven");
        assertEq(r.payFit(), 0);
        assertEq(r.payPlatform(), 0);
        coord.failure(r);
        assertEq(_balance(address(coord)), 0);
        assertEq(r.fitOwed(), 40);
        assertEq(r.platformOwed(), 20);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 50);
        assertEq(r.collect(address(0)).buyersP, 0, "refill backs existing debt");
        assertEq(r.payPlatform(), 20);
        assertEq(r.payFit(), 40);
        assertEq(_balance(address(r)), 0);
    }

    function testFuzz_item6_onlyOtherLedgersClip(uint96 remaining) public {
        _fees(1500, 1500);
        r.collect(address(0));
        uint256 balance = bound(remaining, 0, 2999);
        vm.prank(address(r));
        pm.transfer(address(0xBEEF), uint160(address(p)), 3000 - balance);
        r.collect(address(0));
        assertEq(r.fitOwed(), 400);
        assertEq(r.platformOwed(), 200);
        assertEq(r.booked(address(p)), balance > 600 ? balance : 600);
        assertLe(r.creatorP(), 2000);
        assertLe(r.poolHeldP(), 400);
        assertEq(r.collect(address(0)).buyersP, 0);
    }
}
