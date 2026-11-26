// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverFixture} from "../cq11-b/ReceiverFixture.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";

/// @dev Admission does not invent a ledger in ReleaseContext: immutable receiver wiring is the money boundary.
contract M210LedgerBoundaryTest is ReceiverFixture {
    function test_M210_zeroLedgerRefusedOnEitherSideWithoutMovingMoney() public {
        for (uint256 side; side < 2; ++side) {
            r = _receiver(side == 0 ? 4 : 1, side == 1 ? 4 : 1, 1, address(p), false);
            vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
            coord.initialize(r);
            vm.expectRevert(bytes("ReceiverNotInitialized"));
            r.collect(address(0));
            assertEq(r.booked(address(p)), 0);
            assertEq(_balance(address(r)), 0);
        }
    }
    function test_M210_nonzeroLedgerAdmittedByMergedM230() public {
        ReceiverArgs memory a = _args(4, 4, 1, address(p)); a.holderLedger = address(0x1717);
        r = _clone(a);
        coord.initialize(r);
        assertEq(r.holderLedger(), a.holderLedger);
        assertEq(uint8(r.buyersChoice()), 4);
        assertEq(uint8(r.sellersChoice()), 4);
        assertEq(r.booked(address(p)), 0);
        assertEq(_balance(a.holderLedger), 0);
        vm.expectRevert(IBoxReceiverV2.AlreadyInitialised.selector);
        coord.initialize(r);
    }
}
