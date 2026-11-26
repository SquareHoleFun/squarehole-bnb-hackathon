// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookingFixture} from "../../m3-23/Fixture.sol";

contract RulesPayoutFindingsTest is BookingFixture {
    function test_R05_F130_anyCallerPaysOnlyFixedFitSafe() public {
        _safePayout(true);
    }

    function test_R05_F130_anyCallerPaysOnlyFixedPlatformSafe() public {
        _safePayout(false);
    }

    function _safePayout(bool fit) private {
        _items(5, 5, 1, 2);
        _source(1, 150, 150);
        r.collect(address(0));
        address safe = fit ? FIT : PLATFORM;
        uint256 owed = fit ? r.fitOwed() : r.platformOwed();
        uint256 otherOwed = fit ? r.platformOwed() : r.fitOwed();
        uint256 backing = _balance(address(r));
        uint256 itemsHeld = r.itemsHeldP();
        uint256 callerP = p.balanceOf(ALICE);
        assertEq(fit ? r.FIT_SAFE() : r.PLATFORM_SAFE(), safe);
        assertGt(owed, 0);
        vm.prank(ALICE);
        assertEq(fit ? r.payFit() : r.payPlatform(), owed);
        assertEq(p.balanceOf(safe), owed, "F130: whole payout to fixed Safe");
        assertEq(p.balanceOf(ALICE), callerP, "no caller payout or tip");
        assertEq(p.balanceOf(fit ? PLATFORM : FIT), 0);
        assertEq(fit ? r.fitOwed() : r.platformOwed(), 0);
        assertEq(fit ? r.platformOwed() : r.fitOwed(), otherOwed);
        assertEq(r.itemsHeldP(), itemsHeld);
        assertEq(_balance(address(r)) + owed, backing);
        vm.prank(ALICE);
        assertEq(fit ? r.payFit() : r.payPlatform(), 0);
        assertEq(p.balanceOf(safe), owed);
        assertEq(_balance(address(r)) + owed, backing);
        _booked();
    }
}
