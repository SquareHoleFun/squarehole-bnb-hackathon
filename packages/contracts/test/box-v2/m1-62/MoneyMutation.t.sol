// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {FailureReferenceTest} from "./FailureReference.t.sol";
import {SplitReferenceTest} from "./SplitReference.t.sol";
import {RaiseReferenceTest} from "./RaiseReference.t.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

/// CQ11-F / M1-62b: focused entry points retain M1-62's independent committed Python oracle.
/// Production receiver/coordinator/planner artifacts are rebuilt for every planted mutant.
contract FailureMutationTest is FailureReferenceTest {
    /// F136 / C11.3: the final counted raw coin owns the remaining pot and late tax/gifts, with no sweep.
    function test_C11_oneOutstandingCoinKeepsThePotWithNoSweep() public {
        _fail(101, 2);
        assertEq(_claim(ALICE, 1, BOB), 50);
        _fund(p, address(box), 17);
        _tax(3);
        router.sweep();
        assertEq(_left(), 1);
        assertEq(_pot(), 71);
        uint256 fitBefore = realReceiver.fitOwed();
        NoFailureSweep.check(address(box));
        assertEq(_pot(), 71, "last holder's pot must not be swept");
        assertEq(_left(), 1);
        assertEq(realReceiver.fitOwed(), fitBefore);
        assertEq(box.quoteClaim(1), 71);
        assertEq(_claim(ALICE, 1, ALICE), 71);
        assertEq(_left(), 0);
        assertEq(_pot(), 0);

        _fund(p, address(box), 7);
        vm.prank(BOB);
        NoFailureSweep.check(address(box));
        assertEq(realReceiver.payFit(), fitBefore);
        assertEq(_pot(), 7);
    }
}
contract SplitMutationTest is SplitReferenceTest {}
contract RaiseMutationTest is RaiseReferenceTest {}
