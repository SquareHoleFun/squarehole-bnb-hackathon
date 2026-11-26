// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";
import {FailureTestBase, IBoxCoordinatorV2, IBoxCoordinator, FullMath} from "../m1-31/FailureTestBase.sol";

contract ClaimsTest is FailureTestBase {
    function test_claimPaysProRataAndLastRemainder() public {
        _fail(101, 100);
        assertEq(_claim(ALICE, 33, BOB), 33);
        assertEq(_left(), 67);
        assertEq(_pot(), 68);
        assertEq(_claim(ALICE, 67, ALICE), 68);
        assertEq(_pot(), 0);
        assertEq(_left(), 0);
        assertEq(_balance(BOB) + _balance(ALICE), 101);
    }

    function test_claimSweepsLateTaxBeforeQuote() public {
        _fail(100, 100);
        _tax(100);
        assertEq(box.quoteClaim(50), 50); // read never calls the router
        assertEq(_claim(ALICE, 50, ALICE), 100);
        assertEq(_claim(ALICE, 50, ALICE), 100);
    }

    function test_refusedSweepDoesNotBlockClaimAndRetries() public {
        _fail(100, 100);
        _tax(100);
        router.configure(true, false);
        assertEq(_claim(ALICE, 50, ALICE), 50);
        router.configure(false, false);
        assertEq(_claim(ALICE, 50, ALICE), 150);
    }

    function test_afterLastClaimGiftAndTaxStayPut() public {
        _fail(100, 100);
        _claim(ALICE, 100, ALICE);
        _fund(p, address(box), 11);
        _tax(7);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        vm.prank(CREATOR);
        box.claim(0, CREATOR);
        // The permissionless router sweep is a separate retry, just as the keeper does.
        router.sweep();
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), 0);
        receiver.payFit();
        assertEq(_balance(receiver.FIT_SAFE()), 0);
        assertEq(_pot(), 18);
    }

    function test_surplusCannotSpendUnpaidHolder() public {
        _fail(100, 100);
        NoFailureSweep.check(address(box));
        assertEq(_pot(), 100);
    }

    function test_noBuyerCreatorEntitlementFixedBeforeLateMoney() public {
        _fail(101, 0);
        _fund(p, address(box), 19);
        assertEq(box.quoteClaim(0), 101);
        NoFailureSweep.check(address(box));
        assertEq(_pot(), 120);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(0, BOB);
        assertEq(_claim(CREATOR, 0, BOB), 101);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        vm.prank(CREATOR);
        box.claim(0, BOB);
        assertEq(receiver.fitOwed(), 0);
    }

    function test_noBuyerLateTaxDuringClaimCannotIncreaseReturn() public {
        _fail(100, 0);
        _tax(27);
        assertEq(_claim(CREATOR, 0, CREATOR), 100);
        NoFailureSweep.check(address(box));
    }

    function test_claimRefusesZeroExcessZeroToAndPullsOnlyCaller() public {
        _fail(100, 100);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(0, ALICE);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(101, ALICE);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(1, address(0));
        vm.expectRevert();
        box.claim(1, ALICE);
        assertEq(_left(), 100);
        assertEq(_pot(), 100);
    }

    function test_pausedPClaimRollsBackTThenRetries() public {
        _fail(100, 100);
        priceToken.setPaused(true);
        vm.expectRevert();
        vm.prank(ALICE);
        box.claim(100, ALICE);
        assertEq(t.balanceOf(ALICE), 100);
        assertEq(_left(), 100);
        assertEq(_pot(), 100);
        priceToken.setPaused(false);
        assertEq(_claim(ALICE, 100, BOB), 100);
    }

    function test_refusedBurnDoesNotBlockOrCountSameCoinTwice() public {
        _fail(100, 100);
        vault.configure(100, 0, false);
        assertEq(_claim(ALICE, 40, ALICE), 40);
        assertEq(t.balanceOf(address(box)), 40);
        assertEq(t.totalSupply(), 100);
        assertEq(_left(), 60);
        assertEq(_claim(ALICE, 60, ALICE), 60);
    }

    function test_reentrantPTransferCannotClaimAgain() public {
        _fail(100, 100);
        priceToken.armReentry(address(box), abi.encodeCall(box.claim, (1, BOB)));
        vm.expectRevert();
        vm.prank(ALICE);
        box.claim(100, ALICE);
        assertEq(_pot(), 100);
        assertEq(_left(), 100);
        priceToken.armReentry(address(0), "");
        assertEq(_claim(ALICE, 100, ALICE), 100);
    }

    function test_nativeRefusingRecipientRetriesToAnother() public {
        _box(address(0), false, true);
        _fail(100, 100);
        vm.expectRevert();
        vm.prank(ALICE);
        box.claim(100, address(hook));
        assertEq(_left(), 100);
        assertEq(_claim(ALICE, 100, BOB), 100);
    }

    function test_claimsHaveNoExpiryAndZeroPotStillAcceptsT() public {
        _fail(0, 100);
        vm.warp(block.timestamp + 1000 days);
        assertEq(_claim(ALICE, 100, ALICE), 0);
        assertEq(_left(), 0);
    }

    function test_claimBeforeFailureAndCallbackSpoofRefused() public {
        vm.expectRevert(IBoxCoordinatorV2.NotFailed.selector);
        box.claim(1, ALICE);
        vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
        box.unlockCallback(abi.encode(uint8(1), ALICE, 1));
    }

    function test_largePotAboveSinglePoolManagerDeltaStillHasAnExit() public {
        // Claims can accumulate across unlocks beyond int128, the limit of each burn/take delta.
        uint256 part = uint256(uint128(type(int128).max));
        _give(ALICE, 1);
        _fund(p, address(hook), part);
        _fund(p, address(hook), part);
        _expire();
        box.fail();
        assertEq(_pot(), 2 * part);
        assertEq(_claim(ALICE, 1, ALICE), 2 * part);
        assertEq(_pot(), 0);
    }

    /// forge-config: default.fuzz.runs = 5000
    function testFuzz_claimConservation(uint128 potSeed, uint96 tSeed, uint96 firstSeed) public {
        uint256 pot = bound(potSeed, 0, uint256(uint128(type(int128).max)));
        uint256 coins = bound(tSeed, 2, 1e28);
        uint256 first = bound(firstSeed, 1, coins - 1);
        _fail(pot, coins);
        uint256 expected = FullMath.mulDiv(pot, first, coins);
        assertEq(_claim(ALICE, first, ALICE), expected);
        assertGe(FullMath.mulDiv(_pot(), coins, coins - first), pot);
        assertEq(_claim(ALICE, coins - first, BOB), pot - expected);
        assertEq(_pot(), 0);
        assertEq(_left(), 0);
    }
}
