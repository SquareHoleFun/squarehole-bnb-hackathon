// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MoneyFixture} from "../m1-61/MoneyFixture.sol";

/// @dev RC5-A: no role can confiscate failed-box money, including an expired-looking or exhausted pot.
contract PermanentClaimsTest is MoneyFixture {
    function _noSweep() internal {
        uint256 beforePot = _pot();
        uint256 beforeFit = fees.fitOwed();
        (bool ok,) = address(box).call(abi.encodeWithSignature("sweepAfterLastClaim()"));
        assertFalse(ok, "removed sweep selector must refuse");
        assertEq(_pot(), beforePot);
        assertEq(fees.fitOwed(), beforeFit);
    }

    function test_claimsRemainOpenPastYearAndOldSelectorCannotCloseThem() public {
        _fail(101, 100);
        vm.warp(box.failedAt() + 1000 days);
        _noSweep();
        assertEq(box.quoteClaim(33), 33);
        assertEq(_claim(ALICE, 33, BOB), 33);
        _fund(p, address(fees), 19);
        assertEq(fees.collect(CAROL).buyersP, 19);
        assertEq(_balance(CAROL), 0, "failed collect has no tip");
        _royaltyP(7);
        _fund(p, address(hook), 11);
        assertEq(_claim(ALICE, 67, ALICE), 105);
        assertEq(_pot(), 0);
        assertEq(fees.fitOwed(), 0);
    }

    function test_unpresentedShareAndReceiptsAfterLastClaimStayPut() public {
        _fail(100, 100);
        vm.prank(ALICE); t.burn(40);
        assertEq(_claim(ALICE, 60, ALICE), 60);
        vm.warp(box.failedAt() + 10000 days);
        _noSweep();
        assertEq(_pot(), 40);
        assertEq(_left(), 40);
    }

    function test_exhaustedPotHasNoExitForNewReceipts() public {
        _fail(100, 100);
        _claim(ALICE, 100, ALICE);
        _fund(p, address(fees), 17);
        fees.collect(CAROL);
        _royaltyP(13);
        _fund(p, address(box), 7);
        vm.warp(box.failedAt() + 1000 days);
        _noSweep();
        vm.expectRevert(); box.claim(0, CREATOR);
        vm.expectRevert(); box.claim(1, ALICE);
        assertEq(_pot(), 37);
        assertEq(fees.payFit(), 0);
    }

    function test_oneRawTokenCanClaimTheLastShareAfterManyYears() public {
        _fail(101, 1);
        vm.warp(box.failedAt() + 10000 days);
        assertEq(_claim(ALICE, 1, BOB), 101);
        assertEq(_pot(), 0);
        assertEq(_left(), 0);
    }

    function test_creatorRemainderIsFixedAndNeverExpires() public {
        _fail(101, 0);
        _fund(p, address(fees), 19);
        fees.collect(CAROL);
        _royaltyP(7);
        vm.warp(box.failedAt() + 1000 days);
        _noSweep();
        assertEq(box.quoteClaim(0), 101);
        vm.expectRevert(); box.claim(0, BOB);
        assertEq(_claim(CREATOR, 0, BOB), 101);
        assertEq(_pot(), 26);
        _noSweep();
    }

    function testFuzz_unpresentedShareConservation(uint96 pot, uint96 late, uint96 coinsSeed, uint96 claimSeed) public {
        uint256 coins = bound(coinsSeed, 2, 1e28);
        uint256 presented = bound(claimSeed, 1, coins - 1);
        _fail(pot, coins);
        vm.prank(ALICE); t.burn(coins - presented);
        _fund(p, address(fees), late);
        fees.collect(CAROL);
        uint256 paid = _claim(ALICE, presented, BOB);
        assertEq(paid, (uint256(pot) + late) * presented / coins);
        vm.warp(box.failedAt() + 1000 days);
        _noSweep();
        assertEq(_balance(BOB) + _pot(), uint256(pot) + late);
        assertEq(fees.fitOwed(), 0);
        assertEq(_left(), coins - presented);
    }
}
