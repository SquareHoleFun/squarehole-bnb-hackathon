// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {FactoryLife, LifeForeignUnlock, LifeGift} from "../kit/FactoryLife.sol";
import {IBoxCoordinatorV2, FailCause} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";

contract FailureLifeTest is FactoryLife {
    function test_tradeFailClaimAndLateMoney() public {
        _start(_menu(2, 3));
        uint256 money = _money();
        _buy(box.raise() / 5);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 3, layout.sqrtPriceStartX96);
        receiver.collect(address(0));
        uint256 burn = receiver.buyBackP();
        assertGt(burn, 0);
        vm.warp(box.deadline());
        box.fail();
        assertTrue(box.failed());
        assertFalse(box.graduated());
        assertEq(uint256(box.failCause()), uint256(FailCause.Deadline));
        (uint256 pot,) = box.claimState();
        assertGe(pot, burn);
        assertEq(receiver.buyBackP(), 0);
        _claimBuyer();
        _lateMoney();
        assertEq(_money(), money, "P conserved through every exit");
    }

    function test_hatchBoundaryRollbackRetryAndHatchWinsGraduationRace() public {
        _start(_menu(1, 2));
        _fill();
        uint256 filled = hook.closedAt();
        uint256 end = filled + 7 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, end));
        box.fail();
        assertEq(hook.closedAt(), filled);
        vm.warp(end);
        assertLt(end, box.deadline());
        uint256 state = _state();
        LifeForeignUnlock foreign = new LifeForeignUnlock(pm);
        (bool ok, bytes memory reason) = foreign.attempt(address(box), abi.encodeCall(box.fail, ()));
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBoxCoordinatorV2.ForeignUnlock.selector));
        assertEq(_state(), state);
        (ok,) = address(box).call{gas: 300_000}(abi.encodeCall(box.fail, ()));
        assertFalse(ok);
        assertEq(_state(), state, "low gas rolls back balances and phase");
        box.fail();
        assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
        assertEq(hook.closedAt(), filled);
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.graduate();
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.fail();
        _claimBuyer();
        _lateMoney();
    }

    function test_graduationWinsHatchRace() public {
        _start(_menu(2, 2));
        _fill();
        vm.warp(hook.closedAt() + 7 days);
        box.graduate();
        uint256 state = _state();
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        box.fail();
        assertEq(_state(), state);
        assertTrue(box.graduated());
        assertFalse(box.failed());
    }

    function test_failedGraduationRetriesNeverRestartHatchClock() public {
        _start(_menu(2, 2));
        _fill();
        uint256 end = hook.closedAt() + 7 days;
        for (uint256 i; i < 3; ++i) {
            vm.warp(end - 3 + i);
            (bool ok,) = address(box).call{gas: 100_000}(abi.encodeCall(box.graduate, ()));
            assertFalse(ok);
            assertFalse(box.graduated());
            assertEq(hook.closedAt() + 7 days, end);
        }
        vm.warp(end);
        box.fail();
        _claimBuyer();
    }

    function test_unfilledHatchRefusedAndNoBuyerEntitlementFixed() public {
        _start(_menu(2, 2));
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.DeadlineNotReached.selector, box.deadline()));
        box.fail();
        _gift(address(box), 1 ether);
        vm.warp(box.deadline());
        box.fail();
        (, uint256 left) = box.claimState();
        assertEq(left, 0);
        uint256 fixedReturn = box.quoteClaim(0);
        assertGt(fixedReturn, 0);
        _gift(address(box), 12345);
        assertEq(box.quoteClaim(0), fixedReturn);
        NoFailureSweep.check(address(box));
        assertEq(box.quoteClaim(0), fixedReturn);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(0, address(this));
        vm.prank(CREATOR);
        assertEq(box.claim(0, CREATOR), fixedReturn);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        vm.prank(CREATOR);
        box.claim(0, CREATOR);
    }

    function _lateMoney() private {
        uint256 fit = receiver.fitOwed();
        _gift(address(box), 12345);
        NoFailureSweep.check(address(box));
        _gift(address(receiver), 54321);
        receiver.collect(address(0));
        // A forced gift follows the same permissionless router sweep as delayed tax.
        new LifeGift{value: 7}(box.launchRouter());
        (bool ok,) = box.launchRouter().call(abi.encodeWithSignature("sweep()"));
        require(ok);
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        uint256 owed = receiver.fitOwed();
        uint256 before = fitSafe.balance;
        assertEq(receiver.payFit(), owed);
        assertEq(fitSafe.balance - before, owed);
        NoFailureSweep.check(address(box));
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        vm.prank(CREATOR);
        box.claim(0, CREATOR);
        _booked();
    }

    function _state() private view returns (uint256) {
        return uint256(
            keccak256(
                abi.encode(
                    box.failed(),
                    box.graduated(),
                    hook.closedAt(),
                    hook.failed(),
                    token.totalSupply(),
                    token.balanceOf(address(buyer)),
                    pm.balanceOf(address(box), 0),
                    pm.balanceOf(address(hook), 0),
                    pm.balanceOf(address(receiver), 0),
                    receiver.booked(address(0))
                )
            )
        );
    }
}
