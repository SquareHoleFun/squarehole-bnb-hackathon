// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {MoneyFixture} from "../m1-61/MoneyFixture.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

/// @dev RC5 supersedes R40A: the fixed denominator survives time and token disposal.
abstract contract SweepFixture is MoneyFixture {
    function _assertClaimsOpen(address, uint256 amount) internal view {
        assertEq(box.quoteClaim(amount), _pot() * amount / _left());
    }
    function _retainedAtYear(uint256 expected) internal {
        uint256 left = _left();
        uint256 owed = fees.fitOwed();
        vm.warp(box.failedAt() + 365 days - 1);
        NoFailureSweep.check(address(box));
        vm.warp(box.failedAt() + 365 days);
        NoFailureSweep.check(address(box));
        assertEq(_pot(), expected);
        assertEq(_left(), left);
        assertEq(fees.fitOwed(), owed);
    }
}
