// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FailureTestBase} from "../m1-31/FailureTestBase.sol";

// BC-046/109/111/163/226/236: old conversion/cap/closing-range cases replaced by C11's P destinations.
contract FailureDestinationsTest is FailureTestBase {
    function testFuzz_reserveAloneSplitForEveryFeeChoice(uint8 seed) public {
        uint256 choice = bound(seed, 1, 5);
        _give(ALICE, 100);
        _fund(p, address(hook), 1150);
        hook.configure(0, 150, 0);
        _fund(p, address(receiver), 35);
        receiver.configure(choice, 35);
        _expire();
        box.fail();
        assertEq(receiver.feeInput(), 150);
        assertEq(receiver.platformOwed(), 10);
        assertEq(receiver.fitOwed(), choice == 3 ? 120 : 20);
        assertEq(_pot(), choice == 3 || choice == 4 ? 1055 : 1155);
        uint256 holders = pm.balanceOf(address(0xB47C), uint256(uint160(p)));
        assertEq(_pot() + receiver.fitOwed() + receiver.platformOwed() + holders, 1185);
    }

    function test_lateReceiverMoneyBelongsToFitBeforeLastClaimToo() public {
        _fail(100, 100);
        _fund(p, address(receiver), 37);
        receiver.collect(address(0));
        assertEq(_pot(), 100);
        assertEq(receiver.fitOwed(), 37);
        assertEq(_claim(ALICE, 100, ALICE), 100);
    }
}
