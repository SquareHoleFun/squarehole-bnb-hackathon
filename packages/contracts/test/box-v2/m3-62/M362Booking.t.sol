// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Mutate production only; preserve the independent per-account behavioral oracle.
import {EveryItemBookingTest} from "../m3-23/Booking.t.sol";

contract M362Booking is EveryItemBookingTest {
    function test_burnCountsKnownShelfItemsAsInside() public {
        _items(5, 1, 2, 0);
        coord.graduation(r);
        vault.pick(1, ALICE);
        vault.back(1);
        assertEq(vault.inside(), 4);
        assertEq(vault.hiddenCount(), 3, "known shelf item is not anonymous again");
        _source(1, 15, 15);
        r.collect(address(0));
        // A=10, N=4: all four inside shares burn (8); only rounding (2) reaches the ledger.
        _record(2, 1, 1, 1, 10, 2);
        assertEq(r.buyBackP(), 8);
        assertEq(_balance(address(items)), 2);
        items.sync(32);
        (uint256 outsideP, uint256 stashP) = items.itemCredit(1);
        assertEq(outsideP + stashP, 0);
        assertEq(items.flushResidue(), 2);
        _booked();
    }
}
