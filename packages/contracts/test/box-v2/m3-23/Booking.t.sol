// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookingFixture, ItemCodeRefuses, ItemCodeExhausts} from "./Fixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract EveryItemBookingTest is BookingFixture {
    function test_graduationReleasesBothHeldPoliciesOnceBeforeRoyalty() public {
        _items(5, 5, 1, 2);
        _source(1, 150, 150); _source(2, 300, 300); r.collect(address(0));
        assertEq(r.itemsHeldP(), 300); assertEq(funding.itemFundingCount(), 0); _booked();
        vault.request(bytes32(uint256(1)));
        _royalty(address(p), 150);
        coord.graduation(r);
        assertEq(funding.itemFundingCount(), 3);
        _record(1, 1, 3, 0, 100, 100); _record(2, 2, 3, 0, 200, 0);
        _record(3, 1, 2, 0, 100, 100);
        assertEq(r.buyBackP(), 200); assertEq(r.itemsHeldP(), 0); assertEq(_balance(address(items)), 200);
        items.sync(32);
        (, uint256 credit, bool open) = items.ticketCredit(bytes32(uint256(1)));
        assertEq(credit, 25); assertTrue(open);
        coord.graduation(r); r.collect(address(0)); assertEq(funding.itemFundingCount(), 3); _booked();
    }

    function test_lazyGraduationIncludesZeroReleasesBeforeLiveSources() public {
        _items(5, 5, 2, 1); coord.setGraduated();
        _source(1, 150, 150); _source(2, 300, 300); r.collect(address(0));
        assertEq(funding.itemFundingCount(), 4);
        _record(1, 1, 3, 0, 0, 0); _record(2, 2, 3, 0, 0, 0);
        _record(3, 1, 1, 1, 100, 0); _record(4, 2, 1, 2, 200, 200);
        assertEq(r.buyBackP(), 100); items.sync(32); _booked();
    }

    function test_zeroOneAllOutsideAndRounding() public {
        _items(5, 1, 2, 0); coord.graduation(r);
        _source(1, 15, 15); r.collect(address(0)); _record(2, 1, 1, 1, 10, 2);
        vault.request(bytes32(uint256(1)));
        _source(3, 15, 15); r.collect(address(0)); _record(3, 1, 1, 3, 10, 4);
        for (uint256 i = 2; i <= 4; ++i) vault.request(bytes32(i));
        _source(5, 15, 15); r.collect(address(0)); _record(4, 1, 1, 5, 10, 10);
        items.sync(32); assertEq(items.flushResidue(), 6);
        assertEq(r.buyBackP(), 14); assertEq(_balance(address(items)), 10); _booked();
    }

    function test_failedTipAndTerminalCarryKeepOriginalSource() public {
        _items(5, 4, 1, 0); coord.graduation(r); p.setBlocked(TIP, true);
        _source(1, 1501, 1501); _source(2, 750, 750);
        assertEq(r.collect(TIP).tip, 0); _record(2, 1, 1, 1, 1000, 1000);
        assertEq(r.holderBatchPaid(2), 500); assertEq(_balance(holders), 500);
        assertEq(_balance(address(hook)), 301);
        _source(3, 14, 14); r.collect(address(0));
        assertEq(funding.itemFundingCount(), 2); assertEq(_balance(address(hook)), 315); _booked();
    }

    function test_shortfallNeverBorrowsBookedDebtOrLaterBatch() public {
        _items(5, 1, 1, 0); _royalty(address(p), 150);
        _source(1, 150, 0); batches.harvest(); _source(3, 300, 300);
        coord.setGraduated(); r.collect(address(0));
        _record(1, 1, 3, 0, 0, 0); _record(2, 1, 2, 0, 100, 100);
        _record(3, 1, 1, 3, 200, 200);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 150); r.collect(address(0));
        _record(3, 1, 1, 3, 200, 200); _record(4, 1, 2, 0, 100, 100);
        assertEq(_balance(address(items)), 400); _booked();
    }

    function test_failureHeldItemsAndFinalD6GoToPotWithoutReceipts() public {
        _items(5, 5, 1, 2); _source(1, 150, 150); _source(2, 300, 300); r.collect(address(0));
        _source(3, 150, 150); driver.mintClaims(Currency.wrap(address(p)), address(r), 150);
        coord.failure(r);
        assertEq(_balance(address(coord)), 600); assertEq(r.itemsHeldP(), 0);
        assertEq(r.buyBackP(), 0); assertEq(funding.itemFundingCount(), 0); assertEq(_balance(address(items)), 0);
        coord.failure(r); _royalty(address(p), 75); r.collect(address(0));
        assertEq(_balance(address(coord)), 675); assertEq(r.fitOwed(), 100); _booked();
    }

    function test_revertingAndGasHeavyLedgerCannotStopMixedFeesOrGraduation() public {
        _items(4, 5, 0, 2);
        vm.etch(address(items), address(new ItemCodeRefuses()).code);
        _source(1, 150, 150); _source(2, 150, 150); r.collect(address(0));
        coord.graduation(r); assertEq(r.buyBackP(), 100); assertEq(r.holderBatchPaid(1), 100);
        vault.request(bytes32(uint256(1)));
        vm.etch(address(items), address(new ItemCodeExhausts()).code);
        _source(3, 150, 150); _source(4, 150, 150);
        r.collect{gas: 4_000_000}(address(0));
        _record(2, 2, 1, 4, 100, 25);
        assertEq(_balance(holders), 200); assertEq(_balance(address(items)), 25);
        assertEq(r.buyBackP(), 175); _booked();
    }

    function test_receiptTransferFailureRollsBackAndRetries() public {
        _items(5, 1, 1, 0); coord.graduation(r); _source(1, 150, 150);
        vm.mockCall(address(pm), abi.encodeWithSignature("transfer(address,uint256,uint256)", address(items), uint160(address(p)), 100), abi.encode(false));
        vm.expectRevert(bytes("ClaimsTransferFailed")); r.collect(address(0));
        assertEq(funding.itemFundingCount(), 1); assertEq(r.fitOwed(), 0);
        vm.clearMockedCalls();
        // Normal collect needs only the original coordinator phase reads and cached vault/policies.
        r.collect(address(0)); _record(2, 1, 1, 1, 100, 100); _booked();
    }

    function test_retainedItemMoneyHasTheExistingOwnPoolBurnExit() public {
        _items(5, 1, 2, 0); _pool();
        _source(1, 15000, 15000); r.collect(address(0)); coord.graduation(r);
        assertEq(r.buyBackP(), 10000); uint256 supply = t.totalSupply();
        vm.roll(block.number + 1);
        (, uint256 spent, uint256 bought,) = r.buyBack(address(0));
        assertGt(spent, 0); assertGt(bought, 0);
        assertEq(r.buyBackP() + spent, 10000); assertEq(t.totalSupply() + bought, supply);
        assertEq(r.tBurnPending(), 0); assertEq(_balance(address(items)), 0); _booked();
    }

    function test_twoItemSidesNeedNoLedgerCodeAtGraduationOrLiveBooking() public {
        _items(5, 5, 1, 2); _source(1, 150, 150); _source(2, 150, 150); r.collect(address(0));
        vm.etch(address(items), address(new ItemCodeExhausts()).code);
        coord.graduation(r); _source(3, 150, 150); _source(4, 150, 150);
        r.collect{gas: 4_000_000}(address(0));
        assertEq(funding.itemFundingCount(), 4); assertEq(_balance(address(items)), 200);
        assertEq(r.buyBackP(), 200); _booked();
    }

    function test_pausedPriceAndGasHeavyLedgerCannotBlockMixedFailure() public {
        _items(5, 4, 2, 0); _source(1, 150, 150); _source(2, 150, 150);
        vm.etch(address(items), address(new ItemCodeExhausts()).code); p.setPaused(true);
        coord.failure(r);
        assertEq(_balance(address(coord)), 140); assertEq(_balance(holders), 100);
        assertEq(funding.itemFundingCount(), 0); assertEq(r.itemsHeldP(), 0); _booked();
    }

    function test_secondGraduationTransferFailureRollsBackFirstRelease() public {
        _items(5, 5, 1, 1); _source(1, 150, 150); _source(2, 300, 300); r.collect(address(0));
        vm.mockCall(address(pm), abi.encodeWithSignature("transfer(address,uint256,uint256)", address(items), uint160(address(p)), 200), abi.encode(false));
        vm.expectRevert(bytes("ClaimsTransferFailed")); coord.graduation(r);
        assertFalse(r.graduationSettled()); assertEq(funding.itemFundingCount(), 0);
        assertEq(r.itemsHeldP(), 300); assertEq(_balance(address(items)), 0); _booked();
    }
}
