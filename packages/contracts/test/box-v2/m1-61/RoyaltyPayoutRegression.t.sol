// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MoneyFixture} from "./MoneyFixture.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

/// @notice CQ11-F / C5.5 / C15.5-7: small royalty intakes can accumulate beyond a single v4 payout.
contract RoyaltyPayoutRegressionTest is MoneyFixture {
    uint256 private constant MAX_PART = uint256(uint128(type(int128).max));
    uint256 private constant MAX_BATCH = 4 * MAX_PART;
    uint256 private constant PAYOUT_CALL_GAS = 2_000_000;

    function test_repeatedPayoutOfHeldTokenRoyaltiesDeliversFullBalance() public {
        _repeatedPayout(false, true);
    }

    function test_repeatedPayoutOfGraduatedTokenRoyaltiesDeliversFullBalance() public {
        _repeatedPayout(false, false);
    }

    function test_repeatedPayoutOfHeldNativeRoyaltiesDeliversFullBalance() public {
        _repeatedPayout(true, true);
    }

    function test_repeatedPayoutOfGraduatedNativeRoyaltiesDeliversFullBalance() public {
        _repeatedPayout(true, false);
    }

    function _repeatedPayout(bool nativeP, bool heldUntilGraduation) private {
        _realBox(1, 2, 1, false, nativeP ? address(0) : address(priceToken));
        if (!heldUntilGraduation) _graduate();

        uint256 intake = MAX_PART / 8;
        uint256 intakeCount = 110;
        uint256 largeBalance = intakeCount * intake;
        assertLe(intake, MAX_PART, "every intake fits the manager's signed delta");
        assertGt(largeBalance / 15 * 10, 2 * MAX_BATCH, "balance requires repeated bounded payouts");
        assertLt(largeBalance / 15 * 10, 3 * MAX_BATCH, "last payout is a partial batch");
        for (uint256 i; i < intakeCount; ++i) {
            _royaltyP(intake);
            uint256 accumulated = (i + 1) * intake;
            assertEq(fees.royaltyHeldP(), heldUntilGraduation ? accumulated : 0);
            assertEq(fees.creatorP(), heldUntilGraduation ? 0 : accumulated / 15 * 10);
            assertEq(fees.booked(p), heldUntilGraduation ? accumulated : accumulated - accumulated / 15 * 2);
            assertEq(_claimsP(address(fees)), fees.booked(p));
            assertEq(_balance(address(pm)), accumulated, "royalty claims have real backing");
            _assertBooked();
        }
        if (heldUntilGraduation) {
            vm.expectRevert(IBoxReceiverV2.NotGraduated.selector);
            vm.prank(CREATOR);
            fees.claimCreator(p, BOB);
            _graduate();
        }
        assertEq(fees.royaltyHeldP(), 0);
        uint256 creatorAllocation = largeBalance / 15 * 10;
        uint256 bookedStart = fees.booked(p);
        assertEq(fees.creatorP(), creatorAllocation);
        address outsideCaller = ALICE;
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotPayee.selector, outsideCaller));
        vm.prank(outsideCaller);
        fees.claimCreator(p, BOB);

        uint256 totalPaid;
        // A fixed call count also rejects a payout that makes no progress and leaves debt behind.
        for (uint256 i; i < 3; ++i) {
            uint256 remaining = creatorAllocation - totalPaid;
            uint256 expected = remaining > MAX_BATCH ? MAX_BATCH : remaining;
            vm.expectEmit(address(fees));
            emit IBoxReceiverV2.CreatorClaimed(CREATOR, p, BOB, expected);
            vm.prank(CREATOR);
            uint256 paid = fees.claimCreator{gas: PAYOUT_CALL_GAS}(p, BOB);
            assertEq(paid, expected, "report only the completed batch");
            totalPaid += paid;
            assertEq(_balance(BOB), totalPaid, "recipient receives every paid raw unit");
            assertEq(fees.creatorP(), creatorAllocation - totalPaid);
            assertEq(fees.booked(p), bookedStart - totalPaid);
            assertEq(_claimsP(address(fees)), bookedStart - totalPaid);
            assertEq(_balance(address(pm)), largeBalance - totalPaid);
            assertEq(fees.fitOwed() + fees.platformOwed() + fees.buyBackP(), largeBalance / 15 * 3);
            assertEq(_pot(), 0);
            assertEq(_claimsP(address(hook)), largeBalance / 15 * 2, "pool share stays with the box");
            _assertBooked();
        }
        assertEq(totalPaid, creatorAllocation);
        vm.prank(CREATOR);
        assertEq(fees.claimCreator{gas: PAYOUT_CALL_GAS}(p, BOB), 0, "empty retry pays nothing twice");
        assertEq(_balance(BOB), creatorAllocation);
        assertEq(_balance(address(fees)), 0);
        assertEq(_balance(CREATOR) + _balance(FIT) + _balance(PLATFORM), 0);
    }

    function _graduate() private {
        hook.fill();
        box.graduate();
        assertTrue(box.graduated());
    }
}
